import { describe, expect, it } from "vitest";

import { createOpenRouterModelPort } from "../../src/model/index.js";

const apiKey = process.env.OPENROUTER_API_KEY;
const liveEnabled = process.env.NAUSICAA_LIVE_TESTS === "1"
  && apiKey !== undefined
  && apiKey.trim().length > 0;

const configuredModel = process.env.NAUSICAA_EVAL_MODEL ?? "openai/gpt-4.1-nano";
const model = configuredModel.startsWith("openrouter:")
  ? configuredModel
  : `openrouter:${configuredModel}`;

describe.skipIf(!liveEnabled)("OpenRouter live integration", () => {
  it("completes one tiny request through the real pi-ai adapter", async () => {
    const adapter = createOpenRouterModelPort();
    const response = await adapter.complete({
      runId: "live-openrouter",
      laneId: "main",
      sessionId: `live-openrouter-${Date.now()}`,
      model,
      systemPrompt: "Reply briefly.",
      messages: [{
        role: "user",
        content: "Reply with OK.",
        createdAt: new Date().toISOString(),
      }],
      tools: [],
      maxOutputTokens: 8,
      signal: AbortSignal.timeout(30_000),
    });

    expect(response.content.trim().length).toBeGreaterThan(0);
    expect(response.toolCalls).toEqual([]);
    expect(response.usage.input).toBeGreaterThan(0);
    expect(response.usage.output).toBeGreaterThanOrEqual(0);
  }, 35_000);
});
