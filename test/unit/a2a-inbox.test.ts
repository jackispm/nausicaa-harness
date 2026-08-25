import { describe, expect, it } from "vitest";

import type { A2AMessage, AdviceDisposition, Clock } from "../../src/domain/index.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import {
  A2AInbox,
  A2AProtocolError,
  MessageExpiredError,
  projectInbox,
} from "../../src/a2a/index.js";

class MutableClock implements Clock {
  constructor(private instant: Date) {}

  now(): Date {
    return new Date(this.instant);
  }

  advance(milliseconds: number): void {
    this.instant = new Date(this.instant.getTime() + milliseconds);
  }
}

function adviceMessage(overrides: Partial<A2AMessage> = {}): A2AMessage {
  return {
    messageId: "message-1",
    runId: "run-1",
    conversationId: "conversation-1",
    threadId: "thread-1",
    from: "teto",
    to: "main",
    createdAt: "2026-08-25T12:00:00.000Z",
    expiresAt: "2026-08-25T12:10:00.000Z",
    correlationId: "correlation-1",
    idempotencyKey: "send-1",
    visibility: "run",
    priority: 5,
    delivery: "next-step",
    payload: {
      type: "advice.propose",
      advice: {
        adviceId: "advice-1",
        kind: "orientation",
        claim: "The current action no longer serves the requested outcome.",
        evidenceRefs: ["boundary:b5"],
        confidence: 0.85,
        risk: "medium",
        suggestedAction: "Return to installation evidence.",
        urgency: "next-step",
        expiresAt: "2026-08-25T12:10:00.000Z",
        dedupeKey: "return-to-install",
        sourceLane: "teto",
      },
    },
    ...overrides,
  };
}

describe("A2AInbox", () => {
  it("makes send, claim, and handle idempotent", async () => {
    const clock = new MutableClock(new Date("2026-08-25T12:00:00.000Z"));
    const inbox = new A2AInbox({ clock });
    const message = adviceMessage();

    await expect(inbox.send(message)).resolves.toEqual({
      status: "queued",
      messageId: "message-1",
    });
    await expect(inbox.send(message)).resolves.toEqual({
      status: "duplicate",
      messageId: "message-1",
    });

    const first = await inbox.claim("main", "main", { claimId: "claim-1" });
    const retry = await inbox.claim("main", "main", { claimId: "claim-1" });
    expect(first).toHaveLength(1);
    expect(retry).toEqual(first);
    expect(first[0]?.claim).toMatchObject({ claimId: "claim-1", attempt: 1 });

    const handled = await inbox.handle("message-1", "main");
    const handledAgain = await inbox.handle("message-1", "main");
    expect(handled.status).toBe("handled");
    expect(handledAgain).toEqual(handled);
  });

  it("redelivers an unhandled claim after its lease", async () => {
    const clock = new MutableClock(new Date("2026-08-25T12:00:00.000Z"));
    const inbox = new A2AInbox({ clock, claimLeaseMs: 1_000 });
    await inbox.send(adviceMessage());
    await inbox.claim("main", "worker-a", { claimId: "claim-a" });

    clock.advance(1_001);
    const redelivery = await inbox.claim("main", "worker-b", {
      claimId: "claim-b",
    });

    expect(redelivery).toHaveLength(1);
    expect(redelivery[0]?.claim).toMatchObject({
      claimId: "claim-b",
      claimedBy: "worker-b",
      attempt: 2,
    });
  });

  it("atomically admits only one of two concurrent claims", async () => {
    const clock = new MutableClock(new Date("2026-08-25T12:00:00.000Z"));
    const inbox = new A2AInbox({ clock });
    await inbox.send(adviceMessage());

    const [left, right] = await Promise.all([
      inbox.claim("main", "worker-a", { claimId: "claim-a" }),
      inbox.claim("main", "worker-b", { claimId: "claim-b" }),
    ]);

    expect(left.length + right.length).toBe(1);
    expect(inbox.snapshot().records[0]?.claim?.attempt).toBe(1);
  });

  it("deduplicates Advice until TTL and never delivers expired messages", async () => {
    const clock = new MutableClock(new Date("2026-08-25T12:00:00.000Z"));
    const inbox = new A2AInbox({ clock });
    await inbox.send(adviceMessage());

    const duplicate = adviceMessage({
      messageId: "message-2",
      idempotencyKey: "send-2",
    });
    await expect(inbox.send(duplicate)).resolves.toEqual({
      status: "duplicate",
      messageId: "message-1",
    });

    clock.advance(10 * 60_000 + 1);
    expect(await inbox.claim("main", "main", { claimId: "late" })).toEqual([]);
    await expect(
      inbox.acknowledgeAdvice("advice-1", "accept", "main"),
    ).rejects.toBeInstanceOf(MessageExpiredError);
  });

  it("rejects malformed Advice at the protocol boundary", async () => {
    const clock = new MutableClock(new Date("2026-08-25T12:00:00.000Z"));
    const inbox = new A2AInbox({ clock });
    const message = adviceMessage();
    if (message.payload.type !== "advice.propose") {
      throw new Error("test fixture must contain Advice");
    }
    message.payload.advice.confidence = 2;

    await expect(inbox.send(message)).rejects.toThrow(/confidence/);
    expect(inbox.snapshot().records).toEqual([]);
  });

  it.each<AdviceDisposition>(["accept", "defer", "reject"])(
    "persists and deduplicates an %s acknowledgement",
    async (disposition) => {
      const clock = new MutableClock(new Date("2026-08-25T12:00:00.000Z"));
      const inbox = new A2AInbox({ clock });
      await inbox.send(adviceMessage());
      await inbox.claim("main", "main", { claimId: "claim-1" });

      await expect(
        inbox.acknowledgeAdvice("advice-1", disposition, "main", "boundary decision"),
      ).resolves.toEqual({ status: "acknowledged", messageId: "message-1" });
      await expect(
        inbox.acknowledgeAdvice("advice-1", disposition, "main", "boundary decision"),
      ).resolves.toEqual({ status: "duplicate", messageId: "message-1" });

      expect(inbox.snapshot().records[0]).toMatchObject({
        status: "handled",
        acknowledgement: { disposition, reason: "boundary decision" },
      });
      await expect(
        inbox.acknowledgeAdvice("advice-1", "reject", "main", "different"),
      ).rejects.toBeInstanceOf(A2AProtocolError);
    },
  );

  it("uses Ledger events as the rehydratable source of truth", async () => {
    const clock = new MutableClock(new Date("2026-08-25T12:00:00.000Z"));
    const ledger = new MemoryLedger({ clock });
    const first = new A2AInbox({ sink: ledger, clock, claimLeaseMs: 1_000 });
    await first.send(adviceMessage());
    await first.claim("main", "worker-a", { claimId: "claim-a" });

    const committed = await ledger.read({ runId: "run-1" });
    const recovered = A2AInbox.rehydrate(committed, {
      sink: ledger,
      clock,
      claimLeaseMs: 1_000,
    });
    expect(recovered.snapshot()).toEqual(projectInbox(committed));

    clock.advance(1_001);
    const redelivered = await recovered.claim("main", "worker-b", {
      claimId: "claim-b",
    });
    expect(redelivered[0]?.claim?.attempt).toBe(2);

    const finalEvents = await ledger.read({ runId: "run-1" });
    expect(finalEvents.map((event) => event.type)).toEqual([
      "message.sent",
      "message.claimed",
      "message.claimed",
    ]);
    expect(projectInbox(finalEvents).records[0]?.claim?.claimedBy).toBe("worker-b");
  });
});
