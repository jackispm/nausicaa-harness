import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { A2AInbox } from "../a2a/index.js";
import type {
  AnyEvent,
  AppendEvent,
  EventEnvelope,
  EventType,
  InputDelivery,
  TurnExecutionBoundary,
} from "../domain/events.js";
import type { AgentTool, Clock, ModelPort } from "../domain/ports.js";
import { systemClock } from "../domain/ports.js";
import {
  type UserImage,
  validateUserImages,
} from "../domain/images.js";
import type {
  ArtifactRef,
  ConversationMessage,
  FukaiCompactionPolicy,
  Goal,
  LaneStatus,
  RunPolicy,
  TokenUsage,
} from "../domain/types.js";
import {
  DEFAULT_MAIN_OUTPUT_TOKENS,
  MAX_MAIN_OUTPUT_TOKENS,
  mainStepAllowance,
} from "../domain/types.js";
import {
  ContentStoreFukaiSource,
  FukaiContextProvider,
} from "../fukai/index.js";
import {
  JsonlLedger,
  type Ledger,
  projectRun,
  projectTaskGraph,
  validateEvent,
} from "../ledger/index.js";
import {
  createOpenRouterModelPort,
  normalizeModelSelector,
} from "../model/index.js";
import {
  FileContentAddressedStore,
  type ContentAddressedStore,
} from "../store/index.js";
import { IntentNavigator, ObservationFrameBuilder } from "../teto/index.js";
import {
  createWorkspaceTools,
  FileProcessJobRegistry,
  ProcessJobManager,
  WorkspaceCommandSandbox,
  type WorkspaceSandboxAvailability,
  type WebFetchProvider,
  type WebSearchProvider,
} from "../tools/index.js";
import { createAdviceResponseTool } from "./advice-tool.js";
import {
  MainLoop,
  MainRunTokenBudgetExhaustedError,
  type MainBoundaryMessage,
  type MainLoopDeps,
  type MainStreamEvent,
} from "./main-loop.js";
import {
  commitRunCheckpoint,
  projectMainExecutionRecovery,
  resolvePendingToolOperation,
} from "./recovery.js";
import { persistedErrorText } from "./redaction.js";
import {
  normalizeFukaiCompactionPolicy,
  resolveRunPolicy,
} from "./run-policy.js";
import {
  createRuntimeFukaiCompaction,
  deriveRuntimePolicyVersion,
  instantiateRuntimeFukaiCompaction,
  prepareRuntimeFukaiCompaction,
  runtimeFukaiCompactionBudget,
  type RuntimeFukaiCompactionFactory,
} from "./fukai-compaction-runtime.js";
import { RunTokenBudget } from "./run-token-budget.js";
import {
  recoverRunTokenUsage,
  recoverRunTokenUsageByLane,
  type RecoveredLaneUsage,
} from "./run-token-budget-recovery.js";
import { TetoScheduler } from "./teto-scheduler.js";
import { createDelegateTaskTool } from "./delegate-task-tool.js";
import { TaskDispatcher } from "./task-dispatcher.js";
import {
  projectCommittedBoundaryMessageIds,
  WorkerLaneScheduler,
} from "./worker-lane-scheduler.js";
import { WorkerTaskExecutor } from "./worker-task-executor.js";
import { shouldAdvertiseImageTools } from "./model-capabilities.js";
import {
  MESSAGE_MEDIA_TYPE,
  projectPendingAdmissions,
  projectPendingInputs,
  projectSessionTranscript,
  type ProjectedPendingAdmission,
  readConversationArtifact,
  readToolArgumentsFromStore,
  readUserMessage,
  readUserText,
  type SessionPendingInput,
  type SessionTranscriptEntry,
} from "./session-artifacts.js";
import { SessionProtocolError } from "./session-protocol-error.js";

export {
  SessionProtocolError,
} from "./session-protocol-error.js";
export type {
  SessionPendingInput,
  SessionTranscriptEntry,
} from "./session-artifacts.js";
const DEFAULT_INTERACTIVE_GOAL = "Assist the user with tasks in the current workspace";
const MAX_PENDING_INPUTS = 8;
const CLOSE_GRACE_MS = 2_000;

export type SessionControllerStatus =
  | "detached"
  | "idle"
  | "running"
  | "cancelling"
  | "closed";

export type SessionRuntimeEvent =
  | { kind: "event"; event: AnyEvent }
  | { kind: "stream"; event: MainStreamEvent }
  | { kind: "state"; snapshot: SessionSnapshot };

export interface SessionModelCapabilities {
  imageInput: "supported" | "unsupported" | "unknown";
}

export interface SessionModelSelectionResult {
  model: string;
  previousModel: string;
  changed: boolean;
  /** Any request already handed to the provider retains previousModel. */
  activeRequestUnaffected: boolean;
}

export type SessionPermissionProfile =
  | "read-only"
  | "workspace"
  | "full-access"
  | "custom";

export type SelectableSessionPermissionProfile = Exclude<
  SessionPermissionProfile,
  "custom"
>;

export type SessionCollaborationMode = "default" | "plan";

export interface SessionPermissionSelectionResult {
  profile: SelectableSessionPermissionProfile;
  previousProfile: SessionPermissionProfile;
  changed: boolean;
  /** An active Main loop keeps the catalog captured at its Turn boundary. */
  activeTurnUnaffected: boolean;
}

export interface SessionCollaborationModeSelectionResult {
  mode: SessionCollaborationMode;
  previousMode: SessionCollaborationMode;
  changed: boolean;
  /** An active Main loop keeps the mode captured at its Turn boundary. */
  activeTurnUnaffected: boolean;
}

export interface SessionSnapshot {
  workspace: string;
  runId?: string;
  turnId?: string;
  goal?: Goal;
  status: SessionControllerStatus;
  model: string;
  tetoEnabled: boolean;
  workerEnabled: boolean;
  permissionProfile: SessionPermissionProfile;
  collaborationMode: SessionCollaborationMode;
  allowWrite: boolean;
  allowShell: boolean;
  allowNetwork: boolean;
  /** Actual OS confinement capability behind the workspace permission profile. */
  workspaceBashAvailability: WorkspaceSandboxAvailability;
  pendingInputs: number;
  lastCommittedStep: number;
  /** Latest durable Fukai input estimate for the selected Main model, or null before its next request. */
  mainContextTokens: number | null;
  /** Selected Main model's advertised context window, or null when unknown. */
  mainContextWindowTokens: number | null;
  /** Cumulative provider usage for the Run; shown in detailed status, not the context tray. */
  usage: TokenUsage;
  blocker?: string;
}

/** Read-only accounting projection used by local context/status surfaces. */
export interface SessionContextOverview {
  model: string;
  currentContext: {
    tokens: number | null;
    contextWindowTokens: number | null;
    percent: number | null;
  };
  /** Cumulative billable usage across every lane in the attached Run. */
  usage: TokenUsage;
  /** Per-lane own usage; rows sum to usage without parent/child duplication. */
  lanes: RecoveredLaneUsage[];
}

export type WorkspaceRunStatus =
  | "ready"
  | "active"
  | "waiting"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled";

/** Read-only metadata used by resume selectors and startup discovery. */
export interface WorkspaceRunSummary {
  runId: string;
  goal: string;
  status: WorkspaceRunStatus;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerTaskSummary {
  total: number;
  queued: number;
  running: number;
  ready: number;
  done: number;
  failed: number;
  stale: number;
}

export interface SessionSubmitRequest {
  inputId: string;
  text: string;
  images?: UserImage[];
  delivery?: InputDelivery;
}

export interface SessionSubmitResult {
  inputId: string;
  turnId?: string;
  status: "admitted" | "duplicate";
  delivery: InputDelivery;
}

export interface SessionPendingInputReplacement {
  text: string;
  delivery: "steering" | "follow-up";
  /** Omit to preserve current images; pass [] to clear them. */
  images?: UserImage[];
}

export type SessionPendingInputMutationResult = "applied" | "stale";

export interface SessionControllerOptions {
  workspace: string;
  dataDir: string;
  model: string;
  tetoModel?: string;
  workerModel?: string;
  /** Opt-in bounded Worker lane; omitted or false preserves Main-only behavior. */
  workerEnabled?: boolean;
  /** Explicit Fukai capability settings; omitted keeps the legacy disabled path. */
  fukaiCompaction?: FukaiCompactionPolicy;
  policy?: Partial<RunPolicy>;
  maxOutputTokens?: number;
  allowWrite?: boolean;
  allowShell?: boolean;
  /** Explicitly enable network-backed workspace tools for Main. */
  allowNetwork?: boolean;
  /** Initial collaboration behavior; interactive users may change it later. */
  collaborationMode?: SessionCollaborationMode;
  /** Optional root directory for per-Run durable process-job metadata. */
  processJobRegistryDir?: string;
  runId?: string;
}

export interface SessionControllerDeps {
  mainModel?: ModelPort;
  tetoModel?: ModelPort;
  workerModel?: ModelPort;
  tools?: readonly AgentTool[];
  /** Optional bounded read-only tools for Worker; defaults to the workspace set. */
  workerTools?: readonly AgentTool[];
  /** Optional provider seams for network-backed Main tools. */
  webFetchProvider?: WebFetchProvider;
  webSearchProvider?: WebSearchProvider;
  /** Test/embedding seam for the default workspace-confined foreground Bash. */
  workspaceCommandSandbox?: WorkspaceCommandSandbox;
  /** Host/TUI approval boundary for Main tools that explicitly require approval. */
  approveTool?: MainLoopDeps["approve"];
  /** Test/plugin seam for the opt-in activation-scoped compaction adapter. */
  createCompactionRuntime?: RuntimeFukaiCompactionFactory;
  /**
   * Optional durable-write guard. Daemon activations use this to re-check
   * their execution lease before appending a fact; ordinary sessions omit it.
   */
  assertExecutionLease?: () => void | Promise<void>;
  /** Atomically serialize one Ledger commit with execution-lease takeover. */
  commitExecutionLease?: <T>(operation: () => Promise<T>) => Promise<T>;
  clock?: Clock;
  createRunId?: () => string;
}

interface AttachedRun {
  runId: string;
  ledger: Ledger;
  sink: SessionEventSink;
  store: ContentAddressedStore;
  goal: Goal;
  policy: RunPolicy;
  tokenBudget: RunTokenBudget;
  mainModel: string;
  processJobs?: ProcessJobManager;
  worker?: WorkerLaneRuntime;
}

interface WorkerLaneRuntime {
  inbox: A2AInbox;
  dispatcher: TaskDispatcher;
  scheduler: WorkerLaneScheduler;
}

interface Admission {
  event: Extract<AnyEvent, { type: "input.admitted" }> | ProjectedPendingAdmission;
}

interface ActiveTurn {
  turnId: string;
  inputId: string;
  controller: AbortController;
}

export class SessionController {
  readonly workspace: string;
  readonly dataDir: string;
  readonly tetoModel: string;
  readonly workerModel: string;
  readonly maxOutputTokens: number;
  readonly processJobRegistryDir: string | undefined;

  private readonly deps: SessionControllerDeps;
  private readonly clock: Clock;
  private readonly policy: RunPolicy;
  private readonly requestedWorkerEnabled: boolean | undefined;
  private readonly workspaceCommandSandbox: WorkspaceCommandSandbox;
  private selectedMainModel: string;
  private writeAllowed: boolean;
  private shellAllowed: boolean;
  private networkAllowed: boolean;
  private selectedCollaborationMode: SessionCollaborationMode;
  private readonly listeners = new Set<(event: SessionRuntimeEvent) => void>();
  private readonly contextWindowByModel = new Map<string, number | null>();
  private workerTaskSummaryCache: {
    runId: string;
    lastOffset: number;
    summary: WorkerTaskSummary;
  } | undefined;
  private attached: AttachedRun | undefined;
  private active: ActiveTurn | undefined;
  private status: SessionControllerStatus = "detached";
  private admissionTail: Promise<void> = Promise.resolve();
  /** Serializes pending-input transitions with delivery/promotion boundaries. */
  private pendingInputTransitionTail: Promise<void> = Promise.resolve();
  private execution: Promise<void> | undefined;
  private closing = false;
  private closePromise: Promise<void> | undefined;

