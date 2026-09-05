import { describe, expect, it } from "vitest";

import { A2AInbox } from "../../src/a2a/index.js";
import type {
  A2AMessage,
  ArtifactRef,
  Clock,
  ConversationMessage,
  ModelPort,
  ModelResponse,
  TaskBudget,
  TokenUsage,
} from "../../src/domain/index.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { RunTokenBudget, WorkerTaskExecutor } from "../../src/runtime/index.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

class MutableClock implements Clock {
  constructor(private instant: Date) {}

  now(): Date {
    return new Date(this.instant);
  }

  advance(milliseconds: number): void {
    this.instant = new Date(this.instant.getTime() + milliseconds);
  }
}

describe("Worker durable task budgets", () => {
  it("does not spend a model attempt on a claim that crashed before model.requested", async () => {
    const fixture = await claimedFixture({
      maxModelTokens: 100,
      maxWallClockMs: 60_000,
      deadline: "2026-08-27T12:01:00.000Z",
      maxAttempts: 1,
    });
    fixture.clock.advance(1_001);
    let providerCalls = 0;
    const executor = fixture.executor(async () => {
      providerCalls += 1;
      return response("recovered after an empty claim", usage(4, 2));
    });

    await expect(executor.runOnce()).resolves.toMatchObject({
      status: "completed",
      taskId: "task-1",
    });
    expect(providerCalls).toBe(1);
    const events = await fixture.ledger.read({ runId: "run-1" });
    const requests = events.filter((event) => event.type === "model.requested");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.idempotencyKey).toContain(":attempt:1:model:requested");
  });

  it("fails closed when a reclaimed task has no durable event reader", async () => {
    const fixture = await claimedFixture({
      maxModelTokens: 100,
      maxWallClockMs: 60_000,
      deadline: "2026-08-27T12:01:00.000Z",
      maxAttempts: 2,
    });
    fixture.clock.advance(1_001);
    let providerCalls = 0;
    const executor = new WorkerTaskExecutor({
      inbox: fixture.inbox,
      eventSink: fixture.ledger,
      store: fixture.store,
      model: {
        async complete() {
          providerCalls += 1;
          return response("must not run", usage(1, 1));
        },
      },
      modelName: "scripted/worker",
      runId: "run-1",
      workerLaneId: "worker",
      clock: fixture.clock,
      createId: () => "claim-without-history",
    });

    await expect(executor.runOnce()).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("history is unavailable"),
    });
    expect(providerCalls).toBe(0);
  });

  it("terminalizes a corrupt committed response instead of leaving the lease stuck", async () => {
    const fixture = await claimedFixture({
      maxModelTokens: 100,
      maxWallClockMs: 60_000,
      deadline: "2026-08-27T12:01:00.000Z",
      maxAttempts: 2,
    });
    await appendModelRequested(fixture, 1);
    const responseRef = await fixture.store.put("not-json", "application/vnd.nausicaa.conversation-message+json");
    await fixture.ledger.append({
      runId: "run-1",
      laneId: "worker",
      type: "model.completed",
      payload: {
        model: "scripted/worker",
        responseRef,
        stopReason: "stop",
        usage: usage(2, 1),
      },
      correlationId: "task-correlation-1",
      idempotencyKey: attemptPrefix(1) + ":model:completed",
      visibility: "run",
      occurredAt: fixture.clock.now().toISOString(),
    });
    fixture.clock.advance(1_001);
    let providerCalls = 0;
    const executor = fixture.executor(async () => {
      providerCalls += 1;
      return response("must not run", usage(1, 1));
    });

    await expect(executor.runOnce()).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("not valid JSON"),
    });
    expect(providerCalls).toBe(0);
    const requestRecord = fixture.inbox.snapshot().records.find((record) => (
      record.message.payload.type === "task.request"
    ));
    expect(requestRecord?.status).toBe("handled");
  });

  it("does not reset the absolute deadline after queue and lease delay", async () => {
    const fixture = await claimedFixture({
      maxModelTokens: 100,
      maxWallClockMs: 1_000,
      deadline: "2026-08-27T12:00:01.000Z",
      maxAttempts: 2,
    });
    fixture.clock.advance(1_001);
    let providerCalls = 0;
    const executor = fixture.executor(async () => {
      providerCalls += 1;
      return response("too late", usage(1, 1));
    });

    await expect(executor.runOnce()).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("deadline expired"),
    });
    expect(providerCalls).toBe(0);
    const failure = fixture.inbox.snapshot().records.find((record) => (
      record.message.payload.type === "task.failed"
    ));
    expect(failure?.message.payload).toMatchObject({ retryable: false });
    expect((await fixture.ledger.read({ runId: "run-1" })).some((event) => (
      event.type === "model.requested"
    ))).toBe(false);
  });

  it("derives a stable deadline from createdAt for legacy task messages", async () => {
    const fixture = await claimedFixture({
      maxModelTokens: 100,
      maxWallClockMs: 1_000,
    });
    fixture.clock.advance(1_001);
    let providerCalls = 0;
    const executor = fixture.executor(async () => {
      providerCalls += 1;
      return response("too late", usage(1, 1));
    });

    await expect(executor.runOnce()).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("deadline expired"),
    });
    expect(providerCalls).toBe(0);
  });

  it("retries an orphan model request only while maxAttempts permits", async () => {
    const fixture = await claimedFixture({
      maxModelTokens: 100,
      maxWallClockMs: 60_000,
      deadline: "2026-08-27T12:01:00.000Z",
      maxAttempts: 2,
    });
    await appendModelRequested(fixture, 1);
    fixture.clock.advance(1_001);
    let providerCalls = 0;
    const runTokenBudget = new RunTokenBudget(500);
    const executor = fixture.executor(async () => {
      providerCalls += 1;
      return response("second attempt completed", usage(3, 2));
    }, runTokenBudget);

    await expect(executor.runOnce()).resolves.toMatchObject({ status: "completed" });
    expect(providerCalls).toBe(1);
    const requests = (await fixture.ledger.read({ runId: "run-1" })).filter((event) => (
      event.type === "model.requested"
    ));
    expect(requests.map((event) => event.idempotencyKey)).toEqual([
      expect.stringContaining(":attempt:1:model:requested"),
      expect.stringContaining(":attempt:2:model:requested"),
    ]);
    expect(runTokenBudget.snapshot().settlements).toMatchObject([{
      id: "run-1:worker:task:task-1:attempt:2:provider",
      actualTokens: 5,
    }]);
  });

  it("recovers charged-only attempt usage without double counting the retry", async () => {
    const fixture = await claimedFixture({
      maxModelTokens: 20,
      maxWallClockMs: 60_000,
      deadline: "2026-08-27T12:01:00.000Z",
      maxAttempts: 2,
    });
    await appendModelRequested(fixture, 1);
    await appendBudgetCharged(fixture, 1, usage(3, 2));
    fixture.clock.advance(1_001);
    let requestMaxOutput = 0;
    const executor = fixture.executor(async (request) => {
      requestMaxOutput = request.maxOutputTokens;
      return response("retry completed", usage(4, 1));
    });

    await expect(executor.runOnce()).resolves.toMatchObject({
      status: "completed",
      usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 },
    });
    expect(requestMaxOutput).toBe(15);
    const charges = (await fixture.ledger.read({ runId: "run-1" })).filter((event) => (
      event.type === "budget.charged"
    ));
    expect(charges).toHaveLength(2);
    expect(charges.map((event) => event.idempotencyKey)).toEqual([
      attemptPrefix(1) + ":budget",
      attemptPrefix(2) + ":budget",
    ]);
  });

  it("terminates an orphan model request after maxAttempts is exhausted", async () => {
    const fixture = await claimedFixture({
      maxModelTokens: 100,
      maxWallClockMs: 60_000,
      deadline: "2026-08-27T12:01:00.000Z",
      maxAttempts: 1,
    });
    await appendModelRequested(fixture, 1);
    fixture.clock.advance(1_001);
    let providerCalls = 0;
    const executor = fixture.executor(async () => {
      providerCalls += 1;
      return response("must not run", usage(1, 1));
    });

    await expect(executor.runOnce()).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("attempt budget exhausted (1/1)"),
    });
    expect(providerCalls).toBe(0);
    const failure = fixture.inbox.snapshot().records.find((record) => (
      record.message.payload.type === "task.failed"
    ));
    expect(failure?.message.payload).toMatchObject({ retryable: false });
  });

  it("recovers model.failed as one terminal failure without another provider call", async () => {
    const fixture = await claimedFixture({
      maxModelTokens: 100,
      maxWallClockMs: 60_000,
      deadline: "2026-08-27T12:01:00.000Z",
      maxAttempts: 2,
    });
    await appendModelFailed(fixture, "provider overloaded", true);
    fixture.clock.advance(1_001);
    let providerCalls = 0;
    const executor = fixture.executor(async () => {
      providerCalls += 1;
      return response("must not run", usage(1, 1));
    });

    await expect(executor.runOnce()).resolves.toMatchObject({
      status: "failed",
      reason: "provider overloaded",
    });
    expect(providerCalls).toBe(0);
    const failures = (await fixture.ledger.read({ runId: "run-1" })).filter((event) => (
      event.type === "message.sent"
      && event.payload.message.payload.type === "task.failed"
    ));
    expect(failures).toHaveLength(1);
    expect(failures[0]?.type === "message.sent" ? failures[0].payload.message.payload : undefined)
      .toMatchObject({ retryable: true, reason: "provider overloaded" });
  });

  it("recovers a legacy model.failed without retryable as non-retryable", async () => {
    const fixture = await claimedFixture({
      maxModelTokens: 100,
      maxWallClockMs: 60_000,
      deadline: "2026-08-27T12:01:00.000Z",
      maxAttempts: 2,
    });
    await appendModelFailed(fixture, "legacy provider failure");
    fixture.clock.advance(1_001);
    const executor = fixture.executor(async () => {
      throw new Error("legacy failure recovery must not call the provider");
    });

    await expect(executor.runOnce()).resolves.toMatchObject({
      status: "failed",
      reason: "legacy provider failure",
    });
    const terminal = fixture.inbox.snapshot().records.find((record) => (
      record.message.payload.type === "task.failed"
    ));
    expect(terminal?.message.payload).toMatchObject({ retryable: false });
  });

  it("reports cumulative completion usage and charges every attempt once", async () => {
    const fixture = await claimedFixture({
      maxModelTokens: 20,
      maxWallClockMs: 60_000,
      deadline: "2026-08-27T12:01:00.000Z",
      maxAttempts: 2,
    });
    await appendModelCompletion(
      fixture,
      1,
      "first",
      usage(3, 2),
    );
    const secondResponseRef = await appendModelCompletion(fixture, 2, "second", usage(2, 1));
    fixture.clock.advance(1_001);
    const executor = fixture.executor(async () => {
      throw new Error("committed completions must prevent provider execution");
    });

    await expect(executor.runOnce()).resolves.toMatchObject({
      status: "completed",
      usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0 },
    });
    const events = await fixture.ledger.read({ runId: "run-1" });
    expect(events.filter((event) => event.type === "budget.charged")).toHaveLength(2);
    const result = events.find((event) => (
      event.type === "message.sent"
      && event.payload.message.payload.type === "task.result"
    ));
    expect(result?.type === "message.sent" ? result.payload.message.payload : undefined)
      .toMatchObject({
        summary: "second",
        artifactRefs: [secondResponseRef],
        usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0 },
      });
  });

  it("turns an over-budget cumulative completion into terminal failure", async () => {
    const fixture = await claimedFixture({
      maxModelTokens: 7,
      maxWallClockMs: 60_000,
      deadline: "2026-08-27T12:01:00.000Z",
      maxAttempts: 2,
    });
    await appendModelCompletion(fixture, 1, "first", usage(3, 2));
    await appendModelCompletion(fixture, 2, "second", usage(2, 1));
    fixture.clock.advance(1_001);
    const executor = fixture.executor(async () => {
      throw new Error("committed completions must prevent provider execution");
    });

    await expect(executor.runOnce()).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("token budget exceeded (8 > 7)"),
    });
    const events = await fixture.ledger.read({ runId: "run-1" });
    expect(events.filter((event) => event.type === "budget.charged")).toHaveLength(2);
    expect(events.filter((event) => (
      event.type === "message.sent"
      && event.payload.message.payload.type === "task.failed"
    ))).toHaveLength(1);
  });
});

