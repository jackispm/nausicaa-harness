import { randomUUID } from "node:crypto";

import type { A2AInbox } from "../a2a/index.js";
import type { AnyEvent } from "../domain/events.js";
import type { AgentTool, Clock, ModelPort, ToolExecutionContext } from "../domain/ports.js";
import type { ArtifactRef, Goal, LaneId, RunId, TaskRequest } from "../domain/types.js";
import type { ContentAddressedStore } from "../store/index.js";
import type { Ledger } from "../ledger/index.js";
import { sha256, stableJson } from "../ledger/hash.js";
import type { RuntimeFukaiCompaction, RuntimeFukaiCompactionFactory } from "./fukai-compaction-runtime.js";
import { instantiateRuntimeFukaiCompaction } from "./fukai-compaction-runtime.js";
import { RunTokenBudget } from "./run-token-budget.js";
import { TaskDispatcher } from "./task-dispatcher.js";
import {
  projectCommittedBoundaryMessageIds,
  WorkerLaneScheduler,
} from "./worker-lane-scheduler.js";
import { recoverRunTokenUsageByLane } from "./run-token-budget-recovery.js";
import { createTeamBranchPolicy, TeamBranchExecutor } from "./team-branch-executor.js";
import type { AgentTopologySnapshot } from "./agent-awareness.js";
import type { TeamControl, TeamCreateRequest, TeamCreateResult, TeamBranchRequest } from "./team-tool.js";
import { teamGoal } from "./team-tool.js";
import {
  DEFAULT_SUBAGENT_MAX_DEPTH,
  MAX_SUBAGENT_NAME_LENGTH,
  assertSubagentSpawnAllowed,
  createCollisionResistantChildName,
  evaluateSubagentDepth,
  normalizeSubagentName,
} from "./subagent-policy.js";

const DEFAULT_PARENT_LANE = "main";
const DEFAULT_BRANCH_MODEL_TOKENS = 12_000;
const DEFAULT_BRANCH_WALL_CLOCK_MS = 5 * 60 * 1_000;
const DEFAULT_BRANCH_ATTEMPTS = 2;
const MAX_TEAMS = 16;
const MAX_BRANCHES_PER_TEAM = 16;
const MAX_ID_LENGTH = 96;

interface BranchRuntime {
  readonly teamId: string;
  readonly branchId: string;
  readonly laneId: LaneId;
  readonly tokenBudget: RunTokenBudget;
  readonly scheduler: WorkerLaneScheduler;
  readonly executor: TeamBranchExecutor;
}

interface PreparedTeamBranch {
  readonly branch: TeamBranchRequest;
  readonly branchId: string;
  readonly taskBudget: {
    maxModelTokens: number;
    maxWallClockMs: number;
    maxAttempts: number;
  };
  readonly inputRef?: ArtifactRef;
}

export interface TeamRuntimeOptions {
  /** Session/one-shot sinks are Ledgers and remain the single persistence boundary. */
  eventSink: Ledger;
  inbox: A2AInbox;
  store: ContentAddressedStore;
  model: ModelPort;
  modelName: string;
  runId: RunId;
  workspace: string;
  parentLaneId?: LaneId;
  /** Current parent depth; root Main uses zero. */
  depth?: number;
  /** Absolute recursion limit for this host composition. */
  maxDepth?: number;
  branchTools: readonly AgentTool[];
  runTokenBudget: RunTokenBudget;
  readEvents: () => Promise<readonly AnyEvent[]>;
  readWatermark: () => Promise<number>;
  readAwareness: () => AgentTopologySnapshot | Promise<AgentTopologySnapshot>;
  /** Parent policy copied into each ordinary Team branch lane. */
  policy?: import("../domain/types.js").RunPolicy;
  policyVersion?: string;
  createCompactionRuntime?: RuntimeFukaiCompactionFactory;
  clock?: Clock;
  createId?: () => string;
  signal?: AbortSignal;
}

/**
 * Creates bounded Team branches and keeps their schedulers behind Main's
 * normal boundary hooks. Branches are ordinary lanes; this class only owns
 * their admission and lifecycle, not a second persistence system.
 */
export class TeamRuntime implements TeamControl {
  readonly runId: RunId;
  readonly parentLaneId: LaneId;

