import type { InboxProjection, InboxRecord } from "../a2a/index.js";
import { InboxProjector, projectInbox } from "../a2a/index.js";
import type { AnyEvent } from "../domain/events.js";
import type {
  TeamDefinition,
  TeamJoined,
  TeamJoinPolicy,
  TeamJoinState,
  TeamMemberDefinition,
  TeamMemberExecution,
  TeamMemberOutcome,
  TeamMemberSettlement,
  TeamRunReport,
  TeamTaskAssignment,
  TeamReduction,
} from "../domain/team.js";
import type {
  ArtifactRef,
  Goal,
  LaneId,
  LaneStatus,
  RunId,
  TaskBudget,
  TaskFailed,
  TaskResult,
} from "../domain/types.js";
import { stableJson } from "../ledger/hash.js";

export type { TeamJoinPolicy } from "../domain/team.js";

export type TeamBoardBranchStatus =
  | "queued" | "claimed" | "running" | "completed" | "partial"
  | "failed" | "cancelled" | "abandoned" | "unknown";
export type TeamBoardStatus = Exclude<TeamBoardBranchStatus, "claimed">;

export interface TeamBoardLease {
  claimId: string;
  claimedBy: LaneId;
  claimedAt: string;
  attempt: number;
}

export interface TeamBoardMember {
  teamId: string;
  memberId: string;
  /** Compatibility alias; this is a live member, not a historical Run branch. */
  branchId: string;
  laneId: LaneId;
  taskId: string;
  requestMessageId: string;
  coordinator: LaneId;
  goal: Goal;
  inputRefs: ArtifactRef[];
  budget: TaskBudget;
  dependsOn: string[];
  required: boolean;
  capabilities?: import("../domain/team.js").TeamCapabilityGrant;
  registered: boolean;
  laneStatus?: LaneStatus;
  execution: TeamMemberExecution;
  outcome?: TeamMemberOutcome;
  status: TeamBoardBranchStatus;
  /** True only for a validated task settlement, never a lane status alone. */
  terminal: boolean;
  attempt: number;
  lease?: TeamBoardLease;
  acceptedMessageId?: string;
  result?: TaskResult;
  failure?: TaskFailed;
  latestReport?: TeamRunReport & { reportId: string; runId: RunId };
  reason?: string;
  lastOffset: number;
  anomalies: string[];
}

export type TeamTaskStatus = "queued" | "running" | "waiting" | "blocked" | "review" | "done" | "failed" | "cancelled" | "unknown";

export interface TeamBoardTask {
  taskId: string;
  memberId: string;
  laneId: LaneId;
  assignmentVersion: number;
  statement: string;
  status: TeamTaskStatus;
  assignedAt: string;
  latestReport?: TeamRunReport & { reportId: string; runId: RunId };
}

export type TeamBoardBranch = TeamBoardMember;

export interface TeamBoard {
  runId: RunId;
  teamId: string;
  leadLaneId: LaneId;
  coordinator: LaneId;
  definition?: TeamDefinition;
  /** Current admission projection, including append-only member additions. */
  memberDefinitions?: TeamMemberDefinition[];
  joinPolicy: TeamJoinPolicy;
  status: TeamBoardStatus;
  joinReady: boolean;
  joinSatisfied: boolean;
  joinState: TeamJoinState;
  cancellationRequested: boolean;
  reductionState: "not-started" | "running" | "completed" | "failed";
  presentationState: "pending" | "accepted" | "rejected";
  lifecycleState: "open" | "closed";
  closedReason?: string;
  reducer?: TeamMemberDefinition;
  reduction?: TeamReduction;
  members: TeamBoardMember[];
  /** Durable tasks assigned after Team creation, including their latest handoff. */
  tasks?: TeamBoardTask[];
  /** Compatibility alias of members. */
  branches: TeamBoardMember[];
  anomalies: string[];
  lastOffset: number;
}

export interface TeamBoardProjectionOptions {
  runId?: RunId;
  inbox?: InboxProjection | readonly InboxRecord[];
  /** Legacy only. Modern Teams persist their policy in team.created. */
  joinPolicy?: TeamJoinPolicy;
}

/** A read-only projection: scheduling and lifecycle commits belong to the runtime. */
export function projectTeamBoards(
  events: readonly AnyEvent[],
  options: TeamBoardProjectionOptions = {},
): TeamBoard[] {
  const suppliedRecords = options.inbox === undefined
    ? undefined
    : "records" in options.inbox ? options.inbox.records : options.inbox;
  const runIds = options.runId === undefined
    ? new Set([...events.map((event) => event.runId), ...(suppliedRecords ?? []).map((record) => record.message.runId)])
    : new Set([options.runId]);
  return [...runIds].sort(compareText).flatMap((runId) => {
    const seen = new Set<string>();
    const scopedEvents = events.filter((event) => event.runId === runId)
      .sort((left, right) => left.globalOffset - right.globalOffset)
      .filter((event) => {
        if (seen.has(event.eventId)) return false;
        seen.add(event.eventId);
        return true;
      });
    const records = suppliedRecords === undefined
      ? projectInbox(scopedEvents).records.filter((record) => record.message.runId === runId)
      : suppliedRecords.filter((record) => record.message.runId === runId);
    return projectRunBoards(runId, scopedEvents, records, options.joinPolicy);
  });
}

