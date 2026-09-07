import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Terminal } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { runInteractive } from "../../src/cli/interactive.js";
import { runRemoteAttach } from "../../src/cli/remote-attach.js";
import type { AnyEvent, ModelResponse, Visibility } from "../../src/domain/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import { executeRun, SessionController } from "../../src/runtime/index.js";
import { createLocalCrossRunComposition } from "../../src/runtime/local-cross-run-composition.js";

describe("private cross-Run Main input", () => {
  it.each(["lane", "sensitive"] as const)("consumes %s messages without exposing their input in live or resumed surfaces", async (visibility) => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-private-a2a-"));
    const dataDir = join(root, "state");
    const content = `PRIVATE_${visibility}_A2A_NOTE`;
    const terminal = new MemoryTerminal();
    const remoteTerminal = new MemoryTerminal();
    const previousExitCode = process.exitCode;
    let target: SessionController | undefined;
    let resumed: SessionController | undefined;
    let interactive: Promise<number> | undefined;
    let remote: Promise<number> | undefined;
    try {
      const model = new ScriptedModel([response("seeded"), response("TARGET_MAIN_RECEIVED")]);
      target = await SessionController.open({
        workspace: root, dataDir, model: "scripted",
        policy: { tetoEnabled: false, maxMainStepsPerActivation: 2 },
      }, { mainModel: model, createRunId: () => "private-target" });
      await target.submit({ inputId: "seed", text: "Seed the recipient" });
      await target.waitForIdle();
      const events: AnyEvent[] = [];
      target.subscribe((event) => { if (event.kind === "event") events.push(event.event); });
      interactive = runInteractive({ session: target, terminal, forceAltScreen: true });
      await terminal.started;

      await sendPrivateNote(root, dataDir, visibility, content);
      await target.reconcileExternalMessages();
      await target.waitForIdle();
      await waitFor(() => terminal.output.includes("TARGET_MAIN_RECEIVED"));
      expect(model.requests[1]?.messages.some((message) => message.content.includes(content))).toBe(true);
      expect(events.filter((event) => event.type === "message.sent")).toMatchObject([
        { visibility, payload: { message: { visibility } } },
      ]);
      expect(events.filter((event) => event.type === "input.admitted" || event.type === "user.message"))
        .toMatchObject([{ visibility: "sensitive" }, { visibility: "sensitive" }]);
      expect((await target.transcript()).some((entry) => entry.content.includes(content))).toBe(false);
      expect(terminal.output).not.toContain(content);
      terminal.type("/exit");
      terminal.send("\r");
      await expect(interactive).resolves.toBe(0);
      interactive = undefined;

      const resumedModel = new ScriptedModel([response("TARGET_MAIN_CONTINUED")]);
      resumed = await SessionController.open({
        workspace: root, dataDir, runId: "private-target", model: "scripted",
      }, { mainModel: resumedModel });
      expect((await resumed.transcript()).some((entry) => entry.content.includes(content))).toBe(false);
      await resumed.submit({ inputId: "continue", text: "Continue from the earlier note" });
      await resumed.waitForIdle();
      expect(resumedModel.requests[0]?.messages.some((message) => message.content.includes(content))).toBe(true);

      const attached = resumed;
      remote = runRemoteAttach({
        forceAltScreen: true, terminal: remoteTerminal,
        session: {
          workspace: root, snapshot: () => attached.snapshot(),
          state: () => ({ snapshot: attached.snapshot(), attachmentStatus: "attached" }),
          transcript: () => attached.transcript(), workerTaskSummary: () => attached.workerTaskSummary(),
          subscribe: () => () => undefined, close: async () => undefined,
        },
      });
      await remoteTerminal.started;
      await waitFor(() => remoteTerminal.output.includes("TARGET_MAIN_CONTINUED"));
      expect(remoteTerminal.output).not.toContain(content);
      remoteTerminal.send("q");
      await expect(remote).resolves.toBe(0);
      remote = undefined;
    } finally {
      terminal.type("/exit");
      terminal.send("\r");
      remoteTerminal.send("q");
      await interactive;
      await remote;
      await target?.close();
      await resumed?.close();
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains queued privacy through repeated delivery, replacement, and process recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-private-a2a-pending-"));
    const dataDir = join(root, "state");
    const content = "PRIVATE_PENDING_A2A_NOTE";
    let target: SessionController | undefined;
    let resumed: SessionController | undefined;
    const noop = {
      definition: { name: "noop", description: "No-op", parameters: { type: "object" as const } },
      execute: async () => ({ content: "done", isError: false }),
    };
    try {
      const pausedModel = new ScriptedModel([{
        ...response("paused"), stopReason: "toolUse",
        toolCalls: [{ id: "pause-noop", name: "noop", arguments: {} }],
      }]);
      target = await SessionController.open({
        workspace: root, dataDir, model: "scripted",
        policy: { tetoEnabled: false, maxMainStepsPerActivation: 1 },
      }, { mainModel: pausedModel, tools: [noop], createRunId: () => "private-target" });
      await target.submit({ inputId: "pause", text: "Pause at the step limit" });
      await target.waitForIdle();
      expect(target.snapshot().blocker).toBe("step-allowance-exhausted");
      const events: AnyEvent[] = [];
      target.subscribe((event) => { if (event.kind === "event") events.push(event.event); });
      await sendPrivateNote(root, dataDir, "lane", content);
      await target.reconcileExternalMessages();
      await target.reconcileExternalMessages();
      const admissions = events.filter((event) => event.type === "input.admitted");
      expect(admissions).toHaveLength(1);
      const admission = admissions[0]!;
      expect(admission.visibility).toBe("sensitive");
      expect(pausedModel.callCount).toBe(1);
      expect(await target.pendingInputs()).toEqual([]);
      const message = await target.readConversationMessage(admission.payload.messageRef);
      expect(await target.replacePendingInput(admission.payload.inputId, 1, {
        text: message.content, delivery: "follow-up",
      })).toBe("applied");
      expect(events.find((event) => event.type === "input.replaced")?.visibility).toBe("sensitive");
      await target.close();

      const model = new ScriptedModel([response("unblocked"), response("received pending note")]);
      resumed = await SessionController.open({
        workspace: root, dataDir, runId: "private-target", model: "scripted",
      }, { mainModel: model, tools: [noop] });
      expect(await resumed.pendingInputs()).toEqual([]);
      const resumedEvents: AnyEvent[] = [];
      resumed.subscribe((event) => { if (event.kind === "event") resumedEvents.push(event.event); });
      await resumed.reconcileExternalMessages();
      await resumed.resumeCurrent();
      await resumed.waitForIdle();
      expect(model.requests.some((request) => request.messages.some((entry) => entry.content.includes(content)))).toBe(true);
      expect(resumedEvents.filter((event) => event.type === "user.message"
        && event.payload.inputId === admission.payload.inputId)).toMatchObject([{ visibility: "sensitive" }]);
      expect((await resumed.transcript()).some((entry) => entry.content.includes(content))).toBe(false);
    } finally {
      await target?.close();
      await resumed?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves private visibility when a busy Main consumes steering at its next boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-private-a2a-steering-"));
    const dataDir = join(root, "state");
    const content = "PRIVATE_STEERING_A2A_NOTE";
    let target: SessionController | undefined;
    let release!: (response: ModelResponse) => void;
    const gate = new Promise<ModelResponse>((resolve) => { release = resolve; });
    const noop = {
      definition: { name: "noop", description: "No-op", parameters: { type: "object" as const } },
      execute: async () => ({ content: "done", isError: false }),
    };
    try {
      const model = new ScriptedModel([async () => gate, response("received steering")]);
      target = await SessionController.open({
        workspace: root, dataDir, model: "scripted",
        policy: { tetoEnabled: false, maxMainStepsPerActivation: 2 },
      }, { mainModel: model, tools: [noop], createRunId: () => "private-target" });
      const events: AnyEvent[] = [];
      target.subscribe((event) => { if (event.kind === "event") events.push(event.event); });
      await target.submit({ inputId: "busy", text: "Keep Main working" });
      await waitFor(() => model.callCount === 1);
      await sendPrivateNote(root, dataDir, "lane", content);
      await target.reconcileExternalMessages();
      const admission = events.find((event) => event.type === "input.admitted"
        && event.payload.inputId.startsWith("a2a:"));
      expect(admission).toMatchObject({ visibility: "sensitive", payload: { delivery: "steering" } });
      expect(await target.pendingInputs()).toEqual([]);
      release({
        ...response("continue"), stopReason: "toolUse",
        toolCalls: [{ id: "steering-noop", name: "noop", arguments: {} }],
      });
      await target.waitForIdle();
      expect(model.requests[1]?.messages.some((message) => message.content.includes(content))).toBe(true);
      expect(events.filter((event) => event.type === "user.message" && event.payload.kind === "steering"))
        .toMatchObject([{ visibility: "sensitive" }]);
      expect((await target.transcript()).some((entry) => entry.content.includes(content))).toBe(false);
    } finally {
      release(response("cleanup"));
      await target?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function sendPrivateNote(root: string, dataDir: string, visibility: Visibility, content: string): Promise<void> {
  const model = new ScriptedModel([{
    ...response("send"), stopReason: "toolUse",
    toolCalls: [{
      id: "send-private", name: "agent_message",
      arguments: {
        target: { relationship: "direct", id: "private-target" },
        visibility, payload: { type: "message.inform", text: content },
      },
    }],
  }, response("sent")]);
  const composition = createLocalCrossRunComposition({ workspace: root, dataDir });
  await executeRun({
    workspace: root, dataDir, model: "scripted", message: "Send the private note",
    policy: { tetoEnabled: false, maxMainSteps: 2 },
  }, {
    mainModel: model, createRunId: () => "private-source",
    crossRun: { ...composition, permissions: { relationships: ["direct"], visibilities: [visibility] } },
  });
  expect(model.requests[1]?.messages.findLast((message) => message.role === "tool")?.content)
    .toContain('"status":"queued"');
}

function response(content: string): ModelResponse {
  return {
    content, toolCalls: [], stopReason: "stop",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for rendered output");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

class MemoryTerminal implements Terminal {
  readonly columns = 140;
  readonly rows = 50;
  readonly chunks: string[] = [];
  kittyProtocolActive = false;
  private input: ((data: string) => void) | undefined;
  private didStart: (() => void) | undefined;
  readonly started = new Promise<void>((resolve) => { this.didStart = resolve; });
  get output(): string { return this.chunks.join(""); }
  start(input: (data: string) => void): void { this.input = input; this.didStart?.(); }
  send(data: string): void { this.input?.(data); }
  type(data: string): void { for (const character of data) this.send(character); }
  stop(): void { this.input = undefined; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.chunks.push(data); }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}