  private readonly options: TeamRuntimeOptions;
  private readonly inbox: A2AInbox;
  private readonly store: ContentAddressedStore;
  private readonly clock: Clock;
  private readonly createId: () => string;
  private readonly depth: number;
  private readonly maxDepth: number;
  private readonly branches = new Map<string, BranchRuntime>();
  private readonly teams = new Map<string, string[]>();
  private readonly teamFingerprints = new Map<string, string>();
  /** In-process source of truth used to finish a partially admitted Team. */
  private readonly teamDefinitions = new Map<string, readonly PreparedTeamBranch[]>();
  private lifecycleTail: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(options: TeamRuntimeOptions) {
    if (options.runId.trim().length === 0 || options.modelName.trim().length === 0) throw new TypeError("Team runtime runId and modelName must be non-empty");
    this.options = options;
    this.runId = options.runId;
    this.parentLaneId = options.parentLaneId ?? DEFAULT_PARENT_LANE;
    this.inbox = options.inbox;
    this.store = options.store;
    this.clock = options.clock ?? { now: () => new Date() };
    this.createId = options.createId ?? randomUUID;
    this.depth = options.depth ?? 0;
    this.maxDepth = options.maxDepth ?? DEFAULT_SUBAGENT_MAX_DEPTH;
    evaluateSubagentDepth(this.depth, this.maxDepth);
  }

  create(request: TeamCreateRequest, context: ToolExecutionContext): Promise<TeamCreateResult> {
    return this.enqueueLifecycle(() => this.createInternal(request, context));
  }

  /** Rebuild branch schedulers from durable lane registrations and task requests. */
  async restore(): Promise<void> {
    await this.enqueueLifecycle(async () => {
      if (this.stopped) return;
      const events = await this.options.readEvents();
      const records = this.inbox.snapshot().records;
      // Task requests are the durable branch intent. Rebuild the complete
      // definition before restoring in-memory schedulers so a retry can fill
      // a branch whose lane registration was interrupted.
      const durableDefinitions = new Map<string, PreparedTeamBranch[]>();
      for (const record of records) {
        const message = record.message;
        if (
          message.runId !== this.runId
          || message.from !== this.parentLaneId
          || message.payload.type !== "task.request"
        ) continue;
        const identity = parseBranchLane(message.to);
        if (identity === undefined) continue;
        const prepared = preparedBranchFromTask(identity.branchId, message.payload);
        const definition = durableDefinitions.get(identity.teamId) ?? [];
        if (!definition.some((item) => item.branchId === prepared.branchId)) {
          definition.push(prepared);
        }
        durableDefinitions.set(identity.teamId, definition);
      }
      for (const [teamId, definition] of durableDefinitions) {
        definition.sort((left, right) => left.branchId.localeCompare(right.branchId));
        this.teamDefinitions.set(teamId, definition);
      }
      const registered = events
        .filter((event): event is Extract<AnyEvent, { type: "lane.registered" }> => (
          event.runId === this.runId
          && event.type === "lane.registered"
          && event.payload.kind === "team"
        ))
        .map((event) => event.laneId);
      for (const laneId of registered) {
        const identity = parseBranchLane(laneId);
        if (identity === undefined || this.branches.has(laneId)) continue;
        const requestRecord = records.find((record) => (
          record.message.runId === this.runId
          && record.message.to === laneId
          && record.message.payload.type === "task.request"
        ));
        if (requestRecord?.message.payload.type !== "task.request") continue;
        if (this.teams.size >= MAX_TEAMS) break;
        const taskBudget = requestRecord.message.payload.budget;
        const branchBudget = new RunTokenBudget(
          taskBudget.maxModelTokens,
          laneFamilyTokens(events, this.runId, laneId),
          { parent: this.options.runTokenBudget, scope: laneId },
        );
        const runtime = this.createBranchRuntime(
          identity.teamId,
          identity.branchId,
          laneId,
          branchBudget,
          events,
          taskBudget,
          requestRecord.message.payload.goal,
        );
        this.branches.set(laneId, runtime);
        const laneIds = this.teams.get(identity.teamId) ?? [];
        if (!laneIds.includes(laneId)) laneIds.push(laneId);
        this.teams.set(identity.teamId, laneIds);
        const registration = events.find((event): event is Extract<AnyEvent, { type: "lane.registered" }> => (
          event.runId === this.runId
          && event.laneId === laneId
          && event.type === "lane.registered"
        ));
        if (registration?.payload.teamFingerprint !== undefined) {
          this.teamFingerprints.set(identity.teamId, registration.payload.teamFingerprint);
        } else if (!this.teamFingerprints.has(identity.teamId)) {
          // Legacy Team registrations predate durable request fingerprints.
          // Refuse to silently treat an arbitrary retry as the old request.
          this.teamFingerprints.set(identity.teamId, "legacy-without-fingerprint");
        }
        if (!latestBranchTerminal(events, this.runId, laneId)) {
          await runtime.executor.restoreIfRequested();
        }
        runtime.scheduler.enqueue();
      }
    });
  }

