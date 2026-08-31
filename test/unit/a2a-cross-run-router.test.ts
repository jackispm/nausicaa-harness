import { describe, expect, it } from "vitest";

import {
  CrossRunProtocolError,
  CrossRunRouter,
  MemoryCrossRunFactStore,
  createCrossRunMessageId,
  createCrossRunRouteId,
  envelopeToA2AMessage,
  normalizeCrossRunSendRequest,
  normalizeEnvelope,
  projectCrossRunFacts,
  projectCrossRunInbox,
} from "../../src/a2a/index.js";
import type {
  Clock,
  CrossRunArtifactRelayInput,
  CrossRunAuthorizationInput,
  CrossRunEndpoint,
  CrossRunFact,
  CrossRunFactStore,
  CrossRunTargetAdmissionInput,
  CrossRunSenderIdentity,
  CrossRunSendRequest,
  CrossRunTargetSelector,
  CrossRunWakeInput,
} from "../../src/a2a/index.js";
import { createArtifactRef } from "../../src/store/index.js";

class FixedClock implements Clock {
  constructor(readonly instant = new Date("2026-08-31T00:00:00.000Z")) {}

  now(): Date {
    return new Date(this.instant);
  }
}

const source: CrossRunEndpoint = {
  workspaceId: "workspace-a",
  sessionId: "session-a",
  runId: "run-a",
  laneId: "main",
};
const child: CrossRunEndpoint = {
  workspaceId: "workspace-a",
  sessionId: "session-child",
  runId: "run-child",
  laneId: "worker",
};
const sibling: CrossRunEndpoint = {
  workspaceId: "workspace-a",
  sessionId: "session-sibling",
  runId: "run-sibling",
  laneId: "worker",
};
const parent: CrossRunEndpoint = {
  workspaceId: "workspace-a",
  sessionId: "session-parent",
  runId: "run-parent",
  laneId: "main",
};

const sender: CrossRunSenderIdentity = {
  endpoint: source,
  proof: { kind: "lease", authenticated: true, token: "opaque-proof" },
  relationshipGrants: ["parent", "sibling", "child", "direct"],
};

function request(
  key = "key-1",
  target: CrossRunSendRequest["target"] = { relationship: "direct", id: child.runId },
  text = "hello",
  overrides: Partial<CrossRunSendRequest> = {},
): CrossRunSendRequest {
  return {
    target,
    payload: { type: "message.inform", text },
    conversationId: "conversation-1",
    threadId: "thread-1",
    correlationId: "correlation-1",
    idempotencyKey: key,
    visibility: "run",
    priority: 1,
    ...overrides,
  };
}

function router(options: ConstructorParameters<typeof CrossRunRouter>[0] = {}): CrossRunRouter {
  return new CrossRunRouter({
    clock: new FixedClock(),
    resolver: {
      resolve: async () => ({ endpoint: child, relationship: "direct" }),
    },
    targetAdmission: {
      admit: async () => ({ status: "queued", messageId: "target-message-1" }),
    },
    ...options,
  });
}

function envelopeFor(input: CrossRunSendRequest) {
  const normalized = normalizeCrossRunSendRequest(input, {
    now: new FixedClock().now(),
  });
  const routeId = createCrossRunRouteId(source, child, normalized.idempotencyKey);
  return normalizeEnvelope({
    protocolVersion: 1,
    messageId: createCrossRunMessageId(routeId, normalized),
    routeId,
    source,
    target: child,
    relationship: "direct",
    conversationId: normalized.conversationId,
    threadId: normalized.threadId,
    correlationId: normalized.correlationId,
    idempotencyKey: normalized.idempotencyKey,
    createdAt: normalized.createdAt,
    ...(normalized.expiresAt === undefined ? {} : { expiresAt: normalized.expiresAt }),
    visibility: normalized.visibility,
    priority: normalized.priority,
    payload: normalized.payload,
    artifacts: [],
  });
}

