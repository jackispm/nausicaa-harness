import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { resolve } from "node:path";

import type { AgentTool, ToolExecutionContext, ToolResult } from "../domain/ports.js";
import {
  assertRealDirectory,
  assertRegularFile,
  canonicalFilePath,
  openNoFollow,
  syncDirectory,
} from "../ledger/file-utils.js";
import type { MoweToolMetadata } from "../mowe/types.js";
import {
  resolveExistingWorkspacePath,
  type WorkspacePathPolicy,
} from "./workspace-path.js";
import {
  SHELL_MAX_OUTPUT_BYTES,
  type ShellOutputSnapshot,
} from "./shell-output.js";
import {
  spawnShellCommand,
  type StartedShellProcess,
} from "./shell-process.js";

/** The default lifetime is long enough for a dev server, but never unbounded. */
export const DEFAULT_PROCESS_JOB_TIMEOUT_SECONDS = 5 * 60;
export const MAX_PROCESS_JOB_TIMEOUT_SECONDS = 60 * 60;
export const DEFAULT_PROCESS_JOB_MAX_OUTPUT_BYTES = SHELL_MAX_OUTPUT_BYTES;
export const MAX_PROCESS_JOB_OUTPUT_BYTES = SHELL_MAX_OUTPUT_BYTES;
export const DEFAULT_PROCESS_JOB_MAX_JOBS = 32;
export const MAX_PROCESS_JOB_MAX_JOBS = 128;

/** Embedded metadata lets Mowe register these tools without a second list. */
export const PROCESS_JOB_MOWE_METADATA: Readonly<Record<string, MoweToolMetadata>> = Object.freeze({
  process_start: Object.freeze({
    effect: "external",
    deterministic: false,
    supportsBatch: false,
    concurrencySafe: false,
    scope: "run",
    inputKinds: ["text"] as const,
    outputKinds: ["json", "text"] as const,
  }),
  process_status: Object.freeze({
    effect: "read",
    deterministic: false,
    supportsBatch: true,
    concurrencySafe: true,
    scope: "run",
    inputKinds: ["text"] as const,
    outputKinds: ["json"] as const,
  }),
  process_output: Object.freeze({
    effect: "read",
    deterministic: false,
    supportsBatch: true,
    concurrencySafe: true,
    scope: "run",
    inputKinds: ["text"] as const,
    outputKinds: ["json", "text"] as const,
  }),
  process_kill: Object.freeze({
    effect: "external",
    deterministic: false,
    supportsBatch: false,
    concurrencySafe: false,
    scope: "run",
    inputKinds: ["text"] as const,
    outputKinds: ["json"] as const,
  }),
  process_list: Object.freeze({
    effect: "read",
    deterministic: false,
    supportsBatch: false,
    concurrencySafe: true,
    scope: "run",
    inputKinds: ["text"] as const,
    outputKinds: ["json"] as const,
  }),
});

export type ProcessJobState =
  | "running"
  | "succeeded"
  | "failed"
  | "killed"
  | "aborted"
  | "timed_out"
  | "output_limited";

export type ProcessJobTerminationReason =
  | "killed"
  | "aborted"
  | "timed_out"
  | "output_limited";

/**
 * Metadata retained by an optional durable process registry. A registry is a
 * record of what a manager observed, not a process supervisor: a persisted
 * `running` snapshot is reported as `orphaned` after a restart.
 */
export interface ProcessJobRegistryEntry {
  readonly snapshot: ProcessJobSnapshot;
  readonly managerId: string;
  readonly recordedAt: string;
}

export type ProcessJobRegistryStatus = "attached" | "terminal" | "orphaned";

/** A manager-facing view that makes restart state explicit to callers. */
export interface ProcessJobListEntry {
  readonly snapshot: ProcessJobSnapshot;
  readonly status: ProcessJobRegistryStatus;
  readonly persisted: boolean;
}

/** Replaceable persistence boundary for process metadata. */
export interface ProcessJobRegistry {
  load(): Promise<readonly ProcessJobRegistryEntry[]>;
  replace(entries: readonly ProcessJobRegistryEntry[]): Promise<void>;
}

export class ProcessJobRegistryError extends Error {
  override readonly name = "ProcessJobRegistryError";
}

/** Upper bound for one registry snapshot, including retained output tails. */
export const MAX_PROCESS_JOB_REGISTRY_BYTES = 16 * 1024 * 1024;
export const MAX_PROCESS_JOB_REGISTRY_ENTRIES = 1_024;

export interface ProcessJobManagerOptions extends WorkspacePathPolicy {
  /** Maximum number of retained running or terminal jobs. */
  maxJobs?: number;
  /** Default process lifetime in seconds. */
  defaultTimeoutSeconds?: number;
  /** Hard process lifetime cap in seconds. */
  maxTimeoutSeconds?: number;
  /** Default retained output cap. */
  defaultMaxOutputBytes?: number;
  /** Hard retained output cap. Must not exceed the shared shell capture cap. */
  maxOutputBytes?: number;
  /** Optional durable metadata registry. Omit to retain process-local behavior. */
  registry?: ProcessJobRegistry;
  /** Observe asynchronous registry write failures that cannot be thrown to a caller. */
  onRegistryError?: (error: Error) => void;
}

export interface ProcessJobStartRequest {
  command: string;
  timeoutSeconds?: number;
  maxOutputBytes?: number;
}

export interface ProcessJobSnapshot {
  id: string;
  runId: string;
  workspace: string;
  pid: number | null;
  state: ProcessJobState;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  endedAt: string | null;
  timeoutSeconds: number;
  maxOutputBytes: number;
  terminationReason: ProcessJobTerminationReason | null;
  stdout: ShellOutputSnapshot;
  stderr: ShellOutputSnapshot;
}

export interface ProcessJobOutputRequest {
  jobId: string;
  stream?: "stdout" | "stderr" | "both";
  maxBytes?: number;
}

