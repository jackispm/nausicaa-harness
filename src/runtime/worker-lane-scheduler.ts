import { randomUUID } from "node:crypto";

import type { A2AInbox, InboxRecord } from "../a2a/index.js";
import type { AnyEvent, DeliveryMode, LaneId, RunId } from "../domain/index.js";
import type {
  MainAfterStepContext,
  MainBeforeStepContext,
  MainBoundaryMessage,
} from "./main-loop.js";
import type { WorkerTaskExecutor } from "./worker-task-executor.js";

const DEFAULT_MAIN_LANE = "main";
const DEFAULT_WORKER_LANE = "worker";
const DEFAULT_BOUNDARY_LIMIT = 4;
const MAX_BOUNDARY_LIMIT = 32;
const DEFAULT_MAX_PENDING_ACTIVATIONS = 8;
const MAX_PENDING_ACTIVATIONS = 64;
const DEFAULT_MAX_TASKS_PER_ACTIVATION = 8;
const MAX_TASKS_PER_ACTIVATION = 64;
const DEFAULT_STOP_WAIT_MS = 250;
const MAX_STOP_WAIT_MS = 10_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
// A claim can remain visible when its acknowledgement append fails.  Give a
// hand-off race one immediate retry, then move retries onto timers with a
// finite backoff so a broken sink cannot monopolize the event loop.
const ZERO_DELAY_WAKE_RETRY_BASE_MS = 25;
const MAX_ZERO_DELAY_WAKE_RETRY_MS = 1_000;
const MAX_ZERO_DELAY_WAKE_RETRIES = 8;

function mainBoundaryDeliveries(step: number): readonly DeliveryMode[] {
  return step === 1
    ? ["urgent", "next-step", "next-turn"]
    : ["urgent", "next-step"];
}

export type WorkerTaskRunner = Pick<WorkerTaskExecutor, "runOnce"> & {
  /** Optional hook for executors which own an AbortController. */
  stop?: () => void | Promise<void>;
};
type TerminalRecord = InboxRecord & {
  message: InboxRecord["message"] & {
    payload: Extract<InboxRecord["message"]["payload"], {
      type: "task.result" | "task.failed";
    }>;
  };
};

export interface WorkerLaneSchedulerOptions {
  executor: WorkerTaskRunner;
  inbox: A2AInbox;
  runId: RunId;
  mainLaneId?: LaneId;
  workerLaneId?: LaneId;
  maxResultsPerBoundary?: number;
  /** Maximum active + queued Worker activations; extra enqueues coalesce. */
  maxPendingActivations?: number;
  /** Maximum tasks consumed by one activation before yielding to Main. */
  maxTasksPerActivation?: number;
  /** Boundary messages already consumed by committed Main Steps during replay. */
  committedBoundaryMessageIds?: readonly string[];
  createId?: () => string;
  signal?: AbortSignal;
  stopWaitMs?: number;
}

/**
 * Keeps Worker work behind Main's step boundary. Enqueue is synchronous and
 * only schedules a serial worker activation; Main never awaits the worker.
 */
export class WorkerLaneScheduler {
  private readonly executor: WorkerTaskRunner;
  private readonly inbox: A2AInbox;
  private readonly runId: RunId;
  private readonly mainLaneId: LaneId;
  private readonly workerLaneId: LaneId;
  private readonly maxResultsPerBoundary: number;
  private readonly maxPendingActivations: number;
  private readonly maxTasksPerActivation: number;
  private readonly createId: () => string;
  private readonly signal: AbortSignal | undefined;
  private readonly stopWaitMs: number;
  private readonly stopController = new AbortController();
  private readonly committedBoundaryMessageIds = new Set<string>();
  private readonly failures: Error[] = [];
  private tail: Promise<void> = Promise.resolve();
  private receiptTail: Promise<void> = Promise.resolve();
  private leaseWakeTimer: ReturnType<typeof setTimeout> | undefined;
  private leaseWakeRequested = false;
  private zeroDelayWakeRetries = 0;
  private pendingActivationCount = 0;
  private droppedWakeups = 0;
  private accepting = true;

