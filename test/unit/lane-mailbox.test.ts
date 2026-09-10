import { describe, expect, it, vi } from "vitest";

import {
  A2AInbox,
  createCrossRunMessageId,
  createCrossRunRouteId,
  envelopeToA2AMessage,
} from "../../src/a2a/index.js";
import type { A2AMessage } from "../../src/domain/types.js";
import type { AgentTool, ToolExecutionContext } from "../../src/domain/ports.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { validateArguments } from "../../src/mowe/admission.js";
import { createAgentMessageTool } from "../../src/runtime/agent-message-tool.js";
import {
  composeAgentMessageTools,
  createInRunAgentMessageTool,
} from "../../src/runtime/in-run-agent-message-tool.js";
import { LaneMailbox } from "../../src/runtime/lane-mailbox.js";

const runId = "run-1";
const memberA = "team:research:a";
const memberB = "team:research:b";
const timestamp = "2026-09-07T00:00:00.000Z";
const context: ToolExecutionContext = {
  runId,
  laneId: memberA,
  workspace: "/workspace",
  operationId: "operation-1",
};

function setup() {
  let milliseconds = Date.parse(timestamp);
  const clock = { now: () => new Date(milliseconds) };
  const ledger = new MemoryLedger({ clock });
  const inbox = new A2AInbox({ sink: ledger, clock, claimLeaseMs: 100 });
  return { ledger, inbox, clock, advance: (amount: number) => { milliseconds += amount; } };
}

function message(id: string, overrides: Partial<A2AMessage> = {}): A2AMessage {
  return {
    messageId: id,
    runId,
    conversationId: runId,
    threadId: `${runId}:${memberB}`,
    from: memberA,
    to: memberB,
    createdAt: timestamp,
    correlationId: runId,
    idempotencyKey: `send:${id}`,
    visibility: "run",
    priority: 1,
    delivery: "next-step",
    payload: { type: "message.inform", text: `Note ${id}` },
    ...overrides,
  };
}

function mailbox(inbox: A2AInbox, overrides: Partial<ConstructorParameters<typeof LaneMailbox>[0]> = {}) {
  return new LaneMailbox({
    inbox,
    runId,
    laneId: memberB,
    resolveSenders: () => [memberA, "main"],
    ...overrides,
  });
}

