import { describe, expect, it } from "vitest";

import type {
  ModelPort,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "../../src/domain/index.js";
import {
  ProviderModelError,
  RetryingModelPort,
} from "../../src/model/index.js";

const response: ModelResponse = {
  content: "done",
  toolCalls: [],
  stopReason: "stop",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
};

describe("RetryingModelPort", () => {
  it("retries transient completions with bounded deterministic backoff", async () => {
    const transient = new ProviderModelError({ category: "server", status: 503, retryable: true });
    const delegate = new CompletionSequence([transient, transient, response]);
    const delays: number[] = [];
    const model = retrying(delegate, {
      baseDelayMs: 10,
      maxDelayMs: 100,
      maxAttempts: 3,
      random: () => 1,
      sleep: async (delayMs) => { delays.push(delayMs); },
    });

    await expect(model.complete(request())).resolves.toEqual(response);
    expect(delegate.calls).toBe(3);
    expect(delays).toEqual([10, 20]);
  });

  it.each(["authentication", "permission", "quota", "invalid-request", "aborted"] as const)(
    "does not retry the %s category even when a caller marks it retryable",
    async (category) => {
      const failure = new ProviderModelError({ category, retryable: true });
      const delegate = new CompletionSequence([failure, response]);
      const model = retrying(delegate);

      await expect(model.complete(request())).rejects.toBe(failure);
      expect(delegate.calls).toBe(1);
    },
  );

  it("does not retry after the caller aborts", async () => {
    const delegate = new CompletionSequence([response]);
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    const model = retrying(delegate);

    await expect(model.complete({ ...request(), signal: controller.signal })).rejects.toBe(reason);
    expect(delegate.calls).toBe(0);
  });

  it("refuses a server retry delay above the configured bound", async () => {
    const failure = new ProviderModelError({
      category: "rate-limit",
      status: 429,
      retryable: true,
      retryAfterMs: 101,
    });
    const delegate = new CompletionSequence([failure, response]);
    const model = retrying(delegate, { maxDelayMs: 100 });

    await expect(model.complete(request())).rejects.toBe(failure);
    expect(delegate.calls).toBe(1);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses an invalid Retry-After delay: %s",
    async (retryAfterMs) => {
      const failure = new ProviderModelError({
        category: "rate-limit",
        retryable: true,
        retryAfterMs,
      });
      const delegate = new CompletionSequence([failure, response]);
      const model = retrying(delegate);

      await expect(model.complete(request())).rejects.toBe(failure);
      expect(delegate.calls).toBe(1);
    },
  );

  it("uses a bounded Retry-After delay instead of exponential backoff", async () => {
    const failure = new ProviderModelError({
      category: "rate-limit",
      status: 429,
      retryable: true,
      retryAfterMs: 42,
    });
    const delegate = new CompletionSequence([failure, response]);
    const delays: number[] = [];
    const model = retrying(delegate, {
      sleep: async (delayMs) => { delays.push(delayMs); },
    });

    await expect(model.complete(request())).resolves.toEqual(response);
    expect(delays).toEqual([42]);
  });

  it("returns the final transient error after the attempt budget is exhausted", async () => {
    const first = new ProviderModelError({ category: "server", status: 503, retryable: true });
    const final = new ProviderModelError({ category: "rate-limit", status: 429, retryable: true });
    const delegate = new CompletionSequence([first, final, response]);
    const model = retrying(delegate, { maxAttempts: 2 });

    await expect(model.complete(request())).rejects.toBe(final);
    expect(delegate.calls).toBe(2);
  });

  it("discards an attempt that fails before a stream delta and retries cleanly", async () => {
    const transient = new ProviderModelError({ category: "network", retryable: true });
    const delegate = new StreamSequence([
      [
        { type: "start" },
        { type: "thinking-start" },
        { type: "error", error: transient },
      ],
      [
        { type: "start" },
        { type: "thinking-start" },
        { type: "thinking-delta", delta: "considering" },
        { type: "thinking-end" },
        { type: "text-delta", delta: "done" },
        { type: "done", response },
      ],
    ]);
    const delays: number[] = [];
    const model = retrying(delegate, {
      sleep: async (delayMs) => { delays.push(delayMs); },
    });

    const events = await collect(model.stream!(request()));

    expect(delegate.streamCalls).toBe(2);
    expect(delays).toEqual([10]);
    expect(events).toEqual([
      { type: "start" },
      { type: "thinking-start" },
      { type: "thinking-delta", delta: "considering" },
      { type: "thinking-end" },
      { type: "text-delta", delta: "done" },
      { type: "done", response },
    ]);
  });

  it.each(["text-delta", "thinking-delta"] as const)(
    "does not retry a stream after publishing a %s",
    async (deltaType) => {
      const transient = new ProviderModelError({ category: "server", status: 503, retryable: true });
      const delegate = new StreamSequence([[
        { type: "start" },
        { type: deltaType, delta: "visible" },
        { type: "error", error: transient },
      ], [{ type: "done", response }]]);
      const model = retrying(delegate);

      const events = await collect(model.stream!(request()));

      expect(delegate.streamCalls).toBe(1);
      expect(events.map((event) => event.type)).toEqual(["start", deltaType, "error"]);
      expect(events.at(-1)).toEqual({ type: "error", error: transient });
    },
  );

  it("preserves the delegate's optional stream and capability surface", () => {
    const capabilities = { imageInput: true, contextWindowTokens: 128_000 };
    const completionOnly: ModelPort = {
      capabilities: () => capabilities,
      complete: async () => response,
    };
    const withoutStream = retrying(completionOnly);
    const withStream = retrying(new StreamSequence([[{ type: "done", response }]]));

    expect(withoutStream.capabilities("vision")).toBe(capabilities);
    expect(withStream.capabilities("text")).toEqual({ imageInput: false });
    expect(withoutStream.stream).toBeUndefined();
    expect(withStream.stream).toBeTypeOf("function");
  });

  it("rejects unbounded retry policies", () => {
    const delegate = new CompletionSequence([response]);

    expect(() => retrying(delegate, { maxAttempts: 11 })).toThrow(/maxAttempts/);
    expect(() => retrying(delegate, { maxDelayMs: 60_001 })).toThrow(/maxDelayMs/);
    expect(() => retrying(delegate, { baseDelayMs: 101, maxDelayMs: 100 })).toThrow(/baseDelayMs/);
  });
});

class CompletionSequence implements ModelPort {
  calls = 0;

  constructor(private readonly values: Array<ModelResponse | Error>) {}

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    const value = this.values[this.calls];
    this.calls += 1;
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error("Completion sequence exhausted");
    return value;
  }
}

class StreamSequence implements ModelPort {
  streamCalls = 0;

  constructor(private readonly attempts: ModelStreamEvent[][]) {}

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    return response;
  }

  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const events = this.attempts[this.streamCalls];
    this.streamCalls += 1;
    if (events === undefined) throw new Error("Stream sequence exhausted");
    for (const event of events) yield event;
  }
}

function retrying(
  delegate: ModelPort,
  overrides: Partial<ConstructorParameters<typeof RetryingModelPort>[1]> = {},
): RetryingModelPort {
  return new RetryingModelPort(delegate, {
    maxAttempts: 3,
    baseDelayMs: 10,
    maxDelayMs: 100,
    random: () => 1,
    sleep: async () => undefined,
    ...overrides,
  });
}

function request(): ModelRequest {
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

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