  constructor(options: WorkerLaneSchedulerOptions) {
    nonEmpty(options.runId, "runId");
    const maxResultsPerBoundary = options.maxResultsPerBoundary ?? DEFAULT_BOUNDARY_LIMIT;
    if (
      !Number.isSafeInteger(maxResultsPerBoundary)
      || maxResultsPerBoundary < 1
      || maxResultsPerBoundary > MAX_BOUNDARY_LIMIT
    ) {
      throw new RangeError(
        `maxResultsPerBoundary must be an integer between 1 and ${MAX_BOUNDARY_LIMIT}`,
      );
    }
    this.executor = options.executor;
    this.inbox = options.inbox;
    this.runId = options.runId;
    this.mainLaneId = options.mainLaneId ?? DEFAULT_MAIN_LANE;
    this.workerLaneId = options.workerLaneId ?? DEFAULT_WORKER_LANE;
    this.maxResultsPerBoundary = maxResultsPerBoundary;
    const maxPendingActivations = options.maxPendingActivations ?? DEFAULT_MAX_PENDING_ACTIVATIONS;
    if (
      !Number.isSafeInteger(maxPendingActivations)
      || maxPendingActivations < 1
      || maxPendingActivations > MAX_PENDING_ACTIVATIONS
    ) {
      throw new RangeError(
        `maxPendingActivations must be an integer between 1 and ${MAX_PENDING_ACTIVATIONS}`,
      );
    }
    this.maxPendingActivations = maxPendingActivations;
    const maxTasksPerActivation = options.maxTasksPerActivation
      ?? DEFAULT_MAX_TASKS_PER_ACTIVATION;
    if (
      !Number.isSafeInteger(maxTasksPerActivation)
      || maxTasksPerActivation < 1
      || maxTasksPerActivation > MAX_TASKS_PER_ACTIVATION
    ) {
      throw new RangeError(
        `maxTasksPerActivation must be an integer between 1 and ${MAX_TASKS_PER_ACTIVATION}`,
      );
    }
    this.maxTasksPerActivation = maxTasksPerActivation;
    this.createId = options.createId ?? randomUUID;
    this.signal = options.signal;
    const stopWaitMs = options.stopWaitMs ?? DEFAULT_STOP_WAIT_MS;
    if (
      !Number.isSafeInteger(stopWaitMs)
      || stopWaitMs < 1
      || stopWaitMs > MAX_STOP_WAIT_MS
    ) {
      throw new RangeError(
        `stopWaitMs must be an integer between 1 and ${MAX_STOP_WAIT_MS}`,
      );
    }
    this.stopWaitMs = stopWaitMs;
    nonEmpty(this.mainLaneId, "mainLaneId");
    nonEmpty(this.workerLaneId, "workerLaneId");
    for (const messageId of options.committedBoundaryMessageIds ?? []) {
      nonEmpty(messageId, "committedBoundaryMessageIds[]");
      this.committedBoundaryMessageIds.add(messageId);
    }
  }

  /** Pass this signal to an executor that supports cancellation. */
  get abortSignal(): AbortSignal {
    return this.stopController.signal;
  }

  /** Number of active or queued Worker activations. */
  get pendingActivations(): number {
    return this.pendingActivationCount;
  }

  /** Number of redundant wakeups coalesced by the activation bound. */
  get droppedWakeupsCount(): number {
    return this.droppedWakeups;
  }

  /** Called from Main's synchronous afterStep hook. */
  enqueue(context?: MainAfterStepContext): void {
    if (!this.accepting) return;
    // An explicit Main boundary is a fresh wake signal.  It may be the first
    // opportunity for a previously failed persistence operation to recover.
    this.zeroDelayWakeRetries = 0;
    this.clearLeaseWakeup();
    if (context !== undefined) {
      if (context.runId !== this.runId || context.laneId !== this.mainLaneId) {
        this.failures.push(new Error(
          `Worker lane scheduler for ${this.runId}/${this.mainLaneId} received ${context.runId}/${context.laneId}`,
        ));
        return;
      }
      for (const messageId of context.boundaryMessageIds) {
        this.committedBoundaryMessageIds.add(messageId);
      }
    }
    this.scheduleAcknowledgements([...this.committedBoundaryMessageIds]);
    if (this.pendingActivationCount >= this.maxPendingActivations) {
      this.droppedWakeups += 1;
      return;
    }
    this.scheduleActivation();
  }

