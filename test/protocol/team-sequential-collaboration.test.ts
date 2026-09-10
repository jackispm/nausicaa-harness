import { afterEach, describe, expect, it, vi } from "vitest";

import { A2AInbox } from "../../src/a2a/inbox.js";
import type { AnyEvent, AppendEvent, EventType } from "../../src/domain/events.js";
import type { AgentTool, ModelPort, ModelRequest, ModelResponse, ToolExecutionContext } from "../../src/domain/ports.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { RunTokenBudget } from "../../src/runtime/run-token-budget.js";
import { TeamRuntime, type TeamRuntimeOptions } from "../../src/runtime/team-runtime.js";
import { projectTeamBoard } from "../../src/runtime/team-board.js";
import { capabilityEntriesFromTools, createScopedSpawnContext } from "../../src/runtime/lane-context.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

const runId = "sequential-team-run";
const context: ToolExecutionContext = { runId, laneId: "main", workspace: process.cwd(), operationId: "create" };
const runtimes = new Set<TeamRuntime>();
const releases: (() => void)[] = [];

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all([...runtimes].map((runtime) => runtime.stop()));
  runtimes.clear();
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  return { promise, release };
}

function response(content: string): ModelResponse {
  return { content, stopReason: "stop", toolCalls: [], usage: { input: 8, output: 4, cacheRead: 0, cacheWrite: 0 } };
}

function callTool(id: string, name: string, arguments_: Record<string, unknown>): ModelResponse {
  return { ...response(""), stopReason: "toolUse", toolCalls: [{ id, name, arguments: arguments_ }] };
}

function toolResult(request: ModelRequest, id: string): unknown {
  const message = request.messages.findLast((item) => item.role === "tool" && item.toolCallId === id);
  if (message === undefined) throw new Error(`Missing tool result ${id}`);
  return JSON.parse(message.content);
}

async function consumeLeadReports(team: TeamRuntime, ledger: MemoryLedger, step: number): Promise<void> {
  const messages = await team.beforeMainStep({ step });
  await ledger.append({ runId, laneId: "main", type: "step.completed", payload: {
    step, hasToolCalls: false, boundaryMessageIds: messages.map((message) => message.messageId),
  }, correlationId: "lead-read-reports", idempotencyKey: `lead-read-reports-${step}` });
}

function fixture(options: {
  ledger?: MemoryLedger;
  store?: MemoryContentAddressedStore;
  events?: readonly AnyEvent[];
  respond?: (request: ModelRequest) => ModelResponse | Promise<ModelResponse>;
  tools?: AgentTool[];
  maxDepth?: number;
  spawnContext?: TeamRuntimeOptions["spawnContext"];
  onWake?: () => void;
} = {}) {
  const ledger = options.ledger ?? new MemoryLedger();
  const store = options.store ?? new MemoryContentAddressedStore();
  const inbox = new A2AInbox({ sink: ledger, events: options.events ?? [] });
  const requests: ModelRequest[] = [];
  const model: ModelPort = { async complete(request) {
    requests.push(request);
    return options.respond?.(request) ?? response(`${request.laneId}: completed with evidence`);
  } };
  const runtimeOptions: TeamRuntimeOptions = {
    eventSink: ledger, inbox, store, model, modelName: "scripted", runId,
    workspace: process.cwd(), branchTools: options.tools ?? [],
    runTokenBudget: new RunTokenBudget(undefined),
    policy: { maxMainStepsPerActivation: 24, mainRequestTimeoutMs: 10_000, tetoEnabled: false, tetoMaxOutputTokens: 64, workerEnabled: false },
    readEvents: () => ledger.read({ runId }), readWatermark: () => ledger.watermark(),
    readAwareness: () => ({ version: 1, generatedAt: new Date().toISOString(), availability: "fresh", nodes: [], edges: [], roots: [], truncated: false }),
    ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
    ...(options.spawnContext === undefined ? {} : { spawnContext: options.spawnContext }),
    ...(options.onWake === undefined ? {} : { onWake: options.onWake }),
  };
  const team = new TeamRuntime(runtimeOptions);
  runtimes.add(team);
  return { team, ledger, store, inbox, requests };
}

