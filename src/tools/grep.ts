import path from "node:path";

import type { AgentTool, ToolResult } from "../domain/ports.js";
import { executeRipgrep } from "./ripgrep.js";
import {
  boundedInteger,
  compareText,
  discoverSearchFiles,
  optionalBoolean,
  optionalString,
  requiredString,
  revalidateSearchFile,
  ripgrepError,
  snapshotPolicy,
  throwIfAborted,
  type SearchFile,
} from "./search-files.js";
import { revalidateExistingWorkspacePath, type WorkspacePathPolicy } from "./workspace-path.js";

const DEFAULT_LIMIT = 100;
const HARD_LIMIT = 1_000;
const HARD_CONTEXT = 20;
const FILE_BATCH_SIZE = 64;
const MAX_BATCH_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_RESULT_BYTES = 128 * 1024;
const MAX_LINE_CHARACTERS = 500;

interface GrepLine {
  line: number;
  text: string;
  truncated?: true;
}

interface GrepMatch extends GrepLine {
  path: string;
  column: number;
  before?: GrepLine[];
  after?: GrepLine[];
}

interface GrepOutput {
  path: string;
  pattern: string;
  matches: GrepMatch[];
  matchCount: number;
  filesMatched: number;
  truncated: boolean;
}

interface ParsedLine extends GrepLine {
  path: string;
  column?: number;
  match: boolean;
}

export function createGrepTool(policy: WorkspacePathPolicy = {}): AgentTool {
  const pathPolicy = snapshotPolicy(policy);
  return {
    definition: {
      name: "grep",
      description: "Search workspace file contents for a pattern and return bounded structured matches.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Search pattern (regex or literal string)" },
          path: { type: "string", description: "Directory or file to search (default: current directory)" },
          glob: { type: "string", description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" },
          ignoreCase: { type: "boolean", description: "Case-insensitive search (default: false)" },
          literal: { type: "boolean", description: "Treat pattern as a literal string instead of regex (default: false)" },
          context: { type: "integer", minimum: 0, maximum: HARD_CONTEXT },
          limit: { type: "integer", minimum: 1, maximum: HARD_LIMIT },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },

    async execute(arguments_, context): Promise<ToolResult> {
      try {
        const pattern = requiredString(arguments_.pattern, "pattern");
        const requestedPath = optionalString(arguments_.path, "path") ?? ".";
        const glob = optionalString(arguments_.glob, "glob");
        const ignoreCase = optionalBoolean(arguments_.ignoreCase, "ignoreCase") ?? false;
        const literal = optionalBoolean(arguments_.literal, "literal") ?? false;
        const contextLines = boundedInteger(arguments_.context, "context", 0, 0, HARD_CONTEXT);
        const limit = boundedInteger(arguments_.limit, "limit", DEFAULT_LIMIT, 1, HARD_LIMIT);
        const discovery = await discoverSearchFiles(
          context.workspace,
          requestedPath,
          glob,
          pathPolicy,
          context.signal,
        );
        const search = await searchFiles(
          discovery.files,
          discovery.cwd,
          pattern,
          { ignoreCase, literal, contextLines, limit },
          context.signal,
        );
        await revalidateExistingWorkspacePath(discovery.root);
        for (const file of search.matchedFiles) {
          await revalidateSearchFile(file);
        }
        return success(boundOutput(
          discovery.root.relative,
          pattern,
          search.matches,
          discovery.truncated || search.truncated,
        ));
      } catch (error: unknown) {
        return failure(error instanceof Error ? error.message : "Content search failed");
      }
    },
  };
}

export const grepTool: AgentTool = createGrepTool();

async function searchFiles(
  files: readonly SearchFile[],
  cwd: string,
  pattern: string,
  options: { ignoreCase: boolean; literal: boolean; contextLines: number; limit: number },
  signal: AbortSignal | undefined,
): Promise<{ matches: GrepMatch[]; matchedFiles: SearchFile[]; truncated: boolean }> {
  const fileByArgument = new Map(files.map((file) => [toPosix(file.argument), file]));
  const parsedLines: ParsedLine[] = [];
  let outputTruncated = false;
  let stoppedAtLimit = false;

  for (let start = 0; start < files.length; start += FILE_BATCH_SIZE) {
    throwIfAborted(signal);
    const batch = files.slice(start, start + FILE_BATCH_SIZE);
    const arguments_ = [
      "--json",
      "--line-number",
      "--column",
      "--color=never",
      "--no-config",
      "--sort=path",
      "--path-separator=/",
      "--max-count",
      String(options.limit),
    ];
    if (options.ignoreCase) arguments_.push("--ignore-case");
    if (options.literal) arguments_.push("--fixed-strings");
    if (options.contextLines > 0) arguments_.push("--context", String(options.contextLines));
    arguments_.push("--", pattern, ...batch.map((file) => file.argument));

    const result = await executeRipgrep(arguments_, cwd, signal, MAX_BATCH_OUTPUT_BYTES);
    if (result.exitCode !== 0 && result.exitCode !== 1 && !result.outputTruncated) {
      throw new Error(ripgrepError(result.stderr, result.exitCode));
    }
    outputTruncated ||= result.outputTruncated;
    parsedLines.push(...parseRipgrepJson(result.stdout, fileByArgument, result.outputTruncated));
    const observedMatches = parsedLines.reduce((count, line) => count + Number(line.match), 0);
    if (observedMatches >= options.limit) {
      stoppedAtLimit = true;
      break;
    }
    if (result.outputTruncated) break;
  }

  const matchLines = parsedLines
    .filter((line): line is ParsedLine & { column: number } => line.match && line.column !== undefined)
    .sort(compareParsedLines)
    .slice(0, options.limit);
  const allLines = new Map<string, ParsedLine>();
  for (const line of parsedLines.sort(compareParsedLines)) {
    allLines.set(lineKey(line.path, line.line), line);
  }
  const matches = matchLines.map((match) => withContext(match, allLines, options.contextLines));
  const matchedPaths = new Set(matches.map((match) => match.path));
  const matchedFiles = files.filter((file) => matchedPaths.has(file.path));
  return {
    matches,
    matchedFiles,
    truncated: outputTruncated || stoppedAtLimit,
  };
}

