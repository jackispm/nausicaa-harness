import { describe, expect, it } from "vitest";

import type {
  AgentTool,
  ModelPort,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "../../src/domain/ports.js";
import type { ConversationMessage } from "../../src/domain/types.js";
import {
  L0AgentLoop,
  L0ProtocolError,
  type L0ModelRequest,
} from "../../src/runtime/l0-agent-loop.js";

describe("L0AgentLoop Pi parity", () => {
  it("consumes provider streaming boundaries and settles usage once", async () => {
    const streamEvents: string[] = [];
    const observed: string[] = [];
    const model: ModelPort = {
      async complete() {
        throw new Error("complete must not be selected when stream is available");
      },
      async *stream() {
        yield { type: "start" } satisfies ModelStreamEvent;
        yield { type: "thinking-start" } satisfies ModelStreamEvent;
        yield { type: "thinking-delta", delta: "plan" } satisfies ModelStreamEvent;
        yield { type: "thinking-end" } satisfies ModelStreamEvent;
        yield { type: "text-delta", delta: "done" } satisfies ModelStreamEvent;
        yield { type: "done", response: response("done", "stop", [], 4, 2) } satisfies ModelStreamEvent;
      },
    };
    const loop = new L0AgentLoop({
      model,
      onStreamEvent: (event) => {
        if (event.type === "done") event.response.content = "observer mutation";
        streamEvents.push(event.type === "thinking-delta" || event.type === "text-delta"
          ? `${event.type}:${event.delta}`
          : event.type);
      },
      onEvent: (event) => { observed.push(event.type); },
    });

    const result = await loop.run({
      request: baseRequest(),
      messages: [userMessage("Go")],
      maxSteps: 1,
    });

    expect(streamEvents).toEqual([
      "start",
      "thinking-start",
      "thinking-delta:plan",
      "thinking-end",
      "text-delta:done",
      "done",
    ]);
    expect(observed).toContain("model.requested");
    expect(observed.filter((type) => type === "model.stream")).toHaveLength(6);
    expect(result).toMatchObject({
      finalText: "done",
      completed: true,
      steps: 1,
      usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
    });
    expect(result.messages.map((message) => message.role)).toEqual(["assistant"]);
  });

  it("executes parallel calls concurrently but materializes results in source order", async () => {
    const requests: ModelRequest[] = [];
    const completionOrder: string[] = [];
    let started = 0;
    let releaseBoth: (() => void) | undefined;
    let releaseAlpha: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => { releaseBoth = resolve; });
    const betaFinished = new Promise<void>((resolve) => { releaseAlpha = resolve; });
    const tool = (name: "alpha" | "beta"): AgentTool => ({
      definition: {
        name,
        description: name,
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
    let calls = 0;
    const model: ModelPort = {
      async complete(request) {
        requests.push(request);
        calls += 1;
        return calls === 1
          ? response("checking", "toolUse", [
              { id: "alpha-call", name: "alpha", arguments: {} },
              { id: "beta-call", name: "beta", arguments: {} },
            ])
          : response("done", "stop");
      },
    };
    const loop = new L0AgentLoop({ model, tools: [tool("alpha"), tool("beta")] });

    const result = await loop.run({
      request: baseRequest(),
      messages: [userMessage("Inspect")],
      maxSteps: 2,
    });

    const secondRequestTools = requests[1]?.messages
      .filter((message) => message.role === "tool")
      .map((message) => message.role === "tool" ? message.toolName : "");
    expect(completionOrder).toEqual(["beta", "alpha"]);
    expect(secondRequestTools).toEqual(["alpha", "beta"]);
    expect(result.messages.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "tool",
      "assistant",
    ]);
  });

  it("fails every length-truncated call closed and lets the model recover", async () => {
    let effectInvocations = 0;
    let calls = 0;
    const model: ModelPort = {
      async complete(request) {
        calls += 1;
        expect(request.tools.map((tool) => tool.name)).toEqual(["mutate"]);
        return calls === 1
          ? response("partial", "length", [
              { id: "truncated-call", name: "mutate", arguments: { path: "partial" } },
            ])
          : response("recovered", "stop");
      },
    };
    const loop = new L0AgentLoop({
      model,
      tools: [{
        definition: {
          name: "mutate",
          description: "Mutation",
          parameters: { type: "object", additionalProperties: true },
        },
        async execute() {
          effectInvocations += 1;
          return { content: "must not run", isError: false };
        },
      }],
    });

    const result = await loop.run({
      request: baseRequest(),
      messages: [userMessage("Go")],
      maxSteps: 2,
    });
    const toolMessage = result.messages.find((message) => message.role === "tool");

    expect(effectInvocations).toBe(0);
    expect(calls).toBe(2);
    expect(toolMessage?.role === "tool" ? toolMessage.isError : false).toBe(true);
    expect(toolMessage?.role === "tool" ? toolMessage.content : "")
      .toContain("output token limit");
    expect(result).toMatchObject({ completed: true, finalText: "recovered" });
  });

  it("rejects invalid arguments before invoking a tool and continues", async () => {
    let effectInvocations = 0;
    let calls = 0;
    const model: ModelPort = {
      async complete() {
        calls += 1;
        return calls === 1
          ? response("invalid", "toolUse", [
              { id: "invalid-call", name: "requires-value", arguments: {} },
            ])
          : response("recovered", "stop");
      },
    };
    const loop = new L0AgentLoop({
      model,
      tools: [{
        definition: {
          name: "requires-value",
          description: "Requires a value",
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
      }],
    });

    const result = await loop.run({
      request: baseRequest(),
      messages: [userMessage("Go")],
      maxSteps: 2,
    });
    const toolMessage = result.messages.find((message) => message.role === "tool");

    expect(effectInvocations).toBe(0);
    expect(toolMessage?.role === "tool" ? toolMessage.isError : false).toBe(true);
    expect(toolMessage?.role === "tool" ? toolMessage.content : "").toContain("required");
    expect(result).toMatchObject({ completed: true, finalText: "recovered" });
  });

  it("honors AbortSignal at the provider boundary and never retries", async () => {
    const controller = new AbortController();
    let calls = 0;
    const model: ModelPort = {
      async complete(request) {
        calls += 1;
        return new Promise<ModelResponse>((resolve) => {
          request.signal?.addEventListener("abort", () => resolve(response("late", "stop")), { once: true });
        });
      },
    };
    const loop = new L0AgentLoop({ model });
    const pending = loop.run({
      request: baseRequest(),
      messages: [userMessage("Wait")],
      signal: controller.signal,
      maxSteps: 3,
    });

    await Promise.resolve();
    controller.abort(new Error("cancelled by test"));
    await expect(pending).rejects.toThrow("cancelled by test");
    expect(calls).toBe(1);
  });

  it("returns usage and step-limit state without retrying provider errors", async () => {
    let calls = 0;
    const model: ModelPort = {
      async complete() {
        calls += 1;
        return response("needs another step", "toolUse", [
          { id: "noop-call", name: "noop", arguments: {} },
        ], 3, 1);
      },
    };
    const loop = new L0AgentLoop({
      model,
      tools: [{
        definition: {
          name: "noop",
          description: "No-op",
          parameters: { type: "object", additionalProperties: false },
        },
        async execute() { return { content: "ok", isError: false }; },
      }],
    });
    const limited = await loop.run({
      request: baseRequest(),
      messages: [userMessage("Go")],
      maxSteps: 3,
      maxModelTokens: 4,
    });
    expect(limited).toMatchObject({ completed: false, steps: 1, usage: { input: 3, output: 1 } });
    expect(calls).toBe(1);

    const failing = new L0AgentLoop({
      model: {
        async complete() {
          throw new Error("provider unavailable");
        },
      },
    });
    await expect(failing.run({ request: baseRequest(), messages: [userMessage("Go")] }))
      .rejects.toThrow("provider unavailable");
  });

  it("turns a malformed provider response into an explicit protocol failure", async () => {
    const loop = new L0AgentLoop({
      model: {
        async complete() {
          return {
            content: "ok",
            toolCalls: [],
            stopReason: "stop",
            usage: undefined,
          } as unknown as ModelResponse;
        },
      },
    });

    await expect(loop.run({ request: baseRequest(), messages: [userMessage("Go")] }))
      .rejects.toBeInstanceOf(L0ProtocolError);
  });
});

function baseRequest(): L0ModelRequest {
  return {
    runId: "l0-parity-run",
    laneId: "main",
    sessionId: "l0-parity-session",
    model: "scripted",
    systemPrompt: "You are a test agent.",
    maxOutputTokens: 128,
  };
}

function userMessage(content: string): ConversationMessage {
  return {
    role: "user",
    content,
    createdAt: "2026-09-04T00:00:00.000Z",
  };
}

function response(
  content: string,
  stopReason: string,
  toolCalls: ModelResponse["toolCalls"] = [],
  input = 1,
  output = 1,
): ModelResponse {
  return {
    content,
    toolCalls,
    stopReason,
    usage: { input, output, cacheRead: 0, cacheWrite: 0 },
  };
}
