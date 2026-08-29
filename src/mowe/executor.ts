import { resolve as resolvePath } from "node:path";

import type { AgentTool, ToolResult } from "../domain/ports.js";
import { validateUserImages } from "../domain/images.js";
import { sha256, stableJson } from "../ledger/hash.js";
import { asCatalog, MoweCatalog } from "./catalog.js";
import { assertArguments } from "./admission.js";
import { projectResult } from "./result-projector.js";
import {
  DEFAULT_MOWE_MAX_CALLS,
  DEFAULT_MOWE_MAX_INPUT_BYTES,
  DEFAULT_MOWE_MAX_OUTPUT_BYTES,
  MAX_MOWE_DEADLINE_MS,
  MAX_MOWE_MAX_CALLS,
  MAX_MOWE_MAX_INPUT_BYTES,
  MAX_MOWE_MAX_OUTPUT_BYTES,
} from "./types.js";
import type {
  MoweApprovalDecision,
  MoweBatchLimits,
  MoweCall,
  MoweCallResult,
  MoweExecutionRequest,
  MoweExecutionResponse,
  MoweToolEntry,
} from "./types.js";

export class MoweBatchLimitError extends RangeError {
  override readonly name = "MoweBatchLimitError";
}

/**
 * A small in-process mutex used for workspace mutations.  The registry is
 * intentionally process-local: coordinating independent daemon processes
 * would require an OS/file lock and belongs to a higher runtime boundary.
 */
class WorkspaceMutex {
  #locked = false;
  #waiters: WorkspaceMutexWaiter[] = [];

  get idle(): boolean {
    return !this.#locked && this.#waiters.length === 0;
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      if (signal?.aborted === true) {
        throw abortReason(signal);
      }
      return await operation();
    } finally {
      release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) return Promise.reject(abortReason(signal));
    return new Promise<() => void>((resolve, reject) => {
      const waiter: WorkspaceMutexWaiter = {
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
      };
      if (signal !== undefined) {
        const onAbort = (): void => {
          const index = this.#waiters.indexOf(waiter);
          if (index < 0) return;
          this.#waiters.splice(index, 1);
          signal.removeEventListener("abort", onAbort);
          reject(abortReason(signal));
          this.drain();
        };
        waiter.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.#waiters.push(waiter);
      this.drain();
    });
  }

  private drain(): void {
    if (this.#locked) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) return;
    if (waiter.signal?.aborted === true) {
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.reject(abortReason(waiter.signal));
      this.drain();
      return;
    }
    this.#locked = true;
    if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      this.#locked = false;
      this.drain();
    });
  }
}

interface WorkspaceMutexWaiter {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const workspaceMutexes = new Map<string, WorkspaceMutex>();

function workspaceMutexFor(workspace: string): WorkspaceMutex {
  const key = resolvePath(workspace);
  let mutex = workspaceMutexes.get(key);
  if (mutex === undefined) {
    mutex = new WorkspaceMutex();
    workspaceMutexes.set(key, mutex);
  }
  return mutex;
}

function releaseWorkspaceMutexIfIdle(workspace: string, mutex: WorkspaceMutex): void {
  const key = resolvePath(workspace);
  if (workspaceMutexes.get(key) === mutex && mutex.idle) {
    workspaceMutexes.delete(key);
  }
}

function isWorkspaceWriteEntry(entry: MoweToolEntry): boolean {
  return entry.metadata.effect === "write" && entry.metadata.scope === "workspace";
}

interface ResolvedMoweBatchLimits {
  maxCalls: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  deadlineMs?: number;
}

export interface MoweExecutorOptions {
  catalog: MoweCatalog | readonly AgentTool[];
  maxConcurrency?: number;
  /** Runtime redaction/bounding hook; it runs before projection or storage. */
  sanitizeResult?: (result: ToolResult) => ToolResult;
}

export class MoweExecutor {
  readonly catalog: MoweCatalog;
  readonly #maxConcurrency: number;
  readonly #sanitizeResult: (result: ToolResult) => ToolResult;

  constructor(options: MoweExecutorOptions) {
    this.catalog = asCatalog(options.catalog);
    this.#maxConcurrency = positiveInteger(options.maxConcurrency ?? 4, "maxConcurrency");
    this.#sanitizeResult = options.sanitizeResult ?? ((result) => result);
  }