export function projectTeamBoard(
  events: readonly AnyEvent[],
  teamId: string,
  options: TeamBoardProjectionOptions = {},
): TeamBoard | undefined {
  return projectTeamBoards(events, options).find((board) => board.teamId === teamId);
}

export function parseTeamLane(laneId: string): {
  teamId: string;
  memberId: string;
  branchId: string;
  laneId: string;
} | undefined {
  const parts = laneId.split(":");
  if (parts.length !== 3 || parts[0] !== "team" || !parts[1] || !parts[2]) return undefined;
  return { teamId: parts[1], memberId: parts[2], branchId: parts[2], laneId };
}

interface DraftMember {
  definition: TeamMemberDefinition;
  admittedOffset: number;
  request?: InboxRecord;
  registered: boolean;
  laneStatus?: LaneStatus;
  acceptedMessageId?: string;
  settlement?: TeamMemberSettlement;
  latestReport?: TeamRunReport & { reportId: string; runId: RunId };
  terminalReplies: string[];
  lastOffset: number;
  anomalies: string[];
}

interface DraftTeam {
  teamId: string;
  coordinator: LaneId;
  definition?: TeamDefinition;
  definitionOffset?: number;
  members: Map<LaneId, DraftMember>;
  tasks: Map<string, DraftTask>;
  cancellationRequested: boolean;
  cancelled: boolean;
  joined?: TeamJoined;
  reducer?: TeamMemberDefinition;
  reduction?: TeamReduction;
  presentationState: TeamBoard["presentationState"];
  closed?: { reason: string; closedBy: LaneId };
  lastOffset: number;
  anomalies: string[];
}

interface DraftTask {
  assignment: TeamTaskAssignment;
  assignedAt: string;
  requestMessageId?: string;
  latestReport?: TeamRunReport & { reportId: string; runId: RunId };
  status: TeamTaskStatus;
}

function newTeam(teamId: string, coordinator: LaneId): DraftTeam {
  return {
    teamId, coordinator, members: new Map(), cancellationRequested: false,
    tasks: new Map(), cancelled: false, presentationState: "pending", lastOffset: 0, anomalies: [],
  };
}

function newMember(definition: TeamMemberDefinition, offset: number): DraftMember {
  return {
    definition: structuredClone(definition), admittedOffset: offset, registered: false,
    terminalReplies: [], lastOffset: offset, anomalies: [],
  };
}

