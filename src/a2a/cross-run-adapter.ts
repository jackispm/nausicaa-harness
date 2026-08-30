import type {
  AnyEvent,
  AppendEvent,
} from "../domain/events.js";
import { systemClock, type Clock } from "../domain/ports.js";
import type {
  CrossRunEndpoint,
  CrossRunEnvelope,
  Visibility,
} from "../domain/types.js";
import {
  IdempotencyConflictError,
  type Ledger,
} from "../ledger/index.js";
import { sha256, stableJson } from "../ledger/hash.js";
import {
  A2AInbox,
  A2AProtocolError,
} from "./inbox.js";
import {
  CrossRunProtocolError,
  type CrossRunFact,
  type CrossRunFactStore,
  type CrossRunSenderIdentity,
  type CrossRunTargetAdmission,
  type CrossRunTargetAdmissionInput,
  type CrossRunTargetAdmissionResult,
  type CrossRunWake,
  type CrossRunWakeInput,
  envelopeToA2AMessage,
  normalizeEndpoint,
  normalizeEnvelope,
  normalizeReceipt,
  normalizeSenderIdentity,
  sameEndpoint,
} from "./cross-run-contract.js";

type CrossRunOutboxEventType =
  | "a2a.outbox.pending"
  | "a2a.outbox.attempted"
  | "a2a.outbox.receipt";

interface CrossRunPendingPayload {
  readonly envelope: CrossRunEnvelope;
  readonly recordedAt: string;
}

interface CrossRunAttemptPayload {
  readonly routeId: string;
  readonly messageId: string;
  readonly attemptId: string;
  readonly attemptedAt: string;
}

interface CrossRunReceiptPayload {
  readonly receipt: import("../domain/types.js").CrossRunReceipt;
}

interface CrossRunOutboxEventBase {
  readonly runId: string;
  readonly laneId: string;
  readonly occurredAt: string;
  readonly globalOffset: number;
}

type CrossRunOutboxEvent =
  | (CrossRunOutboxEventBase & {
      readonly type: "a2a.outbox.pending";
      readonly payload: CrossRunPendingPayload;
    })
  | (CrossRunOutboxEventBase & {
      readonly type: "a2a.outbox.attempted";
      readonly payload: CrossRunAttemptPayload;
    })
  | (CrossRunOutboxEventBase & {
      readonly type: "a2a.outbox.receipt";
      readonly payload: CrossRunReceiptPayload;
    });

type CrossRunAppendEvent = Omit<AppendEvent, "type" | "payload"> & {
  readonly type: CrossRunOutboxEventType;
  readonly payload:
    | CrossRunPendingPayload
    | CrossRunAttemptPayload
    | CrossRunReceiptPayload;
};

export interface LedgerCrossRunFactStoreOptions {
  /** The source Run's existing Ledger; this adapter never owns or closes it. */
  readonly ledger: Ledger;
  /** Authenticated composition identity used to bind every source fact. */
  readonly source: CrossRunEndpoint;
}

export interface LedgerCrossRunTargetAdmissionOptions {
  /** The target Run's existing Ledger and only durable Inbox fact source. */
  readonly ledger: Ledger;
  /** Host-resolved target identity; model input cannot replace it. */
  readonly target: CrossRunEndpoint;
  readonly clock?: Clock;
}

export interface CrossRunHostWakeRequest {
  readonly runId: string;
  readonly source: "a2a";
  readonly dedupeKey: string;
  readonly wakeId: string;
  readonly inputId: string;
  readonly occurredAt: string;
}

export interface CrossRunHostWakeResult {
  readonly status: "queued" | "duplicate" | "already-active" | "rejected";
  readonly retryAt?: string;
}

export interface CrossRunHostWakeAdapterOptions {
  /** Host wake is injected so A2A does not become a second scheduler. */
  readonly wake: (
    request: CrossRunHostWakeRequest,
  ) => Promise<CrossRunHostWakeResult>;
  readonly target: CrossRunEndpoint;
  readonly clock?: Clock;
}

const outboxTails = new WeakMap<object, Map<string, Promise<void>>>();
const targetAdmissionTails = new WeakMap<object, Map<string, Promise<void>>>();

