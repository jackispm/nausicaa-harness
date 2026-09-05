import type { A2AMessage, ArtifactRef, CrossRunArtifactDelivery, CrossRunEndpoint, CrossRunEnvelope, CrossRunReceipt, CrossRunRelationship, CrossRunRoute, Visibility } from "../domain/types.js";
import type { Clock } from "../domain/ports.js";
import { systemClock } from "../domain/ports.js";
import { sha256, stableJson } from "../ledger/hash.js";
import type { InboxRecord } from "./inbox.js";
import {
  CROSS_RUN_MAX_BATCH,
  CrossRunProtocolError,
  assertCrossRunReceiptMatchesEnvelope,
  type CrossRunAdmissionDecision,
  type CrossRunAdmissionPolicy,
  type CrossRunArtifactRelay,
  type CrossRunArtifactRelayInput,
  type CrossRunAuthorization,
  type CrossRunAuthorizationInput,
  type CrossRunAuthorizer,
  type CrossRunFact,
  type CrossRunFactStore,
  type CrossRunResolvedTarget,
  type CrossRunRoster,
  type CrossRunRosterEntry,
  type CrossRunRosterResolver,
  type CrossRunSenderIdentity,
  type CrossRunSendRequest,
  type CrossRunTargetAdmission,
  type CrossRunTargetAdmissionResult,
  type CrossRunTargetResolver,
  type CrossRunTargetSelector,
  type CrossRunWake,
  createCrossRunMessageId,
  createCrossRunReceiptId,
  createCrossRunRouteId,
  endpointKey,
  envelopeToA2AMessage,
  normalizeCrossRunSendRequest,
  normalizeCrossRunFact,
  normalizeEndpoint,
  normalizeEnvelope,
  normalizeReceipt,
  normalizeSenderIdentity,
  sameEndpoint,
  sameLogicalEnvelope,
} from "./cross-run-contract.js";
import {
  MemoryCrossRunFactStore,
} from "./cross-run-contract.js";

export interface CrossRunRouterOptions {
  /** Source durable outbox. A resolver permits one store per source Run. */
  readonly factStore?: CrossRunFactStore;
  readonly factStoreFor?: (source: CrossRunEndpoint) => CrossRunFactStore | Promise<CrossRunFactStore>;
  readonly resolver?: CrossRunTargetResolver;
  readonly resolveTarget?: CrossRunTargetResolver["resolve"];
  readonly roster?: CrossRunRosterResolver;
  readonly listRoster?: CrossRunRosterResolver["list"];
  readonly authorizer?: CrossRunAuthorizer;
  readonly authorize?: CrossRunAuthorizer["authorize"];
  readonly targetAdmission?: CrossRunTargetAdmission;
  readonly admitTarget?: CrossRunTargetAdmission["admit"];
  readonly artifactRelay?: CrossRunArtifactRelay;
  readonly relayArtifact?: CrossRunArtifactRelay["relay"];
  readonly wake?: CrossRunWake;
  readonly wakeTarget?: CrossRunWake["wake"];
  readonly admissionPolicy?: CrossRunAdmissionPolicy;
  readonly checkAdmission?: CrossRunAdmissionPolicy["check"];
  readonly clock?: Clock;
  /** Optional host verifier for the opaque attach/lease proof. */
  readonly verifySender?: (sender: CrossRunSenderIdentity) => boolean | Promise<boolean>;
  readonly maxBatch?: number;
  readonly maxInlineBytes?: number;
  /** Maximum number of source-side delivery attempts for one route. */
  readonly maxAttempts?: number;
  readonly createId?: (kind: "attempt" | "receipt") => string;
}

/** Keep recovery bounded even when a host asks for retries repeatedly. */
export const CROSS_RUN_MAX_ATTEMPTS = 8;

// The source-side route critical section must span router instances. A host
// may construct one router per activation while sharing the same source Run
// (and therefore the same durable fact store); an instance-local tail would
// let two sends race between the pending read and target admission.
const sharedSendTails = new Map<string, Promise<void>>();

export interface CrossRunBatchResult {
  readonly receipts: readonly CrossRunReceipt[];
  readonly accepted: number;
  readonly failed: number;
}

export interface CrossRunRecoveryResult {
  readonly receipts: readonly CrossRunReceipt[];
  readonly uncertain: readonly CrossRunReceipt[];
}

export interface CrossRunReceiptView {
  readonly route: CrossRunRoute;
  readonly envelope: CrossRunEnvelope;
  readonly status: CrossRunReceipt["status"];
  readonly receipt?: CrossRunReceipt;
  readonly attemptCount: number;
  readonly diagnostic?: string;
}

export interface CrossRunProjection {
  readonly entries: readonly CrossRunReceiptView[];
  readonly pending: readonly CrossRunReceiptView[];
  readonly uncertain: readonly CrossRunReceiptView[];
}

/**
 * Cross-Session/Run A2A saga router. All side effects are injected: this
 * class only orders authorization, source facts, target admission and wake.
 */
export class CrossRunRouter {
  readonly #options: CrossRunRouterOptions;
  readonly #clock: Clock;
  readonly #maxBatch: number;
  readonly #maxAttempts: number;
  readonly #fallbackStore: CrossRunFactStore;

