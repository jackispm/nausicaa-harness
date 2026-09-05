import { randomUUID } from "node:crypto";

import type { A2AInbox, EventSink } from "../a2a/index.js";
import type { AnyEvent } from "../domain/events.js";
import type {
  Goal,
  LaneId,
  RunId,
  RunPolicy,
} from "../domain/types.js";
import type { Clock, ModelPort, ToolExecutionContext } from "../domain/ports.js";
import type { ContentAddressedStore } from "../store/index.js";
import type { RuntimeFukaiCompaction } from "./fukai-compaction-runtime.js";
import type { MainAfterStepContext, MainBeforeStepContext, MainBoundaryMessage } from "./main-loop.js";
import { TetoLaneScheduler } from "./teto-lane-scheduler.js";
import type { TetoControl, TetoControlResult, TetoControlStatus } from "./teto-control-tool.js";
import { RunTokenBudget } from "./run-token-budget.js";

const DEFAULT_MAIN_LANE = "main";
const DEFAULT_TETO_LANE = "teto";

export interface TetoLaneControllerOptions {
  eventSink: EventSink;
  inbox: A2AInbox;
  store: ContentAddressedStore;
  model: ModelPort;
  modelName: string;
  runId: RunId;
  goal: Goal;
  policy: RunPolicy;
  workspace: string;
  events?: readonly AnyEvent[];
  readEvents?: () => Promise<readonly AnyEvent[]>;
  createCompactionRuntime?: () => RuntimeFukaiCompaction | undefined;
  policyVersion?: string;
  clock?: Clock;
  mainLaneId?: LaneId;
  tetoLaneId?: LaneId;
  createId?: () => string;
  signal?: AbortSignal;
  readWatermark?: () => Promise<number>;
  tokenBudget?: RunTokenBudget;
  /** Legacy one-shot callers may preserve the old automatic behavior. */
  autoStart?: boolean;
}

/**
 * Lifecycle owner for one lane's optional Teto. It contains no second event
 * store or scheduler: activation facts live in the shared Ledger and the
 * active observer is the ordinary TetoLaneScheduler.
 */
export class TetoLaneController implements TetoControl {
  readonly runId: RunId;
  readonly laneId: LaneId;
  readonly mainLaneId: LaneId;

  private readonly options: TetoLaneControllerOptions;
  private readonly eventSink: EventSink;
  private readonly clock: Clock;
  private readonly createId: () => string;
  private readonly readEvents: () => Promise<readonly AnyEvent[]>;
  private readonly lifecycleController = new AbortController();
  private readonly tokenBudget: RunTokenBudget;
  private goal: Goal;
  private scheduler: TetoLaneScheduler | undefined;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private stopping = false;
  private closed = false;

  constructor(options: TetoLaneControllerOptions) {
    if (options.runId.trim().length === 0 || options.modelName.trim().length === 0) {
      throw new TypeError("Teto controller runId and modelName must be non-empty");
    }
    this.options = options;
    this.eventSink = options.eventSink;
    this.clock = options.clock ?? { now: () => new Date() };
    this.createId = options.createId ?? randomUUID;
    this.runId = options.runId;
    this.mainLaneId = options.mainLaneId ?? DEFAULT_MAIN_LANE;
    this.laneId = options.tetoLaneId ?? DEFAULT_TETO_LANE;
    this.goal = structuredClone(options.goal);
    this.readEvents = options.readEvents ?? (async () => options.events ?? []);
    this.tokenBudget = options.tokenBudget ?? new RunTokenBudget(options.policy.maxModelTokens);
  }

  get active(): boolean {
    return this.scheduler !== undefined && !this.stopping;
  }

  get available(): boolean {
    return !this.closed && this.options.policy.tetoEnabled === true;
  }

  /** Update the observer's objective before a task-scoped branch starts it. */
  setGoal(goal: Goal): void {
    this.goal = structuredClone(goal);
  }

  /** Ensure the optional lane is visible in the durable topology without starting it. */
  async ensureAvailable(): Promise<boolean> {
    return this.enqueueLifecycle(async () => {
      if (!this.available) return false;
      const events = await this.readEvents();
      await this.ensureAvailableInLifecycle(events);
      return true;
    });
  }

