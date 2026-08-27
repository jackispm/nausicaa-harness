import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { A2AInbox } from "../../src/a2a/index.js";
import type { A2AMessage, Clock, ModelPort } from "../../src/domain/index.js";
import { JsonlLedger } from "../../src/ledger/index.js";
import { WorkerTaskExecutor } from "../../src/runtime/index.js";
import { FileContentAddressedStore } from "../../src/store/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

class MutableClock implements Clock {
  constructor(private instant: Date) {}

  now(): Date {
    return new Date(this.instant);
  }

  advance(milliseconds: number): void {
    this.instant = new Date(this.instant.getTime() + milliseconds);
  }
}

describe("Worker recovery protocol", () => {
  it("rehydrates a claimed task and redelivers it only after the lease expires", async () => {
    const root = await temporaryRoot();
    const ledgerPath = join(root, "ledger.jsonl");
    const clock = new MutableClock(new Date("2026-08-27T12:00:00.000Z"));
    const firstLedger = await JsonlLedger.open(ledgerPath);
    const firstInbox = new A2AInbox({
      sink: firstLedger,
      clock,
      claimLeaseMs: 1_000,
    });

    await firstInbox.send(taskRequest());
    const original = await firstInbox.claim("worker", "worker", {
      claimId: "worker-claim-before-restart",
    });
    expect(original[0]?.claim).toMatchObject({
      attempt: 1,
      claimedBy: "worker",
    });
    await firstLedger.close();

    clock.advance(999);
    const recoveredLedger = await JsonlLedger.open(ledgerPath);
    const committed = await recoveredLedger.read({ runId: "run-1" });
    const recoveredInbox = A2AInbox.rehydrate(committed, {
      sink: recoveredLedger,
      clock,
      claimLeaseMs: 1_000,
    });

    await expect(recoveredInbox.claim("worker", "worker", {
      claimId: "worker-claim-too-early",
    })).resolves.toEqual([]);

    clock.advance(2);
    const redelivered = await recoveredInbox.claim("worker", "worker", {
      claimId: "worker-claim-after-restart",
    });
    expect(redelivered).toHaveLength(1);
    expect(redelivered[0]?.message.messageId).toBe("task-request-1");
    expect(redelivered[0]?.claim).toMatchObject({
      claimId: "worker-claim-after-restart",
      attempt: 2,
      claimedBy: "worker",
    });

    const recoveredEvents = await recoveredLedger.read({ runId: "run-1" });
    expect(recoveredEvents.filter((event) => event.type === "message.claimed"))
      .toHaveLength(2);
    await recoveredLedger.close();
  });

  it("uses a durable terminal reply after restart without executing the model again", async () => {
    const root = await temporaryRoot();
    const ledgerPath = join(root, "ledger.jsonl");
    const clock = new MutableClock(new Date("2026-08-27T12:00:00.000Z"));
    const firstLedger = await JsonlLedger.open(ledgerPath);
    const firstInbox = new A2AInbox({
      sink: firstLedger,
      clock,
      claimLeaseMs: 1_000,
    });
    const request = taskRequest();
    const terminal = taskResult();

    await firstInbox.send(request);
    await firstInbox.claim("worker", "worker", {
      claimId: "worker-claim-before-terminal",
    });
    await firstInbox.send(terminal);
    expect(firstInbox.snapshot().records.find((record) => (
      record.message.messageId === request.messageId
    ))?.status).toBe("claimed");
    await firstLedger.close();

    clock.advance(1_001);
    const recoveredLedger = await JsonlLedger.open(ledgerPath);
    const committed = await recoveredLedger.read({ runId: "run-1" });
    const recoveredInbox = A2AInbox.rehydrate(committed, {
      sink: recoveredLedger,
      clock,
      claimLeaseMs: 1_000,
    });
    await expect(recoveredInbox.send(terminal)).resolves.toEqual({
      status: "duplicate",
      messageId: terminal.messageId,
    });

    let modelCalls = 0;
    const model: ModelPort = {
      async complete() {
        modelCalls += 1;
        throw new Error("the durable terminal reply should prevent model execution");
      },
    };
    const store = await FileContentAddressedStore.open(join(root, "store"));
    let claimSequence = 0;
    const executor = new WorkerTaskExecutor({
      inbox: recoveredInbox,
      eventSink: recoveredLedger,
      store,
      model,
      modelName: "scripted/worker",
      runId: "run-1",
      workerLaneId: "worker",
      clock,
      createId: () => `worker-recovery-claim-${++claimSequence}`,
    });

    await expect(executor.runOnce()).resolves.toMatchObject({
      status: "completed",
      taskId: "task-1",
      usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
    expect(modelCalls).toBe(0);
    expect(recoveredInbox.snapshot().records.find((record) => (
      record.message.messageId === request.messageId
    ))?.status).toBe("handled");
    await expect(executor.runOnce()).resolves.toEqual({ status: "idle" });

    const recoveredEvents = await recoveredLedger.read({ runId: "run-1" });
    expect(recoveredEvents.filter((event) => (
      event.type === "message.sent"
      && event.payload.message.payload.type === "task.result"
    ))).toHaveLength(1);
    expect(recoveredEvents.some((event) => event.type === "model.requested"))
      .toBe(false);
    expect(recoveredEvents.filter((event) => (
      event.type === "message.handled"
      && event.payload.messageId === request.messageId
    ))).toHaveLength(1);

    await executor.stop();
    await recoveredLedger.close();
  });
});

function taskRequest(): A2AMessage {
  return {
    messageId: "task-request-1",
    runId: "run-1",
    conversationId: "conversation-1",
    threadId: "thread-1",
    from: "main",
    to: "worker",
    createdAt: "2026-08-27T12:00:00.000Z",
    correlationId: "task-correlation-1",
    idempotencyKey: "task-request-1",
    visibility: "run",
    priority: 1,
    delivery: "next-step",
    payload: {
      type: "task.request",
      taskId: "task-1",
      goal: {
        version: 1,
        statement: "Identify the package manager command",
        successCriteria: ["Return one grounded command"],
        hardConstraints: ["Do not modify files"],
      },
      inputRefs: [],
      budget: { maxModelTokens: 500, maxWallClockMs: 5_000 },
    },
  };
}

function taskResult(): A2AMessage {
  return {
    messageId: "run-1:worker:task:task-1:result",
    runId: "run-1",
    conversationId: "conversation-1",
    threadId: "thread-1",
    from: "worker",
    to: "main",
    parentId: "task-request-1",
    replyTo: "task-request-1",
    createdAt: "2026-08-27T12:00:00.000Z",
    correlationId: "task-correlation-1",
    idempotencyKey: "run-1:worker:task:task-1:result",
    visibility: "run",
    priority: 1,
    delivery: "next-step",
    payload: {
      type: "task.result",
      taskId: "task-1",
      status: "completed",
      summary: "Use npm install.",
      evidenceRefs: [],
      artifactRefs: [],
      openQuestions: [],
      usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
    },
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nausicaa-worker-recovery-"));
  roots.push(root);
  return root;
}
