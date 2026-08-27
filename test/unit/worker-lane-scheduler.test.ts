import { describe, expect, it } from "vitest";

import { A2AInbox } from "../../src/a2a/index.js";
import type { Goal, ModelPort, ModelRequest, ModelResponse } from "../../src/domain/index.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import { TaskDispatcher, WorkerLaneScheduler, WorkerTaskExecutor } from "../../src/runtime/index.js";
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
});
