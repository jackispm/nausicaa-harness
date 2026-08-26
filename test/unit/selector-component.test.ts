import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { SelectorOverlay } from "../../src/cli/selector-component.js";

describe("SelectorOverlay", () => {
  const options = [
    { value: "openrouter:deepseek/v4", label: "DeepSeek", description: "Main lane" },
    { value: "openrouter:qwen/qwen3", label: "Qwen", description: "Teto lane" },
    { value: "scripted", label: "Scripted", description: "Offline test model" },
  ] as const;

  it("filters by label/value/description and confirms the selected item", () => {
    const selected: string[] = [];
    const overlay = new SelectorOverlay({
      title: "Models",
      options,
      onSelect: (value) => selected.push(value),
      onCancel: () => {},
    });

    overlay.focused = true;
    expect(overlay.getSearchInput().focused).toBe(true);
    overlay.handleInput("deep");
    expect(overlay.getSelectedValue()).toBe("openrouter:deepseek/v4");
    overlay.handleInput("\r");
    expect(selected).toEqual(["openrouter:deepseek/v4"]);

    overlay.handleInput("\u007f");
    expect(overlay.getSearchInput().getValue()).toBe("dee");
  });

  it("navigates with wraparound and cancels with escape", () => {
    const selected: string[] = [];
    let cancelled = 0;
    const overlay = new SelectorOverlay({
      title: "Models",
      options,
      current: "openrouter:deepseek/v4",
      onSelect: (value) => selected.push(value),
      onCancel: () => { cancelled += 1; },
    });

    overlay.handleInput("\x1b[A");
    expect(overlay.getSelectedValue()).toBe("scripted");
    overlay.handleInput("\x1b[B");
    expect(overlay.getSelectedValue()).toBe("openrouter:deepseek/v4");
    overlay.handleInput("\x1b");
    expect(cancelled).toBe(1);
  });

  it("moves through long result sets by page", () => {
    const manyOptions = Array.from({ length: 20 }, (_, index) => ({
      value: `model-${index}`,
      label: `Model ${index}`,
    }));
    const overlay = new SelectorOverlay({
      title: "Models",
      options: manyOptions,
      current: "model-0",
      onSelect: () => {},
      onCancel: () => {},
    });

    overlay.handleInput("\x1b[6~");
    expect(overlay.getSelectedValue()).toBe("model-8");
    overlay.handleInput("\x1b[5~");
    expect(overlay.getSelectedValue()).toBe("model-0");
  });

  it.each([80, 12, 4])("keeps every rendered line within %i columns", (width) => {
    const overlay = new SelectorOverlay({
      title: "Models",
      subtitle: "Choose a model for the next Run",
      options,
      onSelect: () => {},
      onCancel: () => {},
    });
    for (const line of overlay.render(width)) {
      expect(visibleWidth(stripTerminalSequences(line))).toBeLessThanOrEqual(width);
    }
  });
});
