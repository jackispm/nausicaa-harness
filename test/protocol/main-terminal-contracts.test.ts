import { describe, expect, it, vi } from "vitest";

import type { EventPayloadMap, EventType } from "../../src/domain/events.js";
import type { AgentTool, ModelPort, ModelResponse, ModelStreamEvent } from "../../src/domain/ports.js";
import type { ArtifactRef, ConversationMessage } from "../../src/domain/types.js";
import { ContentStoreFukaiSource, FukaiContextProvider } from "../../src/fukai/index.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import type { MoweAgentTool } from "../../src/mowe/index.js";
import {
  MainLoop,
  type MainEventSink,
  type MainLoopDeps,
  type MainLoopInput,
} from "../../src/runtime/main-loop.js";
import {
  projectMainExecutionRecovery,
  recoverLaneConversationRefs,
  recoverRun,
} from "../../src/runtime/recovery.js";
import { pendingToolOperations } from "../../src/runtime/tool-operation-recovery.js";
import { RunTokenBudget } from "../../src/runtime/run-token-budget.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

describe("Main completion admission", () => {
  it.each([
    ["run", false], ["turn", false], ["none", false],
    ["run", true], ["turn", true], ["none", true],
  ] as const)("cancels %s completion after awaiting the host (deferred=%s)", async (completionMode, defer) => {
    const entered = gate();
    const release = gate();
    const controller = new AbortController();
    const cancellation = new Error("cancel during final bookkeeping");
    const fixture = setup([response("done")], {
      beforeCompletion: async () => {
        entered.resolve();
        await release.promise;
        return defer;
      },
    });
    const outcome = fixture.loop.run({
      ...input("cancel-completion"),
      completionMode,
      ...(completionMode === "turn" ? { turnId: "turn-1" } : {}),
      signal: controller.signal,
    }).catch((error: unknown) => error);

    await entered.promise;
    controller.abort(cancellation);
    release.resolve();

    expect(await outcome).toBe(cancellation);
    expect(fixture.model.callCount).toBe(1);
    const events = await fixture.ledger.read();
    expect(events.filter((event) => event.type === "step.completed")).toHaveLength(1);
    expect(events.some((event) => (
      event.type === "run.completed" || event.type === "turn.completed" || event.type === "step.failed"
    ))).toBe(false);
  });

  it.each(["run", "turn"] as const)("honors an admitted %s completion if abort arrives during its append", async (completionMode) => {
    const ledger = new MemoryLedger();
    const entered = gate();
    const release = gate();
    const controller = new AbortController();
    const sink: MainEventSink = {
      async append(event) {
        if (event.type === "run.completed" || event.type === "turn.completed") {
          entered.resolve();
          await release.promise;
        }
        return ledger.append(event);
      },
    };
    const fixture = setup([response("done")], { eventSink: sink }, ledger);
    const outcome = fixture.loop.run({
      ...input("admitted-completion"),
      completionMode,
      ...(completionMode === "turn" ? { turnId: "turn-1" } : {}),
      signal: controller.signal,
    });

    await entered.promise;
    controller.abort(new Error("cancel after completion admission"));
    release.resolve();

    await expect(outcome).resolves.toMatchObject({ completed: true, finalText: "done" });
    expect((await ledger.read()).filter((event) => (
      event.type === "run.completed" || event.type === "turn.completed"
    ))).toHaveLength(1);
  });

  it("checks cancellation from afterStepAsync even without a beforeCompletion hook", async () => {
    const controller = new AbortController();
    const cancellation = new Error("cancel at committed step boundary");
    const fixture = setup([response("done")], {
      afterStepAsync: async () => { controller.abort(cancellation); },
    });

    await expect(fixture.loop.run({
      ...input("cancel-after-step"),
      signal: controller.signal,
    })).rejects.toBe(cancellation);
    expect((await fixture.ledger.read()).some((event) => event.type === "run.completed")).toBe(false);
  });
});