describe("in-Run agent_message", () => {
  it.each(["nausicaa", "main"])("routes %s to the canonical owner and preserves retries across aliases", async (target) => {
    const { inbox, ledger, clock } = setup();
    const tool = createInRunAgentMessageTool({ inbox, runId, now: clock.now });
    const tetoContext = { ...context, laneId: "teto" };
    const text = "Check the user's requested main branch before continuing";
    const first = await tool.execute({ target, text }, tetoContext);
    const retry = await tool.execute({ target: target === "main" ? "nausicaa" : "main", text }, tetoContext);

    expect(first.isError).toBe(false);
    expect(retry.isError).toBe(false);
    expect(JSON.parse(first.content)).toMatchObject({ status: "queued", from: "teto", to: "nausicaa" });
    expect(JSON.parse(retry.content)).toMatchObject({
      status: "duplicate", messageId: JSON.parse(first.content).messageId, to: "nausicaa",
    });
    expect(inbox.snapshot().records).toHaveLength(1);
    expect(inbox.snapshot().records[0]?.message).toMatchObject({
      from: "teto", to: "main", payload: { type: "message.inform", text },
    });
    const sent = (await ledger.read({ runId })).filter((event) => event.type === "message.sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload.message.to).toBe("main");
  });

  it("rechecks the owner's grant before accepting a public-name retry", async () => {
    const { inbox, ledger, clock } = setup();
    let targets = ["main"];
    const tool = createInRunAgentMessageTool({
      inbox, runId, from: memberA, resolveTargets: () => targets, now: clock.now,
    });
    const arguments_ = { target: "nausicaa", text: "The current approach misses a requirement" };
    expect((await tool.execute(arguments_, context)).isError).toBe(false);
    const admitted = await ledger.read({ runId });

    targets = [memberB];
    const deniedRetry = await tool.execute(arguments_, context);
    const deniedNewSend = await tool.execute(arguments_, { ...context, operationId: "operation-2" });
    for (const result of [deniedRetry, deniedNewSend]) {
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).error).toContain("target nausicaa is not authorized");
    }
    expect(await ledger.read({ runId })).toEqual(admitted);
    expect(inbox.snapshot().records).toHaveLength(1);
  });

  it("checks replies against the canonical owner's original message", async () => {
    const { inbox, clock } = setup();
    await inbox.send(message("owner-question", {
      from: "main", to: memberA, payload: { type: "question.ask", question: "Is the approach sound?" },
    }));
    await inbox.send(message("peer-question", { from: memberB, to: memberA }));
    await inbox.send(message("other-owner-question", { from: "main", to: memberB }));
    const tool = createInRunAgentMessageTool({ inbox, runId, from: memberA, to: "main", now: clock.now });
    const result = await tool.execute({ target: "nausicaa", text: "One requirement is missing", replyTo: "owner-question" }, context);

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({ from: memberA, to: "nausicaa" });
    expect(inbox.snapshot().records.find((record) => record.message.messageId === JSON.parse(result.content).messageId)?.message).toMatchObject({
      from: memberA, to: "main", replyTo: "owner-question",
    });
    for (const replyTo of ["peer-question", "other-owner-question"]) {
      const rejected = await tool.execute({ target: "nausicaa", text: "Not my owner's question", replyTo }, {
        ...context, operationId: `reply:${replyTo}`,
      });
      expect(rejected.isError).toBe(true);
      expect(JSON.parse(rejected.content).error).toContain("replyTo must reference a message from this recipient");
    }
    expect(inbox.snapshot().records).toHaveLength(4);
  });

  it("keeps a nested Teto bound to its actual Team owner", async () => {
    const { inbox, clock } = setup();
    const observer = `${memberA}:teto`;
    const tool = createInRunAgentMessageTool({ inbox, runId, from: observer, to: memberA, now: clock.now });
    const observerContext = { ...context, laneId: observer };
    for (const target of ["nausicaa", "main"]) {
      expect((await tool.execute({ target, text: "Do not route this to the root" }, observerContext)).isError).toBe(true);
    }
    expect(inbox.snapshot().records).toEqual([]);

    const result = await tool.execute({ target: memberA, text: "Your repeated search has returned no new evidence" }, observerContext);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({ from: observer, to: memberA });
    expect(inbox.snapshot().records[0]?.message).toMatchObject({ from: observer, to: memberA });
  });

  it("projects the root sender name without changing the identity used by the host", async () => {
    const { inbox, clock } = setup();
    const onMessage = vi.fn();
    const tool = createInRunAgentMessageTool({
      inbox, runId, from: "main", to: memberA, now: clock.now, onMessage,
    });
    const text = "Inspect main.ts and report evidence";
    const result = await tool.execute({ text }, { ...context, laneId: "main" });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({ from: "nausicaa", to: memberA });
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      from: "main", to: memberA, payload: { type: "message.inform", text },
    }));
    expect(inbox.snapshot().records[0]?.message.from).toBe("main");
  });

  it("preserves the host-fixed Teto text call and refuses another target", async () => {
    const { inbox, clock } = setup();
    const tool = createInRunAgentMessageTool({ inbox, runId, now: clock.now });
    const tetoContext = { ...context, laneId: "teto" };
    const result = await tool.execute({ text: "Check the requirements" }, tetoContext);
    expect(result.isError).toBe(false);
    expect(inbox.snapshot().records[0]?.message).toMatchObject({
      from: "teto",
      to: "main",
      payload: { type: "message.inform", text: "Check the requirements" },
    });
    expect((await tool.execute({ target: memberB, text: "wrong target" }, {
      ...tetoContext,
      operationId: "operation-2",
    })).isError).toBe(true);
    expect(inbox.snapshot().records).toHaveLength(1);
  });

  it("resolves current targets on every send, including a retried operation", async () => {
    const { inbox, clock } = setup();
    let targets = [memberB];
    const resolveTargets = vi.fn(() => targets);
    const tool = createInRunAgentMessageTool({ inbox, runId, from: memberA, resolveTargets, now: clock.now });
    expect((await tool.execute({ target: memberB, kind: "request", text: "What did you find?" }, context)).isError).toBe(false);
    expect(inbox.snapshot().records[0]?.message.payload).toEqual({ type: "question.ask", question: "What did you find?" });
    targets = ["main"];
    expect((await tool.execute({ target: memberB, kind: "request", text: "What did you find?" }, context)).isError).toBe(true);
    expect((await tool.execute({ target: "main", kind: "progress", text: "Inspection is underway" }, {
      ...context,
      operationId: "operation-2",
    })).isError).toBe(false);
    expect(resolveTargets).toHaveBeenCalledTimes(3);
    expect(inbox.snapshot().records).toHaveLength(2);
  });

  it("binds both Run and lane identity before sending", async () => {
    const { inbox } = setup();
    const resolveTargets = vi.fn(() => [memberB]);
    const tool = createInRunAgentMessageTool({ inbox, runId, from: memberA, resolveTargets });
    for (const changed of [{ runId: "another-run" }, { laneId: memberB }]) {
      expect((await tool.execute({ target: memberB, text: "hello" }, { ...context, ...changed })).isError).toBe(true);
    }
    expect(resolveTargets).not.toHaveBeenCalled();
    expect(inbox.snapshot().records).toEqual([]);
  });

  it.each([
    { from: "main" },
    { to: "main" },
    { visibility: "user" },
    { runId: "another-run" },
    { artifactRefs: ["private-ref"] },
    { maxPendingMessages: 1_000 },
    { expiresAt: "2099-01-01T00:00:00.000Z" },
    { target: null },
    { kind: "task.result" },
    { text: "" },
    { text: "x".repeat(8_193) },
    { text: "bad\u0000text" },
  ])("rejects forged, unsupported, or unbounded arguments case %#", async (extra) => {
    const { inbox } = setup();
    const tool = createInRunAgentMessageTool({ inbox, runId, from: memberA, to: memberB });
    expect((await tool.execute({ text: "hello", ...extra }, context)).isError).toBe(true);
    expect(inbox.snapshot().records).toEqual([]);
  });

  it("keeps one durable message and its original expiry after restart and delayed retry", async () => {
    const { inbox, ledger, clock, advance } = setup();
    const options = { inbox, runId, from: memberA, to: memberB, now: clock.now, ttlMs: 1_000 };
    const tool = createInRunAgentMessageTool(options);
    const first = await tool.execute({ text: "stable note" }, context);
    expect(JSON.parse(first.content).status).toBe("queued");
    advance(2_000);
    const replayed = A2AInbox.rehydrate(await ledger.read({ runId }), { sink: ledger, clock });
    const retry = await createInRunAgentMessageTool({ ...options, inbox: replayed }).execute({ text: "stable note" }, context);
    expect(JSON.parse(retry.content)).toMatchObject({
      status: "duplicate",
      messageId: JSON.parse(first.content).messageId,
    });
    expect(replayed.snapshot().records).toHaveLength(1);
    expect(replayed.snapshot().records[0]?.message.expiresAt).toBe("2026-09-07T00:00:01.000Z");
    expect((await createInRunAgentMessageTool({ ...options, inbox: replayed }).execute({ text: "changed note" }, context)).isError).toBe(true);
    expect(replayed.snapshot().records).toHaveLength(1);
  });

  it("does not let an operation retry choose a second authorized recipient", async () => {
    const { inbox, clock } = setup();
    const tool = createInRunAgentMessageTool({
      inbox, runId, from: memberA, resolveTargets: () => [memberB, "main"], now: clock.now,
    });
    await tool.execute({ target: memberB, text: "one delivery" }, context);
    const result = await tool.execute({ target: "main", text: "one delivery" }, context);
    expect(result.isError).toBe(true);
    expect(inbox.snapshot().records).toHaveLength(1);
  });

  it("serializes simultaneous retries so a clock change cannot create a second envelope", async () => {
    const { inbox, clock, advance } = setup();
    const tool = createInRunAgentMessageTool({
      inbox, runId, from: memberA, to: memberB,
      now: () => { advance(1); return clock.now(); },
    });
    const receipts = await Promise.all([
      tool.execute({ text: "one delivery" }, context),
      tool.execute({ text: "one delivery" }, context),
    ]);
    expect(receipts.map((result) => JSON.parse(result.content).status)).toEqual(["queued", "duplicate"]);
    expect(inbox.snapshot().records).toHaveLength(1);
  });

  it("permits replies only to a message sent by that recipient to the current lane", async () => {
    const { inbox, clock } = setup();
    await inbox.send(message("question", {
      from: memberB, to: memberA, payload: { type: "question.ask", question: "What did you find?" },
    }));
    await inbox.send(message("unrelated", { from: "main", to: memberB }));
    const tool = createInRunAgentMessageTool({ inbox, runId, from: memberA, to: memberB, now: clock.now });
    expect((await tool.execute({ text: "The tests pass", replyTo: "question" }, context)).isError).toBe(false);
    expect(inbox.snapshot().records.some(({ message }) => message.replyTo === "question")).toBe(true);
    expect((await tool.execute({ text: "pretend reply", replyTo: "unrelated" }, {
      ...context, operationId: "operation-2",
    })).isError).toBe(true);
  });

  it("reports a wake failure without losing the durable delivery receipt", async () => {
    const { inbox, clock } = setup();
    const tool = createInRunAgentMessageTool({
      inbox, runId, from: memberA, to: memberB, now: clock.now,
      onMessage: async () => { throw new Error("wake unavailable"); },
    });
    const result = await tool.execute({ text: "durable note" }, context);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({ status: "queued", wakePending: true });
    expect(inbox.snapshot().records).toHaveLength(1);
  });

  it("checks abort again after asynchronous target resolution", async () => {
    const { inbox } = setup();
    const controller = new AbortController();
    const tool = createInRunAgentMessageTool({
      inbox, runId, from: memberA,
      resolveTargets: async () => { controller.abort(); return [memberB]; },
    });
    expect((await tool.execute({ target: memberB, text: "cancelled" }, {
      ...context, signal: controller.signal,
    })).isError).toBe(true);
    expect(inbox.snapshot().records).toEqual([]);
  });

  it("snapshots host identity while permitting fresh topology grants", async () => {
    const { inbox, clock } = setup();
    const options = { inbox, runId, from: memberA, to: memberB, now: clock.now };
    const tool = createInRunAgentMessageTool(options);
    options.runId = "changed-run";
    options.from = "changed-lane";
    expect((await tool.execute({ text: "bound identity" }, context)).isError).toBe(false);
    expect(inbox.snapshot().records[0]?.message).toMatchObject({ runId, from: memberA });
  });

  it("rejects invalid host TTLs", () => {
    for (const ttlMs of [0, -1, 86_400_001, Infinity, 1.5]) {
      expect(() => createInRunAgentMessageTool({ inbox: new A2AInbox(), runId, ttlMs })).toThrow(/ttlMs/);
    }
  });

  it("returns sender backpressure for new sends while admitting existing operation retries", async () => {
    const { inbox, clock } = setup();
    const tool = createInRunAgentMessageTool({
      inbox, runId, from: memberA, to: memberB, now: clock.now, maxPendingMessages: 1,
    });
    expect(JSON.parse((await tool.execute({ text: "first" }, context)).content).status).toBe("queued");
    expect(JSON.parse((await tool.execute({ text: "first" }, context)).content).status).toBe("duplicate");
    const blocked = await tool.execute({ text: "second" }, { ...context, operationId: "operation-2" });
    expect(blocked.isError).toBe(true);
    expect(JSON.parse(blocked.content)).toMatchObject({ status: "error", code: "backpressure" });
    expect(inbox.snapshot().records).toHaveLength(1);
  });

  it("releases capacity after handle and expiry without deleting durable messages", async () => {
    const { inbox, clock, advance } = setup();
    const tool = createInRunAgentMessageTool({
      inbox, runId, from: memberA, to: memberB, now: clock.now, ttlMs: 100, maxPendingMessages: 1,
    });
    const first = await tool.execute({ text: "first" }, context);
    await inbox.claim(memberB, memberB, { runId });
    await inbox.handle(JSON.parse(first.content).messageId, memberB);
    expect((await tool.execute({ text: "second" }, { ...context, operationId: "operation-2" })).isError).toBe(false);
    advance(101);
    expect((await tool.execute({ text: "third" }, { ...context, operationId: "operation-3" })).isError).toBe(false);
    expect(inbox.snapshot().records).toHaveLength(3);
  });

  it("enforces the recipient cap across different senders and still accepts an existing retry", async () => {
    const { inbox, clock } = setup();
    const tool = createInRunAgentMessageTool({ inbox, runId, from: memberA, to: memberB, now: clock.now });
    await tool.execute({ text: "admitted" }, context);
    for (let index = 0; index < 255; index += 1) {
      await inbox.send(message(`recipient-backlog-${index}`, { from: `sender-${index}` }));
    }
    expect(JSON.parse((await tool.execute({ text: "admitted" }, context)).content).status).toBe("duplicate");
    const blocked = await tool.execute({ text: "over capacity" }, { ...context, operationId: "operation-2" });
    expect(JSON.parse(blocked.content)).toMatchObject({ code: "backpressure", error: expect.stringContaining("Inbox message limit") });
    expect(inbox.snapshot().records).toHaveLength(256);
  });

  it("serializes quota checks across tool instances sharing one Inbox", async () => {
    const { inbox, clock } = setup();
    const options = { inbox, runId, from: memberA, to: memberB, now: clock.now, maxPendingMessages: 1 };
    const receipts = await Promise.all([
      createInRunAgentMessageTool(options).execute({ text: "first" }, context),
      createInRunAgentMessageTool(options).execute({ text: "second" }, { ...context, operationId: "operation-2" }),
    ]);
    expect(receipts.filter((item) => !item.isError)).toHaveLength(1);
    expect(receipts.filter((item) => JSON.parse(item.content).code === "backpressure")).toHaveLength(1);
    expect(inbox.snapshot().records).toHaveLength(1);
  });

  it("does not hold message admission while the host wake callback sends a reply", async () => {
    const { inbox, clock } = setup();
    const responder = createInRunAgentMessageTool({ inbox, runId, from: memberB, to: memberA, now: clock.now });
    const sender = createInRunAgentMessageTool({
      inbox, runId, from: memberA, to: memberB, now: clock.now,
      onMessage: async () => {
        await responder.execute({ text: "received" }, { ...context, laneId: memberB, operationId: "reply" });
      },
    });
    expect((await sender.execute({ text: "question" }, context)).isError).toBe(false);
    expect(inbox.snapshot().records).toHaveLength(2);
  });

  it("checks sender identity, target authorization, and reply provenance before suppression", async () => {
    const { inbox, ledger, clock } = setup();
    await inbox.send(message("unrelated-question", { from: "main", to: memberA }));
    const before = await ledger.read({ runId });
    const suppressMessage = vi.fn(() => "Already reported");
    const onMessage = vi.fn();
    const tool = createInRunAgentMessageTool({
      inbox, runId, from: memberA, resolveTargets: () => [memberB], now: clock.now,
      suppressMessage, onMessage,
    });
    const denied = [
      await tool.execute({ text: "note", target: memberB }, { ...context, laneId: memberB }),
      await tool.execute({ text: "note", target: memberB }, { ...context, runId: "another-run" }),
      await tool.execute({ text: "note", target: "main" }, context),
      await tool.execute({ text: "note", target: memberB, replyTo: "unrelated-question" }, context),
    ];
    expect(denied.every((result) => result.isError)).toBe(true);
    expect(denied.map((result) => JSON.parse(result.content).error)).toEqual([
      expect.stringContaining("another lane"), expect.stringContaining("another Run"),
      expect.stringContaining("not authorized"), expect.stringContaining("replyTo"),
    ]);
    expect(suppressMessage).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(await ledger.read({ runId })).toEqual(before);
  });

  it("does not persist or wake for a suppressed message, leaving the operation available for a later send", async () => {
    const { inbox, ledger, clock } = setup();
    await inbox.send(message("peer-question", { from: memberB, to: memberA }));
    const before = await ledger.read({ runId });
    const suppressMessage = vi.fn<(_: A2AMessage) => string | undefined>(() => "Already reported");
    const onMessage = vi.fn();
    const tool = createInRunAgentMessageTool({
      inbox, runId, from: memberA, to: memberB, now: clock.now, suppressMessage, onMessage,
    });
    const arguments_ = { text: "Verified report", replyTo: "peer-question" };
    const suppressed = await tool.execute(arguments_, context);
    expect(suppressed.isError).toBe(false);
    expect(JSON.parse(suppressed.content)).toEqual({ queued: false, suppressed: true, reason: "Already reported" });
    expect(suppressMessage).toHaveBeenCalledWith(expect.objectContaining({
      from: memberA, to: memberB, runId, replyTo: "peer-question",
      payload: { type: "message.inform", text: "Verified report" },
    }));
    expect(onMessage).not.toHaveBeenCalled();
    expect(await ledger.read({ runId })).toEqual(before);
    expect(inbox.snapshot().records).toHaveLength(1);

    suppressMessage.mockReturnValue(undefined);
    const admitted = await tool.execute(arguments_, context);
    expect(admitted.isError).toBe(false);
    expect(JSON.parse(admitted.content).status).toBe("queued");
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(inbox.snapshot().records).toHaveLength(2);
  });

  it("preserves durable retries and conflicts after replay while still rechecking a revoked target grant", async () => {
    const { inbox, ledger, clock } = setup();
    const options = { runId, from: memberA, to: memberB, now: clock.now };
    const first = await createInRunAgentMessageTool({ ...options, inbox }).execute({ text: "Verified report" }, context);
    const before = await ledger.read({ runId });
    const recovered = A2AInbox.rehydrate(before, { sink: ledger, clock });
    const suppressMessage = vi.fn(() => "Already reported");
    const onMessage = vi.fn();
    let targets = [memberB];
    const tool = createInRunAgentMessageTool({
      ...options, inbox: recovered, resolveTargets: () => targets, suppressMessage, onMessage,
    });
    const retried = await tool.execute({ text: "Verified report" }, context);
    expect(retried.isError).toBe(false);
    expect(JSON.parse(retried.content)).toMatchObject({ status: "duplicate", messageId: JSON.parse(first.content).messageId });
    expect(suppressMessage).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect((await tool.execute({ text: "Different report" }, context)).isError).toBe(true);
    expect(suppressMessage).not.toHaveBeenCalled();

    targets = [];
    for (const operationId of [context.operationId, "new-operation"]) {
      const denied = await tool.execute({ text: "Verified report" }, { ...context, operationId });
      expect(denied.isError).toBe(true);
      expect(JSON.parse(denied.content).error).toContain("not authorized");
    }
    expect(suppressMessage).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(await ledger.read({ runId })).toEqual(before);
    expect(recovered.snapshot().records).toHaveLength(1);
  });

  it("serializes suppression and durable admission across concurrent tool instances", async () => {
    const { inbox, ledger, clock } = setup();
    let entered!: () => void;
    let release!: () => void;
    const sending = new Promise<void>((resolve) => { entered = resolve; });
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    const send = inbox.send.bind(inbox);
    vi.spyOn(inbox, "send").mockImplementation(async (message) => {
      entered();
      await delayed;
      return send(message);
    });
    const suppressMessage = vi.fn((candidate: A2AMessage) => inbox.snapshot().records.some(({ message }) =>
      message.from === candidate.from && message.to === candidate.to
      && message.payload.type === "message.inform" && candidate.payload.type === "message.inform"
      && message.payload.text === candidate.payload.text,
    ) ? "Already reported" : undefined);
    const onMessage = vi.fn();
    const options = { inbox, runId, from: memberA, to: memberB, now: clock.now, suppressMessage, onMessage };
    const first = createInRunAgentMessageTool(options).execute({ text: "One finding" }, context);
    await sending;
    const second = createInRunAgentMessageTool(options).execute({ text: "One finding" }, { ...context, operationId: "operation-2" });
    release();
    const receipts = await Promise.all([first, second]);
    expect(receipts.every((result) => !result.isError)).toBe(true);
    expect(JSON.parse(receipts[0]!.content).status).toBe("queued");
    expect(JSON.parse(receipts[1]!.content)).toEqual({ queued: false, suppressed: true, reason: "Already reported" });
    expect(suppressMessage).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(inbox.snapshot().records).toHaveLength(1);
    expect((await ledger.read({ runId })).filter((event) => event.type === "message.sent")).toHaveLength(1);
  });

  it.each([0, 257, Infinity, 1.5])("rejects an invalid pending message bound %s", (maxPendingMessages) => {
    expect(() => createInRunAgentMessageTool({ inbox: new A2AInbox(), runId, maxPendingMessages })).toThrow(/maxPendingMessages/);
  });
});

