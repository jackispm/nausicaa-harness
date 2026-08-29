import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Terminal } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import {
  clipboardImagePasteKey,
  runInteractive,
} from "../../src/cli/interactive.js";
import {
  getNausicaaColorScheme,
  setNausicaaColorScheme,
} from "../../src/cli/tui-components.js";
import type {
  AgentTool,
  ModelPort,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "../../src/domain/index.js";
import { JsonlLedger } from "../../src/ledger/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import {
  SessionController,
  type SessionRuntimeEvent,
} from "../../src/runtime/index.js";
import { FileContentAddressedStore } from "../../src/store/index.js";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

describe("interactive TUI", () => {
  it("treats same-tick Enter submissions as steering and preserves explicit follow-up", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-queue-delivery-"));
    const previousExitCode = process.exitCode;
    let releaseFirst = (_response: ModelResponse): void => {};
    const firstResponse = new Promise<ModelResponse>((resolve) => { releaseFirst = resolve; });
    try {
      const model = new ScriptedModel([
        async () => firstResponse,
        response("STEERING_ANSWER"),
        response("FOLLOW_UP_ANSWER"),
      ]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 3, tetoEnabled: false },
      }, { mainModel: model, createRunId: () => "interactive-queue-delivery-run" });
      const events: SessionRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.type("first");
      terminal.send("\r");
      // No await here: the second Enter arrives before SessionController's
      // admission microtask has published its running state.
      terminal.type("second");
      terminal.send("\r");
      terminal.type("third");
      terminal.send("\x1b\r");
      await waitForPendingInputs(session, 2);

      const pending = await session.pendingInputs();
      expect(pending.map((input) => input.delivery)).toEqual(["steering", "follow-up"]);

      releaseFirst(response("FIRST_ANSWER"));
      await waitForModelCalls(model, 3);
      await waitForOutput(terminal, "FOLLOW_UP_ANSWER");
      const admissions = events
        .filter((event): event is Extract<SessionRuntimeEvent, { kind: "event" }> => event.kind === "event")
        .map((event) => event.event)
        .filter((event): event is Extract<typeof event, { type: "input.admitted" }> => event.type === "input.admitted");
      expect(admissions.map((event) => event.payload.delivery)).toEqual([
        "new-turn",
        "steering",
        "follow-up",
      ]);

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      releaseFirst(response("cleanup"));
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("admits queued Enter input before a concurrent /exit closes the session", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-queue-exit-"));
    const previousExitCode = process.exitCode;
    let releaseAdmission = (): void => {};
    const admissionGate = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    let releaseFirst = (_response: ModelResponse): void => {};
    const firstResponse = new Promise<ModelResponse>((resolve) => { releaseFirst = resolve; });
    try {
      const model = new ScriptedModel([
        async () => firstResponse,
        response("QUEUED_INPUT_ANSWER"),
      ]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: model, createRunId: () => "interactive-queue-exit-run" });
      const originalSubmit = session.submit.bind(session);
      let holdFirstAdmission = true;
      (session as unknown as {
        submit: typeof session.submit;
      }).submit = async (request) => {
        if (holdFirstAdmission) {
          holdFirstAdmission = false;
          await admissionGate;
        }
        return originalSubmit(request);
      };
      const events: SessionRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.type("first");
      terminal.send("\r");
      terminal.type("queued before exit");
      terminal.send("\r");
      terminal.type("/exit");
      terminal.send("\r");
      await delay(40);
      expect(model.callCount).toBe(0);

      releaseFirst(response("FIRST_ANSWER"));
      releaseAdmission();
      await expect(running).resolves.toBe(0);

      const admissions = events
        .filter((event): event is Extract<SessionRuntimeEvent, { kind: "event" }> => event.kind === "event")
        .map((event) => event.event)
        .filter((event): event is Extract<typeof event, { type: "input.admitted" }> => event.type === "input.admitted");
      expect(admissions).toHaveLength(2);
      expect(admissions.map((event) => event.payload.delivery)).toEqual(["new-turn", "steering"]);
    } finally {
      releaseAdmission();
      releaseFirst(response("cleanup"));
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "Ctrl+D",
      expectedCode: 0,
      trigger: (terminal: MemoryTerminal): void => { terminal.send("\x04"); },
    },
    {
      name: "two idle Ctrl+C presses after clearing the draft",
      expectedCode: 130,
      trigger: (terminal: MemoryTerminal): void => {
        terminal.type("discard this draft");
        terminal.send("\x03");
        terminal.send("\x03");
        terminal.send("\x03");
      },
    },
    {
      name: "SIGTERM",
      expectedCode: 0,
      trigger: (_terminal: MemoryTerminal): void => {
        process.emit("SIGTERM", "SIGTERM");
      },
    },
    {
      name: "SIGINT",
      expectedCode: 130,
      trigger: (_terminal: MemoryTerminal): void => {
        process.emit("SIGINT", "SIGINT");
      },
    },
  ])("admits accepted input before $name shutdown", async ({ expectedCode, trigger }) => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-signal-exit-"));
    const previousExitCode = process.exitCode;
    let releaseAdmission = (): void => {};
    const admissionGate = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    let markSubmitStarted = (): void => {};
    const submitStarted = new Promise<void>((resolve) => { markSubmitStarted = resolve; });
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([response("answer")]),
        createRunId: () => "interactive-signal-exit-run",
      });
      const originalSubmit = session.submit.bind(session);
      (session as unknown as { submit: typeof session.submit }).submit = async (request) => {
        markSubmitStarted();
        await admissionGate;
        return originalSubmit(request);
      };
      const events: SessionRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({ session, terminal, forceAltScreen: true });
      let exited = false;
      void running.then(() => { exited = true; });

      await terminal.started;
      terminal.type("persist before shutdown");
      terminal.send("\r");
      await submitStarted;
      trigger(terminal);
      await delay(40);
      expect(exited).toBe(false);

      releaseAdmission();
      await expect(running).resolves.toBe(expectedCode);
      expect(events.some((event) =>
        event.kind === "event" && event.event.type === "input.admitted"
      )).toBe(true);
    } finally {
      releaseAdmission();
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires two idle Ctrl+C presses within the exit window", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-double-interrupt-"));
    const previousExitCode = process.exitCode;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: new ScriptedModel([]) });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        interruptExitWindowMs: 100,
      });
      let exited = false;
      void running.then(() => { exited = true; });

      await terminal.started;
      terminal.send("\x03");
      await waitForOutput(terminal, "Press Ctrl+C again to exit");
      await delay(20);
      expect(exited).toBe(false);

      terminal.send("\x03");
      await expect(running).resolves.toBe(130);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("expires the idle Ctrl+C exit window", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-interrupt-timeout-"));
    const previousExitCode = process.exitCode;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: new ScriptedModel([]) });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        interruptExitWindowMs: 20,
      });
      let exited = false;
      void running.then(() => { exited = true; });

      await terminal.started;
      terminal.send("\x03");
      await delay(50);
      terminal.send("\x03");
      await delay(10);
      expect(exited).toBe(false);

      terminal.send("\x03");
      await expect(running).resolves.toBe(130);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses Ctrl+C to cancel a running Turn without closing the TUI", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-running-interrupt-"));
    const previousExitCode = process.exitCode;
    let releaseFirst = (_response: ModelResponse): void => {};
    const firstResponse = new Promise<ModelResponse>((resolve) => { releaseFirst = resolve; });
    try {
      const model = new ScriptedModel([
        async () => firstResponse,
        response("AFTER_CANCEL_ANSWER"),
      ]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: model });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.type("cancel this turn");
      terminal.send("\r");
      await waitForModelCalls(model, 1);
      terminal.send("\x03");
      await waitForCondition(
        () => session.snapshot().status !== "running" && session.snapshot().status !== "cancelling",
        "cancelled Turn to settle",
      );

      terminal.type("continue after cancel");
      terminal.send("\r");
      await waitForOutput(terminal, "AFTER_CANCEL_ANSWER");
      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      releaseFirst(response("cleanup"));
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shows shortcut help for an empty '?' but preserves '?' in normal input", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-shortcut-help-"));
    const previousExitCode = process.exitCode;
    try {
      const model = new ScriptedModel([response("QUESTION_ANSWER")]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: model });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.send("?");
      await waitForOutput(terminal, "Prompt");
      expect(model.callCount).toBe(0);

      terminal.type("why?");
      terminal.send("\r");
      await waitForOutput(terminal, "QUESTION_ANSWER");
      expect(model.requests[0]?.messages.at(-1))
        .toMatchObject({ role: "user", content: "why?" });

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("copies the last assistant answer through the injected clipboard writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-copy-"));
    const previousExitCode = process.exitCode;
    const copied: string[] = [];
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: new ScriptedModel([response("COPY_SENTINEL")]) });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        clipboardTextWriter: async (text) => { copied.push(text); },
      });

      await terminal.started;
      terminal.type("answer first");
      terminal.send("\r");
      await waitForOutput(terminal, "COPY_SENTINEL");
      terminal.type("/copy");
      terminal.send("\r");
      await waitForOutput(terminal, "Copied last assistant message");
      expect(copied).toEqual(["COPY_SENTINEL"]);

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the platform-specific clipboard shortcut in help contracts", () => {
    expect(clipboardImagePasteKey("win32")).toBe("alt+v");
    expect(clipboardImagePasteKey("darwin")).toBe("ctrl+v");
    expect(clipboardImagePasteKey("linux")).toBe("ctrl+v");
  });

  it("mounts a fixed alternate-screen surface and restores the terminal", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 4, tetoEnabled: false },
      }, { mainModel: new ScriptedModel([]) });

      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
      });
      await terminal.started;
      await delay(120);
      terminal.type("/exit");
      terminal.send("\r");
      const result = await running;

      expect(result).toBe(0);
      expect(terminal.output).toContain("\x1b[?1049h");
      expect(terminal.output).toContain("\x1b[?1049l");
      expect(terminal.output).toContain("\x1b[48;2;232;232;232m");
      expect(terminal.output).toContain("version");
      expect(terminal.output).not.toContain("Ctrl+E");
      expect(terminal.cursorVisible).toBe(true);
      expect(exitFrame(terminal.output)).not.toContain('Try "inspect this project"');
      expect(exitFrame(terminal.output)).not.toContain("← main");
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("submits and restores image-only turns without rendering image data", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-image-"));
    const previousExitCode = process.exitCode;
    const image = {
      type: "image" as const,
      data: Buffer.from("private-image-bytes").toString("base64"),
      mimeType: "image/png",
    };
    try {
      const model = new ScriptedModel([response("IMAGE_ONLY_ANSWER")]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: model,
        createRunId: () => "interactive-image-run",
      });
      const terminal = new MemoryTerminal(100, 28);
      const completed = waitForDurableEvent(session, "turn.completed");
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        initialImages: [image],
      });

      await terminal.started;
      await completed;
      await waitForOutput(terminal, "IMAGE_ONLY_ANSWER");
      await waitForOutput(terminal, "1 image");
      expect(terminal.output).toContain("PNG");
      expect(terminal.output).not.toContain(image.data);
      expect(model.requests[0]?.messages.find((message) =>
        message.role === "user" && message.images !== undefined
      )).toMatchObject({ content: "", images: [image] });

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);

      process.exitCode = previousExitCode;
      const reopened = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        runId: "interactive-image-run",
      });
      const restoredTerminal = new MemoryTerminal(100, 28);
      const restored = runInteractive({
        session: reopened,
        terminal: restoredTerminal,
        forceAltScreen: true,
      });
      await restoredTerminal.started;
      await waitForOutput(restoredTerminal, "1 image");
      expect(restoredTerminal.output).toContain("PNG");
      expect(restoredTerminal.output).toContain("IMAGE_ONLY_ANSWER");
      expect(restoredTerminal.output).not.toContain(image.data);
      restoredTerminal.type("/exit");
      restoredTerminal.send("\r");
      await expect(restored).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an image draft when the selected model is text-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-text-only-image-"));
    const previousExitCode = process.exitCode;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "text-only",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new TextOnlyScriptedModel([]),
      });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        initialImages: [{ type: "image", mimeType: "image/png", data: TINY_PNG.toString("base64") }],
      });

      await terminal.started;
      await waitForOutput(terminal, "selected model does not support image input");
      expect(session.snapshot().status).toBe("detached");

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses Prime-style clipboard markers for image-only, history, and deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-clipboard-image-"));
    const previousExitCode = process.exitCode;
    try {
      const model = new ScriptedModel([
        response("PASTED_IMAGE_ANSWER"),
        response("HISTORY_IMAGE_ANSWER"),
        response("TEXT_ONLY_ANSWER"),
      ]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: model,
        createRunId: () => "interactive-clipboard-image-run",
      });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        clipboardImageReader: async () => ({
          bytes: TINY_PNG,
          mimeType: "image/png",
        }),
      });

      await terminal.started;
      terminal.send("\x16");
      await waitForOutput(terminal, "[image #1]");
      terminal.send("\r");
      await waitForModelCalls(model, 1);
      await waitForOutput(terminal, "PASTED_IMAGE_ANSWER");

      expect(model.requests[0]?.messages.at(-1)).toMatchObject({
        role: "user",
        content: "[image #1]",
        images: [{ mimeType: "image/png", data: TINY_PNG.toString("base64") }],
      });

      terminal.send("\x1b[A");
      terminal.send("\r");
      await waitForModelCalls(model, 2);
      await waitForOutput(terminal, "HISTORY_IMAGE_ANSWER");
      expect(model.requests[1]?.messages.at(-1)).toMatchObject({
        role: "user",
        content: "[image #1]",
        images: [{ mimeType: "image/png" }],
      });

      terminal.send("\x1b[A");
      terminal.send("\x0b");
      terminal.type("text only");
      terminal.send("\r");
      await waitForModelCalls(model, 3);
      await waitForOutput(terminal, "TEXT_ONLY_ANSWER");
      const lastUser = model.requests[2]?.messages.filter((message) => message.role === "user").at(-1);
      if (lastUser?.role !== "user") throw new Error("missing final user message");
      expect(lastUser).toMatchObject({ role: "user", content: "text only" });
      expect(lastUser.images).toBeUndefined();
      expect(terminal.output).not.toContain(TINY_PNG.toString("base64"));

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not rebind restored image markers after a process restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-image-restart-"));
    const previousExitCode = process.exitCode;
    try {
      const firstModel = new ScriptedModel([response("FIRST_IMAGE_ANSWER")]);
      const firstSession = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: firstModel,
        createRunId: () => "interactive-image-restart-run",
      });
      const firstTerminal = new MemoryTerminal(100, 28);
      const firstRunning = runInteractive({
        session: firstSession,
        terminal: firstTerminal,
        forceAltScreen: true,
        clipboardImageReader: async () => ({ bytes: TINY_PNG, mimeType: "image/png" }),
      });
      await firstTerminal.started;
      firstTerminal.send("\x16");
      await waitForOutput(firstTerminal, "[image #1]");
      firstTerminal.send("\r");
      await waitForOutput(firstTerminal, "FIRST_IMAGE_ANSWER");
      firstTerminal.type("/exit");
      firstTerminal.send("\r");
      await expect(firstRunning).resolves.toBe(0);

      process.exitCode = previousExitCode;
      const secondBytes = Buffer.from([9, 8, 7]);
      const secondModel = new ScriptedModel([response("SECOND_IMAGE_ANSWER")]);
      const secondSession = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        runId: "interactive-image-restart-run",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: secondModel });
      const secondTerminal = new MemoryTerminal(100, 28);
      const secondRunning = runInteractive({
        session: secondSession,
        terminal: secondTerminal,
        forceAltScreen: true,
        clipboardImageReader: async () => ({ bytes: secondBytes, mimeType: "image/png" }),
      });
      await secondTerminal.started;
      secondTerminal.send("\x16");
      await waitForOutput(secondTerminal, "[image #2]");
      secondTerminal.send("\r");
      await waitForOutput(secondTerminal, "SECOND_IMAGE_ANSWER");
      expect(secondModel.requests[0]?.messages.at(-1)).toMatchObject({
        role: "user",
        content: "[image #2]",
        images: [{ data: secondBytes.toString("base64") }],
      });

      secondTerminal.send("\x1b[A");
      secondTerminal.send("\x1b[A");
      secondTerminal.send("\r");
      await waitForOutput(secondTerminal, "no longer available");
      expect(secondModel.callCount).toBe(1);

      secondTerminal.send("\x15");
      secondTerminal.type("/exit");
      secondTerminal.send("\r");
      await expect(secondRunning).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reserves literal markers and blocks unresolved references", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-image-literal-"));
    const previousExitCode = process.exitCode;
    try {
      const model = new ScriptedModel([]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: model });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        clipboardImageReader: async () => ({ bytes: TINY_PNG, mimeType: "image/png" }),
      });

      await terminal.started;
      terminal.type("literal [image #1] ");
      terminal.send("\x16");
      await waitForOutput(terminal, "[image #2]");
      terminal.send("\r");
      await waitForOutput(terminal, "no longer available");
      expect(model.callCount).toBe(0);

      terminal.send("\x15");
      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("evicts unprotected history images and reports expired markers", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-image-eviction-"));
    const previousExitCode = process.exitCode;
    try {
      const model = new ScriptedModel([response("FIRST_EVICTION_ANSWER")]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: model });
      const terminal = new MemoryTerminal(100, 28);
      const completed = waitForDurableEvent(session, "turn.completed");
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        clipboardImageReader: async () => ({ bytes: TINY_PNG, mimeType: "image/png" }),
        pastedImageBudgetBytes: TINY_PNG.byteLength,
      });

      await terminal.started;
      terminal.send("\x16");
      await waitForOutput(terminal, "[image #1]");
      terminal.send("\r");
      await completed;
      await waitForOutput(terminal, "FIRST_EVICTION_ANSWER");

      terminal.send("\x16");
      await waitForOutput(terminal, "[image #2]");
      terminal.send("\x15");
      terminal.send("\x1b[A");
      terminal.send("\r");
      await waitForOutput(terminal, "no longer available");
      expect(model.callCount).toBe(1);

      terminal.send("\x15");
      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes clipboard reads and cancels attachment when the draft changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-image-race-"));
    const previousExitCode = process.exitCode;
    const reads = [
      deferredClipboardImage(),
      deferredClipboardImage(),
      deferredClipboardImage(),
    ];
    let readIndex = 0;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: new ScriptedModel([]) });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        clipboardImageReader: () => {
          const read = reads[readIndex];
          readIndex += 1;
          if (read === undefined) throw new Error("unexpected clipboard read");
          return read.promise;
        },
      });

      await terminal.started;
      terminal.send("\x16");
      terminal.send("\x16");
      await waitForCondition(() => readIndex === 1, "first serialized clipboard read");
      reads[0]?.resolve({ bytes: TINY_PNG, mimeType: "image/png" });
      await waitForOutput(terminal, "[image #1]");
      await waitForCondition(() => readIndex === 2, "second serialized clipboard read");
      reads[1]?.resolve({ bytes: TINY_PNG, mimeType: "image/png" });
      await waitForOutput(terminal, "[image #2]");

      terminal.send("\x16");
      await waitForCondition(() => readIndex === 3, "third clipboard read");
      terminal.type("draft changed");
      reads[2]?.resolve({ bytes: TINY_PNG, mimeType: "image/png" });
      await waitForOutput(terminal, "draft changed while the clipboard");
      expect(terminal.output).not.toContain("[image #3]");

      terminal.send("\x03");
      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("checks clipboard byte size before base64 encoding", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-image-size-"));
    const previousExitCode = process.exitCode;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: new ScriptedModel([]) });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        clipboardImageReader: async () => ({
          bytes: new Uint8Array(3 * 1024 * 1024 + 1),
          mimeType: "image/png",
        }),
      });

      await terminal.started;
      terminal.send("\x16");
      await waitForOutput(terminal, "exceeds the 3 MiB limit");
      expect(terminal.output).not.toContain("[image #1]");

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves pasted images through steering and follow-up queues", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-queued-image-"));
    const previousExitCode = process.exitCode;
    let releaseFirst = (_response: ModelResponse): void => {};
    const firstResponse = new Promise<ModelResponse>((resolve) => { releaseFirst = resolve; });
    try {
      const model = new ScriptedModel([
        async () => firstResponse,
        response("STEERED_IMAGE_ANSWER"),
        response("FOLLOW_UP_IMAGE_ANSWER"),
      ]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 3, tetoEnabled: false },
      }, {
        mainModel: model,
        createRunId: () => "interactive-queued-image-run",
      });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        clipboardImageReader: async () => ({ bytes: TINY_PNG, mimeType: "image/png" }),
      });

      await terminal.started;
      terminal.type("start main work");
      terminal.send("\r");
      await waitForModelCalls(model, 1);

      terminal.type("steer with image ");
      terminal.send("\x16");
      await waitForOutput(terminal, "[image #1]");
      terminal.send("\r");
      terminal.type("follow up with image ");
      terminal.send("\x16");
      await waitForOutput(terminal, "[image #2]");
      terminal.send("\x1b\r");
      await waitForPendingInputs(session, 2);

      releaseFirst(response("FIRST_BOUNDARY"));
      await waitForModelCalls(model, 3);
      await waitForOutput(terminal, "FOLLOW_UP_IMAGE_ANSWER");

      const steering = model.requests[1]?.messages.findLast((message) =>
        message.role === "user" && message.content.includes("steer with image")
      );
      const followUp = model.requests[2]?.messages.findLast((message) =>
        message.role === "user" && message.content.includes("follow up with image")
      );
      if (steering?.role !== "user" || followUp?.role !== "user") {
        throw new Error("missing queued image messages");
      }
      expect(steering.images).toEqual([
        expect.objectContaining({ mimeType: "image/png", data: TINY_PNG.toString("base64") }),
      ]);
      expect(followUp.images).toEqual([
        expect.objectContaining({ mimeType: "image/png", data: TINY_PNG.toString("base64") }),
      ]);
      expect(terminal.output).not.toContain(TINY_PNG.toString("base64"));

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      releaseFirst(response("cleanup"));
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shows and explicitly revises the durable Run Goal", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-goal-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 4, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([]),
        createRunId: () => "interactive-goal-run",
      });
      const events: SessionRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      await delay(120);
      terminal.type("/goal Understand this repository");
      terminal.send("\r");
      await waitForOutput(terminal, "Goal v1: Understand this repository");
      terminal.type("/goal Explain installation precisely");
      terminal.send("\r");
      await waitForOutput(terminal, "Goal v2: Explain installation precisely");

      expect(session.snapshot().goal).toMatchObject({
        version: 2,
        statement: "Explain installation precisely",
      });
      expect(events
        .filter((event) => event.kind === "event" && event.event.type === "goal.revised"))
        .toHaveLength(1);

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["/context", "/usage"])(
    "renders %s locally without model or Ledger mutation",
    async (command) => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-context-"));
    const terminal = new MemoryTerminal(60, 28);
    const previousExitCode = process.exitCode;
    try {
      const model = new ScriptedModel([]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: model,
        createRunId: () => "interactive-context-run",
      });
      const events: SessionRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.type(command);
      terminal.send("\r");
      await waitForOutput(terminal, "Cumulative usage");
      expect(terminal.output).toContain("Current context:");
      expect(terminal.output).toContain("not measured yet");
      expect(model.callCount).toBe(0);
      expect(events.filter((event) => event.kind === "event")).toHaveLength(0);

      if (command === "/context") {
        terminal.type("/context extra");
        terminal.send("\r");
        await waitForOutput(terminal, "Usage: /context");
        expect(model.callCount).toBe(0);
        expect(events.filter((event) => event.kind === "event")).toHaveLength(0);
      }

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([44, 100])(
    "completes command arguments and preserves a multiline Goal at %i columns",
    async (columns) => {
      const root = await mkdtemp(join(tmpdir(), `nausicaa-tui-command-arguments-${columns}-`));
      const terminal = new MemoryTerminal(columns, 28);
      const previousExitCode = process.exitCode;
      try {
        const session = await SessionController.open({
          workspace: root,
          dataDir: join(root, "state"),
          model: "scripted",
          policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
        }, {
          mainModel: new ScriptedModel([]),
          createRunId: () => `interactive-command-arguments-${columns}`,
        });
        const running = runInteractive({ session, terminal, forceAltScreen: true });

        await terminal.started;
        terminal.type("/permissions fu");
        await waitForOutput(terminal, "Full Access");
        terminal.send("\r");
        terminal.send("\r");
        await waitForOutput(terminal, "Permissions set to full-access");
        expect(session.snapshot().permissionProfile).toBe("full-access");

        terminal.type("/goal Keep the first line");
        terminal.send("\n");
        terminal.type("and preserve the second line");
        terminal.send("\r");
        await waitForCondition(
          () => session.snapshot().goal?.statement === "Keep the first line\nand preserve the second line",
          "multiline Goal revision",
        );

        // Completing an argument and submitting a multiline command must leave
        // the editor focused for the next command on both narrow and wide TUIs.
        terminal.type("/status");
        terminal.send("\r");
        await waitForOutput(terminal, "Queue / Tokens");

        terminal.type("/exit");
        terminal.send("\r");
        await expect(running).resolves.toBe(0);
      } finally {
        process.exitCode = previousExitCode;
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("uses Prime-style focused selectors to switch Main and restores editor focus", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-selectors-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted-main",
        tetoModel: "scripted-teto",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: new ScriptedModel([response("PLAN_ANSWER")]) });
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        modelChoices: ["openrouter:next-model"],
      });

      await terminal.started;
      terminal.type("/model");
      terminal.send("\r");
      await waitForOutput(terminal, "Models");
      expect(session.snapshot().model).toBe("scripted-main");

      terminal.type("next");
      await waitForOutput(terminal, "openrouter:next-model");
      terminal.send("\r");
      await waitForOutput(terminal, "Main model set to openrouter:next-model");
      expect(session.snapshot().model).toBe("openrouter:next-model");

      terminal.type("/model openrouter:direct-model");
      terminal.send("\r");
      await waitForOutput(terminal, "Main model set to openrouter:direct-model");
      expect(session.snapshot().model).toBe("openrouter:direct-model");

      terminal.type("/theme");
      terminal.send("\r");
      await waitForOutput(terminal, "Preview with Up/Down");
      terminal.send("\x1b[B");
      terminal.send("\r");
      await waitForOutput(terminal, "Theme set to light");

      terminal.type("/theme");
      terminal.send("\r");
      await waitForOutput(terminal, "Esc to restore");
      terminal.send("\x1b[B");
      terminal.send("\x1b");

      // Cancel must restore editor focus; this command would otherwise be
      // consumed as selector search text.
      terminal.type("/status");
      terminal.send("\r");
      await waitForOutput(terminal, "Queue / Tokens");

      terminal.type("/permissions");
      terminal.send("\r");
      await waitForOutput(terminal, "Choose the capability boundary");
      terminal.send("\x1b[B");
      terminal.send("\r");
      await waitForOutput(terminal, "Permissions set to workspace");
      expect(session.snapshot()).toMatchObject({
        permissionProfile: "workspace",
        allowWrite: true,
        allowShell: false,
        allowNetwork: false,
      });

      terminal.type("/mode");
      terminal.send("\r");
      await waitForOutput(terminal, "Default can act; Plan investigates");
      terminal.send("\x1b[B");
      terminal.send("\r");
      await waitForOutput(terminal, "Plan mode selected");
      expect(session.snapshot().collaborationMode).toBe("plan");

      terminal.type("/mode default");
      terminal.send("\r");
      await waitForOutput(terminal, "Default mode selected");
      terminal.type("/plan Propose a focused migration");
      terminal.send("\r");
      await waitForOutput(terminal, "PLAN_ANSWER");
      expect(session.snapshot().collaborationMode).toBe("plan");

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("switches saved workspace Runs through the session selector and reloads transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-sessions-"));
    const dataDir = join(root, "state");
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const older = await SessionController.open({
        workspace: root,
        dataDir,
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([response("OLDER_TRANSCRIPT_ANSWER")]),
        createRunId: () => "older-session-run",
      });
      await older.reviseGoal("OLDER_SESSION_GOAL");
      await older.submit({ inputId: "older-input", text: "OLDER_SESSION_GOAL" });
      await older.waitForIdle();
      await older.close();

      const current = await SessionController.open({
        workspace: root,
        dataDir,
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([response("CURRENT_TRANSCRIPT_ANSWER")]),
        createRunId: () => "current-session-run",
      });
      await current.reviseGoal("CURRENT_SESSION_GOAL");
      await current.submit({ inputId: "current-input", text: "CURRENT_SESSION_GOAL" });
      await current.waitForIdle();
      const running = runInteractive({ session: current, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.type("/session");
      terminal.send("\r");
      await waitForOutput(terminal, "Resume a saved Run from this workspace");
      terminal.send("\x1b");
      terminal.type("/status");
      terminal.send("\r");
      await waitForOutput(terminal, "Queue / Tokens");
      expect(current.snapshot().runId).toBe("current-session-run");

      const selectorCount = countOccurrences(
        terminal.output,
        "Resume a saved Run from this workspace",
      );
      terminal.type("/session");
      terminal.send("\r");
      await waitForCondition(
        () => countOccurrences(
          terminal.output,
          "Resume a saved Run from this workspace",
        ) > selectorCount,
        "second session selector",
      );
      terminal.type("older-session-run");
      await waitForOutput(terminal, "OLDER_SESSION_GOAL");
      const beforeSwitch = terminal.output.length;
      terminal.send("\r");
      await waitForCondition(
        () => current.snapshot().runId === "older-session-run",
        "selected Run attachment",
      );
      await waitForOutput(terminal, "Attached Run older-session-run");
      await waitForOutput(terminal, "OLDER_TRANSCRIPT_ANSWER");
      const olderFrame = terminal.output.slice(beforeSwitch);
      expect(olderFrame).toContain("OLDER_TRANSCRIPT_ANSWER");
      expect(olderFrame.lastIndexOf("OLDER_TRANSCRIPT_ANSWER"))
        .toBeGreaterThan(olderFrame.lastIndexOf("CURRENT_TRANSCRIPT_ANSWER"));
      await expect(current.transcript()).resolves.toEqual([
        expect.objectContaining({ role: "user", content: "OLDER_SESSION_GOAL" }),
        expect.objectContaining({ role: "assistant", content: "OLDER_TRANSCRIPT_ANSWER" }),
      ]);

      terminal.type("/session current-session-run");
      terminal.send("\r");
      await waitForCondition(
        () => current.snapshot().runId === "current-session-run",
        "direct Run attachment",
      );
      await waitForOutput(terminal, "Attached Run current-session-run");

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clears the previous transcript when an attached Run cannot hydrate its artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-session-artifact-"));
    const dataDir = join(root, "state");
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const damaged = await SessionController.open({
        workspace: root,
        dataDir,
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([response("DAMAGED_TRANSCRIPT_ANSWER")]),
        createRunId: () => "damaged-artifact-run",
      });
      await damaged.reviseGoal("DAMAGED_ARTIFACT_GOAL");
      await damaged.submit({ inputId: "damaged-input", text: "DAMAGED_ARTIFACT_GOAL" });
      await damaged.waitForIdle();
      await damaged.close();
      await rm(join(dataDir, "runs", "damaged-artifact-run", "store"), {
        recursive: true,
        force: true,
      });

      const current = await SessionController.open({
        workspace: root,
        dataDir,
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([response("CURRENT_ARTIFACT_ANSWER")]),
        createRunId: () => "current-artifact-run",
      });
      await current.reviseGoal("CURRENT_ARTIFACT_GOAL");
      await current.submit({ inputId: "current-input", text: "CURRENT_ARTIFACT_GOAL" });
      await current.waitForIdle();
      const running = runInteractive({ session: current, terminal, forceAltScreen: true });

      await terminal.started;
      await waitForOutput(terminal, "CURRENT_ARTIFACT_ANSWER");
      terminal.type("/session damaged-artifact-run");
      const chunkCountBeforeSwitch = terminal.outputChunks.length;
      terminal.send("\r");
      await waitForCondition(
        () => current.snapshot().runId === "damaged-artifact-run",
        "damaged Run attachment",
      );
      await waitForOutput(terminal, "was not found");
      const transition = terminal.outputChunks.slice(chunkCountBeforeSwitch).join("");
      expect(transition).toContain("was not found");
      expect(transition).not.toContain("CURRENT_ARTIFACT_GOAL");
      expect(transition).not.toContain("CURRENT_ARTIFACT_ANSWER");

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses session switching while Main has an active Turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-session-active-"));
    const dataDir = join(root, "state");
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    let releaseCurrent = (_response: ModelResponse): void => {};
    try {
      const saved = await SessionController.open({
        workspace: root,
        dataDir,
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([]),
        createRunId: () => "saved-session-run",
      });
      await saved.reviseGoal("Saved Run");
      await saved.close();

      const responseGate = new Promise<ModelResponse>((resolve) => { releaseCurrent = resolve; });
      const current = await SessionController.open({
        workspace: root,
        dataDir,
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([async () => responseGate]),
        createRunId: () => "active-session-run",
      });
      const running = runInteractive({ session: current, terminal, forceAltScreen: true });
      await terminal.started;
      terminal.type("Keep working");
      terminal.send("\r");
      await waitForCondition(() => current.snapshot().status === "running", "active Turn");

      terminal.type("/session saved-session-run");
      terminal.send("\r");
      await waitForOutput(terminal, "/session is unavailable while Main is working");
      expect(current.snapshot().runId).toBe("active-session-run");
      terminal.type("/session");
      terminal.send("\r");
      await waitForCondition(
        () => countOccurrences(
          terminal.output,
          "/session is unavailable while Main is working",
        ) >= 2,
        "selector rejection during active Turn",
      );
      expect(current.snapshot().runId).toBe("active-session-run");

      releaseCurrent(response("ACTIVE_SESSION_ANSWER"));
      await current.waitForIdle();
      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      releaseCurrent(response("cleanup"));
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back an unconfirmed theme preview during SIGTERM shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-selector-signal-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    const previousScheme = getNausicaaColorScheme();
    setNausicaaColorScheme("light");
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: new ScriptedModel([]) });
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.type("/theme");
      terminal.send("\r");
      await waitForOutput(terminal, "Preview with Up/Down");
      terminal.send("\x1b[B");
      terminal.send("\x1b[B");
      await waitForCondition(
        () => getNausicaaColorScheme() === "dark",
        "dark theme preview",
      );

      process.emit("SIGTERM", "SIGTERM");
      await expect(running).resolves.toBe(0);
      expect(getNausicaaColorScheme()).toBe("light");
    } finally {
      process.exitCode = previousExitCode;
      setNausicaaColorScheme(previousScheme);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats an external SIGINT as selector cancel before allowing exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-selector-sigint-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: new ScriptedModel([]) });
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.type("/model");
      terminal.send("\r");
      await waitForOutput(terminal, "Models");
      process.emit("SIGINT", "SIGINT");
      await delay(20);
      expect(session.snapshot().status).not.toBe("closed");

      terminal.type("/status");
      terminal.send("\r");
      await waitForOutput(terminal, "Queue / Tokens");
      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders a tool lifecycle and replaces partial deltas with the committed answer", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-tool-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 4, tetoEnabled: false },
      }, {
        mainModel: new PartialToolModel(),
        tools: [inspectTool],
        createRunId: () => "interactive-tool-run",
      });
      const completed = waitForDurableEvent(session, "turn.completed");
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      await delay(120);
      terminal.type("inspect the manifest");
      terminal.send("\r");
      await completed;
      await waitForOutput(terminal, "FINAL_COMMITTED_SENTINEL");

      expect(terminal.output).toContain("inspect_manifest");
      expect(terminal.output).toContain("package.json");
      expect(terminal.output).not.toContain("TOOL_RESULT_COMMITTED");

      terminal.send("\x0f");
      await waitForOutput(terminal, "TOOL_RESULT_COMMITTED");
      expect(terminal.output).toContain("arguments");
      expect(terminal.output).toContain("package.json");
      expect(terminal.output).toContain("result");

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
      expect(terminal.output).toContain("\x1b[?1049l");
      expect(exitFrame(terminal.output)).toContain("Nausicaa");
      expect(exitFrame(terminal.output)).not.toContain("▄██▀");
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders an unresolved tool from the attached transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-unknown-tool-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const initial = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([response("done")]),
        createRunId: () => "interactive-unknown-tool-run",
      });
      await initial.submit({ inputId: "initial-input", text: "prepare" });
      await initial.waitForIdle();
      const runId = initial.snapshot().runId!;
      await initial.close();

      const store = await FileContentAddressedStore.open(
        join(root, "state", "runs", runId, "store"),
      );
      const argumentsRef = await store.put(
        JSON.stringify({ path: "src/config.ts", content: "replacement" }),
        "application/vnd.nausicaa.tool-arguments+json",
      );
      const ledger = await JsonlLedger.open(
        join(root, "state", "runs", runId, "ledger.jsonl"),
      );
      const events = await ledger.read({ runId });
      const turnId = events.find((event) => event.type === "turn.started")?.payload.turnId;
      if (turnId === undefined) throw new Error("missing test Turn");
      await ledger.append({
        runId,
        turnId,
        laneId: "main",
        type: "tool.requested",
        payload: {
          operationId: "unknown-op",
          toolCallId: "unknown-call",
          name: "write_file",
          argumentsRef,
        },
        correlationId: `turn:${turnId}`,
        idempotencyKey: "test:unknown-request",
        visibility: "run",
      });
      await ledger.append({
        runId,
        turnId,
        laneId: "main",
        type: "tool.unknown",
        payload: {
          operationId: "unknown-op",
          toolCallId: "unknown-call",
          name: "write_file",
          reason: "provider response was lost",
        },
        correlationId: `turn:${turnId}`,
        idempotencyKey: "test:unknown-outcome",
        visibility: "run",
      });
      await ledger.close();

      const resumed = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        runId,
      });
      const running = runInteractive({ session: resumed, terminal, forceAltScreen: true });
      await terminal.started;
      await waitForOutput(terminal, "unknown-op");

      expect(terminal.output).toContain("write_file");
      expect(terminal.output).toContain("unknown");
      expect(terminal.output).toContain("src/config.ts");
      expect(terminal.output).toContain("replacement");
      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("updates the durable Worker summary from running through ready and done", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-worker-summary-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    let releaseWorker = (_response: ModelResponse): void => {};
    let releaseMain = (_response: ModelResponse): void => {};
    let markWorkerStarted = (): void => {};
    let markMainWaiting = (): void => {};
    const workerStarted = new Promise<void>((resolve) => { markWorkerStarted = resolve; });
    const mainWaiting = new Promise<void>((resolve) => { markMainWaiting = resolve; });
    try {
      const workerModel = new ScriptedModel([async () => {
        markWorkerStarted();
        return new Promise<ModelResponse>((resolve) => { releaseWorker = resolve; });
      }]);
      const mainModel = new ScriptedModel([
        response("Delegating", [{
          id: "delegate-summary",
          name: "delegate_task",
          arguments: {
            taskId: "summary-task",
            statement: "Inspect the package name",
            successCriteria: ["Return the package name"],
            maxModelTokens: 200,
            maxWallClockMs: 5_000,
          },
        }], "toolUse"),
        async () => {
          markMainWaiting();
          return new Promise<ModelResponse>((resolve) => { releaseMain = resolve; });
        },
        response("WORKER_SUMMARY_DONE"),
      ]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted/main",
        workerModel: "scripted/worker",
        workerEnabled: true,
        policy: {
          maxMainStepsPerActivation: 4,
          maxModelTokens: 10_000,
          tetoEnabled: false,
        },
      }, {
        mainModel,
        workerModel,
        tools: [inspectTool],
        createRunId: () => "interactive-worker-summary-run",
      });
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.type("inspect in parallel");
      terminal.send("\r");
      await Promise.all([workerStarted, mainWaiting]);
      await waitForOutput(terminal, "1 Worker task · 1 running");

      releaseWorker(response("package name: nausicaa"));
      await waitForOutput(terminal, "1 Worker task · 1 ready");

      releaseMain(response("Commit the Worker result", [{
        id: "worker-boundary",
        name: "inspect_manifest",
        arguments: { path: "package.json" },
      }], "toolUse"));
      await waitForOutput(terminal, "WORKER_SUMMARY_DONE");
      await waitForOutput(terminal, "1 Worker task · 1 done");

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      releaseWorker(response("cleanup"));
      releaseMain(response("cleanup"));
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shows one durable failure notice and does not persist a streamed fragment", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-failure-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new FailingStreamModel(),
        createRunId: () => "interactive-failure-run",
      });
      const failed = waitForDurableEvent(session, "turn.failed");
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      await delay(120);
      terminal.type("fail after starting");
      terminal.send("\r");
      await failed;
      await waitForOutput(terminal, "Turn failed.");

      expect(countOccurrences(terminal.output, "Turn failed.")).toBe(1);
      await expect(session.transcript()).resolves.toEqual([
        expect.objectContaining({ role: "user", content: "fail after starting" }),
      ]);

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a length-limited answer and explains how to continue it", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-output-limit-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const model = new ScriptedModel([
        response("PARTIAL_OUTPUT_SENTINEL", [], "length"),
        response("CONTINUED_OUTPUT_SENTINEL"),
      ]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: model,
        createRunId: () => "interactive-output-limit-run",
      });
      const originalSubmit = session.submit.bind(session);
      let releaseSubmit = (): void => {};
      const submitGate = new Promise<void>((resolve) => { releaseSubmit = resolve; });
      session.submit = async (request) => {
        const result = await originalSubmit(request);
        await submitGate;
        return result;
      };
      const waiting = waitForDurableEvent(session, "turn.waiting");
      const completed = waitForDurableEvent(session, "turn.completed");
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      await delay(120);
      terminal.type("write a long answer");
      terminal.send("\r");
      await waiting;
      await waitForOutput(terminal, "The model reached its output limit");

      expect(terminal.output).toContain("PARTIAL_OUTPUT_SENTINEL");
      expect(session.snapshot().blocker).toBe("model-output-limit");
      terminal.type("/resume");
      terminal.send("\r");
      releaseSubmit();
      await waitForOutput(terminal, "CONTINUED_OUTPUT_SENTINEL");
      await completed;

      expect(model.requests[1]?.messages.at(-1)?.content)
        .toContain("Continue exactly where it stopped");
      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });
});

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

