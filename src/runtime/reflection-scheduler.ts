import { randomUUID } from "node:crypto";

import type { EventSink } from "../a2a/index.js";
import type {
  AnyEvent,
  Clock,
  Goal,
  MainTriggerKind,
  ModelPort,
  RunId,
  RunPolicy,
  TokenUsage,
} from "../domain/index.js";
import { parseSingleJsonObject, systemClock } from "../domain/index.js";
import { stableJson } from "../ledger/hash.js";
import {
  ArtifactIntegrityError,
  ArtifactNotFoundError,
  type ContentAddressedStore,
} from "../store/index.js";
import { TetoCadence, TokenRatioGate, type TetoCadenceState, type TokenRatioGateState } from "../teto/index.js";
import type {
  MainAfterStepContext,
  MainBeforeStepContext,
  MainBoundaryMessage,
} from "./main-loop.js";
import { persistedErrorText } from "./redaction.js";
import { prepareModelPort } from "../model/prepared-model.js";
import type { RunTokenBudget } from "./run-token-budget.js";

const DEFAULT_REFLECTION_LANE = "reflection";
const OBSERVATION_DEADLINE_MS = 30_000;
const REFLECTION_SYSTEM_PROMPT = `You are the private Reflection lane.
The mission and latest decision are the only inputs. No tools are available.
Return exactly one minified JSON object: {"action":"silent"} or {"action":"revise","note":"<=12 words"}.
A revise note is delivered to Nausicaa at the next boundary.`;

export interface ReflectionSchedulerOptions {
  eventSink: EventSink;
  modelPort: ModelPort;
  store: ContentAddressedStore;
  runId: RunId;
  goal: Goal;
  model: string;
  policy: RunPolicy;
  events?: readonly AnyEvent[];
  clock?: Clock;
  laneId?: string;
  createId?: () => string;
  signal?: AbortSignal;
  /** Shared admission gate for every provider call in this Run. */
  runTokenBudget?: RunTokenBudget;
}

export interface ReflectionSchedulerState {
  cadenceState: TetoCadenceState;
  tokenGateState: TokenRatioGateState;
}

interface QueuedObservation {
  runId: RunId;
  laneId: string;
  step: number;
  goal: Goal;
  delta: MainAfterStepContext["delta"];
  usage: TokenUsage;
}

interface PendingReflection {
  mainCallIndex: number;
  reflectionRef: Extract<AnyEvent, { type: "reflection.observed" }>["payload"]["reflectionRef"];
}

/** A durable reflection artifact can never become readable by retrying. */
class PermanentReflectionArtifactError extends Error {
  override readonly name = "PermanentReflectionArtifactError";
}

export class ReflectionScheduler {
  private readonly eventSink: EventSink;
  private readonly modelPort: ModelPort;
  private readonly store: ContentAddressedStore;
  private readonly runId: RunId;
  private readonly model: string;
  private readonly policy: RunPolicy;
  private readonly clock: Clock;
  private readonly laneId: string;
  private readonly createId: () => string;
  private readonly runTokenBudget: RunTokenBudget | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly stopController = new AbortController();
  private readonly cadence: TetoCadence;
  private tokenGate: TokenRatioGate;
  private readonly mainLaneId = "main";
  private accepting = true;
  private goal: Goal;
  private tail: Promise<void> = Promise.resolve();
  private unrecordedErrors: Error[] = [];
  private readonly pendingReflections: PendingReflection[];
  private readonly discardedReflections = new Set<number>();

  constructor(options: ReflectionSchedulerOptions) {
    validateOptions(options);
    this.eventSink = options.eventSink;
    this.modelPort = prepareModelPort(options.modelPort, { captureCapabilities: false });
    this.store = options.store;
    this.runId = options.runId;
    this.model = options.model;
    this.policy = options.policy;
    this.clock = options.clock ?? systemClock;
    this.laneId = options.laneId ?? DEFAULT_REFLECTION_LANE;
    this.createId = options.createId ?? randomUUID;
    this.runTokenBudget = options.runTokenBudget;
    this.signal = options.signal;
    const recovered = recoverReflectionSchedulerState(options.events ?? [], {
      runId: this.runId,
      mainLaneId: this.mainLaneId,
      reflectionLaneId: this.laneId,
    });
    this.cadence = new TetoCadence({}, recovered.cadenceState);
    this.tokenGate = new TokenRatioGate(this.policy.tetoTokenRatio, recovered.tokenGateState);
    this.goal = structuredClone(options.goal);
    this.pendingReflections = recoverPendingReflections(
      options.events ?? [],
      this.runId,
      this.laneId,
    );
  }

