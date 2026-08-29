import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { AgentTool, ToolExecutionContext, ToolResult } from "../domain/ports.js";
import {
  isWorkspacePathAllowed,
  resolveExistingWorkspacePath,
  revalidateExistingWorkspacePath,
  type WorkspacePathPolicy,
} from "./workspace-path.js";

// Safety behavior follows Prime Agent 7787f074 (MIT) and Codex 31d338a1
// (Apache-2.0): fixed argv, bounded output, and no repository-configured helpers.
export const GIT_TOOL_TIMEOUT_MS = 30_000;
export const GIT_TOOL_MAX_OUTPUT_BYTES = 50 * 1024;
export const GIT_TOOL_MAX_OUTPUT_LINES = 2_000;

const GIT_DISCOVERY_MAX_BYTES = 512 * 1024;
const GIT_DISCOVERY_MAX_PATHS = 256;
const GIT_DISCOVERY_MAX_ARG_BYTES = 64 * 1024;
const GIT_MAX_FILTER_OVERRIDES = 128;
const GIT_MAX_PATH_ARGUMENTS = 64;
const GIT_MAX_LOG_COUNT = 100;

export interface GitToolOptions extends WorkspacePathPolicy {
  /** Trusted absolute executable override for tests or an embedding host. Never model-controlled. */
  gitBinary?: string;
  /** May only lower the fixed 30 second operation deadline. */
  timeoutMs?: number;
}

interface NormalizedGitOptions {
  gitBinary?: string;
  timeoutMs: number;
  policy: WorkspacePathPolicy;
}

interface GitRepository {
  workspace: string;
  gitBinary: string;
  configOverrides: string[];
  deadline: number;
}

interface GitExecution {
  stdout: OutputCapture;
  stderr: OutputCapture;
  exitCode: number | null;
  aborted: boolean;
  timedOut: boolean;
  spawnError?: Error;
}

interface DiscoveredPaths {
  paths: string[];
  omittedProtectedPaths: number;
  truncated: boolean;
}

export function createGitStatusTool(options: GitToolOptions = {}): AgentTool {
  const normalized = normalizeOptions(options);
  return {
    definition: {
      name: "git_status",
      description: "Inspect the current workspace repository status without enabling shell access. Returns bounded porcelain entries and omits protected paths.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    async execute(_arguments, context): Promise<ToolResult> {
      return await executeSafely(async () => {
        const repository = await openRepository(normalized, context);
        const execution = await runGit(
          normalized,
          repository,
          [
            "status",
            "--porcelain=v1",
            "-z",
            "--branch",
            "--untracked-files=all",
            "--ignore-submodules=all",
            "--no-renames",
            "--",
            ".",
          ],
          context.signal,
          GIT_TOOL_MAX_OUTPUT_BYTES,
        );
        assertSucceeded(execution, "git status");

        const records = completeNullRecords(execution.stdout.rawContent());
        let branch: string | undefined;
        let omittedProtectedPaths = 0;
        const entries: Array<{ status: string; path: string }> = [];
        for (const record of records) {
          if (record.startsWith("## ")) {
            branch = sanitizeText(record.slice(3));
            continue;
          }
          if (record.length < 4 || record[2] !== " ") continue;
          const candidate = record.slice(3);
          if (!isSafeRepositoryPath(repository.workspace, candidate, normalized.policy)) {
            omittedProtectedPaths += 1;
            continue;
          }
          entries.push({ status: record.slice(0, 2), path: sanitizeText(candidate) });
        }
        const output = [
          ...(branch === undefined ? [] : [`## ${branch}`]),
          ...entries.map((entry) => `${entry.status} ${entry.path}`),
        ].join("\n");
        return success({
          ...(branch === undefined ? {} : { branch }),
          entries,
          output,
          omittedProtectedPaths,
          truncated: execution.stdout.truncated,
          truncation: execution.stdout.metadata(),
        });
      });
    },
  };
}