class PartialToolModel implements ModelPort {
  private call = 0;

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("stream() should be used by the interactive runtime");
  }

  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.call += 1;
    yield { type: "start" };
    if (this.call === 1) {
      yield { type: "thinking-start" };
      yield { type: "thinking-delta", delta: "Inspect the smallest useful source first." };
      yield { type: "thinking-end" };
      yield { type: "text-delta", delta: "Inspecting" };
      yield {
        type: "done",
        response: response("Inspecting the manifest.", [{
          id: "inspect-1",
          name: "inspect_manifest",
          arguments: { path: "package.json" },
        }], "toolUse"),
      };
      return;
    }
    yield { type: "text-delta", delta: "FINAL_PART" };
    yield { type: "done", response: response("FINAL_COMMITTED_SENTINEL") };
  }
}

class TextOnlyScriptedModel extends ScriptedModel {
  capabilities(): { imageInput: boolean } {
    return { imageInput: false };
  }
}

class FailingStreamModel implements ModelPort {
  async complete(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("stream() should be used by the interactive runtime");
  }

  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield { type: "start" };
    yield { type: "text-delta", delta: "HALF_SENTENCE" };
    yield { type: "error", error: new Error("provider failed") };
  }
}

const inspectTool: AgentTool = {
  definition: {
    name: "inspect_manifest",
    description: "Return a deterministic manifest summary",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  async execute() {
    return {
      content: [
        "line one",
        "line two",
        "line three",
        "line four",
        "line five",
        "line six",
        "TOOL_RESULT_COMMITTED",
      ].join("\n"),
      isError: false,
    };
  },
};

function response(
  content: string,
  toolCalls: ModelResponse["toolCalls"] = [],
  stopReason = "stop",
): ModelResponse {
  return {
    content,
    toolCalls,
    stopReason,
    usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
  };
}

function waitForDurableEvent(
  session: SessionController,
  type: "turn.completed" | "turn.failed" | "turn.waiting",
): Promise<void> {
  return new Promise<void>((resolve) => {
    const unsubscribe = session.subscribe((runtimeEvent: SessionRuntimeEvent) => {
      if (runtimeEvent.kind !== "event" || runtimeEvent.event.type !== type) return;
      unsubscribe();
      resolve();
    });
  });
}

async function waitForOutput(terminal: MemoryTerminal, expected: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!terminal.output.includes(expected)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for TUI output: ${expected}`);
    await delay(10);
  }
}

async function waitForModelCalls(model: ScriptedModel, expected: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (model.callCount < expected) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected} model calls`);
    await delay(10);
  }
}

async function waitForPendingInputs(session: SessionController, expected: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while ((await session.pendingInputs()).length < expected) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected} pending inputs`);
    await delay(10);
  }
}

function countOccurrences(value: string, expected: string): number {
  return value.split(expected).length - 1;
}

function exitFrame(output: string): string {
  const exit = output.lastIndexOf("\x1b[?1049l");
  return exit < 0 ? "" : output.slice(exit);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deferredClipboardImage(): {
  promise: Promise<{ bytes: Uint8Array; mimeType: "image/png" }>;
  resolve: (image: { bytes: Uint8Array; mimeType: "image/png" }) => void;
} {
  let resolve = (_image: { bytes: Uint8Array; mimeType: "image/png" }): void => {};
  const promise = new Promise<{ bytes: Uint8Array; mimeType: "image/png" }>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForCondition(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await delay(10);
  }
}