  /** Return at most one completed self-reflection at a natural Main boundary. */
  async beforeMainStep(
    _context?: Pick<MainBeforeStepContext, "step">,
  ): Promise<readonly MainBoundaryMessage[]> {
    // Reflection is an observer lane. A slow provider must not hold Main at a
    // boundary; completed notes are picked up on the next boundary instead.
    // The queue itself remains serialized and every rejection is still caught
    // by enqueue(), so skipping a drain here cannot create an unhandled tail.
    const pending = this.pendingReflections[0];
    if (pending === undefined) return [];
    const messageId = `${this.runId}:reflection:${pending.mainCallIndex}`;
    try {
      const note = await readReflectionNote(this.store, pending.reflectionRef);
      await this.eventSink.append({
        runId: this.runId,
        laneId: this.laneId,
        type: "reflection.delivered",
        payload: { mainCallIndex: pending.mainCallIndex, messageId },
        correlationId: this.runId,
        idempotencyKey: `reflection:${pending.mainCallIndex}:delivered`,
        visibility: "run",
        occurredAt: this.clock.now().toISOString(),
      });
      this.pendingReflections.shift();
      return [{
        kind: "reflection",
        source: "nausicaa-reflection",
        content: note,
        messageId,
      }];
    } catch (error: unknown) {
      if (error instanceof PermanentReflectionArtifactError) {
        // Do not let one missing/corrupt artifact block every later note. The
        // failed marker is idempotent and lets recovery skip this observation
        // after a restart; if its append fails, recovery will retry safely.
        this.pendingReflections.shift();
        this.discardedReflections.add(pending.mainCallIndex);
        await this.recordFailure(`${pending.mainCallIndex}:delivery:discarded`, error)
          .catch(() => undefined);
        return [];
      }
      // Keep the note queued when the delivery fact cannot be persisted. A
      // transient Ledger failure must not make a durable revision disappear;
      // the next Main boundary can retry the same idempotent delivery.
      await this.recordFailure(`delivery:${pending.mainCallIndex}`, error).catch(() => undefined);
      return [];
    }
  }

  enqueue(context: MainAfterStepContext): void {
    if (!this.accepting) return;
    let operation: Promise<void>;
    try {
      const observation = narrowObservation(context);
      operation = this.tail.then(() => this.process(observation));
    } catch (error: unknown) {
      operation = this.tail.then(() => this.recordFailure(`enqueue:${this.createId()}`, error));
    }
    this.tail = operation.catch((error: unknown) => {
      this.unrecordedErrors.push(asError(error));
    });
  }

  async drain(): Promise<void> {
    while (true) {
      const observedTail = this.tail;
      await observedTail;
      if (observedTail === this.tail) break;
    }
    if (this.unrecordedErrors.length > 0) {
      throw new AggregateError(
        [...this.unrecordedErrors],
        "Reflection scheduler could not persist one or more failures",
      );
    }
  }

  async stop(): Promise<void> {
    this.accepting = false;
    if (!this.stopController.signal.aborted) {
      this.stopController.abort(new DOMException("Reflection cancelled after Main finished", "AbortError"));
    }
    await this.drain();
  }

  snapshot(): ReflectionSchedulerState {
    return {
      cadenceState: this.cadence.snapshot(),
      tokenGateState: this.tokenGate.snapshot(),
    };
  }

