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
} from "../domain/events.js";
import type { AgentTool, Clock, ModelPort } from "../domain/ports.js";
import { systemClock } from "../domain/ports.js";
import type {
  ArtifactRef,
  ConversationMessage,
  Goal,
  RunPolicy,
  TokenUsage,
} from "../domain/types.js";
import { mainStepAllowance } from "../domain/types.js";
import {
  ContentStoreFukaiSource,
  FukaiContextProvider,
  type FukaiConversationRef,
} from "../fukai/index.js";
import {
  JsonlLedger,
  type Ledger,
  projectRun,
  validateEvent,
} from "../ledger/index.js";
import { createOpenRouterModelPort } from "../model/index.js";
import {
  FileContentAddressedStore,
  type ContentAddressedStore,
} from "../store/index.js";
import { IntentNavigator, ObservationFrameBuilder } from "../teto/index.js";
import { createWorkspaceTools } from "../tools/index.js";
import { createAdviceResponseTool } from "./advice-tool.js";
import {
  MainLoop,
  type MainBoundaryMessage,
  type MainStreamEvent,
} from "./main-loop.js";
import { commitRunCheckpoint, resolvePendingToolOperation } from "./recovery.js";
import { persistedErrorText } from "./redaction.js";
import { TetoScheduler } from "./teto-scheduler.js";

const MESSAGE_MEDIA_TYPE = "application/vnd.nausicaa.conversation-message+json";
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

export interface SessionSnapshot {
  workspace: string;
  runId?: string;
  turnId?: string;
  status: SessionControllerStatus;
  model: string;
  tetoEnabled: boolean;
  allowWrite: boolean;
  pendingInputs: number;
  lastCommittedStep: number;
  usage: TokenUsage;
  blocker?: string;
}

export interface SessionTranscriptEntry {
  role: "user" | "assistant" | "tool";
  content: string;
  turnId: string;
}

export interface SessionSubmitRequest {
  inputId: string;
  text: string;
  delivery?: InputDelivery;
}

export interface SessionSubmitResult {
  inputId: string;
  turnId?: string;
  status: "admitted" | "duplicate";
  delivery: InputDelivery;
}

export interface SessionControllerOptions {
  workspace: string;
  dataDir: string;
  model: string;
  tetoModel?: string;
  policy?: Partial<RunPolicy>;
  allowWrite?: boolean;
  runId?: string;
}

export interface SessionControllerDeps {
  mainModel?: ModelPort;
  tetoModel?: ModelPort;
  tools?: readonly AgentTool[];
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
}

interface Admission {
  event: Extract<AnyEvent, { type: "input.admitted" }>;
}

interface ActiveTurn {
  turnId: string;
  inputId: string;
  controller: AbortController;
}

export class SessionProtocolError extends Error {
  override readonly name = "SessionProtocolError";
}

export class SessionController {
  readonly workspace: string;
  readonly dataDir: string;
  readonly model: string;
  readonly tetoModel: string;
  readonly allowWrite: boolean;

  private readonly deps: SessionControllerDeps;
  private readonly clock: Clock;
  private readonly policy: RunPolicy;
  private readonly listeners = new Set<(event: SessionRuntimeEvent) => void>();
  private attached: AttachedRun | undefined;
  private active: ActiveTurn | undefined;
  private status: SessionControllerStatus = "detached";
  private admissionTail: Promise<void> = Promise.resolve();
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
    this.model = options.model;
    this.tetoModel = options.tetoModel ?? options.model;
    this.allowWrite = options.allowWrite === true;
    this.deps = deps;
    this.clock = deps.clock ?? systemClock;
    this.policy = resolveSessionPolicy(options.policy);
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

  snapshot(): SessionSnapshot {
    const events = this.attached?.sink.cachedEvents ?? [];
    const usage = usageFromEvents(events);
    const pending = pendingAdmissions(events);
    const blocker = blockingReason(events);
    return {
      workspace: this.workspace,
      ...(this.attached === undefined ? {} : { runId: this.attached.runId }),
      ...(this.active === undefined ? {} : { turnId: this.active.turnId }),
      status: this.status,
      model: this.model,
      tetoEnabled: this.attached?.policy.tetoEnabled ?? this.policy.tetoEnabled,
      allowWrite: this.allowWrite,
      pendingInputs: pending.length,
      lastCommittedStep: this.active === undefined
        ? 0
        : highestTurnStep(events, this.active.turnId),
      usage,
      ...(blocker === undefined ? {} : { blocker }),
    };
  }

