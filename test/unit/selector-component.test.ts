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

  it("supports confirm/cancel for metadata-only multi-selects", () => {
    const selected: string[][] = [];
    let cancelled = 0;
    const overlay = new SelectorOverlay({
      title: "Skills",
      multiSelect: true,
      selectedValues: [options[0].value],
      options: options.map((option, index) => ({ ...option, disabled: index === 2 })),
      onSelect: () => {},
      onConfirm: (values) => selected.push([...values]),
      onCancel: () => { cancelled += 1; },
    });
    expect(overlay.getSelectedValues()).toEqual([options[0].value]);
    overlay.handleInput("\x1b[B");
    overlay.handleInput(" ");
    expect(overlay.getSelectedValues()).toEqual([options[0].value, options[1].value]);
    overlay.handleInput("\r");
    expect(selected).toEqual([[options[0].value, options[1].value]]);
    overlay.handleInput("\x1b");
    expect(cancelled).toBe(1);
    for (const width of [4, 20, 80]) {
      for (const line of overlay.render(width)) {
        expect(visibleWidth(stripTerminalSequences(line))).toBeLessThanOrEqual(width);
      }
    }
  });

  it("renders Codex-style facets and reprojects options without leaving the selector", () => {
    const overlay = new SelectorOverlay({
      title: "Resume a previous session",
      searchLabel: "Type to search",
      filters: [
        {
          key: "scope",
          label: "Filter",
          options: [{ value: "cwd", label: "Cwd" }, { value: "all", label: "All" }],
          current: "cwd",
        },
        {
          key: "status",
          label: "Status",
          options: [{ value: "active", label: "Active" }, { value: "archived", label: "Archived" }],
          current: "active",
        },
      ],
      options: [
        { value: "active-run", label: "2s ago", description: "Active task" },
        { value: "archived-run", label: "1d ago", description: "Archived task" },
      ],
      filterOptions: (options, values) => values.status === "archived" ? [options[1]!] : [options[0]!],
      onSelect: () => {},
      onCancel: () => {},
    });

    expect(overlay.render(120).join("\n")).toContain("Type to search    Filter: [Cwd] All    Status: [Active] Archived");
    expect(overlay.getSelectedValue()).toBe("active-run");
    overlay.handleInput("\t");
    overlay.handleInput("\x1b[C");
    expect(overlay.getSelectedValue()).toBe("archived-run");
    expect(overlay.render(120).join("\n")).toContain("Status: Active [Archived]");
  });
});
