import { describe, expect, it } from "vitest";

import { effectiveSystemPrompt } from "../../src/runtime/main-loop.js";

describe("Main collaboration guidance", () => {
  it("encourages early, focused Teto collaboration only when the tool is available", () => {
    const prompt = effectiveSystemPrompt({});
    expect(prompt).toContain("When teto_start is available, proactively open Teto early");
    expect(prompt).toContain("reason documents why to open the lane, not a task assignment to Teto");
    expect(prompt).toContain("Reuse an active Teto, keep working while it observes");
    expect(prompt).toContain("respect the host's permissions and budgets");
    expect(prompt).toContain("Brief factual answers and trivial one-step tasks usually do not need it");
    expect(effectiveSystemPrompt({ collaborationMode: "plan" })).toContain("Plan mode is active");
  });

  it("retains explicitly supplied system prompts", () => {
    expect(effectiveSystemPrompt({ systemPrompt: "Custom Main instructions" })).toBe("Custom Main instructions");
  });
});