  private async process(context: QueuedObservation): Promise<void> {
    if (context.delta.status === "complete" || this.stopController.signal.aborted) return;
    let wakePending = false;
    let mainCallIndex: number | undefined;
    let reservationId: string | undefined;
    let reservationSettled = false;
    let runReservationId: string | undefined;
    let runReservationSettled = false;
    let providerUsage: TokenUsage | undefined;
    let budgetChargeRecorded = false;
    let passCommitted = false;
    let observationSignal: AbortSignal | undefined;
    try {
      assertContextScope(context, this.runId, this.mainLaneId);
      this.acceptGoal(context.goal);
      this.tokenGate.chargeMain(context.usage);
      const decision = this.cadence.recordMainCall(context.delta.triggerKind);
      mainCallIndex = decision.mainCallIndex;
      if (!decision.shouldWake) return;
      wakePending = true;

      const frame = reflectionFrame(this.goal, context.delta);
      reservationId = `${this.runId}:${this.laneId}:${decision.mainCallIndex}`;
      const reservationTokens = estimateTokens(REFLECTION_SYSTEM_PROMPT)
        + estimateTokens(stableJson(frame))
        + this.policy.tetoMaxOutputTokens;
      if (this.tokenGate.reserve(reservationId, reservationTokens) === undefined) {
        this.cadence.skipPass(decision.mainCallIndex);
        wakePending = false;
        return;
      }
      if (this.runTokenBudget !== undefined) {
        runReservationId = runModelReservationId(
          this.runId,
          this.laneId,
          decision.mainCallIndex,
        );
        if (this.runTokenBudget.reserve(runReservationId, reservationTokens, { priority: "auxiliary" }) === undefined) {
          this.tokenGate.cancel(reservationId);
          this.cadence.skipPass(decision.mainCallIndex);
          wakePending = false;
          return;
        }
      }

      await this.recordLaneStatus(
        decision.mainCallIndex,
        "running",
        `Reflecting Main boundary ${context.delta.boundaryId}`,
      );
      this.cadence.commitPass(decision.mainCallIndex);
      wakePending = false;
      passCommitted = true;
      const signal = createObservationSignal(this.signal, this.stopController.signal);
      observationSignal = signal;
      const response = await withAbort(() => this.modelPort.complete({
        runId: this.runId,
        laneId: this.laneId,
        sessionId: `${this.runId}:${this.laneId}:${this.model}`,
        model: this.model,
        systemPrompt: REFLECTION_SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: JSON.stringify(frame),
          createdAt: this.clock.now().toISOString(),
        }],
        tools: [],
        maxOutputTokens: this.policy.tetoMaxOutputTokens,
        ...(signal === undefined ? {} : { signal }),
      }), signal);
      providerUsage = response.usage;
      await this.recordBudgetCharge(
        decision.mainCallIndex,
        context.delta.boundaryId,
        response.usage,
      );
      budgetChargeRecorded = true;
      if (runReservationId !== undefined) {
        this.runTokenBudget?.settle(runReservationId, response.usage);
        runReservationSettled = true;
      }
      if (response.stopReason === "aborted") {
        throw new Error("Reflection response was aborted by the provider");
      }
      if (response.stopReason === "length") {
        throw new Error(
          `Reflection output was truncated at the ${this.policy.tetoMaxOutputTokens}-token limit`,
        );
      }
      if (response.toolCalls.length !== 0) {
        throw new Error("Reflection lane must not request tools");
      }
      if (response.usage.output > this.policy.tetoMaxOutputTokens) {
        throw new Error(
          `Reflection output used ${response.usage.output} tokens; limit is ${this.policy.tetoMaxOutputTokens}`,
        );
      }
      const reflection = parseReflectionOutput(response.content);
      const reflectionRef = await this.store.put(JSON.stringify({
        ...reflection,
        mainCallIndex: decision.mainCallIndex,
      }), "application/vnd.nausicaa.reflection+json");
      await this.eventSink.append({
        runId: this.runId,
        laneId: this.laneId,
        type: "reflection.observed",
        payload: {
          mainCallIndex: decision.mainCallIndex,
          trigger: decision.reason ?? context.delta.triggerKind,
          action: reflection.action,
          reflectionRef,
          usage: response.usage,
        },
        causationId: context.delta.boundaryId,
        correlationId: this.runId,
        idempotencyKey: `reflection:${decision.mainCallIndex}:observed`,
        visibility: "run",
        occurredAt: this.clock.now().toISOString(),
      });
      reservationSettled = true;
      this.settleReservation(reservationId, response.usage);
      if (reflection.action === "revise") {
        this.pendingReflections.push({
          mainCallIndex: decision.mainCallIndex,
          reflectionRef,
        });
      }
      await this.recordLaneStatus(decision.mainCallIndex, "dormant");
    } catch (error: unknown) {
      let failure = error;
      if (
        runReservationId !== undefined
        && !runReservationSettled
        && providerUsage !== undefined
      ) {
        try {
          this.runTokenBudget?.settle(runReservationId, providerUsage);
          runReservationSettled = true;
        } catch (settlementError: unknown) {
          failure = new AggregateError(
            [asError(error), asError(settlementError)],
            "Reflection usage could not be settled",
          );
        }
      }
      if (
        reservationId !== undefined
        && !reservationSettled
        && providerUsage !== undefined
      ) {
        reservationSettled = true;
        try {
          this.settleReservation(reservationId, providerUsage);
        } catch (settlementError: unknown) {
          failure = new AggregateError(
            [asError(failure), asError(settlementError)],
            "Reflection ratio usage could not be settled",
          );
        }
      }
      if (reservationId !== undefined && !reservationSettled) {
        this.tokenGate.cancel(reservationId);
      }
      if (runReservationId !== undefined && !runReservationSettled) {
        this.runTokenBudget?.cancel(runReservationId);
      }
      if (wakePending && !passCommitted) {
        try {
          this.cadence.skipPass();
        } catch {
          // Keep the original failure authoritative.
        }
      }
      if (
        providerUsage !== undefined
        && !budgetChargeRecorded
        && mainCallIndex !== undefined
      ) {
        await this.recordBudgetCharge(
          mainCallIndex,
          context.delta.boundaryId,
          providerUsage,
        );
        budgetChargeRecorded = true;
      }
      if (isSignalAbort(failure, observationSignal)) {
        await this.recordLaneStatus(
          mainCallIndex ?? context.step,
          "cancelled",
          persistedErrorText(failure, "Reflection cancelled before completion"),
        );
      } else {
        await this.recordFailure(`step:${context.step}`, failure);
      }
    }
  }

  private acceptGoal(goal: Goal): void {
    if (goal.version < this.goal.version) {
      throw new Error(
        `Stale goal version ${goal.version}; current version is ${this.goal.version}`,
      );
    }
    if (goal.version === this.goal.version && stableJson(goal) !== stableJson(this.goal)) {
      throw new Error(
        `Goal version ${goal.version} changed without a revision`,
      );
    }
    if (goal.version > this.goal.version) this.goal = structuredClone(goal);
  }

  private async recordLaneStatus(
    pass: number,
    status: "running" | "dormant" | "cancelled",
    reason?: string,
  ): Promise<void> {
    await this.eventSink.append({
      runId: this.runId,
      laneId: this.laneId,
      type: "lane.status",
      payload: { status, ...(reason === undefined ? {} : { reason }) },
      correlationId: this.runId,
      idempotencyKey: `reflection:${pass}:status:${status}`,
      visibility: "run",
      occurredAt: this.clock.now().toISOString(),
    });
  }

  private async recordBudgetCharge(
    mainCallIndex: number,
    causationId: string,
    usage: TokenUsage,
  ): Promise<void> {
    await this.eventSink.append({
      runId: this.runId,
      laneId: this.laneId,
      type: "budget.charged",
      payload: { laneId: this.laneId, usage },
      causationId,
      correlationId: this.runId,
      idempotencyKey: `reflection:${mainCallIndex}:budget`,
      visibility: "run",
      occurredAt: this.clock.now().toISOString(),
    });
  }

  private settleReservation(reservationId: string, usage: TokenUsage): void {
    try {
      this.tokenGate.settle(reservationId, usage);
    } catch (error: unknown) {
      const state = this.tokenGate.snapshot();
      this.tokenGate.cancel(reservationId);
      this.tokenGate = new TokenRatioGate(this.policy.tetoTokenRatio, {
        mainTokens: state.mainTokens,
        tetoTokens: state.tetoTokens + totalTokens(usage),
        reservations: state.reservations.filter(
          (reservation) => reservation.id !== reservationId,
        ),
      });
      throw error;
    }
  }

  private async recordFailure(scope: string, error: unknown): Promise<void> {
    await this.eventSink.append({
      runId: this.runId,
      laneId: this.laneId,
      type: "lane.status",
      payload: { status: "failed", reason: persistedErrorText(error) },
      correlationId: this.runId,
      idempotencyKey: `reflection:${scope}:status:failed`,
      visibility: "run",
      occurredAt: this.clock.now().toISOString(),
    });
  }
}

