import { describe, expect, it } from "vitest";

import type { A2AMessage } from "../../src/domain/index.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";
import { peerEvidenceChecks, teamCancellationChecks } from "../eval/topology-live-evidence.js";

const runId = "evidence-run";
const from = "team:exchange:items";
const to = "team:exchange:policy";
const expected = { subtotal: 44 };

async function fixture() {
  const ledger = new MemoryLedger();
  const store = new MemoryContentAddressedStore();
  const ref = await store.put("{}", "application/json");
  const metadata = { runId, laneId: from, correlationId: "evidence", visibility: "run" as const };
  return {
    ledger,
    async read() {
      await ledger.append({ ...metadata, type: "tool.requested", idempotencyKey: "read-request",
        payload: { operationId: "read", toolCallId: "read", name: "read_file", argumentsRef: ref } });
      await ledger.append({ ...metadata, type: "tool.succeeded", idempotencyKey: "read-success",
        payload: { operationId: "read", toolCallId: "read", name: "read_file", resultRef: ref } });
    },
    async send(text: string, id = "facts") {
      const message: A2AMessage = {
        messageId: id, runId, from, to, conversationId: runId, threadId: "evidence",
        correlationId: "evidence", idempotencyKey: id, createdAt: new Date().toISOString(),
        visibility: "run", priority: 0, delivery: "next-step",
        payload: { type: "message.inform", text },
      };
      return ledger.append({ ...metadata, type: "message.sent", idempotencyKey: id, payload: { message } });
    },
    async consume(messageId = "facts") {
      return ledger.append({ ...metadata, laneId: to, type: "step.completed", idempotencyKey: `consume:${messageId}`,
        payload: { step: 1, hasToolCalls: false, boundaryMessageIds: [messageId] } });
    },
    async check() { return peerEvidenceChecks(await ledger.read({ runId }), runId, from, to, expected); },
  };
}

describe("topology live evidence", () => {
  it("does not treat a consumed handshake as consumed checkout evidence", async () => {
    const f = await fixture();
    await f.send("Please exchange checkout evidence", "hello");
    await f.consume("hello");
    await f.read();
    await f.send(JSON.stringify({ type: "checkout.evidence", subtotal: 44 }));
    expect(await f.check()).toEqual({ sent: true, consumed: false });
  });

  it.each([
    "Subtotal is 44", "not JSON", '{"type":"checkout.evidence","subtotal":"44"}',
    '{"type":"checkout.evidence","subtotal":144}', '{"type":"greeting","subtotal":44}',
  ])("rejects non-evidence or incorrect numeric payload %s", async (text) => {
    const f = await fixture();
    await f.read();
    await f.send(text);
    await f.consume();
    expect(await f.check()).toEqual({ sent: false, consumed: false });
  });

  it("requires read evidence before sending facts and consumption after sending them", async () => {
    const f = await fixture();
    await f.consume();
    await f.send(JSON.stringify({ type: "checkout.evidence", subtotal: 44 }));
    await f.read();
    expect(await f.check()).toEqual({ sent: false, consumed: false });
  });

  it("rejects a receipt from before the matching evidence was sent", async () => {
    const f = await fixture();
    await f.read();
    await f.consume();
    await f.send(JSON.stringify({ type: "checkout.evidence", subtotal: 44 }));
    expect(await f.check()).toEqual({ sent: true, consumed: false });
  });

  it("matches the sender, Run, and exact message id, not an unrelated receipt", async () => {
    const f = await fixture();
    await f.read();
    const sent = await f.send(JSON.stringify({ type: "checkout.evidence", subtotal: 44 }));
    const receipt = await f.consume();
    const events = await f.ledger.read({ runId });
    for (const changed of [
      { ...receipt, runId: "foreign-run" },
      { ...receipt, laneId: from },
      { ...receipt, payload: { ...receipt.payload, boundaryMessageIds: ["hello"] } },
    ]) {
      expect(peerEvidenceChecks(events.map((event) => event.eventId === receipt.eventId ? changed : event), runId, from, to, expected))
        .toEqual({ sent: true, consumed: false });
    }
    expect(peerEvidenceChecks(events.map((event) => event.eventId === sent.eventId ? { ...event, laneId: "forged" } : event), runId, from, to, expected))
      .toEqual({ sent: false, consumed: false });
  });

  it("accepts grounded numeric evidence with its later durable consumption", async () => {
    const f = await fixture();
    await f.read();
    await f.send(JSON.stringify({ type: "checkout.evidence", subtotal: 44 }));
    await f.consume();
    expect(await f.check()).toEqual({ sent: true, consumed: true });
  });

  it("keeps durable cancellation evidence independent of a provider failure", async () => {
    const ledger = new MemoryLedger();
    const metadata = { runId, laneId: "main", correlationId: "cancel", visibility: "run" as const };
    await ledger.append({ ...metadata, type: "team.cancel.requested", idempotencyKey: "cancel-request",
      payload: { teamId: "cancelled", reason: "test", requestedBy: "main" } });
    await ledger.append({ ...metadata, type: "team.member.settled", idempotencyKey: "member-cancelled",
      payload: { teamId: "cancelled", taskId: "task", memberId: "reader", outcome: "cancelled" } });
    await ledger.append({ ...metadata, type: "team.cancelled", idempotencyKey: "cancelled",
      payload: { teamId: "cancelled", reason: "test" } });
    await ledger.append({ ...metadata, type: "model.failed", idempotencyKey: "provider-failed",
      payload: { model: "scripted", error: "cost unknown", retryable: false } });
    const checks = teamCancellationChecks(await ledger.read({ runId }), runId, "cancelled");
    expect(Object.values(checks).every(Boolean)).toBe(true);
    expect(Object.values(teamCancellationChecks(await ledger.read({ runId }), "another-run", "cancelled")).every((value) => !value)).toBe(true);
    await ledger.append({ ...metadata, type: "team.member.settled", idempotencyKey: "late-success",
      payload: { teamId: "cancelled", taskId: "task", memberId: "reader", outcome: "succeeded" } });
    expect(teamCancellationChecks(await ledger.read({ runId }), runId, "cancelled").noLateSuccess).toBe(false);
  });
});
