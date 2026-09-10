import type { AnyEvent, EventEnvelope } from "../domain/events.js";
import type { Clock } from "../domain/ports.js";
import type {
  A2AMessage,
  A2APayload,
  ArtifactRef,
  CrossRunArtifactDelivery,
  CrossRunEnvelope,
  CrossRunEndpoint,
  CrossRunEndpointStatus,
  CrossRunReceipt,
  CrossRunReceiptReason,
  CrossRunReceiptStatus,
  CrossRunRelationship,
  CrossRunRoute,
  LaneId,
  RunId,
  SpawnContext,
  Visibility,
} from "../domain/types.js";
import {
  MAX_TASK_ATTEMPTS,
  MAX_TASK_MODEL_TOKENS,
  MAX_TASK_WALL_CLOCK_MS,
} from "../domain/types.js";
import { sha256, stableJson } from "../ledger/hash.js";
import {
  assertArtifactRef,
  verifyArtifact,
} from "../store/store.js";
import { validateSpawnContext } from "../runtime/lane-context.js";

/** Version of the host-to-host A2A contract. */
export const CROSS_RUN_PROTOCOL_VERSION = 1 as const;

/** Prime's useful 16 KiB bound, measured in UTF-8 bytes rather than chars. */
export const CROSS_RUN_MAX_INLINE_BYTES = 16 * 1024;
export const CROSS_RUN_MAX_BATCH = 16;
export const CROSS_RUN_MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
export const CROSS_RUN_MAX_STRING_LENGTH = 4_096;
export const CROSS_RUN_MAX_ENDPOINT_LENGTH = 512;

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const HASH = /^sha256:[0-9a-f]{64}$/u;
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u;

export class CrossRunProtocolError extends Error {
  override readonly name = "CrossRunProtocolError";
  readonly code: CrossRunProtocolErrorCode;

  constructor(
    message: string,
    code: CrossRunProtocolErrorCode = "invalid-request",
  ) {
    super(message);
    this.code = code;
  }
}

export type CrossRunProtocolErrorCode =
  | "invalid-request"
  | "identity-forged"
  | "selector-invalid"
  | "selector-ambiguous"
  | "authorization-denied"
  | "cross-workspace-denied"
  | "artifact-invalid"
  | "artifact-mismatch"
  | "artifact-integrity"
  | "capacity-rejected"
  | "rate-limited"
  | "expired"
  | "target-unavailable"
  | "target-admission-failed"
  | "wake-failed"
  | "durable-fact-failed"
  | "uncertain-side-effect"
  | "idempotency-conflict";

export type CrossRunPayload = A2APayload;

/**
 * Untrusted input accepted by the router. Sender identity, source endpoint,
 * auth/lease data and local paths are intentionally not fields here.
 */
export interface CrossRunSendRequest {
  readonly target: CrossRunTargetSelector;
  readonly payload: CrossRunPayload;
  readonly conversationId: string;
  readonly threadId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly visibility: Visibility;
  readonly priority: number;
  readonly createdAt?: string;
  readonly expiresAt?: string;
  readonly artifactRefs?: readonly ArtifactRef[];
  /** Optional causal message identity; it is still validated as data. */
  readonly causationId?: string;
}

export type CrossRunTargetSelector =
  | { readonly relationship: "parent" }
  | {
      readonly relationship: "sibling" | "child";
      readonly name?: string;
      readonly id?: string;
    }
  | {
      readonly relationship: "direct";
      readonly endpoint?: CrossRunEndpoint;
      readonly name?: string;
      readonly id?: string;
    };

/** Identity derived from an authenticated attach or worker lease. */
export interface CrossRunSenderIdentity {
  readonly endpoint: CrossRunEndpoint;
  /** Host-derived proof. It is opaque and never serialized or echoed. */
  readonly proof: CrossRunAuthProof;
  /** Optional relationship grants supplied by the host, not by the model. */
  readonly relationshipGrants?: readonly CrossRunRelationship[];
}

export type CrossRunAuthProof =
  | { readonly kind: "attach"; readonly authenticated: true; readonly token: string }
  | { readonly kind: "lease"; readonly authenticated: true; readonly token: string };

export interface CrossRunRosterEntry {
  readonly endpoint: CrossRunEndpoint;
  readonly name?: string;
  readonly relationship: CrossRunRelationship;
  readonly status: CrossRunEndpointStatus;
  readonly reachable: boolean;
}

export interface CrossRunRoster {
  readonly current: CrossRunEndpoint;
  readonly entries: readonly CrossRunRosterEntry[];
}

export interface CrossRunTargetAdmissionInput {
  readonly envelope: CrossRunEnvelope;
  readonly message: A2AMessage;
  readonly source: CrossRunSenderIdentity;
}

export type CrossRunTargetAdmissionResult =
  | {
      readonly status: "accepted" | "queued" | "delivered" | "handled" | "duplicate";
      readonly messageId?: string;
      readonly retryAt?: string;
    }
  | {
      readonly status: "rejected";
      readonly reason?: CrossRunReceiptReason;
      readonly retryAt?: string;
    };

export interface CrossRunTargetAdmission {
  admit(input: CrossRunTargetAdmissionInput):
    Promise<CrossRunTargetAdmissionResult>;
}

export interface CrossRunTargetResolver {
  resolve(
    selector: CrossRunTargetSelector,
    source: CrossRunSenderIdentity,
  ): Promise<CrossRunResolvedTarget>;
}

export interface CrossRunResolvedTarget {
  readonly endpoint: CrossRunEndpoint;
  readonly relationship: CrossRunRelationship;
  readonly name?: string;
  readonly status?: CrossRunEndpointStatus;
  readonly reachable?: boolean;
}

export interface CrossRunRosterResolver {
  list(source: CrossRunSenderIdentity): Promise<CrossRunRoster>;
}

export interface CrossRunAuthorizationInput {
  readonly source: CrossRunSenderIdentity;
  readonly target: CrossRunEndpoint;
  readonly relationship: CrossRunRelationship;
  readonly operation: "send" | "recover";
}

export type CrossRunAuthorization =
  | { readonly allowed: true; readonly reauthenticated?: boolean }
  | {
      readonly allowed: false;
      readonly reason?: CrossRunReceiptReason;
      readonly reauthenticated?: boolean;
    };

export interface CrossRunAuthorizer {
  authorize(input: CrossRunAuthorizationInput):
    Promise<CrossRunAuthorization>;
}

export interface CrossRunArtifactRelayInput {
  readonly source: CrossRunEndpoint;
  readonly target: CrossRunEndpoint;
  readonly sourceRef: ArtifactRef;
  readonly visibility: Visibility;
}

export interface CrossRunArtifactRelay {
  relay(input: CrossRunArtifactRelayInput): Promise<CrossRunArtifactDelivery>;
}

export interface CrossRunWakeInput {
  readonly envelope: CrossRunEnvelope;
  readonly targetMessageId: string;
}

export interface CrossRunWake {
  wake(input: CrossRunWakeInput): Promise<{
    readonly status: "queued" | "already-active" | "rejected";
    readonly retryAt?: string;
  }>;
}