  /** Start is serialized so a batched pair of tool calls cannot create two Teto lanes. */
  start(context: ToolExecutionContext): Promise<TetoControlResult> {
    return this.enqueueLifecycle(async () => {
      assertOwner(context, this.runId, this.mainLaneId);
      if (!this.available) return { active: false, changed: false, reason: "Teto is disabled by policy" };
      if (this.active) return { active: true, changed: false, laneId: this.laneId };
      this.stopping = false;
      const events = await this.readEvents();
      await this.ensureAvailableInLifecycle(events);
      const schedulerOptions = {
        eventSink: this.options.eventSink,
        inbox: this.options.inbox,
        store: this.options.store,
        model: this.options.model,
        modelName: this.options.modelName,
        runId: this.options.runId,
        goal: this.goal,
        policy: this.options.policy,
        workspace: this.options.workspace,
        events,
        clock: this.clock,
        mainLaneId: this.mainLaneId,
        tetoLaneId: this.laneId,
        replayPublicEvents: true,
        tokenBudget: this.tokenBudget,
        ...(this.options.signal === undefined
          ? { signal: this.lifecycleController.signal }
          : { signal: AbortSignal.any([this.options.signal, this.lifecycleController.signal]) }),
        ...(this.options.policyVersion === undefined ? {} : { policyVersion: this.options.policyVersion }),
        ...(this.options.readWatermark === undefined ? {} : { readWatermark: this.options.readWatermark }),
        ...(this.options.createCompactionRuntime === undefined
          ? {}
          : (() => {
              const compactionRuntime = this.options.createCompactionRuntime!();
              return compactionRuntime === undefined ? {} : { compactionRuntime };
            })()),
      };
      const scheduler = new TetoLaneScheduler(schedulerOptions);
      this.scheduler = scheduler;
      const requestedBy = context.laneId ?? this.mainLaneId;
      try {
        await this.eventSink.append({
          runId: this.runId,
          laneId: this.laneId,
          type: "lane.status",
          payload: {
            status: "ready",
            reason: `Teto opened by ${requestedBy}`,
            control: { action: "start", requestedBy },
          },
          correlationId: `${this.runId}:${this.laneId}:lifecycle`,
          idempotencyKey: `${this.runId}:${this.laneId}:status:ready:${this.createId()}`,
          visibility: "run",
          occurredAt: this.clock.now().toISOString(),
        });
      } catch (error: unknown) {
        // Do not expose an active scheduler when the durable start intent was
        // rejected. A later start must be able to retry from a clean state.
        this.scheduler = undefined;
        this.stopping = true;
        await scheduler.stop().catch(() => undefined);
        this.stopping = false;
        throw error;
      }
      return { active: true, changed: true, laneId: this.laneId };
    });
  }

  stop(context?: ToolExecutionContext): Promise<TetoControlResult> {
    return this.enqueueLifecycle(async () => {
      if (context !== undefined) assertOwner(context, this.runId, this.mainLaneId);
      if (this.closed) return { active: false, changed: false, laneId: this.laneId };
      if (!this.active) return { active: false, changed: false, laneId: this.laneId };
      this.stopping = true;
      const scheduler = this.scheduler;
      this.scheduler = undefined;
      await scheduler?.stop();
      const requestedBy = context?.laneId ?? this.mainLaneId;
      await this.eventSink.append({
        runId: this.runId,
        laneId: this.laneId,
        type: "lane.status",
        payload: {
          status: "waiting",
          reason: `Teto closed by ${requestedBy}`,
          control: { action: "stop", requestedBy },
        },
        correlationId: `${this.runId}:${this.laneId}:lifecycle`,
        idempotencyKey: `${this.runId}:${this.laneId}:status:waiting:${this.createId()}`,
        visibility: "run",
        occurredAt: this.clock.now().toISOString(),
      });
      return { active: false, changed: true, laneId: this.laneId };
    });
  }

  status(context: ToolExecutionContext): TetoControlStatus {
    assertOwner(context, this.runId, this.mainLaneId);
    return {
      active: this.active,
      available: this.available,
      laneId: this.laneId,
      ...(this.stopping ? { reason: "Teto is stopping" } : {}),
    };
  }

