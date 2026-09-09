import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stripTerminalSequences, type Terminal } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";

import {
  runInteractive,
} from "../../src/cli/interactive.js";
import type {
  ModelPort,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "../../src/domain/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import {
  listWorkspaceRuns,
  SessionController,
  type SessionRuntimeEvent,
} from "../../src/runtime/index.js";

const roots: string[] = [];
const previousExitCode = process.exitCode;

afterEach(async () => {
  process.exitCode = previousExitCode;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("interactive local commands", () => {
  it("renders local diagnostics, routes settings, and injects changelog and update work", async () => {
    const root = await temporaryRoot("nausicaa-tui-local-commands-");
    const terminal = new MemoryTerminal(100, 32);
    const model = new ScriptedModel([]);
    const session = await openSession(root, model);
    const events: SessionRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    let updateCalls = 0;
    const running = runInteractive({
      session,
      terminal,
      forceAltScreen: true,
      readChangelog: async () => "## [9.9.9]\n\n- CHANGELOG_SENTINEL",
      updateRunner: async () => {
        updateCalls += 1;
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      },
    });

    try {
      await terminal.started;

      await sendCommand(terminal, "/system-prompt", "System Prompt");
      expect(normalizedOutput(terminal.output)).toContain("You are Nausicaa");
      await sendCommand(terminal, "/system-prompt extra", "Usage: /system-prompt");

      await sendCommand(terminal, "/logs", "Current Run ledger: no Run is attached");
      expect(normalizedOutput(terminal.output)).toContain(`State directory: ${join(root, "state")}`);
      await sendCommand(terminal, "/logs extra", "Usage: /logs");

      await sendCommand(terminal, "/changelog", "CHANGELOG_SENTINEL");
      await sendCommand(terminal, "/changelog extra", "Usage: /changelog");

      await sendCommand(terminal, "/settings", "Search settings");
      expect(normalizedOutput(terminal.output)).toContain("Mode");
      terminal.send("\x1b[B");
      terminal.send("\x1b[B");
      terminal.send("\x1b[B");
      terminal.send("\r");
      await waitForOutput(terminal, "Default can act");
      terminal.send("\x1b");
      await sendCommand(terminal, "/settings extra", "Usage: /settings");

      await sendCommand(terminal, "/update extra", "Usage: /update");
      expect(updateCalls).toBe(0);
      await sendCommand(terminal, "/update", "Restart this process");
      expect(updateCalls).toBe(1);

      expect(model.callCount).toBe(0);
      expect(events.filter((event) => event.kind === "event")).toHaveLength(0);
      await closeInteractive(terminal, running);
    } finally {
      await stopIfRunning(terminal, running);
      await session.close();
    }
  });

  it("rejects /update while Main is working without invoking the updater", async () => {
    const root = await temporaryRoot("nausicaa-tui-update-active-");
    const terminal = new MemoryTerminal(100, 28);
    let releaseModel = (_response: ModelResponse): void => {};
    let markStarted = (): void => {};
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const pending = new Promise<ModelResponse>((resolve) => { releaseModel = resolve; });
    const model = new ScriptedModel([() => {
      markStarted();
      return pending;
    }]);
    const session = await openSession(root, model, () => "update-active-run");
    let updateCalls = 0;
    const running = runInteractive({
      session,
      terminal,
      forceAltScreen: true,
      updateRunner: async () => {
        updateCalls += 1;
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      },
    });

    try {
      await terminal.started;
      terminal.type("keep working");
      terminal.send("\r");
      await started;
      await sendCommand(terminal, "/update", "Wait for the current Turn to finish");
      expect(updateCalls).toBe(0);
      releaseModel(response("ACTIVE_TURN_DONE"));
      await session.waitForIdle();
      await closeInteractive(terminal, running);
    } finally {
      releaseModel(response("cleanup"));
      await stopIfRunning(terminal, running);
      await session.close();
    }
  });

  it("implements /clear as an argument-free new Run boundary", async () => {
    const root = await temporaryRoot("nausicaa-tui-clear-");
    const terminal = new MemoryTerminal(100, 28);
    const model = new ScriptedModel([
      response("CLEAR_PARENT_ANSWER"),
      response("CLEAR_CHILD_ANSWER"),
    ]);
    const runIds = ["clear-parent-run", "clear-child-run"];
    const session = await openSession(root, model, () => runIds.shift() ?? "unexpected-run");
    await session.submit({ inputId: "clear-parent-input", text: "CLEAR_PARENT_PROMPT" });
    await session.waitForIdle();
    const parentTranscript = await session.transcript();
    const running = runInteractive({ session, terminal, forceAltScreen: true });

    try {
      await terminal.started;
      await waitForOutput(terminal, "CLEAR_PARENT_ANSWER");
      await sendCommand(terminal, "/clear extra", "Usage: /clear");
      expect(session.snapshot().runId).toBe("clear-parent-run");

      const beforeClear = terminal.output.length;
      await sendCommand(terminal, "/clear", "New Run ready");
      expect(session.snapshot().runId).toBeUndefined();
      expect(session.snapshot().status).toBe("detached");
      expect(model.callCount).toBe(1);
      expect(normalizedOutput(terminal.output.slice(beforeClear))).not.toContain("CLEAR_PARENT_ANSWER");

      terminal.type("CLEAR_CHILD_PROMPT");
      terminal.send("\r");
      await waitForOutput(terminal, "CLEAR_CHILD_ANSWER");
      await session.waitForIdle();
      expect(session.snapshot().runId).toBe("clear-child-run");
      await closeInteractive(terminal, running);

      const savedRuns = await listWorkspaceRuns(join(root, "state"), session.workspace);
      expect(savedRuns.map((run) => run.runId)).toEqual(expect.arrayContaining([
        "clear-parent-run",
        "clear-child-run",
      ]));
      const inspector = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        runId: "clear-parent-run",
      }, { mainModel: new ScriptedModel([]) });
      try {
        await expect(inspector.transcript()).resolves.toEqual(parentTranscript);
      } finally {
        await inspector.close();
      }
    } finally {
      await stopIfRunning(terminal, running);
      await session.close();
    }
  });

  it("clones the attached Run at its current checkpoint without a model request", async () => {
    const root = await temporaryRoot("nausicaa-tui-clone-");
    const terminal = new MemoryTerminal(100, 28);
    const model = new ScriptedModel([response("CLONE_PARENT_ANSWER")]);
    const runIds = ["clone-parent-run", "clone-child-run"];
    const session = await openSession(root, model, () => runIds.shift() ?? "unexpected-run");
    await session.submit({ inputId: "clone-parent-input", text: "CLONE_PARENT_PROMPT" });
    await session.waitForIdle();
    const parentTranscript = await session.transcript();
    const running = runInteractive({ session, terminal, forceAltScreen: true });

    try {
      await terminal.started;
      await waitForOutput(terminal, "CLONE_PARENT_ANSWER");
      await sendCommand(terminal, "/clone extra", "Usage: /clone");
      expect(session.snapshot().runId).toBe("clone-parent-run");

      const beforeClone = terminal.output.length;
      await sendCommand(terminal, "/clone", "Cloned Run clone-parent-run to clone-child-run");
      expect(session.snapshot().runId).toBe("clone-child-run");
      await expect(session.transcript()).resolves.toEqual(parentTranscript);
      expect(model.callCount).toBe(1);
      expect(normalizedOutput(terminal.output.slice(beforeClone))).toContain("CLONE_PARENT_ANSWER");
      await closeInteractive(terminal, running);
    } finally {
      await stopIfRunning(terminal, running);
      await session.close();
    }
  });

  it("keeps /btw and follow-ups outside the main transcript while accounting for usage", async () => {
    const root = await temporaryRoot("nausicaa-tui-btw-");
    const terminal = new MemoryTerminal(100, 32);
    const model = new ScriptedModel([
      response("MAIN_ANSWER"),
      response("SIDE_ANSWER"),
      response("SIDE_FOLLOW_UP_ANSWER"),
    ]);
    const session = await openSession(root, model, () => "btw-main-run");
    await session.submit({ inputId: "btw-main-input", text: "MAIN_QUESTION" });
    await session.waitForIdle();
    const transcriptBefore = await session.transcript();
    const usageBefore = structuredClone(session.snapshot().usage);
    const events: SessionRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    const running = runInteractive({ session, terminal, forceAltScreen: true });

    try {
      await terminal.started;
      await sendCommand(terminal, "/side What changed?", "SIDE_ANSWER");
      expect(model.requests[1]?.tools).toEqual([]);
      await expect(session.transcript()).resolves.toEqual(transcriptBefore);
      expect(session.snapshot().usage).toEqual({
        ...usageBefore, input: usageBefore.input + 20, output: usageBefore.output + 5,
      });

      terminal.type("And now?");
      terminal.send("\r");
      await waitForOutput(terminal, "SIDE_FOLLOW_UP_ANSWER");
      expect(model.requests[2]?.messages.slice(-3).map((message) => message.content)).toEqual([
        expect.stringContaining("What changed?"),
        "SIDE_ANSWER",
        "<side_question>\nAnd now?\n</side_question>",
      ]);
      await expect(session.transcript()).resolves.toEqual(transcriptBefore);
      expect(session.snapshot().usage).toEqual({
        ...usageBefore, input: usageBefore.input + 40, output: usageBefore.output + 10,
      });
      expect(events.filter((event) => event.kind === "event").map((event) => (
        event.kind === "event" ? event.event.type : undefined
      ))).toEqual(["budget.charged", "budget.charged"]);

      terminal.send("\x1b");
      await sendCommand(terminal, "/status", "Queue / Tokens");
      await closeInteractive(terminal, running);
    } finally {
      await stopIfRunning(terminal, running);
      await session.close();
    }
  });

  it.each([
    ["Escape", "\x1b"],
    ["Ctrl+C", "\x03"],
  ])("cancels /btw with %s and suppresses a late result", async (_label, cancelKey) => {
    const root = await temporaryRoot("nausicaa-tui-btw-cancel-");
    const terminal = new MemoryTerminal(100, 28);
    const model = new LateSideQuestionModel();
    const session = await openSession(root, model);
    await session.setSessionName("Side cancellation test");
    const runId = session.snapshot().runId;
    const events: SessionRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    const running = runInteractive({ session, terminal, forceAltScreen: true });

    try {
      await terminal.started;
      terminal.type("/btw Wait for this");
      terminal.send("\r");
      await model.started;
      await waitForOutput(terminal, "Thinking...");
      terminal.send(cancelKey);
      await waitForCondition(() => model.requests[0]?.signal?.aborted === true, "side request cancellation");
      model.release();
      await delay(30);
      expect(normalizedOutput(terminal.output)).not.toContain("LATE_SIDE_ANSWER");
      expect(session.snapshot().runId).toBe(runId);
      expect(events.filter((event) => event.kind === "event")).toHaveLength(0);

      await sendCommand(terminal, "/status", "Queue / Tokens");
      await closeInteractive(terminal, running);
    } finally {
      model.release();
      await stopIfRunning(terminal, running);
      await session.close();
    }
  });

  it("aborts an active /btw request during shutdown", async () => {
    const root = await temporaryRoot("nausicaa-tui-btw-shutdown-");
    const terminal = new MemoryTerminal(100, 28);
    const model = new LateSideQuestionModel();
    const session = await openSession(root, model);
    await session.setSessionName("Side shutdown test");
    const running = runInteractive({ session, terminal, forceAltScreen: true });

    try {
      await terminal.started;
      terminal.type("/btw Still running");
      terminal.send("\r");
      await model.started;
      terminal.send("\x04");
      await waitForCondition(() => model.requests[0]?.signal?.aborted === true, "shutdown cancellation");
      model.release();
      await expect(running).resolves.toBe(0);
      expect(normalizedOutput(terminal.output)).not.toContain("LATE_SIDE_ANSWER");
    } finally {
      model.release();
      await stopIfRunning(terminal, running);
      await session.close();
    }
  });
});

class LateSideQuestionModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  private readonly requestGate: Promise<void>;
  private releaseRequest = (): void => {};
  readonly started: Promise<void>;

  constructor() {
    let markStarted = (): void => {};
    this.started = new Promise<void>((resolve) => { markStarted = resolve; });
    this.markStarted = markStarted;
    this.requestGate = new Promise<void>((resolve) => { this.releaseRequest = resolve; });
  }

  private readonly markStarted: () => void;

  release(): void {
    this.releaseRequest();
  }

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("stream() should be used");
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    this.markStarted();
    yield { type: "start" };
    await this.requestGate;
    yield { type: "text-delta", delta: "LATE_SIDE_ANSWER" };
    yield { type: "done", response: response("LATE_SIDE_ANSWER") };
  }
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

  start(onInput: (data: string) => void): void {
    this.input = onInput;
    this.resolveStarted?.();
  }

  send(data: string): void { this.input?.(data); }
  type(value: string): void {
    for (const character of value) this.send(character);
  }

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

async function openSession(
  root: string,
  model: ModelPort,
  createRunId?: () => string,
): Promise<SessionController> {
  return SessionController.open({
    workspace: root,
    dataDir: join(root, "state"),
    model: "scripted",
    policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
  }, {
    mainModel: model,
    ...(createRunId === undefined ? {} : { createRunId }),
  });
}