/** A bounded admission/rate signal supplied by the host. */
export interface CrossRunAdmissionPolicy {
  check(input: {
    readonly source: CrossRunEndpoint;
    readonly target: CrossRunEndpoint;
    readonly envelope: CrossRunEnvelope;
  }): Promise<CrossRunAdmissionDecision>;
}

export type CrossRunAdmissionDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: "target-capacity" | "rate-limited";
      readonly retryAt?: string;
    };

/**
 * Durable saga facts. The default implementation can be backed by a Ledger
 * bridge; keeping this port separate lets S6 bind source/target writers
 * without introducing a second queue or database in this lane.
 */
export type CrossRunFact =
  | {
      readonly kind: "outbox.pending";
      readonly envelope: CrossRunEnvelope;
      readonly recordedAt: string;
    }
  | {
      readonly kind: "outbox.attempted";
      readonly routeId: string;
      readonly messageId: string;
      readonly attemptId: string;
      readonly attemptedAt: string;
    }
  | {
      readonly kind: "outbox.receipt";
      readonly receipt: CrossRunReceipt;
    };

export interface CrossRunFactStore {
  append(fact: CrossRunFact): Promise<void>;
  read(scope?: { readonly runId?: RunId; readonly routeId?: string }):
    Promise<readonly CrossRunFact[]>;
}

/** Strictly validate and clone one durable saga fact before storing it. */
export function normalizeCrossRunFact(value: unknown): CrossRunFact {
  if (!isRecord(value)) {
    throw new CrossRunProtocolError("A2A fact must be an object", "durable-fact-failed");
  }
  if (value.kind === "outbox.pending") {
    exactKeys(value, ["kind", "envelope", "recordedAt"], "fact");
    return {
      kind: value.kind,
      envelope: normalizeEnvelope(value.envelope),
      recordedAt: dateTime(value.recordedAt, "fact.recordedAt"),
    };
  }
  if (value.kind === "outbox.attempted") {
    exactKeys(value, ["kind", "routeId", "messageId", "attemptId", "attemptedAt"], "fact");
    return {
      kind: value.kind,
      routeId: boundedString(value.routeId, "fact.routeId", false),
      messageId: boundedString(value.messageId, "fact.messageId", false),
      attemptId: boundedString(value.attemptId, "fact.attemptId", false),
      attemptedAt: dateTime(value.attemptedAt, "fact.attemptedAt"),
    };
  }
  if (value.kind === "outbox.receipt") {
    exactKeys(value, ["kind", "receipt"], "fact");
    return { kind: value.kind, receipt: normalizeReceipt(value.receipt) };
  }
  throw new CrossRunProtocolError("A2A fact kind is unsupported", "durable-fact-failed");
}

