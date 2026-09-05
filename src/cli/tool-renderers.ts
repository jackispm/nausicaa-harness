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
    read_many: renderReadMany,
    list_files: renderListFiles,
    grep: renderGrep,
    find: renderFind,
    file_info: renderFileInfo,
    git_status: renderGitStatus,
    git_log: renderGitLog,
    git_show: renderGitShow,
    git_diff: renderGitDiff,
    read_image: renderReadImage,
    write_file: renderWriteFile,
    edit: renderEdit,
    apply_patch: renderApplyPatch,
    directory_create: renderDirectoryCreate,
    path_copy: renderPathCopy,
    path_move: renderPathMove,
    path_delete: renderPathDelete,
    web_fetch: renderWebFetch,
    web_search: renderWebSearch,
    process_start: renderProcessStart,
    process_status: renderProcessStatus,
    process_output: renderProcessOutput,
    process_kill: renderProcessKill,
    process_list: renderProcessList,
    delegate_task: renderDelegateTask,
    respond_to_advice: renderAdviceResponse,
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
    if (parsed !== null) {
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
      continue;
    }
    const unifiedPrefix = rawLine[0];
    const isFileHeader = rawLine.startsWith("+++") || rawLine.startsWith("---");
    if (!isFileHeader && (unifiedPrefix === "+" || unifiedPrefix === "-")) {
      rows.push(...wrapPrefixed(
        unifiedPrefix,
        rawLine.slice(1),
        safeWidth,
        unifiedPrefix === "+" ? "added" : "removed",
      ));
      continue;
    }
    rows.push(...wrapRows(rawLine, safeWidth, "context"));
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
  const diagnosticHint = isRecord(context.result.diagnostic)
    ? stringValue(context.result.diagnostic.hint)
    : undefined;
  const diagnosticRows = diagnosticHint === undefined
    ? []
    : wrapRows(`Hint: ${diagnosticHint}`, context.width, "warning");
  const collapsed = tailPreview(outputRows, BASH_PREVIEW_LINES);
  const expandedWithoutDiagnostic = boundedTailRows([...outputRows, ...warnings]);
  const expanded = diagnosticRows.length === 0
    ? expandedWithoutDiagnostic
    : appendPinnedTail(expandedWithoutDiagnostic, diagnosticRows);
  return {
    summary,
    collapsed: [...collapsed, ...warnings, ...diagnosticRows],
    expanded,
  };
}

