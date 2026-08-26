import { randomUUID } from "node:crypto";

import type { A2AInbox, EventSink, InboxRecord } from "../a2a/index.js";
import type {
  A2AMessage,
  AdviceDisposition,
  AnyEvent,
  Clock,
  Goal,
  LaneId,
  MainTriggerKind,
  RunId,
  RunPolicy,
  TokenUsage,
} from "../domain/index.js";
import { systemClock } from "../domain/index.js";
import { sha256, stableJson } from "../ledger/hash.js";
import {
  IntentNavigator,
  ObservationFrameBuilder,
  TETO_SYSTEM_PROMPT,
  TetoCadence,
  TokenRatioGate,
  type TetoCadenceState,
  type TokenRatioGateState,
} from "../teto/index.js";
import { persistedErrorText } from "./redaction.js";
import type {
  MainAfterStepContext,
  MainBoundaryMessage,
} from "./main-loop.js";

const DEFAULT_TETO_LANE = "teto";
const DEFAULT_MAIN_LANE = "main";
const OBSERVATION_DEADLINE_MS = 30_000;
const MAX_BOUNDARY_ADVICE = 4;
const TETO_INPUT_OVERHEAD_TOKENS = 16;

export interface TetoSchedulerOptions {
  eventSink: EventSink;
  inbox: A2AInbox;
  navigator: IntentNavigator;
  frameBuilder: ObservationFrameBuilder;
  runId: RunId;
  goal: Goal;
  model: string;
  policy: RunPolicy;
  events?: readonly AnyEvent[];
  clock?: Clock;
  mainLaneId?: LaneId;
  tetoLaneId?: LaneId;
  createId?: () => string;
  signal?: AbortSignal;
  /** Shadow preserves the observation and generated Advice facts without
   * claiming or delivering Advice to Main. */
  adviceDelivery?: TetoAdviceDelivery;
}

export type TetoAdviceDelivery = "live" | "shadow";

export interface TetoSchedulerRecoveryOptions {
  runId: RunId;
  mainLaneId?: LaneId;
  tetoLaneId?: LaneId;
}

export interface PreviousAdviceOutcome {
  adviceId: string;
  disposition: AdviceDisposition;
  reason?: string;
}

export interface TetoSchedulerState {
  cadenceState: TetoCadenceState;
  tokenGateState: TokenRatioGateState;
  previousAdviceOutcome?: PreviousAdviceOutcome;
}

interface QueuedMainObservation {
  runId: RunId;
  laneId: LaneId;
  step: number;
  goal: Goal;
  delta: MainAfterStepContext["delta"];
  usage: TokenUsage;
}

export class TetoScheduler {
  private readonly eventSink: EventSink;
  private readonly inbox: A2AInbox;
  private readonly navigator: IntentNavigator;
  private readonly frameBuilder: ObservationFrameBuilder;
  private readonly runId: RunId;
  private readonly model: string;
  private readonly policy: RunPolicy;
  private readonly clock: Clock;
  private readonly mainLaneId: LaneId;
  private readonly tetoLaneId: LaneId;
  private readonly createId: () => string;
  private readonly cadence: TetoCadence;
  private tokenGate: TokenRatioGate;
  private readonly signal: AbortSignal | undefined;
  private readonly adviceDelivery: TetoAdviceDelivery;
  private readonly stopController = new AbortController();
  private accepting = true;
  private goal: Goal;
  private previousAdviceOutcome: PreviousAdviceOutcome | undefined;
  private tail: Promise<void> = Promise.resolve();
  private readonly unrecordedErrors: Error[] = [];

  constructor(options: TetoSchedulerOptions) {
    validateOptions(options);
    this.eventSink = options.eventSink;
    this.inbox = options.inbox;
    this.navigator = options.navigator;
    this.frameBuilder = options.frameBuilder;
    this.runId = options.runId;
    this.model = options.model;
    this.policy = structuredClone(options.policy);
    this.clock = options.clock ?? systemClock;
    this.mainLaneId = options.mainLaneId ?? DEFAULT_MAIN_LANE;
    this.tetoLaneId = options.tetoLaneId ?? DEFAULT_TETO_LANE;
    this.createId = options.createId ?? randomUUID;
    this.signal = options.signal;
    this.adviceDelivery = options.adviceDelivery ?? "live";
    this.goal = structuredClone(options.goal);

    const recovered = recoverTetoSchedulerState(options.events ?? [], {
      runId: this.runId,
      mainLaneId: this.mainLaneId,
      tetoLaneId: this.tetoLaneId,
    });
    this.cadence = new TetoCadence({}, recovered.cadenceState);
    this.tokenGate = new TokenRatioGate(
      this.policy.tetoTokenRatio,
      recovered.tokenGateState,
    );
    this.previousAdviceOutcome = recovered.previousAdviceOutcome;
  }