  async transcript(): Promise<SessionTranscriptEntry[]> {
    this.assertOpen();
    const attached = this.requireAttached();
    const events = await attached.ledger.read({ runId: attached.runId });
    const transcript: SessionTranscriptEntry[] = [];
    for (const event of events) {
      if (
        event.type !== "user.message"
        && event.type !== "assistant.message"
        && event.type !== "tool.succeeded"
        && event.type !== "tool.failed"
      ) continue;
      const ref = event.type === "tool.succeeded" || event.type === "tool.failed"
        ? event.payload.resultRef
        : event.payload.messageRef;
      const message = await readConversationArtifact(attached.store, ref);
      transcript.push({
        role: message.role,
        content: message.content,
        turnId: event.turnId ?? legacyTurnIdForTranscript(attached.runId),
      });
    }
    return transcript;
  }

  async submit(request: SessionSubmitRequest): Promise<SessionSubmitResult> {
    return this.runAdmission(async () => {
      this.assertOpen();
      validateSubmit(request);
      if (this.attached === undefined) {
        await this.createRun(request.text);
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

      if (pendingAdmissions(events).length >= MAX_PENDING_INPUTS) {
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
        turnId = promoted.turnId;
        this.startExecution(promoted);
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
        const pending = pendingAdmissions(events)[0];
        if (pending !== undefined) {
          const promoted = await this.promote({ event: pending }, "resume-pending");
          this.startExecution(promoted);
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
        attached.ledger,
        attached.store,
        attached.runId,
        operationId,
        { clock: this.clock },
      );
      attached.sink.replaceCache(await attached.ledger.read({ runId: attached.runId }));
      this.publishState();
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
        candidate.sink.deactivate();
        await candidate.ledger.close().catch(() => undefined);
        throw error;
      }
      const previous = this.attached;
      this.attached = candidate;
      if (previous !== undefined) {
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
        await commitRunCheckpoint(this.attached.ledger, this.attached.runId).catch(() => undefined);
      }
      await this.detach();
      this.status = "closed";
      this.publishState();
      this.listeners.clear();
    });
    this.closePromise = closePromise;
    await closePromise;
  }

  private async createRun(firstMessage: string): Promise<void> {
    const runId = (this.deps.createRunId ?? randomUUID)();
    validateRunId(runId);
    const stateDir = resolve(this.dataDir, "runs", runId);
    const ledger = await JsonlLedger.open(resolve(stateDir, "ledger.jsonl"));
    try {
      const store = await FileContentAddressedStore.open(resolve(stateDir, "store"));
      const sink = new SessionEventSink(ledger, [], (event) => this.publish(event));
      const goal: Goal = {
        version: 1,
        statement: firstMessage,
        successCriteria: ["Produce a grounded result for the requested task"],
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
      this.attached = { runId, ledger, sink, store, goal, policy: this.policy };
      this.status = "idle";
    } catch (error: unknown) {
      await ledger.close();
      throw error;
    }
  }

  private async openAttachment(runId: string): Promise<AttachedRun> {
    const stateDir = resolve(this.dataDir, "runs", runId);
    const ledger = await JsonlLedger.open(resolve(stateDir, "ledger.jsonl"));
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
      return {
        runId,
        ledger,
        sink: new SessionEventSink(ledger, events, (event) => this.publish(event)),
        store,
        goal: projection.goal,
        policy: projection.run.policy,
      };
    } catch (error: unknown) {
      await ledger.close().catch(() => undefined);
      throw error;
    }
  }

  private async promote(
    admission: Admission,
    boundary: string,
  ): Promise<{ turnId: string; inputId: string }> {
    const attached = this.requireAttached();
    const inputId = admission.event.payload.inputId;
    let events = await attached.ledger.read({ runId: attached.runId });
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
        payload: { turnId, inputId, ordinal: nextTurnOrdinal(events) },
        causationId: admission.event.eventId,
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
        payload: { inputId, turnId, boundary },
        causationId: started.eventId,
        correlationId: `turn:${turnId}`,
        idempotencyKey: `${attached.runId}:input:${inputId}:delivered`,
        visibility: "run",
        occurredAt: this.clock.now().toISOString(),
      });
      events = attached.sink.cachedEvents;
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
          messageRef: admission.event.payload.messageRef,
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
      const used = totalTokens(usageFromEvents(events));
      const remaining = Math.max(0, attached.policy.maxModelTokens - used);
      if (remaining === 0) {
        await this.failRunBudget(turn.turnId);
        return;
      }
      const model = this.deps.mainModel ?? createOpenRouterModelPort();
      const inbox = new A2AInbox({ sink: attached.sink, events, clock: this.clock });
      const tools = [...(this.deps.tools ?? createWorkspaceTools({
        allowWrite: this.allowWrite,
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
          signal: turn.controller.signal,
        });
      }
      const loop = new MainLoop({
        model,
        contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(attached.store)),
        conversationStore: attached.store,
        eventSink: attached.sink,
        tools,
        clock: this.clock,
        beforeStep: async ({ step }) => [
          ...await this.deliverSteering(turn.turnId, step),
          ...await (scheduler?.beforeMainStep() ?? Promise.resolve([])),
        ],
        ...(scheduler === undefined
          ? {}
          : { afterStep: (context) => scheduler!.enqueue(context) }),
        onStreamEvent: (event) => this.publish({ kind: "stream", event }),
      });
      const latestEvents = await attached.ledger.read({ runId: attached.runId });
      const result = await loop.run({
        runId: attached.runId,
        turnId: turn.turnId,
        goal: attached.goal,
        model: this.model,
        workspace: this.workspace,
        policy: { ...attached.policy, maxModelTokens: remaining },
        conversationRefs: conversationRefs(latestEvents),
        upperWatermark: latestEvents.at(-1)?.globalOffset ?? 0,
        startStep: highestTurnStep(latestEvents, turn.turnId) + 1,
        completeRun: false,
        signal: turn.controller.signal,
      });
      await settlesWithin(scheduler?.drain() ?? Promise.resolve(), 25);
      await scheduler?.stop();
      if (!result.completed) {
        await attached.sink.append({
          runId: attached.runId,
          turnId: turn.turnId,
          laneId: "main",
          type: "turn.waiting",
          payload: {
            turnId: turn.turnId,
            reason: "step-allowance-exhausted",
            lastCommittedStep: highestTurnStep(attached.sink.cachedEvents, turn.turnId),
            resumeRequires: "explicit-resume",
          },
          correlationId: `turn:${turn.turnId}`,
          idempotencyKey: `${attached.runId}:turn:${turn.turnId}:waiting:${highestTurnStep(attached.sink.cachedEvents, turn.turnId)}`,
          visibility: "run",
          occurredAt: this.clock.now().toISOString(),
        });
      }
    } catch (error: unknown) {
      await scheduler?.stop().catch(() => undefined);
      if (turn.controller.signal.aborted) {
        await this.appendTurnCancelled(turn.turnId, persistedErrorText(
          turn.controller.signal.reason,
          "Cancelled by user",
        ));
      } else {
        await attached.sink.append({
          runId: attached.runId,
          turnId: turn.turnId,
          laneId: "main",
          type: "turn.failed",
          payload: { turnId: turn.turnId, error: persistedErrorText(error) },
          correlationId: `turn:${turn.turnId}`,
          idempotencyKey: `${attached.runId}:turn:${turn.turnId}:failed`,
          visibility: "run",
          occurredAt: this.clock.now().toISOString(),
        });
      }
    } finally {
      await scheduler?.stop().catch(() => undefined);
      if (this.status !== "closed") {
        await commitRunCheckpoint(attached.ledger, attached.runId).catch(() => undefined);
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
    const attached = this.requireAttached();
    const events = await attached.ledger.read({ runId: attached.runId });
    const deliveredIds = new Set(events
      .filter((event) => event.type === "input.delivered")
      .map((event) => event.payload.inputId));
    const steering = events
      .filter((event): event is Extract<AnyEvent, { type: "input.admitted" }> => (
        event.type === "input.admitted"
        && event.payload.delivery === "steering"
        && event.payload.targetTurnId === turnId
        && !deliveredIds.has(event.payload.inputId)
      ))
      .sort((left, right) => left.payload.sequence - right.payload.sequence);
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
        },
        causationId: admission.eventId,
        correlationId: `turn:${turnId}`,
        idempotencyKey: `${attached.runId}:input:${admission.payload.inputId}:delivered`,
        visibility: "run",
        occurredAt: this.clock.now().toISOString(),
      });
      await attached.sink.append({
        runId: attached.runId,
        turnId,
        laneId: "main",
        type: "user.message",
        payload: {
          inputId: admission.payload.inputId,
          messageRef: admission.payload.messageRef,
          kind: "steering",
        },
        causationId: delivered.eventId,
        correlationId: `turn:${turnId}`,
        idempotencyKey: `${attached.runId}:input:${admission.payload.inputId}:user-message`,
        visibility: "user",
        occurredAt: this.clock.now().toISOString(),
      });
      messages.push({
        kind: "steering",
        source: "user",
        content: await readUserText(attached.store, admission.payload.messageRef),
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
    const pending = pendingAdmissions(events)[0];
    if (pending === undefined) return;
    const promoted = await this.promote({ event: pending },
      pending.payload.delivery === "steering"
        ? "retargeted-after-terminal"
        : "queued-after-terminal");
    this.startExecution(promoted, previousExecution);
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
  }

  private async detach(): Promise<void> {
    const attached = this.attached;
    this.attached = undefined;
    this.active = undefined;
    this.execution = undefined;
    if (attached !== undefined) {
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
      attached.sink.deactivate();
      await commitRunCheckpoint(attached.ledger, attached.runId).catch(() => undefined);
      await attached.ledger.close().catch(() => undefined);
    }
    if (this.status !== "closed") {
      this.status = "detached";
      this.publishState();
    }
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

class SessionEventSink {
  private active = true;
  private events: AnyEvent[];

  constructor(
    private readonly ledger: Ledger,
    events: readonly AnyEvent[],
    private readonly onEvent: (event: SessionRuntimeEvent) => void,
  ) {
    this.events = [...events];
  }

  get cachedEvents(): AnyEvent[] {
    return this.events.map((event) => structuredClone(event));
  }

  replaceCache(events: readonly AnyEvent[]): void {
    this.events = [...events];
  }

  deactivate(): void {
    this.active = false;
  }

  async append<K extends EventType>(input: AppendEvent<K>): Promise<EventEnvelope<K>> {
    if (!this.active) throw new SessionProtocolError("Session event sink is closed");
    const event = await this.ledger.append(input);
    // Detach may race the ledger write. The event is durable and will be
    // replayed on the next attachment, but a retired surface must not publish
    // it into the new attachment's event stream or cache.
    if (!this.active) return event;
    if (!this.events.some((candidate) => candidate.eventId === event.eventId)) {
      this.events.push(event as AnyEvent);
      this.onEvent({ kind: "event", event: event as AnyEvent });
    }
    return event;
  }
}

export async function findLatestRunId(
  dataDir: string,
  workspace: string,
): Promise<string | undefined> {
  const canonicalWorkspace = await realpath(resolve(workspace));
  const runsDir = resolve(dataDir, "runs");
  let entries;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const candidates: Array<{ runId: string; occurredAt: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidRunId(entry.name)) continue;
    const ledgerPath = join(runsDir, entry.name, "ledger.jsonl");
    const info = await lstat(ledgerPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (info === undefined) continue;
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new SessionProtocolError(`Invalid Ledger candidate: ${ledgerPath}`);
    }
    const events = parseCommittedEvents(await readFile(ledgerPath), ledgerPath);
    const created = events.find((event) => event.type === "run.created");
    if (created === undefined) {
      throw new SessionProtocolError(`Run ${entry.name} is missing run.created`);
    }
    const recordedWorkspace = await realpath(created.payload.workspace).catch(() => undefined);
    if (recordedWorkspace !== canonicalWorkspace) continue;
    candidates.push({
      runId: entry.name,
      occurredAt: events.at(-1)?.occurredAt ?? created.occurredAt,
    });
  }
  candidates.sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt)
    || left.runId.localeCompare(right.runId));
  return candidates.at(-1)?.runId;
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

