import { describe, expect, it } from "vitest";

import type {
  ModelCapabilities,
  ModelPort,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "../../src/domain/index.js";
import { PreparedModelPort } from "../../src/model/index.js";

const response: ModelResponse = {
  content: "done",
  toolCalls: [],
  stopReason: "stop",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
};

describe("PreparedModelPort", () => {
  it("isolates complete requests from caller mutation and preserves the AbortSignal", async () => {
    let observed: ModelRequest | undefined;
    let release!: () => void;
    const pending = new Promise<ModelResponse>((resolve) => {
      release = () => resolve(response);
    });
    const delegate: ModelPort = {
      complete(request) {
        observed = request;
        return pending;
      },
    };
    const model = new PreparedModelPort(delegate);
    const controller = new AbortController();
    const requestValue = request(controller.signal);
    const completion = model.complete(requestValue);

    requestValue.systemPrompt = "mutated system";
    requestValue.messages[0]!.content = "mutated message";
    requestValue.tools[0]!.description = "mutated tool";
    (requestValue.tools[0]!.parameters.properties as Record<string, unknown>).path = {
      type: "number",
    };

    release();
    await completion;

    expect(observed).toBeDefined();
    expect(observed?.systemPrompt).toBe("stable system");
    expect(observed?.messages[0]).toMatchObject({ content: "stable message" });
    expect(observed?.tools[0]).toMatchObject({
      description: "stable tool",
      parameters: { properties: { path: { type: "string" } } },
    });
    expect(observed?.signal).toBe(controller.signal);
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed?.messages)).toBe(true);
    expect(Object.isFrozen(observed?.tools[0])).toBe(true);
  });

  it("binds one request and capability snapshot for a prepared stream", async () => {
    let capabilityReads = 0;
    const capabilities: ModelCapabilities = {
      imageInput: true,
      contextWindowTokens: 16_384,
    };
    const observedRequests: ModelRequest[] = [];
    const delegate: ModelPort = {
      capabilities: () => {
        capabilityReads += 1;
        return capabilities;
      },
      complete: async () => response,
      stream(requestValue) {
        return (async function* (): AsyncIterable<ModelStreamEvent> {
          observedRequests.push(requestValue);
          yield { type: "start" };
          observedRequests.push(requestValue);
          yield { type: "done", response };
        })();
      },
    };
    const model = new PreparedModelPort(delegate);
    const requestValue = request();
    const prepared = model.prepare(requestValue);

    requestValue.model = "changed-model";
    requestValue.messages[0]!.content = "changed message";
    capabilities.imageInput = false;

    expect(prepared.snapshot).toEqual({
      model: "demo",
      capabilities: { imageInput: true, contextWindowTokens: 16_384 },
    });
    expect(Object.isFrozen(prepared.snapshot)).toBe(true);
    expect(Object.isFrozen(prepared.snapshot.capabilities)).toBe(true);

    const events = await collect(prepared.stream!());

    expect(events.map((event) => event.type)).toEqual(["start", "done"]);
    expect(observedRequests).toHaveLength(2);
    expect(observedRequests[0]).toBe(observedRequests[1]);
    expect(observedRequests[0]?.model).toBe("demo");
    expect(observedRequests[0]?.messages[0]?.content).toBe("stable message");
    expect(Object.isFrozen(observedRequests[0])).toBe(true);
    expect(capabilityReads).toBe(1);
  });

  it("can freeze auxiliary requests without probing an unused capability catalog", async () => {
    let capabilityReads = 0;
    let observed: ModelRequest | undefined;
    const model = new PreparedModelPort({
      capabilities: () => {
        capabilityReads += 1;
        return { imageInput: true };
      },
      complete: async (requestValue) => {
        observed = requestValue;
        return response;
      },
    }, { captureCapabilities: false });

    await model.complete(request());

    expect(capabilityReads).toBe(0);
    expect(observed).toBeDefined();
    expect(Object.isFrozen(observed)).toBe(true);
  });
});

function request(signal?: AbortSignal): ModelRequest {
  return {
    runId: "run-1",
    laneId: "main",
    sessionId: "session-1",
    model: "demo",
    systemPrompt: "stable system",
    messages: [{
      role: "user",
      content: "stable message",
      createdAt: "2026-01-01T00:00:00.000Z",
    }],
    tools: [{
      name: "read_file",
      description: "stable tool",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    }],
    maxOutputTokens: 100,
    ...(signal === undefined ? {} : { signal }),
  };
}

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