  constructor(options: CrossRunRouterOptions = {}) {
    if (options === null || typeof options !== "object" || Array.isArray(options)
      || (Object.getPrototypeOf(options) !== Object.prototype
        && Object.getPrototypeOf(options) !== null)) {
      throw new CrossRunProtocolError("router options must be an object");
    }
    if (options.factStore !== undefined
      && (typeof options.factStore.append !== "function"
        || typeof options.factStore.read !== "function")) {
      throw new CrossRunProtocolError("factStore must implement append/read");
    }
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    const maxBatch = options.maxBatch === undefined ? CROSS_RUN_MAX_BATCH : options.maxBatch;
    this.#maxBatch = positiveBound(maxBatch, 1, CROSS_RUN_MAX_BATCH, "maxBatch");
    if (options.clock !== undefined
      && (options.clock === null || typeof options.clock !== "object"
        || typeof options.clock.now !== "function")) {
      throw new CrossRunProtocolError("clock must implement now");
    }
    this.#maxAttempts = positiveBound(
      options.maxAttempts === undefined ? CROSS_RUN_MAX_ATTEMPTS : options.maxAttempts,
      1,
      CROSS_RUN_MAX_ATTEMPTS,
      "maxAttempts",
    );
    this.#fallbackStore = options.factStore ?? new MemoryCrossRunFactStore();
  }

  /** List only host-provided reachable family/direct entries. */
  async listRoster(senderInput: CrossRunSenderIdentity): Promise<CrossRunRoster> {
    const sender = await this.#authenticatedSender(senderInput);
    const resolver = this.#rosterResolver();
    if (resolver === undefined) {
      return Object.freeze({ current: sender.endpoint, entries: [] });
    }
    let roster: CrossRunRoster;
    try {
      roster = await resolver.list(structuredClone(sender));
    } catch {
      throw new CrossRunProtocolError("roster lookup failed", "target-unavailable");
    }
    return normalizeRoster(roster, sender.endpoint);
  }

  async send(
    requestInput: CrossRunSendRequest,
    senderInput: CrossRunSenderIdentity,
  ): Promise<CrossRunReceipt> {
    const sender = await this.#authenticatedSender(senderInput);
    return this.withSenderExclusive(sender.endpoint, () => this.#sendOne(requestInput, sender));
  }

  /** Bounded, ordered batch. A malformed item is isolated as a rejection. */
  async sendMany(
    requests: readonly CrossRunSendRequest[],
    senderInput: CrossRunSenderIdentity,
  ): Promise<readonly CrossRunReceipt[]> {
    if (!Array.isArray(requests)) throw new CrossRunProtocolError("sendMany requests must be an array");
    if (requests.length > this.#maxBatch) {
      throw new CrossRunProtocolError(`sendMany is limited to ${this.#maxBatch} recipients` , "selector-invalid");
    }
    const sender = await this.#authenticatedSender(senderInput);
    const receipts: CrossRunReceipt[] = [];
    for (let index = 0; index < requests.length; index += 1) {
      try {
        receipts.push(await this.send(requests[index]!, sender));
      } catch (error: unknown) {
        receipts.push(this.failureReceipt(
          sender.endpoint,
          requests[index],
          index,
          failureReason(error),
          diagnosticCode(error),
        ));
      }
    }
    return receipts;
  }

  /** Explicit recipient-list broadcast. Wildcards and implicit rosters are rejected. */
  async broadcast(
    recipients: readonly CrossRunTargetSelector[],
    baseRequest: Omit<CrossRunSendRequest, "target">,
    senderInput: CrossRunSenderIdentity,
  ): Promise<readonly CrossRunReceipt[]> {
    if (!Array.isArray(recipients) || recipients.length === 0) {
      throw new CrossRunProtocolError("broadcast requires an explicit recipient list", "selector-invalid");
    }
    if (recipients.length > this.#maxBatch) {
      throw new CrossRunProtocolError(`broadcast is limited to ${this.#maxBatch} recipients`, "selector-invalid");
    }
    return this.sendMany(recipients.map((target) => ({ ...baseRequest, target })), senderInput);
  }

  /**
   * Recover source outbox facts. A pending fact without an attempt may be
   * retried; an attempt without a terminal receipt is surfaced as uncertain.
   */
  async recover(senderInput: CrossRunSenderIdentity): Promise<CrossRunRecoveryResult> {
    const sender = await this.#authenticatedSender(senderInput);
    // Recovery and send share one source-side critical section. Without this
    // boundary a restart callback could observe a pending fact while send is
    // between its admission side effect and terminal receipt, causing a
    // second target admission.
    return this.withSenderExclusive(sender.endpoint, () => this.#recover(sender));
  }

  async #recover(sender: CrossRunSenderIdentity): Promise<CrossRunRecoveryResult> {
    const store = await this.#storeFor(sender.endpoint);
    const facts = await this.readFacts(store, { runId: sender.endpoint.runId });
    const grouped = groupFacts(facts, true);
    const receipts: CrossRunReceipt[] = [];
    const uncertain: CrossRunReceipt[] = [];
    const entries = [...grouped.values()].sort((left, right) => (
      left.envelope.routeId < right.envelope.routeId
        ? -1
        : left.envelope.routeId > right.envelope.routeId ? 1 : 0
    ));
    for (const entry of entries) {
      if (!sameEndpoint(entry.envelope.source, sender.endpoint)) {
        throw new CrossRunProtocolError(
          "recovery sender does not own the pending route",
          "identity-forged",
        );
      }
      if (entry.receipt !== undefined) {
        receipts.push(entry.receipt);
        if (entry.receipt.status === "uncertain") uncertain.push(entry.receipt);
        continue;
      }
      if (entry.attempts.length > 0) {
        const receipt = this.makeReceipt(entry.envelope, "uncertain", {
          attemptId: entry.attempts[entry.attempts.length - 1]!.attemptId,
          reason: "delivery-attempt-without-receipt",
        });
        const persisted = await this.recordReceipt(store, receipt, true);
        receipts.push(persisted);
        uncertain.push(persisted);
        continue;
      }
      try {
        const receipt = await this.#recoverPending(entry.envelope, sender, store);
        receipts.push(receipt);
        if (receipt.status === "uncertain") uncertain.push(receipt);
      } catch (error: unknown) {
        const receipt = this.makeReceipt(entry.envelope, "uncertain", {
          reason: "target-admission-failed",
          diagnostic: diagnosticCode(error),
        });
        const persisted = await this.recordReceipt(store, receipt, true);
        receipts.push(persisted);
        uncertain.push(persisted);
      }
    }
    return { receipts, uncertain };
  }

  /** Alias used by recovery compositions. */
  recoverPending(sender: CrossRunSenderIdentity): Promise<CrossRunRecoveryResult> {
    return this.recover(sender);
  }

  async #recoverPending(
    envelope: CrossRunEnvelope,
    sender: CrossRunSenderIdentity,
    store: CrossRunFactStore,
  ): Promise<CrossRunReceipt> {
    if (sender.relationshipGrants !== undefined
      && !sender.relationshipGrants.includes(envelope.relationship)) {
      return this.recordReceipt(store, this.makeReceipt(envelope, "rejected", {
        reason: "authorization-denied",
      }), true);
    }
    const authorization = await this.authorize({
      source: sender,
      target: envelope.target,
      relationship: envelope.relationship,
      operation: "recover",
    });
    if (!authorization.allowed) {
      return this.recordReceipt(store, this.makeReceipt(envelope, "rejected", {
        reason: authorization.reason ?? (sender.endpoint.workspaceId === envelope.target.workspaceId
          ? "authorization-denied"
          : "cross-workspace-reauthentication-required"),
      }), true);
    }
    if (sender.endpoint.workspaceId !== envelope.target.workspaceId
      && authorization.reauthenticated !== true) {
      return this.recordReceipt(store, this.makeReceipt(envelope, "rejected", {
        reason: "cross-workspace-reauthentication-required",
      }), true);
    }
    if (envelope.expiresAt !== undefined
      && Date.parse(envelope.expiresAt) <= this.now().getTime()) {
      return this.recordReceipt(store, this.makeReceipt(envelope, "expired", {
        reason: "expired",
      }), true);
    }
    try {
      await this.relayArtifacts(
        envelope.artifacts.map((artifact) => artifact.sourceRef),
        envelope.source,
        envelope.target,
        envelope.visibility,
      );
    } catch (error: unknown) {
      return this.recordReceipt(store, this.makeReceipt(envelope, "rejected", {
        reason: "artifact-rejected",
        diagnostic: diagnosticCode(error),
      }), true);
    }
    const policy = await this.checkAdmission(envelope.source, envelope.target, envelope);
    if (!policy.allowed) {
      return this.recordReceipt(store, this.makeReceipt(envelope, "rejected", {
        reason: policy.reason === "target-capacity" ? "target-capacity" : "rate-limited",
        ...(policy.retryAt === undefined ? {} : { retryAt: policy.retryAt }),
      }), true);
    }
    return this.#deliverExisting(envelope, sender, store, 0);
  }

  async #sendOne(
    requestInput: CrossRunSendRequest,
    sender: CrossRunSenderIdentity,
  ): Promise<CrossRunReceipt> {
    const request = normalizeCrossRunSendRequest(requestInput, {
      now: this.now(),
      ...(this.#options.maxInlineBytes === undefined
        ? {}
        : { maxInlineBytes: this.#options.maxInlineBytes }),
    });
    const target = await this.resolveTarget(request.target, sender);
    if (sameEndpoint(sender.endpoint, target.endpoint)) {
      throw new CrossRunProtocolError("A2A cannot target the sending endpoint", "selector-invalid");
    }
    const now = this.now();
    const routeId = createCrossRunRouteId(sender.endpoint, target.endpoint, request.idempotencyKey);
    const messageId = createCrossRunMessageId(routeId, request);
    const artifacts = expectedArtifactDeliveries(
      request.artifactRefs ?? [],
      target.endpoint,
      request.visibility,
    );
    // Build the trusted envelope before authorization/expiration decisions so
    // rejection receipts still identify the actual request payload and route.
    let envelope = normalizeEnvelope({
      protocolVersion: 1,
      messageId,
      routeId,
      source: sender.endpoint,
      target: target.endpoint,
      relationship: target.relationship,
      conversationId: request.conversationId,
      threadId: request.threadId,
      correlationId: request.correlationId,
      idempotencyKey: request.idempotencyKey,
      createdAt: request.createdAt,
      ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
      ...(request.causationId === undefined ? {} : { causationId: request.causationId }),
      visibility: request.visibility,
      priority: request.priority,
      payload: request.payload,
      artifacts,
    });

    // Resolve the source store before any policy/transport decision. A new
    // route is recorded as pending first so authorization, expiry, capacity,
    // and artifact failures remain replayable durable facts.
    const store = await this.#storeFor(sender.endpoint);
    let existing = await this.findExisting(store, sender.endpoint.runId, routeId);
    if (existing === undefined) {
      try {
        await this.appendFact(store, {
          kind: "outbox.pending",
          envelope,
          recordedAt: now.toISOString(),
        });
        existing = await this.findExisting(store, sender.endpoint.runId, routeId);
        // A custom store may acknowledge an append without exposing the
        // record in the same read view. Treat the just-appended envelope as a
        // pending group so this call still emits exactly one attempt.
        existing ??= { envelope: structuredClone(envelope), attempts: [] };
      } catch (error: unknown) {
        // Another router instance may have won the same idempotency race. A
        // successful retry must inspect the durable winner before delivering.
        if (!isIdempotencyConflict(error)) throw error;
        existing = await this.findExisting(store, sender.endpoint.runId, routeId);
        if (existing === undefined) throw error;
        if (!sameLogicalEnvelope(existing.envelope, envelope)) {
          return this.makeReceipt(envelope, "conflict", { reason: "idempotency-conflict" });
        }
      }
    }

    // Idempotency is resolved against the durable route before any
    // request-time policy can produce a second terminal state. A retry may
    // arrive after authorization, capacity, or expiry conditions changed;
    // the first durable outcome remains authoritative for the logical
    // envelope. Content changes are still conflicts and are never admitted.
    if (existing !== undefined) {
      if (!sameLogicalEnvelope(existing.envelope, envelope)) {
        return this.makeReceipt(envelope, "conflict", { reason: "idempotency-conflict" });
      }
      if (existing.receipt !== undefined) {
        if (existing.receipt.status === "uncertain") {
          return structuredClone(existing.receipt);
        }
        return this.makeReceipt(envelope, "duplicate", {
          ...(existing.receipt.targetMessageId === undefined
            ? {}
            : { targetMessageId: existing.receipt.targetMessageId }),
          ...(existing.receipt.attemptId === undefined
            ? {}
            : { attemptId: existing.receipt.attemptId }),
        });
      }
      if (existing.attempts.length > 0) {
        const receipt = this.makeReceipt(envelope, "uncertain", {
          attemptId: existing.attempts[existing.attempts.length - 1]!.attemptId,
          reason: "delivery-attempt-without-receipt",
        });
        return this.recordReceipt(store, receipt, true);
      }
      // `createdAt` is intentionally outside the logical idempotency
      // fingerprint, so retries may omit it. Once a durable pending fact is
      // present, use that immutable envelope for every later side effect and
      // event provenance.
      envelope = existing.envelope;
    }

    if (sender.relationshipGrants !== undefined
      && !sender.relationshipGrants.includes(target.relationship)) {
      return this.recordReceipt(store, this.makeReceipt(envelope, "rejected", {
        reason: "authorization-denied",
      }), true);
    }
    const authorization = await this.authorize({
      source: sender,
      target: target.endpoint,
      relationship: target.relationship,
      operation: "send",
    });
    if (!authorization.allowed) {
      return this.recordReceipt(store, this.makeReceipt(envelope, "rejected", {
        reason: authorization.reason ?? (sender.endpoint.workspaceId === target.endpoint.workspaceId
          ? "authorization-denied"
          : "cross-workspace-reauthentication-required"),
      }), true);
    }
    if (sender.endpoint.workspaceId !== target.endpoint.workspaceId
      && authorization.reauthenticated !== true) {
      return this.recordReceipt(store, this.makeReceipt(envelope, "rejected", {
        reason: "cross-workspace-reauthentication-required",
      }), true);
    }
    if (request.expiresAt !== undefined && Date.parse(request.expiresAt) <= now.getTime()) {
      return this.recordReceipt(store, this.makeReceipt(envelope, "expired", { reason: "expired" }), true);
    }

    try {
      await this.relayArtifacts(
        request.artifactRefs ?? [],
        sender.endpoint,
        target.endpoint,
        request.visibility,
      );
    } catch (error: unknown) {
      const receipt = this.makeReceipt(envelope, "rejected", {
        reason: "artifact-rejected",
        diagnostic: diagnosticCode(error),
      });
      return this.recordReceipt(store, receipt, true);
    }

    const policy = await this.checkAdmission(sender.endpoint, target.endpoint, envelope);
    if (!policy.allowed) {
      const receipt = this.makeReceipt(envelope, "rejected", {
        reason: policy.reason === "target-capacity" ? "target-capacity" : "rate-limited",
        ...(policy.retryAt === undefined ? {} : { retryAt: policy.retryAt }),
      });
      return this.recordReceipt(store, receipt, true);
    }
    return this.#deliverExisting(envelope, sender, store, existing?.attempts.length ?? 0);
  }

  async #deliverExisting(
    envelope: CrossRunEnvelope,
    sender: CrossRunSenderIdentity,
    store: CrossRunFactStore,
    priorAttemptCount = 0,
  ): Promise<CrossRunReceipt> {
    const attemptOrdinal = priorAttemptCount + 1;
    if (attemptOrdinal > this.#maxAttempts) {
      return this.recordReceipt(store, this.makeReceipt(envelope, "uncertain", {
        reason: "delivery-attempt-without-receipt",
        diagnostic: "attempt-limit-reached",
      }), true);
    }
    const attemptId = this.createId("attempt", envelope.routeId, attemptOrdinal);
    await this.appendFact(store, {
      kind: "outbox.attempted",
      routeId: envelope.routeId,
      messageId: envelope.messageId,
      attemptId,
      attemptedAt: this.nowIso(),
    });
    const message = envelopeToA2AMessage(envelope);
    let admission: CrossRunTargetAdmissionResult;
    try {
      admission = await this.admitTarget({ envelope, message, source: sender });
      validateAdmissionResult(admission);
      if (admission.status !== "rejected"
        && admission.messageId !== undefined
        && admission.messageId !== envelope.messageId) {
        throw new CrossRunProtocolError(
          "Target admission messageId does not match the trusted envelope",
          "identity-forged",
        );
      }
    } catch (error: unknown) {
      const receipt = this.makeReceipt(envelope, "uncertain", {
        attemptId,
        reason: "target-admission-failed",
        diagnostic: diagnosticCode(error),
      });
      return this.recordReceipt(store, receipt, true);
    }
    if (admission.status === "rejected") {
      if (admission.reason === "expired") {
        const receipt = this.makeReceipt(envelope, "expired", {
          attemptId,
          reason: "expired",
          ...(admission.retryAt === undefined ? {} : { retryAt: admission.retryAt }),
        });
        return this.recordReceipt(store, receipt, true);
      }
      const receipt = this.makeReceipt(envelope, "rejected", {
        attemptId,
        reason: admission.reason ?? "target-admission-failed",
        ...(admission.retryAt === undefined ? {} : { retryAt: admission.retryAt }),
      });
      return this.recordReceipt(store, receipt, true);
    }
    const targetMessageId = admission.messageId ?? envelope.messageId;
    if (this.#options.wake !== undefined || this.#options.wakeTarget !== undefined) {
      try {
        const wake = await this.wakeTarget({ envelope, targetMessageId });
        if (wake.status === "rejected") {
          const receipt = this.makeReceipt(envelope, "uncertain", {
            attemptId,
            targetMessageId,
            reason: "wake-failed",
            ...(wake.retryAt === undefined ? {} : { retryAt: wake.retryAt }),
          });
          return this.recordReceipt(store, receipt, true);
        }
      } catch (error: unknown) {
        const receipt = this.makeReceipt(envelope, "uncertain", {
          attemptId,
          targetMessageId,
          reason: "wake-failed",
          diagnostic: diagnosticCode(error),
        });
        return this.recordReceipt(store, receipt, true);
      }
    }
    const receipt = this.makeReceipt(envelope, admission.status, {
      attemptId,
      targetMessageId,
      ...(admission.retryAt === undefined ? {} : { retryAt: admission.retryAt }),
    });
    return this.recordReceipt(store, receipt, true);
  }

  private withSenderExclusive<T>(
    endpoint: CrossRunEndpoint,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = endpointKey(endpoint);
    const previous = sharedSendTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.then(() => gate);
    sharedSendTails.set(key, current);
    return previous
      .then(operation)
      .finally(() => {
        release();
        if (sharedSendTails.get(key) === current) sharedSendTails.delete(key);
      });
  }

  private async resolveTarget(
    selector: CrossRunTargetSelector,
    sender: CrossRunSenderIdentity,
  ): Promise<CrossRunResolvedTarget> {
    const resolver = this.#options.resolver;
    const resolveTarget = resolver === undefined
      ? this.#options.resolveTarget
      : undefined;
    if (resolver !== undefined || resolveTarget !== undefined) {
      // Keep the receiver for adapter objects. Several host implementations
      // use private state in `resolve`; extracting the method would turn a
      // normal delivery into an opaque transport failure.
      let target: CrossRunResolvedTarget;
      try {
        target = resolver !== undefined
          ? await resolver.resolve(structuredClone(selector), structuredClone(sender))
          : await resolveTarget!(structuredClone(selector), structuredClone(sender));
      } catch (error: unknown) {
        throw safeResolverError(error);
      }
      const normalized = normalizeResolvedTarget(target);
      assertResolvedTargetMatchesSelector(selector, normalized);
      if (normalized.reachable === false || normalized.status === "inactive") {
        throw new CrossRunProtocolError("target is not reachable", "target-unavailable");
      }
      return normalized;
    }
    let roster: CrossRunRoster;
    try {
      roster = await this.listRoster(sender);
    } catch (error: unknown) {
      if (error instanceof CrossRunProtocolError) throw error;
      throw new CrossRunProtocolError("roster lookup failed", "target-unavailable");
    }
    const relationship = selector.relationship;
    const candidates = roster.entries.filter((entry) => entry.relationship === relationship);
    if (relationship === "parent") {
      if (candidates.length !== 1) throw new CrossRunProtocolError("parent selector is unavailable or ambiguous", "selector-ambiguous");
      return entryTarget(candidates[0]!);
    }
    const bySelector = candidates.filter((entry) => {
      const item = selector as Exclude<CrossRunTargetSelector, { relationship: "parent" }>;
      const endpoint = "endpoint" in item ? item.endpoint : undefined;
      return (item.name === undefined || entry.name === item.name)
        && (item.id === undefined || entry.endpoint.runId === item.id || entry.endpoint.laneId === item.id)
        && (endpoint === undefined || sameEndpoint(entry.endpoint, endpoint));
    });
    if (bySelector.length !== 1) {
      throw new CrossRunProtocolError(
        bySelector.length === 0 ? `${relationship} target is unavailable` : `${relationship} target selector is ambiguous`,
        bySelector.length === 0 ? "target-unavailable" : "selector-ambiguous",
      );
    }
    return entryTarget(bySelector[0]!);
  }

  #rosterResolver(): CrossRunRosterResolver | undefined {
    if (this.#options.roster !== undefined) return this.#options.roster;
    if (this.#options.listRoster !== undefined) return { list: this.#options.listRoster };
    return undefined;
  }

  private async authorize(input: CrossRunAuthorizationInput): Promise<CrossRunAuthorization> {
    const authorizer = this.#options.authorizer;
    const authorize = authorizer === undefined ? this.#options.authorize : undefined;
    if (authorizer !== undefined || authorize !== undefined) {
      try {
        const adapterInput = structuredClone(input);
        const result = authorizer !== undefined
          ? await authorizer.authorize(adapterInput)
          : await authorize!(adapterInput);
        validateAuthorizationResult(result);
        return structuredClone(result);
      } catch {
        return { allowed: false, reason: "authorization-denied" };
      }
    }
    if (input.source.endpoint.workspaceId !== input.target.workspaceId) {
      return { allowed: false, reason: "cross-workspace-reauthentication-required" };
    }
    return { allowed: true };
  }

  private async checkAdmission(
    source: CrossRunEndpoint,
    target: CrossRunEndpoint,
    envelope: CrossRunEnvelope,
  ): Promise<CrossRunAdmissionDecision> {
    const policy = this.#options.admissionPolicy;
    const check = policy === undefined ? this.#options.checkAdmission : undefined;
    if (policy === undefined && check === undefined) return { allowed: true };
    try {
      const input = structuredClone({ source, target, envelope });
      const result = policy !== undefined
        ? await policy.check(input)
        : await check!(input);
      validateAdmissionDecision(result);
      return structuredClone(result);
    } catch {
      return { allowed: false, reason: "target-capacity" };
    }
  }

  private async relayArtifacts(
    refs: readonly import("../domain/types.js").ArtifactRef[],
    source: CrossRunEndpoint,
    target: CrossRunEndpoint,
    visibility: Visibility,
  ): Promise<readonly CrossRunArtifactDelivery[]> {
    const result: CrossRunArtifactDelivery[] = [];
    for (const sourceRef of refs) {
      const input: CrossRunArtifactRelayInput = {
        source: structuredClone(source),
        target: structuredClone(target),
        sourceRef: structuredClone(sourceRef),
        visibility,
      };
      let delivery: CrossRunArtifactDelivery;
      try {
        const relayAdapter = this.#options.artifactRelay;
        const relay = relayAdapter === undefined ? this.#options.relayArtifact : undefined;
        if (relayAdapter === undefined && relay === undefined) {
          // Artifact stores are Run-scoped in the production composition.
          // A content-addressed ref alone does not make the object available
          // to the target Run, even when both endpoints share a workspace.
          // Require the host to inject a relay that verifies and copies the
          // bytes into the target store before admitting the message.
          throw new CrossRunProtocolError(
            "ArtifactRef requires an authorized relay",
            "artifact-invalid",
          );
        } else {
          delivery = relayAdapter !== undefined
            ? await relayAdapter.relay(input)
            : await relay!(input);
        }
      } catch (error: unknown) {
        if (error instanceof CrossRunProtocolError) {
          throw new CrossRunProtocolError(
            error.code === "artifact-integrity"
              ? "Artifact relay failed integrity verification"
              : "Artifact relay rejected the reference",
            error.code,
          );
        }
        throw new CrossRunProtocolError("Artifact relay failed", "artifact-mismatch");
      }
      delivery = normalizeRelayDelivery(delivery, sourceRef, target, visibility);
      if (!sameArtifactRef(delivery.sourceRef, sourceRef)
        || !sameArtifactRef(delivery.targetRef, sourceRef)
        || delivery.visibility !== visibility
        || delivery.targetWorkspaceId !== target.workspaceId) {
        throw new CrossRunProtocolError("Artifact relay returned a mismatched reference", "artifact-mismatch");
      }
      result.push(structuredClone(delivery));
    }
    return result.sort((left, right) => left.sourceRef.contentHash < right.sourceRef.contentHash ? -1 : left.sourceRef.contentHash > right.sourceRef.contentHash ? 1 : 0);
  }

  private async wakeTarget(input: Parameters<NonNullable<CrossRunWake["wake"]>>[0]): Promise<Awaited<ReturnType<NonNullable<CrossRunWake["wake"]>>>> {
    const wakeAdapter = this.#options.wake;
    const wake = wakeAdapter === undefined ? this.#options.wakeTarget : undefined;
    if (wakeAdapter === undefined && wake === undefined) return { status: "already-active" };
    const result = wakeAdapter !== undefined
      ? wakeAdapter.wake(structuredClone(input))
      : wake!(structuredClone(input));
    const normalized = await result;
    validateWakeResult(normalized);
    return normalized;
  }

  private async admitTarget(input: Parameters<NonNullable<CrossRunTargetAdmission["admit"]>>[0]): Promise<CrossRunTargetAdmissionResult> {
    const admissionAdapter = this.#options.targetAdmission;
    const admit = admissionAdapter === undefined ? this.#options.admitTarget : undefined;
    if (admissionAdapter === undefined && admit === undefined) {
      throw new CrossRunProtocolError("target admission is not configured", "target-unavailable");
    }
    return admissionAdapter !== undefined
      ? admissionAdapter.admit(structuredClone(input))
      : admit!(structuredClone(input));
  }

  async #storeFor(endpoint: CrossRunEndpoint): Promise<CrossRunFactStore> {
    let store: CrossRunFactStore;
    try {
      store = this.#options.factStoreFor === undefined
        ? this.#fallbackStore
        : await this.#options.factStoreFor(structuredClone(endpoint));
    } catch (error: unknown) {
      if (error instanceof CrossRunProtocolError) throw error;
      throw new CrossRunProtocolError("A2A fact store is unavailable", "durable-fact-failed");
    }
    if (store === null || typeof store !== "object"
      || typeof store.append !== "function" || typeof store.read !== "function") {
      throw new CrossRunProtocolError("A2A fact store must implement append/read", "durable-fact-failed");
    }
    return store;
  }

  async #authenticatedSender(input: CrossRunSenderIdentity): Promise<CrossRunSenderIdentity> {
    const sender = normalizeSenderIdentity(input);
    if (this.#options.verifySender !== undefined) {
      let verified = false;
      try {
        verified = await this.#options.verifySender(structuredClone(sender));
      } catch {
        verified = false;
      }
      if (verified !== true) {
        throw new CrossRunProtocolError("authenticated sender proof was rejected", "identity-forged");
      }
    }
    return sender;
  }

  private async appendFact(store: CrossRunFactStore, fact: CrossRunFact): Promise<void> {
    try {
      await store.append(structuredClone(fact));
    } catch (error: unknown) {
      if (isIdempotencyConflict(error)) {
        if (error instanceof CrossRunProtocolError) throw error;
        throw new CrossRunProtocolError(
          "A2A outbox fact idempotency conflicts with durable content",
          "idempotency-conflict",
        );
      }
      throw new CrossRunProtocolError("Unable to persist A2A outbox fact", "durable-fact-failed");
    }
  }

  private async recordReceipt(
    store: CrossRunFactStore,
    receipt: CrossRunReceipt,
    tolerateFailure: boolean,
  ): Promise<CrossRunReceipt> {
    try {
      await store.append({ kind: "outbox.receipt", receipt: structuredClone(receipt) });
      return receipt;
    } catch (error: unknown) {
      if (error instanceof CrossRunProtocolError && error.code !== "durable-fact-failed") {
        throw error;
      }
      if (isIdempotencyConflict(error)) {
        throw new CrossRunProtocolError(
          "A2A receipt idempotency conflicts with durable content",
          "idempotency-conflict",
        );
      }
      if (!tolerateFailure) throw new CrossRunProtocolError("Unable to persist A2A receipt", "durable-fact-failed");
      return normalizeReceipt({
        ...receipt,
        receiptId: createCrossRunReceiptId(receipt.routeId, "uncertain"),
        status: "uncertain",
        recordedAt: this.nowIso(),
        reason: "source-receipt-failed",
        diagnostic: "durable-fact-failed",
      });
    }
  }

  private async findExisting(store: CrossRunFactStore, runId: string, routeId: string): Promise<FactGroup | undefined> {
    const facts = await this.readFacts(store, { runId });
    return groupFacts(facts, true).get(routeId);
  }

  private async readFacts(
    store: CrossRunFactStore,
    scope: { readonly runId?: string; readonly routeId?: string },
  ): Promise<readonly CrossRunFact[]> {
    try {
      const facts = await store.read(scope);
      if (!Array.isArray(facts)) {
        throw new CrossRunProtocolError(
          "A2A fact store returned an invalid result",
          "durable-fact-failed",
        );
      }
      return facts;
    } catch (error: unknown) {
      if (error instanceof CrossRunProtocolError && error.code !== "durable-fact-failed") {
        throw error;
      }
      throw new CrossRunProtocolError(
        "Unable to read A2A outbox facts",
        "durable-fact-failed",
      );
    }
  }

  private makeReceipt(
    envelope: CrossRunEnvelope,
    status: CrossRunReceipt["status"],
    fields: Partial<Pick<CrossRunReceipt, "targetMessageId" | "attemptId" | "reason" | "retryAt" | "diagnostic">> = {},
  ): CrossRunReceipt {
    return normalizeReceipt({
      protocolVersion: 1,
      receiptId: createCrossRunReceiptId(envelope.routeId, status),
      routeId: envelope.routeId,
      messageId: envelope.messageId,
      idempotencyKey: envelope.idempotencyKey,
      source: structuredClone(envelope.source),
      target: structuredClone(envelope.target),
      relationship: envelope.relationship,
      status,
      recordedAt: this.nowIso(),
      ...(fields.targetMessageId === undefined ? {} : { targetMessageId: fields.targetMessageId }),
      ...(fields.attemptId === undefined ? {} : { attemptId: fields.attemptId }),
      ...(fields.reason === undefined ? {} : { reason: fields.reason }),
      ...(fields.retryAt === undefined ? {} : { retryAt: fields.retryAt }),
      ...(fields.diagnostic === undefined ? {} : { diagnostic: fields.diagnostic.slice(0, 512) }),
    });
  }

  private rejectedReceipt(
    source: CrossRunEndpoint,
    target: CrossRunEndpoint,
    relationship: CrossRunRelationship,
    idempotencyKey: string,
    reason: CrossRunReceipt["reason"],
    status: CrossRunReceipt["status"] = "rejected",
  ): CrossRunReceipt {
    const routeId = createCrossRunRouteId(source, target, idempotencyKey);
    const createdAt = this.nowIso();
    const payload = { type: "message.inform" as const, text: "rejected" };
    const messageId = createCrossRunMessageId(routeId, {
      payload,
      conversationId: "rejected",
      threadId: "rejected",
      correlationId: "rejected",
      visibility: "run",
      priority: 0,
      artifactRefs: [],
    });
    const envelope = {
      protocolVersion: 1,
      messageId,
      routeId,
      source,
      target,
      relationship,
      conversationId: "rejected",
      threadId: "rejected",
      correlationId: "rejected",
      idempotencyKey,
      createdAt,
      visibility: "run" as const,
      priority: 0,
      payload,
      artifacts: [],
    } satisfies CrossRunEnvelope;
    return this.makeReceipt(envelope, status, {
      ...(reason === undefined ? {} : { reason }),
    });
  }

  private createId(
    kind: "attempt" | "receipt",
    routeId?: string,
    ordinal?: number,
  ): string {
    const provided = this.#options.createId?.(kind);
    if (provided !== undefined) return provided;
    if (kind === "attempt" && routeId !== undefined && ordinal !== undefined) {
      return `attempt:${sha256(stableJson({ routeId, ordinal }))}`;
    }
    return `${kind}:${this.now().getTime()}:${Math.random().toString(36).slice(2, 10)}`;
  }

  private now(): Date {
    try {
      const value = this.#clock.now();
      if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw new Error("invalid clock");
      }
      return new Date(value.getTime());
    } catch {
      throw new CrossRunProtocolError("A2A clock is invalid", "durable-fact-failed");
    }
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private failureReceipt(
    source: CrossRunEndpoint,
    request: unknown,
    index: number,
    reason: CrossRunReceipt["reason"],
    diagnostic?: string,
  ): CrossRunReceipt {
    const key = safeFailureKey(request, index);
    const relationship = safeFailureRelationship(request);
    const target = safeFailureTarget(source, request, index);
    const receipt = this.rejectedReceipt(source, target, relationship, key, reason);
    return diagnostic === undefined
      ? receipt
      : normalizeReceipt({ ...receipt, diagnostic: diagnostic.slice(0, 128) });
  }
}