function resolveSessionPolicy(input: Partial<RunPolicy> = {}): RunPolicy {
  const policy: RunPolicy = {
    maxMainStepsPerActivation: input.maxMainStepsPerActivation ?? input.maxMainSteps ?? 24,
    maxModelTokens: input.maxModelTokens ?? 200_000,
    tetoEnabled: input.tetoEnabled ?? true,
    tetoMaxOutputTokens: input.tetoMaxOutputTokens ?? 200,
    tetoTokenRatio: input.tetoTokenRatio ?? 0.1,
  };
  if (!Number.isSafeInteger(mainStepAllowance(policy)) || mainStepAllowance(policy) < 1) {
    throw new SessionProtocolError("Main step allowance must be a positive integer");
  }
  if (!Number.isSafeInteger(policy.maxModelTokens) || policy.maxModelTokens < 1) {
    throw new SessionProtocolError("Run token budget must be a positive integer");
  }
  if (policy.tetoTokenRatio <= 0 || policy.tetoTokenRatio >= 1) {
    throw new SessionProtocolError("Teto token ratio must be between zero and one");
  }
  return policy;
}

function pendingAdmissions(
  events: readonly AnyEvent[],
): Array<Extract<AnyEvent, { type: "input.admitted" }>> {
  const delivered = new Set(events
    .filter((event) => event.type === "input.delivered")
    .map((event) => event.payload.inputId));
  return events
    .filter((event): event is Extract<AnyEvent, { type: "input.admitted" }> => (
      event.type === "input.admitted" && !delivered.has(event.payload.inputId)
    ))
    .sort((left, right) => left.payload.sequence - right.payload.sequence);
}

