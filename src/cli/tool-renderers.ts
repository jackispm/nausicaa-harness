import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export type ToolPresentationStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "unknown"
  | "archived";

export type ToolLineTone =
  | "output"
  | "muted"
  | "warning"
  | "error"
  | "added"
  | "removed"
  | "context";

export interface ToolPresentationLine {
  text: string;
  tone: ToolLineTone;
}

export interface ToolPresentationInput {
  name: string;
  arguments?: string | Record<string, unknown>;
  result?: string | Record<string, unknown>;
  status: ToolPresentationStatus;
  width: number;
}

export interface ToolPresentation {
  summary: string;
  collapsed: ToolPresentationLine[];
  expanded: ToolPresentationLine[];
}

export interface ToolRenderContext {
  name: string;
  arguments?: Record<string, unknown>;
  result?: Record<string, unknown>;
  rawArguments: string;
  rawResult: string;
  status: ToolPresentationStatus;
  width: number;
}

export type ToolPresentationRenderer = (context: ToolRenderContext) => ToolPresentation;

const MAX_EXPANDED_LINES = 200;
const BASH_PREVIEW_LINES = 5;
const MIN_WRAP_SOURCE_CHARACTERS = 4_096;
const MAX_WRAP_SOURCE_CHARACTERS = 256 * 1_024;
const HEAD_SOURCE_CLIPPED = "... remaining output clipped before rendering";
const TAIL_SOURCE_CLIPPED = "... earlier output clipped before rendering";

// Presentation behavior is a minimal attributed adaptation of Prime Agent 0.7.2
// (commit 7787f074): ToolExecutionComponent, bash/edit renderers, and rich diff rows.
export const TOOL_PRESENTATION_RENDERERS: Readonly<Record<string, ToolPresentationRenderer>> =
  Object.freeze({
    bash: renderBash,
    read_file: renderReadFile,
    list_files: renderListFiles,
    grep: renderGrep,
    find: renderFind,
    write_file: renderWriteFile,
    edit: renderEdit,
  });

export function renderToolPresentation(input: ToolPresentationInput): ToolPresentation {
  const name = safeText(input.name).trim() || "unknown_tool";
  const rawArguments = serialize(input.arguments);
  const rawResult = serialize(input.result);
  const arguments_ = parseRecord(input.arguments);
  const result = parseRecord(input.result);
  const context: ToolRenderContext = {
    name,
    ...(arguments_ === undefined ? {} : { arguments: arguments_ }),
    ...(result === undefined ? {} : { result }),
    rawArguments,
    rawResult,
    status: input.status,
    width: Math.max(1, Math.floor(input.width)),
  };
  const renderer = TOOL_PRESENTATION_RENDERERS[name] ?? renderFallback;
  return normalizePresentation(renderer(context), context.width);
}

/** Prime-style semantic diff rows. Styling is deliberately left to the caller. */
export function renderRichDiffRows(diff: string, width: number): ToolPresentationLine[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const rows: ToolPresentationLine[] = [];
  for (const unsafeLine of safeText(diff).split("\n")) {
    const rawLine = unsafeLine.replaceAll("\t", "   ");
    const parsed = /^([+\- ])(\s*\d+)\s(.*)$/.exec(rawLine);
    if (parsed === null) {
      rows.push(...wrapRows(rawLine, safeWidth, "context"));
      continue;
    }
    const prefix = parsed[1] ?? " ";
    const lineNumber = parsed[2] ?? "";
    const content = parsed[3] ?? "";
    const gutter = `${prefix}${lineNumber} `;
    const tone: ToolLineTone = prefix === "+"
      ? "added"
      : prefix === "-"
        ? "removed"
        : "context";
    rows.push(...wrapPrefixed(gutter, content, safeWidth, tone));
  }
  return rows;
}

