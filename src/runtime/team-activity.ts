import type { AnyEvent } from "../domain/events.js";
import type { TeamMemberDefinition } from "../domain/team.js";

export type TeamActivityPhase = "queued" | "context" | "model" | "tools" | "waiting"
  | "working" | "idle" | "reported" | "blocked" | "failed" | "cancelling" | "cancelled";

export interface TeamMemberActivity {
  teamId: string;
  memberId: string;
  laneId: string;
  taskId: string;
  phase: TeamActivityPhase;
  lastActivityAt: string;
  tools: string[];
  completedTools: number;
}

export interface TeamActivitySnapshot {
  members: TeamMemberActivity[];
}

/** Metadata projection only: no conversation bodies, tool arguments or model calls. */
export function projectTeamActivity(events: readonly AnyEvent[], runId: string): TeamActivitySnapshot {
  const teams = new Map<string, { lead: string; closed: boolean; cancelling: boolean; cancelled: boolean }>();
  const reducers = new Map<string, string>();
  const members = new Map<string, TeamMemberActivity>();
  const pending = new Map<string, Map<string, string>>();
  const finished = new Map<string, Set<string>>();
  const unresolved = new Map<string, Set<string>>();
  const settled = new Set<string>();
  const assignments = new Map<string, number>();
  const add = (teamId: string, member: TeamMemberDefinition, at: string): void => {
    if (members.has(member.laneId)) return;
    members.set(member.laneId, {
      teamId, memberId: member.memberId, laneId: member.laneId,
      taskId: member.task.taskId, phase: "queued", lastActivityAt: at,
      tools: [], completedTools: 0,
    });
    pending.set(member.laneId, new Map());
    finished.set(member.laneId, new Set());
    unresolved.set(member.laneId, new Set());
    assignments.set(member.laneId, 0);
  };
  for (const event of [...events].sort((a, b) => a.globalOffset - b.globalOffset)) {
    if (event.runId !== runId || (event.visibility !== "run" && event.visibility !== "user")) continue;
    if (event.type === "team.created") {
      if (event.laneId !== event.payload.leadLaneId || teams.has(event.payload.teamId)) continue;
      teams.set(event.payload.teamId, { lead: event.laneId, closed: false, cancelling: false, cancelled: false });
      for (const member of event.payload.members) add(event.payload.teamId, member, event.occurredAt);
      continue;
    }
    if (event.type === "team.member.added") {
      const team = teams.get(event.payload.teamId);
      if (team?.lead === event.laneId && !team.closed && !team.cancelling && !team.cancelled) {
        add(event.payload.teamId, event.payload.member, event.occurredAt);
      }
      continue;
    }
    if (event.type === "team.reduction.requested") {
      const team = teams.get(event.payload.teamId);
      if (team?.lead === event.laneId && !team.closed && !team.cancelling && !team.cancelled) {
        add(event.payload.teamId, event.payload.reducer, event.occurredAt);
        reducers.set(event.payload.teamId, event.payload.reducer.laneId);
      }
      continue;
    }
    if (event.type === "team.closed" || event.type === "team.cancelled" || event.type === "team.cancel.requested") {
      const team = teams.get(event.payload.teamId);
      if (team?.lead !== event.laneId) continue;
      if (event.type === "team.closed") team.closed = true;
      else {
        team.cancelling = true;
        team.cancelled = event.type === "team.cancelled";
        for (const member of members.values()) {
          if (member.teamId !== event.payload.teamId || settled.has(member.laneId)) continue;
          member.phase = team.cancelled ? "cancelled" : "cancelling";
          if (team.cancelled) member.tools = [];
          member.lastActivityAt = event.occurredAt;
        }
      }
      continue;
    }
    const member = event.type === "team.task.assigned" || event.type === "team.run.reported"
      ? members.get(event.payload.laneId)
      : event.type === "team.member.settled"
        ? [...members.values()].find((m) => m.teamId === event.payload.teamId && m.memberId === event.payload.memberId)
        : event.type === "team.reduced" ? members.get(reducers.get(event.payload.teamId) ?? "")
        : members.get(event.laneId);
    if (member === undefined) continue;
    const team = teams.get(member.teamId)!;
    if (team.closed || team.cancelled) continue;
    if (event.type === "team.task.assigned") {
      if (event.laneId !== team.lead || event.payload.teamId !== member.teamId || team.cancelling
        || event.payload.memberId !== member.memberId
        || event.payload.assignmentVersion <= assignments.get(member.laneId)!) continue;
      member.taskId = event.payload.taskId;
      member.phase = "queued";
      member.completedTools = 0;
      member.tools = [];
      pending.get(member.laneId)!.clear();
      finished.get(member.laneId)!.clear();
      unresolved.get(member.laneId)!.clear();
      settled.delete(member.laneId);
      assignments.set(member.laneId, event.payload.assignmentVersion);
    } else if (event.type === "team.run.reported") {
      if (event.laneId !== member.laneId || event.payload.taskId !== member.taskId
        || event.payload.teamId !== member.teamId
        || event.payload.assignmentVersion !== assignments.get(member.laneId)) continue;
      member.phase = event.payload.kind === "failed" ? "failed"
        : event.payload.kind === "blocked" ? "blocked" : "reported";
      member.tools = [];
      settled.add(member.laneId);
    } else if (event.type === "team.member.settled" || event.type === "team.reduced") {
      if (event.laneId !== team.lead
        || (event.type === "team.member.settled" && event.payload.taskId !== member.taskId)) continue;
      member.phase = event.payload.outcome === "cancelled" || event.payload.outcome === "abandoned" ? "cancelled"
        : event.payload.outcome === "failed" ? "failed" : "reported";
      member.tools = [];
      settled.add(member.laneId);
    } else {
      if (settled.has(member.laneId)) continue;
      const tools = pending.get(member.laneId)!;
      switch (event.type) {
        case "step.started": member.phase = "context"; break;
        case "model.requested":
        case "model.retrying": member.phase = "model"; break;
        case "model.completed": member.phase = "working"; break;
        case "tool.requested":
        case "tool.started":
          tools.set(event.payload.operationId, event.payload.name);
          member.phase = [...tools.values()].every((name) => name === "task_wait") ? "waiting" : "tools";
          member.tools = [...new Set(tools.values())].slice(0, 4);
          break;
        case "tool.succeeded":
        case "tool.failed":
        case "tool.unknown": {
          tools.delete(event.payload.operationId);
          if (event.type === "tool.unknown") unresolved.get(member.laneId)!.add(event.payload.operationId);
          else {
            unresolved.get(member.laneId)!.delete(event.payload.operationId);
            finished.get(member.laneId)!.add(event.payload.operationId);
          }
          member.completedTools = finished.get(member.laneId)!.size;
          member.tools = [...new Set(tools.values())].slice(0, 4);
          member.phase = event.type === "tool.unknown" ? "blocked"
            : tools.size === 0 ? "working"
              : [...tools.values()].every((name) => name === "task_wait") ? "waiting" : "tools";
          break;
        }
        case "lane.status":
          if (event.payload.status === "failed") member.phase = "failed";
          else if (event.payload.status === "cancelled") member.phase = "cancelled";
          else if (event.payload.status === "waiting") member.phase = "waiting";
          else if (event.payload.status === "ready") member.phase = "queued";
          else if (event.payload.status === "completed" || event.payload.status === "dormant") member.phase = "idle";
          else member.phase = "working";
          break;
        default: continue;
      }
      if (unresolved.get(member.laneId)!.size > 0) member.phase = "blocked";
      if (team.cancelling) member.phase = "cancelling";
    }
    member.lastActivityAt = event.occurredAt;
  }
  return { members: [...members.values()].filter((member) => !teams.get(member.teamId)!.closed) };
}