  async execute(request: MoweExecutionRequest): Promise<MoweExecutionResponse> {
    const limits = resolveBatchLimits(request.limits);
    validateRequest(request, limits);
    const results: MoweCallResult[] = new Array(request.calls.length);
    const concurrency = positiveInteger(request.concurrency ?? this.#maxConcurrency, "concurrency");
    const deadline = createBatchDeadline(request.signal, limits.deadlineMs);
    const executionRequest = deadline.signal === request.signal || deadline.signal === undefined
      ? request
      : { ...request, signal: deadline.signal };
    let boundedResults: MoweCallResult[];
    try {
      await this.executePool(executionRequest, results, concurrency);
      boundedResults = await boundBatchResults(
        results,
        limits.maxOutputBytes,
        request.artifactStore,
      );
    } finally {
      deadline.dispose();
    }
    const completed = boundedResults.filter((result): result is MoweCallResult => result !== undefined);
    const status = executionRequest.signal?.aborted === true
      ? "cancelled"
      : completed.length === 0 || completed.every((result) => result.status === "succeeded")
        ? "succeeded"
        : completed.every((result) => result.status === "failed")
          ? "failed"
          : "partial";
    return {
      runId: request.runId,
      laneId: request.laneId,
      results: boundedResults,
      cancelled: executionRequest.signal?.aborted === true,
      status,
    };
  }

  /**
   * Run independent calls in parallel while honoring the catalog's per-tool
   * safety declarations. A plain worker pool is insufficient here: two
   * `write_file` calls must not overlap, while read-only calls should still
   * fill the global pool. The scheduler scans for the first admissible call
   * so a blocked unsafe operation cannot hold up unrelated reads.
   */
  private async executePool(
    request: MoweExecutionRequest,
    results: MoweCallResult[],
    concurrency: number,
  ): Promise<void> {
    const pending = request.calls.map((_, index) => index);
    const activeByTool = new Map<string, number>();
    let activeWorkspaceWrites = 0;
    let active = 0;

    await new Promise<void>((resolve) => {
      const pump = (): void => {
        while (active < concurrency && pending.length > 0) {
          const pendingPosition = pending.findIndex((index) => {
            const call = request.calls[index];
            if (call === undefined) return false;
            const entry = this.catalog.get(call.name);
            if (entry === undefined) return true;
            // Keep at most one workspace write in this batch.  The actual
            // process-wide mutex is acquired later, after admission and
            // approval, so a waiting write never blocks unrelated reads.
            if (isWorkspaceWriteEntry(entry) && activeWorkspaceWrites > 0) return false;
            const current = activeByTool.get(call.name) ?? 0;
            const declaredLimit = entry.metadata.concurrencySafe
              ? entry.metadata.maxConcurrency ?? concurrency
              : 1;
            return current < Math.min(concurrency, declaredLimit);
          });
          if (pendingPosition < 0) break;
          const [index] = pending.splice(pendingPosition, 1);
          if (index === undefined) continue;
          const call = request.calls[index];
          if (call === undefined) continue;
          const entry = this.catalog.get(call.name);
          const workspaceWrite = entry !== undefined && isWorkspaceWriteEntry(entry);
          active += 1;
          activeByTool.set(call.name, (activeByTool.get(call.name) ?? 0) + 1);
          if (workspaceWrite) activeWorkspaceWrites += 1;
          void this.executeCall(request, call, index)
            .then((result) => {
              results[index] = result;
            })
            .catch((error: unknown) => {
              // executeCall normally converts failures into a per-call result;
              // retain that isolation if a future projector escapes its guard.
              results[index] = failed(call, operationIdFor(request, call, index), errorMessage(error));
            })
            .finally(() => {
              active -= 1;
              const current = activeByTool.get(call.name) ?? 1;
              if (current <= 1) activeByTool.delete(call.name);
              else activeByTool.set(call.name, current - 1);
              if (workspaceWrite) activeWorkspaceWrites -= 1;
              if (pending.length === 0 && active === 0) resolve();
              else pump();
            });
        }
        if (pending.length === 0 && active === 0) resolve();
      };
      pump();
    });
  }

  private async executeCall(request: MoweExecutionRequest, call: MoweCall, index: number): Promise<MoweCallResult> {
    const operationId = operationIdFor(request, call, index);
    if (request.signal?.aborted === true) return cancelled(call, operationId, request.signal.reason);
    // A truncated provider response is a runtime fact, not a tool invocation.
    // Preserve the legacy behavior by recording that fact before catalog or
    // argument admission can turn it into a misleading schema error.
    if (call.forcedError !== undefined) {
      return failed(call, operationId, call.forcedError);
    }
    const entry = this.catalog.get(call.name);
    if (entry === undefined) {
      return failed(call, operationId, `Unknown tool: ${call.name}`);
    }
    if (request.allowedEffects !== undefined && !request.allowedEffects.includes(entry.metadata.effect)) {
      return failed(call, operationId, `Tool effect is not allowed: ${entry.metadata.effect}`);
    }
    if (request.allowedScopes !== undefined && !request.allowedScopes.includes(entry.metadata.scope)) {
      return failed(call, operationId, `Tool scope is not allowed: ${entry.metadata.scope}`);
    }
    try {
      assertArguments(entry.tool, call.arguments);
    } catch (error: unknown) {
      return failed(call, operationId, errorMessage(error));
    }
    if (entry.metadata.requiresApproval) {
      if (request.approve === undefined) {
        return failed(call, operationId, "Tool requires approval before execution");
      }
      try {
        const decision = await request.approve({
          runId: request.runId,
          laneId: request.laneId,
          operationId,
          call,
          tool: entry,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        if (!approvalGranted(decision)) {
          return failed(call, operationId, approvalReason(decision));
        }
        if (isSignalAborted(request.signal)) {
          return cancelled(call, operationId, request.signal?.reason);
        }
      } catch (error: unknown) {
        if ((request.signal !== undefined && request.signal.aborted) || isAbortError(error)) {
          return cancelled(call, operationId, request.signal?.reason ?? error);
        }
        return failed(call, operationId, `Tool approval failed: ${errorMessage(error)}`);
      }
    }
    const deadline = createToolDeadline(request.signal, entry.metadata.timeoutMs);
    try {
      const context = {
        runId: request.runId,
        workspace: request.workspace,
        operationId,
        ...(deadline.signal === undefined ? {} : { signal: deadline.signal }),
      };
      const workspaceMutex = isWorkspaceWriteEntry(entry)
        ? workspaceMutexFor(request.workspace)
        : undefined;
      let rawResult: ToolResult;
      try {
        rawResult = workspaceMutex === undefined
          ? await entry.tool.execute(call.arguments, context)
          : await workspaceMutex.run(
            () => entry.tool.execute(call.arguments, context),
            deadline.signal,
          );
      } finally {
        if (workspaceMutex !== undefined) {
          releaseWorkspaceMutexIfIdle(request.workspace, workspaceMutex);
        }
      }
      // A cooperative adapter may return a normal value after observing the
      // abort signal. Preserve the deadline as a runtime failure either way.
      if (deadline.didTimeout()) return failed(call, operationId, deadline.timeoutMessage);
      const result = this.#sanitizeResult(rawResult);
      validateUserImages(result.images);
      const projectionOptions = { ...request.projection, ...call.projection };
      const projection = await projectResult(result, projectionOptions, request.artifactStore);
      if (deadline.didTimeout()) return failed(call, operationId, deadline.timeoutMessage);
      return {
        callId: call.id,
        name: call.name,
        operationId,
        status: result.isError ? "failed" : "succeeded",
        result,
        projection,
        ...(result.isError ? { error: result.content } : {}),
      };
    } catch (error: unknown) {
      if (deadline.didTimeout()) return failed(call, operationId, deadline.timeoutMessage);
      if ((request.signal !== undefined && request.signal.aborted) || isAbortError(error)) return cancelled(call, operationId, request.signal?.reason ?? error);
      return failed(call, operationId, errorMessage(error));
    } finally {
      deadline.dispose();
    }
  }
}

export function operationIdFor(request: Pick<MoweExecutionRequest, "runId" | "laneId">, call: MoweCall, index = 0): string {
  return call.operationId ?? `op:${sha256(stableJson({ runId: request.runId, laneId: request.laneId, index, callId: call.id, name: call.name, arguments: call.arguments }))}`;
}

function failed(call: MoweCall, operationId: string, message: string): MoweCallResult {
  const result: ToolResult = { content: message, isError: true };
  return { callId: call.id, name: call.name, operationId, status: "failed", result, error: message };
}

function cancelled(call: MoweCall, operationId: string, reason: unknown): MoweCallResult {
  return failedWithStatus(call, operationId, `Operation cancelled${reason instanceof Error ? `: ${reason.message}` : ""}`, "cancelled");
}

function failedWithStatus(call: MoweCall, operationId: string, message: string, status: "cancelled"): MoweCallResult {
  return { callId: call.id, name: call.name, operationId, status, result: { content: message, isError: true }, error: message };
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
    throw new RangeError(`${label} must be an integer between 1 and 64`);
  }
  return value;
}

function validateRequest(request: MoweExecutionRequest, limits: ResolvedMoweBatchLimits): void {
  if (request.runId.trim().length === 0) throw new RangeError("runId must not be empty");
  if (request.laneId.trim().length === 0) throw new RangeError("laneId must not be empty");
  if (request.workspace.trim().length === 0) throw new RangeError("workspace must not be empty");
  if (request.calls.length > limits.maxCalls) {
    throw new MoweBatchLimitError(
      `Batch contains ${request.calls.length} calls; limit is ${limits.maxCalls}`,
    );
  }
  const ids = new Set<string>();
  const operationIds = new Set<string>();
  let inputBytes = 0;
  for (const call of request.calls) {
    if (call.id.trim().length === 0) throw new RangeError("Tool call ids must not be empty");
    if (call.name.trim().length === 0) throw new RangeError("Tool call names must not be empty");
    if (ids.has(call.id)) throw new RangeError(`Duplicate tool call id: ${call.id}`);
    ids.add(call.id);
    if (call.operationId !== undefined) {
      if (call.operationId.trim().length === 0) {
        throw new RangeError("Operation ids must not be empty");
      }
      if (operationIds.has(call.operationId)) {
        throw new RangeError(`Duplicate operation id: ${call.operationId}`);
      }
      operationIds.add(call.operationId);
    }
    if (call.arguments === null || typeof call.arguments !== "object" || Array.isArray(call.arguments)) {
      throw new RangeError(`Tool call arguments must be an object: ${call.id}`);
    }
    inputBytes += Buffer.byteLength(stableJson({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      ...(call.operationId === undefined ? {} : { operationId: call.operationId }),
      ...(call.forcedError === undefined ? {} : { forcedError: call.forcedError }),
      ...(call.projection === undefined ? {} : { projection: call.projection }),
    }), "utf8");
    if (inputBytes > limits.maxInputBytes) {
      throw new MoweBatchLimitError(
        `Batch call input is ${inputBytes} bytes; limit is ${limits.maxInputBytes}`,
      );
    }
  }
}

function resolveBatchLimits(input: MoweBatchLimits | undefined): ResolvedMoweBatchLimits {
  const maxCalls = boundedInteger(
    input?.maxCalls,
    "limits.maxCalls",
    DEFAULT_MOWE_MAX_CALLS,
    1,
    MAX_MOWE_MAX_CALLS,
  );
  const maxInputBytes = boundedInteger(
    input?.maxInputBytes,
    "limits.maxInputBytes",
    DEFAULT_MOWE_MAX_INPUT_BYTES,
    1,
    MAX_MOWE_MAX_INPUT_BYTES,
  );
  const maxOutputBytes = boundedInteger(
    input?.maxOutputBytes,
    "limits.maxOutputBytes",
    DEFAULT_MOWE_MAX_OUTPUT_BYTES,
    1,
    MAX_MOWE_MAX_OUTPUT_BYTES,
  );
  const deadlineMs = input?.deadlineMs;
  if (deadlineMs !== undefined
    && (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_MOWE_DEADLINE_MS)) {
    throw new RangeError(`limits.deadlineMs must be an integer between 1 and ${MAX_MOWE_DEADLINE_MS}`);
  }
  return {
    maxCalls,
    maxInputBytes,
    maxOutputBytes,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  };
}

function boundedInteger(
  value: number | undefined,
  label: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return selected;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}

interface ToolDeadline {
  signal?: AbortSignal;
  didTimeout(): boolean;
  dispose(): void;
  timeoutMessage: string;
}

/**
 * Give each adapter a cooperative deadline. We intentionally wait for the
 * adapter promise to settle after signalling, so a non-cooperative adapter
 * cannot release a write/external concurrency slot while it is still running.
 */
function createToolDeadline(parentSignal: AbortSignal | undefined, timeoutMs: number | undefined): ToolDeadline {
  if (timeoutMs === undefined) {
    return {
      ...(parentSignal === undefined ? {} : { signal: parentSignal }),
      didTimeout: () => false,
      dispose: () => undefined,
      timeoutMessage: "",
    };
  }
  const controller = new AbortController();
  let timedOut = false;
  const timeoutMessage = `Tool timed out after ${timeoutMs}ms`;
  const timeout = setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort(new Error(timeoutMessage));
  }, timeoutMs);
  timeout.unref?.();
  const onAbort = (): void => {
    if (!controller.signal.aborted) controller.abort(parentSignal?.reason);
  };
  if (parentSignal?.aborted === true) onAbort();
  else parentSignal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", onAbort);
    },
    timeoutMessage,
  };
}

