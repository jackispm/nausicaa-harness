import { afterEach, describe, expect, it, vi } from "vitest";

import { A2AInbox } from "../../src/a2a/inbox.js";
import type { AppendEvent, EventType } from "../../src/domain/events.js";
import type { AgentTool, ModelPort, ModelRequest, ModelResponse, ToolExecutionContext } from "../../src/domain/ports.js";
import type { TeamTaskAssignment } from "../../src/domain/team.js";
import type { RunPolicy } from "../../src/domain/types.js";
import { MAX_TASK_ATTEMPTS } from "../../src/domain/types.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { annotateTool } from "../../src/mowe/catalog.js";
import { capabilityEntriesFromTools, createScopedSpawnContext } from "../../src/runtime/lane-context.js";
import { RunTokenBudget } from "../../src/runtime/run-token-budget.js";
import { TeamRuntime, type TeamRuntimeOptions } from "../../src/runtime/team-runtime.js";
import { createTaskWaitTool, type TeamCreateRequest } from "../../src/runtime/team-tool.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

const RUN_ID = "team-collaboration-run";
const policy: RunPolicy = {
  maxMainStepsPerActivation: 3,
  maxModelTokens: 100_000,
  mainRequestTimeoutMs: 10_000,
  tetoEnabled: false,
  tetoMaxOutputTokens: 64,
  tetoActivation: "manual",
  workerEnabled: false,
};
const context: ToolExecutionContext = {
  runId: RUN_ID, laneId: "main", workspace: process.cwd(), operationId: "create-review",
};
const runtimes = new Set<TeamRuntime>();

afterEach(async () => {
  for (const runtime of runtimes) await runtime.stop();
  runtimes.clear();
});

class ManualClock {
  private timestamp = Date.parse("2026-09-07T08:00:00.000Z");
  now(): Date { return new Date(this.timestamp); }
  advance(milliseconds: number): void { this.timestamp += milliseconds; }
}

class RecordingModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  private readonly callsByLane = new Map<string, number>();

  constructor(private readonly respond: (request: ModelRequest, laneCall: number) => ModelResponse | Promise<ModelResponse> = (request) => response(`${request.laneId} finished`)) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const { signal: _signal, ...observable } = request;
    this.requests.push(structuredClone(observable));
    const laneCall = (this.callsByLane.get(request.laneId) ?? 0) + 1;
    this.callsByLane.set(request.laneId, laneCall);
    return this.respond(request, laneCall);
  }
}

function fixture(options: {
  clock?: ManualClock;
  ledger?: MemoryLedger;
  store?: MemoryContentAddressedStore;
  inbox?: A2AInbox;
  model?: RecordingModel;
  tools?: readonly AgentTool[];
  onWake?: () => void;
  spawnContext?: TeamRuntimeOptions["spawnContext"];
  parentLaneId?: string;
  policy?: RunPolicy;
} = {}) {
  const clock = options.clock ?? new ManualClock();
  const ledger = options.ledger ?? new MemoryLedger({ clock });
  const store = options.store ?? new MemoryContentAddressedStore();
  const inbox = options.inbox ?? new A2AInbox({ sink: ledger, clock });
  const model = options.model ?? new RecordingModel();
  let sequence = 0;
  const team = new TeamRuntime({
    eventSink: ledger, inbox, store, model, modelName: "scripted-team", runId: RUN_ID,
    workspace: process.cwd(), branchTools: options.tools ?? [], policy: options.policy ?? policy, clock,
    runTokenBudget: new RunTokenBudget(100_000), createId: () => `collaboration-${++sequence}`,
    readEvents: () => ledger.read({ runId: RUN_ID }), readWatermark: () => ledger.watermark(),
    readAwareness: () => ({ version: 1, generatedAt: clock.now().toISOString(), availability: "fresh", nodes: [], edges: [], roots: [], truncated: false }),
    ...(options.onWake === undefined ? {} : { onWake: options.onWake }),
    ...(options.spawnContext === undefined ? {} : { spawnContext: options.spawnContext }),
    ...(options.parentLaneId === undefined ? {} : { parentLaneId: options.parentLaneId }),
  });
  runtimes.add(team);
  return { team, model, ledger, store, inbox, clock };
}

async function board(team: TeamRuntime, teamId = "review") {
  const result = (await team.status(context)).teams.find((item) => item.teamId === teamId);
  if (result === undefined) throw new Error(`Missing Team ${teamId}`);
  return result;
}

