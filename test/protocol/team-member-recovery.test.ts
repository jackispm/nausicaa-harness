import { afterEach, describe, expect, it, vi } from "vitest";

import { A2AInbox } from "../../src/a2a/index.js";
import type { EventPayloadMap, EventType } from "../../src/domain/events.js";
import type { AgentTool, ModelPort, ModelRequest, ModelResponse } from "../../src/domain/ports.js";
import type { A2AMessage, RunPolicy } from "../../src/domain/types.js";
import type { TeamDefinition } from "../../src/domain/team.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";
import { TeamBranchExecutor } from "../../src/runtime/team-branch-executor.js";
import { TeamLifecycle } from "../../src/runtime/team-lifecycle.js";
import { TeamRuntime } from "../../src/runtime/team-runtime.js";
import { RunTokenBudget } from "../../src/runtime/run-token-budget.js";
import { MESSAGE_MEDIA_TYPE, TOOL_ARGUMENTS_MEDIA_TYPE } from "../../src/runtime/session-artifacts.js";

const runId = "team-member-recovery";
const modelName = "recovery-model";
const usage = { input: 13, output: 5, cacheRead: 2, cacheWrite: 0 };
const policy: RunPolicy = {
  maxMainStepsPerActivation: 3, maxModelTokens: 10_000, mainRequestTimeoutMs: 10_000,
  tetoEnabled: false, tetoMaxOutputTokens: 64, tetoActivation: "manual", workerEnabled: false,
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  let now = Date.parse("2026-09-07T00:00:00.000Z");
  let sequence = 0;
  const clock = { now: () => new Date(now) };
  const ledger = new MemoryLedger({ clock });
  const store = new MemoryContentAddressedStore();
  const inbox = new A2AInbox({ sink: ledger, clock, claimLeaseMs: 50 });
  const complete = vi.fn(async (_request: ModelRequest): Promise<ModelResponse> => ({
    content: "Unexpected fresh model call", toolCalls: [], stopReason: "stop", usage,
  }));
  const model: ModelPort = { complete };
  const definition: TeamDefinition = {
    teamId: "review", leadLaneId: "main", joinPolicy: "all-terminal", peerMessaging: "team-members",
    deadline: new Date(now + 60_000).toISOString(), fingerprint: "recovery-definition",
    members: [{
      memberId: "inspection", laneId: "team:review:inspection", required: true, dependsOn: [],
      task: {
        type: "task.request", taskId: "review:inspection",
        goal: { version: 1, statement: "Inspect recovery evidence", successCriteria: ["Preserve verified results"], hardConstraints: [] },
        inputRefs: [], budget: { maxModelTokens: 1_000, maxWallClockMs: 60_000, maxAttempts: 3, deadline: new Date(now + 60_000).toISOString() },
      },
    }],
  };
  const member = definition.members[0]!;
  const append = <K extends EventType>(type: K, payload: EventPayloadMap[K], laneId = member.laneId, idempotencyKey = `seed-${++sequence}`) => ledger.append({
    runId, laneId, type, payload, correlationId: "review", idempotencyKey,
    visibility: "run", occurredAt: clock.now().toISOString(),
  });
  await append("team.created", definition, "main");
  const request: A2AMessage = {
    messageId: `${runId}:task:${member.task.taskId}:request`, runId, conversationId: runId, threadId: `${runId}:team:review`,
    from: "main", to: member.laneId, createdAt: clock.now().toISOString(), correlationId: "review",
    idempotencyKey: `${runId}:task:${member.task.taskId}:request`, visibility: "run", priority: 1, delivery: "next-step", payload: member.task,
  };
  await inbox.send(request);
  await append("lane.registered", { kind: "team", teamFingerprint: definition.fingerprint });
  await inbox.claim(member.laneId, member.laneId, { claimId: "old-process-claim", runId, types: ["task.request"] });

  const awareness = () => ({
    version: 1 as const, generatedAt: clock.now().toISOString(), availability: "fresh" as const,
    nodes: [], edges: [], roots: [], truncated: false,
  });
  async function restoreExecutor(tools: readonly AgentTool[] = []) {
    now += 51;
    const events = await ledger.read({ runId });
    const restoredInbox = A2AInbox.rehydrate(events, { sink: ledger, clock, claimLeaseMs: 50 });
    const lifecycle = new TeamLifecycle({
      runId, leadLaneId: "main", ledger, inbox: restoredInbox, clock,
      readEvents: () => ledger.read({ runId }), stopMember: async () => undefined,
    });
    cleanup.push(() => lifecycle.close());
    const executor = new TeamBranchExecutor({
      eventSink: ledger, inbox: restoredInbox, store, model, modelName, runId,
      parentLaneId: "main", branchLaneId: member.laneId, goal: member.task.goal, taskDefinition: member.task,
      policy, tools, workspace: process.cwd(), runTokenBudget: new RunTokenBudget(10_000),
      clock, events, createId: () => `recovered-${++sequence}`,
      readEvents: () => ledger.read({ runId }), readWatermark: () => ledger.watermark(), readAwareness: awareness,
      settleTask: (input) => lifecycle.settle("review", member, input.request, input.claim, input.payload),
      readTaskTerminal: async () => {
        const state = (await lifecycle.boards())[0]?.members.find((item) => item.memberId === member.memberId);
        return state?.result ?? state?.failure;
      },
    });
    cleanup.push(() => executor.stop());
    return { executor, inbox: restoredInbox, lifecycle };
  }
  return { ledger, store, inbox, clock, definition, member, request, model, complete, append, awareness, restoreExecutor };
}

