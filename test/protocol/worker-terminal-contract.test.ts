import { describe, expect, it } from "vitest";

import { A2AInbox } from "../../src/a2a/index.js";
import type { EventSink } from "../../src/a2a/index.js";
import type {
  A2AMessage,
  AgentTool,
  AnyEvent,
  AppendEvent,
  Clock,
  EventType,
  ModelPort,
  ModelResponse,
  TaskResult,
  ToolCall,
} from "../../src/domain/index.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import type { MoweAgentTool, MoweToolMetadata } from "../../src/mowe/types.js";
import { ScriptedModel } from "../../src/model/index.js";
import { ProviderModelError } from "../../src/model/provider-error.js";
import { RunTokenBudget, WorkerTaskExecutor } from "../../src/runtime/index.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";
import type { ContentAddressedStore } from "../../src/store/index.js";

type AnyAppendEvent = { [K in EventType]: AppendEvent<K> }[EventType];

describe("Worker terminal boundaries", () => {
  it.each([
    { concurrencySafe: false },
    { concurrencySafe: true, maxConcurrency: 1 },
  ])("honors per-tool concurrency declarations: %j", async (metadata) => {
    const entered = deferred();
    const release = deferred();
    let active = 0;
    let maximum = 0;
    const tool = readTool(async (arguments_) => {
      active += 1;
      maximum = Math.max(maximum, active);
      if (arguments_.index === 0) {
        entered.resolve();
        await release.promise;
      }
      active -= 1;
      return { content: `read ${arguments_.index}`, isError: false };
    }, metadata);
    const model = new ScriptedModel([response(calls()), response()]);
    const fixture = await setup({ model, tools: [tool] });

    const running = fixture.executor.runOnce();
    await entered.promise;
    await nextTick();
    release.resolve();
    await expect(running).resolves.toMatchObject({ status: "completed" });
    expect(maximum).toBe(1);
    expect(model.requests[1]?.messages.filter((message) => message.role === "tool")
      .map((message) => message.toolCallId)).toEqual(["first", "second"]);
  });

  it("persists fast tools immediately while preserving source order for the model", async () => {
    const entered = deferred();
    const release = deferred();
    const secondPersisted = deferred();
    const tool = readTool(async (arguments_) => {
      if (arguments_.index === 0) {
        entered.resolve();
        await release.promise;
      }
      return { content: `read ${arguments_.index}`, isError: false };
    });
    const model = new ScriptedModel([response(calls()), response()]);
    const fixture = await setup({
      model,
      tools: [tool],
      afterAppend: (event) => {
        if (event.type === "tool.succeeded" && event.payload.toolCallId === "second") {
          secondPersisted.resolve();
        }
      },
    });

    const running = fixture.executor.runOnce();
    await entered.promise;
    await secondPersisted.promise;
    const intermediate = await fixture.ledger.read();
    release.resolve();
    await expect(running).resolves.toMatchObject({ status: "completed" });
    expect(toolTerminals(intermediate).map((event) => event.payload.toolCallId)).toEqual(["second"]);
    expect(toolTerminals(await fixture.ledger.read()).map((event) => event.payload.toolCallId))
      .toEqual(["second", "first"]);
    expect(model.requests[1]?.messages.filter((message) => message.role === "tool")
      .map((message) => message.toolCallId)).toEqual(["first", "second"]);
  });

  it.each([false, true])("cancels and drains peers after result storage fails (stop=%s)", async (stop) => {
    const secondEntered = deferred();
    const storageFailed = deferred();
    const releaseCleanup = deferred();
    let cancelled = false;
    let cleaned = false;
    const tool = readTool(async (arguments_, context) => {
      if (arguments_.index === 0) {
        await secondEntered.promise;
        return { content: "first result", isError: false };
      }
      const onAbort = (): void => { cancelled = true; };
      context.signal?.addEventListener("abort", onAbort, { once: true });
      secondEntered.resolve();
      await releaseCleanup.promise;
      context.signal?.removeEventListener("abort", onAbort);
      cleaned = true;
      return { content: "second result after cleanup", isError: false };
    });
    const backingStore = new MemoryContentAddressedStore();
    const store: ContentAddressedStore = {
      get: (ref) => backingStore.get(ref),
      has: (ref) => backingStore.has(ref),
      async put(data, mediaType) {
        if (typeof data === "string" && mediaType?.includes("conversation-message")) {
          const message = JSON.parse(data) as { role: string; toolCallId?: string };
          if (message.role === "tool" && message.toolCallId === "first") {
            storageFailed.resolve();
            throw new Error("injected tool result storage failure");
          }
        }
        return backingStore.put(data, mediaType);
      },
    };
    const fixture = await setup({
      model: new ScriptedModel([response(calls())]),
      tools: [tool],
      store,
    });
    let taskSettled = false;
    const running = fixture.executor.runOnce().then((result) => {
      taskSettled = true;
      return result;
    });
    await storageFailed.promise;
    await nextTick();
    let stopSettled = false;
    const stopping = stop
      ? fixture.executor.stop().then(() => { stopSettled = true; })
      : Promise.resolve();
    await nextTick();
    const beforeCleanup = { cancelled, cleaned, taskSettled, stopSettled };
    const beforeEvents = await fixture.ledger.read();
    releaseCleanup.resolve();
    const result = await running;
    await stopping;

    expect(beforeCleanup).toEqual({
      cancelled: true, cleaned: false, taskSettled: false, stopSettled: false,
    });
    expect(beforeEvents.some((event) => event.type === "message.sent"
      && (event.payload.message.payload.type === "task.result"
        || event.payload.message.payload.type === "task.failed"))).toBe(false);
    expect(cleaned).toBe(true);
    expect(result).toMatchObject(stop
      ? { status: "idle", reason: "stopped" }
      : { status: "failed", reason: "injected tool result storage failure" });
    const settledEvents = await fixture.ledger.read();
    expect(toolTerminals(settledEvents).map((event) => event.payload.toolCallId)).toEqual(["second"]);
    await nextTick();
    expect(await fixture.ledger.read()).toEqual(settledEvents);
  });

  it.each([false, true])("charges failed provider usage once across recovery (fresh budget=%s)", async (freshBudget) => {
    const runTokenBudget = new RunTokenBudget(2_000);
    const model = new ScriptedModel([new ProviderModelError({
      category: "server",
      retryable: true,
      providerUsage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.001 },
    })]);
    let crash = true;
    const fixture = await setup({
      model,
      runTokenBudget,
      beforeAppend: (event) => {
        if (crash && event.type === "message.sent"
          && event.payload.message.payload.type === "task.failed") {
          crash = false;
          throw new Error("crash before failure reply");
        }
      },
    });
    await expect(fixture.executor.runOnce()).rejects.toThrow("crash before failure reply");
    expect(runTokenBudget.snapshot()).toMatchObject({
      usedTokens: 25,
      reservedTokens: 0,
      settlements: [{ actualTokens: 25 }],
    });
    const before = await fixture.ledger.read();
    const charged = before.filter((event) => event.type === "budget.charged");
    expect(charged).toHaveLength(1);
    expect(charged[0]?.payload.usage).toEqual({
      input: 20, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.001,
    });
    expect(before.findIndex((event) => event.type === "budget.charged"))
      .toBeLessThan(before.findIndex((event) => event.type === "model.failed"));

    fixture.advance();
    const recoveredBudget = freshBudget ? new RunTokenBudget(2_000, 25) : runTokenBudget;
    const recovered = fixture.recover(before, recoveredBudget);
    await expect(recovered.runOnce()).resolves.toMatchObject({
      status: "failed", reason: "Model provider failure (server)",
    });
    expect(model.requests).toHaveLength(1);
    expect((await fixture.ledger.read()).filter((event) => event.type === "budget.charged"))
      .toEqual(charged);
    expect(recoveredBudget.snapshot()).toMatchObject({ usedTokens: 25, reservedTokens: 0 });
  });

  it("keeps failed provider usage charged in memory when the charge write fails", async () => {
    const runTokenBudget = new RunTokenBudget(2_000);
    const fixture = await setup({
      runTokenBudget,
      model: new ScriptedModel([new ProviderModelError({
        category: "server",
        retryable: true,
        providerUsage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
      })]),
      beforeAppend: (event) => {
        if (event.type === "budget.charged") throw new Error("charge storage unavailable");
      },
    });
    await expect(fixture.executor.runOnce()).resolves.toMatchObject({
      status: "failed", reason: "charge storage unavailable",
    });
    expect(runTokenBudget.snapshot()).toMatchObject({ usedTokens: 25, reservedTokens: 0 });
    expect((await fixture.ledger.read()).filter((event) => event.type === "budget.charged"))
      .toEqual([]);
  });

  it.each([
    { input: 0.5, output: 5 },
    { input: Number.MAX_SAFE_INTEGER + 1, output: 5 },
    { input: Number.NaN, output: 5 },
    { input: Number.MAX_SAFE_INTEGER, output: 1 },
  ])(
    "does not persist invalid custom-provider usage (%j)",
    async ({ input, output }) => {
      const runTokenBudget = new RunTokenBudget(2_000);
      const error = Object.assign(new Error("custom provider failure"), {
        providerUsage: { input, output, cacheRead: 0, cacheWrite: 0 },
      });
      const fixture = await setup({
        runTokenBudget,
        model: new ScriptedModel([error]),
      });

      await expect(fixture.executor.runOnce()).resolves.toMatchObject({
        status: "failed", reason: "custom provider failure",
      });
      expect(runTokenBudget.snapshot()).toMatchObject({ usedTokens: 0, reservedTokens: 0 });
      expect((await fixture.ledger.read()).filter((event) => event.type === "budget.charged"))
        .toEqual([]);
    },
  );

  it("restores the same source-ordered tool evidence after a crash before task.result", async () => {
    const secondPersisted = deferred();
    let original: TaskResult | undefined;
    let crash = true;
    const model = new ScriptedModel([response(calls()), response()]);
    const fixture = await setup({
      model,
      tools: [readTool(async (arguments_) => {
        if (arguments_.index === 0) await secondPersisted.promise;
        return { content: `read ${arguments_.index}`, isError: arguments_.index === 1 };
      })],
      beforeAppend: (event) => {
        if (crash && event.type === "message.sent"
          && event.payload.message.payload.type === "task.result") {
          crash = false;
          original = structuredClone(event.payload.message.payload);
          throw new Error("crash before result reply");
        }
      },
      afterAppend: (event) => {
        if (event.type === "tool.failed" && event.payload.toolCallId === "second") {
          secondPersisted.resolve();
        }
      },
    });
    await expect(fixture.executor.runOnce()).rejects.toThrow("crash before result reply");
    const before = await fixture.ledger.read();
    const toolEvents = toolTerminals(before);
    expect(toolEvents.map((event) => event.payload.toolCallId)).toEqual(["second", "first"]);
    expect(original?.evidenceRefs.slice(1, 3)).toEqual([
      toolEvents[1]?.payload.resultRef?.contentHash,
      toolEvents[0]?.payload.resultRef?.contentHash,
    ]);

    fixture.advance();
    const recovered = fixture.recover(before);
    await expect(recovered.runOnce()).resolves.toMatchObject({ status: "completed" });
    expect(model.requests).toHaveLength(2);
    const results = (await fixture.ledger.read()).flatMap((event) => (
      event.type === "message.sent" && event.payload.message.payload.type === "task.result"
        ? [event.payload.message.payload]
        : []
    ));
    expect(results).toEqual([original]);
    expect(toolTerminals(await fixture.ledger.read())).toEqual(toolEvents);
  });
});

