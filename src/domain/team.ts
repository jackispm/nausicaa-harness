import type { ArtifactRef, LaneId, TaskFailed, TaskRequest, TaskResult } from "./types.js";

export type TeamJoinPolicy = "all-terminal" | "deadline-best-effort";
export type TeamMemberOutcome = "succeeded" | "partial" | "failed" | "cancelled" | "abandoned";
export type TeamMemberExecution = "queued" | "claimed" | "running" | "terminal";
export type TeamJoinState = "waiting" | "joined" | "deadline-settled" | "cancelled";

/** Host-enforced capability narrowing for one Team member. */
export interface TeamCapabilityGrant {
  /** Omit to inherit every capability available to the creating lane. */
  tools?: string[];
  /** Omit to inherit the creating lane's nested-Team permission. */
  allowNestedTeam?: boolean;
}

export interface TeamMemberDefinition {
  memberId: string;
  laneId: LaneId;
  task: TaskRequest;
  dependsOn: string[];
  required: boolean;
  capabilities?: TeamCapabilityGrant;
}

/** The immutable admission record exists before any member is dispatched. */
export interface TeamDefinition {
  teamId: string;
  leadLaneId: LaneId;
  joinPolicy: TeamJoinPolicy;
  peerMessaging: "team-members" | "lead-only";
  /** Optional deadline retained for explicitly bounded host/legacy Teams. */
  deadline?: string;
  fingerprint: string;
  members: TeamMemberDefinition[];
}

/** Append-only membership admission; the original Team definition stays immutable. */
export interface TeamMemberAddition {
  teamId: string;
  member: TeamMemberDefinition;
  addedBy: LaneId;
  operationId: string;
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

/** A durable task assigned to an already admitted Team member. */
export interface TeamTaskAssignment {
  teamId: string;
  taskId: string;
  memberId: string;
  laneId: LaneId;
  assignmentVersion: number;
  task: TaskRequest;
  assignedBy: LaneId;
  operationId: string;
}

export type TeamRunReportKind = "checkpoint" | "ready-for-review" | "blocked" | "failed";

/** Compact host-produced handoff at a resident member Run boundary. */
export interface TeamRunReport {
  teamId: string;
  taskId: string;
  laneId: LaneId;
  /** Zero identifies the member's initial task; follow-up versions start at one. */
  assignmentVersion: number;
  kind: TeamRunReportKind;
  summary: string;
  artifactRefs: ArtifactRef[];
  openQuestions: string[];
  result?: TaskResult;
  failure?: TaskFailed;
}
