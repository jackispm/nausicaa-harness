import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import type { AnyEvent, EventPayloadMap, EventType } from "../../src/domain/events.js";
import type { TeamMemberDefinition } from "../../src/domain/team.js";
import { TeamActivityPanel, AgentMessageBlock, agentMessagePresentationFromTranscript } from "../../src/cli/tui-components.js";
import { projectTeamActivity } from "../../src/runtime/team-activity.js";
import { projectSessionLaneMessage, projectSessionTranscript } from "../../src/runtime/session-artifacts.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

const runId = "activity-run";
const at = "2026-09-11T00:00:00.000Z";
const lane = "team:flight:physics";
const ref = { id: "sha256:x", contentHash: "sha256:x", byteLength: 0, mediaType: "application/json" };
const member: TeamMemberDefinition = {
  memberId: "physics", laneId: lane, required: true, dependsOn: [],
  task: { type: "task.request", taskId: "flight:physics", inputRefs: [], budget: {},
    goal: { version: 1, statement: "Improve the aircraft", successCriteria: [], hardConstraints: [] } },
};

function fact<T extends EventType>(type: T, payload: EventPayloadMap[T], n: number, laneId = lane): AnyEvent {
  return { type, payload, runId, laneId, eventId: `event-${n}`, globalOffset: n, laneSeq: n,
    schemaVersion: 1, occurredAt: at, correlationId: "activity", idempotencyKey: `event-${n}`,
    contentHash: "sha256:event", visibility: "run" } as AnyEvent;
}
const created = fact("team.created", {
  teamId: "flight", leadLaneId: "main", joinPolicy: "all-terminal", peerMessaging: "team-members",
  fingerprint: "fingerprint", members: [member],
}, 1, "main");