  private constructor(
    workspace: string,
    dataDir: string,
    options: SessionControllerOptions,
    deps: SessionControllerDeps,
  ) {
    this.workspace = workspace;
    this.dataDir = dataDir;
    this.selectedMainModel = normalizeModelSelector(options.model);
    this.tetoModel = normalizeModelSelector(options.tetoModel ?? options.model);
    this.workerModel = normalizeModelSelector(options.workerModel ?? options.model);
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAIN_OUTPUT_TOKENS;
    this.writeAllowed = options.allowWrite === true;
    this.shellAllowed = options.allowShell === true;
    this.networkAllowed = options.allowNetwork === true;
    this.selectedCollaborationMode = options.collaborationMode ?? "default";
    this.processJobRegistryDir = options.processJobRegistryDir === undefined
      ? undefined
      : resolve(options.processJobRegistryDir);
    this.deps = deps;
    this.workspaceCommandSandbox = deps.workspaceCommandSandbox
      ?? new WorkspaceCommandSandbox({ protectedPaths: [dataDir] });
    this.clock = deps.clock ?? systemClock;
    this.requestedWorkerEnabled = options.workerEnabled ?? options.policy?.workerEnabled;
    this.policy = resolveRunPolicy({
      ...options.policy,
      ...(options.fukaiCompaction === undefined
        ? {}
        : { fukaiCompaction: options.fukaiCompaction }),
      ...(options.workerEnabled === undefined
        ? {}
        : { workerEnabled: options.workerEnabled }),
    });
  }

  static async open(
    options: SessionControllerOptions,
    deps: SessionControllerDeps = {},
  ): Promise<SessionController> {
    validateOptions(options);
    const workspace = await realpath(resolve(options.workspace));
    const dataDir = resolve(options.dataDir);
    const controller = new SessionController(workspace, dataDir, options, deps);
    if (options.runId !== undefined) {
      await controller.attachRun(options.runId);
    }
    return controller;
  }

  subscribe(listener: (event: SessionRuntimeEvent) => void): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get model(): string {
    return this.selectedMainModel;
  }

  get allowWrite(): boolean {
    return this.writeAllowed;
  }

  get allowShell(): boolean {
    return this.shellAllowed;
  }

  get allowNetwork(): boolean {
    return this.networkAllowed;
  }

  get permissionProfile(): SessionPermissionProfile {
    return permissionProfileForCapabilities({
      allowWrite: this.writeAllowed,
      allowShell: this.shellAllowed,
      allowNetwork: this.networkAllowed,
    });
  }

  get collaborationMode(): SessionCollaborationMode {
    return this.selectedCollaborationMode;
  }

  modelCapabilities(): SessionModelCapabilities {
    this.assertOpen();
    try {
      const capabilities = (
        this.deps.mainModel ?? createOpenRouterModelPort()
      ).capabilities?.(this.model);
      if (capabilities === undefined) return { imageInput: "unknown" };
      return {
        imageInput: capabilities.imageInput ? "supported" : "unsupported",
      };
    } catch {
      // Capability discovery is advisory. The model boundary still reports
      // selector and provider errors when a request is actually attempted.
      return { imageInput: "unknown" };
    }
  }

  /**
   * Select Main's model for this Session and attached Run. The selector is
   * durable before it becomes observable; an already-issued provider request
   * is never rewritten and the next request reads the new value.
   */
  async selectModel(value: string): Promise<SessionModelSelectionResult> {
    return this.runAdmission(async () => {
      this.assertOpen();
      let model: string;
      try {
        model = normalizeModelSelector(value);
      } catch (error: unknown) {
        throw new SessionProtocolError(
          error instanceof Error ? error.message : "Invalid model selector",
        );
      }
      const previousModel = this.selectedMainModel;
      const activeRequestUnaffected = this.active !== undefined;
      if (model === previousModel) {
        return {
          model,
          previousModel,
          changed: false,
          activeRequestUnaffected,
        };
      }

      const attached = this.attached;
      if (attached !== undefined) {
        const revision = attached.sink.cachedEvents.filter((event) => (
          event.type === "model.selected" && event.laneId === "main"
        )).length + 1;
        await attached.sink.append({
          runId: attached.runId,
          laneId: "main",
          type: "model.selected",
          payload: { model },
          correlationId: `run:${attached.runId}`,
          idempotencyKey: `${attached.runId}:main:model:selected:${revision}`,
          visibility: "run",
          occurredAt: this.clock.now().toISOString(),
        });
        attached.mainModel = model;
      }
      this.selectedMainModel = model;
      this.publishState();
      return {
        model,
        previousModel,
        changed: true,
        activeRequestUnaffected,
      };
    });
  }

  /** Change which first-party capabilities Main receives on its next Turn. */
  async selectPermissionProfile(
    profile: SelectableSessionPermissionProfile,
  ): Promise<SessionPermissionSelectionResult> {
    return this.runAdmission(async () => {
      this.assertOpen();
      const normalized = normalizePermissionProfile(profile);
      const previousProfile = this.permissionProfile;
      const activeTurnUnaffected = this.active !== undefined;
      const next = capabilitiesForPermissionProfile(normalized);
      const changed = this.writeAllowed !== next.allowWrite
        || this.shellAllowed !== next.allowShell
        || this.networkAllowed !== next.allowNetwork;
      if (!changed) {
        return {
          profile: normalized,
          previousProfile,
          changed: false,
          activeTurnUnaffected,
        };
      }
      this.writeAllowed = next.allowWrite;
      this.shellAllowed = next.allowShell;
      this.networkAllowed = next.allowNetwork;
      this.publishState();
      return {
        profile: normalized,
        previousProfile,
        changed: true,
        activeTurnUnaffected,
      };
    });
  }

  /** Select Default or Plan behavior for the next Turn boundary. */
  async selectCollaborationMode(
    mode: SessionCollaborationMode,
  ): Promise<SessionCollaborationModeSelectionResult> {
    return this.runAdmission(async () => {
      this.assertOpen();
      const normalized = normalizeCollaborationMode(mode);
      const previousMode = this.selectedCollaborationMode;
      const activeTurnUnaffected = this.active !== undefined;
      if (normalized === previousMode) {
        return {
          mode: normalized,
          previousMode,
          changed: false,
          activeTurnUnaffected,
        };
      }
      this.selectedCollaborationMode = normalized;
      this.publishState();
      return {
        mode: normalized,
        previousMode,
        changed: true,
        activeTurnUnaffected,
      };
    });
  }

  snapshot(): SessionSnapshot {
    const events = this.attached?.sink.cachedEvents ?? [];
    const usage = this.attached === undefined
      ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      : recoverRunTokenUsage(events, this.attached.runId);
    const pending = projectPendingAdmissions(events);
    const blocker = blockingReason(events);
    return {
      workspace: this.workspace,
      ...(this.attached === undefined ? {} : { runId: this.attached.runId }),
      ...(this.active === undefined ? {} : { turnId: this.active.turnId }),
      ...(this.attached === undefined ? {} : { goal: structuredClone(this.attached.goal) }),
      status: this.status,
      model: this.model,
      tetoEnabled: this.attached?.policy.tetoEnabled ?? this.policy.tetoEnabled,
      workerEnabled: this.attached?.policy.workerEnabled === true
        || (this.attached === undefined && this.policy.workerEnabled === true),
      permissionProfile: this.permissionProfile,
      collaborationMode: this.collaborationMode,
      allowWrite: this.allowWrite,
      allowShell: this.allowShell,
      allowNetwork: this.allowNetwork,
      workspaceBashAvailability: structuredClone(
        this.workspaceCommandSandbox.availability(),
      ),
      pendingInputs: pending.length,
      lastCommittedStep: this.active === undefined
        ? 0
        : highestTurnStep(events, this.active.turnId),
      mainContextTokens: latestMainContextTokens(events, this.model),
      mainContextWindowTokens: this.selectedModelContextWindowTokens() ?? null,
      usage,
      ...(blocker === undefined ? {} : { blocker }),
    };
  }

  /** Project current context capacity separately from cumulative Run spend. */
  contextOverview(): SessionContextOverview {
    this.assertOpen();
    const snapshot = this.snapshot();
    const events = this.attached?.sink.cachedEvents ?? [];
    const recovered = this.attached === undefined
      ? []
      : recoverRunTokenUsageByLane(events, this.attached.runId);
    const lanes = ensureVisibleLanes(
      recovered,
      snapshot.tetoEnabled,
      snapshot.workerEnabled,
    );
    const tokens = snapshot.mainContextTokens;
    const contextWindowTokens = snapshot.mainContextWindowTokens;
    return {
      model: snapshot.model,
      currentContext: {
        tokens,
        contextWindowTokens,
        percent: tokens === null || contextWindowTokens === null
          ? null
          : (tokens / contextWindowTokens) * 100,
      },
      usage: structuredClone(snapshot.usage),
      lanes,
    };
  }

  private selectedModelContextWindowTokens(): number | undefined {
    const cached = this.contextWindowByModel.get(this.model);
    if (cached !== undefined) return cached ?? undefined;
    try {
      const value = (
        this.deps.mainModel ?? createOpenRouterModelPort()
      ).capabilities?.(this.model)?.contextWindowTokens;
      const normalized = Number.isSafeInteger(value) && (value ?? 0) > 0
        ? value
        : undefined;
      this.contextWindowByModel.set(this.model, normalized ?? null);
      return normalized;
    } catch {
      // Context capacity is advisory; unknown custom models keep working.
      this.contextWindowByModel.set(this.model, null);
      return undefined;
    }
  }

  /** Project the durable Worker lifecycle without giving the TUI its own task state. */
  workerTaskSummary(): WorkerTaskSummary {
    const attached = this.attached;
    if (attached === undefined) return emptyWorkerTaskSummary();
    const lastOffset = attached.sink.cachedLastOffset;
    if (
      this.workerTaskSummaryCache?.runId === attached.runId
      && this.workerTaskSummaryCache.lastOffset === lastOffset
    ) {
      return { ...this.workerTaskSummaryCache.summary };
    }

    const summary = emptyWorkerTaskSummary();
    const tasks = projectTaskGraph(attached.sink.cachedEvents, attached.runId).tasks;
    summary.total = tasks.length;
    for (const task of tasks) {
      const terminal = task.state.kind === "delegated"
        ? undefined
        : task.state.terminal;
      if (task.state.kind === "stale") {
        summary.stale += 1;
      } else if (terminal?.type === "task.failed") {
        summary.failed += 1;
      } else if (task.state.kind === "joined") {
        summary.done += 1;
      } else if (task.state.kind === "terminal") {
        summary.ready += 1;
      } else if (task.accept === undefined) {
        summary.queued += 1;
      } else {
        summary.running += 1;
      }
    }
    this.workerTaskSummaryCache = {
      runId: attached.runId,
      lastOffset,
      summary: { ...summary },
    };
    return { ...summary };
  }

  async transcript(): Promise<SessionTranscriptEntry[]> {
    this.assertOpen();
    const attached = this.requireAttached();
    const events = await attached.ledger.read({ runId: attached.runId });
    return projectSessionTranscript(attached.store, events, attached.runId);
  }

  /** Return admitted inputs which have not reached a Main boundary yet. */
  async pendingInputs(): Promise<SessionPendingInput[]> {
    this.assertOpen();
    if (this.attached === undefined) {
      return [];
    }
    const attached = this.attached;
    const events = await attached.ledger.read({ runId: attached.runId });
    return projectPendingInputs(attached.store, events);
  }

