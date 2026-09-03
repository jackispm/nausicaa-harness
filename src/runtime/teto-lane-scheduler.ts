import { randomUUID } from "node:crypto";

import type { A2AInbox, EventSink, InboxRecord } from "../a2a/index.js";
import type { AnyEvent } from "../domain/events.js";
import type {
  AgentTool,
  Clock,
  ModelPort,
} from "../domain/ports.js";
import type {
  ConversationMessage,
  Goal,
  LaneId,
  DeliveryMode,
  RunId,
  RunPolicy,
  TokenUsage,
} from "../domain/types.js";
import {
  ContentStoreFukaiSource,
  FukaiContextProvider,
} from "../fukai/index.js";
import type {
  FukaiConversationRef,
  MainContextProvider,
} from "../fukai/types.js";
import type { ContentAddressedStore } from "../store/index.js";
import { recoverRunTokenUsageByLane } from "./run-token-budget-recovery.js";
import {
  prepareRuntimeFukaiCompaction,
  runtimeFukaiCompactionBudget,
  type RuntimeFukaiCompaction,
} from "./fukai-compaction-runtime.js";
import {
  MainLoop,
  MainRunTokenBudgetExhaustedError,
  type MainAfterStepContext,
  type MainBeforeStepContext,
  type MainBoundaryMessage,
} from "./main-loop.js";
import {
  isMainPublicEvent,
  projectMainPublicEvent,
  readConversationMessage,
  type MainPublicEvent,
} from "./main-public-projection.js";
import { createInRunAgentMessageTool } from "./in-run-agent-message-tool.js";
import { persistedErrorText } from "./redaction.js";
import { RunTokenBudget } from "./run-token-budget.js";

const DEFAULT_MAIN_LANE = "main";
const DEFAULT_TETO_LANE = "teto";
const DEFAULT_STOP_WAIT_MS = 250;
const DEFAULT_DELIVERIES: readonly DeliveryMode[] = ["urgent", "next-step", "next-turn"];
const DEFAULT_TETO_SYSTEM_PROMPT = `You are Teto, an independent observer lane alongside Main.
Use only the public context supplied by the runtime.
Do not perform workspace work.
Send relevant observations to Main through the available messaging tool.`;

export interface TetoLaneSchedulerOptions {
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
  contextProvider?: MainContextProvider;
  tools?: readonly AgentTool[];
  compactionRuntime?: RuntimeFukaiCompaction;
  policyVersion?: string;
  clock?: Clock;
  mainLaneId?: LaneId;
  tetoLaneId?: LaneId;
  createId?: () => string;
  signal?: AbortSignal;
  /** Re-queue public Main facts not already present in Teto's transcript. */
  replayPublicEvents?: boolean;
  /** Read the current shared Ledger watermark for Fukai request metadata. */
  readWatermark?: () => Promise<number>;
  /** Independent Teto allowance. Defaults to the Main configured allowance. */
  tokenBudget?: RunTokenBudget;
  systemPrompt?: string;
  stopWaitMs?: number;
}

/**
 * Runs Teto as an ordinary lane backed by MainLoop and Fukai.
 *
 * Main only contributes a public event stream. Every projected event is
 * appended to Teto's own transcript and processed serially, so Teto remains
 * coherent while the observer hook itself stays non-blocking for Main.
 */
export class TetoLaneScheduler {
  readonly runId: RunId;
  readonly laneId: LaneId;
  readonly mainLaneId: LaneId;
  readonly modelName: string;
  readonly tokenBudget: RunTokenBudget;

  private readonly eventSink: EventSink;
  private readonly inbox: A2AInbox;
  private readonly store: TetoLaneSchedulerOptions["store"];
  private readonly model: ModelPort;
  private readonly workspace: string;
  private readonly goal: Goal;
  private readonly policy: RunPolicy;
  private readonly contextProvider: MainContextProvider;
  private readonly tools: readonly AgentTool[];
  private readonly compactionRuntime: RuntimeFukaiCompaction | undefined;
  private readonly policyVersion: string;
  private readonly clock: Clock;
  private readonly createId: () => string;
  private readonly signal: AbortSignal | undefined;
  private readonly readWatermark: () => Promise<number>;
  private readonly stopController = new AbortController();
  private readonly systemPrompt: string;
  private readonly stopWaitMs: number;
  private readonly seenMainEventIds = new Set<string>();
  private readonly completedMainEventIds = new Set<string>();
  private readonly projectedSourceEventIds = new Set<string>();
  private readonly seenToolCallIds = new Set<string>();
  private readonly failures: Error[] = [];
  private readonly pendingVoiceIds = new Set<string>();
  private conversationRefs: FukaiConversationRef[];
  private nextStep: number;
  private compactionPrepared = false;
  private budgetExhausted = false;
  private accepting = true;
  private tail: Promise<void> = Promise.resolve();
  private receiptTail: Promise<void> = Promise.resolve();

