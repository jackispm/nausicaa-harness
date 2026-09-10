import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { A2AInbox } from "../../src/a2a/inbox.js";
import type { AnyEvent } from "../../src/domain/events.js";
import type { ModelPort, ModelRequest, ModelResponse, ToolExecutionContext } from "../../src/domain/ports.js";
import type { A2AMessage, RunPolicy } from "../../src/domain/types.js";
import { ContentStoreFukaiSource, FukaiContextProvider } from "../../src/fukai/index.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { MainLoop } from "../../src/runtime/main-loop.js";
import { LaneMailbox } from "../../src/runtime/lane-mailbox.js";
import { RunTokenBudget } from "../../src/runtime/run-token-budget.js";
import { TeamRuntime } from "../../src/runtime/team-runtime.js";
import { createTaskWaitTool } from "../../src/runtime/team-tool.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

const runId = "team-wait-interruption";
const lead: ToolExecutionContext = { runId, laneId: "main", workspace: process.cwd(), operationId: "create" };
const policy: RunPolicy = { maxMainStepsPerActivation: 8, mainRequestTimeoutMs: 30_000,
  tetoEnabled: false, tetoMaxOutputTokens: 64, workerEnabled: false };
const runtimes: TeamRuntime[] = [];
const releases: (() => void)[] = [];

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const runtime of runtimes.splice(0)) await runtime.stop();
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  return { promise, release };
}

function response(content: string): ModelResponse {
  return { content, toolCalls: [], stopReason: "stop", usage: { input: 8, output: 4, cacheRead: 0, cacheWrite: 0 } };
}

function calls(...tools: { id: string; name: string; arguments: Record<string, unknown> }[]): ModelResponse {
  return { ...response(""), stopReason: "toolUse", toolCalls: tools };
}

function waitCall(task: string, id = "wait", teamId = "work") {
  return { id, name: "task_wait", arguments: { teamId, taskId: `${teamId}:${task}` } };
}

function privateMessage(id: string, from = "team:work:slow", to = "main", overrides: Partial<A2AMessage> = {}): A2AMessage {
  return { messageId: id, runId, conversationId: runId, threadId: "clarification", from, to,
    createdAt: new Date().toISOString(), correlationId: id, idempotencyKey: id, visibility: "run",
    priority: 5, delivery: "next-step", payload: { type: "message.inform", text: id }, ...overrides };
}

function fixture(respond: (request: ModelRequest, laneCall: number) => ModelResponse | Promise<ModelResponse>, options: {
  claimLeaseMs?: number;
  readEvents?: (events: readonly AnyEvent[]) => Promise<readonly AnyEvent[]>;
} = {}) {
  const ledger = new MemoryLedger();
  const store = new MemoryContentAddressedStore();
  const inbox = new A2AInbox({ sink: ledger, ...(options.claimLeaseMs === undefined ? {} : { claimLeaseMs: options.claimLeaseMs }) });
  const requests: ModelRequest[] = [];
  const counts = new Map<string, number>();
  let reads = 0;
  const model: ModelPort = { complete: async (request) => {
    requests.push(request);
    const count = (counts.get(request.laneId) ?? 0) + 1;
    counts.set(request.laneId, count);
    return respond(request, count);
  } };
  const team = new TeamRuntime({ eventSink: ledger, inbox, store, model, modelName: "scripted", runId,
    workspace: process.cwd(), branchTools: [], runTokenBudget: new RunTokenBudget(undefined), policy, asyncCompletion: true,
    readEvents: async () => { reads += 1; const events = await ledger.read({ runId }); return options.readEvents?.(events) ?? events; },
    readWatermark: () => ledger.watermark(),
    readAwareness: () => ({ version: 1, generatedAt: new Date().toISOString(), availability: "fresh", nodes: [], edges: [], roots: [], truncated: false }),
  });
  runtimes.push(team);
  const runLead = () => new MainLoop({ model, eventSink: ledger, conversationStore: store,
    contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)), tools: [createTaskWaitTool(team)],
    includeProjectInstructions: false, beforeStep: ({ step }) => team.beforeMainStep({ step }), afterStep: (context) => team.enqueue(context),
  }).run({ runId, laneId: "main", workspace: process.cwd(), model: "scripted", policy,
    goal: { version: 1, statement: "Coordinate the Team", successCriteria: [], hardConstraints: [] }, initialMessage: "Wait for the work" });
  return { team, ledger, store, inbox, requests, runLead, get reads() { return reads; } };
}