  /** Replace one still-pending input using an append-only compare-and-swap event. */
  async replacePendingInput(
    inputId: string,
    expectedRevision: number,
    replacement: SessionPendingInputReplacement,
  ): Promise<SessionPendingInputMutationResult> {
    return this.runAdmission(() => this.runPendingInputTransition(async () => {
      this.assertOpen();
      validatePendingMutationIdentity(inputId, expectedRevision);
      validatePendingReplacementShape(replacement);
      if (this.attached === undefined) return "stale";

      const attached = this.attached;
      let events = await attached.ledger.read({ runId: attached.runId });
      attached.sink.replaceCache(events);
      let current = findPendingInput(events, inputId);
      if (current === undefined || current.payload.revision !== expectedRevision) {
        return "stale";
      }
      const expectedMessageRef = structuredClone(current.payload.messageRef);
      const previous = await readUserMessage(attached.store, expectedMessageRef);
      const images = replacement.images === undefined
        ? previous.images
        : replacement.images;
      validateSubmit({
        inputId,
        text: replacement.text,
        ...(images === undefined ? {} : { images }),
      });

      const targetTurnId = replacement.delivery === "steering"
        ? this.active?.turnId
        : undefined;
      if (replacement.delivery === "steering" && targetTurnId === undefined) {
        throw new SessionProtocolError("Steering replacement requires an active Turn");
      }
      const messageRef = await attached.store.put(stableJson({
        role: "user",
        content: replacement.text,
        ...(images === undefined ? {} : { images: structuredClone(images) }),
        createdAt: this.clock.now().toISOString(),
      } satisfies ConversationMessage), MESSAGE_MEDIA_TYPE);

      // Artifact IO can yield to Main's delivery boundary. Re-check before the
      // authoritative Ledger CAS so a normal race is reported as stale.
      events = await attached.ledger.read({ runId: attached.runId });
      attached.sink.replaceCache(events);
      current = findPendingInput(events, inputId);
      if (
        current === undefined
        || current.payload.revision !== expectedRevision
        || !sameArtifactRef(current.payload.messageRef, expectedMessageRef)
        || (replacement.delivery === "steering" && this.active?.turnId !== targetTurnId)
      ) {
        return "stale";
      }

      try {
        await attached.sink.append({
          runId: attached.runId,
          ...(targetTurnId === undefined ? {} : { turnId: targetTurnId }),
          laneId: "main",
          type: "input.replaced",
          payload: {
            inputId,
            expectedRevision,
            expectedMessageRef,
            revision: expectedRevision + 1,
            messageRef,
            delivery: replacement.delivery,
            ...(targetTurnId === undefined ? {} : { targetTurnId }),
            sequence: current.payload.sequence,
          },
          causationId: current.eventId,
          correlationId: `input:${inputId}`,
          idempotencyKey: `${attached.runId}:input:${inputId}:replaced:${expectedRevision + 1}`,
          visibility: "user",
          occurredAt: this.clock.now().toISOString(),
        });
      } catch (error: unknown) {
        if (await pendingMutationIsStale(
          attached,
          inputId,
          expectedRevision,
          expectedMessageRef,
        )) return "stale";
        throw new SessionProtocolError(`Unable to replace pending input ${inputId}`, {
          cause: error,
        });
      }
      this.publishState();
      return "applied";
    }));
  }

  /** Permanently withdraw one still-pending input without rewriting history. */
  async withdrawPendingInput(
    inputId: string,
    expectedRevision: number,
  ): Promise<SessionPendingInputMutationResult> {
    return this.runAdmission(() => this.runPendingInputTransition(async () => {
      this.assertOpen();
      validatePendingMutationIdentity(inputId, expectedRevision);
      if (this.attached === undefined) return "stale";

      const attached = this.attached;
      const events = await attached.ledger.read({ runId: attached.runId });
      attached.sink.replaceCache(events);
      const current = findPendingInput(events, inputId);
      if (current === undefined || current.payload.revision !== expectedRevision) {
        return "stale";
      }
      const expectedMessageRef = structuredClone(current.payload.messageRef);
      try {
        await attached.sink.append({
          runId: attached.runId,
          laneId: "main",
          type: "input.withdrawn",
          payload: { inputId, expectedRevision, expectedMessageRef },
          causationId: current.eventId,
          correlationId: `input:${inputId}`,
          idempotencyKey: `${attached.runId}:input:${inputId}:withdrawn:${expectedRevision}`,
          visibility: "user",
          occurredAt: this.clock.now().toISOString(),
        });
      } catch (error: unknown) {
        if (await pendingMutationIsStale(
          attached,
          inputId,
          expectedRevision,
          expectedMessageRef,
        )) return "stale";
        throw new SessionProtocolError(`Unable to withdraw pending input ${inputId}`, {
          cause: error,
        });
      }
      this.publishState();
      return "applied";
    }));
  }

  /** Read and strictly validate a tool arguments artifact. */
  async readToolArguments(ref: ArtifactRef): Promise<Record<string, unknown>> {
    this.assertOpen();
    return readToolArgumentsFromStore(this.requireAttached().store, ref);
  }

  /** Read one durable conversation artifact for a presentation adapter. */
  async readConversationMessage(ref: ArtifactRef): Promise<ConversationMessage> {
    this.assertOpen();
    return readConversationArtifact(this.requireAttached().store, ref);
  }

  /** Explicitly replace the durable Run mission; ordinary Turn input never calls this. */
  async reviseGoal(statement: string): Promise<Goal> {
    return this.runAdmission(async () => {
      this.assertOpen();
      const normalized = statement.trim();
      if (normalized.length === 0) {
        throw new SessionProtocolError("Goal statement must not be empty");
      }
      if (this.active !== undefined || this.execution !== undefined) {
        throw new SessionProtocolError("Wait for or cancel the active Turn before revising Goal");
      }
      if (this.attached === undefined) {
        await this.createRun(normalized);
        this.publishState();
        return structuredClone(this.requireAttached().goal);
      }

      const attached = this.attached;
      const events = await attached.ledger.read({ runId: attached.runId });
      attached.sink.replaceCache(events);
      const current = projectRun(events, attached.runId).goal;
      if (current === undefined) {
        throw new SessionProtocolError(`Run ${attached.runId} is missing its Goal`);
      }
      attached.goal = current;
      if (current.statement === normalized) {
        return structuredClone(current);
      }
      if (current.version >= Number.MAX_SAFE_INTEGER) {
        throw new SessionProtocolError("Goal version is exhausted");
      }
      const goal: Goal = {
        ...structuredClone(current),
        version: current.version + 1,
        statement: normalized,
      };
      await attached.sink.append({
        runId: attached.runId,
        laneId: "main",
        type: "goal.revised",
        payload: { goal },
        correlationId: `run:${attached.runId}`,
        idempotencyKey: `${attached.runId}:goal:${goal.version}`,
        visibility: "run",
        occurredAt: this.clock.now().toISOString(),
      });
      attached.goal = goal;
      this.publishState();
      return structuredClone(goal);
    });
  }

  async submit(request: SessionSubmitRequest): Promise<SessionSubmitResult> {
    return this.runAdmission(async () => {
      this.assertOpen();
      validateSubmit(request);
      if (this.attached === undefined) {
        await this.createRun();
      }
      const attached = this.requireAttached();
      let events = await attached.ledger.read({ runId: attached.runId });
      attached.sink.replaceCache(events);
      const existing = events.find((event): event is Extract<AnyEvent, {
        type: "input.admitted";
      }> => event.type === "input.admitted" && event.payload.inputId === request.inputId);
      if (existing !== undefined) {
        await assertSameAdmission(attached.store, existing, request);
        return {
          inputId: request.inputId,
          ...(existing.payload.targetTurnId === undefined
            ? {}
            : { turnId: existing.payload.targetTurnId }),
          status: "duplicate",
          delivery: existing.payload.delivery,
        };
      }

      if (projectPendingAdmissions(events).length >= MAX_PENDING_INPUTS) {
        throw new SessionProtocolError(
          `Pending input limit reached (${MAX_PENDING_INPUTS})`,
        );
      }
      const delivery = this.active === undefined
        ? "new-turn"
        : request.delivery ?? "steering";
      if (this.active === undefined && delivery === "new-turn") {
        const blocker = blockingReason(events);
        const interrupted = latestResumableTurn(events);
        if (blocker === "turn-interrupted" && interrupted?.status === "interrupted") {
          await this.appendTurnCancelled(interrupted.turnId, "superseded-by-new-input");
          events = attached.sink.cachedEvents;
        }
      }
      const runProjection = projectRun(events, attached.runId);
      if (
        this.active === undefined
        && (runProjection.run.status === "completed" || runProjection.run.status === "failed")
      ) {
        if (runProjection.run.error === "run-budget-exhausted") {
          throw new SessionProtocolError("Run budget is exhausted; start a new Run");
        }
        await attached.sink.append({
          runId: attached.runId,
          laneId: "main",
          type: "run.resumed",
          payload: {
            fromOffset: runProjection.run.lastOffset,
            reason: "new-turn",
          },
          correlationId: `run:${attached.runId}`,
          idempotencyKey: `${attached.runId}:resumed:new-turn:${request.inputId}`,
          visibility: "run",
          occurredAt: this.clock.now().toISOString(),
        });
        events = attached.sink.cachedEvents;
      }
      const targetTurnId = delivery === "steering" ? this.active?.turnId : undefined;
      const messageRef = await attached.store.put(stableJson({
        role: "user",
        content: request.text,
        ...(request.images === undefined
          ? {}
          : { images: structuredClone(request.images) }),
        createdAt: this.clock.now().toISOString(),
      } satisfies ConversationMessage), MESSAGE_MEDIA_TYPE);
      const admitted = await attached.sink.append({
        runId: attached.runId,
        ...(targetTurnId === undefined ? {} : { turnId: targetTurnId }),
        laneId: "main",
        type: "input.admitted",
        payload: {
          inputId: request.inputId,
          messageRef,
          delivery,
          ...(targetTurnId === undefined ? {} : { targetTurnId }),
          sequence: nextInputSequence(events),
        },
        correlationId: `input:${request.inputId}`,
        idempotencyKey: `${attached.runId}:input:${request.inputId}:admitted`,
        visibility: "user",
        occurredAt: this.clock.now().toISOString(),
      });

      let turnId = targetTurnId;
      if (
        this.active === undefined
        && this.execution === undefined
        && blockingReason(attached.sink.cachedEvents) === undefined
      ) {
        const promoted = await this.promote({ event: admitted }, "idle-submit");
        if (promoted !== undefined) {
          turnId = promoted.turnId;
          this.startExecution(promoted);
        }
      }
      this.publishState();
      return {
        inputId: request.inputId,
        ...(turnId === undefined ? {} : { turnId }),
        status: "admitted",
        delivery,
      };
    });
  }

  async cancel(reason = "Cancelled by user"): Promise<void> {
    await this.runAdmission(async () => {
      this.assertOpen();
      const active = this.active;
      const execution = this.execution;
      if (active !== undefined) {
        this.status = "cancelling";
        this.publishState();
        active.controller.abort(new Error(reason));
      }
      if (execution === undefined) {
        const attached = this.attached;
        if (attached === undefined) return;
        const events = await attached.ledger.read({ runId: attached.runId });
        const waiting = latestResumableTurn(events);
        if (waiting === undefined) return;
        await this.appendTurnCancelled(waiting.turnId, reason);
        this.publishState();
        await this.promoteNextPending();
        return;
      }
      if (await settlesWithin(execution, CLOSE_GRACE_MS)) return;

      // A provider/tool that ignores AbortSignal cannot keep the Session's
      // writer lease alive. Record the boundary, close this attachment, and
      // let the next command create or explicitly attach a fresh Session.
      if (this.attached !== undefined && active !== undefined) {
        await this.recordForcedBoundary().catch(() => undefined);
      }
      await this.retireAttachment();
    });
  }

