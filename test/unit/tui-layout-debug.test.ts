import {
  Container,
  Editor,
  TuiAltScreen,
  TuiMainScreen,
  stripTerminalSequences,
  type Terminal,
} from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { runInteractive } from "../../src/cli/interactive.js";
import { SessionController } from "../../src/runtime/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import type { ModelResponse } from "../../src/domain/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

class TerminalStub implements Terminal {
  readonly output: string[] = [];
  kittyProtocolActive = false;
  private input?: (data: string) => void;
  private resolveStarted?: () => void;
  readonly started = new Promise<void>((resolve) => { this.resolveStarted = resolve; });
  constructor(readonly columns = 100, readonly rows = 28) {}
  start(onInput: (data: string) => void): void { this.input = onInput; this.resolveStarted?.(); }
  send(data: string): void { this.input?.(data); }
  stop(): void {}
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

function response(content: string): ModelResponse {
  return { content, toolCalls: [], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("debug prompt layout", () => {
  it("captures prompt y around a completed response", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-layout-debug-"));
    const terminal = new TerminalStub();
    const model = new ScriptedModel([response("answer")]);
    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      policy: { maxMainStepsPerActivation: 1, tetoEnabled: false },
    }, { mainModel: model });
    const original = TuiAltScreen.prototype.setLayoutRoot;
    let captured: { tui: TuiAltScreen; root: Container } | undefined;
    TuiAltScreen.prototype.setLayoutRoot = function(rootComponent) {
      captured = { tui: this, root: rootComponent as Container };
      return original.call(this, rootComponent);
    };
    try {
      const running = runInteractive({ session, terminal, forceAltScreen: true });
      await terminal.started;
      await waitFor(() => stripTerminalSequences(terminal.output.join("")).includes("Nausicaa can explain"));
      const rootComponent = captured?.root;
      expect(rootComponent).toBeDefined();
      const findEditorContainer = (component: unknown): Container | undefined => {
        if (!(component instanceof Container)) return undefined;
        if (component.children.some((nested) => nested instanceof Editor)) return component;
        for (const child of component.children) {
          const found = findEditorContainer(child);
          if (found !== undefined) return found;
        }
        return undefined;
      };
      const editorContainer = findEditorContainer(rootComponent);
      const getBox = (component: unknown): { y: number; height: number } | undefined => {
        const layout = (captured?.tui as unknown as { currentLayout?: { root: any } }).currentLayout;
        if (layout === undefined) return undefined;
        const visit = (box: any): any => {
          if (box.component === component) return box.rect;
          for (const child of box.children ?? []) {
            const found = visit(child);
            if (found) return found;
          }
          return undefined;
        };
        return visit(layout.root);
      };
      await waitFor(() => getBox(editorContainer) !== undefined);
      const before = getBox(editorContainer);
      for (const character of "hello") terminal.send(character);
      terminal.send("\r");
      await waitFor(() => model.callCount > 0);
      await waitFor(() => stripTerminalSequences(terminal.output.join("")).includes("answer"));
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(getBox(editorContainer)?.y).toBe(before?.y);
      terminal.send("/exit");
      terminal.send("\r");
      await running;
    } finally {
      TuiAltScreen.prototype.setLayoutRoot = original;
      await session.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("captures prompt rows in regular mode while status settles", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-layout-debug-main-"));
    const terminal = new TerminalStub();
    const model = new ScriptedModel([response("answer")]);
    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      policy: { maxMainStepsPerActivation: 1, tetoEnabled: false },
    }, { mainModel: model });
    const original = TuiMainScreen.prototype.render;
    const frames: string[][] = [];
    let clearOnShrink: boolean | undefined;
    TuiMainScreen.prototype.render = function(width) {
      clearOnShrink = this.getClearOnShrink();
      const lines = original.call(this, width);
      frames.push([...lines]);
      return lines;
    };
    try {
      const running = runInteractive({ session, terminal, forceAltScreen: false });
      await terminal.started;
      await waitFor(() => frames.some((frame) => frame.some((line) => line.includes("Nausicaa can explain"))));
      // Pi leaves this setting disabled unless the host or PI_CLEAR_ON_SHRINK
      // explicitly enables it. Regular mode therefore keeps its scrollback
      // differential-render path intact.
      expect(clearOnShrink).toBe(process.env.PI_CLEAR_ON_SHRINK === "1");
      for (const character of "hello") terminal.send(character);
      terminal.send("\r");
      await waitFor(() => model.callCount > 0);
      await waitFor(() => frames.some((frame) => stripTerminalSequences(frame.join("\n")).includes("answer")));
      await new Promise((resolve) => setTimeout(resolve, 500));
      const promptRow = (frame: readonly string[]): number => {
        const index = frame.findIndex((line) => stripTerminalSequences(line).startsWith("─"));
        return index;
      };
      const rows = frames.map(promptRow).filter((row) => row >= 0);
      // The regular Pi renderer removes the transient loader rows when the
      // turn settles, so the final frame may move upward once. What must not
      // remain is a continuing drift or an empty tail after it settles.
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.at(-1)).toBeLessThanOrEqual(rows.at(-2)!);
      terminal.send("/exit");
      terminal.send("\r");
      await running;
    } finally {
      TuiMainScreen.prototype.render = original;
      await session.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the fullscreen prompt anchored after transient command UI is cancelled", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-layout-debug-autocomplete-"));
    const terminal = new TerminalStub();
    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      policy: { maxMainStepsPerActivation: 1, tetoEnabled: false },
    }, { mainModel: new ScriptedModel([]) });
    const original = TuiAltScreen.prototype.setLayoutRoot;
    let captured: { tui: TuiAltScreen; root: Container } | undefined;
    TuiAltScreen.prototype.setLayoutRoot = function(rootComponent) {
      captured = { tui: this, root: rootComponent as Container };
      return original.call(this, rootComponent);
    };
    try {
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        modelChoices: ["openrouter:next-model"],
      });
      await terminal.started;
      await waitFor(() => stripTerminalSequences(terminal.output.join("")).includes("Nausicaa can explain"));
      const findEditorContainer = (component: unknown): Container | undefined => {
        if (!(component instanceof Container)) return undefined;
        if (component.children.some((nested) => nested instanceof Editor)) return component;
        for (const child of component.children) {
          const found = findEditorContainer(child);
          if (found !== undefined) return found;
        }
        return undefined;
      };
      const editorContainer = findEditorContainer(captured?.root);
      expect(editorContainer).toBeDefined();
      const getBox = (): { y: number; height: number } | undefined => {
        const layout = (captured?.tui as unknown as { currentLayout?: { root: any } }).currentLayout;
        if (layout === undefined || editorContainer === undefined) return undefined;
        const visit = (box: any): { y: number; height: number } | undefined => {
          if (box.component === editorContainer) return box.rect;
          for (const child of box.children ?? []) {
            const found = visit(child);
            if (found !== undefined) return found;
          }
          return undefined;
        };
        return visit(layout.root);
      };
      await waitFor(() => getBox() !== undefined);
      const before = getBox();
      terminal.send("/");
      await waitFor(() => stripTerminalSequences(terminal.output.join("")).includes("list-agents"));
      await waitFor(() => (getBox()?.height ?? 0) > (before?.height ?? 0));
      terminal.send("\x1b");
      await waitFor(() => getBox()?.height === before?.height);
      expect(getBox()?.y).toBe(before?.y);
      terminal.send("\x7f");
      terminal.send("/model");
      terminal.send("\r");
      await waitFor(() => stripTerminalSequences(terminal.output.join("")).includes("Models"));
      await waitFor(() => (getBox()?.height ?? 0) > (before?.height ?? 0));
      terminal.send("\x1b");
      await waitFor(() => getBox()?.height === before?.height);
      expect(getBox()?.y).toBe(before?.y);
      terminal.send("\x03");
      terminal.send("\x03");
      terminal.send("\x03");
      await running;
    } finally {
      TuiAltScreen.prototype.setLayoutRoot = original;
      await session.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns the regular Pi editor stream to its pre-selector height", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-layout-debug-regular-selector-"));
    // Force the main-screen content into scrollback and exercise the same
    // differential shrink path used by Pi when transient rows disappear.
    const terminal = new TerminalStub(100, 12);
    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      policy: { maxMainStepsPerActivation: 1, tetoEnabled: false },
    }, { mainModel: new ScriptedModel([]) });
    const original = TuiMainScreen.prototype.render;
    const frames: string[][] = [];
    let capturedTui: TuiMainScreen | undefined;
    TuiMainScreen.prototype.render = function(width) {
      capturedTui = this;
      const lines = original.call(this, width);
      frames.push([...lines]);
      return lines;
    };
    try {
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: false,
        modelChoices: ["openrouter:next-model"],
      });
      await terminal.started;
      await waitFor(() => frames.some((frame) => frame.some((line) => line.includes("Nausicaa can explain"))));
      // Capture the settled baseline after the initial composer frame.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const settledFrame = (): readonly string[] => frames.at(-1) ?? [];
      const viewportTop = (): number => capturedTui?.captureRenderState().previousViewportTop ?? 0;
      const baselineHeight = settledFrame().length;
      const baselineViewportTop = viewportTop();
      terminal.send("/");
      await waitFor(() => stripTerminalSequences(settledFrame().join("\n")).includes("list-agents"));
      expect(settledFrame().length).toBeGreaterThan(baselineHeight);
      const openViewportTop = viewportTop();
      expect(openViewportTop).toBeGreaterThan(0);
      const framesBeforeAutocompleteClose = frames.length;
      terminal.send("\x7f");
      await waitFor(() => !stripTerminalSequences(settledFrame().join("\n")).includes("list-agents"));
      expect(frames.length).toBeGreaterThan(framesBeforeAutocompleteClose);
      expect(settledFrame().length).toBe(baselineHeight);
      if (process.env.PI_CLEAR_ON_SHRINK === "1") {
        expect(viewportTop()).toBe(baselineViewportTop);
      }

      terminal.send("\x7f");
      terminal.send("/model");
      terminal.send("\r");
      await waitFor(() => stripTerminalSequences(settledFrame().join("\n")).includes("Models"));
      expect(settledFrame().length).toBeGreaterThan(baselineHeight);
      const framesBeforeModelClose = frames.length;
      terminal.send("\x1b");
      await waitFor(() => !stripTerminalSequences(settledFrame().join("\n")).includes("Models"));
      expect(frames.length).toBeGreaterThan(framesBeforeModelClose);
      expect(settledFrame().length).toBe(baselineHeight);
      if (process.env.PI_CLEAR_ON_SHRINK === "1") {
        expect(viewportTop()).toBe(baselineViewportTop);
      }

      terminal.send("\x03");
      terminal.send("\x03");
      await running;
    } finally {
      TuiMainScreen.prototype.render = original;
      await session.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the welcome header in the regular transcript stream", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-layout-debug-header-stream-"));
    const terminal = new TerminalStub();
    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      policy: { maxMainStepsPerActivation: 1, tetoEnabled: false },
    }, { mainModel: new ScriptedModel([]) });
    const original = TuiMainScreen.prototype.render;
    const frames: string[][] = [];
    TuiMainScreen.prototype.render = function(width) {
      const lines = original.call(this, width);
      frames.push([...lines]);
      return lines;
    };
    try {
      const running = runInteractive({ session, terminal, forceAltScreen: false });
      await terminal.started;
      await waitFor(() => frames.some((frame) => frame.some((line) => line.includes("Nausicaa can explain"))));
      terminal.send("/help");
      terminal.send("\r");
      await waitFor(() => stripTerminalSequences((frames.at(-1) ?? []).join("\n")).includes("Commands"));
      const welcomeFrame = frames.findIndex((frame) => (
        stripTerminalSequences(frame.join("\n")).includes("Nausicaa can explain")
      ));
      const helpFrame = frames.findIndex((frame) => (
        stripTerminalSequences(frame.join("\n")).includes("Commands")
      ));
      expect(welcomeFrame).toBeGreaterThanOrEqual(0);
      expect(helpFrame).toBeGreaterThan(welcomeFrame);
      terminal.send("\x03");
      terminal.send("\x03");
      await running;
    } finally {
      TuiMainScreen.prototype.render = original;
      await session.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});
