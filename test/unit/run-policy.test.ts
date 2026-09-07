import { describe, expect, it } from "vitest";

import { resolveRunPolicy } from "../../src/runtime/run-policy.js";

describe("run policy", () => {
  it("makes Worker delegation available by default without activating Teto automatically", () => {
    expect(resolveRunPolicy()).toMatchObject({
      workerEnabled: true,
      tetoEnabled: true,
      tetoActivation: "manual",
    });
  });

  it("preserves explicit Worker and Teto opt-outs", () => {
    expect(resolveRunPolicy({ workerEnabled: false, tetoEnabled: false }))
      .toMatchObject({ workerEnabled: false, tetoEnabled: false });
  });

  it("gives tool-using Teto room for complete messages and preserves explicit output caps", () => {
    expect(resolveRunPolicy().tetoMaxOutputTokens).toBe(1_024);
    expect(resolveRunPolicy({ tetoMaxOutputTokens: 64 }).tetoMaxOutputTokens).toBe(64);
  });

  it("leaves compaction composition to CLI settings or the embedding API caller", () => {
    expect(resolveRunPolicy().fukaiCompaction).toBeUndefined();
  });

  it("does not impose an aggregate token limit by default", () => {
    const policy = resolveRunPolicy({ tetoEnabled: false });

    expect(policy.maxModelTokens).toBeUndefined();
    expect(policy.tetoTokenRatio).toBeUndefined();
  });

  it("preserves an explicitly configured aggregate token limit", () => {
    expect(resolveRunPolicy({
      maxModelTokens: 1_234,
      tetoTokenRatio: 0.25,
      tetoEnabled: false,
    })).toMatchObject({ maxModelTokens: 1_234, tetoTokenRatio: 0.25 });
  });
});