  constructor(options: TetoLaneSchedulerOptions) {
    validateOptions(options);
    this.eventSink = options.eventSink;
    this.inbox = options.inbox;
    this.store = options.store;
    this.model = options.model;
    this.modelName = options.modelName;
    this.runId = options.runId;
    this.laneId = options.tetoLaneId ?? DEFAULT_TETO_LANE;
    this.mainLaneId = options.mainLaneId ?? DEFAULT_MAIN_LANE;
    this.workspace = options.workspace;
    this.goal = structuredClone(options.goal);
    this.policy = lanePolicy(options.policy);
    this.policyVersion = options.policyVersion ?? "teto-lane-v1";
    this.clock = options.clock ?? { now: () => new Date() };
    this.createId = options.createId ?? randomUUID;
    this.signal = options.signal;
    this.readWatermark = options.readWatermark ?? (async () => 0);
    this.systemPrompt = options.systemPrompt ?? DEFAULT_TETO_SYSTEM_PROMPT;
    this.stopWaitMs = options.stopWaitMs ?? DEFAULT_STOP_WAIT_MS;
    if (!Number.isSafeInteger(this.stopWaitMs) || this.stopWaitMs < 1) {
      throw new RangeError("stopWaitMs must be a positive integer");
    }
    this.contextProvider = options.contextProvider
      ?? new FukaiContextProvider(new ContentStoreFukaiSource(this.store));
    this.compactionRuntime = options.compactionRuntime;
    const recoveredUsage = recoverRunTokenUsageByLane(options.events ?? [], this.runId)
      .find((lane) => lane.laneId === this.laneId)?.usage;
    this.tokenBudget = options.tokenBudget
      ?? new RunTokenBudget(
        this.policy.maxModelTokens,
        totalTokens(recoveredUsage ?? emptyUsage()),
      );
    this.conversationRefs = recoverConversationRefs(options.events ?? [], this.runId, this.laneId);
    for (const eventId of recoverProjectedSourceEventIds(
      options.events ?? [],
      this.runId,
      this.laneId,
    )) {
      this.projectedSourceEventIds.add(eventId);
    }
    this.nextStep = highestStep(options.events ?? [], this.runId, this.laneId) + 1;
    for (const eventId of recoverCompletedMainEventIds(
      options.events ?? [],
      this.runId,
      this.laneId,
    )) {
      this.completedMainEventIds.add(eventId);
      this.seenMainEventIds.add(eventId);
    }
    this.budgetExhausted = this.tokenBudget.availableTokens() === 0;
    this.tail = recoverSeenToolCallIds(
      this.store,
      options.events ?? [],
      this.runId,
      this.laneId,
      this.mainLaneId,
    ).then((toolCallIds) => {
      for (const toolCallId of toolCallIds) this.seenToolCallIds.add(toolCallId);
    }).catch((error: unknown) => {
      this.failures.push(asError(error));
    });
    const defaultTool = createInRunAgentMessageTool({
      inbox: this.inbox,
      runId: this.runId,
      from: this.laneId,
      to: this.mainLaneId,
      conversationId: this.runId,
      threadId: `${this.runId}:${this.mainLaneId}`,
      correlationId: `${this.runId}:${this.laneId}`,
      createId: this.createId,
      now: () => this.clock.now(),
    });
    this.tools = options.tools === undefined
      ? [defaultTool]
      : [...options.tools];
    if (options.replayPublicEvents === true) {
      for (const event of [...(options.events ?? [])].sort(
        (left, right) => left.globalOffset - right.globalOffset,
      )) {
        this.observeMainEvent(event);
      }
    }
  }

