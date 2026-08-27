import { randomUUID } from "node:crypto";

import type { A2AInbox, SendResult } from "../a2a/index.js";
import type {
  ArtifactRef,
  Clock,
  DeliveryMode,
  Goal,
  LaneId,
  RunId,
  TaskBudget,
  Visibility,
} from "../domain/index.js";
import {
  MAX_TASK_MODEL_TOKENS,
  MAX_TASK_WALL_CLOCK_MS,
  systemClock,
} from "../domain/index.js";

const DEFAULT_FROM: LaneId = "main";
const DEFAULT_TO: LaneId = "worker";
const DEFAULT_PRIORITY = 1;
const DEFAULT_DELIVERY: DeliveryMode = "next-step";
const DEFAULT_VISIBILITY: Visibility = "run";

export interface TaskDispatcherOptions {
  inbox: A2AInbox;
  runId: RunId;
  from?: LaneId;
  to?: LaneId;
  conversationId?: string;
  threadId?: string;
  correlationId?: string;
  priority?: number;
  delivery?: DeliveryMode;
  visibility?: Visibility;
  clock?: Clock;
  createId?: () => string;
}

export interface TaskDispatchRequest {
  taskId?: string;
  goal: Goal;
  inputRefs?: readonly ArtifactRef[];
  budget: TaskBudget;
  from?: LaneId;
  to?: LaneId;
  conversationId?: string;
  threadId?: string;
  correlationId?: string;
  priority?: number;
  delivery?: DeliveryMode;
  visibility?: Visibility;
}

export interface TaskDispatchResult extends SendResult {
  taskId: string;
}

/** Builds one bounded, replayable task handoff without owning execution state. */
export class TaskDispatcher {
  private readonly inbox: A2AInbox;
  private readonly runId: RunId;
  private readonly defaults: Omit<Required<TaskDispatcherOptions>, "inbox" | "clock" | "createId">;
  private readonly clock: Clock;
  private readonly createId: () => string;

  constructor(options: TaskDispatcherOptions) {
    nonEmpty(options.runId, "runId");
    this.inbox = options.inbox;
    this.runId = options.runId;
    const from = options.from ?? DEFAULT_FROM;
    nonEmpty(from, "from");
    const to = options.to ?? DEFAULT_TO;
    nonEmpty(to, "to");
    const conversationId = options.conversationId ?? options.runId;
    const threadId = options.threadId ?? `${options.runId}:${from}`;
    const correlationId = options.correlationId ?? options.runId;
    nonEmpty(conversationId, "conversationId");
    nonEmpty(threadId, "threadId");
    nonEmpty(correlationId, "correlationId");
    const priority = options.priority ?? DEFAULT_PRIORITY;
    validatePriority(priority);
    const delivery = options.delivery ?? DEFAULT_DELIVERY;
    validateDelivery(delivery);
    const visibility = options.visibility ?? DEFAULT_VISIBILITY;
    validateVisibility(visibility);
    this.defaults = {
      runId: options.runId,
      from,
      to,
      conversationId,
      threadId,
      correlationId,
      priority,
      delivery,
      visibility,
    };
    this.clock = options.clock ?? systemClock;
    this.createId = options.createId ?? randomUUID;
  }

  async dispatch(request: TaskDispatchRequest): Promise<TaskDispatchResult> {
    validateGoal(request.goal);
    validateTaskBudget(request.budget);
    const taskId = request.taskId ?? this.createId();
    validateTaskId(taskId);

    const from = request.from ?? this.defaults.from;
    const to = request.to ?? this.defaults.to;
    const conversationId = request.conversationId ?? this.defaults.conversationId;
    const threadId = request.threadId ?? `${this.runId}:${from}`;
    const correlationId = request.correlationId ?? this.defaults.correlationId;
    const priority = request.priority ?? this.defaults.priority;
    const delivery = request.delivery ?? this.defaults.delivery;
    const visibility = request.visibility ?? this.defaults.visibility;
    for (const [name, value] of [
      ["from", from],
      ["to", to],
      ["conversationId", conversationId],
      ["threadId", threadId],
      ["correlationId", correlationId],
    ] as const) {
      nonEmpty(value, name);
    }
    validatePriority(priority);
    validateDelivery(delivery);
    validateVisibility(visibility);

    const messageId = `${this.runId}:task:${taskId}:request`;
    const idempotencyKey = messageId;
    const existing = this.inbox.snapshot().records.find((record) => (
      record.message.runId === this.runId
      && record.message.messageId === messageId
    ));
    const createdAt = existing?.message.createdAt ?? this.clock.now().toISOString();
    const result = await this.inbox.send({
      messageId,
      runId: this.runId,
      conversationId,
      threadId,
      from,
      to,
      createdAt,
      correlationId,
      idempotencyKey,
      visibility,
      priority,
      delivery,
      payload: {
        type: "task.request",
        taskId,
        goal: structuredClone(request.goal),
        inputRefs: [...structuredClone(request.inputRefs ?? [])],
        budget: structuredClone(request.budget),
      },
    });
    return { ...result, taskId };
  }
}

function nonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new TypeError(`${field} must be a non-empty string without NUL`);
  }
}

function validateTaskId(value: string): void {
  nonEmpty(value, "taskId");
  if (value.length > 128) throw new RangeError("taskId exceeds 128 characters");
}

function validateGoal(goal: Goal): void {
  if (goal === null || typeof goal !== "object" || Array.isArray(goal)) {
    throw new TypeError("goal must be an object");
  }
  if (!Number.isSafeInteger(goal.version) || goal.version < 1) {
    throw new RangeError("goal.version must be a positive integer");
  }
  nonEmpty(goal.statement, "goal.statement");
  validateStringArray(goal.successCriteria, "goal.successCriteria");
  validateStringArray(goal.hardConstraints, "goal.hardConstraints");
}

function validateStringArray(values: readonly string[], field: string): void {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new TypeError(`${field} must be an array of strings`);
  }
}

function validateTaskBudget(budget: TaskBudget): void {
  if (budget === null || typeof budget !== "object" || Array.isArray(budget)) {
    throw new TypeError("budget must be an object");
  }
  if (
    !Number.isSafeInteger(budget.maxModelTokens)
    || budget.maxModelTokens < 1
    || budget.maxModelTokens > MAX_TASK_MODEL_TOKENS
  ) {
    throw new RangeError(
      `budget.maxModelTokens must be between 1 and ${MAX_TASK_MODEL_TOKENS}`,
    );
  }
  if (
    !Number.isSafeInteger(budget.maxWallClockMs)
    || budget.maxWallClockMs < 1
    || budget.maxWallClockMs > MAX_TASK_WALL_CLOCK_MS
  ) {
    throw new RangeError(
      `budget.maxWallClockMs must be between 1 and ${MAX_TASK_WALL_CLOCK_MS}`,
    );
  }
}

function validatePriority(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("priority must be a non-negative safe integer");
  }
}

function validateDelivery(value: DeliveryMode): void {
  if (!["next-step", "next-turn", "deferred", "urgent"].includes(value)) {
    throw new TypeError("delivery is invalid");
  }
}

function validateVisibility(value: Visibility): void {
  if (!["lane", "run", "user", "sensitive"].includes(value)) {
    throw new TypeError("visibility is invalid");
  }
}
