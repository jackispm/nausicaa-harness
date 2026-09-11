import { describe, expect, it, vi } from "vitest";

import type { ModelPort, ModelResponse, ModelStreamEvent } from "../../src/domain/ports.js";
import { L0AgentLoop, L0ProtocolError } from "../../src/runtime/l0-agent-loop.js";
import {
  validateModelResponse,
  validateModelStreamEvent,
} from "../../src/runtime/model-response-validation.js";

describe("Model response validation", () => {
  it("accepts empty text and tool lists while retaining provider-specific stop reasons", () => {
    expect(() => validateModelResponse({
      ...response(), content: "", toolCalls: [], stopReason: "provider_specific_reason",
    })).not.toThrow();
    expect(() => validateModelStreamEvent({ type: "error", error: new Error("provider failure") }))
      .not.toThrow();
  });

  it.each(["complete", "stream"] as const)("prevents invalid %s responses from changing L0 context or running tools", async (mode) => {
    const cyclicArguments: Record<string, unknown> = {};
    cyclicArguments.self = cyclicArguments;
    const malformed = [
      { ...response(), stopReason: " \t" },
      { ...response(), toolCalls: undefined },
      { ...response(), usage: { input: Number.MAX_SAFE_INTEGER, output: 1, cacheRead: 0, cacheWrite: 0 } },
      { ...response(), toolCalls: [{ id: "first", name: "read", arguments: { value: 1n } }] },
      { ...response(), toolCalls: [{ id: "first", name: "read", arguments: cyclicArguments }] },
      { ...response(), toolCalls: [response().toolCalls[0]!, { id: " \t", name: "read", arguments: {} }] },
      { ...response(), toolCalls: [response().toolCalls[0]!, { id: "second", name: " \t", arguments: {} }] },
    ];
    for (const value of malformed) {
      const observed: string[] = [];
      const onStreamEvent = vi.fn();
      const execute = vi.fn(async () => ({ content: "read result", isError: false }));
      const model: ModelPort = {
        complete: async () => value as ModelResponse,
        ...(mode === "stream" ? {
          async *stream(): AsyncIterable<ModelStreamEvent> {
            yield { type: "done", response: value as ModelResponse };
          },
        } : {}),
      };
      const loop = new L0AgentLoop({
        model,
        onEvent: (event) => { observed.push(event.type); },
        onStreamEvent,
        tools: [{
          definition: { name: "read", description: "Read", parameters: { type: "object" } },
          execute,
        }],
      });
      const input = loopInput();

      await expect(loop.run(input)).rejects.toBeInstanceOf(L0ProtocolError);

      expect(observed).toEqual(["model.requested"]);
      expect(onStreamEvent).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(input.messages).toEqual([]);
    }
  });

  it.each([
    { type: "unknown-provider-event" },
    { type: "text-delta", delta: 7 },
    { type: "error", error: "a string is not a provider Error" },
  ])("rejects malformed stream events before forwarding them to L0 observers ($type)", async (invalid) => {
    let closed = false;
    const onStreamEvent = vi.fn();
    const observed: string[] = [];
    const loop = new L0AgentLoop({
      model: {
        complete: async () => response(),
        async *stream() {
          try {
            yield invalid as unknown as ModelStreamEvent;
            yield { type: "done", response: response() };
          } finally {
            closed = true;
          }
        },
      },
      onEvent: (event) => { observed.push(event.type); },
      onStreamEvent,
    });

    await expect(loop.run(loopInput())).rejects.toBeInstanceOf(L0ProtocolError);

    expect(observed).toEqual(["model.requested"]);
    expect(onStreamEvent).not.toHaveBeenCalled();
    expect(closed).toBe(true);
  });
});

function response(): ModelResponse {
  return {
    content: "untrusted response",
    stopReason: "toolUse",
    toolCalls: [{ id: "first", name: "read", arguments: {} }],
    usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0 },
  };
}

function loopInput() {
  return {
    request: {
      runId: "validation-run", laneId: "main", sessionId: "validation-session",
      model: "untrusted/model", systemPrompt: "Test response admission", maxOutputTokens: 100,
    },
    messages: [],
    maxSteps: 1,
  };
}
