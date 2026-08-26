import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ModelResponse } from "../../src/domain/index.js";
import { createOpenRouterModelPort } from "../../src/model/index.js";

const apiKey = process.env.OPENROUTER_API_KEY;
const configuredModel = process.env.NAUSICAA_CACHE_EVAL_MODEL
  ?? process.env.NAUSICAA_EVAL_MODEL;
const budgetUsd = Number(
  process.env.NAUSICAA_CACHE_EVAL_BUDGET_USD
    ?? process.env.NAUSICAA_EVAL_BUDGET_USD,
);
const liveEnabled = process.env.NAUSICAA_LIVE_TESTS === "1"
  && apiKey !== undefined
  && apiKey.trim().length > 0
  && configuredModel !== undefined
  && configuredModel.trim().length > 0
  && Number.isFinite(budgetUsd)
  && budgetUsd > 0;
const model = configuredModel?.startsWith("openrouter:")
  ? configuredModel
  : `openrouter:${configuredModel ?? "disabled"}`;
const MAX_REQUESTS = 2;
const MAX_OUTPUT_TOKENS = 8;
describe.skipIf(!liveEnabled)("OpenRouter prompt-cache evidence", () => {
  it("reads a stable prefix on the second request and writes redacted evidence", async () => {
    const port = createOpenRouterModelPort();
    const probeId = randomUUID();
    const stableSystemPrompt = [
      `Stable evaluation prefix ${probeId}. Treat this as policy, not user data.`,
      ...Array.from({ length: 1_800 }, (_, index) =>
        `policy-${index % 17}: preserve the task objective and use only grounded evidence.`,
      ),
    ].join("\n");
    const base = {
      runId: "phase-2.3-cache-probe",
      laneId: "main" as const,
      sessionId: `phase-2.3-cache-probe:${probeId}`,
      model,
      systemPrompt: stableSystemPrompt,
      tools: [],
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    };

    const responses: ModelResponse[] = [];
    for (const content of ["first cache probe", "second cache probe"]) {
      if (responses.length >= MAX_REQUESTS) {
        throw new Error("Cache probe request limit exceeded");
      }
      responses.push(await port.complete({
        ...base,
        messages: [{
          role: "user",
          content,
          createdAt: new Date(0).toISOString(),
        }],
        signal: AbortSignal.timeout(20_000),
      }));
    }

    const spentUsd = responses.reduce((sum, response) =>
      sum + (response.usage.costUsd ?? Number.NaN), 0);
    expect(responses).toHaveLength(2);
    expect(responses.every((response) =>
      response.usage.costUsd !== undefined
      && Number.isFinite(response.usage.costUsd)
      && response.usage.costUsd >= 0,
    )).toBe(true);
    expect(spentUsd).toBeLessThanOrEqual(budgetUsd);
    expect(responses[1]?.usage.cacheRead ?? 0).toBeGreaterThan(0);

    const evidenceDir = join(process.cwd(), ".nausicaa", "evals");
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, "phase-2.3-cache.json"), JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      provider: "openrouter",
      model,
      sessionContinuity: "same-session-id",
      stablePrefix: "long-deterministic-system-prefix",
      limits: {
        maxRequests: MAX_REQUESTS,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        budgetUsd,
      },
      requests: responses.map((response, index) => ({
        ordinal: index + 1,
        inputTokens: response.usage.input,
        outputTokens: response.usage.output,
        cacheReadTokens: response.usage.cacheRead,
        cacheWriteTokens: response.usage.cacheWrite,
        costUsd: response.usage.costUsd,
      })),
      spentUsd,
      cacheReadTokens: responses.reduce(
        (sum, response) => sum + response.usage.cacheRead,
        0,
      ),
    }, null, 2), "utf8");
  }, 60_000);
});
