import { realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  resolve as resolvePath,
} from "node:path";

import type { AgentTool, ToolResult } from "../domain/ports.js";
import { validateUserImages } from "../domain/images.js";
import { sha256, stableJson } from "../ledger/hash.js";
import { asCatalog, MoweCatalog } from "./catalog.js";
import { assertArguments } from "./admission.js";
import {
  projectResult,
  serializeToolResult,
} from "./result-projector.js";
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
  MoweApprovalDecisionRecord,
  MoweBatchLimits,
  MoweCall,
  MoweCallResult,
  MoweExecutionRequest,
  MoweExecutionResponse,
  MoweApprovalContext,
  MoweToolLifecycleContext,
  MoweToolEntry,
  ResultProjectionOptions,
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

function workspaceMutexFor(key: string): WorkspaceMutex {
  let mutex = workspaceMutexes.get(key);
  if (mutex === undefined) {
    mutex = new WorkspaceMutex();
    workspaceMutexes.set(key, mutex);
  }
  return mutex;
}

function releaseWorkspaceMutexIfIdle(key: string, mutex: WorkspaceMutex): void {
  if (workspaceMutexes.get(key) === mutex && mutex.idle) {
    workspaceMutexes.delete(key);
  }
}

/**
 * Resolve aliases even when the requested workspace leaf does not exist yet.
 * The nearest existing ancestor supplies the canonical prefix; unresolved
 * suffix components remain lexical until the caller creates them.
 */
