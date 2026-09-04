import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type { AnyEvent, TurnExecutionBoundary } from "../domain/events.js";
import type { ArtifactRef, ConversationMessage, TokenUsage } from "../domain/types.js";
import { projectRun, projectTaskGraph } from "../ledger/index.js";
import { FileContentAddressedStore } from "../store/index.js";
import type { ContentAddressedStore } from "../store/store.js";
import {
  readConversationArtifact,
  readToolArgumentsFromStore,
  projectPendingInputs,
  projectSessionCompactionNotices,
  projectSessionTranscript,
  type SessionPendingInput,
  type SessionCompactionNotice,
  type SessionTranscriptEntry,
} from "./session-artifacts.js";
import type {
  SessionCollaborationMode,
  SessionContextOverview,
  SessionPermissionProfile,
  SessionSnapshot,
  WorkerTaskSummary,
} from "./session-controller.js";
import {
  recoverRunTokenUsage,
  recoverRunTokenUsageByLane,
  type RecoveredLaneUsage,
} from "./run-token-budget-recovery.js";
import {
  DaemonRemoteAttachment,
  type DaemonRemoteAttachmentSnapshot,
  type DaemonRemoteAttachmentStatus,
} from "./daemon-remote-attachment.js";
import { DaemonControlClientError } from "./daemon-control-client.js";

export interface DaemonRemoteSessionOptions {
  readonly attachment: DaemonRemoteAttachment;
  readonly workspace: string;
  readonly dataDir: string;
  /** Schema-v1 Runs may not contain model.selected. */
  readonly model: string;
  readonly collaborationMode?: SessionCollaborationMode;
}

export interface DaemonRemoteSessionState {
  readonly snapshot: SessionSnapshot;
  readonly attachmentStatus: DaemonRemoteAttachmentStatus;
  readonly error?: string;
}

/** Read-only Session-shaped projection consumed by the remote TUI. */
export class DaemonRemoteSession {
  readonly workspace: string;
  readonly dataDir: string;
  readonly runId: string;

  private readonly attachment: DaemonRemoteAttachment;
  private readonly fallbackModel: string;
  private readonly fallbackBoundary: TurnExecutionBoundary;
  private readonly store: ContentAddressedStore;
  private readonly listeners = new Set<(state: DaemonRemoteSessionState) => void>();
  private readonly unsubscribeAttachment: () => void;
  private attachmentSnapshot: DaemonRemoteAttachmentSnapshot;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  private constructor(
    options: DaemonRemoteSessionOptions,
    workspace: string,
    dataDir: string,
    store: ContentAddressedStore,
  ) {
    this.attachment = options.attachment;
    this.attachmentSnapshot = options.attachment.snapshot();
    this.workspace = workspace;
    this.dataDir = dataDir;
    this.runId = options.attachment.runId;
    this.fallbackModel = selectedModel(options.model);
    this.fallbackBoundary = {
      collaborationMode: options.collaborationMode ?? "default",
      capabilities: {
        allowWrite: false,
        allowShell: false,
        allowNetwork: false,
      },
    };
    this.store = store;
    this.unsubscribeAttachment = options.attachment.subscribe((snapshot) => {
      this.attachmentSnapshot = snapshot;
      this.publish();
    });
  }