  /**
   * Main's event observer calls this synchronously. It only appends to a
   * serial promise chain and never waits for a Teto model request.
   */
  observeMainEvent(event: AnyEvent): void {
    if (
      !this.accepting
      || this.budgetExhausted
      || this.stopController.signal.aborted
      || this.signal?.aborted
    ) return;
    if (!isMainPublicEvent(event, this.mainLaneId)) return;
    if (
      event.runId !== this.runId
      || this.completedMainEventIds.has(event.eventId)
      || this.seenMainEventIds.has(event.eventId)
    ) return;
    this.seenMainEventIds.add(event.eventId);
    const operation = this.tail.then(() => this.process(event));
    this.tail = operation.catch(async (error: unknown) => {
      if (!(error instanceof MainRunTokenBudgetExhaustedError)) {
        this.failures.push(asError(error));
      }
      const recorder = error instanceof MainRunTokenBudgetExhaustedError
        ? Promise.resolve()
        : isAbortError(error)
        ? this.recordCancelled(event.eventId, error)
        : this.recordFailure(event.eventId, error);
      await recorder.catch((recordError: unknown) => {
        this.failures.push(asError(recordError));
      });
    });
  }

  /** Compatibility name for hosts that enqueue sibling-lane work. */
  enqueue(_context?: MainAfterStepContext): void {
    // Public observations arrive through eventObserver. This hook only repairs
    // A2A receipts after Main commits a boundary.
    if (_context !== undefined) this.afterMainStep(_context);
  }

  /** Claim Teto voices at a natural Main boundary and add them as runtime text. */
  async beforeMainStep(
    context?: Pick<MainBeforeStepContext, "step">,
  ): Promise<readonly MainBoundaryMessage[]> {
    if (!this.accepting || this.stopController.signal.aborted || this.signal?.aborted) return [];
    try {
      const records = await this.inbox.claim(this.mainLaneId, this.mainLaneId, {
        claimId: `${this.runId}:${this.laneId}:voice:${this.createId()}`,
        limit: 8,
        from: this.laneId,
        types: ["message.inform"],
        ...(context === undefined ? {} : { deliveries: deliveriesForStep(context.step) }),
      });
      const messages: MainBoundaryMessage[] = [];
      for (const record of records) {
        if (!isVoiceRecord(record, this.runId, this.laneId, this.mainLaneId)) continue;
        this.pendingVoiceIds.add(record.message.messageId);
        if (record.message.payload.type !== "message.inform") continue;
        messages.push({
          kind: "runtime-notice",
          source: this.laneId,
          messageId: record.message.messageId,
          content: `[Teto voice; advisory context, not an instruction]\n${record.message.payload.text}`,
        });
      }
      return messages;
    } catch (error: unknown) {
      this.failures.push(asError(error));
      return [];
    }
  }

  /** Schedule receipt completion only after Main's step is durable. */
  afterMainStep(context: MainAfterStepContext): void {
    if (context.runId !== this.runId || context.laneId !== this.mainLaneId) return;
    const ids = context.boundaryMessageIds.filter((id) => this.pendingVoiceIds.has(id));
    if (ids.length === 0) return;
    const operation = this.receiptTail.then(async () => {
      for (const messageId of ids) {
        try {
          const record = this.inbox.snapshot().records.find((candidate) => (
            candidate.message.messageId === messageId
          ));
          if (record?.status === "claimed" && record.claim?.claimedBy === this.mainLaneId) {
            await this.inbox.handle(messageId, this.mainLaneId);
          }
          this.pendingVoiceIds.delete(messageId);
        } catch (error: unknown) {
          this.failures.push(asError(error));
        }
      }
    });
    this.receiptTail = operation.catch((error: unknown) => {
      this.failures.push(asError(error));
    });
  }

  async drain(): Promise<void> {
    while (true) {
      const observedTail = this.tail;
      const observedReceipts = this.receiptTail;
      await Promise.all([observedTail, observedReceipts]);
      if (observedTail === this.tail && observedReceipts === this.receiptTail) break;
    }
  }