async function started(ledger: MemoryLedger, laneId: string, toolCallId = "wait") {
  await vi.waitFor(async () => expect((await ledger.read()).some((event) => event.type === "tool.started"
    && event.laneId === laneId && event.payload.toolCallId === toolCallId)).toBe(true));
}

async function create(team: TeamRuntime, members: string[]) {
  return team.create({ teamId: "work", members: members.map((memberId) => ({ memberId, statement: `Complete ${memberId}` })) }, lead);
}

describe("Team cooperative waits", () => {
  it("lets all waits in a Main tool batch yield for another member report, without polling or stopping their tasks", async () => {
    const slow = gate();
    const fast = gate();
    const f = fixture(async (request, call) => {
      if (request.laneId === "main") {
        if (call === 1) return calls(waitCall("slow", "slow-wait"), waitCall("slower", "slower-wait"));
        expect(request.messages.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content)))
          .toEqual([expect.objectContaining({ waiting: true, wakeReason: "collaboration" }), expect.objectContaining({ waiting: true, wakeReason: "collaboration" })]);
        expect(request.messages.map((message) => message.content).join("\n")).toContain("FAST_MEMBER_REPORT");
        return response("Handled the finished member report while other work continues");
      }
      if (request.laneId.endsWith(":fast")) { await fast.promise; return response("FAST_MEMBER_REPORT"); }
      await slow.promise;
      return response("slow member complete");
    });
    await create(f.team, ["slow", "slower", "fast"]);
    const running = f.runLead();
    await started(f.ledger, "main", "slow-wait");
    await started(f.ledger, "main", "slower-wait");
    await delay(25);
    const reads = f.reads;
    await delay(100);
    expect(f.reads).toBe(reads);
    fast.release();
    expect((await running).completed).toBe(true);
    const board = (await f.team.status(lead)).teams[0]!;
    expect(board.members.filter((member) => member.terminal).map((member) => member.memberId)).toEqual(["fast"]);
    expect(f.requests.filter((request) => request.laneId === "main")).toHaveLength(2);
    slow.release();
    await f.team.drain();
  });

  it.each(["group", "private"] as const)("delivers a %s question at Main's next ordinary boundary while its task continues", async (kind) => {
    const work = gate();
    const f = fixture(async (request, call) => {
      if (request.laneId !== "main") { await work.promise; return response("done"); }
      if (call === 1) return calls(waitCall("slow"));
      expect(request.messages.map((message) => message.content).join("\n")).toContain("CONFIRM_OUTPUT_FOLDER");
      return response("I can answer the member now");
    });
    await create(f.team, ["slow"]);
    const running = f.runLead();
    await started(f.ledger, "main");
    if (kind === "group") await f.team.message({ teamId: "work", body: "CONFIRM_OUTPUT_FOLDER", mentions: ["nausicaa"] }, { ...lead, laneId: "team:work:slow", operationId: "ask" });
    else await f.inbox.send(privateMessage("CONFIRM_OUTPUT_FOLDER"));
    expect((await running).completed).toBe(true);
    expect((await f.team.status(lead)).teams[0]?.members[0]?.terminal).toBe(false);
  });

  it("does not yield repeatedly for messages delivered in the current uncommitted step, and does not hide later mentions", async () => {
    const work = gate();
    const f = fixture(async () => { await work.promise; return response("done"); }, { claimLeaseMs: 5 });
    await create(f.team, ["slow"]);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    for (let index = 0; index < 8; index += 1) {
      await f.team.message({ teamId: "work", body: `already seen ${index}`, mentions: ["nausicaa"] }, { ...lead, laneId: "team:work:slow", operationId: `old-${index}` });
    }
    await f.inbox.send(privateMessage("already-seen-private"));
    const delivered = await f.team.beforeMainStep({ step: 1 });
    expect(delivered).toHaveLength(9);
    let settled = false;
    const waiting = f.team.wait({ teamId: "work", taskId: "work:slow" }, lead).then((value) => { settled = true; return value; });
    await delay(40);
    expect(settled).toBe(false);
    await f.team.message({ teamId: "work", body: "NEW_FINDING", mentions: ["nausicaa"] }, { ...lead, laneId: "team:work:slow", operationId: "new" });
    expect(await waiting).toMatchObject({ waiting: true, wakeReason: "collaboration" });
    await f.ledger.append({ runId, laneId: "main", type: "step.completed", payload: { step: 1, hasToolCalls: true, boundaryMessageIds: delivered.map((message) => message.messageId) }, correlationId: "step", idempotencyKey: "committed-step" });
    const next = await f.team.beforeMainStep({ step: 2 });
    expect(next.some((message) => message.content.includes("NEW_FINDING"))).toBe(true);
    work.release();
    expect(await f.team.wait({ teamId: "work", taskId: "work:slow" }, lead)).toMatchObject({ waiting: false, outcome: "succeeded" });
  });

  it("observes mail committed while a subscribed state read is in flight", async () => {
    const work = gate();
    const reading = gate();
    const releaseRead = gate();
    let intercept = false;
    const f = fixture(async () => { await work.promise; return response("done"); }, { readEvents: async (events) => {
      if (intercept) { intercept = false; reading.release(); await releaseRead.promise; }
      return events;
    } });
    await create(f.team, ["slow"]);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    intercept = true;
    const waiting = f.team.wait({ teamId: "work", taskId: "work:slow" }, lead);
    await reading.promise;
    await f.inbox.send(privateMessage("DURING_READ"));
    releaseRead.release();
    expect(await waiting).toMatchObject({ waiting: true, wakeReason: "collaboration" });
  });

  it("honors messages already delivered by another mailbox in the host's composed boundary", async () => {
    const work = gate();
    const f = fixture(async () => { await work.promise; return response("done"); }, { claimLeaseMs: 100 });
    await create(f.team, ["slow"]);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    await f.inbox.send(privateMessage("DELIVERED_BY_HOST_MAILBOX"));
    const mailbox = new LaneMailbox({ inbox: f.inbox, runId, laneId: "main", resolveSenders: () => ["team:work:slow"] });
    const delivered = await mailbox.beforeStep({ step: 1 });
    const teamMessages = await f.team.beforeMainStep({ step: 1 });
    f.team.observeBoundaryMessages("main", [...delivered, ...teamMessages]);
    let settled = false;
    const waiting = f.team.wait({ teamId: "work", taskId: "work:slow" }, lead).then((result) => { settled = true; return result; });
    await delay(150);
    expect(settled).toBe(false);
    await f.inbox.send(privateMessage("NEW_HOST_MESSAGE"));
    expect(await waiting).toMatchObject({ waiting: true, wakeReason: "collaboration" });
  });

  it("prefers settlement that commits during the collaboration readiness check", async () => {
    const work = gate();
    const f = fixture(async () => { await work.promise; return response("done"); });
    await create(f.team, ["slow"]);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    await f.inbox.send(privateMessage("RACING_QUESTION"));
    const task = f.inbox.snapshot().records.find((record) => record.message.payload.type === "task.request")!;
    const availability = f.inbox.nextClaimableDelayMs.bind(f.inbox);
    let settlement: Promise<unknown> | undefined;
    vi.spyOn(f.inbox, "nextClaimableDelayMs").mockImplementation((lane, options) => {
      const ready = availability(lane, options);
      if (settlement === undefined && options?.messageIds?.includes("RACING_QUESTION")) {
        // Inject a durable terminal between the ready-message read and return.
        settlement = f.ledger.append({ runId, laneId: "main", type: "team.member.settled", payload: {
          teamId: "work", memberId: "slow", taskId: "work:slow", requestMessageId: task.message.messageId,
          claimId: task.claim!.claimId, attempt: task.claim!.attempt, outcome: "succeeded",
          result: { type: "task.result", taskId: "work:slow", status: "completed", summary: "COMMITTED_DURING_READ",
            evidenceRefs: [], artifactRefs: [], openQuestions: [], usage: response("").usage },
        }, correlationId: "race", idempotencyKey: "race-settlement" });
      }
      return ready;
    });
    expect(await f.team.wait({ teamId: "work", taskId: "work:slow" }, lead)).toMatchObject({
      waiting: false, outcome: "succeeded", result: { summary: "COMMITTED_DURING_READ" },
    });
    await settlement;
  });

  it("does not discard a report that settles while its next-boundary claim is in progress", async () => {
    const work = gate();
    const f = fixture(async () => { await work.promise; return response("SETTLED_DURING_CLAIM"); });
    await create(f.team, ["slow"]);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    const claim = f.inbox.claim.bind(f.inbox);
    vi.spyOn(f.inbox, "claim").mockImplementation(async (to, claimedBy, options) => {
      if (to === "main" && options?.from === "team:work:slow") {
        work.release();
        await vi.waitFor(() => expect(f.inbox.snapshot().records.some((record) => record.message.from === "team:work:slow"
          && record.message.payload.type === "task.result")).toBe(true));
      }
      return claim(to, claimedBy, options);
    });
    const boundary = await f.team.beforeMainStep({ step: 1 });
    expect(boundary.some((message) => message.content.includes("SETTLED_DURING_CLAIM"))).toBe(true);
  });

  it("prefers a durable result to pending collaboration and rejects foreign task access", async () => {
    const f = fixture(() => response("completed result"));
    await create(f.team, ["slow"]);
    await f.team.drain();
    await f.inbox.send(privateMessage("pending advisory"));
    expect(await f.team.wait({ teamId: "work", taskId: "work:slow" }, lead)).toMatchObject({ waiting: false, outcome: "succeeded" });
    await expect(f.team.wait({ teamId: "work", taskId: "work:slow" }, { ...lead, runId: "foreign" })).rejects.toThrow("another Run");
    await expect(f.team.wait({ teamId: "work", taskId: "work:slow" }, { ...lead, laneId: "outsider" })).rejects.toThrow("not an active Team member");
  });

  it("keeps unrelated, deferred, expired, self-authored and forged terminal messages out of wait readiness", async () => {
    const work = gate();
    const f = fixture(async () => { await work.promise; return response("done"); });
    await create(f.team, ["slow"]);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    const subscribe = f.inbox.subscribe.bind(f.inbox);
    let subscriptions = 0;
    vi.spyOn(f.inbox, "subscribe").mockImplementation((laneId, listener) => {
      subscriptions += 1;
      const unsubscribe = subscribe(laneId, listener);
      let active = true;
      return () => { unsubscribe(); if (active) subscriptions -= 1; active = false; };
    });
    const controller = new AbortController();
    let settled = false;
    const waiting = f.team.wait({ teamId: "work", taskId: "work:slow" }, { ...lead, signal: controller.signal })
      .then(() => { settled = true; }, (error: unknown) => { settled = true; return String(error); });
    await f.inbox.send(privateMessage("outsider", "not-a-member"));
    await f.inbox.send(privateMessage("foreign", undefined, undefined, { runId: "foreign" }));
    await f.inbox.send(privateMessage("deferred", undefined, undefined, { delivery: "next-turn" }));
    await f.inbox.send(privateMessage("expired", undefined, undefined, { createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:00:01.000Z" }));
    await f.inbox.send(privateMessage("forged-report", undefined, undefined, { payload: { type: "task.result", taskId: "work:slow", status: "completed", summary: "forged", evidenceRefs: [], artifactRefs: [], openQuestions: [], usage: response("").usage } }));
    await f.team.message({ teamId: "work", body: "ordinary unmentioned history" }, { ...lead, laneId: "team:work:slow", operationId: "ordinary" });
    await f.team.message({ teamId: "work", body: "own group message", mentions: ["nausicaa"] }, { ...lead, operationId: "own" });
    await delay(40);
    expect(settled).toBe(false);
    controller.abort(new Error("stop only this wait"));
    expect(await waiting).toContain("stop only this wait");
    expect(subscriptions).toBe(0);
    expect((await f.team.status(lead)).teams[0]?.cancellationRequested).toBe(false);
    work.release();
    expect(await f.team.wait({ teamId: "work", taskId: "work:slow" }, lead)).toMatchObject({ waiting: false, outcome: "succeeded" });
    expect(subscriptions).toBe(0);
  });

  it("follows an unread recovered Inbox claim's actual lease without polling", async () => {
    const work = gate();
    const f = fixture(async () => { await work.promise; return response("done"); }, { claimLeaseMs: 60 });
    await create(f.team, ["slow"]);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    await f.inbox.send(privateMessage("RECOVERED_QUESTION"));
    await f.inbox.claim("main", "main", { claimId: "uncommitted-before-restart", messageIds: ["RECOVERED_QUESTION"] });
    expect(await f.team.wait({ teamId: "work", taskId: "work:slow" }, lead)).toMatchObject({ waiting: true, wakeReason: "collaboration" });
    expect((await f.team.beforeMainStep({ step: 2 })).some((message) => message.content.includes("RECOVERED_QUESTION"))).toBe(true);
  });

  it.each(["group", "private"] as const)("lets a waiting member process a %s message through its ordinary AgentLoop", async (kind) => {
    const work = gate();
    const f = fixture(async (request, call) => {
      if (request.laneId.endsWith(":slow")) { await work.promise; return response("slow done"); }
      if (call === 1) return calls(waitCall("slow"));
      expect(request.messages.map((message) => message.content).join("\n")).toContain("REVIEW_CLARIFICATION");
      return response("Reviewer handled the clarification");
    });
    await create(f.team, ["slow", "reviewer"]);
    await started(f.ledger, "team:work:reviewer");
    if (kind === "group") await f.team.message({ teamId: "work", body: "REVIEW_CLARIFICATION", mentions: ["reviewer"] }, { ...lead, operationId: "clarify" });
    else await f.inbox.send(privateMessage("REVIEW_CLARIFICATION", "main", "team:work:reviewer"));
    await vi.waitFor(async () => expect((await f.team.status(lead)).teams[0]?.members.find((member) => member.memberId === "reviewer")?.terminal).toBe(true));
    expect(f.requests.filter((request) => request.laneId === "team:work:reviewer")).toHaveLength(2);
    expect((await f.team.status(lead)).teams[0]?.members.find((member) => member.memberId === "slow")?.terminal).toBe(false);
  });

  it("rejects circular peer waits and lets both AgentLoops finish without a task timeout", async () => {
    const f = fixture((request, call) => call === 1
      ? calls(waitCall(request.laneId.endsWith(":a") ? "b" : "a"))
      : response(`${request.laneId} finished after handling its wait result`));
    await create(f.team, ["a", "b"]);
    await f.team.drain();
    const toolResults = f.requests.flatMap((request) => request.messages.filter((message) => message.role === "tool").map((message) => message.content));
    expect(toolResults.some((content) => content.includes("circular Team wait"))).toBe(true);
    expect((await f.team.status(lead)).teams[0]?.members.every((member) => member.outcome === "succeeded")).toBe(true);
    expect(f.requests).toHaveLength(4);
  });

  it("delivers child reports to a waiting nested lead and keeps them out of the root's boundary", async () => {
    const slow = gate();
    const fast = gate();
    const f = fixture(async (request, call) => {
      if (request.laneId === "team:work:manager") {
        if (call === 1) return calls({ id: "create", name: "team_create", arguments: { teamId: "inner", members: [
          { memberId: "slow", statement: "Continue long work" }, { memberId: "fast", statement: "Return a finding" },
        ] } });
        if (call === 2) return calls(waitCall("slow", "wait", "inner"));
        expect(request.messages.map((message) => message.content).join("\n")).toContain("NESTED_REPORT_READY");
        return response("Nested lead handled its child's report");
      }
      if (request.laneId.endsWith(":fast")) { await fast.promise; return response("NESTED_REPORT_READY"); }
      await slow.promise;
      return response("Slow child done");
    });
    await create(f.team, ["manager"]);
    await started(f.ledger, "team:work:manager");
    fast.release();
    await vi.waitFor(() => expect(f.requests.filter((request) => request.laneId === "team:work:manager")).toHaveLength(3));
    const rootMessages = await f.team.beforeMainStep({ step: 1 });
    expect(rootMessages.some((message) => message.source === "team:inner:fast")).toBe(false);
    slow.release();
    await f.team.drain();
  });
});