describe("composed agent_message", () => {
  it("routes lane strings and cross-Run selectors through their original validation", async () => {
    const { inbox, clock } = setup();
    const inRun = createInRunAgentMessageTool({ inbox, runId, from: memberA, to: memberB, now: clock.now });
    const source = { workspaceId: "workspace-1", sessionId: "session-1", runId, laneId: memberA };
    const target = { ...source, runId: "run-2", laneId: "main" };
    const send = vi.fn<Parameters<typeof createAgentMessageTool>[0]["router"]["send"]>(async (request) => ({
      protocolVersion: 1,
      receiptId: "cross-receipt",
      routeId: "cross-route",
      status: "queued",
      messageId: "cross-message",
      idempotencyKey: request.idempotencyKey,
      source,
      target,
      relationship: "direct",
      recordedAt: timestamp,
    }));
    const crossRun = createAgentMessageTool({
      router: { send },
      sender: {
        endpoint: source,
        proof: { kind: "attach", authenticated: true, token: "proof" },
        relationshipGrants: ["direct"],
      },
    });
    const originalSchema = structuredClone(crossRun.definition.parameters);
    const tool = composeAgentMessageTools(inRun, crossRun);
    expect(tool.definition.name).toBe("agent_message");
    expect(validateArguments(tool, { target: memberB, text: "local" }).ok).toBe(true);
    expect(validateArguments(tool, { target: { relationship: "direct", id: "run-2" }, text: "remote" }).ok).toBe(true);
    expect((await tool.execute({ target: memberB, text: "local" }, context)).isError).toBe(false);
    expect((await tool.execute({ target: { relationship: "direct", id: "run-2" }, text: "remote" }, {
      ...context, operationId: "operation-2",
    })).isError).toBe(false);
    expect((await tool.execute({ target: { relationship: "direct", workspaceId: "forged" }, text: "remote" }, context)).isError).toBe(true);
    expect((await tool.execute({ target: memberB, text: "local", visibility: "user" }, context)).isError).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(inbox.snapshot().records).toHaveLength(1);
    expect(crossRun.definition.parameters).toEqual(originalSchema);
    expect(composeAgentMessageTools(inRun)).toBe(inRun);
  });

  it("rejects malformed target shapes without delegating", async () => {
    const { inbox } = setup();
    const inRun = createInRunAgentMessageTool({ inbox, runId });
    const execute = vi.fn<AgentTool["execute"]>();
    const crossRun: AgentTool = { definition: inRun.definition, execute };
    const tool = composeAgentMessageTools(inRun, crossRun);
    for (const target of [null, true, 42, []]) {
      expect((await tool.execute({ target, text: "wrong" }, context)).isError).toBe(true);
    }
    expect(execute).not.toHaveBeenCalled();
    expect(inbox.snapshot().records).toEqual([]);
  });
});

