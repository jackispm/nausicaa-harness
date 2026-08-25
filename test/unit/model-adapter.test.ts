import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Models,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import type { ModelStreamEvent } from "../../src/domain/index.js";
import {
  PiAiModelPort,
  ScriptedModel,
  parseModelSelector,
} from "../../src/model/index.js";

const usage = {
  input: 10,
  output: 4,
  cacheRead: 6,
  cacheWrite: 2,
  costUsd: 0.01,
};

describe("ScriptedModel", () => {
  it("runs deterministic steps and captures requests", async () => {
    const model = new ScriptedModel([{
      content: "done",
      toolCalls: [],
      stopReason: "stop",
      usage,
    }]);

    const response = await model.complete(request());

    expect(response.content).toBe("done");
    expect(model.callCount).toBe(1);
    expect(model.pendingCount).toBe(0);
    expect(model.requests[0]?.model).toBe("demo");
  });

  it("honors cancellation while a scripted step is pending", async () => {
    const controller = new AbortController();
    const model = new ScriptedModel([
      () => new Promise(() => undefined),
    ]);
    const pending = model.complete({ ...request(), signal: controller.signal });

    controller.abort(new Error("cancelled"));

    await expect(pending).rejects.toThrow("cancelled");
  });

  it("streams a deterministic start, text delta, and complete response", async () => {
    const model = new ScriptedModel([{
      content: "done",
      toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "x" } }],
      stopReason: "toolUse",
      usage,
    }]);

    const events = await collect(model.stream(request()));

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text-delta",
      "done",
    ]);
    expect(events[1]).toEqual({ type: "text-delta", delta: "done" });
    expect(events[2]).toEqual({
      type: "done",
      response: {
        content: "done",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "x" } }],
        stopReason: "toolUse",
        usage,
      },
    });
    expect(model.callCount).toBe(1);
  });

  it("ends a pre-aborted stream with only the caller's error", async () => {
    const model = new ScriptedModel([{
      content: "unused",
      toolCalls: [],
      stopReason: "stop",
      usage,
    }]);
    const controller = new AbortController();
    controller.abort(new Error("cancel before start"));

    const events = await collect(model.stream({
      ...request(),
      signal: controller.signal,
    }));

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
    if (events[0]?.type !== "error") throw new Error("Missing error event");
    expect(events[0].error.message).toBe("cancel before start");
    expect(model.callCount).toBe(0);
  });

  it("emits one error terminal after a scripted failure", async () => {
    const model = new ScriptedModel([new Error("script failed")]);

    const events = await collect(model.stream(request()));

    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("error");
    if (terminal?.type !== "error") throw new Error("Missing error event");
    expect(terminal.error.message).toBe("script failed");
    expect(model.callCount).toBe(1);
  });
});

