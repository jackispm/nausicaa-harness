import type { LaneId, TaskFailed, TaskRequest, TaskResult } from "./types.js";

export type TeamJoinPolicy = "all-terminal" | "deadline-best-effort";
export type TeamMemberOutcome = "succeeded" | "partial" | "failed" | "cancelled" | "abandoned";
export type TeamMemberExecution = "queued" | "claimed" | "running" | "terminal";
export type TeamJoinState = "waiting" | "joined" | "deadline-settled" | "cancelled";

export interface TeamMemberDefinition {
  memberId: string;
  laneId: LaneId;
  task: TaskRequest;
  dependsOn: string[];
  required: boolean;
}

/** The immutable admission record exists before any member is dispatched. */
export interface TeamDefinition {
  teamId: string;
  leadLaneId: LaneId;
  joinPolicy: TeamJoinPolicy;
  peerMessaging: "team-members" | "lead-only";
  deadline: string;
  fingerprint: string;
  members: TeamMemberDefinition[];
}

export interface TeamMemberSettlement {
  teamId: string;
  memberId: string;
  taskId: string;
  outcome: TeamMemberOutcome;
  requestMessageId?: string;
  result?: TaskResult;
  failure?: TaskFailed;
  reason?: string;
  claimId?: string;
  attempt?: number;
}

export interface TeamJoined {
  teamId: string;
  reason: TeamJoinPolicy;
  memberOutcomes: {
    memberId: string;
    taskId: string;
    outcome: TeamMemberOutcome;
  }[];
}

export interface TeamReduction {
  outcome: TeamMemberOutcome;
  result?: TaskResult;
  failure?: TaskFailed;
}
