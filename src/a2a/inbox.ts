import { randomUUID } from "node:crypto";
import type {
  A2AMessage,
  A2APayload,
  AdviceDisposition,
  AnyEvent,
  AppendEvent,
  Clock,
  EventEnvelope,
  EventType,
  ArtifactRef,
  Goal,
  LaneId,
  TaskBudget,
  TokenUsage,
} from "../domain/index.js";
import {
  MAX_TASK_MODEL_TOKENS,
  MAX_TASK_WALL_CLOCK_MS,
  systemClock,
} from "../domain/index.js";
import { sha256, stableJson } from "../ledger/hash.js";

export interface EventSink {
  append<K extends EventType>(event: AppendEvent<K>): Promise<EventEnvelope<K>>;
}

export type InboxMessageStatus = "pending" | "claimed" | "handled";

export interface InboxClaim {
  claimId: string;
  claimedBy: LaneId;
  claimedAt: string;
  attempt: number;
}

export interface AdviceAcknowledgement {
  disposition: AdviceDisposition;
  reason?: string;
  acknowledgedAt: string;
}

export interface InboxRecord {
  message: A2AMessage;
  status: InboxMessageStatus;
  sentAtOffset: number;
  sentAt: string;
  claim?: InboxClaim;
  handledAt?: string;
  acknowledgement?: AdviceAcknowledgement;
}

export interface InboxProjection {
  records: InboxRecord[];
  lastOffset: number;
}

export interface A2AInboxOptions {
  sink?: EventSink;
  events?: readonly AnyEvent[];
  clock?: Clock;
  claimLeaseMs?: number;
}

export interface SendResult {
  status: "queued" | "duplicate" | "expired";
  messageId: string;
}

export interface ClaimOptions {
  claimId?: string;
  limit?: number;
  now?: Date;
  from?: LaneId;
  types?: readonly A2APayload["type"][];
}

export interface AdviceAckResult {
  status: "acknowledged" | "duplicate";
  messageId: string;
}

export class A2AProtocolError extends Error {
  override readonly name: string = "A2AProtocolError";
}

export class MessageExpiredError extends A2AProtocolError {
  override readonly name = "MessageExpiredError";
}

export class InboxProjector {
  private records = new Map<string, InboxRecord>();
  private idempotency = new Map<string, string>();
  private appliedEventIds = new Set<string>();
  private offset = 0;

  constructor(events: readonly AnyEvent[] = []) {
    this.rehydrate(events);
  }

  rehydrate(events: readonly AnyEvent[]): void {
    this.records = new Map();
    this.idempotency = new Map();
    this.appliedEventIds = new Set();
    this.offset = 0;
    for (const event of [...events].sort(compareEvents)) {
      this.apply(event);
    }
  }

  apply(event: AnyEvent): void {
    if (this.appliedEventIds.has(event.eventId)) {
      return;
    }

    switch (event.type) {
      case "message.sent":
        this.applySent(event);
        break;
      case "message.claimed":
        this.applyClaimed(event);
        break;
      case "message.handled":
        this.applyHandled(event);
        break;
      case "advice.acknowledged":
        this.applyAcknowledged(event);
        break;
      default:
        break;
    }
    this.appliedEventIds.add(event.eventId);
    this.offset = Math.max(this.offset, event.globalOffset);
  }

  get(messageId: string): InboxRecord | undefined {
    const record = this.records.get(messageId);
    return record === undefined ? undefined : clone(record);
  }

  findByIdempotency(runId: string, idempotencyKey: string): InboxRecord | undefined {
    const messageId = this.idempotency.get(idempotencyScope(runId, idempotencyKey));
    return messageId === undefined ? undefined : this.get(messageId);
  }

  list(to?: LaneId): InboxRecord[] {
    return [...this.records.values()]
      .filter((record) => to === undefined || record.message.to === to)
      .sort(compareRecords)
      .map(clone);
  }

  snapshot(): InboxProjection {
    return { records: this.list(), lastOffset: this.offset };
  }