function projectRunBoards(
  runId: RunId,
  events: readonly AnyEvent[],
  records: readonly InboxRecord[],
  legacyPolicy?: TeamJoinPolicy,
): TeamBoard[] {
  const teams = new Map<string, DraftTeam>();
  for (const event of events) {
    if (event.type !== "team.created" || event.laneId !== event.payload.leadLaneId) continue;
    const existing = teams.get(event.payload.teamId);
    if (existing !== undefined) {
      anomaly(existing, stableJson(existing.definition) === stableJson(event.payload)
        ? "duplicate team.created" : "conflicting team.created ignored");
      continue;
    }
    const team = newTeam(event.payload.teamId, event.payload.leadLaneId);
    team.definition = structuredClone(event.payload);
    team.definitionOffset = event.globalOffset;
    team.lastOffset = event.globalOffset;
    for (const member of event.payload.members) {
      team.members.set(member.laneId, newMember(member, event.globalOffset));
    }
    teams.set(team.teamId, team);
  }
  const closedAdmissions = new Set<string>();
  const admissionOperations = new Map<string, string>();
  for (const event of events) {
    if (event.type === "team.cancel.requested" || event.type === "team.closed") {
      const team = teams.get(event.payload.teamId);
      if (event.laneId === team?.coordinator) closedAdmissions.add(team.teamId);
      continue;
    }
    if (event.type !== "team.member.added") continue;
    const team = teams.get(event.payload.teamId);
    if (team === undefined) continue;
    const { member, operationId, addedBy } = event.payload;
    if (event.laneId !== team.coordinator || addedBy !== team.coordinator
      || event.globalOffset <= (team.definitionOffset ?? Infinity)
      || closedAdmissions.has(team.teamId)) {
      anomaly(team, "team.member.added has no authorized open Team admission");
      continue;
    }
    const operationKey = `${team.teamId}:${operationId}`;
    if (admissionOperations.has(operationKey) || team.members.has(member.laneId)
      || [...team.members.values()].some((existing) => existing.definition.memberId === member.memberId
        || existing.definition.task.taskId === member.task.taskId)
      || member.laneId !== `team:${team.teamId}:${member.memberId}`
      || team.members.size >= 16) {
      anomaly(team, "team.member.added conflicts with an existing admission or membership limit");
      continue;
    }
    admissionOperations.set(operationKey, member.memberId);
    team.members.set(member.laneId, newMember(member, event.globalOffset));
  }
  const reducerLanes = new Set(events.flatMap((event) => {
    if (event.type !== "team.reduction.requested") return [];
    const team = teams.get(event.payload.teamId);
    return event.laneId === team?.coordinator && !team.members.has(event.payload.reducer.laneId)
      ? [event.payload.reducer.laneId] : [];
  }));

  const sentRecords = new Map(records.map((record) => [record.message.messageId, record]));
  for (const event of events) {
    if (event.type !== "message.sent" || event.payload.message.runId !== runId) continue;
    const record = sentRecords.get(event.payload.message.messageId);
    if (record === undefined || stableJson(record.message) !== stableJson(event.payload.message)) {
      sentRecords.set(event.payload.message.messageId, recordFromEvent(event));
    }
  }
  for (const record of [...sentRecords.values()].sort((left, right) => left.sentAtOffset - right.sentAtOffset)) {
    const message = record.message;
    if (message.payload.type !== "task.request" || reducerLanes.has(message.to)) continue;
    const parsed = parseTeamLane(message.to);
    if (parsed === undefined) continue;
    const team = teams.get(parsed.teamId) ?? newTeam(parsed.teamId, message.from);
    teams.set(team.teamId, team);
    const existing = team.members.get(message.to);
    if (team.definition !== undefined && existing === undefined) {
      anomaly(team, `task.request targets undeclared member ${parsed.memberId}`);
      continue;
    }
    const member = existing ?? newMember({
      memberId: parsed.memberId, laneId: message.to, task: message.payload,
      dependsOn: [], required: true,
    }, record.sentAtOffset);
    team.members.set(message.to, member);
    if (record.sentAtOffset <= member.admittedOffset && team.definition !== undefined) {
      anomaly(member, "task.request precedes member admission");
      continue;
    }
    // Follow-up requests are checked against assignments in timeline order.
    if (message.payload.taskId !== member.definition.task.taskId) continue;
    if (message.from !== team.coordinator) {
      anomaly(member, "task.request does not match its declared task or lead");
      continue;
    }
    if (member.request !== undefined && member.request.message.messageId !== message.messageId) {
      anomaly(member, `multiple task requests target ${message.to}`);
      continue;
    }
    member.request = structuredClone(record);
    member.lastOffset = Math.max(member.lastOffset, record.sentAtOffset);
  }

  for (const event of events) {
    if (event.type !== "lane.registered" || event.payload.kind !== "team" || reducerLanes.has(event.laneId)) continue;
    const parsed = parseTeamLane(event.laneId);
    if (parsed === undefined) continue;
    const team = teams.get(parsed.teamId) ?? newTeam(parsed.teamId, "main");
    teams.set(team.teamId, team);
    if (team.members.has(event.laneId)) continue;
    if (team.definition !== undefined) {
      anomaly(team, `lane.registered targets undeclared member ${parsed.memberId}`);
      continue;
    }
    const member = newMember({
      memberId: parsed.memberId, laneId: event.laneId, dependsOn: [], required: true,
      task: {
        type: "task.request", taskId: `${parsed.teamId}:${parsed.memberId}`,
        goal: { version: 1, statement: "Unknown task request", successCriteria: [], hardConstraints: [] },
        inputRefs: [], budget: { maxModelTokens: 1, maxWallClockMs: 1 },
      },
    }, event.globalOffset);
    anomaly(member, "lane.registered has no durable task.request");
    team.members.set(event.laneId, member);
  }

  const eventMessageIds = new Set(events.flatMap((event) => (
    event.type === "message.sent" ? [event.payload.message.messageId] : []
  )));
  const timeline = [
    ...events.map((event) => ({ offset: event.globalOffset, event })),
    ...[...sentRecords.values()]
      .filter((record) => !eventMessageIds.has(record.message.messageId))
      .map((record) => ({ offset: record.sentAtOffset, record })),
  ].sort((left, right) => left.offset - right.offset);
  const inbox = new InboxProjector();
  for (const entry of timeline) {
    if ("record" in entry) {
      applyTaskMessage(teams, entry.record);
      continue;
    }
    const event = entry.event;
    const dynamic = dynamicTeamEvent(event);
    if (dynamic !== undefined) {
      const team = teams.get(dynamic.payload.teamId);
      if (team !== undefined) applyDynamicTeamEvent(team, dynamic);
      continue;
    }
    const parsed = parseTeamLane(event.laneId);
    const member = parsed === undefined ? undefined : teams.get(parsed.teamId)?.members.get(event.laneId);
    if (member !== undefined && event.globalOffset >= member.admittedOffset) member.lastOffset = Math.max(member.lastOffset, event.globalOffset);
    // A caller may supply a snapshot alongside a partial Ledger read. Unknown
    // claims cannot authenticate a settlement; their snapshot remains diagnostic.
    if (event.type === "message.sent" && event.payload.message.runId === runId) {
      inbox.apply(event);
      applyTaskMessage(teams, recordFromEvent(event));
    } else if (event.type === "message.claimed" || event.type === "message.handled") {
      if (inbox.get(event.payload.messageId) !== undefined) inbox.apply(event);
      if (event.type === "message.claimed") {
        const message = inbox.get(event.payload.messageId)?.message;
        if (message?.payload.type === "task.request") {
          for (const candidate of teams.values()) {
            const task = (candidate.tasks ?? new Map()).get(message.payload.taskId);
            if (task !== undefined && task.status === "queued") task.status = "running";
          }
        }
      }
    }
    if (event.type === "lane.registered" || event.type === "lane.status") {
      if (member !== undefined && event.globalOffset >= member.admittedOffset) {
        if (event.type === "lane.registered") member.registered = true;
        else member.laneStatus = event.payload.status;
        member.lastOffset = Math.max(member.lastOffset, event.globalOffset);
      }
    }
    if (isTeamEvent(event)) {
      const team = teams.get(event.payload.teamId);
      if (team !== undefined) applyTeamEvent(team, event, inbox);
    }
  }
  return [...teams.values()].sort((left, right) => compareText(left.teamId, right.teamId))
    .map((team) => finalizeTeam(runId, team, inbox, legacyPolicy));
}