function renderBash(context: ToolRenderContext): ToolPresentation {
  const command = stringValue(context.arguments?.command) ?? "...";
  const timeout = numberValue(context.arguments?.timeout);
  const summary = `$ ${oneLine(command)}${timeout === undefined ? "" : ` (${timeout}s timeout)`}`;
  if (context.result === undefined) {
    return rawOrEmpty(context, summary);
  }

  const outputRows: ToolPresentationLine[] = [];
  const stdout = stringValue(context.result.stdout) ?? "";
  const stderr = stringValue(context.result.stderr) ?? "";
  if (stdout.length > 0) outputRows.push(...wrapRows(stdout, context.width, "output", "tail"));
  if (stderr.length > 0) outputRows.push(...wrapRows(stderr, context.width, "error", "tail"));

  const error = stringValue(context.result.error);
  if (error !== undefined && error !== stderr.trim()) {
    outputRows.push(...wrapRows(error, context.width, "error", "tail"));
  }
  if (outputRows.length === 0 && context.status !== "running") {
    outputRows.push(line("(no output)", "muted"));
  }

  const warnings: ToolPresentationLine[] = [];
  if (context.result.truncated === true) {
    warnings.push(line(truncationSummary(context.result), "warning"));
  }
  const exitCode = nullableNumber(context.result.exitCode);
  if (exitCode !== undefined && exitCode !== null && exitCode !== 0 && error === undefined) {
    warnings.push(line(`Command exited with code ${exitCode}`, "error"));
  }
  const collapsed = tailPreview(outputRows, BASH_PREVIEW_LINES);
  return {
    summary,
    collapsed: [...collapsed, ...warnings],
    expanded: boundedTailRows([...outputRows, ...warnings]),
  };
}

function renderReadFile(context: ToolRenderContext): ToolPresentation {
  const argumentPath = stringValue(context.arguments?.path) ?? ".";
  const failure = resultFailure(context, argumentPath);
  if (failure !== undefined) return failure;
  if (context.result === undefined) return rawOrEmpty(context, argumentPath);

  const path = stringValue(context.result.path) ?? argumentPath;
  const offset = integer(context.result.offset) ?? 1;
  const count = integer(context.result.lineCount);
  const lineTruncated = context.result.lineTruncated === true;
  const range = lineTruncated
    ? `line ${offset} · partial`
    : count === undefined
      ? ""
      : count === 0
        ? "empty"
        : `lines ${offset}-${offset + count - 1}`;
  const more = context.result.truncated === true ? " · more" : "";
  const content = stringValue(context.result.content) ?? "";
  const rows = content.length === 0
    ? []
    : wrapRows(content, context.width, "output");
  if (lineTruncated) {
    const minimumMaxBytes = integer(context.result.minimumMaxBytes);
    const nextLineByteOffset = integer(context.result.nextLineByteOffset);
    rows.push(line(
      minimumMaxBytes === undefined
        ? `Line continues${nextLineByteOffset === undefined ? "" : ` at byte ${nextLineByteOffset}`}`
        : `No complete UTF-8 character fits · retry with maxBytes >= ${minimumMaxBytes}`,
      "warning",
    ));
  } else if (rows.length === 0) {
    rows.push(line("(empty file)", "muted"));
  }
  return {
    summary: `${path}${range.length === 0 ? "" : ` · ${range}`}${more}`,
    collapsed: [],
    expanded: boundedRows(rows),
  };
}

function renderListFiles(context: ToolRenderContext): ToolPresentation {
  const argumentPath = stringValue(context.arguments?.path) ?? ".";
  const failure = resultFailure(context, argumentPath);
  if (failure !== undefined) return failure;
  if (context.result === undefined) return rawOrEmpty(context, argumentPath);

  const path = stringValue(context.result.path) ?? argumentPath;
  const entries = Array.isArray(context.result.entries) ? context.result.entries : [];
  const rows: ToolPresentationLine[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.path !== "string") continue;
    const kind = entry.type === "directory"
      ? "dir "
      : entry.type === "symlink"
        ? "link"
        : entry.type === "other"
          ? "other"
          : "file";
    rows.push(...wrapPrefixed(`${kind}  `, entry.path, context.width, "output"));
  }
  if (rows.length === 0) rows.push(line("(empty directory)", "muted"));
  if (context.result.truncated === true) rows.push(line("... more entries", "warning"));
  return {
    summary: `${path} · ${entries.length} entries${context.result.truncated === true ? " · more" : ""}`,
    collapsed: [],
    expanded: boundedRows(rows),
  };
}

