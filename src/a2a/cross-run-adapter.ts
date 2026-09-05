import type {
  AnyEvent,
  AppendEvent,
} from "../domain/events.js";
import { systemClock, type Clock } from "../domain/ports.js";
import type {
  ArtifactRef,
  CrossRunEndpoint,
  CrossRunEnvelope,
  Visibility,
} from "../domain/types.js";
import {
  computeEventContentHash,
  IdempotencyConflictError,
  type Ledger,
} from "../ledger/index.js";
import { sha256, stableJson } from "../ledger/hash.js";
import {
  A2AInbox,
  A2AProtocolError,
} from "./inbox.js";
import {
  assertCrossRunReceiptMatchesEnvelope,
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
  readonly turnId?: string;
  readonly laneId: string;
  readonly occurredAt: string;
  readonly causationId?: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly visibility: Visibility;
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
  /** Optional host verifier for the opaque attach/lease proof. */
  readonly verifySender?: (sender: CrossRunSenderIdentity) => boolean | Promise<boolean>;
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

/** DaemonHost.wake returns this richer shape; the adapter projects it to the
 * small CrossRunWake result while preserving the host-owned dedupe boundary. */
export interface CrossRunDaemonWakeResult {
  readonly status: "queued" | "duplicate";
  readonly admission: {
    readonly status: "admitted" | "duplicate";
    readonly inputId: string;
    readonly shouldActivate?: boolean;
  };
  /** Host-owned normalized wake; validated structurally before projection. */
  readonly wake: unknown;
}

export interface CrossRunHostWakeAdapterOptions {
  /** Host wake is injected so A2A does not become a second scheduler. */
  readonly wake: (
    request: CrossRunHostWakeRequest,
  ) => Promise<CrossRunHostWakeResult | CrossRunDaemonWakeResult>;
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
    if (scope === null || typeof scope !== "object" || Array.isArray(scope)
      || (Object.getPrototypeOf(scope) !== Object.prototype
        && Object.getPrototypeOf(scope) !== null)) {
      throw durableFactError("A2A fact read scope must be an object");
    }
    for (const key of Object.keys(scope)) {
      if (key !== "runId" && key !== "routeId") {
        throw durableFactError(`A2A fact read scope.${key} is not allowed`);
      }
    }
    if (scope.runId !== undefined) identifier(scope.runId, "scope.runId");
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
      const stored = await this.#ledger.append(factAppend(fact, this.#source));
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
      const events = await this.#ledger.read({ runId: this.#source.runId });
      if (!Array.isArray(events)) {
        throw new Error("invalid event list");
      }
      return events;
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
  readonly #verifySender: LedgerCrossRunTargetAdmissionOptions["verifySender"];

  constructor(options: LedgerCrossRunTargetAdmissionOptions) {
    assertOptions(options);
    assertLedger(options.ledger);
    this.#ledger = options.ledger;
    this.#target = normalizeEndpoint(options.target, "target");
    this.#verifySender = options.verifySender;
    this.#inbox = new A2AInbox({
      sink: this.#ledger,
      clock: options.clock ?? systemClock,
    });
  }

  admit(input: CrossRunTargetAdmissionInput): Promise<CrossRunTargetAdmissionResult> {
    return runLedgerExclusive(
      targetAdmissionTails,
      this.#ledger,
      runScope(this.#target),
      async () => this.#admit(await normalizeTargetAdmission(input, this.#target, this.#verifySender)),
    );
  }

  async #admit(
    input: CrossRunTargetAdmissionInput,
  ): Promise<CrossRunTargetAdmissionResult> {
    let events: readonly AnyEvent[];
    try {
      events = await this.#ledger.read({ runId: this.#target.runId });
      if (!Array.isArray(events)) {
        throw new Error("invalid event list");
      }
      this.#inbox.rehydrate(events);
    } catch (error: unknown) {
      if (error instanceof CrossRunProtocolError) throw error;
      throw durableFactError("Unable to rehydrate target Inbox");
    }
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
    if (options.clock !== undefined
      && (options.clock === null || typeof options.clock !== "object"
        || typeof options.clock.now !== "function")) {
      throw new CrossRunProtocolError("wake clock must implement now", "wake-failed");
    }
    this.#wake = options.wake;
    this.#target = normalizeEndpoint(options.target, "target");
    this.#clock = options.clock ?? systemClock;
  }

  async wake(input: CrossRunWakeInput): Promise<{
    readonly status: "queued" | "already-active" | "rejected";
    readonly retryAt?: string;
  }> {
    if (!plainRecord(input)) {
      throw new CrossRunProtocolError("Wake input must be an object", "wake-failed");
    }
    exactKeys(input, ["envelope", "targetMessageId"], "wake input", "wake-failed");
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
    let occurredAt: string;
    try {
      const now = this.#clock.now();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw new Error("invalid clock");
      }
      occurredAt = now.toISOString();
    } catch {
      throw new CrossRunProtocolError("Wake clock is invalid", "wake-failed");
    }
    const request: CrossRunHostWakeRequest = Object.freeze({
      runId: this.#target.runId,
      source: "a2a",
      dedupeKey: `a2a:wake:${identity}`,
      wakeId: `a2a-wake:${identity}`,
      inputId: `a2a-input:${identity}`,
      occurredAt,
    });
    let result: unknown;
    try {
      result = await this.#wake(structuredClone(request));
    } catch {
      throw new CrossRunProtocolError("Host wake failed", "wake-failed");
    }
    const normalized = normalizeHostWakeResult(result, request);
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
  if (!plainRecord(value)) {
    throw durableFactError("A2A outbox fact must be an object");
  }
  if (value.kind === "outbox.pending") {
    exactKeys(value, ["kind", "envelope", "recordedAt"], "fact", "durable-fact-failed");
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
    exactKeys(value, ["kind", "routeId", "messageId", "attemptId", "attemptedAt"], "fact", "durable-fact-failed");
    return Object.freeze({
      kind: value.kind,
      routeId: identifier(value.routeId, "fact.routeId"),
      messageId: identifier(value.messageId, "fact.messageId"),
      attemptId: identifier(value.attemptId, "fact.attemptId"),
      attemptedAt: dateTime(value.attemptedAt, "fact.attemptedAt"),
    });
  }
  if (value.kind === "outbox.receipt") {
    exactKeys(value, ["kind", "receipt"], "fact", "durable-fact-failed");
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
): AppendEvent<CrossRunOutboxEventType> {
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
  // A Run Ledger may contain source outboxes for several lanes. Each adapter
  // owns exactly one lane; unrelated lane facts must not block recovery here.
  const ownedEvents = events.filter((event) => (
    event.runId === source.runId && event.laneId === source.laneId
  ));
  for (const event of [...ownedEvents].sort((left, right) => left.globalOffset - right.globalOffset)) {
    const fact = factFromEvent(event, source);
    if (fact === undefined) continue;
    const identity = factIdentity(fact);
    const existing = identities.get(identity);
    if (existing !== undefined) {
      if (stableJson(existing) !== stableJson(fact)) {
        throw durableFactError("Conflicting A2A outbox facts exist in the Ledger");
      }
      continue;
    }
    assertFactPredecessor(fact, facts, source);
    identities.set(identity, fact);
    facts.push(fact);
  }
  return facts;
}

