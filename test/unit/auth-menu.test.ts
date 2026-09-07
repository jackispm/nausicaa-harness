import {
  CURSOR_MARKER,
  Input,
  stripTerminalSequences,
  type Terminal,
  TuiAltScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthMenu, type AuthMenuChoice, renderAuthPanel } from "../../src/cli/auth-menu.js";
import { getNausicaaColorScheme, setNausicaaColorScheme } from "../../src/cli/tui-components.js";

const choices: readonly AuthMenuChoice[] = [
  { value: "openai:oauth", label: "OpenAI", detail: "ChatGPT subscription", status: "Not configured" },
  { value: "openai:api_key", label: "OpenAI", detail: "API key", status: "Configured" },
  { value: "openrouter:api_key", label: "OpenRouter", detail: "API key", searchText: "router gateway" },
];

function createMenu(options: Partial<ConstructorParameters<typeof AuthMenu>[0]> = {}): AuthMenu {
  return new AuthMenu({ title: "Providers", choices, onSelect: () => {}, onCancel: () => {}, ...options });
}

function text(menu: AuthMenu, width = 78): string {
  return stripTerminalSequences(menu.render(width).join("\n"));
}

describe("AuthMenu", () => {
  const originalScheme = getNausicaaColorScheme();
  afterEach(() => setNausicaaColorScheme(originalScheme));

  it("shows method details beneath provider names and preserves distinct auth values", () => {
    const onSelect = vi.fn();
    const menu = createMenu({ onSelect });
    expect(text(menu)).toContain("ChatGPT subscription");
    expect(text(menu)).toContain("API key");
    menu.handleInput("\r");
    expect(onSelect).toHaveBeenLastCalledWith("openai:oauth");
    menu.handleInput("\x1b[B");
    menu.handleInput("\r");
    expect(onSelect).toHaveBeenLastCalledWith("openai:api_key");
  });

  it("selects the requested current value and clamps navigation at either end", () => {
    const menu = createMenu({ current: "openai:api_key" });
    expect(menu.getSelectedValue()).toBe("openai:api_key");
    menu.handleInput("\x1b[A");
    menu.handleInput("\x1b[A");
    expect(menu.getSelectedValue()).toBe("openai:oauth");
    for (let i = 0; i < 5; i += 1) menu.handleInput("\x1b[B");
    expect(menu.getSelectedValue()).toBe("openrouter:api_key");
  });

  it("matches method metadata and resets selection when the query changes", () => {
    const menu = createMenu({ current: "openrouter:api_key" });
    menu.handleInput("subscription");
    expect(menu.getQuery()).toBe("subscription");
    expect(menu.getSelectedValue()).toBe("openai:oauth");
  });

  it("does not reset the selected match when only the search cursor moves", () => {
    const menu = createMenu({ initialQuery: "OpenAI" });
    menu.handleInput("\x1b[B");
    const selected = menu.getSelectedValue();
    menu.handleInput("\x1b[D");
    expect(menu.getSelectedValue()).toBe(selected);
  });

  it("supports initial queries and provider aliases", () => {
    const menu = createMenu({ initialQuery: "gateway" });
    expect(menu.getQuery()).toBe("gateway");
    expect(menu.getSelectedValue()).toBe("openrouter:api_key");
    expect(text(menu)).not.toContain("ChatGPT subscription");
  });

  it("supports caller-owned search and empty-state labels without losing the cursor", () => {
    const menu = createMenu({ searchPlaceholder: "Search servers", emptyMessage: "No matching servers" });
    menu.focused = true;
    expect(text(menu)).toContain("Search servers");
    expect(menu.render(40).join("\n")).toContain(CURSOR_MARKER);
    menu.handleInput("zzzzzzzzzz");
    expect(text(menu)).toContain("No matching servers");
  });

  it("keeps query and selected value after choices refresh or reorder", () => {
    const menu = createMenu({ initialQuery: "API key", current: "openrouter:api_key" });
    menu.setChoices([...choices].reverse());
    expect(menu.getQuery()).toBe("API key");
    expect(menu.getSelectedValue()).toBe("openrouter:api_key");
    menu.setChoices(choices.slice(0, 2));
    expect(menu.getSelectedValue()).toBe("openai:api_key");
    menu.setChoices([]);
    expect(menu.getSelectedValue()).toBeUndefined();
  });

  it("does not select an empty result and supports Escape and Ctrl+C cancellation", () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const menu = createMenu({ onSelect, onCancel });
    menu.handleInput("zzzzzzzz");
    expect(text(menu)).toContain("No matching providers");
    menu.handleInput("\r");
    menu.handleInput("\x1b[B");
    menu.handleInput("\x1b[A");
    expect(onSelect).not.toHaveBeenCalled();
    expect(menu.getSelectedValue()).toBeUndefined();
    menu.handleInput("\x1b");
    menu.handleInput("\x03");
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("disables searching for short method-choice menus", () => {
    const menu = createMenu({ searchable: false, initialQuery: "ignored" });
    menu.focused = true;
    menu.handleInput("missing");
    expect(menu.getQuery()).toBe("");
    expect(menu.getSelectedValue()).toBe("openai:oauth");
    expect(text(menu)).not.toContain("Search providers");
    expect(menu.render(40).join("\n")).not.toContain(CURSOR_MARKER);
  });

  const manyChoices = Array.from({ length: 24 }, (_, index) => ({
    value: `provider-${index}`, label: `Provider ${index}`, detail: "API key", status: "Not configured",
  }));

  it("moves by a full visible page and keeps the selected row visible", () => {
    const menu = createMenu({ choices: manyChoices, getRows: () => 40 });
    menu.render(78);
    menu.handleInput("\x1b[6~");
    expect(menu.getSelectedValue()).toBe("provider-8");
    expect(text(menu)).toContain("Provider 8");
    menu.handleInput("\x1b[5~");
    expect(menu.getSelectedValue()).toBe("provider-0");
  });

  it.each([24, 40, 78, 100].flatMap((width) => [12, 20, 40].map((rows) => ({ width, rows }))))(
    "fits $width columns and $rows rows, including the active selection and cursor",
    ({ width, rows }) => {
      const menu = createMenu({
        choices: manyChoices,
        subtitle: "Connect with a subscription or API key.",
        current: "provider-19",
        getRows: () => rows,
      });
      menu.focused = true;
      const rendered = menu.render(width);
      expect(rendered.length).toBeLessThanOrEqual(rows - 2);
      for (const line of rendered) expect(visibleWidth(line)).toBe(width);
      expect(stripTerminalSequences(rendered.join("\n"))).toContain("Provider 19");
      expect(rendered.join("\n")).toContain(CURSOR_MARKER);
    },
  );

  it("never renders more than eight provider choices", () => {
    const menu = createMenu({ choices: manyChoices, getRows: () => 100 });
    expect(text(menu).match(/Provider \d+/g)).toHaveLength(8);
  });

  it("adapts page movement when a terminal becomes shorter", () => {
    let rows = 40;
    const menu = createMenu({ choices: manyChoices, getRows: () => rows });
    menu.render(78);
    rows = 12;
    menu.render(78);
    menu.handleInput("\x1b[6~");
    expect(menu.getSelectedValue()).toBe("provider-1");
  });

  it("shortens metadata before it hides the provider identity", () => {
    const menu = createMenu({ choices: [{
      value: "openrouter", label: "OpenRouter", detail: "API key", status: "Environment: VERY_LONG_OPENROUTER_API_KEY_NAME",
    }] });
    expect(text(menu, 24)).toContain("OpenRouter");
    expect(text(menu, 24)).not.toContain("VERY_LONG_OPENROUTER_API_KEY_NAME");
  });

  it("preserves a subscription provider name before spending width on a long status", () => {
    const menu = createMenu({ choices: [{
      value: "openai-codex", label: "OpenAI (ChatGPT Plus/Pro)", detail: "Subscription", status: "Configured through environment",
    }] });
    expect(text(menu, 40)).toContain("OpenAI (ChatGPT Plus/Pro)");
  });

  it("keeps metadata control sequences out of the terminal", () => {
    const menu = createMenu({ choices: [{
      value: "unsafe", label: "Open\x1b[2JAI", detail: "key\r\nvalue", status: "ok\x07",
    }] });
    const rendered = menu.render(40).join("\n");
    expect(rendered).not.toContain("\x1b[2J");
    expect(rendered).not.toContain("\r");
    expect(rendered).not.toContain("\x07");
    expect(stripTerminalSequences(rendered)).toContain("OpenAI");
  });

  it.each([1, 2, 3, 4, 8])("fits unusually narrow %i-column terminals", (width) => {
    for (const line of createMenu().render(width)) expect(visibleWidth(line)).toBe(width);
  });

  it("tracks the existing Nausicaa theme dynamically", () => {
    const menu = createMenu();
    setNausicaaColorScheme("light");
    const light = menu.render(40).join("\n");
    setNausicaaColorScheme("dark");
    const dark = menu.render(40).join("\n");
    expect(light).not.toBe(dark);
    expect(stripTerminalSequences(light)).toBe(stripTerminalSequences(dark));
  });
});

describe("renderAuthPanel", () => {
  it.each([24, 40, 78, 100])("pads content to %i columns without losing the input cursor", (width) => {
    const input = new Input();
    input.focused = true;
    input.handleInput("a long login prompt value".repeat(6));
    const content = input.render(width - 4);
    const panel = renderAuthPanel(content, width);
    expect(panel).toHaveLength(content.length + 2);
    expect(panel.join("\n")).toContain(CURSOR_MARKER);
    for (const line of panel) expect(visibleWidth(line)).toBe(width);
  });
});

class AuthTerminal implements Terminal {
  readonly kittyProtocolActive = false;
  readonly output: string[] = [];
  private onInput: ((data: string) => void) | undefined;
  private onResize: (() => void) | undefined;

  constructor(public columns: number, public rows: number) {}

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.onInput = onInput;
    this.onResize = onResize;
  }

  send(data: string): void { this.onInput?.(data); }
  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.onResize?.();
  }
  stop(): void { this.onInput = undefined; this.onResize = undefined; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.output.push(data); }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

