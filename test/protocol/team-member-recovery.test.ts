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

async function fixture(options: { maxAttempts?: number; maxModelTokens?: number; messageSenders?: readonly string[] } = {}) {
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
        inputRefs: [], budget: { maxModelTokens: options.maxModelTokens ?? 1_000, maxWallClockMs: 60_000, maxAttempts: options.maxAttempts ?? 3, deadline: new Date(now + 60_000).toISOString() },
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
    const events = await ledger.read();
    const restoredInbox = A2AInbox.rehydrate(events, { sink: ledger, clock, claimLeaseMs: 50 });
    const lifecycle = new TeamLifecycle({
      runId, leadLaneId: "main", ledger, inbox: restoredInbox, clock,
      readEvents: () => ledger.read(), stopMember: async () => undefined,
    });
    cleanup.push(() => lifecycle.close());
    const executor = new TeamBranchExecutor({
      eventSink: ledger, inbox: restoredInbox, store, model, modelName, runId,
      parentLaneId: "main", branchLaneId: member.laneId, goal: member.task.goal, taskDefinition: member.task,
      policy, tools, workspace: process.cwd(), runTokenBudget: new RunTokenBudget(10_000),
      clock, events, createId: () => `recovered-${++sequence}`,
      readEvents: () => ledger.read(), readWatermark: () => ledger.watermark(), readAwareness: awareness,
      resolveMessageSenders: () => options.messageSenders ?? ["main"],
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

async function seedAttempt(
  s: Awaited<ReturnType<typeof fixture>>,
  outcome: "length" | "failed" | "unfinished" = "length",
) {
  await s.append("step.started", { step: 1 });
  await s.append("model.requested", {
    model: modelName, requestHash: "prior-call", contextWatermark: await s.ledger.watermark(),
  });
  if (outcome === "failed") {
    await s.append("model.failed", { model: modelName, error: "Interrupted provider attempt", retryable: true });
  } else if (outcome === "length") {
    const responseRef = await s.store.put(JSON.stringify({
      role: "assistant", content: "Prior truncated evidence", toolCalls: [], createdAt: s.clock.now().toISOString(),
    }), MESSAGE_MEDIA_TYPE);
    await s.append("model.completed", { model: modelName, responseRef, stopReason: "length", usage });
  }
}

describe("Team member recovery", () => {
  it.each([1, 2])("checks pending peer evidence before reusing a final response with a %i-attempt allowance", async (maxAttempts) => {
    const peer = "team:review:peer";
    const s = await fixture({ maxAttempts, maxModelTokens: 10_000, messageSenders: ["main", peer] });
    const responseRef = await s.store.put(JSON.stringify({
      role: "assistant", content: "Initial report before peer evidence arrived", toolCalls: [], createdAt: s.clock.now().toISOString(),
    }), MESSAGE_MEDIA_TYPE);
    await s.append("step.started", { step: 1 });
    await s.append("model.requested", { model: modelName, requestHash: "final-before-crash", contextWatermark: await s.ledger.watermark() });
    await s.append("model.completed", { model: modelName, responseRef, stopReason: "stop", usage });
    const messageId = "pending-peer-after-final-model";
    await s.inbox.send({
      ...s.request, messageId, idempotencyKey: messageId, from: peer, to: s.member.laneId,
      payload: { type: "message.inform", text: "Recovered peer evidence: shipping is 6" },
    });
    s.complete.mockResolvedValue({ content: "Revised report using the peer evidence", toolCalls: [], stopReason: "stop", usage });
    const restored = await s.restoreExecutor();
    await restored.executor.runOnce();

    expect(s.complete).toHaveBeenCalledTimes(maxAttempts - 1);
    const events = await s.ledger.read({ runId });
    const consumed = events.filter((event) => event.type === "step.completed" && event.laneId === s.member.laneId
      && event.payload.boundaryMessageIds?.includes(messageId));
    const state = (await restored.lifecycle.boards())[0]!.members[0]!;
    const message = restored.inbox.snapshot().records.find((record) => record.message.messageId === messageId)!;
    if (maxAttempts === 2) {
      expect(s.complete.mock.calls[0]?.[0].messages.map((item) => item.content).join("\n")).toContain("Recovered peer evidence: shipping is 6");
      expect(state).toMatchObject({ outcome: "succeeded", result: { summary: "Revised report using the peer evidence" } });
      expect(consumed).toHaveLength(1);
      expect(message.status).toBe("handled");
    } else {
      expect(state).toMatchObject({ outcome: "failed", failure: { reason: expect.stringContaining("model attempt budget exhausted (1/1)") } });
      expect(state.result).toBeUndefined();
      expect(consumed).toHaveLength(0);
      expect(message.status).toBe("pending");
    }
    expect(events.filter((event) => event.type === "model.requested" && event.laneId === s.member.laneId)).toHaveLength(maxAttempts);
  });

  it.each(["", " \n\t"])("fails a recovered empty final report without another model call: %j", async (content) => {
    const s = await fixture({ maxAttempts: 1 });
    const responseRef = await s.store.put(JSON.stringify({
      role: "assistant", content, toolCalls: [], createdAt: s.clock.now().toISOString(),
    }), MESSAGE_MEDIA_TYPE);
    await s.append("step.started", { step: 1 });
    await s.append("model.requested", { model: modelName, requestHash: "empty-final", contextWatermark: await s.ledger.watermark() });
    await s.append("model.completed", { model: modelName, responseRef, stopReason: "stop", usage });
    const restored = await s.restoreExecutor();

    await expect(restored.executor.runOnce()).resolves.toMatchObject({
      status: "failed", reason: expect.stringContaining("model completed without a non-empty report"),
    });
    expect(s.complete).not.toHaveBeenCalled();
    expect((await restored.lifecycle.boards())[0]?.members[0]).toMatchObject({
      outcome: "failed", failure: { evidenceRefs: [], retryable: false },
    });
    expect(restored.inbox.snapshot().records.some((record) => record.message.payload.type === "task.result")).toBe(false);
  });

  it.each(["", " \n\t"])("fails a fresh empty final report without inventing a summary: %j", async (content) => {
    const s = await fixture({ maxAttempts: 2, maxModelTokens: 10_000 });
    s.complete.mockResolvedValue({ content, toolCalls: [], stopReason: "stop", usage });
    const restored = await s.restoreExecutor();
    await expect(restored.executor.runOnce()).resolves.toMatchObject({
      status: "failed", reason: expect.stringContaining("model completed without a non-empty report"),
    });
    expect(s.complete).toHaveBeenCalledTimes(1);
    expect((await restored.lifecycle.boards())[0]?.members[0]).toMatchObject({
      outcome: "failed", failure: { evidenceRefs: [], retryable: false },
    });
    expect(restored.inbox.snapshot().records.some((record) => record.message.payload.type === "task.result")).toBe(false);
  });

  it("identifies an empty model output-limit response without a serialization error", async () => {
    const s = await fixture({ maxAttempts: 2, maxModelTokens: 10_000 });
    s.complete.mockResolvedValue({ content: "", toolCalls: [], stopReason: "length", usage });
    const restored = await s.restoreExecutor();
    await expect(restored.executor.runOnce()).resolves.toMatchObject({
      status: "failed", reason: expect.stringContaining("model output limit reached without a non-empty report"),
    });
    expect(s.complete).toHaveBeenCalledTimes(1);
  });

  it("reuses a committed final model response after a crash before task settlement", async () => {
    const s = await fixture({ maxAttempts: 1 });
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

  it.each(["length", "failed", "unfinished"] as const)(
    "does not reset exhausted attempts after a %s provider request",
    async (outcome) => {
      const s = await fixture({ maxAttempts: 1, maxModelTokens: 10_000 });
      await seedAttempt(s, outcome);
      const restored = await s.restoreExecutor();

      await expect(restored.executor.runOnce()).resolves.toMatchObject({
        status: "failed", taskId: s.member.task.taskId,
        reason: expect.stringContaining("model attempt budget exhausted (1/1)"),
      });
      expect(s.complete).not.toHaveBeenCalled();
      expect((await restored.lifecycle.boards())[0]?.members[0]).toMatchObject({
        outcome: "failed", failure: { retryable: false, reason: expect.stringContaining("model attempt budget exhausted") },
      });
      expect((await s.ledger.read({ runId })).filter((event) => event.type === "model.requested")).toHaveLength(1);
    },
  );

  it.each([
    { maxAttempts: 3, remainingCalls: 2 },
    { maxAttempts: 8, remainingCalls: 3 },
  ])("bounds resumed work by remaining attempts and host allowance: %j", async ({ maxAttempts, remainingCalls }) => {
    const s = await fixture({ maxAttempts, maxModelTokens: 10_000 });
    await seedAttempt(s);
    const execute = vi.fn(async () => ({ content: "Verified read-only evidence", isError: false }));
    const tool: AgentTool = {
      definition: {
        name: "read_file", description: "Read evidence",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      },
      execute,
    };
    s.complete.mockImplementation(async () => ({
      content: "Continue inspecting evidence", stopReason: "toolUse", usage,
      toolCalls: [{ id: `read-${s.complete.mock.calls.length}`, name: "read_file", arguments: { path: "evidence.txt" } }],
    }));
    const restored = await s.restoreExecutor([tool]);
    await restored.executor.runOnce();

    expect(s.complete).toHaveBeenCalledTimes(remainingCalls);
    expect(execute).toHaveBeenCalledTimes(remainingCalls);
    expect((await restored.lifecycle.boards())[0]?.members[0]).toMatchObject({
      terminal: true, outcome: "partial", result: { status: "partial" },
    });
    const events = await s.ledger.read({ runId });
    expect(events.filter((event) => event.type === "model.requested")).toHaveLength(1 + remainingCalls);
    expect(events.filter((event) => event.type === "step.started").map((event) => event.payload.step))
      .toEqual(Array.from({ length: 1 + remainingCalls }, (_value, index) => index + 1));
  });

  it("does not charge other lanes or Runs against the recovered task's attempts", async () => {
    const s = await fixture({ maxAttempts: 2, maxModelTokens: 10_000 });
    await seedAttempt(s);
    for (const laneId of ["main", "team:review:other", `${s.member.laneId}:teto`]) {
      await s.append("model.requested", {
        model: modelName, requestHash: "other-lane-call", contextWatermark: await s.ledger.watermark(),
      }, laneId);
    }
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await s.ledger.append({
        runId: "different-run", laneId: s.member.laneId, type: "model.requested",
        payload: { model: modelName, requestHash: "other-run-call", contextWatermark: await s.ledger.watermark() },
        correlationId: "other-run", idempotencyKey: `other-run-attempt-${attempt}`,
      });
    }
    s.complete.mockResolvedValue({ content: "Verified final evidence", toolCalls: [], stopReason: "stop", usage });
    const restored = await s.restoreExecutor();
    await expect(restored.executor.runOnce()).resolves.toMatchObject({ status: "completed" });

    expect(s.complete).toHaveBeenCalledTimes(1);
    expect((await restored.lifecycle.boards())[0]?.members[0]).toMatchObject({ outcome: "succeeded" });
    expect((await s.ledger.read({ runId }))
      .filter((event) => event.laneId === s.member.laneId && event.type === "model.requested")).toHaveLength(2);
  });

  it("fails closed without replaying an operation whose side effect outcome is unknown", async () => {
    const s = await fixture({ maxAttempts: 1 });
    const execute = vi.fn(async () => ({ content: "Side effect must not be replayed", isError: false }));
    const tool: AgentTool = {
      definition: { name: "publish_change", description: "Publish a change once", parameters: { type: "object", properties: {}, additionalProperties: false } },
      execute,
    };
    const argumentsRef = await s.store.put("{}", TOOL_ARGUMENTS_MEDIA_TYPE);
    await s.append("step.started", { step: 1 });
    await s.append("model.requested", { model: modelName, requestHash: "prior-tool-call", contextWatermark: await s.ledger.watermark() });
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
