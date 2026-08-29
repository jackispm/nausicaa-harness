import path from "node:path";

import type { AgentTool, ToolResult } from "../domain/ports.js";
import { executeRipgrep } from "./ripgrep.js";
import {
  decodeSearchCursor,
  encodeSearchCursor,
  searchQueryFingerprint,
} from "./search-cursor.js";
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
  nextCursor?: string;
}

interface ParsedLine extends GrepLine {
  path: string;
  column?: number;
  match: boolean;
  ordinal?: number;
}

interface SearchGrepMatch extends GrepMatch {
  ordinal: number;
}

interface GrepCursorAnchor {
  path: string;
  line: number;
  column: number;
  ordinal: number;
}

export interface GrepToolOptions {
  /** Retain the pre-pagination search contract for frozen evaluation fixtures. */
  pagination?: "cursor" | "legacy";
}

export function createGrepTool(
  policy: WorkspacePathPolicy = {},
  options: GrepToolOptions = {},
): AgentTool {
  const pathPolicy = snapshotPolicy(policy);
  const cursorPagination = options.pagination !== "legacy";
  const properties: Record<string, unknown> = {
    pattern: { type: "string", description: "Search pattern (regex or literal string)" },
    path: { type: "string", description: "Directory or file to search (default: current directory)" },
    glob: { type: "string", description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" },
    ignoreCase: { type: "boolean", description: "Case-insensitive search (default: false)" },
    literal: { type: "boolean", description: "Treat pattern as a literal string instead of regex (default: false)" },
    context: { type: "integer", minimum: 0, maximum: HARD_CONTEXT },
    limit: { type: "integer", minimum: 1, maximum: HARD_LIMIT },
    ...(cursorPagination ? {
      cursor: {
        type: "string",
        description: "Opaque nextCursor from the previous search with the same pattern, path, glob, and match options. The limit may change.",
      },
    } : {}),
  };
  return {
    definition: {
      name: "grep",
      description: cursorPagination
        ? "Search workspace file contents in stable pages and return bounded structured matches. Use nextCursor to continue a truncated page."
        : "Search workspace file contents for a pattern and return bounded structured matches.",
      parameters: {
        type: "object",
        properties,
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
        if (!cursorPagination && "cursor" in arguments_) {
          throw new Error("cursor is not available in legacy grep pagination mode");
        }
        const cursor = cursorPagination
          ? optionalString(arguments_.cursor, "cursor")
          : undefined;
        const discovery = await discoverSearchFiles(
          context.workspace,
          requestedPath,
          glob,
          pathPolicy,
          context.signal,
        );
        const query = cursorPagination
          ? searchQueryFingerprint({
            workspace: discovery.root.workspace,
            root: discovery.root.absolute,
            pattern,
            glob: glob ?? null,
            ignoreCase,
            literal,
            contextLines,
          })
          : undefined;
        const anchor = cursor === undefined
          ? undefined
          : decodeSearchCursor(cursor, "grep", query!, isGrepCursorAnchor);
        const search = await searchFiles(
          discovery.files,
          discovery.cwd,
          pattern,
          { ignoreCase, literal, contextLines, limit },
          context.signal,
          anchor,
          cursorPagination,
        );
        await revalidateExistingWorkspacePath(discovery.root);
        for (const file of search.matchedFiles) {
          await revalidateSearchFile(file);
        }
        return success(boundOutput(
          discovery.root.relative,
          pattern,
          search.matches,
          search.truncated,
          discovery.truncated,
          query,
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
  anchor: GrepCursorAnchor | undefined,
  cursorPagination: boolean,
): Promise<{ matches: SearchGrepMatch[]; matchedFiles: SearchFile[]; truncated: boolean }> {
  const fileByArgument = new Map(files.map((file) => [toPosix(file.argument), file]));
  const parsedLines: ParsedLine[] = [];
  let outputTruncated = false;
  let hasMore = false;
  const targetMatches = options.limit + Number(cursorPagination);
  let start = anchor === undefined ? 0 : firstFileAtOrAfter(files, anchor.path);

  while (start < files.length) {
    throwIfAborted(signal);
    const includesAnchorFile = anchor !== undefined && files[start]!.path === anchor.path;
    const batch = includesAnchorFile
      ? files.slice(start, start + 1)
      : files.slice(start, start + FILE_BATCH_SIZE);
    start += batch.length;
    const arguments_ = [
      "--json",
      "--line-number",
      "--column",
      "--color=never",
      "--no-config",
      "--sort=path",
      "--path-separator=/",
      "--max-count",
      String(includesAnchorFile ? anchor.ordinal + targetMatches : targetMatches),
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
    const parsedBatch = parseRipgrepJson(result.stdout, fileByArgument, result.outputTruncated);
    if (includesAnchorFile && !containsAnchor(parsedBatch, anchor)) {
      throw new Error(result.outputTruncated
        ? "grep cursor could not be reached within the search output limit; narrow the query or restart without cursor"
        : "grep cursor no longer matches the workspace; restart the search without cursor");
    }
    parsedLines.push(...parsedBatch);
    const observedMatches = parsedLines.reduce((count, line) => (
      count + Number(isMatchAfter(line, anchor))
    ), 0);
    if (observedMatches >= targetMatches) {
      hasMore = true;
      break;
    }
    if (result.outputTruncated) break;
  }

  const matchLines = parsedLines
    .filter((line): line is ParsedLine & { column: number; ordinal: number } => (
      line.match && line.column !== undefined && line.ordinal !== undefined && isMatchAfter(line, anchor)
    ))
    .sort(compareParsedLines)
  hasMore ||= matchLines.length > options.limit;
  const selectedMatchLines = matchLines.slice(0, options.limit);
  const allLines = new Map<string, ParsedLine>();
  for (const line of parsedLines.sort(compareParsedLines)) {
    allLines.set(lineKey(line.path, line.line), line);
  }
  const matches = selectedMatchLines.map((match) => withContext(match, allLines, options.contextLines));
  const matchedPaths = new Set(matches.map((match) => match.path));
  const matchedFiles = files.filter((file) => matchedPaths.has(file.path));
  return {
    matches,
    matchedFiles,
    truncated: outputTruncated || hasMore,
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
  const ordinals = new Map<string, number>();
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
    const ordinal = event.type === "match" ? (ordinals.get(file.path) ?? 0) + 1 : undefined;
    if (ordinal !== undefined) ordinals.set(file.path, ordinal);
    parsed.push({
      path: file.path,
      line,
      text: bounded.text,
      ...(bounded.truncated ? { truncated: true as const } : {}),
      ...(column === undefined ? {} : { column }),
      ...(ordinal === undefined ? {} : { ordinal }),
      match: event.type === "match",
    });
  }
  return parsed;
}

function withContext(
  match: ParsedLine & { column: number; ordinal: number },
  lines: ReadonlyMap<string, ParsedLine>,
  context: number,
): SearchGrepMatch {
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
    ordinal: match.ordinal!,
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
  matches: readonly SearchGrepMatch[],
  pageTruncated: boolean,
  discoveryTruncated: boolean,
  query: string | undefined,
): GrepOutput {
  const selected = [...matches];
  let hasRecoverableNextPage = pageTruncated;
  while (true) {
    const visibleMatches = selected.map(({ ordinal: _, ...match }) => match);
    const truncated = discoveryTruncated || hasRecoverableNextPage;
    const output: GrepOutput = {
      path: searchPath,
      pattern,
      matches: visibleMatches,
      matchCount: visibleMatches.length,
      filesMatched: new Set(visibleMatches.map((match) => match.path)).size,
      truncated,
      ...(query !== undefined && hasRecoverableNextPage && selected.length > 0
        ? { nextCursor: encodeSearchCursor("grep", query, grepAnchor(selected.at(-1)!)) }
        : {}),
    };
    if (Buffer.byteLength(JSON.stringify(output), "utf8") <= MAX_RESULT_BYTES || selected.length === 0) {
      return output;
    }
    selected.pop();
    hasRecoverableNextPage = true;
  }
}

function firstFileAtOrAfter(files: readonly SearchFile[], anchor: string): number {
  let low = 0;
  let high = files.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (files[middle]!.path < anchor) low = middle + 1;
    else high = middle;
  }
  return low;
}

function containsAnchor(lines: readonly ParsedLine[], anchor: GrepCursorAnchor): boolean {
  return lines.some((line) => line.match
    && line.path === anchor.path
    && line.line === anchor.line
    && line.column === anchor.column
    && line.ordinal === anchor.ordinal);
}

function isMatchAfter(line: ParsedLine, anchor: GrepCursorAnchor | undefined): boolean {
  if (!line.match || line.column === undefined) return false;
  if (anchor === undefined) return true;
  return compareText(line.path, anchor.path) > 0
    || (line.path === anchor.path && (
      line.line > anchor.line
      || (line.line === anchor.line && line.column > anchor.column)
    ));
}

function grepAnchor(match: SearchGrepMatch): GrepCursorAnchor {
  return {
    path: match.path,
    line: match.line,
    column: match.column,
    ordinal: match.ordinal,
  };
}

function isGrepCursorAnchor(value: unknown): value is GrepCursorAnchor {
  return isRecord(value)
    && typeof value.path === "string"
    && value.path.length > 0
    && Number.isSafeInteger(value.line)
    && (value.line as number) > 0
    && Number.isSafeInteger(value.column)
    && (value.column as number) > 0
    && Number.isSafeInteger(value.ordinal)
    && (value.ordinal as number) > 0;
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
