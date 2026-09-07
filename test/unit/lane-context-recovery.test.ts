import { describe, expect, it } from "vitest";

import { A2AInbox } from "../../src/a2a/index.js";
import type { ConversationMessage, Goal } from "../../src/domain/types.js";
import type { ModelResponse } from "../../src/domain/ports.js";
import { ContentStoreFukaiSource, FukaiContextProvider } from "../../src/fukai/index.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import { createInRunAgentMessageTool } from "../../src/runtime/in-run-agent-message-tool.js";
import { LaneMailbox } from "../../src/runtime/lane-mailbox.js";
import { MainLoop } from "../../src/runtime/main-loop.js";
import { recoverLaneConversationRefs } from "../../src/runtime/recovery.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

const runId = "boundary-recovery-run";
const goal: Goal = {
  version: 1,
  statement: "Inspect the assigned objective",
  successCriteria: ["Report supported findings"],
  hardConstraints: [],
};
const policy = {
  maxMainStepsPerActivation: 1,
  maxModelTokens: 10_000,
  tetoEnabled: false,
  tetoMaxOutputTokens: 128,
  tetoTokenRatio: 0,
};

function response(content: string): ModelResponse {
  return { content, toolCalls: [], stopReason: "stop", usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 } };
}

function setup(laneId: string) {
  let time = Date.parse("2026-09-07T00:00:00.000Z");
  const clock = { now: () => new Date(time) };
  const ledger = new MemoryLedger({ clock });
  const store = new MemoryContentAddressedStore();
  const inbox = new A2AInbox({ sink: ledger, clock, claimLeaseMs: 100 });
  const sender = laneId === "main" ? "team:research:peer" : "main";
  const tool = createInRunAgentMessageTool({ inbox, runId, from: sender, to: laneId, now: clock.now });
  const createMailbox = (activeInbox = inbox, events: Awaited<ReturnType<MemoryLedger["read"]>> = []) => new LaneMailbox({
    inbox: activeInbox, runId, laneId, resolveSenders: () => [sender], events,
  });
  const input = {
    runId, laneId, model: "scripted-model", workspace: "/workspace", goal, policy,
    includeProjectInstructions: false,
    completionMode: "none" as const,
  };
  const createLoop = (model: ScriptedModel, mailbox: LaneMailbox, acknowledge = false) => new MainLoop({
    model,
    contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
    conversationStore: store,
    eventSink: ledger,
    tools: [],
    clock,
    includeProjectInstructions: false,
    beforeStep: (context) => mailbox.beforeStep(context),
    ...(acknowledge ? { afterStepAsync: (context) => mailbox.afterStep(context) } : {}),
  });
  return {
    ledger, store, inbox, clock, input, createMailbox, createLoop,
    advance: (milliseconds: number) => { time += milliseconds; },
    send: (text: string, operationId: string) => tool.execute({ text }, {
      runId, laneId: sender, workspace: "/workspace", operationId,
    }),
  };
}