function factFromEvent(
  event: unknown,
  source: CrossRunEndpoint,
): CrossRunFact | undefined {
  if (!isCrossRunOutboxEventType(event)) return undefined;
  if (!isCrossRunOutboxEvent(event)) {
    throw durableFactError("A2A outbox event metadata is malformed");
  }
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
  if (event.turnId !== undefined
    || event.correlationId !== factCorrelationId(normalized)
    || event.idempotencyKey !== `a2a:outbox:${sha256(factIdentity(normalized))}`
    || event.visibility !== factVisibility(normalized)
    || (event.causationId ?? undefined) !== (factCausationId(normalized) ?? undefined)) {
    throw durableFactError("A2A outbox event provenance does not match its fact");
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
  const terminal = existing.find((candidate) => (
    candidate.kind === "outbox.receipt"
    && candidate.receipt.routeId === routeId
  ));
  if (terminal !== undefined) {
    throw new CrossRunProtocolError(
      "A2A route already has a terminal receipt",
      "idempotency-conflict",
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
  assertCrossRunReceiptMatchesEnvelope(receipt, pending.envelope);
  if (receipt.attemptId !== undefined) {
    const attempt = existing.find((candidate) => (
      candidate.kind === "outbox.attempted"
      && candidate.routeId === receipt.routeId
      && candidate.attemptId === receipt.attemptId
    ));
    if (attempt === undefined) {
      throw new CrossRunProtocolError(
        "A2A receipt references an unknown delivery attempt",
        "idempotency-conflict",
      );
    }
  }
}

export async function normalizeTargetAdmission(
  value: CrossRunTargetAdmissionInput,
  target: CrossRunEndpoint,
  verifySender?: (sender: CrossRunSenderIdentity) => boolean | Promise<boolean>,
): Promise<CrossRunTargetAdmissionInput> {
  if (!plainRecord(value)) {
    throw new CrossRunProtocolError("Target admission must be an object");
  }
  exactKeys(value, ["envelope", "message", "source"], "target admission");
  const envelope = normalizeEnvelope(value.envelope);
  const source = normalizeSenderIdentity(value.source);
  if (verifySender !== undefined) {
    let verified = false;
    try {
      verified = await verifySender(source);
    } catch {
      verified = false;
    }
    if (verified !== true) {
      throw new CrossRunProtocolError(
        "authenticated sender proof was rejected",
        "identity-forged",
      );
    }
  }
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
  if (source.relationshipGrants !== undefined
    && !source.relationshipGrants.includes(envelope.relationship)) {
    throw new CrossRunProtocolError(
      "Authenticated sender is not granted this route relationship",
      "authorization-denied",
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
      : { relationshipGrants: Object.freeze([...source.relationshipGrants]) }),
  });
}

function normalizeHostWakeResult(
  value: unknown,
  expectedRequest: CrossRunHostWakeRequest,
): CrossRunHostWakeResult {
  if (!plainRecord(value)) {
    throw new CrossRunProtocolError("Host wake returned an invalid result", "wake-failed");
  }
  exactKeys(
    value,
    ["status", "retryAt", "admission", "wake"],
    "host wake result",
    "wake-failed",
  );
  const candidate = value as Partial<CrossRunHostWakeResult>;
  if (
    candidate.status !== "queued"
    && candidate.status !== "duplicate"
    && candidate.status !== "already-active"
    && candidate.status !== "rejected"
  ) {
    throw new CrossRunProtocolError("Host wake returned an unsupported status", "wake-failed");
  }
  const daemonResult = value as Record<string, unknown>;
  const hasAdmission = Object.hasOwn(daemonResult, "admission");
  const hasWake = Object.hasOwn(daemonResult, "wake");
  if (hasAdmission !== hasWake
    || (hasAdmission && (!plainRecord(daemonResult.admission) || !plainRecord(daemonResult.wake)))) {
    throw new CrossRunProtocolError("Host wake returned an invalid daemon result", "wake-failed");
  }
  if (hasAdmission) {
    if (candidate.status !== "queued" && candidate.status !== "duplicate") {
      throw new CrossRunProtocolError(
        "Rich host wake returned an unsupported status",
        "wake-failed",
      );
    }
    const admission = daemonResult.admission as Record<string, unknown>;
    exactKeys(admission, ["status", "inputId", "shouldActivate"], "host wake admission", "wake-failed");
    if (admission.status !== "admitted" && admission.status !== "duplicate") {
      throw new CrossRunProtocolError("Host wake admission status is invalid", "wake-failed");
    }
    const admissionInputId = wakeIdentifier(admission.inputId, "host wake admission.inputId");
    if (admissionInputId !== expectedRequest.inputId) {
      throw new CrossRunProtocolError(
        "Host wake admission inputId does not match the generated wake",
        "identity-forged",
      );
    }
    if (admission.shouldActivate !== undefined && typeof admission.shouldActivate !== "boolean") {
      throw new CrossRunProtocolError("Host wake admission.shouldActivate is invalid", "wake-failed");
    }
    const expectedStatus = admission.status === "admitted" || admission.shouldActivate === true
      ? "queued"
      : "duplicate";
    if (candidate.status !== expectedStatus) {
      throw new CrossRunProtocolError(
        "Host wake status does not match its admission",
        "wake-failed",
      );
    }
    const wake = daemonResult.wake as Record<string, unknown>;
    exactKeys(
      wake,
      ["runId", "source", "dedupeKey", "wakeId", "inputId", "payloadRef", "occurredAt"],
      "host wake request",
      "wake-failed",
    );
    const wakeRunId = wakeIdentifier(wake.runId, "host wake request.runId");
    if (wakeRunId !== expectedRequest.runId) {
      throw new CrossRunProtocolError(
        "Host wake request runId does not match the target",
        "identity-forged",
      );
    }
    if (typeof wake.source !== "string") {
      throw new CrossRunProtocolError("Host wake request source is invalid", "wake-failed");
    }
    if (wake.source !== expectedRequest.source) {
      throw new CrossRunProtocolError(
        "Host wake request source does not match the generated wake",
        "identity-forged",
      );
    }
    const wakeDedupeKey = wakeIdentifier(wake.dedupeKey, "host wake request.dedupeKey");
    if (wakeDedupeKey !== expectedRequest.dedupeKey) {
      throw new CrossRunProtocolError(
        "Host wake request dedupeKey does not match the generated wake",
        "identity-forged",
      );
    }
    const wakeId = wakeIdentifier(wake.wakeId, "host wake request.wakeId");
    if (wakeId !== expectedRequest.wakeId) {
      throw new CrossRunProtocolError(
        "Host wake request wakeId does not match the generated wake",
        "identity-forged",
      );
    }
    const wakeInputId = wakeIdentifier(wake.inputId, "host wake request.inputId");
    if (wakeInputId !== expectedRequest.inputId) {
      throw new CrossRunProtocolError(
        "Host wake request inputId does not match the generated wake",
        "identity-forged",
      );
    }
    const wakeOccurredAt = wakeDateTime(wake.occurredAt, "host wake request.occurredAt");
    if (wakeOccurredAt !== expectedRequest.occurredAt) {
      throw new CrossRunProtocolError(
        "Host wake request occurredAt does not match the generated wake",
        "identity-forged",
      );
    }
    if (Object.hasOwn(wake, "payloadRef")) {
      // A host may attach a durable payload to the rich response. It is not
      // used by this adapter, but accepting it without validating the CAS
      // identity would let an untrusted daemon smuggle arbitrary metadata.
      normalizeWakePayloadRef(wake.payloadRef);
    }
  }
  return {
    status: candidate.status,
    ...(candidate.retryAt === undefined
      ? {}
      : { retryAt: wakeDateTime(candidate.retryAt, "wake.retryAt") }),
  };
}

function normalizeWakePayloadRef(value: unknown): ArtifactRef {
  if (!plainRecord(value)) {
    throw new CrossRunProtocolError(
      "Host wake request payloadRef must be an ArtifactRef",
      "wake-failed",
    );
  }
  exactKeys(
    value,
    ["id", "contentHash", "mediaType", "byteLength"],
    "host wake request.payloadRef",
    "wake-failed",
  );
  const id = wakeIdentifier(value.id, "host wake request.payloadRef.id");
  const contentHash = wakeIdentifier(
    value.contentHash,
    "host wake request.payloadRef.contentHash",
  );
  if (!/^sha256:[0-9a-f]{64}$/u.test(contentHash) || id !== contentHash) {
    throw new CrossRunProtocolError(
      "Host wake request payloadRef has an invalid content identity",
      "wake-failed",
    );
  }
  const mediaType = wakeIdentifier(value.mediaType, "host wake request.payloadRef.mediaType");
  if (!Number.isSafeInteger(value.byteLength) || (value.byteLength as number) < 0) {
    throw new CrossRunProtocolError(
      "Host wake request.payloadRef.byteLength is invalid",
      "wake-failed",
    );
  }
  return Object.freeze({
    id,
    contentHash,
    mediaType,
    byteLength: value.byteLength as number,
  });
}

function wakeIdentifier(value: unknown, field: string): string {
  try {
    return identifier(value, field);
  } catch (error: unknown) {
    throw new CrossRunProtocolError(
      error instanceof Error ? error.message : `${field} is invalid`,
      "wake-failed",
    );
  }
}

function wakeDateTime(value: unknown, field: string): string {
  const normalized = wakeIdentifier(value, field);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new CrossRunProtocolError(`${field} must be a valid date-time`, "wake-failed");
  }
  return normalized;
}

function isCrossRunOutboxEvent(event: unknown): event is CrossRunOutboxEvent {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    return false;
  }
  const candidate = event as Partial<CrossRunOutboxEvent> & {
    readonly schemaVersion?: unknown;
    readonly eventId?: unknown;
    readonly laneSeq?: unknown;
    readonly contentHash?: unknown;
  };
  if (!(
    (candidate.type === "a2a.outbox.pending"
      || candidate.type === "a2a.outbox.attempted"
      || candidate.type === "a2a.outbox.receipt")
    && candidate.schemaVersion === 1
    && typeof candidate.eventId === "string"
    && candidate.eventId.length > 0
    && !candidate.eventId.includes("\0")
    && typeof candidate.runId === "string"
    && candidate.runId.length > 0
    && !candidate.runId.includes("\0")
    && typeof candidate.laneId === "string"
    && candidate.laneId.length > 0
    && !candidate.laneId.includes("\0")
    && typeof candidate.occurredAt === "string"
    && typeof candidate.correlationId === "string"
    && typeof candidate.idempotencyKey === "string"
    && (candidate.visibility === "lane"
      || candidate.visibility === "run"
      || candidate.visibility === "user"
      || candidate.visibility === "sensitive")
    && (candidate.turnId === undefined || typeof candidate.turnId === "string")
    && (candidate.causationId === undefined || typeof candidate.causationId === "string")
    && Number.isSafeInteger(candidate.globalOffset)
    && (candidate.globalOffset as number) > 0
    && Number.isSafeInteger(candidate.laneSeq)
    && (candidate.laneSeq as number) > 0
    && typeof candidate.contentHash === "string"
    && /^sha256:[0-9a-f]{64}$/u.test(candidate.contentHash)
    && candidate.payload !== null
    && typeof candidate.payload === "object"
    && !Array.isArray(candidate.payload)
  )) {
    return false;
  }
  try {
    return candidate.contentHash === computeEventContentHash(candidate as AnyEvent);
  } catch {
    return false;
  }
}

