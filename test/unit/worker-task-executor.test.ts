import { describe, expect, it } from "vitest";

import { A2AInbox } from "../../src/a2a/index.js";
import type {
  A2AMessage,
  ArtifactRef,
  Goal,
  ModelPort,
  ModelRequest,
  ModelResponse,
} from "../../src/domain/index.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import {
  WorkerTaskExecutor,
  WorkerTaskTimeoutError,
} from "../../src/runtime/index.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

const goal: Goal = {
  version: 1,
  statement: "Identify the installation command",
  successCriteria: ["Return the command with evidence"],
  hardConstraints: ["Do not modify files"],
};

function taskMessage(
  inputRefs: ArtifactRef[],
  budget: { maxModelTokens: number; maxWallClockMs: number } = {
    maxModelTokens: 500,
    maxWallClockMs: 5_000,
  },
): A2AMessage {
  return {
    messageId: "task-message-1",
    runId: "run-1",
    conversationId: "conversation-1",
    threadId: "thread-1",
    from: "main",
    to: "worker-1",
    createdAt: "2026-08-27T12:00:00.000Z",
    correlationId: "task-correlation-1",
    idempotencyKey: "task-send-1",
    visibility: "run",
    priority: 5,
    delivery: "next-step",
    payload: {
      type: "task.request",
      taskId: "task-1",
      goal,
      inputRefs,
      budget,
    },
  };
}

async function setup(
  model: ModelPort,
  input = "npm install",
  budget?: { maxModelTokens: number; maxWallClockMs: number },
) {
  const ledger = new MemoryLedger();
  const store = new MemoryContentAddressedStore();
  const inputRef = await store.put(input, "text/plain");
  const inbox = new A2AInbox({ sink: ledger });
  await inbox.send(taskMessage([inputRef], budget));
  let idSequence = 0;
  const executor = new WorkerTaskExecutor({
    inbox,
    eventSink: ledger,
    store,
    model,
    modelName: "scripted/worker",
    runId: "run-1",
    workerLaneId: "worker-1",
    createId: () => `fixed-id-${++idSequence}`,
    readWatermark: () => ledger.watermark(),
  });
  return { ledger, store, inbox, executor, inputRef };
}

describe("WorkerTaskExecutor", () => {
  it("executes one bounded handoff and returns artifact evidence", async () => {
    const model = new ScriptedModel([(_request: ModelRequest): ModelResponse => ({
      content: "Run `npm install`.",
      toolCalls: [],
      stopReason: "stop",
      usage: { input: 40, output: 8, cacheRead: 0, cacheWrite: 0 },
    })]);
    const { executor, inbox, ledger, inputRef } = await setup(model);

    await expect(executor.runOnce()).resolves.toMatchObject({
      status: "completed",
      taskId: "task-1",
      requestMessageId: "task-message-1",
    });

    const records = inbox.snapshot().records;
    expect(records.find((record) => record.message.messageId === "task-message-1"))
      .toMatchObject({ status: "handled" });
    const replies = records
      .filter((record) => record.message.parentId === "task-message-1")
      .map((record) => record.message.payload.type);
    expect(replies).toEqual(["task.accept", "task.result"]);

    const events = await ledger.read({ runId: "run-1" });
    expect(events.map((event) => event.type)).toEqual([
      "message.sent",
      "message.claimed",
      "message.sent",
      "model.requested",
      "model.completed",
      "assistant.message",
      "budget.charged",
      "message.sent",
      "message.handled",
    ]);
    const request = model.requests[0]!;
    expect(request.messages[0]?.content).toContain(inputRef.contentHash);
    expect(request.messages[0]?.content).toContain("npm install");
    expect(request.maxOutputTokens).toBe(500);
    await expect(executor.runOnce()).resolves.toEqual({ status: "idle" });
  });

  it("returns task.failed when reported usage exceeds the task token budget", async () => {
    const model = new ScriptedModel([{
      content: "Too much output",
      toolCalls: [],
      stopReason: "stop",
      usage: { input: 8, output: 4, cacheRead: 0, cacheWrite: 0 },
    }]);
    const { executor, inbox } = await setup(model, "input", {
      maxModelTokens: 10,
      maxWallClockMs: 5_000,
    });

    await expect(executor.runOnce()).resolves.toMatchObject({
      status: "failed",
      taskId: "task-1",
      reason: expect.stringContaining("token budget exceeded"),
    });
    expect(inbox.snapshot().records.map((record) => record.message.payload.type))
      .toEqual(["task.request", "task.accept", "task.failed"]);
    const failure = inbox.snapshot().records.find((record) => (
      record.message.payload.type === "task.failed"
    ));
    expect(failure?.message.payload).toMatchObject({
      taskId: "task-1",
      retryable: false,
    });
  });

  it("fails a task when the wall-clock budget expires", async () => {
    class SlowModel implements ModelPort {
      async complete(request: ModelRequest): Promise<ModelResponse> {
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (request.signal?.aborted) {
          throw request.signal.reason instanceof Error
            ? request.signal.reason
            : new WorkerTaskTimeoutError("aborted");
        }
        return {
          content: "late",
          toolCalls: [],
          stopReason: "stop",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        };
      }
    }
    const { executor, inbox } = await setup(new SlowModel(), "input", {
      maxModelTokens: 100,
      maxWallClockMs: 5,
    });

    await expect(executor.runOnce()).resolves.toMatchObject({
      status: "failed",
      taskId: "task-1",
      reason: expect.stringContaining("wall-clock budget"),
    });
    const failure = inbox.snapshot().records.find((record) => (
      record.message.payload.type === "task.failed"
    ));
    expect(failure?.message.payload).toMatchObject({
      taskId: "task-1",
      retryable: true,
    });
  });

  it("cancels an in-flight model on stop and ignores its late response", async () => {
    let resolveModel: ((response: ModelResponse) => void) | undefined;
    const model: ModelPort = {
      complete: async () => new Promise<ModelResponse>((resolve) => {
        resolveModel = resolve;
      }),
    };
    const { executor, inbox, ledger } = await setup(model, "input", {
      maxModelTokens: 100,
      maxWallClockMs: 5_000,
    });

    const running = executor.runOnce();
    for (let attempt = 0; attempt < 20 && resolveModel === undefined; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(resolveModel).toBeTypeOf("function");

    await expect(executor.stop()).resolves.toBeUndefined();
    await expect(running).resolves.toEqual({ status: "idle", reason: "stopped" });
    const beforeLateResponse = await ledger.read({ runId: "run-1" });
    expect(beforeLateResponse.map((event) => event.type)).toEqual([
      "message.sent",
      "message.claimed",
      "message.sent",
      "model.requested",
    ]);
    expect(inbox.snapshot().records.some((record) => (
      record.message.payload.type === "task.result"
        || record.message.payload.type === "task.failed"
    ))).toBe(false);

    resolveModel?.({
      content: "late response",
      toolCalls: [],
      stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await ledger.read({ runId: "run-1" })).toEqual(beforeLateResponse);
    expect(inbox.snapshot().records[0]?.status).toBe("claimed");
    await expect(executor.runOnce()).resolves.toEqual({ status: "idle", reason: "stopped" });
  });
});
