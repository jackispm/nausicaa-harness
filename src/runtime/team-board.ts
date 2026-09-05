import type { InboxProjection, InboxRecord } from "../a2a/index.js";
import { projectInbox } from "../a2a/index.js";
import type { AnyEvent } from "../domain/events.js";
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

/**
 * Durable Team-board states.  A board is a projection of Ledger/Inbox facts;
 * it is deliberately not another mutable scheduler or persistence store.
 */
export type TeamBoardBranchStatus =
  | "queued"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export type TeamBoardStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export type TeamJoinPolicy = "all-terminal" | "deadline-best-effort";

export interface TeamBoardLease {
  claimId: string;
  claimedBy: LaneId;
  claimedAt: string;
  attempt: number;
}

export interface TeamBoardBranch {
  teamId: string;
  branchId: string;
  laneId: LaneId;
  taskId: string;
  requestMessageId: string;
  coordinator: LaneId;
  goal: Goal;
  inputRefs: ArtifactRef[];
  budget: TaskBudget;
  registered: boolean;
  laneStatus?: LaneStatus;
  status: TeamBoardBranchStatus;
  terminal: boolean;
  attempt: number;
  lease?: TeamBoardLease;
  acceptedMessageId?: string;
  result?: TaskResult;
  failure?: TaskFailed;
  lastOffset: number;
  anomalies: string[];
}

export interface TeamBoard {
  runId: RunId;
  teamId: string;
  coordinator: LaneId;
  joinPolicy: TeamJoinPolicy;
  status: TeamBoardStatus;
  joinSatisfied: boolean;
  branches: TeamBoardBranch[];
  anomalies: string[];
  lastOffset: number;
}

export interface TeamBoardProjectionOptions {
  /** Restrict projection to one durable Run when the event stream is shared. */
  runId?: RunId;
  /** A caller may provide a live Inbox projection; otherwise it is rebuilt. */
  inbox?: InboxProjection | readonly InboxRecord[];
  joinPolicy?: TeamJoinPolicy;
}

/** Project every Team represented by durable task requests in one Run. */
export function projectTeamBoards(
  events: readonly AnyEvent[],
  options: TeamBoardProjectionOptions = {},
): TeamBoard[] {
  const scopedEvents = options.runId === undefined
    ? [...events]
    : events.filter((event) => event.runId === options.runId);
  const inboxRecords = normalizeInboxRecords(scopedEvents, options.inbox);
  const byTeam = new Map<string, Map<string, DraftBranch>>();
  const teamAnomalies = new Map<string, string[]>();

  const addAnomaly = (teamId: string, message: string): void => {
    const anomalies = teamAnomalies.get(teamId) ?? [];
    if (!anomalies.includes(message)) anomalies.push(message);
    teamAnomalies.set(teamId, anomalies);
  };

  for (const record of inboxRecords) {
    const message = record.message;
    if (message.payload.type !== "task.request") continue;
    const parsed = parseTeamLane(message.to);
    if (parsed === undefined) continue;
    const team = byTeam.get(parsed.teamId) ?? new Map<string, DraftBranch>();
    byTeam.set(parsed.teamId, team);
    const previous = team.get(parsed.laneId);
    if (previous !== undefined) {
      if (previous.requestMessageId !== message.messageId) {
        previous.anomalies.push(
          `multiple task requests target ${parsed.laneId}`,
        );
        addAnomaly(parsed.teamId, `branch ${parsed.branchId} has multiple task requests`);
      }
      continue;
    }
    team.set(parsed.laneId, {
      teamId: parsed.teamId,
      branchId: parsed.branchId,
      laneId: parsed.laneId,
      taskId: message.payload.taskId,
      requestMessageId: message.messageId,
      coordinator: message.from,
      goal: structuredClone(message.payload.goal),
      inputRefs: structuredClone(message.payload.inputRefs),
      budget: structuredClone(message.payload.budget),
      requestRecord: record,
      lastOffset: record.sentAtOffset,
      anomalies: [],
    });
  }

  // A registration can survive when the original request record is filtered
  // out by a caller. Keep the board honest by exposing an anomalous placeholder
  // rather than silently dropping a live lane.
  for (const event of scopedEvents) {
    if (event.type !== "lane.registered" || event.payload.kind !== "team") continue;
    const parsed = parseTeamLane(event.laneId);
    if (parsed === undefined) continue;
    const team = byTeam.get(parsed.teamId) ?? new Map<string, DraftBranch>();
    byTeam.set(parsed.teamId, team);
    if (team.has(event.laneId)) continue;
    const placeholder: DraftBranch = {
      teamId: parsed.teamId,
      branchId: parsed.branchId,
      laneId: event.laneId,
      taskId: `${parsed.teamId}:${parsed.branchId}`,
      requestMessageId: "",
      coordinator: "main",
      goal: {
        version: 1,
        statement: "Unknown task request",
        successCriteria: [],
        hardConstraints: [],
      },
      inputRefs: [],
      budget: { maxModelTokens: 1, maxWallClockMs: 1 },
      lastOffset: event.globalOffset,
      anomalies: ["lane.registered has no durable task.request"],
    };
    team.set(event.laneId, placeholder);
    addAnomaly(parsed.teamId, `branch ${parsed.branchId} has no durable task request`);
  }

  const boards: TeamBoard[] = [];
  for (const [teamId, branches] of [...byTeam.entries()].sort(compareTextEntry)) {
    const branchViews = [...branches.values()]
      .sort((left, right) => compareText(left.branchId, right.branchId))
      .map((draft) => finalizeBranch(draft, scopedEvents, inboxRecords, addAnomaly));
    const coordinator = selectCoordinator(branchViews);
    const anomalies = [...(teamAnomalies.get(teamId) ?? [])];
    for (const branch of branchViews) {
      for (const anomaly of branch.anomalies) {
        if (!anomalies.includes(anomaly)) anomalies.push(anomaly);
      }
    }
    const joinPolicy = options.joinPolicy ?? "all-terminal";
    const joinSatisfied = branchViews.length > 0 && branchViews.every((branch) => branch.terminal);
    const status = aggregateStatus(branchViews, joinSatisfied, anomalies);
    boards.push({
      runId: inferRunId(scopedEvents, inboxRecords),
      teamId,
      coordinator,
      joinPolicy,
      status,
      joinSatisfied,
      branches: branchViews,
      anomalies,
      lastOffset: Math.max(
        ...branchViews.map((branch) => branch.lastOffset),
        ...scopedEvents
          .filter((event) => event.runId === inferRunId(scopedEvents, inboxRecords))
          .map((event) => event.globalOffset),
        0,
      ),
    });
  }
  return boards;
}

