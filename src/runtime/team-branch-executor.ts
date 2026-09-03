import { randomUUID } from "node:crypto";

import type { A2AInbox, EventSink } from "../a2a/index.js";
import type {
  AnyEvent,
  A2AMessage,
  AppendEvent,
  EventType,
  Goal,
  TaskResult,
  TaskFailed,
} from "../domain/index.js";
import type { AgentTool, Clock, ModelPort } from "../domain/ports.js";
import {
  ContentStoreFukaiSource,
  FukaiContextProvider,
} from "../fukai/index.js";
import { MainLoop } from "./main-loop.js";
import { RunTokenBudget } from "./run-token-budget.js";
import type { RuntimeFukaiCompaction, RuntimeFukaiCompactionFactory } from "./fukai-compaction-runtime.js";
import {
  prepareRuntimeFukaiCompaction,
  runtimeFukaiCompactionBudget,
  instantiateRuntimeFukaiCompaction,
} from "./fukai-compaction-runtime.js";
import { createAgentAwarenessTool } from "./agent-awareness-tool.js";
import { createTetoControlTools } from "./teto-control-tool.js";
import { TetoLaneController } from "./teto-lane-controller.js";
import type { AgentTopologySnapshot } from "./agent-awareness.js";
import { teamGoal } from "./team-tool.js";
import type { ContentAddressedStore } from "../store/index.js";
import type { Ledger } from "../ledger/index.js";
import { persistedErrorText } from "./redaction.js";
import { recoverRunTokenUsageByLane } from "./run-token-budget-recovery.js";

const DEFAULT_MAX_MODEL_TOKENS = 12_000;
const DEFAULT_MAX_WALL_CLOCK_MS = 5 * 60 * 1_000;
const MAX_BRANCH_OUTPUT_TOKENS = 1_024;
const DEFAULT_STOP_WAIT_MS = 250;

type TaskRequestPayload = Extract<A2AMessage["payload"], { type: "task.request" }>;
type TaskRequestMessage = Omit<A2AMessage, "payload"> & { payload: TaskRequestPayload };

export interface TeamBranchExecutorOptions {
  inbox: A2AInbox;
  eventSink: Ledger;
  store: ContentAddressedStore;
  model: ModelPort;
  modelName: string;
  runId: string;
  parentLaneId: string;
  branchLaneId: string;
  /** Durable task goal used by the branch and its optional Teto. */
  goal?: Goal;
  workspace: string;
  tools: readonly AgentTool[];
  runTokenBudget: RunTokenBudget;
  /** Durable Run events available when a branch runtime is reconstructed. */
  events?: readonly AnyEvent[];
  policy?: import("../domain/types.js").RunPolicy;
  policyVersion?: string;
  compactionRuntime?: RuntimeFukaiCompaction;
  createCompactionRuntime?: RuntimeFukaiCompactionFactory;
  clock?: Clock;
  createId?: () => string;
  readEvents: () => Promise<readonly AnyEvent[]>;
  readWatermark: () => Promise<number>;
  readAwareness: () => AgentTopologySnapshot | Promise<AgentTopologySnapshot>;
  signal?: AbortSignal;
}

export interface TeamBranchRunResult {
  status: "idle" | "completed" | "failed";
  taskId?: string;
  replyMessageId?: string;
  reason?: string;
}

/**
 * Executes a Team branch with the ordinary MainLoop/Fukai/Ledger contracts.
 * It is intentionally task-scoped: the branch returns a terminal A2A result
 * and does not become an unbounded resident worker.
 */
export class TeamBranchExecutor {
  private readonly options: TeamBranchExecutorOptions;
  private readonly clock: Clock;
  private readonly createId: () => string;
  private readonly teto: TetoLaneController;
  private readonly guardedEventSink: EventSink;
  private readonly guardedLedger: Ledger;
  private readonly policy: import("../domain/types.js").RunPolicy;
  private readonly tetoTokenBudget: RunTokenBudget;
  private readonly compactionRuntime: RuntimeFukaiCompaction | undefined;
  private compactionPrepared = false;
  private readonly stopController = new AbortController();
  private stopped = false;
  private running: Promise<TeamBranchRunResult> | undefined;