class AuthScreen extends TuiAltScreen {
  frame: readonly string[] = [];

  protected override compositeOverlays(lines: string[], width: number, height: number): string[] {
    const frame = super.compositeOverlays(lines, width, height);
    this.frame = [...frame];
    return frame;
  }
}

describe("AuthMenu fullscreen integration", () => {
  it.each([
    { columns: 160, rows: 40 },
    { columns: 100, rows: 20 },
    { columns: 80, rows: 12 },
    { columns: 24, rows: 12 },
  ])("centers the live overlay in a $columns by $rows terminal and restores focus", ({ columns, rows }) => {
    const terminal = new AuthTerminal(columns, rows);
    const tui = new AuthScreen(terminal);
    const root = {
      focused: false,
      handleInput: vi.fn(),
      render: (width: number) => Array.from({ length: terminal.rows }, () => ".".repeat(width)),
      invalidate: () => {},
    };
    tui.setLayoutRoot(root);
    tui.setFocus(root);
    tui.start();
    try {
      const onSelect = vi.fn();
      const menu = createMenu({
        onSelect,
        subtitle: "Connect with a subscription or API key.",
        getRows: () => terminal.rows,
        onCancel: () => handle.hide(),
      });
      const handle = tui.showOverlay(menu, { anchor: "center", width: 78, maxHeight: "100%", margin: 1 });
      tui.renderNow();

      const assertGeometry = (): void => {
        const overlayWidth = Math.min(78, terminal.columns - 2);
        const overlayHeight = menu.render(overlayWidth).length;
        const left = Math.floor((terminal.columns - overlayWidth) / 2);
        const top = Math.floor((terminal.rows - overlayHeight) / 2);
        const frame = tui.frame.map((line) => stripTerminalSequences(line));
        expect(frame).toHaveLength(terminal.rows);
        expect(frame[top + 1]?.indexOf("Providers")).toBe(left + 2);
        expect(frame[top]).toBe(".".repeat(left) + " ".repeat(overlayWidth)
          + ".".repeat(terminal.columns - left - overlayWidth));
        expect(frame[top + overlayHeight - 1]).toBe(frame[top]);
        expect(tui.frame.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
        for (const line of frame) expect(visibleWidth(line)).toBe(terminal.columns);
        expect(tui.getFocusedComponent()).toBe(menu);
      };
      assertGeometry();
      expect(terminal.output.join("")).toContain("Providers");

      terminal.resize(40, 12);
      tui.renderNow(true);
      assertGeometry();

      terminal.send("gateway");
      tui.renderNow();
      expect(menu.getQuery()).toBe("gateway");
      expect(menu.getSelectedValue()).toBe("openrouter:api_key");
      expect(tui.frame.map(stripTerminalSequences).join("\n")).toContain("OpenRouter");
      terminal.send("\r");
      expect(onSelect).toHaveBeenCalledWith("openrouter:api_key");
      terminal.send("\x1b");
      tui.renderNow();
      expect(tui.hasOverlay()).toBe(false);
      expect(tui.getFocusedComponent()).toBe(root);
      expect(menu.focused).toBe(false);
      expect(tui.frame.map(stripTerminalSequences).join("\n")).not.toContain("Providers");
    } finally {
      tui.stop();
    }
  });
});
