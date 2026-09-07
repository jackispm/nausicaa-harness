import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import type { ModelRequest, ModelStreamEvent } from "../../src/domain/index.js";
import { createBuiltinModelPort } from "../../src/model/index.js";

const routes = [
  { provider: "openai", origin: "https://api.openai.com", path: "/v1/responses", header: "authorization" },
  { provider: "anthropic", origin: "https://api.anthropic.com", path: "/v1/messages", header: "x-api-key" },
  { provider: "deepseek", origin: "https://api.deepseek.com", path: "/chat/completions", header: "authorization" },
  { provider: "openrouter", origin: "https://openrouter.ai", path: "/api/v1/chat/completions", header: "authorization" },
];

describe("built-in provider routing", () => {
  it.each(routes)("uses $provider's registered transport and isolated credential", async (route) => {
    const credentials = new InMemoryCredentialStore();
    for (const entry of routes) {
      await credentials.modify(entry.provider, async () => ({ type: "api_key", key: `test-${entry.provider}-key` }));
    }
    const requests: Request[] = [];
    const bodies: Record<string, unknown>[] = [];
    const adapter = createBuiltinModelPort({
      credentials,
      authContext: { env: async () => undefined, fileExists: async () => false },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const body = await request.json() as Record<string, unknown>;
        bodies.push(body);
        return providerResponse(route.provider, String(body.model));
      },
    });
    const model = adapter.catalog().find((entry) => entry.provider === route.provider)!;
    expect(model).toBeDefined();
    const request: ModelRequest = {
      runId: "provider-routing",
      laneId: "main",
      sessionId: "provider-routing-session",
      model: model.selector,
      systemPrompt: "Reply briefly.",
      messages: [{ role: "user", content: "Hello", createdAt: "2026-09-07T00:00:00.000Z" }],
      tools: [],
      maxOutputTokens: 100,
    };

    const result = await adapter.complete(request);
    expect(result.content).toBe("Hello from provider");
    expect(result.stopReason).toBe("stop");
    expect(result.usage).toMatchObject({ input: 10, output: 4 });

    const events: ModelStreamEvent[] = [];
    for await (const event of adapter.stream(request)) events.push(event);
    expect(events.filter((event) => event.type === "text-delta").map((event) => event.delta).join(""))
      .toBe("Hello from provider");
    expect(events.at(-1)).toMatchObject({ type: "done", response: { content: "Hello from provider" } });
    expect(requests).toHaveLength(2);
    for (const sent of requests) {
      expect(new URL(sent.url)).toMatchObject({ origin: route.origin, pathname: route.path });
      expect(sent.headers.get(route.header)).toBe(
        `${route.header === "authorization" ? "Bearer " : ""}test-${route.provider}-key`,
      );
      for (const other of routes.filter((entry) => entry.provider !== route.provider)) {
        expect(JSON.stringify([...sent.headers])).not.toContain(`test-${other.provider}-key`);
      }
    }
    for (const body of bodies) {
      expect(body.model).toBe(model.id);
      expect(JSON.stringify(body)).not.toContain(`test-${route.provider}-key`);
    }
  });
});

// Exercise the installed provider encoders and streaming decoders without a
// live account. Fixtures use each provider's public wire format.
function providerResponse(provider: string, model: string): Response {
  let events: Record<string, unknown>[];
  if (provider === "anthropic") {
    events = [
      { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model, content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello from provider" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } },
      { type: "message_stop" },
    ];
  } else if (provider === "openai") {
    const item = { id: "msg_test", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello from provider", annotations: [] }] };
    events = [
      { type: "response.created", response: { id: "resp_test", status: "in_progress", model } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Hello from provider" },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp_test", model, status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 0 } } } },
    ];
  } else {
    const chunk = { id: "chatcmpl_test", object: "chat.completion.chunk", created: 1, model };
    events = [
      { ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "Hello from provider" }, finish_reason: null }] },
      { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
    ];
  }
  const body = events.map((event) => `${typeof event.type === "string" ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