export function createGitLogTool(options: GitToolOptions = {}): AgentTool {
  const normalized = normalizeOptions(options);
  return {
    definition: {
      name: "git_log",
      description: "Read bounded commit history from the workspace repository. Revisions and path selectors are validated and cannot become Git options.",
      parameters: {
        type: "object",
        properties: {
          revision: { type: "string", description: "Commit-ish to start from; defaults to HEAD" },
          maxCount: {
            type: "integer",
            minimum: 1,
            maximum: GIT_MAX_LOG_COUNT,
            description: "Maximum commits to return; defaults to 10",
          },
          paths: {
            type: "array",
            items: { type: "string" },
            maxItems: GIT_MAX_PATH_ARGUMENTS,
            description: "Optional workspace-relative history paths",
          },
        },
        additionalProperties: false,
      },
    },
    async execute(arguments_, context): Promise<ToolResult> {
      return await executeSafely(async () => {
        const repository = await openRepository(normalized, context);
        const revision = await resolveCommit(
          normalized,
          repository,
          optionalString(arguments_.revision, "revision") ?? "HEAD",
          context.signal,
        );
        const maxCount = boundedInteger(arguments_.maxCount, "maxCount", 10, GIT_MAX_LOG_COUNT);
        const paths = normalizePathArguments(arguments_.paths, repository.workspace, normalized.policy);
        const execution = await runGit(
          normalized,
          repository,
          [
            "log",
            "--no-patch",
            "--no-color",
            "--date=iso-strict",
            "--decorate=short",
            "--format=fuller",
            `--max-count=${maxCount}`,
            revision,
            ...(paths.length === 0 ? [] : ["--", ...paths.map(literalPathspec)]),
          ],
          context.signal,
          GIT_TOOL_MAX_OUTPUT_BYTES,
        );
        assertSucceeded(execution, "git log");
        return outputResult(execution, { revision, maxCount });
      });
    },
  };
}

export function createGitShowTool(options: GitToolOptions = {}): AgentTool {
  const normalized = normalizeOptions(options);
  return {
    definition: {
      name: "git_show",
      description: "Show one commit and its bounded patch or stat. Only changed files inside the workspace's readable path boundary are included.",
      parameters: {
        type: "object",
        properties: {
          revision: { type: "string", description: "Commit-ish to show; defaults to HEAD" },
          paths: {
            type: "array",
            items: { type: "string" },
            maxItems: GIT_MAX_PATH_ARGUMENTS,
            description: "Optional workspace-relative paths",
          },
          statOnly: { type: "boolean", description: "Return commit metadata and stats without a patch" },
        },
        additionalProperties: false,
      },
    },
    async execute(arguments_, context): Promise<ToolResult> {
      return await executeSafely(async () => {
        const repository = await openRepository(normalized, context);
        const revision = await resolveCommit(
          normalized,
          repository,
          optionalString(arguments_.revision, "revision") ?? "HEAD",
          context.signal,
        );
        const selectors = normalizePathArguments(
          arguments_.paths,
          repository.workspace,
          normalized.policy,
        );
        const statOnly = optionalBoolean(arguments_.statOnly, "statOnly", false);
        const discovered = await discoverPaths(
          normalized,
          repository,
          [
            "diff-tree",
            "--root",
            "--no-commit-id",
            "--name-only",
            "-r",
            "-m",
            "--no-renames",
            "-z",
            revision,
            ...(selectors.length === 0 ? [] : ["--", ...selectors.map(literalPathspec)]),
          ],
          context.signal,
        );

        const patchArguments = discovered.paths.length === 0
          ? ["--no-patch"]
          : statOnly
            ? ["--stat", "--summary"]
            : ["--patch"];
        const execution = await runGit(
          normalized,
          repository,
          [
            "show",
            "--format=fuller",
            "--date=iso-strict",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--ignore-submodules=all",
            "--no-renames",
            ...patchArguments,
            revision,
            ...(discovered.paths.length === 0
              ? []
              : ["--", ...discovered.paths.map(literalPathspec)]),
          ],
          context.signal,
          GIT_TOOL_MAX_OUTPUT_BYTES,
        );
        assertSucceeded(execution, "git show");
        return outputResult(execution, {
          revision,
          statOnly,
          pathsShown: discovered.paths.length,
          omittedProtectedPaths: discovered.omittedProtectedPaths,
          pathsTruncated: discovered.truncated,
        });
      });
    },
  };
}