  async resumeCurrent(): Promise<void> {
    await this.runAdmission(async () => {
      this.assertOpen();
      if (this.active !== undefined || this.execution !== undefined) {
        throw new SessionProtocolError("A Turn is already running");
      }
      const attached = this.requireAttached();
      const events = await attached.ledger.read({ runId: attached.runId });
      const blocker = blockingReason(events);
      if (blocker?.startsWith("operation-unknown:")) {
        throw new SessionProtocolError(
          `Resolve ${blocker.slice("operation-unknown:".length)} before resuming`,
        );
      }
      const waiting = latestResumableTurn(events);
      if (waiting === undefined) {
        const pending = projectPendingAdmissions(events)[0];
        if (pending !== undefined) {
          const promoted = await this.promote({ event: pending }, "resume-pending");
          if (promoted !== undefined) this.startExecution(promoted);
        }
        return;
      }
      if (
        waiting.status === "waiting"
        && waiting.resumeRequires !== "explicit-resume"
        && waiting.resumeRequires !== "operation-resolution"
      ) {
        throw new SessionProtocolError(
          `Turn ${waiting.turnId} requires ${waiting.resumeRequires ?? "explicit recovery"}`,
        );
      }
      if (waiting.status === "interrupted" && waiting.retryable !== true) {
        throw new SessionProtocolError(`Turn ${waiting.turnId} is not retryable`);
      }
      const fromStep = highestTurnStep(events, waiting.turnId) + 1;
      await attached.sink.append({
        runId: attached.runId,
        turnId: waiting.turnId,
        laneId: "main",
        type: "turn.resumed",
        payload: {
          turnId: waiting.turnId,
          fromStep,
          stepAllowance: mainStepAllowance(attached.policy),
        },
        correlationId: `turn:${waiting.turnId}`,
        idempotencyKey: `${attached.runId}:turn:${waiting.turnId}:resume:${fromStep}`,
        visibility: "run",
        occurredAt: this.clock.now().toISOString(),
      });
      this.startExecution({ turnId: waiting.turnId, inputId: waiting.inputId });
    });
  }

  async resolveOperation(operationId: string): Promise<void> {
    await this.runAdmission(async () => {
      this.assertOpen();
      if (this.active !== undefined || this.execution !== undefined) {
        throw new SessionProtocolError("Cancel the active Turn before resolving an operation");
      }
      const attached = this.requireAttached();
      await resolvePendingToolOperation(
        attached.sink,
        attached.store,
        attached.runId,
        operationId,
        { clock: this.clock },
      );
      const events = await attached.ledger.read({ runId: attached.runId });
      attached.sink.replaceCache(events);
      if (projectRun(events, attached.runId).unknownOperations.length > 0) {
        this.publishState();
        return;
      }
      const waiting = latestResumableTurn(events);
      if (
        waiting?.status === "waiting"
        && waiting.reason === "operation-unknown"
        && waiting.resumeRequires === "operation-resolution"
      ) {
        const fromStep = highestTurnStep(events, waiting.turnId) + 1;
        await attached.sink.append({
          runId: attached.runId,
          turnId: waiting.turnId,
          laneId: "main",
          type: "turn.resumed",
          payload: {
            turnId: waiting.turnId,
            fromStep,
            stepAllowance: mainStepAllowance(attached.policy),
          },
          correlationId: `turn:${waiting.turnId}`,
          idempotencyKey: `${attached.runId}:turn:${waiting.turnId}:resume:${fromStep}`,
          visibility: "run",
          occurredAt: this.clock.now().toISOString(),
        });
        this.startExecution({ turnId: waiting.turnId, inputId: waiting.inputId });
        return;
      }
      this.publishState();
      await this.promoteNextPending();
    });
  }

  async newRun(): Promise<void> {
    await this.runAdmission(async () => {
      this.assertOpen();
      if (this.active !== undefined || this.execution !== undefined) {
        throw new SessionProtocolError("Cancel the active Turn before starting a new Run");
      }
      await this.detach();
      this.status = "detached";
      this.publishState();
    });
  }

  async attachRun(runId: string): Promise<void> {
    await this.runAdmission(async () => {
      this.assertOpen();
      if (this.active !== undefined || this.execution !== undefined) {
        throw new SessionProtocolError("Cancel the active Turn before attaching another Run");
      }
      validateRunId(runId);
      if (this.attached?.runId === runId) return;
      const candidate = await this.openAttachment(runId);
      try {
        await this.recordInterruptedTurnOnAttach(candidate);
      } catch (error: unknown) {
        await this.stopWorkerLane(candidate);
        candidate.sink.deactivate();
        await candidate.ledger.close().catch(() => undefined);
        throw error;
      }
      const previous = this.attached;
      this.attached = candidate;
      this.selectedMainModel = candidate.mainModel;
      candidate.worker?.scheduler.enqueue();
      if (previous !== undefined) {
        await this.stopWorkerLane(previous);
        await previous.processJobs?.close().catch(() => undefined);
        previous.sink.deactivate();
        await previous.ledger.close();
      }
      this.status = "idle";
      this.publishState();
    });
  }

  async waitForIdle(): Promise<void> {
    while (this.execution !== undefined) {
      await this.execution;
    }
  }

  async close(): Promise<void> {
    if (this.closePromise !== undefined) {
      await this.closePromise;
      return;
    }
    if (this.status === "closed") return;
    this.closing = true;
    const closePromise = this.runAdmission(async () => {
      const execution = this.execution;
      if (this.active !== undefined) {
        this.status = "cancelling";
        this.publishState();
        this.active.controller.abort(new Error("Session closed"));
      }
      if (execution !== undefined) {
        const settled = await settlesWithin(execution, CLOSE_GRACE_MS);
        if (!settled && this.attached !== undefined) {
          await this.recordForcedBoundary().catch(() => undefined);
          await this.retireAttachment();
        }
      }
      if (this.attached !== undefined) {
        // Stop the Run-scoped Worker before checkpointing so a terminal reply
        // cannot race the checksum and land after the final checkpoint.
        await this.stopWorkerLane(this.attached);
        await commitRunCheckpoint(this.attached.sink, this.attached.runId).catch(() => undefined);
      }
      await this.detach();
      this.status = "closed";
      this.publishState();
      this.listeners.clear();
    });
    this.closePromise = closePromise;
    await closePromise;
  }

  private async createRun(goalStatement = DEFAULT_INTERACTIVE_GOAL): Promise<void> {
    const runId = (this.deps.createRunId ?? randomUUID)();
    validateRunId(runId);
    const stateDir = resolve(this.dataDir, "runs", runId);
    const ledger = await JsonlLedger.open(resolve(stateDir, "ledger.jsonl"));
    let attached: AttachedRun | undefined;
    try {
      const store = await FileContentAddressedStore.open(resolve(stateDir, "store"));
      const sink = new SessionEventSink(
        ledger,
        [],
        (event) => this.publish(event),
        this.deps.assertExecutionLease,
        this.deps.commitExecutionLease,
      );
      const goal: Goal = {
        version: 1,
        statement: goalStatement,
        successCriteria: ["Address each explicit user request with a grounded result"],
        hardConstraints: [],
      };
      await sink.append({
        runId,
        laneId: "main",
        type: "run.created",
        payload: { goal, workspace: this.workspace, policy: this.policy },
        correlationId: `run:${runId}`,
        idempotencyKey: "run:created",
        visibility: "run",
        occurredAt: this.clock.now().toISOString(),
      });
      await sink.append({
        runId,
        laneId: "main",
        type: "lane.registered",
        payload: { kind: "main" },
        correlationId: `run:${runId}`,
        idempotencyKey: "lane:main:registered",
        visibility: "run",
      });
      if (this.policy.tetoEnabled) {
        await sink.append({
          runId,
          laneId: "teto",
          type: "lane.registered",
          payload: { kind: "intent-navigator" },
          correlationId: `run:${runId}`,
          idempotencyKey: "lane:teto:registered",
          visibility: "run",
        });
      }
      if (this.policy.workerEnabled === true) {
        await sink.append({
          runId,
          laneId: "worker",
          type: "lane.registered",
          payload: { kind: "worker" },
          correlationId: `run:${runId}`,
          idempotencyKey: "lane:worker:registered",
          visibility: "run",
        });
      }
      attached = {
        runId,
        ledger,
        sink,
        store,
        goal,
        policy: this.policy,
        tokenBudget: new RunTokenBudget(this.policy.maxModelTokens),
        mainModel: this.model,
        ...(this.allowShell
          ? { processJobs: await this.createProcessJobManager(runId) }
          : {}),
      };
      if (this.policy.workerEnabled === true) {
        attached.worker = this.createWorkerLaneRuntime(attached);
      }
      this.attached = attached;
      attached.worker?.scheduler.enqueue();
      this.status = "idle";
    } catch (error: unknown) {
      if (attached !== undefined) {
        await this.stopWorkerLane(attached);
        await attached.processJobs?.close().catch(() => undefined);
      }
      await ledger.close();
      throw error;
    }
  }

  private createWorkerLaneRuntime(attached: AttachedRun): WorkerLaneRuntime {
    const events = attached.sink.cachedEvents;
    const inbox = new A2AInbox({
      sink: attached.sink,
      events,
      clock: this.clock,
    });
    const dispatcher = new TaskDispatcher({
      inbox,
      runId: attached.runId,
      clock: this.clock,
    });
    const workerModel = this.deps.workerModel
      ?? this.deps.mainModel
      ?? createOpenRouterModelPort();
    const executor = new WorkerTaskExecutor({
      inbox,
      eventSink: attached.sink,
      store: attached.store,
      model: workerModel,
      modelName: this.workerModel,
      runId: attached.runId,
      workspace: this.workspace,
      tools: this.deps.workerTools ?? createWorkspaceTools({
        allowWrite: false,
        allowShell: false,
        allowImages: shouldAdvertiseImageTools(workerModel, this.workerModel),
        protectedPaths: [this.dataDir],
      }),
      runTokenBudget: attached.tokenBudget,
      clock: this.clock,
      readWatermark: () => attached.ledger.watermark(),
      readEvents: () => attached.ledger.read({ runId: attached.runId }),
    });
    const scheduler = new WorkerLaneScheduler({
      executor,
      inbox,
      runId: attached.runId,
      committedBoundaryMessageIds: projectCommittedBoundaryMessageIds(
        events,
        attached.runId,
      ),
    });
    return { inbox, dispatcher, scheduler };
  }

  private async openAttachment(runId: string): Promise<AttachedRun> {
    const stateDir = resolve(this.dataDir, "runs", runId);
    const ledger = await JsonlLedger.open(resolve(stateDir, "ledger.jsonl"));
    let attached: AttachedRun | undefined;
    try {
      const store = await FileContentAddressedStore.open(resolve(stateDir, "store"));
      const events = await ledger.read({ runId });
      const projection = projectRun(events, runId);
      if (
        projection.goal === undefined
        || projection.run.policy === undefined
        || projection.run.workspace === undefined
      ) {
        throw new SessionProtocolError(`Run ${runId} is missing creation facts`);
      }
      const recordedWorkspace = await realpath(projection.run.workspace);
      if (recordedWorkspace !== this.workspace) {
        throw new SessionProtocolError(
          `Run ${runId} belongs to ${recordedWorkspace}, not ${this.workspace}`,
        );
      }
      if (
        this.requestedWorkerEnabled !== undefined
        && this.requestedWorkerEnabled !== (projection.run.policy.workerEnabled === true)
      ) {
        throw new SessionProtocolError("Cannot change workerEnabled while resuming a Run");
      }
      validateRequestedFukaiPolicy(
        this.policy.fukaiCompaction,
        projection.run.policy.fukaiCompaction,
      );
      attached = {
        runId,
        ledger,
        sink: new SessionEventSink(
          ledger,
          events,
          (event) => this.publish(event),
          this.deps.assertExecutionLease,
          this.deps.commitExecutionLease,
        ),
        store,
        goal: projection.goal,
        policy: projection.run.policy,
        tokenBudget: new RunTokenBudget(
          projection.run.policy.maxModelTokens,
          totalTokens(recoverRunTokenUsage(events, runId)),
        ),
        // Schema-v1 Runs created before model.selected keep the caller's
        // configured selector until the first explicit selection is recorded.
        mainModel: projection.lanes.main?.model ?? this.model,
        ...(this.allowShell
          ? { processJobs: await this.createProcessJobManager(runId) }
          : {}),
      };
      if (projection.run.policy.workerEnabled === true) {
        attached.worker = this.createWorkerLaneRuntime(attached);
      }
      return attached;
    } catch (error: unknown) {
      if (attached !== undefined) {
        await this.stopWorkerLane(attached);
        await attached.processJobs?.close().catch(() => undefined);
      }
      await ledger.close().catch(() => undefined);
      throw error;
    }
  }