interface ProcessJobRegistrySnapshot {
  readonly version: 1;
  readonly entries: readonly ProcessJobRegistryEntry[];
}

/**
 * In-memory registry useful for embedding and deterministic tests. The
 * manager itself still defaults to no registry, preserving the original
 * process-local behavior.
 */
export class MemoryProcessJobRegistry implements ProcessJobRegistry {
  #entries = new Map<string, ProcessJobRegistryEntry>();

  async load(): Promise<readonly ProcessJobRegistryEntry[]> {
    return [...this.#entries.values()].map(cloneRegistryEntry);
  }

  async replace(entries: readonly ProcessJobRegistryEntry[]): Promise<void> {
    validateRegistryEntries(entries);
    this.#entries = new Map(entries.map((entry) => [entry.snapshot.id, cloneRegistryEntry(entry)]));
  }
}

/**
 * Restart-safe JSON registry for process metadata.
 *
 * This adapter uses the same canonical path, no-follow, private-file and
 * atomic-replacement checks as the Ledger/file stores. It never stores a
 * process handle and therefore cannot claim to resume an old OS process.
 */
export class FileProcessJobRegistry implements ProcessJobRegistry {
  readonly #location: { path: string; parent: string };

  private constructor(location: { path: string; parent: string }) {
    this.#location = location;
  }