/**
 * Stores the source side of the cross-Run delivery saga in the source Ledger.
 * The short promise tail only serializes writers; every recoverable fact is an
 * ordinary Ledger event.
 */
export class LedgerCrossRunFactStore implements CrossRunFactStore {
  readonly #ledger: Ledger;
  readonly #source: CrossRunEndpoint;

  constructor(options: LedgerCrossRunFactStoreOptions) {
    assertOptions(options);
    assertLedger(options.ledger);
    this.#ledger = options.ledger;
    this.#source = normalizeEndpoint(options.source, "source");
  }

  append(fact: CrossRunFact): Promise<void> {
    const normalized = normalizeFact(fact, this.#source);
    return runLedgerExclusive(
      outboxTails,
      this.#ledger,
      endpointScope(this.#source),
      () => this.#append(normalized),
    );
  }

  async read(
    scope: { readonly runId?: string; readonly routeId?: string } = {},
  ): Promise<readonly CrossRunFact[]> {
    if (scope === null || typeof scope !== "object" || Array.isArray(scope)) {
      throw durableFactError("A2A fact read scope must be an object");
    }
    if (scope.runId !== undefined && scope.runId !== this.#source.runId) {
      return [];
    }
    const routeId = scope.routeId === undefined
      ? undefined
      : identifier(scope.routeId, "scope.routeId");
    const events = await this.#readEvents();
    return factsFromEvents(events, this.#source)
      .filter((fact) => routeId === undefined || factRouteId(fact) === routeId)
      .map((fact) => structuredClone(fact));
  }

  async #append(fact: CrossRunFact): Promise<void> {
    const events = await this.#readEvents();
    const facts = factsFromEvents(events, this.#source);
    const identity = factIdentity(fact);
    const existing = facts.find((candidate) => factIdentity(candidate) === identity);
    if (existing !== undefined) {
      if (stableJson(existing) !== stableJson(fact)) {
        throw new CrossRunProtocolError(
          "A2A outbox fact identity conflicts with durable content",
          "idempotency-conflict",
        );
      }
      return;
    }
    assertFactPredecessor(fact, facts, this.#source);

    try {
      const stored = await this.#ledger.append(
        factAppend(fact, this.#source) as unknown as AppendEvent,
      );
      const storedFact = factFromEvent(stored as unknown, this.#source);
      if (storedFact === undefined || stableJson(storedFact) !== stableJson(fact)) {
        throw new CrossRunProtocolError(
          "Ledger returned a conflicting A2A outbox fact",
          "idempotency-conflict",
        );
      }
    } catch (error: unknown) {
      if (error instanceof CrossRunProtocolError) throw error;
      if (error instanceof IdempotencyConflictError) {
        throw new CrossRunProtocolError(
          "A2A outbox idempotency key conflicts with another Ledger fact",
          "idempotency-conflict",
        );
      }
      throw durableFactError("Unable to append A2A outbox fact");
    }
  }

  async #readEvents(): Promise<readonly AnyEvent[]> {
    try {
      return await this.#ledger.read({ runId: this.#source.runId });
    } catch {
      throw durableFactError("Unable to read A2A outbox facts");
    }
  }
}

/**
 * Rehydrates the target Inbox from its Ledger immediately before admission,
 * then appends the normal target `message.sent` fact through A2AInbox.
 */
export class LedgerCrossRunTargetAdmission implements CrossRunTargetAdmission {
  readonly #ledger: Ledger;
  readonly #target: CrossRunEndpoint;
  readonly #inbox: A2AInbox;

  constructor(options: LedgerCrossRunTargetAdmissionOptions) {
    assertOptions(options);
    assertLedger(options.ledger);
    this.#ledger = options.ledger;
    this.#target = normalizeEndpoint(options.target, "target");
    this.#inbox = new A2AInbox({
      sink: this.#ledger,
      clock: options.clock ?? systemClock,
    });
  }

  admit(input: CrossRunTargetAdmissionInput): Promise<CrossRunTargetAdmissionResult> {
    const normalized = normalizeTargetAdmission(input, this.#target);
    return runLedgerExclusive(
      targetAdmissionTails,
      this.#ledger,
      endpointScope(this.#target),
      () => this.#admit(normalized),
    );
  }

  async #admit(
    input: CrossRunTargetAdmissionInput,
  ): Promise<CrossRunTargetAdmissionResult> {
    const events = await this.#ledger.read({ runId: this.#target.runId });
    this.#inbox.rehydrate(events);
    try {
      const result = await this.#inbox.send(input.message);
      if (result.status === "expired") {
        return { status: "rejected", reason: "expired" };
      }
      return {
        status: result.status,
        messageId: result.messageId,
      };
    } catch (error: unknown) {
      if (error instanceof IdempotencyConflictError || isInboxConflict(error)) {
        return { status: "rejected", reason: "idempotency-conflict" };
      }
      if (error instanceof A2AProtocolError) {
        return { status: "rejected", reason: "target-admission-failed" };
      }
      throw error;
    }
  }
}

/** Converts an admitted target message into one deterministic daemon wake. */
export class CrossRunHostWakeAdapter implements CrossRunWake {
  readonly #wake: CrossRunHostWakeAdapterOptions["wake"];
  readonly #target: CrossRunEndpoint;
  readonly #clock: Clock;

  constructor(options: CrossRunHostWakeAdapterOptions) {
    assertOptions(options);
    if (typeof options.wake !== "function") {
      throw new CrossRunProtocolError(
        "wake must be a function",
        "wake-failed",
      );
    }
    this.#wake = options.wake;
    this.#target = normalizeEndpoint(options.target, "target");
    this.#clock = options.clock ?? systemClock;
  }

  async wake(input: CrossRunWakeInput): Promise<{
    readonly status: "queued" | "already-active" | "rejected";
    readonly retryAt?: string;
  }> {
    const envelope = normalizeEnvelope(input.envelope);
    if (!sameEndpoint(envelope.target, this.#target)) {
      throw new CrossRunProtocolError(
        "Wake target does not match the bound endpoint",
        "identity-forged",
      );
    }
    const targetMessageId = identifier(
      input.targetMessageId,
      "targetMessageId",
    );
    const identity = crossRunWakeIdentity(envelope.routeId, targetMessageId);
    const occurredAt = this.#clock.now().toISOString();
    if (!Number.isFinite(Date.parse(occurredAt))) {
      throw new CrossRunProtocolError("Wake clock is invalid", "wake-failed");
    }
    const result = await this.#wake({
      runId: this.#target.runId,
      source: "a2a",
      dedupeKey: `a2a:wake:${identity}`,
      wakeId: `a2a-wake:${identity}`,
      inputId: `a2a-input:${identity}`,
      occurredAt,
    });
    const normalized = normalizeHostWakeResult(result);
    if (normalized.status === "duplicate" || normalized.status === "already-active") {
      return {
        status: "already-active",
        ...(normalized.retryAt === undefined ? {} : { retryAt: normalized.retryAt }),
      };
    }
    return {
      status: normalized.status,
      ...(normalized.retryAt === undefined ? {} : { retryAt: normalized.retryAt }),
    };
  }
}

export function createLedgerCrossRunFactStore(
  options: LedgerCrossRunFactStoreOptions,
): LedgerCrossRunFactStore {
  return new LedgerCrossRunFactStore(options);
}

export function createLedgerCrossRunTargetAdmission(
  options: LedgerCrossRunTargetAdmissionOptions,
): LedgerCrossRunTargetAdmission {
  return new LedgerCrossRunTargetAdmission(options);
}

export function createCrossRunHostWakeAdapter(
  options: CrossRunHostWakeAdapterOptions,
): CrossRunHostWakeAdapter {
  return new CrossRunHostWakeAdapter(options);
}

export function deriveCrossRunWakeDedupeKey(
  routeId: string,
  targetMessageId: string,
): string {
  return `a2a:wake:${crossRunWakeIdentity(routeId, targetMessageId)}`;
}

function normalizeFact(
  value: CrossRunFact,
  source: CrossRunEndpoint,
): CrossRunFact {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw durableFactError("A2A outbox fact must be an object");
  }
  if (value.kind === "outbox.pending") {
    const envelope = normalizeEnvelope(value.envelope);
    if (!sameEndpoint(envelope.source, source)) {
      throw new CrossRunProtocolError(
        "A2A outbox source does not match the bound endpoint",
        "identity-forged",
      );
    }
    return Object.freeze({
      kind: value.kind,
      envelope,
      recordedAt: dateTime(value.recordedAt, "fact.recordedAt"),
    });
  }
  if (value.kind === "outbox.attempted") {
    return Object.freeze({
      kind: value.kind,
      routeId: identifier(value.routeId, "fact.routeId"),
      messageId: identifier(value.messageId, "fact.messageId"),
      attemptId: identifier(value.attemptId, "fact.attemptId"),
      attemptedAt: dateTime(value.attemptedAt, "fact.attemptedAt"),
    });
  }
  if (value.kind === "outbox.receipt") {
    const receipt = normalizeReceipt(value.receipt);
    if (!sameEndpoint(receipt.source, source)) {
      throw new CrossRunProtocolError(
        "A2A receipt source does not match the bound endpoint",
        "identity-forged",
      );
    }
    return Object.freeze({ kind: value.kind, receipt });
  }
  throw durableFactError("A2A outbox fact kind is unsupported");
}

function factAppend(
  fact: CrossRunFact,
  source: CrossRunEndpoint,
): CrossRunAppendEvent {
  const common = {
    runId: source.runId,
    laneId: source.laneId,
    correlationId: factCorrelationId(fact),
    idempotencyKey: `a2a:outbox:${sha256(factIdentity(fact))}`,
    visibility: factVisibility(fact),
    occurredAt: factOccurredAt(fact),
  };
  if (fact.kind === "outbox.pending") {
    return {
      ...common,
      type: "a2a.outbox.pending",
      payload: {
        envelope: structuredClone(fact.envelope),
        recordedAt: fact.recordedAt,
      },
      ...(fact.envelope.causationId === undefined
        ? {}
        : { causationId: fact.envelope.causationId }),
    };
  }
  if (fact.kind === "outbox.attempted") {
    return {
      ...common,
      type: "a2a.outbox.attempted",
      payload: {
        routeId: fact.routeId,
        messageId: fact.messageId,
        attemptId: fact.attemptId,
        attemptedAt: fact.attemptedAt,
      },
      causationId: fact.messageId,
    };
  }
  return {
    ...common,
    type: "a2a.outbox.receipt",
    payload: { receipt: structuredClone(fact.receipt) },
    causationId: fact.receipt.attemptId ?? fact.receipt.messageId,
  };
}

function factsFromEvents(
  events: readonly AnyEvent[],
  source: CrossRunEndpoint,
): CrossRunFact[] {
  const facts: CrossRunFact[] = [];
  const identities = new Map<string, CrossRunFact>();
  for (const event of [...events].sort((left, right) => left.globalOffset - right.globalOffset)) {
    const fact = factFromEvent(event, source);
    if (fact === undefined) continue;
    assertFactPredecessor(fact, facts, source);
    const identity = factIdentity(fact);
    const existing = identities.get(identity);
    if (existing !== undefined) {
      if (stableJson(existing) !== stableJson(fact)) {
        throw durableFactError("Conflicting A2A outbox facts exist in the Ledger");
      }
      continue;
    }
    identities.set(identity, fact);
    facts.push(fact);
  }
  return facts;
}

function factFromEvent(
  event: unknown,
  source: CrossRunEndpoint,
): CrossRunFact | undefined {
  if (!isCrossRunOutboxEvent(event)) return undefined;
  if (event.runId !== source.runId || event.laneId !== source.laneId) {
    throw durableFactError("A2A outbox event is outside the bound source endpoint");
  }
  let fact: CrossRunFact;
  if (event.type === "a2a.outbox.pending") {
    fact = {
      kind: "outbox.pending",
      envelope: event.payload.envelope,
      recordedAt: event.payload.recordedAt,
    };
  } else if (event.type === "a2a.outbox.attempted") {
    fact = {
      kind: "outbox.attempted",
      routeId: event.payload.routeId,
      messageId: event.payload.messageId,
      attemptId: event.payload.attemptId,
      attemptedAt: event.payload.attemptedAt,
    };
  } else {
    fact = { kind: "outbox.receipt", receipt: event.payload.receipt };
  }
  const normalized = normalizeFact(fact, source);
  if (factOccurredAt(normalized) !== event.occurredAt) {
    throw durableFactError("A2A outbox event time does not match its fact time");
  }
  return normalized;
}

function assertFactPredecessor(
  fact: CrossRunFact,
  existing: readonly CrossRunFact[],
  source: CrossRunEndpoint,
): void {
  if (fact.kind === "outbox.pending") return;
  const routeId = factRouteId(fact);
  const pending = existing.find((candidate) => (
    candidate.kind === "outbox.pending"
    && candidate.envelope.routeId === routeId
  ));
  if (pending === undefined || pending.kind !== "outbox.pending") {
    throw durableFactError("A2A attempt or receipt has no durable pending fact");
  }
  if (!sameEndpoint(pending.envelope.source, source)) {
    throw new CrossRunProtocolError(
      "A2A predecessor source does not match the bound endpoint",
      "identity-forged",
    );
  }
  if (fact.kind === "outbox.attempted") {
    if (fact.messageId !== pending.envelope.messageId) {
      throw new CrossRunProtocolError(
        "A2A attempt does not match its pending message",
        "idempotency-conflict",
      );
    }
    return;
  }
  const receipt = fact.receipt;
  if (
    receipt.messageId !== pending.envelope.messageId
    || receipt.idempotencyKey !== pending.envelope.idempotencyKey
    || !sameEndpoint(receipt.target, pending.envelope.target)
    || receipt.relationship !== pending.envelope.relationship
  ) {
    throw new CrossRunProtocolError(
      "A2A receipt does not match its pending envelope",
      "idempotency-conflict",
    );
  }
}

function normalizeTargetAdmission(
  value: CrossRunTargetAdmissionInput,
  target: CrossRunEndpoint,
): CrossRunTargetAdmissionInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CrossRunProtocolError("Target admission must be an object");
  }
  const envelope = normalizeEnvelope(value.envelope);
  const source = normalizeSenderIdentity(value.source);
  if (!sameEndpoint(envelope.target, target)) {
    throw new CrossRunProtocolError(
      "Envelope target does not match the bound target",
      "identity-forged",
    );
  }
  if (!sameEndpoint(envelope.source, source.endpoint)) {
    throw new CrossRunProtocolError(
      "Authenticated sender does not match the envelope source",
      "identity-forged",
    );
  }
  for (const artifact of envelope.artifacts) {
    if (artifact.visibility !== envelope.visibility) {
      throw new CrossRunProtocolError(
        "Artifact visibility does not match the message visibility",
        "artifact-mismatch",
      );
    }
  }
  const expectedMessage = envelopeToA2AMessage(envelope);
  if (stableJson(expectedMessage) !== stableJson(value.message)) {
    throw new CrossRunProtocolError(
      "Target message does not match its trusted envelope",
      "identity-forged",
    );
  }
  return Object.freeze({
    envelope,
    message: structuredClone(expectedMessage),
    source: cloneSender(source),
  });
}