/** Deterministic in-memory reference store for offline tests and composition. */
export class MemoryCrossRunFactStore implements CrossRunFactStore {
  readonly #facts: CrossRunFact[] = [];
  #closed = false;

async append(fact: CrossRunFact): Promise<void> {
    this.assertOpen();
    const copy = normalizeCrossRunFact(fact);
    const identity = factIdentity(copy);
    const existing = this.#facts.find((candidate) => factIdentity(candidate) === identity);
    if (existing !== undefined) {
      if (stableJson(existing) !== stableJson(copy)) {
        throw new CrossRunProtocolError(
          "Durable A2A fact conflicts with an existing identity",
          "idempotency-conflict",
        );
      }
      return;
    }
    assertFactPredecessor(copy, this.#facts);
    this.#facts.push(copy);
  }

  async read(scope: { readonly runId?: RunId; readonly routeId?: string } = {}): Promise<readonly CrossRunFact[]> {
    this.assertOpen();
    if (scope === null || typeof scope !== "object" || Array.isArray(scope)
      || Object.getPrototypeOf(scope) !== Object.prototype
      && Object.getPrototypeOf(scope) !== null) {
      throw new CrossRunProtocolError("A2A fact read scope must be an object", "durable-fact-failed");
    }
    for (const key of Object.keys(scope)) {
      if (key !== "runId" && key !== "routeId") {
        throw new CrossRunProtocolError(`fact read scope.${key} is not allowed`, "durable-fact-failed");
      }
    }
    const runId = scope.runId === undefined
      ? undefined
      : boundedString(scope.runId, "fact read scope.runId", false, CROSS_RUN_MAX_ENDPOINT_LENGTH);
    const routeId = scope.routeId === undefined
      ? undefined
      : boundedString(scope.routeId, "fact read scope.routeId", false);
    const sourceRunByRoute = new Map<string, RunId>();
    for (const fact of this.#facts) {
      if (fact.kind === "outbox.pending") {
        sourceRunByRoute.set(fact.envelope.routeId, fact.envelope.source.runId);
      }
    }
    return this.#facts
      .filter((fact) => {
        const envelope = fact.kind === "outbox.pending" ? fact.envelope : undefined;
        const factRouteId = fact.kind === "outbox.pending" ? fact.envelope.routeId
          : fact.kind === "outbox.receipt" ? fact.receipt.routeId : fact.routeId;
        const factRunId = envelope?.source.runId
          ?? (fact.kind === "outbox.receipt" ? fact.receipt.source.runId : undefined)
          ?? (fact.kind === "outbox.attempted" ? sourceRunByRoute.get(fact.routeId) : undefined);
        return (routeId === undefined || routeId === factRouteId)
          && (runId === undefined || runId === factRunId);
      })
      .map(clone);
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  private assertOpen(): void {
    if (this.#closed) throw new CrossRunProtocolError("A2A fact store is closed", "durable-fact-failed");
  }
}

export interface CrossRunFactEventMarker {
  readonly protocolVersion: typeof CROSS_RUN_PROTOCOL_VERSION;
  readonly kind: CrossRunFact["kind"];
  readonly envelope?: CrossRunEnvelope;
  readonly recordedAt?: string;
  readonly routeId?: string;
  readonly messageId?: string;
  readonly attemptId?: string;
  readonly attemptedAt?: string;
  readonly receipt?: CrossRunReceipt;
}

/** Convert a durable fact to a redaction-safe, deterministic event marker. */
export function crossRunFactMarker(fact: CrossRunFact): CrossRunFactEventMarker {
  if (fact.kind === "outbox.pending") {
    return {
      protocolVersion: CROSS_RUN_PROTOCOL_VERSION,
      kind: fact.kind,
      envelope: clone(fact.envelope),
      recordedAt: fact.recordedAt,
    };
  }
  if (fact.kind === "outbox.attempted") {
    return {
      protocolVersion: CROSS_RUN_PROTOCOL_VERSION,
      kind: fact.kind,
      routeId: fact.routeId,
      messageId: fact.messageId,
      attemptId: fact.attemptId,
      attemptedAt: fact.attemptedAt,
    };
  }
  return {
    protocolVersion: CROSS_RUN_PROTOCOL_VERSION,
    kind: fact.kind,
    receipt: clone(fact.receipt),
  };
}

export function crossRunFactFromMarker(value: unknown): CrossRunFact | undefined {
  if (!isRecord(value) || value.protocolVersion !== CROSS_RUN_PROTOCOL_VERSION) return undefined;
  if (value.kind === "outbox.pending" && isRecord(value.envelope)
    && typeof value.recordedAt === "string") {
    exactKeys(value, ["protocolVersion", "kind", "envelope", "recordedAt"], "fact");
    return {
      kind: "outbox.pending",
      envelope: normalizeEnvelope(value.envelope),
      recordedAt: dateTime(value.recordedAt, "fact.recordedAt"),
    };
  }
  if (value.kind === "outbox.attempted"
    && typeof value.routeId === "string"
    && typeof value.messageId === "string"
    && typeof value.attemptId === "string"
    && typeof value.attemptedAt === "string") {
    exactKeys(value, ["protocolVersion", "kind", "routeId", "messageId", "attemptId", "attemptedAt"], "fact");
    return {
      kind: "outbox.attempted",
      routeId: boundedString(value.routeId, "fact.routeId", false),
      messageId: boundedString(value.messageId, "fact.messageId", false),
      attemptId: boundedString(value.attemptId, "fact.attemptId", false),
      attemptedAt: dateTime(value.attemptedAt, "fact.attemptedAt"),
    };
  }
  if (value.kind === "outbox.receipt" && isRecord(value.receipt)) {
    exactKeys(value, ["protocolVersion", "kind", "receipt"], "fact");
    return {
      kind: "outbox.receipt",
      receipt: normalizeReceipt(value.receipt),
    };
  }
  return undefined;
}

/**
 * Build the ordinary A2A message used by the target Inbox. The extra fields
 * are optional domain metadata; old in-process lanes ignore them safely.
 */
export function envelopeToA2AMessage(envelope: CrossRunEnvelope): A2AMessage {
  return {
    messageId: envelope.messageId,
    runId: envelope.target.runId,
    conversationId: envelope.conversationId,
    threadId: envelope.threadId,
    from: envelope.source.laneId,
    to: envelope.target.laneId,
    createdAt: envelope.createdAt,
    ...(envelope.expiresAt === undefined ? {} : { expiresAt: envelope.expiresAt }),
    ...(envelope.causationId === undefined ? {} : { causationId: envelope.causationId }),
    correlationId: envelope.correlationId,
    idempotencyKey: envelope.idempotencyKey,
    visibility: envelope.visibility,
    priority: envelope.priority,
    delivery: "next-step",
    payload: clone(envelope.payload) as A2APayload,
    routeId: envelope.routeId,
    routeRelationship: envelope.relationship,
    routeArtifacts: clone([...envelope.artifacts]),
    sourceEndpoint: clone(envelope.source),
    targetEndpoint: clone(envelope.target),
  };
}

export function createCrossRunRouteId(
  source: CrossRunEndpoint,
  target: CrossRunEndpoint,
  idempotencyKey: string,
): string {
  return `a2a-route:${sha256(stableJson({ source, target, idempotencyKey }))}`;
}

export function createCrossRunMessageId(
  routeId: string,
  request: Pick<CrossRunSendRequest, "payload" | "conversationId" | "threadId" | "correlationId" | "visibility" | "priority" | "expiresAt" | "artifactRefs" | "causationId">,
): string {
  return `a2a-message:${sha256(stableJson({
    routeId,
    payload: request.payload,
    conversationId: request.conversationId,
    threadId: request.threadId,
    correlationId: request.correlationId,
    visibility: request.visibility,
    priority: request.priority,
    expiresAt: request.expiresAt,
    artifactRefs: dedupeArtifactRefs([
      ...payloadArtifactRefs(request.payload),
      ...(request.artifactRefs ?? []),
    ]),
    causationId: request.causationId,
  }))}`;
}

export function createCrossRunReceiptId(
  routeId: string,
  status: CrossRunReceiptStatus,
): string {
  return `a2a-receipt:${sha256(`${routeId}\u0000${status}`)}`;
}

/** Normalize and strictly validate an untrusted sender-independent request. */
export function normalizeCrossRunSendRequest(
  value: unknown,
  options: { readonly now?: Date; readonly maxInlineBytes?: number } = {},
): CrossRunSendRequest {
  const item = plainObject(value, "request");
  exactKeys(item, [
    "target",
    "payload",
    "conversationId",
    "threadId",
    "correlationId",
    "idempotencyKey",
    "visibility",
    "priority",
    "createdAt",
    "expiresAt",
    "artifactRefs",
    "causationId",
  ], "request");
  const target = normalizeTarget(item.target);
  const payload = normalizePayload(item.payload);
  const conversationId = boundedString(item.conversationId, "conversationId", false);
  const threadId = boundedString(item.threadId, "threadId", false);
  const correlationId = boundedString(item.correlationId, "correlationId", false);
  const idempotencyKey = boundedString(item.idempotencyKey, "idempotencyKey", false);
  const visibility = oneOf(item.visibility, "visibility", ["lane", "run", "user", "sensitive"] as const);
  if (!Number.isSafeInteger(item.priority) || (item.priority as number) < 0 || (item.priority as number) > 100) {
    throw new CrossRunProtocolError("priority must be a safe integer between 0 and 100");
  }
  const now = options.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new CrossRunProtocolError("request clock must be a valid date");
  }
  const createdAt = item.createdAt === undefined ? now.toISOString() : dateTime(item.createdAt, "createdAt");
  if (Date.parse(createdAt) > now.getTime() + CROSS_RUN_MAX_FUTURE_SKEW_MS) {
    throw new CrossRunProtocolError("createdAt is too far in the future");
  }
  const expiresAt = item.expiresAt === undefined ? undefined : dateTime(item.expiresAt, "expiresAt");
  if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new CrossRunProtocolError("expiresAt must be later than createdAt");
  }
  validateTaskDeadline(payload, createdAt);
  const causationId = item.causationId === undefined
    ? undefined
    : boundedString(item.causationId, "causationId", false);
  const artifactRefs = dedupeArtifactRefs([
    ...payloadArtifactRefs(payload),
    ...normalizeArtifactRefs(item.artifactRefs, "artifactRefs"),
  ]);
  const inlineBytes = inlinePayloadBytes(payload);
  const maxInlineBytes = options.maxInlineBytes ?? CROSS_RUN_MAX_INLINE_BYTES;
  if (!Number.isSafeInteger(maxInlineBytes)
    || maxInlineBytes <= 0
    || maxInlineBytes > CROSS_RUN_MAX_INLINE_BYTES) {
    throw new CrossRunProtocolError(
      `maxInlineBytes must be a positive integer <= ${CROSS_RUN_MAX_INLINE_BYTES}`,
    );
  }
  if (inlineBytes > maxInlineBytes) {
    throw new CrossRunProtocolError(
      `inline payload exceeds ${maxInlineBytes} UTF-8 bytes; move large content to ArtifactRef`,
      "artifact-invalid",
    );
  }
  return {
    target,
    payload,
    conversationId,
    threadId,
    correlationId,
    idempotencyKey,
    visibility,
    priority: item.priority as number,
    // The normalized form is trusted by the router and must carry the exact
    // clock sample used for validation. Omitting this field here would make a
    // later router read the clock again, which can invalidate task deadlines
    // and make the durable pending envelope differ from the admitted request.
    createdAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(artifactRefs.length === 0 ? {} : { artifactRefs }),
    ...(causationId === undefined ? {} : { causationId }),
  };
}

export function normalizeSenderIdentity(value: unknown): CrossRunSenderIdentity {
  const item = plainObject(value, "sender");
  exactKeys(item, ["endpoint", "proof", "relationshipGrants"], "sender");
  const endpoint = normalizeEndpoint(item.endpoint, "sender.endpoint");
  const proof = normalizeProof(item.proof);
  const grants = item.relationshipGrants === undefined
    ? undefined
    : normalizeRelationships(item.relationshipGrants, "relationshipGrants");
  return Object.freeze({
    endpoint,
    proof,
    ...(grants === undefined ? {} : { relationshipGrants: grants }),
  });
}

export function normalizeEndpoint(value: unknown, path = "endpoint"): CrossRunEndpoint {
  const item = plainObject(value, path);
  exactKeys(item, ["workspaceId", "sessionId", "runId", "laneId"], path);
  return Object.freeze({
    workspaceId: boundedString(item.workspaceId, `${path}.workspaceId`, false, CROSS_RUN_MAX_ENDPOINT_LENGTH),
    sessionId: boundedString(item.sessionId, `${path}.sessionId`, false, CROSS_RUN_MAX_ENDPOINT_LENGTH),
    runId: boundedString(item.runId, `${path}.runId`, false, CROSS_RUN_MAX_ENDPOINT_LENGTH),
    laneId: boundedString(item.laneId, `${path}.laneId`, false, CROSS_RUN_MAX_ENDPOINT_LENGTH),
  });
}

export function normalizeTarget(value: unknown): CrossRunTargetSelector {
  const item = plainObject(value, "target");
  const relationship = oneOf(item.relationship, "target.relationship", ["parent", "sibling", "child", "direct"] as const);
  if (relationship === "parent") {
    exactKeys(item, ["relationship"], "target");
    return { relationship };
  }
  exactKeys(item, ["relationship", "name", "id", "endpoint"], "target");
  const name = item.name === undefined ? undefined : boundedSelector(item.name, "target.name");
  const id = item.id === undefined ? undefined : boundedSelector(item.id, "target.id");
  const endpoint = item.endpoint === undefined ? undefined : normalizeEndpoint(item.endpoint, "target.endpoint");
  if (relationship !== "direct" && endpoint !== undefined) {
    throw new CrossRunProtocolError("parent/sibling/child selectors cannot carry an endpoint", "selector-invalid");
  }
  if (relationship === "direct" && endpoint === undefined && name === undefined && id === undefined) {
    throw new CrossRunProtocolError("direct selector requires endpoint, name, or id", "selector-invalid");
  }
  if (relationship !== "direct" && name === undefined && id === undefined) {
    throw new CrossRunProtocolError(`${relationship} selector requires name or id`, "selector-invalid");
  }
  return {
    relationship,
    ...(name === undefined ? {} : { name }),
    ...(id === undefined ? {} : { id }),
    ...(endpoint === undefined ? {} : { endpoint }),
  } as CrossRunTargetSelector;
}

export function normalizeEnvelope(value: unknown): CrossRunEnvelope {
  const item = plainObject(value, "envelope");
  exactKeys(item, [
    "protocolVersion",
    "messageId",
    "routeId",
    "source",
    "target",
    "relationship",
    "conversationId",
    "threadId",
    "correlationId",
    "idempotencyKey",
    "createdAt",
    "expiresAt",
    "causationId",
    "visibility",
    "priority",
    "payload",
    "artifacts",
  ], "envelope");
  const protocolVersion = item.protocolVersion;
  if (protocolVersion !== CROSS_RUN_PROTOCOL_VERSION) throw new CrossRunProtocolError("unsupported A2A protocol version");
  const source = normalizeEndpoint(item.source, "envelope.source");
  const target = normalizeEndpoint(item.target, "envelope.target");
  const relationship = oneOf(item.relationship, "envelope.relationship", ["parent", "sibling", "child", "direct"] as const);
  if (sameEndpoint(source, target)) {
    throw new CrossRunProtocolError("envelope source and target must differ", "identity-forged");
  }
  const visibility = oneOf(item.visibility, "envelope.visibility", ["lane", "run", "user", "sensitive"] as const);
  const payload = normalizePayload(item.payload);
  if (inlinePayloadBytes(payload) > CROSS_RUN_MAX_INLINE_BYTES) {
    throw new CrossRunProtocolError(
      `envelope inline payload exceeds ${CROSS_RUN_MAX_INLINE_BYTES} UTF-8 bytes; move large content to ArtifactRef`,
      "artifact-invalid",
    );
  }
  const artifacts = normalizeArtifactDeliveries(item.artifacts, target.workspaceId);
  for (const payloadRef of payloadArtifactRefs(payload)) {
    if (!artifacts.some((artifact) => sameArtifactRef(artifact.sourceRef, payloadRef))) {
      throw new CrossRunProtocolError(
        "payload ArtifactRef is missing from envelope delivery metadata",
        "artifact-mismatch",
      );
    }
  }
  if (artifacts.some((artifact) => artifact.visibility !== visibility)) {
    throw new CrossRunProtocolError(
      "artifact visibility must match envelope visibility",
      "artifact-mismatch",
    );
  }
  const createdAt = dateTime(item.createdAt, "envelope.createdAt");
  const expiresAt = item.expiresAt === undefined ? undefined : dateTime(item.expiresAt, "envelope.expiresAt");
  if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new CrossRunProtocolError("envelope.expiresAt must be later than createdAt");
  }
  validateTaskDeadline(payload, createdAt);
  const messageId = boundedString(item.messageId, "envelope.messageId", false);
  const routeId = boundedString(item.routeId, "envelope.routeId", false);
  const idempotencyKey = boundedString(item.idempotencyKey, "envelope.idempotencyKey", false);
  const expectedRouteId = createCrossRunRouteId(source, target, idempotencyKey);
  if (routeId !== expectedRouteId) {
    throw new CrossRunProtocolError(
      "envelope routeId does not match its endpoints and idempotency key",
      "identity-forged",
    );
  }
  const expectedMessageId = createCrossRunMessageId(routeId, {
    payload,
    conversationId: boundedString(item.conversationId, "envelope.conversationId", false),
    threadId: boundedString(item.threadId, "envelope.threadId", false),
    correlationId: boundedString(item.correlationId, "envelope.correlationId", false),
    visibility,
    priority: boundedPriority(item.priority, "envelope.priority"),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(item.causationId === undefined ? {} : { causationId: boundedString(item.causationId, "envelope.causationId", false) }),
    artifactRefs: artifacts.map((artifact) => artifact.sourceRef),
  });
  if (messageId !== expectedMessageId) {
    throw new CrossRunProtocolError(
      "envelope messageId does not match its logical content",
      "identity-forged",
    );
  }
  return Object.freeze({
    protocolVersion,
    messageId,
    routeId,
    source,
    target,
    relationship,
    conversationId: boundedString(item.conversationId, "envelope.conversationId", false),
    threadId: boundedString(item.threadId, "envelope.threadId", false),
    correlationId: boundedString(item.correlationId, "envelope.correlationId", false),
    idempotencyKey,
    createdAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(item.causationId === undefined ? {} : { causationId: boundedString(item.causationId, "envelope.causationId", false) }),
    visibility,
    priority: boundedPriority(item.priority, "envelope.priority"),
    payload,
    artifacts: [...artifacts],
  });
}

