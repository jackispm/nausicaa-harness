import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  InMemoryCredentialStore,
  type ApiKeyAuth,
  type Models,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import type { ModelStreamEvent } from "../../src/domain/index.js";
import {
  PiAiModelPort,
  ProviderModelError,
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
  it("drops malformed fractional provider usage at the error boundary", () => {
    const error = new ProviderModelError({
      category: "provider",
      retryable: false,
      providerUsage: {
        input: 1.5,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
      },
    });

    expect(error.providerUsage).toBeUndefined();
  });

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
  it("resolves an injected credential store at the provider request boundary", async () => {
    const faux = fauxProvider({ provider: "saved-auth", models: [{ id: "demo" }] });
    let observedKey: string | undefined;
    const authMethod: ApiKeyAuth = {
      name: "Faux API key",
      resolve: async ({ credential }) => {
        observedKey = credential?.key;
        return credential?.key === "stored-key"
          ? { auth: { apiKey: credential.key }, source: "stored credential" }
          : undefined;
      },
    };
    const auth = { apiKey: authMethod };
    const store = new InMemoryCredentialStore();
    await store.modify("saved-auth", async () => ({ type: "api_key", key: "stored-key" }));
    const models = createModels({
      credentials: store,
      authContext: { env: async () => undefined, fileExists: async () => false },
    });
    models.setProvider({ ...faux.provider, auth });
    faux.setResponses([fauxAssistantMessage("authenticated")]);
    const adapter = new PiAiModelPort({ models });

    const response = await adapter.complete({
      ...request(),
      model: "saved-auth:demo",
    });

    expect(response.content).toBe("authenticated");
    expect(observedKey).toBe("stored-key");
  });

  it("reports a validated pi-ai context window capability", () => {
    const faux = fauxProvider({
      provider: "openrouter",
      models: [{ id: "vision", input: ["text", "image"], contextWindow: 128_000 }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const adapter = new PiAiModelPort({ models });

    expect(adapter.capabilities("openrouter:vision")).toEqual({
      imageInput: true,
      contextWindowTokens: 128_000,
    });
  });

  it("projects the injected local catalog without auth or refresh probes", () => {
    const faux = fauxProvider({
      provider: "openrouter",
      models: [{
        id: "vision",
        input: ["text", "image"],
        contextWindow: 128_000,
        maxTokens: 8_192,
        reasoning: true,
      }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const adapter = new PiAiModelPort({ models });

    expect(adapter.catalog()).toEqual([expect.objectContaining({
      selector: "openrouter:vision",
      provider: "openrouter",
      contextWindowTokens: 128_000,
      maxOutputTokens: 8_192,
      imageInput: true,
      toolUse: "unknown",
      reasoning: true,
      authStatus: "unverified",
    })]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "omits an invalid pi-ai context window capability: %s",
    (contextWindow) => {
      const faux = fauxProvider({
        provider: "openrouter",
        models: [{ id: "demo", input: ["text"], contextWindow }],
      });
      const models = createModels();
      models.setProvider(faux.provider);
      const adapter = new PiAiModelPort({ models });

      expect(adapter.capabilities("openrouter:demo")).toEqual({ imageInput: false });
    },
  );

  it("preserves pi-ai session cache affinity across repeated requests", async () => {
    const faux = fauxProvider({
      provider: "openrouter",
      models: [{ id: "demo" }],
    });
    faux.setResponses([
      fauxAssistantMessage("cold"),
      fauxAssistantMessage("warm"),
      fauxAssistantMessage("other session"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const adapter = new PiAiModelPort({ models });
    const repeated = {
      ...request(),
      model: "openrouter:demo",
      systemPrompt: "stable system prefix",
      messages: [{
        role: "user" as const,
        content: "same dynamic tail",
        createdAt: "2026-01-01T00:00:00.000Z",
      }],
    };

    const cold = await adapter.complete(repeated);
    const warm = await adapter.complete(repeated);
    const otherSession = await adapter.complete({
      ...repeated,
      sessionId: "session-2",
    });

    expect(cold.usage.cacheWrite).toBeGreaterThan(0);
    expect(cold.usage.cacheRead).toBe(0);
    expect(warm.usage.cacheRead).toBeGreaterThan(0);
    expect(warm.usage.cacheWrite).toBe(0);
    expect(otherSession.usage.cacheRead).toBe(0);
    expect(otherSession.usage.cacheWrite).toBeGreaterThan(0);
  });

  it("passes pi-ai image blocks through without inventing a provider protocol", async () => {
    let observedContent: unknown;
    const faux = fauxProvider({
      provider: "openrouter",
      models: [{ id: "vision", input: ["text", "image"] }],
    });
    faux.setResponses([(context) => {
      observedContent = context.messages[0]?.content;
      return fauxAssistantMessage("seen");
    }]);
    const models = createModels();
    models.setProvider(faux.provider);
    const adapter = new PiAiModelPort({ models });

    await adapter.complete({
      ...request(),
      model: "openrouter:vision",
      messages: [{
        role: "user",
        content: "inspect",
        images: [{ type: "image", mimeType: "image/png", data: "AA==" }],
        createdAt: "2026-01-01T00:00:00.000Z",
      }],
    });

    expect(observedContent).toEqual([
      { type: "text", text: "inspect" },
      { type: "image", mimeType: "image/png", data: "AA==" },
    ]);
  });

  it("passes tool-produced image blocks through to the vision provider", async () => {
    let observedToolContent: unknown;
    const faux = fauxProvider({
      provider: "openrouter",
      models: [{ id: "vision", input: ["text", "image"] }],
    });
    faux.setResponses([(context) => {
      observedToolContent = context.messages[0]?.content;
      return fauxAssistantMessage("seen");
    }]);
    const models = createModels();
    models.setProvider(faux.provider);
    const adapter = new PiAiModelPort({ models });

    await adapter.complete({
      ...request(),
      model: "openrouter:vision",
      messages: [{
        role: "tool",
        content: "screen.png",
        images: [{ type: "image", mimeType: "image/png", data: "AA==" }],
        toolCallId: "read-image",
        toolName: "read_image",
        isError: false,
        createdAt: "2026-01-01T00:00:00.000Z",
      }],
    });

    expect(observedToolContent).toEqual([
      { type: "text", text: "screen.png" },
      { type: "image", mimeType: "image/png", data: "AA==" },
    ]);
  });

  it("rejects image input before calling a text-only model", async () => {
    const faux = fauxProvider({
      provider: "openrouter",
      models: [{ id: "text-only", input: ["text"] }],
    });
    faux.setResponses([fauxAssistantMessage("must not run")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const adapter = new PiAiModelPort({ models });
    const imageRequest = {
      ...request(),
      model: "openrouter:text-only",
      messages: [{
        role: "user" as const,
        content: "inspect",
        images: [{ type: "image" as const, mimeType: "image/png", data: "AA==" }],
        createdAt: "2026-01-01T00:00:00.000Z",
      }],
    };

    await expect(adapter.complete(imageRequest)).rejects.toThrow(/does not support image/i);
    const events = await collect(adapter.stream(imageRequest));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      error: { message: expect.stringMatching(/does not support image/i) },
    });
    expect(faux.state.callCount).toBe(0);
  });

  it("rejects tool-produced images before calling a text-only model", async () => {
    const faux = fauxProvider({
      provider: "openrouter",
      models: [{ id: "text-only", input: ["text"] }],
    });
    faux.setResponses([fauxAssistantMessage("must not run")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const adapter = new PiAiModelPort({ models });
    const imageRequest = {
      ...request(),
      model: "openrouter:text-only",
      messages: [{
        role: "tool" as const,
        content: "screen.png",
        images: [{ type: "image" as const, mimeType: "image/png", data: "AA==" }],
        toolCallId: "read-image",
        toolName: "read_image",
        isError: false,
        createdAt: "2026-01-01T00:00:00.000Z",
      }],
    };

    await expect(adapter.complete(imageRequest)).rejects.toThrow(/does not support image/i);
    const events = await collect(adapter.stream(imageRequest));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      error: { message: expect.stringMatching(/does not support image/i) },
    });
    expect(faux.state.callCount).toBe(0);
  });

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

  it("rejects a provider completion that resolves after cancellation", async () => {
    const faux = fauxProvider({ provider: "openrouter", models: [{ id: "demo" }] });
    let release!: (message: ReturnType<typeof fauxAssistantMessage>) => void;
    const pending = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
      release = resolve;
    });
    const models = {
      getModel: () => faux.getModel(),
      complete: async () => pending,
    } as unknown as Models;
    const adapter = new PiAiModelPort({ models });
    const controller = new AbortController();
    const completion = adapter.complete({
      ...request(),
      model: "openrouter:demo",
      signal: controller.signal,
    });

    controller.abort(new Error("cancelled while provider was pending"));
    release(fauxAssistantMessage("late"));

    await expect(completion).rejects.toThrow("cancelled while provider was pending");
  });

  it("discards a provider stream done event delivered after cancellation", async () => {
    const faux = fauxProvider({ provider: "openrouter", models: [{ id: "demo" }] });
    const controller = new AbortController();
    const models = {
      getModel: () => faux.getModel(),
      stream: () => (async function* () {
        yield { type: "start" as const };
        await Promise.resolve();
        controller.abort(new Error("cancelled while stream was pending"));
        yield { type: "done" as const, message: fauxAssistantMessage("late") };
      })(),
    } as unknown as Models;
    const adapter = new PiAiModelPort({ models });

    const events = await collect(adapter.stream({
      ...request(),
      model: "openrouter:demo",
      signal: controller.signal,
    }));

    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { message: "cancelled while stream was pending" },
    });
  });

  it("reduces thrown provider details to a safe structured stream error", async () => {
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
    expect(events[0].error).toBeInstanceOf(ProviderModelError);
    expect(events[0].error).toMatchObject({
      category: "provider",
      retryable: false,
    });
    expect(events[0].error.message).not.toContain(secret);
  });

  it("exposes only structured status and category for a provider response", async () => {
    const faux = fauxProvider({ provider: "openrouter", models: [{ id: "demo" }] });
    const response = fauxAssistantMessage("", { stopReason: "error" });
    response.usage = {
      input: 7,
      output: 3,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 13,
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    };
    response.errorMessage = "HTTP 429 Bearer sk-provider-secret https://example.test/private";
    faux.setResponses([response]);
    const models = createModels();
    models.setProvider(faux.provider);
    const adapter = new PiAiModelPort({ models });

    const error = await adapter.complete(request()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderModelError);
    expect(error).toMatchObject({
      category: "rate-limit",
      status: 429,
      retryable: true,
      providerUsage: {
        input: expect.any(Number),
        output: expect.any(Number),
        cacheRead: expect.any(Number),
        cacheWrite: expect.any(Number),
        costUsd: expect.any(Number),
      },
    });
    expect((error as Error).message).not.toContain("sk-provider-secret");
    expect((error as Error).message).not.toContain("example.test");
  });

  it("disables pi-ai retries and captures only public retry response metadata", async () => {
    const faux = fauxProvider({ provider: "openrouter", models: [{ id: "demo" }] });
    const providerResponse = fauxAssistantMessage("", { stopReason: "error" });
    providerResponse.errorMessage = "private body with Bearer sample-credential https://private.test/path";
    const observed: Array<{ maxRetries?: number; fetch?: typeof globalThis.fetch }> = [];
    const models = {
      getModel: () => faux.getModel(),
      complete: async (
        _model: unknown,
        _context: unknown,
        options?: { maxRetries?: number; fetch?: typeof globalThis.fetch },
      ) => {
        observed.push(options ?? {});
        await options?.fetch?.("https://request.test");
        return providerResponse;
      },
    } as unknown as Models;
    const adapter = new PiAiModelPort({
      models,
      fetch: async () => new Response("private response", {
        status: 429,
        headers: {
          "retry-after-ms": "2500",
          "x-should-retry": "true",
          "x-private-header": "private-header-value",
        },
      }),
    });

    const error = await adapter.complete(request()).catch((caught: unknown) => caught);

    expect(observed).toHaveLength(1);
    expect(observed[0]?.maxRetries).toBe(0);
    expect(error).toBeInstanceOf(ProviderModelError);
    expect(error).toMatchObject({
      category: "rate-limit",
      status: 429,
      retryable: true,
      retryAfterMs: 2500,
    });
    expect(JSON.stringify(error)).not.toMatch(/credential|private|request\.test/i);
  });

  it("also disables hidden pi-ai retries on the streaming path", async () => {
    const faux = fauxProvider({ provider: "openrouter", models: [{ id: "demo" }] });
    const observed: Array<{ maxRetries?: number; fetch?: typeof globalThis.fetch }> = [];
    const models = {
      getModel: () => faux.getModel(),
      stream: (
        _model: unknown,
        _context: unknown,
        options?: { maxRetries?: number; fetch?: typeof globalThis.fetch },
      ) => {
        observed.push(options ?? {});
        return (async function* () {
          yield { type: "start" as const };
          yield {
            type: "done" as const,
            message: fauxAssistantMessage("done"),
          };
        })();
      },
    } as unknown as Models;
    const adapter = new PiAiModelPort({ models });

    const events = await collect(adapter.stream(request()));

    expect(events.at(-1)?.type).toBe("done");
    expect(observed).toHaveLength(1);
    expect(observed[0]?.maxRetries).toBe(0);
    expect(observed[0]?.fetch).toBeTypeOf("function");
  });

  it.each([
    ["HTTP 401 invalid API key", "authentication", 401],
    ["HTTP 403 forbidden", "permission", 403],
    ["HTTP 429 insufficient credits quota", "quota", 429],
    ["HTTP 422 invalid request", "invalid-request", 422],
  ])("never marks a permanent failure retryable: %s", async (message, category, status) => {
    const faux = fauxProvider({ provider: "openrouter", models: [{ id: "demo" }] });
    const response = fauxAssistantMessage("", { stopReason: "error" });
    response.errorMessage = message;
    faux.setResponses([response]);
    const models = createModels();
    models.setProvider(faux.provider);
    const adapter = new PiAiModelPort({ models });

    const error = await adapter.complete(request()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderModelError);
    expect(error).toMatchObject({ category, status, retryable: false });
  });

  it.each([
    ["HTTP 408 request timeout", "timeout", 408],
    ["HTTP 409 conflict", "transient", 409],
    ["HTTP 503 unavailable", "server", 503],
  ])("marks only a transient HTTP failure retryable: %s", async (message, category, status) => {
    const faux = fauxProvider({ provider: "openrouter", models: [{ id: "demo" }] });
    const response = fauxAssistantMessage("", { stopReason: "error" });
    response.errorMessage = message;
    faux.setResponses([response]);
    const models = createModels();
    models.setProvider(faux.provider);
    const adapter = new PiAiModelPort({ models });

    const error = await adapter.complete(request()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderModelError);
    expect(error).toMatchObject({ category, status, retryable: true });
  });

  it("honors a provider's public no-retry directive", async () => {
    const faux = fauxProvider({ provider: "openrouter", models: [{ id: "demo" }] });
    const response = fauxAssistantMessage("", { stopReason: "error" });
    response.errorMessage = "opaque failure";
    const models = fetchCallingModels(faux.getModel(), response);
    const adapter = new PiAiModelPort({
      models,
      fetch: async () => new Response("private", {
        status: 503,
        headers: { "x-should-retry": "false" },
      }),
    });

    const error = await adapter.complete(request()).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ category: "server", status: 503, retryable: false });
  });

  it("classifies a transport rejection without exposing its payload", async () => {
    const faux = fauxProvider({ provider: "openrouter", models: [{ id: "demo" }] });
    const response = fauxAssistantMessage("", { stopReason: "error" });
    response.errorMessage = "opaque failure";
    const secret = "network https://private.test Bearer sample-credential";
    const models = fetchCallingModels(faux.getModel(), response);
    const adapter = new PiAiModelPort({
      models,
      fetch: async () => { throw new Error(secret); },
    });

    const error = await adapter.complete(request()).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ category: "network", retryable: true });
    expect((error as Error).message).not.toContain(secret);
    expect(JSON.stringify(error)).not.toMatch(/credential|private/i);
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

function fetchCallingModels(
  model: ReturnType<ReturnType<typeof fauxProvider>["getModel"]>,
  response: ReturnType<typeof fauxAssistantMessage>,
): Models {
  return {
    getModel: () => model,
    complete: async (
      _model: unknown,
      _context: unknown,
      options?: { fetch?: typeof globalThis.fetch },
    ) => {
      try {
        await options?.fetch?.("https://request.test");
      } catch {
        // pi-ai converts transport throws to an AssistantMessage error.
      }
      return response;
    },
  } as unknown as Models;
}