async function setup(options: {
  model: ModelPort;
  tools?: readonly AgentTool[];
  store?: ContentAddressedStore;
  runTokenBudget?: RunTokenBudget;
  beforeAppend?: (event: AnyAppendEvent) => void | Promise<void>;
  afterAppend?: (event: AnyEvent) => void | Promise<void>;
}) {
  let instant = Date.parse("2026-09-09T12:00:00.000Z");
  const clock: Clock = { now: () => new Date(instant) };
  const ledger = new MemoryLedger({ clock });
  const store = options.store ?? new MemoryContentAddressedStore();
  const sink: EventSink = {
    async append(event) {
      await options.beforeAppend?.(event as AnyAppendEvent);
      const committed = await ledger.append(event);
      await options.afterAppend?.(committed as AnyEvent);
      return committed;
    },
  };
  const inbox = new A2AInbox({ sink, clock, claimLeaseMs: 1_000 });
  const inputRef = await store.put("source evidence", "text/plain");
  const request: A2AMessage = {
    messageId: "worker-request",
    runId: "run-1",
    conversationId: "conversation-1",
    threadId: "thread-1",
    from: "main",
    to: "worker",
    createdAt: clock.now().toISOString(),
    correlationId: "correlation-1",
    idempotencyKey: "worker-request",
    visibility: "run",
    priority: 1,
    delivery: "next-step",
    payload: {
      type: "task.request",
      taskId: "task-1",
      goal: {
        version: 1,
        statement: "Read two pieces of evidence",
        successCriteria: ["Return the result with source references"],
        hardConstraints: [],
      },
      inputRefs: [inputRef],
      budget: { maxModelTokens: 2_000, maxWallClockMs: 30_000 },
    },
  };
  await inbox.send(request);
  let nextId = 0;
  const createExecutor = (activeInbox: A2AInbox, runTokenBudget?: RunTokenBudget): WorkerTaskExecutor => (
    new WorkerTaskExecutor({
      inbox: activeInbox,
      eventSink: sink,
      store,
      model: options.model,
      modelName: "scripted/worker",
      runId: "run-1",
      tools: options.tools ?? [],
      clock,
      createId: () => `claim-${++nextId}`,
      readEvents: () => ledger.read(),
      ...(runTokenBudget === undefined ? {} : { runTokenBudget }),
    })
  );
  return {
    ledger,
    executor: createExecutor(inbox, options.runTokenBudget),
    advance: () => { instant += 1_001; },
    recover: (events: AnyEvent[], runTokenBudget?: RunTokenBudget) => createExecutor(
      A2AInbox.rehydrate(events, { sink, clock, claimLeaseMs: 1_000 }),
      runTokenBudget,
    ),
  };
}

function readTool(execute: AgentTool["execute"], metadata: MoweToolMetadata = {
  concurrencySafe: true,
  maxConcurrency: 2,
}): MoweAgentTool {
  return {
    definition: {
      name: "read_file",
      description: "Read one source",
      parameters: {
        type: "object",
        properties: { index: { type: "integer" } },
        required: ["index"],
        additionalProperties: false,
      },
    },
    metadata: { effect: "read", ...metadata },
    execute,
  };
}

function calls(): ToolCall[] {
  return ["first", "second"].map((id, index) => ({
    id, name: "read_file", arguments: { index },
  }));
}

function response(toolCalls: ToolCall[] = []): ModelResponse {
  return {
    content: toolCalls.length > 0 ? "Read sources" : "Sources checked",
    toolCalls,
    stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
    usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
  };
}

function toolTerminals(events: AnyEvent[]) {
  return events.filter((event) => event.type === "tool.succeeded" || event.type === "tool.failed");
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