export function recoverReflectionSchedulerState(
  events: readonly AnyEvent[],
  options: { runId: RunId; mainLaneId?: string; reflectionLaneId?: string },
): ReflectionSchedulerState {
  const mainLaneId = options.mainLaneId ?? "main";
  const reflectionLaneId = options.reflectionLaneId ?? DEFAULT_REFLECTION_LANE;
  const ordered = events
    .filter((event) => event.runId === options.runId)
    .slice()
    .sort((left, right) => left.globalOffset - right.globalOffset);
  const mainCalls: Array<{ trigger: MainTriggerKind; usage: TokenUsage }> = [];
  const pendingMainUsage: TokenUsage[] = [];
  const passCalls = new Set<number>();
  const observedUsageByCall = new Map<number, TokenUsage>();
  const chargedCalls = new Set<number>();
  let chargedReflectionTokens = 0;
  for (const event of ordered) {
    if (event.laneId === mainLaneId && event.type === "model.completed") {
      pendingMainUsage.push(event.payload.usage);
      continue;
    }
    if (event.laneId === mainLaneId && event.type === "navigation.updated") {
      const usage = pendingMainUsage.shift() ?? emptyUsage();
      if (event.payload.delta.status !== "complete") {
        mainCalls.push({
          trigger: event.payload.delta.triggerKind,
          usage,
        });
      }
      continue;
    }
    if (event.laneId === reflectionLaneId && event.type === "reflection.observed") {
      passCalls.add(event.payload.mainCallIndex);
      observedUsageByCall.set(event.payload.mainCallIndex, event.payload.usage);
      continue;
    }
    if (
      event.laneId === reflectionLaneId
      && event.type === "budget.charged"
      && event.payload.laneId === reflectionLaneId
    ) {
      chargedReflectionTokens += totalTokens(event.payload.usage);
      const match = /^reflection:(\d+):budget$/.exec(event.idempotencyKey);
      if (match !== null) {
        const call = Number(match[1]);
        chargedCalls.add(call);
        passCalls.add(call);
      }
      continue;
    }
    if (
      event.laneId === reflectionLaneId
      && event.type === "lane.status"
      && event.payload.status === "running"
    ) {
      const match = /^reflection:(\d+):status:running$/.exec(event.idempotencyKey);
      if (match !== null) passCalls.add(Number(match[1]));
    }
  }
  // Preserve usage from a durable model.completed whose navigation boundary
  // was not appended before a crash. It is billable, but not a committed
  // Main call and therefore must not advance cadence.
  const unpairedMainTokens = pendingMainUsage.reduce(
    (total, usage) => total + totalTokens(usage),
    0,
  );
  let credit = 0;
  for (let index = 0; index < mainCalls.length; index += 1) {
    const call = mainCalls[index]!;
    credit = isHardTrigger(call.trigger)
      ? 5
      : Math.min(5, credit + (call.trigger === "decision" ? 2 : 1));
    if (passCalls.has(index + 1)) credit = 0;
  }
  return {
    cadenceState: {
      mainCallIndex: mainCalls.length,
      credit,
      passCalls: [...passCalls].sort((left, right) => left - right),
    },
    tokenGateState: {
      mainTokens: mainCalls.reduce(
        (sum, call) => sum + totalTokens(call.usage),
        unpairedMainTokens,
      ),
      tetoTokens: chargedReflectionTokens + [...observedUsageByCall]
        .filter(([call]) => !chargedCalls.has(call))
        .reduce((sum, [, usage]) => sum + totalTokens(usage), 0),
      reservations: [],
    },
  };
}