async function canonicalWorkspaceMutexKey(workspace: string): Promise<string> {
  let current = resolvePath(workspace);
  const suffix: string[] = [];
  for (;;) {
    try {
      return resolvePath(await realpath(current), ...suffix);
    } catch (error: unknown) {
      if (!isMissingPath(error)) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

function isMissingPath(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
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
    const workspaceMutexKey = request.calls.some((call) => {
      const entry = this.catalog.get(call.name);
      return entry !== undefined && isWorkspaceWriteEntry(entry);
    })
      ? await canonicalWorkspaceMutexKey(request.workspace)
      : undefined;
    const deadline = createBatchDeadline(request.signal, limits.deadlineMs);
    const retention = new BatchResultRetention(
      limits.maxOutputBytes,
      request.artifactStore,
    );
    const executionRequest = deadline.signal === request.signal || deadline.signal === undefined
      ? request
      : { ...request, signal: deadline.signal };
    let boundedResults: MoweCallResult[] = [];
    try {
      await this.executePool(
        executionRequest,
        results,
        concurrency,
        workspaceMutexKey,
        retention,
      );
      boundedResults = results.filter((result): result is MoweCallResult => result !== undefined);
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
   *
   * `supportsBatch` is intentionally not an admission gate. It describes
   * whether an adapter has a native merged-call API; Mowe's batch envelope
   * always keeps calls isolated and executes each one independently.
   */
  private async executePool(
    request: MoweExecutionRequest,
    results: MoweCallResult[],
    concurrency: number,
    workspaceMutexKey: string | undefined,
    retention: BatchResultRetention,
  ): Promise<void> {
    const failureController = new AbortController();
    const executionRequest: MoweExecutionRequest = {
      ...request,
      signal: request.signal === undefined
        ? failureController.signal
        : AbortSignal.any([request.signal, failureController.signal]),
    };
    const pending = request.calls.map((_, index) => index);
    const activeByTool = new Map<string, number>();
    let activeWorkspaceWrites = 0;
    let active = 0;
    let failed = false;
    let firstFailure: unknown;

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
            const toolKey = entry.tool.definition.name;
            const current = activeByTool.get(toolKey) ?? 0;
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
          const toolKey = entry?.tool.definition.name ?? call.name.trim();
          const workspaceWrite = entry !== undefined && isWorkspaceWriteEntry(entry);
          active += 1;
          activeByTool.set(toolKey, (activeByTool.get(toolKey) ?? 0) + 1);
          if (workspaceWrite) activeWorkspaceWrites += 1;
          void this.executeCall(executionRequest, call, index, workspaceMutexKey)
            .catch((error: unknown) => {
              // executeCall normally converts failures into a per-call result;
              // retain that isolation if a future projector escapes its guard.
              return this.failure(
                call,
                operationIdFor(request, call, index),
                errorMessage(error),
              );
            })
            .then((result) => {
              return retention.retain(result, (error) => {
                return this.failure(
                  call,
                  operationIdFor(request, call, index),
                  `Tool result retention failed: ${errorMessage(error)}`,
                );
              });
            })
            .then(async (result) => {
              results[index] = result;
              await request.onResult?.(result, index);
            })
            .catch((error: unknown) => {
              // A terminal recorder failure is a batch failure, not another
              // tool outcome. Cancel peers, then keep draining their results.
              if (!failed) {
                failed = true;
                firstFailure = error;
                failureController.abort(error);
              }
            })
            .then(() => {
              active -= 1;
              const current = activeByTool.get(toolKey) ?? 1;
              if (current <= 1) activeByTool.delete(toolKey);
              else activeByTool.set(toolKey, current - 1);
              if (workspaceWrite) activeWorkspaceWrites -= 1;
              if (pending.length === 0 && active === 0) resolve();
              else pump();
            });
        }
        if (pending.length === 0 && active === 0) resolve();
      };
      pump();
    });
    if (failed) throw firstFailure;
  }

  private async executeCall(
    request: MoweExecutionRequest,
    call: MoweCall,
    index: number,
    workspaceMutexKey: string | undefined,
  ): Promise<MoweCallResult> {
    const operationId = operationIdFor(request, call, index);
    if (request.signal?.aborted === true) return this.cancelled(call, operationId, request.signal.reason);
    // A truncated provider response is a runtime fact, not a tool invocation.
    // Preserve the legacy behavior by recording that fact before catalog or
    // argument admission can turn it into a misleading schema error.
    if (call.forcedError !== undefined) {
      return this.failure(call, operationId, call.forcedError);
    }
    const entry = this.catalog.get(call.name);
    if (entry === undefined) {
      return this.failure(call, operationId, `Unknown tool: ${call.name}`);
    }
    if (request.allowedEffects !== undefined && !request.allowedEffects.includes(entry.metadata.effect)) {
      return this.failure(call, operationId, `Tool effect is not allowed: ${entry.metadata.effect}`);
    }
    if (request.allowedScopes !== undefined && !request.allowedScopes.includes(entry.metadata.scope)) {
      return this.failure(call, operationId, `Tool scope is not allowed: ${entry.metadata.scope}`);
    }
    try {
      assertArguments(entry.tool, call.arguments);
    } catch (error: unknown) {
      return this.failure(call, operationId, errorMessage(error));
    }
    if (entry.metadata.requiresApproval) {
      const approvalContext: MoweApprovalContext = {
        runId: request.runId,
        laneId: request.laneId,
        operationId,
        call,
        tool: entry,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      };
      const argumentsHash = sha256(stableJson(call.arguments));
      try {
        await request.approvalLifecycle?.requested(approvalContext, argumentsHash);
      } catch (error: unknown) {
        return this.failure(
          call,
          operationId,
          `Tool approval recording failed: ${errorMessage(error)}`,
        );
      }
      if (request.approve === undefined) {
        const decision: MoweApprovalDecisionRecord = {
          decision: "denied",
          reason: "No approval handler configured",
        };
        try {
          await request.approvalLifecycle?.decided(approvalContext, decision);
        } catch (error: unknown) {
          return this.failure(
            call,
            operationId,
            `Tool approval recording failed: ${errorMessage(error)}`,
          );
        }
        return this.failure(call, operationId, "Tool requires approval before execution");
      }
      let approval: MoweApprovalDecisionRecord;
      try {
        const decision = await request.approve(approvalContext);
        approval = isSignalAborted(request.signal)
          ? cancellationRecord(reasonText(request.signal.reason))
          : approvalRecord(decision);
      } catch (error: unknown) {
        approval = ((request.signal !== undefined && request.signal.aborted) || isAbortError(error))
          ? cancellationRecord(reasonText(request.signal?.reason ?? error))
          : { decision: "denied", reason: `Approval callback failed: ${errorMessage(error)}` };
      }
      try {
        await request.approvalLifecycle?.decided(approvalContext, approval);
      } catch (error: unknown) {
        return this.failure(
          call,
          operationId,
          `Tool approval recording failed: ${errorMessage(error)}`,
        );
      }
      if (approval.decision === "cancelled") {
        return this.cancelled(call, operationId, request.signal?.reason ?? approval.reason);
      }
      if (approval.decision !== "approved") {
        return this.failure(
          call,
          operationId,
          approval.reason === undefined ? "Tool approval denied" : `Tool approval denied: ${approval.reason}`,
        );
      }
      if (isSignalAborted(request.signal)) {
        return this.cancelled(call, operationId, request.signal?.reason);
      }
    }
    const lifecycleContext: MoweToolLifecycleContext = {
      runId: request.runId,
      laneId: request.laneId,
      operationId,
      call: structuredClone(call),
      tool: entry,
      argumentsHash: sha256(stableJson(call.arguments)),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    };
    try {
      await request.toolLifecycle?.admitted(lifecycleContext);
    } catch (error: unknown) {
      return this.failure(
        call,
        operationId,
        `Tool admission recording failed: ${errorMessage(error)}`,
      );
    }
    // Admission may be durable before cancellation arrives. Re-check before
    // entering the effect boundary so an admitted-but-never-started call does
    // not invoke user code.
    if (isSignalAborted(request.signal)) {
      return this.cancelled(call, operationId, request.signal?.reason);
    }
    const deadline = createToolDeadline(request.signal, entry.metadata.timeoutMs);
    try {
      const context = {
        runId: request.runId,
        laneId: request.laneId,
        workspace: request.workspace,
        operationId,
        ...(deadline.signal === undefined ? {} : { signal: deadline.signal }),
      };
      const workspaceMutex = isWorkspaceWriteEntry(entry)
        ? workspaceMutexFor(workspaceMutexKey ?? resolvePath(request.workspace))
        : undefined;
      const invokeTool = async (): Promise<ToolResult> => {
        // This is the last durable boundary before user code or an external
        // process can create a side effect.
        if (isSignalAborted(deadline.signal)) {
          throw abortReason(deadline.signal);
        }
        try {
          await request.toolLifecycle?.started(lifecycleContext);
        } catch (error: unknown) {
          throw new Error(`Tool start recording failed: ${errorMessage(error)}`);
        }
        // The started hook is asynchronous because it normally commits a
        // durable fact. Cancellation can win during that write; do not let a
        // late callback completion turn it into an unrecorded side effect.
        if (isSignalAborted(deadline.signal)) {
          throw abortReason(deadline.signal);
        }
        return entry.tool.execute(call.arguments, context);
      };
      let rawResult: ToolResult;
      try {
        rawResult = workspaceMutex === undefined
          ? await invokeTool()
          : await workspaceMutex.run(
            invokeTool,
            deadline.signal,
          );
      } finally {
        if (workspaceMutex !== undefined) {
          releaseWorkspaceMutexIfIdle(
            workspaceMutexKey ?? resolvePath(request.workspace),
            workspaceMutex,
          );
        }
      }
      // A cooperative adapter may return a normal value after observing the
      // abort signal. Preserve the deadline as a runtime failure either way.
      if (deadline.didTimeout()) return this.failure(call, operationId, deadline.timeoutMessage);
      const result = this.#sanitizeResult(rawResult);
      validateUserImages(result.images);
      const projectionOptions = { ...request.projection, ...call.projection };
      // Aggregate accounting owns artifact retention. Per-call projection must
      // not persist an unbudgeted second copy before the batch is bounded.
      const projection = projectionOptions.mode === "artifact"
        ? artifactProjection(result)
        : await projectResult(result, projectionOptions);
      if (deadline.didTimeout()) return this.failure(call, operationId, deadline.timeoutMessage);
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
      if (deadline.didTimeout()) return this.failure(call, operationId, deadline.timeoutMessage);
      if ((request.signal !== undefined && request.signal.aborted) || isAbortError(error)) return this.cancelled(call, operationId, request.signal?.reason ?? error);
      return this.failure(call, operationId, errorMessage(error));
    } finally {
      deadline.dispose();
    }
  }

  /** Keep runtime/tool failures behind the same redaction boundary as values. */
  private failure(
    call: MoweCall,
    operationId: string,
    message: string,
    status: "failed" | "cancelled" = "failed",
  ): MoweCallResult {
    let result: ToolResult;
    try {
      const sanitized = this.#sanitizeResult({ content: message, isError: true });
      if (typeof sanitized.content !== "string") {
        throw new TypeError("Sanitized tool failure content must be a string");
      }
      validateUserImages(sanitized.images);
      result = {
        content: sanitized.content,
        isError: true,
        ...(sanitized.images === undefined ? {} : { images: structuredClone(sanitized.images) }),
      };
    } catch {
      // A broken sanitizer must not re-expose the original exception while
      // Mowe is trying to record the failure that reached that boundary.
      result = { content: "Tool result sanitization failed", isError: true };
    }
    return {
      callId: call.id,
      name: call.name,
      operationId,
      status,
      result,
      error: result.content,
    };
  }

  private cancelled(call: MoweCall, operationId: string, reason: unknown): MoweCallResult {
    return this.failure(
      call,
      operationId,
      `Operation cancelled${reason instanceof Error ? `: ${reason.message}` : ""}`,
      "cancelled",
    );
  }
}