function renderGrep(context: ToolRenderContext): ToolPresentation {
  const pattern = stringValue(context.arguments?.pattern) ?? "";
  const argumentPath = stringValue(context.arguments?.path) ?? ".";
  const callSummary = `/${oneLine(pattern)}/ in ${argumentPath}`;
  const failure = resultFailure(context, callSummary);
  if (failure !== undefined) return failure;
  if (context.result === undefined) return rawOrEmpty(context, callSummary);

  const path = stringValue(context.result.path) ?? argumentPath;
  const matches = Array.isArray(context.result.matches) ? context.result.matches : [];
  const count = integer(context.result.matchCount) ?? matches.length;
  const files = integer(context.result.filesMatched);
  const rows: ToolPresentationLine[] = [];
  for (const candidate of matches) {
    if (!isRecord(candidate)) continue;
    const matchPath = stringValue(candidate.path) ?? path;
    const matchLine = integer(candidate.line);
    const column = integer(candidate.column);
    for (const before of grepContextLines(candidate.before)) {
      rows.push(...wrapPrefixed(
        `${matchPath}-${before.line}- `,
        before.text,
        context.width,
        "context",
      ));
    }
    const location = matchLine === undefined
      ? matchPath
      : `${matchPath}:${matchLine}${column === undefined ? "" : `:${column}`}`;
    rows.push(...wrapPrefixed(`${location}  `, stringValue(candidate.text) ?? "", context.width, "output"));
    for (const after of grepContextLines(candidate.after)) {
      rows.push(...wrapPrefixed(
        `${matchPath}-${after.line}- `,
        after.text,
        context.width,
        "context",
      ));
    }
  }
  if (rows.length === 0) rows.push(line("No matches", "muted"));
  if (context.result.truncated === true) rows.push(line("... more matches", "warning"));
  return {
    summary: `${path} · ${count} matches${files === undefined ? "" : ` in ${files} files`}${context.result.truncated === true ? " · more" : ""}`,
    collapsed: [],
    expanded: boundedRows(rows),
  };
}

function renderFind(context: ToolRenderContext): ToolPresentation {
  const pattern = stringValue(context.arguments?.pattern) ?? "*";
  const argumentPath = stringValue(context.arguments?.path) ?? ".";
  const callSummary = `${pattern} in ${argumentPath}`;
  const failure = resultFailure(context, callSummary);
  if (failure !== undefined) return failure;
  if (context.result === undefined) return rawOrEmpty(context, callSummary);

  const path = stringValue(context.result.path) ?? argumentPath;
  const files = Array.isArray(context.result.files)
    ? context.result.files.filter((value): value is string => typeof value === "string")
    : [];
  const count = integer(context.result.count) ?? files.length;
  const rows = files.flatMap((file) => wrapRows(file, context.width, "output"));
  if (rows.length === 0) rows.push(line("No paths", "muted"));
  if (context.result.truncated === true) rows.push(line("... more paths", "warning"));
  return {
    summary: `${path} · ${count} paths${context.result.truncated === true ? " · more" : ""}`,
    collapsed: [],
    expanded: boundedRows(rows),
  };
}

function renderWriteFile(context: ToolRenderContext): ToolPresentation {
  const argumentPath = stringValue(context.arguments?.path) ?? "...";
  const failure = resultFailure(context, argumentPath);
  if (failure !== undefined) return failure;
  if (context.result === undefined) return rawOrEmpty(context, argumentPath);

  const path = stringValue(context.result.path) ?? argumentPath;
  const bytes = integer(context.result.byteLength);
  const detail = bytes === undefined ? "written" : `${formatBytes(bytes)} written`;
  return {
    summary: `${path} · ${detail}`,
    collapsed: [],
    expanded: [line(`Atomic write complete${bytes === undefined ? "" : ` · ${formatBytes(bytes)}`}`, "muted")],
  };
}

function renderEdit(context: ToolRenderContext): ToolPresentation {
  const argumentPath = stringValue(context.arguments?.path) ?? "...";
  const failure = resultFailure(context, argumentPath);
  if (failure !== undefined) return failure;
  if (context.result === undefined) return rawOrEmpty(context, argumentPath);

  const path = stringValue(context.result.path) ?? argumentPath;
  const replacements = integer(context.result.replacements);
  const diff = stringValue(context.result.diff) ?? "";
  const changes = countDiffChanges(diff);
  const counts = `+${changes.added} -${changes.removed}`;
  const replacementText = replacements === undefined
    ? "edited"
    : `${replacements} replacement${replacements === 1 ? "" : "s"}`;
  const rows = diff.length === 0
    ? [line("(no diff available)", "muted")]
    : renderRichDiffRows(diff, context.width);
  return {
    summary: `${path} · ${replacementText} · ${counts}`,
    collapsed: [line(`${changes.added + changes.removed} changed lines · ${counts}`, "muted")],
    expanded: boundedRows(rows),
  };
}