export function normalizeReceipt(value: unknown): CrossRunReceipt {
  const item = plainObject(value, "receipt");
  exactKeys(item, [
    "protocolVersion",
    "receiptId",
    "routeId",
    "messageId",
    "idempotencyKey",
    "source",
    "target",
    "relationship",
    "status",
    "recordedAt",
    "targetMessageId",
    "attemptId",
    "reason",
    "retryAt",
    "diagnostic",
  ], "receipt");
  if (item.protocolVersion !== CROSS_RUN_PROTOCOL_VERSION) {
    throw new CrossRunProtocolError("unsupported A2A receipt protocol version");
  }
  const source = normalizeEndpoint(item.source, "receipt.source");
  const target = normalizeEndpoint(item.target, "receipt.target");
  if (sameEndpoint(source, target)) {
    throw new CrossRunProtocolError("receipt source and target must differ", "identity-forged");
  }
  const status = oneOf(item.status, "receipt.status", [
    "accepted", "queued", "delivered", "handled", "duplicate", "expired", "rejected", "uncertain", "conflict",
  ] as const);
  const reason = item.reason === undefined ? undefined : oneOf(item.reason, "receipt.reason", [
    "authorization-denied",
    "cross-workspace-reauthentication-required",
    "target-capacity",
    "rate-limited",
    "stale-lease",
    "target-unavailable",
    "artifact-rejected",
    "artifact-integrity",
    "wake-failed",
    "target-admission-failed",
    "source-receipt-failed",
    "delivery-attempt-without-receipt",
    "idempotency-conflict",
    "expired",
  ] as const);
  if (status === "expired" && reason !== "expired") {
    throw new CrossRunProtocolError(
      "expired receipts must carry the expired reason",
      "idempotency-conflict",
    );
  }
  if (status === "conflict" && reason !== "idempotency-conflict") {
    throw new CrossRunProtocolError(
      "conflict receipts must carry the idempotency-conflict reason",
      "idempotency-conflict",
    );
  }
  if ((status === "rejected" || status === "uncertain") && reason === undefined) {
    throw new CrossRunProtocolError(
      `${status} receipts must carry a reason`,
      "idempotency-conflict",
    );
  }
  const receiptId = boundedString(item.receiptId, "receipt.receiptId", false);
  const routeId = boundedString(item.routeId, "receipt.routeId", false);
  const idempotencyKey = boundedString(item.idempotencyKey, "receipt.idempotencyKey", false);
  if (routeId !== createCrossRunRouteId(source, target, idempotencyKey)) {
    throw new CrossRunProtocolError("receipt routeId does not match its route", "identity-forged");
  }
  if (receiptId !== createCrossRunReceiptId(routeId, status)) {
    throw new CrossRunProtocolError("receiptId does not match receipt status and route", "identity-forged");
  }
  return Object.freeze({
    protocolVersion: CROSS_RUN_PROTOCOL_VERSION,
    receiptId,
    routeId,
    messageId: boundedString(item.messageId, "receipt.messageId", false),
    idempotencyKey,
    source,
    target,
    relationship: oneOf(item.relationship, "receipt.relationship", ["parent", "sibling", "child", "direct"] as const),
    status,
    recordedAt: dateTime(item.recordedAt, "receipt.recordedAt"),
    ...(item.targetMessageId === undefined ? {} : { targetMessageId: boundedString(item.targetMessageId, "receipt.targetMessageId", false) }),
    ...(item.attemptId === undefined ? {} : { attemptId: boundedString(item.attemptId, "receipt.attemptId", false) }),
    ...(reason === undefined ? {} : { reason }),
    ...(item.retryAt === undefined ? {} : { retryAt: dateTime(item.retryAt, "receipt.retryAt") }),
    ...(item.diagnostic === undefined ? {} : { diagnostic: boundedString(item.diagnostic, "receipt.diagnostic", true, 512) }),
  });
}