function reflectionFrame(
  goal: Goal,
  delta: MainAfterStepContext["delta"],
): Record<string, unknown> {
  return {
    mission: {
      goalVersion: goal.version,
      goal: goal.statement,
      successCriteria: [...goal.successCriteria],
      hardConstraints: [...goal.hardConstraints],
    },
    latestDecision: {
      boundaryId: delta.boundaryId,
      triggerKind: delta.triggerKind,
      activeObjective: delta.activeObjective,
      actionOrDecision: delta.actionOrDecision,
      expectedOutcome: delta.expectedOutcome,
      outcome: delta.outcome,
      status: delta.status,
    },
  };
}

type ParsedReflection = { action: "silent" } | { action: "revise"; note: string };

function parseReflectionOutput(content: string): ParsedReflection {
  let value: unknown;
  try {
    value = parseSingleJsonObject(content);
  } catch {
    throw new Error("Reflection output must contain one JSON object");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Reflection output must be one JSON object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    record.action === "silent"
    && keys.length === 1
    && keys[0] === "action"
  ) {
    return { action: "silent" };
  }
  if (
    record.action !== "revise"
    || keys.length !== 2
    || keys[0] !== "action"
    || keys[1] !== "note"
    || typeof record.note !== "string"
    || record.note.trim().length === 0
    || record.note.length > 2_000
  ) {
    throw new Error("Reflection output must be silent or one bounded revise note");
  }
  return { action: "revise", note: record.note.trim() };
}