type TeamEvent = Extract<AnyEvent, { type: `team.${string}` }>;

type DynamicTeamEvent = {
  runId: RunId;
  laneId: LaneId;
  globalOffset: number;
  occurredAt: string;
  type: "team.task.assigned" | "team.run.reported";
  payload: TeamTaskAssignment | (TeamRunReport & { reportId: string; runId: RunId });
};

function dynamicTeamEvent(event: AnyEvent): DynamicTeamEvent | undefined {
  const candidate = event as unknown as { type?: string };
  if (candidate.type !== "team.task.assigned" && candidate.type !== "team.run.reported") return undefined;
  return event as unknown as DynamicTeamEvent;
}

function applyDynamicTeamEvent(team: DraftTeam, event: DynamicTeamEvent): void {
  team.lastOffset = Math.max(team.lastOffset, event.globalOffset);
  if (event.type === "team.task.assigned") {
    const assignment = event.payload as TeamTaskAssignment;
    if (assignment.assignedBy !== team.coordinator || event.laneId !== team.coordinator) {
      anomaly(team, "team.task.assigned has an unauthorized assigner");
      return;
    }
    const member = [...team.members.values()].find((candidate) => candidate.definition.memberId === assignment.memberId);
    if (member === undefined || member.definition.laneId !== assignment.laneId
      || member.admittedOffset >= event.globalOffset || member.settlement === undefined
      || team.closed !== undefined || team.cancellationRequested) {
      anomaly(team, "team.task.assigned names an unknown member lane");
      return;
    }
    const previous = team.tasks.get(assignment.taskId);
    if (previous !== undefined) {
      if (stableJson(previous.assignment) !== stableJson(assignment)) anomaly(team, "conflicting team.task.assigned ignored");
      return;
    }
    const active = [...team.tasks.values()].find((task) => task.assignment.memberId === assignment.memberId
      && ["queued", "running", "waiting", "blocked"].includes(task.status));
    if (active !== undefined) {
      anomaly(team, `member ${assignment.memberId} has a concurrent active task`);
      return;
    }
    team.tasks.set(assignment.taskId, { assignment: structuredClone(assignment), assignedAt: event.occurredAt, status: "queued" });
    team.presentationState = "pending";
    return;
  }
  const report = event.payload as TeamRunReport & { reportId: string; runId: string };
  if (report.runId !== event.runId || event.laneId !== report.laneId) {
    anomaly(team, "team.run.reported runId does not match its event envelope");
    return;
  }
  if (report.assignmentVersion === 0) {
    const member = team.members.get(report.laneId);
    if (member === undefined || member.definition.task.taskId !== report.taskId
      || member.settlement === undefined
      || (report.result !== undefined && stableJson(report.result) !== stableJson(member.settlement.result ?? null))
      || (report.failure !== undefined && member.settlement.failure !== undefined
        && stableJson(report.failure) !== stableJson(member.settlement.failure))) {
      anomaly(team, "initial team.run.reported does not match its member settlement");
      return;
    }
    if (member.latestReport === undefined) member.latestReport = structuredClone(report);
    else if (stableJson(member.latestReport) !== stableJson(report)) anomaly(team, "conflicting initial team.run.reported ignored");
    return;
  }
  const task = team.tasks.get(report.taskId);
  if (task === undefined || task.assignment.laneId !== report.laneId
    || task.assignment.assignmentVersion !== report.assignmentVersion) {
    anomaly(team, "team.run.reported does not match the current assignment");
    return;
  }
  if (task.latestReport !== undefined) {
    if (stableJson(task.latestReport) !== stableJson(report)) anomaly(team, "conflicting team.run.reported ignored");
    return;
  }
  if (team.closed !== undefined || team.cancellationRequested) {
    anomaly(team, "late team.run.reported after Team closure ignored");
    return;
  }
  task.latestReport = structuredClone(report);
  task.status = report.result !== undefined ? "review"
    : report.kind === "blocked" ? "blocked"
      : report.kind === "failed" ? "failed" : "waiting";
}

