import { afterEach, describe, expect, it, vi } from "vitest";

import { A2AInbox } from "../../src/a2a/index.js";
import type {
  A2AMessage,
  Goal,
  ModelPort,
  ModelRequest,
  ModelResponse,
} from "../../src/domain/index.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import {
  projectCommittedBoundaryMessageIds,
  TaskDispatcher,
  WorkerLaneScheduler,
  WorkerTaskExecutor,
} from "../../src/runtime/index.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";
import type { MainAfterStepContext } from "../../src/runtime/main-loop.js";

const goal: Goal = {
  version: 1,
  statement: "Return a concise inspection",
  successCriteria: ["Include the result"],
  hardConstraints: ["Do not modify files"],
};

function mainStep(boundaryMessageIds: readonly string[] = []): MainAfterStepContext {
  return {
    runId: "run-1",
    laneId: "main",
    step: 1,
    goal,
    responseText: "done",
    toolCalls: [],
    toolResults: [],
    delta: {
      boundaryId: "boundary-1",
      triggerKind: "normal",
      activeObjective: goal.statement,
      actionOrDecision: "inspect",
      expectedOutcome: "answer",
      outcome: "done",
      status: "progress",
      uncertainties: [],
      openQuestions: [],
    },
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    boundaryMessageIds,
  };
}

async function setup(model: ModelPort) {
  const ledger = new MemoryLedger();
  const store = new MemoryContentAddressedStore();
  const inbox = new A2AInbox({ sink: ledger });
  const dispatcher = new TaskDispatcher({ inbox, runId: "run-1", to: "worker" });
  await dispatcher.dispatch({
    taskId: "task-1",
    goal,
    budget: { maxModelTokens: 500, maxWallClockMs: 5_000 },
  });
  const executor = new WorkerTaskExecutor({
    inbox,
    eventSink: ledger,
    store,
    model,
    modelName: "scripted/worker",
    runId: "run-1",
    workerLaneId: "worker",
    readWatermark: () => ledger.watermark(),
  });
  const scheduler = new WorkerLaneScheduler({
    executor,
    inbox,
    runId: "run-1",
    workerLaneId: "worker",
    createId: () => "delivery-1",
  });
  return { ledger, inbox, scheduler };
}