export function createGitDiffTool(options: GitToolOptions = {}): AgentTool {
  const normalized = normalizeOptions(options);
  return {
    definition: {
      name: "git_diff",
      description: "Read a bounded working-tree, staged, or commit-to-commit diff. It never invokes configured diff/textconv helpers and omits protected paths.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Optional base commit-ish" },
          to: { type: "string", description: "Optional target commit-ish; requires from" },
          staged: { type: "boolean", description: "Compare the index against from or HEAD" },
          paths: {
            type: "array",
            items: { type: "string" },
            maxItems: GIT_MAX_PATH_ARGUMENTS,
            description: "Optional workspace-relative paths",
          },
          statOnly: { type: "boolean", description: "Return stats without a patch" },
        },
        additionalProperties: false,
      },
    },
    async execute(arguments_, context): Promise<ToolResult> {
      return await executeSafely(async () => {
        const repository = await openRepository(normalized, context);
        const staged = optionalBoolean(arguments_.staged, "staged", false);
        const statOnly = optionalBoolean(arguments_.statOnly, "statOnly", false);
        const fromInput = optionalString(arguments_.from, "from");
        const toInput = optionalString(arguments_.to, "to");
        if (toInput !== undefined && fromInput === undefined) {
          throw new TypeError("to requires from");
        }
        if (staged && toInput !== undefined) {
          throw new TypeError("staged cannot be combined with to");
        }
        const from = fromInput === undefined
          ? undefined
          : await resolveCommit(normalized, repository, fromInput, context.signal);
        const to = toInput === undefined
          ? undefined
          : await resolveCommit(normalized, repository, toInput, context.signal);
        const selectors = normalizePathArguments(
          arguments_.paths,
          repository.workspace,
          normalized.policy,
        );
        const comparison = [
          ...(staged ? ["--cached"] : []),
          ...(from === undefined ? [] : [from]),
          ...(to === undefined ? [] : [to]),
        ];
        const common = [
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--ignore-submodules=all",
          "--no-renames",
        ];
        const discovered = await discoverPaths(
          normalized,
          repository,
          [
            "diff",
            ...common,
            ...comparison,
            "--name-only",
            "-z",
            "--",
            ...(selectors.length === 0 ? ["."] : selectors.map(literalPathspec)),
          ],
          context.signal,
        );
        if (discovered.paths.length === 0) {
          return success({
            output: "",
            statOnly,
            pathsShown: 0,
            omittedProtectedPaths: discovered.omittedProtectedPaths,
            pathsTruncated: discovered.truncated,
            truncated: false,
            truncation: emptyTruncation(),
          });
        }

        const execution = await runGit(
          normalized,
          repository,
          [
            "diff",
            ...common,
            ...comparison,
            ...(statOnly ? ["--stat", "--summary"] : ["--patch"]),
            "--",
            ...discovered.paths.map(literalPathspec),
          ],
          context.signal,
          GIT_TOOL_MAX_OUTPUT_BYTES,
        );
        assertSucceeded(execution, "git diff");
        return outputResult(execution, {
          statOnly,
          pathsShown: discovered.paths.length,
          omittedProtectedPaths: discovered.omittedProtectedPaths,
          pathsTruncated: discovered.truncated,
        });
      });
    },
  };
}

export function createGitTools(options: GitToolOptions = {}): AgentTool[] {
  return [
    createGitStatusTool(options),
    createGitLogTool(options),
    createGitShowTool(options),
    createGitDiffTool(options),
  ];
}

export const gitStatusTool = createGitStatusTool();
export const gitLogTool = createGitLogTool();
export const gitShowTool = createGitShowTool();
export const gitDiffTool = createGitDiffTool();