function nextInputSequence(events: readonly AnyEvent[]): number {
  return events.reduce((highest, event) =>
    event.type === "input.admitted"
      ? Math.max(highest, event.payload.sequence)
      : highest, 0) + 1;
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
    ...(turn.retryable === undefined ? {} : { retryable: turn.retryable }),
    ...(turn.resumeRequires === undefined ? {} : { resumeRequires: turn.resumeRequires }),
  };
}

function conversationRefs(events: readonly AnyEvent[]): FukaiConversationRef[] {
  const refs: FukaiConversationRef[] = [];
  for (const event of events) {
    if (event.type === "user.message" || event.type === "assistant.message") {
      refs.push({
        ref: event.payload.messageRef,
        sequence: event.globalOffset,
        groupId: `event:${event.eventId}`,
      });
    } else if (event.type === "tool.succeeded" || event.type === "tool.failed") {
      refs.push({
        ref: event.payload.resultRef,
        sequence: event.globalOffset,
        groupId: `operation:${event.payload.operationId}`,
      });
    }
  }
  return refs.sort((left, right) => left.sequence - right.sequence);
}

function usageFromEvents(events: readonly AnyEvent[]): TokenUsage {
  return events.reduce<TokenUsage>((total, event) => {
    if (event.type !== "budget.charged") return total;
    return {
      input: total.input + event.payload.usage.input,
      output: total.output + event.payload.usage.output,
      cacheRead: total.cacheRead + event.payload.usage.cacheRead,
      cacheWrite: total.cacheWrite + event.payload.usage.cacheWrite,
      ...(
        total.costUsd === undefined && event.payload.usage.costUsd === undefined
          ? {}
          : { costUsd: (total.costUsd ?? 0) + (event.payload.usage.costUsd ?? 0) }
      ),
    };
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
}

function totalTokens(usage: TokenUsage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
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
  const text = await readUserText(store, event.payload.messageRef);
  const requestedDelivery = request.delivery ?? event.payload.delivery;
  if (text !== request.text || requestedDelivery !== event.payload.delivery) {
    throw new SessionProtocolError(
      `Input id ${request.inputId} was reused with different content or delivery`,
    );
  }
}

async function readUserText(store: ContentAddressedStore, ref: ArtifactRef): Promise<string> {
  const value = await readConversationArtifact(store, ref);
  if (value.role !== "user") {
    throw new SessionProtocolError("Input artifact is not a user message");
  }
  return value.content;
}

async function readConversationArtifact(
  store: ContentAddressedStore,
  ref: ArtifactRef,
): Promise<ConversationMessage> {
  const value: unknown = JSON.parse(new TextDecoder().decode(await store.get(ref)));
  if (
    value === null
    || typeof value !== "object"
    || !["user", "assistant", "tool"].includes((value as Partial<ConversationMessage>).role ?? "")
    || typeof (value as Partial<ConversationMessage>).content !== "string"
  ) {
    throw new SessionProtocolError("Conversation artifact is invalid");
  }
  return value as ConversationMessage;
}

function legacyTurnIdForTranscript(runId: string): string {
  return `legacy:${runId}:0`;
}

function validateOptions(options: SessionControllerOptions): void {
  if (options.workspace.length === 0 || options.dataDir.length === 0 || options.model.length === 0) {
    throw new SessionProtocolError("workspace, dataDir, and model are required");
  }
  if (options.runId !== undefined) validateRunId(options.runId);
}

function validateSubmit(request: SessionSubmitRequest): void {
  if (request.inputId.length === 0 || request.inputId.includes("\0")) {
    throw new SessionProtocolError("inputId must be a non-empty string without NUL");
  }
  if (request.text.trim().length === 0) {
    throw new SessionProtocolError("Input text must not be empty");
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