  private async createInternal(request: TeamCreateRequest, context: ToolExecutionContext): Promise<TeamCreateResult> {
    if (this.stopped) throw new Error("Team runtime is stopped");
    assertOwner(context, this.runId, this.parentLaneId);
    if (!Array.isArray(request.branches) || request.branches.length < 1) {
      throw new RangeError("A Team must contain at least one branch");
    }
    if (request.branches.length > MAX_BRANCHES_PER_TEAM) throw new RangeError(`A Team may contain at most ${MAX_BRANCHES_PER_TEAM} branches`);
    const teamId = normalizeId(request.teamId ?? this.createId(), "teamId");
    const fingerprint = teamRequestFingerprint(request);
    const existing = this.teams.get(teamId);
    if (existing !== undefined) {
      const previousFingerprint = this.teamFingerprints.get(teamId);
      if (previousFingerprint !== undefined && previousFingerprint !== fingerprint) {
        throw new Error(`Team ${teamId} already exists with different branch requests`);
      }
      const definition = this.teamDefinitions.get(teamId);
      if (definition !== undefined) {
        const branches = await this.ensureBranches(teamId, definition, context, true);
        return { teamId, branches };
      }
      return {
        teamId,
        branches: existing.map((laneId) => ({ branchId: branchIdFromLane(laneId), laneId, status: "duplicate" as const })),
      };
    }
    // Check recursion before storing branch input or appending lane facts.
    assertSubagentSpawnAllowed(this.depth, this.maxDepth);
    if (this.teams.size >= MAX_TEAMS) throw new Error(`Team limit reached (${MAX_TEAMS})`);
    const preparedBranches = [] as PreparedTeamBranch[];
    const branchIds = new Set<string>();
    for (const branch of request.branches) {
      const requestedBranchId = branch.branchId === undefined
        ? createCollisionResistantChildName(branch.statement, this.createId(), {
            maxLength: MAX_SUBAGENT_NAME_LENGTH,
          })
        : branch.branchId;
      const branchId = normalizeSubagentName(
        requestedBranchId,
        { maxLength: MAX_SUBAGENT_NAME_LENGTH },
      );
      if (branchIds.has(branchId)) throw new Error(`Duplicate Team branch: ${branchId}`);
      branchIds.add(branchId);
      validateBranchRequest(branch);
      const taskBudget = {
        maxModelTokens: branch.maxModelTokens ?? DEFAULT_BRANCH_MODEL_TOKENS,
        maxWallClockMs: branch.maxWallClockMs ?? DEFAULT_BRANCH_WALL_CLOCK_MS,
        maxAttempts: branch.maxAttempts ?? DEFAULT_BRANCH_ATTEMPTS,
      };
      validateBudget(taskBudget);
      const inputRef = branch.input === undefined
        ? undefined
        : await this.store.put(branch.input, "text/plain");
      preparedBranches.push({
        branch,
        branchId,
        taskBudget,
        ...(inputRef === undefined ? {} : { inputRef }),
      });
    }
    // Publish the in-process definition before external writes. If a later
    // branch fails, a same-fingerprint retry can resume from the first gap.
    this.teams.set(teamId, []);
    this.teamFingerprints.set(teamId, fingerprint);
    this.teamDefinitions.set(teamId, preparedBranches);
    const branches = await this.ensureBranches(teamId, preparedBranches, context, false);
    return { teamId, branches };
  }

