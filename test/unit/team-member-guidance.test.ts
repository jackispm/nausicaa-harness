import { afterEach, describe, expect, it } from "vitest";

import { A2AInbox } from "../../src/a2a/index.js";
import type { ModelRequest, ToolExecutionContext } from "../../src/domain/ports.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { createScopedSpawnContext } from "../../src/runtime/lane-context.js";
import { RunTokenBudget } from "../../src/runtime/run-token-budget.js";
import { MESSAGE_MEDIA_TYPE } from "../../src/runtime/session-artifacts.js";
import { appendTeamChannelMessage } from "../../src/runtime/team-channel.js";
import { TeamRuntime } from "../../src/runtime/team-runtime.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

const runId = "team-member-guidance";
const caller: ToolExecutionContext = {
  runId, laneId: "main", workspace: process.cwd(), operationId: "create-guidance",
};
const runtimes: TeamRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
});

async function fixture() {
  const ledger = new MemoryLedger();
  const store = new MemoryContentAddressedStore();
  const inbox = new A2AInbox({ sink: ledger });
  const requests: ModelRequest[] = [];
  const projectRef = await store.put("Authorized project instruction: edit only the assigned files.", "text/plain");
  const summaryRef = await store.put("Explicit handoff: use a single index.html file.", "text/plain");
  const parent = { workspaceId: "workspace", sessionId: "session", runId, laneId: "main", laneKind: "main" as const };
  const team = new TeamRuntime({
    eventSink: ledger, inbox, store, runId, modelName: "guidance-test", workspace: caller.workspace,
    branchTools: [], runTokenBudget: new RunTokenBudget(undefined),
    policy: { maxMainStepsPerActivation: 3, mainRequestTimeoutMs: 10_000, tetoEnabled: false, tetoMaxOutputTokens: 64, tetoActivation: "manual", workerEnabled: false },
    model: {
      async complete(request) {
        requests.push(request);
        return { content: `Completed ${request.laneId}`, toolCalls: [], stopReason: "stop", usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 } };
      },
    },
    spawnContext: ({ laneId, goal, inputRefs, budget }) => createScopedSpawnContext({
      parent,
      child: { ...parent, laneId, laneKind: "team", parentLaneId: "main", ownerLaneId: "main", relation: "member-of" },
      goal, inputRefs, budget, tools: [], role: "Team member", projectInstructionRefs: [projectRef], parentSummaryRefs: [summaryRef],
    }),
    readEvents: () => ledger.read({ runId }), readWatermark: () => ledger.watermark(),
    readAwareness: () => ({ version: 1, generatedAt: new Date().toISOString(), availability: "fresh", nodes: [], edges: [], roots: [], truncated: false }),
  });
  runtimes.push(team);
  const privateRef = await store.put(JSON.stringify({
    role: "user", content: "PRIVATE LEAD CONVERSATION", toolCalls: [], createdAt: new Date().toISOString(),
  }), MESSAGE_MEDIA_TYPE);
  await ledger.append({
    runId, laneId: "main", type: "user.message", payload: { messageRef: privateRef },
    correlationId: "private-parent", idempotencyKey: "private-parent", visibility: "run",
  });
  return { team, requests, ledger };
}

function taskInput(request: ModelRequest): string {
  const input = request.messages.findLast((message) => message.role === "user" && message.content.includes("Team member objective:"));
  if (input === undefined) throw new Error("Missing member task input");
  return input.content;
}

function teamSnapshot(input: string): { serialized: string; value: Record<string, unknown> } {
  const serialized = input.split("\n").find((line) => line.startsWith('{"teamId":'));
  if (serialized === undefined) throw new Error("Missing bounded Team snapshot");
  return { serialized, value: JSON.parse(serialized) as Record<string, unknown> };
}

