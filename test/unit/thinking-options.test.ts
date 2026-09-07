import { describe, expect, it } from "vitest";

import { formatModelThinkingLabel, thinkingLevelChoices } from "../../src/cli/thinking-options.js";
import type { ThinkingLevel } from "../../src/domain/index.js";
import { createBuiltinModelPort } from "../../src/model/index.js";

const levels: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

describe("thinking-level choices", () => {
  it("uses Pi's qualitative descriptions without promising fixed token budgets", () => {
    const choices = thinkingLevelChoices({ levels });
    expect(choices.slice(1).map((choice) => [choice.value, choice.label, choice.detail])).toEqual([
      ["off", "off", "No reasoning"],
      ["minimal", "minimal", "Very brief reasoning"],
      ["low", "low", "Light reasoning"],
      ["medium", "medium", "Moderate reasoning"],
      ["high", "high", "Deep reasoning"],
      ["xhigh", "xhigh", "Extra-high reasoning"],
      ["max", "max", "Maximum reasoning"],
    ]);
    expect(choices.every((choice) => !/\d|tokens?/i.test(choice.detail ?? ""))).toBe(true);
  });

  it("keeps provider default separate from medium and marks it current when unset", () => {
    const choices = thinkingLevelChoices({ levels, current: undefined });
    expect(choices[0]).toEqual({
      value: "default",
      label: "Provider default",
      detail: "Use the provider's default reasoning",
      status: "current",
    });
    expect(choices.find((choice) => choice.value === "medium")).toEqual({
      value: "medium", label: "medium", detail: "Moderate reasoning",
    });
    expect(choices.filter((choice) => choice.status === "current")).toHaveLength(1);
  });

  it("distinguishes the selected level from a known explicit default", () => {
    const choices = thinkingLevelChoices({ levels, current: "high", defaultLevel: "medium" });
    expect(choices.find((choice) => choice.value === "medium")).toMatchObject({ detail: "Moderate reasoning (default)" });
    expect(choices.find((choice) => choice.value === "medium")).not.toHaveProperty("status");
    expect(choices.find((choice) => choice.value === "high")).toMatchObject({ detail: "Deep reasoning", status: "current" });
    expect(choices[0]).not.toHaveProperty("status");
  });

  it("does not add unsupported levels for either the current value or default marker", () => {
    const choices = thinkingLevelChoices({ levels: ["low", "high"], current: "max", defaultLevel: "medium" });
    expect(choices.map((choice) => choice.value)).toEqual(["default", "low", "high"]);
    expect(choices.some((choice) => choice.detail?.includes("(default)"))).toBe(false);
    expect(choices.some((choice) => choice.status === "current")).toBe(false);
  });

  it("offers only provider default when the model's supported levels are unknown", () => {
    expect(thinkingLevelChoices({ levels: [] })).toEqual([{
      value: "default", label: "Provider default", detail: "No adjustable reasoning levels", status: "current",
    }]);
  });

  it("keeps explicit off distinct from provider default", () => {
    expect(thinkingLevelChoices({ levels: ["off"], current: "off" })).toEqual([
      { value: "default", label: "Provider default", detail: "Use the provider's default reasoning" },
      { value: "off", label: "off", detail: "No reasoning", status: "current" },
    ]);
  });

  it("preserves provider ordering, deduplicates choices, and does not mutate inputs", () => {
    const supported: readonly ThinkingLevel[] = Object.freeze(["high", "low", "high"]);
    const choices = thinkingLevelChoices({ levels: supported });
    expect(choices.map((choice) => choice.value)).toEqual(["default", "high", "low"]);
    expect(supported).toEqual(["high", "low", "high"]);
    choices[1]!.detail = "changed by caller";
    expect(thinkingLevelChoices({ levels: supported })[1]?.detail).toBe("Deep reasoning");
  });

  it("uses exactly the supported concrete levels from the installed provider catalog", () => {
    const model = createBuiltinModelPort();
    const catalog = model.catalog();
    for (const reasoning of [false, true]) {
      const entry = catalog.find((candidate) => candidate.reasoning === reasoning);
      expect(entry).toBeDefined();
      const supported = model.capabilities(entry!.selector).thinkingLevels ?? [];
      expect(thinkingLevelChoices({ levels: supported }).slice(1).map((choice) => choice.value))
        .toEqual(supported);
    }
  });
});

describe("model thinking labels", () => {
  it("leaves the model name unchanged when no explicit level is selected", () => {
    const model = "openrouter:openai/model-name";
    expect(formatModelThinkingLabel(model)).toBe(model);
    expect(formatModelThinkingLabel(model, undefined)).toBe(model);
  });

  it.each(levels)("appends the explicit %s level, including off", (level) => {
    expect(formatModelThinkingLabel("model-name", level)).toBe(`model-name \u2022 ${level}`);
  });

  it("does not shorten or rewrite the provider selector", () => {
    const model = "openrouter:provider/model:variant";
    expect(formatModelThinkingLabel(model, "medium")).toBe(`${model} \u2022 medium`);
    expect(model).toBe("openrouter:provider/model:variant");
  });
});
