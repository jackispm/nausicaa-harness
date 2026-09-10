import { randomUUID } from "node:crypto";

import type { A2AInbox, InboxClaim } from "../a2a/index.js";
import type { AnyEvent } from "../domain/events.js";
import type { TeamCapabilityGrant, TeamDefinition, TeamMemberDefinition } from "../domain/team.js";
import { MAX_TASK_ATTEMPTS, MAX_TASK_MODEL_TOKENS, MAX_TASK_WALL_CLOCK_MS } from "../domain/types.js";
import type { AgentTool, Clock, ModelPort, ToolExecutionContext } from "../domain/ports.js";
import type {
  ArtifactRef,
  Goal,
  LaneId,
  RunId,
  SpawnContext,
  TaskBudget,
  TaskFailed,
  TaskRequest,
  TaskResult,
} from "../domain/types.js";
import type { ContentAddressedStore } from "../store/index.js";
import type { Ledger } from "../ledger/index.js";
import { sha256, stableJson } from "../ledger/hash.js";
import type { RuntimeFukaiCompactionFactory } from "./fukai-compaction-runtime.js";
import { instantiateRuntimeFukaiCompaction } from "./fukai-compaction-runtime.js";
import { RunTokenBudget } from "./run-token-budget.js";
import { TaskDispatcher } from "./task-dispatcher.js";
import {
  projectCommittedBoundaryMessageIds,
  WorkerLaneScheduler,
} from "./worker-lane-scheduler.js";
import { recoverRunTokenUsageByLane } from "./run-token-budget-recovery.js";
import { createTeamBranchPolicy, TeamBranchExecutor, teamTaskReplyMessage } from "./team-branch-executor.js";
import type { AgentTopologySnapshot } from "./agent-awareness.js";
import type {
  TeamCloseRequest,
  TeamControl,
  TeamCreateRequest,
  TeamCreateResult,
  TeamHistoryRequest,
  TeamHistoryResult,
  TeamMessageRequest,
  TeamMessageResult,
  TeamBranchRequest,
  TeamReduceRequest,
  TeamAssignRequest,
  TeamAssignResult,
  TeamWaitRequest,
} from "./team-tool.js";
import {
  createTaskWaitTool,
  createTeamAssignTool,
  createTeamCancelTool,
  createTeamCloseTool,
  createTeamHistoryTool,
  createTeamMessageTool,
  createTeamPresentTool,
  createTeamReduceTool,
  createTeamStatusTool,
  createTeamTool,
} from "./team-tool.js";
import { normalizeTeamCreateRequest, teamGoal } from "./team-tool.js";
import { projectTeamBoards, type TeamBoard } from "./team-board.js";
import type { TeamRunReport, TeamTaskAssignment } from "../domain/team.js";
import { capabilityEntriesFromTools, createScopedSpawnContext } from "./lane-context.js";
import { FIRST_PARTY_MOWE_METADATA, MoweCatalog } from "../mowe/catalog.js";
import type { MoweAgentTool } from "../mowe/types.js";
import { TeamLifecycle } from "./team-lifecycle.js";
import { LaneMailbox } from "./lane-mailbox.js";
import { TeamWaitCoordinator } from "./team-wait-coordinator.js";
import { createInRunAgentMessageTool } from "./in-run-agent-message-tool.js";
import { publicAgentName, publicLaneName, resolveLaneTarget } from "./lane-names.js";
import {
  appendTeamChannelMessage,
  readTeamChannelHistory,
  teamChannelCursor,
  publishTeamRunReport,
  serializeTeamChannelWrite,
} from "./team-channel.js";
import {
  DEFAULT_SUBAGENT_MAX_DEPTH,
  MAX_SUBAGENT_NAME_LENGTH,
  assertSubagentSpawnAllowed,
  evaluateSubagentDepth,
  normalizeSubagentName,
} from "./subagent-policy.js";

const DEFAULT_PARENT_LANE = "main";
const DEFAULT_BRANCH_ATTEMPTS = 2;
const MAX_TEAMS = 16;
const MAX_BRANCHES_PER_TEAM = 16;
const MAX_ID_LENGTH = 96;
const NESTED_TEAM_TOOL_NAMES = [
  "team_create", "team_assign",
  "team_close", "team_cancel", "team_reduce", "team_present",
  "child_team_message", "child_team_history",
] as const;
const RUNTIME_CAPABILITY_DESCRIPTIONS: Record<string, string> = {
  agent_awareness: "Inspect the authorized lane topology.",
  agent_message: "Send an authorized private A2A message.",
  teto_start: "Start the lane's auxiliary Teto observer.",
  teto_stop: "Stop the lane's auxiliary Teto observer.",
  teto_status: "Read the lane's auxiliary Teto status.",
};

interface BranchRuntime {
  readonly teamId: string;
  readonly branchId: string;
  readonly laneId: LaneId;
  readonly tokenBudget: RunTokenBudget;
  readonly scheduler: WorkerLaneScheduler;
  readonly executor: TeamBranchExecutor;
}

type TeamTaskAssignedEvent = {
  runId: RunId;
  type: "team.task.assigned";
  payload: TeamTaskAssignment;
};

type TeamRunReportedEvent = {
  runId: RunId;
  type: "team.run.reported";
  payload: TeamRunReport & { reportId: string; runId: RunId };
};