  static async open(path: string): Promise<FileProcessJobRegistry> {
    if (typeof path !== "string" || path.trim().length === 0) {
      throw new TypeError("path must be a non-empty string");
    }
    const location = await canonicalFilePath(resolve(path));
    try {
      const info = await lstat(location.path);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new ProcessJobRegistryError(
          `Process job registry is not a regular file: ${location.path}`,
        );
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return new FileProcessJobRegistry(location);
  }

  /** Absolute canonical path, useful for diagnostics and host configuration. */
  get path(): string {
    return this.#location.path;
  }

  async load(): Promise<readonly ProcessJobRegistryEntry[]> {
    let handle: FileHandle;
    try {
      handle = await openNoFollow(this.#location.path, constants.O_RDONLY);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new ProcessJobRegistryError(
          `Refusing symbolic-link process job registry: ${this.#location.path}`,
        );
      }
      throw error;
    }
    try {
      await assertRegularFile(handle, this.#location.path, true);
      const bytes = await handle.readFile();
      if (bytes.byteLength > MAX_PROCESS_JOB_REGISTRY_BYTES) {
        throw new ProcessJobRegistryError("Process job registry exceeds the size limit");
      }
      if (bytes.byteLength === 0) return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch (error: unknown) {
        throw new ProcessJobRegistryError(`Invalid process job registry JSON: ${String(error)}`);
      }
      return decodeRegistrySnapshot(parsed).entries.map(cloneRegistryEntry);
    } finally {
      await handle.close();
    }
  }

  async replace(entries: readonly ProcessJobRegistryEntry[]): Promise<void> {
    validateRegistryEntries(entries);
    const parent = await assertRealDirectory(this.#location.parent);
    if (parent !== this.#location.parent) {
      throw new ProcessJobRegistryError("Process job registry parent identity changed");
    }
    const serialized = `${JSON.stringify({ version: 1, entries })}\n`;
    const bytes = Buffer.from(serialized, "utf8");
    if (bytes.byteLength > MAX_PROCESS_JOB_REGISTRY_BYTES) {
      throw new ProcessJobRegistryError("Process job registry exceeds the size limit");
    }
    const temporaryPath = `${this.#location.path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await openNoFollow(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    let writeError: unknown;
    try {
      let written = 0;
      while (written < bytes.byteLength) {
        const result = await handle.write(bytes, written, bytes.byteLength - written, written);
        if (result.bytesWritten === 0) {
          throw new ProcessJobRegistryError("Process job registry write made no progress");
        }
        written += result.bytesWritten;
      }
      await handle.sync();
    } catch (error: unknown) {
      writeError = error;
    } finally {
      await handle.close();
    }
    if (writeError !== undefined) {
      await unlink(temporaryPath).catch(() => undefined);
      throw writeError;
    }
    try {
      await rename(temporaryPath, this.#location.path);
      await syncDirectory(this.#location.parent);
    } catch (error: unknown) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

/**
 * A small run-scoped process registry. A job remains alive after the start
 * tool returns. Durable metadata is opt-in; the manager never restores a
 * process handle after restart.
 */
export class ProcessJobManager {
  readonly #jobs = new Map<string, JobRecord>();
  readonly #restored = new Map<string, ProcessJobRegistryEntry>();
  readonly #policy: WorkspacePathPolicy;
  readonly #registry: ProcessJobRegistry | undefined;
  readonly #managerId = `process-manager:${randomUUID()}`;
  readonly #maxJobs: number;
  readonly #defaultTimeoutSeconds: number;
  readonly #maxTimeoutSeconds: number;
  readonly #defaultMaxOutputBytes: number;
  readonly #maxOutputBytes: number;
  readonly #onRegistryError: ((error: Error) => void) | undefined;
  #registryReady: Promise<void> | undefined;
  #registryTail: Promise<void> = Promise.resolve();
  #admissionTail: Promise<void> = Promise.resolve();
  #lastRegistryError: Error | undefined;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  /** Construct and eagerly validate an optional durable registry. */
  static async open(options: ProcessJobManagerOptions = {}): Promise<ProcessJobManager> {
    const manager = new ProcessJobManager(options);
    await manager.#ensureRegistryReady();
    return manager;
  }

  constructor(options: ProcessJobManagerOptions = {}) {
    this.#policy = { protectedPaths: [...(options.protectedPaths ?? [])] };
    if (
      options.registry !== undefined
      && (
        typeof options.registry !== "object"
        || options.registry === null
        || typeof options.registry.load !== "function"
        || typeof options.registry.replace !== "function"
      )
    ) {
      throw new TypeError("registry must provide load() and replace()");
    }
    this.#registry = options.registry;
    if (options.onRegistryError !== undefined && typeof options.onRegistryError !== "function") {
      throw new TypeError("onRegistryError must be a function");
    }
    this.#onRegistryError = options.onRegistryError;
    this.#maxJobs = boundedInteger(
      options.maxJobs,
      "maxJobs",
      DEFAULT_PROCESS_JOB_MAX_JOBS,
      1,
      MAX_PROCESS_JOB_MAX_JOBS,
    );
    this.#maxTimeoutSeconds = boundedNumber(
      options.maxTimeoutSeconds,
      "maxTimeoutSeconds",
      MAX_PROCESS_JOB_TIMEOUT_SECONDS,
      0,
      MAX_PROCESS_JOB_TIMEOUT_SECONDS,
    );
    this.#defaultTimeoutSeconds = boundedNumber(
      options.defaultTimeoutSeconds,
      "defaultTimeoutSeconds",
      DEFAULT_PROCESS_JOB_TIMEOUT_SECONDS,
      0,
      this.#maxTimeoutSeconds,
    );
    this.#maxOutputBytes = boundedInteger(
      options.maxOutputBytes,
      "maxOutputBytes",
      MAX_PROCESS_JOB_OUTPUT_BYTES,
      1,
      MAX_PROCESS_JOB_OUTPUT_BYTES,
    );
    this.#defaultMaxOutputBytes = boundedInteger(
      options.defaultMaxOutputBytes,
      "defaultMaxOutputBytes",
      DEFAULT_PROCESS_JOB_MAX_OUTPUT_BYTES,
      1,
      this.#maxOutputBytes,
    );
  }

  /** Start a process and return before it exits. */
  async start(
    request: ProcessJobStartRequest,
    context: ToolExecutionContext,
  ): Promise<ProcessJobSnapshot> {
    await this.#ensureRegistryReady();
    return this.#withAdmission(() => this.#startAdmitted(request, context));
  }

  async status(jobId: string, context: ToolExecutionContext): Promise<ProcessJobSnapshot> {
    await this.#ensureRegistryReady();
    const id = requiredJobId(jobId);
    const record = this.#jobs.get(id);
    if (record !== undefined) {
      await this.#assertRecordScope(record, context);
      return record.snapshot();
    }
    const restored = await this.#restoredFor(id, context);
    if (restored.snapshot.state === "running") {
      throw new Error(
        `Process job ${id} is orphaned after restart; its OS process cannot be resumed`,
      );
    }
    return cloneSnapshot(restored.snapshot);
  }

  async output(
    request: ProcessJobOutputRequest,
    context: ToolExecutionContext,
  ): Promise<ProcessJobOutput> {
    await this.#ensureRegistryReady();
    const record = await this.#recordFor(request.jobId, context);
    const stream = request.stream ?? "both";
    if (stream !== "stdout" && stream !== "stderr" && stream !== "both") {
      throw new TypeError("stream must be stdout, stderr, or both");
    }
    const maxBytes = boundedInteger(
      request.maxBytes,
      "maxBytes",
      this.#maxOutputBytes,
      1,
      this.#maxOutputBytes,
    );
    const stdout = boundOutputSnapshot(record.process.stdout.snapshot(), maxBytes);
    const stderr = boundOutputSnapshot(record.process.stderr.snapshot(), maxBytes);
    return {
      jobId: record.id,
      state: record.state,
      stream,
      ...(stream === "stdout" || stream === "both" ? { stdout } : {}),
      ...(stream === "stderr" || stream === "both" ? { stderr } : {}),
    };
  }

  async kill(jobId: string, context: ToolExecutionContext): Promise<ProcessJobSnapshot> {
    await this.#ensureRegistryReady();
    const record = await this.#recordFor(jobId, context);
    record.requestTermination("killed");
    return record.snapshot();
  }

  /**
   * Stop all jobs owned by this registry and wait for child `close` events.
   *
   * A termination request changes the visible state immediately, but the
   * final exit code, signal and output counters arrive with the child close
   * event. Waiting here prevents a shutdown snapshot from retaining a
   * half-terminal job (`endedAt: null`).
   */
  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    if (this.#closed) return this.flush();
    this.#closed = true;
    const terminalWaits: Promise<void>[] = [];
    for (const record of this.#jobs.values()) {
      record.requestTermination("killed");
      terminalWaits.push(record.waitForTerminal());
    }
    const admissionDrain = this.#admissionTail;
    this.#closePromise = (async (): Promise<void> => {
      // A start may be resolving its workspace or writing its first snapshot.
      // Wait for that transaction before taking the final registry snapshot.
      await admissionDrain;
      await Promise.all(terminalWaits);
      await this.#queuePersist();
      await this.#registryTail;
    })();
    return this.#closePromise;
  }

  /** Number of running and retained terminal jobs. */
  get size(): number {
    return this.#jobs.size;
  }

  /**
   * List jobs visible to the current workspace. Orphans are only included for
   * the current Run by default; callers may opt into older Run metadata while
   * the workspace boundary remains enforced.
   */
  async list(
    context: ToolExecutionContext,
    options: { includeOrphans?: boolean } = {},
  ): Promise<readonly ProcessJobListEntry[]> {
    await this.#ensureRegistryReady();
    if (context.signal?.aborted) throw abortError();
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("list options must be an object");
    }
    const workspace = await this.#workspaceFor(context);
    const includeOrphans = options.includeOrphans === true;
    const entries: ProcessJobListEntry[] = [];
    for (const record of this.#jobs.values()) {
      if (record.runId !== context.runId || record.workspace !== workspace) continue;
      entries.push({
        snapshot: record.snapshot(),
        status: record.state === "running" ? "attached" : "terminal",
        persisted: this.#registry !== undefined,
      });
    }
    if (this.#registry !== undefined) {
      for (const entry of this.#restored.values()) {
        if (entry.snapshot.workspace !== workspace) continue;
        if (!includeOrphans && entry.snapshot.runId !== context.runId) continue;
        entries.push({
          snapshot: cloneSnapshot(entry.snapshot),
          status: entry.snapshot.state === "running" ? "orphaned" : "terminal",
          persisted: true,
        });
      }
    }
    return entries.sort((left, right) => {
      const started = left.snapshot.startedAt.localeCompare(right.snapshot.startedAt);
      return started !== 0 ? started : left.snapshot.id.localeCompare(right.snapshot.id);
    });
  }

  /** Host-facing diagnostic view of metadata loaded from the registry. */
  async listPersisted(): Promise<readonly ProcessJobListEntry[]> {
    await this.#ensureRegistryReady();
    return [...this.#restored.values()]
      .map((entry) => ({
        snapshot: cloneSnapshot(entry.snapshot),
        status: entry.snapshot.state === "running" ? "orphaned" as const : "terminal" as const,
        persisted: true,
      }))
      .sort((left, right) => left.snapshot.startedAt.localeCompare(right.snapshot.startedAt));
  }

  /** Wait until all queued registry writes are durable. */
  async flush(): Promise<void> {
    await this.#ensureRegistryReady();
    await this.#admissionTail;
    if (this.#closePromise !== undefined) await this.#closePromise;
    await this.#registryTail;
    if (this.#lastRegistryError !== undefined) throw this.#lastRegistryError;
  }

  /** Last asynchronous registry error, if a write has failed since the last success. */
  get registryError(): Error | undefined {
    return this.#lastRegistryError;
  }

  /** Alias retained for callers that prefer an explicit temporal name. */
  get lastRegistryError(): Error | undefined {
    return this.#lastRegistryError;
  }

  #pruneTerminalJobs(): void {
    if (this.#jobs.size < this.#maxJobs) return;
    const terminal = [...this.#jobs.values()]
      .filter((record) => record.state !== "running")
      .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
    while (this.#jobs.size >= this.#maxJobs && terminal.length > 0) {
      const record = terminal.shift();
      if (record !== undefined) this.#jobs.delete(record.id);
    }
  }

  async #recordFor(jobId: string, context: ToolExecutionContext): Promise<JobRecord> {
    if (context.signal?.aborted) throw abortError();
    const id = requiredJobId(jobId);
    const record = this.#jobs.get(id);
    if (record === undefined) {
      const restored = await this.#restoredFor(id, context);
      if (restored.snapshot.state === "running") {
        throw new Error(
          `Process job ${id} is orphaned after restart; its OS process cannot be resumed`,
        );
      }
      throw new Error(`Process job ${id} is terminal metadata and has no attached OS process`);
    }
    await this.#assertRecordScope(record, context);
    return record;
  }

  async #assertRecordScope(record: JobRecord, context: ToolExecutionContext): Promise<void> {
    const workspace = await this.#workspaceFor(context);
    if (record.runId !== context.runId || record.workspace !== workspace) {
      throw new Error("Process job is outside the current run or workspace");
    }
  }

  async #restoredFor(
    id: string,
    context: ToolExecutionContext,
  ): Promise<ProcessJobRegistryEntry> {
    const restored = this.#restored.get(id);
    const workspace = await this.#workspaceFor(context);
    if (
      restored === undefined
      || restored.snapshot.workspace !== workspace
    ) {
      throw new Error(`Unknown process job: ${id}`);
    }
    if (restored.snapshot.runId !== context.runId) {
      throw new Error("Process job is outside the current run or workspace");
    }
    return restored;
  }

  async #workspaceFor(context: ToolExecutionContext): Promise<string> {
    const resolved = await resolveExistingWorkspacePath(context.workspace, ".", this.#policy);
    return resolved.workspace;
  }

  #withAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.#admissionTail;
    let release!: () => void;
    this.#admissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return predecessor.then(operation).finally(release);
  }

  async #startAdmitted(
    request: ProcessJobStartRequest,
    context: ToolExecutionContext,
  ): Promise<ProcessJobSnapshot> {
    if (this.#closed) throw new Error("Process job manager is closed");
    const workspace = await this.#workspaceFor(context);
    // Workspace resolution yields to the event loop. Close may have started
    // while admission was waiting; this check must remain immediately before
    // any child is spawned.
    if (this.#closed) throw new Error("Process job manager is closed");
    if (context.signal?.aborted) throw abortError();
    this.#pruneTerminalJobs();
    if (this.#jobs.size >= this.#maxJobs) {
      throw new Error(`Process job limit reached (${this.#maxJobs})`);
    }
    const command = requiredCommand(request.command);
    const timeoutSeconds = boundedNumber(
      request.timeoutSeconds,
      "timeout",
      this.#defaultTimeoutSeconds,
      0,
      this.#maxTimeoutSeconds,
    );
    const maxOutputBytes = boundedInteger(
      request.maxOutputBytes,
      "maxOutputBytes",
      this.#defaultMaxOutputBytes,
      1,
      this.#maxOutputBytes,
    );
    const id = randomUUID();
    let processHandle: StartedShellProcess | undefined;
    let record: JobRecord | undefined;
    try {
      processHandle = spawnShellCommand({ command, cwd: workspace });
      // The callback verifies identity before scheduling a write. This makes
      // rollback and terminal pruning unable to resurrect a removed record.
      record = new JobRecord({
        id,
        runId: context.runId,
        workspace,
        processHandle,
        timeoutSeconds,
        maxOutputBytes,
        onChange: () => {
          if (record !== undefined && this.#jobs.get(record.id) === record) {
            this.#recordChanged();
          }
        },
      });
      this.#jobs.set(record.id, record);
      this.#restored.delete(record.id);
      record.start(context.signal);
      await this.#queuePersist();
      // A close can terminate a child while its initial registry write is in
      // flight. Do not report that race as a successful start.
      if (this.#closed) throw new Error("Process job manager is closed");
      return record.snapshot();
    } catch (error: unknown) {
      let rollbackError: Error | undefined;
      if (record !== undefined) {
        rollbackError = await this.#rollbackStartedRecord(record);
      } else if (processHandle !== undefined) {
        // A failure before JobRecord.start() still owns a live child.
        try {
          processHandle.terminate();
        } catch (terminationError: unknown) {
          rollbackError = asError(terminationError);
        }
      }
      if (rollbackError !== undefined) {
        throw appendRollbackError(error, rollbackError);
      }
      throw error;
    }
  }

  async #rollbackStartedRecord(record: JobRecord): Promise<Error | undefined> {
    // Remove the record before requesting termination so the termination
    // callback cannot enqueue a snapshot for a transaction that was rejected.
    if (this.#jobs.get(record.id) === record) this.#jobs.delete(record.id);
    this.#restored.delete(record.id);
    try {
      record.requestTermination("killed");
      await record.waitForTerminal();
    } catch (error: unknown) {
      return asError(error);
    }
    if (this.#registry === undefined) return undefined;
    try {
      // Replace the failed start snapshot with the pre-start view. Atomic
      // registries leave this as a no-op on a failed first write; custom
      // registries that partially wrote are repaired on a best-effort basis.
      await this.#queuePersist();
      return undefined;
    } catch (error: unknown) {
      return asError(error);
    }
  }

  async #ensureRegistryReady(): Promise<void> {
    if (this.#registry === undefined) return;
    if (this.#registryReady === undefined) {
      this.#registryReady = this.#restoreRegistry();
    }
    await this.#registryReady;
  }

  async #restoreRegistry(): Promise<void> {
    if (this.#registry === undefined) return;
    const entries = await this.#registry.load();
    validateRegistryEntries(entries);
    for (const entry of entries) {
      this.#restored.set(entry.snapshot.id, cloneRegistryEntry(entry));
    }
  }

  #recordChanged(): void {
    if (this.#registry === undefined || this.#closed) return;
    // The rejection is intentionally consumed here because the state change
    // happened outside a caller await point. #queuePersist records the error,
    // exposes it through registryError/flush, and invokes onRegistryError.
    void this.#queuePersist().catch(() => undefined);
  }

  #queuePersist(): Promise<void> {
    if (this.#registry === undefined) return Promise.resolve();
    const write = async (): Promise<void> => {
      try {
        await this.#persistRegistry();
        this.#lastRegistryError = undefined;
      } catch (error: unknown) {
        const normalized = asRegistryError(error);
        this.#lastRegistryError = normalized;
        try {
          this.#onRegistryError?.(normalized);
        } catch {
          // Observers must not break the persistence queue.
        }
        throw normalized;
      }
    };
    const next = this.#registryTail.then(write, write);
    this.#registryTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async #persistRegistry(): Promise<void> {
    await this.#ensureRegistryReady();
    if (this.#registry === undefined) return;
    const entries = new Map<string, ProcessJobRegistryEntry>();
    for (const [id, entry] of this.#restored) entries.set(id, entry);
    for (const record of this.#jobs.values()) {
      entries.set(record.id, {
        snapshot: record.snapshot(),
        managerId: this.#managerId,
        recordedAt: new Date().toISOString(),
      });
    }
    const selected = pruneRegistryEntries([...entries.values()]);
    await this.#registry.replace(selected);
  }
}

export interface ProcessJobOutput {
  jobId: string;
  state: ProcessJobState;
  stream: "stdout" | "stderr" | "both";
  stdout?: ShellOutputSnapshot;
  stderr?: ShellOutputSnapshot;
}

interface JobRecordOptions {
  id: string;
  runId: string;
  workspace: string;
  processHandle: StartedShellProcess;
  timeoutSeconds: number;
  maxOutputBytes: number;
  onChange: () => void;
}

class JobRecord {
  readonly id: string;
  readonly runId: string;
  readonly workspace: string;
  readonly process: StartedShellProcess;
  readonly timeoutSeconds: number;
  readonly maxOutputBytes: number;
  readonly #onChange: () => void;
  readonly startedAt: Date;
  state: ProcessJobState = "running";
  exitCode: number | null = null;
  signal: NodeJS.Signals | null = null;
  endedAt: Date | null = null;
  terminationReason: ProcessJobTerminationReason | null = null;
  #timer: NodeJS.Timeout | undefined;
  #abortSignal: AbortSignal | undefined;
  #abortListener: (() => void) | undefined;
  #terminated = false;
  #resolveTerminal!: () => void;
  readonly #terminalPromise: Promise<void>;

  constructor(options: JobRecordOptions) {
    this.id = options.id;
    this.runId = options.runId;
    this.workspace = options.workspace;
    this.process = options.processHandle;
    this.timeoutSeconds = options.timeoutSeconds;
    this.maxOutputBytes = options.maxOutputBytes;
    this.#onChange = options.onChange;
    this.startedAt = new Date();
    this.#terminalPromise = new Promise<void>((resolve) => {
      this.#resolveTerminal = resolve;
    });
  }

  waitForTerminal(): Promise<void> {
    return this.endedAt === null ? this.#terminalPromise : Promise.resolve();
  }

  start(signal: AbortSignal | undefined): void {
    const onOutput = (): void => {
      if (this.state !== "running" || this.#terminated) return;
      const stdoutBytes = this.process.stdout.snapshot().totalBytes;
      const stderrBytes = this.process.stderr.snapshot().totalBytes;
      if (stdoutBytes > this.maxOutputBytes || stderrBytes > this.maxOutputBytes) {
        this.requestTermination("output_limited");
      }
    };
    this.process.child.stdout?.on("data", onOutput);
    this.process.child.stderr?.on("data", onOutput);

    const onError = (error: Error): void => {
      this.finish("failed", null, null, error.message);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (this.state !== "running") {
        this.finish(this.state, code, signal, null);
        return;
      }
      this.finish(code === 0 ? "succeeded" : "failed", code, signal, null);
    };
    this.process.child.once("error", onError);
    this.process.child.once("close", onClose);
    this.#timer = setTimeout(() => this.requestTermination("timed_out"), this.timeoutSeconds * 1_000);
    this.#timer.unref?.();
    if (signal !== undefined) {
      this.#abortSignal = signal;
      this.#abortListener = () => this.requestTermination("aborted");
      if (signal.aborted) this.#abortListener();
      else signal.addEventListener("abort", this.#abortListener, { once: true });
    }
    // A process can exit between spawn and listener setup; close will still
    // be delivered by Node, but this check makes the status immediately useful.
    if (this.process.child.exitCode !== null || this.process.child.signalCode !== null) {
      onClose(this.process.child.exitCode, this.process.child.signalCode);
    }
  }

  requestTermination(reason: ProcessJobTerminationReason): void {
    if (this.state !== "running" || this.#terminated) return;
    this.#terminated = true;
    this.terminationReason = reason;
    this.state = reason === "timed_out"
      ? "timed_out"
      : reason === "output_limited"
        ? "output_limited"
        : reason === "aborted"
          ? "aborted"
          : "killed";
    this.#onChange();
    this.process.terminate();
  }

  snapshot(): ProcessJobSnapshot {
    return {
      id: this.id,
      runId: this.runId,
      workspace: this.workspace,
      pid: this.process.child.pid ?? null,
      state: this.state,
      exitCode: this.exitCode,
      signal: this.signal,
      startedAt: this.startedAt.toISOString(),
      endedAt: this.endedAt?.toISOString() ?? null,
      timeoutSeconds: this.timeoutSeconds,
      maxOutputBytes: this.maxOutputBytes,
      terminationReason: this.terminationReason,
      stdout: this.process.stdout.snapshot(),
      stderr: this.process.stderr.snapshot(),
    };
  }

  private finish(
    state: ProcessJobState,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    _error: string | null,
  ): void {
    if (this.endedAt !== null) return;
    this.exitCode = exitCode;
    this.signal = signal;
    this.endedAt = new Date();
    this.state = state;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    if (this.#abortSignal !== undefined && this.#abortListener !== undefined) {
      this.#abortSignal.removeEventListener("abort", this.#abortListener);
    }
    this.#onChange();
    this.#resolveTerminal();
  }
}

/** Create the process lifecycle and registry diagnostic tools for one manager. */
export function createProcessJobTools(
  manager: ProcessJobManager = new ProcessJobManager(),
): AgentTool[] {
  return [
    createProcessStartTool(manager),
    createProcessStatusTool(manager),
    createProcessOutputTool(manager),
    createProcessKillTool(manager),
    createProcessListTool(manager),
  ].map((tool) => withMoweMetadata(tool));
}

export function createProcessStartTool(manager: ProcessJobManager): AgentTool {
  return withMoweMetadata({
    definition: {
      name: "process_start",
      description: "Start a bounded workspace shell process and return a job id without waiting for it to exit.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Bash command to run" },
          timeout: { type: "number", exclusiveMinimum: 0, maximum: MAX_PROCESS_JOB_TIMEOUT_SECONDS, description: "Maximum lifetime in seconds" },
          maxOutputBytes: { type: "integer", minimum: 1, maximum: MAX_PROCESS_JOB_OUTPUT_BYTES, description: "Per-stream output cap before the process is stopped" },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
    async execute(arguments_, context): Promise<ToolResult> {
      try {
        return success(await manager.start({
          command: arguments_.command as string,
          ...(arguments_.timeout === undefined ? {} : { timeoutSeconds: arguments_.timeout as number }),
          ...(arguments_.maxOutputBytes === undefined ? {} : { maxOutputBytes: arguments_.maxOutputBytes as number }),
        }, context));
      } catch (error: unknown) {
        return failure(error);
      }
    },
  });
}

export function createProcessStatusTool(manager: ProcessJobManager): AgentTool {
  return lifecycleTool(
    "process_status",
    "Inspect a process job state and bounded output counters.",
    {
      jobId: { type: "string", description: "Job id returned by process_start" },
    },
    ["jobId"],
    async (arguments_, context) => manager.status(arguments_.jobId as string, context),
  );
}

export function createProcessOutputTool(manager: ProcessJobManager): AgentTool {
  return lifecycleTool(
    "process_output",
    "Read bounded stdout or stderr from a process job; output is retained as a tail.",
    {
      jobId: { type: "string", description: "Job id returned by process_start" },
      stream: { type: "string", enum: ["stdout", "stderr", "both"], description: "Stream to read (default: both)" },
      maxBytes: { type: "integer", minimum: 1, maximum: MAX_PROCESS_JOB_OUTPUT_BYTES, description: "Maximum bytes per returned stream" },
    },
    ["jobId"],
    async (arguments_, context) => manager.output({
      jobId: arguments_.jobId as string,
      ...(arguments_.stream === undefined ? {} : { stream: arguments_.stream as "stdout" | "stderr" | "both" }),
      ...(arguments_.maxBytes === undefined ? {} : { maxBytes: arguments_.maxBytes as number }),
    }, context),
  );
}

export function createProcessKillTool(manager: ProcessJobManager): AgentTool {
  return lifecycleTool(
    "process_kill",
    "Stop a running process job and its descendants. Killing an already terminal job is idempotent.",
    {
      jobId: { type: "string", description: "Job id returned by process_start" },
    },
    ["jobId"],
    async (arguments_, context) => manager.kill(arguments_.jobId as string, context),
  );
}

export function createProcessListTool(manager: ProcessJobManager): AgentTool {
  return lifecycleTool(
    "process_list",
    "List process jobs owned by the current Run in this workspace.",
    {},
    [],
    async (_arguments, context) => manager.list(context),
  );
}

function lifecycleTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  execute: (arguments_: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown>,
): AgentTool {
  return withMoweMetadata({
    definition: {
      name,
      description,
      parameters: { type: "object", properties, required, additionalProperties: false },
    },
    async execute(arguments_, context): Promise<ToolResult> {
      try {
        return success(await execute(arguments_, context));
      } catch (error: unknown) {
        return failure(error);
      }
    },
  });
}

function withMoweMetadata(tool: AgentTool): AgentTool {
  const metadata = PROCESS_JOB_MOWE_METADATA[tool.definition.name];
  return metadata === undefined
    ? tool
    : Object.freeze({ ...tool, metadata });
}

function boundOutputSnapshot(snapshot: ShellOutputSnapshot, maxBytes: number): ShellOutputSnapshot {
  if (Buffer.byteLength(snapshot.content, "utf8") <= maxBytes) return snapshot;
  const content = utf8Tail(snapshot.content, maxBytes);
  return {
    ...snapshot,
    content,
    truncated: true,
    truncatedBy: "bytes",
    outputBytes: Buffer.byteLength(content, "utf8"),
    outputLines: countLines(content),
  };
}

function cloneRegistryEntry(entry: ProcessJobRegistryEntry): ProcessJobRegistryEntry {
  return {
    snapshot: cloneSnapshot(entry.snapshot),
    managerId: entry.managerId,
    recordedAt: entry.recordedAt,
  };
}

function cloneSnapshot(snapshot: ProcessJobSnapshot): ProcessJobSnapshot {
  return {
    ...snapshot,
    stdout: { ...snapshot.stdout },
    stderr: { ...snapshot.stderr },
  };
}

function pruneRegistryEntries(
  entries: readonly ProcessJobRegistryEntry[],
): ProcessJobRegistryEntry[] {
  if (entries.length <= MAX_PROCESS_JOB_REGISTRY_ENTRIES) {
    return entries.map(cloneRegistryEntry);
  }
  const removable = [...entries].sort((left, right) => {
    const leftRunning = left.snapshot.state === "running" ? 1 : 0;
    const rightRunning = right.snapshot.state === "running" ? 1 : 0;
    if (leftRunning !== rightRunning) return leftRunning - rightRunning;
    const recorded = left.recordedAt.localeCompare(right.recordedAt);
    return recorded !== 0 ? recorded : left.snapshot.id.localeCompare(right.snapshot.id);
  });
  const remove = new Set(
    removable
      .slice(0, entries.length - MAX_PROCESS_JOB_REGISTRY_ENTRIES)
      .map((entry) => entry.snapshot.id),
  );
  return entries.filter((entry) => !remove.has(entry.snapshot.id)).map(cloneRegistryEntry);
}

function validateRegistryEntries(entries: readonly ProcessJobRegistryEntry[]): void {
  if (!Array.isArray(entries)) {
    throw new ProcessJobRegistryError("Process job registry entries must be an array");
  }
  if (entries.length > MAX_PROCESS_JOB_REGISTRY_ENTRIES) {
    throw new ProcessJobRegistryError(
      `Process job registry contains more than ${MAX_PROCESS_JOB_REGISTRY_ENTRIES} entries`,
    );
  }
  const ids = new Set<string>();
  for (const entry of entries) {
    const normalized = decodeRegistryEntry(entry);
    if (ids.has(normalized.snapshot.id)) {
      throw new ProcessJobRegistryError(`Duplicate process job id: ${normalized.snapshot.id}`);
    }
    ids.add(normalized.snapshot.id);
  }
}

function decodeRegistrySnapshot(value: unknown): ProcessJobRegistrySnapshot {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) {
    throw new ProcessJobRegistryError("Invalid process job registry snapshot");
  }
  if (value.entries.length > MAX_PROCESS_JOB_REGISTRY_ENTRIES) {
    throw new ProcessJobRegistryError(
      `Process job registry contains more than ${MAX_PROCESS_JOB_REGISTRY_ENTRIES} entries`,
    );
  }
  const entries = value.entries.map((entry) => decodeRegistryEntry(entry));
  const ids = new Set(entries.map((entry) => entry.snapshot.id));
  if (ids.size !== entries.length) {
    throw new ProcessJobRegistryError("Process job registry contains duplicate ids");
  }
  return { version: 1, entries };
}

function decodeRegistryEntry(value: unknown): ProcessJobRegistryEntry {
  if (!isRecord(value)) {
    throw new ProcessJobRegistryError("Invalid process job registry entry");
  }
  return {
    snapshot: decodeSnapshot(value.snapshot),
    managerId: requiredRegistryString(value.managerId, "managerId", 128),
    recordedAt: requiredTimestamp(value.recordedAt, "recordedAt"),
  };
}

function decodeSnapshot(value: unknown): ProcessJobSnapshot {
  if (!isRecord(value)) {
    throw new ProcessJobRegistryError("Invalid process job snapshot");
  }
  if (value.timeoutSeconds === undefined || value.maxOutputBytes === undefined) {
    throw new ProcessJobRegistryError("Process job timeout and output limits are required");
  }
  const state = value.state;
  if (
    state !== "running"
    && state !== "succeeded"
    && state !== "failed"
    && state !== "killed"
    && state !== "aborted"
    && state !== "timed_out"
    && state !== "output_limited"
  ) {
    throw new ProcessJobRegistryError("Invalid process job state");
  }
  const terminationReason = value.terminationReason;
  if (
    terminationReason !== null
    && terminationReason !== "killed"
    && terminationReason !== "aborted"
    && terminationReason !== "timed_out"
    && terminationReason !== "output_limited"
  ) {
    throw new ProcessJobRegistryError("Invalid process job termination reason");
  }
  return {
    id: requiredJobId(value.id),
    runId: requiredRegistryString(value.runId, "runId", 256),
    workspace: requiredAbsolutePath(value.workspace, "workspace"),
    pid: nullablePositiveInteger(value.pid, "pid"),
    state,
    exitCode: nullableInteger(value.exitCode, "exitCode"),
    signal: nullableSignal(value.signal),
    startedAt: requiredTimestamp(value.startedAt, "startedAt"),
    endedAt: nullableTimestamp(value.endedAt, "endedAt"),
    timeoutSeconds: boundedNumber(
      value.timeoutSeconds,
      "timeoutSeconds",
      DEFAULT_PROCESS_JOB_TIMEOUT_SECONDS,
      0,
      MAX_PROCESS_JOB_TIMEOUT_SECONDS,
    ),
    maxOutputBytes: boundedInteger(
      value.maxOutputBytes,
      "maxOutputBytes",
      DEFAULT_PROCESS_JOB_MAX_OUTPUT_BYTES,
      1,
      MAX_PROCESS_JOB_OUTPUT_BYTES,
    ),
    terminationReason,
    stdout: decodeOutputSnapshot(value.stdout, "stdout"),
    stderr: decodeOutputSnapshot(value.stderr, "stderr"),
  };
}

function decodeOutputSnapshot(value: unknown, label: string): ShellOutputSnapshot {
  if (!isRecord(value)) {
    throw new ProcessJobRegistryError(`Invalid process job ${label} output snapshot`);
  }
  const truncatedBy = value.truncatedBy;
  if (truncatedBy !== null && truncatedBy !== "bytes" && truncatedBy !== "lines") {
    throw new ProcessJobRegistryError(`Invalid process job ${label} truncation marker`);
  }
  const content = boundedRegistryString(
    value.content,
    `${label}.content`,
    MAX_PROCESS_JOB_OUTPUT_BYTES,
  );
  const truncated = value.truncated;
  if (typeof truncated !== "boolean") {
    throw new ProcessJobRegistryError(`Invalid process job ${label} truncated flag`);
  }
  const totalBytes = nonNegativeInteger(value.totalBytes, `${label}.totalBytes`);
  const totalLines = nonNegativeInteger(value.totalLines, `${label}.totalLines`);
  const outputBytes = nonNegativeInteger(value.outputBytes, `${label}.outputBytes`);
  const outputLines = nonNegativeInteger(value.outputLines, `${label}.outputLines`);
  if (Buffer.byteLength(content, "utf8") !== outputBytes) {
    throw new ProcessJobRegistryError(`Invalid process job ${label} output byte count`);
  }
  return {
    content,
    truncated,
    truncatedBy,
    totalBytes,
    totalLines,
    outputBytes,
    outputLines,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRegistryString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new ProcessJobRegistryError(`${label} must be a non-empty string`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new ProcessJobRegistryError(`${label} exceeds its size limit`);
  }
  return value;
}

function boundedRegistryString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new ProcessJobRegistryError(`${label} must be a string`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new ProcessJobRegistryError(`${label} exceeds its size limit`);
  }
  return value;
}

function requiredAbsolutePath(value: unknown, label: string): string {
  const normalized = requiredRegistryString(value, label, 4 * 1024);
  if (!normalized.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(normalized)) {
    throw new ProcessJobRegistryError(`${label} must be an absolute path`);
  }
  return normalized;
}

function requiredTimestamp(value: unknown, label: string): string {
  const timestamp = requiredRegistryString(value, label, 128);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new ProcessJobRegistryError(`${label} must be an ISO timestamp`);
  }
  return timestamp;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : requiredTimestamp(value, label);
}

function nullablePositiveInteger(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ProcessJobRegistryError(`${label} must be null or a positive integer`);
  }
  return value as number;
}

function nullableInteger(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value)) {
    throw new ProcessJobRegistryError(`${label} must be null or an integer`);
  }
  return value as number;
}

function nullableSignal(value: unknown): NodeJS.Signals | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 32) {
    throw new ProcessJobRegistryError("signal must be null or a signal name");
  }
  return value as NodeJS.Signals;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProcessJobRegistryError(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function utf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return new TextDecoder().decode(bytes.subarray(start));
}

function countLines(value: string): number {
  if (value.length === 0) return 0;
  const lines = value.split("\n");
  return value.endsWith("\n") ? lines.length - 1 : lines.length;
}

function requiredCommand(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("command must be a non-empty string");
  }
  if (value.includes("\0")) throw new TypeError("command must not contain NUL");
  if (Buffer.byteLength(value, "utf8") > 16 * 1024) {
    throw new TypeError("command exceeds the 16KB input limit");
  }
  return value;
}

function requiredJobId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new TypeError("jobId must be a non-empty id");
  }
  return value;
}