describe("Main provider response admission", () => {
  it.each([
    { field: "stopReason", invalid: { stopReason: " \t" } },
    { field: "toolCalls", invalid: { toolCalls: undefined } },
    { field: "usage total", invalid: { usage: { input: Number.MAX_SAFE_INTEGER, output: 1, cacheRead: 0, cacheWrite: 0 } } },
    { field: "non-JSON arguments", invalid: { toolCalls: [
      { id: "invalid", name: "read_file", arguments: { value: 1n } },
    ] } },
    { field: "non-cloneable arguments", invalid: { toolCalls: [
      { id: "invalid", name: "read_file", arguments: { value: () => "not JSON" } },
    ] } },
    { field: "non-plain arguments", invalid: { toolCalls: [
      { id: "invalid", name: "read_file", arguments: { value: new Map() } },
    ] } },
    { field: "id", invalid: { toolCalls: [
      { id: "valid", name: "read_file", arguments: {} },
      { id: " \t", name: "read_file", arguments: {} },
    ] } },
    { field: "name", invalid: { toolCalls: [
      { id: "valid", name: "read_file", arguments: {} },
      { id: "invalid", name: " \t", arguments: {} },
    ] } },
  ])("rejects invalid $field before billing, persistence, or tool execution", async ({ invalid }) => {
    const execute = vi.fn(async () => ({ content: "read", isError: false }));
    const runTokenBudget = new RunTokenBudget(100_000);
    const untrusted = { ...response("untrusted provider content", ["read_file"]), ...invalid };
    const model: ModelPort = { complete: async () => untrusted as ModelResponse };
    const fixture = setup([], { model, runTokenBudget, tools: [tool("read_file", execute)] });
    const writes = vi.spyOn(fixture.store, "put");

    await expect(fixture.loop.run(input("invalid-response"))).rejects.toThrow();

    const events = await fixture.ledger.read();
    expect(events.filter((event) => event.type.startsWith("model.")).map((event) => event.type))
      .toEqual(["model.requested", "model.failed"]);
    expect(events.some((event) => event.type === "budget.charged"
      || event.type === "assistant.message" || event.type.startsWith("tool."))).toBe(false);
    expect(writes.mock.calls.some(([data]) => typeof data === "string"
      && data.includes("untrusted provider content"))).toBe(false);
    expect(runTokenBudget.snapshot()).toMatchObject({ usedTokens: 0, reservedTokens: 0 });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { type: "unexpected-provider-event", delta: "invalid stream text" },
    { type: "done", response: { ...response("untrusted provider content", ["read_file"]), toolCalls: undefined } },
  ])("records model.failed for a malformed stream envelope ($type)", async (invalid) => {
    const execute = vi.fn(async () => ({ content: "read", isError: false }));
    let closed = false;
    const model: ModelPort = {
      complete: vi.fn(async () => response("complete must not be selected")),
      async *stream() {
        try {
          yield { type: "text-delta", delta: "partial stream" };
          yield invalid as unknown as ModelStreamEvent;
          yield { type: "done", response: response("must not reach completion", ["read_file"]) };
        } finally {
          closed = true;
        }
      },
    };
    const fixture = setup([], { model, tools: [tool("read_file", execute)], onStreamEvent: () => {} });
    const writes = vi.spyOn(fixture.store, "put");

    await expect(fixture.loop.run(input("invalid-stream"))).rejects.toThrow();

    expect(model.complete).not.toHaveBeenCalled();
    const events = await fixture.ledger.read();
    expect(events.filter((event) => event.type.startsWith("model.")).map((event) => event.type))
      .toEqual(["model.requested", "model.failed"]);
    expect(events.some((event) => event.type === "budget.charged"
      || event.type === "assistant.message" || event.type.startsWith("tool."))).toBe(false);
    expect(writes.mock.calls.some(([data]) => typeof data === "string"
      && data.includes("untrusted provider content"))).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(true);
  });
});