function renderFallback(context: ToolRenderContext): ToolPresentation {
  const path = stringValue(context.arguments?.path);
  const summary = path ?? "custom tool";
  const rows: ToolPresentationLine[] = [];
  if (context.rawArguments.length > 0) {
    rows.push(line("arguments", "muted"));
    rows.push(...wrapRows(pretty(context.rawArguments), context.width, "output"));
  }
  if (context.rawResult.length > 0) {
    rows.push(line(context.status === "failed" ? "error" : "result", "muted"));
    rows.push(...wrapRows(
      pretty(context.rawResult),
      context.width,
      context.status === "failed" ? "error" : "output",
    ));
  }
  return { summary, collapsed: [], expanded: boundedRows(rows) };
}

function resultFailure(
  context: ToolRenderContext,
  fallbackSummary: string,
): ToolPresentation | undefined {
  const error = stringValue(context.result?.error);
  if (error === undefined && context.status !== "failed") return undefined;
  const message = (error ?? context.rawResult) || "Tool failed";
  const rows = wrapRows(message, context.width, "error");
  return {
    summary: error === undefined ? fallbackSummary : oneLine(error),
    collapsed: rows,
    expanded: rows,
  };
}

function rawOrEmpty(context: ToolRenderContext, summary: string): ToolPresentation {
  if (context.rawResult.length === 0) return { summary, collapsed: [], expanded: [] };
  const tone: ToolLineTone = context.status === "failed" ? "error" : "output";
  const rows = boundedRows(wrapRows(context.rawResult, context.width, tone));
  return { summary, collapsed: [], expanded: rows };
}

function normalizePresentation(presentation: ToolPresentation, width: number): ToolPresentation {
  return {
    summary: plainTruncate(oneLine(presentation.summary), width, "..."),
    collapsed: presentation.collapsed.map((row) => normalizeLine(row, width)),
    expanded: boundedRows(presentation.expanded.map((row) => normalizeLine(row, width))),
  };
}

function normalizeLine(value: ToolPresentationLine, width: number): ToolPresentationLine {
  return {
    text: plainTruncate(safeText(value.text), width, ""),
    tone: value.tone,
  };
}

function wrapRows(
  text: string,
  width: number,
  tone: ToolLineTone,
  direction: "head" | "tail" = "head",
): ToolPresentationLine[] {
  const rows: ToolPresentationLine[] = [];
  const safeWidth = Math.max(1, width);
  const source = safeText(text);
  const sourceBudget = Math.min(
    MAX_WRAP_SOURCE_CHARACTERS,
    Math.max(MIN_WRAP_SOURCE_CHARACTERS, safeWidth * MAX_EXPANDED_LINES * 4),
  );
  const clipped = source.length > sourceBudget;
  const sample = !clipped
    ? source
    : direction === "head"
      ? source.slice(0, sourceBudget)
      : source.slice(-sourceBudget);
  const sources = sample.split("\n");
  if (sources.length > 1 && sources.at(-1) === "") sources.pop();
  for (const source of sources) {
    const wrapped = wrapTextWithAnsi(source, safeWidth);
    for (const value of wrapped.length === 0 ? [""] : wrapped) rows.push(line(value, tone));
  }
  if (clipped) {
    const marker = line(
      direction === "head" ? HEAD_SOURCE_CLIPPED : TAIL_SOURCE_CLIPPED,
      "muted",
    );
    if (direction === "head") rows.push(marker);
    else rows.unshift(marker);
  }
  return rows;
}

function wrapPrefixed(
  prefix: string,
  text: string,
  width: number,
  tone: ToolLineTone,
): ToolPresentationLine[] {
  const safePrefix = safeText(prefix);
  const prefixWidth = visibleWidth(safePrefix);
  if (prefixWidth >= width) return [line(plainTruncate(safePrefix, width, ""), tone)];
  const contentWidth = Math.max(1, width - prefixWidth);
  const wrapped = wrapTextWithAnsi(safeText(text), contentWidth);
  const values = wrapped.length === 0 ? [""] : wrapped;
  return values.map((value, index) => line(
    `${index === 0 ? safePrefix : " ".repeat(prefixWidth)}${value}`,
    tone,
  ));
}