  private async promote(
    admission: Admission,
    boundary: string,
  ): Promise<{ turnId: string; inputId: string } | undefined> {
    return this.runPendingInputTransition(() => this.promotePending(admission, boundary));
  }

  private async promotePending(
    admission: Admission,
    boundary: string,
  ): Promise<{ turnId: string; inputId: string } | undefined> {
    const attached = this.requireAttached();
    const inputId = admission.event.payload.inputId;
    let events = await attached.ledger.read({ runId: attached.runId });
    const pending = findPendingInput(events, inputId);
    if (pending === undefined) return undefined;
    let started = events.find((event): event is Extract<AnyEvent, {
      type: "turn.started";
    }> => event.type === "turn.started" && event.payload.inputId === inputId);
    const turnId = started?.payload.turnId ?? deriveTurnId(attached.runId, inputId);
    if (started === undefined) {
      started = await attached.sink.append({
        runId: attached.runId,
        turnId,
        laneId: "main",
        type: "turn.started",
        payload: {
          turnId,
          inputId,
          ordinal: nextTurnOrdinal(events),
          boundary: this.currentTurnExecutionBoundary(),
        },
        causationId: pending.eventId,
        correlationId: `turn:${turnId}`,
        idempotencyKey: `${attached.runId}:turn:${turnId}:started`,
        visibility: "run",
        occurredAt: this.clock.now().toISOString(),
      });
      events = attached.sink.cachedEvents;
    }
    let delivered = events.find((event): event is Extract<AnyEvent, {
      type: "input.delivered";
    }> => event.type === "input.delivered" && event.payload.inputId === inputId);
    if (delivered === undefined) {
      delivered = await attached.sink.append({
        runId: attached.runId,
        turnId,
        laneId: "main",
        type: "input.delivered",
        payload: {
          inputId,
          turnId,
          boundary,
          expectedRevision: pending.payload.revision,
          expectedMessageRef: pending.payload.messageRef,
        },
        causationId: started.eventId,
        correlationId: `turn:${turnId}`,
        idempotencyKey: `${attached.runId}:input:${inputId}:delivered`,
        visibility: "run",
        occurredAt: this.clock.now().toISOString(),
      });
      events = attached.sink.cachedEvents;
    }
    const currentInput = projectRun(events, attached.runId).inputs.find((input) => (
      input.inputId === inputId
    ));
    if (currentInput === undefined) {
      throw new SessionProtocolError(`Input ${inputId} is missing from the Run projection`);
    }
    if (!events.some((event) =>
      event.type === "user.message" && event.payload.inputId === inputId
    )) {
      await attached.sink.append({
        runId: attached.runId,
        turnId,
        laneId: "main",
        type: "user.message",
        payload: {
          inputId,
          messageRef: currentInput.messageRef,
          kind: "initial",
        },
        causationId: delivered.eventId,
        correlationId: `turn:${turnId}`,
        idempotencyKey: `${attached.runId}:input:${inputId}:user-message`,
        visibility: "user",
        occurredAt: this.clock.now().toISOString(),
      });
    }
    return { turnId, inputId };
  }

  private startExecution(
    turn: { turnId: string; inputId: string },
    replacingExecution?: Promise<void>,
  ): void {
    if (
      this.active !== undefined
      || (this.execution !== undefined && this.execution !== replacingExecution)
    ) {
      throw new SessionProtocolError("A Main Turn is already active");
    }
    const controller = new AbortController();
    this.active = { ...turn, controller };
    this.status = "running";
    this.publishState();
    const execution = this.runTurn(this.active)
      .catch((error: unknown) => {
        if (this.status !== "closed") {
          this.publishFailure(error);
        }
      })
      .finally(async () => {
        try {
          if (!this.closing && this.status !== "closed" && this.status !== "detached") {
            await this.promoteNextPending(execution);
          }
        } catch (error: unknown) {
          if (this.status !== "closed") this.publishFailure(error);
        } finally {
          if (this.execution === execution) this.execution = undefined;
        }
      });
    this.execution = execution;
  }

  private async runTurn(turn: ActiveTurn): Promise<void> {
    const attached = this.requireAttached();
    let scheduler: TetoScheduler | undefined;
    try {
      const events = await attached.ledger.read({ runId: attached.runId });
      const turnStarted = events.find((event): event is Extract<AnyEvent, {
        type: "turn.started";
      }> => event.type === "turn.started" && event.payload.turnId === turn.turnId);
      if (turnStarted === undefined) {
        throw new SessionProtocolError(`Turn ${turn.turnId} is missing turn.started`);
      }
      const executionBoundary = restrictTurnExecutionBoundary(
        turnStarted.payload.boundary,
        this.currentTurnExecutionBoundary(),
      );
      const turnCapabilities = executionBoundary.capabilities;
      const turnCollaborationMode = executionBoundary.collaborationMode;
      const projection = projectRun(events, attached.runId);
      if (projection.goal === undefined) {
        throw new SessionProtocolError(`Run ${attached.runId} is missing its Goal`);
      }
      // Goal is the durable Run mission. The Turn's admitted input is its
      // recoverable active objective; steering must not silently replace it.
      attached.goal = projection.goal;
      const activeObjective = await readTurnObjective(attached.store, events, turn);
      let outputContinuationMessageId = outputLimitContinuationMessageId(
        events,
        turn.turnId,
      );
      const startStep = highestTurnStep(events, turn.turnId) + 1;
      await this.appendMainLaneStatus(
        "running",
        undefined,
        `turn:${turn.turnId}:running:${startStep}`,
        turn.turnId,
      );
      const model = this.deps.mainModel ?? createOpenRouterModelPort();
      const inbox = attached.worker?.inbox ?? new A2AInbox({
        sink: attached.sink,
        events,
        clock: this.clock,
      });
      const workspaceSandbox = this.deps.tools === undefined
        && permissionProfileForCapabilities(turnCapabilities) === "workspace"
        && this.workspaceCommandSandbox.availability().available
        ? this.workspaceCommandSandbox
        : undefined;
      if (
        this.deps.tools === undefined
        && turnCapabilities.allowShell
        && attached.processJobs === undefined
      ) {
        attached.processJobs = await this.createProcessJobManager(attached.runId);
      }
      const tools = [...(this.deps.tools ?? createWorkspaceTools({
        allowWrite: turnCapabilities.allowWrite,
        allowShell: turnCapabilities.allowShell || workspaceSandbox !== undefined,
        ...(workspaceSandbox === undefined
          ? {}
          : { bashCommandExecutor: workspaceSandbox.execute }),
        allowProcessJobs: turnCapabilities.allowShell,
        ...(attached.processJobs === undefined ? {} : { processJobManager: attached.processJobs }),
        allowImages: shouldAdvertiseImageTools(model, this.model),
        allowNetwork: turnCapabilities.allowNetwork,
        ...(this.deps.webFetchProvider === undefined
          ? {}
          : { webFetchProvider: this.deps.webFetchProvider }),
        ...(this.deps.webSearchProvider === undefined
          ? {}
          : { webSearchProvider: this.deps.webSearchProvider }),
        protectedPaths: [this.dataDir],
      }))];
      if (attached.policy.tetoEnabled) {
        tools.push(createAdviceResponseTool(inbox));
        scheduler = new TetoScheduler({
          eventSink: attached.sink,
          inbox,
          navigator: new IntentNavigator({
            modelPort: this.deps.tetoModel ?? model,
            model: this.tetoModel,
            clock: this.clock,
            maxAdviceOutputTokens: attached.policy.tetoMaxOutputTokens,
          }),
          frameBuilder: new ObservationFrameBuilder({
            maxAdviceOutputTokens: attached.policy.tetoMaxOutputTokens,
          }),
          runId: attached.runId,
          goal: attached.goal,
          model: this.tetoModel,
          policy: attached.policy,
          events,
          clock: this.clock,
          runTokenBudget: attached.tokenBudget,
          signal: turn.controller.signal,
        });
      }
      if (attached.worker !== undefined) {
        tools.push(createDelegateTaskTool({
          dispatcher: attached.worker.dispatcher,
          store: attached.store,
        }));
      }
      let latestEvents = await attached.ledger.read({ runId: attached.runId });
      const recoveredMain = projectMainExecutionRecovery(latestEvents);
      const preTurnConversationRefs = projectMainExecutionRecovery(
        events.filter((event) => event.globalOffset < turnStarted.globalOffset),
      ).conversationRefs;
      const compactionRuntime = instantiateRuntimeFukaiCompaction(
        attached.policy,
        this.deps.createCompactionRuntime ?? createRuntimeFukaiCompaction,
        {
          ledger: attached.sink,
          store: attached.store,
          modelPort: model,
          model: this.model,
          tokenBudget: attached.tokenBudget,
          clock: this.clock,
          policy: attached.policy,
        },
      );
      const policyVersion = deriveRuntimePolicyVersion(attached.policy);
      if (compactionRuntime !== undefined) {
        await prepareRuntimeFukaiCompaction(compactionRuntime, {
          runId: attached.runId,
          laneId: "main",
          goal: attached.goal,
          policyVersion,
          upperWatermark: Math.max(0, turnStarted.globalOffset - 1),
          conversationRefs: preTurnConversationRefs,
          budget: runtimeFukaiCompactionBudget(attached.policy),
          signal: turn.controller.signal,
        });
        latestEvents = await attached.ledger.read({ runId: attached.runId });
      }
      const remaining = attached.tokenBudget.availableTokens();
      if (remaining === 0) {
        await scheduler?.stop();
        scheduler = undefined;
        await this.failRunBudget(turn.turnId);
        return;
      }
      const loop = new MainLoop({
        model,
        resolveModel: () => this.model,
        contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(attached.store)),
        conversationStore: attached.store,
        eventSink: attached.sink,
        tools,
        clock: this.clock,
        runTokenBudget: attached.tokenBudget,
        ...(this.deps.approveTool === undefined
          ? {}
          : { approve: this.deps.approveTool }),
        beforeStep: async ({ step }) => {
          const continuation = outputContinuationMessageId === undefined
            ? []
            : [{
                kind: "runtime-notice" as const,
                source: "session-controller",
                content: "The previous assistant response reached the model output limit. Continue exactly where it stopped without repeating completed material.",
                messageId: outputContinuationMessageId,
              }];
          outputContinuationMessageId = undefined;
          return [
            ...continuation,
            ...await this.deliverSteering(turn.turnId, step),
            ...await (scheduler?.beforeMainStep({ step }) ?? Promise.resolve([])),
            ...await (attached.worker?.scheduler.beforeMainStep({ step }) ?? Promise.resolve([])),
          ];
        },
        ...(scheduler === undefined && attached.worker === undefined
          ? {}
          : {
              afterStep: (context) => {
                scheduler?.enqueue(context);
                attached.worker?.scheduler.enqueue(context);
              },
            }),
        ...(compactionRuntime === undefined
          ? {}
          : {
              selectCompaction: compactionRuntime.select.bind(compactionRuntime),
              ...(compactionRuntime.compactIfNeeded === undefined
                ? {}
                : {
                    compactForPressure: compactionRuntime.compactIfNeeded.bind(
                      compactionRuntime,
                    ),
                  }),
            }),
        onStreamEvent: (event) => this.publish({ kind: "stream", event }),
      });
      const result = await loop.run({
        runId: attached.runId,
        turnId: turn.turnId,
        activeObjective,
        goal: attached.goal,
        model: this.model,
        workspace: this.workspace,
        policy: { ...attached.policy, maxModelTokens: remaining },
        policyVersion,
        conversationRefs: recoveredMain.conversationRefs,
        pressureEligibleConversationCount:
          recoveredMain.pressureEligibleConversationCount,
        upperWatermark: latestEvents.at(-1)?.globalOffset ?? 0,
        startStep: highestTurnStep(latestEvents, turn.turnId) + 1,
        maxOutputTokens: this.maxOutputTokens,
        collaborationMode: turnCollaborationMode,
        completeRun: false,
        signal: turn.controller.signal,
      });
      await settlesWithin(scheduler?.drain() ?? Promise.resolve(), 25);
      // Worker work remains live after this Turn. Its terminal messages stay in
      // the Inbox until a later Main boundary accepts them.
      await scheduler?.stop();
      if (!result.completed) {
        const waitingReason = result.stopReason === "length"
          ? "model-output-limit"
          : "step-allowance-exhausted";
        await attached.sink.append({
          runId: attached.runId,
          turnId: turn.turnId,
          laneId: "main",
          type: "turn.waiting",
          payload: {
            turnId: turn.turnId,
            reason: waitingReason,
            lastCommittedStep: highestTurnStep(attached.sink.cachedEvents, turn.turnId),
            resumeRequires: "explicit-resume",
          },
          correlationId: `turn:${turn.turnId}`,
          idempotencyKey: `${attached.runId}:turn:${turn.turnId}:waiting:${highestTurnStep(attached.sink.cachedEvents, turn.turnId)}`,
          visibility: "run",
          occurredAt: this.clock.now().toISOString(),
        });
        await this.appendMainLaneStatus(
          "waiting",
          waitingReason,
          `turn:${turn.turnId}:waiting:${highestTurnStep(attached.sink.cachedEvents, turn.turnId)}`,
          turn.turnId,
        );
      } else {
        // A completed Turn leaves the long-lived interactive Main lane ready
        // for another Turn; only one-shot Runs use the terminal completed state.
        await this.appendMainLaneStatus(
          "ready",
          undefined,
          `turn:${turn.turnId}:ready`,
          turn.turnId,
        );
      }
    } catch (error: unknown) {
      await scheduler?.stop().catch(() => undefined);
      if (turn.controller.signal.aborted) {
        await this.appendTurnCancelled(turn.turnId, persistedErrorText(
          turn.controller.signal.reason,
          "Cancelled by user",
        ));
      } else if (error instanceof MainRunTokenBudgetExhaustedError) {
        await this.failRunBudget(turn.turnId);
      } else {
        const message = persistedErrorText(error);
        await attached.sink.append({
          runId: attached.runId,
          turnId: turn.turnId,
          laneId: "main",
          type: "turn.failed",
          payload: { turnId: turn.turnId, error: message },
          correlationId: `turn:${turn.turnId}`,
          idempotencyKey: `${attached.runId}:turn:${turn.turnId}:failed`,
          visibility: "run",
          occurredAt: this.clock.now().toISOString(),
        });
        await this.appendMainLaneStatus(
          "failed",
          message,
          `turn:${turn.turnId}:failed`,
          turn.turnId,
        );
      }
    } finally {
      await scheduler?.stop().catch(() => undefined);
      if (this.status !== "closed") {
        await commitRunCheckpoint(attached.sink, attached.runId).catch(() => undefined);
      }
      const ownsTurn = this.active?.turnId === turn.turnId;
      if (ownsTurn) this.active = undefined;
      if (ownsTurn && this.status !== "closed" && this.status !== "detached") {
        this.status = "idle";
        this.publishState();
      }
    }
  }