interface Fixture {
  clock: MutableClock;
  ledger: MemoryLedger;
  inbox: A2AInbox;
  store: MemoryContentAddressedStore;
  request: A2AMessage;
  executor(complete: ModelPort["complete"], runTokenBudget?: RunTokenBudget): WorkerTaskExecutor;
}

async function claimedFixture(budget: TaskBudget): Promise<Fixture> {
  const clock = new MutableClock(new Date("2026-08-27T12:00:00.000Z"));
  const ledger = new MemoryLedger({ clock });
  const store = new MemoryContentAddressedStore();
  const request = taskRequest(budget);
  const firstInbox = new A2AInbox({ sink: ledger, clock, claimLeaseMs: 1_000 });
  await firstInbox.send(request);
  await firstInbox.claim("worker", "worker", { claimId: "claim-before-crash" });

  const inbox = A2AInbox.rehydrate(await ledger.read({ runId: "run-1" }), {
    sink: ledger,
    clock,
    claimLeaseMs: 1_000,
  });
  let ids = 0;
  return {
    clock,
    ledger,
    inbox,
    store,
    request,
    executor: (complete, runTokenBudget) => new WorkerTaskExecutor({
      inbox,
      eventSink: ledger,
      store,
      model: { complete },
      modelName: "scripted/worker",
      runId: "run-1",
      ...(runTokenBudget === undefined ? {} : { runTokenBudget }),
      workerLaneId: "worker",
      clock,
      createId: () => `recovered-claim-${++ids}`,
      readWatermark: () => ledger.watermark(),
      readEvents: () => ledger.read({ runId: "run-1" }),
    }),
  };
}

