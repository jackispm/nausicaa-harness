import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { A2AInbox } from "../../src/a2a/index.js";
import type { ModelRequest, ModelResponse, ToolExecutionContext } from "../../src/domain/ports.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { RunTokenBudget } from "../../src/runtime/run-token-budget.js";
import { SessionController } from "../../src/runtime/session-controller.js";
import { appendTeamChannelMessage } from "../../src/runtime/team-channel.js";
import { TeamRuntime } from "../../src/runtime/team-runtime.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

const runId = "team-group-wake";
const lead: ToolExecutionContext = { runId, laneId: "main", workspace: process.cwd(), operationId: "create" };
const member = { ...lead, laneId: "team:work:dev", operationId: "member-message" };
const runtimes: TeamRuntime[] = [];

afterEach(async () => {
  for (const team of runtimes.splice(0)) await team.stop();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function response(content = "Task completed"): ModelResponse {
  return { content, toolCalls: [], stopReason: "stop", usage: { input: 10, output: 3, cacheRead: 0, cacheWrite: 0 } };
}

async function fixture(respond?: (request: ModelRequest, call: number) => Promise<ModelResponse>) {
  const ledger = new MemoryLedger();
  const store = new MemoryContentAddressedStore();
  const inbox = new A2AInbox({ sink: ledger });
  const entered = deferred<void>();
  const release = deferred<ModelResponse>();
  const requests: ModelRequest[] = [];
  const wake = vi.fn();
  const options = {
    eventSink: ledger, inbox, store, runId, workspace: process.cwd(), modelName: "group-test",
    branchTools: [], runTokenBudget: new RunTokenBudget(undefined), asyncCompletion: true,
    policy: { maxMainStepsPerActivation: 3, mainRequestTimeoutMs: 30_000, tetoEnabled: false, tetoMaxOutputTokens: 64, workerEnabled: false },
    model: { complete: async (request: ModelRequest) => {
      requests.push(request);
      entered.resolve();
      return respond === undefined ? release.promise : respond(request, requests.length);
    } },
    onWake: wake,
    readEvents: () => ledger.read({ runId }), readWatermark: () => ledger.watermark(),
    readAwareness: () => ({ version: 1 as const, generatedAt: new Date().toISOString(), availability: "fresh" as const, nodes: [], edges: [], roots: [], truncated: false }),
  };
  const team = new TeamRuntime(options);
  runtimes.push(team);
  await team.create({ teamId: "work", members: [{ memberId: "dev", statement: "Build the calendar" }] }, lead);
  await entered.promise;
  let committedStep = 0;
  async function commit(ids: readonly string[]) {
    committedStep += 1;
    await ledger.append({ runId, laneId: "main", type: "step.completed", payload: { step: committedStep, hasToolCalls: false, boundaryMessageIds: [...ids] }, correlationId: "consume-group", idempotencyKey: `consume-group-${committedStep}` });
  }
  return { team, ledger, store, inbox, requests, release, wake, options, commit };
}

describe("Team group mentions", () => {
  it("makes a lead mention ready for continuation and consumes it once at a committed boundary", async () => {
    const f = await fixture();
    try {
      expect(await f.team.beforeMainCompletion()).toBe(false);
      const sent = await f.team.message({ teamId: "work", body: "Need the selected output folder", mentions: ["main"] }, member);
      expect(f.wake).toHaveBeenCalledTimes(1);
      expect(await f.team.beforeMainCompletion()).toBe(true);
      const notices = await f.team.beforeMainStep({ step: 1 });
      expect(notices).toHaveLength(1);
      expect(notices[0]?.content).toContain("Need the selected output folder");
      expect(notices[0]?.content).toContain(sent.cursor);
      const { readFullMessage } = JSON.parse(notices[0]!.content.split("\n")[1]!);
      expect(readFullMessage).not.toHaveProperty("after");
      expect((await f.team.history(readFullMessage, lead)).messages[0]?.body).toBe("Need the selected output folder");
      expect(f.inbox.snapshot().records.some((record) => record.message.payload.type === "message.inform")).toBe(false);
      await f.commit(notices.map((notice) => notice.messageId));
      expect(await f.team.beforeMainCompletion()).toBe(false);
      expect(await f.team.beforeMainStep({ step: 2 })).toEqual([]);
      await f.team.message({ teamId: "work", body: "Need the selected output folder", mentions: ["main"] }, member);
      expect(f.wake).toHaveBeenCalledTimes(1);
      expect(await f.team.beforeMainCompletion()).toBe(false);
    } finally { f.release.resolve(response()); }
  });

  it("keeps ordinary history out of automatic continuation and resolves the public lead alias", async () => {
    const f = await fixture();
    try {
      for (let index = 0; index < 25; index += 1) await f.team.message({ teamId: "work", body: `ordinary-history-${index}` }, { ...member, operationId: `ordinary-${index}` });
      expect(f.wake).not.toHaveBeenCalled();
      expect(await f.team.beforeMainCompletion()).toBe(false);
      expect(await f.team.beforeMainStep({ step: 1 })).toEqual([]);
      const body = `Review the chosen date handling. ${"detail ".repeat(800)}FULL_MESSAGE_TAIL`;
      await f.team.message({ teamId: "work", threadId: "task:calendar-fix", body, mentions: ["nausicaa"] }, member);
      const notices = await f.team.beforeMainStep({ step: 1 });
      expect(notices).toHaveLength(1);
      expect(notices[0]!.content.length).toBeLessThan(4_096);
      expect(notices[0]?.content).toContain("team_history");
      expect(notices[0]?.content).not.toContain("ordinary-history-");
      expect(notices[0]?.content).not.toContain("FULL_MESSAGE_TAIL");
      const { readFullMessage, cursor } = JSON.parse(notices[0]!.content.split("\n")[1]!);
      expect(readFullMessage).toMatchObject({ teamId: "work", channelId: "general", threadId: "task:calendar-fix", limit: 1, after: expect.any(String) });
      const full = await f.team.history(readFullMessage, lead);
      expect(full.messages).toHaveLength(1);
      expect(full.messages[0]?.body).toBe(body);
      await f.team.message({ teamId: "work", body: "Later channel message" }, { ...member, operationId: "later-message" });
      expect((await f.team.history({ teamId: "work", after: cursor, limit: 1 }, lead)).messages[0]?.body).toBe("Later channel message");
      const page = await f.team.history({ teamId: "work", limit: 20 }, lead);
      expect(page.messages).toHaveLength(20);
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).toBeDefined();
    } finally { f.release.resolve(response()); }
  });

  it.each(["close", "cancel"] as const)("drops pending group wakeups after Team %s", async (action) => {
    const f = await fixture();
    try {
      await f.team.message({ teamId: "work", body: "Pending question", mentions: ["main"] }, member);
      await f.team[action]({ teamId: "work" }, lead);
      f.wake.mockClear();
      expect(await f.team.beforeMainCompletion()).toBe(false);
      expect((await f.team.beforeMainStep({ step: 1 })).some((notice) => notice.content.includes("Pending question"))).toBe(false);
      await expect(f.team.message({ teamId: "work", body: "Too late", mentions: ["main"] }, member)).rejects.toThrow();
      expect(f.wake).not.toHaveBeenCalled();
    } finally { f.release.resolve(response()); }
  });

  it("an active member consumes a mention before finalizing and idle members are not restarted by mentions", async () => {
    const gate = deferred<ModelResponse>();
    const f = await fixture(async (_request, call) => call === 1 ? gate.promise : response("Applied the requested output folder"));
    try {
      await f.team.message({ teamId: "work", body: "Use /tmp/calendar-output for the result", mentions: ["dev"] }, { ...lead, operationId: "clarify-folder" });
      gate.resolve(response("Initial report before folder clarification"));
      await f.team.drain();
      expect(f.requests).toHaveLength(2);
      expect(f.requests[1]?.messages.map((message) => message.content).join("\n")).toContain("Use /tmp/calendar-output for the result");
      const report = (await f.team.status(lead)).teams[0]?.members[0]?.result;
      expect(report?.summary).toBe("Applied the requested output folder");
      await f.team.message({ teamId: "work", body: "Future work is available", mentions: ["dev"] }, { ...lead, operationId: "future-work" });
      await f.team.drain();
      expect(f.requests).toHaveLength(2);
    } finally { gate.resolve(response()); f.release.resolve(response()); }
  });

  it("replays an uncommitted mention after recovery but preserves a committed consumption", async () => {
    const f = await fixture();
    try {
      await f.team.message({ teamId: "work", body: "Review this durable group finding", mentions: ["main"] }, member);
      f.release.resolve(response());
      await f.team.drain();
      const before = await f.team.beforeMainStep({ step: 1 });
      const group = before.find((notice) => notice.content.includes("Review this durable group finding"))!;
      expect(group).toBeDefined();
      await f.commit(before.filter((notice) => notice.messageId !== group.messageId).map((notice) => notice.messageId));
      await f.team.stop();
      const inbox = A2AInbox.rehydrate(await f.ledger.read(), { sink: f.ledger });
      const restored = new TeamRuntime({ ...f.options, inbox });
      runtimes.push(restored);
      await restored.restore();
      await restored.drain();
      expect(await restored.beforeMainCompletion()).toBe(true);
      const replayed = await restored.beforeMainStep({ step: 2 });
      expect(replayed.map((notice) => notice.messageId)).toEqual([group.messageId]);
      await f.commit(replayed.map((notice) => notice.messageId));
      await restored.stop();
      const committed = new TeamRuntime({ ...f.options, inbox: A2AInbox.rehydrate(await f.ledger.read(), { sink: f.ledger }) });
      runtimes.push(committed);
      await committed.restore();
      await committed.drain();
      expect(await committed.beforeMainCompletion()).toBe(false);
      expect(await committed.beforeMainStep({ step: 3 })).toEqual([]);
      expect(f.requests).toHaveLength(1);
    } finally { f.release.resolve(response()); }
  });

  it("ignores forged channel authors and members without an admission", async () => {
    const f = await fixture();
    try {
      for (const [laneId, fromLane] of [["outsider", "outsider"], ["outsider", member.laneId!]]) {
        const candidate = appendTeamChannelMessage(await f.ledger.read(), {
          runId, teamId: "work", channelId: "general", operationId: `forged-${fromLane}`,
          laneId: laneId!, fromLane: fromLane!, body: "Unauthorized group message", mentions: ["main"],
        });
        if (!candidate.duplicate) await f.ledger.append(candidate.event);
      }
      expect(await f.team.beforeMainCompletion()).toBe(false);
      expect(await f.team.beforeMainStep({ step: 1 })).toEqual([]);
    } finally { f.release.resolve(response()); }
  });

  it("delivers a nested group's mention to its member lead without exposing it to the outer lead", async () => {
    const ownerThinking = deferred<void>();
    const mentioned = deferred<void>();
    const finishChild = deferred<void>();
    let ownerCalls = 0;
    let childCalls = 0;
    const f = await fixture(async (request) => {
      if (request.laneId === member.laneId) {
        ownerCalls += 1;
        if (ownerCalls === 1) return { ...response(""), stopReason: "toolUse", toolCalls: [{ id: "create-nested", name: "team_create", arguments: {
          teamId: "nested", members: [{ memberId: "helper", statement: "Inspect the nested task" }],
        } }] };
        if (ownerCalls === 2) { ownerThinking.resolve(); await mentioned.promise; return response("Initial parent report"); }
        return response("Nested request applied");
      }
      childCalls += 1;
      if (childCalls === 1) {
        await ownerThinking.promise;
        return { ...response(""), stopReason: "toolUse", toolCalls: [{ id: "nested-question", name: "team_message", arguments: {
          teamId: "nested", body: "NESTED_CHILD_FINDING", mentions: [member.laneId],
        } }] };
      }
      mentioned.resolve();
      await finishChild.promise;
      return response("Nested work finished");
    });
    try {
      await f.team.drain();
      const owner = f.requests.filter((request) => request.laneId === member.laneId);
      expect(owner).toHaveLength(3);
      const context = owner[2]!.messages.map((message) => message.content).join("\n");
      expect(context).toContain("NESTED_CHILD_FINDING");
      expect(context).toContain("Use child_team_message to reply; call child_team_history with readFullMessage");
      expect(owner[2]!.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["child_team_message", "child_team_history"]));
      const event = (await f.ledger.read()).find((event) => event.type === "team.message.sent" && event.payload.body === "NESTED_CHILD_FINDING")!;
      expect((await f.team.beforeMainStep({ step: 1 })).some((notice) => notice.messageId === `team-channel:${event.eventId}`)).toBe(false);
      expect(f.requests.filter((request) => request.laneId === member.laneId)).toHaveLength(3);
    } finally { ownerThinking.resolve(); mentioned.resolve(); finishChild.resolve(); f.release.resolve(response()); }
  });

  it("wakes an idle interactive lead for a group mention while its member keeps working", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nausicaa-group-wake-"));
    const sendMention = deferred<void>();
    const finishMember = deferred<void>();
    const memberWorking = deferred<void>();
    let leadCalls = 0;
    let memberCalls = 0;
    const leadContexts: string[] = [];
    const session = await SessionController.open({
      workspace: directory, dataDir: join(directory, "state"), model: "lead", workerModel: "member",
      policy: { tetoEnabled: false, workerEnabled: false, maxMainStepsPerActivation: 5 },
    }, {
      tools: [], workerTools: [], createRunId: () => "interactive-group-wake",
      mainModel: { complete: async (request) => {
        leadCalls += 1;
        leadContexts.push(request.messages.map((message) => message.content).join("\n"));
        return leadCalls === 1 ? { ...response("Starting the task"), stopReason: "toolUse", toolCalls: [{
          id: "create-group", name: "team_create", arguments: { teamId: "work", members: [{ memberId: "dev", statement: "Implement the calendar" }] },
        }] } : response(leadCalls === 2 ? "Members are working" : "Read the group request");
      } },
      workerModel: { complete: async () => {
        memberCalls += 1;
        if (memberCalls === 1) {
          await sendMention.promise;
          return { ...response(""), stopReason: "toolUse", toolCalls: [{ id: "group-question", name: "team_message", arguments: {
            teamId: "work", body: "Please confirm the calendar output folder", mentions: ["nausicaa"],
          } }] };
        }
        memberWorking.resolve();
        await finishMember.promise;
        return response("Calendar completed");
      } },
    });
    let completedTurns = 0;
    const boundaries: unknown[] = [];
    const unlisten = session.subscribe((event) => {
      if (event.kind === "event" && event.event.type === "turn.completed") completedTurns += 1;
      if (event.kind === "event" && event.event.type.startsWith("turn.")) boundaries.push({ type: event.event.type, payload: event.event.payload });
    });
    try {
      await session.submit({ inputId: "calendar-request", text: "Create a Team to build a week calendar." });
      await session.waitForIdle();
      expect(completedTurns, JSON.stringify(boundaries)).toBe(1);
      expect(leadCalls).toBe(2);
      sendMention.resolve();
      await memberWorking.promise;
      await vi.waitFor(() => expect(completedTurns).toBe(2), { timeout: 8_000 });
      await session.waitForIdle();
      expect(leadCalls).toBe(3);
      expect(leadContexts[2]).toContain("Please confirm the calendar output folder");
      expect(memberCalls).toBe(2);
    } finally {
      sendMention.resolve(); finishMember.resolve();
      unlisten();
      await session.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