function tailPreview(rows: readonly ToolPresentationLine[], maximum: number): ToolPresentationLine[] {
  if (rows.length <= maximum) return [...rows];
  const sourceClipped = rows[0]?.text === TAIL_SOURCE_CLIPPED;
  const omitted = Math.max(0, rows.length - maximum - (sourceClipped ? 1 : 0));
  return [
    line(sourceClipped ? `... ${omitted}+ earlier lines` : `... ${omitted} earlier lines`, "muted"),
    ...rows.slice(-maximum),
  ];
}

function boundedRows(rows: readonly ToolPresentationLine[]): ToolPresentationLine[] {
  if (rows.length <= MAX_EXPANDED_LINES) return [...rows];
  const sourceClipped = rows.at(-1)?.text === HEAD_SOURCE_CLIPPED;
  const sourceRows = rows.length - (sourceClipped ? 1 : 0);
  const omitted = Math.max(0, sourceRows - MAX_EXPANDED_LINES + 1);
  return [
    ...rows.slice(0, MAX_EXPANDED_LINES - 1),
    line(
      sourceClipped
        ? `... ${omitted}+ more lines (source clipped)`
        : `... ${omitted} more lines`,
      "muted",
    ),
  ];
}

function boundedTailRows(rows: readonly ToolPresentationLine[]): ToolPresentationLine[] {
  if (rows.length <= MAX_EXPANDED_LINES) return [...rows];
  const sourceClipped = rows[0]?.text === TAIL_SOURCE_CLIPPED;
  const sourceRows = rows.length - (sourceClipped ? 1 : 0);
  const omitted = Math.max(0, sourceRows - MAX_EXPANDED_LINES + 1);
  return [
    line(
      sourceClipped
        ? `... ${omitted}+ earlier lines (source clipped)`
        : `... ${omitted} earlier lines`,
      "muted",
    ),
    ...rows.slice(-(MAX_EXPANDED_LINES - 1)),
  ];
}

function grepContextLines(value: unknown): Array<{ line: number; text: string }> {
  if (!Array.isArray(value)) return [];
  const lines: Array<{ line: number; text: string }> = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const lineNumber = integer(candidate.line);
    const text = stringValue(candidate.text);
    if (lineNumber !== undefined && text !== undefined) lines.push({ line: lineNumber, text });
  }
  return lines;
}

function countDiffChanges(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of diff.split("\n")) {
    if (row.startsWith("+")) added += 1;
    else if (row.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

function truncationSummary(result: Record<string, unknown>): string {
  const truncation = isRecord(result.truncation) ? result.truncation : undefined;
  const streams = truncation === undefined
    ? []
    : [truncation.stdout, truncation.stderr].filter(isRecord);
  if (streams.some((stream) => stream.truncatedBy === "bytes")) {
    const totalBytes = streams.reduce((sum, stream) => sum + (integer(stream.totalBytes) ?? 0), 0);
    const outputBytes = streams.reduce((sum, stream) => sum + (integer(stream.outputBytes) ?? 0), 0);
    if (totalBytes > 0) {
      return `Output truncated · showing ${formatBytes(outputBytes)} of ${formatBytes(totalBytes)}`;
    }
  }
  const totalLines = streams.reduce((sum, stream) => sum + (integer(stream.totalLines) ?? 0), 0);
  const outputLines = streams.reduce((sum, stream) => sum + (integer(stream.outputLines) ?? 0), 0);
  return totalLines > 0
    ? `Output truncated · showing ${outputLines} of ${totalLines} lines`
    : "Output truncated";
}

function parseRecord(value: string | Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function serialize(value: string | Record<string, unknown> | undefined): string {
  if (value === undefined) return "";
  return safeText(typeof value === "string" ? value : JSON.stringify(value));
}

function pretty(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value) as unknown, null, 2);
  } catch {
    return value;
  }
}

function safeText(value: string): string {
  return stripTerminalSequences(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function plainTruncate(value: string, width: number, ellipsis: string): string {
  return safeText(truncateToWidth(value, width, ellipsis));
}

function oneLine(value: string): string {
  return safeText(value).replace(/\s+/g, " ").trim();
}

function line(text: string, tone: ToolLineTone): ToolPresentationLine {
  return { text, tone };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? safeText(value) : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nullableNumber(value: unknown): number | null | undefined {
  return value === null ? null : numberValue(value);
}

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? value as number : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}