  private async deliverSteering(
    turnId: string,
    step: number,
  ): Promise<MainBoundaryMessage[]> {
    return this.runPendingInputTransition(() => this.deliverPendingSteering(turnId, step));
  }

  private async deliverPendingSteering(
    turnId: string,
    step: number,
  ): Promise<MainBoundaryMessage[]> {
    const attached = this.requireAttached();
    const events = await attached.ledger.read({ runId: attached.runId });
    const steering = projectPendingAdmissions(events).filter((event) => (
      event.payload.delivery === "steering"
      && event.payload.targetTurnId === turnId
    ));
    const messages: MainBoundaryMessage[] = [];
    for (const admission of steering) {
      const delivered = await attached.sink.append({
        runId: attached.runId,
        turnId,
        laneId: "main",
        type: "input.delivered",
        payload: {
          inputId: admission.payload.inputId,
          turnId,
          boundary: `safe-step:${step}`,
          expectedRevision: admission.payload.revision,
          expectedMessageRef: admission.payload.messageRef,
        },
        causationId: admission.eventId,
        correlationId: `turn:${turnId}`,
        idempotencyKey: `${attached.runId}:input:${admission.payload.inputId}:delivered`,
        visibility: "run",
        occurredAt: this.clock.now().toISOString(),
      });
      const currentInput = projectRun(
        attached.sink.cachedEvents,
        attached.runId,
      ).inputs.find((input) => input.inputId === admission.payload.inputId);
      if (currentInput === undefined) {
        throw new SessionProtocolError(
          `Input ${admission.payload.inputId} is missing from the Run projection`,
        );
      }
      await attached.sink.append({
        runId: attached.runId,
        turnId,
        laneId: "main",
        type: "user.message",
        payload: {
          inputId: admission.payload.inputId,
          messageRef: currentInput.messageRef,
          kind: "steering",
        },
        causationId: delivered.eventId,
        correlationId: `turn:${turnId}`,
        idempotencyKey: `${attached.runId}:input:${admission.payload.inputId}:user-message`,
        visibility: "user",
        occurredAt: this.clock.now().toISOString(),
      });
      const userMessage = await readUserMessage(
        attached.store,
        currentInput.messageRef,
      );
      messages.push({
        kind: "steering",
        source: "user",
        content: userMessage.content,
        ...(userMessage.images === undefined
          ? {}
          : { images: structuredClone(userMessage.images) }),
        messageId: admission.payload.inputId,
      });
    }
    return messages;
  }

  private async promoteNextPending(previousExecution?: Promise<void>): Promise<void> {
    if (this.status === "closed" || this.active !== undefined || this.attached === undefined) {
      return;
    }
    const events = await this.attached.ledger.read({ runId: this.attached.runId });
    const projection = projectRun(events, this.attached.runId);
    if (projection.run.error === "run-budget-exhausted") return;
    if (blockingReason(events) !== undefined) return;
    const pending = projectPendingAdmissions(events)[0];
    if (pending === undefined) return;
    const promoted = await this.promote({ event: pending },
      pending.payload.delivery === "steering"
        ? "retargeted-after-terminal"
        : "queued-after-terminal");
    if (promoted !== undefined) this.startExecution(promoted, previousExecution);
  }

  private async failRunBudget(turnId: string): Promise<void> {
    const attached = this.requireAttached();
    await attached.sink.append({
      runId: attached.runId,
      turnId,
      laneId: "main",
      type: "turn.failed",
      payload: { turnId, error: "Run token budget exhausted" },
      correlationId: `turn:${turnId}`,
      idempotencyKey: `${attached.runId}:turn:${turnId}:budget-failed`,
      visibility: "run",
    });
    await attached.sink.append({
      runId: attached.runId,
      laneId: "main",
      type: "run.failed",
      payload: { error: "run-budget-exhausted" },
      correlationId: `run:${attached.runId}`,
      idempotencyKey: `${attached.runId}:budget-failed`,
      visibility: "run",
    });
    await this.appendMainLaneStatus(
      "failed",
      "Run token budget exhausted",
      `turn:${turnId}:budget-failed`,
      turnId,
    );
  }

  private async appendTurnCancelled(turnId: string, reason: string): Promise<void> {
    const attached = this.requireAttached();
    await attached.sink.append({
      runId: attached.runId,
      turnId,
      laneId: "main",
      type: "turn.cancelled",
      payload: {
        turnId,
        reason,
        lastCommittedStep: highestTurnStep(attached.sink.cachedEvents, turnId),
      },
      correlationId: `turn:${turnId}`,
      idempotencyKey: `${attached.runId}:turn:${turnId}:cancelled`,
      visibility: "run",
      occurredAt: this.clock.now().toISOString(),
    });
    await this.appendMainLaneStatus(
      "cancelled",
      reason,
      `turn:${turnId}:cancelled`,
      turnId,
    );
  }

  private async appendMainLaneStatus(
    status: LaneStatus,
    reason: string | undefined,
    scope: string,
    turnId?: string,
    target?: AttachedRun,
  ): Promise<void> {
    const attached = target ?? this.requireAttached();
    await attached.sink.append({
      runId: attached.runId,
      ...(turnId === undefined ? {} : { turnId }),
      laneId: "main",
      type: "lane.status",
      payload: { status, ...(reason === undefined ? {} : { reason }) },
      correlationId: turnId === undefined ? `run:${attached.runId}` : `turn:${turnId}`,
      idempotencyKey: `${attached.runId}:main:${scope}`,
      visibility: "run",
      occurredAt: this.clock.now().toISOString(),
    });
  }

  private async recordForcedBoundary(): Promise<void> {
    const attached = this.requireAttached();
    const turn = this.active;
    if (turn === undefined) return;
    const events = await attached.ledger.read({ runId: attached.runId });
    const unknown = pendingToolRequests(events, turn.turnId);
    for (const request of unknown) {
      await attached.sink.append({
        runId: attached.runId,
        turnId: turn.turnId,
        laneId: request.laneId,
        type: "tool.unknown",
        payload: {
          operationId: request.payload.operationId,
          toolCallId: request.payload.toolCallId,
          name: request.payload.name,
          reason: "Session closed before the tool outcome was known",
        },
        causationId: request.eventId,
        correlationId: request.correlationId,
        idempotencyKey: `${attached.runId}:turn:${turn.turnId}:tool:${request.payload.operationId}:unknown`,
        visibility: "run",
      });
    }
    if (unknown.length === 0) {
      await this.appendTurnCancelled(turn.turnId, "Session close grace expired");
    } else {
      await attached.sink.append({
        runId: attached.runId,
        turnId: turn.turnId,
        laneId: "main",
        type: "turn.waiting",
        payload: {
          turnId: turn.turnId,
          reason: "operation-unknown",
          lastCommittedStep: highestTurnStep(events, turn.turnId),
          resumeRequires: "operation-resolution",
        },
        correlationId: `turn:${turn.turnId}`,
        idempotencyKey: `${attached.runId}:turn:${turn.turnId}:operation-unknown`,
        visibility: "run",
      });
      await this.appendMainLaneStatus(
        "waiting",
        "operation-unknown",
        `turn:${turn.turnId}:waiting:operation-unknown`,
        turn.turnId,
      );
    }
  }

  private async recordInterruptedTurnOnAttach(attached = this.requireAttached()): Promise<void> {
    const events = attached.sink.cachedEvents;
    const projection = projectRun(events, attached.runId);
    const turnId = projection.activeTurnId;
    if (turnId === undefined || turnId.startsWith("legacy:")) return;
    const turn = projection.turns[turnId];
    if (turn === undefined) return;
    const pendingRequest = [...events].reverse().find((event): event is Extract<AnyEvent, {
      type: "model.requested";
    }> => event.type === "model.requested" && event.turnId === turnId && !events.some(
      (candidate) => (
        (candidate.type === "model.completed" || candidate.type === "model.failed")
        && candidate.causationId === event.eventId
      ) || (
        candidate.type === "model.cancelled"
        && candidate.payload.requestId === event.eventId
      ),
    ));
    if (pendingRequest !== undefined) {
      await attached.sink.append({
        runId: attached.runId,
        turnId,
        laneId: "main",
        type: "model.cancelled",
        payload: {
          requestId: pendingRequest.eventId,
          reason: "process-interrupted",
        },
        causationId: pendingRequest.eventId,
        correlationId: pendingRequest.correlationId,
        idempotencyKey: `${attached.runId}:turn:${turnId}:model:${pendingRequest.eventId}:interrupted`,
        visibility: "run",
        occurredAt: this.clock.now().toISOString(),
      });
    }
    await attached.sink.append({
      runId: attached.runId,
      turnId,
      laneId: "main",
      type: "turn.interrupted",
      payload: {
        turnId,
        reason: "Process exited before the Turn reached a committed boundary",
        retryable: true,
        lastCommittedStep: turn.lastCommittedStep,
      },
      correlationId: `turn:${turnId}`,
      idempotencyKey: `${attached.runId}:turn:${turnId}:process-interrupted`,
      visibility: "run",
      occurredAt: this.clock.now().toISOString(),
    });
    await this.appendMainLaneStatus(
      "waiting",
      "process-interrupted",
      `turn:${turnId}:waiting:process-interrupted`,
      turnId,
      attached,
    );
  }