describe("WorkerLaneScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs Worker work asynchronously and delivers terminal results at the next boundary", async () => {
    const { inbox, scheduler } = await setup(new ScriptedModel([{
      content: "Worker found the requested detail.",
      toolCalls: [],
      stopReason: "stop",
      usage: { input: 20, output: 6, cacheRead: 0, cacheWrite: 0 },
    }]));

    scheduler.enqueue(mainStep());
    const deliveredBeforeDrain = await scheduler.beforeMainStep();
    expect(deliveredBeforeDrain).toEqual([]);
    await scheduler.drain();

    const messages = await scheduler.beforeMainStep();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: "runtime-notice",
      source: "worker",
      messageId: "run-1:worker:task:task-1:result",
    });
    expect(messages[0]?.content).toContain("Worker found the requested detail.");

    scheduler.enqueue(mainStep(messages.map((message) => message.messageId)));
    await scheduler.drain();
    const terminal = inbox.snapshot().records.find((record) => (
      record.message.messageId === "run-1:worker:task:task-1:result"
    ));
    expect(terminal?.status).toBe("handled");
  });

  it("isolates Worker model failures and still exposes a retryable terminal notice", async () => {
    const { inbox, scheduler } = await setup(new ScriptedModel([new Error("provider unavailable")]));

    scheduler.enqueue();
    await scheduler.drain();
    const messages = await scheduler.beforeMainStep();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("failed");
    expect(messages[0]?.content).toContain("Retryable: yes");
    expect(inbox.snapshot().records.some((record) => (
      record.message.payload.type === "task.failed"
    ))).toBe(true);
    const failed = inbox.snapshot().records.find((record) => (
      record.message.payload.type === "task.failed"
    ));
    expect(failed?.status).toBe("claimed");
  });

  it("holds next-turn Worker replies until the first boundary of a later Turn", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const inbox = new A2AInbox({ sink: ledger });
    const dispatcher = new TaskDispatcher({ inbox, runId: "run-1", to: "worker" });
    await dispatcher.dispatch({
      taskId: "next-turn-task",
      goal,
      budget: { maxModelTokens: 500, maxWallClockMs: 5_000 },
      delivery: "next-turn",
    });
    const scheduler = new WorkerLaneScheduler({
      executor: new WorkerTaskExecutor({
        inbox,
        eventSink: ledger,
        store,
        model: new ScriptedModel([{
          content: "future result",
          toolCalls: [],
          stopReason: "stop",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        }]),
        modelName: "scripted/worker",
        runId: "run-1",
        workerLaneId: "worker",
      }),
      inbox,
      runId: "run-1",
      workerLaneId: "worker",
    });

    scheduler.enqueue(mainStep());
    await scheduler.drain();
    expect(await scheduler.beforeMainStep({ step: 2 })).toEqual([]);
    expect(await scheduler.beforeMainStep({ step: 1 })).toEqual([
      expect.objectContaining({
        messageId: "run-1:worker:task:next-turn-task:result",
      }),
    ]);
  });

  it("does not await an in-flight Worker model from enqueue", async () => {
    let resolveModel: ((response: ModelResponse) => void) | undefined;
    const slowModel: ModelPort = {
      complete: async (_request: ModelRequest) => new Promise<ModelResponse>((resolve) => {
        resolveModel = resolve;
      }),
    };
    const { scheduler } = await setup(slowModel);
    scheduler.enqueue();
    expect(await scheduler.beforeMainStep()).toEqual([]);
    for (let attempt = 0; attempt < 20 && resolveModel === undefined; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(resolveModel).toBeTypeOf("function");
    resolveModel?.({
      content: "done",
      toolCalls: [],
      stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    await scheduler.drain();
  });

  it("stops queued passes before they claim new Worker work", async () => {
    const { inbox, scheduler } = await setup(new ScriptedModel([]));
    scheduler.enqueue(mainStep());
    const errors = await scheduler.stop();

    expect(errors).toEqual([]);
    expect(scheduler.abortSignal.aborted).toBe(true);
    expect(inbox.snapshot().records[0]?.status).toBe("pending");
  });

  it("drains all same-step delegated tasks in one bounded activation", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const inbox = new A2AInbox({ sink: ledger });
    const dispatcher = new TaskDispatcher({ inbox, runId: "run-1" });
    for (let index = 1; index <= 3; index += 1) {
      await dispatcher.dispatch({
        taskId: `task-${index}`,
        goal,
        budget: { maxModelTokens: 500, maxWallClockMs: 5_000 },
      });
    }
    const model = new ScriptedModel(Array.from({ length: 3 }, (_, index) => ({
      content: `result-${index + 1}`,
      toolCalls: [],
      stopReason: "stop" as const,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    })));
    const executor = new WorkerTaskExecutor({
      inbox,
      eventSink: ledger,
      store,
      model,
      modelName: "scripted/worker",
      runId: "run-1",
    });
    const scheduler = new WorkerLaneScheduler({ executor, inbox, runId: "run-1" });

    scheduler.enqueue(mainStep());
    await scheduler.drain();

    expect(model.callCount).toBe(3);
    expect(inbox.snapshot().records.filter((record) => (
      record.message.payload.type === "task.request"
    )).map((record) => record.status)).toEqual(["handled", "handled", "handled"]);
    await scheduler.stop();
  });

  it("coalesces saturated wakeups at the configured activation bound", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const bounded = new WorkerLaneScheduler({
      executor: {
        runOnce: async () => {
          calls += 1;
          if (calls === 1) {
            markStarted?.();
            await blocked;
          }
          return { status: "idle" as const };
        },
      },
      inbox: new A2AInbox(),
      runId: "run-1",
      maxPendingActivations: 1,
    });
    bounded.enqueue(mainStep());
    await started;
    for (let index = 0; index < 100; index += 1) {
      bounded.enqueue(mainStep());
    }
    expect(bounded.pendingActivations).toBe(1);
    expect(bounded.droppedWakeupsCount).toBe(100);
    release?.();
    await bounded.drain();
    expect(calls).toBe(1);
    expect(bounded.pendingActivations).toBe(0);
    await bounded.stop();
  });

  it("acknowledges delivered results without waiting for a slow Worker activation", async () => {
    const inbox = new A2AInbox();
    await inbox.send(workerResultMessage());
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = new WorkerLaneScheduler({
      executor: {
        runOnce: async () => {
          await blocked;
          return { status: "idle" as const };
        },
      },
      inbox,
      runId: "run-1",
      maxTasksPerActivation: 1,
    });
    const [notice] = await scheduler.beforeMainStep();
    scheduler.enqueue(mainStep([notice!.messageId]));

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (inbox.snapshot().records[0]?.status === "handled") break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(inbox.snapshot().records[0]?.status).toBe("handled");
    expect(scheduler.pendingActivations).toBe(1);
    release?.();
    await scheduler.stop();
  });

  it("repairs a committed terminal receipt after restart without reinjecting it", async () => {
    const ledger = new MemoryLedger();
    const firstInbox = new A2AInbox({ sink: ledger });
    const terminal = workerResultMessage();
    await firstInbox.send(terminal);
    await firstInbox.claim("main", "main", { claimId: "before-crash" });
    await ledger.append({
      runId: "run-1",
      laneId: "main",
      type: "step.completed",
      payload: {
        step: 1,
        hasToolCalls: false,
        boundaryMessageIds: [terminal.messageId],
      },
      correlationId: "run-1",
      idempotencyKey: "main:step:1:completed",
      visibility: "run",
    });

    const committed = await ledger.read({ runId: "run-1" });
    const recoveredInbox = A2AInbox.rehydrate(committed, { sink: ledger });
    const recovered = new WorkerLaneScheduler({
      executor: { runOnce: async () => ({ status: "idle" as const }) },
      inbox: recoveredInbox,
      runId: "run-1",
      committedBoundaryMessageIds: projectCommittedBoundaryMessageIds(
        committed,
        "run-1",
      ),
    });

    await expect(recovered.beforeMainStep()).resolves.toEqual([]);
    expect(recoveredInbox.snapshot().records[0]?.status).toBe("handled");
    await expect(recovered.beforeMainStep()).resolves.toEqual([]);
    const finalEvents = await ledger.read({ runId: "run-1" });
    expect(finalEvents.filter((event) => (
      event.type === "message.handled"
      && event.payload.messageId === terminal.messageId
    ))).toHaveLength(1);
    await recovered.stop();
  });

  it("waits for a recovered task lease and wakes automatically when it expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00.000Z"));
    const { inbox, runs, scheduler } = await setupClaimedWorkerTask();

    scheduler.enqueue();
    await scheduler.drain();
    expect(runs.count).toBe(1);
    expect(inbox.snapshot().records[0]?.status).toBe("claimed");

    await vi.advanceTimersByTimeAsync(999);
    expect(runs.count).toBe(1);
    expect(inbox.snapshot().records[0]?.status).toBe("claimed");

    await vi.advanceTimersByTimeAsync(1);
    await scheduler.drain();
    expect(runs.count).toBe(2);
    expect(inbox.snapshot().records[0]?.status).toBe("handled");
    await scheduler.stop();
  });

  it("cancels a recovered task lease wakeup when stopped", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00.000Z"));
    const { inbox, runs, scheduler } = await setupClaimedWorkerTask();

    scheduler.enqueue();
    await scheduler.drain();
    expect(runs.count).toBe(1);
    await scheduler.stop();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runs.count).toBe(1);
    expect(inbox.snapshot().records[0]?.status).toBe("claimed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 65])("rejects an invalid pending activation bound (%s)", (maxPendingActivations) => {
    expect(() => new WorkerLaneScheduler({
      executor: { runOnce: async () => ({ status: "idle" as const }) },
      inbox: new A2AInbox(),
      runId: "run-1",
      maxPendingActivations,
    })).toThrow(/maxPendingActivations/);
  });

  it.each([0, 65])("rejects an invalid per-activation task bound (%s)", (maxTasksPerActivation) => {
    expect(() => new WorkerLaneScheduler({
      executor: { runOnce: async () => ({ status: "idle" as const }) },
      inbox: new A2AInbox(),
      runId: "run-1",
      maxTasksPerActivation,
    })).toThrow(/maxTasksPerActivation/);
  });
});