function taskRequest(budget: TaskBudget): A2AMessage {
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
      budget,
    },
  };
}

async function appendModelRequested(fixture: Fixture, attempt: number): Promise<void> {
  await fixture.ledger.append({
    runId: "run-1",
    laneId: "worker",
    type: "model.requested",
    payload: {
      model: "scripted/worker",
      requestHash: `request-${attempt}`,
      contextWatermark: await fixture.ledger.watermark(),
      sessionId: "run-1:worker:task:task-1",
      prefixHash: "worker-prefix",
      dependencyRefs: [],
      contextBuildMs: 0,
    },
    correlationId: "task-correlation-1",
    idempotencyKey: attemptPrefix(attempt) + ":model:requested",
    visibility: "run",
    occurredAt: fixture.clock.now().toISOString(),
  });
}

async function appendModelCompletion(
  fixture: Fixture,
  attempt: number,
  content: string,
  modelUsage: TokenUsage,
): Promise<ArtifactRef> {
  await appendModelRequested(fixture, attempt);
  const responseRef = await fixture.store.put(JSON.stringify({
    role: "assistant",
    content,
    toolCalls: [],
    createdAt: fixture.clock.now().toISOString(),
  } satisfies ConversationMessage), "application/vnd.nausicaa.conversation-message+json");
  await fixture.ledger.append({
    runId: "run-1",
    laneId: "worker",
    type: "model.completed",
    payload: {
      model: "scripted/worker",
      responseRef,
      stopReason: "stop",
      usage: modelUsage,
      cacheOutcome: "unknown",
    },
    correlationId: "task-correlation-1",
    idempotencyKey: attemptPrefix(attempt) + ":model:completed",
    visibility: "run",
    occurredAt: fixture.clock.now().toISOString(),
  });
  return responseRef;
}

