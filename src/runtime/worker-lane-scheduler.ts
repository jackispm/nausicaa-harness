import { randomUUID } from "node:crypto";

import type { A2AInbox, InboxRecord } from "../a2a/index.js";
import type { LaneId, RunId } from "../domain/index.js";
import type { MainAfterStepContext, MainBoundaryMessage } from "./main-loop.js";
import type { WorkerTaskExecutor } from "./worker-task-executor.js";

const DEFAULT_MAIN_LANE = "main";
const DEFAULT_WORKER_LANE = "worker";
const DEFAULT_BOUNDARY_LIMIT = 4;
const MAX_BOUNDARY_LIMIT = 32;
const DEFAULT_STOP_WAIT_MS = 250;
const MAX_STOP_WAIT_MS = 10_000;

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
  private readonly createId: () => string;
  private readonly signal: AbortSignal | undefined;
  private readonly stopWaitMs: number;
  private readonly stopController = new AbortController();
  private readonly delivered = new Map<string, InboxRecord>();
  private readonly failures: Error[] = [];
  private tail: Promise<void> = Promise.resolve();
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
  }

  /** Pass this signal to an executor that supports cancellation. */
  get abortSignal(): AbortSignal {
    return this.stopController.signal;
  }

  /** Called from Main's synchronous afterStep hook. */
  enqueue(context?: MainAfterStepContext): void {
    if (!this.accepting) return;
    const boundary = context === undefined
      ? undefined
      : {
          runId: context.runId,
          laneId: context.laneId,
          boundaryMessageIds: [...context.boundaryMessageIds],
        };
    const operation = this.tail.then(async () => {
      if (boundary !== undefined) {
        if (boundary.runId !== this.runId || boundary.laneId !== this.mainLaneId) {
          throw new Error(
            `Worker lane scheduler for ${this.runId}/${this.mainLaneId} received ${boundary.runId}/${boundary.laneId}`,
          );
        }
        await this.acknowledgeDelivered(boundary.boundaryMessageIds);
      }
      if (this.stopController.signal.aborted || this.signal?.aborted) return;
      await this.executor.runOnce();
    });
    this.tail = operation.catch((error: unknown) => {
      this.failures.push(asError(error));
    });
  }

  /** Claim completed Worker replies for the next Main natural boundary. */
  async beforeMainStep(): Promise<readonly MainBoundaryMessage[]> {
    if (!this.accepting || this.stopController.signal.aborted || this.signal?.aborted) {
      return [];
    }
    try {
      const records = await this.inbox.claim(this.mainLaneId, this.mainLaneId, {
        claimId: `${this.runId}:worker:delivery:${this.createId()}`,
        limit: this.maxResultsPerBoundary,
        from: this.workerLaneId,
        types: ["task.accept", "task.result", "task.failed"],
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
        this.delivered.set(record.message.messageId, record);
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
      const observed = this.tail;
      await observed;
      if (observed === this.tail) break;
    }
    return [...this.failures];
  }

  async stop(): Promise<readonly Error[]> {
    this.accepting = false;
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

  private async acknowledgeDelivered(messageIds: readonly string[]): Promise<void> {
    for (const messageId of messageIds) {
      if (!this.delivered.has(messageId)) continue;
      try {
        await this.inbox.handle(messageId, this.mainLaneId);
        this.delivered.delete(messageId);
      } catch (error: unknown) {
        // Keep the record for a later lease-based retry; do not block Main.
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