function cloneSender(source: CrossRunSenderIdentity): CrossRunSenderIdentity {
  return Object.freeze({
    endpoint: structuredClone(source.endpoint),
    proof: structuredClone(source.proof),
    ...(source.relationshipGrants === undefined
      ? {}
      : { relationshipGrants: [...source.relationshipGrants] }),
  });
}

function normalizeHostWakeResult(value: unknown): CrossRunHostWakeResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CrossRunProtocolError("Host wake returned an invalid result", "wake-failed");
  }
  const candidate = value as Partial<CrossRunHostWakeResult>;
  if (
    candidate.status !== "queued"
    && candidate.status !== "duplicate"
    && candidate.status !== "already-active"
    && candidate.status !== "rejected"
  ) {
    throw new CrossRunProtocolError("Host wake returned an unsupported status", "wake-failed");
  }
  return {
    status: candidate.status,
    ...(candidate.retryAt === undefined
      ? {}
      : { retryAt: dateTime(candidate.retryAt, "wake.retryAt") }),
  };
}

function isCrossRunOutboxEvent(event: unknown): event is CrossRunOutboxEvent {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    return false;
  }
  const candidate = event as Partial<CrossRunOutboxEvent>;
  return (
    (candidate.type === "a2a.outbox.pending"
      || candidate.type === "a2a.outbox.attempted"
      || candidate.type === "a2a.outbox.receipt")
    && typeof candidate.runId === "string"
    && typeof candidate.laneId === "string"
    && typeof candidate.occurredAt === "string"
    && Number.isSafeInteger(candidate.globalOffset)
    && candidate.payload !== null
    && typeof candidate.payload === "object"
    && !Array.isArray(candidate.payload)
  );
}