async function appendBudgetCharged(
  fixture: Fixture,
  attempt: number,
  modelUsage: TokenUsage,
): Promise<void> {
  await fixture.ledger.append({
    runId: "run-1",
    laneId: "worker",
    type: "budget.charged",
    payload: { laneId: "worker", usage: modelUsage },
    correlationId: "task-correlation-1",
    idempotencyKey: attemptPrefix(attempt) + ":budget",
    visibility: "run",
    occurredAt: fixture.clock.now().toISOString(),
  });
}

async function appendModelFailed(
  fixture: Fixture,
  error: string,
  retryable?: boolean,
): Promise<void> {
  await appendModelRequested(fixture, 1);
  await fixture.ledger.append({
    runId: "run-1",
    laneId: "worker",
    type: "model.failed",
    payload: {
      model: "scripted/worker",
      error,
      ...(retryable === undefined ? {} : { retryable }),
    },
    correlationId: "task-correlation-1",
    idempotencyKey: attemptPrefix(1) + ":model:failed",
    visibility: "run",
    occurredAt: fixture.clock.now().toISOString(),
  });
}

function attemptPrefix(attempt: number): string {
  return `run-1:worker:task:task-1:attempt:${attempt}`;
}

function response(content: string, modelUsage: TokenUsage): ModelResponse {
  return { content, toolCalls: [], stopReason: "stop", usage: modelUsage };
}

function usage(input: number, output: number): TokenUsage {
  return { input, output, cacheRead: 0, cacheWrite: 0 };
}