/** Pure projection of durable saga facts into user/diagnostic receipts. */
export function projectCrossRunFacts(facts: readonly CrossRunFact[]): CrossRunProjection {
  const groups = groupFacts(facts);
  const entries = [...groups.values()]
    .sort((left, right) => left.envelope.routeId < right.envelope.routeId ? -1 : left.envelope.routeId > right.envelope.routeId ? 1 : 0)
    .map((entry): CrossRunReceiptView => {
      if (entry.receipt !== undefined) {
        return {
          route: routeOf(entry.envelope),
          envelope: structuredClone(entry.envelope),
          status: entry.receipt.status,
          receipt: structuredClone(entry.receipt),
          attemptCount: entry.attempts.length,
          ...(entry.receipt.diagnostic === undefined ? {} : { diagnostic: entry.receipt.diagnostic }),
        };
      }
      const uncertain = entry.attempts.length > 0;
      return {
        route: routeOf(entry.envelope),
        envelope: structuredClone(entry.envelope),
        status: uncertain ? "uncertain" : "queued",
        attemptCount: entry.attempts.length,
        ...(uncertain ? { diagnostic: "delivery-attempt-without-receipt" } : {}),
      };
    });
  return {
    entries,
    pending: entries.filter((entry) => entry.status === "queued"),
    uncertain: entries.filter((entry) => entry.status === "uncertain"),
  };
}

