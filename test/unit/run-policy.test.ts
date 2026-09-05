import { describe, expect, it } from "vitest";

import { resolveRunPolicy } from "../../src/runtime/run-policy.js";

describe("run policy", () => {
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
