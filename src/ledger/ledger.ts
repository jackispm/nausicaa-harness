import { randomUUID } from "node:crypto";

import type {
  AnyEvent,
  AppendEvent,
  EventEnvelope,
  EventType,
  InputDelivery,
} from "../domain/events.js";
import type { Clock } from "../domain/ports.js";
import { systemClock } from "../domain/ports.js";
import type { ArtifactRef, EventId, RunId, TurnId } from "../domain/types.js";
import {
  normalizeEnvelope,
  normalizeReceipt,
  sameEndpoint,
} from "../a2a/cross-run-contract.js";
import { cloneJson, sha256, stableJson } from "./hash.js";
import {
  eventTypes,
  validateCompactionRequestEnvelope,
  validateCrossRunEventEnvelope,
  validateEventPayload,
  validateMessageRun,
} from "./validation.js";

export interface ReadEventsOptions {
  runId?: string;
  afterOffset?: number;
}

export interface Ledger {
  append<K extends EventType>(event: AppendEvent<K>): Promise<EventEnvelope<K>>;
  read(options?: ReadEventsOptions): Promise<AnyEvent[]>;
  watermark(): Promise<number>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface LedgerOptions {
  clock?: Clock;
  createEventId?: () => EventId;
}

export class LedgerError extends Error {
  override readonly name: string = "LedgerError";
}

export class LedgerClosedError extends LedgerError {
  override readonly name = "LedgerClosedError";
}

export class LedgerCorruptionError extends LedgerError {
  override readonly name = "LedgerCorruptionError";
}

export class IdempotencyConflictError extends LedgerError {
  override readonly name = "IdempotencyConflictError";
}

export class LedgerWriterLockedError extends LedgerError {
  override readonly name = "LedgerWriterLockedError";
}

function withoutContentHash(event: AnyEvent): Omit<AnyEvent, "contentHash"> {
  const { contentHash: _contentHash, ...content } = event;
  return content as Omit<AnyEvent, "contentHash">;
}

export function computeEventContentHash(
  event: Omit<AnyEvent, "contentHash"> | AnyEvent,
): string {
  const content = "contentHash" in event
    ? withoutContentHash(event as AnyEvent)
    : event;
  return sha256(stableJson(content));
}

function commandFingerprint(event: AppendEvent | AnyEvent): string {
  return sha256(stableJson({
    runId: event.runId,
    turnId: event.turnId,
    laneId: event.laneId,
    type: event.type,
    payload: event.payload,
    causationId: event.causationId,
    correlationId: event.correlationId,
    idempotencyKey: event.idempotencyKey,
    visibility: event.visibility ?? "run",
  }));
}

function inputAdmissionFingerprint(
  event: AppendEvent<"input.admitted"> | EventEnvelope<"input.admitted">,
): string {
  return sha256(stableJson({
    // The artifact id is transport metadata and may change across a
    // lost-ack retry, but media type and byte length affect how the payload
    // is interpreted and must remain stable for the same input id.
    contentHash: event.payload.messageRef.contentHash,
    mediaType: event.payload.messageRef.mediaType,
    byteLength: event.payload.messageRef.byteLength,
    delivery: event.payload.delivery,
    targetTurnId: event.payload.targetTurnId,
  }));
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new LedgerCorruptionError(`Invalid ${field}`);
  }
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new LedgerCorruptionError(`Invalid ${field}`);
  }
}