/** Keep the normal tail/footer diagnostics visible when a pinned hint is added. */
function appendPinnedTail(
  rows: readonly ToolPresentationLine[],
  pinned: readonly ToolPresentationLine[],
): ToolPresentationLine[] {
  const bodyLimit = Math.max(0, MAX_EXPANDED_LINES - pinned.length);
  if (rows.length <= bodyLimit) return [...rows, ...pinned];
  if (bodyLimit === 0) return [...pinned].slice(-MAX_EXPANDED_LINES);
  return [
    rows[0]!,
    ...rows.slice(-(bodyLimit - 1)),
    ...pinned,
  ];
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

function renderReadMany(context: ToolRenderContext): ToolPresentation {
  const targets = Array.isArray(context.arguments?.targets)
    ? context.arguments.targets.filter(isRecord)
    : [];
  const callSummary = targets.length === 0
    ? "file batch"
    : `${targets.length} file${targets.length === 1 ? "" : "s"}`;
  const failure = resultFailure(context, callSummary);
  if (failure !== undefined && !Array.isArray(context.result?.results)) return failure;
  if (context.result === undefined) return rawOrEmpty(context, callSummary);

  const results = Array.isArray(context.result.results)
    ? context.result.results.filter(isRecord)
    : [];
  const rows: ToolPresentationLine[] = [];
  for (const result of results) {
    const path = stringValue(result.path) ?? "unknown file";
    if (result.ok !== true) {
      const error = toolErrorMessage(result.error) ?? "read failed";
      rows.push(...wrapPrefixed("failed  ", `${path} · ${error}`, context.width, "error"));
      continue;
    }
    const offset = integer(result.offset) ?? 1;
    const count = integer(result.lineCount) ?? 0;
    const range = count <= 0 ? "empty" : `lines ${offset}-${offset + count - 1}`;
    rows.push(...wrapPrefixed(
      "read    ",
      `${path} · ${range}${result.truncated === true ? " · more" : ""}`,
      context.width,
      "muted",
    ));
    const content = stringValue(result.content);
    if (content !== undefined && content.length > 0) {
      rows.push(...wrapRows(content, context.width, "output"));
    }
  }
  const succeeded = integer(context.result.succeeded)
    ?? results.filter((result) => result.ok === true).length;
  const failed = integer(context.result.failed) ?? results.length - succeeded;
  return {
    summary: `${results.length} files · ${succeeded} read${failed === 0 ? "" : ` · ${failed} failed`}`,
    collapsed: headPreview(rows, 6),
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
  const matchingFiles = Array.isArray(context.result.files)
    ? context.result.files.filter((value): value is string => typeof value === "string")
    : undefined;
  if (matchingFiles !== undefined) {
    const count = integer(context.result.count) ?? matchingFiles.length;
    const rows = matchingFiles.flatMap((file) => wrapRows(file, context.width, "output"));
    if (rows.length === 0) rows.push(line("No matching files", "muted"));
    if (context.result.truncated === true) rows.push(line("... more matching files", "warning"));
    return {
      summary: `${path} · ${count} matching file${count === 1 ? "" : "s"}${context.result.truncated === true ? " · more" : ""}`,
      collapsed: [],
      expanded: boundedRows(rows),
    };
  }
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

function renderFileInfo(context: ToolRenderContext): ToolPresentation {
  const argumentPath = stringValue(context.arguments?.path) ?? "...";
  const failure = resultFailure(context, argumentPath);
  if (failure !== undefined) return failure;
  if (context.result === undefined) return rawOrEmpty(context, argumentPath);

  const path = stringValue(context.result.path) ?? argumentPath;
  const type = stringValue(context.result.type) ?? "path";
  const bytes = integer(context.result.byteLength);
  const mode = integer(context.result.mode);
  const executable = context.result.executable === true;
  const details = [type, bytes === undefined ? undefined : formatBytes(bytes)]
    .filter((value): value is string => value !== undefined)
    .join(" · ");
  const rows: ToolPresentationLine[] = [];
  if (mode !== undefined) {
    rows.push(line(`Mode 0${mode.toString(8).padStart(3, "0")}${executable ? " · executable" : ""}`, "muted"));
  }
  const modified = stringValue(context.result.modifiedAt);
  const created = stringValue(context.result.createdAt);
  if (modified !== undefined) rows.push(line(`Modified ${modified}`, "muted"));
  if (created !== undefined) rows.push(line(`Created ${created}`, "muted"));
  const hash = stringValue(context.result.hash);
  if (hash !== undefined) rows.push(...wrapRows(hash, context.width, "output"));
  return {
    summary: `${path}${details.length === 0 ? "" : ` · ${details}`}`,
    collapsed: [],
    expanded: rows,
  };
}

function renderGitStatus(context: ToolRenderContext): ToolPresentation {
  const failure = resultFailure(context, "git status");
  if (failure !== undefined) return failure;
  if (context.result === undefined) return rawOrEmpty(context, "git status");

  const entries = Array.isArray(context.result.entries)
    ? context.result.entries.filter(isRecord)
    : [];
  const branch = stringValue(context.result.branch);
  const rows: ToolPresentationLine[] = [];
  for (const entry of entries) {
    const status = stringValue(entry.status) ?? "??";
    const path = stringValue(entry.path) ?? "unknown path";
    rows.push(...wrapPrefixed(`${status.padEnd(3)} `, path, context.width, "output"));
  }
  if (rows.length === 0) rows.push(line("Working tree clean", "muted"));
  appendGitWarnings(rows, context.result);
  return {
    summary: `${branch ?? "repository"} · ${entries.length} change${entries.length === 1 ? "" : "s"}`,
    collapsed: headPreview(rows, 6),
    expanded: boundedRows(rows),
  };
}

function renderGitLog(context: ToolRenderContext): ToolPresentation {
  const revision = shortRevision(stringValue(context.result?.revision)
    ?? stringValue(context.arguments?.revision)
    ?? "HEAD");
  const maxCount = integer(context.result?.maxCount) ?? integer(context.arguments?.maxCount) ?? 10;
  return renderGitText(context, `git log ${revision} · up to ${maxCount}`, false);
}

function renderGitShow(context: ToolRenderContext): ToolPresentation {
  const revision = shortRevision(stringValue(context.result?.revision)
    ?? stringValue(context.arguments?.revision)
    ?? "HEAD");
  const pathsShown = integer(context.result?.pathsShown);
  return renderGitText(
    context,
    `git show ${revision}${pathsShown === undefined ? "" : ` · ${pathsShown} path${pathsShown === 1 ? "" : "s"}`}`,
    context.arguments?.statOnly !== true,
  );
}

function renderGitDiff(context: ToolRenderContext): ToolPresentation {
  const from = stringValue(context.arguments?.from);
  const to = stringValue(context.arguments?.to);
  const staged = context.arguments?.staged === true;
  const comparison = staged
    ? `staged${from === undefined ? "" : ` from ${shortRevision(from)}`}`
    : from === undefined
      ? "working tree"
      : to === undefined
        ? `from ${shortRevision(from)}`
        : `${shortRevision(from)}..${shortRevision(to)}`;
  const pathsShown = integer(context.result?.pathsShown);
  return renderGitText(
    context,
    `git diff ${comparison}${pathsShown === undefined ? "" : ` · ${pathsShown} path${pathsShown === 1 ? "" : "s"}`}`,
    context.arguments?.statOnly !== true,
  );
}

function renderGitText(
  context: ToolRenderContext,
  summary: string,
  richDiff: boolean,
): ToolPresentation {
  const failure = resultFailure(context, summary);
  if (failure !== undefined) return failure;
  if (context.result === undefined) return rawOrEmpty(context, summary);
  const output = stringValue(context.result.output) ?? "";
  const rows = output.length === 0
    ? [line("(no output)", "muted")]
    : richDiff
      ? renderRichDiffRows(output, context.width)
      : wrapRows(output, context.width, "output");
  appendGitWarnings(rows, context.result);
  return {
    summary,
    collapsed: headPreview(rows, 6),
    expanded: boundedRows(rows),
  };
}

function appendGitWarnings(
  rows: ToolPresentationLine[],
  result: Record<string, unknown>,
): void {
  const omitted = integer(result.omittedProtectedPaths);
  if (omitted !== undefined && omitted > 0) {
    rows.push(line(`${omitted} protected path${omitted === 1 ? "" : "s"} omitted`, "warning"));
  }
  if (result.pathsTruncated === true) rows.push(line("Changed path set truncated", "warning"));
  if (result.truncated === true) rows.push(line(truncationSummary(result), "warning"));
}

function shortRevision(value: string): string {
  return value.length > 12 && /^[0-9a-f]+$/iu.test(value) ? value.slice(0, 12) : oneLine(value);
}

function renderReadImage(context: ToolRenderContext): ToolPresentation {
  const argumentPath = stringValue(context.arguments?.path) ?? "...";
  const failure = resultFailure(context, argumentPath);
  if (failure !== undefined) return failure;
  if (context.result === undefined) return rawOrEmpty(context, argumentPath);

  const path = stringValue(context.result.path) ?? argumentPath;
  const mimeType = stringValue(context.result.mimeType) ?? "image";
  const bytes = integer(context.result.byteLength);
  const detail = `${mimeType}${bytes === undefined ? "" : ` · ${formatBytes(bytes)}`}`;
  return {
    summary: `${path} · ${detail}`,
    collapsed: [],
    expanded: [line("Image attached to model context", "muted")],
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
  const changedRows = rows.filter((row) => row.tone === "added" || row.tone === "removed");
  const collapsed = changedRows.length === 0
    ? [line(`${changes.added + changes.removed} changed lines · ${counts}`, "muted")]
    : [
        ...changedRows.slice(0, 8),
        ...(changedRows.length > 8
          ? [line(`... ${changedRows.length - 8} more changed lines`, "muted")]
          : []),
      ];
  return {
    summary: `${path} · ${replacementText} · ${counts}`,
    // Pi/Prime keep the useful part of an edit visible in the normal tool
    // row. Context remains available through Ctrl+O, while the first changed
    // lines make a write auditable without opening every tool panel.
    collapsed,
    expanded: boundedRows(rows),
  };
}

function renderApplyPatch(context: ToolRenderContext): ToolPresentation {
  const failure = resultFailure(context, "patch");
  if (failure !== undefined) return failure;
  const patch = stringValue(context.arguments?.patch) ?? "";
  const changes = Array.isArray(context.result?.changes)
    ? context.result.changes.filter(isRecord)
    : [];
  const status = context.result === undefined
    ? context.status === "failed" ? "failed" : "running"
    : stringValue(context.result.status)
      ?? (context.status === "failed" ? "failed" : "applied");
  const summary = changes.length === 0
    ? `patch · ${status}`
    : `${changes.length} file${changes.length === 1 ? "" : "s"} · ${status}`;
  const diffSource = patch
    .split("\n")
    .filter((line) => line.startsWith("+") || line.startsWith("-")
      || line.startsWith(" ") || line.startsWith("@@") || line.startsWith("*** "))
    .join("\n");
  const rows = diffSource.length === 0
    ? [line("(no diff available)", "muted")]
    : renderRichDiffRows(diffSource, context.width);
  const changedRows = rows.filter((row) => row.tone === "added" || row.tone === "removed");
  const added = changedRows.filter((row) => row.tone === "added").length;
  const removed = changedRows.filter((row) => row.tone === "removed").length;
  const collapsed = changedRows.length === 0
    ? [line(`${summary} · no changed lines`, "muted")]
    : [
        ...changedRows.slice(0, 8),
        ...(changedRows.length > 8
          ? [line(`... ${changedRows.length - 8} more changed lines`, "muted")]
          : []),
      ];
  return {
    summary: `${summary} · +${added} -${removed}`,
    collapsed,
    expanded: boundedRows(rows),
  };
}

function renderDirectoryCreate(context: ToolRenderContext): ToolPresentation {
  const argumentPath = stringValue(context.arguments?.path) ?? "...";
  const failure = resultFailure(context, argumentPath);
  if (failure !== undefined) return failure;
  if (context.result === undefined) return rawOrEmpty(context, argumentPath);

  const path = stringValue(context.result.path) ?? argumentPath;
  const created = context.result.created === true;
  const parents = context.result.parents === true;
  return {
    summary: `${path} · ${created ? "created" : "already exists"}`,
    collapsed: [],
    expanded: [line(parents ? "Parent creation enabled" : "Parent creation disabled", "muted")],
  };
}

function renderPathCopy(context: ToolRenderContext): ToolPresentation {
  return renderPathTransfer(context, "copied");
}

function renderPathMove(context: ToolRenderContext): ToolPresentation {
  return renderPathTransfer(context, "moved");
}

function renderPathTransfer(
  context: ToolRenderContext,
  action: "copied" | "moved",
): ToolPresentation {
  const fromArgument = stringValue(context.arguments?.from) ?? "...";
  const toArgument = stringValue(context.arguments?.to) ?? "...";
  const callSummary = `${fromArgument} -> ${toArgument}`;
  const failure = resultFailure(context, callSummary);
  if (failure !== undefined) return failure;
  if (context.result === undefined) return rawOrEmpty(context, callSummary);

  const from = stringValue(context.result.from) ?? fromArgument;
  const to = stringValue(context.result.to) ?? toArgument;
  const type = stringValue(context.result.type);
  const bytes = integer(context.result.bytes);
  const detail = [action, type, bytes === undefined ? undefined : formatBytes(bytes)]
    .filter((value): value is string => value !== undefined)
    .join(" · ");
  return {
    summary: `${from} -> ${to} · ${detail}`,
    collapsed: [],
    expanded: [],
  };
}

function renderPathDelete(context: ToolRenderContext): ToolPresentation {
  const argumentPath = stringValue(context.arguments?.path) ?? "...";
  const failure = resultFailure(context, argumentPath);
  if (failure !== undefined) return failure;
  if (context.result === undefined) return rawOrEmpty(context, argumentPath);

  const path = stringValue(context.result.path) ?? argumentPath;
  const type = stringValue(context.result.type) ?? "path";
  const recursive = context.result.recursive === true;
  return {
    summary: `${path} · ${type} deleted${recursive ? " recursively" : ""}`,
    collapsed: [],
    expanded: [],
  };
}

function renderWebFetch(context: ToolRenderContext): ToolPresentation {
  const argumentUrl = stringValue(context.arguments?.url) ?? "...";
  const failure = resultFailure(context, argumentUrl);
  if (failure !== undefined) return failure;
  if (context.result === undefined) return rawOrEmpty(context, argumentUrl);

  const url = stringValue(context.result.url) ?? argumentUrl;
  const statusCode = integer(context.result.statusCode);
  const contentType = stringValue(context.result.contentType);
  const body = isRecord(context.result.body) ? context.result.body : undefined;
  const kind = stringValue(body?.kind);
  const content = stringValue(body?.content) ?? "";
  const rows = content.length === 0
    ? [line("(empty response)", "muted")]
    : wrapRows(content, context.width, "output");
  if (statusCode !== undefined && statusCode >= 400) {
    rows.push(line(`HTTP ${statusCode}`, "warning"));
  }
  if (context.result.truncated === true) rows.push(line("... response truncated", "warning"));
  const metadata = [
    statusCode === undefined ? undefined : `HTTP ${statusCode}`,
    kind ?? contentType,
    content.length === 0 ? undefined : formatBytes(Buffer.byteLength(content, "utf8")),
    context.result.truncated === true ? "more" : undefined,
  ].filter((value): value is string => value !== undefined).join(" · ");
  return {
    summary: `${url}${metadata.length === 0 ? "" : ` · ${metadata}`}`,
    collapsed: headPreview(rows, 3),
    expanded: boundedRows(rows),
  };
}

function renderWebSearch(context: ToolRenderContext): ToolPresentation {
  const queries = stringArray(context.arguments?.queries);
  const querySummary = queries.length === 0
    ? "web search"
    : queries.length === 1
      ? oneLine(queries[0] ?? "")
      : `${queries.length} searches`;
  const failure = resultFailure(context, querySummary);
  if (failure !== undefined) return failure;
  if (context.result === undefined) return rawOrEmpty(context, querySummary);

  const sources = Array.isArray(context.result.sources)
    ? context.result.sources.filter(isRecord)
    : [];
  const expanded: ToolPresentationLine[] = [];
  const content = stringValue(context.result.content);
  if (content !== undefined && content.length > 0) {
    expanded.push(...wrapRows(content, context.width, "output"));
  }
  const collapsed: ToolPresentationLine[] = [];
  for (const [index, source] of sources.entries()) {
    const url = stringValue(source.url) ?? "unknown source";
    const title = stringValue(source.title) ?? url;
    collapsed.push(...wrapPrefixed(`${index + 1}. `, `${title} · ${url}`, context.width, "output"));
    expanded.push(...wrapPrefixed(`${index + 1}. `, title, context.width, "output"));
    if (title !== url) expanded.push(...wrapRows(url, context.width, "muted"));
    const snippet = stringValue(source.snippet);
    if (snippet !== undefined) expanded.push(...wrapRows(snippet, context.width, "context"));
    const publishedAt = stringValue(source.publishedAt);
    if (publishedAt !== undefined) expanded.push(line(`Published ${publishedAt}`, "muted"));
  }
  if (sources.length === 0 && expanded.length === 0) expanded.push(line("No sources", "muted"));
  if (context.result.truncated === true) {
    collapsed.push(line("... more sources", "warning"));
    expanded.push(line("... more sources", "warning"));
  }
  return {
    summary: `${querySummary} · ${sources.length} source${sources.length === 1 ? "" : "s"}${context.result.truncated === true ? " · more" : ""}`,
    collapsed: headPreview(collapsed, 3),
    expanded: boundedRows(expanded),
  };
}

function renderProcessStart(context: ToolRenderContext): ToolPresentation {
  const command = stringValue(context.arguments?.command) ?? "...";
  const failure = resultFailure(context, `$ ${oneLine(command)}`);
  if (failure !== undefined) return failure;
  if (context.result === undefined) return rawOrEmpty(context, `$ ${oneLine(command)}`);
  return renderProcessSnapshot(context, `$ ${oneLine(command)}`, true);
}

function renderProcessStatus(context: ToolRenderContext): ToolPresentation {
  return renderProcessSnapshot(context, stringValue(context.arguments?.jobId) ?? "process", false);
}

function renderProcessKill(context: ToolRenderContext): ToolPresentation {
  return renderProcessSnapshot(context, stringValue(context.arguments?.jobId) ?? "process", false);
}

function renderProcessSnapshot(
  context: ToolRenderContext,
  callSummary: string,
  preserveCallSummary: boolean,
): ToolPresentation {
  const failure = resultFailure(context, callSummary);
  if (failure !== undefined) return failure;
  if (context.result === undefined) return rawOrEmpty(context, callSummary);

  const id = stringValue(context.result.id) ?? stringValue(context.arguments?.jobId) ?? "process";
  const state = stringValue(context.result.state) ?? context.status;
  const pid = nullableNumber(context.result.pid);
  const exitCode = nullableNumber(context.result.exitCode);
  const signal = stringValue(context.result.signal);
  const rows: ToolPresentationLine[] = [
    line(`${id}${pid === undefined || pid === null ? "" : ` · pid ${pid}`}`, "muted"),
  ];
  if (exitCode !== undefined && exitCode !== null) rows.push(line(`Exit code ${exitCode}`, exitCode === 0 ? "muted" : "error"));
  if (signal !== undefined) rows.push(line(`Signal ${signal}`, "warning"));
  const startedAt = stringValue(context.result.startedAt);
  const endedAt = stringValue(context.result.endedAt);
  if (startedAt !== undefined) rows.push(line(`Started ${startedAt}`, "muted"));
  if (endedAt !== undefined) rows.push(line(`Ended ${endedAt}`, "muted"));
  appendProcessOutputCounters(rows, "stdout", context.result.stdout);
  appendProcessOutputCounters(rows, "stderr", context.result.stderr);
  return {
    summary: `${preserveCallSummary ? callSummary : id} · ${state}`,
    collapsed: rows.slice(0, 1),
    expanded: rows,
  };
}

function renderProcessOutput(context: ToolRenderContext): ToolPresentation {
  const argumentId = stringValue(context.arguments?.jobId) ?? "process";
  const failure = resultFailure(context, argumentId);
  if (failure !== undefined) return failure;
  if (context.result === undefined) return rawOrEmpty(context, argumentId);

  const id = stringValue(context.result.jobId) ?? argumentId;
  const state = stringValue(context.result.state) ?? "unknown";
  const stream = stringValue(context.result.stream) ?? "both";
  const rows: ToolPresentationLine[] = [];
  appendProcessOutput(rows, context.result.stdout, "output", context.width);
  appendProcessOutput(rows, context.result.stderr, "error", context.width);
  if (rows.length === 0) rows.push(line("(no output)", "muted"));
  return {
    summary: `${id} · ${state} · ${stream}`,
    collapsed: tailPreview(rows, BASH_PREVIEW_LINES),
    expanded: boundedTailRows(rows),
  };
}

function renderProcessList(context: ToolRenderContext): ToolPresentation {
  const failure = resultFailure(context, "process jobs");
  if (failure !== undefined) return failure;
  const entries = parseArray(context.rawResult).filter(isRecord);
  if (entries.length === 0 && context.rawResult.length === 0) {
    return { summary: "process jobs", collapsed: [], expanded: [] };
  }
  const rows: ToolPresentationLine[] = [];
  for (const entry of entries) {
    const snapshot = isRecord(entry.snapshot) ? entry.snapshot : entry;
    const id = stringValue(snapshot.id) ?? "unknown-job";
    const state = stringValue(snapshot.state) ?? "unknown";
    const pid = nullableNumber(snapshot.pid);
    const registryStatus = stringValue(entry.status);
    rows.push(...wrapRows(
      `${id} · ${state}${pid === undefined || pid === null ? "" : ` · pid ${pid}`}${registryStatus === undefined ? "" : ` · ${registryStatus}`}`,
      context.width,
      state === "failed" || state === "output_limited" ? "error" : "output",
    ));
  }
  if (rows.length === 0) rows.push(line("No process jobs", "muted"));
  return {
    summary: `${entries.length} process job${entries.length === 1 ? "" : "s"}`,
    collapsed: headPreview(rows, 5),
    expanded: boundedRows(rows),
  };
}

function renderDelegateTask(context: ToolRenderContext): ToolPresentation {
  const statement = stringValue(context.arguments?.statement) ?? "Worker task";
  const failure = resultFailure(context, oneLine(statement));
  if (failure !== undefined) return failure;
  if (context.result === undefined) return rawOrEmpty(context, oneLine(statement));

  const taskId = stringValue(context.result.taskId) ?? stringValue(context.arguments?.taskId);
  const status = stringValue(context.result.status) ?? "queued";
  const rows: ToolPresentationLine[] = [];
  if (taskId !== undefined) rows.push(line(`${taskId} · ${status}`, "muted"));
  const successCriteria = stringArray(context.arguments?.successCriteria);
  for (const criterion of successCriteria) rows.push(...wrapPrefixed("success  ", criterion, context.width, "context"));
  const hardConstraints = stringArray(context.arguments?.hardConstraints);
  for (const constraint of hardConstraints) rows.push(...wrapPrefixed("limit    ", constraint, context.width, "warning"));
  const input = stringValue(context.arguments?.input);
  if (input !== undefined) rows.push(line(`Input ${formatBytes(Buffer.byteLength(input, "utf8"))}`, "muted"));
  const maxModelTokens = integer(context.arguments?.maxModelTokens);
  const maxWallClockMs = integer(context.arguments?.maxWallClockMs);
  if (maxModelTokens !== undefined || maxWallClockMs !== undefined) {
    rows.push(line([
      maxModelTokens === undefined ? undefined : `${maxModelTokens} tokens`,
      maxWallClockMs === undefined ? undefined : formatDuration(maxWallClockMs),
    ].filter((value): value is string => value !== undefined).join(" · "), "muted"));
  }
  return {
    summary: `${oneLine(statement)} · ${status}`,
    collapsed: taskId === undefined ? [] : [line(taskId, "muted")],
    expanded: rows,
  };
}

function renderAdviceResponse(context: ToolRenderContext): ToolPresentation {
  const adviceId = stringValue(context.arguments?.adviceId) ?? "advice";
  const disposition = stringValue(context.arguments?.disposition) ?? "respond";
  const failure = resultFailure(context, `${disposition} ${adviceId}`);
  if (failure !== undefined) return failure;
  const status = stringValue(context.result?.status);
  const reason = stringValue(context.arguments?.reason);
  const rows = reason === undefined ? [] : wrapRows(reason, context.width, "context");
  return {
    summary: `${disposition} ${adviceId}${status === undefined ? "" : ` · ${status}`}`,
    collapsed: [],
    expanded: rows,
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
  const error = toolErrorMessage(context.result?.error);
  if (error === undefined && context.status !== "failed") return undefined;
  const message = (error ?? context.rawResult) || "Tool failed";
  const rows = wrapRows(message, context.width, "error");
  const diagnostic = isRecord(context.result?.diagnostic)
    ? stringValue(context.result.diagnostic.hint)
    : undefined;
  if (diagnostic !== undefined) {
    rows.push(...wrapRows(`Hint: ${diagnostic}`, context.width, "warning"));
  }
  return {
    summary: error === undefined ? fallbackSummary : oneLine(error),
    collapsed: rows,
    expanded: rows,
  };
}

function toolErrorMessage(value: unknown): string | undefined {
  const direct = stringValue(value);
  if (direct !== undefined) return direct;
  if (!isRecord(value)) return undefined;
  const message = stringValue(value.message);
  const code = stringValue(value.code);
  if (message === undefined) return code;
  return code === undefined ? message : `${code}: ${message}`;
}

function appendProcessOutputCounters(
  rows: ToolPresentationLine[],
  label: "stdout" | "stderr",
  value: unknown,
): void {
  if (!isRecord(value)) return;
  const totalLines = integer(value.totalLines);
  const totalBytes = integer(value.totalBytes);
  if ((totalLines ?? 0) === 0 && (totalBytes ?? 0) === 0) return;
  rows.push(line(
    `${label} · ${totalLines ?? 0} lines · ${formatBytes(totalBytes ?? 0)}${value.truncated === true ? " · truncated" : ""}`,
    value.truncated === true ? "warning" : "muted",
  ));
}

function appendProcessOutput(
  rows: ToolPresentationLine[],
  value: unknown,
  tone: "output" | "error",
  width: number,
): void {
  if (!isRecord(value)) return;
  const content = stringValue(value.content) ?? "";
  if (content.length > 0) rows.push(...wrapRows(content, width, tone, "tail"));
  if (value.truncated === true) {
    const outputBytes = integer(value.outputBytes);
    const totalBytes = integer(value.totalBytes);
    rows.push(line(
      outputBytes !== undefined && totalBytes !== undefined
        ? `${tone === "error" ? "stderr" : "stdout"} truncated · showing ${formatBytes(outputBytes)} of ${formatBytes(totalBytes)}`
        : `${tone === "error" ? "stderr" : "stdout"} truncated`,
      "warning",
    ));
  }
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

function headPreview(rows: readonly ToolPresentationLine[], maximum: number): ToolPresentationLine[] {
  if (rows.length <= maximum) return [...rows];
  return [
    ...rows.slice(0, maximum),
    line(`... ${rows.length - maximum} more lines`, "muted"),
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

function parseArray(value: string): unknown[] {
  if (value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map(safeText)
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}