function isTeamEvent(event: AnyEvent): event is TeamEvent {
  return event.type.startsWith("team.");
}

function applyTeamEvent(team: DraftTeam, event: TeamEvent, inbox: InboxProjector): void {
  team.lastOffset = Math.max(team.lastOffset, event.globalOffset);
  if (event.type === "team.created") return;
  if (event.type === "team.member.added") {
    if (team.members.get(event.payload.member.laneId)?.admittedOffset === event.globalOffset) team.presentationState = "pending";
    return;
  }
  if (team.definitionOffset !== undefined && event.globalOffset < team.definitionOffset) {
    anomaly(team, `${event.type} precedes Team admission`);
    return;
  }
  if (event.type === "team.member.settled") {
    const member = [...team.members.values()].find((candidate) => candidate.definition.memberId === event.payload.memberId);
    if (member === undefined) {
      anomaly(team, `settlement names unknown member ${event.payload.memberId}`);
      return;
    }
    applySettlement(team, member, event, inbox);
    return;
  }
  if (event.type === "team.message.sent") {
    const senderIsMember = [...team.members.values()].some((member) => member.definition.laneId === event.payload.fromLane);
    if (event.payload.fromLane !== team.coordinator && !senderIsMember) {
      anomaly(team, "team.message.sent has an unauthorized sender");
    }
    return;
  }
  if (event.laneId !== team.coordinator) {
    anomaly(team, `${event.type} was not emitted by the Team lead`);
    return;
  }
  switch (event.type) {
    case "team.cancel.requested":
      if (event.payload.requestedBy !== team.coordinator) {
        anomaly(team, "team.cancel.requested has an unauthorized requester");
      } else team.cancellationRequested = true;
      break;
    case "team.cancelled":
      if (!team.cancellationRequested || [...team.members.values()].some((member) => member.settlement === undefined)) {
        anomaly(team, "team.cancelled has no cancellation request or unsettled members");
      } else {
        team.cancelled = true;
        cancelOpenResidentTasks(team);
      }
      break;
    case "team.joined":
      applyJoin(team, event);
      break;
    case "team.reduction.requested":
      if (team.joined === undefined || team.cancellationRequested
        || team.members.has(event.payload.reducer.laneId)
        || [...team.members.values()].some((member) => member.definition.task.taskId === event.payload.reducer.task.taskId)) {
        anomaly(team, "reduction requires a joined Team and a distinct reducer identity");
      } else if (team.reducer !== undefined) {
        anomaly(team, "duplicate reduction request ignored");
      } else team.reducer = structuredClone(event.payload.reducer);
      break;
    case "team.reduced": {
      const taskId = team.reducer?.task.taskId;
      if (taskId === undefined || !consistentOutcome(event.payload, taskId)
        || (team.cancellationRequested && !["cancelled", "abandoned"].includes(event.payload.outcome))) {
        anomaly(team, "team.reduced has no valid active reducer settlement");
      } else if (team.reduction !== undefined) {
        anomaly(team, "duplicate or conflicting reduction settlement ignored");
      } else {
        const { teamId: _teamId, ...reduction } = event.payload;
        team.reduction = structuredClone(reduction);
      }
      break;
    }
    case "team.presented":
      if (team.joined === undefined || (team.reducer !== undefined && team.reduction === undefined)
        || [...team.members.values()].some((member) => member.admittedOffset <= event.globalOffset && member.settlement === undefined)
        || [...team.tasks.values()].some((task) => task.latestReport === undefined && task.status !== "cancelled")) {
        anomaly(team, "presentation requires a joined Team and a finished requested reduction");
      } else team.presentationState = event.payload.disposition;
      break;
    case "team.closed":
      if (event.payload.closedBy !== team.coordinator) {
        anomaly(team, "team.closed has an unauthorized closer");
      } else if (team.closed !== undefined) {
        anomaly(team, "duplicate team.closed ignored");
      } else {
        team.closed = { reason: event.payload.reason, closedBy: event.payload.closedBy };
        cancelOpenResidentTasks(team);
      }
      break;
  }
}