describe("LaneMailbox", () => {
  it("checks ready messages without claiming or consuming them", async () => {
    const { inbox, ledger } = setup();
    const lane = mailbox(inbox);
    expect(await lane.hasReadyMessages({ step: 2 })).toBe(false);
    await inbox.send(message("arrived-before-completion"));
    const before = await ledger.read();
    expect(await lane.hasReadyMessages({ step: 2 })).toBe(true);
    expect(await ledger.read()).toEqual(before);
    expect(inbox.snapshot().records[0]?.status).toBe("pending");
    const notices = await lane.beforeStep({ step: 2 });
    expect(notices.map((item) => item.messageId)).toEqual(["arrived-before-completion"]);
    await lane.afterStep({ runId, laneId: memberB, boundaryMessageIds: notices.map((item) => item.messageId) });
    expect(await lane.hasReadyMessages({ step: 3 })).toBe(false);
  });

  it("uses Inbox expiry, lease, delivery and local identity rules for completion readiness", async () => {
    const { inbox, advance } = setup();
    await inbox.send(message("leased"));
    await inbox.claim(memberB, memberB, { runId });
    await inbox.send(message("expired", { expiresAt: "2026-09-07T00:00:00.001Z" }));
    await inbox.send(message("next-turn", { delivery: "next-turn" }));
    await inbox.send(message("deferred", { delivery: "deferred" }));
    await inbox.send(message("foreign-run", { runId: "foreign-run" }));
    await inbox.send(message("foreign-lane", { to: "main" }));
    await inbox.send(message("unauthorized", { from: "not-a-peer" }));
    await inbox.send(message("protocol", {
      payload: { type: "task.failed", taskId: "task", reason: "not an ordinary message", retryable: false, evidenceRefs: [] },
    }));
    advance(2);
    const lane = mailbox(inbox);
    expect(await lane.hasReadyMessages({ step: 2 })).toBe(false);
    expect(await lane.hasReadyMessages({ step: 1 })).toBe(true);
    advance(100);
    expect(await lane.hasReadyMessages({ step: 2 })).toBe(true);
    expect(inbox.snapshot().records.find((record) => record.message.messageId === "leased")?.claim?.attempt).toBe(1);
  });

  it("excludes committed messages and rechecks sender grants and cancellation before completion", async () => {
    const { inbox } = setup();
    await inbox.send(message("already-committed"));
    const controller = new AbortController();
    let senders: string[] = [];
    const lane = mailbox(inbox, {
      committedBoundaryMessageIds: ["already-committed"], signal: controller.signal,
      resolveSenders: () => senders,
    });
    senders = [memberA];
    expect(await lane.hasReadyMessages({ step: 2 })).toBe(false);
    await inbox.send(message("ready"));
    expect(await lane.hasReadyMessages({ step: 2 })).toBe(true);
    senders = [];
    expect(await lane.hasReadyMessages({ step: 2 })).toBe(false);
    senders = [memberA];
    controller.abort();
    expect(await lane.hasReadyMessages({ step: 2 })).toBe(false);
    await expect(lane.hasReadyMessages({ step: 0 })).rejects.toThrow(/step/);
    await expect(lane.hasReadyMessages({ step: 2, runId: "wrong" })).rejects.toThrow(/another Run or lane/);
    const abort = new AbortController();
    const cancelledDuringResolution = mailbox(inbox, {
      signal: abort.signal, resolveSenders: async () => { abort.abort(); return [memberA]; },
    });
    expect(await cancelledDuringResolution.hasReadyMessages({ step: 2 })).toBe(false);
  });

  it("delivers directed peer messages as runtime notices and handles only committed IDs", async () => {
    const { inbox, ledger } = setup();
    await inbox.send(message("inform"));
    await inbox.send(message("request", { payload: { type: "question.ask", question: "Can you verify the result?" } }));
    await inbox.send(message("answer", { payload: { type: "question.answer", answer: "Verified" } }));
    const lane = mailbox(inbox);
    const messages = await lane.beforeStep({ step: 1, runId, laneId: memberB });
    expect(messages).toHaveLength(3);
    expect(messages.every((item) => item.kind === "runtime-notice" && item.source === memberA)).toBe(true);
    expect(messages[1]?.content).toContain("Can you verify the result?");
    expect(inbox.snapshot().records.every((record) => record.status === "claimed")).toBe(true);
    await lane.afterStep({ runId, laneId: memberB, boundaryMessageIds: ["inform", "answer"] });
    expect(inbox.snapshot().records.filter((record) => record.status === "handled").map((record) => record.message.messageId)).toEqual(["inform", "answer"]);
    expect((await ledger.read({ runId })).some((event) => event.type === "user.message" || event.type === "assistant.message")).toBe(false);
  });

  it("does not claim unknown senders, other Runs, cross-Run traffic, or task terminal records", async () => {
    const { inbox } = setup();
    await inbox.send(message("denied", { from: "team:other:member" }));
    await inbox.send(message("another-run", { runId: "run-2" }));
    await inbox.send(message("other-recipient", { to: "main" }));
    const remoteMessage = message("external");
    const source = { workspaceId: "workspace-1", sessionId: "remote-session", runId: "run-remote", laneId: memberA };
    const target = { workspaceId: "workspace-1", sessionId: "session-1", runId, laneId: memberB };
    const routeId = createCrossRunRouteId(source, target, remoteMessage.idempotencyKey);
    await inbox.send(envelopeToA2AMessage({
      ...remoteMessage,
      protocolVersion: 1,
      routeId,
      messageId: createCrossRunMessageId(routeId, remoteMessage),
      source,
      target,
      relationship: "direct",
      artifacts: [],
    }));
    await inbox.send(message("result", {
      payload: {
        type: "task.result", taskId: "task-1", status: "completed", summary: "result",
        evidenceRefs: [], artifactRefs: [], openQuestions: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    }));
    await inbox.send(message("failed", {
      payload: { type: "task.failed", taskId: "task-2", reason: "unavailable", retryable: false, evidenceRefs: [] },
    }));
    await inbox.send(message("allowed"));
    const messages = await mailbox(inbox, { maxMessagesPerBoundary: 1 }).beforeStep({ step: 1 });
    expect(messages.map((item) => item.messageId)).toEqual(["allowed"]);
    expect(inbox.snapshot().records.filter((record) => record.status === "pending")).toHaveLength(6);
  });

  it("checks fresh sender grants at each boundary", async () => {
    const { inbox } = setup();
    let allowed: string[] = [];
    const lane = mailbox(inbox, { resolveSenders: () => allowed });
    await inbox.send(message("waiting"));
    expect(await lane.beforeStep({ step: 1 })).toEqual([]);
    allowed = [memberA];
    expect((await lane.beforeStep({ step: 2 })).map((item) => item.messageId)).toEqual(["waiting"]);
  });

  it("delivers claimable messages beyond the Inbox's exact-ID batch limit", async () => {
    const { inbox } = setup();
    for (let index = 0; index < 257; index += 1) await inbox.send(message(`leased-${index}`));
    await inbox.claim(memberB, memberB, { runId, limit: 257 });
    await inbox.send(message("ready-after-backlog"));
    const result = await mailbox(inbox, { maxMessagesPerBoundary: 1 }).beforeStep({ step: 1 });
    expect(result.map((item) => item.messageId)).toEqual(["ready-after-backlog"]);
  });

  it("holds next-turn and deferred messages and never injects expired messages", async () => {
    const { inbox, advance } = setup();
    await inbox.send(message("expired", { expiresAt: "2026-09-07T00:00:00.001Z" }));
    await inbox.send(message("next", { delivery: "next-turn" }));
    await inbox.send(message("deferred", { delivery: "deferred" }));
    await inbox.send(message("urgent", { delivery: "urgent" }));
    advance(2);
    const lane = mailbox(inbox);
    expect((await lane.beforeStep({ step: 2 })).map((item) => item.messageId)).toEqual(["urgent"]);
    await lane.afterStep({ runId, laneId: memberB, boundaryMessageIds: ["urgent"] });
    expect((await lane.beforeStep({ step: 1 })).map((item) => item.messageId)).toEqual(["next"]);
    expect(inbox.snapshot().records.filter((record) => record.status === "pending").map((record) => record.message.messageId)).toEqual(["expired", "deferred"]);
  });

  it("repairs a receipt after restart without reinjecting a message consumed by a committed step", async () => {
    const { inbox, ledger, clock, advance } = setup();
    await inbox.send(message("consumed"));
    const first = mailbox(inbox);
    expect(await first.beforeStep({ step: 1 })).toHaveLength(1);
    await ledger.append({
      runId, laneId: memberB, type: "step.completed",
      payload: { step: 1, hasToolCalls: false, boundaryMessageIds: ["consumed"] },
      correlationId: runId, idempotencyKey: "step-1", visibility: "lane",
    });
    advance(200);
    const events = await ledger.read({ runId });
    const restartedInbox = A2AInbox.rehydrate(events, { sink: ledger, clock });
    const restarted = mailbox(restartedInbox, { events });
    expect(await restarted.beforeStep({ step: 2 })).toEqual([]);
    expect(restartedInbox.snapshot().records[0]?.status).toBe("handled");
    expect((await ledger.read({ runId })).filter((event) => event.type === "message.handled")).toHaveLength(1);
  });

  it("redelivers after the claim lease expires when the consuming step never committed", async () => {
    const { inbox, ledger, clock, advance } = setup();
    await inbox.send(message("uncommitted"));
    expect(await mailbox(inbox).beforeStep({ step: 1 })).toHaveLength(1);
    const events = await ledger.read({ runId });
    const restartedInbox = A2AInbox.rehydrate(events, { sink: ledger, clock, claimLeaseMs: 100 });
    const restarted = mailbox(restartedInbox, { events });
    expect(await restarted.beforeStep({ step: 1 })).toEqual([]);
    advance(101);
    expect((await restarted.beforeStep({ step: 1 })).map((item) => item.messageId)).toEqual(["uncommitted"]);
    expect(restartedInbox.snapshot().records[0]?.claim?.attempt).toBe(2);
  });

  it("keeps failed receipt repairs pending while allowing other boundary messages through", async () => {
    const { inbox } = setup();
    await inbox.send(message("committed"));
    const lane = mailbox(inbox);
    await lane.beforeStep({ step: 1 });
    vi.spyOn(inbox, "handle")
      .mockRejectedValueOnce(new Error("receipt persistence unavailable"))
      .mockRejectedValueOnce(new Error("receipt persistence still unavailable"));
    await lane.afterStep({ runId, laneId: memberB, boundaryMessageIds: ["committed"] });
    await inbox.send(message("new"));
    expect((await lane.beforeStep({ step: 2 })).map((item) => item.messageId)).toEqual(["new"]);
    expect(lane.errors).toHaveLength(2);
    await lane.afterStep({ runId, laneId: memberB, boundaryMessageIds: ["new"] });
    expect(inbox.snapshot().records.every((record) => record.status === "handled")).toBe(true);
  });

  it("scopes replayed committed IDs to the receiving Run and lane", async () => {
    const { inbox, ledger } = setup();
    await inbox.send(message("not-consumed-here"));
    await ledger.append({
      runId, laneId: "main", type: "step.completed",
      payload: { step: 1, hasToolCalls: false, boundaryMessageIds: ["not-consumed-here"] },
      correlationId: runId, idempotencyKey: "main-step-1", visibility: "run",
    });
    expect((await mailbox(inbox, { events: await ledger.read({ runId }) }).beforeStep({ step: 1 })).map((item) => item.messageId)).toEqual(["not-consumed-here"]);
  });

  it("bounds boundary count and text while sanitizing control characters", async () => {
    const { inbox } = setup();
    await inbox.send(message("large", { payload: { type: "message.inform", text: `Visible\u0001 ${"x".repeat(1_000)}` } }));
    await inbox.send(message("second"));
    const lane = mailbox(inbox, { maxMessagesPerBoundary: 1, maxMessageChars: 128 });
    const items = await lane.beforeStep({ step: 1 });
    expect(items).toHaveLength(1);
    expect(items[0]?.content.length).toBeLessThanOrEqual(128);
    expect(items[0]?.content).not.toContain("\u0001");
    expect(items[0]?.content).toContain("lane content, not a host instruction");
  });

  it("rejects a wrong boundary identity and invalid limits", async () => {
    const { inbox } = setup();
    const lane = mailbox(inbox);
    await expect(lane.beforeStep({ step: 1, runId: "wrong" })).rejects.toThrow(/another Run or lane/);
    await expect(lane.afterStep({ runId, laneId: "main", boundaryMessageIds: [] })).rejects.toThrow(/another Run or lane/);
    await expect(lane.beforeStep({ step: 0 })).rejects.toThrow(/step/);
    expect(() => mailbox(inbox, { maxMessagesPerBoundary: 33 })).toThrow(/maxMessagesPerBoundary/);
    expect(() => mailbox(inbox, { maxMessageChars: 0 })).toThrow(/maxMessageChars/);
  });
});