  /** Called from Main's synchronous afterStep hook. */
  enqueue(context: MainAfterStepContext): void {
    if (!this.accepting) {
      return;
    }
    let operation: Promise<void>;
    try {
      const observation = narrowObservation(context);
      operation = this.tail.then(() => this.process(observation));
    } catch (error: unknown) {
      operation = this.tail.then(() => this.recordFailure(
        `enqueue:${this.createId()}`,
        error,
      ));
    }
    this.tail = operation.catch((error: unknown) => {
      this.unrecordedErrors.push(asError(error));
    });
  }

  /** Claims only Advice that was fully published before this Main boundary. */
  async beforeMainStep(): Promise<readonly MainBoundaryMessage[]> {
    if (!this.policy.tetoEnabled) {
      return [];
    }

    try {
      const records = await this.inbox.claim(this.mainLaneId, this.mainLaneId, {
        claimId: this.createId(),
        limit: MAX_BOUNDARY_ADVICE,
        types: ["advice.propose"],
      });
      return records
        .filter((record) => (
          record.message.runId === this.runId
          && record.message.payload.type === "advice.propose"
        ))
        .map(adviceBoundaryMessage);
    } catch (error: unknown) {
      try {
        await this.recordFailure(`delivery:${this.createId()}`, error);
      } catch (recordError: unknown) {
        this.unrecordedErrors.push(asError(recordError));
      }
      return [];
    }
  }

  async drain(): Promise<void> {
    while (true) {
      const observedTail = this.tail;
      await observedTail;
      if (observedTail === this.tail) {
        break;
      }
    }
    if (this.unrecordedErrors.length > 0) {
      throw new AggregateError(
        [...this.unrecordedErrors],
        "Teto scheduler could not persist one or more failures",
      );
    }
  }

  /** Stop accepting work and cancel an observation that outlived Main. */
  async stop(): Promise<void> {
    this.accepting = false;
    if (!this.stopController.signal.aborted) {
      this.stopController.abort(new DOMException(
        "Teto observation cancelled after Main finished",
        "AbortError",
      ));
    }
    await this.drain();
  }

  snapshot(): TetoSchedulerState {
    return {
      cadenceState: this.cadence.snapshot(),
      tokenGateState: this.tokenGate.snapshot(),
      ...(this.previousAdviceOutcome === undefined
        ? {}
        : { previousAdviceOutcome: structuredClone(this.previousAdviceOutcome) }),
    };
  }