interface PreparedTeamBranch {
  readonly branch: TeamBranchRequest;
  readonly branchId: string;
  readonly taskBudget: TaskBudget;
  readonly inputRef?: ArtifactRef;
  readonly task?: TaskRequest;
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
  /** Main's host-authorized catalog, or a provider for a changing session grant. */
  branchTools: readonly AgentTool[] | (() => readonly AgentTool[]);
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
  /** The session host can schedule Main after a durable Team notification. */
  onWake?: () => void;
  /** Interactive hosts may let Main finish a Turn while Team work continues. */
  asyncCompletion?: boolean;
  /** Host-owned context projection for each Team branch request. */
  spawnContext?: (input: {
    teamId: string;
    branchId: string;
    laneId: LaneId;
    goal: Goal;
    inputRefs: readonly ArtifactRef[];
    budget: TaskBudget;
  }) => SpawnContext;
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
  /** Branches admitted by restart repair but not yet reported to the caller. */
  private readonly recoveredAdmissions = new Set<string>();
  private readonly durableDefinitions = new Map<string, TeamDefinition>();
  private readonly closedTeams = new Set<string>();
  private readonly reducers = new Map<string, BranchRuntime>();
  /** A Team member may lead one child Team when depth policy allows it. */
  private readonly nestedRuntimes = new Map<LaneId, TeamRuntime>();
  private readonly fencedLanes = new Set<string>();
  private readonly lifecycle: TeamLifecycle;
  private mailbox: LaneMailbox | undefined;
  private deliveryCursor = 0;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private stopped = false;
  private waitCoordinator = new TeamWaitCoordinator();

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
    this.lifecycle = new TeamLifecycle({
      runId: this.runId,
      leadLaneId: this.parentLaneId,
      ledger: options.eventSink,
      inbox: options.inbox,
      clock: this.clock,
      readEvents: options.readEvents,
      stopMember: async (laneId) => {
        this.fencedLanes.add(laneId);
        const runtime = this.branches.get(laneId) ?? [...this.reducers.values()].find((item) => item.laneId === laneId);
        await runtime?.executor.stop();
      },
      ...(options.onWake === undefined ? {} : { onWake: options.onWake }),
      onStateChange: () => this.notifyStateChange(),
    });
  }

  private availableBranchTools(): readonly AgentTool[] {
    return typeof this.options.branchTools === "function"
      ? this.options.branchTools()
      : this.options.branchTools;
  }

  create(request: TeamCreateRequest, context: ToolExecutionContext): Promise<TeamCreateResult> {
    return this.enqueueLifecycle(() => this.createInternal(request, context));
  }

  /** Rebuild branch schedulers from durable lane registrations and task requests. */
  async restore(): Promise<void> {
    await this.enqueueLifecycle(async () => {
      if (this.stopped) return;
      const events = await this.options.readEvents();
      for (const event of events) {
        if (event.type === "team.closed" && event.runId === this.runId) this.closedTeams.add(event.payload.teamId);
      }
      if (!events.some((event) => event.runId === this.runId && (event.type === "team.created" || (event.type === "lane.registered" && event.payload.kind === "team") || (event.type === "message.sent" && event.payload.message.to.startsWith("team:"))))) return;
      const records = this.inbox.snapshot().records;
      const residentAssignments = events as unknown as Array<AnyEvent | TeamTaskAssignedEvent | TeamRunReportedEvent>;
      const reportedResidentTaskIds = new Set(residentAssignments.flatMap((event) => {
        const candidate = event as TeamRunReportedEvent;
        return candidate.type === "team.run.reported" ? [candidate.payload.taskId] : [];
      }));
      const residentTaskLanes = new Set(residentAssignments.flatMap((event) => {
        const candidate = event as TeamTaskAssignedEvent;
        return candidate.type === "team.task.assigned" && !reportedResidentTaskIds.has(candidate.payload.taskId)
          ? [candidate.payload.laneId] : [];
      }));
      // Task requests are the durable branch intent. Rebuild the complete
      // definition before restoring in-memory schedulers so a retry can fill
      // a branch whose lane registration was interrupted.
      const durableDefinitions = new Map<string, PreparedTeamBranch[]>();
      for (const board of await this.lifecycle.boards()) {
        const definition = currentTeamDefinition(board);
        if (definition === undefined) continue;
        if (board.lifecycleState === "closed") this.closedTeams.add(definition.teamId);
        this.durableDefinitions.set(definition.teamId, definition);
        this.teamFingerprints.set(definition.teamId, definition.fingerprint);
        durableDefinitions.set(definition.teamId, definition.members.map((member) => ({
          ...preparedBranchFromTask(member.memberId, member.task),
          branch: {
            ...preparedBranchFromTask(member.memberId, member.task).branch,
            dependsOn: member.dependsOn,
            required: member.required,
            ...(member.capabilities === undefined ? {} : { capabilities: structuredClone(member.capabilities) }),
          },
        })));
      }
      for (const record of records) {
        const message = record.message;
        if (
          message.runId !== this.runId
          || message.from !== this.parentLaneId
          || message.payload.type !== "task.request"
        ) continue;
        const identity = parseBranchLane(message.to);
        if (identity === undefined) continue;
        const admitted = this.durableDefinitions.get(identity.teamId);
        if (admitted !== undefined && !admitted.members.some((member) => member.laneId === message.to && stableJson(member.task) === stableJson(message.payload))) continue;
        const prepared = preparedBranchFromTask(identity.branchId, message.payload);
        const definition = durableDefinitions.get(identity.teamId) ?? [];
        if (!definition.some((item) => item.branchId === prepared.branchId)) {
          definition.push(prepared);
        }
        durableDefinitions.set(identity.teamId, definition);
      }
      for (const [teamId, definition] of durableDefinitions) {
        if (this.closedTeams.has(teamId)) continue;
        definition.sort((left, right) => left.branchId.localeCompare(right.branchId));
        this.teamDefinitions.set(teamId, definition);
      }
      await this.lifecycle.restore();
      await this.repairReportedHandoffs();
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
        if (residentTaskLanes.has(laneId)) continue;
        if ((await this.lifecycle.boards()).some((board) => board.teamId === identity.teamId && board.cancellationRequested)) continue;
        const definition = this.durableDefinitions.get(identity.teamId);
        const member = definition?.members.find((item) => item.laneId === laneId);
        if (definition !== undefined && member === undefined) continue;
        const requestRecord = records.find((record) => (
          record.message.runId === this.runId
          && record.message.from === this.parentLaneId
          && record.message.to === laneId
          && record.message.payload.type === "task.request"
          && (member === undefined || stableJson(record.message.payload) === stableJson(member.task))
        ));
        if (requestRecord?.message.payload.type !== "task.request") continue;
        if (this.teams.size >= MAX_TEAMS) break;
        const taskBudget = requestRecord.message.payload.budget;
        // The task allowance is enforced by the branch policy after a model
        // response.  Keep this lane budget unbounded for context admission:
        // tool schemas and the current task can legitimately exceed a small
        // output allowance, while the parent Run budget still gates the
        // actual provider reservation.
        const branchBudget = new RunTokenBudget(
          undefined,
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
        if (registration?.payload.teamFingerprint !== undefined && !this.durableDefinitions.has(identity.teamId)) {
          this.teamFingerprints.set(identity.teamId, registration.payload.teamFingerprint);
        } else if (!this.teamFingerprints.has(identity.teamId)) {
          // Legacy Team registrations predate durable request fingerprints.
          // Refuse to silently treat an arbitrary retry as the old request.
          this.teamFingerprints.set(identity.teamId, "legacy-without-fingerprint");
        }
        if (!(await this.lifecycle.boards()).some((board) => board.members.some((member) => member.laneId === laneId && member.terminal))) {
          await runtime.executor.restoreIfRequested();
        }
        if (!residentTaskLanes.has(laneId)) runtime.scheduler.enqueue();
      }

      // A crash may happen after the durable task.request but before the
      // lane.registered append. Re-run the host-owned, idempotent admission
      // from the task definition so that branch is recoverable on restart.
      for (const [teamId, definition] of durableDefinitions) {
        const laneIds = this.teams.get(teamId) ?? [];
        this.teams.set(teamId, laneIds);
        this.teamDefinitions.set(teamId, definition);
        this.teamFingerprints.set(
          teamId,
          this.teamFingerprints.get(teamId) ?? preparedTeamFingerprint(definition),
        );
        const missingLaneIds = definition
          .map((item) => `team:${teamId}:${item.branchId}`)
          .filter((laneId) => !this.branches.has(laneId) && !residentTaskLanes.has(laneId));
        if (missingLaneIds.length === 0 || this.teams.size > MAX_TEAMS) continue;
        await this.ensureBranches(
          teamId,
          definition,
          {
            runId: this.runId,
            laneId: this.parentLaneId,
            workspace: this.options.workspace,
            operationId: `${this.runId}:team:${teamId}:restore`,
            ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
          },
          true,
        );
        for (const laneId of missingLaneIds) this.recoveredAdmissions.add(laneId);
      }
      await this.lifecycle.restore();
      for (const board of await this.lifecycle.boards()) {
        if (board.reducer !== undefined && board.reductionState === "running" && !board.cancellationRequested) {
          await this.admitReducer(board.teamId, board.reducer);
        }
      }
      // Resident assignments survive a session restart independently of the
      // original one-shot member request. Rebuild only assignments without a
      // terminal report; a reported task remains inspectable but is not run a
      // second time.
      const dynamicEvents = events as unknown as Array<AnyEvent | TeamTaskAssignedEvent | TeamRunReportedEvent>;
      const reportedTaskIds = new Set(dynamicEvents.flatMap((event) => {
        const candidate = event as TeamRunReportedEvent;
        return candidate.type === "team.run.reported" ? [candidate.payload.taskId] : [];
      }));
      for (const event of dynamicEvents) {
        const assignmentEvent = event as TeamTaskAssignedEvent;
        if (assignmentEvent.type !== "team.task.assigned" || reportedTaskIds.has(assignmentEvent.payload.taskId)) continue;
        const assignment = assignmentEvent.payload;
        const board = (await this.lifecycle.boards()).find((item) => item.teamId === assignment.teamId);
        if (board === undefined || board.lifecycleState === "closed" || board.cancellationRequested) continue;
        const requestRecord = this.inbox.snapshot().records.find((record) => (
          record.message.runId === this.runId && record.message.to === assignment.laneId
          && record.message.payload.type === "task.request" && record.message.payload.taskId === assignment.taskId
        ));
        if (requestRecord === undefined) {
      const admittedAt = taskAdmittedAt(assignment.task);
      const dispatcher = new TaskDispatcher({
        inbox: this.inbox, runId: this.runId, from: this.parentLaneId, to: assignment.laneId, clock: this.clock,
        ...(admittedAt === undefined ? {} : { admittedAt }),
          });
          await dispatcher.dispatch({ taskId: assignment.taskId, goal: assignment.task.goal, inputRefs: assignment.task.inputRefs, budget: assignment.task.budget, ...(assignment.task.spawnContext === undefined ? {} : { spawnContext: assignment.task.spawnContext }) });
        } else if (requestRecord.status === "claimed") {
          // The previous process may have claimed the request and crashed
          // before acknowledging it. Reclaiming is durable and fences that
          // process instead of waiting for the normal Inbox lease to expire.
          await this.inbox.reclaim(requestRecord.message.messageId, this.parentLaneId, "runtime-restart");
        }
        const oldRuntime = this.branches.get(assignment.laneId);
        if (oldRuntime !== undefined) {
          await oldRuntime.scheduler.stop();
          this.branches.delete(assignment.laneId);
        }
        const runtime = this.createBranchRuntime(assignment.teamId, assignment.memberId, assignment.laneId,
          new RunTokenBudget(undefined, 0, { parent: this.options.runTokenBudget, scope: assignment.laneId }),
          events, assignment.task.budget, assignment.task.goal, undefined, false, assignment);
        this.branches.set(assignment.laneId, runtime);
        const laneIds = this.teams.get(assignment.teamId) ?? [];
        if (!laneIds.includes(assignment.laneId)) laneIds.push(assignment.laneId);
        this.teams.set(assignment.teamId, laneIds);
        runtime.scheduler.enqueue();
      }
      // A recovered member may own a nested Team. Restore that child runtime
      // after its parent lane has been rebuilt; each child filters durable
      // boards by its own lead lane and recursively restores its descendants.
      for (const runtime of this.nestedRuntimes.values()) await runtime.restore();
      this.mailbox = this.createMailbox(events);
    });
  }

  private async createInternal(request: TeamCreateRequest, context: ToolExecutionContext): Promise<TeamCreateResult> {
    this.assertAdmissionActive(context.signal);
    assertOwner(context, this.runId, this.parentLaneId);
    const normalized = normalizeTeamCreateRequest(request);
    request = normalized;
    if (!Array.isArray(request.branches) || request.branches.length < 1) {
      throw new RangeError("A Team must contain at least one branch");
    }
    if (request.branches.length > MAX_BRANCHES_PER_TEAM) throw new RangeError(`A Team may contain at most ${MAX_BRANCHES_PER_TEAM} branches`);
    const teamId = normalizeId(request.teamId ?? this.createId(), "teamId");
    const fingerprint = teamRequestFingerprint(request);
    const existing = this.teams.get(teamId);
    if (existing !== undefined) {
      if (this.closedTeams.has(teamId)) throw new Error(`Team ${teamId} is closed`);
      const previousFingerprint = this.teamFingerprints.get(teamId);
      if (previousFingerprint !== undefined && previousFingerprint !== fingerprint) {
        throw new Error(`Team ${teamId} already exists with different branch requests`);
      }
      const definition = this.teamDefinitions.get(teamId);
      if (definition !== undefined) {
        const branches = await this.ensureBranches(teamId, definition, context, true);
        return teamCreateResult(teamId, branches);
      }
      return teamCreateResult(teamId, existing.map((laneId) => ({ branchId: branchIdFromLane(laneId), laneId, status: "duplicate" as const })));
    }
    // Check recursion before storing branch input or appending lane facts.
    assertSubagentSpawnAllowed(this.depth, this.maxDepth);
    if (this.teams.size >= MAX_TEAMS) throw new Error(`Team limit reached (${MAX_TEAMS})`);
    // Team ids are Run-global because lane ids are Run-global. A nested lead
    // cannot accidentally create a second Team that would route to another
    // runtime's `team:<id>:<member>` lanes.
    const existingTeamFact = (await this.options.readEvents()).some((event) => (
      event.runId === this.runId
      && event.type === "team.created"
      && event.payload.teamId === teamId
    ));
    if (existingTeamFact) throw new Error(`Team ${teamId} already exists in this Run`);
    const preparedBranches = [] as PreparedTeamBranch[];
    const branchIds = new Set<string>();
    const reservedNames = new Set(request.branches.flatMap((branch) => branch.branchId === undefined ? [] : [branch.branchId]));
    let nextWorker = 1;
    const now = this.clock.now().getTime();
    const deadlineAt = normalized.deadline === undefined ? undefined : Date.parse(normalized.deadline);
    if (deadlineAt !== undefined && (deadlineAt <= now || deadlineAt - now > MAX_TASK_WALL_CLOCK_MS)) throw new RangeError("Team deadline must be in the future and within the task wall-clock limit");
    for (const branch of request.branches) {
      let requestedBranchId = branch.branchId;
      if (requestedBranchId === undefined) {
        while (reservedNames.has(`worker-${nextWorker}`)) nextWorker += 1;
        requestedBranchId = `worker-${nextWorker++}`;
      }
      const branchId = normalizeSubagentName(
        requestedBranchId,
        { maxLength: MAX_SUBAGENT_NAME_LENGTH },
      );
      if (branchIds.has(branchId)) throw new Error(`Duplicate Team branch: ${branchId}`);
      branchIds.add(branchId);
      validateBranchRequest(branch);
      validateCapabilityGrant(branch.capabilities, this.availableBranchTools());
      const taskDeadline = branch.maxWallClockMs === undefined
        ? deadlineAt
        : Math.min(now + branch.maxWallClockMs, deadlineAt ?? Infinity);
      // TaskDispatcher preserves the legacy attempt default when an internal
      // caller supplies one of the old per-task limits.  Keep the durable
      // Team definition identical to the admitted Inbox payload so the
      // branch's exact request check cannot reject its own task after
      // admission.  Model-facing parsing never exposes these legacy fields.
      const hasLegacyLimits = branch.maxModelTokens !== undefined
        || branch.maxWallClockMs !== undefined
        || branch.maxAttempts !== undefined
        || deadlineAt !== undefined;
      const taskBudget: TaskBudget = {
        ...(branch.maxModelTokens === undefined ? {} : { maxModelTokens: branch.maxModelTokens }),
        ...(branch.maxWallClockMs === undefined ? {} : { maxWallClockMs: taskDeadline! - now }),
        ...(branch.maxAttempts === undefined
          ? (hasLegacyLimits ? { maxAttempts: DEFAULT_BRANCH_ATTEMPTS } : {})
          : { maxAttempts: branch.maxAttempts }),
        ...(taskDeadline === undefined ? {} : { deadline: new Date(taskDeadline).toISOString() }),
      };
      validateBudget(taskBudget);
      const inputRef = branch.input === undefined
        ? undefined
        : await this.store.put(branch.input, "text/plain");
      this.assertAdmissionActive(context.signal);
      const goal = teamGoal(branch);
      const inputRefs = inputRef === undefined ? [] : [inputRef];
      preparedBranches.push({
        branch,
        branchId,
        taskBudget,
        ...(inputRef === undefined ? {} : { inputRef }),
        task: { type: "task.request", taskId: `${teamId}:${branchId}`, goal, inputRefs, budget: taskBudget },
      });
    }
    for (const prepared of preparedBranches) {
      prepared.task!.spawnContext = this.memberSpawnContext(
        teamId, prepared.branchId, `team:${teamId}:${prepared.branchId}`, prepared.task!,
        normalized.peerMessaging === "team-members"
          ? preparedBranches.filter((item) => item !== prepared).map((item) => `team:${teamId}:${item.branchId}`)
          : [],
        false,
        prepared.branch.capabilities,
      );
    }
    const memberDeadlines = preparedBranches.map((item) => item.taskBudget.deadline);
    const teamDeadline = deadlineAt ?? (memberDeadlines.every((deadline) => deadline !== undefined)
      ? Math.max(...memberDeadlines.map((deadline) => Date.parse(deadline)))
      : undefined);
    const definition: TeamDefinition = {
      teamId, leadLaneId: this.parentLaneId, fingerprint,
      joinPolicy: normalized.joinPolicy, peerMessaging: normalized.peerMessaging,
      ...(teamDeadline === undefined ? {} : { deadline: new Date(teamDeadline).toISOString() }),
      members: preparedBranches.map((item) => ({
        memberId: item.branchId, laneId: `team:${teamId}:${item.branchId}`, task: item.task!,
        dependsOn: item.branch.dependsOn ?? [], required: item.branch.required ?? true,
        ...(item.branch.capabilities === undefined ? {} : { capabilities: structuredClone(item.branch.capabilities) }),
      })),
    };
    this.assertAdmissionActive(context.signal);
    await this.lifecycle.create(definition);
    this.durableDefinitions.set(teamId, definition);
    // Publish the in-process definition before external writes. If a later
    // branch fails, a same-fingerprint retry can resume from the first gap.
    this.teams.set(teamId, []);
    this.teamFingerprints.set(teamId, fingerprint);
    this.teamDefinitions.set(teamId, preparedBranches);
    let branches;
    try {
      branches = await this.ensureBranches(teamId, preparedBranches, context, false);
    } catch (error: unknown) {
      if (context.signal?.aborted || this.options.signal?.aborted) await this.lifecycle.cancel(teamId, "Team admission cancelled");
      throw error;
    }
    return teamCreateResult(teamId, branches);
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
      this.assertAdmissionActive(context.signal);
      const { branch, branchId, taskBudget, inputRef } = prepared;
      const board = (await this.lifecycle.boards()).find((item) => item.teamId === teamId);
      this.assertAdmissionActive(context.signal);
      if (board?.lifecycleState === "closed" || board?.cancellationRequested || board?.members.some((member) => member.memberId === branchId && member.terminal)) continue;
      const goal = prepared.task?.goal ?? teamGoal(branch);
      const inputRefs = prepared.task?.inputRefs ?? (inputRef === undefined ? [] : [inputRef]);
      const admittedAt = taskAdmittedAt({
        type: "task.request", taskId: `${teamId}:${branchId}`, goal, inputRefs, budget: taskBudget,
      });
      const dispatcher = new TaskDispatcher({
        inbox: this.inbox,
        runId: this.runId,
        from: this.parentLaneId,
        to: `team:${teamId}:${branchId}`,
        conversationId: this.runId,
        threadId: `${this.runId}:team:${teamId}`,
        correlationId: `${this.runId}:team:${teamId}`,
        clock: this.clock,
        ...(admittedAt === undefined ? {} : { admittedAt }),
      });
      await dispatcher.dispatch({
        taskId: `${teamId}:${branchId}`,
        from: this.parentLaneId,
        to: `team:${teamId}:${branchId}`,
        goal,
        inputRefs,
        budget: taskBudget,
        ...(prepared.task?.spawnContext === undefined ? {} : { spawnContext: prepared.task.spawnContext }),
      });
    }

    for (const prepared of preparedBranches) {
      this.assertAdmissionActive(context.signal);
      const { branch, branchId, taskBudget, inputRef } = prepared;
      const laneId = `team:${teamId}:${branchId}`;
      const board = (await this.lifecycle.boards()).find((item) => item.teamId === teamId);
      if (board?.lifecycleState === "closed" || board?.cancellationRequested || (board?.members.some((member) => member.memberId === branchId && member.terminal && !member.registered))) {
        results.push({ branchId, laneId, status: "duplicate" });
        continue;
      }
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
        undefined,
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
      this.assertAdmissionActive(context.signal);
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
        // A restart repair has already admitted the lane durably, but the
        // first explicit idempotent create after restart still reports the
        // branch as queued (the caller did not observe that admission). Later
        // retries correctly report duplicate.
        status: duplicateExisting && alreadyAdmitted && !this.recoveredAdmissions.delete(laneId)
          ? "duplicate"
          : "queued",
      });
    }
    this.teams.set(teamId, laneIds);
    return results;
  }

  async status(context: ToolExecutionContext): Promise<{ teams: TeamBoard[] }> {
    assertOwner(context, this.runId, this.parentLaneId);
    await this.lifecycle.reconcile();
    return { teams: await this.lifecycle.boards() };
  }

  async assign(request: TeamAssignRequest, context: ToolExecutionContext): Promise<TeamAssignResult> {
    return this.enqueueLifecycle(async () => {
      this.assertAdmissionActive(context.signal);
      assertOwner(context, this.runId, this.parentLaneId);
      const teamId = normalizeId(request.teamId, "teamId");
      const board = (await this.lifecycle.boards()).find((item) => item.teamId === teamId);
      if (board === undefined) throw new Error(`Unknown Team ${teamId}`);
      if (board.lifecycleState === "closed" || board.cancellationRequested) throw new Error(`Team ${teamId} is closed`);
      const events = await this.options.readEvents();
      const memberId = normalizeSubagentName(request.memberId);
      if (["main", "nausicaa", "teto"].includes(memberId)) throw new Error("Member name is reserved for a runtime role");
      request = { ...request, memberId };
      const addition = events.find((event): event is Extract<AnyEvent, { type: "team.member.added" }> => event.runId === this.runId
        && event.type === "team.member.added" && event.payload.teamId === teamId
        && event.payload.operationId === context.operationId && event.payload.addedBy === this.parentLaneId);
      if (addition !== undefined) {
        if (addition.payload.member.memberId !== memberId || !assignmentInputMatches(addition.payload.member.task, request)
          || stableJson(addition.payload.member.capabilities ?? null) !== stableJson(request.capabilities ?? null)) {
          throw new Error(`Team assignment operation ${context.operationId} was reused with different work`);
        }
        return this.admitAssignedMember(board, addition.payload.member, context, true);
      }
      const dynamicEvents = events as unknown as Array<AnyEvent | TeamTaskAssignedEvent>;
      const byOperation = dynamicEvents.find((event): event is TeamTaskAssignedEvent => {
        const candidate = event as TeamTaskAssignedEvent;
        return candidate.runId === this.runId && candidate.type === "team.task.assigned"
          && candidate.payload.teamId === teamId && candidate.payload.operationId === context.operationId;
      });
      if (byOperation !== undefined) {
        if (byOperation.payload.memberId !== memberId || !assignmentInputMatches(byOperation.payload.task, request)
          || (request.capabilities !== undefined && stableJson(request.capabilities) !== stableJson(board.members.find((member) => member.memberId === memberId)?.capabilities ?? null))) {
          throw new Error(`Team assignment operation ${context.operationId} was reused with different work`);
        }
        const existingRequest = this.inbox.snapshot().records.find((record) => (
          record.message.runId === this.runId
          && record.message.to === byOperation.payload.laneId
          && record.message.payload.type === "task.request"
          && record.message.payload.taskId === byOperation.payload.taskId
        ));
        if (existingRequest === undefined) {
          const assignment = byOperation.payload;
          const admittedAt = taskAdmittedAt(assignment.task);
          const dispatcher = new TaskDispatcher({
            inbox: this.inbox, runId: this.runId, from: this.parentLaneId, to: assignment.laneId,
            conversationId: this.runId, threadId: `${this.runId}:team:${teamId}:task:${assignment.taskId}`,
            correlationId: `${this.runId}:team:${teamId}:task:${assignment.taskId}`, clock: this.clock,
            ...(admittedAt === undefined ? {} : { admittedAt }),
          });
          await dispatcher.dispatch({
            taskId: assignment.taskId, goal: assignment.task.goal, inputRefs: assignment.task.inputRefs, budget: assignment.task.budget,
            ...(assignment.task.spawnContext === undefined ? {} : { spawnContext: assignment.task.spawnContext }),
          });
          const repairedEvents = await this.options.readEvents();
          const runtime = this.createBranchRuntime(
            teamId, assignment.memberId, assignment.laneId,
            new RunTokenBudget(undefined, 0, { parent: this.options.runTokenBudget, scope: assignment.laneId }),
            repairedEvents, assignment.task.budget, assignment.task.goal, undefined, false, assignment,
          );
          this.branches.set(assignment.laneId, runtime);
          runtime.scheduler.enqueue();
          return { teamId, taskId: assignment.taskId, memberId: assignment.memberId, laneId: assignment.laneId, assignmentVersion: assignment.assignmentVersion, status: "queued" };
        }
        return { teamId, taskId: byOperation.payload.taskId, memberId: byOperation.payload.memberId, laneId: byOperation.payload.laneId, assignmentVersion: byOperation.payload.assignmentVersion, status: "duplicate" };
      }
      const member = board.members.find((candidate) => candidate.memberId === memberId);
      if (member === undefined) {
        assertSubagentSpawnAllowed(this.depth, this.maxDepth);
        const normalized = normalizeTeamCreateRequest({ teamId, members: [{ memberId, statement: request.statement,
          ...(request.input === undefined ? {} : { input: request.input }),
          ...(request.capabilities === undefined ? {} : { capabilities: request.capabilities }) }] }).branches[0]!;
        validateCapabilityGrant(normalized.capabilities, this.availableBranchTools());
        const inputRef = request.input === undefined ? undefined : await this.store.put(request.input, "text/plain");
        const task: TaskRequest = { type: "task.request", taskId: `${teamId}:${memberId}`,
          goal: teamGoal(normalized), inputRefs: inputRef === undefined ? [] : [inputRef], budget: {} };
        const laneId = `team:${teamId}:${memberId}`;
        task.spawnContext = this.memberSpawnContext(teamId, memberId, laneId, task,
          board.definition?.peerMessaging === "team-members" ? board.members.map((peer) => peer.laneId) : [], false, normalized.capabilities);
        const definition: TeamMemberDefinition = { memberId, laneId, task, dependsOn: [], required: true,
          ...(normalized.capabilities === undefined ? {} : { capabilities: normalized.capabilities }) };
        await this.lifecycle.addMember({ teamId, member: definition, addedBy: this.parentLaneId, operationId: context.operationId },
          () => this.assertAdmissionActive(context.signal));
        const admittedBoard = (await this.lifecycle.boards()).find((item) => item.teamId === teamId)!;
        return this.admitAssignedMember(admittedBoard, definition, context, false);
      }
      if (request.capabilities !== undefined && stableJson(request.capabilities) !== stableJson(member.capabilities ?? null)) {
        throw new Error("An existing Team member's capability grant cannot be changed by assignment");
      }
      if (!member.terminal) throw new Error(`Team member ${member.memberId} still has an unfinished initial Task`);
      const active = (board.tasks ?? []).find((task) => task.memberId === member.memberId
        && task.latestReport === undefined && isOpenResidentTaskStatus(task.status));
      if (active !== undefined) throw new Error(`Team member ${member.memberId} already has active task ${active.taskId}`);
      const previousVersions = dynamicEvents.filter((event): event is TeamTaskAssignedEvent => {
        const candidate = event as TeamTaskAssignedEvent;
        return candidate.runId === this.runId && candidate.type === "team.task.assigned"
          && candidate.payload.teamId === teamId && candidate.payload.memberId === member.memberId;
      });
      const assignmentVersion = Math.max(0, ...previousVersions.map((event) => event.payload.assignmentVersion)) + 1;
      const taskId = `${teamId}:${member.memberId}:task-${assignmentVersion}`;
      const inputRef = request.input === undefined ? undefined : await this.store.put(request.input, "text/plain");
      const now = this.clock.now();
      const taskBudget: TaskBudget = {};
      const task: import("../domain/types.js").TaskRequest = {
        type: "task.request", taskId,
        goal: { version: 1, statement: request.statement, successCriteria: [], hardConstraints: [] },
        inputRefs: inputRef === undefined ? [] : [inputRef], budget: taskBudget,
      };
      task.spawnContext = this.memberSpawnContext(teamId, member.memberId, member.laneId, task, [], false, member.capabilities);
      const assignment: TeamTaskAssignment = {
        teamId, taskId, memberId: member.memberId, laneId: member.laneId,
        assignmentVersion, task, assignedBy: this.parentLaneId, operationId: context.operationId,
      };
      await this.lifecycle.assignTask(assignment, () => this.assertAdmissionActive(context.signal));
      const oldRuntime = this.branches.get(member.laneId);
      if (oldRuntime !== undefined) {
        await oldRuntime.scheduler.stop();
        this.branches.delete(member.laneId);
      }
      const dispatcher = new TaskDispatcher({
        inbox: this.inbox, runId: this.runId, from: this.parentLaneId, to: member.laneId,
        conversationId: this.runId, threadId: `${this.runId}:team:${teamId}:task:${taskId}`,
        correlationId: `${this.runId}:team:${teamId}:task:${taskId}`, clock: this.clock,
        admittedAt: now.toISOString(),
      });
      await dispatcher.dispatch({ taskId, goal: task.goal, inputRefs: task.inputRefs, budget: task.budget, spawnContext: task.spawnContext });
      const runtime = this.createBranchRuntime(teamId, member.memberId, member.laneId,
        new RunTokenBudget(undefined, 0, { parent: this.options.runTokenBudget, scope: member.laneId }),
        events, taskBudget, task.goal, undefined, false, assignment);
      this.branches.set(member.laneId, runtime);
      runtime.scheduler.enqueue();
      return { teamId, taskId, memberId: member.memberId, laneId: member.laneId, assignmentVersion, status: "queued" };
    });
  }

  private async admitAssignedMember(board: TeamBoard, member: TeamMemberDefinition, context: ToolExecutionContext, duplicate: boolean): Promise<TeamAssignResult> {
    const definition = currentTeamDefinition(board);
    if (definition === undefined) throw new Error("Adding members requires a durable Team definition");
    this.durableDefinitions.set(board.teamId, definition);
    this.teamFingerprints.set(board.teamId, definition.fingerprint);
    const prepared = prepareMemberDefinition(member);
    const previous = this.teamDefinitions.get(board.teamId) ?? [];
    if (!previous.some((candidate) => candidate.branchId === member.memberId)) this.teamDefinitions.set(board.teamId, [...previous, prepared]);
    const result = await this.ensureBranches(board.teamId, [prepared], context, duplicate);
    this.notifyStateChange();
    return { teamId: board.teamId, taskId: member.task.taskId, memberId: member.memberId, laneId: member.laneId,
      assignmentVersion: 0, status: duplicate ? "duplicate" : result[0]?.status ?? "queued" };
  }

  async wait(request: TeamWaitRequest, context: ToolExecutionContext): Promise<unknown> {
    const laneId = context.laneId ?? this.parentLaneId;
    let finishWait: (() => void) | undefined;
    try {
      while (true) {
        this.assertAdmissionActive(context.signal);
        let changed!: () => void;
        const notification = new Promise<void>((resolve) => { changed = resolve; });
        const unsubscribeInbox = this.inbox.subscribe(laneId, changed);
        const unsubscribeState = this.waitCoordinator.subscribe(changed);
        context.signal?.addEventListener("abort", changed, { once: true });
        this.options.signal?.addEventListener("abort", changed, { once: true });
        let leaseTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          // Subscribe before reading; a result or message arriving during the
          // projection must not strand this waiter. No model polling is needed.
          await this.lifecycle.reconcile();
          const state = await this.taskState(request, context);
          this.assertAdmissionActive(context.signal);
          if (!state.waiting) return state;
          const collaboration = await this.waitingCollaboration(laneId);
          if (collaboration.ready) {
            // Prefer a result that committed while readiness was being read.
            const latest = await this.taskState(request, context);
            this.assertAdmissionActive(context.signal);
            return latest.waiting ? {
              ...latest,
              wakeReason: "collaboration",
              note: "The task is still running. New Team messages or results will be delivered at the next model step; handle them before waiting again.",
            } : latest;
          }
          finishWait ??= this.waitCoordinator.beginWait(laneId, state.laneId);
          if (collaboration.nextClaimableDelayMs !== undefined) {
            // A recovered Inbox claim has a real lease boundary. This timer
            // follows that boundary; it is neither a task timeout nor polling.
            leaseTimer = setTimeout(changed, Math.min(collaboration.nextClaimableDelayMs, 2_147_483_647));
            leaseTimer.unref?.();
          }
          await notification;
        } finally {
          clearTimeout(leaseTimer);
          unsubscribeState();
          unsubscribeInbox();
          context.signal?.removeEventListener("abort", changed);
          this.options.signal?.removeEventListener("abort", changed);
        }
      }
    } finally {
      finishWait?.();
    }
  }

  private async taskState(request: TeamWaitRequest, context: ToolExecutionContext): Promise<Record<string, unknown> & { waiting: boolean; laneId: LaneId }> {
    const teamId = normalizeId(request.teamId, "teamId");
    const board = (await this.lifecycle.boards()).find((item) => item.teamId === teamId);
    if (board === undefined) throw new Error(`Unknown Team ${teamId}`);
    this.assertTeamAccess(board, context);
    const closed = board.lifecycleState === "closed" || board.cancellationRequested;
    const task = (board.tasks ?? []).find((candidate) => candidate.taskId === request.taskId);
    if (task === undefined) {
      // Initial tasks belong to the admitted member definition; later
      // assignments have their own task records and must not replace them.
      const member = board.members.find((candidate) => candidate.taskId === request.taskId);
      if (member === undefined) throw new Error(`Unknown Team task ${request.taskId}`);
      if (!member.terminal && !closed && member.laneId === context.laneId) {
        throw new Error("Cannot wait for the current task running in this lane");
      }
      return {
        teamId, taskId: member.taskId, memberId: member.memberId, laneId: member.laneId,
        status: member.status, execution: member.execution, terminal: member.terminal,
        ...(member.outcome === undefined ? {} : { outcome: member.outcome }),
        ...(member.result === undefined ? {} : { result: member.result }),
        ...(member.failure === undefined ? {} : { failure: member.failure }),
        ...(member.reason === undefined ? {} : { reason: member.reason }),
        ...(member.latestReport === undefined ? {} : { report: member.latestReport }),
        ...(!member.terminal && closed ? { status: "cancelled", terminal: true, reason: "Team closed or cancelled" } : {}),
        waiting: !member.terminal && !closed,
      };
    }
    const waiting = !closed && task.latestReport === undefined && !["done", "failed", "cancelled", "review"].includes(task.status);
    if (waiting && task.laneId === context.laneId) {
      throw new Error("Cannot wait for the current task running in this lane");
    }
    return {
      teamId, taskId: task.taskId, memberId: task.memberId, laneId: task.laneId,
      assignmentVersion: task.assignmentVersion, status: task.status,
      ...(task.latestReport === undefined ? {} : { report: task.latestReport }),
      ...(closed && task.latestReport === undefined ? { status: "cancelled" } : {}),
      waiting,
    };
  }

  private async waitingCollaboration(laneId: LaneId): Promise<{ ready: boolean; nextClaimableDelayMs?: number }> {
    const events = await this.options.readEvents();
    const excluded = new Set([
      ...projectCommittedBoundaryMessageIds(events, this.runId, laneId),
      ...this.waitCoordinator.currentMessages(laneId),
    ]);
    if ((await this.groupBoundaryMessages(laneId, events, excluded)).length > 0) return { ready: true };
    const inbox = this.inbox.snapshot();
    const records = inbox.records;
    const boards = projectTeamBoards(events, { runId: this.runId, inbox })
      .filter((board) => board.lifecycleState !== "closed" && !board.cancellationRequested);
    const senders = new Set<LaneId>();
    for (const board of boards) {
      if (board.leadLaneId === laneId) {
        senders.add(laneId);
        for (const member of board.members) senders.add(member.laneId);
        if (board.reducer !== undefined) senders.add(board.reducer.laneId);
      } else if (board.members.some((member) => member.laneId === laneId)) {
        senders.add(board.leadLaneId);
        if (board.definition?.peerMessaging === "team-members") {
          for (const member of board.members) senders.add(member.laneId);
        }
      }
    }
    const messageIds = records.filter((record) => {
      const message = record.message;
      if (record.status === "handled" || excluded.has(message.messageId)
        || message.runId !== this.runId || message.to !== laneId || !senders.has(message.from)
        || message.routeId !== undefined || message.sourceEndpoint !== undefined || message.targetEndpoint !== undefined
        || (message.delivery !== "urgent" && message.delivery !== "next-step")) return false;
      if (["message.inform", "question.ask", "question.answer"].includes(message.payload.type)) return true;
      if (message.payload.type !== "task.result" && message.payload.type !== "task.failed") return false;
      const payload = message.payload;
      return boards.some((board) => board.leadLaneId === laneId && teamReplyMatches(board, message.from, payload));
    }).map((record) => record.message.messageId);
    if (messageIds.length === 0) return { ready: false };
    const delay = this.inbox.nextClaimableDelayMs(laneId, { runId: this.runId, messageIds });
    return { ready: delay === 0, ...(delay === undefined || delay === 0 ? {} : { nextClaimableDelayMs: delay }) };
  }

  private async reportAssignedTask(
    teamId: string,
    assignment: TeamTaskAssignment,
    input: { request: import("../domain/types.js").A2AMessage; claim: InboxClaim; payload: TaskResult | TaskFailed },
  ): Promise<void> {
    if (input.payload.taskId !== assignment.taskId) return;
    const assertReportStillOwned = async (): Promise<void> => {
      if (this.stopped || this.fencedLanes.has(assignment.laneId)) throw new DOMException("Team assignment was fenced", "AbortError");
      const board = (await this.lifecycle.boards()).find((item) => item.teamId === teamId);
      if (board === undefined || board.lifecycleState === "closed" || board.cancellationRequested) throw new DOMException("Team is closed", "AbortError");
      const current = this.inbox.snapshot().records.find((record) => record.message.messageId === input.request.messageId);
      if (current?.claim?.claimId !== input.claim.claimId || current.claim.attempt !== input.claim.attempt) throw new DOMException("Team assignment claim was superseded", "AbortError");
    };
    await assertReportStillOwned();
    const payload = input.payload;
    const isFailure = payload.type === "task.failed";
    const report = {
      teamId, taskId: assignment.taskId, laneId: assignment.laneId,
      assignmentVersion: assignment.assignmentVersion,
      kind: isFailure ? "failed" as const : payload.status === "completed" ? "ready-for-review" as const : "checkpoint" as const,
      summary: isFailure ? payload.reason : payload.summary,
      artifactRefs: isFailure ? [] : payload.artifactRefs,
      openQuestions: isFailure ? [payload.reason] : payload.openQuestions,
      ...(isFailure ? { failure: payload } : { result: payload }),
      reportId: `${this.runId}:team:${teamId}:report:${assignment.taskId}`,
      runId: this.runId,
    };
    await publishTeamRunReport({ ledger: this.options.eventSink, readEvents: this.options.readEvents,
      report, occurredAt: this.clock.now().toISOString(), causationId: input.request.messageId,
      assertOwned: assertReportStillOwned });
    this.notifyStateChange();
  }

  /** Repair transport after settlement without ever reopening model execution. */
  private async repairReportedHandoffs(): Promise<void> {
    const events = await this.options.readEvents();
    const consumed = new Set(projectCommittedBoundaryMessageIds(events, this.runId, this.parentLaneId));
    for (const board of await this.lifecycle.boards()) {
      if (board.lifecycleState === "closed" || board.cancellationRequested) continue;
      const assignments = events as unknown as Array<AnyEvent | TeamTaskAssignedEvent>;
      const reports = [
        ...board.members.flatMap((member) => member.latestReport === undefined ? [] : [{
          report: member.latestReport,
          task: currentTeamDefinition(board)?.members.find((definition) => definition.memberId === member.memberId)?.task,
        }]),
        ...(board.tasks ?? []).flatMap((task) => task.latestReport === undefined ? [] : [{
          report: task.latestReport,
          task: assignments.find((event): event is TeamTaskAssignedEvent => event.runId === this.runId
            && event.type === "team.task.assigned" && event.payload.teamId === board.teamId
            && event.payload.taskId === task.taskId && event.payload.assignedBy === this.parentLaneId)?.payload.task,
        }]),
      ];
      for (const { report, task } of reports) {
        const payload = report.result ?? report.failure;
        if (task === undefined || payload === undefined) continue;
        const request = this.inbox.snapshot().records.find((record) => record.message.runId === this.runId
          && record.message.from === this.parentLaneId && record.message.to === report.laneId
          && record.message.payload.type === "task.request" && stableJson(record.message.payload) === stableJson(task));
        if (request?.message.payload.type !== "task.request") continue;
        this.assertAdmissionActive();
        const reply = teamTaskReplyMessage({ ...request.message, payload: request.message.payload }, payload, this.clock.now().toISOString());
        const previous = this.inbox.snapshot().records.find((record) => record.message.messageId === reply.messageId);
        if (previous === undefined) await this.inbox.send(reply);
        else if (stableJson(previous.message.payload) !== stableJson(payload)) throw new Error("Conflicting recovered Team terminal reply");
        if (request.status === "pending") {
          await this.inbox.claim(report.laneId, report.laneId, {
            claimId: `${report.laneId}:report-recovery:${this.createId()}`, limit: 1, runId: this.runId,
            messageIds: [request.message.messageId], types: ["task.request"],
          });
        }
        const current = this.inbox.snapshot().records.find((record) => record.message.messageId === request.message.messageId);
        if (current?.status === "claimed" && current.claim?.claimedBy === report.laneId) await this.inbox.handle(request.message.messageId, report.laneId);
        const status = payload.type === "task.result" ? "completed" : "failed";
        const scope = report.assignmentVersion === 0 ? "member" : `task:${report.taskId}`;
        const statusKey = `${this.runId}:${report.laneId}:${scope}:status:${status}`;
        if (!(board.tasks ?? []).some((task) => task.laneId === report.laneId && task.assignmentVersion > report.assignmentVersion)
          && !events.some((event) => event.runId === this.runId && event.idempotencyKey === statusKey)) {
          await this.options.eventSink.append({
            runId: this.runId, laneId: report.laneId, type: "lane.status",
            payload: { status, reason: `Team member finished ${report.taskId}: ${payload.type === "task.result" ? payload.status : "failed"}` },
            correlationId: `${this.runId}:${report.laneId}`, idempotencyKey: statusKey,
            visibility: "run", occurredAt: this.clock.now().toISOString(),
          });
        }
        if (previous?.status !== "handled" && !consumed.has(reply.messageId)) this.options.onWake?.();
      }
    }
  }

  async message(request: TeamMessageRequest, context: ToolExecutionContext): Promise<TeamMessageResult> {
    return this.enqueueLifecycle(() => serializeTeamChannelWrite(this.options.eventSink, async () => {
      this.assertAdmissionActive(context.signal);
      const teamId = normalizeId(request.teamId, "teamId");
      const channelId = normalizeChannelId(request.channelId);
      const body = boundedTeamBody(request.body);
      const artifactRefs = structuredClone(request.artifactRefs ?? []);
      const board = (await this.lifecycle.boards()).find((item) => item.teamId === teamId);
      if (board === undefined) throw new Error(`Unknown Team ${teamId}`);
      const sender = this.assertTeamAccess(board, context);
      if (board.lifecycleState === "closed" || board.cancellationRequested || this.closedTeams.has(teamId)) throw new Error(`Team ${teamId} is closed`);
      const mentions = [...new Set((request.mentions ?? []).map((mention) => {
        const target = resolveLaneTarget(mention, [this.parentLaneId]);
        if (target === this.parentLaneId) return target;
        const member = board.members.find((item) => item.memberId === mention || item.laneId === mention);
        if (member === undefined) throw new Error(`Unknown Team mention ${mention}`);
        return member.laneId;
      }))];
      const events = await this.options.readEvents();
      const candidate = appendTeamChannelMessage(events, {
        runId: this.runId,
        laneId: sender,
        teamId,
        channelId,
        operationId: context.operationId,
        fromLane: sender,
        body,
        ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
        mentions,
        artifactRefs,
        correlationId: `${this.runId}:team:${teamId}:channel:${channelId}`,
        visibility: "run",
        occurredAt: this.clock.now().toISOString(),
      });
      const event = candidate.duplicate
        ? candidate.event as Extract<AnyEvent, { type: "team.message.sent" }>
        : await this.options.eventSink.append(candidate.event);
      const current = (await this.lifecycle.boards()).find((item) => item.teamId === teamId);
      if (!candidate.duplicate && !this.stopped && current?.lifecycleState === "open" && !current.cancellationRequested) {
        if (mentions.some((mention) => mention !== sender)) this.notifyStateChange();
        for (const mention of mentions) {
          if (mention === sender) continue;
          if (mention === this.parentLaneId) this.options.onWake?.();
          else this.branches.get(mention)?.scheduler.enqueue();
        }
      }
      return teamMessageResult(event, candidate.duplicate ? "duplicate" : "sent");
    }));
  }

  async history(request: TeamHistoryRequest, context: ToolExecutionContext): Promise<TeamHistoryResult> {
    this.assertAdmissionActive(context.signal);
    const teamId = normalizeId(request.teamId, "teamId");
    const channelId = normalizeChannelId(request.channelId);
    const board = (await this.lifecycle.boards()).find((item) => item.teamId === teamId);
    if (board === undefined) throw new Error(`Unknown Team ${teamId}`);
    this.assertTeamAccess(board, context);
    const events = await this.options.readEvents();
    const history = readTeamChannelHistory(events, {
      runId: this.runId,
      teamId,
      channelId,
      ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
      ...(request.after === undefined ? {} : { cursor: request.after }),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
    });
    const page = history.messages.map((event) => teamMessageResult(event, "sent"));
    return {
      teamId,
      channelId,
      messages: page,
      ...(history.nextCursor === undefined ? {} : { nextCursor: history.nextCursor }),
      hasMore: history.hasMore,
    };
  }

  async close(request: TeamCloseRequest, context: ToolExecutionContext): Promise<{ teamId: string; status: "closed" | "duplicate" }> {
    return this.enqueueLifecycle(async () => {
      this.assertAdmissionActive(context.signal);
      assertOwner(context, this.runId, this.parentLaneId);
      const teamId = normalizeId(request.teamId, "teamId");
      const board = (await this.lifecycle.boards()).find((item) => item.teamId === teamId);
      if (board === undefined) throw new Error(`Unknown Team ${teamId}`);
      if (this.closedTeams.has(teamId)) return { teamId, status: "duplicate" };
      await this.lifecycle.closeTeam(teamId, request.reason ?? "Closed by Team Lead");
      this.closedTeams.add(teamId);
      return { teamId, status: "closed" };
    });
  }

  async beforeMainStep(context?: { step: number }): Promise<readonly import("./main-loop.js").MainBoundaryMessage[]> {
    if (this.teams.size === 0) {
      this.waitCoordinator.delivered(this.parentLaneId, []);
      return [];
    }
    await this.lifecycle.reconcile();
    this.mailbox ??= this.createMailbox(await this.options.readEvents());
    const messages = [...await this.groupBoundaryMessages(this.parentLaneId), ...await this.mailbox.beforeStep({ step: context?.step ?? 1 })];
    const runtimes = [...this.branches.values(), ...this.reducers.values()];
    for (let visited = 0; visited < runtimes.length && messages.length < 64; visited += 1) {
      const runtime = runtimes[this.deliveryCursor % runtimes.length]!;
      this.deliveryCursor = (this.deliveryCursor + 1) % runtimes.length;
      const replies = await runtime.scheduler.beforeMainStep({ step: context?.step ?? 1, maxResults: 64 - messages.length });
      if (replies.length === 0) continue;
      // A reply may settle during its claim. Validate against the board after
      // claiming, so a fresh durable report cannot be discarded as untrusted.
      const board = (await this.lifecycle.boards()).find((item) => item.teamId === runtime.teamId);
      for (const reply of replies) {
        const record = this.inbox.snapshot().records.find((item) => item.message.messageId === reply.messageId);
        const payload = record?.message.payload;
        const matches = board !== undefined && (payload?.type === "task.result" || payload?.type === "task.failed")
          && teamReplyMatches(board, runtime.laneId, payload);
        if (matches) messages.push(reply);
        else await this.inbox.handle(reply.messageId, this.parentLaneId);
      }
    }
    this.waitCoordinator.delivered(this.parentLaneId, messages.map((message) => message.messageId));
    return messages;
  }

  /** Hosts compose several mailboxes; record the complete delivered boundary. */
  observeBoundaryMessages(laneId: LaneId, messages: readonly import("./main-loop.js").MainBoundaryMessage[]): void {
    if (!this.stopped) this.waitCoordinator.delivered(laneId, messages.map((message) => message.messageId));
  }

  /** Group mentions share the ordinary committed-step receipt boundary. */
  private async groupBoundaryMessages(laneId: LaneId, snapshot?: readonly AnyEvent[], excluded?: ReadonlySet<string>): Promise<readonly import("./main-loop.js").MainBoundaryMessage[]> {
    if (this.stopped || this.options.signal?.aborted) return [];
    const events = snapshot ?? await this.options.readEvents();
    const consumed = new Set(projectCommittedBoundaryMessageIds(events, this.runId, laneId));
    const candidates = events.filter((event): event is Extract<AnyEvent, { type: "team.message.sent" }> => (
      event.runId === this.runId && event.type === "team.message.sent"
      && event.payload.mentions.includes(laneId) && event.payload.fromLane !== laneId
      && event.laneId === event.payload.fromLane
      && !consumed.has(`team-channel:${event.eventId}`)
      && !excluded?.has(`team-channel:${event.eventId}`)
    ));
    if (candidates.length === 0) return [];
    const boards = projectTeamBoards(events, { runId: this.runId, inbox: this.inbox.snapshot() });
    const admitted = new Map<string, Map<LaneId, number>>();
    for (const board of boards) {
      const ownsGroup = board.leadLaneId === laneId;
      const belongsToGroup = board.leadLaneId === this.parentLaneId && board.members.some((member) => member.laneId === laneId);
      if ((!ownsGroup && !belongsToGroup) || board.lifecycleState === "closed" || board.cancellationRequested) continue;
      const created = events.find((event) => event.runId === this.runId && event.type === "team.created"
        && event.laneId === board.leadLaneId && event.payload.teamId === board.teamId
        && stableJson(event.payload) === stableJson(board.definition));
      if (created?.type !== "team.created") continue;
      const members = new Map<LaneId, number>([[board.leadLaneId, created.globalOffset],
        ...created.payload.members.map((member): [LaneId, number] => [member.laneId, created.globalOffset])]);
      for (const event of events) {
        if (event.runId !== this.runId || event.type !== "team.member.added" || event.payload.teamId !== board.teamId
          || event.laneId !== board.leadLaneId || event.payload.addedBy !== board.leadLaneId) continue;
        const definition = board.memberDefinitions?.find((member) => member.laneId === event.payload.member.laneId);
        if (definition !== undefined && stableJson(definition) === stableJson(event.payload.member) && !members.has(definition.laneId)) {
          members.set(definition.laneId, event.globalOffset);
        }
      }
      admitted.set(board.teamId, members);
    }
    return candidates.filter((event) => (
      event.globalOffset > (admitted.get(event.payload.teamId)?.get(event.payload.fromLane) ?? Infinity)
      && event.globalOffset > (admitted.get(event.payload.teamId)?.get(laneId) ?? Infinity)
    )).sort((left, right) => left.globalOffset - right.globalOffset).slice(0, 8).map((event) => {
      const previous = events.filter((candidate): candidate is Extract<AnyEvent, { type: "team.message.sent" }> => (
        candidate.runId === this.runId && candidate.type === "team.message.sent"
        && candidate.payload.teamId === event.payload.teamId && candidate.payload.channelId === event.payload.channelId
        && candidate.payload.sequence < event.payload.sequence
      )).sort((left, right) => right.payload.sequence - left.payload.sequence)[0];
      const readFullMessage: TeamHistoryRequest = {
        teamId: event.payload.teamId, channelId: event.payload.channelId,
        ...(event.payload.threadId === undefined ? {} : { threadId: event.payload.threadId }), limit: 1,
        ...(previous === undefined ? {} : { after: teamChannelCursor(previous) }),
      };
      const nestedLead = laneId !== DEFAULT_PARENT_LANE && boards.some((board) => board.teamId === event.payload.teamId && board.leadLaneId === laneId);
      const messageTool = nestedLead ? "child_team_message" : "team_message";
      const historyTool = nestedLead ? "child_team_history" : "team_history";
      return {
        kind: "runtime-notice" as const,
        source: event.payload.fromLane,
        messageId: `team-channel:${event.eventId}`,
        content: [
          `Team channel mention. Use ${messageTool} to reply; call ${historyTool} with readFullMessage for this message, or after:cursor for later messages.`,
          JSON.stringify({ teamId: event.payload.teamId, channelId: event.payload.channelId,
            threadId: event.payload.threadId, sequence: event.payload.sequence, cursor: teamChannelCursor(event), readFullMessage }),
          event.payload.body.slice(0, 2_048),
          ...(event.payload.body.length > 2_048 ? ["[Excerpt; readFullMessage retrieves the full message.]"] : []),
        ].join("\n"),
      };
    });
  }

  enqueue(context?: import("./main-loop.js").MainAfterStepContext): void {
    if (this.teams.size === 0 || this.stopped) return;
    if (context !== undefined) void this.mailbox?.afterStep(context).catch(() => undefined);
    for (const branch of [...this.branches.values(), ...this.reducers.values()]) branch.scheduler.enqueue(context);
  }

  async drain(): Promise<void> {
    if (this.teams.size === 0 || this.stopped) return;
    for (let pass = 0; pass <= MAX_BRANCHES_PER_TEAM; pass += 1) {
      await Promise.all([...this.branches.values(), ...this.reducers.values()].map((branch) => branch.scheduler.drain()));
      await this.lifecycle.reconcile();
      const enqueued = await this.enqueueReadyDependencies();
      if (!enqueued && [...this.branches.values(), ...this.reducers.values()].every((branch) => branch.scheduler.pendingActivations === 0)) break;
    }
  }

  async waitForJoin(signal?: AbortSignal): Promise<void> {
    if (this.teams.size === 0) return;
    this.enqueue();
    while (!this.stopped) {
      if (signal?.aborted || this.options.signal?.aborted) { await this.cancelAll("Run aborted"); return; }
      // A cancelled tool may ignore its signal. Wait for durable collection,
      // not the executor tail; the lifecycle fences any later effects/results.
      await this.lifecycle.reconcile();
      this.lifecycle.checkFailure();
      const boards = await this.lifecycle.boards();
      if (boards.every(isCollectedTeam)) return;
      if (this.options.signal?.aborted) { await this.cancelAll("Run aborted"); return; }
      await this.enqueueReadyDependencies();
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  async beforeMainCompletion(signal?: AbortSignal): Promise<boolean> {
    if (this.teams.size === 0 || this.stopped) return false;
    if (this.options.asyncCompletion === true) {
      await this.lifecycle.reconcile();
      // Keep a currently active Main Turn responsive to collaboration mail,
      // while leaving unfinished members to their own schedulers. A later
      // durable report invokes onWake and starts a fresh Main boundary.
      const boards = await this.lifecycle.boards();
      if (!boards.some((board) => board.lifecycleState !== "closed" && !board.cancellationRequested)) return false;
      if ((await this.groupBoundaryMessages(this.parentLaneId)).length > 0) return true;
      const collected = boards.every(isCollectedTeam);
      const consumed = new Set(projectCommittedBoundaryMessageIds(await this.options.readEvents(), this.runId, this.parentLaneId));
      const sources = new Set([this.parentLaneId, ...this.branches.keys(), ...[...this.reducers.values()].map((item) => item.laneId)]);
      return this.inbox.snapshot().records.some((record) => (
        record.message.runId === this.runId
        && record.message.to === this.parentLaneId
        && sources.has(record.message.from)
        && record.message.routeId === undefined
        && record.message.sourceEndpoint === undefined
        && record.message.targetEndpoint === undefined
        && (record.message.delivery === "urgent" || record.message.delivery === "next-step")
        && ["message.inform", "question.ask", "question.answer", "task.result", "task.failed"].includes(record.message.payload.type)
        && (this.options.asyncCompletion === true || collected || (record.message.payload.type !== "task.result" && record.message.payload.type !== "task.failed"))
        && (record.message.expiresAt === undefined || Date.parse(record.message.expiresAt) > this.clock.now().getTime())
        && record.status !== "handled"
        && !consumed.has(record.message.messageId)
      ));
    }
    this.enqueue();
    while (!this.stopped) {
      if (signal?.aborted || this.options.signal?.aborted) await this.cancelAll("Run aborted");
      this.assertAdmissionActive(signal);
      await this.lifecycle.reconcile();
      this.lifecycle.checkFailure();
      const boards = await this.lifecycle.boards();
      if ((await this.groupBoundaryMessages(this.parentLaneId)).length > 0) return true;
      const collected = boards.every(isCollectedTeam);
      const consumed = new Set(projectCommittedBoundaryMessageIds(await this.options.readEvents(), this.runId, this.parentLaneId));
      const sources = new Set([this.parentLaneId, ...this.branches.keys(), ...[...this.reducers.values()].map((item) => item.laneId)]);
      const pending = this.inbox.snapshot().records.filter((record) => record.message.runId === this.runId
        && record.message.to === this.parentLaneId && sources.has(record.message.from)
        && record.message.routeId === undefined && record.message.sourceEndpoint === undefined && record.message.targetEndpoint === undefined
        && (record.message.delivery === "urgent" || record.message.delivery === "next-step")
        && ["message.inform", "question.ask", "question.answer", "task.result", "task.failed"].includes(record.message.payload.type)
        && (collected || (record.message.payload.type !== "task.result" && record.message.payload.type !== "task.failed"))
        && (record.message.expiresAt === undefined || Date.parse(record.message.expiresAt) > this.clock.now().getTime())
        && record.status !== "handled" && !consumed.has(record.message.messageId));
      const delay = this.inbox.nextClaimableDelayMs(this.parentLaneId, { runId: this.runId, messageIds: pending.map((record) => record.message.messageId) });
      if (delay === 0) return true;
      if (delay === undefined && collected) return false;
      await this.enqueueReadyDependencies();
      // A recovered, uncommitted claim must become deliverable before another
      // model step is spent. Live questions/updates reach Main before join;
      // terminal-only wakeups are collected together for a finishing Main.
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(delay ?? 25, 25)));
    }
    return false;
  }

  async cancel(request: { teamId: string; reason?: string }, context: ToolExecutionContext): Promise<unknown> {
    assertOwner(context, this.runId, this.parentLaneId);
    await this.lifecycle.cancel(request.teamId, request.reason ?? "Cancelled by Team Lead");
    return { teamId: request.teamId, status: "cancelled" };
  }

  async cancelAll(reason = "Run cancelled"): Promise<void> {
    await this.enqueueLifecycle(async () => {
      for (const board of await this.lifecycle.boards()) {
        if (board.lifecycleState !== "closed") await this.lifecycle.cancel(board.teamId, reason);
      }
    });
  }

  async reduce(request: TeamReduceRequest, context: ToolExecutionContext): Promise<unknown> {
    return this.enqueueLifecycle(async () => {
      assertOwner(context, this.runId, this.parentLaneId);
      this.assertAdmissionActive(context.signal);
      const board = (await this.lifecycle.boards()).find((item) => item.teamId === request.teamId);
      if (board === undefined) throw new Error(`Unknown Team ${request.teamId}`);
      if (board.lifecycleState === "closed" || !board.joinSatisfied || board.cancellationRequested || board.presentationState !== "pending") throw new Error("Reduction requires a joined, unpresented Team");
      if (board.reducer !== undefined) {
        if (board.reductionState === "running") await this.admitReducer(board.teamId, board.reducer, context.signal);
        return { teamId: board.teamId, laneId: board.reducer.laneId, status: board.reductionState };
      }
      const now = this.clock.now();
      const hasLegacyLimits = request.maxModelTokens !== undefined
        || request.maxWallClockMs !== undefined
        || request.maxAttempts !== undefined;
      const legacyReducerBudget = {
        ...(request.maxModelTokens === undefined ? {} : { maxModelTokens: request.maxModelTokens }),
        ...(request.maxWallClockMs === undefined ? {} : { maxWallClockMs: request.maxWallClockMs }),
        ...(request.maxAttempts === undefined
          ? (hasLegacyLimits ? { maxAttempts: DEFAULT_BRANCH_ATTEMPTS } : {})
          : { maxAttempts: request.maxAttempts }),
      };
      validateBudget(legacyReducerBudget);
      const inputRef = await this.store.put(JSON.stringify(board.members.map((member) => ({
        memberId: member.memberId, outcome: member.outcome, result: member.result, failure: member.failure,
      }))), "application/json");
      this.assertAdmissionActive(context.signal);
      const reducer: TeamMemberDefinition = {
        memberId: "reducer", laneId: `team-reducer:${board.teamId}`, dependsOn: [], required: true,
        task: {
          type: "task.request", taskId: `team:${board.teamId}:reduction`,
          goal: { version: 1, statement: request.statement ?? `Synthesize the Team results for ${publicAgentName(this.parentLaneId)}, the Team Lead. Preserve disagreements, partial results and missing evidence.`, successCriteria: [], hardConstraints: ["Do not merge workspace changes; the Team Lead accepts or rejects this report."] },
          inputRefs: [inputRef], budget: {
            ...legacyReducerBudget,
            ...(request.maxWallClockMs === undefined ? {} : { deadline: new Date(now.getTime() + request.maxWallClockMs).toISOString() }),
          },
        },
      };
      reducer.task.spawnContext = this.memberSpawnContext(board.teamId, reducer.memberId, reducer.laneId, reducer.task, [], true);
      await this.lifecycle.requestReduction(board.teamId, reducer);
      await this.admitReducer(board.teamId, reducer, context.signal);
      return { teamId: board.teamId, laneId: reducer.laneId, status: "queued" };
    });
  }

  async present(request: { teamId: string; disposition: "accepted" | "rejected" }, context: ToolExecutionContext): Promise<unknown> {
    assertOwner(context, this.runId, this.parentLaneId);
    if (request.disposition !== "accepted" && request.disposition !== "rejected") throw new TypeError("Unknown Team presentation disposition");
    await this.lifecycle.present(request.teamId, request.disposition);
    return { teamId: request.teamId, disposition: request.disposition };
  }

  private async admitReducer(teamId: string, member: TeamMemberDefinition, signal?: AbortSignal): Promise<void> {
    this.assertAdmissionActive(signal);
    if (this.reducers.has(teamId)) return;
    const admittedAt = taskAdmittedAt(member.task);
    const dispatcher = new TaskDispatcher({ inbox: this.inbox, runId: this.runId, from: this.parentLaneId, to: member.laneId, clock: this.clock,
      ...(admittedAt === undefined ? {} : { admittedAt }),
    });
    await dispatcher.dispatch({
      taskId: member.task.taskId, goal: member.task.goal, inputRefs: member.task.inputRefs, budget: member.task.budget,
      ...(member.task.spawnContext === undefined ? {} : { spawnContext: member.task.spawnContext }),
    });
    await this.options.eventSink.append({
      runId: this.runId, laneId: member.laneId, type: "lane.registered", payload: { kind: "worker" },
      correlationId: `${this.runId}:team:${teamId}`, idempotencyKey: `${this.runId}:${member.laneId}:registered`,
      visibility: "run", occurredAt: this.clock.now().toISOString(),
    });
    const events = await this.options.readEvents();
    this.assertAdmissionActive(signal);
    const budget = new RunTokenBudget(undefined, laneFamilyTokens(events, this.runId, member.laneId), { parent: this.options.runTokenBudget, scope: member.laneId });
    const runtime = this.createBranchRuntime(teamId, member.memberId, member.laneId, budget, events, member.task.budget, member.task.goal, member, true);
    this.reducers.set(teamId, runtime);
    runtime.scheduler.enqueue();
  }

  async messageTargets(from: LaneId = this.parentLaneId): Promise<readonly LaneId[]> {
    if (this.stopped || this.options.signal?.aborted) return [];
    const targets = new Set<LaneId>();
    for (const board of await this.lifecycle.boards()) {
      if (board.cancellationRequested || board.lifecycleState === "closed") continue;
      if (from === this.parentLaneId) {
        for (const member of board.members) {
          if (!member.terminal || (board.tasks ?? []).some((task) => task.laneId === member.laneId && isOpenResidentTaskStatus(task.status))) targets.add(member.laneId);
        }
        if (board.reducer !== undefined && board.reductionState === "running") targets.add(board.reducer.laneId);
      } else {
        const sender = board.members.find((member) => member.laneId === from);
        const hasActiveTask = (board.tasks ?? []).some((task) => task.laneId === from && isOpenResidentTaskStatus(task.status));
        if ((sender !== undefined && (!sender.terminal || hasActiveTask)) || (board.reducer?.laneId === from && board.reductionState === "running")) {
          targets.add(this.parentLaneId);
          if (sender !== undefined && board.definition?.peerMessaging === "team-members") {
            for (const member of board.members) if ((!member.terminal || (board.tasks ?? []).some((task) => task.laneId === member.laneId && isOpenResidentTaskStatus(task.status))) && member.laneId !== from) targets.add(member.laneId);
          }
        }
      }
    }
    return [...targets];
  }

  createMessageTool(): AgentTool {
    return createInRunAgentMessageTool({
      inbox: this.inbox, runId: this.runId, from: this.parentLaneId,
      resolveTargets: () => this.messageTargets(), now: () => this.clock.now(),
      onMessage: (message) => { this.branches.get(message.to)?.scheduler.enqueue(); },
    });
  }

  private createMailbox(events: readonly AnyEvent[]): LaneMailbox {
    return new LaneMailbox({
      inbox: this.inbox, runId: this.runId, laneId: this.parentLaneId, events,
      resolveSenders: () => [this.parentLaneId, ...this.branches.keys(), ...[...this.reducers.values()].map((item) => item.laneId)],
    });
  }

  private async enqueueReadyDependencies(): Promise<boolean> {
    if (this.stopped) return false;
    let enqueued = false;
    for (const board of await this.lifecycle.boards()) {
      if (board.cancellationRequested || board.joinSatisfied) continue;
      for (const member of board.members) {
        if (member.terminal || this.fencedLanes.has(member.laneId) || member.dependsOn.length === 0) continue;
        if (!member.dependsOn.every((id) => board.members.some((item) => item.memberId === id && item.outcome === "succeeded"))) continue;
        const request = this.inbox.snapshot().records.find((record) => record.message.messageId === member.requestMessageId);
        const runtime = this.branches.get(member.laneId);
        if (request?.status === "pending" && runtime?.scheduler.pendingActivations === 0) {
          runtime.scheduler.enqueue();
          enqueued = true;
        }
      }
    }
    return enqueued;
  }

  async stop(): Promise<void> {
    await this.enqueueLifecycle(async () => {
      this.stopped = true;
      this.notifyStateChange();
      await this.lifecycle.close();
      await Promise.all([...this.nestedRuntimes.values()].map((runtime) => runtime.stop()));
      await Promise.all([...this.branches.values(), ...this.reducers.values()].map((branch) => branch.scheduler.stop()));
      this.branches.clear();
      this.teams.clear();
      this.teamDefinitions.clear();
      this.teamFingerprints.clear();
      this.recoveredAdmissions.clear();
      this.reducers.clear();
      this.nestedRuntimes.clear();
      this.closedTeams.clear();
    });
  }

  private createBranchRuntime(
    teamId: string,
    branchId: string,
    laneId: LaneId,
    tokenBudget: RunTokenBudget,
    events: readonly AnyEvent[],
    taskBudget?: TaskBudget,
    goal?: Goal,
    explicitMember?: TeamMemberDefinition,
    reducer = false,
    dynamicAssignment?: TeamTaskAssignment,
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
    const member = dynamicAssignment === undefined
      ? explicitMember ?? this.durableDefinitions.get(teamId)?.members.find((item) => item.laneId === laneId)
      : undefined;
    // Resident follow-up Tasks still inherit the original member grant. The
    // dynamic assignment intentionally has no one-shot settlement definition,
    // but it must not regain tools that the lead withheld at admission.
    const capabilityGrant = member?.capabilities
      ?? this.durableDefinitions.get(teamId)?.members.find((item) => item.laneId === laneId)?.capabilities;
    const taskContext = dynamicAssignment?.task ?? member?.task;
    const declaredToolNames = taskContext?.spawnContext?.tools === undefined
      ? undefined
      : new Set(taskContext.spawnContext.tools.map((tool) => tool.name));
    // A normal Team member may become a nested Team Lead. The child runtime
    // shares this Run's Ledger/Inbox and parent token budget, but owns its own
    // Team namespace and lifecycle. Reducers remain read-only and cannot
    // create further Teams.
    const nested = !reducer
      && capabilityGrant?.allowNestedTeam !== false
      && evaluateSubagentDepth(this.depth, this.maxDepth).allowed
      ? this.ensureNestedRuntime(laneId, tokenBudget, capabilityGrant, declaredToolNames)
      : undefined;
    const memberToolCatalog = this.memberTools(reducer, nested, capabilityGrant);
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
      tools: memberToolCatalog.filter((tool) => declaredToolNames === undefined || declaredToolNames.has(tool.definition.name)),
      ...(reducer ? {} : { parentTeamTools: [
        createTeamMessageTool(this), createTeamHistoryTool(this),
        ...this.memberReadTools(teamId, laneId, nested),
      ] }),
      reducer,
      onTaskSettled: () => this.options.onWake?.(),
      ...(dynamicAssignment === undefined ? {} : { residentTask: true, residentTaskId: dynamicAssignment.taskId }),
      runTokenBudget: tokenBudget,
      events,
      clock: this.clock,
      createId: this.createId,
      readEvents: this.options.readEvents,
      readWatermark: this.options.readWatermark,
      readAwareness: this.options.readAwareness,
      ...(reducer ? {} : { readGroupMessages: () => this.groupBoundaryMessages(laneId) }),
      onBoundaryMessages: (messages) => this.waitCoordinator.delivered(laneId, messages.map((message) => message.messageId)),
      ...(nested === undefined ? {} : { childTeam: {
        beforeStep: (context: { step: number }) => nested.beforeMainStep(context),
        afterStep: (context: import("./main-loop.js").MainAfterStepContext) => nested.enqueue(context),
        hasReadyMessages: async () => (await nested.waitingCollaboration(laneId)).ready,
      } }),
      policy: branchPolicy,
      ...(member === undefined ? {} : {
        taskDefinition: member.task,
        readDependencyResults: async () => {
          const board = (await this.lifecycle.boards()).find((item) => item.teamId === teamId);
          return member.dependsOn.flatMap((id) => {
            const dependency = board?.members.find((item) => item.memberId === id && item.outcome === "succeeded");
            return dependency?.result === undefined ? [] : [{ memberId: id, result: dependency.result }];
          });
        },
        settleTask: (input) => this.lifecycle.settle(teamId, member, input.request, input.claim, input.payload, reducer),
        readTaskTerminal: async () => {
          const board = (await this.lifecycle.boards()).find((item) => item.teamId === teamId);
          const outcome = reducer ? board?.reduction : board?.members.find((item) => item.memberId === member.memberId && item.terminal);
          if (outcome === undefined) return undefined;
          return outcome.result ?? outcome.failure ?? {
            type: "task.failed" as const, taskId: member.task.taskId,
            reason: `Team task ${outcome.outcome}`, retryable: false, evidenceRefs: [],
          };
        },
      }),
      ...(dynamicAssignment === undefined ? {} : {
        settleTask: (input) => this.reportAssignedTask(teamId, dynamicAssignment, input),
        readTaskTerminal: async () => {
          const board = (await this.lifecycle.boards()).find((item) => item.teamId === teamId);
          const task = (board?.tasks ?? []).find((item) => item.taskId === dynamicAssignment.taskId);
          return task?.latestReport?.result ?? task?.latestReport?.failure;
        },
      }),
      resolveMessageTargets: () => this.messageTargets(laneId),
      resolveMessageSenders: async () => {
        const definition = this.durableDefinitions.get(teamId);
        const nestedSources = nested === undefined
          ? []
          : [...nested.branches.keys(), ...[...nested.reducers.values()].map((item) => item.laneId)];
        return [this.parentLaneId, ...(definition?.peerMessaging === "team-members" ? definition.members.map((item) => item.laneId) : []), ...nestedSources];
      },
      onMessage: (message) => {
        this.branches.get(message.to)?.scheduler.enqueue();
        if (message.to === this.parentLaneId) this.options.onWake?.();
      },
      ...(this.options.policyVersion === undefined ? {} : { policyVersion: this.options.policyVersion }),
      ...(compactionRuntime === undefined ? {} : { compactionRuntime }),
      ...(this.options.createCompactionRuntime === undefined
        ? {}
        : { createCompactionRuntime: this.options.createCompactionRuntime }),
      ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
    });
    const scheduler = new WorkerLaneScheduler({
      executor: {
        stop: () => executor.stop(),
        runOnce: async () => {
          if (this.stopped || this.fencedLanes.has(laneId)) return { status: "idle" as const };
          const board = (await this.lifecycle.boards()).find((item) => item.teamId === teamId);
          if (board?.cancellationRequested || board?.lifecycleState === "closed") return { status: "idle" as const };
          if (!reducer && member !== undefined && !member.dependsOn.every((id) => board?.members.some((item) => item.memberId === id && item.outcome === "succeeded"))) return { status: "idle" as const };
          const result = await executor.runOnce();
          await this.lifecycle.reconcile();
          await this.enqueueReadyDependencies();
          return result;
        },
      },
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

  /**
   * Lazily create the Team control plane owned by one member lane. Child
   * runtimes intentionally share the host's persistence and model boundary;
   * only their parent lane and depth scope differ.
   */
  private ensureNestedRuntime(parentLaneId: LaneId, tokenBudget: RunTokenBudget, grant?: TeamCapabilityGrant, declaredTools?: ReadonlySet<string>): TeamRuntime {
    const branchTools = () => this.memberTools(false, undefined, grant)
      .filter((tool) => declaredTools === undefined || declaredTools.has(tool.definition.name));
    const existing = this.nestedRuntimes.get(parentLaneId);
    if (existing !== undefined) {
      existing.options.branchTools = branchTools;
      return existing;
    }
    const nested = new TeamRuntime({
      eventSink: this.options.eventSink,
      inbox: this.inbox,
      store: this.store,
      model: this.options.model,
      modelName: this.options.modelName,
      runId: this.runId,
      workspace: this.options.workspace,
      parentLaneId,
      depth: this.depth + 1,
      maxDepth: this.maxDepth,
      branchTools,
      runTokenBudget: tokenBudget,
      readEvents: this.options.readEvents,
      readWatermark: this.options.readWatermark,
      readAwareness: this.options.readAwareness,
      ...(this.options.policy === undefined ? {} : { policy: this.options.policy }),
      ...(this.options.policyVersion === undefined ? {} : { policyVersion: this.options.policyVersion }),
      ...(this.options.createCompactionRuntime === undefined ? {} : { createCompactionRuntime: this.options.createCompactionRuntime }),
      clock: this.clock,
      createId: this.createId,
      ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
      onWake: () => this.branches.get(parentLaneId)?.scheduler.enqueue(),
    });
    nested.waitCoordinator = this.waitCoordinator;
    this.nestedRuntimes.set(parentLaneId, nested);
    return nested;
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleTail.then(operation);
    this.lifecycleTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private notifyStateChange(): void {
    this.waitCoordinator.notify();
  }

  private assertAdmissionActive(signal?: AbortSignal): void {
    if (this.stopped) throw new Error("Team runtime is stopped");
    if (signal?.aborted) throw signal.reason ?? new DOMException("Team admission cancelled", "AbortError");
    if (this.options.signal?.aborted) throw this.options.signal.reason ?? new DOMException("Run aborted", "AbortError");
  }

  private assertTeamAccess(board: TeamBoard, context: ToolExecutionContext): LaneId {
    if (context.runId !== this.runId) throw new Error("Team capability is bound to another Run");
    const sender = context.laneId ?? this.parentLaneId;
    if (sender === this.parentLaneId) return sender;
    const member = board.members.find((item) => item.laneId === sender);
    const activeTask = (board.tasks ?? []).some((task) => task.laneId === sender && !["done", "failed", "cancelled"].includes(task.status));
    if (member === undefined || (member.terminal && !activeTask)) throw new Error(`Lane ${publicLaneName(sender)} is not an active Team member`);
    return sender;
  }

  private memberReadTools(teamId: string, laneId: LaneId, nested?: TeamRuntime): AgentTool[] {
    const readMembership = async (context: ToolExecutionContext): Promise<TeamBoard> => {
      this.assertAdmissionActive(context.signal);
      assertOwner(context, this.runId, laneId);
      await this.lifecycle.reconcile();
      const board = (await this.lifecycle.boards()).find((item) => item.teamId === teamId);
      if (board === undefined) throw new Error(`Unknown Team ${teamId}`);
      this.assertTeamAccess(board, { ...context, laneId });
      if (board.lifecycleState === "closed" || board.cancellationRequested) throw new Error(`Team ${teamId} is closed`);
      return board;
    };
    return [
      createTeamStatusTool({ status: async (context) => {
        const board = await readMembership(context);
        const owned = nested === undefined ? [] : (await nested.status({ ...context, laneId })).teams;
        return { teams: [board, ...owned] };
      } }),
      createTaskWaitTool({ wait: async (request, context) => {
        await readMembership(context);
        const runtime = normalizeId(request.teamId, "teamId") === teamId ? this : nested;
        if (runtime === undefined) throw new Error(`Unknown Team ${request.teamId}`);
        return runtime.wait(request, { ...context, laneId });
      } }),
    ];
  }

  private memberTools(reducer: boolean, nested?: TeamRuntime, grant?: TeamCapabilityGrant): readonly AgentTool[] {
    if (!reducer) {
      const allowed = grant?.tools === undefined ? undefined : new Set(grant.tools);
      const inherited = this.availableBranchTools().filter((tool) => allowed === undefined || allowed.has(tool.definition.name));
      return [
        ...inherited,
        ...(nested === undefined ? [] : createNestedTeamTools(nested)),
      ];
    }
    // Custom tools need explicit effect metadata; legacy unknown-tool defaults
    // must not turn arbitrary host capabilities into a read-only reducer grant.
    return new MoweCatalog(this.availableBranchTools()).entries()
      .filter(({ tool, metadata }) => ((tool as MoweAgentTool).metadata?.effect ?? FIRST_PARTY_MOWE_METADATA[tool.definition.name]?.effect) !== undefined
        && (metadata.effect === "read" || metadata.effect === "compute"))
      .map(({ tool }) => tool);
  }

  private memberSpawnContext(teamId: string, branchId: string, laneId: LaneId, task: TaskRequest, peers: readonly LaneId[], reducer = false, grant?: TeamCapabilityGrant): SpawnContext {
    const provided = this.options.spawnContext?.({ teamId, branchId, laneId, goal: task.goal, inputRefs: task.inputRefs, budget: task.budget });
    const declared = provided === undefined ? undefined : new Set(provided.tools.map((tool) => tool.name));
    const nested = reducer || grant?.allowNestedTeam === false ? undefined : this.nestedRuntimes.get(laneId);
    const nestedAllowed = !reducer
      && grant?.allowNestedTeam !== false
      && evaluateSubagentDepth(this.depth, this.maxDepth).allowed;
    const nestedNames = nested === undefined
      ? (nestedAllowed ? [...NESTED_TEAM_TOOL_NAMES] : [])
      : createNestedTeamTools(nested).map((tool) => tool.definition.name);
    const tools = [
      ...capabilityEntriesFromTools(this.memberTools(reducer, undefined, grant)
        .filter((tool) => declared === undefined || declared.has(tool.definition.name))),
      // Parent channel and task reads come from Team membership, not the host's
      // workspace-tool whitelist or permission to create a nested Team.
      ...capabilityEntriesFromTools(reducer ? [] : [
        createTeamMessageTool(this), createTeamHistoryTool(this),
        createTeamStatusTool(this), createTaskWaitTool(this),
      ]),
      ...["agent_awareness", "agent_message", ...(reducer ? [] : ["teto_start", "teto_stop", "teto_status", ...nestedNames])]
        .map((name) => ({
          name,
          kind: "tool" as const,
          description: RUNTIME_CAPABILITY_DESCRIPTIONS[name] ?? `Team control: ${name}`,
        })),
    ];
    const parent = provided?.parent ?? {
      workspaceId: "local-workspace", sessionId: this.runId, runId: this.runId, laneId: this.parentLaneId, laneKind: "main" as const,
    };
    return createScopedSpawnContext({
      parent,
      child: {
        workspaceId: parent.workspaceId, sessionId: parent.sessionId, runId: this.runId,
        laneId, laneKind: reducer ? "worker" : "team", parentLaneId: this.parentLaneId, ownerLaneId: this.parentLaneId,
        relation: reducer ? "delegates" : "member-of",
      },
      goal: task.goal, inputRefs: task.inputRefs, budget: task.budget, tools,
      skills: provided?.skills ?? [], projectInstructionRefs: provided?.projectInstructionRefs ?? [], parentSummaryRefs: provided?.parentSummaryRefs ?? [],
      role: reducer ? `${publicAgentName(laneId)}, read-only Team reducer for ${teamId}; ${publicAgentName(this.parentLaneId)} reviews and accepts the report` : `${publicAgentName(laneId)}, Team member in ${teamId}; ${publicAgentName(this.parentLaneId)} is the Team Lead`,
      targets: [
        { laneId: this.parentLaneId, relation: "owns", actions: ["message.inform", "question.ask", "question.answer", "task.result"] },
        ...peers.map((peer) => ({ laneId: peer, relation: "peer" as const, actions: ["message.inform", "question.ask", "question.answer"] })),
      ],
    });
  }
}

function normalizeId(value: string, field: string): string {
  if (value.trim().length === 0 || value.includes("\0")) throw new TypeError(`${field} must be non-empty and free of NUL`);
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/gu, "-");
  if (normalized.length === 0 || normalized.length > MAX_ID_LENGTH) throw new RangeError(`${field} is too long or invalid`);
  return normalized;
}

/** Full Team control catalog granted to a member that is a nested lead. */
function createNestedTeamTools(runtime: TeamRuntime): AgentTool[] {
  const childMessage = renameNestedTool(
    createTeamMessageTool(runtime),
    "child_team_message",
    "Post a message to the nested Team's channel. The parent Team channel remains available as team_message.",
  );
  const childHistory = renameNestedTool(
    createTeamHistoryTool(runtime),
    "child_team_history",
    "Read a page of the nested Team's channel history.",
  );
  return [
    createTeamTool(runtime),
    createTeamAssignTool(runtime),
    childMessage,
    childHistory,
    createTeamCloseTool(runtime),
    createTeamCancelTool(runtime),
    createTeamReduceTool(runtime),
    createTeamPresentTool(runtime),
  ];
}

function renameNestedTool(tool: AgentTool, name: string, description: string): AgentTool {
  return {
    ...tool,
    definition: { ...tool.definition, name, description },
  };
}

function teamRequestFingerprint(request: TeamCreateRequest): string {
  // This is deliberately content-only. The Team id is already the map key,
  // while stableJson makes retries deterministic across object key order.
  return sha256(stableJson({ ...normalizeTeamCreateRequest(request), teamId: undefined }));
}

function teamCreateResult(teamId: string, branches: { branchId: string; laneId: string; status: "queued" | "duplicate" }[]): TeamCreateResult {
  return {
    teamId, branches,
    members: branches.map((branch) => ({ memberId: branch.branchId, name: publicAgentName(branch.laneId), taskId: `${teamId}:${branch.branchId}`, laneId: branch.laneId, status: branch.status })),
  };
}

function preparedTeamFingerprint(definition: readonly PreparedTeamBranch[]): string {
  return sha256(stableJson(definition.map((item) => ({
    branchId: item.branchId,
    statement: item.branch.statement,
    successCriteria: item.branch.successCriteria ?? [],
    hardConstraints: item.branch.hardConstraints ?? [],
    capabilities: item.branch.capabilities,
    inputRef: item.inputRef,
    budget: item.taskBudget,
  }))));
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

function validateCapabilityGrant(
  grant: TeamCapabilityGrant | undefined,
  availableTools: readonly AgentTool[],
): void {
  if (grant?.tools === undefined) return;
  const available = new Set(availableTools.map((tool) => tool.definition.name));
  const unknown = grant.tools.filter((name) => !available.has(name));
  if (unknown.length > 0) {
    throw new Error(`Team capability grant names tools unavailable to the creating lane: ${unknown.join(", ")}`);
  }
}

function assertOwner(context: ToolExecutionContext, runId: RunId, laneId: LaneId): void {
  if (context.runId !== runId) throw new Error("Team capability is bound to another Run");
  if (context.laneId !== undefined && context.laneId !== laneId) {
    throw new Error(`Team capability is bound to lane ${publicLaneName(laneId)}`);
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
      ...(payload.budget.maxModelTokens === undefined ? {} : { maxModelTokens: payload.budget.maxModelTokens }),
      ...(payload.budget.maxWallClockMs === undefined ? {} : { maxWallClockMs: payload.budget.maxWallClockMs }),
      ...(payload.budget.maxAttempts === undefined
        ? ((payload.budget.maxModelTokens === undefined && payload.budget.maxWallClockMs === undefined) ? {} : { maxAttempts: DEFAULT_BRANCH_ATTEMPTS })
        : { maxAttempts: payload.budget.maxAttempts }),
      ...(payload.budget.deadline === undefined ? {} : { deadline: payload.budget.deadline }),
    },
    task: structuredClone(payload),
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

function taskAdmittedAt(task: TaskRequest): string | undefined {
  const { deadline, maxWallClockMs } = task.budget;
  if (deadline === undefined || maxWallClockMs === undefined) return undefined;
  return new Date(Date.parse(deadline) - maxWallClockMs).toISOString();
}

/** Branch Main and its optional nested Teto share one task allowance. */
function laneFamilyTokens(events: readonly AnyEvent[], runId: string, laneId: string): number {
  return recoverRunTokenUsageByLane(events, runId)
    .filter((lane) => lane.laneId === laneId || lane.laneId === `${laneId}:teto`)
    .reduce((total, lane) => total + totalTokens(lane.usage), 0);
}

function isOpenResidentTaskStatus(status: string): boolean {
  return status === "queued" || status === "running" || status === "waiting" || status === "blocked";
}

function teamReplyMatches(board: TeamBoard, laneId: LaneId, payload: TaskResult | TaskFailed): boolean {
  if (board.definition === undefined) return true;
  const task = (board.tasks ?? []).find((item) => item.taskId === payload.taskId && item.laneId === laneId);
  const outcome = task?.latestReport ?? (board.reducer?.laneId === laneId ? board.reduction
    : board.members.find((member) => member.taskId === payload.taskId && member.laneId === laneId));
  return payload.type === "task.result"
    ? outcome?.result !== undefined && stableJson(payload) === stableJson(outcome.result)
    : outcome?.failure !== undefined && stableJson(payload) === stableJson(outcome.failure);
}

function isCollectedTeam(board: TeamBoard): boolean {
  if (board.lifecycleState === "closed" || board.joinState === "cancelled") return true;
  return board.joinSatisfied
    && board.members.every((member) => member.terminal)
    && board.reductionState !== "running"
    && !(board.tasks ?? []).some((task) => isOpenResidentTaskStatus(task.status));
}

function currentTeamDefinition(board: TeamBoard): TeamDefinition | undefined {
  return board.definition === undefined ? undefined : {
    ...board.definition,
    members: board.memberDefinitions ?? board.definition.members,
  };
}

function prepareMemberDefinition(member: TeamMemberDefinition): PreparedTeamBranch {
  const prepared = preparedBranchFromTask(member.memberId, member.task);
  return { ...prepared, branch: { ...prepared.branch, dependsOn: member.dependsOn, required: member.required,
    ...(member.capabilities === undefined ? {} : { capabilities: structuredClone(member.capabilities) }) } };
}

function assignmentInputMatches(task: TaskRequest, request: TeamAssignRequest): boolean {
  return task.goal.statement === request.statement
    && (request.input === undefined ? task.inputRefs.length === 0
      : task.inputRefs.length === 1 && task.inputRefs[0]?.contentHash === sha256(request.input));
}

function validateBudget(value: TaskBudget): void {
  if (value.maxModelTokens !== undefined && (!Number.isSafeInteger(value.maxModelTokens) || value.maxModelTokens < 1 || value.maxModelTokens > MAX_TASK_MODEL_TOKENS)) throw new RangeError("maxModelTokens must be within the task protocol bounds");
  if (value.maxWallClockMs !== undefined && (!Number.isSafeInteger(value.maxWallClockMs) || value.maxWallClockMs < 1 || value.maxWallClockMs > MAX_TASK_WALL_CLOCK_MS)) throw new RangeError("maxWallClockMs must be within the task protocol bounds");
  if (value.maxAttempts !== undefined && (!Number.isSafeInteger(value.maxAttempts) || value.maxAttempts < 1 || value.maxAttempts > MAX_TASK_ATTEMPTS)) throw new RangeError("maxAttempts must be within the task protocol bounds");
  if (value.deadline !== undefined && !Number.isFinite(Date.parse(value.deadline))) throw new RangeError("deadline must be a valid date-time");
}

function normalizeChannelId(value: string | undefined): string {
  const channel = (value ?? "general").trim();
  if (channel.length === 0 || channel.length > 96 || channel.includes("\0")) throw new TypeError("channelId must be a non-empty string of at most 96 characters");
  return channel;
}

function boundedTeamBody(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) throw new TypeError("body must be a non-empty string");
  if (value.length > 8_192) throw new RangeError("body exceeds 8192 characters");
  return value;
}

function teamMessageResult(
  event: Extract<AnyEvent, { type: "team.message.sent" }>,
  status: TeamMessageResult["status"],
): TeamMessageResult {
  const payload = event.payload;
  return {
    status,
    messageId: event.eventId,
    teamId: payload.teamId,
    channelId: payload.channelId,
    sequence: payload.sequence,
    fromLane: payload.fromLane,
    ...(payload.threadId === undefined ? {} : { threadId: payload.threadId }),
    body: payload.body,
    mentions: [...payload.mentions],
    artifactRefs: structuredClone(payload.artifactRefs),
    cursor: teamChannelCursor(event),
  };
}

export { TeamRuntime as TeamCoordinator };