describe("sequential resident Team collaboration", () => {
  it.each([true, false])("lets members read their Team and wait for peers without exposing other Teams (nested=%s)", async (allowNestedTeam) => {
    const development = gate();
    let reviewerCalls = 0;
    const tools: AgentTool[] = ["read_file", "write_file"].map((name) => ({
      definition: { name, description: name, parameters: { type: "object" } },
      async execute() { return { content: "ok", isError: false }; },
    }));
    const f = fixture({ tools, respond: async (request) => {
      if (request.laneId === "team:reads:developer") await development.promise;
      if (request.laneId === "team:reads:reviewer") {
        reviewerCalls += 1;
        if (reviewerCalls === 1) return callTool("status", "team_status", {});
        if (reviewerCalls === 2) return callTool("self", "task_wait", { teamId: "reads", taskId: "reads:reviewer" });
        if (reviewerCalls === 3) return callTool("foreign", "task_wait", { teamId: "private", taskId: "private:worker" });
        if (reviewerCalls === 4) return callTool("peer", "task_wait", { teamId: "reads", taskId: "reads:developer" });
      }
      return response("Completed with evidence");
    } });
    await f.team.create({ teamId: "private", members: [{ memberId: "worker", statement: "Private work" }] }, context);
    await f.team.drain();
    await f.team.create({ teamId: "reads", members: [
      { memberId: "developer", statement: "Implement the page" },
      { memberId: "reviewer", statement: "Wait for and review the page", capabilities: { tools: ["read_file"], allowNestedTeam } },
    ] }, { ...context, operationId: "reads" });
    await vi.waitFor(async () => expect((await f.ledger.read()).some((event) => event.type === "tool.started"
      && event.laneId === "team:reads:reviewer" && event.payload.toolCallId === "peer")).toBe(true));
    expect(reviewerCalls).toBe(4);
    development.release();
    await f.team.drain();
    const final = f.requests.findLast((request) => request.laneId === "team:reads:reviewer")!;
    expect(toolResult(final, "status")).toMatchObject({ teams: [{ teamId: "reads" }] });
    expect((toolResult(final, "status") as { teams: unknown[] }).teams).toHaveLength(1);
    expect(toolResult(final, "self")).toMatchObject({ error: expect.stringContaining("current task") });
    expect(toolResult(final, "foreign")).toMatchObject({ error: "Unknown Team private" });
    expect(toolResult(final, "peer")).toMatchObject({ waiting: false, outcome: "succeeded" });
    const names = final.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["read_file", "team_status", "task_wait"]));
    expect(names).not.toContain("write_file");
    expect(names.includes("team_create")).toBe(allowNestedTeam);
    expect(new Set(names).size).toBe(names.length);
    const spawn = (await f.team.status(context)).teams.find((board) => board.teamId === "reads")!
      .definition!.members.find((member) => member.memberId === "reviewer")!.task.spawnContext!;
    expect(spawn.tools.map((tool) => tool.name).toSorted()).toEqual(names.toSorted());
  });

  it("uses the same status and wait tools for membership and a member's nested Teams", async () => {
    const childWork = gate();
    let calls = 0;
    const f = fixture({ respond: async (request) => {
      if (request.laneId === "team:inner:child") await childWork.promise;
      if (request.laneId === "team:outer:manager") {
        calls += 1;
        if (calls === 1) return callTool("create", "team_create", { teamId: "inner", members: [{ memberId: "child", statement: "Implement" }] });
        if (calls === 2) return callTool("status", "team_status", {});
        if (calls === 3) return callTool("child", "task_wait", { teamId: "inner", taskId: "inner:child" });
      }
      return response("Completed nested task");
    } });
    await f.team.create({ teamId: "outer", members: [{ memberId: "manager", statement: "Lead a nested Team" }] }, context);
    await vi.waitFor(async () => expect((await f.ledger.read()).some((event) => event.type === "tool.started"
      && event.laneId === "team:outer:manager" && event.payload.toolCallId === "child")).toBe(true));
    expect(calls).toBe(3);
    childWork.release();
    await f.team.drain();
    const final = f.requests.findLast((request) => request.laneId === "team:outer:manager")!;
    expect((toolResult(final, "status") as { teams: { teamId: string }[] }).teams.map((team) => team.teamId)).toEqual(["outer", "inner"]);
    expect(toolResult(final, "child")).toMatchObject({ waiting: false, outcome: "succeeded" });
    expect(final.tools.filter((tool) => tool.name === "team_status")).toHaveLength(1);
    expect(final.tools.filter((tool) => tool.name === "task_wait")).toHaveLength(1);
  });

  it("waits once, adds a reviewer to the same Team, and reuses both members for repair and verification", async () => {
    const development = gate();
    const review = gate();
    const f = fixture({ respond: async (request) => {
      if (request.laneId.endsWith(":developer")) await development.promise;
      else await review.promise;
      return response(`${request.laneId}: completed`);
    } });
    const created = await f.team.create({ teamId: "calendar", members: [{ memberId: "developer", statement: "Implement calendar and Todo" }] }, context);
    let settled = false;
    const waiting = f.team.wait({ teamId: "calendar", taskId: created.members![0]!.taskId }, context).then((result) => { settled = true; return result; });
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    expect(settled).toBe(false);
    development.release();
    expect(await waiting).toMatchObject({ waiting: false, outcome: "succeeded", report: { assignmentVersion: 0 } });
    await f.team.drain();
    const initialHistory = await f.team.history({ teamId: "calendar" }, context);
    expect(initialHistory.messages).toHaveLength(1);
    expect(initialHistory.messages[0]).toMatchObject({ fromLane: "team:calendar:developer", threadId: "task:calendar:developer" });
    await consumeLeadReports(f.team, f.ledger, 1);

    const added = await f.team.assign({ teamId: "calendar", memberId: "reviewer", statement: "Review the existing index.html", input: "Read the developer's report and inspect the artifact", capabilities: { tools: [], allowNestedTeam: false } }, { ...context, operationId: "add-reviewer" });
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    const board = (await f.team.status(context)).teams[0]!;
    expect(board.definition?.members).toHaveLength(1);
    expect(board.members).toHaveLength(2);
    expect(board.anomalies).toEqual([]);
    expect(board.status).toBe("running");
    expect(f.requests[1]?.tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining(["team_history", "team_message"]));
    expect(f.requests[1]?.tools?.some((tool) => tool.name === "team_create")).toBe(false);
    await expect(f.team.present({ teamId: "calendar", disposition: "accepted" }, context)).rejects.toThrow("unfinished");
    review.release();
    expect(await f.team.wait({ teamId: "calendar", taskId: added.taskId }, context)).toMatchObject({ waiting: false, report: { assignmentVersion: 0 } });
    await f.team.drain();
    await consumeLeadReports(f.team, f.ledger, 2);
    const repaired = await f.team.assign({ teamId: "calendar", memberId: "developer", statement: "Fix the two review findings" }, { ...context, operationId: "repair" });
    expect(await f.team.wait({ teamId: "calendar", taskId: repaired.taskId }, context)).toMatchObject({ waiting: false, report: { assignmentVersion: 1 } });
    await f.team.drain();
    await consumeLeadReports(f.team, f.ledger, 3);
    const verified = await f.team.assign({ teamId: "calendar", memberId: "reviewer", statement: "Recheck the fixes" }, { ...context, operationId: "verify" });
    expect(await f.team.wait({ teamId: "calendar", taskId: verified.taskId }, context)).toMatchObject({ waiting: false, status: "review" });
    await f.team.drain();
    expect(await f.team.present({ teamId: "calendar", disposition: "accepted" }, context)).toMatchObject({ disposition: "accepted" });
    expect((await f.team.status(context)).teams[0]).toMatchObject({ lifecycleState: "open", anomalies: [] });
    expect((await f.team.history({ teamId: "calendar" }, context)).messages).toHaveLength(4);
    expect(f.requests).toHaveLength(4);
  });

  it("checks complete new-member operation identity and never duplicates an admission", async () => {
    const f = fixture();
    await f.team.create({ teamId: "identity", members: [{ memberId: "developer", statement: "Develop" }] }, context);
    await f.team.drain();
    const request = { teamId: "identity", memberId: "reviewer", statement: "Review", input: "index.html", capabilities: { tools: [], allowNestedTeam: false } };
    const assignmentContext = { ...context, operationId: "new-reviewer" };
    const first = await f.team.assign(request, assignmentContext);
    await f.team.drain();
    expect(await f.team.assign(request, assignmentContext)).toEqual({ ...first, status: "duplicate" });
    await expect(f.team.assign({ ...request, input: "different.html" }, assignmentContext)).rejects.toThrow("different work");
    await expect(f.team.assign({ ...request, capabilities: { tools: [], allowNestedTeam: true } }, assignmentContext)).rejects.toThrow("different work");
    expect((await f.ledger.read()).filter((event) => event.type === "team.member.added")).toHaveLength(1);
    expect((await f.team.status(context)).teams[0]?.anomalies).toEqual([]);
  });

  it("recovers admission interrupted before task dispatch and keeps its grant", async () => {
    class InterruptedLedger extends MemoryLedger {
      failNewMember = false;
      override async append<K extends EventType>(event: AppendEvent<K>) {
        if (this.failNewMember && event.type === "message.sent") {
          const sent = event as AppendEvent<"message.sent">;
          if (sent.payload.message.to === "team:recovery:reviewer" && sent.payload.message.payload.type === "task.request") {
            this.failNewMember = false;
            throw new Error("Crash before dispatch");
          }
        }
        return super.append(event);
      }
    }
    const ledger = new InterruptedLedger();
    const original = fixture({ ledger });
    await original.team.create({ teamId: "recovery", members: [{ memberId: "developer", statement: "Develop" }] }, context);
    await original.team.drain();
    ledger.failNewMember = true;
    const request = { teamId: "recovery", memberId: "reviewer", statement: "Review", capabilities: { tools: [], allowNestedTeam: false } };
    await expect(original.team.assign(request, { ...context, operationId: "reviewer" })).rejects.toThrow("Crash before dispatch");
    await original.team.stop();
    const restored = fixture({ ledger, store: original.store, events: await ledger.read() });
    await restored.team.restore();
    await restored.team.drain();
    expect(restored.requests).toHaveLength(1);
    expect(restored.requests[0]?.laneId).toBe("team:recovery:reviewer");
    expect(restored.requests[0]?.tools?.some((tool) => tool.name === "team_create")).toBe(false);
    expect(await restored.team.assign(request, { ...context, operationId: "reviewer" })).toMatchObject({ status: "duplicate", assignmentVersion: 0 });
    expect((await restored.team.history({ teamId: "recovery" }, context)).messages).toHaveLength(2);
    expect((await restored.team.status(context)).teams[0]?.anomalies).toEqual([]);
  });

  it("cancels a wait without cancelling or replaying the member task", async () => {
    const working = gate();
    const f = fixture({ respond: async () => { await working.promise; return response("done"); } });
    await f.team.create({ teamId: "abort", members: [{ memberId: "developer", statement: "Develop" }] }, context);
    const controller = new AbortController();
    const waiting = f.team.wait({ teamId: "abort", taskId: "abort:developer" }, { ...context, signal: controller.signal });
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    controller.abort(new Error("Stop waiting"));
    await expect(waiting).rejects.toThrow("Stop waiting");
    expect((await f.team.status(context)).teams[0]?.cancellationRequested).toBe(false);
    working.release();
    expect(await f.team.wait({ teamId: "abort", taskId: "abort:developer" }, context)).toMatchObject({ waiting: false, outcome: "succeeded" });
    expect(f.requests).toHaveLength(1);
  });

  it.each(["close", "cancel", "stop"] as const)("releases a pending wait on %s and fences later admission", async (action) => {
    const working = gate();
    const f = fixture({ respond: async () => { await working.promise; return response("done"); } });
    await f.team.create({ teamId: "stop", members: [{ memberId: "developer", statement: "Develop" }] }, context);
    const waiting = f.team.wait({ teamId: "stop", taskId: "stop:developer" }, context).catch((error: unknown) => ({ error: String(error) }));
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    if (action === "stop") await f.team.stop();
    else await f.team[action]({ teamId: "stop" }, context);
    if (action === "stop") expect(await waiting).toMatchObject({ error: expect.stringContaining("stopped") });
    else expect(await waiting).toMatchObject({ waiting: false, status: "cancelled" });
    await expect(f.team.assign({ teamId: "stop", memberId: "reviewer", statement: "Review" }, { ...context, operationId: "late" })).rejects.toThrow(/closed|stopped/);
  });

  it("rejects forged membership events during board projection", async () => {
    const f = fixture();
    await f.team.create({ teamId: "trust", members: [{ memberId: "developer", statement: "Develop" }] }, context);
    await f.team.drain();
    await f.team.assign({ teamId: "trust", memberId: "reviewer", statement: "Review" }, { ...context, operationId: "reviewer" });
    await f.team.drain();
    const events = await f.ledger.read();
    const forged = events.map((event) => event.type === "team.member.added" ? { ...event, laneId: "team:trust:developer" } : event);
    const board = projectTeamBoard(forged, "trust", { runId });
    expect(board?.members.map((member) => member.memberId)).toEqual(["developer"]);
    expect(board?.anomalies).toContain("team.member.added has no authorized open Team admission");
  });

  it("records a new acceptance after reassignment while same-task-set retries remain idempotent", async () => {
    const f = fixture();
    await f.team.create({ teamId: "rounds", members: [{ memberId: "developer", statement: "Develop" }] }, context);
    await f.team.drain();
    await f.team.present({ teamId: "rounds", disposition: "accepted" }, context);
    await f.team.present({ teamId: "rounds", disposition: "accepted" }, context);
    expect((await f.ledger.read()).filter((event) => event.type === "team.presented")).toHaveLength(1);
    const task = await f.team.assign({ teamId: "rounds", memberId: "developer", statement: "Improve the result" }, { ...context, operationId: "improve" });
    await f.team.wait({ teamId: "rounds", taskId: task.taskId }, context);
    await f.team.drain();
    expect((await f.team.status(context)).teams[0]?.presentationState).toBe("pending");
    await f.team.present({ teamId: "rounds", disposition: "accepted" }, context);
    await f.team.present({ teamId: "rounds", disposition: "accepted" }, context);
    expect((await f.team.status(context)).teams[0]).toMatchObject({ presentationState: "accepted", anomalies: [], lifecycleState: "open" });
    expect((await f.ledger.read()).filter((event) => event.type === "team.presented")).toHaveLength(2);
    await expect(f.team.present({ teamId: "rounds", disposition: "rejected" }, context)).rejects.toThrow("different presentation");
  });

  it("inherits only the actual parent SpawnContext tools when a member creates another Team", async () => {
    const tools: AgentTool[] = ["read_file", "write_file"].map((name) => ({
      definition: { name, description: name, parameters: { type: "object", properties: {}, additionalProperties: false } },
      async execute() { return { content: "ok", isError: false }; },
    }));
    let createdChild = false;
    const f = fixture({ tools,
      spawnContext: ({ laneId, goal, inputRefs, budget }) => createScopedSpawnContext({
        parent: { workspaceId: "workspace", sessionId: "session", runId, laneId: "main", laneKind: "main" },
        child: { workspaceId: "workspace", sessionId: "session", runId, laneId, laneKind: "team", parentLaneId: "main", ownerLaneId: "main", relation: "member-of" },
        goal, inputRefs, budget, tools: capabilityEntriesFromTools([tools[0]!]), role: "Read-only member",
      }),
      respond: (request) => {
        if (request.laneId === "team:outer:parent" && !createdChild) {
          createdChild = true;
          return { ...response(""), stopReason: "toolUse", toolCalls: [{ id: "create-child", name: "team_create",
            arguments: { teamId: "inner", members: [{ memberId: "child", statement: "Inspect the code" }] } }] };
        }
        return response("Review finished");
      },
    });
    await f.team.create({ teamId: "outer", members: [{ memberId: "parent", statement: "Create a reviewer Team" }] }, context);
    await f.team.drain();
    const child = f.requests.find((request) => request.laneId === "team:inner:child");
    expect(child).toBeDefined();
    expect(child?.tools?.some((tool) => tool.name === "read_file")).toBe(true);
    expect(child?.tools?.some((tool) => tool.name === "write_file")).toBe(false);
    expect(f.requests.filter((request) => request.laneId === "team:outer:parent").every((request) => !request.tools?.some((tool) => tool.name === "write_file"))).toBe(true);
  });

  it("enforces the 16-member limit and exposes newly admitted peers under the existing policy", async () => {
    const working = gate();
    const f = fixture({ respond: async () => { await working.promise; return response("finished"); } });
    await f.team.create({ teamId: "capacity", members: Array.from({ length: 15 }, (_, index) => ({ memberId: `worker-${index + 1}`, statement: "Work" })) }, context);
    await f.team.assign({ teamId: "capacity", memberId: "worker-16", statement: "Work" }, { ...context, operationId: "sixteen" });
    expect(await f.team.messageTargets("team:capacity:worker-1")).toContain("team:capacity:worker-16");
    expect(await f.team.messageTargets("team:capacity:worker-16")).toContain("team:capacity:worker-1");
    await expect(f.team.assign({ teamId: "capacity", memberId: "worker-17", statement: "Work" }, { ...context, operationId: "seventeen" })).rejects.toThrow("16-member limit");
    expect((await f.team.status(context)).teams[0]?.members).toHaveLength(16);
    expect((await f.team.status(context)).teams[0]?.anomalies).toEqual([]);
  });

  it("repairs an initial report interrupted after its group message without duplicating the message", async () => {
    class ReportFaultLedger extends MemoryLedger {
      failedReport = false;
      override async append<K extends EventType>(event: AppendEvent<K>) {
        if (!this.failedReport && String(event.type) === "team.run.reported") {
          this.failedReport = true;
          throw new Error("Interrupted report append");
        }
        return super.append(event);
      }
    }
    const ledger = new ReportFaultLedger();
    const f = fixture({ ledger });
    await f.team.create({ teamId: "report-repair", members: [{ memberId: "developer", statement: "Develop" }] }, context);
    await f.team.drain();
    expect(await f.team.wait({ teamId: "report-repair", taskId: "report-repair:developer" }, context)).toMatchObject({ waiting: false, report: { assignmentVersion: 0 } });
    expect((await f.team.history({ teamId: "report-repair" }, context)).messages).toHaveLength(1);
    expect(f.requests).toHaveLength(1);
    expect((await f.team.status(context)).teams[0]?.anomalies).toEqual([]);
    await f.team.stop();
    const restored = fixture({ ledger, store: f.store, events: await ledger.read() });
    await restored.team.restore();
    await restored.team.drain();
    expect(restored.requests).toHaveLength(0);
    expect((await restored.team.history({ teamId: "report-repair" }, context)).messages).toHaveLength(1);
  });

  it("wakes the lead only after the follow-up terminal handoff becomes durable", async () => {
    const entered = gate();
    const releaseReply = gate();
    class DelayedReplyLedger extends MemoryLedger {
      override async append<K extends EventType>(event: AppendEvent<K>) {
        if (event.type === "message.sent") {
          const message = (event as AppendEvent<"message.sent">).payload.message;
          if (message.payload.type === "task.result" && message.payload.taskId === "wake:developer:task-1") {
            entered.release();
            await releaseReply.promise;
          }
        }
        return super.append(event);
      }
    }
    let observing = false;
    const wakeReads: boolean[] = [];
    const f = fixture({ ledger: new DelayedReplyLedger(), onWake: () => {
      if (observing) wakeReads.push(f.inbox.snapshot().records.some((record) => record.message.to === "main"
        && record.message.payload.type === "task.result" && record.message.payload.taskId === "wake:developer:task-1"));
    } });
    await f.team.create({ teamId: "wake", members: [{ memberId: "developer", statement: "Develop" }] }, context);
    await f.team.drain();
    observing = true;
    await f.team.assign({ teamId: "wake", memberId: "developer", statement: "Repair" }, { ...context, operationId: "repair" });
    await entered.promise;
    expect(wakeReads).toEqual([]);
    releaseReply.release();
    await f.team.drain();
    expect(wakeReads).toEqual([true]);
  });

  it("restores a reported follow-up whose terminal message was lost without another model call", async () => {
    class LostReplyLedger extends MemoryLedger {
      failReply = true;
      override async append<K extends EventType>(event: AppendEvent<K>) {
        if (this.failReply && event.type === "message.sent") {
          const message = (event as AppendEvent<"message.sent">).payload.message;
          if (message.payload.type === "task.result" && message.payload.taskId === "handoff:developer:task-1") {
            this.failReply = false;
            throw new Error("Lost terminal handoff");
          }
        }
        return super.append(event);
      }
    }
    const ledger = new LostReplyLedger();
    const original = fixture({ ledger });
    await original.team.create({ teamId: "handoff", members: [{ memberId: "developer", statement: "Develop" }] }, context);
    await original.team.drain();
    await original.team.assign({ teamId: "handoff", memberId: "developer", statement: "Repair" }, { ...context, operationId: "repair" });
    await original.team.drain();
    expect((await original.team.status(context)).teams[0]?.tasks?.[0]?.latestReport).toBeDefined();
    expect(original.inbox.snapshot().records.some((record) => record.message.payload.type === "task.result"
      && record.message.payload.taskId === "handoff:developer:task-1")).toBe(false);
    await original.team.stop();
    const wakes: boolean[] = [];
    const restored = fixture({ ledger, store: original.store, events: await ledger.read(), onWake: () => {
      wakes.push(restored.inbox.snapshot().records.some((record) => record.message.to === "main"
        && record.message.payload.type === "task.result" && record.message.payload.taskId === "handoff:developer:task-1"));
    } });
    await restored.team.restore();
    await restored.team.drain();
    expect(restored.requests).toHaveLength(0);
    expect(wakes).toContain(true);
    const requests = restored.inbox.snapshot().records.filter((record) => record.message.payload.type === "task.request"
      && record.message.payload.taskId === "handoff:developer:task-1");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.status).toBe("handled");
    await restored.team.restore();
    expect(restored.inbox.snapshot().records.filter((record) => record.message.payload.type === "task.result"
      && record.message.payload.taskId === "handoff:developer:task-1")).toHaveLength(1);
    expect((await restored.team.status(context)).teams[0]?.anomalies).toEqual([]);
  });
});