/**
 * Bind a receipt to the trusted envelope that created its route. A receipt is
 * intentionally compact and cannot derive this relationship from its own
 * fields alone, so durable consumers should call this assertion before using
 * an independently supplied receipt.
 */
export function assertCrossRunReceiptMatchesEnvelope(
  receiptInput: unknown,
  envelopeInput: unknown,
): void {
  const receipt = normalizeReceipt(receiptInput);
  const envelope = normalizeEnvelope(envelopeInput);
  if (
    receipt.routeId !== envelope.routeId
    || receipt.messageId !== envelope.messageId
    || receipt.idempotencyKey !== envelope.idempotencyKey
    || !sameEndpoint(receipt.source, envelope.source)
    || !sameEndpoint(receipt.target, envelope.target)
    || receipt.relationship !== envelope.relationship
  ) {
    throw new CrossRunProtocolError(
      "receipt does not match its trusted envelope",
      "idempotency-conflict",
    );
  }
}

export const validateCrossRunReceiptAgainstEnvelope = assertCrossRunReceiptMatchesEnvelope;

export function validateCrossRunSendRequest(
  value: unknown,
  options: { readonly now?: Date; readonly maxInlineBytes?: number } = {},
): void {
  normalizeCrossRunSendRequest(value, options);
}

export function inlinePayloadBytes(value: unknown): number {
  return inlinePayloadBytesAt(value, true);
}

function inlinePayloadBytesAt(value: unknown, root: boolean): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + inlinePayloadBytesAt(item, false), 0);
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).reduce((sum, [key, item]) => {
      // Only the top-level discriminator is protocol overhead. A nested
      // `type` key is payload data and must count toward the transport bound.
      return sum + (root && key === "type" ? 0 : inlinePayloadBytesAt(item, false));
    }, 0);
  }
  return 0;
}

export function endpointKey(endpoint: CrossRunEndpoint): string {
  return stableJson([endpoint.workspaceId, endpoint.sessionId, endpoint.runId, endpoint.laneId]);
}

export function sameEndpoint(left: CrossRunEndpoint, right: CrossRunEndpoint): boolean {
  return endpointKey(left) === endpointKey(right);
}

export function sameLogicalEnvelope(left: CrossRunEnvelope, right: CrossRunEnvelope): boolean {
  return stableJson(logicalEnvelope(left)) === stableJson(logicalEnvelope(right));
}

export function routeFromEnvelope(envelope: CrossRunEnvelope): CrossRunRoute {
  return {
    routeId: envelope.routeId,
    source: clone(envelope.source),
    target: clone(envelope.target),
    relationship: envelope.relationship,
    artifacts: clone([...envelope.artifacts]),
  };
}