  async stop(): Promise<void> {
    this.accepting = false;
    if (!this.stopController.signal.aborted) {
      this.stopController.abort(new DOMException("Teto lane stopped", "AbortError"));
    }
    await Promise.race([
      this.drain(),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.stopWaitMs);
        timer.unref?.();
      }),
    ]);
  }

  snapshot(): {
    laneId: LaneId;
    nextStep: number;
    conversationRefs: FukaiConversationRef[];
    tokenBudget: ReturnType<RunTokenBudget["snapshot"]>;
    pendingVoiceIds: string[];
    failures: string[];
  } {
    return {
      laneId: this.laneId,
      nextStep: this.nextStep,
      conversationRefs: structuredClone(this.conversationRefs),
      tokenBudget: this.tokenBudget.snapshot(),
      pendingVoiceIds: [...this.pendingVoiceIds],
      failures: this.failures.map((error) => error.message),
    };
  }

  private async process(event: MainPublicEvent): Promise<void> {
    if (
      !this.accepting
      || this.budgetExhausted
      || this.stopController.signal.aborted
      || this.signal?.aborted
    ) return;
    const projection = await projectMainPublicEvent(this.store, event);
    if (projection === undefined) {
      await this.recordFailure(
        event.eventId,
        new Error(`Unable to project public Main event ${event.eventId}`),
      );
      return;
    }
    if (projection.toolCallId !== undefined && this.seenToolCallIds.has(projection.toolCallId)) {
      await this.markEventDormant(event);
      return;
    }
    for (const toolCallId of projection.toolCallIds) this.seenToolCallIds.add(toolCallId);
    if (projection.toolCallId !== undefined) this.seenToolCallIds.add(projection.toolCallId);

    const sourceCorrelationId = `${this.runId}:${this.laneId}:source:${event.eventId}`;
    const alreadyProjected = this.projectedSourceEventIds.has(event.eventId);
    await this.eventSink.append({
      runId: this.runId,
      laneId: this.laneId,
      type: "lane.status",
      payload: { status: "running", reason: `observing Main event ${event.eventId}` },
      correlationId: sourceCorrelationId,
      idempotencyKey: `${this.runId}:${this.laneId}:status:running:${event.eventId}`,
      visibility: "run",
      occurredAt: this.clock.now().toISOString(),
    });

    const upperWatermark = Math.max(event.globalOffset, await this.readWatermark());
    if (this.compactionRuntime !== undefined && !this.compactionPrepared) {
      this.compactionPrepared = true;
      await prepareRuntimeFukaiCompaction(this.compactionRuntime, {
        runId: this.runId,
        laneId: this.laneId,
        goal: this.goal,
        policyVersion: this.policyVersion,
        upperWatermark,
        conversationRefs: this.conversationRefs,
        budget: runtimeFukaiCompactionBudget(this.policy),
        ...(this.signal === undefined
          ? { signal: this.stopController.signal }
          : { signal: AbortSignal.any([this.signal, this.stopController.signal]) }),
      });
    }
    const activationStep = this.nextStep;
    // Reserve the step number before entering MainLoop. If a provider or tool
    // fails after step.started, the next public event must receive a fresh
    // idempotency namespace rather than replaying that failed step's keys.
    this.nextStep += 1;
    let result: Awaited<ReturnType<MainLoop["run"]>>;
    try {
      result = await this.loop().run({
        runId: this.runId,
        laneId: this.laneId,
        sessionId: `${this.runId}:${this.laneId}:${this.modelName}`,
        model: this.modelName,
        workspace: this.workspace,
        goal: this.goal,
        policy: this.policy,
        systemPrompt: this.systemPrompt,
        laneKind: "intent-navigator",
        includeProjectInstructions: false,
        completionMode: "none",
        correlationId: sourceCorrelationId,
        ...(alreadyProjected
          ? {}
          : {
              initialMessage: projection.message.content,
              ...(projection.message.role !== "user" || projection.message.images === undefined
                ? {}
                : { initialImages: structuredClone(projection.message.images) }),
              initialMessageSourceEventId: event.eventId,
              initialMessageSourceLane: this.mainLaneId,
            }),
        conversationRefs: this.conversationRefs,
        startStep: activationStep,
        upperWatermark,
        maxOutputTokens: this.policy.tetoMaxOutputTokens,
        policyVersion: this.policyVersion,
        ...(this.signal === undefined
          ? { signal: this.stopController.signal }
          : { signal: AbortSignal.any([this.signal, this.stopController.signal]) }),
      });
    } catch (error: unknown) {
      if (error instanceof MainRunTokenBudgetExhaustedError) {
        this.budgetExhausted = true;
        await this.recordBudgetExhausted(event.eventId);
      }
      throw error;
    }
    this.conversationRefs = result.conversationRefs;
    await this.eventSink.append({
      runId: this.runId,
      laneId: this.laneId,
      type: "lane.status",
      payload: { status: "dormant" },
      correlationId: sourceCorrelationId,
      idempotencyKey: `${this.runId}:${this.laneId}:status:dormant:${event.eventId}`,
      visibility: "run",
      occurredAt: this.clock.now().toISOString(),
    });
    this.projectedSourceEventIds.add(event.eventId);
    this.completedMainEventIds.add(event.eventId);
  }

  private async markEventDormant(event: MainPublicEvent): Promise<void> {
    const sourceCorrelationId = `${this.runId}:${this.laneId}:source:${event.eventId}`;
    await this.eventSink.append({
      runId: this.runId,
      laneId: this.laneId,
      type: "lane.status",
      payload: {
        status: "dormant",
        reason: `public Main event ${event.eventId} was already represented in Teto context`,
      },
      correlationId: sourceCorrelationId,
      idempotencyKey: `${this.runId}:${this.laneId}:status:dormant:${event.eventId}`,
      visibility: "run",
      occurredAt: this.clock.now().toISOString(),
    });
    this.completedMainEventIds.add(event.eventId);
  }

  private loop(): MainLoop {
    const selectCompaction = this.compactionRuntime?.select.bind(this.compactionRuntime);
    const compactForPressure = this.compactionRuntime?.compactIfNeeded?.bind(
      this.compactionRuntime,
    );
    return new MainLoop({
      model: this.model,
      contextProvider: this.contextProvider,
      conversationStore: this.store,
      eventSink: this.eventSink,
      tools: this.tools,
      clock: this.clock,
      runTokenBudget: this.tokenBudget,
      ...(selectCompaction === undefined ? {} : { selectCompaction }),
      ...(compactForPressure === undefined ? {} : { compactForPressure }),
      includeProjectInstructions: false,
    });
  }

  private async recordFailure(sourceEventId: string, error: unknown): Promise<void> {
    await this.eventSink.append({
      runId: this.runId,
      laneId: this.laneId,
      type: "lane.status",
      payload: { status: "failed", reason: persistedErrorText(error) },
      correlationId: `${this.runId}:${this.laneId}:source:${sourceEventId}`,
      idempotencyKey: `${this.runId}:${this.laneId}:status:failed:${sourceEventId}`,
      visibility: "run",
      occurredAt: this.clock.now().toISOString(),
    });
  }

  private async recordCancelled(sourceEventId: string, error: unknown): Promise<void> {
    await this.eventSink.append({
      runId: this.runId,
      laneId: this.laneId,
      type: "lane.status",
      payload: {
        status: "cancelled",
        reason: persistedErrorText(error, "Teto lane cancelled"),
      },
      correlationId: `${this.runId}:${this.laneId}:source:${sourceEventId}`,
      idempotencyKey: `${this.runId}:${this.laneId}:status:cancelled:${sourceEventId}`,
      visibility: "run",
      occurredAt: this.clock.now().toISOString(),
    });
  }

  private async recordBudgetExhausted(sourceEventId: string): Promise<void> {
    await this.eventSink.append({
      runId: this.runId,
      laneId: this.laneId,
      type: "lane.status",
      payload: {
        status: "waiting",
        reason: "Teto token budget exhausted",
      },
      correlationId: `${this.runId}:${this.laneId}:source:${sourceEventId}`,
      idempotencyKey: `${this.runId}:${this.laneId}:status:budget-exhausted`,
      visibility: "run",
      occurredAt: this.clock.now().toISOString(),
    });
  }
}