export const projectA2AReceipts = projectCrossRunFacts;

/** Map target Inbox claim state to the cross-Run receipt vocabulary. */
export function projectCrossRunInbox(records: readonly InboxRecord[]): readonly CrossRunReceiptView[] {
  const projected: CrossRunReceiptView[] = [];
  for (const record of records) {
    try {
      if (record === null || typeof record !== "object"
        || record.message === null || typeof record.message !== "object"
        || record.message.routeId === undefined
        || record.message.sourceEndpoint === undefined
        || record.message.targetEndpoint === undefined
        || record.message.routeRelationship === undefined
        || record.message.routeArtifacts === undefined) {
        continue;
      }
      const source = normalizeEndpoint(record.message.sourceEndpoint, "message.sourceEndpoint");
      const target = normalizeEndpoint(record.message.targetEndpoint, "message.targetEndpoint");
      const envelope = normalizeEnvelope({
        protocolVersion: 1 as const,
        messageId: record.message.messageId,
        routeId: record.message.routeId,
        source,
        target,
        relationship: record.message.routeRelationship,
        conversationId: record.message.conversationId,
        threadId: record.message.threadId,
        correlationId: record.message.correlationId,
        idempotencyKey: record.message.idempotencyKey,
        createdAt: record.message.createdAt,
        ...(record.message.expiresAt === undefined ? {} : { expiresAt: record.message.expiresAt }),
        ...(record.message.causationId === undefined ? {} : { causationId: record.message.causationId }),
        visibility: record.message.visibility,
        priority: record.message.priority,
        payload: record.message.payload,
        artifacts: record.message.routeArtifacts,
      });
      if (record.status !== "pending"
        && record.status !== "claimed"
        && record.status !== "handled") {
        continue;
      }
      // A claimed projection is a delivery assertion. Do not turn a record
      // with a missing or malformed lease into a positive receipt.
      if (record.status === "claimed" && !validInboxClaim(record.claim)) {
        continue;
      }
      if (record.status === "handled" && !validInboxDate(record.handledAt)) {
        continue;
      }
      const status = record.status === "handled" ? "handled" : record.status === "claimed" ? "delivered" : "queued";
      projected.push({ route: routeOf(envelope), envelope, status, attemptCount: 0 });
    } catch {
      // Historical Inbox data may predate the cross-Run metadata. A single
      // malformed record must not make the whole read-only projection fail.
    }
  }
  return projected;
}