async function openRepository(
  options: NormalizedGitOptions,
  context: ToolExecutionContext,
): Promise<GitRepository> {
  throwIfAborted(context.signal);
  const root = await resolveExistingWorkspacePath(context.workspace, ".", options.policy);
  const rootInfo = await revalidateExistingWorkspacePath(root);
  if (!rootInfo.isDirectory()) throw new Error("Workspace is not a directory");
  const repository: GitRepository = {
    workspace: root.workspace,
    gitBinary: options.gitBinary ?? await resolveTrustedGitBinary(root.workspace),
    configOverrides: [],
    deadline: Date.now() + options.timeoutMs,
  };
  const topLevel = await runGit(
    options,
    repository,
    ["rev-parse", "--show-toplevel"],
    context.signal,
    8 * 1024,
  );
  assertSucceeded(topLevel, "git repository check");
  const reported = topLevel.stdout.rawContent().trim();
  if (reported.length === 0 || reported.includes("\0")) {
    throw new Error("Git did not report a repository root");
  }
  const canonicalTopLevel = await realpath(reported);
  if (canonicalTopLevel !== root.workspace) {
    throw new Error("Git repository root must equal the workspace root");
  }

  const filterConfig = await runGit(
    options,
    repository,
    // Read the effective repository configuration so per-worktree and
    // repository-included filter drivers are neutralized as well. Global and
    // system configuration are already disabled by safeGitEnvironment().
    ["config", "--includes", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process)$"],
    context.signal,
    32 * 1024,
  );
  if (filterConfig.exitCode !== 0 && filterConfig.exitCode !== 1) {
    assertSucceeded(filterConfig, "git filter safety check");
  }
  if (filterConfig.stdout.truncated) {
    throw new Error("Repository defines too many executable filter settings");
  }
  const keys = [...new Set(filterConfig.stdout.rawContent().split("\n").filter(Boolean))];
  if (keys.length > GIT_MAX_FILTER_OVERRIDES) {
    throw new Error("Repository defines too many executable filter settings");
  }
  for (const key of keys) {
    if (!/^filter\..+\.(?:clean|process)$/i.test(key) || /[\0\r\n=]/u.test(key)) {
      throw new Error("Repository contains an unsafe filter setting name");
    }
  }
  repository.configOverrides = keys.map((key) => `${key}=`);
  return repository;
}

