import {
  Container,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  Spacer,
  type Terminal,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  type TUI,
} from "@earendil-works/pi-tui";

import type {
  DaemonRemoteSessionState,
  SessionSnapshot,
  SessionTranscriptEntry,
  WorkerTaskSummary,
} from "../runtime/index.js";
import {
  ActivityLine,
  AssistantMessageBlock,
  BrandSplashHeader,
  getNausicaaColorScheme,
  NoticeBlock,
  SessionTray,
  ToolStatusBlock,
  UserMessageBlock,
  WorkerTaskSummaryLine,
  setNausicaaColorScheme,
} from "./tui-components.js";

export interface RemoteAttachOptions {
  readonly session: RemoteAttachSession;
  /** Test/embedding seam; production uses ProcessTerminal. */
  readonly terminal?: Terminal;
  readonly forceAltScreen?: boolean;
}

export interface RemoteAttachSession {
  readonly workspace: string;
  snapshot(): SessionSnapshot;
  state(): DaemonRemoteSessionState;
  transcript(): Promise<SessionTranscriptEntry[]>;
  workerTaskSummary(): WorkerTaskSummary;
  subscribe(listener: (state: DaemonRemoteSessionState) => void): () => void;
  close(): Promise<void>;
}

/** Read-only product surface over one daemon-owned Run attachment. */
export async function runRemoteAttach(options: RemoteAttachOptions): Promise<number> {
  const terminal = options.terminal ?? new ProcessTerminal();
  const tui: TUI = (options.forceAltScreen ?? process.stdout.isTTY === true)
    ? new TuiAltScreen(terminal, true, undefined, { mouse: true })
    : new TuiMainScreen(terminal, true);
  const screen = new VStack();
  const transcript = new Container();
  const viewport = new ScrollView(transcript, {
    follow: "end",
    primary: true,
    scrollbar: "auto",
  });
  const activity = new ActivityLine(() => options.session.snapshot());
  const header = new BrandSplashHeader({
    version: "0.1.0",
    getModel: () => options.session.snapshot().model,
    getWorkspace: () => options.session.workspace,
  });
  let toolsExpanded = false;
  let closing = false;
  let refreshRequested = false;
  let refreshTail = Promise.resolve();
  let finishPromise: Promise<void> | undefined;
  let exitCode = 0;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });

  screen.addChild(viewport, { grow: 1, minSize: 1 });
  screen.addChild(activity, { basis: "auto", minSize: 0, shrink: 1 });
  screen.addChild(new WorkerTaskSummaryLine(
    () => options.session.workerTaskSummary(),
  ), { basis: "auto", minSize: 0, shrink: 1 });
  screen.addChild(new SessionTray(
    () => options.session.snapshot(),
    () => attachmentLabel(options.session.state().attachmentStatus),
  ), { basis: 1, minSize: 1, shrink: 0 });
  if (tui instanceof TuiAltScreen) tui.setLayoutRoot(screen);
  else tui.addChild(screen);

  const append = (component: Parameters<Container["addChild"]>[0]): void => {
    if (transcript.children.length > 0) transcript.addChild(new Spacer(1));
    transcript.addChild(component);
  };

  const renderTranscript = async (): Promise<void> => {
    const entries = await options.session.transcript();
    transcript.clear();
    transcript.addChild(header);
    if (entries.length > 0 && terminal.rows < 36) header.setCompact(true);
    const state = options.session.state();
    if (state.error !== undefined) {
      append(new NoticeBlock(state.error, "warning"));
    }
    for (const entry of entries) {
      if (entry.role === "user") {
        append(new UserMessageBlock(entry.content, entry.imageTypes));
        continue;
      }
      if (entry.role === "assistant") {
        if (!entry.hasToolCalls) append(new AssistantMessageBlock(entry.content, false));
        continue;
      }
      const detail = entry.status === "unknown"
        ? `unresolved ${entry.operationId}`
        : entry.isError ? entry.content : "";
      const block = new ToolStatusBlock(entry.toolName, entry.status, detail);
      block.setExpanded(entry.status === "unknown" || toolsExpanded);
      block.setShowExpandHint(false);
      if (entry.arguments !== undefined) block.setArguments(JSON.stringify(entry.arguments, null, 2));
      if (entry.status !== "unknown") block.setResult(entry.content);
      append(block);
    }
    tui.requestRender();
  };

  const scheduleRefresh = (): void => {
    if (closing || refreshRequested) return;
    refreshRequested = true;
    queueMicrotask(() => {
      refreshRequested = false;
      if (closing) return;
      const next = refreshTail.then(renderTranscript).catch((error: unknown) => {
        transcript.clear();
        transcript.addChild(header);
        append(new NoticeBlock(
          error instanceof Error ? error.message : String(error),
          "error",
        ));
        tui.requestRender();
      });
      refreshTail = next.then(() => undefined, () => undefined);
    });
  };

  const unsubscribe = options.session.subscribe(() => scheduleRefresh());
  const activityTimer = setInterval(() => {
    if (options.session.snapshot().status === "running") {
      activity.advance();
      tui.requestRender();
    }
  }, 500);
  activityTimer.unref?.();

  const finish = (code: number): Promise<void> => {
    if (finishPromise !== undefined) return finishPromise;
    closing = true;
    exitCode = code;
    finishPromise = (async () => {
      unsubscribe();
      clearInterval(activityTimer);
      await refreshTail.catch(() => undefined);
      await terminal.drainInput(250, 25).catch(() => undefined);
      try {
        try {
          tui.stop();
        } catch (error: unknown) {
          exitCode = exitCode === 0 ? 1 : exitCode;
          process.stderr.write(
            `Nausicaa terminal shutdown warning: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          );
        }
      } finally {
        await options.session.close().catch((error: unknown) => {
          exitCode = exitCode === 0 ? 1 : exitCode;
          process.stderr.write(
            `Nausicaa detach warning: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        });
        resolveClosed();
      }
    })();
    return finishPromise;
  };

  tui.addInputListener((data) => {
    if (
      matchesKey(data, "ctrl+c")
      || matchesKey(data, "ctrl+d")
      || matchesKey(data, "escape")
      || data === "q"
    ) {
      void finish(matchesKey(data, "ctrl+c") ? 130 : 0);
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+o")) {
      toolsExpanded = !toolsExpanded;
      scheduleRefresh();
      return { consume: true };
    }
    return undefined;
  });

  const onSignal = (): void => { void finish(0); };
  const onInterrupt = (): void => { void finish(130); };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onInterrupt);
  process.stdin.once("end", onSignal);
  tui.onTerminalColorSchemeChange((scheme) => {
    setNausicaaColorScheme(scheme);
    tui.invalidate();
    tui.requestRender(true);
  });
  tui.setTerminalColorSchemeNotifications(true);

  try {
    try {
      await renderTranscript();
    } catch (error: unknown) {
      transcript.clear();
      transcript.addChild(header);
      append(new NoticeBlock(
        error instanceof Error ? error.message : String(error),
        "error",
      ));
    }
    tui.start();
    try {
      const scheme = await tui.queryTerminalColorScheme({ timeoutMs: 100 });
      if (scheme !== undefined && scheme !== getNausicaaColorScheme()) {
        setNausicaaColorScheme(scheme);
        tui.invalidate();
        tui.requestRender(true);
      }
    } catch {
      // Not every terminal answers OSC color queries.
    }
    await closed;
    return exitCode;
  } finally {
    if (!closing) await finish(1);
    else await finishPromise;
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onInterrupt);
    process.stdin.removeListener("end", onSignal);
  }
}

function attachmentLabel(status: DaemonRemoteSessionState["attachmentStatus"]): string {
  switch (status) {
    case "attached": return "daemon attached";
    case "connecting": return "connecting to daemon";
    case "reconnecting": return "reconnecting to daemon";
    case "resyncing": return "resyncing Run history";
    case "closed": return "detached";
  }
}