export function operationIdFor(request: Pick<MoweExecutionRequest, "runId" | "laneId">, call: MoweCall, index = 0): string {
  return call.operationId ?? `op:${sha256(stableJson({ runId: request.runId, laneId: request.laneId, index, callId: call.id, name: call.name, arguments: call.arguments }))}`;
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
  validateProjectionOptions(request.projection, "projection");
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
    validateProjectionOptions(call.projection, `Tool call projection (${call.id})`);
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

/** Validate caller-owned view settings before any tool can produce a side effect. */
function validateProjectionOptions(
  projection: ResultProjectionOptions | undefined,
  label: string,
): void {
  if (projection === undefined) return;
  if (projection === null || typeof projection !== "object" || Array.isArray(projection)) {
    throw new RangeError(`${label} must be an object`);
  }
  if (projection.mode !== undefined
    && projection.mode !== "auto"
    && projection.mode !== "inline"
    && projection.mode !== "preview"
    && projection.mode !== "summary"
    && projection.mode !== "artifact") {
    throw new RangeError(`${label}.mode is invalid`);
  }
  if (projection.maxBytes !== undefined
    && (!Number.isSafeInteger(projection.maxBytes) || projection.maxBytes < 1)) {
    throw new RangeError(`${label}.maxBytes must be a positive integer`);
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

/** Reserve aggregate output synchronously in tool-completion order. */
class BatchResultRetention {
  #remaining: number;
  readonly #artifactStore: MoweExecutionRequest["artifactStore"];

  constructor(
    maxOutputBytes: number,
    artifactStore: MoweExecutionRequest["artifactStore"],
  ) {
    this.#remaining = maxOutputBytes;
    this.#artifactStore = artifactStore;
  }

  retain(
    result: MoweCallResult,
    onFailure: (error: unknown) => MoweCallResult,
  ): Promise<MoweCallResult> {
    let plan: RetentionPlan;
    try {
      plan = planCallResult(result, this.#remaining, this.#artifactStore !== undefined);
    } catch (error: unknown) {
      plan = planRetentionFailure(onFailure(error), this.#remaining);
    }

    // Planning contains no await, so this subtraction is atomic with respect
    // to every other completed call entering retain() on the JS event loop.
    this.#remaining = Math.max(0, this.#remaining - plan.retainedBytes);
    const artifact = plan.artifact;
    if (artifact === undefined || this.#artifactStore === undefined) {
      return Promise.resolve(plan.result);
    }
    return this.persistArtifact({ ...plan, artifact }, onFailure);
  }

  private async persistArtifact(
    plan: RetentionPlan & { artifact: PendingArtifact },
    onFailure: (error: unknown) => MoweCallResult,
  ): Promise<MoweCallResult> {
    try {
      const artifactRef = await this.#artifactStore!.put(
        plan.artifact.bytes,
        plan.artifact.mediaType,
      );
      return {
        ...plan.result,
        projection: { ...plan.result.projection!, artifactRef },
      };
    } catch (error: unknown) {
      // The reservation is deliberately not refunded: a failing store may
      // have persisted bytes before reporting failure. The replacement error
      // can spend only the non-artifact part of this call's reservation.
      const failureBudget = Math.max(
        0,
        plan.retainedBytes - plan.artifact.bytes.byteLength,
      );
      return planRetentionFailure(onFailure(error), failureBudget).result;
    }
  }
}

interface PendingArtifact {
  bytes: Buffer;
  mediaType: string;
}

interface RetentionPlan {
  result: MoweCallResult;
  retainedBytes: number;
  artifact?: PendingArtifact;
}

/** Bound every returned, projected, and newly persisted payload for one call. */
function planCallResult(
  result: MoweCallResult,
  remaining: number,
  canPersistArtifact: boolean,
): RetentionPlan {
  const projection = result.projection;
  if (projection?.mode === "artifact") {
    const payload = serializeToolResult(result.result);
    if (canPersistArtifact && payload.bytes.byteLength <= remaining) {
      return {
        result: externalizedCallResult(result, projection),
        retainedBytes: payload.bytes.byteLength,
        artifact: { bytes: payload.bytes, mediaType: payload.mediaType },
      };
    }
    const fitted = withoutProjection(fitCallResult(result, remaining));
    return {
      result: fitted,
      retainedBytes: callResultPayloadByteLength(fitted),
    };
  }

  // Inline projection is exactly the canonical result. Retaining both would
  // double-count the same user-visible payload for no additional capability.
  if (projection === undefined || projection.mode === "inline") {
    const fitted = withoutProjection(fitCallResult(result, remaining));
    return {
      result: fitted,
      retainedBytes: callResultPayloadByteLength(fitted),
    };
  }

  const projectionBytes = projectionPayloadByteLength(projection, result.result.isError);
  const projected = projectedCallResult(result, projection);
  const projectedBytes = callResultPayloadByteLength(projected);
  const source = serializeToolResult(result.result);
  const externalizedBytes = source.bytes.byteLength + projectionBytes + projectedBytes;
  if (canPersistArtifact && externalizedBytes <= remaining) {
    return {
      result: {
        ...projected,
        projection,
      },
      retainedBytes: externalizedBytes,
      artifact: { bytes: source.bytes, mediaType: source.mediaType },
    };
  }

  if (projectionBytes <= remaining) {
    const fitted = fitCallResult(result, remaining - projectionBytes);
    return {
      result: { ...fitted, projection },
      retainedBytes: projectionBytes + callResultPayloadByteLength(fitted),
    };
  }

  const fitted = withoutProjection(fitCallResult(result, remaining));
  return {
    result: fitted,
    retainedBytes: callResultPayloadByteLength(fitted),
  };
}

function planRetentionFailure(
  failure: MoweCallResult,
  reservedBytes: number,
): RetentionPlan {
  const fitted = withoutProjection(fitCallResult(failure, reservedBytes));
  return {
    result: fitted,
    retainedBytes: callResultPayloadByteLength(fitted),
  };
}

function artifactProjection(result: ToolResult): NonNullable<MoweCallResult["projection"]> {
  return {
    mode: "artifact",
    byteLength: serializeToolResult(result).bytes.byteLength,
    truncated: false,
  };
}

function externalizedCallResult(
  result: MoweCallResult,
  projection: NonNullable<MoweCallResult["projection"]>,
): MoweCallResult {
  const emptyResult = withoutImages(result.result, "");
  return {
    ...result,
    result: emptyResult,
    ...(result.error === undefined ? {} : { error: "" }),
    projection,
  };
}

function projectedCallResult(
  result: MoweCallResult,
  projection: NonNullable<MoweCallResult["projection"]>,
): MoweCallResult {
  const projectedResult: ToolResult = {
    content: projection.content ?? "",
    isError: result.result.isError,
    ...(projection.images === undefined ? {} : { images: structuredClone(projection.images) }),
  };
  return {
    ...result,
    result: projectedResult,
    ...(result.error === undefined ? {} : { error: projectedResult.content }),
    projection,
  };
}

function withoutProjection(result: MoweCallResult): MoweCallResult {
  const { projection: _projection, ...without } = result;
  return without;
}

function callResultPayloadByteLength(result: MoweCallResult): number {
  return serializeToolResult(result.result).bytes.byteLength
    + (result.error === undefined ? 0 : Buffer.byteLength(result.error, "utf8"));
}

function projectionPayloadByteLength(
  projection: NonNullable<MoweCallResult["projection"]>,
  isError: boolean,
): number {
  const images = projection.images;
  if (images !== undefined && images.length > 0) {
    return serializeToolResult({
      content: projection.content ?? "",
      isError,
      images,
    }).bytes.byteLength;
  }
  return Buffer.byteLength(projection.content ?? "", "utf8");
}

function fitCallResult(result: MoweCallResult, budget: number): MoweCallResult {
  if (callResultPayloadByteLength(result) <= budget) return result;
  const textOnly = withoutImages(result.result, result.result.content);
  if (result.error === undefined) {
    return {
      ...result,
      result: {
        ...textOnly,
        content: clipTextContent(Buffer.from(textOnly.content, "utf8"), budget),
      },
    };
  }

  if (result.error === result.result.content) {
    const sharedBudget = Math.floor(budget / 2);
    const content = clipTextContent(Buffer.from(textOnly.content, "utf8"), sharedBudget);
    return {
      ...result,
      result: { ...textOnly, content },
      error: content,
    };
  }

  const contentBudget = Math.floor(budget / 2);
  const content = clipTextContent(Buffer.from(textOnly.content, "utf8"), contentBudget);
  const errorBudget = Math.max(0, budget - Buffer.byteLength(content, "utf8"));
  return {
    ...result,
    result: { ...textOnly, content },
    error: clipTextContent(Buffer.from(result.error, "utf8"), errorBudget),
  };
}

function clipTextContent(contentBytes: Buffer, remaining: number): string {
  if (contentBytes.byteLength <= remaining) return contentBytes.toString("utf8");
  const marker = remaining === 0 ? "[LIMIT]" : "[TRUNCATED]";
  const markerBytes = Buffer.from(marker, "utf8");
  const markerBudget = Math.min(remaining, markerBytes.byteLength);
  const excerpt = utf8Prefix(contentBytes, Math.max(0, remaining - markerBudget));
  return `${excerpt.toString("utf8")}${utf8Prefix(markerBytes, markerBudget).toString("utf8")}`;
}

function withoutImages(result: MoweCallResult["result"], content: string): MoweCallResult["result"] {
  const { images: _images, ...textResult } = result;
  return { ...textResult, content };
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

function approvalRecord(decision: MoweApprovalDecision): MoweApprovalDecisionRecord {
  if (decision === true) return { decision: "approved" };
  if (typeof decision === "object" && decision.approved === true) {
    return {
      decision: "approved",
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    };
  }
  return {
    decision: "denied",
    ...(typeof decision === "object" && decision.reason !== undefined
      ? { reason: decision.reason }
      : {}),
  };
}

function reasonText(reason: unknown): string | undefined {
  if (reason === undefined) return undefined;
  return reason instanceof Error ? reason.message : String(reason);
}

function cancellationRecord(reason: string | undefined): MoweApprovalDecisionRecord {
  return reason === undefined
    ? { decision: "cancelled" }
    : { decision: "cancelled", reason };
}

/** Short factory for callers that prefer a function over `new MoweExecutor`. */
export function createMoweExecutor(options: MoweExecutorOptions): MoweExecutor {
  return new MoweExecutor(options);
}