describe("Team member recovery", () => {
  it("reuses a committed final model response after a crash before task settlement", async () => {
    const s = await fixture();
    const answerRef = await s.store.put(JSON.stringify({
      role: "assistant", content: "Previously verified recovery evidence", toolCalls: [], createdAt: s.clock.now().toISOString(),
    }), MESSAGE_MEDIA_TYPE);
    await s.append("step.started", { step: 1 });
    await s.append("model.requested", { model: modelName, requestHash: "original-call", contextWatermark: await s.ledger.watermark() });
    await s.append("budget.charged", { laneId: s.member.laneId, usage }, s.member.laneId, `${runId}:${s.member.laneId}:step:1:budget`);
    await s.append("model.completed", { model: modelName, responseRef: answerRef, stopReason: "stop", usage }, s.member.laneId, `${runId}:${s.member.laneId}:step:1:model:completed`);
    const restored = await s.restoreExecutor();
    await expect(restored.executor.runOnce()).resolves.toMatchObject({ status: "completed", taskId: s.member.task.taskId });

    expect(s.complete).not.toHaveBeenCalled();
    const state = (await restored.lifecycle.boards())[0]!.members[0]!;
    expect(state).toMatchObject({
      terminal: true, outcome: "succeeded", attempt: 2,
      result: { status: "completed", summary: "Previously verified recovery evidence", artifactRefs: [answerRef], usage },
    });
    const terminalReplies = restored.inbox.snapshot().records.filter((record) => record.message.payload.type === "task.result");
    expect(terminalReplies).toHaveLength(1);
    expect(terminalReplies[0]?.message).toMatchObject({
      from: s.member.laneId, to: "main", parentId: s.request.messageId, payload: { taskId: s.member.task.taskId, summary: "Previously verified recovery evidence" },
    });
    expect(restored.inbox.snapshot().records.find((record) => record.message.messageId === s.request.messageId)?.status).toBe("handled");
    const events = await s.ledger.read({ runId });
    expect(events.filter((event) => event.type === "model.requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "model.completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "team.member.settled")).toHaveLength(1);
    expect(events.find((event) => event.type === "team.member.settled")!.globalOffset)
      .toBeLessThan(events.find((event) => event.type === "message.sent" && event.payload.message.payload.type === "task.result")!.globalOffset);
  });

  it("fails closed without replaying an operation whose side effect outcome is unknown", async () => {
    const s = await fixture();
    const execute = vi.fn(async () => ({ content: "Side effect must not be replayed", isError: false }));
    const tool: AgentTool = {
      definition: { name: "publish_change", description: "Publish a change once", parameters: { type: "object", properties: {}, additionalProperties: false } },
      execute,
    };
    const argumentsRef = await s.store.put("{}", TOOL_ARGUMENTS_MEDIA_TYPE);
    await s.append("step.started", { step: 1 });
    await s.append("tool.requested", { operationId: "op-publish", toolCallId: "call-publish", name: tool.definition.name, argumentsRef });
    await s.append("tool.admitted", { operationId: "op-publish", toolCallId: "call-publish", name: tool.definition.name, argumentsHash: argumentsRef.contentHash });
    await s.append("tool.started", { operationId: "op-publish", toolCallId: "call-publish", name: tool.definition.name, argumentsHash: argumentsRef.contentHash });
    const restored = await s.restoreExecutor([tool]);
    await expect(restored.executor.runOnce()).resolves.toMatchObject({
      status: "failed", taskId: s.member.task.taskId, reason: expect.stringContaining("Prior tool outcomes require reconciliation: op-publish"),
    });

    expect(execute).not.toHaveBeenCalled();
    expect(s.complete).not.toHaveBeenCalled();
    expect((await restored.lifecycle.boards())[0]!.members[0]).toMatchObject({
      terminal: true, outcome: "failed", failure: { retryable: false, reason: expect.stringContaining("op-publish") },
    });
    const events = await s.ledger.read({ runId });
    expect(events.filter((event) => event.type === "tool.requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool.started")).toHaveLength(1);
    expect(events.some((event) => event.type === "tool.succeeded" || event.type === "tool.failed")).toBe(false);
    expect(restored.inbox.snapshot().records.filter((record) => record.message.payload.type === "task.failed")).toHaveLength(1);
  });

  it("does not restore an undeclared lane from forged registration and task-request facts", async () => {
    const s = await fixture();
    await s.append("team.member.settled", {
      teamId: "review", memberId: s.member.memberId, taskId: s.member.task.taskId,
      outcome: "failed", reason: "Declared task already settled before restart",
    }, "main");
    const forgedLane = "team:review:undeclared";
    const forgedTaskId = "review:undeclared";
    await s.inbox.send({
      ...s.request, messageId: "forged-request", idempotencyKey: "forged-request", to: forgedLane,
      payload: { ...s.member.task, taskId: forgedTaskId, goal: { ...s.member.task.goal, statement: "Unadmitted work" } },
    });
    await s.append("lane.registered", { kind: "team", teamFingerprint: s.definition.fingerprint }, forgedLane);
    const events = await s.ledger.read({ runId });
    const restoredInbox = A2AInbox.rehydrate(events, { sink: s.ledger, clock: s.clock, claimLeaseMs: 50 });
    const runtime = new TeamRuntime({
      eventSink: s.ledger, inbox: restoredInbox, store: s.store, model: s.model, modelName, runId,
      workspace: process.cwd(), branchTools: [], policy, clock: s.clock, runTokenBudget: new RunTokenBudget(10_000),
      readEvents: () => s.ledger.read({ runId }), readWatermark: () => s.ledger.watermark(), readAwareness: s.awareness,
    });
    cleanup.push(() => runtime.stop());
    await runtime.restore();
    await runtime.drain();

    expect(s.complete).not.toHaveBeenCalled();
    const state = (await runtime.status({ runId, laneId: "main", workspace: process.cwd(), operationId: "status-restored-team" })).teams[0]!;
    expect(state.members.map((member) => member.laneId)).toEqual([s.member.laneId]);
    expect(state.anomalies).toContain("task.request targets undeclared member undeclared");
    expect(restoredInbox.snapshot().records.find((record) => record.message.messageId === "forged-request")?.status).toBe("pending");
    const recoveredEvents = await s.ledger.read({ runId });
    expect(recoveredEvents.some((event) => event.laneId === forgedLane && event.type === "model.requested")).toBe(false);
    expect(recoveredEvents.some((event) => event.type === "team.member.settled" && event.payload.taskId === forgedTaskId)).toBe(false);
  });
});