function workerResultMessage(): A2AMessage {
  return {
    messageId: "worker-result-1",
    runId: "run-1",
    conversationId: "run-1",
    threadId: "run-1:main",
    from: "worker",
    to: "main",
    createdAt: "2026-08-27T12:00:00.000Z",
    correlationId: "run-1",
    idempotencyKey: "worker-result-1",
    visibility: "run",
    priority: 1,
    delivery: "next-step",
    payload: {
      type: "task.result",
      taskId: "task-1",
      status: "completed",
      summary: "done",
      evidenceRefs: [],
      artifactRefs: [],
      openQuestions: [],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    },
  };
}

async function setupClaimedWorkerTask(): Promise<{
  inbox: A2AInbox;
  runs: { count: number };
  scheduler: WorkerLaneScheduler;
}> {
  const ledger = new MemoryLedger();
  const original = new A2AInbox({ sink: ledger, claimLeaseMs: 1_000 });
  await original.send(workerRequestMessage());
  await original.claim("worker", "worker", { claimId: "crashed-worker" });
  const inbox = A2AInbox.rehydrate(await ledger.read({ runId: "run-1" }), {
    sink: ledger,
    claimLeaseMs: 1_000,
  });
  const runs = { count: 0 };
  const scheduler = new WorkerLaneScheduler({
    executor: {
      runOnce: async () => {
        runs.count += 1;
        const [record] = await inbox.claim("worker", "worker", {
          claimId: `recovered-worker-${runs.count}`,
          limit: 1,
          types: ["task.request"],
        });
        if (record === undefined) return { status: "idle" as const };
        await inbox.handle(record.message.messageId, "worker");
        return { status: "completed" as const };
      },
    },
    inbox,
    runId: "run-1",
    maxTasksPerActivation: 1,
  });
  return { inbox, runs, scheduler };
}

function workerRequestMessage(): A2AMessage {
  return {
    messageId: "worker-request-1",
    runId: "run-1",
    conversationId: "run-1",
    threadId: "run-1:worker",
    from: "main",
    to: "worker",
    createdAt: "2026-08-27T12:00:00.000Z",
    correlationId: "run-1",
    idempotencyKey: "worker-request-1",
    visibility: "run",
    priority: 1,
    delivery: "next-step",
    payload: {
      type: "task.request",
      taskId: "task-1",
      goal,
      inputRefs: [],
      budget: { maxModelTokens: 500, maxWallClockMs: 5_000 },
    },
  };
}
