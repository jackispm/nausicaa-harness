import { describe, expect, it } from "vitest";

import { createOpenRouterModelPort } from "../../src/model/index.js";

const apiKey = process.env.OPENROUTER_API_KEY;
const configuredModel = process.env.NAUSICAA_EVAL_MODEL;
const budgetUsd = Number(process.env.NAUSICAA_EVAL_BUDGET_USD);
const liveEnabled = process.env.NAUSICAA_LIVE_TESTS === "1"
  && apiKey !== undefined
  && apiKey.trim().length > 0
  && configuredModel !== undefined
  && configuredModel.trim().length > 0
  && Number.isFinite(budgetUsd)
  && budgetUsd > 0;

const modelSelector = configuredModel ?? "disabled";
const model = modelSelector.startsWith("openrouter:")
  ? modelSelector
  : `openrouter:${modelSelector}`;

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
    expect(response.usage.costUsd).toBeLessThanOrEqual(budgetUsd);
  }, 35_000);
});
