import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Markdown,
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

import {
  flattenWorkspaceRunTree,
  listWorkspaceRuns,
  listWorkspaceRunTree,
  SessionController,
  type SessionRuntimeEvent,
  type SessionPendingInput,
  type SessionSnapshot,
  type WorkspaceRunTreeNode,
  type WorkspaceRunTreeRow,
  type WorkspaceRunSummary,
} from "../runtime/index.js";
import {
  MAX_USER_IMAGE_BYTES,
  MAX_USER_IMAGES,
  type UserImage,
  validateUserImages,
} from "../domain/images.js";
import {
  readClipboardImage,
  type ClipboardImageReader,
} from "./clipboard-image.js";
import {
  copyToClipboard,
  type ClipboardTextWriter,
} from "./clipboard-text.js";
import {
  collectMarkedImages,
  evictImagesToBudget,
  formatImageMarker,
  imageMarkerIds,
} from "./image-markers.js";
import {
  collaborationModeOptions,
  filterSelectorOptions,
  modelSelectorOptions,
  normalizeModelSelector,
  parseCollaborationMode,
  parsePermissionProfile,
  parseThemeChoice,
  permissionProfileOptions,
  skillSelectorOptions,
  themeSelectorOptions,
  type SelectorOption,
  type ThemeChoice,
  type ModelSelectorCandidate,
} from "./selectors.js";
import { UNCONFIGURED_MODEL } from "./onboarding.js";
import type { CredentialStatus } from "./onboarding.js";
import { SelectorOverlay } from "./selector-component.js";
import type { SelectorFilter } from "./selector-component.js";
import type { EdgeSelectionController, EdgeSelectionSnapshot } from "./edge-selection.js";
import {
  QueueSelection,
  type QueueSelectionItem,
} from "./queue-selection.js";
import {
  ActivityLine,
  AdviceBlock,
  AssistantMessageBlock,
  BrandSplashHeader,
  ContextUsageBlock,
  EdgeSkillPickerSummary,
  getNausicaaColorScheme,
  nausicaaEditorTheme,
  nausicaaMarkdownTheme,
  NoticeBlock,
  PromptSurface,
  QueuePreview,
  SessionTray,
  ToolStatusBlock,
  UserMessageBlock,
  WorkerTaskSummaryLine,
  selectLatestToolExpandHint,
  setNausicaaColorScheme,
  terminalSafeText,
} from "./tui-components.js";
import {
  formatEdgeStatus,
  type EdgeStatusProjection,
} from "./edge-status.js";
import { AgentTopologyBlock } from "./agent-topology.js";
import type {
  AgentAwarenessInputSource,
  AgentAwarenessQuery,
} from "../runtime/agent-awareness.js";
import {
  canonicalInteractiveCommandName,
  findInteractiveCommand,
  formatInteractiveCommandHelp,
  publicInteractiveCommandSpecs,
} from "./command-registry.js";
import {
  environmentCredentialPresent,
  runAuthCommand,
  type AuthModelPort,
  type Output,
  type SecretInput,
} from "./auth.js";
import type { CredentialStore } from "@earendil-works/pi-ai";

export interface InteractiveOptions {
  session: SessionController;
  initialMessage?: string;
  initialImages?: UserImage[];
  /** Embedding/test seam for an explicit startup continuation; CLI leaves this disabled. */
  resumeOnStart?: boolean;
  /** Test/embedding seam; production uses ProcessTerminal. */
  terminal?: Terminal;
  forceAltScreen?: boolean;
  /** Test/embedding seam; production reads the system clipboard lazily. */
  clipboardImageReader?: ClipboardImageReader;
  /** Test seam; production retains at most 64 MiB of reusable pasted images. */
  pastedImageBudgetBytes?: number;
  /** Test seam; production requires a second idle Ctrl+C within one second. */
  interruptExitWindowMs?: number;
  /** Test seam; production uses the platform clipboard writer. */
  clipboardTextWriter?: ClipboardTextWriter;
  /** Optional extra model candidates shown by the Prime-style `/model` selector. */
  modelChoices?: readonly (string | ModelSelectorCandidate)[];
  /** True when the CLI kept an empty TTY session open for first-run setup. */
  startupModelMissing?: boolean;
  /** Show setup status at startup; setup is not a public slash command. */
  showStartupSetup?: boolean;
  /** Local-only startup status; never contains a complete credential value. */
  startupNotice?: string | (() => string);
  /** Local credential presence only; it is never an authentication result. */
  credentialStatus?: CredentialStatus | (() => CredentialStatus);
  /** Optional provider authentication shared with the host/model boundary. */
  auth?: InteractiveAuthOptions;
  /** Read-only edge status projection supplied by the host/CLI. */
  edgeStatus?: () => EdgeStatusProjection;
  /** Optional host-injected Skill selection seam. */
  edgeSelection?: EdgeSelectionController;
  /** Optional host-owned, read-only Awareness topology source. */
  awareness?:
    | AgentAwarenessQuery
    | AgentAwarenessInputSource
    | (() => Promise<AgentAwarenessQuery | AgentAwarenessInputSource>);
}

export interface InteractiveAuthOptions {
  readonly credentialStore: CredentialStore;
  readonly modelPort: AuthModelPort;
  /** Defaults to the currently selected model provider, then OpenRouter. */
  readonly provider?: string | (() => string);
  /** Environment projection used for conditional logout messaging. */
  readonly environment?: NodeJS.ProcessEnv;
  /** Refresh host-owned status projections after a credential mutation. */
  readonly onChanged?: () => Promise<void> | void;
}

interface QueuedSubmission {
  value: string;
  images?: UserImage[];
  delivery: "new-turn" | "steering" | "follow-up";
  resolve: () => void;
}

interface PromptStash {
  text: string;
  images: readonly (readonly [number, UserImage])[];
}

/**
 * Auth prompts run through the already-active TUI input stream. This keeps
 * secrets out of the Editor and avoids attaching a second raw-stdin reader.
 */
class TuiSecretInput implements SecretInput {
  readonly isTTY = true;
  private readonly listeners = new Set<(chunk: Buffer | string) => void>();
  private cancelled = false;

  private static readonly BRACKETED_PASTE_START = "\x1b[200~";
  private static readonly BRACKETED_PASTE_END = "\x1b[201~";

  setRawMode(_mode: boolean): SecretInput {
    return this;
  }

  resume(): void {}

  pause(): void {}

  on(_event: "data", listener: (chunk: Buffer | string) => void): SecretInput {
    this.listeners.add(listener);
    // `finish()` can cancel the input between creating the auth request and
    // the provider attaching its prompt listener. Replay that cancellation so
    // shutdown cannot leave a hidden prompt pending forever.
    if (this.cancelled) listener("\u0003");
    return this;
  }

  off(_event: "data", listener: (chunk: Buffer | string) => void): SecretInput {
    this.listeners.delete(listener);
    return this;
  }

  push(data: string): void {
    if (
      data.startsWith(TuiSecretInput.BRACKETED_PASTE_START)
      && data.endsWith(TuiSecretInput.BRACKETED_PASTE_END)
    ) {
      this.emit(data.slice(
        TuiSecretInput.BRACKETED_PASTE_START.length,
        -TuiSecretInput.BRACKETED_PASTE_END.length,
      ));
      return;
    }
    this.emit(data);
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.emit("\u0003");
  }

  private emit(data: string): void {
    if (this.cancelled && data !== "\u0003") return;
    for (const listener of [...this.listeners]) listener(data);
  }
}

const quietAuthOutput: Output = {
  write: () => true,
};

const MAX_PASTED_IMAGE_BYTES = 64 * 1024 * 1024;
const DEFAULT_INTERRUPT_EXIT_WINDOW_MS = 1_000;

