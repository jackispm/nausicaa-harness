import { describe, expect, it, vi } from "vitest";

import { A2AInbox, createCrossRunMessageId, createCrossRunRouteId, envelopeToA2AMessage } from "../../src/a2a/index.js";
import type { ModelRequest, ModelResponse, ToolExecutionContext } from "../../src/domain/ports.js";
import type { A2AMessage, DeliveryMode } from "../../src/domain/types.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { RunTokenBudget } from "../../src/runtime/run-token-budget.js";
import { TeamRuntime } from "../../src/runtime/team-runtime.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

const RUN_ID = "team-completion-delivery";
const MEMBER = "team:review:one";
const context: ToolExecutionContext = {
  runId: RUN_ID, laneId: "main", workspace: process.cwd(), operationId: "team-operation",
};

function response(content = "Review completed"): ModelResponse {
  return {
    content, stopReason: "stop", toolCalls: [],
    usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 },
  };
}

async function fixture(respond: (request: ModelRequest) => Promise<ModelResponse> = async () => response(), memberIds = ["one"]) {
  const ledger = new MemoryLedger();
  const store = new MemoryContentAddressedStore();
  const inbox = new A2AInbox({ sink: ledger, claimLeaseMs: 40 });
  const complete = vi.fn(respond);
  const team = new TeamRuntime({
    eventSink: ledger, inbox, store, model: { complete }, modelName: "scripted-team",
    runId: RUN_ID, workspace: process.cwd(), branchTools: [],
    runTokenBudget: new RunTokenBudget(100_000),
    policy: {
      maxMainStepsPerActivation: 3, maxModelTokens: 100_000,
      tetoEnabled: false, tetoMaxOutputTokens: 64, workerEnabled: false,
    },
    readEvents: () => ledger.read({ runId: RUN_ID }),
    readWatermark: () => ledger.watermark(),
    readAwareness: () => ({
      version: 1, generatedAt: new Date().toISOString(), availability: "fresh",
      nodes: [], edges: [], roots: [], truncated: false,
    }),
  });
  await team.create({
    teamId: "review",
    members: memberIds.map((memberId) => ({ memberId, statement: "Inspect evidence", maxModelTokens: 12_000, maxWallClockMs: 10_000 })),
  }, context);
  return { team, inbox, complete };
}

async function consumeJoinedNotices(f: Awaited<ReturnType<typeof fixture>>) {
  await f.team.drain();
  for (const message of await f.team.beforeMainStep({ step: 1 })) {
    await f.inbox.handle(message.messageId, "main");
  }
}

function message(id: string, delivery: DeliveryMode = "next-step"): A2AMessage {
  return {
    messageId: id, runId: RUN_ID, from: MEMBER, to: "main",
    conversationId: RUN_ID, threadId: id, correlationId: id, idempotencyKey: id,
    createdAt: new Date().toISOString(), visibility: "run", priority: 5, delivery,
    payload: { type: "message.inform", text: `Notice ${id}` },
  };
}

