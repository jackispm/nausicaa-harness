import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentTool, ModelResponse } from "../../src/domain/ports.js";
import type { ModelPort } from "../../src/domain/ports.js";
import type { RunPolicy } from "../../src/domain/types.js";
import {
  ContentStoreFukaiSource,
  FukaiContextProvider,
} from "../../src/fukai/index.js";
import { JsonlLedger, MemoryLedger } from "../../src/ledger/index.js";
import { ProviderModelError, ScriptedModel } from "../../src/model/index.js";
import { MainLoop } from "../../src/runtime/main-loop.js";
import { SessionController } from "../../src/runtime/session-controller.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

// Oracle source: earendil-works/pi@6aedd1066e540642165aa30fa7b4a1b863778aa7
// packages/agent/src/agent-loop.ts, covered upstream by agent-loop.test.ts.
const PI_L0_ORACLE = Object.freeze({
  truncatedToolCall: Object.freeze({
    effectInvocations: 0,
    modelRequests: 2,
    modelVisibleResults: ["truncated-call"],
    modelVisibleErrors: [true],
  }),
  parallelToolCalls: Object.freeze({
    completionOrder: ["beta", "alpha"],
    modelVisibleOrder: ["alpha", "beta"],
  }),
  invalidToolArguments: Object.freeze({
    effectInvocations: 0,
    modelRequests: 2,
    admittedCalls: 0,
    startedCalls: 0,
    failedCalls: 1,
    modelVisibleErrors: [true],
  }),
  hookBoundary: Object.freeze([
    "before:1",
    "navigate:1",
    "after:1",
    "after-async:1",
    "before:2",
    "navigate:2",
    "after:2",
    "after-async:2",
  ]),
  streaming: Object.freeze([
    "stream.start",
    "stream.thinking-start",
    "stream.thinking-delta:plan",
    "stream.thinking-end",
    "stream.delta:done",
    "stream.end",
  ]),
});

