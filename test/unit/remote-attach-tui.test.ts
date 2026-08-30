import type { Terminal } from "@earendil-works/pi-tui";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import {
  runRemoteAttach,
  type RemoteAttachSession,
} from "../../src/cli/remote-attach.js";
import type {
  DaemonRemoteSessionState,
  SessionSnapshot,
} from "../../src/runtime/index.js";

describe("remote attach TUI", () => {
  it("renders a durable transcript and detaches without issuing a Run command", async () => {
    const terminal = new MemoryTerminal(100, 28);
    const close = vi.fn(async () => undefined);
    const session: RemoteAttachSession = {
      workspace: "/workspace",
      snapshot: () => snapshot(),
      state: () => ({ snapshot: snapshot(), attachmentStatus: "attached" }),
      transcript: async () => [
        { role: "user", content: "remote question", turnId: "turn-1" },
        {
          role: "assistant",
          content: "remote answer",
          hasToolCalls: false,
          turnId: "turn-1",
        },
      ],
      workerTaskSummary: () => ({
        total: 0,
        queued: 0,
        running: 0,
        ready: 0,
        done: 0,
        failed: 0,
        stale: 0,
      }),
      subscribe: (_listener: (state: DaemonRemoteSessionState) => void) => () => undefined,
      close,
    };

    const running = runRemoteAttach({ session, terminal, forceAltScreen: true });
    await terminal.started;
    await waitFor(() => stripTerminalSequences(terminal.output).includes("remote answer"));
    terminal.send("q");

    await expect(running).resolves.toBe(0);
    expect(close).toHaveBeenCalledOnce();
  });
});

function snapshot(): SessionSnapshot {
  return {
    workspace: "/workspace",
    runId: "run-1",
    status: "idle",
    model: "scripted",
    tetoEnabled: false,
    workerEnabled: false,
    permissionProfile: "read-only",
    collaborationMode: "default",
    allowWrite: false,
    allowShell: false,
    allowNetwork: false,
    workspaceBashAvailability: { available: false, reason: "remote" },
    pendingInputs: 0,
    lastCommittedStep: 1,
    mainContextTokens: null,
    mainContextWindowTokens: null,
    usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
  };
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
  stop(): void { delete this.input; }
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

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for remote TUI output");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
