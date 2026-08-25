import { randomUUID } from "node:crypto";

import type {
  AnyEvent,
  AppendEvent,
  EventEnvelope,
  EventType,
} from "../domain/events.js";
import type { Clock } from "../domain/ports.js";
import { systemClock } from "../domain/ports.js";
import type { EventId } from "../domain/types.js";
import { cloneJson, sha256, stableJson } from "./hash.js";
import {
  eventTypes,
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
    laneId: event.laneId,
    type: event.type,
    payload: event.payload,
    causationId: event.causationId,
    correlationId: event.correlationId,
    idempotencyKey: event.idempotencyKey,
    visibility: event.visibility ?? "run",
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

export class LedgerState {
  readonly #events: AnyEvent[] = [];
  readonly #idempotency = new Map<string, AnyEvent>();
  readonly #eventIds = new Set<string>();
  readonly #laneSequences = new Map<string, number>();
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
    this.#laneSequences.set(laneScope, stored.laneSeq);
    this.#idempotency.set(idempotencyScope, stored);
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

  }

  #validateAppend(input: AppendEvent): void {
    if (!eventTypes.has(input.type)) {
      throw new LedgerError(`Unknown event type: ${String(input.type)}`);
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
    stableJson(input.payload);
  }
}