export function verifyCrossRunArtifact(
  bytes: Uint8Array,
  ref: ArtifactRef,
): void {
  try {
    if (!(bytes instanceof Uint8Array)) {
      throw new CrossRunProtocolError("artifact bytes must be a Uint8Array", "artifact-integrity");
    }
    const normalized = normalizeArtifactRefs([ref], "artifactRef")[0]!;
    assertArtifactRef(normalized);
    verifyArtifact(bytes, normalized);
  } catch (error: unknown) {
    throw new CrossRunProtocolError(
      error instanceof Error ? error.message : "artifact integrity check failed",
      "artifact-integrity",
    );
  }
}

function normalizeProof(value: unknown): CrossRunAuthProof {
  const item = plainObject(value, "sender.proof");
  exactKeys(item, ["kind", "authenticated", "token"], "sender.proof");
  const kind = oneOf(item.kind, "sender.proof.kind", ["attach", "lease"] as const);
  if (item.authenticated !== true) throw new CrossRunProtocolError("sender proof is not authenticated", "identity-forged");
  const token = boundedString(item.token, "sender.proof.token", false, 4_096);
  return Object.freeze({ kind, authenticated: true, token });
}

function normalizePayload(value: unknown): CrossRunPayload {
  const item = plainObject(value, "payload");
  const type = oneOf(item.type, "payload.type", [
    "advice.propose",
    "task.request",
    "task.accept",
    "task.result",
    "task.failed",
    "question.ask",
    "question.answer",
    "message.inform",
  ] as const);
  const allowed = new Set<string>(["type"]);
  for (const key of payloadKeys(type)) allowed.add(key);
  for (const key of Object.keys(item)) {
    if (!allowed.has(key)) throw new CrossRunProtocolError(`payload.${key} is not allowed`);
  }
  if (type === "message.inform" || type === "question.ask" || type === "question.answer") {
    const field = type === "message.inform" ? "text" : type === "question.ask" ? "question" : "answer";
    return {
      type,
      // Validate a generous code-unit bound first, then enforce the actual
      // transport limit below using UTF-8 bytes. ASCII payloads just over the
      // boundary should report the byte-limit error rather than a misleading
      // character-count error.
      [field]: boundedMessageText(item[field], `payload.${field}`),
    } as unknown as CrossRunPayload;
  }
  switch (type) {
    case "advice.propose":
      return { type, advice: normalizeAdvice(item.advice, "payload.advice") };
    case "task.request":
      if (item.inputRefs === undefined) {
        throw new CrossRunProtocolError("payload.inputRefs must be present");
      }
      return {
        type,
        taskId: normalizeTaskId(item.taskId, "payload.taskId"),
        goal: normalizeGoal(item.goal, "payload.goal"),
        inputRefs: normalizeArtifactRefs(item.inputRefs, "payload.inputRefs"),
        budget: normalizeTaskBudget(item.budget, "payload.budget"),
        ...(item.spawnContext === undefined
          ? {}
          : { spawnContext: normalizeSpawnContext(item.spawnContext) }),
      };
    case "task.accept":
      return { type, taskId: normalizeTaskId(item.taskId, "payload.taskId") };
    case "task.result":
      if (item.artifactRefs === undefined) {
        throw new CrossRunProtocolError("payload.artifactRefs must be present");
      }
      return {
        type,
        taskId: normalizeTaskId(item.taskId, "payload.taskId"),
        status: oneOf(item.status, "payload.status", ["completed", "partial"] as const),
        summary: boundedString(item.summary, "payload.summary", false),
        evidenceRefs: normalizeStringArray(item.evidenceRefs, "payload.evidenceRefs"),
        artifactRefs: normalizeArtifactRefs(item.artifactRefs, "payload.artifactRefs"),
        openQuestions: normalizeStringArray(item.openQuestions, "payload.openQuestions"),
        usage: normalizeUsage(item.usage, "payload.usage"),
      };
    case "task.failed":
      return {
        type,
        taskId: normalizeTaskId(item.taskId, "payload.taskId"),
        reason: boundedString(item.reason, "payload.reason", false),
        retryable: requireBoolean(item.retryable, "payload.retryable"),
        evidenceRefs: normalizeStringArray(item.evidenceRefs, "payload.evidenceRefs"),
      };
  }
}

function payloadKeys(type: CrossRunPayload["type"]): readonly string[] {
  switch (type) {
    case "advice.propose": return ["advice"];
    case "task.request": return ["taskId", "goal", "inputRefs", "budget", "spawnContext"];
    case "task.accept": return ["taskId"];
    case "task.result": return ["taskId", "status", "summary", "evidenceRefs", "artifactRefs", "openQuestions", "usage"];
    case "task.failed": return ["taskId", "reason", "retryable", "evidenceRefs"];
    case "question.ask": return ["question"];
    case "question.answer": return ["answer"];
    case "message.inform": return ["text"];
  }
}

function normalizeArtifactRefs(value: unknown, path: string): ArtifactRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128) {
    throw new CrossRunProtocolError(`${path} must contain at most 128 ArtifactRefs`, "artifact-invalid");
  }
  return value.map((candidate, index) => {
    const item = plainObject(candidate, `${path}[${index}]`);
    exactKeys(item, ["id", "contentHash", "mediaType", "byteLength"], `${path}[${index}]`);
    const id = boundedString(item.id, `${path}[${index}].id`, false, 512);
    const contentHash = boundedString(item.contentHash, `${path}[${index}].contentHash`, false, 512);
    const mediaType = boundedString(item.mediaType, `${path}[${index}].mediaType`, false, 256);
    if (!HASH.test(contentHash) || id !== contentHash) {
      throw new CrossRunProtocolError(`${path}[${index}] is not a content-addressed SHA-256 ref`, "artifact-invalid");
    }
    if (!Number.isSafeInteger(item.byteLength) || (item.byteLength as number) < 0) {
      throw new CrossRunProtocolError(`${path}[${index}].byteLength is invalid`, "artifact-invalid");
    }
    return { id, contentHash, mediaType, byteLength: item.byteLength as number };
  });
}

function normalizeTaskId(value: unknown, path: string): string {
  return boundedString(value, path, false, 128);
}

function normalizeStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw new CrossRunProtocolError(`${path} must be an array of at most 128 strings`);
  }
  return value.map((item, index) => boundedString(item, `${path}[${index}]`, false));
}

function normalizeGoal(value: unknown, path: string): import("../domain/types.js").Goal {
  const item = plainObject(value, path);
  exactKeys(item, ["version", "statement", "successCriteria", "hardConstraints"], path);
  if (!Number.isSafeInteger(item.version) || (item.version as number) < 1) {
    throw new CrossRunProtocolError(`${path}.version must be a positive integer`);
  }
  return {
    version: item.version as number,
    statement: boundedString(item.statement, `${path}.statement`, false),
    successCriteria: normalizeStringArray(item.successCriteria, `${path}.successCriteria`),
    hardConstraints: normalizeStringArray(item.hardConstraints, `${path}.hardConstraints`),
  };
}