  private async ensureBranches(
    teamId: string,
    preparedBranches: readonly PreparedTeamBranch[],
    context: ToolExecutionContext,
    duplicateExisting: boolean,
  ): Promise<{ branchId: string; laneId: string; status: "queued" | "duplicate" }[]> {
    const laneIds = this.teams.get(teamId) ?? [];
    const fingerprint = this.teamFingerprints.get(teamId);
    if (fingerprint === undefined) throw new Error(`Team ${teamId} has no request fingerprint`);
    const results: { branchId: string; laneId: string; status: "queued" | "duplicate" }[] = [];

    // Publish every task request before mutating lane admission. A crash in a
    // later registration then leaves enough durable intent for restore to
    // reconstruct the complete Team definition.
    for (const prepared of preparedBranches) {
      const { branch, branchId, taskBudget, inputRef } = prepared;
      const dispatcher = new TaskDispatcher({
        inbox: this.inbox,
        runId: this.runId,
        from: this.parentLaneId,
        to: `team:${teamId}:${branchId}`,
        conversationId: this.runId,
        threadId: `${this.runId}:team:${teamId}`,
        correlationId: `${this.runId}:team:${teamId}`,
        clock: this.clock,
      });
      await dispatcher.dispatch({
        taskId: `${teamId}:${branchId}`,
        from: this.parentLaneId,
        to: `team:${teamId}:${branchId}`,
        goal: teamGoal(branch),
        inputRefs: inputRef === undefined ? [] : [inputRef],
        budget: taskBudget,
      });
    }

    for (const prepared of preparedBranches) {
      const { branch, branchId, taskBudget, inputRef } = prepared;
      const laneId = `team:${teamId}:${branchId}`;
      const alreadyAdmitted = this.branches.has(laneId);
      const events = await this.options.readEvents();
      const registration = events.find((event): event is Extract<AnyEvent, { type: "lane.registered" }> => (
        event.runId === this.runId
        && event.laneId === laneId
        && event.type === "lane.registered"
      ));
      if (registration?.payload.teamFingerprint !== undefined && registration.payload.teamFingerprint !== fingerprint) {
        throw new Error(`Team ${teamId} branch ${branchId} has a different request fingerprint`);
      }
      const branchBudget = new RunTokenBudget(
        taskBudget.maxModelTokens,
        laneFamilyTokens(events, this.runId, laneId),
        { parent: this.options.runTokenBudget, scope: laneId },
      );
      await this.options.eventSink.append({
        runId: this.runId,
        laneId,
        type: "lane.registered",
        payload: { kind: "team", teamFingerprint: fingerprint },
        correlationId: `${this.runId}:team:${teamId}`,
        idempotencyKey: `${this.runId}:${laneId}:registered`,
        visibility: "run",
        occurredAt: this.clock.now().toISOString(),
      });
      await this.options.eventSink.append({
        runId: this.runId,
        laneId,
        type: "lane.status",
        payload: {
          status: "ready",
          reason: `Team ${teamId} branch admitted`,
          control: { action: "start", requestedBy: context.laneId ?? this.parentLaneId },
        },
        correlationId: `${this.runId}:team:${teamId}`,
        idempotencyKey: `${this.runId}:${laneId}:control:start`,
        visibility: "run",
        occurredAt: this.clock.now().toISOString(),
      });
      let runtime = this.branches.get(laneId);
      if (runtime === undefined) {
        runtime = this.createBranchRuntime(
          teamId,
          branchId,
          laneId,
          branchBudget,
          events,
          taskBudget,
          teamGoal(branch),
        );
        this.branches.set(laneId, runtime);
      }
      if (!laneIds.includes(laneId)) laneIds.push(laneId);
      runtime.scheduler.enqueue();
      results.push({
        branchId,
        laneId,
        status: duplicateExisting && alreadyAdmitted ? "duplicate" : "queued",
      });
    }
    this.teams.set(teamId, laneIds);
    return results;
  }

  status(_context: ToolExecutionContext): unknown {
    return {
      teams: [...this.teams.entries()].map(([teamId, laneIds]) => ({
        teamId,
        branches: laneIds.map((laneId) => ({
          laneId,
          active: this.branches.get(laneId)?.scheduler.pendingActivations !== 0,
        })),
      })),
    };
  }