  private async process(context: QueuedMainObservation): Promise<void> {
    if (
      !this.policy.tetoEnabled
      || context.delta.status === "complete"
      || this.stopController.signal.aborted
    ) {
      return;
    }

    let wakePending = false;
    let mainCallIndex: number | undefined;
    let reservationId: string | undefined;
    let reservationSettled = false;
    let passCommitted = false;
    let observationSignal: AbortSignal | undefined;
    try {
      assertContextScope(context, this.runId, this.mainLaneId);
      this.acceptGoal(context.goal);
      this.tokenGate.chargeMain(context.usage);
      const decision = this.cadence.recordMainCall(context.delta.triggerKind);
      mainCallIndex = decision.mainCallIndex;
      if (!decision.shouldWake) {
        return;
      }
      wakePending = true;

      const now = this.clock.now();
      this.previousAdviceOutcome = latestAdviceOutcome(
        this.inbox.snapshot().records,
        this.runId,
        this.tetoLaneId,
      ) ?? this.previousAdviceOutcome;
      const frame = this.frameBuilder.build({
        goal: this.goal,
        mainDelta: context.delta,
        ...(this.previousAdviceOutcome === undefined
          ? {}
          : { previousAdviceOutcome: this.previousAdviceOutcome }),
        budget: {
          maxOutputTokens: this.policy.tetoMaxOutputTokens,
          deadline: new Date(now.getTime() + OBSERVATION_DEADLINE_MS).toISOString(),
        },
      });

      reservationId = `${this.runId}:${this.tetoLaneId}:${decision.mainCallIndex}`;
      const reservationTokens = estimateObservationTokens(frame)
        + frame.budget.maxOutputTokens;
      if (this.tokenGate.reserve(reservationId, reservationTokens) === undefined) {
        this.cadence.skipPass(decision.mainCallIndex);
        wakePending = false;
        return;
      }

      await this.recordLaneStatus(
        decision.mainCallIndex,
        "running",
        `Observing Main boundary ${context.delta.boundaryId}`,
      );
      this.cadence.commitPass(decision.mainCallIndex);
      wakePending = false;
      passCommitted = true;
      const signal = createObservationSignal(this.signal, this.stopController.signal);
      observationSignal = signal;
      const result = await withAbort(() => this.navigator.observe({
        runId: this.runId,
        sessionId: `${this.runId}:${this.tetoLaneId}:${this.model}`,
        frame,
        signal,
      }), signal);

      await this.eventSink.append({
        runId: this.runId,
        laneId: this.tetoLaneId,
        type: "teto.observed",
        payload: {
          mainCallIndex: decision.mainCallIndex,
          trigger: decision.reason ?? context.delta.triggerKind,
          frameHash: sha256(stableJson(frame)),
          usage: result.usage,
        },
        causationId: context.delta.boundaryId,
        correlationId: this.runId,
        idempotencyKey: `teto:${decision.mainCallIndex}:observed`,
        visibility: "run",
        occurredAt: this.clock.now().toISOString(),
      });
      await this.eventSink.append({
        runId: this.runId,
        laneId: this.tetoLaneId,
        type: "budget.charged",
        payload: { laneId: this.tetoLaneId, usage: result.usage },
        causationId: context.delta.boundaryId,
        correlationId: this.runId,
        idempotencyKey: `teto:${decision.mainCallIndex}:budget`,
        visibility: "run",
        occurredAt: this.clock.now().toISOString(),
      });
      this.settleReservation(reservationId, result.usage);
      reservationSettled = true;

      if (result.advice !== undefined) {
        await this.eventSink.append({
          runId: this.runId,
          laneId: this.tetoLaneId,
          type: "teto.advice.generated",
          payload: {
            advice: result.advice,
            delivery: this.adviceDelivery,
          },
          causationId: context.delta.boundaryId,
          correlationId: this.runId,
          idempotencyKey: `teto:${decision.mainCallIndex}:${result.advice.dedupeKey}:generated`,
          visibility: "run",
          occurredAt: this.clock.now().toISOString(),
        });
        if (this.adviceDelivery === "live") {
          await this.inbox.send({
            messageId: this.createId(),
            runId: this.runId,
            conversationId: this.runId,
            threadId: `${this.runId}:${this.mainLaneId}`,
            from: this.tetoLaneId,
            to: this.mainLaneId,
            createdAt: this.clock.now().toISOString(),
            expiresAt: result.advice.expiresAt,
            causationId: context.delta.boundaryId,
            correlationId: this.runId,
            idempotencyKey: `teto:${decision.mainCallIndex}:${result.advice.dedupeKey}`,
            visibility: "run",
            priority: advicePriority(result.advice.risk),
            delivery: result.advice.urgency,
            payload: { type: "advice.propose", advice: result.advice },
          });
        }
      }

      await this.recordLaneStatus(decision.mainCallIndex, "dormant");
    } catch (error: unknown) {
      if (reservationId !== undefined && !reservationSettled) {
        this.tokenGate.cancel(reservationId);
      }
      if (wakePending && !passCommitted) {
        try {
          this.cadence.skipPass();
        } catch {
          // The original failure remains authoritative; no pending pass remains.
        }
      }
      if (isSignalAbort(error, observationSignal)) {
        await this.recordLaneStatus(
          mainCallIndex ?? context.step,
          "cancelled",
          persistedErrorText(error, "Observation cancelled before completion"),
        );
      } else {
        await this.recordFailure(`step:${context.step}`, error);
      }
    }
  }

  private async recordLaneStatus(
    pass: number,
    status: "running" | "dormant" | "cancelled",
    reason?: string,
  ): Promise<void> {
    await this.eventSink.append({
      runId: this.runId,
      laneId: this.tetoLaneId,
      type: "lane.status",
      payload: { status, ...(reason === undefined ? {} : { reason }) },
      correlationId: this.runId,
      idempotencyKey: `teto:${pass}:status:${status}`,
      visibility: "run",
      occurredAt: this.clock.now().toISOString(),
    });
  }