  private applySent(event: Extract<AnyEvent, { type: "message.sent" }>): void {
    const message = event.payload.message;
    const existing = this.records.get(message.messageId);
    if (existing !== undefined) {
      if (!sameJson(existing.message, message)) {
        throw new A2AProtocolError(`Conflicting messageId ${message.messageId}`);
      }
      return;
    }

    const scope = idempotencyScope(message.runId, message.idempotencyKey);
    const duplicateId = this.idempotency.get(scope);
    if (duplicateId !== undefined && duplicateId !== message.messageId) {
      const duplicate = this.records.get(duplicateId);
      if (duplicate === undefined || !sameLogicalSend(duplicate.message, message)) {
        throw new A2AProtocolError(
          `Conflicting idempotencyKey ${message.idempotencyKey}`,
        );
      }
      return;
    }

    this.records.set(message.messageId, {
      message: clone(message),
      status: "pending",
      sentAtOffset: event.globalOffset,
      sentAt: event.occurredAt,
    });
    this.idempotency.set(scope, message.messageId);
  }

  private applyClaimed(event: Extract<AnyEvent, { type: "message.claimed" }>): void {
    const record = this.records.get(event.payload.messageId);
    if (record === undefined) {
      throw new A2AProtocolError(
        `Claim references unknown message ${event.payload.messageId}`,
      );
    }
    if (record.status === "handled") {
      return;
    }
    record.status = "claimed";
    record.claim = {
      claimId: claimIdFromEvent(event),
      claimedBy: event.payload.claimedBy,
      claimedAt: event.occurredAt,
      attempt: (record.claim?.attempt ?? 0) + 1,
    };
  }

  private applyHandled(event: Extract<AnyEvent, { type: "message.handled" }>): void {
    const record = this.records.get(event.payload.messageId);
    if (record === undefined) {
      throw new A2AProtocolError(
        `Handle references unknown message ${event.payload.messageId}`,
      );
    }
    record.status = "handled";
    record.handledAt = event.occurredAt;
  }

  private applyAcknowledged(
    event: Extract<AnyEvent, { type: "advice.acknowledged" }>,
  ): void {
    const record = [...this.records.values()].find((candidate) => (
      candidate.message.runId === event.runId
      && candidate.message.payload.type === "advice.propose"
      && candidate.message.payload.advice.adviceId === event.payload.adviceId
    ));
    if (record === undefined) {
      throw new A2AProtocolError(
        `Acknowledgement references unknown Advice ${event.payload.adviceId}`,
      );
    }
    record.acknowledgement = {
      disposition: event.payload.disposition,
      ...(event.payload.reason === undefined ? {} : { reason: event.payload.reason }),
      acknowledgedAt: event.occurredAt,
    };
  }
}

export function projectInbox(events: readonly AnyEvent[]): InboxProjection {
  return new InboxProjector(events).snapshot();
}

export class A2AInbox {
  private readonly projector: InboxProjector;
  private readonly sink: EventSink;
  private readonly clock: Clock;
  private readonly claimLeaseMs: number;
  private commandTail: Promise<void> = Promise.resolve();

  constructor(options: A2AInboxOptions = {}) {
    const events = options.events ?? [];
    this.projector = new InboxProjector(events);
    this.clock = options.clock ?? systemClock;
    this.claimLeaseMs = options.claimLeaseMs ?? 30_000;
    if (!Number.isSafeInteger(this.claimLeaseMs) || this.claimLeaseMs <= 0) {
      throw new RangeError("claimLeaseMs must be a positive integer");
    }
    this.sink = options.sink ?? new EphemeralEventSink(events, this.clock);
  }

  static rehydrate(
    events: readonly AnyEvent[],
    options: Omit<A2AInboxOptions, "events"> = {},
  ): A2AInbox {
    return new A2AInbox({ ...options, events });
  }

  rehydrate(events: readonly AnyEvent[]): void {
    this.projector.rehydrate(events);
  }

  snapshot(): InboxProjection {
    return this.projector.snapshot();
  }

  send(message: A2AMessage): Promise<SendResult> {
    const input = clone(message);
    return this.runExclusive(() => this.sendCommand(input));
  }