function response(content: string, stopReason = "stop"): ModelResponse {
  return { content, stopReason, toolCalls: [], usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function member(memberId: string, overrides: Record<string, unknown> = {}) {
  return { memberId, statement: `Inspect ${memberId}`, maxModelTokens: 12_000, maxWallClockMs: 10_000, maxAttempts: 3, ...overrides };
}

function workspaceCatalog() {
  const tools: AgentTool[] = ["read_file", "write_file", "bash"].map((name) => ({
    definition: { name, description: name, parameters: { type: "object" } },
    execute: vi.fn(async () => ({ content: name, isError: false })),
  }));
  const spawnContext: TeamRuntimeOptions["spawnContext"] = ({ laneId, goal, inputRefs, budget }) => createScopedSpawnContext({
    parent: { workspaceId: "workspace", sessionId: "session", runId: RUN_ID, laneId: "main", laneKind: "main" },
    child: { workspaceId: "workspace", sessionId: "session", runId: RUN_ID, laneId, laneKind: "team", parentLaneId: "main", ownerLaneId: "main", relation: "member-of" },
    goal, inputRefs, budget, tools: capabilityEntriesFromTools(tools), role: "Member",
  });
  return { tools, spawnContext };
}

function parentChannelModel(teamId: string) {
  return new RecordingModel((_request, call) => {
    if (call === 1) return {
      ...response("", "toolUse"),
      toolCalls: [{ id: "parent-message", name: "team_message", arguments: { teamId, body: "Parent Team channel is available" } }],
    };
    if (call === 2) return {
      ...response("", "toolUse"),
      toolCalls: [{ id: "parent-history", name: "team_history", arguments: { teamId } }],
    };
    return response("Parent Team communication verified");
  });
}

describe("durable Team collaboration", () => {
  it("runs new members, follow-up assignments and reducers beyond old time and step caps", async () => {
    const clock = new ManualClock();
    const tool = annotateTool({
      definition: { name: "read_evidence", description: "Read evidence", parameters: { type: "object", properties: {}, additionalProperties: false } },
      async execute() { return { content: "Verified evidence for the long task", isError: false }; },
    }, { effect: "read" });
    const model = new RecordingModel((request, call) => {
      clock.advance(3 * 60 * 1_000);
      const taskCall = (call - 1) % 11 + 1;
      if (taskCall < 11) {
        return { ...response("", "toolUse"), toolCalls: [{ id: `read-${call}`, name: "read_evidence", arguments: {} }] };
      }
      expect(request.messages.some((message) => message.role === "tool" && message.content.includes("Verified evidence"))).toBe(true);
      return response(`Completed long task on ${request.laneId}`);
    });
    const { team, ledger, inbox } = fixture({ model, clock, tools: [tool], policy: { ...policy, mainRequestTimeoutMs: 5 * 60 * 1_000 } });
    await team.create({ teamId: "unlimited", members: [{ memberId: "researcher", statement: "Investigate the large task" }] }, context);
    await team.drain();
    const created = (await ledger.read({ runId: RUN_ID })).find((event) => event.type === "team.created")!;
    expect(created.payload).not.toHaveProperty("deadline");
    expect(created.payload.members[0]?.task.budget).toEqual({});
    expect(created.payload.members[0]?.task.spawnContext?.budget).toEqual({});
    expect((await board(team, "unlimited")).members[0]?.outcome).toBe("succeeded");

    const assigned = await team.assign({ teamId: "unlimited", memberId: "researcher", statement: "Continue the large task" }, {
      ...context, operationId: "unlimited-follow-up",
    });
    await team.drain();
    expect(await team.wait({ teamId: "unlimited", taskId: assigned.taskId }, context)).toMatchObject({ status: "review" });
    const assignment = inbox.snapshot().records.find((record) => record.message.payload.type === "task.request"
      && record.message.payload.taskId === assigned.taskId)?.message.payload;
    expect(assignment?.type === "task.request" ? assignment.budget : undefined).toEqual({});

    await team.reduce({ teamId: "unlimited" }, context);
    await team.drain();
    const state = await board(team, "unlimited");
    expect(state.reducer?.task.budget).toEqual({});
    expect(state.reduction).toMatchObject({ outcome: "succeeded", result: { usage: { input: 110, output: 44 } } });
    expect(model.requests).toHaveLength(33);
    const events = await ledger.read({ runId: RUN_ID });
    expect(events.filter((event) => event.type === "model.completed")).toHaveLength(33);
    expect(events.filter((event) => event.type === "user.message" && event.laneId === "team:unlimited:researcher")).toHaveLength(2);
    expect(events.some((event) => event.type === "team.member.settled" && event.payload.outcome === "abandoned")).toBe(false);
  });

  it("restores an unlimited Team after a long admission delay without inventing a deadline", async () => {
    const clock = new ManualClock();
    const ledger = new FailFirstTaskDispatchLedger(clock);
    const original = fixture({ ledger, clock });
    await expect(original.team.create({ teamId: "unlimited-recovery", members: [{ memberId: "researcher", statement: "Finish after restart" }] }, context))
      .rejects.toThrow("injected dispatch crash");
    await original.team.stop();
    clock.advance(2 * 24 * 60 * 60 * 1_000);
    const recovered = fixture({ ledger, clock, store: original.store, inbox: A2AInbox.rehydrate(await ledger.read(), { sink: ledger, clock }) });
    await recovered.team.restore();
    await recovered.team.drain();
    const state = await board(recovered.team, "unlimited-recovery");
    expect(state.definition).not.toHaveProperty("deadline");
    expect(state.members[0]).toMatchObject({ budget: {}, outcome: "succeeded" });
    expect(recovered.model.requests).toHaveLength(1);
  });

  it.each(["length", "aborted"])("does not continue a %s provider outcome at an activation boundary", async (stopReason) => {
    const execute = vi.fn(async () => ({ content: "Evidence", isError: false }));
    const tool = annotateTool({
      definition: { name: "read_evidence", description: "Read evidence", parameters: { type: "object", properties: {}, additionalProperties: false } },
      execute,
    }, { effect: "read" });
    const model = new RecordingModel((_request, call) => ({
      ...response("Unfinished evidence report", call === 3 ? stopReason : "toolUse"),
      toolCalls: [{ id: `read-${call}`, name: "read_evidence", arguments: {} }],
    }));
    const { team } = fixture({ model, tools: [tool] });
    await team.create({ teamId: "stopped-provider", members: [{ memberId: "researcher", statement: "Inspect evidence" }] }, context);
    await team.drain();
    expect(model.requests).toHaveLength(3);
    expect(execute).toHaveBeenCalledTimes(2);
    expect((await board(team, "stopped-provider")).members[0]?.outcome).toBe("partial");
  });

  it("supplies a bounded fallback when an inherited tool has an empty description", async () => {
    const emptyDescriptionTool: AgentTool = {
      definition: { name: "empty_description", description: "", parameters: { type: "object" } },
      async execute() { return { content: "ok", isError: false }; },
    };
    const { team, model } = fixture({ tools: [emptyDescriptionTool] });
    await team.create({ teamId: "empty-description", members: [{ memberId: "worker", statement: "Inspect the workspace" }] }, context);
    await team.drain();
    const member = model.requests.find((request) => request.laneId === "team:empty-description:worker");
    expect(member).toBeDefined();
    expect(member?.systemPrompt).toContain("You are worker, a Team member");
  });

  it("persists a bounded public channel with idempotent sends and an explicit close", async () => {
    const { team, ledger } = fixture();
    await team.create({ teamId: "channel-review", members: [member("writer")] }, context);

    const first = await team.message({ teamId: "channel-review", channelId: "discussion", body: "Started the review" }, {
      ...context, operationId: "channel-message-1",
    });
    const memberMessage = await team.message({ teamId: "channel-review", channelId: "discussion", body: "Writer lane is ready", threadId: "task:writer" }, {
      ...context, laneId: "team:channel-review:writer", operationId: "channel-message-member-1",
    });
    expect(memberMessage.fromLane).toBe("team:channel-review:writer");
    const duplicate = await team.message({ teamId: "channel-review", channelId: "discussion", body: "Started the review" }, {
      ...context, operationId: "channel-message-1",
    });
    expect(first.status).toBe("sent");
    expect(duplicate).toMatchObject({ status: "duplicate", messageId: first.messageId, sequence: 1 });

    const second = await team.message({ teamId: "channel-review", channelId: "discussion", body: "Ready for review", threadId: "task:writer" }, {
      ...context, operationId: "channel-message-2",
    });
    const history = await team.history({ teamId: "channel-review", channelId: "discussion", threadId: "channel-review:discussion:general", limit: 1 }, context);
    expect(history.messages.map((message) => message.body)).toEqual(["Started the review"]);
    expect(history.hasMore).toBe(false);
    const taskHistory = await team.history({ teamId: "channel-review", channelId: "discussion", threadId: "task:writer", limit: 1 }, context);
    expect(taskHistory.messages.map((message) => message.body)).toEqual(["Writer lane is ready"]);
    expect(taskHistory.hasMore).toBe(true);
    if (taskHistory.nextCursor === undefined) throw new Error("Expected a next history cursor");
    const next = await team.history({ teamId: "channel-review", channelId: "discussion", after: taskHistory.nextCursor }, context);
    expect(next.messages.map((message) => message.body)).toEqual(["Ready for review"]);
    expect(second.threadId).toBe("task:writer");

    await team.close({ teamId: "channel-review", reason: "Review archived" }, {
      ...context, operationId: "channel-close-1",
    });
    expect((await board(team, "channel-review")).lifecycleState).toBe("closed");
    await expect(team.message({ teamId: "channel-review", body: "late" }, {
      ...context, operationId: "channel-message-late",
    })).rejects.toThrow(/closed/);
    expect((await ledger.read({ runId: RUN_ID })).filter((event) => event.type === "team.message.sent"
      && event.payload.channelId === "discussion")).toHaveLength(3);
  });

  it("creates canonical members after one durable definition while preserving exact legacy identity objects", async () => {
    const onWake = vi.fn();
    const { team, ledger, model } = fixture({ onWake });
    const result = await team.create({ teamId: "review", members: [member("security"), member("compatibility")] }, context);
    expect(result.members).toEqual([
      { memberId: "security", name: "security", taskId: "review:security", laneId: "team:review:security", status: "queued" },
      { memberId: "compatibility", name: "compatibility", taskId: "review:compatibility", laneId: "team:review:compatibility", status: "queued" },
    ]);
    expect(result.branches).toEqual([
      { branchId: "security", laneId: "team:review:security", status: "queued" },
      { branchId: "compatibility", laneId: "team:review:compatibility", status: "queued" },
    ]);
    await team.drain();
    const events = await ledger.read({ runId: RUN_ID });
    const created = events.find((event) => event.type === "team.created")!;
    expect(created.payload).toMatchObject({ leadLaneId: "main", joinPolicy: "all-terminal", peerMessaging: "team-members" });
    const dispatched = events.filter((event) => event.type === "message.sent" && event.payload.message.payload.type === "task.request");
    expect(dispatched).toHaveLength(2);
    expect(dispatched.every((event) => event.globalOffset > created.globalOffset)).toBe(true);
    expect(model.requests).toHaveLength(2);
    expect(model.requests.every((request) => request.laneId.startsWith("team:review:"))).toBe(true);
    expect(model.requests.some((request) => request.laneId === "main" || request.laneId.startsWith("team-reducer:"))).toBe(false);
    expect(await board(team)).toMatchObject({ joinState: "joined", joinSatisfied: true, reductionState: "not-started", presentationState: "pending" });
    expect(events.filter((event) => event.type === "team.joined")).toHaveLength(1);
    expect(onWake).toHaveBeenCalled();
    const notices = await team.beforeMainStep({ step: 1 });
    expect(notices.some((notice) => notice.content.includes("You are the Team Lead"))).toBe(true);
    expect(events.some((event) => event.laneId === "main" && (event.type === "user.message" || event.type === "assistant.message"))).toBe(false);
  });

  it("waits for initial queued and running task IDs without spending model calls or writing", async () => {
    const entered = deferred<void>();
    const release = deferred<ModelResponse>();
    const model = new RecordingModel((request) => {
      if (request.laneId.endsWith(":ui")) { entered.resolve(); return release.promise; }
      return response("Calendar logic checked");
    });
    const { team, ledger, inbox } = fixture({ model });
    const created = await team.create({ teamId: "calendar", members: [
      { memberId: "ui", statement: "Prepare the calendar layout" },
      { memberId: "logic", statement: "Check the calendar logic", dependsOn: ["ui"] },
    ] }, context);
    await entered.promise;
    const uiTask = created.members!.find((item) => item.memberId === "ui")!;
    const logicTask = created.members!.find((item) => item.memberId === "logic")!;
    const waitTool = createTaskWaitTool(team);
    const eventsBefore = await ledger.read({ runId: RUN_ID });
    const inboxBefore = inbox.snapshot();
    const callsBefore = model.requests.length;
    let settledWaits = 0;
    const waits = [uiTask, logicTask].map(async (task) => {
      const result = await waitTool.execute({ teamId: created.teamId, taskId: task.taskId }, context);
      settledWaits += 1;
      return result;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settledWaits).toBe(0);
      expect((await board(team, "calendar")).members).toEqual(expect.arrayContaining([
        expect.objectContaining({ memberId: "ui", status: "running", terminal: false }),
        expect.objectContaining({ memberId: "logic", status: "queued", terminal: false }),
      ]));
      expect(await ledger.read({ runId: RUN_ID })).toEqual(eventsBefore);
      expect(inbox.snapshot()).toEqual(inboxBefore);
      expect(model.requests).toHaveLength(callsBefore);
    } finally {
      release.resolve(response("Calendar layout checked"));
    }
    await team.drain();
    for (const [index, result] of (await Promise.all(waits)).entries()) {
      expect(result.isError).toBe(false);
      const state = JSON.parse(result.content);
      // The later task may yield for UI's report before its own work settles.
      if (index === 1 && state.waiting) expect(state).toMatchObject({ terminal: false, wakeReason: "collaboration" });
      else expect(state).toMatchObject({ terminal: true, waiting: false });
    }
    expect(await team.wait({ teamId: created.teamId, taskId: uiTask.taskId }, context)).toMatchObject({
      status: "completed", outcome: "succeeded", terminal: true, waiting: false,
      result: { taskId: uiTask.taskId, status: "completed", summary: "Calendar layout checked" },
    });
    expect(await team.wait({ teamId: created.teamId, taskId: logicTask.taskId }, context)).toMatchObject({
      status: "completed", outcome: "succeeded", terminal: true, waiting: false,
      result: { taskId: logicTask.taskId, summary: "Calendar logic checked" },
    });
  });

  it("rejects unknown or foreign task IDs without changing either Team", async () => {
    const { team, ledger, inbox, model } = fixture();
    await team.create({ teamId: "calendar", members: [{ memberId: "ui", statement: "Prepare calendar" }] }, context);
    await team.create({ teamId: "other", members: [{ memberId: "ui", statement: "Prepare other work" }] }, context);
    await team.drain();
    const eventsBefore = await ledger.read({ runId: RUN_ID });
    const inboxBefore = inbox.snapshot();
    const callsBefore = model.requests.length;
    for (const taskId of ["ui", "calendar:missing", "calendar:ui:task-1", "other:ui", "team:calendar:ui"]) {
      await expect(team.wait({ teamId: "calendar", taskId }, context)).rejects.toThrow(`Unknown Team task ${taskId}`);
    }
    await expect(team.wait({ teamId: "missing", taskId: "calendar:ui" }, context)).rejects.toThrow("Unknown Team missing");
    await expect(team.wait({ teamId: "calendar", taskId: "calendar:ui" }, { ...context, runId: "foreign" }))
      .rejects.toThrow("another Run");
    await expect(team.wait({ teamId: "calendar", taskId: "calendar:ui" }, { ...context, laneId: "team:other:ui" }))
      .rejects.toThrow("not an active Team member");
    expect(await ledger.read({ runId: RUN_ID })).toEqual(eventsBefore);
    expect(inbox.snapshot()).toEqual(inboxBefore);
    expect(model.requests).toHaveLength(callsBefore);
  });

  it("reuses a settled member lane for a follow-up Task and reports it without copying the transcript", async () => {
    const { team, ledger, model } = fixture();
    await team.create({ teamId: "resident", members: [member("researcher")] }, context);
    await team.drain();
    const initialStatus = await team.wait({ teamId: "resident", taskId: "resident:researcher" }, context);
    const before = model.requests.length;
    const assigned = await team.assign({ teamId: "resident", memberId: "researcher", statement: "Continue with the compatibility check", input: "Use the newly supplied compatibility matrix" }, {
      ...context, operationId: "resident-assign-1",
    });
    expect(assigned).toMatchObject({ taskId: "resident:researcher:task-1", assignmentVersion: 1, status: "queued" });
    await team.drain();
    expect(model.requests.length).toBe(before + 1);
    expect(model.requests.at(-1)?.laneId).toBe("team:resident:researcher");
    expect(model.requests.at(-1)?.messages.map((message) => message.content).join("\n")).toContain("Continue with the compatibility check");
    expect(model.requests.at(-1)?.messages.map((message) => message.content).join("\n")).toContain("Use the newly supplied compatibility matrix");
    const status = await team.wait({ teamId: "resident", taskId: assigned.taskId }, context);
    expect(status).toMatchObject({
      taskId: assigned.taskId, assignmentVersion: 1, status: "review", waiting: false,
      report: { kind: "ready-for-review", result: { taskId: assigned.taskId } },
    });
    expect((await board(team, "resident")).anomalies).toEqual([]);
    expect(await team.wait({ teamId: "resident", taskId: "resident:researcher" }, context)).toEqual(initialStatus);
    const events = await ledger.read({ runId: RUN_ID });
    expect(events.some((event) => (event as unknown as { type?: string }).type === "team.task.assigned")).toBe(true);
    expect(events.some((event) => (event as unknown as { type?: string }).type === "team.run.reported")).toBe(true);
    const duplicate = await team.assign({ teamId: "resident", memberId: "researcher", statement: "Continue with the compatibility check", input: "Use the newly supplied compatibility matrix" }, {
      ...context, operationId: "resident-assign-1",
    });
    expect(duplicate.status).toBe("duplicate");
    const history = await team.history({ teamId: "resident", threadId: `task:${assigned.taskId}` }, context);
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0]?.body).toContain("ready-for-review");

    const next = await team.assign({ teamId: "resident", memberId: "researcher", statement: "Check the final integration" }, {
      ...context, operationId: "resident-assign-2",
    });
    await team.drain();
    expect(next.assignmentVersion).toBe(2);
    expect(model.requests).toHaveLength(before + 2);
    expect((await board(team, "resident")).anomalies).toEqual([]);
  });

  it("rebuilds an unreported resident assignment after a restart", async () => {
    const original = fixture();
    await original.team.create({ teamId: "resident-recovery", members: [member("researcher")] }, context);
    await original.team.drain();
    await original.team.assign({ teamId: "resident-recovery", memberId: "researcher", statement: "Continue after restart" }, {
      ...context, operationId: "resident-recovery-assign",
    });
    await original.team.stop();
    const recoveredInbox = A2AInbox.rehydrate(await original.ledger.read(), { sink: original.ledger, clock: original.clock });
    const recovered = fixture({ ledger: original.ledger, inbox: recoveredInbox, store: original.store, clock: original.clock });
    await recovered.team.restore();
    await recovered.team.drain();
    expect(recovered.model.requests.some((request) => request.laneId === "team:resident-recovery:researcher")).toBe(true);
    expect(await recovered.team.wait({ teamId: "resident-recovery", taskId: "resident-recovery:researcher:task-1" }, context)).toMatchObject({ status: "review" });
  });

  it("repairs an assignment whose task dispatch failed without accepting changed work", async () => {
    const clock = new ManualClock();
    const ledger = new FailResidentTaskDispatchLedger(clock);
    const { team, model } = fixture({ ledger, clock });
    await team.create({ teamId: "dispatch-repair", members: [member("researcher")] }, context);
    await team.drain();
    const request = { teamId: "dispatch-repair", memberId: "researcher", statement: "Run the second task" };
    const assignmentContext = { ...context, operationId: "dispatch-repair-assign" };
    await expect(team.assign(request, assignmentContext)).rejects.toThrow("injected resident dispatch crash");
    await expect(team.assign({ ...request, statement: "Different work" }, assignmentContext)).rejects.toThrow("different work");
    expect(await team.assign(request, assignmentContext)).toMatchObject({ status: "queued", assignmentVersion: 1 });
    await team.drain();
    expect(model.requests).toHaveLength(2);
    expect(await team.wait({ teamId: request.teamId, taskId: "dispatch-repair:researcher:task-1" }, context)).toMatchObject({ status: "review" });
  });

  it("fences an active resident task when the Team is closed", async () => {
    const entered = deferred<void>();
    const release = deferred<ModelResponse>();
    let residentSignal: AbortSignal | undefined;
    const model = new RecordingModel((request, call) => {
      if (call === 1) return response("Initial task finished");
      residentSignal = request.signal;
      entered.resolve();
      return release.promise;
    });
    const { team, ledger } = fixture({ model });
    await team.create({ teamId: "close-resident", members: [member("researcher")] }, context);
    await team.drain();
    await team.assign({ teamId: "close-resident", memberId: "researcher", statement: "Long second task" }, {
      ...context, operationId: "close-resident-assign",
    });
    await entered.promise;
    expect((await board(team, "close-resident")).tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: "close-resident:researcher:task-1", status: "running" }),
    ]));
    await team.close({ teamId: "close-resident" }, context);
    expect(residentSignal?.aborted).toBe(true);
    const closedOffset = await ledger.watermark();
    release.resolve(response("Late result must not be reported"));
    await team.drain();
    expect((await ledger.read({ runId: RUN_ID, afterOffset: closedOffset })).some((event) => (event as unknown as { type: string }).type === "team.run.reported")).toBe(false);
    await expect(team.reduce({ teamId: "close-resident" }, context)).rejects.toThrow("Reduction requires");
  });

  it("assigns readable worker names around explicit names and preserves them through retry and recovery", async () => {
    const original = fixture();
    const request: TeamCreateRequest = { teamId: "named", members: [
      { statement: "Inspect source" },
      member("worker-1"),
      member("worker-3"),
      { statement: "Inspect tests" },
      member("researcher"),
      { statement: "Inspect documentation" },
    ] };
    const created = await original.team.create(request, context);
    const ids = ["worker-2", "worker-1", "worker-3", "worker-4", "researcher", "worker-5"];
    const names = ["worker 2", "worker 1", "worker 3", "worker 4", "researcher", "worker 5"];
    expect(created.members?.map((item) => item.memberId)).toEqual(ids);
    expect(created.members?.map((item) => item.name)).toEqual(names);
    expect(created.members?.map((item) => item.laneId)).toEqual(ids.map((id) => `team:named:${id}`));
    await original.team.drain();
    for (const [index, id] of ids.entries()) {
      const modelRequest = original.model.requests.find((item) => item.laneId === `team:named:${id}`)!;
      expect(modelRequest.systemPrompt).toMatch(new RegExp(`^You are ${names[index]}, a Team member`));
      expect(modelRequest.systemPrompt).toContain("Team Lead, Nausicaa (lane nausicaa)");
      expect(modelRequest.messages.map((item) => item.content).join("\n"))
        .toContain('"laneId":"nausicaa","relation":"owns"');
    }
    const duplicate = await original.team.create(request, context);
    expect(duplicate.members).toEqual(created.members?.map((item) => ({ ...item, status: "duplicate" })));
    await original.team.stop();
    const restoredInbox = A2AInbox.rehydrate(await original.ledger.read(), { sink: original.ledger, clock: original.clock });
    const recovered = fixture({ ...original, inbox: restoredInbox });
    await recovered.team.restore();
    const replayed = await recovered.team.create(request, context);
    expect(replayed.members?.toSorted((left, right) => left.memberId.localeCompare(right.memberId)))
      .toEqual(duplicate.members?.toSorted((left, right) => left.memberId.localeCompare(right.memberId)));
    expect(original.model.requests).toHaveLength(ids.length);
    expect((await original.ledger.read()).filter((event) => event.type === "team.created")).toHaveLength(1);
  });

  it("identifies a nested Team's actual lead and each member without assigning the root identity", async () => {
    const parentLaneId = "team:outer:worker-7";
    const caller = { ...context, laneId: parentLaneId };
    const { team, model } = fixture({ parentLaneId });
    await team.create({ teamId: "nested", members: [member("reviewer")] }, caller);
    await team.drain();
    const request = model.requests.find((item) => item.laneId === "team:nested:reviewer")!;
    expect(request.systemPrompt).toMatch(/^You are reviewer, a Team member/);
    expect(request.systemPrompt).toContain("Team Lead, worker 7 (lane team:outer:worker-7)");
    expect(request.systemPrompt).not.toContain("You are Nausicaa");
    expect(request.systemPrompt).not.toContain("Team Lead, Nausicaa");
    expect(request.messages.map((item) => item.content).join("\n"))
      .toContain('"laneId":"team:outer:worker-7","relation":"owns"');
    await team.reduce({ teamId: "nested" }, caller);
    await team.drain();
    const reduction = model.requests.find((item) => item.laneId === "team-reducer:nested")!;
    expect(reduction.systemPrompt).toMatch(/^You are reducer, the explicitly requested read-only Team reducer/);
    expect(reduction.systemPrompt).toContain("Team Lead, worker 7 (lane team:outer:worker-7)");
    expect(reduction.messages.map((item) => item.content).join("\n"))
      .toContain("Synthesize the Team results for worker 7, the Team Lead");
  });

  it("enforces a lead's capability narrowing and keeps the outer Team channel for a member", async () => {
    const readTool: AgentTool = {
      definition: { name: "read_file", description: "read", parameters: { type: "object", additionalProperties: false } },
      async execute() { return { content: "read", isError: false }; },
    };
    const writeTool: AgentTool = {
      definition: { name: "write_file", description: "write", parameters: { type: "object", additionalProperties: false } },
      async execute() { return { content: "write", isError: false }; },
    };
    const { team, model } = fixture({ tools: [readTool, writeTool] });
    await team.create({
      teamId: "narrowed",
      members: [{
        memberId: "reviewer",
        statement: "Review without mutation",
        capabilities: { tools: ["read_file"], allowNestedTeam: false },
      }],
    }, context);
    await team.drain();
    const request = model.requests.find((item) => item.laneId === "team:narrowed:reviewer");
    expect(request).toBeDefined();
    const names = request!.tools.map((tool) => tool.name);
    expect(names).toContain("read_file");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("team_create");
    expect(names).toContain("team_message");
  });

  it.each([true, false])("preserves parent channels and narrowed tools across restored follow-ups (nested=%s)", async (allowNestedTeam) => {
    const catalog = workspaceCatalog();
    const teamId = "channel-recovery";
    const original = fixture({ ...catalog, model: parentChannelModel(teamId) });
    await original.team.create({ teamId, members: [{
      memberId: "reviewer", statement: "Review the workspace",
      capabilities: { tools: ["read_file"], allowNestedTeam },
    }] }, context);
    await original.team.drain();
    const initialContext = (await board(original.team, teamId)).definition!.members[0]!.task.spawnContext!;
    expect(original.model.requests[0]!.tools.map((tool) => tool.name).toSorted())
      .toEqual(initialContext.tools.map((tool) => tool.name).toSorted());
    expect(initialContext.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["team_message", "team_history"]));
    await original.team.stop();

    const recovered = fixture({
      ...original, ...catalog, model: parentChannelModel(teamId),
      inbox: A2AInbox.rehydrate(await original.ledger.read(), { sink: original.ledger, clock: original.clock }),
    });
    await recovered.team.restore();
    const start = await recovered.ledger.watermark();
    const assigned = await recovered.team.assign({ teamId, memberId: "reviewer", statement: "Continue the review" }, {
      ...context, operationId: "channel-follow-up",
    });
    await recovered.team.drain();
    expect(await recovered.team.wait({ teamId, taskId: assigned.taskId }, context)).toMatchObject({ status: "review" });
    const events = await recovered.ledger.read({ afterOffset: start });
    const assignment = events.find((event) => (event as { type: string }).type === "team.task.assigned") as unknown as { payload: TeamTaskAssignment };
    const names = recovered.model.requests[0]!.tools.map((tool) => tool.name);
    expect(names.toSorted()).toEqual(assignment.payload.task.spawnContext!.tools.map((tool) => tool.name).toSorted());
    expect(names).toEqual(expect.arrayContaining(["read_file", "team_message", "team_history"]));
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("bash");
    for (const name of ["team_create", "child_team_message", "child_team_history"]) expect(names.includes(name)).toBe(allowNestedTeam);
    expect(events.filter((event) => event.type === "tool.failed")).toEqual([]);
    expect(events.filter((event) => event.type === "tool.succeeded")).toHaveLength(2);
    expect(recovered.model.requests.at(-1)!.messages.some((message) => message.role === "tool"
      && message.content.includes("Parent Team channel is available"))).toBe(true);
    for (const tool of catalog.tools) expect(tool.execute).not.toHaveBeenCalled();
    await expect(recovered.team.message({ teamId, body: "Unauthorized" }, { ...context, laneId: "team:other:reviewer" }))
      .rejects.toThrow("not an active Team member");
    await expect(recovered.team.history({ teamId }, { ...context, runId: "foreign-run" })).rejects.toThrow("another Run");
  });

  it.each([true, false])("repairs only parent channel access for persisted deficient assignments (nested=%s)", async (allowNestedTeam) => {
    const catalog = workspaceCatalog();
    const teamId = "legacy-channel";
    const original = fixture(catalog);
    await original.team.create({ teamId, members: [{
      memberId: "reviewer", statement: "Review the workspace",
      capabilities: { tools: ["read_file"], allowNestedTeam },
    }] }, context);
    await original.team.drain();
    const assigned = await original.team.assign({ teamId, memberId: "reviewer", statement: "Continue after restart" }, {
      ...context, operationId: "legacy-channel-follow-up",
    });
    await original.team.stop();

    const originalEvents = await original.ledger.read();
    const dispatch = originalEvents.find((event) => event.type === "message.sent"
      && event.payload.message.payload.type === "task.request" && event.payload.message.payload.taskId === assigned.taskId)!;
    // Reproduce the old durable assignment and envelope, stopping before the
    // member executes. Existing records are replayed into an isolated Ledger.
    const legacyEvents = structuredClone(originalEvents.filter((event) => event.globalOffset <= dispatch.globalOffset));
    for (const event of legacyEvents) {
      const assignment = (event as { type: string }).type === "team.task.assigned"
        ? (event as unknown as { payload: TeamTaskAssignment }).payload.task : undefined;
      const task = assignment ?? (event.type === "message.sent" && event.payload.message.payload.type === "task.request"
        && event.payload.message.payload.taskId === assigned.taskId ? event.payload.message.payload : undefined);
      if (task?.spawnContext === undefined) continue;
      task.spawnContext.tools = task.spawnContext.tools.filter((tool) => !["team_message", "team_history"].includes(tool.name));
      task.spawnContext.laneManifest.capabilities = task.spawnContext.laneManifest.capabilities.filter((tool) => !["team_message", "team_history"].includes(tool.name));
    }
    let sequence = 0;
    const ledger = new MemoryLedger({ clock: original.clock, createEventId: () => legacyEvents[sequence++]?.eventId ?? `recovered-${sequence}` });
    for (const event of legacyEvents) await ledger.append(event);
    const durableAssignment = (await ledger.read()).find((event) => (event as { type: string }).type === "team.task.assigned")!;
    const legacyContext = (durableAssignment as unknown as { payload: TeamTaskAssignment }).payload.task.spawnContext!;
    expect(legacyContext.tools.some((tool) => ["team_message", "team_history"].includes(tool.name))).toBe(false);
    const start = await ledger.watermark();
    const recovered = fixture({
      ...catalog, ledger, store: original.store, clock: original.clock, model: parentChannelModel(teamId),
      inbox: A2AInbox.rehydrate(await ledger.read(), { sink: ledger, clock: original.clock }),
    });
    await recovered.team.restore();
    await recovered.team.drain();
    expect(await recovered.team.wait({ teamId, taskId: assigned.taskId }, context)).toMatchObject({ status: "review" });
    const names = recovered.model.requests[0]!.tools.map((tool) => tool.name);
    expect(names.toSorted()).toEqual([...legacyContext.tools.map((tool) => tool.name), "team_message", "team_history"].toSorted());
    expect(names).toContain("read_file");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("bash");
    for (const name of ["team_create", "child_team_message", "child_team_history"]) expect(names.includes(name)).toBe(allowNestedTeam);
    const events = await ledger.read({ afterOffset: start });
    expect(events.filter((event) => event.type === "tool.failed")).toEqual([]);
    expect(events.filter((event) => event.type === "tool.succeeded")).toHaveLength(2);
    expect(recovered.model.requests.at(-1)!.messages.some((message) => message.role === "tool"
      && message.content.includes("Parent Team channel is available"))).toBe(true);
    expect((await ledger.read()).find((event) => event.eventId === durableAssignment.eventId)).toEqual(durableAssignment);
    for (const tool of catalog.tools) expect(tool.execute).not.toHaveBeenCalled();
  });

  it("retains succeeded, partial, and failed outcomes as distinct facts at join", async () => {
    const model = new RecordingModel((request) => {
      if (request.laneId.endsWith(":failed")) throw new Error("Evidence source unavailable");
      return response(`${request.laneId} result`, request.laneId.endsWith(":partial") ? "length" : "stop");
    });
    const { team, ledger } = fixture({ model });
    await team.create({ teamId: "review", members: [member("success"), member("partial"), member("failed")] }, context);
    await team.drain();
    const state = await board(team);
    expect(state.joinSatisfied).toBe(true);
    expect(Object.fromEntries(state.members.map((item) => [item.memberId, item.outcome])))
      .toEqual({ failed: "failed", partial: "partial", success: "succeeded" });
    expect(state.members.every((item) => item.execution === "terminal" && item.terminal)).toBe(true);
    expect(state.members.find((item) => item.memberId === "partial")?.result?.status).toBe("partial");
    expect(state.members.find((item) => item.memberId === "failed")?.failure?.reason).toContain("Evidence source unavailable");
    const eventsBeforeWait = await ledger.read({ runId: RUN_ID });
    for (const initial of state.members) {
      expect(await team.wait({ teamId: "review", taskId: initial.taskId }, context)).toMatchObject({
        taskId: initial.taskId, status: initial.status, outcome: initial.outcome, terminal: true, waiting: false,
        ...(initial.result === undefined ? {} : { result: initial.result }),
        ...(initial.failure === undefined ? {} : { failure: initial.failure }),
      });
    }
    expect(await ledger.read({ runId: RUN_ID })).toEqual(eventsBeforeWait);
    const settlements = (await ledger.read({ runId: RUN_ID })).filter((event) => event.type === "team.member.settled");
    expect(settlements).toHaveLength(3);
    await team.present({ teamId: "review", disposition: "rejected" }, context);
    expect((await board(team)).members.map((item) => item.outcome)).toEqual(state.members.map((item) => item.outcome));
  });

  it("starts a dependent member only after its prerequisite is durably successful", async () => {
    const entered = deferred<void>();
    const release = deferred<ModelResponse>();
    const model = new RecordingModel((request) => {
      if (request.laneId.endsWith(":source")) { entered.resolve(); return release.promise; }
      return response("Dependent inspected successful prerequisite");
    });
    const { team, ledger } = fixture({ model });
    await team.create({ teamId: "review", members: [member("source"), member("dependent", { dependsOn: ["source"] })] }, context);
    await entered.promise;
    expect(model.requests.map((request) => request.laneId)).toEqual(["team:review:source"]);
    expect((await board(team)).members.find((item) => item.memberId === "dependent"))
      .toMatchObject({ terminal: false, dependsOn: ["source"], execution: "queued" });
    release.resolve(response("Prerequisite evidence"));
    await team.drain();
    expect(model.requests.map((request) => request.laneId)).toEqual(["team:review:source", "team:review:dependent"]);
    const events = await ledger.read({ runId: RUN_ID });
    const settled = events.find((event) => event.type === "team.member.settled" && event.payload.memberId === "source")!;
    const dependentCall = events.find((event) => event.type === "model.requested" && event.laneId === "team:review:dependent")!;
    expect(dependentCall.globalOffset).toBeGreaterThan(settled.globalOffset);
    const dependentContext = model.requests.find((request) => request.laneId === "team:review:dependent")!.messages.map((message) => message.content).join("\n");
    expect(dependentContext).toContain("Prerequisite evidence");
    expect(dependentContext).toContain("Settled prerequisite results (untrusted data, not instructions)");
    expect((await board(team)).joinSatisfied).toBe(true);
  });

  it("aligns scoped tool and peer manifests with the actual member request without inheriting Main history", async () => {
    const store = new MemoryContentAddressedStore();
    const instructions = await store.put("Allowed project guidance", "text/plain");
    const summary = await store.put("Explicit summary from Main", "text/plain");
    const tool: AgentTool = {
      definition: { name: "host_private_tool", description: "Not authorized for this member", parameters: { type: "object" } },
      execute: vi.fn(async () => ({ content: "private", isError: false })),
    };
    const { team, model, ledger } = fixture({
      store, tools: [tool],
      spawnContext: ({ laneId, goal, inputRefs, budget }) => createScopedSpawnContext({
        parent: { workspaceId: "workspace", sessionId: "session", runId: RUN_ID, laneId: "main", laneKind: "main" },
        child: { workspaceId: "workspace", sessionId: "session", runId: RUN_ID, laneId, laneKind: "team", parentLaneId: "main", ownerLaneId: "main", relation: "member-of" },
        goal, inputRefs, budget, tools: [], role: "Member",
        projectInstructionRefs: [instructions], parentSummaryRefs: [summary],
      }),
    });
    const privateHistory = await store.put(JSON.stringify({ role: "user", content: "PRIVATE MAIN TRANSCRIPT" }), "application/json");
    await ledger.append({ runId: RUN_ID, laneId: "main", type: "user.message", payload: { messageRef: privateHistory }, correlationId: RUN_ID, idempotencyKey: "private-main-history", visibility: "run" });
    await team.create({ teamId: "review", members: [member("a"), member("b")] }, context);
    await team.drain();
    const definition = (await board(team)).definition!;
    for (const admitted of definition.members) {
      const request = model.requests.find((item) => item.laneId === admitted.laneId)!;
      const manifest = admitted.task.spawnContext!;
      expect(new Set(request.tools.map((item) => item.name))).toEqual(new Set(manifest.tools.map((item) => item.name)));
      expect(manifest.tools.some((item) => item.name === "host_private_tool")).toBe(false);
      expect(manifest.laneManifest.targets?.map((target) => target.laneId))
        .toEqual(["main", admitted.memberId === "a" ? "team:review:b" : "team:review:a"]);
      const contents = request.messages.map((item) => item.content).join("\n");
      expect(contents).toContain("Allowed project guidance");
      expect(contents).toContain("Explicit summary from Main");
      expect(contents).not.toContain("PRIVATE MAIN TRANSCRIPT");
    }
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("enforces the reducer read-only catalog even when member tools include privileged or unclassified custom tools", async () => {
    const tool = (name: string): AgentTool => ({
      definition: { name, description: name, parameters: { type: "object" } },
      execute: vi.fn(async () => ({ content: name, isError: false })),
    });
    const read = annotateTool(tool("read_evidence"), { effect: "read" });
    const write = annotateTool(tool("mutate_workspace"), { effect: "write" });
    const external = annotateTool(tool("send_external"), { effect: "external" });
    const unknown = tool("unclassified_host_tool");
    const model = new RecordingModel((request, call) => {
      if (request.laneId.startsWith("team-reducer:") && call === 1) {
        return { ...response("Attempt unauthorized mutation", "toolUse"), toolCalls: [{ id: "reducer-write", name: "mutate_workspace", arguments: {} }] };
      }
      return response("Evidence report");
    });
    const { team } = fixture({ model, tools: [read, write, external, unknown] });
    await team.create({ teamId: "review", members: [member("source")] }, context);
    await team.drain();
    await team.reduce({ teamId: "review" }, context);
    await team.drain();
    const reducerRequest = model.requests.find((request) => request.laneId === "team-reducer:review")!;
    expect(reducerRequest.tools.map((item) => item.name)).toEqual(["read_evidence", "agent_awareness", "agent_message"]);
    expect(reducerRequest.systemPrompt).toContain("explicitly requested read-only Team reducer");
    const reducer = (await board(team)).reducer!;
    expect(reducer.task.spawnContext?.tools.map((item) => item.name).toSorted())
      .toEqual(reducerRequest.tools.map((item) => item.name).toSorted());
    expect(reducer.task.spawnContext?.child).toMatchObject({ laneId: "team-reducer:review", laneKind: "worker", relation: "delegates" });
    expect(write.execute).not.toHaveBeenCalled();
    expect(external.execute).not.toHaveBeenCalled();
    expect(unknown.execute).not.toHaveBeenCalled();
  });

  it.each(["failed", "partial"])("does not execute a dependent after a %s prerequisite", async (outcome) => {
    const model = new RecordingModel(() => {
      if (outcome === "failed") throw new Error("Prerequisite could not execute");
      return response("Incomplete evidence", "length");
    });
    const { team } = fixture({ model });
    await team.create({ teamId: "review", members: [member("source"), member("dependent", { dependsOn: ["source"] })] }, context);
    await team.drain();
    expect(model.requests.every((request) => request.laneId === "team:review:source")).toBe(true);
    const state = await board(team);
    expect(state.joinSatisfied).toBe(true);
    expect(state.members.find((item) => item.memberId === "source")?.outcome).toBe(outcome);
    expect(state.members.find((item) => item.memberId === "dependent"))
      .toMatchObject({ terminal: true, outcome: "failed", reason: expect.stringContaining("Dependency source did not succeed") });
  });

  it("recovers the complete definition after a crash before the first dispatch without extending its deadline", async () => {
    const clock = new ManualClock();
    const ledger = new FailFirstTaskDispatchLedger(clock);
    const original = fixture({ ledger, clock });
    const request: TeamCreateRequest = { teamId: "review", members: [member("source"), member("dependent", { dependsOn: ["source"] })] };
    await expect(original.team.create(request, context)).rejects.toThrow("injected dispatch crash");
    const persisted = await ledger.read({ runId: RUN_ID });
    expect(persisted.filter((event) => event.type === "team.created")).toHaveLength(1);
    expect(persisted.some((event) => event.type === "message.sent")).toBe(false);
    expect(original.model.requests).toHaveLength(0);
    const definition = persisted.find((event) => event.type === "team.created")!;
    await original.team.stop();
    clock.advance(500);
    const recovered = fixture({
      ledger, clock, store: original.store, model: original.model,
      inbox: A2AInbox.rehydrate(persisted, { sink: ledger, clock }),
    });
    await recovered.team.restore();
    await recovered.team.drain();
    const state = await board(recovered.team);
    expect(state.definition?.deadline).toBe(definition.payload.deadline);
    expect(state.members).toHaveLength(2);
    expect(state.members.every((item) => item.outcome === "succeeded")).toBe(true);
    expect(state.joinSatisfied).toBe(true);
    expect(original.model.requests).toHaveLength(2);
    expect((await ledger.read({ runId: RUN_ID })).filter((event) => event.type === "team.created")).toHaveLength(1);
  });

  it("recognizes matching create aliases across restart and rejects changed work", async () => {
    const original = fixture();
    const request: TeamCreateRequest = { teamId: "review", members: [member("source")] };
    await original.team.create(request, context);
    await original.team.drain();
    const duplicate = await original.team.create({ teamId: "review", branches: [{ ...member("source"), branchId: "source" }] }, context);
    expect(duplicate.branches).toEqual([{ branchId: "source", laneId: "team:review:source", status: "duplicate" }]);
    await original.team.stop();
    const events = await original.ledger.read({ runId: RUN_ID });
    const recovered = fixture({
      ...original,
      inbox: A2AInbox.rehydrate(events, { sink: original.ledger, clock: original.clock }),
    });
    await recovered.team.restore();
    const replayed = await recovered.team.create(request, context);
    expect(replayed.members?.[0]).toMatchObject({ memberId: "source", taskId: "review:source", status: "duplicate" });
    await recovered.team.drain();
    expect(original.model.requests).toHaveLength(1);
    await expect(recovered.team.create({ teamId: "review", members: [member("source", { statement: "Different work" })] }, context)).rejects.toThrow(/different.*requests/);
    const finalEvents = await original.ledger.read({ runId: RUN_ID });
    expect(finalEvents.filter((event) => event.type === "team.created")).toHaveLength(1);
    expect(finalEvents.filter((event) => event.type === "team.member.settled")).toHaveLength(1);
    expect(finalEvents.filter((event) => event.type === "team.joined")).toHaveLength(1);
  });

  it("does not join from lane status alone, cancels durably, and fences late model completion after restart", async () => {
    const entered = deferred<void>();
    const release = deferred<ModelResponse>();
    const model = new RecordingModel(() => { entered.resolve(); return release.promise; });
    const original = fixture({ model });
    await original.team.create({ teamId: "review", members: [member("slow")] }, context);
    await entered.promise;
    await original.ledger.append({
      runId: RUN_ID, laneId: "team:review:slow", type: "lane.status", payload: { status: "completed", reason: "Liveness-only completion" },
      correlationId: RUN_ID, idempotencyKey: "status-without-settlement", visibility: "run", occurredAt: original.clock.now().toISOString(),
    });
    expect(await board(original.team)).toMatchObject({ joinSatisfied: false, members: [{ terminal: false }] });
    expect((await board(original.team)).members[0]).toMatchObject({ status: "unknown", terminal: false });
    await original.team.cancel({ teamId: "review", reason: "Lead cancelled the review" }, context);
    const state = await board(original.team);
    expect(state).toMatchObject({ joinState: "cancelled", cancellationRequested: true, members: [{ outcome: "cancelled", terminal: true }] });
    expect(await original.team.wait({ teamId: "review", taskId: "review:slow" }, context))
      .toMatchObject({ status: "cancelled", outcome: "cancelled", terminal: true, waiting: false, reason: "Lead cancelled the review" });
    const watermark = await original.ledger.watermark();
    release.resolve(response("Late completion must not win"));
    await original.team.drain();
    expect(await original.ledger.watermark()).toBe(watermark);
    await original.team.stop();
    const events = await original.ledger.read({ runId: RUN_ID });
    const recovered = fixture({ ...original, inbox: A2AInbox.rehydrate(events, { sink: original.ledger, clock: original.clock }) });
    await recovered.team.restore();
    await recovered.team.drain();
    expect((await board(recovered.team)).members[0]?.outcome).toBe("cancelled");
    expect(model.requests).toHaveLength(1);
    expect(await recovered.team.messageTargets("team:review:slow")).toEqual([]);
    const finalEvents = await original.ledger.read({ runId: RUN_ID });
    expect(finalEvents.filter((event) => event.type === "team.cancelled")).toHaveLength(1);
    expect(finalEvents.filter((event) => event.type === "team.member.settled")).toHaveLength(1);
    expect(finalEvents.some((event) => event.type === "team.joined")).toBe(false);
  });

  it("settles a best-effort deadline with available outcomes and abandons unfinished work", async () => {
    const entered = deferred<void>();
    const release = deferred<ModelResponse>();
    const model = new RecordingModel((request) => {
      if (request.laneId.endsWith(":slow")) { entered.resolve(); return release.promise; }
      return response("Available evidence");
    });
    const { team, clock, ledger } = fixture({ model });
    const deadline = new Date(clock.now().getTime() + 1_000).toISOString();
    await team.create({ teamId: "review", members: [member("fast"), member("slow")], joinPolicy: "deadline-best-effort", deadline }, context);
    await entered.promise;
    await expect.poll(async () => (await board(team)).members.find((item) => item.memberId === "fast")?.outcome).toBe("succeeded");
    clock.advance(1_001);
    expect(await board(team)).toMatchObject({ joinState: "deadline-settled", joinSatisfied: true });
    release.resolve(response("Late evidence"));
    await team.drain();
    expect(Object.fromEntries((await board(team)).members.map((item) => [item.memberId, item.outcome])))
      .toEqual({ fast: "succeeded", slow: "abandoned" });
    const joined = (await ledger.read({ runId: RUN_ID })).find((event) => event.type === "team.joined")!;
    expect(joined.payload.reason).toBe("deadline-best-effort");
  });

  it("uses Main synthesis by default and records Main acceptance without another model", async () => {
    const { team, ledger, model } = fixture();
    await team.create({ teamId: "review", members: [member("source")] }, context);
    await team.drain();
    expect((await board(team)).reductionState).toBe("not-started");
    expect(model.requests).toHaveLength(1);
    await team.present({ teamId: "review", disposition: "accepted" }, context);
    await team.present({ teamId: "review", disposition: "accepted" }, context);
    expect(await board(team)).toMatchObject({ presentationState: "accepted", reductionState: "not-started" });
    expect(model.requests).toHaveLength(1);
    await expect(team.present({ teamId: "review", disposition: "rejected" }, context)).rejects.toThrow("different presentation decision");
    await expect(team.reduce({ teamId: "review" }, context)).rejects.toThrow("unpresented Team");
    expect((await ledger.read({ runId: RUN_ID })).filter((event) => event.type === "team.presented")).toHaveLength(1);
  });

  it("closes optional work when the required members reach the join boundary", async () => {
    const optionalEntered = deferred<void>();
    const optionalResult = deferred<ModelResponse>();
    const model = new RecordingModel(async (request) => {
      if (request.laneId.endsWith(":optional")) { optionalEntered.resolve(); return optionalResult.promise; }
      await optionalEntered.promise;
      return response("Required evidence is ready");
    });
    const { team } = fixture({ model });
    await team.create({ teamId: "review", members: [member("required"), member("optional", { required: false })] }, context);
    await team.drain();
    expect(await board(team)).toMatchObject({
      joinState: "joined", joinSatisfied: true,
      members: [
        { memberId: "optional", required: false, outcome: "cancelled", terminal: true },
        { memberId: "required", required: true, outcome: "succeeded", terminal: true },
      ],
    });
    optionalResult.resolve(response("Optional result arrived late"));
    await team.drain();
    expect((await board(team)).members.find((item) => item.memberId === "optional")?.outcome).toBe("cancelled");
  });

  it("joins from a persisted outcome when its transport result is lost and restores without repeating the model", async () => {
    const clock = new ManualClock();
    const ledger = new FailFirstTaskResultLedger(clock);
    const original = fixture({ ledger, clock });
    await original.team.create({ teamId: "review", members: [member("source", { maxWallClockMs: 60_000 })] }, context);
    await original.team.drain();
    expect(await board(original.team)).toMatchObject({ joinSatisfied: true, members: [{ outcome: "succeeded" }] });
    expect(original.model.requests).toHaveLength(1);
    expect(original.inbox.snapshot().records.some((record) => record.message.payload.type === "task.failed")).toBe(false);
    await original.team.stop();
    clock.advance(30_001);
    const recovered = fixture({
      ...original,
      inbox: A2AInbox.rehydrate(await ledger.read({ runId: RUN_ID }), { sink: ledger, clock }),
    });
    await recovered.team.restore();
    await recovered.team.drain();
    expect(original.model.requests).toHaveLength(1);
    expect(await board(recovered.team)).toMatchObject({ joinSatisfied: true, members: [{ outcome: "succeeded" }] });
    const events = await ledger.read({ runId: RUN_ID });
    expect(events.filter((event) => event.type === "team.member.settled")).toHaveLength(1);
    expect(events.filter((event) => event.type === "team.joined")).toHaveLength(1);
    expect(recovered.inbox.snapshot().records.filter((record) => record.message.payload.type === "task.result")).toHaveLength(1);
  });

  it("starts an explicit reducer after join and prevents presentation until its outcome settles", async () => {
    const reducerEntered = deferred<void>();
    const reduction = deferred<ModelResponse>();
    const model = new RecordingModel((request) => {
      if (request.laneId.startsWith("team-reducer:")) { reducerEntered.resolve(); return reduction.promise; }
      return response("Member evidence for synthesis");
    });
    const { team, ledger } = fixture({ model });
    await team.create({ teamId: "review", members: [member("source")] }, context);
    await team.drain();
    expect(await team.reduce({ teamId: "review", statement: "Summarize evidence and uncertainty" }, context))
      .toMatchObject({ laneId: "team-reducer:review", status: "queued" });
    await reducerEntered.promise;
    expect((await board(team)).reductionState).toBe("running");
    await expect(team.present({ teamId: "review", disposition: "accepted" }, context)).rejects.toThrow(/finish any reduction/);
    reduction.resolve(response("Synthesized evidence and open questions"));
    await team.drain();
    expect(await board(team)).toMatchObject({ reductionState: "completed", presentationState: "pending", reduction: { outcome: "succeeded" } });
    const reducerRequest = model.requests.find((request) => request.laneId === "team-reducer:review")!;
    expect(reducerRequest.messages.map((message) => message.content).join("\n")).toContain("Member evidence for synthesis");
    expect(reducerRequest.tools.some((tool) => ["team_create", "team_present", "write_file", "bash"].includes(tool.name))).toBe(false);
    await team.reduce({ teamId: "review" }, context);
    expect(model.requests).toHaveLength(2);
    await team.present({ teamId: "review", disposition: "accepted" }, context);
    const events = await ledger.read({ runId: RUN_ID });
    expect(events.filter((event) => event.type === "team.reduction.requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "team.reduced")).toHaveLength(1);
    expect((await board(team)).presentationState).toBe("accepted");
  });

  it("keeps reducer tasks distinct from a member named reduction and a Team named team-reducer", async () => {
    const model = new RecordingModel((request) => response(request.laneId === "team-reducer:review"
      ? "Reducer synthesis from both reports"
      : `${request.laneId} member evidence`));
    const { team, inbox } = fixture({ model });
    await team.create({ teamId: "review", members: [member("reduction")] }, context);
    await team.create({ teamId: "team-reducer", members: [member("review")] }, context);
    await team.drain();
    await team.reduce({ teamId: "review" }, context);
    await team.drain();
    const requests = inbox.snapshot().records.filter((record) => record.message.payload.type === "task.request");
    const taskIds = requests.map((record) => record.message.payload.type === "task.request" ? record.message.payload.taskId : "");
    expect(taskIds).toHaveLength(3);
    expect(new Set(taskIds)).toEqual(new Set(["review:reduction", "team-reducer:review", "team:review:reduction"]));
    expect(model.requests).toHaveLength(3);
    expect(await board(team)).toMatchObject({
      members: [{ memberId: "reduction", taskId: "review:reduction", outcome: "succeeded", result: { summary: "team:review:reduction member evidence" } }],
      reductionState: "completed", reduction: { outcome: "succeeded", result: { taskId: "team:review:reduction", summary: "Reducer synthesis from both reports" } },
    });
    expect((await board(team, "team-reducer")).members[0]?.taskId).toBe("team-reducer:review");
  });

  it.each([
    { maxAttempts: undefined, content: "", expectedCalls: 3 },
    { maxAttempts: undefined, content: " \n\t", expectedCalls: 3 },
    { maxAttempts: 2, content: "", expectedCalls: 2 },
    { maxAttempts: 3, content: "", expectedCalls: 3 },
  ])("keeps reducers unlimited by default and honors explicit host attempts: %j", async ({ maxAttempts, content, expectedCalls }) => {
    const tool = annotateTool({
      definition: { name: "read_evidence", description: "Read evidence", parameters: { type: "object", properties: {}, additionalProperties: false } },
      execute: vi.fn(async () => ({ content: "Verified subtotal 44, shipping 6, discount 4", isError: false })),
    }, { effect: "read" });
    const model = new RecordingModel((request, call) => {
      if (!request.laneId.startsWith("team-reducer:")) return response("Member evidence for synthesis");
      if (call <= 2) return { ...response(content, "toolUse"), toolCalls: [{ id: `read-${call}`, name: "read_evidence", arguments: {} }] };
      return response("Evidence checked: checkout total is 46");
    });
    const { team, ledger, inbox } = fixture({ model, tools: [tool] });
    await team.create({ teamId: "review", members: [member("source")] }, context);
    await team.drain();
    await team.reduce({ teamId: "review", ...(maxAttempts === undefined ? {} : { maxAttempts }) }, context);
    await team.drain();

    const state = await board(team);
    expect(state.reducer?.task.budget.maxAttempts).toBe(maxAttempts);
    expect(state.reducer?.task.spawnContext?.budget.maxAttempts).toBe(maxAttempts);
    expect(model.requests.filter((request) => request.laneId.startsWith("team-reducer:"))).toHaveLength(expectedCalls);
    if (maxAttempts === 2) {
      expect(state.reduction).toMatchObject({ outcome: "failed", failure: {
        reason: expect.stringContaining("step budget exhausted without a non-empty report"), retryable: false,
        evidenceRefs: state.reducer!.task.inputRefs.map((ref) => ref.contentHash),
      } });
      expect(state.reduction).not.toHaveProperty("result");
      expect(inbox.snapshot().records.some((record) => record.message.from === state.reducer?.laneId && record.message.payload.type === "task.result")).toBe(false);
    } else {
      expect(state.reduction).toMatchObject({ outcome: "succeeded", result: { status: "completed", summary: "Evidence checked: checkout total is 46" } });
    }
    const events = await ledger.read({ runId: RUN_ID });
    expect(events.filter((event) => event.type === "team.reduced")).toHaveLength(1);
    expect(events.find((event) => event.type === "team.reduction.requested")?.payload.reducer.task.budget.maxAttempts).toBe(maxAttempts);
  });

  it.each([0, 1.5, MAX_TASK_ATTEMPTS + 1])("rejects an invalid direct reducer attempt allowance before admission: %j", async (maxAttempts) => {
    const { team, ledger } = fixture();
    await team.create({ teamId: "review", members: [member("source")] }, context);
    await team.drain();
    const watermark = await ledger.watermark();
    await expect(team.reduce({ teamId: "review", maxAttempts }, context)).rejects.toThrow("maxAttempts");
    expect(await ledger.watermark()).toBe(watermark);
    expect((await board(team)).reducer).toBeUndefined();
  });

  it.each([1, 2])("checks peer messages arriving during a final model request within a %i-attempt allowance", async (maxAttempts) => {
    const aEntered = deferred<void>();
    const finalA = deferred<ModelResponse>();
    const model = new RecordingModel(async (request, call) => {
      if (request.laneId.endsWith(":a")) {
        if (call === 1) { aEntered.resolve(); return finalA.promise; }
        return response("A incorporated B's late evidence");
      }
      if (call === 1) {
        await aEntered.promise;
        return { ...response("Send evidence while A is generating", "toolUse"), toolCalls: [
          { id: "late-peer-evidence", name: "agent_message", arguments: { target: "team:review:a", kind: "inform", text: "Late peer evidence: shipping is 6" } },
        ] };
      }
      finalA.resolve(response("A's initial report was generated before peer evidence"));
      return response("B sent its evidence");
    });
    const { team, ledger, inbox } = fixture({ model });
    await team.create({ teamId: "review", members: [member("a", { maxAttempts }), member("b", { maxAttempts: 2 })] }, context);
    await team.drain();

    const aRequests = model.requests.filter((request) => request.laneId === "team:review:a");
    expect(aRequests).toHaveLength(maxAttempts);
    const message = inbox.snapshot().records.find((record) => record.message.payload.type === "message.inform"
      && record.message.from === "team:review:b" && record.message.to === "team:review:a")!;
    const events = await ledger.read({ runId: RUN_ID });
    const consumed = events.filter((event) => event.type === "step.completed" && event.laneId === "team:review:a"
      && event.payload.boundaryMessageIds?.includes(message.message.messageId));
    if (maxAttempts === 2) {
      expect(aRequests[1]?.messages.map((item) => item.content).join("\n")).toContain("Late peer evidence: shipping is 6");
      expect(consumed).toHaveLength(1);
      expect(message.status).toBe("handled");
      expect((await board(team)).members.find((item) => item.memberId === "a")?.outcome).toBe("succeeded");
    } else {
      expect(consumed).toHaveLength(0);
      expect(message.status).toBe("pending");
      expect((await board(team)).members.find((item) => item.memberId === "a")?.outcome).toBe("partial");
    }
    expect(await team.messageTargets("main")).not.toContain("team:review:a");
  });

  it("delivers direct bidirectional peer A2A at member boundaries while both members are working", async () => {
    const aSent = deferred<void>();
    const bSent = deferred<void>();
    const barrierTool: AgentTool = {
      definition: { name: "read_file", description: "Read synchronized test evidence", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
      async execute(arguments_) {
        await (arguments_.path === "wait-a" ? aSent.promise : bSent.promise);
        return { content: "Peer delivery committed", isError: false };
      },
    };
    const model = new RecordingModel((request, laneCall) => {
      if (request.laneId.endsWith(":a")) {
        if (laneCall === 1) return { ...response("Contacting peer", "toolUse"), toolCalls: [{ id: "a-to-b", name: "agent_message", arguments: { target: "team:review:b", text: "A evidence: auth requires a nonce", kind: "progress" } }] };
        if (laneCall === 2) {
          aSent.resolve();
          return { ...response("Waiting for B", "toolUse"), toolCalls: [{ id: "a-waits", name: "read_file", arguments: { path: "wait-b" } }] };
        }
        return response("A reviewed the peer reply");
      }
      if (laneCall === 1) return { ...response("Waiting for A", "toolUse"), toolCalls: [{ id: "b-waits", name: "read_file", arguments: { path: "wait-a" } }] };
      if (laneCall === 2) return { ...response("Replying to peer", "toolUse"), toolCalls: [{ id: "b-to-a", name: "agent_message", arguments: { target: "team:review:a", text: "B evidence: nonce compatibility checked", kind: "inform" } }] };
      bSent.resolve();
      return response("B finished peer review");
    });
    const { team, inbox, ledger } = fixture({ model, tools: [barrierTool] });
    await team.create({ teamId: "review", members: [member("a"), member("b")] }, context);
    await team.drain();
    expect((await board(team)).members.every((item) => item.outcome === "succeeded")).toBe(true);
    const peerMessages = inbox.snapshot().records.filter((record) => record.message.from.startsWith("team:review:")
      && record.message.to.startsWith("team:review:") && record.message.payload.type === "message.inform");
    expect(peerMessages).toHaveLength(2);
    expect(peerMessages.every((record) => record.status === "handled")).toBe(true);
    const aContext = model.requests.filter((request) => request.laneId === "team:review:a").flatMap((request) => request.messages.map((message) => message.content)).join("\n");
    const bContext = model.requests.filter((request) => request.laneId === "team:review:b").flatMap((request) => request.messages.map((message) => message.content)).join("\n");
    expect(aContext).toContain("B evidence: nonce compatibility checked");
    expect(bContext).toContain("A evidence: auth requires a nonce");
    expect((await ledger.read({ runId: RUN_ID })).some((event) => event.laneId === "main" && event.type === "model.requested")).toBe(false);
  });

  it("enforces lead-only routing and rejects lifecycle controls from a teammate", async () => {
    const bothEntered = deferred<void>();
    const release = deferred<ModelResponse>();
    let entered = 0;
    const model = new RecordingModel(() => { if (++entered === 2) bothEntered.resolve(); return release.promise; });
    const { team } = fixture({ model });
    await team.create({ teamId: "review", members: [member("a"), member("b")], peerMessaging: "lead-only" }, context);
    await bothEntered.promise;
    expect(await team.messageTargets("team:review:a")).toEqual(["main"]);
    expect(await team.messageTargets("team:other:a")).toEqual([]);
    expect(await team.messageTargets("main")).toEqual(["team:review:a", "team:review:b"]);
    await expect(team.cancel({ teamId: "review" }, { ...context, laneId: "team:review:a" })).rejects.toThrow("bound to lane nausicaa");
    await expect(team.present({ teamId: "review", disposition: "accepted" }, context)).rejects.toThrow("must join");
    const forbidden = await team.createMessageTool().execute({ target: "team:other:a", text: "must not cross membership" }, context);
    expect(forbidden.isError).toBe(true);
    release.resolve(response("Finished after routing checks"));
    await team.drain();
  });
});

class FailFirstTaskDispatchLedger extends MemoryLedger {
  private failed = false;
  constructor(clock: ManualClock) { super({ clock }); }

  override async append<K extends EventType>(input: AppendEvent<K>) {
    if (!this.failed && input.type === "message.sent" && "message" in input.payload && input.payload.message.payload.type === "task.request") {
      this.failed = true;
      throw new Error("injected dispatch crash");
    }
    return super.append(input);
  }
}

class FailFirstTaskResultLedger extends MemoryLedger {
  private failed = false;
  constructor(clock: ManualClock) { super({ clock }); }

  override async append<K extends EventType>(input: AppendEvent<K>) {
    if (!this.failed && input.type === "message.sent" && "message" in input.payload && input.payload.message.payload.type === "task.result") {
      this.failed = true;
      throw new Error("injected result transport loss");
    }
    return super.append(input);
  }
}

class FailResidentTaskDispatchLedger extends MemoryLedger {
  private failed = false;
  constructor(clock: ManualClock) { super({ clock }); }

  override async append<K extends EventType>(input: AppendEvent<K>) {
    if (!this.failed && input.type === "message.sent" && "message" in input.payload
      && input.payload.message.payload.type === "task.request"
      && input.payload.message.payload.taskId.endsWith(":task-1")) {
      this.failed = true;
      throw new Error("injected resident dispatch crash");
    }
    return super.append(input);
  }
}
