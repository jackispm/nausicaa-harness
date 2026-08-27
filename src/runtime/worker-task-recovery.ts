import type {
  A2AMessage,
  AnyEvent,
  ArtifactRef,
  ConversationMessage,
  LaneId,
  TokenUsage,
  ToolCall,
} from "../domain/index.js";
import type { ContentAddressedStore } from "../store/index.js";
import { WorkerTaskExecutorError } from "./worker-task-errors.js";

export type WorkerTaskRequestMessage = Omit<A2AMessage, "payload"> & {
  payload: Extract<A2AMessage["payload"], { type: "task.request" }>;
};

export type WorkerModelRequestedEvent = Extract<AnyEvent, { type: "model.requested" }>;
export type WorkerModelCompletedEvent = Extract<AnyEvent, { type: "model.completed" }>;
export type WorkerModelFailedEvent = Extract<AnyEvent, { type: "model.failed" }>;

export interface WorkerExecutionState {
  requests: WorkerModelRequestedEvent[];
  completions: WorkerModelCompletedEvent[];
  failures: WorkerModelFailedEvent[];
  usage: TokenUsage;
  nextAttempt: number;
}

export async function readWorkerExecutionState(options: {
  readEvents?: () => Promise<readonly AnyEvent[]>;
  runId: string;
  laneId: LaneId;
  request: WorkerTaskRequestMessage;
}): Promise<WorkerExecutionState> {
  if (options.readEvents === undefined) {
    return emptyWorkerExecutionState();
  }
  const taskPrefix = `${options.runId}:${options.laneId}:task:${options.request.payload.taskId}:attempt:`;
  const sessionId = `${options.runId}:${options.laneId}:task:${options.request.payload.taskId}`;
  const events = [...await options.readEvents()].sort((left, right) => (
    left.globalOffset - right.globalOffset
  ));
  const requests = events.filter((event): event is WorkerModelRequestedEvent => (
    event.runId === options.runId
    && event.laneId === options.laneId
    && event.type === "model.requested"
    && event.correlationId === options.request.correlationId
    && event.idempotencyKey.startsWith(taskPrefix)
    && event.idempotencyKey.endsWith(":model:requested")
    && event.payload.sessionId === sessionId
  ));
  const requestedPrefixes = new Set(requests.map((event) => event.idempotencyKey.slice(
    0,
    -":model:requested".length,
  )));
  const completions = events.filter((event): event is WorkerModelCompletedEvent => {
    if (
      event.runId !== options.runId
      || event.laneId !== options.laneId
      || event.type !== "model.completed"
      || event.correlationId !== options.request.correlationId
      || !event.idempotencyKey.endsWith(":model:completed")
    ) {
      return false;
    }
    return requestedPrefixes.has(event.idempotencyKey.slice(
      0,
      -":model:completed".length,
    ));
  });
  const failures = events.filter((event): event is WorkerModelFailedEvent => {
    if (
      event.runId !== options.runId
      || event.laneId !== options.laneId
      || event.type !== "model.failed"
      || event.correlationId !== options.request.correlationId
      || !event.idempotencyKey.endsWith(":model:failed")
    ) {
      return false;
    }
    return requestedPrefixes.has(event.idempotencyKey.slice(
      0,
      -":model:failed".length,
    ));
  });
  const charges = events.filter((event): event is Extract<AnyEvent, { type: "budget.charged" }> => {
    if (
      event.runId !== options.runId
      || event.laneId !== options.laneId
      || event.type !== "budget.charged"
      || event.payload.laneId !== options.laneId
      || event.correlationId !== options.request.correlationId
      || !event.idempotencyKey.endsWith(":budget")
    ) {
      return false;
    }
    return requestedPrefixes.has(event.idempotencyKey.slice(
      0,
      -":budget".length,
    ));
  });
  const completionsByPrefix = new Map(completions.map((event) => [
    event.idempotencyKey.slice(0, -":model:completed".length),
    event,
  ]));
  const chargesByPrefix = new Map(charges.map((event) => [
    event.idempotencyKey.slice(0, -":budget".length),
    event,
  ]));
  // A durable charge closes the provider-to-CAS crash window. Older logs may
  // have only a completion, so use it strictly as a per-attempt fallback.
  let usage = zeroUsage();
  for (const prefix of requestedPrefixes) {
    const charged = chargesByPrefix.get(prefix);
    const completed = completionsByPrefix.get(prefix);
    const attemptUsage = charged?.payload.usage ?? completed?.payload.usage;
    if (attemptUsage === undefined) continue;
    validateUsage(attemptUsage);
    usage = addUsage(usage, attemptUsage);
  }
  const greatestAttempt = requests.reduce((maximum, event) => {
    const value = event.idempotencyKey.slice(
      taskPrefix.length,
      -":model:requested".length,
    ).split(":", 1)[0];
    const attempt = Number(value);
    return Number.isSafeInteger(attempt) && attempt > 0
      ? Math.max(maximum, attempt)
      : maximum;
  }, 0);
  return {
    requests,
    completions,
    failures,
    usage,
    nextAttempt: Math.max(requests.length, greatestAttempt) + 1,
  };
}

export async function readCommittedWorkerAssistant(
  store: ContentAddressedStore,
  ref: ArtifactRef,
  signal: AbortSignal,
): Promise<Extract<ConversationMessage, { role: "assistant" }>> {
  const bytes = await withAbort(store.get(ref), signal);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new WorkerTaskExecutorError("Committed Worker response is not valid JSON");
  }
  if (
    !isRecord(value)
    || value.role !== "assistant"
    || typeof value.content !== "string"
    || !Array.isArray(value.toolCalls)
    || !value.toolCalls.every(isToolCall)
  ) {
    throw new WorkerTaskExecutorError("Committed Worker response is not an assistant message");
  }
  return value as Extract<ConversationMessage, { role: "assistant" }>;
}

function zeroUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    ...(left.costUsd === undefined && right.costUsd === undefined
      ? {}
      : { costUsd: (left.costUsd ?? 0) + (right.costUsd ?? 0) }),
  };
}

function validateUsage(usage: TokenUsage): void {
  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (!Number.isSafeInteger(usage[field]) || usage[field] < 0) {
      throw new WorkerTaskExecutorError(`Model usage ${field} must be a non-negative integer`);
    }
  }
  if (usage.costUsd !== undefined && (!Number.isFinite(usage.costUsd) || usage.costUsd < 0)) {
    throw new WorkerTaskExecutorError("Model usage costUsd must be non-negative");
  }
}

function emptyWorkerExecutionState(): WorkerExecutionState {
  return {
    requests: [],
    completions: [],
    failures: [],
    usage: zeroUsage(),
    nextAttempt: 1,
  };
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isToolCall(value: unknown): value is ToolCall {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && isRecord(value.arguments)
    && !Array.isArray(value.arguments);
}