  constructor(options: TeamBranchExecutorOptions) {
    if (options.runId.trim().length === 0 || options.branchLaneId.trim().length === 0) {
      throw new TypeError("Team branch runId and branchLaneId must be non-empty");
    }
    this.options = options;
    this.clock = options.clock ?? { now: () => new Date() };
    this.createId = options.createId ?? randomUUID;
    this.policy = options.policy ?? createTeamBranchPolicy(DEFAULT_MAX_MODEL_TOKENS);
    this.compactionRuntime = options.compactionRuntime;
    this.guardedEventSink = {
      append: async <K extends EventType>(event: AppendEvent<K>) => {
        if (this.stopped || this.stopController.signal.aborted) {
          throw new DOMException("Team branch stopped", "AbortError");
        }
        return options.eventSink.append(event);
      },
    };
    this.guardedLedger = {
      append: this.guardedEventSink.append,
      read: options.eventSink.read.bind(options.eventSink),
      watermark: options.eventSink.watermark.bind(options.eventSink),
      flush: options.eventSink.flush.bind(options.eventSink),
      close: options.eventSink.close.bind(options.eventSink),
    };
    const branchGoal = options.goal ?? {
      version: 1,
      statement: `Feedback for ${options.branchLaneId}`,
      successCriteria: [],
      hardConstraints: [],
    };
    this.tetoTokenBudget = new RunTokenBudget(
      options.runTokenBudget.maxTokens,
      totalTokens(laneUsage(options.events ?? [], options.runId, `${options.branchLaneId}:teto`)),
      { parent: options.runTokenBudget, scope: `${options.branchLaneId}:teto` },
    );
    this.teto = new TetoLaneController({
      eventSink: this.guardedEventSink,
      inbox: options.inbox,
      store: options.store,
      model: options.model,
      modelName: options.modelName,
      runId: options.runId,
      goal: branchGoal,
      policy: this.policy,
      workspace: options.workspace,
      readEvents: options.readEvents,
      readWatermark: options.readWatermark,
      tokenBudget: this.tetoTokenBudget,
      mainLaneId: options.branchLaneId,
      tetoLaneId: `${options.branchLaneId}:teto`,
      ...(options.events === undefined ? {} : { events: options.events }),
      ...(options.createCompactionRuntime === undefined
        ? {}
        : {
            createCompactionRuntime: () => instantiateRuntimeFukaiCompaction(
              this.policy,
              options.createCompactionRuntime!,
              {
                ledger: this.guardedLedger,
                store: options.store,
                modelPort: options.model,
                model: options.modelName,
                tokenBudget: this.tetoTokenBudget,
                clock: this.clock,
                policy: this.policy,
              },
            ),
          }),
      clock: this.clock,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  runOnce(): Promise<TeamBranchRunResult> {
    if (this.running !== undefined) return this.running;
    const operation = this.runOnceInternal();
    this.running = operation.finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Restore this branch's optional Teto when its start control fact survived a restart. */
  async restoreIfRequested(): Promise<boolean> {
    return this.teto.restoreIfRequested(this.options.branchLaneId);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (!this.stopController.signal.aborted) this.stopController.abort(new DOMException("Team branch stopped", "AbortError"));
    const running = this.running;
    if (running !== undefined) {
      await settlesWithin(running.catch(() => undefined), DEFAULT_STOP_WAIT_MS);
    }
    await this.teto.close();
  }

  private async runOnceInternal(): Promise<TeamBranchRunResult> {
    if (this.stopped || this.options.signal?.aborted) return { status: "idle", reason: "stopped" };
    const records = await this.options.inbox.claim(this.options.branchLaneId, this.options.branchLaneId, {
      claimId: `${this.options.branchLaneId}:claim:${this.createId()}`,
      limit: 1,
      runId: this.options.runId,
      types: ["task.request"],
    });
    if (records.length === 0) return { status: "idle" };
    const record = records[0]!;
    if (record.message.runId !== this.options.runId) throw new Error(`Team task belongs to Run ${record.message.runId}`);
    const request = record.message as TaskRequestMessage;
    // A terminal reply may have been committed immediately before a process
    // crash or a lost `message.handled` acknowledgement. Reconcile that fact
    // before invoking the model again; otherwise a redelivery repeats the
    // branch's side effects and can produce competing terminal replies.
    const existingTerminal = this.findTerminal(request);
    if (existingTerminal !== undefined) {
      if (this.stopped || this.options.signal?.aborted) return { status: "idle", reason: "stopped" };
      await this.options.inbox.handle(request.messageId, this.options.branchLaneId);
      return terminalRunResult(existingTerminal);
    }
    let terminalPayload: TaskResult | TaskFailed | undefined;
    try {
      await this.sendReply(request, { type: "task.accept", taskId: request.payload.taskId }, "accept");
      await this.appendStatus("running", `Team branch ${this.options.branchLaneId} claimed a task`);
      const result = await this.executeTask(request);
      if (this.stopped || this.options.signal?.aborted) return { status: "idle", reason: "stopped" };
      const reply = await this.sendReply(request, result.payload, result.kind);
      terminalPayload = result.payload;
      if (this.stopped || this.options.signal?.aborted) return { status: "idle", reason: "stopped" };
      await this.options.inbox.handle(request.messageId, this.options.branchLaneId);
      await this.appendStatus(result.kind === "result" ? "completed" : "failed", `Team branch ${this.options.branchLaneId} finished ${request.payload.taskId}`);
      return {
        status: result.kind === "result" ? "completed" : "failed",
        taskId: request.payload.taskId,
        replyMessageId: reply.messageId,
        ...(result.kind === "failed" ? { reason: result.payload.reason } : {}),
      };
    } catch (error: unknown) {
      if (this.stopped || this.options.signal?.aborted) return { status: "idle", reason: "stopped" };
      // Sending a terminal reply and acknowledging the request are separate
      // durable operations. If the latter fails, preserve the already
      // published terminal instead of appending a contradictory task.failed.
      const committedTerminal = terminalPayload ?? this.findTerminal(request);
      if (committedTerminal !== undefined) {
        return terminalRunResult(committedTerminal);
      }
      const failed: TaskFailed = {
        type: "task.failed",
        taskId: request.payload.taskId,
        reason: persistedErrorText(error, "Team branch failed"),
        retryable: false,
        evidenceRefs: request.payload.inputRefs.map((ref) => ref.contentHash),
      };
      await this.sendReply(request, failed, "failed").catch(() => undefined);
      await this.options.inbox.handle(request.messageId, this.options.branchLaneId).catch(() => undefined);
      await this.appendStatus("failed", failed.reason).catch(() => undefined);
      return { status: "failed", taskId: request.payload.taskId, reason: failed.reason };
    }
  }

  private findTerminal(request: TaskRequestMessage): TaskResult | TaskFailed | undefined {
    const record = this.options.inbox.snapshot().records.find((candidate) => (
      candidate.message.runId === this.options.runId
      && candidate.message.from === this.options.branchLaneId
      && candidate.message.to === request.from
      && candidate.message.parentId === request.messageId
      && (candidate.message.payload.type === "task.result"
        || candidate.message.payload.type === "task.failed")
      && candidate.message.payload.taskId === request.payload.taskId
    ));
    return record?.message.payload.type === "task.result"
      || record?.message.payload.type === "task.failed"
      ? record.message.payload
      : undefined;
  }

  private async executeTask(request: TaskRequestMessage): Promise<
    | { kind: "result"; payload: TaskResult }
    | { kind: "failed"; payload: TaskFailed }
  > {
    const task = request.payload;
    const budget = task.budget;
    const maxModelTokens = Math.min(
      budget.maxModelTokens,
      DEFAULT_MAX_MODEL_TOKENS,
    );
    const deadlineAt = budget.deadline === undefined
      ? Date.parse(request.createdAt) + Math.min(budget.maxWallClockMs, DEFAULT_MAX_WALL_CLOCK_MS)
      : Date.parse(budget.deadline);
    const remainingMs = deadlineAt - this.clock.now().getTime();
    if (!Number.isFinite(deadlineAt) || remainingMs <= 0) {
      return { kind: "failed", payload: failed(task, "Team branch deadline expired") };
    }
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new DOMException("Team branch deadline exceeded", "TimeoutError")), remainingMs);
    timer.unref?.();
    const signal = AbortSignal.any([
      deadline.signal,
      this.stopController.signal,
      ...(this.options.signal === undefined ? [] : [this.options.signal]),
    ]);
    try {
      const goal = task.goal;
      this.teto.setGoal(goal);
      const initialMessage = await this.readTaskInput(goal, task.inputRefs, signal);
      const branchTools = this.branchTools();
      const events = await this.options.readEvents();
      const conversationRefs = recoverConversationRefs(
        events,
        this.options.runId,
        this.options.branchLaneId,
      );
      const upperWatermark = await this.options.readWatermark();
      if (this.compactionRuntime !== undefined && !this.compactionPrepared) {
        this.compactionPrepared = true;
        await prepareRuntimeFukaiCompaction(this.compactionRuntime, {
          runId: this.options.runId,
          laneId: this.options.branchLaneId,
          goal,
          policyVersion: this.options.policyVersion ?? "team-branch-v1",
          upperWatermark,
          conversationRefs,
          budget: runtimeFukaiCompactionBudget(this.policy),
          signal,
        });
      }
      const selectCompaction = this.compactionRuntime?.select.bind(this.compactionRuntime);
      const compactForPressure = this.compactionRuntime?.compactIfNeeded?.bind(this.compactionRuntime);
      const loop = new MainLoop({
        model: this.options.model,
        contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(this.options.store)),
        conversationStore: this.options.store,
        eventSink: this.guardedEventSink,
        tools: branchTools,
        clock: this.clock,
        runTokenBudget: this.options.runTokenBudget,
        eventObserver: (event) => this.teto.observeMainEvent(event),
        beforeStep: async ({ step }) => this.teto.beforeMainStep({ step }),
        afterStep: (context) => this.teto.afterMainStep(context),
        ...(selectCompaction === undefined ? {} : { selectCompaction }),
        ...(compactForPressure === undefined ? {} : { compactForPressure }),
        includeProjectInstructions: false,
      });
      const result = await loop.run({
        runId: this.options.runId,
        laneId: this.options.branchLaneId,
        sessionId: `${this.options.runId}:${this.options.branchLaneId}:${this.options.modelName}`,
        model: this.options.modelName,
        workspace: this.options.workspace,
        goal,
        policy: this.policy,
        systemPrompt: branchSystemPrompt(this.options.branchLaneId),
        laneKind: "team",
        includeProjectInstructions: false,
        completionMode: "none",
        correlationId: request.correlationId,
        ...(conversationRefs.length === 0 ? { initialMessage } : {}),
        conversationRefs,
        startStep: highestLaneStep(events, this.options.runId, this.options.branchLaneId) + 1,
        upperWatermark,
        policyVersion: this.options.policyVersion ?? "team-branch-v1",
        pressureEligibleConversationCount: conversationRefs.length,
        maxOutputTokens: Math.min(MAX_BRANCH_OUTPUT_TOKENS, maxModelTokens),
        signal,
      });
      // The branch result is the task lane's terminal boundary. Teto is an
      // advisory sibling, so a slow observer must not hold that result open.
      await settlesWithin(this.teto.drain(), DEFAULT_STOP_WAIT_MS);
      return {
        kind: "result",
        payload: {
          type: "task.result",
          taskId: task.taskId,
          status: result.completed ? "completed" : "partial",
          summary: result.finalText.slice(0, 8_192),
          evidenceRefs: task.inputRefs.map((ref) => ref.contentHash),
          artifactRefs: result.finalMessageRef === undefined ? [] : [result.finalMessageRef],
          openQuestions: [],
          usage: result.usage,
        },
      };
    } catch (error: unknown) {
      return { kind: "failed", payload: failed(task, persistedErrorText(error, "Team branch failed")) };
    } finally {
      clearTimeout(timer);
    }
  }

  private branchTools(): readonly AgentTool[] {
    const awareness = createAgentAwarenessTool({ read: () => this.options.readAwareness() });
    const controls = createTetoControlTools(this.teto);
    const names = new Set<string>();
    const tools: AgentTool[] = [];
    for (const tool of [...this.options.tools, awareness, ...controls]) {
      if (names.has(tool.definition.name)) {
        throw new Error(`Team branch tool collides with a runtime capability: ${tool.definition.name}`);
      }
      names.add(tool.definition.name);
      tools.push(tool);
    }
    return tools;
  }

  private async readTaskInput(goal: Goal, refs: readonly { id: string; mediaType: string; contentHash: string; byteLength: number }[], signal: AbortSignal): Promise<string> {
    const lines = ["Team branch objective:", goal.statement, "Success criteria:", ...goal.successCriteria.map((item) => `- ${item}`), "Hard constraints:", ...(goal.hardConstraints.length === 0 ? ["- None specified"] : goal.hardConstraints.map((item) => `- ${item}`)), "Attached data:"];
    for (const ref of refs.slice(0, 8)) {
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      if (!ref.mediaType.startsWith("text/") && !ref.mediaType.includes("json")) {
        lines.push(`- ${ref.id} (${ref.mediaType}; not inlined)`);
        continue;
      }
      const bytes = await this.options.store.get(ref);
      lines.push(`--- ${ref.id} ---`, new TextDecoder().decode(bytes.subarray(0, 64 * 1024)), `--- end ${ref.id} ---`);
    }
    return lines.join("\n");
  }

  private async sendReply(
    request: TaskRequestMessage,
    payload: Extract<A2AMessage["payload"], { type: "task.accept" | "task.result" | "task.failed" }>,
    suffix: "accept" | "result" | "failed",
  ): Promise<{ messageId: string }> {
    const messageId = `${this.options.runId}:${this.options.branchLaneId}:task:${request.payload.taskId}:${suffix}`;
    const sent = await this.options.inbox.send({
      messageId,
      runId: this.options.runId,
      conversationId: request.conversationId,
      threadId: request.threadId,
      from: this.options.branchLaneId,
      to: request.from,
      parentId: request.messageId,
      replyTo: request.messageId,
      createdAt: this.clock.now().toISOString(),
      correlationId: request.correlationId,
      idempotencyKey: messageId,
      visibility: request.visibility,
      priority: request.priority,
      delivery: request.delivery,
      payload,
    });
    return { messageId: sent.messageId };
  }

  private async appendStatus(status: "running" | "completed" | "failed", reason: string): Promise<void> {
    await this.guardedEventSink.append({
      runId: this.options.runId,
      laneId: this.options.branchLaneId,
      type: "lane.status",
      payload: { status, reason },
      correlationId: `${this.options.runId}:${this.options.branchLaneId}`,
      idempotencyKey: `${this.options.runId}:${this.options.branchLaneId}:status:${status}:${this.createId()}`,
      visibility: "run",
      occurredAt: this.clock.now().toISOString(),
    });
  }
}

function terminalRunResult(payload: TaskResult | TaskFailed): TeamBranchRunResult {
  return payload.type === "task.result"
    ? {
        status: "completed",
        taskId: payload.taskId,
      }
    : {
        status: "failed",
        taskId: payload.taskId,
        reason: payload.reason,
      };
}

export function createTeamBranchPolicy(
  maxModelTokens: number,
  parentPolicy?: import("../domain/types.js").RunPolicy,
  maxSteps = 2,
): import("../domain/types.js").RunPolicy {
  const base = structuredClone(parentPolicy ?? {
    maxMainStepsPerActivation: 2,
    maxModelTokens: Math.max(1, maxModelTokens),
    mainRequestTimeoutMs: DEFAULT_MAX_WALL_CLOCK_MS,
    tetoEnabled: true,
    tetoMaxOutputTokens: Math.min(512, Math.max(1, maxModelTokens)),
    tetoTokenRatio: 0.1,
    tetoActivation: "manual" as const,
    workerEnabled: false,
  });
  const legacy = base as unknown as { maxMainSteps?: number; auxiliaryMode?: unknown };
  delete legacy.maxMainSteps;
  delete legacy.auxiliaryMode;
  return {
    ...base,
    maxMainStepsPerActivation: Math.max(1, Math.min(8, maxSteps)),
    maxModelTokens: Math.max(1, maxModelTokens),
    mainRequestTimeoutMs: base.mainRequestTimeoutMs ?? DEFAULT_MAX_WALL_CLOCK_MS,
    // Teto is a branch-local optional capability. A parent may leave its own
    // observer dormant while still allowing a branch to open an observer for
    // the branch's independent objective.
    tetoEnabled: true,
    tetoMaxOutputTokens: Math.min(
      base.tetoMaxOutputTokens,
      Math.max(1, maxModelTokens),
    ),
    tetoActivation: "manual",
    workerEnabled: false,
  } as import("../domain/types.js").RunPolicy;
}

async function settlesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function recoverConversationRefs(
  events: readonly AnyEvent[],
  runId: string,
  laneId: string,
): import("../fukai/types.js").FukaiConversationRef[] {
  const refs: import("../fukai/types.js").FukaiConversationRef[] = [];
  let sequence = 0;
  for (const event of events
    .filter((candidate) => candidate.runId === runId && candidate.laneId === laneId)
    .toSorted((left, right) => left.globalOffset - right.globalOffset)) {
    const ref = event.type === "user.message" || event.type === "assistant.message"
      ? event.payload.messageRef
      : event.type === "tool.succeeded" || event.type === "tool.failed"
        ? event.payload.resultRef
        : undefined;
    if (ref === undefined) continue;
    sequence += 1;
    refs.push({ ref, sequence, groupId: `${laneId}:recovered:${event.eventId}` });
  }
  return refs;
}

function laneUsage(
  events: readonly AnyEvent[],
  runId: string,
  laneId: string,
): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  return recoverRunTokenUsageByLane(events, runId)
    .find((lane) => lane.laneId === laneId)?.usage
    ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function totalTokens(usage: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function highestLaneStep(
  events: readonly AnyEvent[],
  runId: string,
  laneId: string,
): number {
  return events.reduce((highest, event) => (
    event.runId === runId
      && event.laneId === laneId
      && event.type === "step.started"
      ? Math.max(highest, event.payload.step)
      : highest
  ), 0);
}

function branchSystemPrompt(laneId: string): string {
  return `You are a Team branch (${laneId}). Complete only the assigned branch objective, use the available read-only tools for evidence, and return a concise result for the parent lane. You may call agent_awareness to inspect the current topology and teto_start when a second line of thought would materially help. Teto is advisory; decide yourself whether to use its voice.`;
}

function failed(task: TaskRequestPayload, reason: string): TaskFailed {
  return {
    type: "task.failed",
    taskId: task.taskId,
    reason,
    retryable: false,
    evidenceRefs: task.inputRefs.map((ref) => ref.contentHash),
  };
}