function cancelOpenResidentTasks(team: DraftTeam): void {
  for (const task of team.tasks.values()) {
    if (["done", "failed", "cancelled", "review"].includes(task.status)) continue;
    task.status = "cancelled";
  }
}

function applySettlement(
  team: DraftTeam,
  member: DraftMember,
  event: Extract<AnyEvent, { type: "team.member.settled" }>,
  inbox: InboxProjector,
): void {
  member.lastOffset = Math.max(member.lastOffset, event.globalOffset);
  const settlement = event.payload;
  const requestId = member.request?.message.messageId;
  const claim = requestId === undefined ? undefined : inbox.get(requestId)?.claim;
  const host = event.laneId === team.coordinator;
  const controlOutcome = settlement.outcome === "cancelled" || settlement.outcome === "abandoned" || settlement.outcome === "failed";
  if ((!host && event.laneId !== member.definition.laneId)
    || settlement.taskId !== member.definition.task.taskId
    || (settlement.requestMessageId !== undefined && settlement.requestMessageId !== requestId)
    || !consistentOutcome(settlement, member.definition.task.taskId)) {
    anomaly(member, "member settlement has a mismatched sender, task, parent, or outcome");
    return;
  }
  if (team.cancellationRequested && settlement.outcome !== "cancelled" && settlement.outcome !== "abandoned") {
    anomaly(member, "late member settlement after Team cancellation ignored");
    return;
  }
  if ((settlement.claimId !== undefined && (claim?.claimId !== settlement.claimId
      || claim.attempt !== settlement.attempt || claim.claimedBy !== member.definition.laneId))
    || (claim !== undefined && settlement.claimId === undefined && !(host && controlOutcome))
    || (!controlOutcome && (requestId === undefined || (team.definition !== undefined && claim === undefined)))) {
    anomaly(member, "member settlement has a stale or missing claim");
    return;
  }
  if (member.settlement !== undefined) {
    anomaly(member, "duplicate or conflicting member settlement ignored");
    return;
  }
  member.settlement = structuredClone(settlement);
}

function consistentOutcome(value: TeamReduction, taskId: string): boolean {
  if (value.result !== undefined) {
    const expected = value.result.status === "partial" ? "partial" : "succeeded";
    if (value.result.taskId !== taskId || value.outcome !== expected || value.failure !== undefined) return false;
  }
  if (value.failure !== undefined && (value.failure.taskId !== taskId || value.outcome === "succeeded" || value.outcome === "partial")) return false;
  return true;
}

function applyTaskMessage(teams: Map<string, DraftTeam>, record: InboxRecord): void {
  const message = record.message;
  const payload = message.payload;
  if (payload.type === "task.request") {
    for (const team of teams.values()) {
      const member = team.members.get(message.to);
      if (member === undefined || payload.taskId === member.definition.task.taskId) continue;
      const task = team.tasks.get(payload.taskId);
      if (task === undefined || message.from !== team.coordinator
        || message.to !== task.assignment.laneId || stableJson(payload) !== stableJson(task.assignment.task)) {
        anomaly(member, "task.request does not match its declared task or lead");
      } else if (task.requestMessageId !== undefined && task.requestMessageId !== message.messageId) {
        anomaly(member, `multiple task requests target ${payload.taskId}`);
      } else {
        task.requestMessageId = message.messageId;
      }
    }
    return;
  }
  if (payload.type !== "task.accept" && payload.type !== "task.result" && payload.type !== "task.failed") return;
  for (const team of teams.values()) {
    const task = team.tasks.get(payload.taskId);
    if (task !== undefined) {
      if (message.from !== task.assignment.laneId || message.to !== team.coordinator
        || task.requestMessageId === undefined || message.parentId !== task.requestMessageId
        || (message.replyTo !== undefined && message.replyTo !== task.requestMessageId)) {
        anomaly(team, `reply ${message.messageId} has a mismatched sender, task, or parent`);
      } else if (team.cancellationRequested && payload.type !== "task.accept") {
        anomaly(team, `late terminal reply ${message.messageId} after Team cancellation ignored`);
      }
      // A follow-up report owns task status; its transport cannot settle the
      // member's original task or change the original Team join outcome.
      continue;
    }
    for (const member of team.members.values()) {
      const requestId = member.request?.message.messageId;
      if (message.from !== member.definition.laneId && payload.taskId !== member.definition.task.taskId) continue;
      member.lastOffset = Math.max(member.lastOffset, record.sentAtOffset);
      if (message.from !== member.definition.laneId || message.to !== team.coordinator
        || payload.taskId !== member.definition.task.taskId || requestId === undefined
        || message.parentId !== requestId || (message.replyTo !== undefined && message.replyTo !== requestId)) {
        anomaly(member, `reply ${message.messageId} has a mismatched sender, task, or parent`);
        continue;
      }
      if (payload.type === "task.accept") {
        member.acceptedMessageId = message.messageId;
        continue;
      }
      if (member.terminalReplies.includes(message.messageId)) continue;
      member.terminalReplies.push(message.messageId);
      if (member.terminalReplies.length > 1) anomaly(member, `multiple terminal replies: ${member.terminalReplies.join(", ")}`);
      if (team.cancellationRequested) {
        anomaly(member, `late terminal reply ${message.messageId} after Team cancellation ignored`);
        continue;
      }
      // Modern replies carry notifications, not lease tokens. The host settlement
      // is authoritative; legacy Runs retain their validated transport contract.
      if (team.definition !== undefined || member.settlement !== undefined) continue;
      member.settlement = {
        teamId: team.teamId, memberId: member.definition.memberId,
        taskId: payload.taskId, requestMessageId: requestId,
        outcome: payload.type === "task.failed" ? "failed" : payload.status === "partial" ? "partial" : "succeeded",
        ...(payload.type === "task.result" ? { result: structuredClone(payload) } : { failure: structuredClone(payload) }),
      };
    }
  }
}

