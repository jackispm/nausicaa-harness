import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Models,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

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