  private acceptGoal(goal: Goal): void {
    if (goal.version < this.goal.version) {
      throw new Error(
        `Stale goal version ${goal.version}; current version is ${this.goal.version}`,
      );
    }
    if (goal.version === this.goal.version && stableJson(goal) !== stableJson(this.goal)) {
      throw new Error(`Goal version ${goal.version} changed without a revision`);
    }
    if (goal.version > this.goal.version) {
      this.goal = structuredClone(goal);
    }
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
      laneId: this.tetoLaneId,
      type: "lane.status",
      payload: { status: "failed", reason: persistedErrorText(error) },
      correlationId: this.runId,
      idempotencyKey: `teto:${scope}:status:failed`,
      visibility: "run",
      occurredAt: this.clock.now().toISOString(),
    });
  }
}

export function recoverTetoSchedulerState(
  events: readonly AnyEvent[],
  options: TetoSchedulerRecoveryOptions,
): TetoSchedulerState {
  const mainLaneId = options.mainLaneId ?? DEFAULT_MAIN_LANE;
  const tetoLaneId = options.tetoLaneId ?? DEFAULT_TETO_LANE;
  const ordered = events
    .filter((event) => event.runId === options.runId)
    .slice()
    .sort((left, right) => left.globalOffset - right.globalOffset);
  const mainCalls: Array<{ trigger: MainTriggerKind; usage: TokenUsage }> = [];
  const pendingMainUsage: TokenUsage[] = [];
  const passCalls = new Set<number>();
  const observedCalls = new Set<number>();
  let tetoTokens = 0;
  const adviceSources = new Map<string, LaneId>();
  let previousAdviceOutcome: PreviousAdviceOutcome | undefined;

  for (const event of ordered) {
    if (event.laneId === mainLaneId && event.type === "model.completed") {
      pendingMainUsage.push(event.payload.usage);
      continue;
    }
    if (event.laneId === mainLaneId && event.type === "navigation.updated") {
      const usage = pendingMainUsage.shift() ?? emptyUsage();
      if (event.payload.delta.status !== "complete") {
        mainCalls.push({ trigger: event.payload.delta.triggerKind, usage });
      }
      continue;
    }
    if (event.laneId === tetoLaneId && event.type === "teto.observed") {
      const call = event.payload.mainCallIndex;
      if (!Number.isSafeInteger(call) || call < 1 || observedCalls.has(call)) {
        throw new Error(`Invalid recovered Teto pass at Main call ${call}`);
      }
      observedCalls.add(call);
      passCalls.add(call);
      tetoTokens += totalTokens(event.payload.usage);
      continue;
    }
    if (
      event.laneId === tetoLaneId
      && event.type === "lane.status"
      && event.payload.status === "running"
    ) {
      const match = /^teto:(\d+):status:running$/.exec(event.idempotencyKey);
      if (match !== null) {
        passCalls.add(Number(match[1]));
      }
      continue;
    }
    if (event.type === "message.sent") {
      const payload = event.payload.message.payload;
      if (payload.type === "advice.propose") {
        adviceSources.set(payload.advice.adviceId, payload.advice.sourceLane);
      }
      continue;
    }
    if (
      event.type === "advice.acknowledged"
      && adviceSources.get(event.payload.adviceId) === tetoLaneId
    ) {
      previousAdviceOutcome = {
        adviceId: event.payload.adviceId,
        disposition: event.payload.disposition,
        ...(event.payload.reason === undefined ? {} : { reason: event.payload.reason }),
      };
    }
  }

  const sortedPassCalls = [...passCalls].sort((left, right) => left - right);
  if ((sortedPassCalls.at(-1) ?? 0) > mainCalls.length) {
    throw new Error("Recovered Teto pass is ahead of the Main call count");
  }

  let credit = 0;
  for (let index = 0; index < mainCalls.length; index += 1) {
    const call = mainCalls[index]!;
    credit = isHardTrigger(call.trigger)
      ? 5
      : Math.min(5, credit + (call.trigger === "decision" ? 2 : 1));
    if (passCalls.has(index + 1)) {
      credit = 0;
    }
  }

  const state: TetoSchedulerState = {
    cadenceState: {
      mainCallIndex: mainCalls.length,
      credit,
      passCalls: sortedPassCalls,
    },
    tokenGateState: {
      mainTokens: mainCalls.reduce(
        (total, call) => total + totalTokens(call.usage),
        0,
      ),
      tetoTokens,
      reservations: [],
    },
    ...(previousAdviceOutcome === undefined ? {} : { previousAdviceOutcome }),
  };
  return state;
}

