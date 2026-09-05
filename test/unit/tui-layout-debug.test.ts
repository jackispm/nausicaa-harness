import {
  Container,
  TuiAltScreen,
  TuiMainScreen,
  stripTerminalSequences,
  type Terminal,
} from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { runInteractive } from "../../src/cli/interactive.js";
import { SessionController } from "../../src/runtime/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import { PromptSurface, ActivityLine, WorkerTaskSummaryLine } from "../../src/cli/tui-components.js";
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
      const findPromptSlot = (component: unknown): Container | undefined => {
        if (!(component instanceof Container)) return undefined;
        if (component.children.some((nested) => nested instanceof PromptSurface)) return component;
        for (const child of component.children) {
          const found = findPromptSlot(child);
          if (found !== undefined) return found;
        }
        return undefined;
      };
      const promptSlot = findPromptSlot(rootComponent);
      const activity = rootComponent?.children.find((child) => child instanceof ActivityLine);
      const worker = rootComponent?.children.find((child) => child instanceof WorkerTaskSummaryLine);
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
      await waitFor(() => getBox(promptSlot) !== undefined);
      const before = getBox(promptSlot);
      for (const character of "hello") terminal.send(character);
      terminal.send("\r");
      await waitFor(() => model.callCount > 0);
      await waitFor(() => stripTerminalSequences(terminal.output.join("")).includes("answer"));
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(getBox(promptSlot)?.y).toBe(before?.y);
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
    TuiMainScreen.prototype.render = function(width) {
      const lines = original.call(this, width);
      frames.push([...lines]);
      return lines;
    };
    try {
      const running = runInteractive({ session, terminal, forceAltScreen: false });
      await terminal.started;
      await waitFor(() => frames.some((frame) => frame.some((line) => line.includes("Nausicaa can explain"))));
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
      // turn settles, so one frame may move upward. What must not remain is a
      // continuing drift or an empty tail after the final settled frame.
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.at(-1)).toBe(rows.at(-2));
      terminal.send("/exit");
      terminal.send("\r");
      await running;
    } finally {
      TuiMainScreen.prototype.render = original;
      await session.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});