interface BatchDeadline {
  signal?: AbortSignal;
  dispose(): void;
}

/** Wrap one signal so every call in a batch shares the same wall-clock budget. */
function createBatchDeadline(
  parentSignal: AbortSignal | undefined,
  deadlineMs: number | undefined,
): BatchDeadline {
  if (deadlineMs === undefined) {
    return {
      ...(parentSignal === undefined ? {} : { signal: parentSignal }),
      dispose: () => undefined,
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new Error(`Mowe batch timed out after ${deadlineMs}ms`));
    }
  }, deadlineMs);
  timeout.unref?.();
  const onAbort = (): void => {
    if (!controller.signal.aborted) controller.abort(parentSignal?.reason);
  };
  if (parentSignal?.aborted === true) onAbort();
  else parentSignal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", onAbort);
    },
  };
}

/** Bound aggregate inline output while preserving the full source as an artifact when possible. */
async function boundBatchResults(
  results: readonly (MoweCallResult | undefined)[],
  maxOutputBytes: number,
  artifactStore: MoweExecutionRequest["artifactStore"],
): Promise<MoweCallResult[]> {
  let remaining = maxOutputBytes;
  const bounded: MoweCallResult[] = [];
  for (const result of results) {
    if (result === undefined) continue;
    const contentBytes = Buffer.from(result.result.content, "utf8");
    const contentLength = contentBytes.byteLength;
    if (contentLength <= remaining) {
      bounded.push(result);
      remaining -= contentLength;
      continue;
    }

    const artifactRef = artifactStore === undefined || contentLength === 0
      ? undefined
      : await artifactStore.put(contentBytes, "text/plain; charset=utf-8");
    const marker = remaining === 0 ? "[LIMIT]" : "[TRUNCATED]";
    const markerBytes = Buffer.from(marker, "utf8");
    const markerBudget = Math.min(remaining, markerBytes.byteLength);
    const excerpt = utf8Prefix(contentBytes, Math.max(0, remaining - markerBudget));
    const clipped = `${excerpt.toString("utf8")}${utf8Prefix(markerBytes, markerBudget).toString("utf8")}`;
    bounded.push({
      ...result,
      result: { ...result.result, content: clipped },
      ...(result.error === undefined ? {} : { error: clipped }),
      ...(result.projection === undefined
        ? {}
        : {
            projection: {
              ...result.projection,
              content: clipped,
              byteLength: contentLength,
              truncated: true,
              ...(artifactRef === undefined ? {} : { artifactRef }),
            },
          }),
    });
    remaining = 0;
  }
  return bounded;
}

function utf8Prefix(bytes: Buffer, maxBytes: number): Buffer {
  if (bytes.byteLength <= maxBytes) return bytes;
  let end = Math.max(0, maxBytes);
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end);
}

function isSignalAborted(signal: AbortSignal | undefined): signal is AbortSignal & { aborted: true } {
  return signal?.aborted === true;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function approvalGranted(decision: MoweApprovalDecision): boolean {
  return decision === true || (typeof decision === "object" && decision.approved === true);
}

function approvalReason(decision: MoweApprovalDecision): string {
  if (typeof decision === "object" && decision.reason !== undefined) {
    return `Tool approval denied: ${decision.reason}`;
  }
  return "Tool approval denied";
}

/** Short factory for callers that prefer a function over `new MoweExecutor`. */
export function createMoweExecutor(options: MoweExecutorOptions): MoweExecutor {
  return new MoweExecutor(options);
}
