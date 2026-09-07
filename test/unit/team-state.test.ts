import { describe, expect, it } from "vitest";

import type { A2AMessage, TaskResult } from "../../src/domain/types.js";
import type { AnyEvent, EventPayloadMap, EventType } from "../../src/domain/events.js";
import type { TeamDefinition, TeamMemberSettlement } from "../../src/domain/team.js";
import { projectInbox } from "../../src/a2a/index.js";
import { projectTeamBoard, projectTeamBoards } from "../../src/runtime/team-board.js";

const start = "2026-09-07T00:00:00.000Z";
const deadline = "2026-09-07T00:01:00.000Z";

function scenario(runId = "run-team", memberCount = 1) {
  const definition: TeamDefinition = {
    teamId: "alpha", leadLaneId: "main", joinPolicy: "all-terminal",
    peerMessaging: "team-members", deadline, fingerprint: "definition-alpha",
    members: Array.from({ length: memberCount }, (_, index) => ({
      memberId: `member-${index}`, laneId: `team:alpha:member-${index}`,
      dependsOn: [], required: true,
      task: {
        type: "task.request", taskId: `alpha:member-${index}`,
        goal: { version: 1, statement: `Inspect area ${index}`, successCriteria: ["Cite evidence"], hardConstraints: [] },
        inputRefs: [], budget: { maxModelTokens: 100, maxWallClockMs: 60_000, deadline },
      },
    })),
  };
  const events: AnyEvent[] = [];
  function append<K extends EventType>(
    type: K,
    payload: EventPayloadMap[K],
    laneId = "main",
    occurredAt = start,
    idempotencyKey = `event-${events.length + 1}`,
  ) {
    const offset = events.length + 1;
    const event = {
      eventId: `${runId}-${offset}`, runId, laneId, type, payload: structuredClone(payload),
      occurredAt, idempotencyKey, globalOffset: offset, laneSeq: offset,
      schemaVersion: 1, visibility: "run", correlationId: "team-alpha", contentHash: "",
    } as AnyEvent;
    events.push(event);
    return event;
  }
  function request(index = 0): A2AMessage {
    const member = definition.members[index]!;
    const message: A2AMessage = {
      messageId: `request-${index}`, runId, conversationId: runId, threadId: "team-alpha",
      from: "main", to: member.laneId, createdAt: start, correlationId: "team-alpha",
      idempotencyKey: `request-${index}`, visibility: "run", priority: 1, delivery: "next-step",
      payload: structuredClone(member.task),
    };
    append("message.sent", { message });
    return message;
  }
  function claim(index = 0, claimId = "claim-1") {
    const member = definition.members[index]!;
    append("message.claimed", { messageId: `request-${index}`, claimedBy: member.laneId },
      member.laneId, start, `a2a:claim:${claimId}:request-${index}:${member.laneId}`);
  }
  function result(index = 0, status: TaskResult["status"] = "completed"): TaskResult {
    return {
      type: "task.result", taskId: definition.members[index]!.task.taskId, status,
      summary: status === "partial" ? "Evidence remains incomplete" : "Evidence checked",
      evidenceRefs: [], artifactRefs: [], openQuestions: [],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    };
  }
  function settle(index = 0, patch: Partial<TeamMemberSettlement> = {}) {
    append("team.member.settled", {
      teamId: "alpha", memberId: definition.members[index]!.memberId,
      taskId: definition.members[index]!.task.taskId, outcome: "succeeded",
      requestMessageId: `request-${index}`, result: result(index), claimId: "claim-1", attempt: 1,
      ...patch,
    });
  }
  const board = () => projectTeamBoard(events, "alpha", { runId })!;
  function join(reason: "all-terminal" | "deadline-best-effort" = "all-terminal", occurredAt = start) {
    append("team.joined", {
      teamId: "alpha", reason,
      memberOutcomes: board().members.filter((member) => member.outcome !== undefined)
        .map((member) => ({ memberId: member.memberId, taskId: member.taskId, outcome: member.outcome! })),
    }, "main", occurredAt);
  }
  return { definition, events, append, request, claim, result, settle, board, join };
}