describe("Team activity presentation", () => {
  it("shows a model request, concurrent tools, waiting and durable report without exposing conversation text", () => {
    const events = [created, fact("step.started", { step: 1 }, 2)];
    expect(projectTeamActivity(events, runId).members[0]?.phase).toBe("context");
    events.push(fact("model.requested", { model: "test", requestHash: "x", contextWatermark: 2 }, 3));
    expect(projectTeamActivity(events, runId).members[0]?.phase).toBe("model");
    events.push(fact("tool.started", { name: "edit", operationId: "edit", toolCallId: "edit", argumentsHash: "x" }, 4));
    events.push(fact("tool.started", { name: "task_wait", operationId: "wait", toolCallId: "wait", argumentsHash: "x" }, 5));
    expect(projectTeamActivity(events, runId).members[0]).toMatchObject({ phase: "tools", tools: ["edit", "task_wait"] });
    const succeeded = fact("tool.succeeded", { name: "edit", operationId: "edit", toolCallId: "edit", resultRef: ref }, 6);
    events.push(succeeded, succeeded);
    expect(projectTeamActivity(events, runId).members[0]).toMatchObject({ phase: "waiting", completedTools: 1, tools: ["task_wait"] });
    events.push(fact("team.run.reported", { teamId: "flight", taskId: "flight:physics", laneId: lane,
      assignmentVersion: 0, kind: "ready-for-review", summary: "PRIVATE_RAW_BODY", artifactRefs: [], openQuestions: [],
      reportId: "report-1", runId }, 7));
    events.push(fact("lane.status", { status: "completed" }, 8));
    const snapshot = projectTeamActivity(events, runId);
    expect(snapshot.members[0]).toMatchObject({ phase: "reported", tools: [], completedTools: 1 });
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_RAW_BODY");
  });

  it("recovers assignments, ignores stale results and keeps cancelled or closed members from looking busy", () => {
    const assignment = { ...member.task, taskId: "repair-2" };
    const events = [created, fact("team.task.assigned", {
      teamId: "flight", taskId: "repair-2", memberId: "physics", laneId: lane, assignmentVersion: 1,
      task: assignment, assignedBy: "main", operationId: "assign",
    }, 2, "main"), fact("team.member.settled", {
      teamId: "flight", memberId: "physics", taskId: "flight:physics", outcome: "succeeded",
    }, 3, "main")];
    expect(projectTeamActivity(events.reverse(), runId).members[0]).toMatchObject({ phase: "queued", taskId: "repair-2" });
    events.push(fact("team.cancel.requested", { teamId: "flight", reason: "stop", requestedBy: "main" }, 4, "main"));
    events.push(fact("step.started", { step: 2 }, 5));
    expect(projectTeamActivity(events, runId).members[0]?.phase).toBe("cancelling");
    events.push(fact("team.cancelled", { teamId: "flight", reason: "stop" }, 6, "main"));
    expect(projectTeamActivity(events, runId).members[0]?.phase).toBe("cancelled");
    events.push(fact("team.closed", { teamId: "flight", reason: "done", closedBy: "main" }, 7, "main"));
    expect(projectTeamActivity(events, runId).members).toEqual([]);
    expect(projectTeamActivity(events, "other-run").members).toEqual([]);
  });

  it("never creates placeholder members from unrelated lane events or private events", () => {
    expect(projectTeamActivity([fact("lane.status", { status: "running" }, 1)], runId).members).toEqual([]);
    const hidden = { ...fact("step.started", { step: 1 }, 2), visibility: "lane" } as AnyEvent;
    expect(projectTeamActivity([created, hidden], runId).members[0]?.phase).toBe("queued");
  });

  it("keeps uncertain tool outcomes blocked until resolved and requires a report for report-ready", () => {
    const tool = { name: "edit", operationId: "edit", toolCallId: "edit" };
    const events = [created, fact("tool.unknown", { ...tool, reason: "interrupted" }, 2),
      fact("lane.status", { status: "dormant" }, 3)];
    expect(projectTeamActivity(events, runId).members[0]).toMatchObject({ phase: "blocked", completedTools: 0 });
    events.push(fact("tool.failed", { ...tool, error: "resolved", resultRef: ref }, 4));
    expect(projectTeamActivity(events, runId).members[0]).toMatchObject({ phase: "working", completedTools: 1 });
    events.push(fact("lane.status", { status: "completed" }, 5));
    expect(projectTeamActivity(events, runId).members[0]?.phase).toBe("idle");
  });

  it("shows an admitted reducer while its settled members are waiting for synthesis", () => {
    const reducer = { ...member, memberId: "synthesizer", laneId: "team-reducer:flight:synthesizer",
      task: { ...member.task, taskId: "flight:synthesis" } };
    const events = [created, fact("team.reduction.requested", { teamId: "flight", reducer }, 2, "main"),
      fact("model.requested", { model: "test", requestHash: "x", contextWatermark: 2 }, 3, reducer.laneId)];
    expect(projectTeamActivity(events, runId).members[1]).toMatchObject({ memberId: "synthesizer", phase: "model" });
    events.push(fact("team.reduced", { teamId: "flight", outcome: "failed" }, 4, "main"));
    expect(projectTeamActivity(events, runId).members[1]?.phase).toBe("failed");
  });

  it("bounds the dock, sanitizes labels and shows elapsed inactivity without inventing progress", () => {
    const snapshot = projectTeamActivity([created, fact("model.requested", { model: "test", requestHash: "x", contextWatermark: 1 }, 2)], runId);
    snapshot.members.push(...Array.from({ length: 5 }, (_, i) => ({ ...snapshot.members[0]!, memberId: `worker-${i}` })));
    snapshot.members[0]!.memberId = "physics\x1b]52;c;secret\x07";
    const panel = new TeamActivityPanel(() => snapshot, () => Date.parse(at) + 125_000, () => 2);
    const lines = panel.render(160);
    const text = stripTerminalSequences(lines.join("\n"));
    expect(lines).toHaveLength(4);
    expect(text).toContain("waiting for model");
    expect(text).toContain("2m 5s since activity");
    expect(text).toContain("+ 4 members");
    expect(lines.join("\n")).not.toContain("\x1b]52");
    expect(panel.render(24).every((line) => visibleWidth(line) <= 24)).toBe(true);
  });

  it("replays each public group report once with a group label and omits private messages", async () => {
    const message = fact("team.message.sent", { teamId: "flight", channelId: "general", sequence: 1,
      fromLane: lane, body: "[ready-for-review] Aircraft mesh improved", mentions: [], artifactRefs: [], operationId: "report" }, 2);
    const entry = projectSessionLaneMessage(message, runId)!;
    const block = new AgentMessageBlock(agentMessagePresentationFromTranscript(entry));
    expect(stripTerminalSequences(block.render(140).join("\n"))).toContain("Team message");
    const transcript = await projectSessionTranscript(new MemoryContentAddressedStore(), [created, message, message], runId);
    expect(transcript.filter((item) => item.role === "agent")).toHaveLength(1);
    expect(projectSessionLaneMessage({ ...message, visibility: "lane" }, runId)).toBeUndefined();
    expect(projectSessionLaneMessage({ ...message, laneId: "intruder" }, runId)).toBeUndefined();
  });
});