type FactGroup = {
  envelope: CrossRunEnvelope;
  attempts: Extract<CrossRunFact, { kind: "outbox.attempted" }>[];
  receipt?: CrossRunReceipt;
};

function groupFacts(facts: readonly CrossRunFact[], strict = false): Map<string, FactGroup> {
  const groups = new Map<string, FactGroup>();
  if (!Array.isArray(facts)) {
    if (strict) {
      throw new CrossRunProtocolError("A2A fact store returned an invalid result", "durable-fact-failed");
    }
    return groups;
  }
  for (const raw of facts) {
    let fact: CrossRunFact;
    try {
      fact = normalizeCrossRunFact(raw);
    } catch (error: unknown) {
      if (strict) {
        throw new CrossRunProtocolError(
          "A2A fact store returned a malformed fact",
          "durable-fact-failed",
        );
      }
      continue;
    }
    if (fact.kind === "outbox.pending") {
      const current = groups.get(fact.envelope.routeId);
      if (current !== undefined) {
        if (strict && !sameLogicalEnvelope(current.envelope, fact.envelope)) {
          throw new CrossRunProtocolError("A2A fact store contains conflicting pending envelopes", "idempotency-conflict");
        }
        continue;
      }
      groups.set(fact.envelope.routeId, { envelope: structuredClone(fact.envelope), attempts: [] });
    } else if (fact.kind === "outbox.attempted") {
      const current = groups.get(fact.routeId);
      if (current === undefined) {
        if (strict) throw new CrossRunProtocolError("A2A attempt has no durable pending fact", "durable-fact-failed");
        continue;
      }
      if (fact.messageId !== current.envelope.messageId) {
        if (strict) throw new CrossRunProtocolError("A2A attempt does not match its pending message", "idempotency-conflict");
        continue;
      }
      const existingAttempt = current.attempts.find((attempt) => attempt.attemptId === fact.attemptId);
      if (existingAttempt !== undefined) {
        if (strict && stableJson(existingAttempt) !== stableJson(fact)) {
          throw new CrossRunProtocolError("A2A route contains a conflicting delivery attempt", "idempotency-conflict");
        }
        continue;
      }
      if (current.receipt !== undefined) {
        if (strict) {
          throw new CrossRunProtocolError("A2A route already has a terminal receipt", "idempotency-conflict");
        }
        continue;
      }
      current.attempts.push(structuredClone(fact));
    } else {
      const current = groups.get(fact.receipt.routeId);
      if (current === undefined) {
        if (strict) throw new CrossRunProtocolError("A2A receipt has no durable pending fact", "durable-fact-failed");
        continue;
      }
      try {
        assertCrossRunReceiptMatchesEnvelope(fact.receipt, current.envelope);
      } catch {
        if (strict) throw new CrossRunProtocolError("A2A receipt does not match its pending envelope", "idempotency-conflict");
        continue;
      }
      if (fact.receipt.attemptId !== undefined
        && !current.attempts.some((attempt) => attempt.attemptId === fact.receipt.attemptId)) {
        if (strict) throw new CrossRunProtocolError("A2A receipt references an unknown delivery attempt", "idempotency-conflict");
        continue;
      }
      if (current.receipt !== undefined) {
        if (strict && stableJson(current.receipt) !== stableJson(fact.receipt)) {
          throw new CrossRunProtocolError("A2A route contains conflicting terminal receipts", "idempotency-conflict");
        }
        continue;
      }
      current.receipt = structuredClone(fact.receipt);
    }
  }
  for (const entry of groups.values()) {
    entry.attempts.sort((left, right) => (
      left.attemptedAt < right.attemptedAt
        ? -1
        : left.attemptedAt > right.attemptedAt
          ? 1
          : left.attemptId < right.attemptId ? -1 : left.attemptId > right.attemptId ? 1 : 0
    ));
  }
  return groups;
}

