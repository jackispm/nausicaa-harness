import { describe, expect, it } from "vitest";

import type { Clock, CrossRunEndpoint, CrossRunEnvelope } from "../../src/domain/index.js";
import {
  CrossRunHostWakeAdapter,
  CrossRunRouter,
  type CrossRunFact,
  type CrossRunRouterOptions,
  type CrossRunSenderIdentity,
  type CrossRunSendRequest,
  type CrossRunTargetAdmission,
  LedgerCrossRunFactStore,
  LedgerCrossRunTargetAdmission,
  MemoryCrossRunFactStore,
  createCrossRunMessageId,
  createCrossRunRouteId,
  envelopeToA2AMessage,
  normalizeCrossRunSendRequest,
  normalizeEnvelope,
  projectCrossRunFacts,
  projectCrossRunInbox,
} from "../../src/a2a/index.js";
import { projectInbox } from "../../src/a2a/inbox.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { sha256 } from "../../src/ledger/hash.js";
import { createArtifactRef } from "../../src/store/store.js";

class FixedClock implements Clock {
  constructor(readonly instant = new Date("2026-08-31T00:00:00.000Z")) {}

  now(): Date {
    return new Date(this.instant);
  }
}

const clock = new FixedClock();
const source: CrossRunEndpoint = {
  workspaceId: "workspace-a",
  sessionId: "session-source",
  runId: "run-source",
  laneId: "main",
};
const target: CrossRunEndpoint = {
  workspaceId: "workspace-a",
  sessionId: "session-target",
  runId: "run-target",
  laneId: "worker",
};
const sender: CrossRunSenderIdentity = {
  endpoint: source,
  proof: { kind: "attach", authenticated: true, token: "opaque-proof" },
  relationshipGrants: ["direct"],
};

