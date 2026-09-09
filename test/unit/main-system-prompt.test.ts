import { describe, expect, it } from "vitest";

import { effectiveSystemPrompt } from "../../src/runtime/main-loop.js";

describe("Nausicaa identity and collaboration guidance", () => {
  it("introduces Nausicaa and its default observer without a task-selection playbook", () => {
    const prompt = effectiveSystemPrompt({});
    expect(prompt).toMatch(/^You are Nausicaa, a next-generation general-purpose task agent\./u);
    expect(prompt).toContain("Teto is your auxiliary observer lane");
    expect(prompt).toContain("public messages and tool requests");
    expect(prompt).toContain("advice through A2A");
    expect(prompt).toContain("starts automatically by default");
    expect(prompt).toContain("teto_stop to stop it");
    expect(prompt).not.toContain("You are Main");
    expect(prompt.split(/\s+/u).length).toBeLessThan(120);
    expect(effectiveSystemPrompt({ collaborationMode: "plan" })).toContain("Plan mode is active");
  });

  it("describes explicit manual mode accurately and omits disabled Teto", () => {
    const manual = effectiveSystemPrompt({ policy: { tetoEnabled: true, tetoActivation: "manual" } });
    expect(manual).toContain("available on demand");
    expect(manual).toContain("teto_start to restart it");
    expect(manual).not.toContain("automatically");
    expect(effectiveSystemPrompt({ policy: { tetoEnabled: false } })).not.toContain("Teto");
  });

  it("omits lifecycle directions when control tools are absent from the request", () => {
    for (const options of [{ tetoControlsAvailable: false }, { collaborationMode: "plan" as const }]) {
      const prompt = effectiveSystemPrompt(options);
      expect(prompt).toContain("starts automatically by default");
      expect(prompt).not.toContain("teto_start");
      expect(prompt).not.toContain("teto_stop");
    }
  });

  it("retains explicitly supplied system prompts", () => {
    expect(effectiveSystemPrompt({ systemPrompt: "Custom Main instructions" })).toBe("Custom Main instructions");
  });
});