describe("Pi-compatible single-lane L0 oracle", () => {
  it("fails every length-truncated tool call closed and preserves its rejection on recovery", async () => {
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    let effectInvocations = 0;
    const model = new ScriptedModel([
      response("partial call", "length", [
        { id: "truncated-call", name: "mutate", arguments: { path: "partial" } },
      ]),
      response("recovered", "stop"),
    ]);
    const loop = createLoop(model, ledger, store, [{
      definition: {
        name: "mutate",
        description: "Record one mutation",
        parameters: { type: "object", additionalProperties: true },
      },
      async execute() {
        effectInvocations += 1;
        return { content: "mutated", isError: false };
      },
    }]);

    const { initialMessage, ...resumeInput } = runInput("pi-oracle-truncation");
    const paused = await loop.run({ ...resumeInput, initialMessage });
    expect(paused).toMatchObject({ completed: false, stopReason: "length" });
    expect(model.requests).toHaveLength(1);
    // Nausicaa requires explicit recovery; Pi's fail-closed result pairing still applies.
    const result = await loop.run({
      ...resumeInput,
      startStep: 2,
      conversationRefs: paused.conversationRefs,
      upperWatermark: await ledger.watermark(),
    });
    const toolResults = model.requests[1]?.messages.filter((message) => message.role === "tool") ?? [];
    const events = await ledger.read({ runId: "pi-oracle-truncation" });

    expect({
      effectInvocations,
      modelRequests: model.requests.length,
      modelVisibleResults: toolResults.map((message) => (
        message.role === "tool" ? message.toolCallId : ""
      )),
      modelVisibleErrors: toolResults.map((message) => (
        message.role === "tool" ? message.isError : false
      )),
    }).toEqual(PI_L0_ORACLE.truncatedToolCall);
    expect(result).toMatchObject({ completed: true, finalText: "recovered" });
    expect(events.filter((event) => event.type === "tool.failed")).toHaveLength(1);
    expect(events.some((event) => event.type === "tool.admitted")).toBe(false);
    expect(events.some((event) => event.type === "tool.started")).toBe(false);
  });

  it("keeps model-visible tool results in source order after out-of-order completion", async () => {
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const completionOrder: string[] = [];
    let started = 0;
    let releaseBoth: (() => void) | undefined;
    let releaseAlpha: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => { releaseBoth = resolve; });
    const betaFinished = new Promise<void>((resolve) => { releaseAlpha = resolve; });
    const tool = (name: "alpha" | "beta"): AgentTool => ({
      definition: {
        name,
        description: `Complete ${name}`,
        parameters: { type: "object", additionalProperties: false },
      },
      async execute() {
        started += 1;
        if (started === 2) releaseBoth?.();
        await bothStarted;
        if (name === "alpha") await betaFinished;
        completionOrder.push(name);
        if (name === "beta") releaseAlpha?.();
        return { content: `${name}-done`, isError: false };
      },
    });
    const model = new ScriptedModel([
      response("checking", "toolUse", [
        { id: "alpha-call", name: "alpha", arguments: {} },
        { id: "beta-call", name: "beta", arguments: {} },
      ]),
      response("done", "stop"),
    ]);
    const loop = createLoop(model, ledger, store, [tool("alpha"), tool("beta")]);

    await loop.run(runInput("pi-oracle-ordering"));
    const modelVisibleOrder = model.requests[1]?.messages
      .filter((message) => message.role === "tool")
      .map((message) => message.role === "tool" ? message.toolName : "") ?? [];
    const terminalOrder = (await ledger.read({ runId: "pi-oracle-ordering" }))
      .filter((event) => event.type === "tool.succeeded")
      .map((event) => event.type === "tool.succeeded" ? event.payload.name : "");

    expect({ completionOrder, modelVisibleOrder }).toEqual(PI_L0_ORACLE.parallelToolCalls);
    // Durable completion is immediate; only provider context follows source order.
    expect(terminalOrder).toEqual(PI_L0_ORACLE.parallelToolCalls.completionOrder);
  });

  it("fails invalid tool arguments closed before admission or execution", async () => {
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    let effectInvocations = 0;
    const model = new ScriptedModel([
      response("invalid call", "toolUse", [
        { id: "invalid-call", name: "requires-value", arguments: {} },
      ]),
      response("recovered", "stop"),
    ]);
    const loop = createLoop(model, ledger, store, [{
      definition: {
        name: "requires-value",
        description: "Requires one string",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
      async execute() {
        effectInvocations += 1;
        return { content: "must not run", isError: false };
      },
    }]);

    await expect(loop.run(runInput("pi-oracle-invalid-arguments")))
      .resolves.toMatchObject({ completed: true, finalText: "recovered" });
    const events = await ledger.read({ runId: "pi-oracle-invalid-arguments" });
    const toolResults = model.requests[1]?.messages.filter((message) => message.role === "tool") ?? [];

    expect({
      effectInvocations,
      modelRequests: model.requests.length,
      admittedCalls: events.filter((event) => event.type === "tool.admitted").length,
      startedCalls: events.filter((event) => event.type === "tool.started").length,
      failedCalls: events.filter((event) => event.type === "tool.failed").length,
      modelVisibleErrors: toolResults.map((message) => (
        message.role === "tool" ? message.isError : false
      )),
    }).toEqual(PI_L0_ORACLE.invalidToolArguments);
  });

  it("keeps boundary hooks ordered around each committed step", async () => {
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const order: string[] = [];
    const model = new ScriptedModel([
      response("tool step", "toolUse", [
        { id: "hook-noop", name: "noop", arguments: {} },
      ]),
      response("done", "stop"),
    ]);
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [noopTool()],
      includeProjectInstructions: false,
      beforeStep: async ({ step }) => {
        order.push(`before:${step}`);
        return [{
          kind: "runtime-notice",
          source: "oracle",
          content: `boundary-${step}`,
          messageId: `boundary-${step}`,
        }];
      },
      navigationHook: ({ step }) => {
        order.push(`navigate:${step}`);
        return {
          boundaryId: `oracle-${step}`,
          triggerKind: "normal",
          activeObjective: "Complete the current request",
          actionOrDecision: `step-${step}`,
          expectedOutcome: "next boundary",
          outcome: "recorded",
          status: "progress",
          uncertainties: [],
          openQuestions: [],
        };
      },
      afterStep: ({ step }) => { order.push(`after:${step}`); },
      afterStepAsync: async ({ step }) => { order.push(`after-async:${step}`); },
    });

    await expect(loop.run(runInput("pi-oracle-hooks")))
      .resolves.toMatchObject({ completed: true, finalText: "done" });
    expect(order).toEqual(PI_L0_ORACLE.hookBoundary);
    expect(model.requests[1]?.messages.some((message) => (
      message.role === "user" && message.content.includes("boundary-2")
    ))).toBe(true);
    const events = await ledger.read({ runId: "pi-oracle-hooks" });
    expect(events.filter((event) => event.type === "step.completed")).toHaveLength(2);
    expect(events.filter((event) => event.type === "navigation.updated")).toHaveLength(2);
  });

  it("settles successful provider usage exactly once", async () => {
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const model = new ScriptedModel([response("done", "stop")]);
    const loop = createLoop(model, ledger, store, []);

    await expect(loop.run(runInput("pi-oracle-usage")))
      .resolves.toMatchObject({ completed: true, usage: response("", "stop").usage });
    const events = await ledger.read({ runId: "pi-oracle-usage" });
    expect(events.filter((event) => event.type === "budget.charged")).toEqual([
      expect.objectContaining({
        payload: { laneId: "main", usage: response("", "stop").usage },
      }),
    ]);
    expect(events.filter((event) => event.type === "model.completed")).toHaveLength(1);
  });

  it("keeps streaming boundaries ordered with durable model settlement", async () => {
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const streamEvents: string[] = [];
    const model: ModelPort = {
      async complete() {
        return response("done", "stop");
      },
      stream: async function* () {
        yield { type: "start" as const };
        yield { type: "thinking-start" as const };
        yield { type: "thinking-delta" as const, delta: "plan" };
        yield { type: "thinking-end" as const };
        yield { type: "text-delta" as const, delta: "done" };
        yield { type: "done" as const, response: response("done", "stop") };
      },
    };
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [],
      includeProjectInstructions: false,
      onStreamEvent: (event) => {
        streamEvents.push(
          event.type === "stream.thinking-delta" || event.type === "stream.delta"
            ? `${event.type}:${event.delta}`
            : event.type,
        );
      },
    });

    await expect(loop.run(runInput("pi-oracle-streaming")))
      .resolves.toMatchObject({ completed: true, finalText: "done" });
    expect(streamEvents).toEqual(PI_L0_ORACLE.streaming);
    const durable = await ledger.read({ runId: "pi-oracle-streaming" });
    const modelCompleted = durable.findIndex((event) => event.type === "model.completed");
    const assistantMessage = durable.findIndex((event) => event.type === "assistant.message");
    expect(modelCompleted).toBeGreaterThan(-1);
    expect(assistantMessage).toBeGreaterThan(modelCompleted);
    expect(durable.filter((event) => event.type === "budget.charged")).toHaveLength(1);
  });

  it("resumes the same Turn from its committed step boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-pi-l0-resume-oracle-"));
    try {
      const model = new ScriptedModel([
        response("first step", "toolUse", [
          { id: "resume-noop", name: "noop", arguments: {} },
        ]),
        response("partial answer", "length"),
        (request) => {
          expect(request.messages.filter((message) => (
            message.role === "user" && message.content === "Start"
          ))).toHaveLength(1);
          expect(request.messages.filter((message) => message.role === "tool"))
            .toEqual([expect.objectContaining({ toolCallId: "resume-noop", isError: false })]);
          expect(request.messages.at(-1)?.content).toContain("Continue exactly where it stopped");
          return response("resumed", "stop");
        },
      ]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: {
          maxMainStepsPerActivation: 1,
          maxModelTokens: 10_000,
          tetoEnabled: false,
        },
      }, {
        mainModel: model,
        tools: [noopTool()],
        createRunId: () => "resume-oracle",
      });
      try {
        const submitted = await session.submit({ inputId: "resume-input", text: "Start" });
        await session.waitForIdle();
        expect(session.snapshot().status).toBe("idle");
        expect(session.snapshot().blocker).toBe("model-output-limit");
        expect(model.callCount).toBe(2);
        expect(submitted.turnId).toBeDefined();
        await session.resumeCurrent();
        await session.waitForIdle();
        const events = (await session.transcript());
        expect(events.map((entry) => entry.role))
          .toEqual(["user", "assistant", "tool", "assistant", "assistant"]);
      } finally {
        await session.close();
      }
      const ledger = await JsonlLedger.open(join(root, "state", "runs", "resume-oracle", "ledger.jsonl"));
      try {
        const durable = await ledger.read({ runId: "resume-oracle" });
        expect(durable.filter((event) => event.type === "turn.resumed")).toHaveLength(1);
        expect(durable.filter((event) => event.type === "turn.started")).toHaveLength(1);
        expect(durable.filter((event) => event.type === "turn.completed")).toHaveLength(1);
        expect(durable.filter((event) => event.type === "user.message")).toHaveLength(1);
        expect(durable.filter((event) => event.type === "budget.charged")).toHaveLength(3);
      } finally {
        await ledger.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps steering at the active boundary and follow-up after the Turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-pi-l0-queue-oracle-"));
    try {
      let releaseFirst: ((value: ModelResponse) => void) | undefined;
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const model = new ScriptedModel([
        () => new Promise<ModelResponse>((resolve) => {
          releaseFirst = resolve;
          markStarted?.();
        }),
        (request) => {
          expect(request.messages.some((message) => (
            message.role === "user" && message.content === "steer-now"
          ))).toBe(true);
          expect(request.messages.some((message) => (
            message.role === "user" && message.content === "follow-later"
          ))).toBe(false);
          return response("steered", "stop");
        },
        (request) => {
          expect(request.messages.some((message) => (
            message.role === "user" && message.content === "follow-later"
          ))).toBe(true);
          return response("followed", "stop");
        },
      ]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 4, tetoEnabled: false },
      }, {
        mainModel: model,
        tools: [noopTool()],
        createRunId: () => "queue-oracle",
      });
      try {
        const first = await session.submit({ inputId: "queue-main", text: "start" });
        await started;
        const steering = await session.submit({
          inputId: "queue-steer",
          text: "steer-now",
          delivery: "steering",
        });
        const followUp = await session.submit({
          inputId: "queue-follow",
          text: "follow-later",
          delivery: "follow-up",
        });
        expect(steering.turnId).toBe(first.turnId);
        expect(followUp.turnId).toBeUndefined();
        expect((await session.pendingInputs()).map((input) => input.delivery))
          .toEqual(["steering", "follow-up"]);

        releaseFirst?.({
          ...response("first boundary", "toolUse"),
          toolCalls: [{ id: "queue-noop", name: "noop", arguments: {} }],
        });
        await session.waitForIdle();
        expect(model.requests).toHaveLength(3);
        expect(session.snapshot().status).toBe("idle");
      } finally {
        await session.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cancels a retrying Session request with one durable settlement", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-pi-l0-retry-abort-"));
    try {
      let calls = 0;
      let markRetryStarted: (() => void) | undefined;
      const retryStarted = new Promise<void>((resolve) => { markRetryStarted = resolve; });
      const model: ModelPort = {
        async complete(request) {
          calls += 1;
          if (calls === 1) {
            throw new ProviderModelError({
              category: "server",
              status: 503,
              retryable: true,
              retryAfterMs: 0,
            });
          }
          markRetryStarted?.();
          return new Promise<ModelResponse>((resolve) => {
            request.signal?.addEventListener("abort", () => resolve(response("late", "stop")), { once: true });
          });
        },
      };
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "retrying",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: model, createRunId: () => "retry-abort-oracle" });
      const observed: import("../../src/runtime/session-controller.js").SessionRuntimeEvent[] = [];
      session.subscribe((event) => observed.push(event));
      try {
        await session.submit({ inputId: "retry-abort-input", text: "Start" });
        await retryStarted;
        await session.cancel("oracle cancellation");
        await session.waitForIdle();
        const events = observed.flatMap((event) => event.kind === "event" ? [event.event] : []);
        expect(calls).toBe(2);
        expect(events.filter((event) => event.type === "model.requested")).toHaveLength(1);
        expect(events.filter((event) => event.type === "budget.charged")).toHaveLength(0);
        expect(events.filter((event) => event.type === "turn.cancelled")).toHaveLength(1);
      } finally {
        await session.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function noopTool(): AgentTool {
  return {
    definition: {
      name: "noop",
      description: "Do nothing",
      parameters: { type: "object", additionalProperties: false },
    },
    async execute() {
      return { content: "ok", isError: false };
    },
  };
}

function createLoop(
  model: ScriptedModel,
  ledger: MemoryLedger,
  store: MemoryContentAddressedStore,
  tools: readonly AgentTool[],
): MainLoop {
  return new MainLoop({
    model,
    contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
    conversationStore: store,
    eventSink: ledger,
    tools,
    includeProjectInstructions: false,
  });
}

function runInput(runId: string) {
  return {
    runId,
    goal: {
      version: 1,
      statement: "Complete the current request",
      successCriteria: [],
      hardConstraints: [],
    },
    model: "scripted",
    workspace: process.cwd(),
    policy: policy(),
    initialMessage: "Go",
  };
}

function policy(): RunPolicy {
  return {
    maxMainSteps: 2,
    maxModelTokens: 10_000,
    tetoEnabled: false,
    tetoMaxOutputTokens: 64,
    tetoTokenRatio: 0.1,
  };
}

function response(
  content: string,
  stopReason: string,
  toolCalls: ModelResponse["toolCalls"] = [],
): ModelResponse {
  return {
    content,
    toolCalls,
    stopReason,
    usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 },
  };
}