function idFactory(prefix: string): () => string {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

function request(idempotencyKey = "message-1", overrides: Partial<CrossRunSendRequest> = {}): CrossRunSendRequest {
  return {
    target: { relationship: "direct", id: target.runId },
    payload: { type: "message.inform", text: "hello" },
    conversationId: "conversation-1",
    threadId: "thread-1",
    correlationId: "correlation-1",
    idempotencyKey,
    visibility: "run",
    priority: 1,
    ...overrides,
  };
}

function envelopeFor(
  input: CrossRunSendRequest,
  sourceEndpoint: CrossRunEndpoint = source,
  targetEndpoint: CrossRunEndpoint = target,
): CrossRunEnvelope {
  const normalized = normalizeCrossRunSendRequest(input, { now: clock.now() });
  const routeId = createCrossRunRouteId(sourceEndpoint, targetEndpoint, normalized.idempotencyKey);
  const messageId = createCrossRunMessageId(routeId, normalized);
  return normalizeEnvelope({
    protocolVersion: 1,
    messageId,
    routeId,
    source: sourceEndpoint,
    target: targetEndpoint,
    relationship: "direct",
    conversationId: normalized.conversationId,
    threadId: normalized.threadId,
    correlationId: normalized.correlationId,
    idempotencyKey: normalized.idempotencyKey,
    createdAt: normalized.createdAt ?? clock.now().toISOString(),
    ...(normalized.expiresAt === undefined ? {} : { expiresAt: normalized.expiresAt }),
    ...(normalized.causationId === undefined ? {} : { causationId: normalized.causationId }),
    visibility: normalized.visibility,
    priority: normalized.priority,
    payload: normalized.payload,
    artifacts: [],
  });
}

function setup(options: {
  sourceLedger?: MemoryLedger;
  targetLedger?: MemoryLedger;
  targetAdmission?: CrossRunTargetAdmission;
  wake?: CrossRunHostWakeAdapter;
  artifactRelay?: CrossRunRouterOptions["artifactRelay"];
} = {}): {
  sourceLedger: MemoryLedger;
  targetLedger: MemoryLedger;
  sourceStore: LedgerCrossRunFactStore;
  targetAdmission: CrossRunTargetAdmission;
  router: CrossRunRouter;
} {
  const sourceLedger = options.sourceLedger ?? new MemoryLedger({ createEventId: idFactory("source-event") });
  const targetLedger = options.targetLedger ?? new MemoryLedger({ createEventId: idFactory("target-event") });
  const sourceStore = new LedgerCrossRunFactStore({ ledger: sourceLedger, source });
  const targetAdmission = options.targetAdmission ?? new LedgerCrossRunTargetAdmission({
    ledger: targetLedger,
    target,
    clock,
  });
  const router = new CrossRunRouter({
    clock,
    factStore: sourceStore,
    resolver: { resolve: async () => ({ endpoint: target, relationship: "direct" }) },
    authorizer: { authorize: async () => ({ allowed: true }) },
    targetAdmission,
    ...(options.wake === undefined ? {} : { wake: options.wake }),
    ...(options.artifactRelay === undefined ? {} : { artifactRelay: options.artifactRelay }),
    createId: idFactory("attempt"),
  });
  return { sourceLedger, targetLedger, sourceStore, targetAdmission, router };
}

describe("cross-Run Ledger recovery", () => {
  it("round-trips source outbox and target Inbox through adapter reconstruction", async () => {
    const first = setup();
    const receipt = await first.router.send(request(), sender);
    expect(receipt.status).toBe("queued");
    await expect(first.sourceLedger.read({ runId: source.runId })).resolves.toHaveLength(3);
    await expect(first.targetLedger.read({ runId: target.runId })).resolves.toHaveLength(1);

    const sourceStore = new LedgerCrossRunFactStore({ ledger: first.sourceLedger, source });
    const targetAdmission = new LedgerCrossRunTargetAdmission({
      ledger: first.targetLedger,
      target,
      clock,
    });
    const restarted = new CrossRunRouter({
      clock,
      factStore: sourceStore,
      resolver: { resolve: async () => ({ endpoint: target, relationship: "direct" }) },
      authorizer: { authorize: async () => ({ allowed: true }) },
      targetAdmission,
      createId: idFactory("restart-attempt"),
    });
    const duplicate = await restarted.send(request(), sender);
    expect(duplicate.status).toBe("duplicate");
    await expect(first.targetLedger.read({ runId: target.runId })).resolves.toHaveLength(1);
  });

  it("replays a durable pending fact after source restart and records a terminal receipt", async () => {
    const sourceLedger = new MemoryLedger({ createEventId: idFactory("pending-source") });
    const targetLedger = new MemoryLedger({ createEventId: idFactory("pending-target") });
    const sourceStore = new LedgerCrossRunFactStore({ ledger: sourceLedger, source });
    const envelope = envelopeFor(request("pending"));
    await sourceStore.append({
      kind: "outbox.pending",
      envelope,
      recordedAt: clock.now().toISOString(),
    });

    let admissions = 0;
    const targetAdmission = new LedgerCrossRunTargetAdmission({ ledger: targetLedger, target, clock });
    const router = new CrossRunRouter({
      clock,
      factStore: new LedgerCrossRunFactStore({ ledger: sourceLedger, source }),
      resolver: { resolve: async () => ({ endpoint: target, relationship: "direct" }) },
      authorizer: { authorize: async () => ({ allowed: true }) },
      targetAdmission: {
        admit: async (input) => {
          admissions += 1;
          return targetAdmission.admit(input);
        },
      },
      createId: idFactory("recovery-attempt"),
    });
    const recovered = await router.recover(sender);
    expect(recovered.receipts).toHaveLength(1);
    expect(recovered.receipts[0]).toMatchObject({ status: "queued", routeId: envelope.routeId });
    expect(admissions).toBe(1);
    expect((await sourceStore.read({ routeId: envelope.routeId })).map((fact) => fact.kind)).toEqual([
      "outbox.pending",
      "outbox.attempted",
      "outbox.receipt",
    ]);

    const restarted = new CrossRunRouter({
      clock,
      factStore: new LedgerCrossRunFactStore({ ledger: sourceLedger, source }),
      resolver: { resolve: async () => ({ endpoint: target, relationship: "direct" }) },
      authorizer: { authorize: async () => ({ allowed: true }) },
      targetAdmission: {
        admit: async () => {
          admissions += 1;
          return { status: "queued" };
        },
      },
    });
    const again = await restarted.recover(sender);
    expect(again.receipts[0]).toMatchObject({ status: "queued" });
    expect(admissions).toBe(1);
  });

  it("surfaces an attempt without a receipt as uncertain and never replays the target side effect", async () => {
    const sourceLedger = new MemoryLedger({ createEventId: idFactory("uncertain-source") });
    const targetLedger = new MemoryLedger({ createEventId: idFactory("uncertain-target") });
    const sourceStore = new LedgerCrossRunFactStore({ ledger: sourceLedger, source });
    const envelope = envelopeFor(request("uncertain"));
    await sourceStore.append({ kind: "outbox.pending", envelope, recordedAt: clock.now().toISOString() });
    await sourceStore.append({
      kind: "outbox.attempted",
      routeId: envelope.routeId,
      messageId: envelope.messageId,
      attemptId: "attempt-crashed",
      attemptedAt: clock.now().toISOString(),
    });
    let admissions = 0;
    const router = new CrossRunRouter({
      clock,
      factStore: sourceStore,
      resolver: { resolve: async () => ({ endpoint: target, relationship: "direct" }) },
      targetAdmission: { admit: async () => { admissions += 1; return { status: "queued" }; } },
    });
    const recovered = await router.recover(sender);
    expect(recovered.uncertain).toHaveLength(1);
    expect(recovered.uncertain[0]).toMatchObject({
      status: "uncertain",
      reason: "delivery-attempt-without-receipt",
      attemptId: "attempt-crashed",
    });
    expect(admissions).toBe(0);
    expect(await targetLedger.read({ runId: target.runId })).toEqual([]);
    const second = await router.recover(sender);
    expect(second.uncertain[0]?.receiptId).toBe(recovered.uncertain[0]?.receiptId);
    expect(admissions).toBe(0);
  });

  it("deduplicates target Inbox admission and daemon wake identity", async () => {
    const targetLedger = new MemoryLedger({ createEventId: idFactory("dedupe-target") });
    const targetAdmission = new LedgerCrossRunTargetAdmission({ ledger: targetLedger, target, clock });
    const envelope = envelopeFor(request("target-dedupe"));
    const message = envelopeToA2AMessage(envelope);
    const first = await targetAdmission.admit({ envelope, message, source: sender });
    const second = await targetAdmission.admit({ envelope, message, source: sender });
    expect(first).toMatchObject({ status: "queued", messageId: envelope.messageId });
    expect(second).toMatchObject({ status: "duplicate", messageId: envelope.messageId });
    expect(await targetLedger.read({ runId: target.runId })).toHaveLength(1);

    const wakeRequests: string[] = [];
    let wakeCount = 0;
    const wake = new CrossRunHostWakeAdapter({
      target,
      clock,
      wake: async (input) => {
        wakeRequests.push(`${input.dedupeKey}|${input.wakeId}|${input.inputId}`);
        wakeCount += 1;
        return { status: wakeCount === 1 ? "queued" : "duplicate" };
      },
    });
    await expect(wake.wake({ envelope, targetMessageId: envelope.messageId })).resolves.toMatchObject({ status: "queued" });
    await expect(wake.wake({ envelope, targetMessageId: envelope.messageId })).resolves.toMatchObject({ status: "already-active" });
    expect(wakeRequests[0]).toBe(wakeRequests[1]);
  });

  it("binds rich daemon wake responses to the generated request provenance", async () => {
    const envelope = envelopeFor(request("rich-wake"));
    const adapter = new CrossRunHostWakeAdapter({
      target,
      clock,
      wake: async (generated) => ({
        status: "queued" as const,
        admission: {
          status: "admitted" as const,
          inputId: generated.inputId,
        },
        wake: {
          ...generated,
          runId: "forged-run",
        },
      }),
    });
    await expect(adapter.wake({ envelope, targetMessageId: envelope.messageId }))
      .rejects.toMatchObject({
        code: "identity-forged",
      });

    const valid = new CrossRunHostWakeAdapter({
      target,
      clock,
      wake: async (generated) => ({
        status: "queued" as const,
        admission: {
          status: "admitted" as const,
          inputId: generated.inputId,
          shouldActivate: true,
        },
        wake: generated,
      }),
    });
    await expect(valid.wake({ envelope, targetMessageId: envelope.messageId }))
      .resolves.toMatchObject({ status: "queued" });
  });

  it("records artifact relay mismatch as a rejected durable receipt", async () => {
    const ref = createArtifactRef(new TextEncoder().encode("artifact"), "text/plain");
    const wrong = createArtifactRef(new TextEncoder().encode("wrong"), "text/plain");
    const setupResult = setup({
      artifactRelay: {
        relay: async () => ({
          sourceRef: ref,
          targetRef: wrong,
          visibility: "run" as const,
          targetWorkspaceId: target.workspaceId,
        }),
      },
    });
    const receipt = await setupResult.router.send(request("artifact-mismatch", { artifactRefs: [ref] }), sender);
    expect(receipt).toMatchObject({ status: "rejected", reason: "artifact-rejected" });
    const facts = await setupResult.sourceStore.read({ routeId: receipt.routeId });
    expect(facts.map((fact) => fact.kind)).toEqual(["outbox.pending", "outbox.receipt"]);
    expect(projectCrossRunFacts(facts).entries[0]).toMatchObject({ status: "rejected" });
  });

  it("preserves an expired status returned by the target Inbox", async () => {
    const sourceClock = new FixedClock(new Date("2026-08-31T00:00:00.000Z"));
    const targetClock = new FixedClock(new Date("2026-08-31T01:00:00.000Z"));
    const sourceLedger = new MemoryLedger({ createEventId: idFactory("expired-source") });
    const targetLedger = new MemoryLedger({ createEventId: idFactory("expired-target") });
    const sourceStore = new LedgerCrossRunFactStore({ ledger: sourceLedger, source });
    const targetAdmission = new LedgerCrossRunTargetAdmission({
      ledger: targetLedger,
      target,
      clock: targetClock,
    });
    const router = new CrossRunRouter({
      clock: sourceClock,
      factStore: sourceStore,
      resolver: { resolve: async () => ({ endpoint: target, relationship: "direct" }) },
      authorizer: { authorize: async () => ({ allowed: true }) },
      targetAdmission,
      createId: idFactory("expired-attempt"),
    });
    const receipt = await router.send(request("target-expired", {
      createdAt: "2026-08-31T00:00:00.000Z",
      expiresAt: "2026-08-31T00:30:00.000Z",
    }), sender);

    expect(receipt).toMatchObject({ status: "expired", reason: "expired" });
    expect((await sourceStore.read({ routeId: receipt.routeId })).map((fact) => fact.kind)).toEqual([
      "outbox.pending",
      "outbox.attempted",
      "outbox.receipt",
    ]);
  });

  it("maps target Inbox records and preserves route metadata in projections", async () => {
    const setupResult = setup();
    await setupResult.router.send(request("projection"), sender);
    const targetEvents = await setupResult.targetLedger.read({ runId: target.runId });
    const records = projectInbox(targetEvents).records;
    const projection = projectCrossRunInbox(records);
    expect(projection).toHaveLength(1);
    expect(projection[0]).toMatchObject({
      status: "queued",
      route: {
        relationship: "direct",
        target,
      },
    });
  });

  it("rejects a target admission whose sender proof fails host verification", async () => {
    const targetLedger = new MemoryLedger({ createEventId: idFactory("proof-target") });
    const targetAdmission = new LedgerCrossRunTargetAdmission({
      ledger: targetLedger,
      target,
      clock,
      verifySender: async () => false,
    });
    const envelope = envelopeFor(request("proof"));
    await expect(targetAdmission.admit({
      envelope,
      message: envelopeToA2AMessage(envelope),
      source: sender,
    })).rejects.toMatchObject({ code: "identity-forged" });
    expect(await targetLedger.read({ runId: target.runId })).toEqual([]);
  });

  it("normalizes and clones generic fact stores without exposing mutable state", async () => {
    const store = new MemoryCrossRunFactStore();
    const envelope = envelopeFor(request("memory"));
    const pending: CrossRunFact = { kind: "outbox.pending", envelope, recordedAt: clock.now().toISOString() };
    await store.append(pending);
    const facts = await store.read({ routeId: envelope.routeId });
    expect(facts).toHaveLength(1);
    const mutable = facts[0] as unknown as { envelope: { payload: CrossRunEnvelope["payload"] } };
    mutable.envelope.payload = {
      type: "message.inform",
      text: "mutated",
    };
    const reread = await store.read({ routeId: envelope.routeId });
    expect(reread[0]).toMatchObject({ envelope: { payload: { text: "hello" } } });
  });

  it("enforces outbox predecessor order at the direct Ledger boundary", async () => {
    const ledger = new MemoryLedger({ createEventId: idFactory("direct-event") });
    const envelope = envelopeFor(request("direct-ledger"));
    const attemptId = "attempt-direct";
    const attemptedAt = clock.now().toISOString();
    const attemptedIdempotency = `a2a:outbox:${sha256(
      `outbox.attempted\u0000${envelope.routeId}\u0000${attemptId}`,
    )}`;

    await expect(ledger.append({
      runId: source.runId,
      laneId: source.laneId,
      type: "a2a.outbox.attempted",
      payload: {
        routeId: envelope.routeId,
        messageId: envelope.messageId,
        attemptId,
        attemptedAt,
      },
      correlationId: `a2a:${sha256(envelope.routeId)}`,
      idempotencyKey: attemptedIdempotency,
      causationId: envelope.messageId,
      visibility: "run",
      occurredAt: attemptedAt,
    })).rejects.toThrow(/no durable pending predecessor/iu);

    await ledger.close();
  });

  it("scopes a Ledger outbox adapter to its source lane", async () => {
    const ledger = new MemoryLedger({ createEventId: idFactory("lane-event") });
    const otherSource = { ...source, laneId: "worker" };
    const otherTarget = { ...target, laneId: "observer" };
    const otherStore = new LedgerCrossRunFactStore({ ledger, source: otherSource });
    await otherStore.append({
      kind: "outbox.pending",
      envelope: envelopeFor(request("other-lane"), otherSource, otherTarget),
      recordedAt: clock.now().toISOString(),
    });

    const ownStore = new LedgerCrossRunFactStore({ ledger, source });
    await expect(ownStore.read({ runId: source.runId })).resolves.toEqual([]);
    await ledger.close();
  });
});