function lanePolicy(policy: RunPolicy): RunPolicy {
  // Each public Main fact opens one coherent Teto thought. A2A is a side
  // effect of that thought; no follow-up provider turn is required just to
  // acknowledge the send, and Teto never owns the Run/Turn completion fact.
  return {
    ...structuredClone(policy),
    maxMainStepsPerActivation: 1,
  } as RunPolicy;
}

function recoverConversationRefs(
  events: readonly AnyEvent[],
  runId: RunId,
  laneId: LaneId,
): FukaiConversationRef[] {
  const refs: FukaiConversationRef[] = [];
  let sequence = 0;
  for (const event of [...events].filter((candidate) => (
    candidate.runId === runId && candidate.laneId === laneId
  )).sort(
    (left, right) => left.globalOffset - right.globalOffset,
  )) {
    const ref = conversationRefForEvent(event);
    if (ref === undefined) continue;
    sequence += 1;
    refs.push({
      ref,
      sequence,
      groupId: `${laneId}:recovered:${event.eventId}`,
    });
  }
  return refs;
}

function recoverCompletedMainEventIds(
  events: readonly AnyEvent[],
  runId: RunId,
  laneId: LaneId,
): string[] {
  const prefix = `${runId}:${laneId}:status:dormant:`;
  return events
    .filter((event) => (
      event.runId === runId
      && event.laneId === laneId
      && event.type === "lane.status"
      && event.payload.status === "dormant"
      && event.idempotencyKey.startsWith(prefix)
    ))
    .map((event) => event.idempotencyKey.slice(prefix.length))
    .filter((eventId) => eventId.length > 0);
}