  /** Restore an intentionally active Teto after a process/session restart. */
  async restoreIfRequested(requestedBy: LaneId = this.mainLaneId): Promise<boolean> {
    return this.enqueueLifecycle(async () => {
      if (!this.available || this.active) return this.active;
      const events = await this.readEvents();
      // The lane registration is a capability fact; the start control is the
      // durable intent to run. Re-establish the capability before inspecting
      // that intent so a resumed Run can be observed even when its original
      // registration was interrupted.
      await this.ensureAvailableInLifecycle(events);
      if (!lastControlIsStart(events, this.runId, this.laneId)) return false;
      this.stopping = false;
      const current = await this.readEvents();
      const schedulerOptions = {
        eventSink: this.options.eventSink,
        inbox: this.options.inbox,
        store: this.options.store,
        model: this.options.model,
        modelName: this.options.modelName,
        runId: this.options.runId,
        goal: this.goal,
        policy: this.options.policy,
        workspace: this.options.workspace,
        events: current,
        clock: this.clock,
        mainLaneId: this.mainLaneId,
        tetoLaneId: this.laneId,
        replayPublicEvents: true,
        tokenBudget: this.tokenBudget,
        ...(this.options.signal === undefined
          ? { signal: this.lifecycleController.signal }
          : { signal: AbortSignal.any([this.options.signal, this.lifecycleController.signal]) }),
        ...(this.options.policyVersion === undefined ? {} : { policyVersion: this.options.policyVersion }),
        ...(this.options.readWatermark === undefined ? {} : { readWatermark: this.options.readWatermark }),
        ...(this.options.createCompactionRuntime === undefined
          ? {}
          : (() => {
              const compactionRuntime = this.options.createCompactionRuntime!();
              return compactionRuntime === undefined ? {} : { compactionRuntime };
            })()),
      };
      this.scheduler = new TetoLaneScheduler(schedulerOptions);
      return this.active;
    });
  }

  observeMainEvent(event: AnyEvent): void {
    this.scheduler?.observeMainEvent(event);
  }

  enqueue(context?: MainAfterStepContext): void {
    this.scheduler?.enqueue(context);
  }

  async beforeMainStep(context?: Pick<MainBeforeStepContext, "step">): Promise<readonly MainBoundaryMessage[]> {
    return this.scheduler === undefined ? [] : this.scheduler.beforeMainStep(context);
  }

  afterMainStep(context: MainAfterStepContext): void {
    this.scheduler?.afterMainStep(context);
  }

  async drain(): Promise<void> {
    await this.scheduler?.drain();
  }

  async close(): Promise<void> {
    await this.enqueueLifecycle(async () => {
      this.closed = true;
      this.stopping = true;
      const scheduler = this.scheduler;
      this.scheduler = undefined;
      await scheduler?.stop();
      if (!this.lifecycleController.signal.aborted) this.lifecycleController.abort();
    });
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleTail.then(operation);
    this.lifecycleTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensureRegistered(events: readonly AnyEvent[]): Promise<void> {
    if (events.some((event) => event.runId === this.runId && event.laneId === this.laneId && event.type === "lane.registered")) return;
    await this.eventSink.append({
      runId: this.runId,
      laneId: this.laneId,
      type: "lane.registered",
      payload: { kind: "intent-navigator" },
      correlationId: `${this.runId}:${this.laneId}:lifecycle`,
      idempotencyKey: `${this.runId}:${this.laneId}:registered`,
      visibility: "run",
      occurredAt: this.clock.now().toISOString(),
    });
  }

  private async ensureAvailableInLifecycle(events: readonly AnyEvent[]): Promise<void> {
    await this.ensureRegistered(events);
    if (events.some((event) => (
      event.runId === this.runId
      && event.laneId === this.laneId
      && event.type === "lane.status"
    ))) return;
    await this.eventSink.append({
      runId: this.runId,
      laneId: this.laneId,
      type: "lane.status",
      payload: {
        status: "dormant",
        reason: "Teto available; Main may open it with teto_start",
      },
      correlationId: `${this.runId}:${this.laneId}:lifecycle`,
      idempotencyKey: `${this.runId}:${this.laneId}:status:dormant:available`,
      visibility: "run",
      occurredAt: this.clock.now().toISOString(),
    });
  }

}

function assertOwner(context: ToolExecutionContext, runId: RunId, laneId: LaneId): void {
  if (context.runId !== runId) throw new Error("Teto capability is bound to another Run");
  if (context.laneId !== undefined && context.laneId !== laneId) {
    throw new Error(`Teto capability is bound to lane ${laneId}`);
  }
}

function lastControlIsStart(events: readonly AnyEvent[], runId: RunId, laneId: LaneId): boolean {
  const controls = events
    .filter((event) => event.runId === runId && event.laneId === laneId && event.type === "lane.status" && event.payload.control !== undefined)
    .sort((left, right) => left.globalOffset - right.globalOffset);
  const latest = controls.at(-1);
  return latest?.type === "lane.status" && latest.payload.control?.action === "start";
}