function parseRipgrepJson(
  output: Buffer,
  fileByArgument: ReadonlyMap<string, SearchFile>,
  outputTruncated: boolean,
): ParsedLine[] {
  const rawLines = output.toString("utf8").split("\n");
  if (outputTruncated) rawLines.pop();
  const parsed: ParsedLine[] = [];
  for (const rawLine of rawLines) {
    if (rawLine.length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (!isRecord(event) || (event.type !== "match" && event.type !== "context") || !isRecord(event.data)) {
      continue;
    }
    const rawPath = jsonText(event.data.path);
    const rawText = jsonText(event.data.lines);
    const line = event.data.line_number;
    if (rawPath === undefined || rawText === undefined || typeof line !== "number") continue;
    const file = fileByArgument.get(normalizeResultPath(rawPath));
    if (file === undefined) continue;
    const bounded = boundLine(rawText.replace(/\r?\n$/, ""));
    const column = event.type === "match" ? firstColumn(event.data.submatches) : undefined;
    if (event.type === "match" && column === undefined) continue;
    parsed.push({
      path: file.path,
      line,
      text: bounded.text,
      ...(bounded.truncated ? { truncated: true as const } : {}),
      ...(column === undefined ? {} : { column }),
      match: event.type === "match",
    });
  }
  return parsed;
}

function withContext(
  match: ParsedLine & { column: number },
  lines: ReadonlyMap<string, ParsedLine>,
  context: number,
): GrepMatch {
  const before: GrepLine[] = [];
  const after: GrepLine[] = [];
  for (let line = match.line - context; line < match.line; line += 1) {
    const value = lines.get(lineKey(match.path, line));
    if (value !== undefined) before.push(toGrepLine(value));
  }
  for (let line = match.line + 1; line <= match.line + context; line += 1) {
    const value = lines.get(lineKey(match.path, line));
    if (value !== undefined) after.push(toGrepLine(value));
  }
  return {
    path: match.path,
    line: match.line,
    column: match.column,
    text: match.text,
    ...(match.truncated ? { truncated: true as const } : {}),
    ...(before.length > 0 ? { before } : {}),
    ...(after.length > 0 ? { after } : {}),
  };
}

function toGrepLine(line: ParsedLine): GrepLine {
  return {
    line: line.line,
    text: line.text,
    ...(line.truncated ? { truncated: true as const } : {}),
  };
}

function boundOutput(
  searchPath: string,
  pattern: string,
  matches: readonly GrepMatch[],
  initiallyTruncated: boolean,
): GrepOutput {
  const selected = [...matches];
  let truncated = initiallyTruncated;
  while (true) {
    const output: GrepOutput = {
      path: searchPath,
      pattern,
      matches: selected,
      matchCount: selected.length,
      filesMatched: new Set(selected.map((match) => match.path)).size,
      truncated,
    };
    if (Buffer.byteLength(JSON.stringify(output), "utf8") <= MAX_RESULT_BYTES || selected.length === 0) {
      return output;
    }
    selected.pop();
    truncated = true;
  }
}

function compareParsedLines(left: ParsedLine, right: ParsedLine): number {
  return compareText(left.path, right.path)
    || left.line - right.line
    || Number(right.match) - Number(left.match)
    || (left.column ?? 0) - (right.column ?? 0);
}

function jsonText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.text === "string") return value.text;
  if (typeof value.bytes === "string") return Buffer.from(value.bytes, "base64").toString("utf8");
  return undefined;
}

function firstColumn(value: unknown): number | undefined {
  if (!Array.isArray(value) || !isRecord(value[0]) || typeof value[0].start !== "number") {
    return undefined;
  }
  return value[0].start + 1;
}

function boundLine(text: string): { text: string; truncated: boolean } {
  const characters = Array.from(text);
  if (characters.length <= MAX_LINE_CHARACTERS) return { text, truncated: false };
  return { text: characters.slice(0, MAX_LINE_CHARACTERS).join(""), truncated: true };
}

function normalizeResultPath(value: string): string {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function lineKey(filePath: string, line: number): string {
  return `${filePath}\0${line}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function success(value: GrepOutput): ToolResult {
  return { content: JSON.stringify(value), isError: false };
}

function failure(message: string): ToolResult {
  return { content: JSON.stringify({ error: message }), isError: true };
}
