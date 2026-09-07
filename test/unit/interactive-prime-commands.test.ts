import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stripTerminalSequences, type Terminal } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalInteractiveCommandName,
  publicInteractiveCommandSpecs,
} from "../../src/cli/command-registry.js";
import { runInteractive } from "../../src/cli/interactive.js";
import type { SelfUpdateProcessResult } from "../../src/cli/local-commands.js";
import type { ModelResponse } from "../../src/domain/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import { SessionController } from "../../src/runtime/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Prime-style interactive commands", () => {
  it("registers the commands and keeps Prime compatibility aliases canonical", () => {
    const names = publicInteractiveCommandSpecs().map((command) => command.name);
    expect(names).toEqual(expect.arrayContaining([
      "system-prompt", "logs", "changelog", "settings", "update", "btw", "clone",
    ]));
    expect(canonicalInteractiveCommandName("/clear")).toBe("new");
    expect(canonicalInteractiveCommandName("/side")).toBe("btw");
  });

  it("renders system prompt, log paths, changelog, and the settings menu locally", async () => {
    const { root, session, model } = await createSession([]);
    const canonicalRoot = await realpath(root);
    await withTui(session, {
      readChangelog: async () => "## [test-release]\n\n- Fixed it.",
    }, async (terminal) => {
      await submitCommand(terminal, "/system-prompt", "System Prompt (");
      expect(terminal.output).toContain("Workspace root:");
      expect(terminal.output).toContain(JSON.stringify(canonicalRoot));
      await submitCommand(terminal, "/logs", "Current Run ledger: no Run is attached");
      const compactOutput = stripTerminalSequences(terminal.output).replace(/\s+/gu, "");
      expect(compactOutput).toContain(join(root, "state", "daemon", "control.sock"));
      await submitCommand(terminal, "/changelog", "test-release");
      terminal.type("/settings");
      terminal.send("\r");
      await waitForOutput(terminal, "Search settings");
      expect(terminal.output).toContain("Provider setup");
      terminal.send("\x1b");
      expect(model.callCount).toBe(0);
    });
  });

  it("runs self-update only through the injected updater", async () => {
    const { session } = await createSession([]);
    let calls = 0;
    const result: SelfUpdateProcessResult = {
      exitCode: 0,
      signal: null,
      stdout: "updated",
      stderr: "",
    };
    await withTui(session, { updateRunner: async () => { calls += 1; return result; } }, async (terminal) => {
      await submitCommand(terminal, "/update", "Restart this process to use the installed release");
      expect(calls).toBe(1);
    });
  });

  it("keeps BTW questions isolated, supports follow-ups, and returns on Escape", async () => {
    const { session, model } = await createSession([
      response("SIDE ONE"),
      response("SIDE TWO"),
      response("MAIN ANSWER"),
    ]);
    await session.setSessionName("Side conversation test");
    const runId = session.snapshot().runId;
    await withTui(session, {}, async (terminal) => {
      await submitCommand(terminal, "/btw first question", "SIDE ONE");
      terminal.type("follow-up question");
      terminal.send("\r");
      await waitForOutput(terminal, "SIDE TWO");
      expect(session.snapshot().runId).toBe(runId);
      terminal.send("\x1b");
      terminal.type("main question");
      terminal.send("\r");
      await waitForOutput(terminal, "MAIN ANSWER");
      await session.waitForIdle();

      expect(model.requests[0]).toMatchObject({ thinkingLevel: "off", tools: [] });
      expect(model.requests[1]?.messages.slice(-3).map((message) => message.content)).toEqual([
        expect.stringContaining("first question"),
        "SIDE ONE",
        "<side_question>\nfollow-up question\n</side_question>",
      ]);
      expect(model.requests[2]?.messages.map((message) => message.content)).toEqual(["main question"]);
      expect((await session.transcript()).map((entry) => entry.content)).toEqual([
        "main question",
        "MAIN ANSWER",
      ]);
    });
  });

  it("clones the latest checkpoint and treats clear as a no-argument new-session alias", async () => {
    const { session } = await createSession([response("SEED ANSWER")], ["parent-run", "clone-run"]);
    await session.submit({ inputId: "seed-input", text: "seed question" });
    await session.waitForIdle();
    expect(session.snapshot().runId).toBe("parent-run");

    await withTui(session, {}, async (terminal) => {
      await submitCommand(terminal, "/clone", "Cloned Run parent-run to clone-run");
      expect(session.snapshot().runId).toBe("clone-run");
      await submitCommand(terminal, "/clear", "New Run ready");
      expect(session.snapshot().runId).toBeUndefined();
      await submitCommand(terminal, "/clear extra", "Usage: /clear");
      expect(session.snapshot().runId).toBeUndefined();
    });
  });
});

async function createSession(
  responses: readonly ModelResponse[],
  runIds: readonly string[] = [],
): Promise<{ root: string; session: SessionController; model: ScriptedModel }> {
  const root = await mkdtemp(join(tmpdir(), "nausicaa-prime-commands-"));
  roots.push(root);
  const model = new ScriptedModel(responses);
  let runIndex = 0;
  const session = await SessionController.open({
    workspace: root,
    dataDir: join(root, "state"),
    model: "demo:model",
    policy: { tetoEnabled: false },
  }, {
    mainModel: model,
    createRunId: () => runIds[runIndex++] ?? `run-${runIndex}`,
  });
  return { root, session, model };
}

async function withTui(
  session: SessionController,
  options: {
    updateRunner?: () => Promise<SelfUpdateProcessResult>;
    readChangelog?: () => Promise<string>;
  },
  check: (terminal: MemoryTerminal) => Promise<void>,
): Promise<void> {
  const previousExitCode = process.exitCode;
  const terminal = new MemoryTerminal(100, 28);
  let stopped = false;
  const running = runInteractive({
    session,
    terminal,
    forceAltScreen: true,
    ...(options.updateRunner === undefined ? {} : { updateRunner: options.updateRunner }),
    ...(options.readChangelog === undefined ? {} : { readChangelog: options.readChangelog }),
  }).finally(() => { stopped = true; });
  await terminal.started;
  try {
    await check(terminal);
  } finally {
    if (!stopped) {
      terminal.type("/quit");
      terminal.send("\r");
    }
    await running;
    process.exitCode = previousExitCode;
  }
}

async function submitCommand(
  terminal: MemoryTerminal,
  command: string,
  expected: string,
): Promise<void> {
  terminal.type(command);
  terminal.send("\r");
  await waitForOutput(terminal, expected);
}

class MemoryTerminal implements Terminal {
  readonly outputChunks: string[] = [];
  cursorVisible = true;
  kittyProtocolActive = false;
  private input?: (data: string) => void;
  private resolveStarted?: () => void;
  readonly started = new Promise<void>((resolve) => { this.resolveStarted = resolve; });

  constructor(readonly columns: number, readonly rows: number) {}
  get output(): string { return this.outputChunks.join(""); }
  start(onInput: (data: string) => void): void { this.input = onInput; this.resolveStarted?.(); }
  send(data: string): void { this.input?.(data); }
  type(value: string): void { for (const character of value) this.send(character); }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void { this.outputChunks.push(data); }
  moveBy(): void {}
  hideCursor(): void { this.cursorVisible = false; }
  showCursor(): void { this.cursorVisible = true; }
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

async function waitForOutput(terminal: MemoryTerminal, expected: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!terminal.output.includes(expected)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for TUI output: ${expected}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function response(content: string): ModelResponse {
  return {
    content,
    toolCalls: [],
    stopReason: "stop",
    usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
  };
}