async function sendCommand(
  terminal: MemoryTerminal,
  command: string,
  expected: string,
): Promise<void> {
  const offset = terminal.output.length;
  terminal.type(command);
  terminal.send("\r");
  await waitForCondition(
    () => normalizedOutput(terminal.output.slice(offset)).includes(expected),
    `output for ${command}: ${expected}`,
  );
}

async function closeInteractive(
  terminal: MemoryTerminal,
  running: Promise<number>,
): Promise<void> {
  terminal.type("/exit");
  terminal.send("\r");
  await expect(running).resolves.toBe(0);
}

async function stopIfRunning(
  terminal: MemoryTerminal,
  running: Promise<number>,
): Promise<void> {
  const result = await Promise.race([
    running.then(() => "stopped" as const, () => "stopped" as const),
    delay(1).then(() => "running" as const),
  ]);
  if (result === "running") {
    terminal.send("\x04");
    await running.catch(() => undefined);
  }
}

async function waitForOutput(terminal: MemoryTerminal, expected: string): Promise<void> {
  await waitForCondition(
    () => normalizedOutput(terminal.output).includes(expected),
    `TUI output: ${expected}`,
  );
}

async function waitForCondition(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await delay(10);
  }
}

function normalizedOutput(value: string): string {
  return stripTerminalSequences(value).replace(/\s+/gu, " ");
}

function response(content: string): ModelResponse {
  return {
    content,
    toolCalls: [],
    stopReason: "stop",
    usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
  };
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