describe("PiAiModelPort", () => {
  it("adapts an injected pi-ai collection and maps cache usage", async () => {
    let observedRoles: string[] = [];
    const faux = fauxProvider({
      provider: "openrouter",
      models: [{ id: "demo" }],
    });
    faux.setResponses([
      (context) => {
        observedRoles = context.messages.map((message) => message.role);
        const response = fauxAssistantMessage([
          fauxText("inspect"),
          fauxToolCall("read_file", { path: "README.md" }, { id: "call-1" }),
        ], { stopReason: "toolUse" });
        response.usage = {
          input: 10,
          output: 4,
          cacheRead: 6,
          cacheWrite: 2,
          totalTokens: 22,
          cost: {
            input: 0.001,
            output: 0.002,
            cacheRead: 0.0002,
            cacheWrite: 0.0003,
            total: 0.0035,
          },
        };
        return response;
      },
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const adapter = new PiAiModelPort({ models });

    const response = await adapter.complete({
      ...request(),
      model: "openrouter:demo",
      messages: [
        { role: "user", content: "go", createdAt: "2026-01-01T00:00:00.000Z" },
        {
          role: "assistant",
          content: "calling",
          toolCalls: [{ id: "old", name: "read_file", arguments: { path: "x" } }],
          createdAt: "2026-01-01T00:00:01.000Z",
        },
        {
          role: "tool",
          content: "result",
          toolCallId: "old",
          toolName: "read_file",
          isError: false,
          createdAt: "2026-01-01T00:00:02.000Z",
        },
      ],
    });

    expect(observedRoles).toEqual(["user", "assistant", "toolResult"]);
    expect(response.toolCalls).toEqual([
      { id: "call-1", name: "read_file", arguments: { path: "README.md" } },
    ]);
    expect(response.usage).toEqual({
      input: expect.any(Number),
      output: expect.any(Number),
      cacheRead: expect.any(Number),
      cacheWrite: expect.any(Number),
      costUsd: expect.any(Number),
    });
  });

  it("maps every pi-ai usage and cost field without loss", async () => {
    const faux = fauxProvider({ provider: "openrouter", models: [{ id: "demo" }] });
    const piResponse = fauxAssistantMessage("done");
    piResponse.usage = {
      input: 10,
      output: 4,
      cacheRead: 6,
      cacheWrite: 2,
      totalTokens: 22,
      cost: {
        input: 0.001,
        output: 0.002,
        cacheRead: 0.0002,
        cacheWrite: 0.0003,
        total: 0.0035,
      },
    };
    const models = {
      getModel: () => faux.getModel(),
      complete: async () => piResponse,
    } as unknown as Models;
    const adapter = new PiAiModelPort({ models });

    const response = await adapter.complete(request());

    expect(response.usage).toEqual({
      input: 10,
      output: 4,
      cacheRead: 6,
      cacheWrite: 2,
      costUsd: 0.0035,
    });
  });

  it("streams text in order and returns complete tool calls in done", async () => {
    const faux = fauxProvider({
      provider: "openrouter",
      models: [{ id: "demo" }],
      tokenSize: { min: 1, max: 1 },
    });
    const piResponse = fauxAssistantMessage([
      fauxText("inspect"),
      fauxText("README"),
      fauxToolCall("read_file", { path: "README.md" }, { id: "call-1" }),
    ], { stopReason: "toolUse" });
    faux.setResponses([piResponse]);
    const models = createModels();
    models.setProvider(faux.provider);
    const adapter = new PiAiModelPort({ models });

    const events = await collect(adapter.stream({
      ...request(),
      model: "openrouter:demo",
    }));

    expect(events[0]).toEqual({ type: "start" });
    expect(events.at(-1)?.type).toBe("done");
    expect(events
      .filter((event) => event.type === "text-delta")
      .map((event) => event.delta)
      .join(""))
      .toBe("inspect\nREADME");
    expect(events.filter((event) => (
      event.type === "done" || event.type === "error"
    ))).toHaveLength(1);
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type !== "done") throw new Error("Missing done event");
    expect(done.response).toEqual({
      content: "inspect\nREADME",
      stopReason: "toolUse",
      toolCalls: [
        { id: "call-1", name: "read_file", arguments: { path: "README.md" } },
      ],
      usage: {
        input: 4,
        output: 12,
        cacheRead: 0,
        cacheWrite: 4,
        costUsd: 0,
      },
    });
  });

  it("terminates a stream with the AbortSignal reason", async () => {
    const faux = fauxProvider({
      provider: "openrouter",
      models: [{ id: "demo" }],
      tokenSize: { min: 1, max: 1 },
      tokensPerSecond: 1_000,
    });
    faux.setResponses([fauxAssistantMessage("a response that arrives in chunks")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const adapter = new PiAiModelPort({ models });
    const controller = new AbortController();
    const iterator = adapter.stream({
      ...request(),
      model: "openrouter:demo",
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual({ type: "start" });
    controller.abort(new Error("cancelled by caller"));
    const terminal = await iterator.next();

    expect(terminal.value?.type).toBe("error");
    if (terminal.value?.type !== "error") throw new Error("Missing error event");
    expect(terminal.value.error.message).toBe("cancelled by caller");
    expect((await iterator.next()).done).toBe(true);
  });

  it("redacts provider error details from stream events", async () => {
    const secret = "Bearer sk-provider-secret";
    const faux = fauxProvider({ provider: "openrouter", models: [{ id: "demo" }] });
    faux.setResponses([async () => {
      throw new Error(secret);
    }]);
    const models = createModels();
    models.setProvider(faux.provider);
    const adapter = new PiAiModelPort({ models });

    const events = await collect(adapter.stream({
      ...request(),
      model: "openrouter:demo",
    }));

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
    if (events[0]?.type !== "error") throw new Error("Missing error event");
    expect(events[0].error.message).toBe("Model request failed");
    expect(events[0].error.message).not.toContain(secret);
  });

  it("parses explicit and default provider selectors", () => {
    expect(parseModelSelector("openrouter:anthropic/claude", "other")).toEqual({
      provider: "openrouter",
      model: "anthropic/claude",
    });
    expect(parseModelSelector("anthropic/claude")).toEqual({
      provider: "openrouter",
      model: "anthropic/claude",
    });
  });
});

function request() {
  return {
    runId: "run-1",
    laneId: "main",
    sessionId: "session-1",
    model: "demo",
    systemPrompt: "system",
    messages: [],
    tools: [],
    maxOutputTokens: 100,
  };
}

async function collect(
  stream: AsyncIterable<ModelStreamEvent>,
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
