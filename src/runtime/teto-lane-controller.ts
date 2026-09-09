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
  /** Start on first initialization only; a durable stop always takes precedence. */
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
    return this.enqueueLifecycle(() => this.startInLifecycle(context));
  }

  stop(context?: ToolExecutionContext): Promise<TetoControlResult> {
    return this.enqueueLifecycle(async () => {
      if (context !== undefined) assertOwner(context, this.runId, this.mainLaneId);
      if (this.closed) return { active: false, changed: false, laneId: this.laneId };
      if (!this.active) return { active: false, changed: false, laneId: this.laneId };
      const scheduler = this.scheduler;
      const requestedBy = context?.laneId ?? this.mainLaneId;
      // Persist the owner's stop intent before retiring the scheduler. If the
      // Ledger rejects it, the observer remains active and a retry can still
      // establish the durable fact used by recovery.
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
      this.stopping = true;
      this.scheduler = undefined;
      await scheduler?.stop();
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

  /** Restore the latest explicit intent, or apply automatic startup once. */
  async restoreIfRequested(requestedBy: LaneId = this.mainLaneId): Promise<boolean> {
    return this.enqueueLifecycle(async () => {
      if (!this.available || this.active) return this.active;
      const events = await this.readEvents();
      // The lane registration is a capability fact; the start control is the
      // durable intent to run. Re-establish the capability before inspecting
      // that intent so a resumed Run can be observed even when its original
      // registration was interrupted.
      await this.ensureAvailableInLifecycle(events);
      const action = lastControlAction(events, this.runId, this.laneId);
      if (action === "stop") return false;
      if (action === undefined) {
        if (this.options.autoStart !== true) return false;
        return (await this.startInLifecycle({
          runId: this.runId,
          laneId: requestedBy,
          workspace: this.options.workspace,
          operationId: `${this.runId}:${this.laneId}:auto-start`,
        })).active;
      }
      this.stopping = false;
      this.scheduler = this.createScheduler(await this.readEvents());
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

  private async startInLifecycle(context: ToolExecutionContext): Promise<TetoControlResult> {
    assertOwner(context, this.runId, this.mainLaneId);
    if (!this.available) return { active: false, changed: false, reason: "Teto is disabled by policy" };
    if (this.active) return { active: true, changed: false, laneId: this.laneId };
    this.stopping = false;
    const events = await this.readEvents();
    await this.ensureAvailableInLifecycle(events);
    const scheduler = this.createScheduler(events);
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
      // Failed admission must leave no active scheduler so startup is retryable.
      this.scheduler = undefined;
      this.stopping = true;
      await scheduler.stop().catch(() => undefined);
      this.stopping = false;
      throw error;
    }
    return { active: true, changed: true, laneId: this.laneId };
  }

  private createScheduler(events: readonly AnyEvent[]): TetoLaneScheduler {
    const compactionRuntime = this.options.createCompactionRuntime?.();
    return new TetoLaneScheduler({
      eventSink: this.eventSink,
      inbox: this.options.inbox,
      store: this.options.store,
      model: this.options.model,
      modelName: this.options.modelName,
      runId: this.runId,
      goal: this.goal,
      policy: this.options.policy,
      workspace: this.options.workspace,
      events,
      clock: this.clock,
      mainLaneId: this.mainLaneId,
      tetoLaneId: this.laneId,
      replayPublicEvents: true,
      tokenBudget: this.tokenBudget,
      signal: this.options.signal === undefined
        ? this.lifecycleController.signal
        : AbortSignal.any([this.options.signal, this.lifecycleController.signal]),
      ...(this.options.policyVersion === undefined ? {} : { policyVersion: this.options.policyVersion }),
      ...(this.options.readWatermark === undefined ? {} : { readWatermark: this.options.readWatermark }),
      ...(compactionRuntime === undefined ? {} : { compactionRuntime }),
    });
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

function lastControlAction(
  events: readonly AnyEvent[],
  runId: RunId,
  laneId: LaneId,
): "start" | "stop" | undefined {
  const controls = events
    .filter((event) => event.runId === runId && event.laneId === laneId && event.type === "lane.status" && event.payload.control !== undefined)
    .sort((left, right) => left.globalOffset - right.globalOffset);
  const latest = controls.at(-1);
  return latest?.type === "lane.status" ? latest.payload.control?.action : undefined;
}