/** Project one Team, returning undefined when no durable facts identify it. */
export function projectTeamBoard(
  events: readonly AnyEvent[],
  teamId: string,
  options: TeamBoardProjectionOptions = {},
): TeamBoard | undefined {
  return projectTeamBoards(events, options).find((board) => board.teamId === teamId);
}

/** Stable parser shared by restore/status callers; names are host-issued. */
export function parseTeamLane(laneId: string): { teamId: string; branchId: string; laneId: string } | undefined {
  const parts = laneId.split(":");
  if (parts.length !== 3 || parts[0] !== "team" || !parts[1] || !parts[2]) return undefined;
  return { teamId: parts[1], branchId: parts[2], laneId };
}

interface DraftBranch {
  teamId: string;
  branchId: string;
  laneId: string;
  taskId: string;
  requestMessageId: string;
  coordinator: string;
  goal: Goal;
  inputRefs: ArtifactRef[];
  budget: TaskBudget;
  requestRecord?: InboxRecord;
  lastOffset: number;
  anomalies: string[];
}

function finalizeBranch(
  draft: DraftBranch,
  events: readonly AnyEvent[],
  records: readonly InboxRecord[],
  addTeamAnomaly: (teamId: string, message: string) => void,
): TeamBoardBranch {
  const laneEvents = events
    .filter((event) => event.runId === inferRunId(events, records) && event.laneId === draft.laneId)
    .sort((left, right) => left.globalOffset - right.globalOffset);
  const registration = laneEvents.find((event) => event.type === "lane.registered");
  const statuses = laneEvents.filter((event): event is Extract<AnyEvent, { type: "lane.status" }> => event.type === "lane.status");
  const latestStatus = statuses.at(-1);
  const replies = records
    .filter((record) => (
      record.message.runId === inferRunId(events, records)
      && record.message.from === draft.laneId
      && record.message.to === draft.coordinator
      && (draft.requestMessageId === "" || record.message.parentId === draft.requestMessageId)
      && (
        record.message.payload.type === "task.accept"
        || record.message.payload.type === "task.result"
        || record.message.payload.type === "task.failed"
      )
    ))
    .sort((left, right) => left.sentAtOffset - right.sentAtOffset);
  const accepts = replies.filter((record) => record.message.payload.type === "task.accept");
  const terminals = replies.filter((record) => (
    record.message.payload.type === "task.result"
      || record.message.payload.type === "task.failed"
  ));
  const latestTerminal = terminals.at(-1);
  const terminalPayload = latestTerminal?.message.payload;
  if (terminals.length > 1) {
    const terminalIds = terminals.map((record) => record.message.messageId);
    draft.anomalies.push(`multiple terminal replies: ${terminalIds.join(", ")}`);
    addTeamAnomaly(draft.teamId, `branch ${draft.branchId} published multiple terminal replies`);
  }
  const requestRecord = draft.requestRecord;
  const latestClaim = requestRecord?.claim;
  const laneStatus = latestStatus?.payload.status;
  const terminal = terminalPayload?.type === "task.result"
    || terminalPayload?.type === "task.failed"
    || laneStatus === "completed"
    || laneStatus === "failed"
    || laneStatus === "cancelled";
  const status = deriveBranchStatus(
    terminalPayload?.type === "task.result"
      ? "completed"
      : terminalPayload?.type === "task.failed"
        ? "failed"
        : undefined,
    requestRecord?.status,
    latestClaim !== undefined,
    terminal,
    laneStatus,
  );
  const lastOffset = Math.max(
    draft.lastOffset,
    ...laneEvents.map((event) => event.globalOffset),
    ...replies.map((record) => record.sentAtOffset),
    0,
  );
  const result = terminalPayload?.type === "task.result" ? structuredClone(terminalPayload) : undefined;
  const failure = terminalPayload?.type === "task.failed" ? structuredClone(terminalPayload) : undefined;
  const anomalies = [...draft.anomalies];
  if (draft.requestMessageId === "") anomalies.push("task request is missing");
  if (registration === undefined) anomalies.push("branch lane registration is missing");
  if (latestStatus !== undefined && latestStatus.payload.status === "completed" && result === undefined) {
    anomalies.push("lane is completed without a task.result reply");
  }
  return {
    teamId: draft.teamId,
    branchId: draft.branchId,
    laneId: draft.laneId,
    taskId: draft.taskId,
    requestMessageId: draft.requestMessageId,
    coordinator: draft.coordinator,
    goal: structuredClone(draft.goal),
    inputRefs: structuredClone(draft.inputRefs),
    budget: structuredClone(draft.budget),
    registered: registration !== undefined,
    ...(laneStatus === undefined ? {} : { laneStatus }),
    status,
    terminal,
    attempt: latestClaim?.attempt ?? 0,
    ...(latestClaim === undefined ? {} : { lease: structuredClone(latestClaim) }),
    ...(accepts.at(-1) === undefined ? {} : { acceptedMessageId: accepts.at(-1)!.message.messageId }),
    ...(result === undefined ? {} : { result }),
    ...(failure === undefined ? {} : { failure }),
    lastOffset,
    anomalies,
  };
}

