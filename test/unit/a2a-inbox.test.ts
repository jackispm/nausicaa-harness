import { describe, expect, it } from "vitest";

import type { A2AMessage, AdviceDisposition, Clock, ArtifactRef } from "../../src/domain/index.js";
import {
  MAX_TASK_MODEL_TOKENS,
  MAX_TASK_WALL_CLOCK_MS,
} from "../../src/domain/index.js";
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

const artifactRef: ArtifactRef = {
  id: "sha256:input",
  contentHash: "sha256:input",
  mediaType: "text/plain",
  byteLength: 12,
};

function taskMessage(
  payload: A2AMessage["payload"],
  overrides: Partial<A2AMessage> = {},
): A2AMessage {
  return {
    messageId: "task-message-1",
    runId: "run-1",
    conversationId: "conversation-1",
    threadId: "thread-1",
    from: "main",
    to: "worker-1",
    createdAt: "2026-08-25T12:00:00.000Z",
    correlationId: "correlation-task-1",
    idempotencyKey: "task-send-1",
    visibility: "run",
    priority: 1,
    delivery: "next-step",
    payload,
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

  it("reports the next matching claimable delay without mutating the Inbox", async () => {
    const clock = new MutableClock(new Date("2026-08-25T12:00:00.000Z"));
    const inbox = new A2AInbox({ clock, claimLeaseMs: 1_000 });
    await inbox.send(adviceMessage());
    expect(inbox.nextClaimableDelayMs("main", {
      from: "teto",
      types: ["advice.propose"],
    })).toBe(0);
    await inbox.claim("main", "worker-a", { claimId: "claim-a" });
    const claimed = inbox.snapshot();

    expect(inbox.nextClaimableDelayMs("main", {
      from: "teto",
      types: ["advice.propose"],
    })).toBe(1_000);
    expect(inbox.nextClaimableDelayMs("main", {
      types: ["task.request"],
    })).toBeUndefined();
    expect(inbox.snapshot()).toEqual(claimed);

    clock.advance(400);
    expect(inbox.nextClaimableDelayMs("main")).toBe(600);
    clock.advance(600);
    expect(inbox.nextClaimableDelayMs("main")).toBe(0);
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

  it("filters claims by message source when requested", async () => {
    const inbox = new A2AInbox();
    await inbox.send(taskMessage(
      { type: "task.accept", taskId: "task-a" },
      { messageId: "accept-a", idempotencyKey: "accept-a", from: "worker-a", to: "main" },
    ));
    await inbox.send(taskMessage(
      { type: "task.accept", taskId: "task-b" },
      { messageId: "accept-b", idempotencyKey: "accept-b", from: "worker-b", to: "main" },
    ));

    const claimed = await inbox.claim("main", "main", {
      claimId: "worker-b-only",
      from: "worker-b",
      types: ["task.accept"],
    });
    expect(claimed.map((record) => record.message.messageId)).toEqual(["accept-b"]);
    expect(inbox.snapshot().records.find((record) => record.message.messageId === "accept-a")?.status)
      .toBe("pending");
  });

  it("claims only delivery modes admitted at the current boundary", async () => {
    const inbox = new A2AInbox();
    for (const delivery of ["next-step", "next-turn", "deferred"] as const) {
      await inbox.send(taskMessage(
        { type: "task.accept", taskId: delivery },
        {
          messageId: delivery,
          idempotencyKey: delivery,
          from: "worker-a",
          to: "main",
          delivery,
        },
      ));
    }

    const currentTurn = await inbox.claim("main", "main", {
      claimId: "current-turn",
      deliveries: ["urgent", "next-step"],
    });
    expect(currentTurn.map((record) => record.message.messageId)).toEqual(["next-step"]);
    expect(inbox.nextClaimableDelayMs("main", {
      deliveries: ["next-turn"],
    })).toBe(0);

    const nextTurn = await inbox.claim("main", "main", {
      claimId: "next-turn-boundary",
      deliveries: ["urgent", "next-step", "next-turn"],
    });
    expect(nextTurn.map((record) => record.message.messageId)).toEqual(["next-turn"]);
    const deferred = await inbox.claim("main", "main", {
      claimId: "explicit-deferred",
      deliveries: ["deferred"],
    });
    expect(deferred.map((record) => record.message.messageId)).toEqual(["deferred"]);
  });

  it("ages old low-priority work until it cannot be starved, including after replay", async () => {
    const ledger = new MemoryLedger();
    const inbox = new A2AInbox({ sink: ledger });
    await inbox.send(taskMessage(
      { type: "task.accept", taskId: "old-low" },
      {
        messageId: "old-low",
        idempotencyKey: "old-low",
        from: "worker-1",
        to: "main",
        priority: 0,
      },
    ));
    await inbox.send(taskMessage(
      { type: "task.accept", taskId: "first-high" },
      {
        messageId: "first-high",
        idempotencyKey: "first-high",
        from: "worker-1",
        to: "main",
        priority: Number.MAX_SAFE_INTEGER,
      },
    ));

    const first = await inbox.claim("main", "main", {
      claimId: "first-priority-claim",
    });
    expect(first.map((record) => record.message.messageId)).toEqual(["first-high"]);
    await inbox.handle("first-high", "main");

    for (let index = 0; index < 80; index += 1) {
      await inbox.send(taskMessage(
        { type: "task.accept", taskId: `aging-${index}` },
        {
          messageId: `aging-${index}`,
          idempotencyKey: `aging-${index}`,
          from: "worker-1",
          to: "other-lane",
          priority: 10,
        },
      ));
    }
    await inbox.send(taskMessage(
      { type: "task.accept", taskId: "new-high" },
      {
        messageId: "new-high",
        idempotencyKey: "new-high",
        from: "worker-1",
        to: "main",
        priority: Number.MAX_SAFE_INTEGER,
      },
    ));

    const events = await ledger.read({ runId: "run-1" });
    const recovered = A2AInbox.rehydrate(events, { sink: ledger });
    const aged = await recovered.claim("main", "main", {
      claimId: "aged-priority-claim",
    });
    expect(aged.map((record) => record.message.messageId)).toEqual(["old-low"]);
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

  it("accepts and rehydrates a bounded task handoff", async () => {
    const inbox = new A2AInbox();
    const request = taskMessage({
      type: "task.request",
      taskId: "task-1",
      goal: {
        version: 1,
        statement: "Inspect the adapter contract",
        successCriteria: ["Return evidence"],
        hardConstraints: ["Do not modify files"],
      },
      inputRefs: [artifactRef],
      budget: { maxModelTokens: 1_000, maxWallClockMs: 30_000 },
    });
    await expect(inbox.send(request)).resolves.toMatchObject({ status: "queued" });
    await expect(inbox.send(request)).resolves.toMatchObject({ status: "duplicate" });

    const claimed = await inbox.claim("worker-1", "worker-1", { claimId: "task-claim" });
    expect(claimed[0]?.message.payload).toMatchObject({ type: "task.request", taskId: "task-1" });
    await inbox.handle("task-message-1", "worker-1");
    expect(inbox.snapshot().records[0]?.status).toBe("handled");
  });

  it.each([
    ["task id", (payload: Extract<A2AMessage["payload"], { type: "task.request" }>) => { payload.taskId = ""; }],
    ["goal version", (payload: Extract<A2AMessage["payload"], { type: "task.request" }>) => { payload.goal.version = 0; }],
    ["model budget", (payload: Extract<A2AMessage["payload"], { type: "task.request" }>) => { payload.budget.maxModelTokens = 0; }],
    ["model budget upper bound", (payload: Extract<A2AMessage["payload"], { type: "task.request" }>) => { payload.budget.maxModelTokens = MAX_TASK_MODEL_TOKENS + 1; }],
    ["wall-clock budget upper bound", (payload: Extract<A2AMessage["payload"], { type: "task.request" }>) => { payload.budget.maxWallClockMs = MAX_TASK_WALL_CLOCK_MS + 1; }],
    ["artifact ref", (payload: Extract<A2AMessage["payload"], { type: "task.request" }>) => { payload.inputRefs[0]!.byteLength = -1; }],
  ])("rejects malformed task request %s", async (_label, mutate) => {
    const inbox = new A2AInbox();
    const payload = {
      type: "task.request" as const,
      taskId: "task-1",
      goal: {
        version: 1,
        statement: "Inspect the adapter contract",
        successCriteria: ["Return evidence"],
        hardConstraints: [],
      },
      inputRefs: [structuredClone(artifactRef)],
      budget: { maxModelTokens: 1_000, maxWallClockMs: 30_000 },
    };
    mutate(payload);
    await expect(inbox.send(taskMessage(payload))).rejects.toThrow(/task|goal|budget|artifact|inputRefs/);
    expect(inbox.snapshot().records).toEqual([]);
  });

  it("validates task result usage and status at the protocol boundary", async () => {
    const inbox = new A2AInbox();
    const payload = {
      type: "task.result" as const,
      taskId: "task-1",
      status: "completed" as const,
      summary: "The adapter contract is explicit.",
      evidenceRefs: ["sha256:evidence"],
      artifactRefs: [],
      openQuestions: [],
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
    };
    await expect(inbox.send(taskMessage(payload))).resolves.toMatchObject({ status: "queued" });
    payload.usage.output = -1;
    await expect(inbox.send(taskMessage(payload, {
      messageId: "task-message-2",
      idempotencyKey: "task-send-2",
    }))).rejects.toThrow(/usage/);
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