function isCrossRunOutboxEventType(event: unknown): boolean {
  if (event === null || typeof event !== "object" || Array.isArray(event)) return false;
  const type = (event as { readonly type?: unknown }).type;
  return type === "a2a.outbox.pending"
    || type === "a2a.outbox.attempted"
    || type === "a2a.outbox.receipt";
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

function factCausationId(fact: CrossRunFact): string | undefined {
  if (fact.kind === "outbox.pending") return fact.envelope.causationId;
  if (fact.kind === "outbox.attempted") return fact.messageId;
  return fact.receipt.attemptId ?? fact.receipt.messageId;
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

function runScope(endpoint: CrossRunEndpoint): string {
  return stableJson([
    endpoint.workspaceId,
    endpoint.sessionId,
    endpoint.runId,
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

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  code: CrossRunProtocolError["code"] = "invalid-request",
): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) {
      throw new CrossRunProtocolError(`${path}.${key} is not allowed`, code);
    }
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

/** Compatibility names used by hosts that describe these as Ledger-backed adapters. */
export {
  LedgerCrossRunFactStore as LedgerBackedCrossRunFactStore,
  LedgerCrossRunTargetAdmission as LedgerBackedCrossRunTargetAdmission,
  CrossRunHostWakeAdapter as DaemonWakeCrossRunAdapter,
};
