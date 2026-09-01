import { describe, expect, it } from "vitest";

import {
  BETA_HARD_BUDGET_USD,
  BETA_MODEL_SELECTOR,
  BETA_SOFT_BUDGET_USD,
  BetaBudgetError,
  BetaBudgetMeter,
  CappedBetaModel,
  BetaUsageError,
  betaArtifactPathIsScoped,
  betaSmokePreflight,
  normalizeBetaModel,
  readBetaSmokeConfig,
  redactedBetaFailure,
  verifyBetaSmokeArtifact,
} from "../live/openrouter-beta-harness.js";

describe("OpenRouter beta smoke offline contract", () => {
  it("normalizes only the pinned OpenRouter model", () => {
    expect(normalizeBetaModel("tencent/hy3")).toBe(BETA_MODEL_SELECTOR);
    expect(normalizeBetaModel("openrouter:tencent/hy3")).toBe(BETA_MODEL_SELECTOR);
    expect(() => normalizeBetaModel("openai/gpt-5-mini")).toThrow();
    expect(() => normalizeBetaModel("https://openrouter.ai/api/v1")).toThrow();
  });

  it("fails closed for missing authorization, budget, and dirty provenance", () => {
    const base = {
      liveRequested: true,
      apiKeyConfigured: false,
      modelInput: "tencent/hy3",
      model: BETA_MODEL_SELECTOR,
      budgetUsd: 0.85,
      tetoEnabled: false,
    } as const;
    expect(betaSmokePreflight(base).code).toBe("missing-api-key");
    const { budgetUsd: _budget, ...withoutBudget } = { ...base, apiKeyConfigured: true };
    expect(betaSmokePreflight(withoutBudget).code).toBe("missing-budget");
    expect(betaSmokePreflight({ ...base, apiKeyConfigured: true }, {
      executionCommit: "abc123",
      repositoryDirty: true,
    }).code).toBe("dirty-worktree");
    expect(betaSmokePreflight({ ...base, apiKeyConfigured: true, budgetUsd: 0.86 }).code)
      .toBe("budget-too-large");
  });

  it("caps requests and requires finite provider cost/usage", () => {
    const meter = new BetaBudgetMeter(BETA_SOFT_BUDGET_USD, 1, 8);
    meter.beforeRequest({ maxOutputTokens: 8 });
    expect(() => meter.beforeRequest({ maxOutputTokens: 8 })).toThrow(BetaBudgetError);
    expect(() => meter.charge({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }))
      .toThrow(BetaUsageError);
    meter.charge({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.01 });
    expect(meter.snapshot()).toMatchObject({ requestCount: 1, costUsd: 0.01 });
  });

  it("accepts only redacted, hard-budget-bounded artifacts", () => {
    const artifact = {
      schemaVersion: 1 as const,
      provider: "openrouter" as const,
      model: BETA_MODEL_SELECTOR,
      requestCount: 1,
      usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.01,
      status: "pass" as const,
      commit: "abc123",
    };
    expect(verifyBetaSmokeArtifact(artifact)).toEqual(artifact);
    expect(() => verifyBetaSmokeArtifact({ ...artifact, costUsd: BETA_HARD_BUDGET_USD + 0.01 }))
      .toThrow();
    expect(() => verifyBetaSmokeArtifact({ ...artifact, commit: "../../secret" }))
      .toThrow();
    expect(verifyBetaSmokeArtifact({ ...artifact, commit: "unknown" }).commit).toBe("unknown");
    expect(betaArtifactPathIsScoped("/tmp/not-nausicaa-evals.json")).toBe(false);
  });

  it("aborts a hanging provider at the wall-clock boundary", async () => {
    let aborted = false;
    const hanging: import("../../src/domain/index.js").ModelPort = {
      async complete(request) {
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) {
            aborted = true;
            resolve();
            return;
          }
          request.signal?.addEventListener("abort", () => {
            aborted = true;
            resolve();
          }, { once: true });
        });
        throw new Error("provider observed abort");
      },
    };
    const model = new CappedBetaModel(
      hanging,
      new BetaBudgetMeter(0.10, 1, 8),
      10,
    );
    await expect(model.complete({
      runId: "beta-timeout",
      laneId: "main",
      sessionId: "beta-timeout:main",
      model: BETA_MODEL_SELECTOR,
      systemPrompt: "",
      messages: [],
      tools: [],
      maxOutputTokens: 8,
    })).rejects.toThrow(/wall-clock timeout/u);
    expect(aborted).toBe(true);
  });

  it("redacts provider credentials from compatibility diagnostics", () => {
    expect(redactedBetaFailure(new Error("Bearer sk-or-v1-12345678901234567890")))
      .toBe("Bearer [REDACTED]");
  });

  it("does not infer a model or budget from unrelated environment variables", () => {
    const config = readBetaSmokeConfig({
      NAUSICAA_LIVE_TESTS: "0",
      NAUSICAA_EVAL_MODEL: "openai/gpt-5-mini",
      NAUSICAA_EVAL_BUDGET_USD: "0.85",
    });
    expect(config.model).toBeUndefined();
    expect(config.budgetUsd).toBe(0.85);
    expect(config.liveRequested).toBe(false);
  });

  it("rejects an explicit live model when the selector is omitted", () => {
    const result = betaSmokePreflight({
      liveRequested: true,
      apiKeyConfigured: true,
      budgetUsd: 0.85,
      tetoEnabled: false,
    });
    expect(result).toMatchObject({ ok: false, code: "missing-model" });
  });
});
