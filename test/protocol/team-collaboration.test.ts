import { afterEach, describe, expect, it, vi } from "vitest";

import { A2AInbox } from "../../src/a2a/inbox.js";
import type { AppendEvent, EventType } from "../../src/domain/events.js";
import type { AgentTool, ModelPort, ModelRequest, ModelResponse, ToolExecutionContext } from "../../src/domain/ports.js";
import type { RunPolicy } from "../../src/domain/types.js";
import { MAX_TASK_ATTEMPTS } from "../../src/domain/types.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { annotateTool } from "../../src/mowe/catalog.js";
import { createScopedSpawnContext } from "../../src/runtime/lane-context.js";
import { RunTokenBudget } from "../../src/runtime/run-token-budget.js";
import { TeamRuntime, type TeamRuntimeOptions } from "../../src/runtime/team-runtime.js";
import type { TeamCreateRequest } from "../../src/runtime/team-tool.js";
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
} = {}) {
  const clock = options.clock ?? new ManualClock();
  const ledger = options.ledger ?? new MemoryLedger({ clock });
  const store = options.store ?? new MemoryContentAddressedStore();
  const inbox = options.inbox ?? new A2AInbox({ sink: ledger, clock });
  const model = options.model ?? new RecordingModel();
  let sequence = 0;
  const team = new TeamRuntime({
    eventSink: ledger, inbox, store, model, modelName: "scripted-team", runId: RUN_ID,
    workspace: process.cwd(), branchTools: options.tools ?? [], policy, clock,
    runTokenBudget: new RunTokenBudget(100_000), createId: () => `collaboration-${++sequence}`,
    readEvents: () => ledger.read({ runId: RUN_ID }), readWatermark: () => ledger.watermark(),
    readAwareness: () => ({ version: 1, generatedAt: clock.now().toISOString(), availability: "fresh", nodes: [], edges: [], roots: [], truncated: false }),
    ...(options.onWake === undefined ? {} : { onWake: options.onWake }),
    ...(options.spawnContext === undefined ? {} : { spawnContext: options.spawnContext }),
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

describe("durable Team collaboration", () => {
  it("creates canonical members after one durable definition while preserving exact legacy identity objects", async () => {
    const onWake = vi.fn();
    const { team, ledger, model } = fixture({ onWake });
    const result = await team.create({ teamId: "review", members: [member("security"), member("compatibility")] }, context);
    expect(result.members).toEqual([
      { memberId: "security", taskId: "review:security", laneId: "team:review:security", status: "queued" },
      { memberId: "compatibility", taskId: "review:compatibility", laneId: "team:review:compatibility", status: "queued" },
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
    expect(notices.some((notice) => notice.content.includes("Main is the Team Lead"))).toBe(true);
    expect(events.some((event) => event.laneId === "main" && (event.type === "user.message" || event.type === "assistant.message"))).toBe(false);
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
        return { ...response("Attempt unauthorized mutation", "tool_calls"), toolCalls: [{ id: "reducer-write", name: "mutate_workspace", arguments: {} }] };
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
    await original.team.cancel({ teamId: "review", reason: "Lead cancelled the review" }, context);
    const state = await board(original.team);
    expect(state).toMatchObject({ joinState: "cancelled", cancellationRequested: true, members: [{ outcome: "cancelled", terminal: true }] });
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
    { maxAttempts: undefined, content: "", expectedCalls: 2 },
    { maxAttempts: undefined, content: " \n\t", expectedCalls: 2 },
    { maxAttempts: 3, content: "", expectedCalls: 3 },
  ])("preserves the reducer default and durably applies an explicit attempt allowance: %j", async ({ maxAttempts, content, expectedCalls }) => {
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
    expect(state.reducer?.task.budget.maxAttempts).toBe(maxAttempts ?? 2);
    expect(state.reducer?.task.spawnContext?.budget.maxAttempts).toBe(maxAttempts ?? 2);
    expect(model.requests.filter((request) => request.laneId.startsWith("team-reducer:"))).toHaveLength(expectedCalls);
    if (maxAttempts === undefined) {
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
    expect(events.find((event) => event.type === "team.reduction.requested")?.payload.reducer.task.budget.maxAttempts).toBe(maxAttempts ?? 2);
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
        if (laneCall === 1) return { ...response("Contacting peer", "tool_calls"), toolCalls: [{ id: "a-to-b", name: "agent_message", arguments: { target: "team:review:b", text: "A evidence: auth requires a nonce", kind: "progress" } }] };
        if (laneCall === 2) {
          aSent.resolve();
          return { ...response("Waiting for B", "tool_calls"), toolCalls: [{ id: "a-waits", name: "read_file", arguments: { path: "wait-b" } }] };
        }
        return response("A reviewed the peer reply");
      }
      if (laneCall === 1) return { ...response("Waiting for A", "tool_calls"), toolCalls: [{ id: "b-waits", name: "read_file", arguments: { path: "wait-a" } }] };
      if (laneCall === 2) return { ...response("Replying to peer", "tool_calls"), toolCalls: [{ id: "b-to-a", name: "agent_message", arguments: { target: "team:review:a", text: "B evidence: nonce compatibility checked", kind: "inform" } }] };
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
    await expect(team.cancel({ teamId: "review" }, { ...context, laneId: "team:review:a" })).rejects.toThrow("bound to lane main");
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