function deriveBranchStatus(
  terminalKind: "completed" | "failed" | undefined,
  requestStatus: InboxRecord["status"] | undefined,
  hasClaim: boolean,
  terminal: boolean,
  laneStatus?: LaneStatus,
): TeamBoardBranchStatus {
  if (terminalKind === "completed" || laneStatus === "completed") return "completed";
  if (terminalKind === "failed" || laneStatus === "failed") return "failed";
  if (laneStatus === "cancelled") return "cancelled";
  if (laneStatus === "running") return "running";
  if (terminal) return "unknown";
  if (requestStatus === "claimed" || hasClaim) return "claimed";
  return "queued";
}

function aggregateStatus(
  branches: readonly TeamBoardBranch[],
  joinSatisfied: boolean,
  anomalies: readonly string[],
): TeamBoardStatus {
  if (branches.length === 0) return "unknown";
  if (joinSatisfied) {
    if (branches.every((branch) => branch.status === "cancelled")) return "cancelled";
    if (branches.some((branch) => branch.status === "failed")) return "failed";
    return "completed";
  }
  if (branches.every((branch) => branch.status === "queued")) return "queued";
  if (branches.some((branch) => branch.status === "unknown")) return "unknown";
  return "running";
}

function selectCoordinator(branches: readonly TeamBoardBranch[]): LaneId {
  return branches.find((branch) => branch.coordinator.length > 0)?.coordinator ?? "main";
}

function normalizeInboxRecords(
  events: readonly AnyEvent[],
  input: InboxProjection | readonly InboxRecord[] | undefined,
): InboxRecord[] {
  if (input === undefined) return projectInbox(events).records;
  if ("records" in input) {
    return input.records.map((record) => structuredClone(record));
  }
  return [...input].map((record) => structuredClone(record));
}

function inferRunId(events: readonly AnyEvent[], records: readonly InboxRecord[]): RunId {
  return events[0]?.runId ?? records[0]?.message.runId ?? "unknown-run";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareTextEntry(left: readonly [string, unknown], right: readonly [string, unknown]): number {
  return compareText(left[0], right[0]);
}