  private async sendCommand(message: A2AMessage): Promise<SendResult> {
    validateMessage(message);
    const now = this.clock.now();
    const existing = this.projector.findByIdempotency(
      message.runId,
      message.idempotencyKey,
    );
    if (existing !== undefined) {
      if (!sameLogicalSend(existing.message, message)) {
        throw new A2AProtocolError(
          `Conflicting idempotencyKey ${message.idempotencyKey}`,
        );
      }
      return { status: "duplicate", messageId: existing.message.messageId };
    }
    if (isExpired(message, now)) {
      return { status: "expired", messageId: message.messageId };
    }

    if (message.payload.type === "advice.propose") {
      const advice = message.payload.advice;
      const duplicate = this.projector.list(message.to).find((record) => (
        record.message.runId === message.runId
        && record.message.payload.type === "advice.propose"
        && record.message.payload.advice.sourceLane
          === advice.sourceLane
        && record.message.payload.advice.dedupeKey
          === advice.dedupeKey
        && !isExpired(record.message, now)
      ));
      if (duplicate !== undefined) {
        return { status: "duplicate", messageId: duplicate.message.messageId };
      }
    }

    const event = await this.append({
      runId: message.runId,
      laneId: message.from,
      type: "message.sent",
      payload: { message: clone(message) },
      ...(message.causationId === undefined ? {} : { causationId: message.causationId }),
      correlationId: message.correlationId,
      idempotencyKey: `a2a:send:${message.idempotencyKey}`,
      visibility: message.visibility,
      occurredAt: message.createdAt,
    });
    const sentMessage = event.payload.message;
    return {
      status: sentMessage.messageId === message.messageId ? "queued" : "duplicate",
      messageId: sentMessage.messageId,
    };
  }

  claim(
    to: LaneId,
    claimedBy: LaneId,
    options: ClaimOptions = {},
  ): Promise<InboxRecord[]> {
    return this.runExclusive(() => this.claimCommand(to, claimedBy, options));
  }

  private async claimCommand(
    to: LaneId,
    claimedBy: LaneId,
    options: ClaimOptions,
  ): Promise<InboxRecord[]> {
    nonEmpty(to, "to");
    nonEmpty(claimedBy, "claimedBy");
    const now = options.now ?? this.clock.now();
    const limit = options.limit ?? 1;
    const claimId = options.claimId ?? randomUUID();
    nonEmpty(claimId, "claimId");
    if (options.from !== undefined) nonEmpty(options.from, "from");
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError("claim limit must be a positive integer");
    }

    const repeated = this.projector.list().filter(
      (record) => record.claim?.claimId === claimId,
    );
    if (repeated.length > 0) {
      if (repeated.some((record) => (
        record.message.to !== to
        || record.claim?.claimedBy !== claimedBy
        || (options.from !== undefined && record.message.from !== options.from)
        || (options.types !== undefined
          && !options.types.includes(record.message.payload.type))
      ))) {
        throw new A2AProtocolError(`claimId ${claimId} was reused by another receiver`);
      }
      return repeated;
    }