function factIdentity(fact: CrossRunFact): string {
  if (fact.kind === "outbox.pending") {
    return `${fact.kind}\u0000${fact.envelope.routeId}`;
  }
  if (fact.kind === "outbox.attempted") {
    return `${fact.kind}\u0000${fact.routeId}\u0000${fact.attemptId}`;
  }
  return `${fact.kind}\u0000${fact.receipt.routeId}\u0000${fact.receipt.status}`;
}

function factRouteId(fact: CrossRunFact): string {
  if (fact.kind === "outbox.pending") return fact.envelope.routeId;
  if (fact.kind === "outbox.attempted") return fact.routeId;
  return fact.receipt.routeId;
}

function factOccurredAt(fact: CrossRunFact): string {
  if (fact.kind === "outbox.pending") return fact.recordedAt;
  if (fact.kind === "outbox.attempted") return fact.attemptedAt;
  return fact.receipt.recordedAt;
}

function factCorrelationId(fact: CrossRunFact): string {
  if (fact.kind === "outbox.pending") return fact.envelope.correlationId;
  return `a2a:${sha256(factRouteId(fact))}`;
}

function factVisibility(fact: CrossRunFact): Visibility {
  return fact.kind === "outbox.pending" ? fact.envelope.visibility : "run";
}

function crossRunWakeIdentity(routeId: string, targetMessageId: string): string {
  const route = identifier(routeId, "routeId");
  const message = identifier(targetMessageId, "targetMessageId");
  return sha256(stableJson({ routeId: route, targetMessageId: message }));
}

