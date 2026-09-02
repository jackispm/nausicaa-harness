import { describe, expect, it } from "vitest";

import { A2AInbox } from "../../src/a2a/index.js";
import type { AnyEvent, Goal, ModelResponse } from "../../src/domain/index.js";
import type { AgentTool, ModelPort, ModelRequest } from "../../src/domain/ports.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import { TetoLaneScheduler } from "../../src/runtime/teto-lane-scheduler.js";
import type { MainAfterStepContext } from "../../src/runtime/main-loop.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";
import {
  isMainPublicEvent,
  projectMainPublicEvent,
} from "../../src/runtime/main-public-projection.js";

const goal: Goal = {
  version: 1,
  statement: "Build a small app",
  successCriteria: ["The app works"],
  hardConstraints: ["Do not publish secrets"],
};

const policy = {
  maxMainStepsPerActivation: 1,
  maxModelTokens: 10_000,
  tetoEnabled: true,
  tetoMaxOutputTokens: 128,
  tetoTokenRatio: 0.1,
} as const;

const response = (
  content: string,
  toolCalls: ModelResponse["toolCalls"] = [],
  stopReason = "stop",
): ModelResponse => ({
  content,
  toolCalls,
  stopReason,
  usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
});

describe("TetoLaneScheduler", () => {
  it("projects only the public Main surface and omits tool results", async () => {
    const store = new MemoryContentAddressedStore();
    const userRef = await store.put(JSON.stringify({
      role: "user",
      content: "Build the app",
      createdAt: "2026-01-01T00:00:00.000Z",
    }), "application/vnd.nausicaa.conversation-message+json");
    const argsRef = await store.put(JSON.stringify({ path: "src/app.ts" }), "application/vnd.nausicaa.tool-arguments+json");
    const assistantRef = await store.put(JSON.stringify({
      role: "assistant",
      content: "I will inspect the entry point",
      toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "src/app.ts" } }],
      createdAt: "2026-01-01T00:00:01.000Z",
    }), "application/vnd.nausicaa.conversation-message+json");
    const toolResultRef = await store.put(JSON.stringify({
      role: "tool",
      content: "PRIVATE TOOL RESULT: secret file contents",
      toolCallId: "call-1",
      toolName: "read_file",
      isError: false,
      createdAt: "2026-01-01T00:00:02.000Z",
    }), "application/vnd.nausicaa.conversation-message+json");
    const ledger = new MemoryLedger();
    const userEvent = await ledger.append({
      runId: "run-1",
      laneId: "main",
      type: "user.message",
      payload: { messageRef: userRef },
      correlationId: "run-1",
      idempotencyKey: "main:user",
      visibility: "run",
    });
    const assistantEvent = await ledger.append({
      runId: "run-1",
      laneId: "main",
      type: "assistant.message",
      payload: { messageRef: assistantRef },
      correlationId: "run-1",
      idempotencyKey: "main:assistant",
      visibility: "run",
    });
    const toolRequested = await ledger.append({
      runId: "run-1",
      laneId: "main",
      type: "tool.requested",
      payload: {
        operationId: "op-1",
        toolCallId: "call-1",
        name: "read_file",
        argumentsRef: argsRef,
      },
      correlationId: "run-1",
      idempotencyKey: "main:tool:requested",
      visibility: "run",
    });
    const terminal = await ledger.append({
      runId: "run-1",
      laneId: "main",
      type: "tool.succeeded",
      payload: {
        operationId: "op-1",
        toolCallId: "call-1",
        name: "read_file",
        resultRef: toolResultRef,
      },
      correlationId: "run-1",
      idempotencyKey: "main:tool:succeeded",
      visibility: "run",
    });

    expect(isMainPublicEvent(userEvent)).toBe(true);
    expect(isMainPublicEvent(assistantEvent)).toBe(true);
    expect(isMainPublicEvent(toolRequested)).toBe(true);
    expect(isMainPublicEvent(terminal)).toBe(false);

    const projected = await projectMainPublicEvent(store, assistantEvent);
    expect(projected?.message.content).toContain("I will inspect the entry point");
    expect(projected?.message.content).toContain("read_file");
    expect(projected?.message.content).not.toContain("PRIVATE TOOL RESULT");
    expect(projected?.toolCallIds).toEqual(["call-1"]);

    const requestedProjection = await projectMainPublicEvent(store, toolRequested);
    expect(requestedProjection?.message.content).toContain('"src/app.ts"');
    expect(requestedProjection?.message.content).not.toContain("PRIVATE TOOL RESULT");
  });

  it("keeps one transcript, deduplicates tool intent, and speaks through message.inform", async () => {
    const clock = { now: () => new Date("2026-01-01T00:00:00.000Z") };
    const ledger = new MemoryLedger({ clock });
    const inbox = new A2AInbox({ sink: ledger, clock });
    const store = new MemoryContentAddressedStore();
    const userRef = await store.put(JSON.stringify({
      role: "user",
      content: "Build the app",
      createdAt: clock.now().toISOString(),
    }), "application/vnd.nausicaa.conversation-message+json");
    const assistantRef = await store.put(JSON.stringify({
      role: "assistant",
      content: "I found the entry point",
      toolCalls: [{ id: "main-call-1", name: "read_file", arguments: { path: "src/app.ts" } }],
      createdAt: clock.now().toISOString(),
    }), "application/vnd.nausicaa.conversation-message+json");
    const argsRef = await store.put(JSON.stringify({ path: "src/app.ts" }), "application/vnd.nausicaa.tool-arguments+json");
    const model = new ScriptedModel([
      response("Teto first thought"),
      response("I should alert Main", [{
        id: "teto-voice-1",
        name: "agent_message",
        arguments: { text: "Consider validating the smallest runnable slice first." },
      }], "toolUse"),
      response("Teto remembers the earlier voice"),
    ]);
    const scheduler = new TetoLaneScheduler({
      eventSink: ledger,
      inbox,
      store,
      model,
      modelName: "teto-scripted",
      runId: "run-1",
      goal,
      policy,
      workspace: "/workspace",
      clock,
      createId: (() => {
        let index = 0;
        return () => `id-${++index}`;
      })(),
    });

    const userEvent = await ledger.append({
      runId: "run-1",
      laneId: "main",
      type: "user.message",
      payload: { messageRef: userRef },
      correlationId: "run-1",
      idempotencyKey: "main:user",
      visibility: "run",
    });
    const assistantEvent = await ledger.append({
      runId: "run-1",
      laneId: "main",
      type: "assistant.message",
      payload: { messageRef: assistantRef },
      correlationId: "run-1",
      idempotencyKey: "main:assistant",
      visibility: "run",
    });
    const requestedEvent = await ledger.append({
      runId: "run-1",
      laneId: "main",
      type: "tool.requested",
      payload: {
        operationId: "op-1",
        toolCallId: "main-call-1",
        name: "read_file",
        argumentsRef: argsRef,
      },
      correlationId: "run-1",
      idempotencyKey: "main:tool:requested",
      visibility: "run",
    });

    scheduler.observeMainEvent(userEvent);
    scheduler.observeMainEvent(assistantEvent);
    scheduler.observeMainEvent(requestedEvent);
    await scheduler.drain();

    expect(model.callCount).toBe(2);
    expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual(["agent_message"]);
    expect(model.requests[1]?.messages.map((message) => message.content)).toEqual([
      "Build the app",
      "Teto first thought",
      expect.stringContaining("I found the entry point"),
    ]);
    expect(model.requests[1]?.messages.map((message) => message.content).join("\n"))
      .not.toContain("PRIVATE TOOL RESULT");
    const projectedRequestedStatus = (await ledger.read({ runId: "run-1" })).find((event) => (
      event.type === "lane.status"
      && event.laneId === "teto"
      && event.idempotencyKey === `run-1:teto:status:dormant:${requestedEvent.eventId}`
    ));
    expect(projectedRequestedStatus?.payload).toMatchObject({ status: "dormant" });

    const sent = inbox.snapshot().records.find((record) => (
      record.message.payload.type === "message.inform"
    ));
    expect(sent?.message.from).toBe("teto");
    expect(sent?.message.to).toBe("main");
    expect(sent?.message.payload).toMatchObject({
      type: "message.inform",
      text: "Consider validating the smallest runnable slice first.",
    });

    const continuationRef = await store.put(JSON.stringify({
      role: "assistant",
      content: "Main continues with the smallest slice",
      toolCalls: [],
      createdAt: clock.now().toISOString(),
    }), "application/vnd.nausicaa.conversation-message+json");
    const continuationEvent = await ledger.append({
      runId: "run-1",
      laneId: "main",
      type: "assistant.message",
      payload: { messageRef: continuationRef },
      correlationId: "run-1",
      idempotencyKey: "main:assistant:continuation",
      visibility: "run",
    });
    scheduler.observeMainEvent(continuationEvent);
    await scheduler.drain();
    expect(model.callCount).toBe(3);
    const thirdRequestContents = model.requests[2]?.messages.map((message) => message.content) ?? [];
    expect(thirdRequestContents).toHaveLength(6);
    expect(thirdRequestContents).toEqual(expect.arrayContaining([
      "Build the app",
      "Teto first thought",
      expect.stringContaining("I found the entry point"),
      "I should alert Main",
      expect.stringContaining('"status":"queued"'),
      expect.stringContaining("Main continues with the smallest slice"),
    ]));

    const boundary = await scheduler.beforeMainStep({ step: 2 });
    expect(boundary).toHaveLength(1);
    expect(boundary[0]?.content).toContain("Consider validating the smallest runnable slice first.");
    scheduler.afterMainStep({
      runId: "run-1",
      laneId: "main",
      step: 2,
      goal,
      responseText: "Main continues",
      toolCalls: [],
      toolResults: [],
      delta: {
        boundaryId: "main:step:2",
        triggerKind: "normal",
        activeObjective: goal.statement,
        actionOrDecision: "Continue",
        expectedOutcome: "Progress",
        outcome: "Progress",
        status: "progress",
        uncertainties: [],
        openQuestions: [],
      },
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      boundaryMessageIds: boundary.map((message) => message.messageId),
    } satisfies MainAfterStepContext);
    await scheduler.drain();
    expect(inbox.snapshot().records.find((record) => record.message.messageId === sent?.message.messageId)?.status)
      .toBe("handled");
  });

  it("replays a public event that was queued but cancelled before completion", async () => {
    const clock = { now: () => new Date("2026-01-01T00:00:00.000Z") };
    const ledger = new MemoryLedger({ clock });
    const inbox = new A2AInbox({ sink: ledger, clock });
    const store = new MemoryContentAddressedStore();
    const userRef = await store.put(JSON.stringify({
      role: "user",
      content: "Build the app",
      createdAt: clock.now().toISOString(),
    }), "application/vnd.nausicaa.conversation-message+json");
    const userEvent = await ledger.append({
      runId: "run-replay",
      laneId: "main",
      type: "user.message",
      payload: { messageRef: userRef },
      correlationId: "run-replay",
      idempotencyKey: "main:user",
      visibility: "run",
    });

    const cancelled = new TetoLaneScheduler({
      eventSink: ledger,
      inbox,
      store,
      model: new ScriptedModel([response("must not run")]),
      modelName: "teto-scripted",
      runId: "run-replay",
      goal,
      policy,
      workspace: "/workspace",
      clock,
    });
    cancelled.observeMainEvent(userEvent);
    await cancelled.stop();

    const replayEvents = await ledger.read({ runId: "run-replay" });
    const recoveringModel = new ScriptedModel([response("replayed")]);
    const recovering = new TetoLaneScheduler({
      eventSink: ledger,
      inbox,
      store,
      model: recoveringModel,
      modelName: "teto-scripted",
      runId: "run-replay",
      goal,
      policy,
      workspace: "/workspace",
      clock,
      events: replayEvents,
      replayPublicEvents: true,
    });
    await recovering.drain();
    expect(recoveringModel.callCount).toBe(1);

    const recoveredEvents = await ledger.read({ runId: "run-replay" });
    const alreadyCompleteModel = new ScriptedModel([response("must not replay")]);
    const alreadyComplete = new TetoLaneScheduler({
      eventSink: ledger,
      inbox,
      store,
      model: alreadyCompleteModel,
      modelName: "teto-scripted",
      runId: "run-replay",
      goal,
      policy,
      workspace: "/workspace",
      clock,
      events: recoveredEvents,
      replayPublicEvents: true,
    });
    await alreadyComplete.drain();
    expect(alreadyCompleteModel.callCount).toBe(0);
  });

  it("does not duplicate a projected user message after an activation crash", async () => {
    const clock = { now: () => new Date("2026-01-01T00:00:00.000Z") };
    const ledger = new MemoryLedger({ clock });
    const inbox = new A2AInbox({ sink: ledger, clock });
    const store = new MemoryContentAddressedStore();
    const userRef = await store.put(JSON.stringify({
      role: "user",
      content: "Build the app",
      createdAt: clock.now().toISOString(),
    }), "application/vnd.nausicaa.conversation-message+json");
    const userEvent = await ledger.append({
      runId: "run-crash-recovery",
      laneId: "main",
      type: "user.message",
      payload: { messageRef: userRef },
      correlationId: "run-crash-recovery",
      idempotencyKey: "main:user",
      visibility: "run",
    });

    const crashed = new TetoLaneScheduler({
      eventSink: ledger,
      inbox,
      store,
      model: new ScriptedModel([new Error("provider failed after projection")]),
      modelName: "teto-scripted",
      runId: "run-crash-recovery",
      goal,
      policy,
      workspace: "/workspace",
      clock,
    });
    crashed.observeMainEvent(userEvent);
    await crashed.drain();

    const afterCrash = await ledger.read({ runId: "run-crash-recovery" });
    const projectedInputs = afterCrash.filter((event) => (
      event.laneId === "teto"
      && event.type === "user.message"
      && event.payload.sourceEventId === userEvent.eventId
    ));
    expect(projectedInputs).toHaveLength(1);

    const recoveringModel = new ScriptedModel([response("recovered")]);
    const recovering = new TetoLaneScheduler({
      eventSink: ledger,
      inbox,
      store,
      model: recoveringModel,
      modelName: "teto-scripted",
      runId: "run-crash-recovery",
      goal,
      policy,
      workspace: "/workspace",
      clock,
      events: afterCrash,
      replayPublicEvents: true,
    });
    await recovering.drain();

    const recoveredEvents = await ledger.read({ runId: "run-crash-recovery" });
    expect(recoveringModel.callCount).toBe(1);
    expect(recoveredEvents.filter((event) => (
      event.laneId === "teto"
      && event.type === "user.message"
      && event.payload.sourceEventId === userEvent.eventId
    ))).toHaveLength(1);
    expect(recoveringModel.requests[0]?.messages.map((message) => message.content))
      .toEqual(["Build the app"]);
  });

  it("recovers tool-intent deduplication when the request event follows a completed activation", async () => {
    const clock = { now: () => new Date("2026-01-01T00:00:00.000Z") };
    const ledger = new MemoryLedger({ clock });
    const inbox = new A2AInbox({ sink: ledger, clock });
    const store = new MemoryContentAddressedStore();
    const assistantRef = await store.put(JSON.stringify({
      role: "assistant",
      content: "I will inspect the entry point",
      toolCalls: [{ id: "main-call-1", name: "read_file", arguments: { path: "src/app.ts" } }],
      createdAt: clock.now().toISOString(),
    }), "application/vnd.nausicaa.conversation-message+json");
    const argsRef = await store.put(JSON.stringify({ path: "src/app.ts" }), "application/vnd.nausicaa.tool-arguments+json");
    const assistantEvent = await ledger.append({
      runId: "run-tool-recovery",
      laneId: "main",
      type: "assistant.message",
      payload: { messageRef: assistantRef },
      correlationId: "run-tool-recovery",
      idempotencyKey: "main:assistant",
      visibility: "run",
    });

    const first = new TetoLaneScheduler({
      eventSink: ledger,
      inbox,
      store,
      model: new ScriptedModel([response("Teto already considered this intent")]),
      modelName: "teto-scripted",
      runId: "run-tool-recovery",
      goal,
      policy,
      workspace: "/workspace",
      clock,
    });
    first.observeMainEvent(assistantEvent);
    await first.drain();

    const requestedEvent = await ledger.append({
      runId: "run-tool-recovery",
      laneId: "main",
      type: "tool.requested",
      payload: {
        operationId: "op-1",
        toolCallId: "main-call-1",
        name: "read_file",
        argumentsRef: argsRef,
      },
      correlationId: "run-tool-recovery",
      idempotencyKey: "main:tool:requested",
      visibility: "run",
    });
    const recoveredModel = new ScriptedModel([response("must not repeat")]);
    const recovered = new TetoLaneScheduler({
      eventSink: ledger,
      inbox,
      store,
      model: recoveredModel,
      modelName: "teto-scripted",
      runId: "run-tool-recovery",
      goal,
      policy,
      workspace: "/workspace",
      clock,
      events: await ledger.read({ runId: "run-tool-recovery" }),
      replayPublicEvents: true,
    });
    await recovered.drain();

    expect(recoveredModel.callCount).toBe(0);
    expect((await ledger.read({ runId: "run-tool-recovery" })).some((event) => (
      event.type === "lane.status"
      && event.laneId === "teto"
      && event.idempotencyKey === `run-tool-recovery:teto:status:dormant:${requestedEvent.eventId}`
    ))).toBe(true);
  });

  it("allocates a fresh lane step after a failed activation", async () => {
    const clock = { now: () => new Date("2026-01-01T00:00:00.000Z") };
    const ledger = new MemoryLedger({ clock });
    const inbox = new A2AInbox({ sink: ledger, clock });
    const store = new MemoryContentAddressedStore();
    const firstRef = await store.put(JSON.stringify({
      role: "user",
      content: "First visible fact",
      createdAt: clock.now().toISOString(),
    }), "application/vnd.nausicaa.conversation-message+json");
    const secondRef = await store.put(JSON.stringify({
      role: "assistant",
      content: "Second visible fact",
      toolCalls: [],
      createdAt: clock.now().toISOString(),
    }), "application/vnd.nausicaa.conversation-message+json");
    const firstEvent = await ledger.append({
      runId: "run-failure",
      laneId: "main",
      type: "user.message",
      payload: { messageRef: firstRef },
      correlationId: "run-failure",
      idempotencyKey: "main:first",
      visibility: "run",
    });
    const secondEvent = await ledger.append({
      runId: "run-failure",
      laneId: "main",
      type: "assistant.message",
      payload: { messageRef: secondRef },
      correlationId: "run-failure",
      idempotencyKey: "main:second",
      visibility: "run",
    });
    const model = new ScriptedModel([new Error("provider failed"), response("recovered")]);
    const scheduler = new TetoLaneScheduler({
      eventSink: ledger,
      inbox,
      store,
      model,
      modelName: "teto-scripted",
      runId: "run-failure",
      goal,
      policy,
      workspace: "/workspace",
      clock,
    });
    scheduler.observeMainEvent(firstEvent);
    scheduler.observeMainEvent(secondEvent);
    await scheduler.drain();

    expect(model.callCount).toBe(2);
    const steps = (await ledger.read({ runId: "run-failure" }))
      .filter((event): event is Extract<AnyEvent, {
        type: "step.started";
      }> => event.type === "step.started" && event.laneId === "teto")
      .map((event) => event.payload.step);
    expect(steps).toEqual([1, 2]);
  });
});