/** Pi-inspired presentation layer. Runtime state stays in SessionController. */
export async function runInteractive(options: InteractiveOptions): Promise<number> {
  const terminal = options.terminal ?? new ProcessTerminal();
  // Pi-style fullscreen mode keeps the transcript scrollable and the prompt docked.
  // Main-screen mode remains available when stdout is not a real terminal.
  const tui: TUI = (options.forceAltScreen ?? process.stdout.isTTY === true)
    ? new TuiAltScreen(terminal, true, undefined, { mouse: true })
    : new TuiMainScreen(terminal, true);
  const screen = new VStack();
  const transcript = new Container();
  const activity = new ActivityLine(() => options.session.snapshot());
  const shortcutGuide = new Container();
  const queuePreview = new QueuePreview();
  const transcriptViewport = new ScrollView(transcript, {
    follow: "end",
    primary: true,
    scrollbar: "auto",
  });
  // Pi's editor defaults to zero horizontal padding; PromptSurface owns the
  // prompt treatment while the editor keeps the text flush with its border.
  const editor = new Editor(tui, nausicaaEditorTheme, { paddingX: 0 });
  const promptSurface = new PromptSurface(editor);
  const promptSlot = new Container();
  promptSlot.addChild(promptSurface);
  const toolBlocks = new Map<string, ToolStatusBlock>();
  const assistantBlocks: AssistantMessageBlock[] = [];
  let thinkingExpanded = true;
  let toolsExpanded = false;
  let responseBlock: AssistantMessageBlock | undefined;
  let responseGroup: Container | undefined;
  let responseSpacer: Spacer | undefined;
  let responseText = "";
  let thinkingText = "";
  let responseTurnId: string | undefined;
  let presentationTail: Promise<void> = Promise.resolve();
  let transcriptGeneration = 0;
  let queueSessionGeneration = 0;
  let queueRefreshTail: Promise<void> = Promise.resolve();
  let queueBrowseTail: Promise<void> = Promise.resolve();
  let pendingQueueEdit: symbol | undefined;
  let queueMutationTail: Promise<void> = Promise.resolve();
  let closing = false;
  let closed = false;
  let activeSecretInput: TuiSecretInput | undefined;
  let activeSubmission: QueuedSubmission | undefined;
  let submissionDrainPromise: Promise<void> | undefined;
  let finishPromise: Promise<void> | undefined;
  let queuedFinishCode: number | undefined;
  let interruptExitUntil = 0;
  let interruptExitTimer: ReturnType<typeof setTimeout> | undefined;
  let themePreference: ThemeChoice = "auto";
  let detectedColorScheme = getNausicaaColorScheme();
  let activeSelector: {
    component: SelectorOverlay;
    restorePreview: () => void;
  } | undefined;
  const submissionQueue: QueuedSubmission[] = [];
  const queueSelection = new QueueSelection();
  let pendingQueue: SessionPendingInput[] = [];
  // Compaction lifecycle events are durable UI evidence. Counters let the
  // slash command avoid adding a second success/error notice when the event
  // projection already rendered the outcome.
  let compactionCommittedEvents = 0;
  let compactionFailureEvents = 0;
  const pastedImages = new Map<number, UserImage>();
  const promptStashes = new Map<string, PromptStash>();
  let detachedPromptStashSequence = 1;
  let promptStashScope = options.session.snapshot().runId ?? "<new-run:0>";
  const promptHistory: string[] = [];
  const reservedImageMarkerIds = new Set<number>();
  const pastedImageBudgetBytes = options.pastedImageBudgetBytes ?? MAX_PASTED_IMAGE_BYTES;
  const interruptExitWindowMs = Math.max(
    1,
    options.interruptExitWindowMs ?? DEFAULT_INTERRUPT_EXIT_WINDOW_MS,
  );
  let nextImageMarkerId = 1;
  let editorRevision = 0;
  let clipboardPasteTail: Promise<void> = Promise.resolve();
  let resolveClosed: (() => void) | undefined;
  const renderedAssistants = new Set<string>();
  const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const pasteImageKey = clipboardImagePasteKey(process.platform);
  const pasteImageLabel = pasteImageKey === "alt+v" ? "Alt+V" : "Ctrl+V";

  const header = new BrandSplashHeader({
    version: "0.1.0",
  });
  transcript.addChild(header);
  screen.addChild(transcriptViewport, { grow: 1, minSize: 1 });
  screen.addChild(activity, { basis: "auto", minSize: 0, shrink: 1 });
  screen.addChild(shortcutGuide, { basis: "auto", minSize: 0, shrink: 1 });
  screen.addChild(queuePreview, { basis: "auto", minSize: 0, shrink: 1 });
  screen.addChild(promptSlot, { minSize: 1, shrink: 0 });
  screen.addChild(new WorkerTaskSummaryLine(
    () => options.session.workerTaskSummary(),
  ), {
    basis: "auto",
    minSize: 0,
    shrink: 1,
  });
  screen.addChild(new SessionTray(
    () => options.session.snapshot(),
    () => interruptExitUntil > Date.now() ? "Press Ctrl+C again to exit" : undefined,
  ), {
    basis: 1,
    minSize: 1,
    shrink: 0,
  });
  if (tui instanceof TuiAltScreen) {
    tui.setLayoutRoot(screen);
  } else {
    tui.addChild(screen);
  }
  tui.setFocus(editor);
  const autocompleteCommands = publicInteractiveCommandSpecs().map((spec) => {
    const completion: {
      name: string;
      description: string;
      argumentHint?: string;
      getArgumentCompletions?: (prefix: string) => ReturnType<typeof commandArgumentCompletions>;
    } = {
      name: spec.name,
      description: spec.description,
      ...(spec.argumentHint === undefined ? {} : { argumentHint: spec.argumentHint }),
    };
    if (spec.name === "model") {
      completion.getArgumentCompletions = (prefix) => commandArgumentCompletions(
        readModelOptions(),
        prefix,
      );
    } else if (spec.name === "permissions") {
      completion.getArgumentCompletions = (prefix) => commandArgumentCompletions(
        permissionProfileOptions(
          options.session.snapshot().permissionProfile,
          options.session.snapshot().workspaceBashAvailability,
        ),
        prefix,
      );
    } else if (spec.name === "mode") {
      completion.getArgumentCompletions = (prefix) => commandArgumentCompletions(
        collaborationModeOptions(options.session.snapshot().collaborationMode),
        prefix,
      );
    } else if (spec.name === "theme") {
      completion.getArgumentCompletions = (prefix) => commandArgumentCompletions(
        themeSelectorOptions(themePreference),
        prefix,
      );
    }
    return completion;
  });
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider(
    autocompleteCommands,
    options.session.workspace,
  ));
  const setEditorTextFromQueueSelection = (text: string): void => {
    editor.setText(text);
  };

  const queueSelectionItems = (
    pending: readonly SessionPendingInput[],
  ): QueueSelectionItem[] => pending.map((item) => ({
    inputId: item.inputId,
    revision: item.revision,
    delivery: item.delivery === "steering" ? "steering" : "follow-up",
    text: item.text,
    sequence: item.sequence,
  }));

  const updateQueuePreview = (): void => {
    const selected = queueSelection.selected;
    queuePreview.setItems(pendingQueue.map((item) => ({
      delivery: item.delivery === "steering" ? "steering" : "follow-up",
      text: item.imageTypes === undefined
        ? item.text
        : `${item.text} [${item.imageTypes.length} image(s)]`,
      selected: selected?.inputId === item.inputId
        && selected.revision === item.revision,
    })));
  };

  const resetQueueSelection = (): void => {
    queueSessionGeneration += 1;
    queueSelection.reset();
    pendingQueueEdit = undefined;
    pendingQueue = [];
    updateQueuePreview();
  };

  const restoreDroppedQueueSelection = (
    dropped: QueueSelectionItem | undefined,
  ): void => {
    if (dropped === undefined || pendingQueueEdit !== undefined) return;
    const editorText = editor.getExpandedText();
    if (editorText === dropped.text) {
      setEditorTextFromQueueSelection(queueSelection.reset());
    } else {
      // Keep the in-progress queue edit visible instead of restoring an older draft over it.
      queueSelection.replaceDraft(editorText);
    }
  };

  const refreshQueue = (): Promise<boolean> => {
    const generation = queueSessionGeneration;
    const runId = options.session.snapshot().runId;
    let applied = false;
    const refresh = queueRefreshTail.then(async () => {
      if (
        closed
        || generation !== queueSessionGeneration
        || runId !== options.session.snapshot().runId
      ) return;
      try {
        const pending = await options.session.pendingInputs();
        if (
          closed
          || generation !== queueSessionGeneration
          || runId !== options.session.snapshot().runId
        ) return;
        pendingQueue = pending;
        const dropped = queueSelection.sync(queueSelectionItems(pending));
        restoreDroppedQueueSelection(dropped);
        updateQueuePreview();
        tui.requestRender();
        applied = true;
      } catch {
        if (
          closed
          || generation !== queueSessionGeneration
          || runId !== options.session.snapshot().runId
        ) return;
        // Queue is observational. A closed or detached session simply renders no preview.
        pendingQueue = [];
        restoreDroppedQueueSelection(queueSelection.sync([]));
        queuePreview.setItems([]);
        tui.requestRender();
      }
    });
    queueRefreshTail = refresh.then(() => undefined, () => undefined);
    return refresh.then(() => applied);
  };
  tui.onTerminalColorSchemeChange((scheme) => {
    detectedColorScheme = scheme;
    if (themePreference !== "auto") return;
    setNausicaaColorScheme(scheme);
    tui.invalidate();
    tui.requestRender(true);
  });
  tui.setTerminalColorSchemeNotifications(true);
  // Match pi-tui's Loader cadence so the active request feels alive without
  // tying animation updates to model/network event frequency.
  const activityTimer = setInterval(() => {
    const status = options.session.snapshot().status;
    if (status === "running" || status === "cancelling") {
      activity.advance();
      for (const block of toolBlocks.values()) block.advance();
      tui.requestRender();
    }
  }, 80);
  activityTimer.unref?.();

  const appendBlock = (
    component: Parameters<Container["addChild"]>[0],
    spaceBefore = true,
  ): Spacer | undefined => {
    let spacer: Spacer | undefined;
    if (spaceBefore && transcript.children.length > 0) {
      spacer = new Spacer(1);
      transcript.addChild(spacer);
    }
    transcript.addChild(component);
    tui.requestRender();
    return spacer;
  };

  const appendNotice = (
    message: string,
    kind: "info" | "success" | "warning" | "error" = "info",
  ): void => {
    appendBlock(new NoticeBlock(message, kind));
  };

  const showAgentTopology = async (argument: string): Promise<void> => {
    if (argument.length > 0) throw new Error("Usage: /agents");
    if (options.awareness === undefined) {
      appendNotice(
        "Agent awareness is unavailable: the host did not provide a read-only topology source.",
        "warning",
      );
      return;
    }
    try {
      const source = typeof options.awareness === "function"
        ? await options.awareness()
        : options.awareness;
      appendBlock(new AgentTopologyBlock(source));
    } catch {
      appendNotice("Nausicaa agents · unavailable", "warning");
    }
  };

  const moveQueueSelection = (direction: -1 | 1, draft: string): void => {
    const movement = queueSelection.move(
      queueSelectionItems(pendingQueue),
      draft,
      direction,
    );
    if (movement === undefined) return;
    setEditorTextFromQueueSelection(
      movement.kind === "item" ? movement.item.text : movement.text,
    );
    updateQueuePreview();
    tui.requestRender();
  };

  const browseQueueSelection = (direction: -1 | 1): void => {
    const snapshot = options.session.snapshot();
    if (queueSelection.isBrowsing && pendingQueueEdit === undefined) {
      moveQueueSelection(direction, editor.getExpandedText());
      void refreshQueue();
      return;
    }

    const generation = queueSessionGeneration;
    const runId = snapshot.runId;
    const browse = queueBrowseTail.then(async () => {
      // A mutation becomes durable before its local refresh/finalizer settles.
      // Queue browsing behind that tail so a fast follow-up keypress is not lost.
      await queueMutationTail;
      if (
        closed
        || generation !== queueSessionGeneration
        || runId !== options.session.snapshot().runId
      ) return;
      const browseEditorRevision = editorRevision;
      const draft = editor.getExpandedText();
      if (!await refreshQueue()) return;
      if (
        closed
        || generation !== queueSessionGeneration
        || runId !== options.session.snapshot().runId
        || browseEditorRevision !== editorRevision
        || draft !== editor.getExpandedText()
      ) return;
      moveQueueSelection(direction, draft);
    });
    queueBrowseTail = browse.then(() => undefined, () => undefined);
  };

  const queueReplacementImages = (
    pending: SessionPendingInput,
    text: string,
  ): UserImage[] | undefined => {
    const beforeMarkers = uniqueImageMarkerIds(pending.text);
    const afterMarkers = uniqueImageMarkerIds(text);
    if (sameNumbers(beforeMarkers, afterMarkers)) return undefined;
    if (afterMarkers.length === 0) return [];

    const available = new Map<number, UserImage>();
    beforeMarkers.forEach((markerId, index) => {
      const image = pending.images?.[index];
      if (image !== undefined) available.set(markerId, image);
    });
    for (const [markerId, image] of pastedImages) {
      if (!available.has(markerId)) available.set(markerId, image);
    }
    const missing = afterMarkers.filter((markerId) => !available.has(markerId));
    if (missing.length > 0) {
      throw new Error(
        `Image attachment ${missing.slice(0, 3).map(formatImageMarker).join(", ")} is no longer available.`,
      );
    }
    const images = afterMarkers.map((markerId) => structuredClone(available.get(markerId)!));
    validateUserImages(images);
    return images;
  };

  const enqueueQueueMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queueMutationTail.then(operation, operation);
    queueMutationTail = next.then(() => undefined, () => undefined);
    return next;
  };

  const applyQueueSelection = async (
    text: string,
    delivery: "steering" | "follow-up",
  ): Promise<void> => {
    if (pendingQueueEdit !== undefined) return;
    const selected = queueSelection.selected;
    if (selected === undefined) return;
    const pending = pendingQueue.find((item) => (
      item.inputId === selected.inputId && item.revision === selected.revision
    ));
    const submittedText = text.trim();
    const submittedAtEditorRevision = editorRevision;
    const generation = queueSessionGeneration;
    const mutation = Symbol("pending-queue-edit");
    pendingQueueEdit = mutation;

    try {
      await enqueueQueueMutation(async () => {
        if (generation !== queueSessionGeneration) return;
        if (pending === undefined) {
          await refreshQueue();
          keepStaleQueueEdit(submittedText, submittedAtEditorRevision);
          return;
        }
        const replacementImages = submittedText.length === 0
          ? undefined
          : queueReplacementImages(pending, submittedText);
        const status = submittedText.length === 0
          ? await options.session.withdrawPendingInput(selected.inputId, selected.revision)
          : await options.session.replacePendingInput(selected.inputId, selected.revision, {
              text: submittedText,
              delivery,
              ...(replacementImages === undefined ? {} : { images: replacementImages }),
            });
        if (generation !== queueSessionGeneration) return;
        if (status === "stale") {
          await refreshQueue();
          keepStaleQueueEdit(submittedText, submittedAtEditorRevision);
          return;
        }

        const draft = queueSelection.reset();
        if (editorRevision === submittedAtEditorRevision) {
          setEditorTextFromQueueSelection(draft);
        }
        await refreshQueue();
      });
    } catch (error: unknown) {
      if (generation === queueSessionGeneration) {
        if (editorRevision === submittedAtEditorRevision) {
          setEditorTextFromQueueSelection(submittedText);
        }
        appendNotice(
          `Queued input was not changed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    } finally {
      if (pendingQueueEdit === mutation) pendingQueueEdit = undefined;
      updateQueuePreview();
      tui.requestRender();
    }
  };

  const keepStaleQueueEdit = (
    text: string,
    submittedAtEditorRevision: number,
  ): void => {
    queueSelection.reset();
    if (editorRevision === submittedAtEditorRevision) {
      setEditorTextFromQueueSelection(text);
    }
    appendNotice("Queued input changed before the edit; the draft was kept in the prompt.", "warning");
  };

  const clearShortcutGuide = (): void => {
    if (shortcutGuide.children.length === 0) return;
    shortcutGuide.clear();
    tui.requestRender();
  };

  const showShortcutGuide = (): void => {
    shortcutGuide.clear();
    shortcutGuide.addChild(new Markdown([
      "**Prompt**",
      "`Tab` complete paths  ·  `Alt+Enter` queue follow-up",
      "`Alt+Up/Down` browse and edit queued input",
      "**Controls**",
      `\`${pasteImageLabel}\` paste image  ·  \`Ctrl+S\` stash prompt`,
      "`Ctrl+O` tool output  ·  `Ctrl+T` thinking",
      "**Help**",
      "`/help` commands  ·  `Ctrl+C` cancel or clear; twice when idle to exit",
    ].join("\n\n"), 1, 0, nausicaaMarkdownTheme));
    tui.requestRender();
  };

  const clearInterruptExit = (): void => {
    if (interruptExitTimer !== undefined) clearTimeout(interruptExitTimer);
    interruptExitTimer = undefined;
    if (interruptExitUntil === 0) return;
    interruptExitUntil = 0;
    tui.requestRender();
  };

  const armInterruptExit = (): void => {
    clearInterruptExit();
    interruptExitUntil = Date.now() + interruptExitWindowMs;
    interruptExitTimer = setTimeout(() => {
      interruptExitTimer = undefined;
      interruptExitUntil = 0;
      if (!closed) tui.requestRender();
    }, interruptExitWindowMs);
    interruptExitTimer.unref?.();
    tui.requestRender();
  };

  const addPromptToHistory = (value: string): void => {
    reserveImageMarkers(value);
    editor.addToHistory(value);
    const trimmed = value.trim();
    if (trimmed.length === 0 || promptHistory[0] === trimmed) return;
    promptHistory.unshift(trimmed);
    if (promptHistory.length > 100) promptHistory.pop();
  };

  function reserveImageMarkers(text: string): void {
    for (const markerId of imageMarkerIds(text)) reservedImageMarkerIds.add(markerId);
  }

  const allocateImageMarkerId = async (): Promise<number> => {
    const occupied = new Set<number>([
      ...reservedImageMarkerIds,
      ...pastedImages.keys(),
    ]);
    const add = (text: string): void => {
      for (const markerId of imageMarkerIds(text)) occupied.add(markerId);
    };
    add(editor.getText());
    for (const value of promptHistory) add(value);
    for (const submission of submissionQueue) add(submission.value);
    try {
      for (const pending of await options.session.pendingInputs()) add(pending.text);
    } catch {
      // A detached session may not expose its queue. Local reservations still prevent reuse.
    }

    while (occupied.has(nextImageMarkerId)) nextImageMarkerId += 1;
    if (!Number.isSafeInteger(nextImageMarkerId)) {
      throw new Error("Image marker ids are exhausted");
    }
    const markerId = nextImageMarkerId;
    nextImageMarkerId += 1;
    reservedImageMarkerIds.add(markerId);
    return markerId;
  };

  const rememberPastedImage = (id: number, image: UserImage): void => {
    pastedImages.set(id, image);
    const keep = new Set(imageMarkerIds(editor.getText()));
    keep.add(id);
    for (const stash of promptStashes.values()) {
      for (const [markerId] of stash.images) keep.add(markerId);
    }
    try {
      evictImagesToBudget(
        pastedImages,
        (value) => Buffer.byteLength(value.data, "base64"),
        pastedImageBudgetBytes,
        keep,
      );
    } catch (error: unknown) {
      pastedImages.delete(id);
      throw error;
    }
  };

  const handleClipboardImagePaste = async (): Promise<void> => {
    const revision = editorRevision;
    let clipboardImage;
    try {
      clipboardImage = await (options.clipboardImageReader ?? readClipboardImage)();
    } catch {
      // Prime treats an unavailable or unreadable clipboard as a no-op.
      return;
    }
    if (clipboardImage === null || closed) return;
    if (revision !== editorRevision) {
      appendNotice("Image not attached because the draft changed while the clipboard was being read.", "warning");
      return;
    }
    if (
      clipboardImage.bytes.byteLength === 0
      || clipboardImage.bytes.byteLength > MAX_USER_IMAGE_BYTES
    ) {
      appendNotice("Image not attached: clipboard image exceeds the 3 MiB limit.", "warning");
      return;
    }

    const attachment: UserImage = {
      type: "image",
      data: Buffer.from(clipboardImage.bytes).toString("base64"),
      mimeType: clipboardImage.mimeType,
    };
    try {
      const liveImages = collectMarkedImages(pastedImages, editor.getText());
      if (liveImages.length >= MAX_USER_IMAGES) {
        throw new Error(`At most ${MAX_USER_IMAGES} images may be attached`);
      }
      validateUserImages([...liveImages, attachment]);
    } catch (error: unknown) {
      appendNotice(
        `Image not attached: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
      return;
    }

    const markerId = await allocateImageMarkerId();
    if (closed) return;
    if (revision !== editorRevision) {
      appendNotice("Image not attached because the draft changed while the clipboard was being read.", "warning");
      return;
    }
    try {
      rememberPastedImage(markerId, attachment);
    } catch (error: unknown) {
      appendNotice(
        `Image not attached: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
      return;
    }
    editor.insertTextAtCursor(formatImageMarker(markerId));
    tui.requestRender();
  };

  const queueClipboardImagePaste = (): void => {
    clipboardPasteTail = clipboardPasteTail
      .then(handleClipboardImagePaste)
      .catch((error: unknown) => {
        if (!closed) {
          appendNotice(
            `Image not attached: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        }
      });
  };

  const promptStashKey = (): string => promptStashScope;

  const adoptAttachedPromptStashScope = (): void => {
    const runId = options.session.snapshot().runId;
    if (runId === undefined || !promptStashScope.startsWith("<new-run:")) return;
    const stash = promptStashes.get(promptStashScope);
    if (stash !== undefined) promptStashes.set(runId, stash);
    promptStashes.delete(promptStashScope);
    promptStashScope = runId;
  };

  const snapshotPromptStash = (text: string): PromptStash => {
    const markerIds = new Set(imageMarkerIds(text));
    const images = [...pastedImages.entries()]
      .filter(([markerId]) => markerIds.has(markerId))
      .map(([markerId, image]) => [markerId, structuredClone(image)] as const);
    return { text, images };
  };

  const handlePromptStash = (): void => {
    const key = promptStashKey();
    // Expand pi-tui paste placeholders before clearing the editor so a large
    // pasted prompt remains complete even though this client has no paste-
    // snapshot restoration API.
    const text = editor.getExpandedText();
    if (text.trim().length > 0) {
      if (promptStashes.has(key)) {
        appendNotice("Prompt stash already has a draft.", "warning");
        return;
      }
      promptStashes.set(key, snapshotPromptStash(text));
      editor.setText("");
      appendNotice("Stashed prompt.", "success");
      return;
    }

    const stash = promptStashes.get(key);
    if (stash === undefined) {
      appendNotice("No prompt to stash.", "info");
      return;
    }
    promptStashes.delete(key);
    for (const [markerId, image] of stash.images) {
      pastedImages.set(markerId, structuredClone(image));
    }
    editor.setText(stash.text);
    appendNotice("Restored stashed prompt.", "success");
  };

  const appendAssistant = (
    block: AssistantMessageBlock,
    spaceBefore = true,
  ): Spacer | undefined => {
    block.setThinkingExpanded(thinkingExpanded);
    assistantBlocks.push(block);
    return appendBlock(block, spaceBefore);
  };

  const resetTranscript = (): void => {
    transcript.clear();
    transcript.addChild(header);
    assistantBlocks.length = 0;
  };

  const removeEmptyResponse = (): void => {
    if (responseGroup !== undefined) transcript.removeChild(responseGroup);
    if (responseSpacer !== undefined) transcript.removeChild(responseSpacer);
  };

  const resetResponse = (): void => {
    responseBlock = undefined;
    responseGroup = undefined;
    responseSpacer = undefined;
    responseText = "";
    thinkingText = "";
    responseTurnId = undefined;
  };

  const beginResponse = (turnId?: string): void => {
    if (responseGroup !== undefined && !responseBlock?.hasVisibleContent()) {
      removeEmptyResponse();
    }
    responseText = "";
    thinkingText = "";
    responseTurnId = turnId;
    activity.setPhase("Thinking");
    responseBlock = new AssistantMessageBlock();
    responseBlock.setThinkingExpanded(thinkingExpanded);
    assistantBlocks.push(responseBlock);
    responseGroup = new Container();
    responseGroup.addChild(responseBlock);
    responseSpacer = appendBlock(responseGroup);
  };

  const endResponse = async (
    ref: Parameters<SessionController["readConversationMessage"]>[0],
    generation: number,
  ): Promise<void> => {
    const block = responseBlock;
    const turnId = responseTurnId;
    const group = responseGroup;
    const spacer = responseSpacer;
    let finalText = responseText;
    resetResponse();
    try {
      const committed = await options.session.readConversationMessage(ref);
      if (closed || generation !== transcriptGeneration) return;
      if (block !== undefined && committed.role === "assistant") {
        finalText = committed.content;
        block.setText(committed.content);
        block.setHasToolCalls(committed.toolCalls.length > 0);
      }
    } catch {
      if (closed || generation !== transcriptGeneration) return;
      if (group !== undefined) transcript.removeChild(group);
      if (spacer !== undefined) transcript.removeChild(spacer);
      if (block !== undefined) {
        const index = assistantBlocks.indexOf(block);
        if (index >= 0) assistantBlocks.splice(index, 1);
      }
      appendNotice("The committed answer could not be reconciled from the Ledger.", "warning");
      tui.requestRender();
      return;
    }
    if (block === undefined || !block.hasVisibleContent()) {
      if (group !== undefined) transcript.removeChild(group);
      if (spacer !== undefined) transcript.removeChild(spacer);
      if (block !== undefined) {
        const index = assistantBlocks.indexOf(block);
        if (index >= 0) assistantBlocks.splice(index, 1);
      }
    } else {
      renderedAssistants.add(assistantKey(turnId, finalText));
    }
    tui.requestRender();
  };

  const discardResponse = (): void => {
    const interruptedBlock = responseBlock;
    removeEmptyResponse();
    if (interruptedBlock !== undefined) {
      const index = assistantBlocks.indexOf(interruptedBlock);
      if (index >= 0) assistantBlocks.splice(index, 1);
    }
    resetResponse();
    tui.requestRender();
  };

  const appendUnstreamedAssistant = async (
    ref: Parameters<SessionController["readConversationMessage"]>[0],
    generation: number,
  ): Promise<void> => {
    try {
      const message = await options.session.readConversationMessage(ref);
      if (closed || generation !== transcriptGeneration) return;
      if (
        message.role !== "assistant"
        || message.content.length === 0
        || message.toolCalls.length > 0
      ) return;
      const key = assistantKey(ref.id, message.content);
      if (renderedAssistants.has(key)) return;
      renderedAssistants.add(key);
      appendAssistant(new AssistantMessageBlock(message.content, message.toolCalls.length > 0));
    } catch {
      if (closed || generation !== transcriptGeneration) return;
      appendNotice("Assistant message could not be rendered; the Ledger still contains the event.", "error");
    }
  };

  const loadAttachedTranscript = async (reset: boolean): Promise<void> => {
    if (reset) {
      transcriptGeneration += 1;
      resetTranscript();
      toolBlocks.clear();
      renderedAssistants.clear();
      resetResponse();
      clearShortcutGuide();
    }
    const entries = await options.session.transcript();
    entries.forEach((entry) => {
      if (entry.role === "user") {
        addPromptToHistory(entry.content);
        appendBlock(new UserMessageBlock(entry.content, entry.imageTypes));
        return;
      }
      if (entry.role === "assistant") {
        if (entry.hasToolCalls) return;
        renderedAssistants.add(assistantKey(entry.turnId, entry.content));
        appendAssistant(new AssistantMessageBlock(entry.content, entry.hasToolCalls));
        return;
      }
      const detail = entry.status === "unknown"
        ? unknownToolDetail(entry.operationId)
        : entry.isError ? entry.content : "";
      const block = new ToolStatusBlock(entry.toolName, entry.status, detail);
      block.setExpanded(entry.status === "unknown" || toolsExpanded);
      if (entry.arguments !== undefined) block.setArguments(JSON.stringify(entry.arguments, null, 2));
      if (entry.status !== "unknown") block.setResult(entry.content);
      selectLatestToolExpandHint([...toolBlocks.values()], block);
      toolBlocks.set(entry.operationId, block);
      appendBlock(block);
    });
  };

  const renderRuntimeEvent = async (
    runtimeEvent: SessionRuntimeEvent,
    generation: number,
  ): Promise<void> => {
    if (runtimeEvent.kind === "event") {
      const event = runtimeEvent.event;
      const isTetoAdvice = event.type === "message.sent"
        && event.payload.message.from === "teto"
        && event.payload.message.payload.type === "advice.propose";
      // The transcript renderer owns Main's presentation surface. Teto and
      // Worker facts stay durable and available to their schedulers, while a
      // Teto advice message remains an explicit user-facing notice below.
      if (event.laneId !== "main" && !isTetoAdvice) return;
      if (
        event.type === "message.sent"
        || event.type === "step.completed"
        || event.type === "goal.revised"
        || event.type === "thread.goal.changed"
        || event.type === "thread.goal.cleared"
        || event.type === "message.handled"
      ) {
        tui.requestRender();
      }
      if (
        event.type === "input.admitted"
        || event.type === "input.replaced"
        || event.type === "input.withdrawn"
        || event.type === "input.delivered"
        || event.type === "user.message"
      ) {
        void refreshQueue();
      }
      switch (event.type) {
        case "user.message": {
          clearShortcutGuide();
          try {
            const message = await options.session.readConversationMessage(event.payload.messageRef);
            if (closed || generation !== transcriptGeneration) break;
            if (message.role === "user") {
              appendBlock(new UserMessageBlock(
                message.content,
                message.images?.map((image) => image.mimeType),
              ));
            }
          } catch {
            if (!closed && generation === transcriptGeneration) {
              appendNotice("A delivered user message could not be rendered.", "warning");
            }
          }
          break;
        }
        case "assistant.message":
          if (responseBlock === undefined) {
            await appendUnstreamedAssistant(event.payload.messageRef, generation);
          }
          break;
        case "tool.requested": {
          const block = new ToolStatusBlock(event.payload.name, "running");
          block.setExpanded(toolsExpanded);
          selectLatestToolExpandHint([...toolBlocks.values()], block);
          toolBlocks.set(event.payload.operationId, block);
          appendBlock(block);
          activity.setPhase("Executing");
          try {
            const args = await options.session.readToolArguments(event.payload.argumentsRef);
            if (!closed && generation === transcriptGeneration) {
              block.setArguments(JSON.stringify(args, null, 2));
              tui.requestRender();
            }
          } catch {
            // The durable tool event remains visible even when optional details cannot be read.
          }
          break;
        }
        case "tool.succeeded":
          updateToolBlock(
            toolBlocks,
            event.payload.operationId,
            event.payload.name,
            "succeeded",
            "",
            appendBlock,
          );
          try {
            const result = await options.session.readConversationMessage(event.payload.resultRef);
            if (!closed && generation === transcriptGeneration) {
              toolBlocks.get(event.payload.operationId)?.setResult(result.content);
            }
          } catch {
            // Status is still useful if a legacy result artifact cannot be hydrated.
          }
          tui.requestRender();
          break;
        case "tool.failed":
          updateToolBlock(
            toolBlocks,
            event.payload.operationId,
            event.payload.name,
            "failed",
            oneLine(event.payload.error),
            appendBlock,
          );
          try {
            const result = await options.session.readConversationMessage(event.payload.resultRef);
            if (!closed && generation === transcriptGeneration) {
              toolBlocks.get(event.payload.operationId)?.setResult(result.content);
            }
          } catch {
            // Status is still useful if a legacy result artifact cannot be hydrated.
          }
          tui.requestRender();
          break;
        case "tool.unknown":
          updateToolBlock(
            toolBlocks,
            event.payload.operationId,
            event.payload.name,
            "unknown",
            unknownToolDetail(event.payload.operationId),
            appendBlock,
          );
          toolBlocks.get(event.payload.operationId)?.setExpanded(true);
          tui.requestRender();
          break;
        case "message.sent": {
          const payload = event.payload.message.payload;
          if (event.payload.message.from === "teto" && payload.type === "advice.propose") {
            appendBlock(new AdviceBlock(
              payload.advice.claim,
              payload.advice.suggestedAction,
              payload.advice.confidence,
            ));
          }
          break;
        }
        case "advice.acknowledged":
          appendNotice(
            `Teto advice ${event.payload.disposition}.`,
            event.payload.disposition === "accept" ? "success" : "info",
          );
          break;
        case "turn.waiting":
          appendNotice(
            event.payload.reason === "model-output-limit"
              ? "The model reached its output limit. The partial answer is preserved; use /resume to continue."
              : "Turn paused at a safe boundary. Use /resume or /stop.",
            "warning",
          );
          break;
        case "turn.failed":
          appendNotice("Turn failed. Use /resume or start a new Run.", "error");
          break;
        case "turn.cancelled":
          appendNotice("Turn cancelled.", "warning");
          break;
        case "run.failed":
          appendNotice("Run failed. Start a new Run or resume from the last checkpoint.", "error");
          break;
        case "fukai.compaction.requested":
          appendNotice("Compacting context...", "info");
          break;
        case "fukai.compaction.committed":
          appendNotice("Context compacted for the next Turn.", "success");
          break;
        case "fukai.compaction.failed":
          appendNotice("Compaction provider failed; the raw context is unchanged.", "warning");
          break;
        case "fukai.compaction.fallback":
          appendNotice("Compaction fell back to the raw context; the transcript is unchanged.", "warning");
          break;
      }
    } else if (runtimeEvent.kind === "stream") {
      const event = runtimeEvent.event;
      if (event.laneId !== "main") return;
      switch (event.type) {
        case "stream.start":
          beginResponse(event.turnId);
          break;
        case "stream.thinking-start":
          if (responseBlock === undefined) beginResponse(event.turnId);
          thinkingText = "";
          responseBlock?.setThinking(thinkingText, true);
          activity.setPhase("Thinking");
          tui.requestRender();
          break;
        case "stream.thinking-delta":
          if (responseBlock === undefined) beginResponse(event.turnId);
          thinkingText += event.delta;
          responseBlock?.setThinking(thinkingText, true);
          tui.requestRender();
          break;
        case "stream.thinking-end":
          responseBlock?.setThinking(thinkingText, false);
          tui.requestRender();
          break;
        case "stream.delta":
          if (responseBlock === undefined) beginResponse(event.turnId);
          activity.setPhase("Writing");
          responseText += event.delta;
          responseBlock?.setText(responseText);
          tui.requestRender();
          break;
        case "stream.end":
          await endResponse(event.messageRef, generation);
          break;
        case "stream.failed":
          // A durable turn.failed event owns the one user-visible terminal notice.
          discardResponse();
          break;
        case "stream.cancelled":
          // A durable turn.cancelled event owns the one user-visible terminal notice.
          discardResponse();
          break;
      }
    } else {
      void refreshQueue();
      tui.requestRender();
    }
  };

  const unsubscribe = options.session.subscribe((runtimeEvent) => {
    if (runtimeEvent.kind === "event") {
      if (runtimeEvent.event.type === "fukai.compaction.committed") {
        compactionCommittedEvents += 1;
      } else if (
        runtimeEvent.event.type === "fukai.compaction.failed"
        || runtimeEvent.event.type === "fukai.compaction.fallback"
      ) {
        compactionFailureEvents += 1;
      }
    }
    const generation = transcriptGeneration;
    presentationTail = presentationTail
      .then(async () => {
        if (closed || generation !== transcriptGeneration) return;
        await renderRuntimeEvent(runtimeEvent, generation);
      })
      .catch(() => {
        if (!closed && generation === transcriptGeneration) {
          appendNotice("A session update could not be rendered.", "warning");
        }
      });
  });

  const finish = (code: number): Promise<void> => {
    if (finishPromise !== undefined) return finishPromise;
    closing = true;
    clearInterruptExit();
    // A selector may have temporarily previewed a theme. Restore its committed
    // palette before waiting for queued submissions or stopping the renderer.
    closeSelector(true);
    finishPromise = (async () => {
      // A hidden `/login` prompt owns the active input stream. Cancel it
      // before draining submissions so SIGINT/SIGTERM/EOF can always settle
      // the auth request and let the TUI shut down.
      const secretInput = activeSecretInput;
      activeSecretInput = undefined;
      secretInput?.cancel();
      // Enter already accepted these submissions. Stopping admission first
      // makes this a finite drain before the Ledger-backed controller closes.
      await waitForSubmissionDrain();
      closed = true;
      unsubscribe();
      clearInterval(activityTimer);
      await terminal.drainInput(250, 25).catch(() => undefined);
      // Freeze the last live snapshot before closing detaches the Ledger-backed state.
      try {
        if (tui instanceof TuiAltScreen) tui.setLayoutRoot(transcript);
        tui.stop();
      } catch (error: unknown) {
        process.exitCode = code === 0 ? 1 : code;
        process.stderr.write(`Nausicaa terminal shutdown warning: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      try {
        await options.session.close();
      } catch (error: unknown) {
        process.exitCode = code === 0 ? 1 : code;
        // The terminal must still be restored when persistence cleanup fails.
        process.stderr.write(`Nausicaa shutdown warning: ${error instanceof Error ? error.message : String(error)}\n`);
      } finally {
        if (process.exitCode === undefined) process.exitCode = code;
        resolveClosed?.();
      }
    })();
    return finishPromise;
  };

  const onSignal = (): void => { void finish(0); };
  const onSigint = (): void => {
    if (activeSelector !== undefined) {
      closeSelector(true);
      return;
    }
    void finish(130);
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSigint);
  process.stdin.once("end", onSignal);

  const writeStatus = (snapshot: SessionSnapshot): void => {
    const usage = snapshot.usage;
    const shellStatus = snapshot.permissionProfile === "workspace"
      ? snapshot.workspaceBashAvailability.available
        ? `sandboxed Bash enabled (${snapshot.workspaceBashAvailability.backend})`
        : `sandboxed Bash unavailable: ${snapshot.workspaceBashAvailability.reason}`
      : snapshot.allowShell ? "host shell enabled" : "shell off";
    const text = [
      "### Session",
      `- **Workspace:** \`${snapshot.workspace}\``,
      `- **Model:** \`${snapshot.model}\``,
      `- **Run / Turn:** \`${snapshot.runId ?? "new"}\` / \`${snapshot.turnId ?? "idle"}\``,
      `- **State:** ${snapshot.status}; ${snapshot.collaborationMode} mode; Teto ${snapshot.tetoEnabled ? "on" : "off"}`,
      `- **Permissions:** ${snapshot.permissionProfile}; ${snapshot.allowWrite ? "write enabled" : "file writes off"}; ${shellStatus}; ${snapshot.allowNetwork ? "network enabled" : "network off"}`,
      `- **Queue / Tokens:** ${snapshot.pendingInputs} pending; ${usage.input + usage.output} used; ${usage.cacheRead} cache-read`,
      ...(options.credentialStatus === undefined
        ? []
        : [`- **Auth:** ${credentialStatusSummary(readCredentialStatus())}`]),
      ...(snapshot.blocker === undefined ? [] : [`- **Blocked:** ${snapshot.blocker}`]),
      ...(options.edgeStatus === undefined && options.edgeSelection === undefined
        ? []
        : (() => {
            const edge = readEdgeStatus();
            return [`- **Edges:** ${edge.enabled ? "enabled" : "off"}; generation ${edge.generation}; ${edge.sources.length} source(s); ${edge.discoveredSkills?.length ?? 0} Skill(s)`];
          })()),
    ].join("\n");
    appendBlock(new Markdown(text, 1, 0, nausicaaMarkdownTheme));
  };

  const readCredentialStatus = (): CredentialStatus => (
    typeof options.credentialStatus === "function"
      ? options.credentialStatus()
      : options.credentialStatus!
  );

  const readEdgeSelection = (): EdgeSelectionSnapshot | undefined => options.edgeSelection?.snapshot();

  const readEdgeStatus = (): EdgeStatusProjection => {
    const base = options.edgeStatus?.() ?? {
      enabled: options.edgeSelection !== undefined,
      refreshRequested: false,
      generation: 0,
      sources: [],
      toolCount: 0,
      contextCount: 0,
      diagnostics: [],
    } satisfies EdgeStatusProjection;
    const selection = readEdgeSelection();
    if (selection === undefined) return base;
    const provenance = selection.provenance;
    return {
      ...base,
      generation: selection.generation,
      contextCount: Math.max(base.contextCount ?? 0, selection.skills.length),
      diagnostics: Object.freeze([...new Set([...(base.diagnostics ?? []), ...selection.diagnostics])]),
      discoveredSkills: Object.freeze([...selection.skills]),
      skills: Object.freeze([...selection.skills]),
      selectedSkillIds: Object.freeze([...selection.selectedSkillIds]),
      stale: selection.stale,
      refreshing: selection.refreshing,
      ...(selection.health === undefined ? {} : { health: selection.health }),
      provenance: Object.freeze(provenance),
    };
  };

  const readModelOptions = () => modelSelectorOptions(
    options.session.snapshot().model === UNCONFIGURED_MODEL
      ? ""
      : options.session.snapshot().model,
    options.session.tetoModel === UNCONFIGURED_MODEL ? "" : options.session.tetoModel,
    options.modelChoices ?? [],
  );

  const showSetup = (): void => {
    const startupNotice = typeof options.startupNotice === "function"
      ? options.startupNotice()
      : options.startupNotice;
    appendBlock(new Markdown([
      "### Local setup",
      startupNotice ?? "Use `/model` to choose a local catalog entry. Provider auth is unverified until a real request.",
      "Use `/login` (or `nausicaa auth login`) to save a credential, or set OPENROUTER_API_KEY for this process.",
    ].join("\n\n"), 1, 0, nausicaaMarkdownTheme));
  };

  const authProvider = (argument: string, commandName: "login" | "logout"): string => {
    if (argument.length > 0 && argument.split(/\s+/u).length !== 1) {
      throw new Error(`Usage: /${commandName} [provider]`);
    }
    const configuredProvider = typeof options.auth?.provider === "function"
      ? options.auth.provider()
      : options.auth?.provider;
    const selectedModel = options.session.snapshot().model;
    const modelProvider = selectedModel.includes(":")
      ? selectedModel.slice(0, selectedModel.indexOf(":"))
      : "openrouter";
    const provider = argument.length > 0
      ? argument
      : configuredProvider ?? modelProvider;
    if (options.auth?.modelPort.hasProvider !== undefined
      && !options.auth.modelPort.hasProvider(provider)) {
      throw new Error(`Unknown provider ${provider}; choose a provider from the model catalog.`);
    }
    return provider;
  };

  const loginInTui = async (argument: string): Promise<void> => {
    if (options.auth === undefined) {
      appendNotice(
        "Authentication is unavailable in this session. Use `nausicaa auth login` instead.",
        "warning",
      );
      return;
    }
    const provider = authProvider(argument, "login");
    const input = new TuiSecretInput();
    activeSecretInput = input;
    appendNotice(
      `${provider} API key input is hidden. Press Enter to save, or Esc/Ctrl+C to cancel.`,
      "info",
    );
    try {
      await runAuthCommand(
        { action: "login", provider, json: false },
        {
          credentialStore: options.auth.credentialStore,
          modelPort: options.auth.modelPort,
          input,
          output: quietAuthOutput,
        },
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      appendNotice(
        message === "Login cancelled" ? "Login cancelled." : `Login failed: ${oneLine(message)}`,
        message === "Login cancelled" ? "info" : "error",
      );
      return;
    } finally {
      if (activeSecretInput === input) activeSecretInput = undefined;
    }
    try {
      await options.auth.onChanged?.();
    } catch {
      // The credential mutation already succeeded; a status refresh is optional.
    }
    appendNotice(
      `Signed in to ${provider}. The credential is saved locally; auth remains unverified until a provider request.`,
      "success",
    );
  };

  const logoutInTui = async (argument: string): Promise<void> => {
    if (options.auth === undefined) {
      appendNotice(
        "Authentication is unavailable in this session. Use `nausicaa auth logout` instead.",
        "warning",
      );
      return;
    }
    const provider = authProvider(argument, "logout");
    let hadSavedCredential = false;
    try {
      hadSavedCredential = await options.auth.credentialStore.read(provider) !== undefined;
      await runAuthCommand(
        { action: "logout", provider, json: false },
        {
          credentialStore: options.auth.credentialStore,
          modelPort: options.auth.modelPort,
          output: quietAuthOutput,
        },
      );
    } catch (error: unknown) {
      appendNotice(
        `Logout failed: ${oneLine(error instanceof Error ? error.message : String(error))}`,
        "error",
      );
      return;
    }
    try {
      await options.auth.onChanged?.();
    } catch {
      // The deletion already succeeded; a status refresh is optional.
    }
    let environmentAvailable = environmentCredentialPresent(
      provider,
      options.auth.environment ?? process.env,
    );
    if (!environmentAvailable) {
      try {
        environmentAvailable = await options.auth.modelPort.checkAuth(provider) !== undefined;
      } catch {
        // The credential mutation already succeeded; an ambient status probe
        // is advisory and must not turn logout into a failure.
      }
    }
    appendNotice(
      hadSavedCredential
        ? environmentAvailable
          ? `Removed the saved ${provider} credential. Any environment credential remains available.`
          : `Removed the saved ${provider} credential. No environment credential is configured.`
        : environmentAvailable
          ? `No saved ${provider} credential was present. Any environment credential remains available.`
          : `No saved ${provider} credential was present.`,
      "success",
    );
  };

  const providerReadinessError = (): string | undefined => {
    if (options.session.snapshot().model === UNCONFIGURED_MODEL) {
      return "Choose a model with /model before sending a task.";
    }
    const credential = typeof options.credentialStatus === "function"
      ? options.credentialStatus()
      : options.credentialStatus;
    if (credential?.selectorRecognized === false) {
      return "The selected model selector is not recognized locally. Choose a catalog entry with /model.";
    }
    if (credential?.catalogKnown === false) {
      return "The selected model is not in the local catalog. Choose a catalog entry with /model.";
    }
    if (credential?.credentialEnv !== undefined && !credential.credentialPresent) {
      return `Credential not detected: ${credential.credentialEnv}. `
        + "Restart after setting it; auth is not verified locally.";
    }
    return undefined;
  };

  const assertProviderReady = (): void => {
    const message = providerReadinessError();
    if (message !== undefined) throw new Error(message);
  };

  function closeSelector(restorePreview: boolean): void {
    const selected = activeSelector;
    if (selected === undefined) return;
    activeSelector = undefined;
    try {
      if (restorePreview) selected.restorePreview();
    } catch (error: unknown) {
      // A failed preview rollback must not strand focus in an unmounted selector.
      try {
        appendNotice(
          `Selector preview could not be restored: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      } catch {
        // Shutdown still owns terminal and focus restoration if rendering is unavailable.
      }
    } finally {
      promptSlot.clear();
      promptSlot.addChild(promptSurface);
      tui.setFocus(editor);
      tui.requestRender(true);
    }
  }

  function mountSelector(
    component: SelectorOverlay,
    restorePreview: () => void = () => {},
  ): void {
    closeSelector(true);
    activeSelector = { component, restorePreview };
    promptSlot.clear();
    promptSlot.addChild(component);
    tui.setFocus(component);
    tui.requestRender(true);
  }

  const showModelSelector = (): void => {
    const current = options.session.snapshot().model;
    const modelOptions = readModelOptions();
    const selector = new SelectorOverlay({
      title: "Models",
      subtitle: modelOptions.length === 0
        ? "Local model catalog unavailable/unverified; configure a provider:model selector and retry."
        : "Switch Main at the next provider request boundary.",
      options: modelOptions,
      current,
      onSelect: (value) => {
        closeSelector(false);
        void applyModelSelection(value);
      },
      onCancel: () => closeSelector(true),
    });
    mountSelector(selector);
  };

  const applyModelSelection = async (value: string): Promise<void> => {
    try {
      if (value === UNCONFIGURED_MODEL) {
        throw new Error("Choose a model from the local catalog before sending a task");
      }
      const result = await options.session.selectModel(value);
      if (!result.changed) {
        appendNotice(`Already using model ${result.model}.`, "info");
        return;
      }
      appendNotice(
        result.activeRequestUnaffected
          ? `Main model set to ${result.model}. Any request already in flight keeps ${result.previousModel}; the next request uses the new model.`
          : `Main model set to ${result.model}. The next request will use it.`,
        "success",
      );
    } catch (error: unknown) {
      appendNotice(
        `Model was not changed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  };

  const applyPermissionProfile = async (value: string): Promise<void> => {
    try {
      const profile = parsePermissionProfile(value);
      const result = await options.session.selectPermissionProfile(profile);
      if (!result.changed) {
        appendNotice(`Permissions already use ${result.profile}.`, "info");
        return;
      }
      appendNotice(
        result.activeTurnUnaffected
          ? `Permissions set to ${result.profile}. The active Turn keeps ${result.previousProfile}; the next Turn uses the new boundary.`
          : `Permissions set to ${result.profile}. Future tool calls use the new boundary.`,
        "success",
      );
    } catch (error: unknown) {
      appendNotice(
        `Permissions were not changed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  };

  const showPermissionSelector = (): void => {
    const current = options.session.snapshot().permissionProfile;
    const selector = new SelectorOverlay({
      title: "Permissions",
      subtitle: "Choose the capability boundary for future tool calls.",
      options: permissionProfileOptions(
        current,
        options.session.snapshot().workspaceBashAvailability,
      ),
      current,
      onSelect: (value) => {
        closeSelector(false);
        void applyPermissionProfile(value);
      },
      onCancel: () => closeSelector(true),
    });
    mountSelector(selector);
  };

  const applyCollaborationMode = async (value: string): Promise<void> => {
    try {
      const mode = parseCollaborationMode(value);
      const result = await options.session.selectCollaborationMode(mode);
      if (!result.changed) {
        appendNotice(`Already using ${result.mode} mode.`, "info");
        return;
      }
      appendNotice(
        result.activeTurnUnaffected
          ? `${capitalize(result.mode)} mode selected. The active Turn keeps ${result.previousMode}; the next Turn uses the new mode.`
          : `${capitalize(result.mode)} mode selected.`,
        "success",
      );
    } catch (error: unknown) {
      appendNotice(
        `Mode was not changed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  };

  const showCollaborationModeSelector = (): void => {
    const current = options.session.snapshot().collaborationMode;
    const selector = new SelectorOverlay({
      title: "Mode",
      subtitle: "Default can act; Plan investigates read-only and proposes the work.",
      options: collaborationModeOptions(current),
      current,
      onSelect: (value) => {
        closeSelector(false);
        void applyCollaborationMode(value);
      },
      onCancel: () => closeSelector(true),
    });
    mountSelector(selector);
  };

  const applyThemeChoice = (choice: ThemeChoice): void => {
    themePreference = choice;
    // `auto` follows the last detected terminal scheme; explicit choices take
    // effect immediately and remain stable across terminal notifications.
    setNausicaaColorScheme(choice === "auto" ? detectedColorScheme : choice);
    tui.invalidate();
    tui.requestRender(true);
    appendNotice(
      choice === "auto"
        ? "Theme set to auto; it follows terminal color changes."
        : `Theme set to ${choice}.`,
      "success",
    );
  };

  const showThemeSelector = (): void => {
    const originalPreference = themePreference;
    const originalScheme = getNausicaaColorScheme();
    const restorePreview = (): void => {
      setNausicaaColorScheme(
        originalPreference === "auto" ? detectedColorScheme : originalScheme,
      );
      tui.invalidate();
    };
    const selector = new SelectorOverlay({
      title: "Theme",
      subtitle: "Preview with Up/Down, Enter to keep, Esc to restore.",
      options: themeSelectorOptions(themePreference),
      current: themePreference,
      onPreview: (value) => {
        if (value !== "auto" && value !== "light" && value !== "dark") return;
        setNausicaaColorScheme(value === "auto" ? detectedColorScheme : value);
        tui.invalidate();
        tui.requestRender(true);
      },
      onSelect: (value) => {
        const choice = parseThemeChoice(value);
        closeSelector(false);
        applyThemeChoice(choice);
      },
      onCancel: () => closeSelector(true),
    });
    mountSelector(selector, restorePreview);
  };

  const switchSession = async (runId: string): Promise<void> => {
    const current = options.session.snapshot();
    // An explicit `/resume <current-run>` can arrive on the same tick as the
    // durable `turn.waiting` fact, before SessionController has published its
    // final idle state. Wait for that execution to close instead of treating
    // the current attachment as a cross-Run switch.
    if (current.runId === runId) {
      if (current.status === "running" || current.status === "cancelling") {
        await options.session.waitForIdle();
      }
      appendNotice(`Run ${runId} is already attached.`, "info");
      return;
    }
    if (current.status === "running" || current.status === "cancelling") {
      throw new Error("/resume is unavailable while Main is working");
    }
    await options.session.attachRun(runId);
    resetQueueSelection();
    if (promptStashScope.startsWith("<new-run:")) {
      promptStashes.delete(promptStashScope);
    }
    promptStashScope = runId;
    await loadAttachedTranscript(true);
    await refreshQueue();
    appendNotice(`Attached Run ${runId}.`, "success");
  };

  const forkSession = async (argument: string): Promise<void> => {
    const current = options.session.snapshot();
    if (current.status === "running" || current.status === "cancelling") {
      throw new Error("/fork is unavailable while Main is working");
    }
    const parts = argument.split(/\s+/u).filter(Boolean);
    if (parts.length > 1) throw new Error("Usage: /fork [run-id]");
    const result = await options.session.forkRun(
      parts.length === 0 ? {} : { runId: parts[0]! },
    );
    resetQueueSelection();
    if (promptStashScope.startsWith("<new-run:")) {
      promptStashes.delete(promptStashScope);
    }
    promptStashScope = result.runId;
    await loadAttachedTranscript(true);
    await refreshQueue();
    appendNotice(`Forked Run ${result.parentRunId} to ${result.runId}.`, "success");
  };

  const showSessionTreeSelector = async (): Promise<void> => {
    const snapshot = options.session.snapshot();
    if (snapshot.status === "running" || snapshot.status === "cancelling") {
      throw new Error("/tree is unavailable while Main is working");
    }
    const tree = await listWorkspaceRunTree(options.session.dataDir, options.session.workspace);
    if (tree.length === 0) {
      appendNotice("No saved Runs exist for this workspace.", "info");
      return;
    }
    const selectorOptions = workspaceTreeOptions(tree, snapshot.runId);
    const selectionByValue = new Map(
      selectorOptions.map((option) => [option.value, parseWorkspaceTreeSelection(option.value)]),
    );
    const selector = new SelectorOverlay({
      title: "Session tree",
      searchLabel: "Type to search",
      subtitle: "Select a Run to attach, or a checkpoint to fork from that history point.",
      options: selectorOptions,
      ...(snapshot.runId === undefined ? {} : { current: snapshot.runId }),
      onSelect: (value) => {
        closeSelector(false);
        const selection = selectionByValue.get(value);
        if (selection === undefined) return;
        void navigateWorkspaceTreeSelection(selection).catch((error: unknown) => {
          appendNotice(error instanceof Error ? error.message : String(error), "error");
        });
      },
      onCancel: () => closeSelector(true),
    });
    mountSelector(selector);
  };

  const navigateWorkspaceTreeSelection = async (
    selection: WorkspaceTreeSelection,
  ): Promise<void> => {
    if (selection.kind === "run") {
      await switchSession(selection.runId);
      return;
    }
    const snapshot = options.session.snapshot();
    if (snapshot.status === "running" || snapshot.status === "cancelling") {
      throw new Error("/tree is unavailable while Main is working");
    }
    if (snapshot.runId !== selection.runId) {
      await switchSession(selection.runId);
    }
    const result = await options.session.forkRun({ checkpoint: selection.checkpoint });
    resetQueueSelection();
    if (promptStashScope.startsWith("<new-run:")) {
      promptStashes.delete(promptStashScope);
    }
    promptStashScope = result.runId;
    await loadAttachedTranscript(true);
    await refreshQueue();
    appendNotice(
      `Forked Run ${result.parentRunId} at checkpoint ${result.parentCheckpoint.watermark} to ${result.runId}.`,
      "success",
    );
  };

  const showSessionSelector = async (): Promise<void> => {
    const snapshot = options.session.snapshot();
    if (snapshot.status === "running" || snapshot.status === "cancelling") {
      throw new Error("/resume is unavailable while Main is working");
    }
    const runs = await listWorkspaceRuns(options.session.dataDir, options.session.workspace);
    if (runs.length === 0) {
      appendNotice("No saved Runs exist for this workspace.", "info");
      return;
    }
    const selectorOptions = workspaceResumeOptions(runs);
    const runById = new Map(runs.map((run) => [run.runId, run]));
    const filters: readonly SelectorFilter[] = [
      {
        key: "status",
        label: "Status",
        options: [
          { value: "all", label: "All" },
          { value: "active", label: "Active" },
          { value: "archived", label: "Archived" },
        ],
        current: "all",
      },
      {
        key: "sort",
        label: "Sort",
        options: [
          { value: "updated", label: "Updated" },
          { value: "created", label: "Created" },
        ],
        current: "updated",
      },
    ];
    const selector = new SelectorOverlay({
      title: "Resume a previous session",
      // Codex keeps this surface quiet: the title, search, and facets explain
      // the operation without a second prose subtitle.
      searchLabel: "Type to search",
      filters,
      options: selectorOptions,
      filterOptions: (options: readonly SelectorOption[], values: Readonly<Record<string, string>>) => {
        const status = values.status ?? "active";
        const selected = options.filter((option) => {
          const run = runById.get(option.value);
          if (run === undefined || status === "all") return run !== undefined;
          const archived = run.status === "completed"
            || run.status === "failed"
            || run.status === "cancelled";
          return status === "archived" ? archived : !archived;
        });
        const sort = values.sort ?? "updated";
        return [...selected].sort((left, right) => {
          const leftRun = runById.get(left.value);
          const rightRun = runById.get(right.value);
          if (leftRun === undefined || rightRun === undefined) return 0;
          const leftTime = sort === "created" ? leftRun.createdAt : leftRun.updatedAt;
          const rightTime = sort === "created" ? rightRun.createdAt : rightRun.updatedAt;
          return rightTime.localeCompare(leftTime) || rightRun.runId.localeCompare(leftRun.runId);
        });
      },
      ...(snapshot.runId === undefined ? {} : { current: snapshot.runId }),
      onSelect: (value) => {
        closeSelector(false);
        void switchSession(value).catch((error: unknown) => {
          appendNotice(error instanceof Error ? error.message : String(error), "error");
        });
      },
      onCancel: () => closeSelector(true),
    });
    mountSelector(selector);
  };

  const refreshEdgeSelection = async (): Promise<void> => {
    const controller = options.edgeSelection;
    if (controller === undefined) {
      appendNotice("Edge refresh is unavailable: the host did not provide a selection controller.", "warning");
      return;
    }
    const before = controller.snapshot();
    const pending = controller.refresh();
    tui.requestRender(true);
    const refreshed = await pending;
    if (refreshed.stale) {
      appendNotice(
        `Edge refresh was cancelled or failed; showing stale generation ${before.generation}.`,
        "warning",
      );
    } else {
      appendNotice(`Edges refreshed at generation ${refreshed.generation}.`, "success");
    }
    tui.requestRender(true);
  };

  const applySkillSelection = async (values: readonly string[]): Promise<void> => {
    const controller = options.edgeSelection;
    if (controller === undefined) return;
    const wanted = new Set(values);
    const snapshot = controller.snapshot();
    try {
      for (const skill of snapshot.skills) {
        if (skill.disabled) continue;
        const selected = wanted.has(skill.id);
        if (selected && !skill.selected) await controller.selectSkill(skill.id);
        if (!selected && skill.selected) await controller.deselectSkill(skill.id);
      }
      const count = controller.snapshot().selectedSkillIds.length;
      appendNotice(`${count} Skill(s) selected for the next Turn.`, "success");
      tui.requestRender(true);
    } catch (error: unknown) {
      appendNotice(
        `Skills were not changed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  };

  const showSkillsSelector = (): void => {
    const controller = options.edgeSelection;
    if (controller === undefined) {
      appendBlock(new Markdown(formatEdgeStatus(readEdgeStatus()), 1, 0, nausicaaMarkdownTheme));
      appendNotice("Skill selection is unavailable: the host did not provide a selection controller.", "warning");
      return;
    }
    const snapshot = controller.snapshot();
    appendBlock(new EdgeSkillPickerSummary(() => controller.snapshot()));
    if (snapshot.skills.length === 0) {
      appendNotice(snapshot.stale ? "No fresh Skills; the displayed edge snapshot is stale." : "No Skills discovered.", "info");
      return;
    }
    const selector = new SelectorOverlay({
      title: "Skills",
      subtitle: snapshot.stale
        ? "Stale snapshot. Space toggles metadata-only Skills; Enter applies to the next Turn."
        : "Space toggles metadata-only Skills; Enter applies to the next Turn.",
      options: skillSelectorOptions(snapshot.skills),
      multiSelect: true,
      selectedValues: snapshot.selectedSkillIds,
      onSelect: () => {},
      onConfirm: (values) => {
        closeSelector(false);
        void applySkillSelection(values);
      },
      onCancel: () => closeSelector(true),
    });
    mountSelector(selector);
  };

  const handleCommand = async (
    commandLine: string,
    commandImages?: readonly UserImage[],
  ): Promise<void> => {
    const { command: enteredCommand, argument } = parseInteractiveCommand(commandLine);
    if (findInteractiveCommand(enteredCommand) === undefined) {
      appendNotice(`Unknown command: ${enteredCommand}. Try /help.`, "warning");
      return;
    }
    const command = `/${canonicalInteractiveCommandName(enteredCommand)}`;
    try {
      switch (command) {
        case "/help":
          appendBlock(new Markdown([
            "### Commands",
            formatInteractiveCommandHelp(),
            "`/exit` remains a hidden Codex-compatible alias for `/quit`.",
            "`Alt+Up/Down` browse and edit queued input",
            `\`${pasteImageLabel}\` paste image  ·  \`Ctrl+S\` stash prompt`,
            "`Ctrl+T` thinking  ·  `Ctrl+O` tool output",
            "`Ctrl+Up/Down` jump between prompts  ·  `Ctrl+Shift+F` search transcript",
            "`Ctrl+C` cancel/clear",
          ].join("\n\n"), 1, 0, nausicaaMarkdownTheme));
          break;
        case "/status":
          writeStatus(options.session.snapshot());
          break;
        case "/setup":
          if (argument.length > 0) throw new Error("Usage: /setup");
          showSetup();
          break;
        case "/login":
          await loginInTui(argument);
          break;
        case "/logout":
          await logoutInTui(argument);
          break;
        case "/agents":
          await showAgentTopology(argument);
          break;
        case "/topology":
          await showAgentTopology(argument);
          break;
        case "/edges":
          if (argument === "refresh") {
            await refreshEdgeSelection();
            break;
          }
          if (argument.length > 0) throw new Error("Usage: /edges [refresh]");
          appendBlock(new Markdown(formatEdgeStatus(readEdgeStatus()), 1, 0, nausicaaMarkdownTheme));
          break;
        case "/skills": {
          const parts = argument.split(/\s+/u).filter(Boolean);
          const action = parts[0] ?? "show";
          if (action === "refresh" && parts.length === 1) {
            await refreshEdgeSelection();
            break;
          }
          if (action === "show" && parts.length === 1) {
            showSkillsSelector();
            break;
          }
          const controller = options.edgeSelection;
          if ((action === "select" || action === "deselect") && parts.length === 2 && controller !== undefined) {
            if (action === "select") await controller.selectSkill(parts[1]!);
            else await controller.deselectSkill(parts[1]!);
            appendNotice(`Skill ${parts[1]} ${action === "select" ? "selected" : "deselected"} for the next Turn.`, "success");
            break;
          }
          throw new Error("Usage: /skills [refresh|select <id>|deselect <id>]");
        }
        case "/context":
          if (argument.length > 0) throw new Error("Usage: /context");
          appendBlock(new ContextUsageBlock(options.session.contextOverview()));
          break;
        case "/usage":
          if (argument.length > 0) throw new Error("Usage: /usage");
          appendBlock(new ContextUsageBlock(options.session.contextOverview()));
          break;
        case "/compact": {
          if (argument.length > 0) throw new Error("Usage: /compact");
          const committedEventsBefore = compactionCommittedEvents;
          const failureEventsBefore = compactionFailureEvents;
          const result = await options.session.compact();
          if (result.status === "committed") {
            if (compactionCommittedEvents === committedEventsBefore) {
              appendNotice("Context compacted for the next Turn.", "success");
            }
          } else if (result.status === "unavailable") {
            appendNotice("Compaction is unavailable for this Run.", "warning");
          } else {
            if (result.reason === "provider-error") {
              if (compactionFailureEvents === failureEventsBefore) {
                appendNotice("Compaction provider failed; the raw context is unchanged.", "warning");
              }
            } else {
              appendNotice(
                result.reason === "budget-exhausted"
                  ? "Compaction skipped because the Run token budget is exhausted."
                  : "No eligible context was compacted.",
                result.reason === "budget-exhausted" ? "warning" : "info",
              );
            }
          }
          break;
        }
        case "/model": {
          if (argument.length === 0) {
            showModelSelector();
            break;
          }
          const selected = normalizeModelSelector(argument);
          await applyModelSelection(selected);
          break;
        }
        case "/permissions": {
          if (argument.length === 0) {
            showPermissionSelector();
            break;
          }
          await applyPermissionProfile(argument);
          break;
        }
        case "/mode": {
          if (argument.length === 0) {
            showCollaborationModeSelector();
            break;
          }
          await applyCollaborationMode(argument);
          break;
        }
        case "/plan": {
          const status = options.session.snapshot().status;
          if (status === "running" || status === "cancelling") {
            throw new Error("/plan is unavailable while Main is working");
          }
          await applyCollaborationMode("plan");
          const prompt = argument;
          if (prompt.length > 0) {
            assertProviderReady();
            await options.session.submit({
              inputId: createInputId(),
              text: prompt,
              ...(commandImages === undefined || commandImages.length === 0
                ? {}
                : { images: structuredClone([...commandImages]) }),
              delivery: "new-turn",
            });
          }
          break;
        }
        case "/theme": {
          if (argument.length === 0) {
            showThemeSelector();
            break;
          }
          applyThemeChoice(parseThemeChoice(argument));
          break;
        }
        case "/goal": {
          const parsed = parseGoalCommand(argument);
          const current = options.session.snapshot().goal;
          if (parsed.kind === "status") {
            appendNotice(current === undefined ? "No goal is currently set." : formatThreadGoal(current));
            break;
          }
          if (parsed.kind === "create") {
            const goal = current === undefined
              ? await options.session.createGoal(parsed.objective, parsed.tokenBudget)
              : await options.session.replaceGoal(parsed.objective, parsed.tokenBudget);
            adoptAttachedPromptStashScope();
            appendNotice(`${current === undefined ? "Goal created." : "Goal replaced."}\n${formatThreadGoal(goal)}`, "success");
            break;
          }
          if (parsed.kind === "edit") {
            const goal = await options.session.editGoal(parsed.objective, parsed.tokenBudget);
            appendNotice(`Goal updated.\n${formatThreadGoal(goal)}`, "success");
            break;
          }
          if (parsed.kind === "pause" || parsed.kind === "resume") {
            if (current === undefined) {
              appendNotice("No goal is currently set.", "info");
              break;
            }
            const goal = await options.session.updateGoalStatus(parsed.kind === "pause" ? "paused" : "active");
            appendNotice(`Goal ${parsed.kind}d.\n${formatThreadGoal(goal)}`, "success");
            break;
          }
          const cleared = await options.session.clearGoal();
          appendNotice(cleared ? "Goal cleared." : "No goal to clear.", cleared ? "success" : "info");
          break;
        }
        case "/session":
          if (argument.length === 0) {
            await showSessionSelector();
          } else {
            if (argument.split(/\s+/u).length !== 1) throw new Error("Usage: /session [run-id]");
            await switchSession(argument);
          }
          break;
        case "/tree":
          if (argument.length > 0) throw new Error("Usage: /tree");
          await showSessionTreeSelector();
          break;
        case "/fork":
          await forkSession(argument);
          break;
        case "/new":
          await options.session.newRun();
          resetQueueSelection();
          promptStashes.delete(promptStashKey());
          promptStashScope = `<new-run:${detachedPromptStashSequence}>`;
          detachedPromptStashSequence += 1;
          transcriptGeneration += 1;
          header.setCompact(false);
          resetTranscript();
          toolBlocks.clear();
          renderedAssistants.clear();
          resetResponse();
          clearShortcutGuide();
          appendNotice("New Run ready.", "success");
          break;
        case "/resume":
          if (argument.length > 0) {
            if (argument.split(/\s+/u).length !== 1) {
              throw new Error("Usage: /resume [run-id]");
            }
            await switchSession(argument);
            // An explicit Run ID means the caller asked to continue this
            // resumable Turn, while completed Runs simply remain attached.
            assertProviderReady();
            await options.session.resumeCurrent();
            appendNotice("Resume requested.", "success");
            break;
          }
          // History selection is an attachment operation. Continuing a
          // resumable Turn requires the explicit `/resume <run-id>` form so
          // opening the picker never causes an unexpected provider request.
          await showSessionSelector();
          break;
        case "/stop":
          await options.session.cancel();
          break;
        case "/cancel":
          await options.session.cancel();
          break;
        case "/resolve":
          if (argument.length === 0) throw new Error("/resolve requires an operation id");
          await options.session.resolveOperation(argument.split(/\s+/u)[0]!);
          appendNotice("Operation resolved as failed.", "warning");
          break;
        case "/copy": {
          if (argument.length > 0) throw new Error("Usage: /copy");
          if (
            options.session.snapshot().status === "running"
            || options.session.snapshot().status === "cancelling"
          ) {
            await options.session.waitForIdle();
          }
          const lastAssistant = (await options.session.transcript())
            .findLast((entry) => entry.role === "assistant");
          if (lastAssistant?.role !== "assistant" || lastAssistant.content.length === 0) {
            throw new Error("No assistant message to copy yet.");
          }
          await (options.clipboardTextWriter ?? copyToClipboard)(lastAssistant.content);
          appendNotice("Copied last assistant message to clipboard.", "success");
          break;
        }
        case "/quit":
          // Finish after this worker drains; awaiting it here would await the
          // worker from inside its own queue item.
          closing = true;
          queuedFinishCode ??= 0;
          break;
        default:
          appendNotice(`Unknown command: ${command}. Try /help.`, "warning");
      }
    } catch (error: unknown) {
      appendNotice(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const processSubmission = async (submission: QueuedSubmission): Promise<void> => {
    clearShortcutGuide();
    const { value } = submission;
    if (value.startsWith("/")) {
      addPromptToHistory(value);
      await handleCommand(value, submission.images);
      return;
    }
    const readinessError = providerReadinessError();
    if (readinessError !== undefined) {
      editor.setText(value);
      appendNotice(readinessError, "warning");
      return;
    }
    const inputId = createInputId();
    try {
      await options.session.submit({
        inputId,
        text: value,
        ...(submission.images === undefined
          ? {}
          : { images: structuredClone(submission.images) }),
        delivery: submission.delivery,
      });
      adoptAttachedPromptStashScope();
      addPromptToHistory(value);
    } catch (error: unknown) {
      const currentDraft = editor.getExpandedText();
      editor.setText(currentDraft.length === 0 ? value : `${value}\n${currentDraft}`);
      appendNotice(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const drainSubmissions = (): Promise<void> => {
    if (submissionDrainPromise !== undefined) return submissionDrainPromise;
    const drain = (async () => {
      try {
        while (submissionQueue.length > 0) {
          const submission = submissionQueue.shift();
          if (submission === undefined) break;
          activeSubmission = submission;
          try {
            await processSubmission(submission);
          } finally {
            activeSubmission = undefined;
            submission.resolve();
          }
        }
      } finally {
        if (queuedFinishCode !== undefined) void finish(queuedFinishCode);
      }
    })();
    submissionDrainPromise = drain;
    const completeDrain = (): void => {
      if (submissionDrainPromise === drain) submissionDrainPromise = undefined;
      if (submissionQueue.length > 0) void drainSubmissions();
    };
    void drain.then(completeDrain, completeDrain);
    return drain;
  };

  async function waitForSubmissionDrain(): Promise<void> {
    while (activeSubmission !== undefined || submissionQueue.length > 0) {
      await (submissionDrainPromise ?? drainSubmissions());
    }
  };

  const submitText = (
    text: string,
    requestedDelivery?: "steering" | "follow-up",
    images?: UserImage[],
  ): Promise<void> => {
    const value = text.trim();
    if (queueSelection.isBrowsing && !closing) {
      if (pendingQueueEdit !== undefined) {
        editor.setText(text);
        appendNotice("Queued input update is still finishing; your draft was kept.", "warning");
        return Promise.resolve();
      }
      return applyQueueSelection(
        value,
        requestedDelivery === "follow-up" ? "follow-up" : "steering",
      );
    }
    const unresolvedMarkers = [...new Set(imageMarkerIds(value)
      .filter((markerId) => !pastedImages.has(markerId)))];
    if (!value.startsWith("/") && unresolvedMarkers.length > 0) {
      editor.setText(value);
      const references = unresolvedMarkers
        .slice(0, 3)
        .map(formatImageMarker)
        .join(", ");
      appendNotice(
        `Image attachment ${references} is no longer available. Remove the marker and paste the image again.`,
        "warning",
      );
      return Promise.resolve();
    }
    const submittedImages = [
      ...(images ?? []),
      ...collectMarkedImages(pastedImages, value),
    ];
    if ((value.length === 0 && submittedImages.length === 0) || closing) return Promise.resolve();
    if (!value.startsWith("/") && options.session.snapshot().model === UNCONFIGURED_MODEL) {
      editor.setText(value);
      appendNotice("Choose a model with /model before sending a task. Local setup status is shown at startup.", "warning");
      return Promise.resolve();
    }
    if (submittedImages.length > 0 && options.session.modelCapabilities().imageInput === "unsupported") {
      editor.setText(value);
      appendNotice(
        "Image not attached: the selected model does not support image input. Choose a vision model or remove the image.",
        "warning",
      );
      return Promise.resolve();
    }
    editor.setText("");
    const hasPriorConversationSubmission = (
      activeSubmission !== undefined && !activeSubmission.value.startsWith("/")
    ) || submissionQueue.some((submission) => !submission.value.startsWith("/"));
    const delivery = requestedDelivery
      ?? (
        options.session.snapshot().status === "running" || hasPriorConversationSubmission
          ? "steering"
          : "new-turn"
      );
    return new Promise<void>((resolve) => {
      submissionQueue.push({
        value,
        ...(submittedImages.length === 0
          ? {}
          : { images: structuredClone(submittedImages) }),
        delivery,
        resolve,
      });
      void drainSubmissions();
    });
  };

  editor.onChange = () => { editorRevision += 1; };
  editor.onSubmit = (text) => { void submitText(text); };
  tui.addInputListener((data) => {
    if (activeSecretInput !== undefined) {
      activeSecretInput.push(data);
      return { consume: true };
    }
    if (activeSelector !== undefined) return undefined;
    const isInterrupt = matchesKey(data, "ctrl+c");
    if (!isInterrupt) clearInterruptExit();
    if (matchesKey(data, "?") && editor.getText().length === 0) {
      showShortcutGuide();
      return { consume: true };
    }
    if (matchesKey(data, pasteImageKey)) {
      queueClipboardImagePaste();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+s")) {
      handlePromptStash();
      return { consume: true };
    }
    if (matchesKey(data, "alt+up")) {
      browseQueueSelection(-1);
      return { consume: true };
    }
    if (matchesKey(data, "alt+down")) {
      browseQueueSelection(1);
      return { consume: true };
    }
    if (matchesKey(data, "alt+enter")) {
      if (!closing) {
        const text = editor.getExpandedText();
        void submitText(text, "follow-up");
      }
      return { consume: true };
    }
    if (isInterrupt) {
      if (options.edgeSelection?.snapshot().refreshing === true) {
        options.edgeSelection.cancelRefresh();
        appendNotice("Cancelling edge refresh; the previous snapshot remains available.", "warning");
        return { consume: true };
      }
      if (
        options.session.snapshot().status === "running"
        || options.session.snapshot().status === "cancelling"
      ) {
        clearInterruptExit();
        void options.session.cancel();
      } else if (editor.getText().length > 0) {
        clearInterruptExit();
        editor.setText("");
        tui.requestRender();
      } else if (interruptExitUntil > Date.now()) {
        void finish(130);
      } else {
        armInterruptExit();
      }
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+d") && editor.getText().length === 0) {
      void finish(0);
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+t")) {
      thinkingExpanded = !thinkingExpanded;
      for (const block of assistantBlocks) block.setThinkingExpanded(thinkingExpanded);
      tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+o")) {
      toolsExpanded = !toolsExpanded;
      for (const block of toolBlocks.values()) block.setExpanded(toolsExpanded);
      header.setExpanded(toolsExpanded);
      tui.requestRender();
      return { consume: true };
    }
    return undefined;
  });

  if (options.session.snapshot().runId !== undefined) {
    await loadAttachedTranscript(false);
  }

  tui.start();
  try {
    const scheme = await tui.queryTerminalColorScheme({ timeoutMs: 100 });
    if (scheme !== undefined) {
      detectedColorScheme = scheme;
      setNausicaaColorScheme(scheme);
    }
  } catch {
    // Some terminals do not answer OSC 10/11 queries; the light palette remains valid.
  }
  await refreshQueue();
  if (options.showStartupSetup === true || options.startupModelMissing === true) {
    // Setup status is a startup diagnostic, not a public slash command.
    showSetup();
    if (options.startupModelMissing === true) showModelSelector();
  }
  if (options.resumeOnStart === true) {
    try {
      assertProviderReady();
      await options.session.resumeCurrent();
    } catch (error: unknown) {
      appendNotice(error instanceof Error ? error.message : String(error), "error");
    }
  }
  if (
    options.startupModelMissing === true
    && (options.initialMessage !== undefined || (options.initialImages?.length ?? 0) > 0)
  ) {
    const initialDraftParts = [options.initialMessage ?? ""];
    for (const image of options.initialImages ?? []) {
      const markerId = await allocateImageMarkerId();
      rememberPastedImage(markerId, image);
      initialDraftParts.push(formatImageMarker(markerId));
    }
    editor.setText(initialDraftParts.filter((part) => part.length > 0).join("\n"));
    appendNotice(
      "Initial task is kept in the editor until a local model is selected.",
      "info",
    );
  } else if (options.initialMessage !== undefined || (options.initialImages?.length ?? 0) > 0) {
    await submitText(options.initialMessage ?? "", undefined, options.initialImages);
  }

  await closedPromise;
  process.removeListener("SIGTERM", onSignal);
  process.removeListener("SIGINT", onSigint);
  process.stdin.removeListener("end", onSignal);
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

function updateToolBlock(
  blocks: Map<string, ToolStatusBlock>,
  operationId: string,
  name: string,
  status: "succeeded" | "failed" | "unknown",
  detail: string,
  append: (component: ToolStatusBlock) => unknown,
): void {
  const existing = blocks.get(operationId);
  if (existing !== undefined) {
    existing.setStatus(status, detail);
    return;
  }
  const block = new ToolStatusBlock(name, status, detail);
  selectLatestToolExpandHint([...blocks.values()], block);
  blocks.set(operationId, block);
  append(block);
}

function assistantKey(turnId: string | undefined, content: string): string {
  return `${turnId ?? "legacy"}:${content}`;
}

function credentialStatusSummary(status: CredentialStatus): string {
  if (status.provider === undefined) return "no provider selected";
  if (status.credentialSource === "saved") return "saved credential (unverified)";
  if (status.credentialSource === "environment") {
    return `${status.credentialEnv ?? "environment"} ${status.credentialMask ?? "configured"} (unverified)`;
  }
  if (status.credentialEnv !== undefined) return `${status.credentialEnv} missing`;
  return "not configured (unverified)";
}

function unknownToolDetail(operationId: string): string {
  return `unresolved ${operationId}; restart with --resolve-operation ${operationId} if the operation should be treated as failed`;
}

function oneLine(value: string, maxWidth = 160): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxWidth);
}

function commandArgumentCompletions(
  options: readonly SelectorOption[],
  prefix: string,
): Array<{ value: string; label: string; description?: string }> {
  return filterSelectorOptions(options, prefix).map((option) => ({
    value: option.value,
    label: option.label,
    ...(option.description === undefined ? {} : { description: option.description }),
  }));
}

function workspaceRunOptions(
  runs: readonly WorkspaceRunSummary[],
  currentRunId?: string,
): SelectorOption[] {
  return runs.map((run) => ({
    value: run.runId,
    label: run.title === undefined
      ? (run.runId === currentRunId ? `${run.runId} (current)` : run.runId)
      : terminalSafeText(run.title),
    description: [
      run.runId === currentRunId ? "current" : undefined,
      capitalize(run.status),
      formatRunRelativeTime(run.updatedAt),
      run.runId,
      run.title === undefined ? undefined : oneLine(terminalSafeText(run.goal), 72),
    ].filter((value): value is string => value !== undefined).join(" · "),
  }));
}

/** Codex-style history rows lead with recency and keep the task title primary. */
function workspaceResumeOptions(
  runs: readonly WorkspaceRunSummary[],
): SelectorOption[] {
  return runs.map((run) => ({
    value: run.runId,
    label: formatRunRelativeTime(run.updatedAt),
    description: [
      terminalSafeText(run.title ?? run.goal),
      capitalize(run.status),
      run.parentRunId === undefined ? undefined : `Fork of ${run.parentRunId}`,
      `Run ID ${run.runId}`,
    ].filter((value): value is string => value !== undefined).join(" · "),
  }));
}

const TREE_CHECKPOINT_PREFIX = "tree-checkpoint:";

type WorkspaceTreeSelection =
  | { kind: "run"; runId: string }
  | { kind: "checkpoint"; runId: string; checkpoint: { watermark: number; checksum: string } };

/** Build selector rows while retaining the Run tree's durable parent shape. */
export function workspaceTreeOptions(
  tree: readonly WorkspaceRunTreeNode[],
  currentRunId?: string,
): SelectorOption[] {
  const rows = flattenWorkspaceRunTree(tree);
  const options: SelectorOption[] = [];
  const seenCheckpoints = new Set<string>();
  for (const row of rows) {
    const prefix = workspaceTreePrefix(row);
    const run = row.run;
    const title = terminalSafeText(run.title ?? run.goal);
    options.push({
      value: run.runId,
      label: `${prefix}${title || run.runId}${run.runId === currentRunId ? " (current)" : ""}`,
      description: [
        capitalize(run.status),
        run.runId,
        run.branchSummary,
      ].filter((value): value is string => value !== undefined && value.length > 0).join(" · "),
    });
    for (const checkpoint of run.checkpoints ?? []) {
      const value = encodeWorkspaceTreeCheckpoint(run.runId, checkpoint);
      if (seenCheckpoints.has(value)) continue;
      seenCheckpoints.add(value);
      options.push({
        value,
        label: `${prefix}  checkpoint ${checkpoint.watermark}`,
        description: `Fork ${run.runId} from ${checkpoint.checksum}`,
      });
    }
  }
  return options;
}

function workspaceTreePrefix(row: WorkspaceRunTreeRow): string {
  const ancestors = row.ancestorContinues
    .map((continues) => continues ? "|  " : "   ")
    .join("");
  return `${ancestors}${row.isLast ? "\\- " : "|- "}`;
}

function encodeWorkspaceTreeCheckpoint(
  runId: string,
  checkpoint: { watermark: number; checksum: string },
): string {
  return `${TREE_CHECKPOINT_PREFIX}${encodeURIComponent(runId)}:${checkpoint.watermark}:${encodeURIComponent(checkpoint.checksum)}`;
}

function parseWorkspaceTreeSelection(value: string): WorkspaceTreeSelection | undefined {
  if (!value.startsWith(TREE_CHECKPOINT_PREFIX)) {
    return { kind: "run", runId: value };
  }
  const encoded = value.slice(TREE_CHECKPOINT_PREFIX.length);
  const firstSeparator = encoded.indexOf(":");
  const lastSeparator = encoded.lastIndexOf(":");
  if (firstSeparator <= 0 || lastSeparator <= firstSeparator) return undefined;
  const encodedRunId = encoded.slice(0, firstSeparator);
  const watermarkText = encoded.slice(firstSeparator + 1, lastSeparator);
  const encodedChecksum = encoded.slice(lastSeparator + 1);
  const watermark = Number(watermarkText);
  if (!Number.isSafeInteger(watermark) || watermark < 1) return undefined;
  try {
    const runId = decodeURIComponent(encodedRunId);
    const checksum = decodeURIComponent(encodedChecksum);
    if (runId.length === 0 || !/^sha256:[0-9a-f]{64}$/u.test(checksum)) return undefined;
    return { kind: "checkpoint", runId, checkpoint: { watermark, checksum } };
  } catch {
    return undefined;
  }
}

function formatRunRelativeTime(value: string, now = Date.now()): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return oneLine(value, 24);
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function parseInteractiveCommand(commandLine: string): {
  command: string;
  argument: string;
} {
  // Prime Agent 7787f074 splits once, preserving a multiline command argument.
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(commandLine.trim());
  return {
    command: match?.[1] ?? commandLine,
    argument: (match?.[2] ?? "").trim(),
  };
}

type ParsedGoalCommand =
  | { kind: "status" }
  | { kind: "create"; objective: string; tokenBudget?: number }
  | { kind: "edit"; objective: string; tokenBudget?: number }
  | { kind: "pause" | "resume" | "clear" };

function parseGoalCommand(argument: string): ParsedGoalCommand {
  const value = argument.trim();
  const control = value.toLowerCase();
  if (value.length === 0 || control === "status") return { kind: "status" };
  if (control === "pause" || control === "resume" || control === "clear" || control === "stop") {
    return { kind: control === "stop" ? "clear" : control };
  }
  const edit = /^edit\s+([\s\S]+)$/iu.exec(value);
  if (edit !== null) {
    const parsed = parseGoalObjectiveAndBudget(edit[1]!);
    return { kind: "edit", ...parsed };
  }
  if (control === "edit") throw new Error("Usage: /goal edit <objective>");
  const parsed = parseGoalObjectiveAndBudget(value);
  return { kind: "create", ...parsed };
}

function parseGoalObjectiveAndBudget(value: string): { objective: string; tokenBudget?: number } {
  const normalized = value.trim();
  const firstWhitespace = normalized.search(/\s/u);
  const firstToken = firstWhitespace < 0
    ? normalized
    : normalized.slice(0, firstWhitespace);
  const flag = /^(--budget|--token-budget)(?:=(.*))?$/u.exec(firstToken);
  if (flag === null) return { objective: normalized };

  let budgetText = flag[2];
  let objective = firstWhitespace < 0 ? "" : normalized.slice(firstWhitespace).trim();
  if (budgetText === undefined) {
    const budgetSeparator = objective.search(/\s/u);
    if (budgetSeparator < 0) {
      throw new Error("Usage: /goal [--budget <tokens>] <objective>");
    }
    budgetText = objective.slice(0, budgetSeparator);
    objective = objective.slice(budgetSeparator).trim();
  }
  if (!/^[1-9]\d*$/u.test(budgetText)) {
    throw new Error("Goal token budget must be a positive integer.");
  }
  const tokenBudget = Number(budgetText);
  if (!Number.isSafeInteger(tokenBudget) || objective.length === 0) {
    throw new Error("Usage: /goal [--budget <tokens>] <objective>");
  }
  return { objective, tokenBudget };
}

function formatThreadGoal(goal: NonNullable<SessionSnapshot["goal"]>): string {
  const budget = goal.tokenBudget === undefined ? "unbounded" : `${goal.tokensUsed}/${goal.tokenBudget}`;
  const reason = goal.blockedReason === undefined ? "" : `\nReason: ${goal.blockedReason}`;
  return [
    `Goal (${goal.status}) - revision ${goal.revision}`,
    `Objective: ${goal.objective}`,
    `Usage: ${budget} tokens - ${goal.timeUsedSeconds}s - ${goal.continuationsUsed} continuation(s)`,
    reason,
  ].filter((line) => line.length > 0).join("\n");
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toLocaleUpperCase()}${value.slice(1)}`;
}

function createInputId(): string {
  return `input-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function clipboardImagePasteKey(platform: NodeJS.Platform): "alt+v" | "ctrl+v" {
  return platform === "win32" ? "alt+v" : "ctrl+v";
}

function uniqueImageMarkerIds(text: string): number[] {
  return [...new Set(imageMarkerIds(text))].sort((left, right) => left - right);
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