function narrowObservation(context: MainAfterStepContext): QueuedMainObservation {
  return {
    runId: context.runId,
    laneId: context.laneId,
    step: context.step,
    goal: structuredClone(context.goal),
    delta: structuredClone(context.delta),
    usage: structuredClone(context.usage),
  };
}

function adviceBoundaryMessage(record: InboxRecord): MainBoundaryMessage {
  if (record.message.payload.type !== "advice.propose") {
    throw new Error("Boundary record is not Advice");
  }
  const advice = record.message.payload.advice;
  const evidence = advice.evidenceRefs.length === 0
    ? "none supplied"
    : advice.evidenceRefs.join(", ");
  return {
    kind: "advice",
    source: record.message.from,
    messageId: record.message.messageId,
    content: [
      `adviceId: ${advice.adviceId}`,
      `kind: ${advice.kind}`,
      `claim: ${advice.claim}`,
      `suggestedAction: ${advice.suggestedAction}`,
      `confidence: ${advice.confidence}; risk: ${advice.risk}`,
      `evidenceRefs: ${evidence}`,
      "Use respond_to_advice with this adviceId to accept, defer, or reject it.",
    ].join("\n"),
  };
}

function latestAdviceOutcome(
  records: readonly InboxRecord[],
  runId: RunId,
  sourceLane: LaneId,
): PreviousAdviceOutcome | undefined {
  const acknowledged = records
    .filter((record) => (
      record.message.runId === runId
      && record.message.payload.type === "advice.propose"
      && record.message.payload.advice.sourceLane === sourceLane
      && record.acknowledgement !== undefined
    ))
    .sort((left, right) => Date.parse(
      right.acknowledgement?.acknowledgedAt ?? "",
    ) - Date.parse(left.acknowledgement?.acknowledgedAt ?? ""));
  const latest = acknowledged[0];
  if (latest?.message.payload.type !== "advice.propose") {
    return undefined;
  }
  const acknowledgement = latest.acknowledgement;
  if (acknowledgement === undefined) {
    return undefined;
  }
  return {
    adviceId: latest.message.payload.advice.adviceId,
    disposition: acknowledgement.disposition,
    ...(acknowledgement.reason === undefined ? {} : { reason: acknowledgement.reason }),
  };
}

function estimateObservationTokens(frame: unknown): number {
  return estimateTokens(TETO_SYSTEM_PROMPT)
    + estimateTokens(stableJson(frame))
    + TETO_INPUT_OVERHEAD_TOKENS;
}

function estimateTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / 4);
}

function createObservationSignal(
  parent: AbortSignal | undefined,
  stop: AbortSignal,
): AbortSignal {
  const timeout = AbortSignal.timeout(OBSERVATION_DEADLINE_MS);
  return AbortSignal.any(parent === undefined ? [stop, timeout] : [parent, stop, timeout]);
}

async function withAbort<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw abortError(signal);
  }
  const pending = start();

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
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

function isSignalAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal === undefined || !signal.aborted) {
    return false;
  }
  return error === signal.reason
    || (error instanceof Error && error.name === "AbortError");
}

function advicePriority(risk: "low" | "medium" | "high"): number {
  return risk === "high" ? 8 : risk === "medium" ? 5 : 3;
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
  context: QueuedMainObservation,
  runId: RunId,
  mainLaneId: LaneId,
): void {
  if (context.runId !== runId || context.laneId !== mainLaneId) {
    throw new Error(
      `Teto scheduler for ${runId}/${mainLaneId} received ${context.runId}/${context.laneId}`,
    );
  }
}

function validateOptions(options: TetoSchedulerOptions): void {
  if (options.runId.trim().length === 0 || options.model.trim().length === 0) {
    throw new Error("Teto scheduler requires runId and model");
  }
  if (!Number.isSafeInteger(options.goal.version) || options.goal.version < 1) {
    throw new Error("Teto scheduler requires a positive goal version");
  }
  if (!Number.isSafeInteger(options.policy.tetoMaxOutputTokens)
    || options.policy.tetoMaxOutputTokens <= 0) {
    throw new Error("tetoMaxOutputTokens must be a positive integer");
  }
  if (options.adviceDelivery !== undefined
    && options.adviceDelivery !== "live"
    && options.adviceDelivery !== "shadow") {
    throw new Error("adviceDelivery must be live or shadow");
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