describe("Main tool result durability", () => {
  it("persists a successful write while a sibling read waits and preserves call order after replay", async () => {
    const readStarted = gate();
    const releaseRead = gate();
    let writeCount = 0;
    let settled = false;
    const fixture = setup([
      response("inspect and write", ["slow_read", "fast_write"]),
      response("done"),
    ], {
      tools: [
        tool("slow_read", async () => {
          readStarted.resolve();
          await releaseRead.promise;
          return { content: "read complete", isError: false };
        }),
        tool("fast_write", async () => {
          await readStarted.promise;
          writeCount += 1;
          return { content: "write complete", isError: false };
        }, "write"),
      ],
    });
    const runInput = input("durable-parallel-tools");
    await fixture.ledger.append({
      runId: runInput.runId,
      laneId: "main",
      type: "run.created",
      payload: { goal: runInput.goal, policy: runInput.policy, workspace: runInput.workspace },
      correlationId: "create",
      idempotencyKey: "created",
    });
    const outcome = fixture.loop.run(runInput).finally(() => { settled = true; });

    try {
      await vi.waitFor(async () => {
        const events = await fixture.ledger.read();
        expect(events.some((event) => (
          event.type === "tool.succeeded" && event.payload.name === "fast_write"
        ))).toBe(true);
      });
      expect(writeCount).toBe(1);
      expect(settled).toBe(false);
      const snapshot = await fixture.ledger.read();
      const pending = pendingToolOperations(snapshot);
      expect(pending.map((operation) => operation.request.payload.name)).toEqual(["slow_read"]);
      await expect(recoverRun(fixture.ledger, runInput.runId, { mode: "inspect" })).rejects.toMatchObject({
        operationIds: [pending[0]!.request.payload.operationId],
      });
      const recoveredWhilePending = projectMainExecutionRecovery(snapshot);
      expect((await readMessages(fixture.store, recoveredWhilePending.conversationRefs.map((item) => item.ref)))
        .filter((message) => message.role === "tool")
        .map((message) => message.toolName)).toEqual(["fast_write"]);
    } finally {
      releaseRead.resolve();
      await outcome;
    }

    const events = await fixture.ledger.read();
    expect(events.filter((event) => event.type === "tool.succeeded")
      .map((event) => event.type === "tool.succeeded" ? event.payload.name : undefined))
      .toEqual(["fast_write", "slow_read"]);
    expect(fixture.model.requests[1]?.messages.filter((message) => message.role === "tool")
      .map((message) => message.toolName)).toEqual(["slow_read", "fast_write"]);
    const recovered = await recoverRun(fixture.ledger, runInput.runId, { mode: "inspect" });
    expect((await readMessages(fixture.store, recovered.conversationRefs.map((item) => item.ref)))
      .filter((message) => message.role === "tool")
      .map((message) => message.toolName)).toEqual(["slow_read", "fast_write"]);
    expect(pendingToolOperations(events)).toEqual([]);
  });

  it("cancels and drains siblings before surfacing a terminal persistence failure", async () => {
    const ledger = new MemoryLedger();
    const slowStarted = gate();
    const slowCancelled = gate();
    const releaseCleanup = gate();
    const storageFailure = new Error("tool terminal storage failed");
    let cleaned = false;
    let settled = false;
    const sink: MainEventSink = {
      async append(event) {
        if (event.type === "tool.succeeded" && "name" in event.payload && event.payload.name === "cannot_persist") {
          throw storageFailure;
        }
        return ledger.append(event);
      },
    };
    const fixture = setup([response("run both", ["cannot_persist", "slow_read"])], {
      eventSink: sink,
      tools: [
        tool("cannot_persist", async () => {
          await slowStarted.promise;
          return { content: "result", isError: false };
        }),
        tool("slow_read", async (_arguments, context) => {
          context.signal!.addEventListener("abort", () => slowCancelled.resolve(), { once: true });
          slowStarted.resolve();
          await releaseCleanup.promise;
          cleaned = true;
          return { content: "read cleanup complete", isError: false };
        }),
      ],
    }, ledger);
    const outcome = fixture.loop.run(input("failed-terminal-write"))
      .catch((error: unknown) => error)
      .finally(() => { settled = true; });
    try {
      await slowCancelled.promise;
      expect(settled).toBe(false);
      expect(cleaned).toBe(false);
    } finally {
      releaseCleanup.resolve();
    }

    expect(await outcome).toBe(storageFailure);
    expect(cleaned).toBe(true);
    const events = await ledger.read();
    expect(events.some((event) => (
      (event.type === "tool.failed" || event.type === "tool.succeeded")
      && event.payload.name === "slow_read"
    ))).toBe(true);
    expect(pendingToolOperations(events).map((operation) => operation.request.payload.name))
      .toEqual(["cannot_persist"]);
    expect(events.at(-1)?.type).toBe("step.failed");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await ledger.read()).toEqual(events);
  });

  it("reconstructs ordered results across turns, scoped operation IDs, and legacy terminal-only facts", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    let sequence = 0;
    const append = async <K extends EventType>(type: K, payload: EventPayloadMap[K], runId = "replay", turnId = "one") => {
      await ledger.append({
        runId, laneId: "main", turnId, type, payload,
        correlationId: "replay",
        idempotencyKey: `event:${++sequence}`,
      });
    };
    const messageRef = (content: string) => store.put(JSON.stringify({ content }), "application/json");
    const request = async (operationId: string, runId = "replay", turnId = "one") => append("tool.requested", {
      operationId, toolCallId: "reused-call-id", name: "read", argumentsRef: await messageRef("{}"),
    }, runId, turnId);
    const terminal = async (operationId: string, content: string, runId = "replay", turnId = "one") => append("tool.succeeded", {
      operationId, toolCallId: "reused-call-id", name: "read", resultRef: await messageRef(content),
    }, runId, turnId);

    await append("assistant.message", { messageRef: await messageRef("turn one") });
    await request("shared-operation");
    await request("second-operation");
    await request("shared-operation", "other-run");
    await terminal("second-operation", "second result");
    await terminal("shared-operation", "other run result", "other-run");
    await terminal("shared-operation", "first result");
    await append("assistant.message", { messageRef: await messageRef("turn two") }, "replay", "two");
    await request("third-operation", "replay", "two");
    await request("fourth-operation", "replay", "two");
    await terminal("fourth-operation", "fourth result", "replay", "two");
    await terminal("third-operation", "third result", "replay", "two");
    await terminal("legacy-operation", "legacy result", "replay", "two");

    const refs = recoverLaneConversationRefs(await ledger.read());
    expect((await readMessages(store, refs.map((item) => item.ref))).map((message) => message.content)).toEqual([
      "turn one", "first result", "second result", "other run result",
      "turn two", "third result", "fourth result", "legacy result",
    ]);
  });
});