function applyJoin(team: DraftTeam, event: Extract<AnyEvent, { type: "team.joined" }>): void {
  if (team.joined !== undefined) {
    anomaly(team, "duplicate or conflicting team.joined ignored");
    return;
  }
  const members = [...team.members.values()].filter((member) => member.admittedOffset <= event.globalOffset);
  const settled = members.filter((member) => member.settlement !== undefined);
  const supplied = event.payload.memberOutcomes;
  const matching = supplied.length === settled.length
    && new Set(supplied.map((member) => member.memberId)).size === supplied.length
    && settled.every((member) => supplied.some((outcome) => (
      outcome.memberId === member.definition.memberId
      && outcome.taskId === member.definition.task.taskId
      && outcome.outcome === member.settlement!.outcome
    )));
  const requiredReady = members.every((member) => !member.definition.required || member.settlement !== undefined);
  const deadlineReady = event.payload.reason !== "deadline-best-effort"
    || (team.definition?.joinPolicy === "deadline-best-effort"
      && team.definition.deadline !== undefined
      && Date.parse(event.occurredAt) >= Date.parse(team.definition.deadline)
      && settled.length === members.length);
  if (team.cancellationRequested || !requiredReady || !deadlineReady || !matching) {
    anomaly(team, "team.joined does not match the durable policy and member settlements");
    return;
  }
  team.joined = structuredClone(event.payload);
}

function finalizeTeam(runId: RunId, team: DraftTeam, inbox: InboxProjector, legacyPolicy?: TeamJoinPolicy): TeamBoard {
  const members = [...team.members.values()]
    .sort((left, right) => compareText(left.definition.memberId, right.definition.memberId))
    .map((member) => finalizeMember(team, member, inbox));
  const joinReady = members.length > 0 && !team.cancellationRequested
    && members.every((member) => !member.required || member.terminal);
  const joinSatisfied = !team.cancelled && (team.definition === undefined ? joinReady : team.joined !== undefined);
  const joinState: TeamJoinState = team.cancelled ? "cancelled"
    : team.joined?.reason === "deadline-best-effort" ? "deadline-settled"
      : joinSatisfied ? "joined" : "waiting";
  const reductionState: TeamBoard["reductionState"] = team.reduction === undefined
    ? team.reducer === undefined ? "not-started" : "running"
    : team.reduction.outcome === "succeeded" || team.reduction.outcome === "partial" ? "completed" : "failed";
  return {
    runId, teamId: team.teamId, coordinator: team.coordinator, leadLaneId: team.coordinator,
    ...(team.definition === undefined ? {} : { definition: structuredClone(team.definition) }),
    memberDefinitions: [...team.members.values()].map((member) => structuredClone(member.definition)),
    joinPolicy: team.definition?.joinPolicy ?? legacyPolicy ?? "all-terminal",
    status: team.cancelled ? "cancelled"
      : [...team.tasks.values()].some((task) => task.latestReport === undefined && task.status !== "cancelled") ? "running"
        : aggregateStatus(members, joinSatisfied && members.every((member) => member.terminal)),
    joinReady, joinSatisfied, joinState, cancellationRequested: team.cancellationRequested,
    reductionState, presentationState: team.presentationState,
    ...(team.reducer === undefined ? {} : { reducer: structuredClone(team.reducer) }),
    ...(team.reduction === undefined ? {} : { reduction: structuredClone(team.reduction) }),
    members, branches: members,
    tasks: [...team.tasks.values()].sort((left, right) => compareText(left.assignment.taskId, right.assignment.taskId)).map((task) => ({
      taskId: task.assignment.taskId,
      memberId: task.assignment.memberId,
      laneId: task.assignment.laneId,
      assignmentVersion: task.assignment.assignmentVersion,
      statement: task.assignment.task.goal.statement,
      status: task.status,
      assignedAt: task.assignedAt,
      ...(task.latestReport === undefined ? {} : { latestReport: structuredClone(task.latestReport) }),
    })),
    lifecycleState: team.closed === undefined ? "open" : "closed",
    ...(team.closed === undefined ? {} : { closedReason: team.closed.reason }),
    anomalies: [...new Set([...team.anomalies, ...members.flatMap((member) => member.anomalies)])],
    lastOffset: Math.max(team.lastOffset, ...members.map((member) => member.lastOffset), 0),
  };
}