  /** Claim completed Worker replies for the next Main natural boundary. */
  async beforeMainStep(
    context?: Pick<MainBeforeStepContext, "step"> & { maxResults?: number },
  ): Promise<readonly MainBoundaryMessage[]> {
    if (!this.accepting || this.stopController.signal.aborted || this.signal?.aborted) {
      return [];
    }
    try {
      await this.acknowledgeCommitted([...this.committedBoundaryMessageIds]);
      const records = await this.inbox.claim(this.mainLaneId, this.mainLaneId, {
        claimId: `${this.runId}:worker:delivery:${this.createId()}`,
        limit: Math.min(this.maxResultsPerBoundary, context?.maxResults ?? this.maxResultsPerBoundary),
        runId: this.runId,
        from: this.workerLaneId,
        types: ["task.accept", "task.result", "task.failed"],
        ...(context === undefined
          ? {}
          : { deliveries: mainBoundaryDeliveries(context.step) }),
      });
      const messages: MainBoundaryMessage[] = [];
      for (const record of records) {
        if (record.message.payload.type === "task.accept") {
          // Acceptance is a transport status, not model context.
          try {
            await this.inbox.handle(record.message.messageId, this.mainLaneId);
          } catch (error: unknown) {
            // Keep a failed receipt leased so the Inbox can redeliver it.
            this.failures.push(asError(error));
          }
          continue;
        }
        const terminal = record as TerminalRecord;
        if (this.committedBoundaryMessageIds.has(record.message.messageId)) {
          // The Main Step is already committed. Repair the transport receipt,
          // but never inject the terminal into a second model request.
          await this.acknowledgeCommitted([record.message.messageId]);
          continue;
        }
        messages.push({
          kind: "runtime-notice",
          source: this.workerLaneId,
          messageId: record.message.messageId,
          content: formatTerminal(terminal),
        });
      }
      return messages;
    } catch (error: unknown) {
      this.failures.push(asError(error));
      return [];
    }
  }

  /** Wait for already scheduled work without starting an unbounded drain. */
  async drain(): Promise<readonly Error[]> {
    while (true) {
      const observedWorker = this.tail;
      const observedReceipts = this.receiptTail;
      await Promise.all([observedWorker, observedReceipts]);
      if (observedWorker === this.tail && observedReceipts === this.receiptTail) break;
    }
    return [...this.failures];
  }

  async stop(): Promise<readonly Error[]> {
    this.accepting = false;
    this.clearLeaseWakeup();
    this.leaseWakeRequested = false;
    if (!this.stopController.signal.aborted) {
      this.stopController.abort(new DOMException(
        "Worker lane cancelled after Main finished",
        "AbortError",
      ));
    }
    try {
      await this.runWithin(this.executor.stop?.(), this.stopWaitMs);
    } catch (error: unknown) {
      this.failures.push(asError(error));
    }
    return this.drainWithin(this.stopWaitMs);
  }

  private scheduleActivation(): void {
    if (!this.accepting || this.pendingActivationCount >= this.maxPendingActivations) return;
    this.pendingActivationCount += 1;
    let madeProgress = false;
    const operation = this.tail.then(async () => {
      if (this.stopController.signal.aborted || this.signal?.aborted) return;
      for (let index = 0; index < this.maxTasksPerActivation; index += 1) {
        const result = await this.executor.runOnce();
        if (result.status === "idle") break;
        madeProgress = true;
        if (this.stopController.signal.aborted || this.signal?.aborted) break;
      }
    });
    this.tail = operation.catch((error: unknown) => {
      this.failures.push(asError(error));
    }).finally(() => {
      this.pendingActivationCount -= 1;
      if (madeProgress) this.zeroDelayWakeRetries = 0;
      if (this.leaseWakeRequested) {
        this.leaseWakeRequested = false;
        this.scheduleActivation();
        return;
      }
      this.scheduleLeaseWakeup();
    });
  }

  private scheduleLeaseWakeup(): void {
    this.clearLeaseWakeup();
    if (!this.accepting || this.stopController.signal.aborted || this.signal?.aborted) return;
    const delay = this.inbox.nextClaimableDelayMs(this.workerLaneId, {
      runId: this.runId,
      types: ["task.request"],
    });
    if (delay === undefined) return;
    // A zero delay can be a real hand-off race: enqueue may have coalesced a
    // wakeup while the previous runOnce was still checking the Inbox. Start
    // one bounded activation now so that task is not stranded until Main's
    // next boundary. The executor's idle result still bounds the work.
    let wakeDelay = delay;
    if (wakeDelay <= 0) {
      if (this.zeroDelayWakeRetries >= MAX_ZERO_DELAY_WAKE_RETRIES) return;
      const retry = this.zeroDelayWakeRetries;
      this.zeroDelayWakeRetries += 1;
      // Preserve the one immediate retry needed for a task admitted while an
      // activation was finishing.  Further retries yield to the event loop
      // and back off; an explicit enqueue resets this bound.
      if (retry === 0) {
        this.scheduleActivation();
        return;
      }
      wakeDelay = Math.min(
        MAX_ZERO_DELAY_WAKE_RETRY_MS,
        ZERO_DELAY_WAKE_RETRY_BASE_MS * 2 ** (retry - 1),
      );
    }

    const timer = setTimeout(() => {
      if (this.leaseWakeTimer !== timer) return;
      this.leaseWakeTimer = undefined;
      if (!this.accepting || this.stopController.signal.aborted || this.signal?.aborted) return;
      if (this.pendingActivationCount >= this.maxPendingActivations) {
        this.leaseWakeRequested = true;
        return;
      }
      this.scheduleActivation();
    }, Math.min(wakeDelay, MAX_TIMER_DELAY_MS));
    timer.unref?.();
    this.leaseWakeTimer = timer;
  }

