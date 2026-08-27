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
  DEFAULT_TASK_MAX_ATTEMPTS,
  MAX_TASK_ATTEMPTS,
  MAX_TASK_MODEL_TOKENS,
  MAX_TASK_WALL_CLOCK_MS,
  systemClock,
} from "../domain/index.js";

const DEFAULT_FROM: LaneId = "main";
const DEFAULT_TO: LaneId = "worker";
const DEFAULT_PRIORITY = 1;
const DEFAULT_DELIVERY: DeliveryMode = "next-step";
const DEFAULT_VISIBILITY: Visibility = "run";
const DEFAULT_MAX_OUTSTANDING_TASKS = 8;
const MAX_OUTSTANDING_TASKS = 64;
// One Inbox is the single-process admission boundary. A multi-process runtime
// must move this check into its transactional Inbox repository.
const admissionTails = new WeakMap<A2AInbox, Promise<void>>();

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
  /** Maximum unhandled task requests admitted to one destination lane. */
  maxOutstandingTasks?: number;
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

export class TaskBackpressureError extends Error {
  override readonly name = "TaskBackpressureError";
}

/** Builds one bounded, replayable task handoff without owning execution state. */
export class TaskDispatcher {
  private readonly inbox: A2AInbox;
  private readonly runId: RunId;
  private readonly defaults: Omit<
    Required<TaskDispatcherOptions>,
    "inbox" | "clock" | "createId" | "maxOutstandingTasks"
  >;
  private readonly clock: Clock;
  private readonly createId: () => string;
  private readonly maxOutstandingTasks: number;

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
    const maxOutstandingTasks = options.maxOutstandingTasks ?? DEFAULT_MAX_OUTSTANDING_TASKS;
    if (
      !Number.isSafeInteger(maxOutstandingTasks)
      || maxOutstandingTasks < 1
      || maxOutstandingTasks > MAX_OUTSTANDING_TASKS
    ) {
      throw new RangeError(
        `maxOutstandingTasks must be an integer between 1 and ${MAX_OUTSTANDING_TASKS}`,
      );
    }
    this.maxOutstandingTasks = maxOutstandingTasks;
    this.clock = options.clock ?? systemClock;
    this.createId = options.createId ?? randomUUID;
  }

  async dispatch(request: TaskDispatchRequest): Promise<TaskDispatchResult> {
    const input = structuredClone(request);
    return runInboxAdmission(this.inbox, () => this.dispatchCommand(input));
  }

  private async dispatchCommand(request: TaskDispatchRequest): Promise<TaskDispatchResult> {
    validateGoal(request.goal);
    validateTaskBudget(request.budget);
    const taskId = request.taskId ?? this.createId();
    validateTaskId(taskId);

    const from = request.from ?? this.defaults.from;
    const to = request.to ?? this.defaults.to;
    const conversationId = request.conversationId ?? this.defaults.conversationId;
    const threadId = request.threadId ?? this.defaults.threadId;
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
    const now = this.clock.now();
    if (existing === undefined) {
      const outstanding = this.inbox.snapshot().records.filter((record) => (
        record.message.runId === this.runId
        && record.message.to === to
        && record.message.payload.type === "task.request"
        && record.status !== "handled"
        && (
          record.message.expiresAt === undefined
          || Date.parse(record.message.expiresAt) > now.getTime()
        )
      )).length;
      if (outstanding >= this.maxOutstandingTasks) {
        throw new TaskBackpressureError(
          `Worker lane ${to} is at task capacity (${outstanding}/${this.maxOutstandingTasks})`,
        );
      }
    }
    const createdAt = existing?.message.createdAt ?? now.toISOString();
    const existingBudget = existing?.message.payload.type === "task.request"
      ? existing.message.payload.budget
      : undefined;
    const budget = canonicalTaskBudget(
      request.budget,
      createdAt,
      existing === undefined ? undefined : existingBudget,
    );
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
        budget,
      },
    });
    return { ...result, taskId };
  }
}

function runInboxAdmission<T>(inbox: A2AInbox, operation: () => Promise<T>): Promise<T> {
  const tail = admissionTails.get(inbox) ?? Promise.resolve();
  const result = tail.then(operation);
  admissionTails.set(inbox, result.then(() => undefined, () => undefined));
  return result;
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
  if (budget.deadline !== undefined && !isValidDate(budget.deadline)) {
    throw new TypeError("budget.deadline must be a valid date-time");
  }
  if (budget.maxAttempts !== undefined && (
    !Number.isSafeInteger(budget.maxAttempts)
    || budget.maxAttempts < 1
    || budget.maxAttempts > MAX_TASK_ATTEMPTS
  )) {
    throw new RangeError(
      `budget.maxAttempts must be between 1 and ${MAX_TASK_ATTEMPTS}`,
    );
  }
}

function canonicalTaskBudget(
  requested: TaskBudget,
  createdAt: string,
  existing: TaskBudget | undefined,
): TaskBudget {
  const expectedDeadline = new Date(
    Date.parse(createdAt) + requested.maxWallClockMs,
  ).toISOString();
  if (existing === undefined) {
    if (
      requested.deadline !== undefined
      && Date.parse(requested.deadline) !== Date.parse(expectedDeadline)
    ) {
      throw new RangeError(
        "budget.deadline must equal createdAt plus budget.maxWallClockMs",
      );
    }
    return {
      maxModelTokens: requested.maxModelTokens,
      maxWallClockMs: requested.maxWallClockMs,
      deadline: expectedDeadline,
      maxAttempts: requested.maxAttempts ?? DEFAULT_TASK_MAX_ATTEMPTS,
    };
  }

  const deadline = requested.deadline === undefined
    ? existing.deadline
    : existing.deadline !== undefined
      && Date.parse(requested.deadline) === Date.parse(existing.deadline)
      ? existing.deadline
      : requested.deadline;
  const maxAttempts = requested.maxAttempts ?? existing.maxAttempts;
  return {
    maxModelTokens: requested.maxModelTokens,
    maxWallClockMs: requested.maxWallClockMs,
    ...(deadline === undefined ? {} : { deadline }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
  };
}

function isValidDate(value: string): boolean {
  return value.length > 0 && Number.isFinite(Date.parse(value));
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