function routeOf(envelope: CrossRunEnvelope): CrossRunRoute {
  return {
    routeId: envelope.routeId,
    source: structuredClone(envelope.source),
    target: structuredClone(envelope.target),
    relationship: envelope.relationship,
    artifacts: [...envelope.artifacts].map((artifact) => structuredClone(artifact)),
  };
}

function normalizeRoster(value: CrossRunRoster, sender: CrossRunEndpoint): CrossRunRoster {
  if (!isPlainRecord(value)
    || value.current === undefined
    || value.entries === undefined
    || !sameEndpointSafe(value.current, sender)
    || !Array.isArray(value.entries)) {
    throw new CrossRunProtocolError("roster current identity does not match authenticated sender", "identity-forged");
  }
  exactKeys(value, ["current", "entries"], "roster");
  const entries = [...value.entries]
    .map((entry) => normalizeRosterEntry(entry))
    .filter((entry) => entry.reachable && !sameEndpoint(entry.endpoint, sender))
    .sort((left, right) => {
      const leftKey = `${left.name ?? ""}\u0000${endpointKey(left.endpoint)}`;
      const rightKey = `${right.name ?? ""}\u0000${endpointKey(right.endpoint)}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  return Object.freeze({ current: structuredClone(sender), entries });
}

function normalizeRosterEntry(value: CrossRunRosterEntry): CrossRunRosterEntry {
  if (!isPlainRecord(value)) {
    throw new CrossRunProtocolError("roster entry is invalid", "selector-invalid");
  }
  exactKeys(value, ["endpoint", "name", "relationship", "status", "reachable"], "roster entry");
  const endpoint = normalizeEndpoint(value.endpoint, "roster.endpoint");
  if (value.name !== undefined) boundedTargetName(value.name, "roster.name");
  if (value.relationship !== "parent" && value.relationship !== "sibling" && value.relationship !== "child" && value.relationship !== "direct") {
    throw new CrossRunProtocolError("roster relationship is invalid", "selector-invalid");
  }
  if (value.status !== "idle" && value.status !== "busy" && value.status !== "inactive") {
    throw new CrossRunProtocolError("roster status is invalid", "selector-invalid");
  }
  if (typeof value.reachable !== "boolean") throw new CrossRunProtocolError("roster reachable must be boolean", "selector-invalid");
  return Object.freeze({ endpoint, relationship: value.relationship, status: value.status, reachable: value.reachable, ...(value.name === undefined ? {} : { name: value.name }) });
}

function sameEndpointSafe(left: unknown, right: CrossRunEndpoint): boolean {
  try {
    return isPlainRecord(left) && sameEndpoint(normalizeEndpoint(left, "roster.current"), right);
  } catch {
    return false;
  }
}

function normalizeResolvedTarget(value: CrossRunResolvedTarget): CrossRunResolvedTarget {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new CrossRunProtocolError("resolver returned an invalid target", "target-unavailable");
  }
  exactKeys(value as unknown as Record<string, unknown>, ["endpoint", "relationship", "name", "status", "reachable"], "target");
  const endpoint = normalizeEndpoint(value.endpoint, "target.endpoint");
  if (value.relationship !== "parent" && value.relationship !== "sibling" && value.relationship !== "child" && value.relationship !== "direct") {
    throw new CrossRunProtocolError("target relationship is invalid", "selector-invalid");
  }
  if (value.name !== undefined) boundedTargetName(value.name, "target.name");
  if (value.status !== undefined
    && value.status !== "idle" && value.status !== "busy" && value.status !== "inactive") {
    throw new CrossRunProtocolError("target status is invalid", "selector-invalid");
  }
  if (value.reachable !== undefined && typeof value.reachable !== "boolean") {
    throw new CrossRunProtocolError("target reachable must be boolean", "selector-invalid");
  }
  return { endpoint, relationship: value.relationship, ...(value.name === undefined ? {} : { name: value.name }), ...(value.status === undefined ? {} : { status: value.status }), ...(value.reachable === undefined ? {} : { reachable: value.reachable }) };
}

function assertResolvedTargetMatchesSelector(
  selector: CrossRunTargetSelector,
  target: CrossRunResolvedTarget,
): void {
  if (target.relationship !== selector.relationship) {
    throw new CrossRunProtocolError(
      "resolver relationship does not match the requested selector",
      "identity-forged",
    );
  }
  // A resolver may intentionally return only the machine endpoint. When it
  // does echo a human selector, however, a conflicting name is evidence that
  // the host resolved a different target than requested.
  if ("name" in selector && selector.name !== undefined
    && target.name !== undefined && target.name !== selector.name) {
    throw new CrossRunProtocolError(
      "resolver target name does not match the requested selector",
      "identity-forged",
    );
  }
  if ("id" in selector && selector.id !== undefined
    && target.endpoint.runId !== selector.id
    && target.endpoint.laneId !== selector.id) {
    throw new CrossRunProtocolError(
      "resolver target id does not match the requested selector",
      "identity-forged",
    );
  }
  if ("endpoint" in selector && selector.endpoint !== undefined
    && !sameEndpoint(target.endpoint, selector.endpoint)) {
    throw new CrossRunProtocolError(
      "resolver endpoint does not match the requested selector",
      "identity-forged",
    );
  }
}

function boundedTargetName(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new CrossRunProtocolError(`${path} is invalid`, "selector-invalid");
  }
}

function entryTarget(entry: CrossRunRosterEntry): CrossRunResolvedTarget {
  return { endpoint: structuredClone(entry.endpoint), relationship: entry.relationship, ...(entry.name === undefined ? {} : { name: entry.name }), status: entry.status, reachable: entry.reachable };
}

function validateAdmissionResult(value: unknown): asserts value is CrossRunTargetAdmissionResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new CrossRunProtocolError("target admission returned an invalid result", "target-admission-failed");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.status !== "accepted" && candidate.status !== "queued"
    && candidate.status !== "delivered" && candidate.status !== "handled"
    && candidate.status !== "duplicate" && candidate.status !== "rejected") {
    throw new CrossRunProtocolError("target admission returned an invalid status", "target-admission-failed");
  }
  const allowed = candidate.status === "rejected"
    ? ["status", "reason", "retryAt"]
    : ["status", "messageId", "retryAt"];
  exactKeys(candidate, allowed, "target admission result");
  if (candidate.status === "rejected") {
    if (candidate.reason !== undefined) validateReceiptReason(candidate.reason);
  } else if (candidate.messageId !== undefined) {
    boundedAdapterString(candidate.messageId, "target admission result.messageId");
  }
  if (candidate.retryAt !== undefined) validateAdapterDateTime(candidate.retryAt, "target admission result.retryAt");
}

function validateAuthorizationResult(value: unknown): asserts value is CrossRunAuthorization {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new CrossRunProtocolError("authorizer returned an invalid result", "authorization-denied");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.allowed !== true && candidate.allowed !== false) {
    throw new CrossRunProtocolError("authorizer returned an invalid decision", "authorization-denied");
  }
  exactKeys(candidate, ["allowed", "reason", "reauthenticated"], "authorization result");
  if (candidate.reason !== undefined) validateReceiptReason(candidate.reason);
  if (candidate.reauthenticated !== undefined && typeof candidate.reauthenticated !== "boolean") {
    throw new CrossRunProtocolError("authorizer returned an invalid reauthentication flag", "authorization-denied");
  }
}

function validateAdmissionDecision(value: unknown): asserts value is CrossRunAdmissionDecision {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new CrossRunProtocolError("admission policy returned an invalid result", "capacity-rejected");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.allowed === true) {
    exactKeys(candidate, ["allowed"], "admission result");
    return;
  }
  if (candidate.allowed !== false
    || (candidate.reason !== "target-capacity" && candidate.reason !== "rate-limited")) {
    throw new CrossRunProtocolError("admission policy returned an invalid decision", "capacity-rejected");
  }
  exactKeys(candidate, ["allowed", "reason", "retryAt"], "admission result");
  if (candidate.retryAt !== undefined) validateAdapterDateTime(candidate.retryAt, "admission result.retryAt");
}

function validateWakeResult(value: unknown): asserts value is Awaited<ReturnType<NonNullable<CrossRunWake["wake"]>>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new CrossRunProtocolError("wake returned an invalid result", "wake-failed");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.status !== "queued" && candidate.status !== "already-active" && candidate.status !== "rejected") {
    throw new CrossRunProtocolError("wake returned an invalid status", "wake-failed");
  }
  exactKeys(candidate, ["status", "retryAt"], "wake result");
  if (candidate.retryAt !== undefined) validateAdapterDateTime(candidate.retryAt, "wake result.retryAt");
}

function validateReceiptReason(value: unknown): asserts value is NonNullable<CrossRunReceipt["reason"]> {
  const reasons: readonly NonNullable<CrossRunReceipt["reason"]>[] = [
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
  ];
  if (typeof value !== "string" || !reasons.includes(value as NonNullable<CrossRunReceipt["reason"]>)) {
    throw new CrossRunProtocolError("adapter returned an invalid receipt reason", "target-admission-failed");
  }
}

function boundedAdapterString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new CrossRunProtocolError(`${path} is invalid`, "target-admission-failed");
  }
}

function validateAdapterDateTime(value: unknown, path: string): asserts value is string {
  boundedAdapterString(value, path);
  if (!Number.isFinite(Date.parse(value))) {
    throw new CrossRunProtocolError(`${path} must be a valid date-time`, "target-admission-failed");
  }
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) {
      throw new CrossRunProtocolError(`${path}.${key} is not allowed`, "invalid-request");
    }
  }
}

function sameArtifactRef(left: import("../domain/types.js").ArtifactRef, right: import("../domain/types.js").ArtifactRef): boolean {
  return left.id === right.id && left.contentHash === right.contentHash && left.mediaType === right.mediaType && left.byteLength === right.byteLength;
}

function normalizeRelayDelivery(
  value: unknown,
  expectedRef: ArtifactRef,
  target: CrossRunEndpoint,
  visibility: Visibility,
): CrossRunArtifactDelivery {
  try {
    if (!isPlainRecord(value)
      || !hasExactKeys(value, ["sourceRef", "targetRef", "visibility", "targetWorkspaceId"])
      || !sameArtifactRefValue(value.sourceRef, expectedRef)
      || !sameArtifactRefValue(value.targetRef, expectedRef)
      || value.visibility !== visibility
      || value.targetWorkspaceId !== target.workspaceId) {
      throw new CrossRunProtocolError(
        "Artifact relay returned a mismatched reference",
        "artifact-mismatch",
      );
    }
  } catch (error: unknown) {
    if (error instanceof CrossRunProtocolError) throw error;
    throw new CrossRunProtocolError(
      "Artifact relay returned an invalid result",
      "artifact-mismatch",
    );
  }
  return Object.freeze({
    sourceRef: structuredClone(expectedRef),
    targetRef: structuredClone(expectedRef),
    visibility,
    targetWorkspaceId: target.workspaceId,
  });
}

function sameArtifactRefValue(value: unknown, expected: ArtifactRef): boolean {
  return isPlainRecord(value)
    && hasExactKeys(value, ["id", "contentHash", "mediaType", "byteLength"])
    && value.id === expected.id
    && value.contentHash === expected.contentHash
    && value.mediaType === expected.mediaType
    && value.byteLength === expected.byteLength;
}

function safeFailureKey(request: unknown, index: number): string {
  try {
    if (isPlainRecord(request)
      && typeof request.idempotencyKey === "string"
      && request.idempotencyKey.length > 0
      && request.idempotencyKey.length <= 4_096
      && !/[\u0000-\u001f\u007f]/u.test(request.idempotencyKey)) {
      return request.idempotencyKey;
    }
  } catch {
    // Fall through to the deterministic batch-local key.
  }
  return `batch:${index}`;
}

function safeFailureRelationship(request: unknown): CrossRunRelationship {
  try {
    if (!isPlainRecord(request) || !isPlainRecord(request.target)) return "direct";
    const relationship = request.target.relationship;
    if (relationship === "parent" || relationship === "sibling"
      || relationship === "child" || relationship === "direct") {
      return relationship;
    }
  } catch {
    // A malformed selector is represented by the synthetic direct route.
  }
  return "direct";
}

function safeFailureTarget(
  source: CrossRunEndpoint,
  request: unknown,
  index: number,
): CrossRunEndpoint {
  try {
    if (isPlainRecord(request) && isPlainRecord(request.target)
      && request.target.relationship === "direct"
      && request.target.endpoint !== undefined) {
      const target = normalizeEndpoint(request.target.endpoint, "request.target.endpoint");
      if (!sameEndpoint(source, target)) return target;
    }
  } catch {
    // Resolution failed, so a valid endpoint cannot be trusted from the item.
  }
  const primaryLaneId = `a2a-unresolved-${index}`;
  return Object.freeze({
    workspaceId: source.workspaceId,
    sessionId: source.sessionId,
    runId: source.runId,
    laneId: source.laneId === primaryLaneId
      ? `a2a-unresolved-alt-${index}`
      : primaryLaneId,
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validInboxClaim(value: unknown): boolean {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ["claimId", "claimedBy", "claimedAt", "attempt"])) {
    return false;
  }
  return validInboxString(value.claimId)
    && validInboxString(value.claimedBy)
    && validInboxDate(value.claimedAt)
    && Number.isSafeInteger(value.attempt)
    && (value.attempt as number) > 0;
}

function validInboxDate(value: unknown): boolean {
  return validInboxString(value) && Number.isFinite(Date.parse(value));
}

function validInboxString(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4_096
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function expectedArtifactDeliveries(
  refs: readonly import("../domain/types.js").ArtifactRef[],
  target: CrossRunEndpoint,
  visibility: Visibility,
): readonly CrossRunArtifactDelivery[] {
  return [...refs]
    .map((sourceRef) => ({
      sourceRef: structuredClone(sourceRef),
      targetRef: structuredClone(sourceRef),
      visibility,
      targetWorkspaceId: target.workspaceId,
    }))
    .sort((left, right) => left.sourceRef.contentHash < right.sourceRef.contentHash ? -1
      : left.sourceRef.contentHash > right.sourceRef.contentHash ? 1 : 0);
}

function positiveBound(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new CrossRunProtocolError(`${field} is outside the supported bound`);
  return value;
}

function diagnosticCode(error: unknown): string {
  if (error instanceof CrossRunProtocolError) return error.code;
  return "transport-failure";
}

/** Recognize conflicts from both the cross-Run port and concrete Ledger adapters. */
function isIdempotencyConflict(error: unknown): boolean {
  if (error instanceof CrossRunProtocolError) return error.code === "idempotency-conflict";
  if (error === null || typeof error !== "object") return false;
  const candidate = error as { readonly name?: unknown; readonly code?: unknown; readonly message?: unknown };
  return candidate.name === "IdempotencyConflictError"
    || candidate.code === "idempotency-conflict"
    || (typeof candidate.message === "string" && /idempotency\s+conflict/iu.test(candidate.message));
}

function safeResolverError(error: unknown): CrossRunProtocolError {
  if (error instanceof CrossRunProtocolError) {
    const message = error.code === "selector-ambiguous"
      ? "target selector is ambiguous"
      : error.code === "selector-invalid"
        ? "target selector is invalid"
        : "target resolver rejected the request";
    return new CrossRunProtocolError(message, error.code);
  }
  return new CrossRunProtocolError("target resolver failed", "target-unavailable");
}

function failureReason(error: unknown): CrossRunReceipt["reason"] {
  if (error instanceof CrossRunProtocolError) {
    switch (error.code) {
      case "selector-invalid":
      case "selector-ambiguous":
      case "target-unavailable":
        return "target-unavailable";
      case "authorization-denied":
      case "cross-workspace-denied":
        return "authorization-denied";
      case "expired":
        return "expired";
      case "artifact-invalid":
      case "artifact-mismatch":
      case "artifact-integrity":
        return "artifact-rejected";
      case "rate-limited":
        return "rate-limited";
      case "capacity-rejected":
        return "target-capacity";
      case "wake-failed":
        return "wake-failed";
      case "idempotency-conflict":
        return "idempotency-conflict";
      default:
        return "target-admission-failed";
    }
  }
  return "target-admission-failed";
}