function recoverPendingReflections(
  events: readonly AnyEvent[],
  runId: RunId,
  laneId: string,
): PendingReflection[] {
  const delivered = new Set(
    events
      .filter((event): event is Extract<AnyEvent, { type: "reflection.delivered" }> => (
        event.runId === runId
        && event.laneId === laneId
        && event.type === "reflection.delivered"
      ))
      .map((event) => event.payload.mainCallIndex),
  );
  const discarded = new Set(
    events
      .filter((event) => (
        event.runId === runId
        && event.laneId === laneId
        && event.type === "lane.status"
        && event.payload.status === "failed"
      ))
      .flatMap((event) => {
        const match = /^reflection:(\d+):delivery:discarded:status:failed$/u
          .exec(event.idempotencyKey);
        return match === null ? [] : [Number(match[1])];
      }),
  );
  return events
    .filter((event): event is Extract<AnyEvent, { type: "reflection.observed" }> => (
      event.runId === runId
      && event.laneId === laneId
      && event.type === "reflection.observed"
      && event.payload.action === "revise"
      && !delivered.has(event.payload.mainCallIndex)
      && !discarded.has(event.payload.mainCallIndex)
    ))
    .sort((left, right) => left.globalOffset - right.globalOffset)
    .map((event) => ({
      mainCallIndex: event.payload.mainCallIndex,
      reflectionRef: structuredClone(event.payload.reflectionRef),
    }));
}

async function readReflectionNote(
  store: ContentAddressedStore,
  ref: PendingReflection["reflectionRef"],
): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = await store.get(ref);
  } catch (error: unknown) {
    if (error instanceof ArtifactNotFoundError || error instanceof ArtifactIntegrityError) {
      throw new PermanentReflectionArtifactError(
        `Reflection artifact ${ref.contentHash} is unavailable or corrupt`,
        { cause: error },
      );
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error: unknown) {
    throw new PermanentReflectionArtifactError(
      "Reflection artifact is not valid JSON",
      { cause: error },
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PermanentReflectionArtifactError("Reflection artifact is not an object");
  }
  const note = (value as { note?: unknown }).note;
  if (typeof note !== "string" || note.trim().length === 0 || note.length > 2_000) {
    throw new PermanentReflectionArtifactError("Reflection artifact has no bounded revise note");
  }
  return note.trim();
}

function narrowObservation(context: MainAfterStepContext): QueuedObservation {
  return {
    runId: context.runId,
    laneId: context.laneId,
    step: context.step,
    goal: structuredClone(context.goal),
    delta: structuredClone(context.delta),
    usage: structuredClone(context.usage),
  };
}

function validateOptions(options: ReflectionSchedulerOptions): void {
  if (options.runId.trim().length === 0 || options.model.trim().length === 0) {
    throw new Error("Reflection scheduler requires runId and model");
  }
  if (
    !Number.isSafeInteger(options.goal.version)
    || options.goal.version < 1
  ) {
    throw new Error(
      "Reflection scheduler requires a positive goal version",
    );
  }
  if (
    !Number.isSafeInteger(options.policy.tetoMaxOutputTokens)
    || options.policy.tetoMaxOutputTokens <= 0
  ) {
    throw new Error("tetoMaxOutputTokens must be a positive integer");
  }
}

function estimateTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / 4);
}

function runModelReservationId(
  runId: RunId,
  laneId: string,
  mainCallIndex: number,
): string {
  return `${runId}:lane:${laneId}:model:${mainCallIndex}`;
}

function totalTokens(usage: TokenUsage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function isHardTrigger(trigger: MainTriggerKind): boolean {
  return trigger === "goal-change"
    || trigger === "repeated-failure"
    || trigger === "contradiction";
}

function assertContextScope(
  context: QueuedObservation,
  runId: RunId,
  laneId: string,
): void {
  if (context.runId !== runId || context.laneId !== laneId) {
    throw new Error(
      `Reflection scheduler for ${runId}/${laneId} received ${context.runId}/${context.laneId}`,
    );
  }
}

function createObservationSignal(
  parent: AbortSignal | undefined,
  stop: AbortSignal,
): AbortSignal {
  const timeout = AbortSignal.timeout(OBSERVATION_DEADLINE_MS);
  return AbortSignal.any(
    parent === undefined ? [stop, timeout] : [parent, stop, timeout],
  );
}

async function withAbort<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw abortError(signal);
  }
  const pending = start();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function isSignalAbort(
  error: unknown,
  signal: AbortSignal | undefined,
): boolean {
  return signal !== undefined
    && signal.aborted
    && (
      error === signal.reason
      || error instanceof Error && error.name === "AbortError"
    );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