describe("durable lane boundary context", () => {
  it.each(["main", "team:research:member"])("recovers %s boundary messages in source order before its assistant and repairs missing receipts", async (laneId) => {
    const { ledger, store, inbox, clock, input, createMailbox, createLoop, send } = setup(laneId);
    const otherLane = laneId === "main" ? "team:other:private" : "main";
    const privateRef = await store.put(JSON.stringify({
      role: "user", content: "Private unrelated context", createdAt: clock.now().toISOString(),
    }), "application/vnd.nausicaa.conversation-message+json");
    await ledger.append({
      runId, laneId: otherLane, type: "user.message", payload: { messageRef: privateRef },
      correlationId: runId, idempotencyKey: "other-input", visibility: "lane",
    });
    const first = await send("First collaborator finding", "note-first");
    const second = await send("Second collaborator finding", "note-second");
    const messageIds = [JSON.parse(first.content).messageId, JSON.parse(second.content).messageId];
    const initialModel = new ScriptedModel([response("Assistant considers both findings")]);
    await createLoop(initialModel, createMailbox()).run({ ...input, initialMessage: "Original objective" });

    const events = await ledger.read({ runId });
    const committed = events.find((event) => event.type === "step.completed" && event.laneId === laneId);
    expect(committed?.type).toBe("step.completed");
    if (committed?.type !== "step.completed") throw new Error("Expected a committed step");
    expect(committed.payload.boundaryMessageIds).toEqual(messageIds);
    expect(committed.payload.boundaryMessages?.map((item) => item.messageId)).toEqual(messageIds);
    expect(events.filter((event) => event.type === "user.message" && event.laneId === laneId)).toHaveLength(1);
    expect(inbox.snapshot().records.every((record) => record.status === "claimed")).toBe(true);

    const refs = recoverLaneConversationRefs(events, laneId);
    const recoveredMessages = await Promise.all(refs.map(async ({ ref }) => JSON.parse(
      new TextDecoder().decode(await store.get(ref)),
    ) as ConversationMessage));
    expect(recoveredMessages.map((item) => item.content)).toEqual([
      "Original objective",
      expect.stringContaining("First collaborator finding"),
      expect.stringContaining("Second collaborator finding"),
      "Assistant considers both findings",
    ]);
    expect(refs.filter((item) => item.groupId?.startsWith(`${runId}:boundary:`)).map((item) => item.ref))
      .toEqual(committed.payload.boundaryMessages?.map((item) => item.messageRef));

    const restartedInbox = A2AInbox.rehydrate(events, { sink: ledger, clock, claimLeaseMs: 100 });
    const resumedModel = new ScriptedModel([response("Assistant continues")]);
    await createLoop(resumedModel, createMailbox(restartedInbox, events), true).run({
      ...input, startStep: 2, conversationRefs: refs,
    });
    expect(resumedModel.requests[0]?.messages.map((item) => item.content)).toEqual(recoveredMessages.map((item) => item.content));
    expect(restartedInbox.snapshot().records.every((record) => record.status === "handled")).toBe(true);
    const resumedEvents = await ledger.read({ runId });
    const resumedCommit = resumedEvents.find((event) => event.type === "step.completed" && event.laneId === laneId && event.payload.step === 2);
    expect(resumedCommit?.payload).toMatchObject({ boundaryMessageIds: [] });
    expect(resumedEvents.filter((event) => event.type === "message.handled")).toHaveLength(2);
    expect(resumedEvents.filter((event) => event.type === "user.message" && event.laneId === laneId)).toHaveLength(1);
  });

  it.each(["main", "team:research:member"])("does not recover uncommitted %s boundary refs and redelivers after the old claim lease", async (laneId) => {
    const { ledger, inbox, clock, input, createMailbox, createLoop, send, advance } = setup(laneId);
    const sent = await send("Finding awaiting a committed read", "uncommitted-note");
    const messageId = JSON.parse(sent.content).messageId;
    await expect(createLoop(new ScriptedModel([new Error("provider failed")]), createMailbox()).run({
      ...input, initialMessage: "Original objective",
    })).rejects.toThrow("provider failed");
    const events = await ledger.read({ runId });
    expect(events.some((event) => event.type === "step.completed")).toBe(false);
    const refs = recoverLaneConversationRefs(events, laneId);
    expect(refs).toHaveLength(1);
    expect(refs.every((ref) => !ref.groupId?.startsWith(`${runId}:boundary:`))).toBe(true);
    expect(inbox.snapshot().records[0]?.status).toBe("claimed");

    advance(101);
    const restartedInbox = A2AInbox.rehydrate(events, { sink: ledger, clock, claimLeaseMs: 100 });
    const resumedModel = new ScriptedModel([response("Now the finding is consumed")]);
    await createLoop(resumedModel, createMailbox(restartedInbox, events), true).run({
      ...input, startStep: 2, conversationRefs: refs,
    });
    expect(resumedModel.requests[0]?.messages.map((item) => item.content)).toEqual([
      "Original objective", expect.stringContaining("Finding awaiting a committed read"),
    ]);
    expect(restartedInbox.snapshot().records[0]?.status).toBe("handled");
    const resumedEvents = await ledger.read({ runId });
    const committed = resumedEvents.find((event) => event.type === "step.completed");
    expect(committed?.payload).toMatchObject({ boundaryMessageIds: [messageId] });
    expect(resumedEvents.filter((event) => event.type === "user.message" && event.laneId === laneId)).toHaveLength(1);
  });
});