async function resolveCommit(
  options: NormalizedGitOptions,
  repository: GitRepository,
  input: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const revision = validateRevision(input);
  const execution = await runGit(
    options,
    repository,
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`],
    signal,
    8 * 1024,
  );
  assertSucceeded(execution, `resolve revision ${revision}`);
  const resolved = execution.stdout.rawContent().trim();
  if (!/^[0-9a-f]{40,64}$/u.test(resolved)) {
    throw new Error("Git returned an invalid commit identifier");
  }
  return resolved;
}

async function discoverPaths(
  options: NormalizedGitOptions,
  repository: GitRepository,
  arguments_: string[],
  signal: AbortSignal | undefined,
): Promise<DiscoveredPaths> {
  const execution = await runGit(
    options,
    repository,
    arguments_,
    signal,
    GIT_DISCOVERY_MAX_BYTES,
  );
  assertSucceeded(execution, `git ${arguments_[0] ?? "path discovery"}`);
  const records = completeNullRecords(execution.stdout.rawContent());
  const paths: string[] = [];
  let pathArgumentBytes = 0;
  let omittedProtectedPaths = 0;
  let truncated = execution.stdout.truncated;
  for (const candidate of records) {
    if (!isSafeRepositoryPath(repository.workspace, candidate, options.policy)) {
      omittedProtectedPaths += 1;
      continue;
    }
    const candidateBytes = Buffer.byteLength(candidate, "utf8") + 16;
    if (paths.length >= GIT_DISCOVERY_MAX_PATHS
      || pathArgumentBytes + candidateBytes > GIT_DISCOVERY_MAX_ARG_BYTES) {
      truncated = true;
      continue;
    }
    paths.push(candidate);
    pathArgumentBytes += candidateBytes;
  }
  return { paths: [...new Set(paths)], omittedProtectedPaths, truncated };
}

async function runGit(
  options: NormalizedGitOptions,
  repository: GitRepository,
  commandArguments: readonly string[],
  signal: AbortSignal | undefined,
  stdoutLimit: number,
): Promise<GitExecution> {
  const stdout = new OutputCapture(stdoutLimit);
  const stderr = new OutputCapture(GIT_TOOL_MAX_OUTPUT_BYTES);
  if (signal?.aborted) {
    return { stdout, stderr, exitCode: null, aborted: true, timedOut: false };
  }
  const remaining = repository.deadline - Date.now();
  if (remaining <= 0) {
    return { stdout, stderr, exitCode: null, aborted: false, timedOut: true };
  }
  const argv = [
    "--no-pager",
    "--no-optional-locks",
    ...baseConfigArguments(),
    ...repository.configOverrides.flatMap((entry) => ["-c", entry]),
    ...commandArguments,
  ];

  return await new Promise((resolve) => {
    let child: ChildProcess;
    let settled = false;
    let aborted = false;
    let timedOut = false;
    let spawnError: Error | undefined;
    let hardKillTimer: NodeJS.Timeout | undefined;

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (hardKillTimer !== undefined) clearTimeout(hardKillTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        stdout,
        stderr,
        exitCode,
        aborted,
        timedOut,
        ...(spawnError === undefined ? {} : { spawnError }),
      });
    };
    const terminate = (): void => {
      terminateChild(child, "SIGTERM");
      hardKillTimer = setTimeout(() => terminateChild(child, "SIGKILL"), 250);
      hardKillTimer.unref?.();
    };
    const onAbort = (): void => {
      if (timedOut) return;
      aborted = true;
      terminate();
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, remaining);
    timeoutTimer.unref?.();

    try {
      child = spawn(repository.gitBinary, argv, {
        cwd: repository.workspace,
        detached: process.platform !== "win32",
        env: safeGitEnvironment(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error: unknown) {
      spawnError = asError(error);
      finish(null);
      return;
    }
    child.stdout?.on("data", (chunk: Buffer | string) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => stderr.append(chunk));
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (exitCode) => finish(exitCode));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function baseConfigArguments(): string[] {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  return [
    "-c", "core.pager=cat",
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${nullDevice}`,
    "-c", `core.attributesFile=${nullDevice}`,
    "-c", "diff.external=",
    "-c", "color.ui=false",
    "-c", "log.showSignature=false",
    "-c", "status.submoduleSummary=false",
    "-c", "pager.status=false",
    "-c", "pager.log=false",
    "-c", "pager.show=false",
    "-c", "pager.diff=false",
  ];
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("GIT_CONFIG_")) delete environment[name];
  }
  for (const name of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_EXTERNAL_DIFF",
    "GIT_INDEX_FILE",
    "GIT_NAMESPACE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_WORK_TREE",
  ]) {
    delete environment[name];
  }
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_CONFIG_GLOBAL = nullDevice;
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_SYSTEM = nullDevice;
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_PAGER = "cat";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.PAGER = "cat";
  return environment;
}