describe("durable Team state", () => {
  it("reconstructs every admitted member when a crash prevents dispatch", () => {
    const s = scenario("run-team", 2);
    s.definition.members[1]!.dependsOn = ["member-0"];
    s.definition.members[1]!.required = false;
    s.append("team.created", s.definition);
    const board = s.board();
    expect(board).toMatchObject({ joinReady: false, joinSatisfied: false, joinState: "waiting", status: "queued" });
    expect(board.members).toHaveLength(2);
    expect(board.branches).toBe(board.members);
    expect(board.members[1]).toMatchObject({
      memberId: "member-1", branchId: "member-1", required: false,
      dependsOn: ["member-0"], registered: false, execution: "queued", terminal: false,
    });
    expect(board.definition).toEqual(s.definition);
    expect(board.definition).not.toBe(s.definition);
  });

  it("does not infer task success or join from an ended lane or a transport reply", () => {
    const s = scenario();
    s.append("team.created", s.definition);
    const request = s.request();
    s.append("lane.status", { status: "completed" }, request.to);
    s.append("message.sent", { message: {
      ...request, messageId: "reply-1", idempotencyKey: "reply-1", from: request.to, to: "main",
      parentId: request.messageId, payload: s.result(),
    } }, request.to);
    expect(s.board().members[0]).toMatchObject({ execution: "terminal", terminal: false, status: "unknown" });
    expect(s.board().members[0]?.outcome).toBeUndefined();
    expect(s.board().anomalies).toContain("lane is terminal without a valid task settlement");
    expect(s.board().joinSatisfied).toBe(false);
  });

  it("preserves partial outcome without a result notification and requires a separate join commit", () => {
    const s = scenario();
    s.append("team.created", s.definition);
    s.request(); s.claim();
    s.settle(0, { outcome: "partial", result: s.result(0, "partial") });
    expect(s.board()).toMatchObject({ joinReady: true, joinSatisfied: false, joinState: "waiting" });
    expect(s.board().members[0]).toMatchObject({ execution: "terminal", terminal: true, outcome: "partial", status: "partial" });
    s.join();
    expect(s.board()).toMatchObject({ joinSatisfied: true, joinState: "joined", status: "partial" });
  });

  it("does not retroactively validate a premature joined event", () => {
    const s = scenario();
    s.append("team.created", s.definition);
    s.request(); s.claim(); s.join(); s.settle();
    expect(s.board()).toMatchObject({ joinReady: true, joinSatisfied: false });
    s.join();
    expect(s.board().joinSatisfied).toBe(true);
  });

  it("ignores optional unfinished members for all-terminal readiness", () => {
    const s = scenario("run-team", 2);
    s.definition.members[1]!.required = false;
    s.append("team.created", s.definition);
    s.request(); s.claim(); s.settle(); s.join();
    expect(s.board()).toMatchObject({ joinReady: true, joinSatisfied: true });
    expect(s.board().members[1]?.terminal).toBe(false);
  });

  it("uses persisted deadline policy and requires explicit outcomes at the deadline", () => {
    const s = scenario("run-team", 2);
    s.definition.joinPolicy = "deadline-best-effort";
    s.append("team.created", s.definition);
    s.request(); s.claim(); s.settle();
    s.join("deadline-best-effort", deadline);
    expect(s.board().joinSatisfied).toBe(false);
    s.append("team.member.settled", {
      teamId: "alpha", memberId: "member-1", taskId: "alpha:member-1", outcome: "abandoned", reason: "Deadline reached",
    }, "main", deadline);
    s.join("deadline-best-effort");
    expect(s.board().joinSatisfied).toBe(false);
    s.join("deadline-best-effort", deadline);
    const board = projectTeamBoard(s.events, "alpha", { joinPolicy: "all-terminal" })!;
    expect(board).toMatchObject({ joinPolicy: "deadline-best-effort", joinSatisfied: true, joinState: "deadline-settled" });
  });

  it("rejects stale leases and retains the first valid settlement across a later receipt claim", () => {
    const s = scenario();
    s.append("team.created", s.definition);
    s.request(); s.claim(); s.claim(0, "claim-2"); s.settle();
    expect(s.board().members[0]?.terminal).toBe(false);
    s.settle(0, { claimId: "claim-2", attempt: 2, outcome: "partial", result: s.result(0, "partial") });
    s.claim(0, "claim-3");
    s.settle(0, { claimId: "claim-3", attempt: 3 });
    expect(s.board().members[0]).toMatchObject({ outcome: "partial", attempt: 3 });
    expect(s.board().anomalies).toContain("member settlement has a stale or missing claim");
    expect(s.board().anomalies).toContain("duplicate or conflicting member settlement ignored");
  });

  it.each(["sender", "task", "parent", "outcome", "missing-claim"] as const)("rejects a settlement with mismatched %s", (kind) => {
    const s = scenario();
    s.append("team.created", s.definition);
    s.request(); s.claim();
    s.append("team.member.settled", {
      teamId: "alpha", memberId: "member-0", taskId: kind === "task" ? "foreign-task" : "alpha:member-0",
      outcome: kind === "outcome" ? "partial" : "succeeded", result: s.result(),
      requestMessageId: kind === "parent" ? "foreign-request" : "request-0",
      ...(kind === "missing-claim" ? {} : { claimId: "claim-1", attempt: 1 }),
    }, kind === "sender" ? "team:alpha:outsider" : "main");
    expect(s.board().members[0]?.terminal).toBe(false);
    expect(s.board().joinReady).toBe(false);
  });

  it("fences late results after cancellation and does not treat cancellation request as completed cleanup", () => {
    const s = scenario();
    s.append("team.created", s.definition);
    const request = s.request(); s.claim();
    s.append("team.cancel.requested", { teamId: "alpha", reason: "Stopped", requestedBy: "main" });
    s.settle();
    s.append("team.cancelled", { teamId: "alpha", reason: "Stopped" });
    expect(s.board()).toMatchObject({ cancellationRequested: true, joinSatisfied: false, joinState: "waiting" });
    expect(s.board().members[0]?.terminal).toBe(false);
    s.append("team.member.settled", {
      teamId: "alpha", memberId: "member-0", taskId: "alpha:member-0", outcome: "cancelled", reason: "Stopped",
    });
    s.append("team.cancelled", { teamId: "alpha", reason: "Stopped" });
    s.append("message.sent", { message: {
      ...request, messageId: "late-reply", idempotencyKey: "late-reply", from: request.to, to: "main",
      parentId: request.messageId, payload: s.result(),
    } }, request.to);
    expect(s.board()).toMatchObject({ joinState: "cancelled", status: "cancelled", joinReady: false });
    expect(s.board().members[0]?.outcome).toBe("cancelled");
    expect(s.board().anomalies).toContain("late terminal reply late-reply after Team cancellation ignored");
  });

  it("keeps outcomes committed before cancellation and rejects peer lifecycle writes", () => {
    const s = scenario();
    s.append("team.created", s.definition);
    s.request(); s.claim(); s.settle();
    s.append("team.cancel.requested", { teamId: "alpha", reason: "Peer stop", requestedBy: "main" }, "team:alpha:member-0");
    expect(s.board().cancellationRequested).toBe(false);
    s.append("team.cancel.requested", { teamId: "alpha", reason: "Stopped", requestedBy: "main" });
    s.append("team.member.settled", { teamId: "alpha", memberId: "member-0", taskId: "alpha:member-0", outcome: "cancelled" });
    s.append("team.cancelled", { teamId: "alpha", reason: "Stopped" });
    expect(s.board().members[0]?.outcome).toBe("succeeded");
    expect(s.board().joinState).toBe("cancelled");
  });

  it("separates optional reduction and Main presentation from member collection", () => {
    const s = scenario();
    s.append("team.created", s.definition);
    s.request(); s.claim(); s.settle(); s.join();
    expect(s.board()).toMatchObject({ reductionState: "not-started", presentationState: "pending" });
    const reducer = {
      ...s.definition.members[0]!, memberId: "reducer", laneId: "team-reducer:alpha",
      task: { ...s.definition.members[0]!.task, taskId: "alpha:reduce" },
    };
    s.append("team.reduction.requested", { teamId: "alpha", reducer });
    s.append("lane.registered", { kind: "worker" }, reducer.laneId);
    expect(s.board()).toMatchObject({ reductionState: "running", presentationState: "pending", reducer });
    expect(s.board().members).toHaveLength(1);
    s.append("team.presented", { teamId: "alpha", disposition: "accepted" });
    expect(s.board().presentationState).toBe("pending");
    s.append("team.reduced", { teamId: "alpha", outcome: "partial", result: { ...s.result(0, "partial"), taskId: reducer.task.taskId } });
    expect(s.board()).toMatchObject({ reductionState: "completed", reduction: { outcome: "partial" }, presentationState: "pending" });
    s.append("team.presented", { teamId: "alpha", disposition: "accepted" });
    expect(s.board().presentationState).toBe("accepted");
  });

  it("isolates identical Team and message identities in shared Run streams and snapshots", () => {
    const first = scenario("run-first");
    const second = scenario("run-second");
    for (const s of [first, second]) {
      s.append("team.created", s.definition); s.request(); s.claim();
    }
    first.settle(); first.join();
    const records = [...projectInbox(first.events).records, ...projectInbox(second.events).records];
    const events = [...first.events, ...second.events];
    const boards = projectTeamBoards(events, { inbox: records });
    expect(boards.map((board) => [board.runId, board.joinSatisfied])).toEqual([["run-first", true], ["run-second", false]]);
    expect(projectTeamBoards(events, { runId: "run-second", inbox: records })).toMatchObject([{ runId: "run-second", joinSatisfied: false }]);
    expect(projectTeamBoards(events)).toHaveLength(2);
  });
});
