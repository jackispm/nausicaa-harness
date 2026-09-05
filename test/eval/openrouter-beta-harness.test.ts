import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BETA_HARD_BUDGET_USD,
  BETA_MAX_OUTPUT_TOKENS,
  BETA_MAX_REQUESTS,
  BETA_MODEL_SELECTOR,
  BETA_SOFT_BUDGET_USD,
  BetaBudgetError,
  BetaBudgetMeter,
  CappedBetaModel,
  BetaUsageError,
  betaArtifactPathIsScoped,
  betaSmokePreflight,
  classifyBetaFailure,
  normalizeBetaModel,
  readBetaSmokeConfig,
  readBetaSmokeArtifact,
  redactedBetaFailure,
  publicBetaSmokeSummary,
  writeBetaSmokeArtifact,
  verifyBetaSmokeArtifact,
} from "../live/openrouter-beta-harness.js";

describe("OpenRouter beta smoke offline contract", () => {
  it("normalizes only the pinned OpenRouter model", () => {
    expect(normalizeBetaModel("deepseek/deepseek-v4-pro-0813")).toBe(BETA_MODEL_SELECTOR);
    expect(normalizeBetaModel("openrouter:deepseek/deepseek-v4-pro-0813")).toBe(BETA_MODEL_SELECTOR);
    expect(() => normalizeBetaModel("openai/gpt-5-mini")).toThrow();
    expect(() => normalizeBetaModel("https://openrouter.ai/api/v1")).toThrow();
  });

  it("fails closed for every incomplete or unsafe preflight branch", () => {
    const base = {
      liveRequested: true,
      apiKeyConfigured: true,
      modelInput: "deepseek/deepseek-v4-pro-0813",
      model: BETA_MODEL_SELECTOR,
      budgetUsd: 0.85,
      tetoEnabled: false,
    } as const;
    expect(betaSmokePreflight({ ...base, liveRequested: false }).code).toBe("disabled");
    expect(betaSmokePreflight({ ...base, apiKeyConfigured: false }).code).toBe("missing-api-key");
    const { modelInput: _modelInput, model: _model, ...withoutModel } = base;
    expect(betaSmokePreflight(withoutModel).code).toBe("missing-model");
    const { model: _invalidModel, ...invalidModel } = {
      ...base,
      modelInput: "openai/gpt-5-mini",
    };
    expect(betaSmokePreflight(invalidModel).code).toBe("invalid-model");
    const { budgetUsd: _budget, ...withoutBudget } = base;
    expect(betaSmokePreflight(withoutBudget).code).toBe("missing-budget");
    expect(betaSmokePreflight({ ...base, budgetUsd: Number.NaN }).code).toBe("invalid-budget");
    expect(betaSmokePreflight({ ...base, budgetUsd: 0 }).code).toBe("invalid-budget");
    expect(betaSmokePreflight({ ...base, budgetUsd: 0.86 }).code).toBe("budget-too-large");
    expect(betaSmokePreflight(base, {
      executionCommit: "abc123",
      repositoryDirty: true,
    }).code).toBe("dirty-worktree");
  });

  it("caps requests and requires finite provider cost/usage", () => {
    expect(() => new BetaBudgetMeter(
      BETA_SOFT_BUDGET_USD,
      BETA_MAX_REQUESTS + 1,
      BETA_MAX_OUTPUT_TOKENS,
    )).toThrow(BetaBudgetError);
    expect(() => new BetaBudgetMeter(
      BETA_SOFT_BUDGET_USD,
      BETA_MAX_REQUESTS,
      BETA_MAX_OUTPUT_TOKENS + 1,
    )).toThrow(BetaBudgetError);
    const meter = new BetaBudgetMeter(BETA_SOFT_BUDGET_USD, 1, 8);
    expect(() => meter.beforeRequest({ maxOutputTokens: 9 })).toThrow(BetaBudgetError);
    meter.beforeRequest({ maxOutputTokens: 8 });
    expect(() => meter.beforeRequest({ maxOutputTokens: 8 })).toThrow(BetaBudgetError);
    expect(() => meter.charge({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }))
      .toThrow(BetaUsageError);
    for (const invalid of [
      { input: Number.NaN, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.01 },
      { input: 1, output: Number.POSITIVE_INFINITY, cacheRead: 0, cacheWrite: 0, costUsd: 0.01 },
      { input: 1, output: 1, cacheRead: -1, cacheWrite: 0, costUsd: 0.01 },
      { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: Number.NaN },
      { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: -0.01 },
    ]) {
      expect(() => meter.charge(invalid)).toThrow(BetaUsageError);
    }
    meter.charge({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.01 });
    expect(meter.snapshot()).toMatchObject({ requestCount: 1, costUsd: 0.01 });
    expect(() => meter.charge({
      input: 1,
      output: 9,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0.01,
    })).toThrow(BetaUsageError);
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
      elapsedMs: 42,
      failureCategory: null,
      nextOwner: null,
    };
    expect(verifyBetaSmokeArtifact(artifact)).toEqual(artifact);
    expect(() => verifyBetaSmokeArtifact({ ...artifact, costUsd: BETA_HARD_BUDGET_USD + 0.01 }))
      .toThrow();
    expect(() => verifyBetaSmokeArtifact({
      ...artifact,
      requestCount: BETA_MAX_REQUESTS + 1,
    })).toThrow(/request limit/u);
    expect(() => verifyBetaSmokeArtifact({
      ...artifact,
      usage: { ...artifact.usage, output: BETA_MAX_OUTPUT_TOKENS + 1 },
    })).toThrow(/output limit/u);
    expect(() => verifyBetaSmokeArtifact({ ...artifact, commit: "../../secret" }))
      .toThrow();
    expect(() => verifyBetaSmokeArtifact({ ...artifact, usage: { ...artifact.usage, input: Number.NaN } }))
      .toThrow();
    expect(() => verifyBetaSmokeArtifact({ ...artifact, prompt: "do not persist" }))
      .toThrow();
    expect(() => verifyBetaSmokeArtifact({
      ...artifact,
      usage: { ...artifact.usage, prompt: "do not persist" },
    })).toThrow();
    expect(() => verifyBetaSmokeArtifact({ ...artifact, elapsedMs: -1 }))
      .toThrow();
    expect(() => verifyBetaSmokeArtifact({ ...artifact, status: "failed", failureCategory: null, nextOwner: null }))
      .toThrow();
    expect(verifyBetaSmokeArtifact({ ...artifact, commit: "unknown" }).commit).toBe("unknown");
    expect(betaArtifactPathIsScoped("/tmp/not-nausicaa-evals.json")).toBe(false);
  });

  it("writes and reads only a scoped, redacted evidence record", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-beta-artifact-"));
    try {
      const artifact = {
        schemaVersion: 1 as const,
        provider: "openrouter" as const,
        model: BETA_MODEL_SELECTOR,
        requestCount: 1,
        usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0.01,
        status: "pass" as const,
        commit: "abc123",
        elapsedMs: 17,
        failureCategory: null,
        nextOwner: null,
      };
      const path = await writeBetaSmokeArtifact(artifact, root);
      expect(betaArtifactPathIsScoped(path, root)).toBe(true);
      expect(await readBetaSmokeArtifact(path, root)).toEqual(artifact);
      await expect(readBetaSmokeArtifact(path, join(root, "other"))).rejects.toThrow(/outside/u);
      const summary = publicBetaSmokeSummary(artifact);
      expect(summary).not.toMatch(/prompt|workspace|sk-or-v1|secret|README\.md/i);
      expect(summary).toContain('"elapsedMs":17');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  it("maps failure evidence to finite categories and owners", () => {
    expect(classifyBetaFailure(new BetaBudgetError("request cap")))
      .toMatchObject({ failureCategory: "budget-guard", nextOwner: "release-owner" });
    expect(classifyBetaFailure(new Error("OpenRouter returned 401 unauthorized")))
      .toMatchObject({ failureCategory: "provider-auth-failure", nextOwner: "provider-owner" });
    expect(classifyBetaFailure(new Error("tool schema is unsupported")))
      .toMatchObject({ failureCategory: "model-tool-call-incompatibility", nextOwner: "runtime-owner" });
    expect(classifyBetaFailure(new Error("Beta smoke wall-clock timeout")))
      .toMatchObject({ failureCategory: "timeout", nextOwner: "harness-owner" });
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