function recoverProjectedSourceEventIds(
  events: readonly AnyEvent[],
  runId: RunId,
  laneId: LaneId,
): string[] {
  const sourceEventIds = new Set<string>();
  for (const event of events) {
    if (
      event.runId !== runId
      || event.laneId !== laneId
      || event.type !== "user.message"
    ) continue;
    const sourceEventId = event.payload.sourceEventId;
    if (typeof sourceEventId === "string" && sourceEventId.length > 0) {
      sourceEventIds.add(sourceEventId);
    }
  }
  return [...sourceEventIds];
}

async function recoverSeenToolCallIds(
  store: Pick<ContentAddressedStore, "get">,
  events: readonly AnyEvent[],
  runId: RunId,
  laneId: LaneId,
  mainLaneId: LaneId,
): Promise<string[]> {
  const projectedSourceEventIds = new Set(
    recoverProjectedSourceEventIds(events, runId, laneId),
  );
  if (projectedSourceEventIds.size === 0) return [];

  const toolCallIds = new Set<string>();
  const projectedAssistantEvents = events
    .filter((event): event is Extract<AnyEvent, { type: "assistant.message" }> => (
      event.runId === runId
      && event.laneId === mainLaneId
      && event.type === "assistant.message"
      && projectedSourceEventIds.has(event.eventId)
    ))
    .sort((left, right) => left.globalOffset - right.globalOffset);
  for (const event of projectedAssistantEvents) {
    const message = await readConversationMessage(store, event.payload.messageRef);
    if (message?.role !== "assistant") continue;
    for (const toolCall of message.toolCalls) toolCallIds.add(toolCall.id);
  }
  return [...toolCallIds];
}

function conversationRefForEvent(event: AnyEvent): FukaiConversationRef["ref"] | undefined {
  switch (event.type) {
    case "user.message":
    case "assistant.message":
      return event.payload.messageRef;
    case "tool.succeeded":
    case "tool.failed":
      return event.payload.resultRef;
    default:
      return undefined;
  }
}

function highestStep(events: readonly AnyEvent[], runId: RunId, laneId: LaneId): number {
  return events.reduce((highest, event) => (
    event.runId === runId
      && event.laneId === laneId
      && event.type === "step.started"
      ? Math.max(highest, event.payload.step)
      : highest
  ), 0);
}

function isVoiceRecord(
  record: InboxRecord,
  runId: RunId,
  from: LaneId,
  to: LaneId,
): boolean {
  return record.message.runId === runId
    && record.message.from === from
    && record.message.to === to
    && record.message.payload.type === "message.inform";
}

function deliveriesForStep(step: number): readonly DeliveryMode[] {
  return step <= 1 ? DEFAULT_DELIVERIES : ["urgent", "next-step"];
}

function totalTokens(usage: TokenUsage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function validateOptions(options: TetoLaneSchedulerOptions): void {
  for (const [name, value] of [
    ["runId", options.runId],
    ["modelName", options.modelName],
    ["workspace", options.workspace],
  ] as const) {
    if (value.trim().length === 0 || value.includes("\0")) {
      throw new TypeError(`${name} must be non-empty and free of NUL`);
    }
  }
  if (!Number.isSafeInteger(options.policy.maxModelTokens) || options.policy.maxModelTokens <= 0) {
    throw new RangeError("Teto policy maxModelTokens must be a positive integer");
  }
  if (!Number.isSafeInteger(options.policy.tetoMaxOutputTokens)
    || options.policy.tetoMaxOutputTokens <= 0) {
    throw new RangeError("Teto policy tetoMaxOutputTokens must be a positive integer");
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