export function validateEvent(event: unknown): asserts event is AnyEvent {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw new LedgerCorruptionError("Ledger line is not an event object");
  }

  const candidate = event as Partial<AnyEvent>;
  assertNonEmptyString(candidate.eventId, "eventId");
  assertNonEmptyString(candidate.runId, "runId");
  if (candidate.turnId !== undefined) {
    assertNonEmptyString(candidate.turnId, "turnId");
  }
  assertNonEmptyString(candidate.laneId, "laneId");
  assertPositiveInteger(candidate.globalOffset, "globalOffset");
  assertPositiveInteger(candidate.laneSeq, "laneSeq");
  assertNonEmptyString(candidate.occurredAt, "occurredAt");
  assertNonEmptyString(candidate.correlationId, "correlationId");
  assertNonEmptyString(candidate.idempotencyKey, "idempotencyKey");
  assertNonEmptyString(candidate.contentHash, "contentHash");
  if (candidate.causationId !== undefined) {
    assertNonEmptyString(candidate.causationId, "causationId");
  }

  if (candidate.schemaVersion !== 1) {
    throw new LedgerCorruptionError("Unsupported schemaVersion");
  }
  if (typeof candidate.type !== "string" || !eventTypes.has(candidate.type as EventType)) {
    throw new LedgerCorruptionError(`Unknown event type: ${String(candidate.type)}`);
  }
  if (candidate.payload === null || typeof candidate.payload !== "object") {
    throw new LedgerCorruptionError("Invalid payload");
  }
  if (
    candidate.visibility !== "lane"
    && candidate.visibility !== "run"
    && candidate.visibility !== "user"
    && candidate.visibility !== "sensitive"
  ) {
    throw new LedgerCorruptionError("Invalid visibility");
  }
  if (!Number.isFinite(Date.parse(candidate.occurredAt))) {
    throw new LedgerCorruptionError("Invalid occurredAt");
  }

  try {
    validateEventPayload(candidate.type, candidate.payload);
    validateCompactionRequestEnvelope(
      candidate.type,
      candidate.payload,
      candidate.runId,
      candidate.laneId,
    );
    validateCrossRunEventEnvelope(
      candidate.type,
      candidate.payload,
      candidate.runId,
      candidate.laneId,
      candidate.occurredAt,
      {
        occurredAt: candidate.occurredAt,
        turnId: candidate.turnId,
        causationId: candidate.causationId,
        correlationId: candidate.correlationId,
        idempotencyKey: candidate.idempotencyKey,
        visibility: candidate.visibility,
      },
    );
    const payloadTurnId = "turnId" in candidate.payload
      ? candidate.payload.turnId
      : undefined;
    // Legacy one-shot runs may cancel a model request without a Turn; interactive
    // callers still include their Turn identity on the event envelope.
    if (
      (candidate.type === "input.delivered"
        || candidate.type.startsWith("turn.")
        || candidate.type === "tool.unknown"
        || (candidate.type === "user.message" && "inputId" in candidate.payload))
      && candidate.turnId === undefined
    ) {
      throw new TypeError(`${candidate.type} requires an event turnId`);
    }
    if (payloadTurnId !== undefined && payloadTurnId !== candidate.turnId) {
      throw new TypeError("payload turnId must equal the event turnId");
    }
    if (
      candidate.type === "input.admitted"
      && (
        (candidate.payload.targetTurnId === undefined && candidate.turnId !== undefined)
        || candidate.payload.targetTurnId !== candidate.turnId
      )
    ) {
      throw new TypeError(
        "input.admitted targetTurnId and event turnId must either both be absent or equal",
      );
    }
    if (candidate.type === "input.replaced") {
      const isSteering = candidate.payload.delivery === "steering";
      if (
        (isSteering && candidate.payload.targetTurnId === undefined)
        || (!isSteering && candidate.payload.targetTurnId !== undefined)
        || candidate.payload.targetTurnId !== candidate.turnId
      ) {
        throw new TypeError(
          "input.replaced steering targetTurnId must equal event turnId; follow-up must omit both",
        );
      }
    }
    if (candidate.type === "input.withdrawn" && candidate.turnId !== undefined) {
      throw new TypeError("input.withdrawn must be run-scoped");
    }
    if (candidate.type === "message.sent") {
      validateMessageRun(candidate.payload.message, candidate.runId);
    }
  } catch (error) {
    throw new LedgerCorruptionError(
      `Invalid ${candidate.type}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const expectedHash = computeEventContentHash(candidate as AnyEvent);
  if (candidate.contentHash !== expectedHash) {
    throw new LedgerCorruptionError(
      `Content hash mismatch at offset ${candidate.globalOffset}`,
    );
  }
}

interface PreparedAppend<K extends EventType> {
  event: EventEnvelope<K>;
  duplicate: boolean;
}

interface LedgerInputState {
  revision: number;
  messageRef: ArtifactRef;
  delivery: InputDelivery;
  targetTurnId?: TurnId;
  sequence: number;
  status: "pending" | "delivered" | "withdrawn";
}

export class LedgerState {
  readonly #events: AnyEvent[] = [];
  readonly #idempotency = new Map<string, AnyEvent>();
  readonly #eventIds = new Set<string>();
  readonly #runCreations = new Set<RunId>();
  readonly #goalVersions = new Map<RunId, number>();
  readonly #sentMessages = new Map<string, EventEnvelope<"message.sent">>();
  readonly #laneSequences = new Map<string, number>();
  readonly #inputAdmissions = new Map<string, EventEnvelope<"input.admitted">>();
  readonly #inputStates = new Map<string, LedgerInputState>();
  readonly #inputSequences = new Map<RunId, number>();
  readonly #clock: Clock;
  readonly #createEventId: () => EventId;

  constructor(events: AnyEvent[] = [], options: LedgerOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#createEventId = options.createEventId ?? randomUUID;

    for (const event of events) {
      this.#commitLoaded(event);
    }
  }

  get watermark(): number {
    return this.#events.length === 0
      ? 0
      : this.#events[this.#events.length - 1]!.globalOffset;
  }

  prepare<K extends EventType>(input: AppendEvent<K>): PreparedAppend<K> {
    this.#validateAppend(input);
    if (input.type === "input.admitted") {
      const admission = input as AppendEvent<"input.admitted">;
      const inputScope = `${input.runId}\u0000${admission.payload.inputId}`;
      const existingAdmission = this.#inputAdmissions.get(inputScope);
      if (existingAdmission !== undefined) {
        if (
          inputAdmissionFingerprint(existingAdmission)
          !== inputAdmissionFingerprint(admission)
        ) {
          throw new IdempotencyConflictError(
            `Input ID ${admission.payload.inputId} was reused with different content`,
          );
        }
        return {
          event: cloneJson(existingAdmission) as EventEnvelope<K>,
          duplicate: true,
        };
      }
    }
    const idempotencyScope = `${input.runId}\u0000${input.idempotencyKey}`;
    const existing = this.#idempotency.get(idempotencyScope);
    if (existing !== undefined) {
      if (commandFingerprint(existing) !== commandFingerprint(input)) {
        throw new IdempotencyConflictError(
          `Idempotency key ${input.idempotencyKey} was reused with different content`,
        );
      }
      return {
        event: cloneJson(existing) as EventEnvelope<K>,
        duplicate: true,
      };
    }

    const laneScope = `${input.runId}\u0000${input.laneId}`;
    const laneSeq = (this.#laneSequences.get(laneScope) ?? 0) + 1;
    const occurredAt = input.occurredAt ?? this.#clock.now().toISOString();
    if (!Number.isFinite(Date.parse(occurredAt))) {
      throw new LedgerError("occurredAt must be a valid date-time");
    }

    const content = cloneJson({
      eventId: this.#createEventId(),
      runId: input.runId,
      turnId: input.turnId,
      laneId: input.laneId,
      globalOffset: this.watermark + 1,
      laneSeq,
      type: input.type,
      schemaVersion: 1 as const,
      occurredAt,
      causationId: input.causationId,
      correlationId: input.correlationId,
      idempotencyKey: input.idempotencyKey,
      visibility: input.visibility ?? "run",
      payload: input.payload,
    });
    const event = {
      ...content,
      contentHash: computeEventContentHash(content as Omit<AnyEvent, "contentHash">),
    } as EventEnvelope<K>;
    this.#validateCandidate(event as AnyEvent);

    return { event, duplicate: false };
  }

  commit(event: AnyEvent): void {
    this.#commitLoaded(event);
  }

  preflight(event: AnyEvent): void {
    this.#validateCandidate(event);
  }

  read(options: ReadEventsOptions = {}): AnyEvent[] {
    const afterOffset = options.afterOffset ?? 0;
    if (!Number.isSafeInteger(afterOffset) || afterOffset < 0) {
      throw new LedgerError("afterOffset must be a non-negative safe integer");
    }

    return this.#events
      .filter((event) => (
        event.globalOffset > afterOffset
        && (options.runId === undefined || event.runId === options.runId)
      ))
      .map((event) => cloneJson(event));
  }

  #commitLoaded(event: AnyEvent): void {
    this.#validateCandidate(event);
    const laneScope = `${event.runId}\u0000${event.laneId}`;
    const idempotencyScope = `${event.runId}\u0000${event.idempotencyKey}`;
    const stored = cloneJson(event);
    this.#events.push(stored);
    this.#eventIds.add(stored.eventId);
    if (stored.type === "run.created") {
      this.#runCreations.add(stored.runId);
      this.#goalVersions.set(stored.runId, stored.payload.goal.version);
    } else if (stored.type === "goal.revised") {
      this.#goalVersions.set(stored.runId, stored.payload.goal.version);
    } else if (stored.type === "message.sent") {
      this.#sentMessages.set(messageScope(stored.runId, stored.payload.message.messageId), stored);
    }
    this.#laneSequences.set(laneScope, stored.laneSeq);
    this.#idempotency.set(idempotencyScope, stored);
    if (stored.type === "input.admitted") {
      const inputScope = `${stored.runId}\u0000${stored.payload.inputId}`;
      this.#inputAdmissions.set(inputScope, stored);
      this.#inputStates.set(inputScope, {
        revision: 1,
        messageRef: stored.payload.messageRef,
        delivery: stored.payload.delivery,
        ...(stored.payload.targetTurnId === undefined
          ? {}
          : { targetTurnId: stored.payload.targetTurnId }),
        sequence: stored.payload.sequence,
        status: "pending",
      });
      this.#inputSequences.set(stored.runId, stored.payload.sequence);
    } else if (stored.type === "input.replaced") {
      const inputScope = `${stored.runId}\u0000${stored.payload.inputId}`;
      const state = this.#inputStates.get(inputScope)!;
      this.#inputStates.set(inputScope, {
        revision: stored.payload.revision,
        messageRef: stored.payload.messageRef,
        delivery: stored.payload.delivery,
        ...(stored.payload.targetTurnId === undefined
          ? {}
          : { targetTurnId: stored.payload.targetTurnId }),
        sequence: stored.payload.sequence,
        status: state.status,
      });
    } else if (stored.type === "input.delivered") {
      const inputScope = `${stored.runId}\u0000${stored.payload.inputId}`;
      this.#inputStates.get(inputScope)!.status = "delivered";
    } else if (stored.type === "input.withdrawn") {
      const inputScope = `${stored.runId}\u0000${stored.payload.inputId}`;
      this.#inputStates.get(inputScope)!.status = "withdrawn";
    }
  }

  #validateCandidate(event: AnyEvent): void {
    validateEvent(event);
    const expectedOffset = this.watermark + 1;
    if (event.globalOffset !== expectedOffset) {
      throw new LedgerCorruptionError(
        `Expected globalOffset ${expectedOffset}, received ${event.globalOffset}`,
      );
    }

    if (this.#eventIds.has(event.eventId)) {
      throw new LedgerCorruptionError(`Duplicate eventId ${event.eventId}`);
    }

    if (event.type === "run.created" && this.#runCreations.has(event.runId)) {
      throw new LedgerCorruptionError(`Run ${event.runId} has more than one run.created event`);
    }

    if (event.type === "goal.revised") {
      const currentVersion = this.#goalVersions.get(event.runId);
      if (currentVersion === undefined) {
        throw new LedgerCorruptionError(
          `Run ${event.runId} has no goal to revise`,
        );
      }
      const nextVersion = event.payload.goal.version;
      if (nextVersion !== currentVersion + 1) {
        throw new LedgerCorruptionError(
          `Goal version must increment from ${currentVersion} to ${currentVersion + 1}, received ${nextVersion}`,
        );
      }
    }

    if (event.type === "message.sent") {
      const messageId = event.payload.message.messageId;
      if (this.#sentMessages.has(messageScope(event.runId, messageId))) {
        throw new LedgerCorruptionError(`Message ${messageId} was sent more than once`);
      }
    }

    if (event.type === "message.claimed" || event.type === "message.handled") {
      const messageId = event.payload.messageId;
      const scope = messageScope(event.runId, messageId);
      if (!this.#sentMessages.has(scope)) {
        throw new LedgerCorruptionError(
          `${event.type} references message ${messageId} before message.sent`,
        );
      }
      if (event.type === "message.claimed" && event.payload.claimedBy !== event.laneId) {
        throw new LedgerCorruptionError(
          `Claim for ${messageId} must be emitted by its claiming lane`,
        );
      }
    }

    if (event.type === "budget.charged" && event.payload.laneId !== event.laneId) {
      throw new LedgerCorruptionError(
        "budget.charged laneId must equal the event laneId",
      );
    }

    const laneScope = `${event.runId}\u0000${event.laneId}`;
    const expectedLaneSeq = (this.#laneSequences.get(laneScope) ?? 0) + 1;
    if (event.laneSeq !== expectedLaneSeq) {
      throw new LedgerCorruptionError(
        `Expected laneSeq ${expectedLaneSeq} for ${event.laneId}, received ${event.laneSeq}`,
      );
    }

    const idempotencyScope = `${event.runId}\u0000${event.idempotencyKey}`;
    if (this.#idempotency.has(idempotencyScope)) {
      throw new LedgerCorruptionError(
        `Duplicate idempotencyKey ${event.idempotencyKey}`,
      );
    }

    this.#validateCrossRunPredecessor(event);

    if (event.type === "input.admitted") {
      const inputScope = `${event.runId}\u0000${event.payload.inputId}`;
      if (this.#inputAdmissions.has(inputScope)) {
        throw new LedgerCorruptionError(`Duplicate inputId ${event.payload.inputId}`);
      }
      const previousSequence = this.#inputSequences.get(event.runId) ?? 0;
      if (event.payload.sequence <= previousSequence) {
        throw new LedgerCorruptionError(
          `Input sequence ${event.payload.sequence} is not monotonic for ${event.runId}`,
        );
      }
    }

    if (event.type === "input.replaced") {
      const inputScope = `${event.runId}\u0000${event.payload.inputId}`;
      const state = this.#inputStates.get(inputScope);
      if (state === undefined) {
        throw new LedgerCorruptionError(
          `Cannot replace missing input ${event.payload.inputId}`,
        );
      }
      if (state.status !== "pending") {
        throw new LedgerCorruptionError(
          `Cannot replace ${state.status} input ${event.payload.inputId}`,
        );
      }
      if (event.payload.expectedRevision !== state.revision) {
        throw new LedgerCorruptionError(
          `Input ${event.payload.inputId} expected revision ${event.payload.expectedRevision}, current revision is ${state.revision}`,
        );
      }
      if (stableJson(event.payload.expectedMessageRef) !== stableJson(state.messageRef)) {
        throw new LedgerCorruptionError(
          `Input ${event.payload.inputId} expected message ref does not match current revision`,
        );
      }
      if (event.payload.revision !== state.revision + 1) {
        throw new LedgerCorruptionError(
          `Input ${event.payload.inputId} replacement revision must increment by one`,
        );
      }
      if (event.payload.sequence !== state.sequence) {
        throw new LedgerCorruptionError(
          `Input ${event.payload.inputId} replacement cannot change queue sequence`,
        );
      }
    }

    if (event.type === "input.withdrawn") {
      const inputScope = `${event.runId}\u0000${event.payload.inputId}`;
      const state = this.#inputStates.get(inputScope);
      if (state === undefined) {
        throw new LedgerCorruptionError(
          `Cannot withdraw missing input ${event.payload.inputId}`,
        );
      }
      if (state.status !== "pending") {
        throw new LedgerCorruptionError(
          `Cannot withdraw ${state.status} input ${event.payload.inputId}`,
        );
      }
      if (event.payload.expectedRevision !== state.revision) {
        throw new LedgerCorruptionError(
          `Input ${event.payload.inputId} expected revision ${event.payload.expectedRevision}, current revision is ${state.revision}`,
        );
      }
      if (stableJson(event.payload.expectedMessageRef) !== stableJson(state.messageRef)) {
        throw new LedgerCorruptionError(
          `Input ${event.payload.inputId} expected message ref does not match current revision`,
        );
      }
    }

    if (event.type === "input.delivered") {
      const inputScope = `${event.runId}\u0000${event.payload.inputId}`;
      const state = this.#inputStates.get(inputScope);
      if (state === undefined) {
        throw new LedgerCorruptionError(
          `Cannot deliver missing input ${event.payload.inputId}`,
        );
      }
      if (state.status !== "pending") {
        throw new LedgerCorruptionError(
          `Cannot deliver ${state.status} input ${event.payload.inputId}`,
        );
      }
      if (
        event.payload.expectedRevision !== undefined
        && event.payload.expectedRevision !== state.revision
      ) {
        throw new LedgerCorruptionError(
          `Input ${event.payload.inputId} expected revision ${event.payload.expectedRevision}, current revision is ${state.revision}`,
        );
      }
      if (
        event.payload.expectedMessageRef !== undefined
        && stableJson(event.payload.expectedMessageRef) !== stableJson(state.messageRef)
      ) {
        throw new LedgerCorruptionError(
          `Input ${event.payload.inputId} expected message ref does not match current revision`,
        );
      }
    }

  }

  /**
   * A2A saga facts are ordinary Ledger events, so the Ledger itself must
   * enforce their causal order. The adapter performs the same checks at its
   * port boundary, but callers can append directly to a Ledger as well.
   */
  #validateCrossRunPredecessor(event: AnyEvent): void {
    if (
      event.type !== "a2a.outbox.pending"
      && event.type !== "a2a.outbox.attempted"
      && event.type !== "a2a.outbox.receipt"
    ) {
      return;
    }

    const prior = this.#events;
    if (event.type === "a2a.outbox.pending") {
      const routeId = normalizeEnvelope(event.payload.envelope).routeId;
      if (prior.some((candidate) => (
        candidate.type === "a2a.outbox.pending"
        && normalizeEnvelope(candidate.payload.envelope).routeId === routeId
      ))) {
        throw new LedgerCorruptionError(
          `A2A route ${routeId} already has a pending fact`,
        );
      }
      return;
    }

    const routeId = event.type === "a2a.outbox.attempted"
      ? event.payload.routeId
      : event.payload.receipt.routeId;
    const pendingEvent = prior.find((candidate) => (
      candidate.type === "a2a.outbox.pending"
      && normalizeEnvelope(candidate.payload.envelope).routeId === routeId
    ));
    if (pendingEvent === undefined || pendingEvent.type !== "a2a.outbox.pending") {
      throw new LedgerCorruptionError(
        `A2A ${event.type} has no durable pending predecessor`,
      );
    }
    const pending = normalizeEnvelope(pendingEvent.payload.envelope);

    const terminalEvent = prior.find((candidate) => (
      candidate.type === "a2a.outbox.receipt"
      && normalizeReceipt(candidate.payload.receipt).routeId === routeId
    ));
    if (terminalEvent !== undefined) {
      throw new LedgerCorruptionError(
        `A2A route ${routeId} already has a terminal receipt`,
      );
    }

    if (event.type === "a2a.outbox.attempted") {
      if (
        event.payload.messageId !== pending.messageId
        || event.runId !== pending.source.runId
        || event.laneId !== pending.source.laneId
      ) {
        throw new LedgerCorruptionError(
          `A2A attempt ${event.payload.attemptId} does not match its pending envelope`,
        );
      }
      return;
    }

    const receipt = normalizeReceipt(event.payload.receipt);
    if (
      receipt.messageId !== pending.messageId
      || receipt.idempotencyKey !== pending.idempotencyKey
      || !sameEndpoint(receipt.source, pending.source)
      || !sameEndpoint(receipt.target, pending.target)
      || receipt.relationship !== pending.relationship
      || receipt.source.runId !== event.runId
      || receipt.source.laneId !== event.laneId
    ) {
      throw new LedgerCorruptionError(
        `A2A receipt for route ${routeId} does not match its pending envelope`,
      );
    }
    if (receipt.attemptId !== undefined && !prior.some((candidate) => (
      candidate.type === "a2a.outbox.attempted"
      && candidate.payload.routeId === routeId
      && candidate.payload.attemptId === receipt.attemptId
    ))) {
      throw new LedgerCorruptionError(
        `A2A receipt for route ${routeId} references an unknown attempt`,
      );
    }
  }

  #validateAppend(input: AppendEvent): void {
    if (!eventTypes.has(input.type)) {
      throw new LedgerError(`Unknown event type: ${String(input.type)}`);
    }
    if (input.type === "input.delivered") {
      const delivery = input as AppendEvent<"input.delivered">;
      if (
        delivery.payload.expectedRevision === undefined
        || delivery.payload.expectedMessageRef === undefined
      ) {
        throw new LedgerError(
          "New input.delivered events require expectedRevision and expectedMessageRef",
        );
      }
    }
    if (input.type === "turn.started") {
      const started = input as AppendEvent<"turn.started">;
      if (started.payload.boundary === undefined) {
        throw new LedgerError("New turn.started events require an execution boundary");
      }
    }
    for (const [field, value] of [
      ["runId", input.runId],
      ["laneId", input.laneId],
      ["correlationId", input.correlationId],
      ["idempotencyKey", input.idempotencyKey],
    ] as const) {
      if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
        throw new LedgerError(`${field} must be a non-empty string without NUL`);
      }
    }
    for (const [field, value] of [
      ["turnId", input.turnId],
      ["causationId", input.causationId],
    ] as const) {
      if (
        value !== undefined
        && (typeof value !== "string" || value.length === 0 || value.includes("\0"))
      ) {
        throw new LedgerError(`${field} must be a non-empty string without NUL`);
      }
    }
    stableJson(input.payload);
  }
}

function messageScope(runId: RunId, messageId: string): string {
  return `${runId}\u0000${messageId}`;
}