class OutputCapture {
  private readonly chunks: Buffer[] = [];
  private retainedBytes = 0;
  private totalBytes = 0;
  private completedLines = 0;
  private hasOpenLine = false;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer | string): void {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (buffer.length === 0) return;
    this.totalBytes += buffer.length;
    for (const byte of buffer) {
      if (byte === 0x0a) this.completedLines += 1;
    }
    this.hasOpenLine = buffer[buffer.length - 1] !== 0x0a;
    const remaining = this.maxBytes - this.retainedBytes;
    if (remaining <= 0) return;
    const retained = buffer.subarray(0, Math.min(remaining, buffer.length));
    this.chunks.push(Buffer.from(retained));
    this.retainedBytes += retained.length;
  }

  rawContent(): string {
    return new TextDecoder().decode(Buffer.concat(this.chunks));
  }

  content(): string {
    const sanitized = sanitizeText(this.rawContent());
    const lines = splitLines(sanitized);
    return lines.length <= GIT_TOOL_MAX_OUTPUT_LINES
      ? sanitized
      : lines.slice(0, GIT_TOOL_MAX_OUTPUT_LINES).join("\n");
  }

  get totalLines(): number {
    return this.completedLines + (this.hasOpenLine ? 1 : 0);
  }

  get truncated(): boolean {
    return this.totalBytes > this.retainedBytes || this.totalLines > GIT_TOOL_MAX_OUTPUT_LINES;
  }

  metadata(): object {
    const content = this.content();
    return {
      truncated: this.truncated,
      truncatedBy: this.truncated
        ? this.totalBytes > this.retainedBytes ? "bytes" : "lines"
        : null,
      totalBytes: this.totalBytes,
      totalLines: this.totalLines,
      outputBytes: Buffer.byteLength(content, "utf8"),
      outputLines: splitLines(content).length,
    };
  }
}

function assertSucceeded(execution: GitExecution, operation: string): void {
  if (execution.spawnError !== undefined) {
    throw new GitExecutionError(`${operation} could not start`, execution);
  }
  if (execution.aborted) throw new GitExecutionError(`${operation} aborted`, execution);
  if (execution.timedOut) {
    throw new GitExecutionError(`${operation} timed out after ${GIT_TOOL_TIMEOUT_MS / 1_000} seconds`, execution);
  }
  if (execution.exitCode !== 0) {
    throw new GitExecutionError(`${operation} exited with code ${execution.exitCode}`, execution);
  }
}

class GitExecutionError extends Error {
  override readonly name = "GitExecutionError";
  constructor(message: string, readonly execution: GitExecution) {
    super(message);
  }
}

function outputResult(execution: GitExecution, metadata: object): ToolResult {
  return success({
    ...metadata,
    output: execution.stdout.content(),
    ...(execution.stderr.content().length === 0 ? {} : { stderr: execution.stderr.content() }),
    truncated: execution.stdout.truncated,
    truncation: execution.stdout.metadata(),
  });
}

async function executeSafely(operation: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof GitExecutionError) {
      return failure({
        error: error.message,
        stderr: error.execution.stderr.content(),
        exitCode: error.execution.exitCode,
        aborted: error.execution.aborted,
        timedOut: error.execution.timedOut,
        truncated: error.execution.stderr.truncated,
      });
    }
    return failure({ error: safeMessage(error) });
  }
}

function normalizeOptions(options: GitToolOptions): NormalizedGitOptions {
  const gitBinary = options.gitBinary;
  if (gitBinary !== undefined && (
    typeof gitBinary !== "string"
    || gitBinary.length === 0
    || gitBinary.includes("\0")
    || !path.isAbsolute(gitBinary)
  )) {
    throw new TypeError("gitBinary must be an absolute path without NUL");
  }
  const timeoutMs = options.timeoutMs ?? GIT_TOOL_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > GIT_TOOL_TIMEOUT_MS) {
    throw new TypeError(`timeoutMs must be an integer between 1 and ${GIT_TOOL_TIMEOUT_MS}`);
  }
  return {
    ...(gitBinary === undefined ? {} : { gitBinary }),
    timeoutMs,
    policy: { protectedPaths: [...(options.protectedPaths ?? [])] },
  };
}

async function resolveTrustedGitBinary(workspace: string): Promise<string> {
  const names = process.platform === "win32"
    ? ["git.exe", "git.com", "git"]
    : ["git"];
  const entries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry.length > 0 && path.isAbsolute(entry));
  for (const entry of entries) {
    for (const name of names) {
      const candidate = path.join(entry, name);
      let canonical: string;
      try {
        canonical = await realpath(candidate);
        const info = await stat(canonical);
        if (!info.isFile()) continue;
        await access(canonical, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      } catch {
        continue;
      }
      if (!isInsideWorkspace(workspace, canonical)) return canonical;
    }
  }
  throw new Error("Cannot locate a trusted Git executable outside the workspace");
}