  static async open(options: DaemonRemoteSessionOptions): Promise<DaemonRemoteSession> {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new DaemonControlClientError("invalid_options", "remote Session options must be an object");
    }
    if (!(options.attachment instanceof DaemonRemoteAttachment)) {
      throw new DaemonControlClientError(
        "invalid_options",
        "remote Session attachment must be a DaemonRemoteAttachment",
      );
    }
    if (
      typeof options.workspace !== "string"
      || options.workspace.trim().length === 0
      || options.workspace.includes("\0")
      || typeof options.dataDir !== "string"
      || options.dataDir.trim().length === 0
      || options.dataDir.includes("\0")
    ) {
      throw new DaemonControlClientError(
        "invalid_options",
        "workspace and dataDir must be non-empty paths without NUL",
      );
    }
    if (
      options.collaborationMode !== undefined
      && options.collaborationMode !== "default"
      && options.collaborationMode !== "plan"
    ) {
      throw new DaemonControlClientError(
        "invalid_options",
        "collaborationMode must be default or plan",
      );
    }
    const workspace = await realpath(resolve(options.workspace));
    const dataDir = resolve(options.dataDir);
    const attachment = options.attachment.snapshot();
    const projection = requireCreationFacts(attachment.events, attachment.runId);
    const recordedWorkspace = await realpath(projection.run.workspace!);
    if (recordedWorkspace !== workspace) {
      throw new DaemonControlClientError(
        "workspace_mismatch",
        `Run ${attachment.runId} belongs to ${recordedWorkspace}, not ${workspace}`,
      );
    }
    const storeRoot = resolve(dataDir, "runs", attachment.runId, "store");
    await assertExistingDirectory(storeRoot, "Run Store");
    await assertExistingDirectory(resolve(storeRoot, "objects"), "Run Store objects");
    const store = await FileContentAddressedStore.open(storeRoot);
    return new DaemonRemoteSession(options, workspace, dataDir, store);
  }

  snapshot(): SessionSnapshot {
    const events = this.attachmentSnapshot.events;
    const projection = projectRun(events, this.runId);
    const boundary = latestTurnBoundary(events) ?? this.fallbackBoundary;
    const model = projection.lanes.main?.model ?? this.fallbackModel;
    const usage = recoverRunTokenUsage(events, this.runId);
    const activeTurn = projection.activeTurnId === undefined
      ? undefined
      : projection.turns[projection.activeTurnId];
    const connectionStatus = this.attachmentSnapshot.status;
    const status = this.closed || connectionStatus === "closed"
      ? "closed" as const
      : connectionStatus !== "attached"
        ? "detached" as const
        : activeTurn === undefined
          ? "idle" as const
          : "running" as const;
    const pendingInputs = projection.inputs.filter((input) => input.status === "pending").length;
    const policy = projection.run.policy;
    const blocker = blockingReason(projection);
    return {
      workspace: this.workspace,
      runId: this.runId,
      ...(projection.activeTurnId === undefined ? {} : { turnId: projection.activeTurnId }),
      ...(projection.threadGoal === undefined ? {} : { goal: structuredClone(projection.threadGoal) }),
      status,
      model,
      tetoEnabled: policy?.tetoEnabled === true,
      workerEnabled: policy?.workerEnabled === true,
      permissionProfile: permissionProfile(boundary.capabilities),
      collaborationMode: boundary.collaborationMode,
      ...boundary.capabilities,
      workspaceBashAvailability: {
        available: false,
        reason: "Remote attachment does not expose the daemon command sandbox",
      },
      pendingInputs,
      lastCommittedStep: activeTurn?.lastCommittedStep ?? latestCommittedStep(projection.turns),
      mainContextTokens: latestMainContextTokens(events, model),
      mainContextWindowTokens: null,
      usage,
      ...(blocker === undefined ? {} : { blocker }),
    };
  }

  state(): DaemonRemoteSessionState {
    return {
      snapshot: this.snapshot(),
      attachmentStatus: this.attachmentSnapshot.status,
      ...(this.attachmentSnapshot.error === undefined
        ? {}
        : { error: this.attachmentSnapshot.error }),
    };
  }

  subscribe(listener: (state: DaemonRemoteSessionState) => void): () => void {
    if (typeof listener !== "function") {
      throw new DaemonControlClientError("invalid_listener", "remote Session listener must be a function");
    }
    this.assertOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  contextOverview(): SessionContextOverview {
    this.assertOpen();
    const snapshot = this.snapshot();
    return {
      model: snapshot.model,
      currentContext: {
        tokens: snapshot.mainContextTokens,
        contextWindowTokens: snapshot.mainContextWindowTokens,
        percent: null,
      },
      usage: structuredClone(snapshot.usage),
      lanes: ensureVisibleLanes(
        recoverRunTokenUsageByLane(this.attachmentSnapshot.events, this.runId),
        snapshot.tetoEnabled,
        snapshot.workerEnabled,
      ),
    };
  }

  workerTaskSummary(): WorkerTaskSummary {
    this.assertOpen();
    const summary = emptyWorkerTaskSummary();
    const tasks = projectTaskGraph(this.attachmentSnapshot.events, this.runId).tasks;
    summary.total = tasks.length;
    for (const task of tasks) {
      const terminal = task.state.kind === "delegated" ? undefined : task.state.terminal;
      if (task.state.kind === "stale") summary.stale += 1;
      else if (terminal?.type === "task.failed") summary.failed += 1;
      else if (task.state.kind === "joined") summary.done += 1;
      else if (task.state.kind === "terminal") summary.ready += 1;
      else if (task.accept === undefined) summary.queued += 1;
      else summary.running += 1;
    }
    return summary;
  }

  async transcript(): Promise<SessionTranscriptEntry[]> {
    this.assertOpen();
    return projectSessionTranscript(this.store, this.attachmentSnapshot.events, this.runId);
  }

  /** Project compaction lifecycle from the attachment's replayed Ledger facts. */
  async compactionHistory(): Promise<SessionCompactionNotice[]> {
    this.assertOpen();
    return projectSessionCompactionNotices(this.attachmentSnapshot.events, this.runId);
  }

  async pendingInputs(): Promise<SessionPendingInput[]> {
    this.assertOpen();
    return projectPendingInputs(this.store, this.attachmentSnapshot.events);
  }

  async readConversationMessage(ref: ArtifactRef): Promise<ConversationMessage> {
    this.assertOpen();
    return readConversationArtifact(this.store, ref);
  }

  async readToolArguments(ref: ArtifactRef): Promise<Record<string, unknown>> {
    this.assertOpen();
    return readToolArgumentsFromStore(this.store, ref);
  }

  async close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    const operation = this.performClose();
    this.closePromise = operation;
    return operation;
  }

  private async performClose(): Promise<void> {
    this.closed = true;
    this.unsubscribeAttachment();
    await this.attachment.close();
    this.attachmentSnapshot = this.attachment.snapshot();
    this.publish();
    this.listeners.clear();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new DaemonControlClientError("closed", "remote Session is closed");
    }
  }

  private publish(): void {
    if (this.listeners.size === 0) return;
    const state = this.state();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // TUI observers cannot own the durable projection.
      }
    }
  }
}

