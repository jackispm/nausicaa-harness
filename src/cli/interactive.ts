import {
  CombinedAutocompleteProvider,
  Container,
  Markdown,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  Spacer,
  type Terminal,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  type Component,
  type Focusable,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";

import {
  flattenWorkspaceRunTree,
  listWorkspaceRuns,
  listWorkspaceRunTree,
  SessionController,
  type SessionBashExecution,
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
import type { A2AMessage } from "../domain/types.js";
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
import {
  inspectEnvironmentCredential,
  providerCredentialHint,
  providerSupportsAmbientCredentialChain,
  UNCONFIGURED_MODEL,
} from "./onboarding.js";
import type { CredentialStatus } from "./onboarding.js";
import { SelectorOverlay } from "./selector-component.js";
import { CustomEditor } from "./custom-editor.js";
import type { SelectorFilter } from "./selector-component.js";
import { createKeybindings } from "./keybindings.js";
import type { EdgeSelectionController, EdgeSelectionSnapshot } from "./edge-selection.js";
import {
  QueueSelection,
  type QueueSelectionItem,
} from "./queue-selection.js";
import {
  ActivityLine,
  AgentMessageBlock,
  agentMessagePresentationFromA2A,
  type AgentMessagePresentation,
  AdviceBlock,
  AssistantMessageBlock,
  BrandSplashHeader,
  ContextUsageBlock,
  EdgeSkillPickerSummary,
  getNausicaaColorScheme,
  nausicaaEditorTheme,
  nausicaaMarkdownTheme,
  NoticeBlock,
  parseExternalA2APrompt,
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
  BracketedPasteDecoder,
  environmentCredentialPresent,
  runAuthCommand,
  type AuthModelPort,
  type Output,
  type SecretInput,
} from "./auth.js";
import type {
  AuthEvent,
  AuthPrompt,
  AuthType,
  CredentialStore,
} from "@earendil-works/pi-ai";
import type { ModelProviderInfo } from "../model/index.js";
import { diagnosePermissionFailure } from "../tools/permission-diagnostics.js";
import type { PermissionDiagnostic } from "../tools/permission-diagnostics.js";

export interface InteractiveOptions {
  session: SessionController;
  initialMessage?: string;
  initialImages?: UserImage[];
  /** Embedding/test seam for an explicit startup continuation; CLI leaves this disabled. */
  resumeOnStart?: boolean;
  /** Test/embedding seam; production uses ProcessTerminal. */
  terminal?: Terminal;
  /** Explicitly opt into Pi's fullscreen/alternate-screen layout. */
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
  modelChoices?:
    | readonly (string | ModelSelectorCandidate)[]
    | (() => readonly (string | ModelSelectorCandidate)[]);
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
  /** Defaults to the currently selected model provider, then OpenRouter for compatibility. */
  readonly provider?: string | (() => string);
  /** Environment projection used for conditional logout messaging. */
  readonly environment?: NodeJS.ProcessEnv;
  /** Refresh host-owned status projections after a credential mutation. */
  readonly onChanged?: () => Promise<void> | void;
  /** Refresh a provider-owned dynamic model catalog after login. */
  readonly refreshModels?: (provider: string) => Promise<void>;
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
  private readonly abortController = new AbortController();
  private readonly listeners = new Set<(chunk: Buffer | string) => void>();
  private readonly pasteDecoder = new BracketedPasteDecoder();
  private cancelled = false;

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

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
    this.pasteDecoder.push(data, (decoded) => this.emit(decoded));
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.abortController.abort(new Error("Login cancelled"));
    this.emit("\u0003");
  }

  private emit(data: string): void {
    if (this.cancelled && data !== "\u0003") return;
    for (const listener of [...this.listeners]) listener(data);
  }
}

/**
 * Non-transcript input surface for provider-owned login prompts. Secret
 * prompts show a length-preserving mask; text/manual-code prompts show the
 * value so account ids and paths are not entered blindly.
 */
class TuiAuthPromptView implements Component, Focusable {
  private prompt: AuthPrompt | undefined;
  private value = "";
  private secretLength = 0;
  private _focused = false;

  setPrompt(prompt: AuthPrompt): void {
    this.prompt = prompt;
    this.value = "";
    this.secretLength = 0;
  }

  setValue(value: string): void {
    this.value = value;
  }

  setSecretLength(length: number): void {
    this.secretLength = Math.max(0, Math.min(length, 256));
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const prompt = this.prompt;
    if (prompt === undefined) {
      return [truncateToWidth(" Authentication input", safeWidth, "")];
    }
    const label = prompt.type === "secret" || prompt.type === "manual_code" ? "Credential" : "Input";
    const display = prompt.type === "secret" || prompt.type === "manual_code"
      ? "*".repeat(this.secretLength)
      : this.value;
    return [
      truncateToWidth(` ${terminalSafeText(prompt.message)}`, safeWidth, ""),
      truncateToWidth(` ${label}: ${display || "_"}`, safeWidth, ""),
      truncateToWidth(" Enter submit · Esc/Ctrl+C cancel", safeWidth, ""),
    ];
  }

  invalidate(): void {}
}

const quietAuthOutput: Output = {
  write: () => true,
};

const MAX_PASTED_IMAGE_BYTES = 64 * 1024 * 1024;
const DEFAULT_INTERRUPT_EXIT_WINDOW_MS = 1_000;
const MAX_INTERACTIVE_BASH_CONTEXT_CHARS = 32 * 1024;
const MAX_PENDING_BASH_CONTEXTS = 8;

/** Pi-inspired presentation layer. Runtime state stays in SessionController. */
export async function runInteractive(options: InteractiveOptions): Promise<number> {
  const terminal = options.terminal ?? new ProcessTerminal();
  // Pi uses the regular main-screen renderer by default. Fullscreen is an
  // explicit opt-in for embedders/tests that need a fixed viewport and dock.
  const useAltScreen = options.forceAltScreen === true;
  const tui: TUI = useAltScreen
    ? new TuiAltScreen(terminal, undefined, undefined, { mouse: true })
    : new TuiMainScreen(terminal);
  // Pi shares one keybinding manager between the editor and every selector.
  // Register it before constructing any focusable component so pi-tui's
  // global Editor/Input/SelectList bindings resolve the same definitions.
  const keybindings = createKeybindings();
  // Pi leaves clearOnShrink under the TUI/settings/environment default. Do not
  // force it here: forcing a main-screen full redraw clears scrollback and
  // moves the regular welcome stream back to the top of the terminal.
  // A forced render resets pi-tui's differential-render state. That is safe
  // in the alternate screen, where the next frame starts at a known origin,
  // but it leaves stale rows behind on the main screen because the terminal
  // cursor is already below the previous frame. Keep the previous frame for
  // main-screen updates so shrinking selectors and notices can be erased.
  const requestTuiRender = (force = false): void => {
    // Pi invalidates changed components and always keeps the renderer's
    // differential state. requestRender(true) resets the main-screen viewport
    // and can replay the welcome stream at the top.
    if (force) tui.invalidate();
    tui.requestRender();
  };
  // Warp and other terminal session browsers use the OSC title as their
  // session label. Keep it stable and application-specific while the TUI is
  // running; the sidebar icon remains terminal-owned metadata.
  terminal.setTitle("Nausicaa");
  const screen = new VStack();
  const documentContainer = new Container();
  const transcript = new Container();
  const activity = new ActivityLine(() => options.session.snapshot(), tui);
  const statusContainer = new Container();
  let activityMounted = false;
  const mountActivity = (): void => {
    if (activityMounted) return;
    statusContainer.clear();
    statusContainer.addChild(activity);
    activityMounted = true;
  };
  const unmountActivity = (): void => {
    if (!activityMounted) return;
    statusContainer.clear();
    activityMounted = false;
  };
  const startActivity = (): void => {
    activity.start();
    mountActivity();
  };
  const stopActivity = (): void => {
    activity.stop();
    unmountActivity();
  };
  const resumeActivity = (): void => {
    activity.resumeWorking();
    mountActivity();
  };
  const startRetryActivity = (attempt: number, maxAttempts: number, delayMs: number): void => {
    activity.startRetry(attempt, maxAttempts, delayMs);
    mountActivity();
  };
  const startCompactionActivity = (): void => {
    activity.startCompaction();
    mountActivity();
  };
  const shortcutGuide = new Container();
  const queuePreview = new QueuePreview();
  // Keep the same stable containers as Pi. Transient selectors replace only
  // the editor child; they never replace the layout slot itself.
  const pendingMessagesContainer = new Container();
  pendingMessagesContainer.addChild(queuePreview);
  const widgetContainerAbove = new Container();
  // Pi keeps one spacer in the above-editor widget slot even when no
  // extension widget is mounted. This is part of the prompt's stable
  // baseline geometry, so selector expansion and collapse use the same
  // editor origin on every frame.
  widgetContainerAbove.addChild(new Spacer(1));
  widgetContainerAbove.addChild(shortcutGuide);
  const workerTaskSummary = new WorkerTaskSummaryLine(
    () => options.session.workerTaskSummary(),
  );
  widgetContainerAbove.addChild(workerTaskSummary);
  const editor = new CustomEditor(tui, nausicaaEditorTheme, keybindings, { paddingX: 0 });
  const editorContainer = new Container();
  editorContainer.addChild(editor);
  const widgetContainerBelow = new Container();
  const footerContainer = new Container();
  const toolBlocks = new Map<string, ToolStatusBlock>();
  const agentMessageBlocks = new Map<string, AgentMessageBlock>();
  const assistantBlocks: AssistantMessageBlock[] = [];
  let thinkingExpanded = true;
  let toolsExpanded = false;
  let agentMessagesExpanded = false;
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
  let activeAuthPromptView: TuiAuthPromptView | undefined;
  let activeSubmission: QueuedSubmission | undefined;
  let activeBashAbortController: AbortController | undefined;
  let bashOperationSequence = 0;
  let pendingBashContext: string[] = [];
  let submissionDrainPromise: Promise<void> | undefined;
  let finishPromise: Promise<void> | undefined;
  let queuedFinishCode: number | undefined;
  let interruptExitUntil = 0;
  let interruptExitTimer: ReturnType<typeof setTimeout> | undefined;
  let themePreference: ThemeChoice = "auto";
  let detectedColorScheme = getNausicaaColorScheme();
  let activeSelector: {
    token: object;
    component: Component & Focusable & { handleInput(data: string): void };
    restorePreview: () => void;
    dispose?: () => void;
  } | undefined;
  let pendingPermissionApproval: (() => void) | undefined;
  let permissionApprovalTail: Promise<void> = Promise.resolve();
  let permissionApprovalGranted = false;
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
  const headerContainer = new Container();
  documentContainer.addChild(headerContainer);
  documentContainer.addChild(transcript);
  const transcriptViewport = new ScrollView(documentContainer, {
    follow: "end",
    primary: true,
    scrollbar: "auto",
  });
  const sessionTray = new SessionTray(
    () => options.session.snapshot(),
    () => interruptExitUntil > Date.now() ? "Press Ctrl+C again to exit" : undefined,
  );
  footerContainer.addChild(sessionTray);
  // Keep the transcript and the input dock as two stable layout regions, like
  // Pi's InteractiveMode. Dynamic rows live in their corresponding stable
  // containers so adding/removing a selector cannot orphan the editor slot.
  const dock = new VStack([
    { component: pendingMessagesContainer, shrink: 1, minSize: 0 },
    { component: statusContainer, shrink: 1, minSize: 0 },
    { component: widgetContainerAbove, shrink: 1, minSize: 0 },
    { component: editorContainer, shrink: 1, minSize: 3 },
    { component: widgetContainerBelow, shrink: 1, minSize: 0 },
    { component: footerContainer, shrink: 1, minSize: 1 },
  ]);
  screen.addChild(transcriptViewport, { basis: 0, grow: 1, shrink: 1, minSize: 1 });
  if (tui instanceof TuiAltScreen) {
    screen.addChild(dock, { basis: "auto", grow: 0, shrink: 1, minSize: 1 });
    tui.setLayoutRoot(screen);
  } else {
    tui.addChild(documentContainer);
    tui.addChild(pendingMessagesContainer);
    tui.addChild(statusContainer);
    tui.addChild(widgetContainerAbove);
    tui.addChild(editorContainer);
    tui.addChild(widgetContainerBelow);
    tui.addChild(footerContainer);
  }
  tui.setFocus(editor);
  const autocompleteSpecs = [...publicInteractiveCommandSpecs()].sort((left, right) => (
    autocompletePriority(left.name) - autocompletePriority(right.name)
  ));
  const autocompleteCommands = autocompleteSpecs.map((spec) => {
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
  // Keep the initial command menu useful while compatibility aliases remain
  // accepted by dispatch but are intentionally hidden from the public list.
  // Pi's default editor exposes five completion rows. Larger menus make the
  // composer grow and are a frequent source of apparent dock drift.
  editor.setAutocompleteMaxVisible?.(5);
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
    requestTuiRender(true);
  });
  tui.setTerminalColorSchemeNotifications(true);
  // Tool rows retain Prime's shared four-frame pulse. The request indicator is
  // a real pi-tui Loader and owns its braille interval independently.
  const toolAnimationTimer = setInterval(() => {
    for (const block of toolBlocks.values()) block.advance();
    tui.requestRender();
  }, 250);
  toolAnimationTimer.unref?.();

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

  const clearPendingBashContext = (): void => {
    pendingBashContext = [];
  };

  const renderBashExecution = (
    result: SessionBashExecution,
  ): Record<string, unknown> => {
    const execution = result.execution;
    const diagnostic = diagnosePermissionFailure({
      command: result.command,
      error: execution.spawnError,
      stderr: execution.stderr.content,
    });
    return {
      stdout: execution.stdout.content,
      stderr: execution.stderr.content,
      exitCode: execution.exitCode,
      aborted: execution.aborted,
      timedOut: execution.timedOut,
      ...(execution.spawnError === undefined
        ? {}
        : { error: execution.spawnError.message }),
      ...(diagnostic === undefined ? {} : { diagnostic }),
      truncated: execution.stdout.truncated || execution.stderr.truncated,
      truncation: {
        stdout: execution.stdout,
        stderr: execution.stderr,
      },
    };
  };

  const tailForBashContext = (value: string, limit: number): string => {
    if (value.length <= limit) return value;
    return `[earlier output omitted; showing the last ${limit} characters]\n${value.slice(-limit)}`;
  };

  const bashContextFromExecution = (result: SessionBashExecution): string => {
    const execution = result.execution;
    const streamLimit = Math.floor(MAX_INTERACTIVE_BASH_CONTEXT_CHARS / 2);
    const rows = [`[Nausicaa Bash] $ ${result.command}`];
    if (execution.stdout.content.length > 0) {
      rows.push(`stdout:\n${tailForBashContext(execution.stdout.content, streamLimit)}`);
    }
    if (execution.stderr.content.length > 0) {
      rows.push(`stderr:\n${tailForBashContext(execution.stderr.content, streamLimit)}`);
    }
    if (execution.spawnError !== undefined) {
      rows.push(`error: ${execution.spawnError.message}`);
    }
    if (execution.aborted) rows.push("status: aborted");
    if (execution.timedOut) rows.push("status: timed out");
    if (execution.exitCode !== 0 && execution.exitCode !== null) {
      rows.push(`exit code: ${execution.exitCode}`);
    }
    if (rows.length === 1) rows.push("(no output)");
    return terminalSafeText(rows.join("\n"));
  };

  /** Ask before crossing a capability boundary; headless callers fail closed. */
  const requestPermissionApproval = (
    title: string,
    subtitle: string,
    approveLabel: string,
    approveDescription: string,
    reuseGranted = true,
  ): Promise<boolean> => {
    if (reuseGranted && permissionApprovalGranted) return Promise.resolve(true);
    const request = permissionApprovalTail.then(() => {
      if (reuseGranted && permissionApprovalGranted) return true;
      if (closing || closed) return false;
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const settle = (approved: boolean): void => {
          if (settled) return;
          settled = true;
          if (pendingPermissionApproval === cancelPending) pendingPermissionApproval = undefined;
          resolve(approved);
        };
        const cancelPending = (): void => settle(false);
        pendingPermissionApproval = cancelPending;
        const selector = new SelectorOverlay({
          title,
          subtitle,
          options: [
            {
              value: "approve",
              label: approveLabel,
              description: approveDescription,
            },
            {
              value: "cancel",
              label: "Cancel",
              description: "Leave the command failed and keep the current boundary",
            },
          ],
          onSelect: (value) => {
            closeSelector(false, selector);
            settle(value === "approve");
          },
          onCancel: () => {
            closeSelector(true, selector);
            settle(false);
          },
        });
        mountSelector(selector);
      });
    });
    permissionApprovalTail = request.then(() => undefined, () => undefined);
    return request;
  };

  /**
   * Ask before crossing a capability boundary. A single approval retries the
   * exact Bash command at most once, so a denied command cannot loop forever.
   */
  const requestBashPermission = (
    command: string,
    diagnostic: PermissionDiagnostic,
  ): Promise<boolean> => {
    const current = options.session.snapshot().permissionProfile;
    const needsProfileUpgrade = current !== "full-access";
    return requestPermissionApproval(
      needsProfileUpgrade ? "Permission required" : "Host permission required",
      `${diagnostic.hint}\n\nCommand: ${command}`,
      needsProfileUpgrade ? "Allow full access and retry" : "Retry command",
      needsProfileUpgrade
        ? "Use the host shell for this and future commands in this session"
        : "Retry after granting the required permission in the host or OS",
      needsProfileUpgrade,
    );
  };

  // Model-visible gated tools use the same TUI approval boundary as operator
  // Bash. Approval upgrades only this local session; durable lane boundaries
  // and child-lane restrictions remain unchanged.
  options.session.setApprovalHandler(async (context) => {
    const effect = context.tool.metadata.effect;
    const permissionWasRestricted = options.session.snapshot().permissionProfile !== "full-access";
    const approved = await requestPermissionApproval(
      "Permission required",
      `Tool ${context.tool.tool.definition.name} needs ${effect} capability before it can run.`,
      "Allow full access and run",
      "Grant the wider host boundary for this session",
      permissionWasRestricted,
    );
    if (!approved) return { approved: false, reason: "Permission denied in TUI" };
    try {
      if (options.session.snapshot().permissionProfile !== "full-access") {
        await options.session.selectPermissionProfile("full-access");
      }
      if (permissionWasRestricted) permissionApprovalGranted = true;
      return { approved: true };
    } catch (error: unknown) {
      return {
        approved: false,
        reason: `Permission upgrade failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });

  const runInteractiveBash = async (
    input: string,
    includeContext: boolean,
  ): Promise<void> => {
    const command = input.slice(includeContext ? 1 : 2).trim();
    if (command.length === 0) {
      appendNotice(
        includeContext ? "Usage: ! <bash command>" : "Usage: !! <bash command>",
        "warning",
      );
      return;
    }

    const operationId = `interactive-bash:${++bashOperationSequence}`;
    const block = new ToolStatusBlock(
      "bash",
      "running",
      includeContext ? "! · context queued" : "!! · context disabled",
    );
    block.setArguments(JSON.stringify({ command }));
    selectLatestToolExpandHint([...toolBlocks.values()], block);
    toolBlocks.set(operationId, block);
    appendBlock(block);

    const controller = new AbortController();
    activeBashAbortController = controller;
    const retryPermissionFailure = async (
      diagnostic: PermissionDiagnostic,
      permissionWasRestricted: boolean,
    ): Promise<boolean> => {
      if (
        options.session.snapshot().collaborationMode === "plan"
        || !(await requestBashPermission(command, diagnostic))
      ) return false;
      try {
        if (options.session.snapshot().permissionProfile !== "full-access") {
          await options.session.selectPermissionProfile("full-access");
        }
        if (permissionWasRestricted) permissionApprovalGranted = true;
        block.setStatus("running", "retrying with full-access");
        await executeAttempt(false);
      } catch (retryError: unknown) {
        const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
        block.setStatus("failed", "retry failed");
        block.setResult(JSON.stringify({
          error: retryMessage,
          ...(diagnosePermissionFailure({ command, error: retryError }) === undefined
            ? {}
            : { diagnostic: diagnosePermissionFailure({ command, error: retryError }) }),
        }));
        appendNotice(`Bash retry failed: ${retryMessage}`, "error");
      }
      return true;
    };
    async function executeAttempt(allowRetry: boolean): Promise<void> {
      try {
        const result = await options.session.executeBash(command, controller.signal);
        const execution = result.execution;
        const diagnostic = diagnosePermissionFailure({
          command,
          error: execution.spawnError,
          stderr: execution.stderr.content,
        });
        const permissionWasRestricted = options.session.snapshot().permissionProfile !== "full-access";
        if (
          allowRetry
          && diagnostic !== undefined
          && await retryPermissionFailure(diagnostic, permissionWasRestricted)
        ) return;
        const succeeded = execution.spawnError === undefined
          && !execution.aborted
          && !execution.timedOut
          && execution.exitCode === 0;
        block.setStatus(
          succeeded ? "succeeded" : "failed",
          succeeded
            ? result.profile === "workspace" ? "sandboxed" : "host shell"
            : execution.aborted
              ? "aborted"
              : execution.timedOut
                ? "timed out"
                : `exit ${execution.exitCode ?? "unknown"}`,
        );
        block.setResult(JSON.stringify(renderBashExecution(result)));
        if (includeContext) {
          pendingBashContext = [
            ...pendingBashContext,
            bashContextFromExecution(result),
          ].slice(-MAX_PENDING_BASH_CONTEXTS);
          appendNotice("Bash output queued for the next prompt.", "info");
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const diagnostic = diagnosePermissionFailure({ command, error });
        // Plan mode is an intentional policy decision, not an escalation
        // request. Capability upgrades are remembered for this session; an OS
        // or host denial still asks again because changing the profile cannot
        // grant that external permission.
        if (
          allowRetry
          && diagnostic !== undefined
          && await retryPermissionFailure(
            diagnostic,
            options.session.snapshot().permissionProfile !== "full-access",
          )
        ) {
          return;
        }
        block.setStatus("failed", "not executed");
        block.setResult(JSON.stringify({
          error: message,
          ...(diagnostic === undefined ? {} : { diagnostic }),
        }));
        appendNotice(`Bash was not executed: ${message}`, "error");
      }
    }
    try {
      await executeAttempt(true);
    } finally {
      if (activeBashAbortController === controller) activeBashAbortController = undefined;
      tui.requestRender();
    }
  };

  const appendAgentMessage = (details: AgentMessagePresentation): AgentMessageBlock | undefined => {
    const existing = agentMessageBlocks.get(details.messageId);
    if (existing !== undefined) return existing;
    const previous = transcript.children.at(-1);
    const block = new AgentMessageBlock(details, {
      suppressLeadingSpace: previous instanceof AgentMessageBlock,
    });
    block.setExpanded(agentMessagesExpanded);
    agentMessageBlocks.set(details.messageId, block);
    // AgentMessageBlock owns its Pi-style leading spacer so adjacent agent
    // messages can be compacted without affecting ordinary transcript rows.
    appendBlock(block, false);
    return block;
  };

  const showAgentTopology = async (argument: string): Promise<void> => {
    if (argument.length > 0) throw new Error("Usage: /list-agents");
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
      const sessionSnapshot = options.session.snapshot();
      appendBlock(new AgentTopologyBlock(source, {
        currentEndpoint: {
          workspaceId: "local-workspace",
          sessionId: options.session.sessionId,
          runId: sessionSnapshot.runId ?? `session:${options.session.sessionId}`,
          laneId: "main",
        },
      }));
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
      "`Ctrl+P` agent messages",
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
    // AssistantMessageBlock owns Pi's leading Spacer once it has visible
    // content. Adding a transcript spacer here would create a double gap.
    spaceBefore = false,
  ): Spacer | undefined => {
    block.setThinkingExpanded(thinkingExpanded);
    assistantBlocks.push(block);
    return appendBlock(block, spaceBefore);
  };

  const resetTranscript = (): void => {
    transcript.clear();
    assistantBlocks.length = 0;
    agentMessageBlocks.clear();
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
    // The live assistant component inserts the same leading Spacer as Pi's
    // AssistantMessageComponent. Keep the outer transcript gap absent.
    responseSpacer = appendBlock(responseGroup, false);
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
        const agentMessage = parseExternalA2APrompt(entry.content);
        if (agentMessage !== undefined) {
          appendAgentMessage(agentMessage);
          return;
        }
        addPromptToHistory(entry.content);
        appendBlock(new UserMessageBlock(entry.content, entry.imageTypes));
        return;
      }
      if (entry.role === "assistant") {
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
      appendBlock(block, false);
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
        && event.payload.message.payload.type === "advice.propose"
        && event.payload.message.sourceEndpoint === undefined;
      const isExternalA2AMessage = event.type === "message.sent"
        && event.payload.message.sourceEndpoint !== undefined;
      // The transcript renderer owns Main's presentation surface. Teto and
      // Worker facts stay durable and available to their schedulers, while a
      // Teto advice message remains an explicit user-facing notice below.
      if (event.laneId !== "main" && !isTetoAdvice && !isExternalA2AMessage) {
        // Worker lifecycle events still change the durable summary mounted in
        // the dock. They are not transcript entries, but skipping the redraw
        // leaves the old "running/ready" label until an unrelated Main event.
        tui.requestRender();
        return;
      }
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
        case "turn.started":
        case "turn.resumed":
          startActivity();
          tui.requestRender();
          break;
        case "model.requested":
        case "model.completed":
          // A retrying provider returns to the ordinary Pi loader when the
          // next physical attempt is admitted or completes.
          resumeActivity();
          tui.requestRender();
          break;
        case "model.retrying":
          startRetryActivity(
            event.payload.attempt,
            event.payload.maxAttempts,
            event.payload.delayMs,
          );
          tui.requestRender();
          break;
        case "model.cancelled":
          stopActivity();
          tui.requestRender();
          break;
        case "turn.completed":
        case "turn.waiting":
        case "turn.interrupted":
        case "turn.failed":
        case "turn.cancelled":
          stopActivity();
          tui.requestRender();
          if (event.type === "turn.waiting") {
            appendNotice(
              event.payload.reason === "model-output-limit"
                ? "The model reached its output limit. The partial answer is preserved; use /resume to continue."
                : "Turn paused at a safe boundary. Use /resume or /stop.",
              "warning",
            );
          } else if (event.type === "turn.failed") {
            appendNotice("Turn failed. Use /resume or start a new Run.", "error");
          } else if (event.type === "turn.cancelled") {
            appendNotice("Turn cancelled.", "warning");
          }
          break;
        case "run.failed":
          stopActivity();
          tui.requestRender();
          appendNotice("Run failed. Start a new Run or resume from the last checkpoint.", "error");
          break;
        case "user.message": {
          clearShortcutGuide();
          try {
            const message = await options.session.readConversationMessage(event.payload.messageRef);
            if (closed || generation !== transcriptGeneration) break;
            if (message.role === "user") {
              const agentMessage = parseExternalA2APrompt(message.content);
              if (agentMessage !== undefined) {
                appendAgentMessage(agentMessage);
                break;
              }
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
          appendBlock(block, false);
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
          const message = event.payload.message;
          const payload = message.payload;
          if (message.from === "teto" && payload.type === "advice.propose"
            && message.sourceEndpoint === undefined) {
            appendBlock(new AdviceBlock(
              payload.advice.claim,
              payload.advice.suggestedAction,
              payload.advice.confidence,
            ));
            break;
          }
          if (message.sourceEndpoint !== undefined) {
            const agentMessage = agentMessagePresentationFromA2A(message);
            if (agentMessage !== undefined) {
              appendAgentMessage(agentMessage);
              break;
            }
          }
          const notice = formatA2AMessageNotice(message);
          if (notice !== undefined) appendNotice(notice);
          break;
        }
        case "advice.acknowledged":
          appendNotice(
            `Teto advice ${event.payload.disposition}.`,
            event.payload.disposition === "accept" ? "success" : "info",
          );
          break;
        case "fukai.compaction.requested":
          startCompactionActivity();
          appendNotice("Compacting context...", "info");
          break;
        case "fukai.compaction.completed":
          // The summary is persisted in a later committed event; keep the
          // compaction loader visible until that durable boundary settles.
          tui.requestRender();
          break;
        case "fukai.compaction.committed":
          if (options.session.snapshot().status === "running") resumeActivity();
          else stopActivity();
          appendNotice("Context compacted for the next Turn.", "success");
          break;
        case "fukai.compaction.failed":
          if (options.session.snapshot().status === "running") resumeActivity();
          else stopActivity();
          appendNotice("Compaction provider failed; the raw context is unchanged.", "warning");
          break;
        case "fukai.compaction.fallback":
          if (options.session.snapshot().status === "running") resumeActivity();
          else stopActivity();
          appendNotice("Compaction fell back to the raw context; the transcript is unchanged.", "warning");
          break;
      }
    } else if (runtimeEvent.kind === "stream") {
      const event = runtimeEvent.event;
      if (event.laneId !== "main") return;
      switch (event.type) {
        case "stream.start":
          startActivity();
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
          stopActivity();
          discardResponse();
          break;
        case "stream.cancelled":
          // A durable turn.cancelled event owns the one user-visible terminal notice.
          stopActivity();
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
    activeBashAbortController?.abort(new Error("Nausicaa is closing"));
    pendingPermissionApproval?.();
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
      clearInterval(toolAnimationTimer);
      await terminal.drainInput(250, 25).catch(() => undefined);
      // Freeze the last live snapshot before closing detaches the Ledger-backed state.
      try {
        if (tui instanceof TuiAltScreen) tui.setLayoutRoot(documentContainer);
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
    const selector = activeSelector;
    if (selector !== undefined) {
      pendingPermissionApproval?.();
      // Let the mounted selector settle any awaiting Promise (provider/auth
      // selection, permissions, skills, etc.) before restoring editor focus.
      selector.component.handleInput("\x1b");
      if (activeSelector === selector) closeSelector(true);
      return;
    }
    if (activeSecretInput !== undefined) {
      // A SIGINT during OAuth or a hidden API-key prompt cancels that auth
      // operation first. The surrounding TUI stays usable for a retry.
      activeSecretInput.cancel();
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

  const readModelOptions = () => {
    const modelChoices = typeof options.modelChoices === "function"
      ? options.modelChoices()
      : options.modelChoices ?? [];
    return modelSelectorOptions(
      options.session.snapshot().model === UNCONFIGURED_MODEL
        ? ""
        : options.session.snapshot().model,
      options.session.tetoModel === UNCONFIGURED_MODEL ? "" : options.session.tetoModel,
      modelChoices,
    );
  };

  const showSetup = (): void => {
    const startupNotice = typeof options.startupNotice === "function"
      ? options.startupNotice()
      : options.startupNotice;
    appendBlock(new Markdown([
      "### Local setup",
      startupNotice ?? "Use `/model` to choose a local catalog entry. Provider auth is unverified until a real request.",
      "Use `/login` (or `nausicaa auth login <provider>`) to choose API key or OAuth, or set the provider's documented environment variable.",
    ].join("\n\n"), 1, 0, nausicaaMarkdownTheme));
  };

  const providerInfos = (): readonly ModelProviderInfo[] => (
    options.auth?.modelPort.providers?.() ?? []
  );

  const authTypesForProvider = (provider: string): readonly AuthType[] => (
    options.auth?.modelPort.providerAuthTypes?.(provider) ?? ["api_key"]
  );

  const authTypeLabel = (type: AuthType, provider: string): string => {
    const info = providerInfos().find((candidate) => candidate.id === provider);
    if (type === "oauth") {
      return info?.oauthLoginLabel ?? info?.oauthName ?? "Browser/device sign-in (OAuth)";
    }
    return info?.apiKeyName ?? "API key";
  };

  const providerAuthStatus = async (
    provider: ModelProviderInfo,
    saved: ReadonlySet<string>,
  ): Promise<string> => {
    let auth: Awaited<ReturnType<AuthModelPort["checkAuth"]>>;
    let checkFailed = false;
    try {
      auth = await options.auth!.modelPort.checkAuth(provider.id);
    } catch {
      checkFailed = true;
      auth = undefined;
    }
    if (auth !== undefined) {
      const source = auth.source?.trim().toLocaleLowerCase();
      if (auth.type === "oauth" || source === "oauth") {
        return "saved OAuth credential · auth unverified";
      }
      if (source === "stored credential") {
        return "saved API key · auth unverified";
      }
      return `ready locally · ${auth.source ?? auth.type}`;
    }
    if (saved.has(provider.id)) {
      return checkFailed
        ? "saved credential · local check unavailable"
        : "saved credential · auth unavailable";
    }
    const environment = inspectEnvironmentCredential(
      provider.id,
      options.auth?.environment ?? process.env,
    );
    if (environment.present) return "environment configured · auth unverified";
    if (environment.partial) return "partial environment · setup incomplete";
    if (checkFailed) return "local auth check unavailable";
    return "not configured";
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
    const provider = normalizeAuthProviderId(argument.length > 0
      ? argument
      : configuredProvider ?? modelProvider);
    if (options.auth?.modelPort.hasProvider !== undefined
      && !options.auth.modelPort.hasProvider(provider)) {
      throw new Error(`Unknown provider ${provider}; choose a provider from the model catalog.`);
    }
    return provider;
  };

  const selectLoginProvider = async (): Promise<string | undefined> => {
    const providers = providerInfos()
      // Dynamic providers may have no models until their first authenticated
      // refresh (for example Radius), but they must remain selectable.
      .filter((provider) => provider.authTypes.length > 0)
      .sort((left, right) => left.name.localeCompare(right.name));
    if (providers.length <= 1) return providers[0]?.id;
    let saved = new Set<string>();
    try {
      saved = new Set((await options.auth!.credentialStore.list()).map((entry) => entry.providerId));
    } catch {
      // The selector remains useful even if the credential store is unavailable.
    }
    const status = new Map<string, string>();
    await Promise.all(providers.map(async (provider) => {
      status.set(provider.id, await providerAuthStatus(provider, saved));
    }));
    if (closing) return undefined;
    return new Promise<string | undefined>((resolve) => {
      let settled = false;
      const settle = (value: string | undefined): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const selector = new SelectorOverlay({
        title: "Providers",
        subtitle: "Choose where to authenticate. Search by provider name or id.",
        searchLabel: "Search providers",
        options: providers.map((provider) => ({
          value: provider.id,
          label: `${provider.name} (${provider.id})`,
          description: `${provider.modelCount} models · ${provider.authTypes.map((type) => authTypeLabel(type, provider.id)).join(" / ")} · ${status.get(provider.id) ?? "status unavailable"}`,
        })),
        onSelect: (value) => {
          settle(value);
          closeSelector(false, selector);
        },
        onCancel: () => {
          settle(undefined);
          closeSelector(true, selector);
        },
      });
      mountSelector(selector, undefined, () => settle(undefined));
    });
  };

  const selectLoginAuthType = async (
    provider: string,
    showChoice = true,
  ): Promise<AuthType | undefined> => {
    const authTypes = authTypesForProvider(provider);
    if (authTypes.length <= 1) return authTypes[0];
    // Keep the established one-provider `/login` shortcut ergonomic. Users
    // can still select OAuth explicitly with `/login <provider> oauth`.
    if (!showChoice) return authTypes.includes("api_key") ? "api_key" : authTypes[0];
    const info = providerInfos().find((candidate) => candidate.id === provider);
    return new Promise<AuthType | undefined>((resolve) => {
      let settled = false;
      const settle = (value: AuthType | undefined): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const selector = new SelectorOverlay({
        title: "Sign in",
        subtitle: `${info?.name ?? provider} supports more than one authentication method.`,
        options: authTypes.map((type) => ({
          value: type,
          label: authTypeLabel(type, provider),
          description: type === "oauth"
            ? "Open a browser or device flow; no API key is entered"
            : "Enter a provider key through a hidden prompt",
        })),
        onSelect: (value) => {
          settle(value as AuthType);
          closeSelector(false, selector);
        },
        onCancel: () => {
          settle(undefined);
          closeSelector(true, selector);
        },
      });
      mountSelector(selector, undefined, () => settle(undefined));
    });
  };

  const selectLogoutProvider = async (): Promise<string | undefined> => {
    const credentials = await options.auth!.credentialStore.list();
    if (closing) return undefined;
    if (credentials.length === 0) {
      appendNotice("No saved credentials to remove. Environment credentials remain available.", "info");
      return undefined;
    }
    const names = new Map(providerInfos().map((provider) => [provider.id, provider.name]));
    return new Promise<string | undefined>((resolve) => {
      const selector = new SelectorOverlay({
        title: "Sign out",
        searchLabel: "Search saved accounts",
        options: credentials
          .map((credential) => ({
            value: credential.providerId,
            label: names.get(credential.providerId) ?? credential.providerId,
            description: `${credential.providerId} · ${credential.type === "oauth" ? "Saved OAuth credential" : "Saved API key"}`,
          }))
          .sort((left, right) => left.label.localeCompare(right.label)),
        onSelect: (value) => {
          resolve(value);
          closeSelector(false, selector);
        },
        onCancel: () => {
          resolve(undefined);
          closeSelector(true, selector);
        },
      });
      mountSelector(selector, undefined, () => resolve(undefined));
    });
  };

  const renderAuthPrompt = (prompt: AuthPrompt): void => {
    const message = terminalSafeText(prompt.message);
    activeAuthPromptView?.setPrompt(prompt);
    if (prompt.type === "select") {
      appendNotice(
        `${message}\n${prompt.options.map((option, index) => `${index + 1}. ${terminalSafeText(option.label)}`).join("\n")}\nEnter a number or option id.`,
        "info",
      );
      return;
    }
    const inputHint = prompt.type === "secret" || prompt.type === "manual_code"
      ? "Input is hidden. Press Enter to continue, or Esc/Ctrl+C to cancel."
      : "Enter a value, then press Enter. Esc/Ctrl+C cancels.";
    appendNotice(`${message}\n${inputHint}`, "info");
  };

  const renderAuthEvent = (event: AuthEvent): void => {
    switch (event.type) {
      case "auth_url":
        appendNotice(
          terminalSafeText(`${event.instructions ?? "Open this URL to authenticate"}: ${event.url}`),
          "info",
        );
        break;
      case "device_code":
        appendNotice(
          terminalSafeText(`Open ${event.verificationUri} and enter code ${event.userCode}${event.expiresInSeconds === undefined ? "" : ` (expires in ${event.expiresInSeconds}s)`}`),
          "info",
        );
        break;
      case "info":
      case "progress":
        appendNotice(
          terminalSafeText(`${event.message}${event.type === "info" && event.links !== undefined
            ? `\n${event.links.map((link) => `${link.label ?? "Open"}: ${link.url}`).join("\n")}`
            : ""}`),
          "info",
        );
        break;
    }
  };

  const loginInTui = async (argument: string, openModels = true): Promise<boolean> => {
    if (closing) return false;
    if (options.auth === undefined) {
      appendNotice(
        "Authentication is unavailable in this session. Use `nausicaa auth login` instead.",
        "warning",
      );
      return false;
    }
    const parts = argument.split(/\s+/u).filter(Boolean);
    if (parts.length > 2) throw new Error("Usage: /login [provider] [api-key|oauth]");
    const providerWasExplicit = parts[0] !== undefined;
    const multipleProviders = providerInfos().length > 1;
    const provider = parts[0] === undefined
      ? multipleProviders
        ? await selectLoginProvider()
        : authProvider("", "login")
      : authProvider(parts[0], "login");
    if (provider === undefined) {
      appendNotice("Login cancelled.", "info");
      return false;
    }
    const authTypes = authTypesForProvider(provider);
    if (authTypes.length === 0) {
      appendNotice(`No supported authentication method is available for ${provider}.`, "error");
      return false;
    }
    const showAuthTypeChoice = providerWasExplicit || multipleProviders;
    const requestedAuthType = parts[1] === undefined
      ? authTypes.length <= 1 || !showAuthTypeChoice
        ? authTypes[0]
        : await selectLoginAuthType(provider)
      : normalizeAuthType(parts[1]);
    if (requestedAuthType === undefined) {
      appendNotice("Login cancelled.", "info");
      return false;
    }
    if (closing) return false;
    const input = new TuiSecretInput();
    const authPromptView = new TuiAuthPromptView();
    activeAuthPromptView = authPromptView;
    activeSecretInput = input;
    editorContainer.clear();
    editorContainer.addChild(authPromptView);
    tui.setFocus(authPromptView);
    requestTuiRender();
    appendNotice(
      requestedAuthType === "oauth"
        ? `${provider} browser/device sign-in started. Follow the authorization instructions below.`
        : `${provider} API key input is hidden. Press Enter to save, or Esc/Ctrl+C to cancel.`,
      "info",
    );
    try {
      await runAuthCommand(
        { action: "login", provider, authType: requestedAuthType, json: false },
        {
          credentialStore: options.auth.credentialStore,
          modelPort: options.auth.modelPort,
          input,
          output: quietAuthOutput,
          ...(options.auth.environment === undefined ? {} : { environment: options.auth.environment }),
          onAuthEvent: renderAuthEvent,
          onAuthPrompt: renderAuthPrompt,
          onAuthInput: (value) => {
            authPromptView.setValue(value);
            // Provider-owned text prompts can be submitted in the same input
            // tick as their final character. Flush this non-secret value now
            // so the TUI never skips the visible field before restoring the
            // normal editor; secret prompts never call this callback.
            tui.renderNow();
          },
          onAuthSecretInput: (length) => {
            authPromptView.setSecretLength(length);
            tui.renderNow();
          },
        },
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      appendNotice(
        message === "Login cancelled" ? "Login cancelled." : `Login failed: ${oneLine(message)}`,
        message === "Login cancelled" ? "info" : "error",
      );
      return false;
    } finally {
      if (activeSecretInput === input) activeSecretInput = undefined;
      if (activeAuthPromptView === authPromptView) activeAuthPromptView = undefined;
      editorContainer.clear();
      editorContainer.addChild(editor);
      tui.setFocus(editor);
      requestTuiRender();
    }
    try {
      await options.auth.refreshModels?.(provider);
    } catch (error: unknown) {
      appendNotice(
        `Model catalog refresh failed for ${provider}: ${oneLine(error instanceof Error ? error.message : String(error))}. You can retry with --refresh-models.`,
        "warning",
      );
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
    if (!closing && openModels && options.session.snapshot().model === UNCONFIGURED_MODEL) {
      const hasModels = readModelOptions().some((option) => modelProviderOf(option.value) === provider);
      if (hasModels) showModelSelector("", provider);
      else appendNotice(`No models are available for ${provider} yet. Retry with --refresh-models.`, "warning");
    }
    return !closing;
  };

  const logoutInTui = async (argument: string): Promise<void> => {
    if (options.auth === undefined) {
      appendNotice(
        "Authentication is unavailable in this session. Use `nausicaa auth logout` instead.",
        "warning",
      );
      return;
    }
    let hadSavedCredential = false;
    let provider: string;
    try {
      const selected = argument.length === 0
        ? await selectLogoutProvider()
        : authProvider(argument, "logout");
      if (selected === undefined || closing) return;
      provider = selected;
      hadSavedCredential = await options.auth.credentialStore.read(provider) !== undefined;
      await runAuthCommand(
        { action: "logout", provider, json: false },
        {
          credentialStore: options.auth.credentialStore,
          modelPort: options.auth.modelPort,
          output: quietAuthOutput,
          ...(options.auth.environment === undefined ? {} : { environment: options.auth.environment }),
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
    // A provider-owned check can fail for transient/local reasons (for
    // example an unavailable credential helper). Do not turn an unknown state
    // into a false "missing credential" block; the request boundary remains
    // authoritative and will report its structured provider error.
    if (credential?.authCheckFailed === true) return undefined;
    if (credential?.credentialPartial === true) {
      const provider = credential.provider ?? "the selected provider";
      const requirement = providerCredentialHint(credential.provider);
      return requirement === undefined
        ? `Credentials for ${provider} are incomplete. Finish the provider setup before sending a task.`
        : `Credentials for ${provider} are incomplete or missing: ${requirement}. `
          + `Use /login ${provider} before sending a task.`;
    }
    if (credential?.credentialEnv !== undefined && !credential.credentialPresent) {
      const requirement = providerCredentialHint(credential.provider);
      return `Credential not detected: ${credential.credentialEnv}. `
        + (requirement === undefined
          ? "Restart after setting it; auth is not verified locally."
          : `${requirement}; auth is not verified locally.`);
    }
    if (credential?.authConfigured === false) {
      const provider = credential.provider ?? "the selected provider";
      if (providerSupportsAmbientCredentialChain(credential.provider)) return undefined;
      const requirement = providerCredentialHint(credential.provider);
      return requirement === undefined
        ? `Credentials for ${provider} are not configured. Use /login ${provider} `
          + "or set the provider's credential before sending a task."
        : `Credentials for ${provider} are incomplete or missing. ${requirement}. `
          + `Use /login ${provider} before sending a task.`;
    }
    return undefined;
  };

  const assertProviderReady = (): void => {
    const message = providerReadinessError();
    if (message !== undefined) throw new Error(message);
  };

  function disposeActiveSelector(): void {
    const selected = activeSelector;
    activeSelector = undefined;
    selected?.dispose?.();
  }

  function closeSelector(
    restorePreview: boolean,
    expectedComponent?: Component,
  ): void {
    const selected = activeSelector;
    if (selected === undefined) return;
    if (expectedComponent !== undefined && selected.component !== expectedComponent) return;
    disposeActiveSelector();
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
      editorContainer.clear();
      editorContainer.addChild(editor);
      tui.setFocus(editor);
      requestTuiRender();
    }
  }

  function mountSelector(
    component: Component & Focusable & { handleInput(data: string): void },
    restorePreview: () => void = () => {},
    dispose?: () => void,
  ): void {
    closeSelector(true);
    const token = {};
    const mountedSelector: {
      token: object;
      component: Component & Focusable & { handleInput(data: string): void };
      restorePreview: () => void;
      dispose?: () => void;
    } = {
      token,
      component,
      restorePreview,
    };
    if (dispose !== undefined) mountedSelector.dispose = dispose;
    activeSelector = mountedSelector;
    editorContainer.clear();
    editorContainer.addChild(component);
    tui.setFocus(component);
    requestTuiRender();
  }

  const showModelSelector = (initialQuery = "", initialProvider = "all"): void => {
    const current = options.session.snapshot().model;
    const modelOptions = readModelOptions();
    const providerNames = new Map(providerInfos().map((provider) => [provider.id, provider.name]));
    const providerIds = [...new Set(modelOptions.map((option) => modelProviderOf(option.value)))]
      .sort((left, right) => left.localeCompare(right));
    type AuthState = Awaited<ReturnType<AuthModelPort["checkAuth"]>> | null;
    const show = (authStates?: ReadonlyMap<string, AuthState>, query = initialQuery): void => {
      if (closing) return;
      const configured = (value: string): boolean => authStates === undefined
        || authStates.get(modelProviderOf(value)) != null;
      const candidates = modelOptions.map((option) => {
        if (authStates === undefined) return option;
        const auth = authStates.get(modelProviderOf(option.value));
        const status = auth === null ? "Auth status unavailable"
          : auth === undefined ? "Login required"
          : `Configured locally (${terminalSafeText(auth.source ?? auth.type)})`;
        return { ...option, description: [status, option.description].filter(Boolean).join(" · ") };
      }).sort((left, right) => Number(configured(right.value)) - Number(configured(left.value)));
      const selector = new SelectorOverlay({
        title: "Models",
        searchLabel: "Search models",
        subtitle: (visible) => `${visible.length} model${visible.length === 1 ? "" : "s"}${authStates === undefined ? "" : " · account access unverified"}`,
        filters: [
          ...(authStates === undefined ? [] : [{
            key: "scope",
            label: "Scope",
            options: [{ value: "configured", label: "Configured" }, { value: "all", label: "All" }],
            current: "configured",
          }]),
          ...(providerIds.length <= 1 ? [] : [{
            key: "provider",
            label: "Provider",
            options: [
              { value: "all", label: "All" },
              ...providerIds.map((provider) => ({
                value: provider,
                label: provider === "default" ? "Local" : providerNames.get(provider) ?? provider,
              })),
            ],
            current: initialProvider,
          }]),
        ],
        filterOptions: (items, values) => items.filter((item) => (
          (values.scope === "all" || configured(item.value))
          && ((values.provider ?? initialProvider) === "all"
            || modelProviderOf(item.value) === (values.provider ?? initialProvider))
        )),
        options: candidates,
        ...(current === UNCONFIGURED_MODEL ? {} : { current }),
        initialQuery: query,
        onSelect: (value) => {
          closeSelector(false, selector);
          void applyModelSelection(value);
        },
        onCancel: () => closeSelector(true, selector),
      });
      mountSelector(selector);
    };
    if (options.auth === undefined) {
      show();
      return;
    }
    const authModel = options.auth.modelPort;
    const loading = new SelectorOverlay({
      title: "Models",
      searchLabel: "Checking local credentials...",
      options: [],
      initialQuery,
      onSelect: () => {},
      onCancel: () => closeSelector(true, loading),
    });
    mountSelector(loading);
    // Auth discovery must not hold the submission queue or reopen a dismissed picker.
    void Promise.all(providerIds.map(async (provider): Promise<[string, AuthState]> => {
      try {
        return [provider, await authModel.checkAuth(provider)];
      } catch {
        return [provider, null];
      }
    })).then((states) => {
      if (closing || activeSelector?.component !== loading) return;
      show(new Map(states), loading.getSearchInput().getValue());
    }).catch(() => {
      if (closing || activeSelector?.component !== loading) return;
      closeSelector(true, loading);
      appendNotice("Model authentication status could not be loaded. Retry /model.", "warning");
    });
  };

  const applyModelSelection = async (value: string): Promise<void> => {
    try {
      if (value === UNCONFIGURED_MODEL) {
        throw new Error("Choose a model from the local catalog before sending a task");
      }
      if (options.auth !== undefined) {
        const provider = modelProviderOf(value);
        if (await options.auth.modelPort.checkAuth(provider) === undefined) {
          if (closing) return;
          appendNotice(`Connect ${provider} to select ${value}.`, "info");
          if (!await loginInTui(provider, false)) return;
          if (await options.auth.modelPort.checkAuth(provider) === undefined) {
            throw new Error(`Credentials for ${provider} are still incomplete. Use /login ${provider}.`);
          }
        }
      }
      if (closing) return;
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
      try {
        await options.auth?.onChanged?.();
      } catch {
        // Model selection is already durable; an auth status refresh is advisory.
      }
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
      // An explicit operator choice is equivalent to approving the wider
      // boundary. Downgrades revoke that session-scoped approval.
      permissionApprovalGranted = profile === "full-access";
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
        closeSelector(false, selector);
        void applyPermissionProfile(value);
      },
      onCancel: () => closeSelector(true, selector),
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
        closeSelector(false, selector);
        void applyCollaborationMode(value);
      },
      onCancel: () => closeSelector(true, selector),
    });
    mountSelector(selector);
  };

  const applyThemeChoice = (choice: ThemeChoice): void => {
    themePreference = choice;
    // `auto` follows the last detected terminal scheme; explicit choices take
    // effect immediately and remain stable across terminal notifications.
    setNausicaaColorScheme(choice === "auto" ? detectedColorScheme : choice);
    requestTuiRender(true);
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
        requestTuiRender(true);
      },
      onSelect: (value) => {
        const choice = parseThemeChoice(value);
        closeSelector(false, selector);
        applyThemeChoice(choice);
      },
      onCancel: () => closeSelector(true, selector),
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
    clearPendingBashContext();
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
    clearPendingBashContext();
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
        closeSelector(false, selector);
        const selection = selectionByValue.get(value);
        if (selection === undefined) return;
        void navigateWorkspaceTreeSelection(selection).catch((error: unknown) => {
          appendNotice(error instanceof Error ? error.message : String(error), "error");
        });
      },
      onCancel: () => closeSelector(true, selector),
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
    clearPendingBashContext();
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
        closeSelector(false, selector);
        void switchSession(value).catch((error: unknown) => {
          appendNotice(error instanceof Error ? error.message : String(error), "error");
        });
      },
      onCancel: () => closeSelector(true, selector),
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
    requestTuiRender(true);
    const refreshed = await pending;
    if (refreshed.stale) {
      appendNotice(
        `Edge refresh was cancelled or failed; showing stale generation ${before.generation}.`,
        "warning",
      );
    } else if (
      refreshed.diagnostics.length > 0
      || refreshed.sources.some((source) => (
        source.health === "degraded"
        || source.health === "failed"
        || source.health === "unavailable"
      ))
    ) {
      // The registry may publish a partial generation while isolating one
      // source failure. Do not report that as an unqualified success; keep
      // the notice short and point users to `/edges` for the bounded details.
      appendNotice(
        `Edges refreshed at generation ${refreshed.generation} with diagnostics; inspect /edges.`,
        "warning",
      );
    } else {
      appendNotice(`Edges refreshed at generation ${refreshed.generation}.`, "success");
    }
    requestTuiRender(true);
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
      requestTuiRender(true);
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
        closeSelector(false, selector);
        void applySkillSelection(values);
      },
      onCancel: () => closeSelector(true, selector),
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
        case "/list-agents":
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
          const match = readModelOptions().find((option) => option.value.toLowerCase() === argument.toLowerCase());
          if (match !== undefined) await applyModelSelection(match.value);
          else if (argument.includes(":") && !/\s/u.test(argument)) {
            await applyModelSelection(normalizeModelSelector(argument));
          } else showModelSelector(argument);
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
          clearPendingBashContext();
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
    if (value.startsWith("!!")) {
      addPromptToHistory(value);
      await runInteractiveBash(value, false);
      return;
    }
    if (value.startsWith("!")) {
      addPromptToHistory(value);
      await runInteractiveBash(value, true);
      return;
    }
    const readinessError = providerReadinessError();
    if (readinessError !== undefined) {
      editor.setText(value);
      appendNotice(readinessError, "warning");
      return;
    }
    const inputId = createInputId();
    const shellContext = pendingBashContext.length === 0
      ? undefined
      : pendingBashContext.join("\n\n");
    const promptText = shellContext === undefined
      ? value
      : `${shellContext}\n\nUser request:\n${value}`;
    try {
      await options.session.submit({
        inputId,
        text: promptText,
        ...(submission.images === undefined
          ? {}
          : { images: structuredClone(submission.images) }),
        delivery: submission.delivery,
      });
      clearPendingBashContext();
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
    const isBashCommand = value.startsWith("!");
    if (!value.startsWith("/") && !isBashCommand && options.session.snapshot().model === UNCONFIGURED_MODEL) {
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
  editor.onPasteImage = queueClipboardImagePaste;
  editor.onCtrlD = () => { void finish(0); };
  editor.onEscape = () => {
    if (activeBashAbortController !== undefined) {
      activeBashAbortController.abort(new Error("Cancelled by user"));
      return;
    }
    if (options.edgeSelection?.snapshot().refreshing === true) {
      options.edgeSelection.cancelRefresh();
      appendNotice("Cancelling edge refresh; the previous snapshot remains available.", "warning");
      return;
    }
    if (
      options.session.snapshot().status === "running"
      || options.session.snapshot().status === "cancelling"
    ) {
      clearInterruptExit();
      void options.session.cancel();
    } else if (editor.getText().length > 0) {
      // Pi leaves a non-empty draft untouched on Escape. This also lets the
      // caller press Enter immediately after dismissing autocomplete.
      clearInterruptExit();
    } else if (interruptExitUntil > Date.now()) {
      void finish(130);
    } else {
      armInterruptExit();
    }
  };
  tui.addInputListener((data) => {
    if (activeSecretInput !== undefined) {
      if (matchesKey(data, "ctrl+c") || data === "\x1b") {
        activeSecretInput.cancel();
      } else {
        activeSecretInput.push(data);
      }
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
      if (activeBashAbortController !== undefined) {
        activeBashAbortController.abort(new Error("Cancelled by user"));
        return { consume: true };
      }
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
    if (matchesKey(data, "ctrl+p")) {
      agentMessagesExpanded = !agentMessagesExpanded;
      for (const block of agentMessageBlocks.values()) {
        block.setExpanded(agentMessagesExpanded);
      }
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
  // Pi mounts its expandable startup header after the renderer has produced
  // the first empty composer frame. Keeping that ordering matters in regular
  // mode: the introduction becomes scrollback content instead of a permanent
  // banner that pushes the composer down from the moment the process starts.
  headerContainer.addChild(new Spacer(1));
  headerContainer.addChild(header);
  headerContainer.addChild(new Spacer(1));
  requestTuiRender();
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
  append: (component: ToolStatusBlock, spaceBefore?: boolean) => unknown,
): void {
  const existing = blocks.get(operationId);
  if (existing !== undefined) {
    existing.setStatus(status, detail);
    return;
  }
  const block = new ToolStatusBlock(name, status, detail);
  selectLatestToolExpandHint([...blocks.values()], block);
  blocks.set(operationId, block);
  append(block, false);
}

function assistantKey(turnId: string | undefined, content: string): string {
  return `${turnId ?? "legacy"}:${content}`;
}

function credentialStatusSummary(status: CredentialStatus): string {
  if (status.provider === undefined) return "no provider selected";
  if (status.authCheckFailed === true) return "local auth check unavailable";
  if (status.credentialSource === "saved") return "saved credential (unverified)";
  if (status.credentialPartial === true) {
    const requirement = providerCredentialHint(status.provider);
    return requirement === undefined ? "partial environment (unverified)" : `incomplete (${requirement})`;
  }
  if (status.authConfigured === true) {
    return `${status.authSource ?? "provider credential"} (unverified)`;
  }
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

const MAX_A2A_NOTICE_CHARS = 160;
const MAX_A2A_SOURCE_CHARS = 24;

/** Keep cross-Run messages visible without allowing remote text to grow the transcript. */
function formatA2AMessageNotice(message: A2AMessage): string | undefined {
  const source = a2aSourceLabel(message);
  switch (message.payload.type) {
    case "message.inform":
      return oneLine(
        terminalSafeText(`Agent message from ${source}: ${message.payload.text}`),
        MAX_A2A_NOTICE_CHARS,
      );
    case "question.ask":
      return oneLine(
        terminalSafeText(`Question from ${source}: ${message.payload.question}`),
        MAX_A2A_NOTICE_CHARS,
      );
    case "question.answer":
      return oneLine(
        terminalSafeText(`Answer from ${source}: ${message.payload.answer}`),
        MAX_A2A_NOTICE_CHARS,
      );
    case "task.request":
      return oneLine(
        terminalSafeText(`Task request from ${source}: ${message.payload.goal.statement}`),
        MAX_A2A_NOTICE_CHARS,
      );
    case "advice.propose":
      return oneLine(
        terminalSafeText(`Advice from ${source}: ${message.payload.advice.claim}`),
        MAX_A2A_NOTICE_CHARS,
      );
    default:
      return undefined;
  }
}

function a2aSourceLabel(message: A2AMessage): string {
  const source = message.sourceEndpoint?.runId ?? message.from;
  const label = oneLine(terminalSafeText(source), MAX_A2A_SOURCE_CHARS);
  return label.length > 0 ? label : "unknown";
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

function autocompletePriority(name: string): number {
  if (name === "help") return 0;
  if (name === "list-agents") return 1;
  return 2;
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

function normalizeAuthType(value: string): AuthType {
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized === "oauth") return "oauth";
  if (normalized === "api-key" || normalized === "api_key") return "api_key";
  throw new Error("/login method must be api-key or oauth");
}

function normalizeAuthProviderId(value: string): string {
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized.length === 0 || !/^[a-z0-9][a-z0-9._-]*$/u.test(normalized)) {
    throw new Error("/login provider must contain only letters, numbers, dots, underscores, or hyphens");
  }
  return normalized;
}

function modelProviderOf(selector: string): string {
  const separator = selector.indexOf(":");
  return separator > 0 ? selector.slice(0, separator) : "default";
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