function setup(responses: ModelResponse[], overrides: Partial<MainLoopDeps> = {}, ledger = new MemoryLedger()) {
  const store = new MemoryContentAddressedStore();
  const model = new ScriptedModel(responses);
  const loop = new MainLoop({
    model,
    contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
    conversationStore: store,
    eventSink: ledger,
    includeProjectInstructions: false,
    tools: [],
    ...overrides,
  });
  return { loop, store, model, ledger };
}

function input(runId: string): MainLoopInput {
  return {
    runId,
    activeObjective: "Inspect and report",
    model: "scripted",
    workspace: process.cwd(),
    goal: { version: 1, statement: "Inspect", successCriteria: [], hardConstraints: [] },
    policy: { maxMainSteps: 2, maxModelTokens: 10_000, tetoEnabled: false, tetoMaxOutputTokens: 128, tetoTokenRatio: 0.1 },
    initialMessage: "Inspect and report",
  };
}

function response(content: string, tools: string[] = []): ModelResponse {
  return {
    content,
    toolCalls: tools.map((name) => ({ id: `call-${name}`, name, arguments: {} })),
    stopReason: tools.length === 0 ? "stop" : "toolUse",
    usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 },
  };
}

function tool(name: string, execute: AgentTool["execute"], effect: "read" | "write" = "read"): MoweAgentTool {
  return {
    definition: { name, description: name, parameters: { type: "object", additionalProperties: false } },
    metadata: { effect, scope: "workspace", concurrencySafe: effect === "read" },
    execute,
  };
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function readMessages(store: MemoryContentAddressedStore, refs: ArtifactRef[]): Promise<ConversationMessage[]> {
  return Promise.all(refs.map(async (ref) => JSON.parse(Buffer.from(await store.get(ref)).toString("utf8")) as ConversationMessage));
}
