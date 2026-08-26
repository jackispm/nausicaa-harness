import { describe, expect, it } from "vitest";

import {
  filterSelectorOptions,
  modelSelectorOptions,
  normalizeModelSelector,
  parseThemeChoice,
  themeSelectorOptions,
} from "../../src/cli/selectors.js";

describe("Prime-style CLI selectors", () => {
  it("filters options by value, label, and description", () => {
    const options = [
      { value: "openrouter:deepseek/deepseek-v4", label: "DeepSeek", description: "Main lane" },
      { value: "openrouter:qwen/qwen3", label: "Qwen", description: "Teto lane" },
    ];

    expect(filterSelectorOptions(options, "teto")).toEqual([options[1]]);
    expect(filterSelectorOptions(options, "DEEPSEEK")).toEqual([options[0]]);
    expect(filterSelectorOptions(options, "dsv4")).toEqual([options[0]]);
    expect(filterSelectorOptions(options)).toEqual(options);
  });

  it("deduplicates Main and Teto model candidates", () => {
    expect(modelSelectorOptions(
      "openrouter:main",
      "openrouter:main",
      ["openrouter:main", "openrouter:other"],
    )).toEqual([
      { value: "openrouter:main", label: "openrouter:main", description: "Main lane" },
      { value: "openrouter:other", label: "openrouter:other", description: "Configured candidate" },
    ]);
  });

  it("parses only supported theme choices", () => {
    expect(parseThemeChoice(" DARK ")).toBe("dark");
    expect(parseThemeChoice("auto")).toBe("auto");
    expect(themeSelectorOptions("light")).toHaveLength(3);
    expect(() => parseThemeChoice("solarized")).toThrow(/auto, light, or dark/);
  });

  it("rejects unsafe or ambiguous model selectors", () => {
    expect(normalizeModelSelector(" openrouter:main ")).toBe("openrouter:main");
    expect(() => normalizeModelSelector("openrouter:main other")).toThrow(/without spaces/);
    expect(() => normalizeModelSelector("\u0000")).toThrow(/without spaces/);
  });
});