    const eligible = this.projector.list(to)
      .filter((record) => this.isClaimable(record, now))
      .filter((record) => options.from === undefined || record.message.from === options.from)
      .filter((record) => (
        options.types === undefined
        || options.types.includes(record.message.payload.type)
      ))
      .slice(0, limit);
    const claimed: InboxRecord[] = [];
    for (const record of eligible) {
      const attempt = (record.claim?.attempt ?? 0) + 1;
      await this.append({
        runId: record.message.runId,
        laneId: claimedBy,
        type: "message.claimed",
        payload: { messageId: record.message.messageId, claimedBy },
        causationId: record.message.messageId,
        correlationId: record.message.correlationId,
        idempotencyKey: `a2a:claim:${claimId}:${record.message.messageId}:${attempt}`,
        visibility: record.message.visibility,
        occurredAt: now.toISOString(),
      });
      const projected = this.projector.get(record.message.messageId);
      if (projected !== undefined) {
        claimed.push(projected);
      }
    }
    return claimed;
  }

  handle(messageId: string, claimedBy: LaneId): Promise<InboxRecord> {
    return this.runExclusive(() => this.handleCommand(messageId, claimedBy));
  }

  private async handleCommand(
    messageId: string,
    claimedBy: LaneId,
  ): Promise<InboxRecord> {
    const record = this.requireRecord(messageId);
    if (record.status === "handled") {
      return record;
    }
    if (record.status !== "claimed" || record.claim?.claimedBy !== claimedBy) {
      throw new A2AProtocolError(
        `Message ${messageId} is not claimed by ${claimedBy}`,
      );
    }

    await this.append({
      runId: record.message.runId,
      laneId: claimedBy,
      type: "message.handled",
      payload: { messageId },
      causationId: messageId,
      correlationId: record.message.correlationId,
      idempotencyKey: `a2a:handle:${messageId}`,
      visibility: record.message.visibility,
    });
    return this.requireRecord(messageId);
  }

  acknowledgeAdvice(
    adviceId: string,
    disposition: AdviceDisposition,
    claimedBy: LaneId,
    reason?: string,
  ): Promise<AdviceAckResult> {
    return this.runExclusive(() => this.acknowledgeAdviceCommand(
      adviceId,
      disposition,
      claimedBy,
      reason,
    ));
  }

  private async acknowledgeAdviceCommand(
    adviceId: string,
    disposition: AdviceDisposition,
    claimedBy: LaneId,
    reason?: string,
  ): Promise<AdviceAckResult> {
    const record = this.projector.list().find((candidate) => (
      candidate.message.payload.type === "advice.propose"
      && candidate.message.payload.advice.adviceId === adviceId
    ));
    if (record === undefined) {
      throw new A2AProtocolError(`Unknown Advice ${adviceId}`);
    }
    if (isExpired(record.message, this.clock.now())) {
      throw new MessageExpiredError(`Advice ${adviceId} has expired`);
    }
    if (record.acknowledgement !== undefined) {
      if (
        record.acknowledgement.disposition !== disposition
        || record.acknowledgement.reason !== reason
      ) {
        throw new A2AProtocolError(`Advice ${adviceId} already has a different ack`);
      }
      if (record.status !== "handled") {
        await this.handleCommand(record.message.messageId, claimedBy);
      }
      return { status: "duplicate", messageId: record.message.messageId };
    }
    if (record.status !== "claimed" || record.claim?.claimedBy !== claimedBy) {
      throw new A2AProtocolError(
        `Advice ${adviceId} is not claimed by ${claimedBy}`,
      );
    }

    await this.append({
      runId: record.message.runId,
      laneId: claimedBy,
      type: "advice.acknowledged",
      payload: {
        adviceId,
        disposition,
        ...(reason === undefined ? {} : { reason }),
      },
      causationId: record.message.messageId,
      correlationId: record.message.correlationId,
      idempotencyKey: `a2a:ack:${adviceId}`,
      visibility: record.message.visibility,
    });
    await this.handleCommand(record.message.messageId, claimedBy);
    return { status: "acknowledged", messageId: record.message.messageId };
  }

  private isClaimable(record: InboxRecord, now: Date): boolean {
    if (record.status === "handled" || isExpired(record.message, now)) {
      return false;
    }
    if (record.status === "pending" || record.claim === undefined) {
      return true;
    }
    return Date.parse(record.claim.claimedAt) + this.claimLeaseMs <= now.getTime();
  }

  private requireRecord(messageId: string): InboxRecord {
    const record = this.projector.get(messageId);
    if (record === undefined) {
      throw new A2AProtocolError(`Unknown message ${messageId}`);
    }
    return record;
  }

  private async append<K extends EventType>(
    event: AppendEvent<K>,
  ): Promise<EventEnvelope<K>> {
    const stored = await this.sink.append(event);
    this.projector.apply(stored as AnyEvent);
    return stored;
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.commandTail.then(operation);
    this.commandTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

class EphemeralEventSink implements EventSink {
  private offset: number;
  private readonly laneSequences = new Map<string, number>();
  private readonly eventsByIdempotency = new Map<string, AnyEvent>();

  constructor(events: readonly AnyEvent[], private readonly clock: Clock) {
    this.offset = events.reduce(
      (maximum, event) => Math.max(maximum, event.globalOffset),
      0,
    );
    for (const event of events) {
      const laneScope = `${event.runId}\u0000${event.laneId}`;
      this.laneSequences.set(
        laneScope,
        Math.max(this.laneSequences.get(laneScope) ?? 0, event.laneSeq),
      );
      this.eventsByIdempotency.set(
        idempotencyScope(event.runId, event.idempotencyKey),
        event,
      );
    }
  }

  async append<K extends EventType>(input: AppendEvent<K>): Promise<EventEnvelope<K>> {
    const idempotency = idempotencyScope(input.runId, input.idempotencyKey);
    const existing = this.eventsByIdempotency.get(idempotency);
    if (existing !== undefined) {
      return clone(existing) as EventEnvelope<K>;
    }
    const laneScope = `${input.runId}\u0000${input.laneId}`;
    const content = {
      eventId: randomUUID(),
      runId: input.runId,
      laneId: input.laneId,
      globalOffset: ++this.offset,
      laneSeq: (this.laneSequences.get(laneScope) ?? 0) + 1,
      type: input.type,
      schemaVersion: 1 as const,
      occurredAt: input.occurredAt ?? this.clock.now().toISOString(),
      ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
      correlationId: input.correlationId,
      idempotencyKey: input.idempotencyKey,
      visibility: input.visibility ?? "run",
      payload: clone(input.payload),
    };
    const event = {
      ...content,
      contentHash: sha256(stableJson(content)),
    } as EventEnvelope<K>;
    this.laneSequences.set(laneScope, event.laneSeq);
    this.eventsByIdempotency.set(idempotency, event as AnyEvent);
    return clone(event);
  }
}

function validateMessage(message: A2AMessage): void {
  for (const [field, value] of [
    ["messageId", message.messageId],
    ["runId", message.runId],
    ["conversationId", message.conversationId],
    ["threadId", message.threadId],
    ["from", message.from],
    ["to", message.to],
    ["correlationId", message.correlationId],
    ["idempotencyKey", message.idempotencyKey],
  ] as const) {
    nonEmpty(value, field);
  }
  validDate(message.createdAt, "createdAt");
  if (message.expiresAt !== undefined) {
    validDate(message.expiresAt, "expiresAt");
    if (Date.parse(message.expiresAt) <= Date.parse(message.createdAt)) {
      throw new A2AProtocolError("expiresAt must be later than createdAt");
    }
  }
  if (!Number.isSafeInteger(message.priority)) {
    throw new A2AProtocolError("priority must be a safe integer");
  }
  if (!(["lane", "run", "user", "sensitive"] as const).includes(message.visibility)) {
    throw new A2AProtocolError("visibility is invalid");
  }
  if (!(["next-step", "next-turn", "deferred", "urgent"] as const).includes(
    message.delivery,
  )) {
    throw new A2AProtocolError("delivery is invalid");
  }
  if (message.payload.type === "advice.propose") {
    const advice = message.payload.advice;
    validDate(advice.expiresAt, "advice.expiresAt");
    nonEmpty(advice.adviceId, "adviceId");
    nonEmpty(advice.dedupeKey, "advice.dedupeKey");
    nonEmpty(advice.claim, "advice.claim");
    nonEmpty(advice.suggestedAction, "advice.suggestedAction");
    if (!Number.isFinite(advice.confidence) || advice.confidence < 0 || advice.confidence > 1) {
      throw new A2AProtocolError("Advice confidence must be between 0 and 1");
    }
    if (advice.evidenceRefs.some((ref) => ref.trim().length === 0)) {
      throw new A2AProtocolError("Advice evidenceRefs must not contain empty refs");
    }
    if (!(["orientation", "intent-gap", "method-alternative"] as const).includes(
      advice.kind,
    )) {
      throw new A2AProtocolError("Advice kind is invalid");
    }
    if (!(["low", "medium", "high"] as const).includes(advice.risk)) {
      throw new A2AProtocolError("Advice risk is invalid");
    }
    if (!(["next-step", "next-turn", "deferred"] as const).includes(advice.urgency)) {
      throw new A2AProtocolError("Advice urgency is invalid");
    }
    if (advice.sourceLane !== message.from) {
      throw new A2AProtocolError("Advice sourceLane must match message.from");
    }
  } else if (message.payload.type === "question.ask") {
    nonEmpty(message.payload.question, "question");
  } else if (message.payload.type === "question.answer") {
    nonEmpty(message.payload.answer, "answer");
  } else if (message.payload.type === "message.inform") {
    nonEmpty(message.payload.text, "text");
  } else if (message.payload.type === "task.request") {
    validateTaskId(message.payload.taskId);
    validateGoal(message.payload.goal);
    validateArtifactRefs(message.payload.inputRefs, "inputRefs");
    validateTaskBudget(message.payload.budget);
  } else if (message.payload.type === "task.accept") {
    validateTaskId(message.payload.taskId);
  } else if (message.payload.type === "task.result") {
    validateTaskId(message.payload.taskId);
    if (message.payload.status !== "completed" && message.payload.status !== "partial") {
      throw new A2AProtocolError("task result status is invalid");
    }
    nonEmpty(message.payload.summary, "summary");
    validateStringArray(message.payload.evidenceRefs, "evidenceRefs");
    validateArtifactRefs(message.payload.artifactRefs, "artifactRefs");
    validateStringArray(message.payload.openQuestions, "openQuestions");
    validateUsage(message.payload.usage);
  } else if (message.payload.type === "task.failed") {
    validateTaskId(message.payload.taskId);
    nonEmpty(message.payload.reason, "reason");
    if (typeof message.payload.retryable !== "boolean") {
      throw new A2AProtocolError("task failed retryable must be boolean");
    }
    validateStringArray(message.payload.evidenceRefs, "evidenceRefs");
  } else {
    throw new A2AProtocolError("payload type is invalid");
  }
}

function validateTaskId(value: string): void {
  nonEmpty(value, "taskId");
  if (value.length > 128) throw new A2AProtocolError("taskId exceeds 128 characters");
}

function validateGoal(goal: Goal): void {
  if (!isRecord(goal)) throw new A2AProtocolError("task goal must be an object");
  if (!Number.isSafeInteger(goal.version) || goal.version < 1) {
    throw new A2AProtocolError("task goal version must be a positive integer");
  }
  nonEmpty(goal.statement, "goal.statement");
  validateStringArray(goal.successCriteria, "goal.successCriteria");
  validateStringArray(goal.hardConstraints, "goal.hardConstraints");
}

function validateTaskBudget(budget: TaskBudget): void {
  if (!isRecord(budget)) throw new A2AProtocolError("task budget must be an object");
  if (
    !Number.isSafeInteger(budget.maxModelTokens)
    || budget.maxModelTokens < 1
    || budget.maxModelTokens > MAX_TASK_MODEL_TOKENS
  ) {
    throw new A2AProtocolError(
      `task budget maxModelTokens must be between 1 and ${MAX_TASK_MODEL_TOKENS}`,
    );
  }
  if (
    !Number.isSafeInteger(budget.maxWallClockMs)
    || budget.maxWallClockMs < 1
    || budget.maxWallClockMs > MAX_TASK_WALL_CLOCK_MS
  ) {
    throw new A2AProtocolError(
      `task budget maxWallClockMs must be between 1 and ${MAX_TASK_WALL_CLOCK_MS}`,
    );
  }
}

function validateArtifactRefs(
  refs: ArtifactRef[],
  field: string,
): void {
  if (!Array.isArray(refs)) throw new A2AProtocolError(`${field} must be an array`);
  for (const ref of refs) {
    if (ref === null || typeof ref !== "object") throw new A2AProtocolError(`${field} contains an invalid artifact ref`);
    nonEmpty(ref.id, `${field}.id`);
    nonEmpty(ref.contentHash, `${field}.contentHash`);
    nonEmpty(ref.mediaType, `${field}.mediaType`);
    if (!Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0) {
      throw new A2AProtocolError(`${field}.byteLength must be a non-negative integer`);
    }
  }
}

function validateStringArray(values: string[], field: string): void {
  if (!Array.isArray(values)) throw new A2AProtocolError(`${field} must be an array`);
  for (const value of values) {
    if (typeof value !== "string") throw new A2AProtocolError(`${field} must contain strings`);
  }
}

function validateUsage(usage: TokenUsage): void {
  if (!isRecord(usage)) throw new A2AProtocolError("task result usage must be an object");
  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const value = usage[field];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new A2AProtocolError(`task result usage ${field} must be a non-negative integer`);
    }
  }
  if (usage.costUsd !== undefined && (!Number.isFinite(usage.costUsd) || usage.costUsd < 0)) {
    throw new A2AProtocolError("task result usage costUsd must be non-negative");
  }
}

