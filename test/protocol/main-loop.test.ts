import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type {
  AgentTool,
  ModelPort,
  ModelResponse,
} from "../../src/domain/ports.js";
import {
  ContentStoreFukaiSource,
  FukaiContextProvider,
} from "../../src/fukai/index.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import {
  MainLoop,
  type MainStreamEvent,
} from "../../src/runtime/main-loop.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("MainLoop", () => {
  it("reconciles partial deltas with the committed assistant message", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const response: ModelResponse = {
      content: "partial response completed from durable state",
      toolCalls: [],
      stopReason: "stop",
      usage: tokenUsage(4, 6),
    };
    const model: ModelPort = {
      async complete() { return response; },
      async *stream() {
        yield { type: "start" as const };
        yield { type: "text-delta" as const, delta: "partial response" };
        yield { type: "done" as const, response };
      },
    };
    const streamed: MainStreamEvent[] = [];
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [],
      onStreamEvent: (event) => streamed.push(event),
    });

    await loop.run({
      runId: "stream-reconcile-run",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "Go",
    });

    expect(streamed.find((event) => event.type === "stream.delta")).toMatchObject({
      delta: "partial response",
    });
    const ended = streamed.find((event) => event.type === "stream.end");
    expect(ended?.type).toBe("stream.end");
    if (ended?.type !== "stream.end") throw new Error("Missing stream.end");
    const committed = JSON.parse(new TextDecoder().decode(await store.get(ended.messageRef)));
    expect(committed.content).toBe(response.content);
  });

  it("accepts an image-only initial message and preserves it for the model", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const model = new ScriptedModel([{
      content: "image inspected",
      toolCalls: [],
      stopReason: "stop",
      usage: tokenUsage(4, 3),
    }]);
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [],
    });
    const image = { type: "image" as const, data: "AQID", mimeType: "image/png" };

    const result = await loop.run({
      runId: "image-only-run",
      goal: {
        version: 1,
        statement: "Analyze the attached image",
        successCriteria: [],
        hardConstraints: [],
      },
      model: "vision-demo",
      workspace,
      policy: policy(1),
      initialImages: [image],
    });

    expect(result.finalText).toBe("image inspected");
    expect(model.requests[0]?.messages.find((message) =>
      message.role === "user" && message.images !== undefined
    )).toMatchObject({ content: "", images: [image] });
    const userEvent = (await ledger.read({ runId: "image-only-run" }))
      .find((event) => event.type === "user.message");
    if (userEvent?.type !== "user.message") throw new Error("Missing user message");
    const persisted = JSON.parse(new TextDecoder().decode(await store.get(userEvent.payload.messageRef)));
    expect(persisted).toMatchObject({ role: "user", content: "", images: [image] });
  });

  it("executes same-response tools concurrently and records natural boundaries", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    let started = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tool = (name: string): AgentTool => ({
      definition: {
        name,
        description: name,
        parameters: { type: "object", additionalProperties: false },
      },
      async execute() {
        started += 1;
        if (started === 2) {
          release?.();
        }
        await gate;
        return { content: `${name}-done`, isError: false };
      },
    });
    const model = new ScriptedModel([
      {
        content: "running checks",
        toolCalls: [
          { id: "call-a", name: "alpha", arguments: {} },
          { id: "call-b", name: "beta", arguments: {} },
        ],
        stopReason: "toolUse",
        usage: tokenUsage(20, 5),
      },
      {
        content: "all done",
        toolCalls: [],
        stopReason: "stop",
        usage: tokenUsage(25, 5),
      },
    ]);
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [tool("alpha"), tool("beta")],
      beforeStep: async ({ step }) => step === 1
        ? [{
            kind: "advice",
            source: "teto",
            content: "Check the simpler route",
            messageId: "advice-1",
          }]
        : [],
    });

    const result = await loop.run({
      runId: "run-main",
      activeObjective: "Handle the current Turn",
      goal: {
        version: 1,
        statement: "Complete the task",
        successCriteria: ["finished"],
        hardConstraints: [],
      },
      model: "openrouter:demo",
      workspace,
      policy: policy(4),
      initialMessage: "Please do it",
      contextBudget: { maxInputTokens: 4_000 },
    });

    expect(started).toBe(2);
    expect(result).toMatchObject({ finalText: "all done", steps: 2, completed: true });
    expect(result.usage).toEqual(tokenUsage(45, 10));
    expect(model.requests[0]?.messages.at(-1)?.content).toContain("Handle the current Turn");
    expect(model.requests[0]?.messages.some((message) =>
      message.content.includes("Runtime advice")
      && message.content.includes("Check the simpler route"),
    )).toBe(true);
    expect(model.requests[1]?.messages.filter((message) => message.role === "tool")).toHaveLength(2);

    const events = await ledger.read({ runId: "run-main" });
    expect(events.filter((event) => event.type === "tool.requested")).toHaveLength(2);
    expect(events.filter((event) => event.type === "tool.succeeded")).toHaveLength(2);
    expect(events.filter((event) => event.type === "navigation.updated")).toHaveLength(2);
    expect(result.navigationDeltas.map((delta) => delta.activeObjective)).toEqual([
      "Handle the current Turn",
      "Handle the current Turn",
    ]);
    expect(events.at(-1)?.type).toBe("run.completed");
    expect(new Set(events.map((event) => event.correlationId)).size).toBe(1);
    expect(events.every((event) => event.idempotencyKey.length > 0)).toBe(true);
    const requestedTools = events.filter((event) => event.type === "tool.requested");
    const expectedOperationId = (toolCallId: string, toolName: string) => {
      const input = JSON.stringify({
        laneId: "main",
        runId: "run-main",
        step: 1,
        toolCallId,
        toolName,
      });
      return `op:${createHash("sha256").update(input).digest("hex")}`;
    };
    expect(requestedTools.map((event) => event.payload.operationId)).toEqual([
      expectedOperationId("call-a", "alpha"),
      expectedOperationId("call-b", "beta"),
    ]);
  });

  it("returns an incomplete checkpoint when the step limit is reached", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const previousMessage = await store.put(JSON.stringify({
      role: "user",
      content: "Original request",
      createdAt: "2026-01-01T00:00:00.000Z",
    }), "application/vnd.nausicaa.conversation-message+json");
    const model = new ScriptedModel([{
      content: "one more step",
      toolCalls: [{ id: "again", name: "noop", arguments: {} }],
      stopReason: "toolUse",
      usage: tokenUsage(5, 2),
    }]);
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [{
        definition: {
          name: "noop",
          description: "noop",
          parameters: { type: "object", additionalProperties: false },
        },
        async execute() {
          return { content: "ok", isError: false };
        },
      }],
    });

    const result = await loop.run({
      runId: "resume-run",
      goal: { version: 1, statement: "Continue", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(7),
      startStep: 7,
      conversationRefs: [{ ref: previousMessage, sequence: 1 }],
      contextBudget: { maxInputTokens: 2_000 },
    });

    expect(result.completed).toBe(false);
    expect(result.steps).toBe(1);
    const events = await ledger.read({ runId: "resume-run" });
    expect(events.find((event) => event.type === "step.started")?.payload).toEqual({ step: 7 });
    expect(events.some((event) => event.type === "user.message")).toBe(false);
    expect(model.requests[0]?.messages[0]?.content).toBe("Original request");
    expect(events.some((event) => event.type === "run.completed")).toBe(false);
  });

  it("does not mark a length-limited response complete", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const afterSteps: Array<{ usage: unknown; boundaryMessageIds: readonly string[] }> = [];
    const model = new ScriptedModel([{
      content: "partial",
      toolCalls: [],
      stopReason: "length",
      usage: tokenUsage(3, 4),
    }]);
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [],
      beforeStep: async () => [{
        kind: "advice",
        source: "teto",
        content: "stay focused",
        messageId: "advice-length",
      }],
      afterStep: ({ usage, boundaryMessageIds }) => {
        afterSteps.push({ usage, boundaryMessageIds });
      },
    });

    const result = await loop.run({
      runId: "length-run",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "Go",
      contextBudget: { maxInputTokens: 2_000 },
    });

    expect(result.completed).toBe(false);
    expect(result.stopReason).toBe("length");
    expect(result.navigationDeltas[0]?.status).toBe("uncertain");
    expect(afterSteps).toEqual([{
      usage: tokenUsage(3, 4),
      boundaryMessageIds: ["advice-length"],
    }]);
    const events = await ledger.read({ runId: "length-run" });
    expect(events.some((event) => event.type === "run.completed")).toBe(false);
    const requested = events.find((event) => event.type === "model.requested");
    expect(requested?.payload.contextWatermark).toBeGreaterThan(0);
    expect(requested?.payload.contextWatermark).toBeLessThan(requested?.globalOffset ?? 0);
  });

  it("never executes tool calls from a length-truncated model response", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    let executions = 0;
    const model = new ScriptedModel([
      {
        content: "partial tool call",
        toolCalls: [{ id: "truncated-call", name: "mutate", arguments: { path: "a" } }],
        stopReason: "length",
        usage: tokenUsage(3, 4),
      },
      {
        content: "recovered",
        toolCalls: [],
        stopReason: "stop",
        usage: tokenUsage(4, 2),
      },
    ]);
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [{
        definition: {
          name: "mutate",
          description: "must not run with truncated arguments",
          parameters: { type: "object", additionalProperties: true },
        },
        async execute() {
          executions += 1;
          return { content: "mutated", isError: false };
        },
      }],
    });

    const result = await loop.run({
      runId: "truncated-tool-run",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(2),
      initialMessage: "Go",
    });

    expect(executions).toBe(0);
    expect(result).toMatchObject({ completed: true, finalText: "recovered" });
    const events = await ledger.read({ runId: "truncated-tool-run" });
    expect(events.filter((event) => event.type === "tool.failed")).toHaveLength(1);
    const retryContext = model.requests[1]?.messages.find((message) => message.role === "tool");
    expect(retryContext?.content).toContain("may be truncated");
  });

  it("does not promote one expected tool miss to a repeated-failure wake", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const model = new ScriptedModel([
      {
        content: "",
        toolCalls: [{ id: "missing-1", name: "read_file", arguments: { path: "OPTIONAL.md" } }],
        stopReason: "toolUse",
        usage: tokenUsage(3, 1),
      },
      {
        content: "done",
        toolCalls: [],
        stopReason: "stop",
        usage: tokenUsage(3, 1),
      },
    ]);
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [{
        definition: {
          name: "read_file",
          description: "read a bounded file",
          parameters: { type: "object", additionalProperties: false },
        },
        async execute() {
          return { content: "File not found", isError: true };
        },
      }],
    });

    const result = await loop.run({
      runId: "expected-miss-run",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(2),
      initialMessage: "Go",
    });

    expect(result.completed).toBe(true);
    expect(result.navigationDeltas[0]).toMatchObject({
      triggerKind: "normal",
      actionOrDecision: expect.stringContaining("OPTIONAL.md"),
      outcome: expect.stringContaining("File not found"),
    });
  });

  it("marks a successful workspace mutation as a decision boundary", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const loop = new MainLoop({
      model: new ScriptedModel([
        {
          content: "",
          toolCalls: [{
            id: "edit-1",
            name: "edit",
            arguments: { path: "src/value.ts", oldText: "1", newText: "2" },
          }],
          stopReason: "toolUse",
          usage: tokenUsage(3, 1),
        },
        {
          content: "done",
          toolCalls: [],
          stopReason: "stop",
          usage: tokenUsage(3, 1),
        },
      ]),
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [{
        definition: {
          name: "edit",
          description: "edit one file",
          parameters: { type: "object", additionalProperties: true },
        },
        async execute() {
          return { content: "Updated src/value.ts", isError: false };
        },
      }],
    });

    const result = await loop.run({
      runId: "mutation-decision-run",
      goal: { version: 1, statement: "Change the value", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(2),
      initialMessage: "Go",
    });

    expect(result.navigationDeltas[0]).toMatchObject({
      triggerKind: "decision",
      actionOrDecision: expect.stringContaining("src/value.ts"),
    });
  });

  it("records monotonic context and provider latency without wall-clock inference", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const timings = [10, 14, 20, 45];
    const loop = new MainLoop({
      model: new ScriptedModel([{
        content: "done",
        toolCalls: [],
        stopReason: "stop",
        usage: { input: 10, output: 2, cacheRead: 8, cacheWrite: 1 },
      }]),
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [],
      monotonicNow: () => timings.shift() ?? 45,
    });

    await loop.run({
      runId: "telemetry-run",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "Go",
    });

    const events = await ledger.read({ runId: "telemetry-run" });
    const requested = events.find((event) => event.type === "model.requested");
    const completed = events.find((event) => event.type === "model.completed");
    expect(requested?.payload).toMatchObject({
      contextBuildMs: 4,
      sessionId: "telemetry-run:main",
      truncations: [],
    });
    expect(requested?.payload.prefixHash).toMatch(/^[a-f0-9]{64}$/);
    expect(completed?.payload).toMatchObject({
      modelLatencyMs: 25,
      cacheOutcome: "hit-write",
    });
  });

  it("keeps prefix and session affinity stable across images, steering, recovery, and turns", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const image = { type: "image" as const, data: "AQID", mimeType: "image/png" };
    const model = new ScriptedModel([
      {
        content: "inspect once",
        toolCalls: [{ id: "inspect", name: "noop", arguments: {} }],
        stopReason: "toolUse",
        usage: tokenUsage(5, 2),
      },
      {
        content: "first turn complete",
        toolCalls: [],
        stopReason: "stop",
        usage: tokenUsage(6, 2),
      },
      {
        content: "second turn complete",
        toolCalls: [],
        stopReason: "stop",
        usage: tokenUsage(7, 2),
      },
    ]);
    let boundaryOrdinal = 0;
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [{
        definition: {
          name: "noop",
          description: "Return a deterministic observation",
          parameters: { type: "object", additionalProperties: false },
        },
        async execute() {
          return { content: "observed", isError: false };
        },
      }],
      beforeStep: async () => {
        boundaryOrdinal += 1;
        return [{
          kind: "steering",
          source: "user",
          content: `steering-${boundaryOrdinal}`,
          messageId: `steering-${boundaryOrdinal}`,
        }];
      },
    });
    const goal = {
      version: 1,
      statement: "Keep cache evidence explainable",
      successCriteria: [],
      hardConstraints: [],
    };
    const contextBudget = {
      maxInputTokens: 4_000,
      maxConversationMessages: 3,
    };

    const interrupted = await loop.run({
      runId: "cache-evidence-run",
      turnId: "turn-1",
      activeObjective: "Inspect the image",
      goal,
      model: "vision-demo",
      workspace,
      policy: policy(1),
      initialImages: [image],
      contextBudget,
    });
    expect(interrupted.completed).toBe(false);

    const resumed = await loop.run({
      runId: "cache-evidence-run",
      turnId: "turn-1",
      activeObjective: "Finish the inspection",
      goal,
      model: "vision-demo",
      workspace,
      policy: policy(2),
      startStep: 2,
      upperWatermark: await ledger.watermark(),
      conversationRefs: interrupted.conversationRefs,
      contextBudget,
    });
    expect(resumed.completed).toBe(true);

    await loop.run({
      runId: "cache-evidence-run",
      turnId: "turn-2",
      activeObjective: "Answer the follow-up",
      goal,
      model: "vision-demo",
      workspace,
      policy: policy(1),
      initialMessage: "What changed?",
      upperWatermark: await ledger.watermark(),
      conversationRefs: resumed.conversationRefs,
      contextBudget,
    });

    expect(model.requests.map((request) => request.sessionId)).toEqual([
      "cache-evidence-run:main",
      "cache-evidence-run:main",
      "cache-evidence-run:main",
    ]);
    expect(model.requests[0]?.messages.some((message) =>
      message.role === "user" && message.images?.length === 1
    )).toBe(true);
    expect(model.requests[1]?.messages.some((message) =>
      message.content.includes("steering-2")
    )).toBe(true);

    const requested = (await ledger.read({ runId: "cache-evidence-run" }))
      .filter((event) => event.type === "model.requested");
    expect(requested).toHaveLength(3);
    expect(new Set(requested.map((event) => event.payload.sessionId))).toEqual(
      new Set(["cache-evidence-run:main"]),
    );
    expect(new Set(requested.map((event) => event.payload.prefixHash)).size).toBe(1);
    expect(new Set(requested.map((event) => event.payload.requestHash)).size).toBe(3);
    expect(requested[0]?.payload.truncations).toEqual([]);
    expect(requested.slice(1).every((event) =>
      event.payload.truncations?.some((item) => item.kind === "conversation-message-limit")
    )).toBe(true);
  });

  it("redacts persisted model and Step failure text", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const bearer = "bearer-secret-value-123456";
    const openRouterKey = "sk" + "-or-v1-" + "a".repeat(32);
    const loop = new MainLoop({
      model: new ScriptedModel([
        new Error(`Provider rejected Bearer ${bearer} using ${openRouterKey}`),
      ]),
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [],
    });

    await expect(loop.run({
      runId: "redacted-model-run",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "Go",
    })).rejects.toThrow("Provider rejected");

    const serialized = JSON.stringify(await ledger.read({ runId: "redacted-model-run" }));
    expect(serialized).not.toContain(bearer);
    expect(serialized).not.toContain(openRouterKey);
    expect(serialized).toContain("[REDACTED]");
    const failureTypes = (await ledger.read({ runId: "redacted-model-run" }))
      .filter((event) => event.type.endsWith(".failed"))
      .map((event) => event.type);
    expect(failureTypes).toEqual(["model.failed", "step.failed"]);
  });

  it("redacts a failed tool result before storing or returning it to the model", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const bearer = "tool-bearer-secret-123456";
    const openRouterKey = "sk" + "-or-v1-" + "z".repeat(32);
    const model = new ScriptedModel([
      {
        content: "run the tool",
        toolCalls: [{ id: "secret-call", name: "secret_tool", arguments: {} }],
        stopReason: "toolUse",
        usage: tokenUsage(5, 2),
      },
      {
        content: "done",
        toolCalls: [],
        stopReason: "stop",
        usage: tokenUsage(5, 2),
      },
    ]);
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [{
        definition: {
          name: "secret_tool",
          description: "fails with provider details",
          parameters: { type: "object", additionalProperties: false },
        },
        async execute() {
          throw new Error(`Authorization: Bearer ${bearer}; key=${openRouterKey}`);
        },
      }],
    });

    await loop.run({
      runId: "redacted-tool-run",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(2),
      initialMessage: "Go",
    });

    const events = await ledger.read({ runId: "redacted-tool-run" });
    const failed = events.find((event) => event.type === "tool.failed");
    expect(failed?.type).toBe("tool.failed");
    if (failed?.type !== "tool.failed") throw new Error("Missing tool.failed event");
    const artifact = new TextDecoder().decode(await store.get(failed.payload.resultRef));
    const persisted = JSON.stringify(events) + artifact;
    expect(persisted).not.toContain(bearer);
    expect(persisted).not.toContain(openRouterKey);
    expect(persisted).toContain("[REDACTED]");
    expect(JSON.stringify(model.requests[1]?.messages)).not.toContain(bearer);
    expect(JSON.stringify(model.requests[1]?.messages)).not.toContain(openRouterKey);
  });

  it("waits for every parallel tool execution before rejecting cancellation", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const controller = new AbortController();
    let started = 0;
    let releaseStarted: (() => void) | undefined;
    let releaseDelayed: (() => void) | undefined;
    let delayedFinished = false;
    let runSettled = false;
    const bothStarted = new Promise<void>((resolve) => { releaseStarted = resolve; });
    const delayedGate = new Promise<void>((resolve) => { releaseDelayed = resolve; });
    const markStarted = (): void => {
      started += 1;
      if (started === 2) releaseStarted?.();
    };
    const tool = (name: string, execute: AgentTool["execute"]): AgentTool => ({
      definition: {
        name,
        description: name,
        parameters: { type: "object", additionalProperties: false },
      },
      execute,
    });
    const loop = new MainLoop({
      model: new ScriptedModel([{
        content: "run both",
        toolCalls: [
          { id: "cancel-call", name: "cancel", arguments: {} },
          { id: "delayed-call", name: "delayed", arguments: {} },
        ],
        stopReason: "toolUse",
        usage: tokenUsage(5, 2),
      }]),
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [
        tool("cancel", async () => {
          markStarted();
          await bothStarted;
          controller.abort(new Error("cancelled"));
          return { content: "cancelled", isError: false };
        }),
        tool("delayed", async () => {
          markStarted();
          await delayedGate;
          delayedFinished = true;
          return { content: "late result", isError: false };
        }),
      ],
    });

    const outcome = loop.run({
      runId: "cancelled-tools-run",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "Go",
      signal: controller.signal,
    }).then(
      () => undefined,
      (error: unknown) => error,
    ).finally(() => {
      runSettled = true;
    });

    await bothStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runSettled).toBe(false);
    expect(delayedFinished).toBe(false);

    releaseDelayed?.();
    expect(await outcome).toBeInstanceOf(Error);
    expect(delayedFinished).toBe(true);
    const watermark = await ledger.watermark();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await ledger.watermark()).toBe(watermark);
  });
});

function policy(maxMainSteps: number) {
  return {
    maxMainSteps,
    maxModelTokens: 10_000,
    tetoEnabled: false,
    tetoMaxOutputTokens: 200,
    tetoTokenRatio: 0.1,
  };
}

function tokenUsage(input: number, output: number) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "nausicaa-main-"));
  temporaryDirectories.push(directory);
  return directory;
}