function isInsideWorkspace(workspace: string, candidate: string): boolean {
  const relative = path.relative(workspace, candidate);
  return relative.length === 0
    || (!path.isAbsolute(relative)
      && relative !== ".."
      && !relative.startsWith(`..${path.sep}`));
}

function validateRevision(value: string): string {
  if (value.length > 256) throw new TypeError("revision must not exceed 256 characters");
  if (value.startsWith("-")) throw new TypeError("revision must not begin with an option prefix");
  if (value.includes(":")) throw new TypeError("revision path expressions are not allowed");
  if (value.includes("..")) throw new TypeError("revision ranges are not allowed here");
  if (/\s|[\0-\x1f\x7f]/u.test(value)) {
    throw new TypeError("revision must not contain whitespace or control characters");
  }
  return value;
}

function normalizePathArguments(
  value: unknown,
  workspace: string,
  policy: WorkspacePathPolicy,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > GIT_MAX_PATH_ARGUMENTS) {
    throw new TypeError(`paths must be an array with at most ${GIT_MAX_PATH_ARGUMENTS} entries`);
  }
  return [...new Set(value.map((entry) => normalizePathArgument(entry, workspace, policy)))];
}

function normalizePathArgument(
  value: unknown,
  workspace: string,
  policy: WorkspacePathPolicy,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("paths must contain non-empty strings");
  }
  if (value.length > 4_096 || value.includes("\0") || /[\r\n]/u.test(value)) {
    throw new TypeError("path contains an invalid character or is too long");
  }
  if (value.startsWith("-") || value.startsWith(":")) {
    throw new TypeError("path must not use an option or pathspec prefix");
  }
  if (path.isAbsolute(value)) throw new TypeError("Absolute paths are outside the workspace contract");
  const absolute = path.resolve(workspace, value);
  const relative = path.relative(workspace, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new TypeError("Path escapes the workspace");
  }
  if (!isWorkspacePathAllowed(workspace, absolute, policy)) {
    throw new TypeError("Access to a protected workspace path is denied");
  }
  return relative.length === 0 ? "." : relative.split(path.sep).join("/");
}

function isSafeRepositoryPath(
  workspace: string,
  candidate: string,
  policy: WorkspacePathPolicy,
): boolean {
  if (candidate.length === 0 || candidate.includes("\0") || path.isAbsolute(candidate)) return false;
  const absolute = path.resolve(workspace, candidate);
  const relative = path.relative(workspace, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return false;
  }
  return isWorkspacePathAllowed(workspace, absolute, policy);
}

function literalPathspec(value: string): string {
  return value === "." ? "." : `:(top,literal)${value}`;
}

function completeNullRecords(content: string): string[] {
  const records = content.split("\0");
  if (!content.endsWith("\0")) records.pop();
  return records.filter((record) => record.length > 0);
}

function terminateChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when process groups are unavailable.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The child may already have exited.
  }
}

function sanitizeText(value: string): string {
  return Array.from(value).filter((character) => {
    const code = character.codePointAt(0);
    if (code === undefined) return false;
    return code === 0x09 || code === 0x0a || code >= 0x20 && code !== 0x7f;
  }).join("").replaceAll("\r", "");
}

function splitLines(value: string): string[] {
  if (value.length === 0) return [];
  const lines = value.split("\n");
  if (value.endsWith("\n")) lines.pop();
  return lines;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalBoolean(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
  return value;
}

function boundedInteger(value: unknown, name: string, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value as number;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}

function emptyTruncation(): object {
  return {
    truncated: false,
    truncatedBy: null,
    totalBytes: 0,
    totalLines: 0,
    outputBytes: 0,
    outputLines: 0,
  };
}

function success(value: unknown): ToolResult {
  return { content: JSON.stringify(value), isError: false };
}

function failure(value: unknown): ToolResult {
  return { content: JSON.stringify(value), isError: true };
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Git operation failed";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Git process failed");
}