function isExpired(message: A2AMessage, now: Date): boolean {
  const expiries = [
    message.expiresAt,
    message.payload.type === "advice.propose"
      ? message.payload.advice.expiresAt
      : undefined,
  ].filter((value): value is string => value !== undefined);
  return expiries.some((expiry) => Date.parse(expiry) <= now.getTime());
}

function compareEvents(left: AnyEvent, right: AnyEvent): number {
  return left.globalOffset - right.globalOffset;
}

function compareRecords(left: InboxRecord, right: InboxRecord): number {
  return right.message.priority - left.message.priority
    || left.sentAtOffset - right.sentAtOffset;
}

function sameLogicalSend(left: A2AMessage, right: A2AMessage): boolean {
  return sameJson(
    { ...left, messageId: undefined },
    { ...right, messageId: undefined },
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function idempotencyScope(runId: string, key: string): string {
  return `${runId}\u0000${key}`;
}

function claimIdFromEvent(
  event: Extract<AnyEvent, { type: "message.claimed" }>,
): string {
  const prefix = "a2a:claim:";
  if (!event.idempotencyKey.startsWith(prefix)) {
    return event.eventId;
  }
  const suffix = event.idempotencyKey.slice(prefix.length);
  const messageMarker = `:${event.payload.messageId}:`;
  const markerIndex = suffix.lastIndexOf(messageMarker);
  return markerIndex < 0 ? event.eventId : suffix.slice(0, markerIndex);
}

function nonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new A2AProtocolError(`${field} must not be empty`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDate(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new A2AProtocolError(`${field} must be an ISO date string`);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
