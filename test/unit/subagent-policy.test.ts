import { describe, expect, it } from "vitest";

import {
  DEFAULT_SUBAGENT_MAX_DEPTH,
  MAX_SUBAGENT_DEPTH,
  MAX_SUBAGENT_MODEL_CANDIDATES,
  MAX_SUBAGENT_MODEL_SEARCH_LIMIT,
  MAX_SUBAGENT_NAME_LENGTH,
  assertSubagentSpawnAllowed,
  canSpawnSubagent,
  createCollisionResistantChildName,
  evaluateSubagentDepth,
  findSubagentModelMatches,
  normalizeSubagentMaxDepth,
  normalizeSubagentName,
  normalizeSubagentDepth,
  searchSubagentModelSelectors,
} from "../../src/runtime/subagent-policy.js";

describe("subagent policy", () => {
  it("validates absolute depth and computes one bounded child depth", () => {
    expect(evaluateSubagentDepth(0)).toEqual({
      depth: 0,
      maxDepth: DEFAULT_SUBAGENT_MAX_DEPTH,
      childDepth: 1,
      allowed: true,
    });
    expect(evaluateSubagentDepth(2, 2)).toMatchObject({
      childDepth: 3,
      allowed: false,
    });
    expect(assertSubagentSpawnAllowed(1, 2)).toBe(2);
    expect(canSpawnSubagent(0, 0)).toBe(false);
    expect(() => assertSubagentSpawnAllowed(2, 2)).toThrow(/depth limit reached/i);
  });

  it("rejects malformed or overlarge depth metadata", () => {
    expect(normalizeSubagentDepth(0)).toBe(0);
    expect(normalizeSubagentMaxDepth(MAX_SUBAGENT_DEPTH)).toBe(MAX_SUBAGENT_DEPTH);
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_SUBAGENT_DEPTH + 1]) {
      expect(() => normalizeSubagentDepth(value)).toThrow(/integer between 0 and/);
      expect(() => normalizeSubagentMaxDepth(value)).toThrow(/integer between 0 and/);
    }
    expect(() => evaluateSubagentDepth(3, 2)).toThrow(/cannot exceed maxDepth/);
  });

  it("normalizes explicit names into safe, bounded selector slugs", () => {
    expect(normalizeSubagentName("  API Reviewer / v2  ")).toBe("api-reviewer-v2");
    expect(normalizeSubagentName("Café" )).toBe("cafe");
    expect(() => normalizeSubagentName("all")).toThrow(/reserved/);
    expect(() => normalizeSubagentName("\u0000worker")).toThrow(/control/);
    expect(() => normalizeSubagentName("x".repeat(MAX_SUBAGENT_NAME_LENGTH + 1))).toThrow(/exceeds/);
    expect(() => normalizeSubagentName("中文")).toThrow(/ASCII/);
    expect(() => normalizeSubagentName("worker", { maxLength: 7 })).toThrow(/maxLength/);
  });

  it("keeps generated names readable, bounded, and distinct for colliding id tails", () => {
    const first = createCollisionResistantChildName(
      "Summarize the HTTP API!",
      "sub-prefix-a1b2c3d4",
    );
    const second = createCollisionResistantChildName(
      "Summarize the HTTP API!",
      "sub-other-a1b2c3d4",
    );
    expect(first).toMatch(/^subagent-summarize-the-http-api-a1b2c3d4-[a-f0-9]{8}$/);
    expect(second).not.toBe(first);
    expect(first.length).toBeLessThanOrEqual(MAX_SUBAGENT_NAME_LENGTH);

    const truncated = createCollisionResistantChildName("x".repeat(300), "sub-a1b2c3d4");
    expect(truncated.length).toBe(MAX_SUBAGENT_NAME_LENGTH);
    expect(truncated).toMatch(/a1b2c3d4-[a-f0-9]{8}$/);
  });

  it("searches only a bounded local model catalog with deterministic ranking", () => {
    const models = [
      { selector: "openrouter:qwen/qwen3", name: "Qwen 3" },
      { selector: "openrouter:anthropic/claude-sonnet", name: "Claude Sonnet" },
      { selector: "openrouter:deepseek/deepseek-v4", name: "DeepSeek V4" },
      "openrouter:other/model",
      "openrouter:QWEN/qwen3",
    ] as const;

    expect(searchSubagentModelSelectors("deepseek", models)).toEqual([
      "openrouter:deepseek/deepseek-v4",
    ]);
    expect(searchSubagentModelSelectors("qwen", models)).toEqual([
      "openrouter:qwen/qwen3",
    ]);
    expect(findSubagentModelMatches("sonnet", models, 1)).toEqual([
      {
        selector: "openrouter:anthropic/claude-sonnet",
        provider: "openrouter",
        id: "anthropic/claude-sonnet",
        name: "Claude Sonnet",
      },
    ]);
    expect(searchSubagentModelSelectors("", models, 2)).toEqual([
      "openrouter:anthropic/claude-sonnet",
      "openrouter:deepseek/deepseek-v4",
    ]);
    expect(() => searchSubagentModelSelectors("x", models, 0)).toThrow(/limit/);
    expect(() => searchSubagentModelSelectors("x", models, MAX_SUBAGENT_MODEL_SEARCH_LIMIT + 1)).toThrow(/limit/);
  });

  it("rejects untrusted model selectors and oversized catalogs", () => {
    expect(() => findSubagentModelMatches(42, [])).toThrow(/query/);
    expect(() => findSubagentModelMatches("x", ["openrouter:bad model"])).toThrow(/selector/);
    expect(() => findSubagentModelMatches(
      "x",
      Array.from({ length: MAX_SUBAGENT_MODEL_CANDIDATES + 1 }, (_, index) => `provider:model-${index}`),
    )).toThrow(/candidates/);
  });
});