  private clearLeaseWakeup(): void {
    if (this.leaseWakeTimer === undefined) return;
    clearTimeout(this.leaseWakeTimer);
    this.leaseWakeTimer = undefined;
  }

  private scheduleAcknowledgements(messageIds: readonly string[]): void {
    if (messageIds.length === 0) return;
    const ids = [...new Set(messageIds)];
    const operation = this.receiptTail.then(() => this.acknowledgeCommitted(ids));
    this.receiptTail = operation.catch((error: unknown) => {
      this.failures.push(asError(error));
    });
  }

  private async acknowledgeCommitted(messageIds: readonly string[]): Promise<void> {
    const records = new Map(this.inbox.snapshot().records.map((record) => [
      record.message.messageId,
      record,
    ]));
    for (const messageId of messageIds) {
      const record = records.get(messageId);
      if (record === undefined || !isWorkerTerminalRecord(
        record,
        this.runId,
        this.mainLaneId,
        this.workerLaneId,
      )) {
        this.committedBoundaryMessageIds.delete(messageId);
        continue;
      }
      if (record.status === "handled") {
        this.committedBoundaryMessageIds.delete(messageId);
        continue;
      }
      if (record.status !== "claimed" || record.claim?.claimedBy !== this.mainLaneId) {
        continue;
      }
      try {
        await this.inbox.handle(messageId, this.mainLaneId);
        this.committedBoundaryMessageIds.delete(messageId);
      } catch (error: unknown) {
        // Keep the committed receipt for replay; do not block or reinject Main.
        this.failures.push(asError(error));
      }
    }
  }

  private async drainWithin(milliseconds: number): Promise<readonly Error[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<readonly Error[]>((resolve) => {
      timer = setTimeout(() => resolve([...this.failures]), milliseconds);
    });
    try {
      return await Promise.race([this.drain(), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async runWithin<T>(operation: Promise<T> | void, milliseconds: number): Promise<void> {
    if (operation === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Worker stop hook exceeded its wait bound")), milliseconds);
    });
    try {
      await Promise.race([operation.then(() => undefined), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export function projectCommittedBoundaryMessageIds(
  events: readonly AnyEvent[],
  runId: RunId,
  mainLaneId: LaneId = DEFAULT_MAIN_LANE,
): string[] {
  nonEmpty(runId, "runId");
  nonEmpty(mainLaneId, "mainLaneId");
  const committed = new Set<string>();
  for (const event of events) {
    if (
      event.runId !== runId
      || event.laneId !== mainLaneId
      || event.type !== "step.completed"
    ) {
      continue;
    }
    for (const messageId of event.payload.boundaryMessageIds ?? []) {
      committed.add(messageId);
    }
  }
  return [...committed];
}

function isWorkerTerminalRecord(
  record: InboxRecord,
  runId: RunId,
  mainLaneId: LaneId,
  workerLaneId: LaneId,
): record is TerminalRecord {
  return record.message.runId === runId
    && record.message.from === workerLaneId
    && record.message.to === mainLaneId
    && (
      record.message.payload.type === "task.result"
      || record.message.payload.type === "task.failed"
    );
}

function formatTerminal(record: TerminalRecord): string {
  const payload = record.message.payload;
  if (payload.type === "task.result") {
    const evidence = payload.evidenceRefs.length === 0
      ? "none"
      : payload.evidenceRefs.slice(0, 8).join(", ");
    const questions = payload.openQuestions.length === 0
      ? "none"
      : payload.openQuestions.slice(0, 4).join("; ");
    return [
      `Worker task ${payload.taskId} ${payload.status}.`,
      `Summary: ${bounded(payload.summary, 4_096)}`,
      `Evidence refs: ${bounded(evidence, 2_048)}`,
      `Open questions: ${bounded(questions, 2_048)}`,
    ].join("\n");
  }
  return [
    `Worker task ${payload.taskId} failed.`,
    `Reason: ${bounded(payload.reason, 4_096)}`,
    `Retryable: ${payload.retryable ? "yes" : "no"}`,
    `Evidence refs: ${bounded(payload.evidenceRefs.slice(0, 8).join(", ") || "none", 2_048)}`,
  ].join("\n");
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 15)}[TRUNCATED]`;
}

function nonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