function requireCreationFacts(events: readonly AnyEvent[], runId: string) {
  const projection = projectRun(events, runId);
  if (
    projection.run.policy === undefined
    || projection.run.workspace === undefined
  ) {
    throw new DaemonControlClientError(
      "invalid_run",
      `Run ${runId} is missing creation facts`,
    );
  }
  return projection;
}

async function assertExistingDirectory(path: string, label: string): Promise<void> {
  const stat = await lstat(path).catch((error: unknown) => {
    throw new DaemonControlClientError(
      "invalid_run",
      `${label} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new DaemonControlClientError("invalid_run", `${label} must be a real directory`);
  }
}

function selectedModel(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new DaemonControlClientError("invalid_options", "model must be a non-empty selector");
  }
  return value.trim();
}

function latestTurnBoundary(events: readonly AnyEvent[]): TurnExecutionBoundary | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "turn.started" && event.payload.boundary !== undefined) {
      return structuredClone(event.payload.boundary);
    }
  }
  return undefined;
}

function permissionProfile(
  capabilities: TurnExecutionBoundary["capabilities"],
): SessionPermissionProfile {
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

function latestCommittedStep(turns: ReturnType<typeof projectRun>["turns"]): number {
  return Object.values(turns).reduce(
    (highest, turn) => Math.max(highest, turn.lastCommittedStep),
    0,
  );
}

function latestMainContextTokens(events: readonly AnyEvent[], model: string): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.laneId !== "main") continue;
    if (event.type === "model.selected") return null;
    if (event.type !== "model.requested") continue;
    if (event.payload.model !== model) return null;
    return Number.isSafeInteger(event.payload.estimatedInputTokens)
      && (event.payload.estimatedInputTokens ?? -1) >= 0
      ? event.payload.estimatedInputTokens ?? null
      : null;
  }
  return null;
}

function blockingReason(projection: ReturnType<typeof projectRun>): string | undefined {
  const unknown = projection.unknownOperations[0];
  if (unknown !== undefined) return `operation-unknown:${unknown.operationId}`;
  const waiting = Object.values(projection.turns)
    .filter((turn) => turn.status === "waiting" || turn.status === "interrupted")
    .sort((left, right) => right.lastOffset - left.lastOffset)[0];
  return waiting?.reason;
}

function ensureVisibleLanes(
  recovered: readonly RecoveredLaneUsage[],
  tetoEnabled: boolean,
  workerEnabled: boolean,
): RecoveredLaneUsage[] {
  const byLane = new Map(recovered.map((lane) => [lane.laneId, structuredClone(lane)]));
  const ensure = (laneId: string): void => {
    if (!byLane.has(laneId)) byLane.set(laneId, { laneId, usage: emptyUsage() });
  };
  ensure("main");
  if (tetoEnabled) ensure("teto");
  if (workerEnabled) ensure("worker");
  const priority = new Map([["main", 0], ["teto", 1], ["reflection", 2], ["worker", 3]]);
  return [...byLane.values()].sort((left, right) => (
    (priority.get(left.laneId) ?? 4) - (priority.get(right.laneId) ?? 4)
      || left.laneId.localeCompare(right.laneId)
  ));
}

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function emptyWorkerTaskSummary(): WorkerTaskSummary {
  return { total: 0, queued: 0, running: 0, ready: 0, done: 0, failed: 0, stale: 0 };
}
