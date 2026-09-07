import { CURSOR_MARKER, Input, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi, type MockInstance } from "vitest";

import { AuthMenu, FullScreenMenuPage } from "../../src/cli/auth-menu.js";
import { SelectorOverlay } from "../../src/cli/selector-component.js";
import {
  CONFIGURATION_MENU_TABS,
  ConfigurationMenu,
  type ConfigurationMenuTab,
} from "../../src/cli/configuration-menu.js";

function fixture() {
  const pages = new Map<ConfigurationMenuTab, {
    input: Input;
    inputSpy: MockInstance<(data: string) => void>;
    dispose: ReturnType<typeof vi.fn>;
    invalidate: MockInstance<() => void>;
  }>();
  const requestRender = vi.fn();
  const createPage = vi.fn((tab: ConfigurationMenuTab) => {
    const input = new Input();
    const inputSpy = vi.spyOn(input, "handleInput");
    const invalidate = vi.spyOn(input, "invalidate");
    const dispose = vi.fn();
    pages.set(tab, { input, inputSpy, dispose, invalidate });
    return { component: input, dispose };
  });
  const menu = new ConfigurationMenu({ initialTab: "providers", createPage, requestRender });
  return { menu, pages, createPage, requestRender };
}

describe("ConfigurationMenu", () => {
  it("constructs only visited pages and retains their input state", () => {
    const { menu, pages, createPage } = fixture();
    expect(createPage).not.toHaveBeenCalled();
    menu.focused = true;
    expect(createPage).toHaveBeenCalledExactlyOnceWith("providers");
    menu.handleInput("subscription");
    menu.setActiveTab("models");
    menu.handleInput("gpt");
    menu.setActiveTab("providers");
    expect(createPage).toHaveBeenCalledTimes(2);
    expect(pages.get("providers")?.input.getValue()).toBe("subscription");
    expect(pages.get("models")?.input.getValue()).toBe("gpt");
    expect(pages.get("providers")?.dispose).not.toHaveBeenCalled();
    expect(pages.get("models")?.dispose).not.toHaveBeenCalled();
  });

  it("moves focus only to the active page and preserves hidden page cursors", () => {
    const { menu, pages } = fixture();
    menu.focused = true;
    menu.handleInput("openai");
    menu.handleInput("\x1b[D");
    const focusedInput = pages.get("providers")?.input.render(78);
    menu.setActiveTab("models");
    expect(pages.get("providers")?.input.focused).toBe(false);
    expect(pages.get("models")?.input.focused).toBe(true);
    menu.setActiveTab("providers");
    expect(pages.get("providers")?.input.focused).toBe(true);
    expect(pages.get("providers")?.input.render(78)).toEqual(focusedInput);
    menu.handleInput("X");
    expect(pages.get("providers")?.input.getValue()).toBe("openaXi");
    expect(menu.render(78).join("\n")).toContain(CURSOR_MARKER);
    menu.focused = false;
    expect(pages.get("providers")?.input.focused).toBe(false);
  });

  it("wraps Ctrl+Left/Right through all four tabs without consuming other navigation", () => {
    const { menu, pages, requestRender } = fixture();
    menu.focused = true;
    menu.handleInput("\x1b[1;5D");
    expect(menu.activeTab).toBe("skills");
    menu.handleInput("\x1b[1;5C");
    expect(menu.activeTab).toBe("providers");
    menu.handleInput("\x1b[1;5C");
    expect(menu.activeTab).toBe("models");
    for (const key of ["\t", "\x1b[Z", "\x1b[C", "\x1b[D", "\x1b", "\x03"]) {
      menu.handleInput(key);
      expect(pages.get("models")?.inputSpy).toHaveBeenLastCalledWith(key);
      expect(menu.activeTab).toBe("models");
    }
    expect(requestRender).toHaveBeenCalledTimes(3);
  });

  it("does not recreate or rerender when selecting the same tab", () => {
    const { menu, createPage, requestRender } = fixture();
    menu.setActiveTab("providers");
    expect(createPage).not.toHaveBeenCalled();
    menu.render(78);
    menu.setActiveTab("providers");
    expect(createPage).toHaveBeenCalledTimes(1);
    expect(requestRender).not.toHaveBeenCalled();
  });

  it("preserves the current page when another factory fails", () => {
    const input = new Input();
    const menu = new ConfigurationMenu({
      initialTab: "providers", requestRender: vi.fn(), createPage: (tab) => {
        if (tab === "models") throw new Error("Unavailable");
        return { component: input };
      },
    });
    menu.focused = true;
    expect(() => menu.setActiveTab("models")).toThrow("Unavailable");
    expect(menu.activeTab).toBe("providers");
    expect(input.focused).toBe(true);
  });

  it("invalidates only constructed pages, including inactive ones", () => {
    const { menu, pages, createPage } = fixture();
    menu.render(78);
    menu.setActiveTab("models");
    menu.invalidate();
    expect(createPage).toHaveBeenCalledTimes(2);
    expect(pages.get("providers")?.invalidate).toHaveBeenCalledOnce();
    expect(pages.get("models")?.invalidate).toHaveBeenCalledOnce();
  });

  it("disposes every visited page once and ignores all late activity", () => {
    const { menu, pages, createPage, requestRender } = fixture();
    menu.focused = true;
    menu.setActiveTab("models");
    menu.dispose();
    const renders = requestRender.mock.calls.length;
    menu.dispose();
    menu.focused = true;
    menu.handleInput("\x1b[1;5C");
    menu.handleInput("late input");
    menu.setActiveTab("skills");
    menu.invalidate();
    expect(menu.render(78)).toEqual([]);
    expect(menu.focused).toBe(false);
    expect(createPage).toHaveBeenCalledTimes(2);
    expect(requestRender).toHaveBeenCalledTimes(renders);
    for (const page of pages.values()) {
      expect(page.dispose).toHaveBeenCalledOnce();
      expect(page.input.focused).toBe(false);
      expect(page.input.getValue()).toBe("");
    }
  });

  it("cleans up a factory result returned after synchronous disposal", () => {
    const dispose = vi.fn();
    const input = new Input();
    const menu = new ConfigurationMenu({ initialTab: "providers", requestRender: vi.fn(), createPage: () => {
      menu.dispose();
      return { component: input, dispose };
    } });
    menu.focused = true;
    expect(dispose).toHaveBeenCalledOnce();
    expect(input.focused).toBe(false);
    expect(menu.focused).toBe(false);
    expect(menu.render(78)).toEqual([]);
  });

  it("continues cleanup if one page disposer throws", () => {
    const { menu, pages } = fixture();
    menu.focused = true;
    menu.setActiveTab("models");
    pages.get("providers")?.dispose.mockImplementation(() => { throw new Error("cleanup"); });
    expect(() => menu.dispose()).toThrow(AggregateError);
    expect(pages.get("models")?.dispose).toHaveBeenCalledOnce();
    expect(pages.get("models")?.input.focused).toBe(false);
    expect(menu.render(78)).toEqual([]);
    expect(() => menu.dispose()).not.toThrow();
  });

  it("accepts nonfocusable pages and falls back to their own disposer", () => {
    const component = { render: () => ["MCP"], invalidate: vi.fn(), dispose: vi.fn() };
    const menu = new ConfigurationMenu({ initialTab: "mcp", requestRender: vi.fn(), createPage: () => ({ component }) });
    menu.focused = true;
    expect(stripTerminalSequences(menu.render(24).join("\n"))).toContain("MCP");
    menu.handleInput("ignored");
    menu.dispose();
    expect(component.dispose).toHaveBeenCalledOnce();
  });

  it.each([1, 2, 4, 8, 24, 38, 40, 78, 100])("wraps navigation inside %i columns without changing tab geometry", (width) => {
    const { menu } = fixture();
    const initialRows = menu.render(width).length;
    for (const tab of CONFIGURATION_MENU_TABS) {
      menu.setActiveTab(tab);
      const lines = menu.render(width);
      expect(lines.length).toBe(initialRows);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      if (width >= 24) {
        const text = stripTerminalSequences(lines.join("\n"));
        for (const label of ["Nausicaa", "Providers", "Models", "MCP", "Skills"]) expect(text).toContain(label);
      }
    }
  });

  it.each([{ columns: 100, rows: 28 }, { columns: 40, rows: 14 }, { columns: 24, rows: 14 }])(
    "reserves the wrapped header while preserving the active choice at $columns x $rows",
    ({ columns, rows }) => {
      const menu: ConfigurationMenu = new ConfigurationMenu({ initialTab: "providers", requestRender: vi.fn(), createPage: () => ({
        component: new AuthMenu({
          title: "Providers", choices: [{ value: "openai", label: "OpenAI", detail: "API key" }],
          getRows: () => menu.getPageRows(rows), onSelect: vi.fn(), onCancel: vi.fn(),
        }),
      }) });
      const page = new FullScreenMenuPage(menu, { getRows: () => rows });
      page.focused = true;
      const lines = page.render(columns);
      expect(lines).toHaveLength(rows);
      for (const line of lines) expect(visibleWidth(line)).toBe(columns);
      const text = stripTerminalSequences(lines.join("\n"));
      expect(text).toContain("Nausicaa");
      expect(text).toContain("OpenAI");
      expect(lines.join("\n")).toContain(CURSOR_MARKER);
    },
  );

  it("keeps both selected model rows below wrapped tabs and facets at 40 x 14", () => {
    const menu: ConfigurationMenu = new ConfigurationMenu({
      initialTab: "models", requestRender: vi.fn(), createPage: () => ({
        component: new SelectorOverlay({
          title: "Models", presentation: "panel", subtitle: "Available models", searchLabel: "Search models",
          getRows: () => menu.getPageRows(14),
          filters: [
            { key: "scope", label: "Scope", options: [{ value: "configured", label: "Configured" }, { value: "all", label: "All" }] },
            { key: "provider", label: "Provider", options: [{ value: "openrouter", label: "OpenRouter" }, { value: "all", label: "All" }] },
          ],
          options: [{ value: "model", label: "Selected model", description: "Selected model description" }],
          onSelect: vi.fn(), onCancel: vi.fn(),
        }),
      }),
    });
    const page = new FullScreenMenuPage(menu, { getRows: () => 14 });
    page.focused = true;
    const lines = page.render(40);
    const text = stripTerminalSequences(lines.join("\n"));
    expect(lines).toHaveLength(14);
    expect(text).toContain("Selected model description");
    expect(text).toContain("[Models]");
    expect(text).toContain("Provider:");
    expect(lines.join("\n")).toContain(CURSOR_MARKER);
  });
});