  async beforeMainStep(context?: { step: number }): Promise<readonly import("./main-loop.js").MainBoundaryMessage[]> {
    const messages = await Promise.all([...this.branches.values()].map((branch) => branch.scheduler.beforeMainStep(context)));
    return messages.flat();
  }

  enqueue(context?: import("./main-loop.js").MainAfterStepContext): void {
    for (const branch of this.branches.values()) branch.scheduler.enqueue(context);
  }

  async drain(): Promise<void> {
    await Promise.all([...this.branches.values()].map((branch) => branch.scheduler.drain()));
  }

  async stop(): Promise<void> {
    await this.enqueueLifecycle(async () => {
      this.stopped = true;
      await Promise.all([...this.branches.values()].map((branch) => branch.scheduler.stop()));
      this.branches.clear();
      this.teams.clear();
      this.teamDefinitions.clear();
      this.teamFingerprints.clear();
    });
  }

  private createBranchRuntime(
    teamId: string,
    branchId: string,
    laneId: LaneId,
    tokenBudget: RunTokenBudget,
    events: readonly AnyEvent[],
    taskBudget?: { maxModelTokens: number; maxAttempts?: number },
    goal?: Goal,
  ): BranchRuntime {
    const branchPolicy = createTeamBranchPolicy(
      taskBudget?.maxModelTokens ?? tokenBudget.maxTokens,
      this.options.policy,
      taskBudget?.maxAttempts,
    );
    const compactionRuntime = this.options.createCompactionRuntime === undefined
      ? undefined
      : instantiateRuntimeFukaiCompaction(branchPolicy, this.options.createCompactionRuntime, {
          ledger: this.options.eventSink,
          store: this.store,
          modelPort: this.options.model,
          model: this.options.modelName,
          tokenBudget,
          clock: this.clock,
          policy: branchPolicy,
        });
    const executor = new TeamBranchExecutor({
      inbox: this.inbox,
      eventSink: this.options.eventSink,
      store: this.store,
      model: this.options.model,
      modelName: this.options.modelName,
      runId: this.runId,
      parentLaneId: this.parentLaneId,
      branchLaneId: laneId,
      ...(goal === undefined ? {} : { goal }),
      workspace: this.options.workspace,
      tools: this.options.branchTools,
      runTokenBudget: tokenBudget,
      events,
      clock: this.clock,
      createId: this.createId,
      readEvents: this.options.readEvents,
      readWatermark: this.options.readWatermark,
      readAwareness: this.options.readAwareness,
      policy: branchPolicy,
      ...(this.options.policyVersion === undefined ? {} : { policyVersion: this.options.policyVersion }),
      ...(compactionRuntime === undefined ? {} : { compactionRuntime }),
      ...(this.options.createCompactionRuntime === undefined
        ? {}
        : { createCompactionRuntime: this.options.createCompactionRuntime }),
      ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
    });
    const scheduler = new WorkerLaneScheduler({
      executor,
      inbox: this.inbox,
      runId: this.runId,
      mainLaneId: this.parentLaneId,
      workerLaneId: laneId,
      committedBoundaryMessageIds: projectCommittedBoundaryMessageIds(
        events,
        this.runId,
        this.parentLaneId,
      ),
      ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
    });
    return { teamId, branchId, laneId, tokenBudget, scheduler, executor };
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleTail.then(operation);
    this.lifecycleTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function normalizeId(value: string, field: string): string {
  if (value.trim().length === 0 || value.includes("\0")) throw new TypeError(`${field} must be non-empty and free of NUL`);
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/gu, "-");
  if (normalized.length === 0 || normalized.length > MAX_ID_LENGTH) throw new RangeError(`${field} is too long or invalid`);
  return normalized;
}

function teamRequestFingerprint(request: TeamCreateRequest): string {
  // This is deliberately content-only. The Team id is already the map key,
  // while stableJson makes retries deterministic across object key order.
  return sha256(stableJson(request.branches));
}

function validateBranchRequest(branch: TeamBranchRequest): void {
  if (branch === null || typeof branch !== "object") {
    throw new TypeError("Team branch must be an object");
  }
  if (typeof branch.statement !== "string" || branch.statement.trim().length === 0 || branch.statement.includes("\0")) {
    throw new TypeError("branch statement must be a non-empty string");
  }
  for (const [name, value] of [
    ["successCriteria", branch.successCriteria],
    ["hardConstraints", branch.hardConstraints],
  ] as const) {
    if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.includes("\0")))) {
      throw new TypeError(`branch ${name} must be an array of strings`);
    }
  }
  if (branch.input !== undefined && (typeof branch.input !== "string" || branch.input.includes("\0"))) {
    throw new TypeError("branch input must be a string");
  }
}