  private async detach(): Promise<void> {
    const attached = this.attached;
    this.attached = undefined;
    this.active = undefined;
    this.execution = undefined;
    if (attached !== undefined) {
      await this.stopWorkerLane(attached);
      await attached.processJobs?.close().catch(() => undefined);
      attached.sink.deactivate();
      await attached.ledger.close();
    }
  }

  private async retireAttachment(): Promise<void> {
    const attached = this.attached;
    this.attached = undefined;
    this.active = undefined;
    this.execution = undefined;
    if (attached !== undefined) {
      await this.stopWorkerLane(attached);
      await attached.processJobs?.close().catch(() => undefined);
      await commitRunCheckpoint(attached.sink, attached.runId).catch(() => undefined);
      attached.sink.deactivate();
      await attached.ledger.close().catch(() => undefined);
    }
    if (this.status !== "closed") {
      this.status = "detached";
      this.publishState();
    }
  }

  private async stopWorkerLane(attached: AttachedRun): Promise<void> {
    await attached.worker?.scheduler.stop().catch(() => undefined);
  }

  private async createProcessJobManager(runId: string): Promise<ProcessJobManager> {
    const registry = this.processJobRegistryDir === undefined
      ? undefined
      : await FileProcessJobRegistry.open(resolve(
          this.processJobRegistryDir,
          "runs",
          runId,
          "process-jobs.json",
        ));
    return ProcessJobManager.open({
      protectedPaths: [this.dataDir],
      ...(registry === undefined ? {} : { registry }),
    });
  }

  private requireAttached(): AttachedRun {
    if (this.attached === undefined) {
      throw new SessionProtocolError("No Run is attached");
    }
    return this.attached;
  }

  private assertOpen(): void {
    if (this.status === "closed") {
      throw new SessionProtocolError("Session controller is closed");
    }
    if (this.closing) {
      throw new SessionProtocolError("Session controller is closing");
    }
  }

  private runAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.admissionTail.then(operation);
    this.admissionTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private runPendingInputTransition<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pendingInputTransitionTail.then(operation);
    this.pendingInputTransitionTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private currentTurnExecutionBoundary(): TurnExecutionBoundary {
    return {
      collaborationMode: this.collaborationMode,
      capabilities: {
        allowWrite: this.allowWrite,
        allowShell: this.allowShell,
        allowNetwork: this.allowNetwork,
      },
    };
  }

  private publish(event: SessionRuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Surfaces observe runtime state; they never own it.
      }
    }
  }

  private publishState(): void {
    this.publish({ kind: "state", snapshot: this.snapshot() });
  }

  private publishFailure(error: unknown): void {
    const turnId = this.active?.turnId ?? "unknown";
    this.publish({
      kind: "stream",
      event: {
        type: "stream.failed",
        runId: this.attached?.runId ?? "unknown",
        ...(turnId === "unknown" ? {} : { turnId }),
        laneId: "main",
        requestId: "runtime",
        sequence: 0,
        error: persistedErrorText(error),
      },
    });
  }
}

function emptyWorkerTaskSummary(): WorkerTaskSummary {
  return {
    total: 0,
    queued: 0,
    running: 0,
    ready: 0,
    done: 0,
    failed: 0,
    stale: 0,
  };
}

class SessionEventSink implements Ledger {
  private active = true;
  private events: AnyEvent[];
  private lastOffset: number;

  constructor(
    private readonly ledger: Ledger,
    events: readonly AnyEvent[],
    private readonly onEvent: (event: SessionRuntimeEvent) => void,
    private readonly beforeAppend?: () => void | Promise<void>,
    private readonly commitAppend?: <T>(operation: () => Promise<T>) => Promise<T>,
  ) {
    this.events = [...events];
    this.lastOffset = highestGlobalOffset(events);
  }

  get cachedEvents(): AnyEvent[] {
    return this.events.map((event) => structuredClone(event));
  }

  get cachedLastOffset(): number {
    return this.lastOffset;
  }

  replaceCache(events: readonly AnyEvent[]): void {
    this.events = [...events];
    this.lastOffset = highestGlobalOffset(events);
  }

  deactivate(): void {
    this.active = false;
  }

  async append<K extends EventType>(input: AppendEvent<K>): Promise<EventEnvelope<K>> {
    if (!this.active) throw new SessionProtocolError("Session event sink is closed");
    const append = async (): Promise<EventEnvelope<K>> => {
      if (!this.active) throw new SessionProtocolError("Session event sink is closed");
      return this.ledger.append(input);
    };
    const event = this.commitAppend === undefined
      ? await (async (): Promise<EventEnvelope<K>> => {
          // Compatibility fallback for non-daemon custom SessionController
          // integrations which only provide the cooperative assertion seam.
          await this.beforeAppend?.();
          return append();
        })()
      : await this.commitAppend(append);
    // Detach may race the ledger write. The event is durable and will be
    // replayed on the next attachment, but a retired surface must not publish
    // it into the new attachment's event stream or cache.
    if (!this.active) return event;
    if (!this.events.some((candidate) => candidate.eventId === event.eventId)) {
      this.events.push(event as AnyEvent);
      this.lastOffset = Math.max(this.lastOffset, event.globalOffset);
      this.onEvent({ kind: "event", event: event as AnyEvent });
    }
    return event;
  }

  read(options?: Parameters<Ledger["read"]>[0]): ReturnType<Ledger["read"]> {
    return this.ledger.read(options);
  }

  watermark(): Promise<number> {
    return this.ledger.watermark();
  }

  flush(): Promise<void> {
    return this.ledger.flush();
  }

  close(): Promise<void> {
    return this.ledger.close();
  }
}

function highestGlobalOffset(events: readonly AnyEvent[]): number {
  return events.reduce((highest, event) => Math.max(highest, event.globalOffset), 0);
}

export async function findLatestRunId(
  dataDir: string,
  workspace: string,
): Promise<string | undefined> {
  return (await listWorkspaceRuns(dataDir, workspace))[0]?.runId;
}

/** List resumable Runs for one canonical workspace, newest first. */
export async function listWorkspaceRuns(
  dataDir: string,
  workspace: string,
): Promise<WorkspaceRunSummary[]> {
  const canonicalWorkspace = await realpath(resolve(workspace));
  const runsDir = resolve(dataDir, "runs");
  let entries;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const candidates: WorkspaceRunSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidRunId(entry.name)) continue;
    try {
      const ledgerPath = join(runsDir, entry.name, "ledger.jsonl");
      const info = await lstat(ledgerPath);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      const events = parseCommittedEvents(await readFile(ledgerPath), ledgerPath);
      const created = events.find((event) => event.type === "run.created");
      if (created === undefined) continue;
      const recordedWorkspace = await realpath(created.payload.workspace).catch(() => undefined);
      if (recordedWorkspace !== canonicalWorkspace) continue;
      const projection = projectRun(events, entry.name);
      candidates.push({
        runId: entry.name,
        goal: projection.goal?.statement ?? created.payload.goal.statement,
        status: workspaceRunStatus(projection),
        createdAt: created.occurredAt,
        updatedAt: events.at(-1)?.occurredAt ?? created.occurredAt,
      });
    } catch {
      // One damaged or unreadable Run must not hide healthy sessions.
    }
  }
  candidates.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
    || right.runId.localeCompare(left.runId));
  return candidates;
}

function workspaceRunStatus(
  projection: ReturnType<typeof projectRun>,
): WorkspaceRunStatus {
  if (projection.run.status === "completed" || projection.run.status === "failed") {
    return projection.run.status;
  }
  const latestTurn = Object.values(projection.turns)
    .sort((left, right) => right.lastOffset - left.lastOffset)[0];
  if (latestTurn === undefined || latestTurn.status === "completed") return "ready";
  return latestTurn.status;
}

function parseCommittedEvents(contents: Buffer, path: string): AnyEvent[] {
  const lastNewline = contents.lastIndexOf(0x0a);
  if (lastNewline < 0) return [];
  const lines = contents.subarray(0, lastNewline).toString("utf8").split("\n");
  return lines.filter((line) => line.length > 0).map((line, index) => {
    let event: unknown;
    try {
      event = JSON.parse(line);
      validateEvent(event);
    } catch (error: unknown) {
      throw new SessionProtocolError(
        `Invalid Ledger ${path} at line ${index + 1}: ${persistedErrorText(error)}`,
      );
    }
    return event;
  });
}

function nextInputSequence(events: readonly AnyEvent[]): number {
  return events.reduce((highest, event) =>
    event.type === "input.admitted"
      ? Math.max(highest, event.payload.sequence)
      : highest, 0) + 1;
}

function findPendingInput(
  events: readonly AnyEvent[],
  inputId: string,
): ProjectedPendingAdmission | undefined {
  return projectPendingAdmissions(events).find((event) => (
    event.payload.inputId === inputId
  ));
}

function sameArtifactRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return stableJson(left) === stableJson(right);
}

async function pendingMutationIsStale(
  attached: AttachedRun,
  inputId: string,
  expectedRevision: number,
  expectedMessageRef: ArtifactRef,
): Promise<boolean> {
  const events = await attached.ledger.read({ runId: attached.runId });
  attached.sink.replaceCache(events);
  const current = findPendingInput(events, inputId);
  return current === undefined
    || current.payload.revision !== expectedRevision
    || !sameArtifactRef(current.payload.messageRef, expectedMessageRef);
}

function nextTurnOrdinal(events: readonly AnyEvent[]): number {
  return events.reduce((count, event) => count + Number(event.type === "turn.started"), 0) + 1;
}

function deriveTurnId(runId: string, inputId: string): string {
  const digest = createHash("sha256").update(`${runId}\0${inputId}`).digest("hex");
  return `turn-${digest.slice(0, 24)}`;
}

function highestTurnStep(events: readonly AnyEvent[], turnId: string): number {
  return events.reduce((highest, event) => (
    event.turnId === turnId
    && (event.type === "step.started"
      || event.type === "step.completed"
      || event.type === "step.failed")
      ? Math.max(highest, event.payload.step)
      : highest
  ), 0);
}

function blockingReason(events: readonly AnyEvent[]): string | undefined {
  const runId = events[0]?.runId;
  if (runId === undefined) return undefined;
  const projection = projectRun(events, runId);
  const unknown = projection.unknownOperations[0];
  if (unknown !== undefined) return `operation-unknown:${unknown.operationId}`;
  const blocked = Object.values(projection.turns)
    .filter((turn) => turn.status === "waiting" || turn.status === "interrupted")
    .sort((left, right) => right.lastOffset - left.lastOffset)[0];
  if (blocked?.status === "waiting") return blocked.reason ?? "turn-waiting";
  if (blocked?.status === "interrupted" && blocked.retryable) return "turn-interrupted";
  return undefined;
}

function latestResumableTurn(
  events: readonly AnyEvent[],
): {
  turnId: string;
  inputId: string;
  status: "waiting" | "interrupted";
  reason?: string;
  retryable?: boolean;
  resumeRequires?: string;
} | undefined {
  const runId = events[0]?.runId;
  if (runId === undefined) return undefined;
  const turn = Object.values(projectRun(events, runId).turns)
    .filter((candidate) => (
      (candidate.status === "waiting" || candidate.status === "interrupted")
      && candidate.inputId !== undefined
    ))
    .sort((left, right) => right.lastOffset - left.lastOffset)[0];
  if (
    turn === undefined
    || turn.inputId === undefined
    || (turn.status !== "waiting" && turn.status !== "interrupted")
  ) {
    return undefined;
  }
  return {
    turnId: turn.turnId,
    inputId: turn.inputId,
    status: turn.status,
    ...(turn.reason === undefined ? {} : { reason: turn.reason }),
    ...(turn.retryable === undefined ? {} : { retryable: turn.retryable }),
    ...(turn.resumeRequires === undefined ? {} : { resumeRequires: turn.resumeRequires }),
  };
}