function finalizeMember(team: DraftTeam, member: DraftMember, inbox: InboxProjector): TeamBoardMember {
  const { definition, settlement, laneStatus } = member;
  const requestId = member.request?.message.messageId;
  const lease = requestId === undefined ? undefined : inbox.get(requestId)?.claim ?? member.request?.claim;
  const terminal = settlement !== undefined;
  const ended = laneStatus === "completed" || laneStatus === "failed" || laneStatus === "cancelled";
  const execution: TeamMemberExecution = terminal || ended ? "terminal"
    : laneStatus === "running" ? "running" : lease !== undefined ? "claimed" : "queued";
  const status: TeamBoardBranchStatus = settlement === undefined
    ? ended ? "unknown" : execution as "queued" | "claimed" | "running"
    : settlement.outcome === "succeeded" ? "completed" : settlement.outcome;
  const anomalies = [...member.anomalies];
  if (requestId === undefined && team.definition === undefined) anomalies.push("task request is missing");
  if (!member.registered && member.request !== undefined) anomalies.push("branch lane registration is missing");
  if (ended && !terminal) anomalies.push("lane is terminal without a valid task settlement");
  return {
    teamId: team.teamId, memberId: definition.memberId, branchId: definition.memberId,
    laneId: definition.laneId, taskId: definition.task.taskId,
    requestMessageId: requestId ?? "", coordinator: team.coordinator,
    goal: structuredClone(definition.task.goal), inputRefs: structuredClone(definition.task.inputRefs),
    budget: structuredClone(definition.task.budget), dependsOn: [...definition.dependsOn], required: definition.required,
    ...(definition.capabilities === undefined ? {} : { capabilities: structuredClone(definition.capabilities) }),
    registered: member.registered,
    ...(laneStatus === undefined ? {} : { laneStatus }),
    execution, status, terminal,
    ...(settlement === undefined ? {} : { outcome: settlement.outcome }),
    attempt: lease?.attempt ?? 0,
    ...(lease === undefined ? {} : { lease: structuredClone(lease) }),
    ...(member.acceptedMessageId === undefined ? {} : { acceptedMessageId: member.acceptedMessageId }),
    ...(settlement?.result === undefined ? {} : { result: structuredClone(settlement.result) }),
    ...(settlement?.failure === undefined ? {} : { failure: structuredClone(settlement.failure) }),
    ...(member.latestReport === undefined ? {} : { latestReport: structuredClone(member.latestReport) }),
    ...(settlement?.reason === undefined ? {} : { reason: settlement.reason }),
    lastOffset: member.lastOffset, anomalies,
  };
}

function aggregateStatus(members: readonly TeamBoardMember[], joined: boolean): TeamBoardStatus {
  if (members.length === 0) return "unknown";
  if (joined) {
    if (members.every((member) => member.outcome === "cancelled")) return "cancelled";
    if (members.some((member) => member.outcome === "failed")) return "failed";
    if (members.some((member) => member.outcome === "abandoned")) return "abandoned";
    if (members.some((member) => member.outcome === "partial" || member.outcome === "cancelled")) return "partial";
    return "completed";
  }
  if (members.every((member) => member.status === "queued")) return "queued";
  if (members.some((member) => member.status === "unknown")) return "unknown";
  return "running";
}

function recordFromEvent(event: Extract<AnyEvent, { type: "message.sent" }>): InboxRecord {
  return { message: event.payload.message, sentAtOffset: event.globalOffset, sentAt: event.occurredAt, status: "pending" };
}

function anomaly(target: { anomalies: string[] }, message: string): void {
  if (!target.anomalies.includes(message)) target.anomalies.push(message);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
