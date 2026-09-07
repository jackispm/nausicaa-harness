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
  SessionCompactionNotice,
  SessionSnapshot,
  SessionTranscriptEntry,
  WorkerTaskSummary,
} from "../runtime/index.js";
import {
  ActivityLine,
  AgentMessageBlock,
  AssistantMessageBlock,
  BrandSplashHeader,
  getNausicaaColorScheme,
  NoticeBlock,
  parseExternalA2APrompt,
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
  /** Use Pi's fullscreen/alternate-screen dock; false keeps regular scrollback. */
  readonly forceAltScreen?: boolean;
}

export interface RemoteAttachSession {
  readonly workspace: string;
  snapshot(): SessionSnapshot;
  state(): DaemonRemoteSessionState;
  transcript(): Promise<SessionTranscriptEntry[]>;
  /** Durable lifecycle projection; optional for older embedders. */
  compactionHistory?: () => Promise<SessionCompactionNotice[]>;
  workerTaskSummary(): WorkerTaskSummary;
  subscribe(listener: (state: DaemonRemoteSessionState) => void): () => void;
  close(): Promise<void>;
}

/** Read-only product surface over one daemon-owned Run attachment. */
export async function runRemoteAttach(options: RemoteAttachOptions): Promise<number> {
  const terminal = options.terminal ?? new ProcessTerminal();
  // Keep the attached interactive surface on the same fixed Pi dock as the
  // primary CLI. Regular scrollback remains an explicit embedding option.
  const useAltScreen = options.forceAltScreen !== false;
  const tui: TUI = useAltScreen
    ? new TuiAltScreen(terminal, undefined, undefined, { mouse: true })
    : new TuiMainScreen(terminal);
  // Match Pi: clearOnShrink is controlled by the TUI default, environment, or
  // host settings. A forced true value would clear main-screen scrollback.
  const requestTuiRender = (force = false): void => {
    if (force) tui.invalidate();
    tui.requestRender();
  };
  terminal.setTitle("Nausicaa");
  const screen = new VStack();
  const documentContainer = new Container();
  const transcript = new Container();
  const activity = new ActivityLine(() => options.session.snapshot(), tui);
  const statusContainer = new Container();
  let activityMounted = false;
  const syncActivityStatus = (): void => {
    const status = options.session.snapshot().status;
    const shouldMount = status === "running" || status === "cancelling";
    if (shouldMount && !activityMounted) {
      activity.start();
      statusContainer.clear();
      statusContainer.addChild(activity);
      activityMounted = true;
    } else if (!shouldMount && activityMounted) {
      activity.stop();
      statusContainer.clear();
      activityMounted = false;
    }
  };
  const header = new BrandSplashHeader({
    version: "0.1.0",
  });
  const headerContainer = new Container();
  documentContainer.addChild(headerContainer);
  documentContainer.addChild(transcript);
  const viewport = new ScrollView(documentContainer, {
    follow: "end",
    primary: true,
    scrollbar: "auto",
  });
  let toolsExpanded = false;
  let agentMessagesExpanded = false;
  const agentMessageBlocks = new Map<string, AgentMessageBlock>();
  let closing = false;
  let refreshRequested = false;
  let refreshTail = Promise.resolve();
  let finishPromise: Promise<void> | undefined;
  let exitCode = 0;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });

  const workerTaskSummary = new WorkerTaskSummaryLine(
    () => options.session.workerTaskSummary(),
  );
  const sessionTray = new SessionTray(
    () => options.session.snapshot(),
    () => attachmentLabel(options.session.state().attachmentStatus),
  );
  const widgetContainerAbove = new Container();
  widgetContainerAbove.addChild(workerTaskSummary);
  const footerContainer = new Container();
  footerContainer.addChild(sessionTray);
  const dock = new VStack([
    { component: statusContainer, shrink: 1, minSize: 0 },
    { component: widgetContainerAbove, shrink: 1, minSize: 0 },
    { component: footerContainer, shrink: 1, minSize: 1 },
  ]);
  screen.addChild(viewport, { basis: 0, grow: 1, shrink: 1, minSize: 1 });
  if (tui instanceof TuiAltScreen) {
    screen.addChild(dock, { basis: "auto", grow: 0, shrink: 1, minSize: 1 });
    tui.setLayoutRoot(screen);
  } else {
    tui.addChild(documentContainer);
    tui.addChild(statusContainer);
    tui.addChild(widgetContainerAbove);
    tui.addChild(footerContainer);
  }

  const append = (
    component: Parameters<Container["addChild"]>[0],
    spaceBefore = true,
  ): void => {
    if (spaceBefore && transcript.children.length > 0) transcript.addChild(new Spacer(1));
    transcript.addChild(component);
  };

  const renderTranscript = async (): Promise<void> => {
    const [entries, compactionHistory] = await Promise.all([
      options.session.transcript(),
      options.session.compactionHistory?.() ?? Promise.resolve([]),
    ]);
    transcript.clear();
    agentMessageBlocks.clear();
    const state = options.session.state();
    syncActivityStatus();
    if (state.error !== undefined) {
      append(new NoticeBlock(state.error, "warning"));
    }
    for (const notice of compactionHistory) {
      const presentation = compactionNoticePresentation(notice);
      append(new NoticeBlock(presentation.message, presentation.kind));
    }
    for (const entry of entries) {
      if (entry.role === "user") {
        const agentMessage = parseExternalA2APrompt(entry.content);
        if (agentMessage !== undefined) {
          const previous = transcript.children.at(-1);
          const block = new AgentMessageBlock(agentMessage, {
            suppressLeadingSpace: previous instanceof AgentMessageBlock,
          });
          block.setExpanded(agentMessagesExpanded);
          agentMessageBlocks.set(agentMessage.messageId, block);
          // The component owns its leading spacer, matching Prime's compact
          // adjacent agent-message layout.
          append(block, false);
          continue;
        }
        append(new UserMessageBlock(entry.content, entry.imageTypes));
        continue;
      }
      if (entry.role === "assistant") {
        if (!entry.hasToolCalls) {
          // The assistant component owns Pi's leading spacer. Do not add a
          // second transcript spacer around it.
          append(new AssistantMessageBlock(entry.content, false), false);
        }
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
  const finish = (code: number): Promise<void> => {
    if (finishPromise !== undefined) return finishPromise;
    closing = true;
    exitCode = code;
    finishPromise = (async () => {
      unsubscribe();
      activity.stop();
      statusContainer.clear();
      activityMounted = false;
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
    if (matchesKey(data, "ctrl+p")) {
      agentMessagesExpanded = !agentMessagesExpanded;
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
    requestTuiRender(true);
  });
  tui.setTerminalColorSchemeNotifications(true);

  try {
    try {
      await renderTranscript();
    } catch (error: unknown) {
      transcript.clear();
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
        requestTuiRender(true);
      }
    } catch {
      // Not every terminal answers OSC color queries.
    }
    headerContainer.addChild(new Spacer(1));
    headerContainer.addChild(header);
    headerContainer.addChild(new Spacer(1));
    requestTuiRender();
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

function compactionNoticePresentation(
  notice: SessionCompactionNotice,
): { message: string; kind: "info" | "success" | "warning" } {
  switch (notice.status) {
    case "requested":
      return { message: "Compacting context...", kind: "info" };
    case "committed":
      return { message: "Context compacted for the next Turn.", kind: "success" };
    case "failed":
      return { message: "Compaction provider failed; the raw context is unchanged.", kind: "warning" };
    case "fallback":
      return {
        message: "Compaction fell back to the raw context; the transcript is unchanged.",
        kind: "warning",
      };
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
