import { describe, expect, it, vi } from "vitest";

import { A2AInbox } from "../../src/a2a/inbox.js";
import type { AgentTool, ModelResponse } from "../../src/domain/ports.js";
import type { Goal, RunPolicy } from "../../src/domain/types.js";
import { ContentStoreFukaiSource, FukaiContextProvider } from "../../src/fukai/index.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { ScriptedModel } from "../../src/model/scripted-model.js";
import { L0AgentLoop } from "../../src/runtime/l0-agent-loop.js";
import { MainLoop } from "../../src/runtime/main-loop.js";
import { RunTokenBudget } from "../../src/runtime/run-token-budget.js";
import { TaskDispatcher } from "../../src/runtime/task-dispatcher.js";
import { WorkerTaskExecutor } from "../../src/runtime/worker-task-executor.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

const goal: Goal = { version: 1, statement: "Inspect the supplied evidence", successCriteria: [], hardConstraints: [] };
const policy: RunPolicy = {
  maxMainStepsPerActivation: 2,
  maxModelTokens: 10_000,
  tetoEnabled: false,
  tetoMaxOutputTokens: 512,
  workerEnabled: false,
};
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
const clock = { now: () => new Date("2026-09-07T08:00:00.000Z") };

function setup(withToolCalls: boolean) {
  const execute = vi.fn(async () => ({ content: "must not execute", isError: false }));
  const tool: AgentTool = {
    definition: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: {}, additionalProperties: false } },
    execute,
  };
  const aborted: ModelResponse = {
    content: "Partial response",
    stopReason: "aborted",
    usage,
    toolCalls: withToolCalls ? [{ id: "aborted-read", name: "read_file", arguments: {} }] : [],
  };
  const model = new ScriptedModel([aborted, {
    content: "Explicitly resumed",
    stopReason: "stop",
    usage,
    toolCalls: [],
  }]);
  const ledger = new MemoryLedger({ clock });
  const store = new MemoryContentAddressedStore();
  const runTokenBudget = new RunTokenBudget(10_000);
  return { execute, tool, model, ledger, store, runTokenBudget };
}

describe("provider-aborted response parity", () => {
  it.each([false, true])("ends L0 without executing tools or continuing (tool calls: %s)", async (withToolCalls) => {
    const { model, tool, execute } = setup(withToolCalls);
    const loop = new L0AgentLoop({ model, tools: [tool] });
    const result = await loop.run({
      request: { runId: "run-1", laneId: "main", sessionId: "run-1", model: "scripted", systemPrompt: "Inspect evidence", maxOutputTokens: 512 },
      messages: [],
      workspace: process.cwd(),
      maxSteps: 2,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ completed: false, aborted: true, stopReason: "aborted", steps: 1 });
    expect(model.requests).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([false, true])("ends Main without executing tools or continuing (tool calls: %s)", async (withToolCalls) => {
    const { model, ledger, store, tool, execute, runTokenBudget } = setup(withToolCalls);
    const signal = new AbortController().signal;
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [tool],
      runTokenBudget,
      clock,
      includeProjectInstructions: false,
    });
    const result = await loop.run({
      runId: "run-1", goal, model: "scripted", workspace: process.cwd(), policy,
      initialMessage: "Inspect evidence", signal, includeProjectInstructions: false,
    });
    expect(signal.aborted).toBe(false);
    expect(result).toMatchObject({ completed: false, stopReason: "aborted", steps: 1, usage });
    expect(model.requests).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
    expect(runTokenBudget.snapshot()).toMatchObject({ usedTokens: 15, reservedTokens: 0 });
    const events = await ledger.read({ runId: "run-1" });
    expect(events.filter((event) => event.type === "step.completed")).toHaveLength(1);
    expect(events.some((event) => event.type === "tool.admitted" || event.type === "tool.started" || event.type === "run.completed")).toBe(false);
    expect(events.filter((event) => event.type === "tool.failed")).toHaveLength(withToolCalls ? 1 : 0);
  });

  it("retains paired rejected tool results when Main explicitly resumes", async () => {
    const { model, ledger, store, tool, execute } = setup(true);
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [tool],
      clock,
      includeProjectInstructions: false,
    });
    const input = { runId: "run-1", goal, model: "scripted", workspace: process.cwd(), policy, includeProjectInstructions: false };
    const first = await loop.run({ ...input, initialMessage: "Inspect evidence" });
    expect(first.completed).toBe(false);
    expect(model.requests).toHaveLength(1);

    const resumed = await loop.run({
      ...input,
      startStep: 2,
      conversationRefs: first.conversationRefs,
      upperWatermark: await ledger.watermark(),
    });
    expect(resumed).toMatchObject({ completed: true, finalText: "Explicitly resumed" });
    expect(execute).not.toHaveBeenCalled();
    const messages = model.requests[1]!.messages;
    const assistantIndex = messages.findIndex((message) => message.role === "assistant" && message.toolCalls?.[0]?.id === "aborted-read");
    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    expect(messages[assistantIndex + 1]).toMatchObject({
      role: "tool", toolCallId: "aborted-read", isError: true, content: expect.stringContaining("provider aborted"),
    });
  });

  it.each([false, true])("settles Worker as partial without executing tools or continuing (tool calls: %s)", async (withToolCalls) => {
    const { model, ledger, store, tool, execute, runTokenBudget } = setup(withToolCalls);
    const inbox = new A2AInbox({ sink: ledger, clock });
    const dispatcher = new TaskDispatcher({ inbox, runId: "run-1", to: "worker-1", clock });
    await dispatcher.dispatch({ taskId: "task-1", goal, inputRefs: [], budget: { maxModelTokens: 10_000, maxWallClockMs: 10_000, maxAttempts: 2 } });
    const signal = new AbortController().signal;
    const executor = new WorkerTaskExecutor({
      inbox, eventSink: ledger, store, model, modelName: "scripted", runId: "run-1", workerLaneId: "worker-1",
      workspace: process.cwd(), tools: [tool], runTokenBudget, signal, clock,
      readEvents: () => ledger.read({ runId: "run-1" }), readWatermark: () => ledger.watermark(),
    });
    try {
      expect(await executor.runOnce()).toMatchObject({ status: "partial", taskId: "task-1", usage });
      expect(signal.aborted).toBe(false);
      expect(model.requests).toHaveLength(1);
      expect(execute).not.toHaveBeenCalled();
      expect(runTokenBudget.snapshot()).toMatchObject({ usedTokens: 15, reservedTokens: 0 });
      const events = await ledger.read({ runId: "run-1" });
      expect(events.some((event) => event.type === "tool.admitted" || event.type === "tool.started")).toBe(false);
      expect(events.filter((event) => event.type === "tool.failed")).toHaveLength(withToolCalls ? 1 : 0);
      const terminal = inbox.snapshot().records.find((record) => record.message.payload.type === "task.result");
      expect(terminal?.message.payload).toMatchObject({ status: "partial", openQuestions: [expect.stringContaining("provider aborted")] });
      expect(await executor.runOnce()).toMatchObject({ status: "idle" });
      expect(model.requests).toHaveLength(1);
    } finally {
      await executor.stop();
    }
  });
});