function remoteMessage(id: string): A2AMessage {
  const local = { ...message(id), from: "main" };
  const source = { workspaceId: "workspace", sessionId: "remote", runId: "remote-run", laneId: "main" };
  const target = { workspaceId: "workspace", sessionId: "session", runId: RUN_ID, laneId: "main" };
  const routeId = createCrossRunRouteId(source, target, local.idempotencyKey);
  return envelopeToA2AMessage({
    ...local, protocolVersion: 1, routeId, messageId: createCrossRunMessageId(routeId, local),
    source, target, relationship: "direct", artifacts: [],
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("Team completion boundary delivery", () => {
  it("batches terminal-only wakeups at join when Main is ready to finish", async () => {
    const entered = deferred<void>();
    const release = deferred<ModelResponse>();
    const f = await fixture(async (request) => {
      if (request.laneId.endsWith(":two")) { entered.resolve(); return release.promise; }
      return response("First member finished");
    }, ["one", "two"]);
    try {
      await entered.promise;
      await expect.poll(async () => (await f.team.status(context)).teams[0]?.members.find((member) => member.memberId === "one")?.terminal).toBe(true);
      vi.useFakeTimers();
      let settled = false;
      const waiting = f.team.beforeMainCompletion().then((value) => { settled = true; return value; });
      await vi.advanceTimersByTimeAsync(25);
      expect(settled).toBe(false);
      release.resolve(response("Second member finished"));
      await vi.advanceTimersByTimeAsync(50);
      expect(await waiting).toBe(true);
      expect((await f.team.beforeMainStep({ step: 2 })).some((message) => message.content.includes("Team review joined"))).toBe(true);
    } finally {
      vi.useRealTimers();
      release.resolve(response());
      await f.team.stop();
    }
  });

  it.each<DeliveryMode>(["next-turn", "deferred"])(
    "does not spend another Main step on a %s message",
    async (delivery) => {
      const f = await fixture();
      try {
        await consumeJoinedNotices(f);
        await f.inbox.send(message("later", delivery));
        expect(await f.team.beforeMainStep({ step: 2 })).toEqual([]);
        expect(await f.team.beforeMainCompletion()).toBe(false);
        expect(f.inbox.snapshot().records.find((record) => record.message.messageId === "later")?.status).toBe("pending");
        if (delivery === "next-turn") {
          expect((await f.team.beforeMainStep({ step: 1 })).map((item) => item.messageId)).toEqual(["later"]);
        }
      } finally { await f.team.stop(); }
    },
  );

  it("leaves cross-Run messages to their existing delivery path", async () => {
    const f = await fixture();
    try {
      await consumeJoinedNotices(f);
      const remote = remoteMessage("external");
      await f.inbox.send(remote);
      expect(await f.team.beforeMainStep({ step: 2 })).toEqual([]);
      expect(await f.team.beforeMainCompletion()).toBe(false);
      expect(f.inbox.snapshot().records.find((record) => record.message.messageId === remote.messageId)?.status).toBe("pending");
    } finally { await f.team.stop(); }
  });

  it("waits for the selected uncommitted claim lease without spending a model step", async () => {
    const f = await fixture();
    try {
      await consumeJoinedNotices(f);
      vi.useFakeTimers();
      await f.inbox.send(message("leased"));
      await f.inbox.claim("main", "main", { runId: RUN_ID, messageIds: ["leased"], claimId: "interrupted-step" });
      await f.inbox.send(message("later", "next-turn"));
      await f.inbox.send(remoteMessage("unrelated-ready"));
      expect(f.inbox.nextClaimableDelayMs("main", { runId: RUN_ID })).toBe(0);
      expect(f.inbox.nextClaimableDelayMs("main", { runId: RUN_ID, messageIds: ["leased"] })).toBe(40);

      let settled = false;
      const waiting = f.team.beforeMainCompletion().then((value) => { settled = true; return value; });
      await vi.advanceTimersByTimeAsync(39);
      expect(settled).toBe(false);
      expect(f.complete).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await waiting).toBe(true);
      expect((await f.team.beforeMainStep({ step: 2 })).map((item) => item.messageId)).toEqual(["leased"]);
    } finally {
      vi.useRealTimers();
      await f.team.stop();
    }
  });

  it("delivers a working member question before join while Main can still reply", async () => {
    const entered = deferred<void>();
    const release = deferred<ModelResponse>();
    let calls = 0;
    const f = await fixture(async () => {
      if (++calls === 1) return {
        ...response("Ask Main before continuing"), stopReason: "toolUse",
        toolCalls: [{
          id: "ask-main", name: "agent_message",
          arguments: { target: "main", kind: "request", text: "Which target should I inspect?" },
        }],
      };
      entered.resolve();
      return release.promise;
    });
    try {
      await entered.promise;
      expect(await f.team.beforeMainCompletion()).toBe(true);
      expect((await f.team.status(context)).teams[0]?.joinSatisfied).toBe(false);
      const question = (await f.team.beforeMainStep({ step: 2 })).find((item) => item.content.includes("Which target"));
      expect(question).toBeDefined();
      const reply = await f.team.createMessageTool().execute({
        target: MEMBER, replyTo: question!.messageId, text: "Inspect the API boundary",
      }, { ...context, operationId: "reply-to-member" });
      expect(reply.isError).toBe(false);
      expect(JSON.parse(reply.content)).toMatchObject({ status: "queued", from: "nausicaa", to: MEMBER });
    } finally {
      release.resolve(response());
      await f.team.stop();
    }
  });
});