function totalTokens(usage: TokenUsage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function ensureVisibleLanes(
  recovered: readonly RecoveredLaneUsage[],
  tetoEnabled: boolean,
  workerEnabled: boolean,
): RecoveredLaneUsage[] {
  const byLane = new Map(recovered.map((lane) => [
    lane.laneId,
    { laneId: lane.laneId, usage: structuredClone(lane.usage) },
  ]));
  const ensure = (laneId: string): void => {
    if (byLane.has(laneId)) return;
    byLane.set(laneId, {
      laneId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  };
  ensure("main");
  if (tetoEnabled) ensure("teto");
  if (workerEnabled) ensure("worker");
  const priority = new Map([
    ["main", 0],
    ["teto", 1],
    ["reflection", 2],
    ["worker", 3],
  ]);
  return [...byLane.values()].sort((left, right) => (
    (priority.get(left.laneId) ?? 4) - (priority.get(right.laneId) ?? 4)
      || left.laneId.localeCompare(right.laneId)
  ));
}

function latestMainContextTokens(
  events: readonly AnyEvent[],
  selectedModel: string,
): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.laneId !== "main") continue;
    // A model selection invalidates the previous tokenizer-specific estimate
    // until Fukai constructs the first request for that selection.
    if (event.type === "model.selected") return null;
    if (event.type !== "model.requested") continue;
    if (event.payload.model !== selectedModel) return null;
    const tokens = event.payload.estimatedInputTokens;
    return Number.isSafeInteger(tokens) && (tokens ?? -1) >= 0 ? tokens ?? null : null;
  }
  return null;
}

function pendingToolRequests(
  events: readonly AnyEvent[],
  turnId: string,
): Array<Extract<AnyEvent, { type: "tool.requested" }>> {
  const terminal = new Set<string>();
  for (const event of events) {
    if (event.type === "tool.succeeded" || event.type === "tool.failed") {
      terminal.add(event.payload.operationId);
    }
  }
  return events.filter((event): event is Extract<AnyEvent, { type: "tool.requested" }> => (
    event.type === "tool.requested"
    && event.turnId === turnId
    && !terminal.has(event.payload.operationId)
  ));
}

async function assertSameAdmission(
  store: ContentAddressedStore,
  event: Extract<AnyEvent, { type: "input.admitted" }>,
  request: SessionSubmitRequest,
): Promise<void> {
  const message = await readUserMessage(store, event.payload.messageRef);
  const requestedDelivery = request.delivery ?? event.payload.delivery;
  if (
    stableJson({ text: message.content, images: message.images ?? [] })
      !== stableJson({ text: request.text, images: request.images ?? [] })
    || requestedDelivery !== event.payload.delivery
  ) {
    throw new SessionProtocolError(
      `Input id ${request.inputId} was reused with different content or delivery`,
    );
  }
}

function outputLimitContinuationMessageId(
  events: readonly AnyEvent[],
  turnId: string,
): string | undefined {
  const waiting = [...events].reverse().find((event): event is Extract<AnyEvent, {
    type: "turn.waiting";
  }> => (
    event.type === "turn.waiting"
    && event.payload.turnId === turnId
    && event.payload.reason === "model-output-limit"
  ));
  if (waiting === undefined) return undefined;
  const resumed = [...events].reverse().find((event): event is Extract<AnyEvent, {
    type: "turn.resumed";
  }> => event.type === "turn.resumed" && event.payload.turnId === turnId);
  return resumed !== undefined && resumed.globalOffset > waiting.globalOffset
    ? `output-limit-continuation:${resumed.eventId}`
    : undefined;
}

async function readTurnObjective(
  store: ContentAddressedStore,
  events: readonly AnyEvent[],
  turn: Pick<ActiveTurn, "turnId" | "inputId">,
): Promise<string> {
  const runId = events[0]?.runId;
  const input = runId === undefined
    ? undefined
    : projectRun(events, runId).inputs.find((candidate) => candidate.inputId === turn.inputId);
  if (input === undefined) {
    throw new SessionProtocolError(
      `Turn ${turn.turnId} is missing its admitted input ${turn.inputId}`,
    );
  }
  const text = await readUserText(store, input.messageRef);
  return text.trim().length === 0 ? "Analyze the attached image(s)" : text;
}

function capabilitiesForPermissionProfile(
  profile: SelectableSessionPermissionProfile,
): { allowWrite: boolean; allowShell: boolean; allowNetwork: boolean } {
  switch (profile) {
    case "read-only":
      return { allowWrite: false, allowShell: false, allowNetwork: false };
    case "workspace":
      return { allowWrite: true, allowShell: false, allowNetwork: false };
    case "full-access":
      return { allowWrite: true, allowShell: true, allowNetwork: true };
  }
}

function restrictTurnExecutionBoundary(
  persisted: TurnExecutionBoundary | undefined,
  host: TurnExecutionBoundary,
): TurnExecutionBoundary {
  // Schema-v1 Turns did not persist this boundary. Resume them fail-closed so
  // a process restart cannot silently turn an old planning Turn into mutation.
  const durable = persisted ?? {
    collaborationMode: "plan",
    capabilities: { allowWrite: false, allowShell: false, allowNetwork: false },
  };
  return {
    collaborationMode: durable.collaborationMode === "plan"
      || host.collaborationMode === "plan"
      ? "plan"
      : "default",
    capabilities: {
      allowWrite: durable.capabilities.allowWrite && host.capabilities.allowWrite,
      allowShell: durable.capabilities.allowShell && host.capabilities.allowShell,
      allowNetwork: durable.capabilities.allowNetwork && host.capabilities.allowNetwork,
    },
  };
}

function permissionProfileForCapabilities(capabilities: {
  allowWrite: boolean;
  allowShell: boolean;
  allowNetwork: boolean;
}): SessionPermissionProfile {
  if (!capabilities.allowWrite && !capabilities.allowShell && !capabilities.allowNetwork) {
    return "read-only";
  }
  if (capabilities.allowWrite && !capabilities.allowShell && !capabilities.allowNetwork) {
    return "workspace";
  }
  if (capabilities.allowWrite && capabilities.allowShell && capabilities.allowNetwork) {
    return "full-access";
  }
  return "custom";
}

function normalizePermissionProfile(
  profile: SelectableSessionPermissionProfile,
): SelectableSessionPermissionProfile {
  if (profile !== "read-only" && profile !== "workspace" && profile !== "full-access") {
    throw new SessionProtocolError(
      "permission profile must be read-only, workspace, or full-access",
    );
  }
  return profile;
}

function normalizeCollaborationMode(mode: SessionCollaborationMode): SessionCollaborationMode {
  if (mode !== "default" && mode !== "plan") {
    throw new SessionProtocolError("collaboration mode must be default or plan");
  }
  return mode;
}

function validateOptions(options: SessionControllerOptions): void {
  if (options.workspace.length === 0 || options.dataDir.length === 0 || options.model.length === 0) {
    throw new SessionProtocolError("workspace, dataDir, and model are required");
  }
  for (const [name, selector] of [
    ["model", options.model],
    ["tetoModel", options.tetoModel],
    ["workerModel", options.workerModel],
  ] as const) {
    if (selector === undefined) continue;
    try {
      normalizeModelSelector(selector);
    } catch (error: unknown) {
      throw new SessionProtocolError(
        `${name}: ${error instanceof Error ? error.message : "invalid model selector"}`,
      );
    }
  }
  if (options.workerEnabled !== undefined && typeof options.workerEnabled !== "boolean") {
    throw new SessionProtocolError("workerEnabled must be a boolean");
  }
  if (options.collaborationMode !== undefined) {
    normalizeCollaborationMode(options.collaborationMode);
  }
  if (
    options.processJobRegistryDir !== undefined
    && (
      typeof options.processJobRegistryDir !== "string"
      || options.processJobRegistryDir.trim().length === 0
      || options.processJobRegistryDir.includes("\0")
    )
  ) {
    throw new SessionProtocolError(
      "processJobRegistryDir must be a non-empty path without NUL",
    );
  }
  if (options.fukaiCompaction !== undefined) {
    try {
      normalizeFukaiCompactionPolicy(options.fukaiCompaction);
    } catch (error: unknown) {
      throw new SessionProtocolError(
        error instanceof Error ? error.message : "Invalid fukaiCompaction policy",
      );
    }
  }
  if (options.runId !== undefined) validateRunId(options.runId);
  if (
    options.maxOutputTokens !== undefined
    && (
      !Number.isSafeInteger(options.maxOutputTokens)
      || options.maxOutputTokens < 1
      || options.maxOutputTokens > MAX_MAIN_OUTPUT_TOKENS
    )
  ) {
    throw new SessionProtocolError(
      `maxOutputTokens must be an integer from 1 to ${MAX_MAIN_OUTPUT_TOKENS}`,
    );
  }
}

const validateRequestedFukaiPolicy = (
  requested: FukaiCompactionPolicy | undefined,
  recorded: FukaiCompactionPolicy | undefined,
): void => {
  if (requested === undefined || recorded === undefined) {
    if (requested?.enabled === true && recorded === undefined) {
      throw new SessionProtocolError(
        "Cannot enable Fukai compaction while resuming a Run without a recorded policy",
      );
    }
    return;
  }
  if (!sameFukaiCompactionPolicy(
    normalizeFukaiCompactionPolicy(requested),
    normalizeFukaiCompactionPolicy(recorded),
  )) {
    throw new SessionProtocolError("Cannot change fukaiCompaction while resuming a Run");
  }
};

const sameFukaiCompactionPolicy = (
  left: FukaiCompactionPolicy,
  right: FukaiCompactionPolicy,
): boolean => left.enabled === right.enabled
  && left.provider === right.provider
  && left.maxInputTokens === right.maxInputTokens
  && left.maxOutputTokens === right.maxOutputTokens
  && left.maxWallClockMs === right.maxWallClockMs
  && left.thresholdRatio === right.thresholdRatio
  && left.retainRatio === right.retainRatio
  && left.minimumGainTokens === right.minimumGainTokens;

function validateSubmit(request: SessionSubmitRequest): void {
  if (
    typeof request.inputId !== "string"
    || request.inputId.length === 0
    || request.inputId.includes("\0")
  ) {
    throw new SessionProtocolError("inputId must be a non-empty string without NUL");
  }
  if (typeof request.text !== "string" || request.text.includes("\0")) {
    throw new SessionProtocolError("Input text must be a string without NUL");
  }
  try {
    validateUserImages(request.images);
  } catch (error: unknown) {
    throw new SessionProtocolError("Input images are invalid", { cause: error });
  }
  if (request.text.trim().length === 0 && (request.images?.length ?? 0) === 0) {
    throw new SessionProtocolError("Input text or images are required");
  }
}

function validatePendingMutationIdentity(inputId: string, expectedRevision: number): void {
  if (inputId.length === 0 || inputId.includes("\0")) {
    throw new SessionProtocolError("inputId must be a non-empty string without NUL");
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new SessionProtocolError("expectedRevision must be a positive safe integer");
  }
  if (expectedRevision >= Number.MAX_SAFE_INTEGER) {
    throw new SessionProtocolError("Input revision is exhausted");
  }
}

function validatePendingReplacementShape(replacement: SessionPendingInputReplacement): void {
  if (replacement === null || typeof replacement !== "object") {
    throw new SessionProtocolError("Pending input replacement must be an object");
  }
  if (replacement.delivery !== "steering" && replacement.delivery !== "follow-up") {
    throw new SessionProtocolError("Replacement delivery must be steering or follow-up");
  }
}

function validateRunId(runId: string): void {
  if (!isValidRunId(runId)) {
    throw new SessionProtocolError("Run id contains unsupported characters");
  }
}

function isValidRunId(runId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

async function settlesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(false), milliseconds);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