describe("Team member guidance", () => {
  it("provides only the scoped handoff and identifies the task, shared channel and final-report boundary", async () => {
    const s = await fixture();
    const created = await s.team.create({ teamId: "calendar", members: [{ memberId: "frontend", statement: "Build the week calendar", input: "Implement Monday through Sunday." }] }, caller);
    await s.team.drain();
    const request = s.requests.find((item) => item.laneId === "team:calendar:frontend")!;
    expect(request.systemPrompt).toContain("Team Lead, Nausicaa (lane nausicaa)");
    expect(request.systemPrompt).toContain("Prefer team_message for shared coordination");
    expect(request.systemPrompt).toContain("agent_message is private A2A");
    expect(request.systemPrompt).toContain("runtime posts your final response to the Team channel and pauses this task");
    expect(request.systemPrompt).not.toContain("agent_message to ask");
    expect(request.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["team_message", "team_history"]));
    const input = taskInput(request);
    expect(input).toContain(`Task: ${created.members![0]!.taskId}`);
    expect(input).toContain("Authorized project instruction");
    expect(input).toContain("Explicit handoff");
    expect(input).toContain("Implement Monday through Sunday.");
    expect(input).not.toContain("PRIVATE LEAD CONVERSATION");
    expect(input).not.toContain("Success criteria:");
    expect(input).not.toContain("Hard constraints:");
    expect(teamSnapshot(input).value).toMatchObject({ teamId: "calendar", channelId: "general", totalMembers: 1 });
  });

  it("gives a later member a bounded current group snapshot without other groups or forged senders", async () => {
    const s = await fixture();
    await s.team.create({ teamId: "calendar", members: [{ memberId: "frontend", statement: "Build index.html" }] }, caller);
    await s.team.drain();
    await s.team.create({ teamId: "private-group", members: [{ memberId: "private-worker", statement: "Private work" }] }, { ...caller, operationId: "private-group" });
    await s.team.drain();
    await s.team.message({ teamId: "private-group", body: "OTHER GROUP PRIVATE MESSAGE" }, { ...caller, operationId: "private-message" });
    for (let index = 0; index < 6; index += 1) {
      await s.team.message({ teamId: "calendar", body: `group-message-${index} ${"日历进度".repeat(500)}` }, { ...caller, operationId: `group-${index}` });
    }
    for (const [laneId, fromLane, body] of [
      ["outside-member", "outside-member", "UNAUTHORIZED MEMBER MESSAGE"],
      ["outside-member", "main", "FORGED LEAD MESSAGE"],
      ["team:calendar:reviewer", "team:calendar:reviewer", "MESSAGE BEFORE MEMBER ADMISSION"],
    ]) {
      const candidate = appendTeamChannelMessage(await s.ledger.read({ runId }), {
        runId, teamId: "calendar", channelId: "general", laneId: laneId!, fromLane: fromLane!, body: body!, operationId: body!,
      });
      if (!candidate.duplicate) await s.ledger.append(candidate.event);
    }
    const assigned = await s.team.assign({ teamId: "calendar", memberId: "reviewer", statement: "Review the produced HTML", input: "Read index.html and report usability problems." }, { ...caller, operationId: "add-reviewer" });
    await s.team.drain();
    const request = s.requests.find((item) => item.laneId === "team:calendar:reviewer")!;
    const input = taskInput(request);
    const snapshot = teamSnapshot(input);
    expect(input).toContain(`Task: ${assigned.taskId}`);
    expect(snapshot.value).toMatchObject({ teamId: "calendar", totalMembers: 2, members: expect.arrayContaining([
      expect.objectContaining({ memberId: "frontend", status: "completed" }),
      expect.objectContaining({ memberId: "reviewer", taskId: assigned.taskId }),
    ]) });
    expect(snapshot.value.messages).toHaveLength(4);
    expect(Buffer.byteLength(snapshot.serialized, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(input).toContain("group-message-5");
    expect(input).not.toContain("group-message-0");
    expect(input).not.toContain("OTHER GROUP PRIVATE MESSAGE");
    expect(input).not.toContain("UNAUTHORIZED MEMBER MESSAGE");
    expect(input).not.toContain("FORGED LEAD MESSAGE");
    expect(input).not.toContain("MESSAGE BEFORE MEMBER ADMISSION");
    expect(input).not.toContain("PRIVATE LEAD CONVERSATION");
    expect(input).toContain("team_history for paged history");
  });
});
