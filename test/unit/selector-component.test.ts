import { CURSOR_MARKER, stripTerminalSequences, type Terminal, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { AuthMenu, renderAuthPanel } from "../../src/cli/auth-menu.js";
import { SelectorOverlay, type SelectorOverlayOptions } from "../../src/cli/selector-component.js";

describe("SelectorOverlay", () => {
  const options = [
    { value: "openrouter:deepseek/v4", label: "DeepSeek", description: "Main lane" },
    { value: "openrouter:qwen/qwen3", label: "Qwen", description: "Teto lane" },
    { value: "scripted", label: "Scripted", description: "Offline test model" },
  ] as const;

  it("updates the result count after facet and search changes", () => {
    const overlay = new SelectorOverlay({
      title: "Models",
      subtitle: (visible) => `${visible.length} models`,
      options,
      filters: [{
        key: "scope", label: "Scope",
        options: [{ value: "all", label: "All" }, { value: "local", label: "Local" }],
      }],
      filterOptions: (items, values) => values.scope === "local" ? items.slice(2) : items,
      onSelect: () => {},
      onCancel: () => {},
    });
    const rendered = () => stripTerminalSequences(overlay.render(80).join("\n"));
    expect(rendered()).toContain("3 models");
    overlay.handleInput("\x1b[C");
    expect(rendered()).toContain("1 models");
    overlay.handleInput("missing");
    expect(rendered()).toContain("0 models");
  });

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

  it("focuses the best search match instead of retaining a weaker previous selection", () => {
    const overlay = new SelectorOverlay({
      title: "Models",
      options: [
        { value: "anthropic:openai-lookalike", label: "Other model mentioning openai" },
        { value: "openai:test-model", label: "OpenAI model" },
      ],
      current: "anthropic:openai-lookalike",
      onSelect: () => {},
      onCancel: () => {},
    });
    overlay.handleInput("OpenAI model");
    expect(overlay.getSelectedValue()).toBe("openai:test-model");
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

  it("filters model rows by provider while preserving the qualified selector", () => {
    const overlay = new SelectorOverlay({
      title: "Models",
      searchLabel: "Search models",
      filters: [{
        key: "provider",
        label: "Provider",
        current: "all",
        options: [
          { value: "all", label: "All" },
          { value: "openai", label: "OpenAI" },
          { value: "anthropic", label: "Anthropic" },
        ],
      }],
      options: [
        { value: "openai:gpt-5.4", label: "OpenAI / GPT-5.4" },
        { value: "anthropic:claude-sonnet-4-5", label: "Anthropic / Claude" },
      ],
      filterOptions: (options, values) => values.provider === "all"
        ? options
        : options.filter((option) => option.value.startsWith(`${values.provider}:`)),
      onSelect: () => {},
      onCancel: () => {},
    });

    expect(overlay.getSelectedValue()).toBe("openai:gpt-5.4");
    overlay.handleInput("\t");
    overlay.handleInput("\x1b[C");
    expect(overlay.getSelectedValue()).toBe("openai:gpt-5.4");
    expect(overlay.render(120).join("\n")).toContain("Provider: All [OpenAI] Anthropic");
  });

  it("keeps long provider facets readable by showing the active value and count", () => {
    const overlay = new SelectorOverlay({
      title: "Models",
      searchLabel: "Search models",
      filters: [{
        key: "provider",
        label: "Provider",
        current: "all",
        options: [
          { value: "all", label: "All" },
          ...Array.from({ length: 40 }, (_, index) => ({
            value: `provider-${index}`,
            label: `Provider ${index}`,
          })),
        ],
      }],
      options: [{ value: "provider-0:model", label: "Provider 0 / model" }],
      onSelect: () => {},
      onCancel: () => {},
    });

    expect(overlay.render(80).join("\n")).toContain("Provider: [All] (1/41)");
    overlay.handleInput("\x1b[C");
    expect(overlay.render(80).join("\n")).toContain("Provider: [Provider 0] (2/41)");
  });

  it.each([44, 80, 120])("keeps both model facets visible at %i columns", (width) => {
    const overlay = new SelectorOverlay({
      title: "Models",
      searchLabel: "Search models",
      filters: [
        {
          key: "scope", label: "Scope",
          options: [{ value: "configured", label: "Configured" }, { value: "all", label: "All" }],
        },
        {
          key: "provider", label: "Provider", current: "openrouter",
          options: [
            { value: "all", label: "All" },
            { value: "anthropic", label: "Anthropic" },
            { value: "openai", label: "OpenAI" },
            { value: "openrouter", label: "OpenRouter" },
          ],
        },
      ],
      options: [],
      onSelect: () => {},
      onCancel: () => {},
    });
    const rows = overlay.render(width).map(stripTerminalSequences);
    expect(rows.join("\n")).toContain("Scope: [Configured] All");
    expect(rows.join("\n")).toContain("[OpenRouter]");
    expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
  });
});

describe("SelectorOverlay panel presentation", () => {
  const options = Array.from({ length: 24 }, (_, index) => ({
    value: `openai:model-${index}`,
    label: `Model ${index}`,
    description: index === 19 ? "OpenAI - current model" : "OpenAI - configured",
  }));
  const create = (overrides: Partial<SelectorOverlayOptions> = {}): SelectorOverlay => new SelectorOverlay({
    title: "Models",
    presentation: "panel",
    subtitle: (visible) => `${visible.length} models`,
    searchLabel: "Search models",
    filters: [
      { key: "scope", label: "Scope", options: [{ value: "configured", label: "Configured" }, { value: "all", label: "All" }] },
      { key: "provider", label: "Provider", options: [{ value: "all", label: "All" }, { value: "openai", label: "OpenAI" }] },
    ],
    options,
    current: "openai:model-19",
    onSelect: () => {},
    onCancel: () => {},
    ...overrides,
  });

  it.each([24, 40, 78, 100].flatMap((width) => [12, 20, 40].map((rows) => ({ width, rows }))))(
    "keeps the active model, facets and solid background inside $width columns and $rows rows",
    ({ width, rows }) => {
      const selector = create({ getRows: () => rows });
      selector.focused = true;
      const frame = selector.render(width);
      const text = frame.map(stripTerminalSequences).join("\n");
      expect(frame.length).toBeLessThanOrEqual(rows - 2);
      expect(frame[0]).toBe(renderAuthPanel([], width)[0]);
      expect(frame.at(-1)).toBe(renderAuthPanel([], width).at(-1));
      expect(text).toContain("Model 19");
      expect(text).toContain("Scope:");
      expect(text).toContain("Provider:");
      expect(text).toContain("current");
      expect(frame.join("\n")).toContain(CURSOR_MARKER);
      for (const line of frame) {
        expect(visibleWidth(line)).toBe(width);
        expect(line).toMatch(/^\x1b\[48;2;\d+;\d+;\d+m/);
      }
    },
  );

  it("uses the shared selected-row fill for both model and detail lines", () => {
    const selector = create({ options: [options[19]!], getRows: () => 40 });
    const rows = selector.render(78);
    const selectedStyle = renderAuthPanel([""], 78, new Set([0]))[1]!.split("m")[0] + "m";
    const name = rows.find((line) => stripTerminalSequences(line).includes("Model 19"));
    const detail = rows.find((line) => stripTerminalSequences(line).includes("current model"));
    expect(name?.startsWith(selectedStyle)).toBe(true);
    expect(detail?.startsWith(selectedStyle)).toBe(true);
    expect(rows[0]?.startsWith(selectedStyle)).toBe(false);
  });

  it("preserves filters, search results and current selection while changing presentation", () => {
    const onSelect = vi.fn();
    const selector = create({
      onSelect,
      filterOptions: (items, filters) => filters.scope === "all" ? items : items.slice(19),
    });
    expect(selector.getSelectedValue()).toBe("openai:model-19");
    expect(stripTerminalSequences(selector.render(100).join("\n"))).toContain("5 models");
    selector.handleInput("\x1b[C");
    expect(stripTerminalSequences(selector.render(100).join("\n"))).toContain("24 models");
    selector.handleInput("Model 23");
    expect(selector.getSelectedValue()).toBe("openai:model-23");
    selector.handleInput("\r");
    expect(onSelect).toHaveBeenCalledWith("openai:model-23");
  });

  it("keeps loading and empty states inside the same panel without selecting disabled rows", () => {
    const onSelect = vi.fn();
    const loading = create({ options: [{ value: "loading", label: "Loading models...", disabled: true }], onSelect });
    expect(stripTerminalSequences(loading.render(78).join("\n"))).toContain("Loading models...");
    loading.handleInput("\r");
    expect(onSelect).not.toHaveBeenCalled();
    loading.handleInput("missing");
    expect(stripTerminalSequences(loading.render(78).join("\n"))).toContain("No matching models");
    loading.handleInput("\r");
    expect(onSelect).not.toHaveBeenCalled();
    for (const line of loading.render(78)) expect(line).toMatch(/^\x1b\[48;2;/);
  });

  it("uses the adaptive visible page size after the terminal shrinks", () => {
    let rows = 40;
    const selector = create({ current: options[0]!.value, getRows: () => rows });
    selector.render(100);
    selector.handleInput("\x1b[6~");
    expect(selector.getSelectedValue()).toBe("openai:model-8");
    rows = 12;
    selector.render(40);
    selector.handleInput("\x1b[6~");
    expect(selector.getSelectedValue()).toBe("openai:model-9");
  });

  it.each([4, 8, 12])("does not exceed %i columns on unusually narrow terminals", (width) => {
    for (const line of create().render(width)) expect(visibleWidth(line)).toBe(width);
  });

  it("retains the same surface when the fullscreen overlay advances from provider to model", () => {
    const terminal: Terminal = {
      columns: 120, rows: 24, kittyProtocolActive: false,
      start: () => {}, stop: () => {}, drainInput: async () => {}, write: () => {}, moveBy: () => {},
      hideCursor: () => {}, showCursor: () => {}, clearLine: () => {}, clearFromCursor: () => {},
      clearScreen: () => {}, setTitle: () => {}, setProgress: () => {},
    };
    class PanelScreen extends TuiAltScreen {
      frame: readonly string[] = [];
      protected override compositeOverlays(lines: string[], width: number, height: number): string[] {
        const frame = super.compositeOverlays(lines, width, height);
        this.frame = [...frame];
        return frame;
      }
    }
    const tui = new PanelScreen(terminal);
    tui.setLayoutRoot({ render: (width) => Array.from({ length: terminal.rows }, () => ".".repeat(width)), invalidate: () => {} });
    tui.start();
    try {
      const provider = new AuthMenu({
        title: "Providers", choices: [{ value: "openai", label: "OpenAI", detail: "API key" }],
        getRows: () => terminal.rows, onSelect: () => {}, onCancel: () => {},
      });
      const overlayOptions = { anchor: "center" as const, width: 78, maxHeight: "100%" as const, margin: 1 };
      const providerHandle = tui.showOverlay(provider, overlayOptions);
      tui.renderNow();
      const providerTop = Math.floor((terminal.rows - provider.render(78).length) / 2);
      const providerFill = tui.frame[providerTop];
      providerHandle.hide();

      const model = create({ getRows: () => terminal.rows });
      const modelHandle = tui.showOverlay(model, overlayOptions);
      tui.renderNow();
      const modelTop = Math.floor((terminal.rows - model.render(78).length) / 2);
      expect(tui.frame[modelTop]).toBe(providerFill);
      expect(stripTerminalSequences(tui.frame[modelTop + 1]!).indexOf("Models")).toBe(23);
      expect(tui.frame.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
      expect(tui.getFocusedComponent()).toBe(model);
      for (const line of tui.frame) expect(visibleWidth(line)).toBe(120);
      modelHandle.hide();
    } finally {
      tui.stop();
    }
  });
});