function endpointScope(endpoint: CrossRunEndpoint): string {
  return stableJson([
    endpoint.workspaceId,
    endpoint.sessionId,
    endpoint.runId,
    endpoint.laneId,
  ]);
}

function isInboxConflict(error: unknown): boolean {
  return error instanceof A2AProtocolError
    && error.message.startsWith("Conflicting idempotencyKey ");
}

function assertOptions(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CrossRunProtocolError("adapter options must be an object");
  }
}

function assertLedger(value: unknown): asserts value is Ledger {
  if (
    value === null
    || typeof value !== "object"
    || typeof (value as Partial<Ledger>).append !== "function"
    || typeof (value as Partial<Ledger>).read !== "function"
  ) {
    throw durableFactError("ledger must implement append and read");
  }
}

function identifier(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.length > 4_096
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new CrossRunProtocolError(`${field} is invalid`);
  }
  return value;
}

function dateTime(value: unknown, field: string): string {
  const normalized = identifier(value, field);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new CrossRunProtocolError(`${field} must be a valid date-time`);
  }
  return normalized;
}

function durableFactError(message: string): CrossRunProtocolError {
  return new CrossRunProtocolError(message, "durable-fact-failed");
}

function runLedgerExclusive<T>(
  registry: WeakMap<object, Map<string, Promise<void>>>,
  ledger: Ledger,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const tails = registry.get(ledger) ?? new Map<string, Promise<void>>();
  registry.set(ledger, tails);
  const previous = tails.get(key) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(() => undefined, () => undefined);
  tails.set(key, tail);
  return result.finally(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
}