function normalizeTaskBudget(value: unknown, path: string): import("../domain/types.js").TaskBudget {
  const item = plainObject(value, path);
  exactKeys(item, ["maxModelTokens", "maxWallClockMs", "deadline", "maxAttempts"], path);
  if (item.maxModelTokens !== undefined && (!Number.isSafeInteger(item.maxModelTokens)
    || (item.maxModelTokens as number) < 1
    || (item.maxModelTokens as number) > MAX_TASK_MODEL_TOKENS)) {
    throw new CrossRunProtocolError(`${path}.maxModelTokens is outside its supported bound`);
  }
  if (item.maxWallClockMs !== undefined && (!Number.isSafeInteger(item.maxWallClockMs)
    || (item.maxWallClockMs as number) < 1
    || (item.maxWallClockMs as number) > MAX_TASK_WALL_CLOCK_MS)) {
    throw new CrossRunProtocolError(`${path}.maxWallClockMs is outside its supported bound`);
  }
  if (item.maxAttempts !== undefined
    && (!Number.isSafeInteger(item.maxAttempts)
      || (item.maxAttempts as number) < 1
      || (item.maxAttempts as number) > MAX_TASK_ATTEMPTS)) {
    throw new CrossRunProtocolError(`${path}.maxAttempts is outside its supported bound`);
  }
  const deadline = item.deadline === undefined ? undefined : dateTime(item.deadline, `${path}.deadline`);
  return {
    ...(item.maxModelTokens === undefined ? {} : { maxModelTokens: item.maxModelTokens as number }),
    ...(item.maxWallClockMs === undefined ? {} : { maxWallClockMs: item.maxWallClockMs as number }),
    ...(deadline === undefined ? {} : { deadline }),
    ...(item.maxAttempts === undefined ? {} : { maxAttempts: item.maxAttempts as number }),
  };
}

function normalizeSpawnContext(value: unknown): SpawnContext {
  try {
    validateSpawnContext(value);
    return structuredClone(value);
  } catch (error: unknown) {
    throw new CrossRunProtocolError(
      error instanceof Error ? error.message : "spawnContext is invalid",
      "invalid-request",
    );
  }
}

function normalizeUsage(value: unknown, path: string): import("../domain/types.js").TokenUsage {
  const item = plainObject(value, path);
  exactKeys(item, ["input", "output", "cacheRead", "cacheWrite", "costUsd"], path);
  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (!Number.isSafeInteger(item[field]) || (item[field] as number) < 0) {
      throw new CrossRunProtocolError(`${path}.${field} must be a non-negative integer`);
    }
  }
  if (item.costUsd !== undefined
    && (typeof item.costUsd !== "number" || !Number.isFinite(item.costUsd) || item.costUsd < 0)) {
    throw new CrossRunProtocolError(`${path}.costUsd must be a non-negative finite number`);
  }
  return {
    input: item.input as number,
    output: item.output as number,
    cacheRead: item.cacheRead as number,
    cacheWrite: item.cacheWrite as number,
    ...(item.costUsd === undefined ? {} : { costUsd: item.costUsd as number }),
  };
}

function normalizeAdvice(value: unknown, path: string): import("../domain/types.js").Advice {
  const item = plainObject(value, path);
  exactKeys(item, [
    "adviceId", "kind", "claim", "evidenceRefs", "confidence", "risk",
    "suggestedAction", "urgency", "expiresAt", "dedupeKey", "sourceLane",
  ], path);
  if (typeof item.confidence !== "number" || !Number.isFinite(item.confidence)
    || item.confidence < 0 || item.confidence > 1) {
    throw new CrossRunProtocolError(`${path}.confidence must be between 0 and 1`);
  }
  return {
    adviceId: boundedString(item.adviceId, `${path}.adviceId`, false),
    kind: oneOf(item.kind, `${path}.kind`, ["orientation", "intent-gap", "method-alternative"] as const),
    claim: boundedString(item.claim, `${path}.claim`, false),
    evidenceRefs: normalizeStringArray(item.evidenceRefs, `${path}.evidenceRefs`),
    confidence: item.confidence,
    risk: oneOf(item.risk, `${path}.risk`, ["low", "medium", "high"] as const),
    suggestedAction: boundedString(item.suggestedAction, `${path}.suggestedAction`, false),
    urgency: oneOf(item.urgency, `${path}.urgency`, ["next-step", "next-turn", "deferred"] as const),
    expiresAt: dateTime(item.expiresAt, `${path}.expiresAt`),
    dedupeKey: boundedString(item.dedupeKey, `${path}.dedupeKey`, false),
    sourceLane: boundedString(item.sourceLane, `${path}.sourceLane`, false),
  };
}

function validateTaskDeadline(payload: CrossRunPayload, createdAt: string): void {
  if (payload.type !== "task.request" || payload.budget.deadline === undefined) return;
  const maxWallClockMs = payload.budget.maxWallClockMs;
  const expected = maxWallClockMs === undefined ? undefined : Date.parse(createdAt) + maxWallClockMs;
  if (expected !== undefined && Date.parse(payload.budget.deadline) !== expected) {
    throw new CrossRunProtocolError(
      "task budget deadline must equal createdAt plus maxWallClockMs",
    );
  }
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new CrossRunProtocolError(`${path} must be a boolean`);
  return value;
}

function normalizeArtifactDeliveries(value: unknown, targetWorkspaceId: string): CrossRunArtifactDelivery[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw new CrossRunProtocolError("envelope.artifacts must contain at most 128 refs", "artifact-invalid");
  }
  const deliveries = value.map((candidate, index) => {
    const item = plainObject(candidate, `envelope.artifacts[${index}]`);
    exactKeys(item, ["sourceRef", "targetRef", "visibility", "targetWorkspaceId"], `envelope.artifacts[${index}]`);
    const sourceRef = normalizeArtifactRefs([item.sourceRef], `envelope.artifacts[${index}].sourceRef`)[0]!;
    const targetRef = normalizeArtifactRefs([item.targetRef], `envelope.artifacts[${index}].targetRef`)[0]!;
    if (stableJson(sourceRef) !== stableJson(targetRef)) {
      throw new CrossRunProtocolError("source and target ArtifactRefs differ", "artifact-mismatch");
    }
    const visibility = oneOf(item.visibility, `envelope.artifacts[${index}].visibility`, ["lane", "run", "user", "sensitive"] as const);
    const workspace = boundedString(item.targetWorkspaceId, `envelope.artifacts[${index}].targetWorkspaceId`, false);
    if (workspace !== targetWorkspaceId) throw new CrossRunProtocolError("artifact target workspace mismatch", "artifact-mismatch");
    return { sourceRef, targetRef, visibility, targetWorkspaceId: workspace };
  });
  const byHash = new Map<string, CrossRunArtifactDelivery>();
  for (const delivery of deliveries) {
    const key = delivery.sourceRef.contentHash;
    const existing = byHash.get(key);
    if (existing !== undefined && stableJson(existing) !== stableJson(delivery)) {
      throw new CrossRunProtocolError("duplicate ArtifactRefs have conflicting delivery metadata", "artifact-mismatch");
    }
    byHash.set(key, delivery);
  }
  return [...byHash.values()].sort((left, right) => (
    left.sourceRef.contentHash < right.sourceRef.contentHash ? -1
      : left.sourceRef.contentHash > right.sourceRef.contentHash ? 1 : 0
  ));
}

function dedupeArtifactRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const byHash = new Map<string, ArtifactRef>();
  for (const ref of refs) {
    const existing = byHash.get(ref.contentHash);
    if (existing !== undefined && !sameArtifactRef(existing, ref)) {
      throw new CrossRunProtocolError(
        "duplicate ArtifactRefs have conflicting metadata",
        "artifact-mismatch",
      );
    }
    byHash.set(ref.contentHash, ref);
  }
  return [...byHash.values()].sort((left, right) => left.contentHash < right.contentHash ? -1 : left.contentHash > right.contentHash ? 1 : 0);
}

function payloadArtifactRefs(payload: CrossRunPayload): readonly ArtifactRef[] {
  if (payload.type === "task.request") return payload.inputRefs;
  if (payload.type === "task.result") return payload.artifactRefs;
  return [];
}

function sameArtifactRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return left.id === right.id
    && left.contentHash === right.contentHash
    && left.mediaType === right.mediaType
    && left.byteLength === right.byteLength;
}

function normalizeRelationships(value: unknown, path: string): readonly CrossRunRelationship[] {
  if (!Array.isArray(value)) throw new CrossRunProtocolError(`${path} must be an array`);
  const result = value.map((item, index) => oneOf(item, `${path}[${index}]`, ["parent", "sibling", "child", "direct"] as const));
  return Object.freeze([...new Set(result)]);
}

function boundedSelector(value: unknown, path: string): string {
  const normalized = boundedString(value, path, false, CROSS_RUN_MAX_ENDPOINT_LENGTH);
  if (normalized === "*" || /^(all|broadcast)$/iu.test(normalized)) {
    throw new CrossRunProtocolError("wildcard A2A targets are not supported", "selector-invalid");
  }
  return normalized;
}

function boundedMessageText(value: unknown, path: string): string {
  // Body whitespace is data; endpoint and identity fields keep their stricter contract.
  if (typeof value !== "string" || value.trim().length === 0 || value.length > CROSS_RUN_MAX_INLINE_BYTES * 4
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new CrossRunProtocolError(`${path} must be bounded text without unsafe control characters`);
  }
  return value;
}

function boundedString(value: unknown, path: string, allowEmpty: boolean, max = CROSS_RUN_MAX_STRING_LENGTH): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > max || CONTROL_CHARACTER.test(value)) {
    throw new CrossRunProtocolError(`${path} must be a bounded string without control characters`);
  }
  return value;
}

function dateTime(value: unknown, path: string): string {
  const result = boundedString(value, path, false, 128);
  const match = ISO_DATE_TIME.exec(result);
  if (match === null || !validIsoDateParts(match)) {
    throw new CrossRunProtocolError(`${path} must be an ISO date-time`);
  }
  return result;
}

function validIsoDateParts(match: RegExpExecArray): boolean {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[8]!;
  const zoneHour = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const zoneMinute = zone === "Z" ? 0 : Number(zone.slice(4, 6));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = month === 2
    ? (leap ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return month >= 1 && month <= 12
    && day >= 1 && day <= daysInMonth
    && hour >= 0 && hour <= 23
    && minute >= 0 && minute <= 59
    && second >= 0 && second <= 59
    && zoneHour >= 0 && zoneHour <= 23
    && zoneMinute >= 0 && zoneMinute <= 59
    && Number.isFinite(Date.parse(match[0]!));
}

function boundedPriority(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 100) {
    throw new CrossRunProtocolError(`${path} must be a safe integer between 0 and 100`);
  }
  return value as number;
}

function oneOf<T extends string>(value: unknown, path: string, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new CrossRunProtocolError(`${path} is invalid`);
  }
  return value as T;
}

function plainObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CrossRunProtocolError(`${path} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CrossRunProtocolError(`${path} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) throw new CrossRunProtocolError(`${path}.${key} is not allowed`);
  }
}

function validateNestedStrings(value: unknown, path: string): void {
  if (typeof value === "string") {
    boundedString(value, path, true, CROSS_RUN_MAX_STRING_LENGTH);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateNestedStrings(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    const item = plainObject(value, path);
    for (const [key, child] of Object.entries(item)) {
      boundedString(key, `${path}.<key>`, false, CROSS_RUN_MAX_STRING_LENGTH);
      validateNestedStrings(child, `${path}.${key}`);
    }
  }
}

function logicalEnvelope(envelope: CrossRunEnvelope): Record<string, unknown> {
  return {
    source: envelope.source,
    target: envelope.target,
    relationship: envelope.relationship,
    conversationId: envelope.conversationId,
    threadId: envelope.threadId,
    correlationId: envelope.correlationId,
    idempotencyKey: envelope.idempotencyKey,
    expiresAt: envelope.expiresAt,
    causationId: envelope.causationId,
    visibility: envelope.visibility,
    priority: envelope.priority,
    payload: envelope.payload,
    artifacts: envelope.artifacts,
  };
}

function factIdentity(fact: CrossRunFact): string {
  if (fact.kind === "outbox.pending") return `${fact.kind}\u0000${fact.envelope.routeId}`;
  if (fact.kind === "outbox.attempted") return `${fact.kind}\u0000${fact.routeId}\u0000${fact.attemptId}`;
  return `${fact.kind}\u0000${fact.receipt.routeId}\u0000${fact.receipt.status}`;
}

function assertFactPredecessor(
  fact: CrossRunFact,
  existing: readonly CrossRunFact[],
): void {
  if (fact.kind === "outbox.pending") return;
  const routeId = fact.kind === "outbox.receipt" ? fact.receipt.routeId : fact.routeId;
  const pending = existing.find((candidate) => (
    candidate.kind === "outbox.pending"
    && candidate.envelope.routeId === routeId
  ));
  if (pending === undefined || pending.kind !== "outbox.pending") {
    throw new CrossRunProtocolError(
      "A2A attempt or receipt has no durable pending fact",
      "durable-fact-failed",
    );
  }
  // A receipt closes the source-side saga. Any later attempt or a second
  // terminal state would make recovery ambiguous, even when the new fact uses
  // a different idempotency identity.
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
  if (receipt.attemptId !== undefined && !existing.some((candidate) => (
    candidate.kind === "outbox.attempted"
    && candidate.routeId === receipt.routeId
    && candidate.attemptId === receipt.attemptId
  ))) {
    throw new CrossRunProtocolError(
      "A2A receipt references an unknown delivery attempt",
      "idempotency-conflict",
    );
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Keep these imports in the public type surface without forcing consumers to
// depend on a concrete Ledger implementation in the cross-Run adapter.
export type CrossRunLedgerEvent = EventEnvelope | AnyEvent;
export type { Clock, CrossRunEndpoint, CrossRunRelationship, CrossRunReceiptReason, CrossRunReceiptStatus, CrossRunRoute, LaneId, RunId, Visibility };