function assertOwner(context: ToolExecutionContext, runId: RunId, laneId: LaneId): void {
  if (context.runId !== runId) throw new Error("Team capability is bound to another Run");
  if (context.laneId !== undefined && context.laneId !== laneId) {
    throw new Error(`Team capability is bound to lane ${laneId}`);
  }
}

function branchIdFromLane(laneId: string): string {
  return parseBranchLane(laneId)?.branchId ?? laneId;
}

function preparedBranchFromTask(
  branchId: string,
  payload: TaskRequest,
): PreparedTeamBranch {
  const inputRef = payload.inputRefs[0];
  return {
    branch: {
      branchId,
      statement: payload.goal.statement,
      successCriteria: [...payload.goal.successCriteria],
      hardConstraints: [...payload.goal.hardConstraints],
    },
    branchId,
    taskBudget: {
      maxModelTokens: payload.budget.maxModelTokens,
      maxWallClockMs: payload.budget.maxWallClockMs,
      maxAttempts: payload.budget.maxAttempts ?? DEFAULT_BRANCH_ATTEMPTS,
    },
    ...(inputRef === undefined ? {} : { inputRef: structuredClone(inputRef) }),
  };
}

function parseBranchLane(laneId: string): { teamId: string; branchId: string } | undefined {
  const parts = laneId.split(":");
  const [prefix, teamId, branchId] = parts;
  if (parts.length !== 3 || prefix !== "team" || teamId === undefined || branchId === undefined || teamId.length === 0 || branchId.length === 0) {
    return undefined;
  }
  return { teamId, branchId };
}

function totalTokens(usage: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** Branch Main and its optional nested Teto share one task allowance. */
function laneFamilyTokens(events: readonly AnyEvent[], runId: string, laneId: string): number {
  return recoverRunTokenUsageByLane(events, runId)
    .filter((lane) => lane.laneId === laneId || lane.laneId === `${laneId}:teto`)
    .reduce((total, lane) => total + totalTokens(lane.usage), 0);
}

function laneUsage(
  events: readonly AnyEvent[],
  runId: string,
  laneId: string,
): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  const usage = events
    .filter((event) => event.runId === runId && event.type === "budget.charged" && event.payload.laneId === laneId)
    .reduce((total, event) => event.type === "budget.charged"
      ? {
          input: total.input + event.payload.usage.input,
          output: total.output + event.payload.usage.output,
          cacheRead: total.cacheRead + event.payload.usage.cacheRead,
          cacheWrite: total.cacheWrite + event.payload.usage.cacheWrite,
        }
      : total,
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  return usage;
}

function latestBranchTerminal(
  events: readonly AnyEvent[],
  runId: string,
  laneId: string,
): boolean {
  const latest = events
    .filter((event) => (
      event.runId === runId
      && event.laneId === laneId
      && event.type === "lane.status"
    ))
    .toSorted((left, right) => left.globalOffset - right.globalOffset)
    .at(-1);
  return latest?.type === "lane.status"
    && (latest.payload.status === "completed"
      || latest.payload.status === "failed"
      || latest.payload.status === "cancelled");
}

function validateBudget(value: { maxModelTokens: number; maxWallClockMs: number; maxAttempts: number }): void {
  if (!Number.isSafeInteger(value.maxModelTokens) || value.maxModelTokens < 1) throw new RangeError("maxModelTokens must be a positive integer");
  if (!Number.isSafeInteger(value.maxWallClockMs) || value.maxWallClockMs < 1) throw new RangeError("maxWallClockMs must be a positive integer");
  if (!Number.isSafeInteger(value.maxAttempts) || value.maxAttempts < 1) throw new RangeError("maxAttempts must be a positive integer");
}