describe("CrossRunRouter", () => {
  it("writes pending before attempt, authorizes before target admission, and returns queued", async () => {
    const calls: string[] = [];
    const store = new MemoryCrossRunFactStore();
    const result = await new CrossRunRouter({
      clock: new FixedClock(),
      factStore: store,
      resolver: {
        resolve: async () => {
          calls.push("resolve");
          return { endpoint: child, relationship: "direct" };
        },
      },
      authorizer: {
        authorize: async () => {
          calls.push("authorize");
          return { allowed: true };
        },
      },
      admissionPolicy: {
        check: async () => {
          calls.push("policy");
          return { allowed: true };
        },
      },
      targetAdmission: {
        admit: async ({ envelope }) => {
          calls.push("admit");
          return { status: "queued", messageId: envelope.messageId };
        },
      },
      wake: {
        wake: async () => {
          calls.push("wake");
          return { status: "queued" };
        },
      },
      createId: (kind) => `${kind}-1`,
    }).send(request(), sender);

    expect(result.status).toBe("queued");
    expect(calls).toEqual(["resolve", "authorize", "policy", "admit", "wake"]);
    const facts = await store.read({ runId: source.runId });
    expect(facts.map((fact) => fact.kind)).toEqual([
      "outbox.pending",
      "outbox.attempted",
      "outbox.receipt",
    ]);
    expect(projectCrossRunFacts(facts).entries[0]).toMatchObject({
      status: "queued",
      attemptCount: 1,
    });
  });

  it("preserves receivers for stateful host adapter objects", async () => {
    const ref = createArtifactRef(new TextEncoder().encode("artifact"), "text/plain");
    class StatefulPorts {
      readonly calls: string[] = [];

      async resolve(selector: CrossRunTargetSelector) {
        this.calls.push("resolve");
        return { endpoint: child, relationship: selector.relationship };
      }

      async authorize(_input: CrossRunAuthorizationInput) {
        this.calls.push("authorize");
        return { allowed: true as const };
      }

      async relay(input: CrossRunArtifactRelayInput) {
        this.calls.push("relay");
        return {
          sourceRef: input.sourceRef,
          targetRef: input.sourceRef,
          visibility: input.visibility,
          targetWorkspaceId: input.target.workspaceId,
        };
      }

      async check() {
        this.calls.push("policy");
        return { allowed: true as const };
      }

      async admit(input: CrossRunTargetAdmissionInput) {
        this.calls.push("admit");
        return { status: "queued" as const, messageId: input.envelope.messageId };
      }

      async wake(_input: CrossRunWakeInput) {
        this.calls.push("wake");
        return { status: "queued" as const };
      }
    }

    const ports = new StatefulPorts();
    const result = await new CrossRunRouter({
      clock: new FixedClock(),
      resolver: ports,
      authorizer: ports,
      artifactRelay: ports,
      admissionPolicy: ports,
      targetAdmission: ports,
      wake: ports,
    }).send({ ...request("stateful-ports"), artifactRefs: [ref] }, sender);

    expect(result.status).toBe("queued");
    expect(ports.calls).toEqual([
      "resolve",
      "authorize",
      "relay",
      "policy",
      "admit",
      "wake",
    ]);
  });

  it("returns duplicate for the same logical key and conflict for changed content", async () => {
    let admissions = 0;
    const store = new MemoryCrossRunFactStore();
    const r = router({
      factStore: store,
      targetAdmission: {
        admit: async ({ envelope }) => {
          admissions += 1;
          return { status: "delivered", messageId: envelope.messageId };
        },
      },
      createId: (kind) => `${kind}-${admissions + 1}`,
    });
    await expect(r.send(request(), sender)).resolves.toMatchObject({ status: "delivered" });
    await expect(r.send(request(), sender)).resolves.toMatchObject({ status: "duplicate" });
    await expect(r.send(request("key-1", undefined, "changed"), sender))
      .resolves.toMatchObject({ status: "conflict", reason: "idempotency-conflict" });
    expect(admissions).toBe(1);
  });

  it("serializes the same source route across router instances", async () => {
    const store = new MemoryCrossRunFactStore();
    let admissions = 0;
    let releaseFirst!: () => void;
    let firstAdmissionStarted!: () => void;
    const admissionStarted = new Promise<void>((resolve) => {
      firstAdmissionStarted = resolve;
    });
    const firstAdmissionRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const targetAdmission = {
      admit: async ({ envelope }: CrossRunTargetAdmissionInput) => {
        admissions += 1;
        if (admissions === 1) {
          firstAdmissionStarted();
          await firstAdmissionRelease;
        }
        return { status: "queued" as const, messageId: envelope.messageId };
      },
    };
    const options = {
      clock: new FixedClock(),
      factStore: store,
      resolver: { resolve: async () => ({ endpoint: child, relationship: "direct" as const }) },
      targetAdmission,
    };
    const first = new CrossRunRouter(options).send(request("router-race"), sender);
    await admissionStarted;
    const second = new CrossRunRouter(options).send(request("router-race"), sender);
    await Promise.resolve();
    expect(admissions).toBe(1);
    releaseFirst();
    await expect(first).resolves.toMatchObject({ status: "queued" });
    await expect(second).resolves.toMatchObject({ status: "duplicate" });
    expect(admissions).toBe(1);
  });

  it("keeps busy admission non-blocking and enforces capacity before target side effects", async () => {
    let admitted = false;
    const busy = router({
      admissionPolicy: {
        check: async () => ({ allowed: false, reason: "target-capacity", retryAt: "2026-08-31T00:01:00.000Z" }),
      },
      targetAdmission: {
        admit: async () => {
          admitted = true;
          return { status: "queued" };
        },
      },
    });
    await expect(busy.send(request(), sender)).resolves.toMatchObject({
      status: "rejected",
      reason: "target-capacity",
      retryAt: "2026-08-31T00:01:00.000Z",
    });
    expect(admitted).toBe(false);

    const queued = router({
      targetAdmission: { admit: async () => ({ status: "queued" }) },
    });
    await expect(queued.send(request("busy"), sender)).resolves.toMatchObject({ status: "queued" });
  });

  it("denies cross-workspace routes unless the authorizer explicitly reauthenticates", async () => {
    const remote: CrossRunEndpoint = { ...child, workspaceId: "workspace-b" };
    const denied = new CrossRunRouter({
      clock: new FixedClock(),
      resolver: { resolve: async () => ({ endpoint: remote, relationship: "direct" }) },
      targetAdmission: { admit: async () => ({ status: "queued" }) },
    });
    await expect(denied.send(request(), sender)).resolves.toMatchObject({
      status: "rejected",
      reason: "cross-workspace-reauthentication-required",
    });

    const allowed = new CrossRunRouter({
      clock: new FixedClock(),
      resolver: { resolve: async () => ({ endpoint: remote, relationship: "direct" }) },
      authorizer: { authorize: async () => ({ allowed: true, reauthenticated: true }) },
      targetAdmission: { admit: async () => ({ status: "accepted" }) },
    });
    await expect(allowed.send(request("remote"), sender)).resolves.toMatchObject({ status: "accepted" });
  });

  it("resolves family selectors from a constrained roster and rejects ambiguity", async () => {
    const roster = {
      current: source,
      entries: [
        { endpoint: parent, relationship: "parent" as const, status: "idle" as const, reachable: true, name: "root" },
        { endpoint: sibling, relationship: "sibling" as const, status: "busy" as const, reachable: true, name: "reviewer" },
        { endpoint: child, relationship: "child" as const, status: "inactive" as const, reachable: false, name: "worker" },
      ],
    };
    const seen: string[] = [];
    const r = new CrossRunRouter({
      clock: new FixedClock(),
      roster: { list: async () => roster },
      targetAdmission: { admit: async ({ envelope }) => {
        seen.push(envelope.target.runId);
        return { status: "queued" };
      } },
    });
    await expect(r.send(request("parent", { relationship: "parent" }), sender)).resolves.toMatchObject({ status: "queued" });
    await expect(r.send(request("sibling", { relationship: "sibling", name: "reviewer" }), sender)).resolves.toMatchObject({ status: "queued" });
    await expect(r.send(request("child", { relationship: "child", name: "worker" }), sender)).rejects.toMatchObject({ code: "target-unavailable" });
    expect(seen).toEqual([parent.runId, sibling.runId]);

    const ambiguous = new CrossRunRouter({
      clock: new FixedClock(),
      roster: { list: async () => ({ current: source, entries: [
        { endpoint: sibling, relationship: "sibling", status: "idle", reachable: true, name: "same" },
        { endpoint: { ...sibling, runId: "run-sibling-2" }, relationship: "sibling", status: "idle", reachable: true, name: "same" },
      ] }) },
      targetAdmission: { admit: async () => ({ status: "queued" }) },
    });
    await expect(ambiguous.send(request("ambiguous", { relationship: "sibling", name: "same" }), sender))
      .rejects.toMatchObject({ code: "selector-ambiguous" });
  });

  it("preserves batch order, bounds explicit broadcast, and isolates failures", async () => {
    const targets = [child, sibling, parent];
    const r = new CrossRunRouter({
      clock: new FixedClock(),
      maxBatch: 3,
      resolver: { resolve: async (selector) => {
        const id = "id" in selector ? selector.id : undefined;
        if (id === "broken") throw new Error("resolver detail");
        const endpoint = targets.find((candidate) => candidate.runId === id) ?? child;
        return { endpoint, relationship: selector.relationship };
      } },
      targetAdmission: { admit: async ({ envelope }) => ({ status: "queued", messageId: envelope.messageId }) },
    });
    const receipts = await r.broadcast([
      { relationship: "direct", id: child.runId },
      { relationship: "direct", id: "broken" },
      { relationship: "direct", id: parent.runId },
    ], {
      payload: { type: "message.inform", text: "broadcast" },
      conversationId: "c",
      threadId: "t",
      correlationId: "c",
      idempotencyKey: "broadcast",
      visibility: "run",
      priority: 0,
    }, sender);
    expect(receipts).toHaveLength(3);
    expect(receipts.map((receipt) => receipt.status)).toEqual(["queued", "rejected", "queued"]);
    await expect(r.broadcast([], request(), sender)).rejects.toMatchObject({ code: "selector-invalid" });
    await expect(r.broadcast(new Array(4).fill({ relationship: "direct", id: child.runId }), request(), sender))
      .rejects.toMatchObject({ code: "selector-invalid" });
  });

  it("isolates throwing resolver, authorizer, and target admission ports", async () => {
    const resolved: string[] = [];
    const admitted: string[] = [];
    const r = new CrossRunRouter({
      clock: new FixedClock(),
      resolver: { resolve: async (selector) => {
        const id = "id" in selector ? selector.id : undefined;
        resolved.push(id ?? "missing");
        if (id === "resolver-error") throw new Error("resolver secret");
        const endpoint = id === sibling.runId
          ? sibling
          : id === parent.runId ? parent : child;
        return { endpoint, relationship: selector.relationship };
      } },
      authorizer: { authorize: async ({ target }) => {
        if (target.runId === sibling.runId) throw new Error("authorizer secret");
        return { allowed: true };
      } },
      targetAdmission: { admit: async ({ envelope }) => {
        admitted.push(envelope.target.runId);
        if (envelope.target.runId === parent.runId) throw new Error("admitter secret");
        return { status: "queued", messageId: envelope.messageId };
      } },
    });

    const receipts = await r.sendMany([
      request("resolver-throw", { relationship: "direct", id: "resolver-error" }),
      request("authorizer-throw", { relationship: "direct", id: sibling.runId }),
      request("admitter-throw", { relationship: "direct", id: parent.runId }),
      request("after-throws", { relationship: "direct", id: child.runId }),
    ], sender);

    expect(receipts.map(({ status, reason }) => ({ status, reason }))).toEqual([
      { status: "rejected", reason: "target-unavailable" },
      { status: "rejected", reason: "authorization-denied" },
      { status: "uncertain", reason: "target-admission-failed" },
      { status: "queued", reason: undefined },
    ]);
    expect(resolved).toEqual([
      "resolver-error",
      sibling.runId,
      parent.runId,
      child.runId,
    ]);
    expect(admitted).toEqual([parent.runId, child.runId]);
    expect(receipts.map((receipt) => receipt.diagnostic)).not.toContain("resolver secret");
    expect(receipts.map((receipt) => receipt.diagnostic)).not.toContain("authorizer secret");
    expect(receipts.map((receipt) => receipt.diagnostic)).not.toContain("admitter secret");
  });

  it("surfaces an uncertain side effect and never blindly replays it", async () => {
    let admissions = 0;
    const store = new MemoryCrossRunFactStore();
    const r = router({
      factStore: store,
      targetAdmission: { admit: async () => {
        admissions += 1;
        throw new Error("connection dropped after admission");
      } },
      createId: (kind) => `${kind}-uncertain`,
    });
    await expect(r.send(request("uncertain"), sender)).resolves.toMatchObject({
      status: "uncertain",
      reason: "target-admission-failed",
    });
    await expect(r.send(request("uncertain"), sender)).resolves.toMatchObject({
      status: "uncertain",
      reason: "target-admission-failed",
    });
    const recovery = await r.recover(sender);
    expect(recovery.uncertain[0]?.reason).toBe("target-admission-failed");
    expect(admissions).toBe(1);
  });

  it("rejects a stale/custom resolver relationship before authorization or admission", async () => {
    const calls: string[] = [];
    const r = new CrossRunRouter({
      resolver: { resolve: async () => ({ endpoint: child, relationship: "sibling" }) },
      authorizer: { authorize: async () => { calls.push("authorize"); return { allowed: true }; } },
      targetAdmission: { admit: async () => { calls.push("admit"); return { status: "queued" }; } },
    });
    await expect(r.send(request("relationship"), sender)).rejects.toMatchObject({ code: "identity-forged" });
    expect(calls).toEqual([]);
  });

  it("requires an authenticated proof when a host verifier is configured", async () => {
    const r = router({ verifySender: async () => false });
    await expect(r.send(request("proof"), sender)).rejects.toMatchObject({ code: "identity-forged" });
    expect(r).toBeInstanceOf(CrossRunRouter);
    expect(CrossRunProtocolError).toBeDefined();
  });

  it("persists authorization, expiry, and capacity rejections as durable facts", async () => {
    const deniedStore = new MemoryCrossRunFactStore();
    const denied = router({
      factStore: deniedStore,
      authorizer: { authorize: async () => ({ allowed: false, reason: "authorization-denied" as const }) },
      targetAdmission: { admit: async () => { throw new Error("must not admit"); } },
    });
    await expect(denied.send(request("durable-denied"), sender)).resolves.toMatchObject({
      status: "rejected",
      reason: "authorization-denied",
    });
    expect((await deniedStore.read({ runId: source.runId })).map((fact) => fact.kind))
      .toEqual(["outbox.pending", "outbox.receipt"]);

    const expiredStore = new MemoryCrossRunFactStore();
    const expired = router({ factStore: expiredStore });
    await expect(expired.send(request("durable-expired", undefined, "old", {
      createdAt: "2026-08-30T00:00:00.000Z",
      expiresAt: "2026-08-30T00:01:00.000Z",
    }), sender)).resolves.toMatchObject({ status: "expired", reason: "expired" });
    expect((await expiredStore.read({ runId: source.runId })).map((fact) => fact.kind))
      .toEqual(["outbox.pending", "outbox.receipt"]);

    const capacityStore = new MemoryCrossRunFactStore();
    const capacity = router({
      factStore: capacityStore,
      admissionPolicy: { check: async () => ({
        allowed: false,
        reason: "target-capacity" as const,
        retryAt: "2026-08-31T00:01:00.000Z",
      }) },
      targetAdmission: { admit: async () => { throw new Error("must not admit"); } },
    });
    await expect(capacity.send(request("durable-capacity"), sender)).resolves.toMatchObject({
      status: "rejected",
      reason: "target-capacity",
    });
    expect((await capacityStore.read({ runId: source.runId })).map((fact) => fact.kind))
      .toEqual(["outbox.pending", "outbox.receipt"]);
  });

  it("reuses a durable terminal receipt when authorization changes on retry", async () => {
    let allowed = false;
    const store = new MemoryCrossRunFactStore();
    const r = router({
      factStore: store,
      authorizer: { authorize: async () => ({ allowed }) },
      targetAdmission: { admit: async () => ({ status: "delivered" as const }) },
    });

    await expect(r.send(request("authorization-retry"), sender)).resolves.toMatchObject({
      status: "rejected",
      reason: "authorization-denied",
    });
    allowed = true;
    await expect(r.send(request("authorization-retry"), sender)).resolves.toMatchObject({
      status: "duplicate",
    });

    const receipts = (await store.read({ runId: source.runId }))
      .filter((fact): fact is Extract<CrossRunFact, { kind: "outbox.receipt" }> => fact.kind === "outbox.receipt");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.receipt.status).toBe("rejected");
  });

  it("does not append an expired terminal receipt after a successful retry becomes stale", async () => {
    let instant = new Date("2026-08-31T00:00:00.000Z");
    const clock: Clock = { now: () => new Date(instant) };
    const store = new MemoryCrossRunFactStore();
    const r = new CrossRunRouter({
      clock,
      factStore: store,
      resolver: { resolve: async () => ({ endpoint: child, relationship: "direct" }) },
      authorizer: { authorize: async () => ({ allowed: true }) },
      targetAdmission: { admit: async () => ({ status: "delivered" as const }) },
    });
    const input = request("expiry-retry", undefined, "hello", {
      createdAt: instant.toISOString(),
      expiresAt: "2026-08-31T00:05:00.000Z",
    });

    await expect(r.send(input, sender)).resolves.toMatchObject({ status: "delivered" });
    instant = new Date("2026-08-31T00:10:00.000Z");
    await expect(r.send(input, sender)).resolves.toMatchObject({ status: "duplicate" });

    const receipts = (await store.read({ runId: source.runId }))
      .filter((fact): fact is Extract<CrossRunFact, { kind: "outbox.receipt" }> => fact.kind === "outbox.receipt");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.receipt.status).toBe("delivered");
  });

  it("derives default delivery attempt IDs from route and ordinal, not wall clock", async () => {
    const makePending = async (key: string): Promise<MemoryCrossRunFactStore> => {
      const store = new MemoryCrossRunFactStore();
      await store.append({
        kind: "outbox.pending",
        envelope: envelopeFor(request(key)),
        recordedAt: "2026-08-31T00:00:00.000Z",
      });
      return store;
    };
    const firstStore = await makePending("deterministic-attempt");
    const secondStore = await makePending("deterministic-attempt");
    const makeRecoveryRouter = (factStore: MemoryCrossRunFactStore): CrossRunRouter => new CrossRunRouter({
      clock: new FixedClock(),
      factStore,
      resolver: { resolve: async () => ({ endpoint: child, relationship: "direct" }) },
      authorizer: { authorize: async () => ({ allowed: true }) },
      targetAdmission: { admit: async () => ({ status: "queued" }) },
    });
    const first = await makeRecoveryRouter(firstStore).recover(sender);
    const second = await makeRecoveryRouter(secondStore).recover(sender);
    expect(first.receipts[0]?.attemptId).toBe(second.receipts[0]?.attemptId);
    expect(first.receipts[0]?.attemptId).toMatch(/^attempt:sha256:/u);
  });

  it("does not downgrade a durable receipt identity conflict to uncertain", async () => {
    const backing = new MemoryCrossRunFactStore();
    const store: CrossRunFactStore = {
      append: async (fact: CrossRunFact) => {
        if (fact.kind === "outbox.receipt") {
          throw new CrossRunProtocolError("receipt identity conflict", "idempotency-conflict");
        }
        await backing.append(fact);
      },
      read: (scope) => backing.read(scope),
    };
    const r = router({
      factStore: store,
      targetAdmission: { admit: async () => ({ status: "queued" }) },
    });
    await expect(r.send(request("receipt-conflict"), sender)).rejects.toMatchObject({
      code: "idempotency-conflict",
    });
  });

  it("marks a target admission message identity mismatch uncertain before wake", async () => {
    let woke = false;
    const store = new MemoryCrossRunFactStore();
    const r = router({
      factStore: store,
      targetAdmission: { admit: async () => ({ status: "queued", messageId: "forged-target-id" }) },
      wake: { wake: async () => { woke = true; return { status: "queued" }; } },
    });
    await expect(r.send(request("forged-admission"), sender)).resolves.toMatchObject({
      status: "uncertain",
      reason: "target-admission-failed",
    });
    expect(woke).toBe(false);
  });

  it("rejects a target admission message identity mismatch without wake", async () => {
    const store = new MemoryCrossRunFactStore();
    const r = router({
      factStore: store,
      targetAdmission: { admit: async () => ({ status: "queued", messageId: "forged-target-id" }) },
    });
    await expect(r.send(request("forged-admission-no-wake"), sender)).resolves.toMatchObject({
      status: "uncertain",
      reason: "target-admission-failed",
    });
  });

  it("does not project a claimed message without a valid claim lease", () => {
    const envelope = envelopeFor(request("malformed-claim"));
    const message = envelopeToA2AMessage(envelope);
    expect(projectCrossRunInbox([{
      message,
      status: "claimed",
      sentAtOffset: 1,
      sentAt: envelope.createdAt,
    }])).toEqual([]);
    expect(projectCrossRunInbox([{
      message,
      status: "claimed",
      sentAtOffset: 1,
      sentAt: envelope.createdAt,
      claim: {
        claimId: "claim-1",
        claimedBy: "worker",
        claimedAt: envelope.createdAt,
        attempt: 1,
      },
    }])).toHaveLength(1);
  });
});
