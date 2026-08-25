import {
  Editor,
  type EditorTheme,
  ProcessTerminal,
  Text,
  TuiMainScreen,
  type TUI,
  Container,
  matchesKey,
} from "@earendil-works/pi-tui";

import type { SessionRuntimeEvent } from "../runtime/index.js";
import {
  SessionController,
  type SessionSnapshot,
} from "../runtime/index.js";

export interface InteractiveOptions {
  session: SessionController;
  initialMessage?: string;
  resumeOnStart?: boolean;
}

const theme: EditorTheme = {
  borderColor: (text) => text,
  selectList: {
    selectedPrefix: (text) => text,
    selectedText: (text) => text,
    description: (text) => text,
    scrollInfo: (text) => text,
    noMatch: (text) => text,
  },
};

/** Small pi-tui surface. Runtime state remains entirely in SessionController. */
export async function runInteractive(options: InteractiveOptions): Promise<number> {
  const terminal = new ProcessTerminal();
  const tui: TUI = new TuiMainScreen(terminal, true);
  const transcript = new Container();
  const editor = new Editor(tui, theme);
  let responseBlock: Text | undefined;
  let responseText = "";
  let closed = false;
  let submitting = false;
  let resolveClosed: (() => void) | undefined;
  const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });

  const write = (text: string): void => {
    transcript.addChild(new Text(text));
    tui.requestRender();
  };
  const finishResponse = (suffix: string): void => {
    // Keep one mutable response block instead of one component per delta.
    if (responseBlock === undefined) {
      responseBlock = new Text("", 1, 1);
      transcript.addChild(responseBlock);
    }
    responseBlock.setText(responseText.length > 0 ? `${responseText}\n${suffix}` : suffix);
    responseBlock = undefined;
    responseText = "";
    tui.requestRender();
  };
  const writeStatus = (snapshot: SessionSnapshot): void => {
    const run = snapshot.runId === undefined ? "new Run" : snapshot.runId;
    const turn = snapshot.turnId === undefined ? "idle" : snapshot.turnId;
    write(`\n[${snapshot.status}] ${run} / ${turn} | pending ${snapshot.pendingInputs}`);
  };

  tui.addChild(transcript);
  tui.addChild(editor);
  tui.setFocus(editor);
  const unsubscribe = options.session.subscribe((runtimeEvent) => {
    if (runtimeEvent.kind === "event") {
      const event = runtimeEvent.event;
      if (event.type === "message.sent" && event.payload.message.from === "teto") {
        const payload = event.payload.message.payload;
        if (payload.type === "advice.propose") {
          write(`\n[Teto] ${payload.advice.claim}\n`);
        }
      } else if (event.type === "advice.acknowledged") {
        write(`\n[Teto ${event.payload.disposition}] ${event.payload.reason ?? ""}\n`);
      } else if (event.type === "turn.waiting") {
        write(`\n[waiting] ${event.payload.reason}; use /resume or /cancel\n`);
      } else if (event.type === "turn.failed") {
        write(`\n[turn failed] ${event.payload.error}\n`);
      }
    } else if (runtimeEvent.kind === "stream") {
      const event = runtimeEvent.event;
      if (event.type === "stream.delta") {
        responseText += event.delta;
        if (responseBlock === undefined) {
          responseBlock = new Text("", 1, 1);
          transcript.addChild(responseBlock);
        }
        responseBlock.setText(responseText);
        tui.requestRender();
      } else if (event.type === "stream.start") {
        responseText = "";
        responseBlock = new Text("", 1, 1);
        transcript.addChild(responseBlock);
        tui.requestRender();
      } else if (event.type === "stream.end") {
        responseBlock = undefined;
        responseText = "";
      } else if (event.type === "stream.failed") {
        finishResponse(`[model error] ${event.error}`);
      } else if (event.type === "stream.cancelled") {
        finishResponse(`[cancelled] ${event.reason}`);
      }
    } else if (runtimeEvent.kind === "state") {
      if (runtimeEvent.snapshot.status === "idle") {
        tui.requestRender();
      }
    }
  });

  const finish = async (code: number): Promise<void> => {
    if (closed) return;
    closed = true;
    unsubscribe();
    await options.session.close();
    tui.stop();
    process.exitCode = code;
    resolveClosed?.();
  };

  const onSignal = (): void => { void finish(0); };
  process.once("SIGTERM", onSignal);
  process.stdin.once("end", onSignal);

  const submitText = async (
    text: string,
    requestedDelivery?: "steering" | "follow-up",
  ): Promise<void> => {
    const value = text.trim();
    if (value.length === 0 || submitting || closed) return;
    editor.addToHistory(value);
    editor.setText("");
    if (value.startsWith("/")) {
      await handleCommand(value);
      return;
    }
    submitting = true;
    write(`\n> ${value}\n`);
    try {
      await options.session.submit({
        inputId: createInputId(),
        text: value,
        delivery: requestedDelivery
          ?? (options.session.snapshot().status === "running" ? "steering" : "new-turn"),
      });
    } catch (error: unknown) {
      write(`\n[${error instanceof Error ? error.message : String(error)}]\n`);
    } finally {
      submitting = false;
    }
  };

  const handleCommand = async (commandLine: string): Promise<void> => {
    const [command, ...args] = commandLine.split(/\s+/);
    try {
      switch (command) {
        case "/help":
          write("\n/help /status /new /resume /cancel /resolve <operation-id> /exit | Alt+Enter queues follow-up\n");
          break;
        case "/status":
          writeStatus(options.session.snapshot());
          break;
        case "/new":
          await options.session.newRun();
          write("\n[new Run]\n");
          break;
        case "/resume":
          await options.session.resumeCurrent();
          write("\n[resume requested]\n");
          break;
        case "/cancel":
          await options.session.cancel();
          write("\n[cancel requested]\n");
          break;
        case "/resolve":
          if (args[0] === undefined) throw new Error("/resolve requires an operation id");
          await options.session.resolveOperation(args[0]);
          write("\n[operation resolved as failed]\n");
          break;
        case "/exit":
          await finish(0);
          break;
        default:
          write(`\nUnknown command: ${command}. Try /help.\n`);
      }
    } catch (error: unknown) {
      write(`\n[${error instanceof Error ? error.message : String(error)}]\n`);
    }
  };

  editor.onSubmit = (text) => { void submitText(text); };
  tui.addInputListener((data) => {
    if (matchesKey(data, "alt+enter")) {
      if (!submitting && !closed) {
        const text = editor.getText();
        editor.setText("");
        void submitText(text, "follow-up");
      }
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+c")) {
      if (options.session.snapshot().status === "running") {
        void options.session.cancel();
      } else {
        void finish(130);
      }
      return { consume: true };
    }
    return undefined;
  });

  write("Nausicaa interactive session. /help for commands.\n");
  if (options.session.snapshot().runId !== undefined) {
    for (const entry of await options.session.transcript()) {
      if (entry.role === "tool") continue;
      write(entry.role === "user" ? `\n> ${entry.content}\n` : `\n${entry.content}\n`);
    }
  }
  writeStatus(options.session.snapshot());
  tui.start();
  if (options.resumeOnStart === true) {
    try {
      await options.session.resumeCurrent();
    } catch (error: unknown) {
      write(`\n[${error instanceof Error ? error.message : String(error)}]\n`);
    }
  }
  if (options.initialMessage !== undefined) {
    await submitText(options.initialMessage);
  }

  await closedPromise;
  process.removeListener("SIGTERM", onSignal);
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

function createInputId(): string {
  return `input-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
