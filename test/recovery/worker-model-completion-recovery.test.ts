import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { A2AInbox } from "../../src/a2a/index.js";
import type {
  A2AMessage,
  Clock,
  ConversationMessage,
  ModelPort,
} from "../../src/domain/index.js";
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

describe("Worker model completion recovery", () => {
  it("rebuilds the terminal result from the Ledger and CAS without another provider call", async () => {
    const root = await temporaryRoot();
    const ledgerPath = join(root, "ledger.jsonl");
    const store = await FileContentAddressedStore.open(join(root, "store"));
    const clock = new MutableClock(new Date("2026-08-27T12:00:00.000Z"));
    const firstLedger = await JsonlLedger.open(ledgerPath);
    const firstInbox = new A2AInbox({
      sink: firstLedger,
      clock,
      claimLeaseMs: 1_000,
    });
    const request = taskRequest();

    await firstInbox.send(request);
    await firstInbox.claim("worker", "worker", {
      claimId: "worker-first-attempt",
    });
    await firstInbox.send(taskAccept(request, clock.now().toISOString()));

    const responseRef = await store.put(JSON.stringify({
      role: "assistant",
      content: "Use `npm install`.",
      toolCalls: [],
      createdAt: clock.now().toISOString(),
    } satisfies ConversationMessage), "application/vnd.nausicaa.conversation-message+json");
    const prefix = "run-1:worker:task:task-1:attempt:1";
    await firstLedger.append({
      runId: "run-1",
      laneId: "worker",
      type: "model.requested",
      payload: {
        model: "scripted/worker",
        requestHash: "sha256:requested",
        contextWatermark: await firstLedger.watermark(),
        sessionId: "run-1:worker:task:task-1",
        prefixHash: "sha256:prefix",
        dependencyRefs: [],
        contextBuildMs: 0,
      },
      correlationId: request.correlationId,
      idempotencyKey: `${prefix}:model:requested`,
      visibility: "run",
      occurredAt: clock.now().toISOString(),
    });
    await firstLedger.append({
      runId: "run-1",
      laneId: "worker",
      type: "model.completed",
      payload: {
        model: "scripted/worker",
        responseRef,
        stopReason: "stop",
        usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
        cacheOutcome: "unknown",
      },
      correlationId: request.correlationId,
      idempotencyKey: `${prefix}:model:completed`,
      visibility: "run",
      occurredAt: clock.now().toISOString(),
    });
    await firstLedger.close();

    clock.advance(1_001);
    const recoveredLedger = await JsonlLedger.open(ledgerPath);
    const committed = await recoveredLedger.read({ runId: "run-1" });
    const recoveredInbox = A2AInbox.rehydrate(committed, {
      sink: recoveredLedger,
      clock,
      claimLeaseMs: 1_000,
    });
    let providerCalls = 0;
    const model: ModelPort = {
      async complete() {
        providerCalls += 1;
        throw new Error("recovery must not call the provider");
      },
    };
    const executor = new WorkerTaskExecutor({
      inbox: recoveredInbox,
      eventSink: recoveredLedger,
      store,
      model,
      modelName: "scripted/worker",
      runId: "run-1",
      workerLaneId: "worker",
      clock,
      createId: () => "worker-recovered-attempt",
      readWatermark: () => recoveredLedger.watermark(),
      readEvents: () => recoveredLedger.read({ runId: "run-1" }),
    });

    await expect(executor.runOnce()).resolves.toMatchObject({
      status: "completed",
      taskId: "task-1",
      requestMessageId: "task-request-1",
      usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
      artifactRefs: [responseRef],
    });
    expect(providerCalls).toBe(0);
    expect(recoveredInbox.snapshot().records.find((record) => (
      record.message.messageId === request.messageId
    ))?.status).toBe("handled");

    const events = await recoveredLedger.read({ runId: "run-1" });
    expect(count(events, "model.requested")).toBe(1);
    expect(count(events, "model.completed")).toBe(1);
    expect(count(events, "assistant.message")).toBe(1);
    expect(count(events, "budget.charged")).toBe(1);
    expect(events.filter((event) => (
      event.type === "message.sent"
      && event.payload.message.payload.type === "task.accept"
    ))).toHaveLength(1);
    const results = events.filter((event) => (
      event.type === "message.sent"
      && event.payload.message.payload.type === "task.result"
    ));
    expect(results).toHaveLength(1);
    expect(results[0]?.type === "message.sent" ? results[0].payload.message.payload : undefined)
      .toMatchObject({
        type: "task.result",
        summary: "Use `npm install`.",
        artifactRefs: [responseRef],
      });
    expect(events.filter((event) => (
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

function taskAccept(request: A2AMessage, createdAt: string): A2AMessage {
  if (request.payload.type !== "task.request") throw new Error("expected task request");
  return {
    messageId: "run-1:worker:task:task-1:accept",
    runId: request.runId,
    conversationId: request.conversationId,
    threadId: request.threadId,
    from: "worker",
    to: request.from,
    parentId: request.messageId,
    replyTo: request.messageId,
    createdAt,
    correlationId: request.correlationId,
    idempotencyKey: "run-1:worker:task:task-1:accept",
    visibility: request.visibility,
    priority: request.priority,
    delivery: "next-step",
    payload: { type: "task.accept", taskId: request.payload.taskId },
  };
}

function count(
  events: readonly { type: string }[],
  type: string,
): number {
  return events.filter((event) => event.type === type).length;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nausicaa-worker-model-recovery-"));
  roots.push(root);
  return root;
}