function boundedNumber(
  value: unknown,
  label: string,
  fallback: number,
  minimumExclusive: number,
  maximum: number,
): number {
  const selected = value === undefined ? fallback : value;
  if (typeof selected !== "number" || !Number.isFinite(selected)
    || selected <= minimumExclusive || selected > maximum) {
    throw new TypeError(`${label} must be a finite number greater than zero and at most ${maximum}`);
  }
  return selected;
}

function boundedInteger(
  value: unknown,
  label: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const selected = value === undefined ? fallback : value;
  if (typeof selected !== "number"
    || !Number.isSafeInteger(selected)
    || selected < minimum
    || selected > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return selected;
}

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function asRegistryError(error: unknown): ProcessJobRegistryError {
  if (error instanceof ProcessJobRegistryError) return error;
  return new ProcessJobRegistryError(
    `Process job registry persistence failed: ${asError(error).message}`,
  );
}

function appendRollbackError(primary: unknown, rollback: Error): Error {
  const error = asError(primary);
  const combined = new Error(
    `${error.message}; process job rollback failed: ${rollback.message}`,
  );
  combined.name = error.name;
  return combined;
}

function success(value: unknown): ToolResult {
  return { content: JSON.stringify(value), isError: false };
}

function failure(error: unknown): ToolResult {
  return {
    content: JSON.stringify({ error: error instanceof Error ? error.message : "Process job failed" }),
    isError: true,
  };
}
