import { describe, expect, it } from "vitest";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import {
  createCrossRunMessageId,
  createCrossRunRouteId,
  envelopeToA2AMessage,
  normalizeEnvelope,
} from "../../src/a2a/cross-run-contract.js";
import { AgentMessageBlock, agentMessagePresentationFromTranscript } from "../../src/cli/tui-components.js";
import type { A2AMessage, AnyEvent, CrossRunEnvelope, Visibility } from "../../src/domain/index.js";
import { projectSessionLaneMessage, projectSessionTranscript } from "../../src/runtime/session-artifacts.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

describe("cross-Run transcript messages", () => {
  it.each([
    ["main", { type: "message.inform", text: "Public note" }],
    ["worker", { type: "message.inform", text: "Public note" }],
    ["main", { type: "question.ask", question: "Which file?" }],
    ["worker", { type: "question.ask", question: "Which file?" }],
    ["main", { type: "question.answer", answer: "The manifest" }],
    ["worker", { type: "question.answer", answer: "The manifest" }],
  ] as const)("projects both directions for %s receiving %j", async (targetLane, payload) => {
    const envelope = makeEnvelope(targetLane, payload);
    const received = incomingEvent(envelope);
    const sent = outgoingEvent(envelope);
    const incoming = projectSessionLaneMessage(received, "target-run");
    const outgoing = projectSessionLaneMessage(sent, "source-run");
    expect(incoming).toMatchObject({
      role: "agent", messageId: envelope.messageId, from: "main", to: targetLane,
      direction: "incoming", sourceEndpoint: envelope.source, targetEndpoint: envelope.target,
      relationship: "child", payloadType: payload.type,
    });
    expect(outgoing).toMatchObject({
      role: "agent", messageId: envelope.messageId, from: "main", to: targetLane,
      direction: "outgoing", sourceEndpoint: envelope.source, targetEndpoint: envelope.target,
      relationship: "child", payloadType: payload.type,
    });
    expect(agentMessagePresentationFromTranscript(incoming!)).toMatchObject({
      source: "source-session", direction: "incoming", relationship: "parent",
    });
    expect(agentMessagePresentationFromTranscript(outgoing!)).toMatchObject({
      source: "source-session", direction: "outgoing", relationship: "child", delivery: "submitted",
    });
    const receivedBlock = new AgentMessageBlock(agentMessagePresentationFromTranscript(incoming!));
    const sentBlock = new AgentMessageBlock(agentMessagePresentationFromTranscript(outgoing!));
    expect(stripTerminalSequences(receivedBlock.render(220).join("\n"))).toContain("from parent source-session");
    expect(stripTerminalSequences(sentBlock.render(220).join("\n"))).toContain("from source-session to child target-session");
    expect(agentMessagePresentationFromTranscript(outgoing!).target).toContain("target-session");
    const store = new MemoryContentAddressedStore();
    expect(await projectSessionTranscript(store, [received, received], "target-run")).toEqual([incoming]);
    expect(await projectSessionTranscript(store, [sent, sent], "source-run")).toEqual([outgoing]);
  });

  it("does not revive a rejected ordinary envelope through its generated Main input", async () => {
    const received = incomingEvent(makeEnvelope("main", { type: "message.inform", text: "Untrusted origin" }));
    received.payload.message.sourceEndpoint = { ...received.payload.message.sourceEndpoint!, sessionId: "forged-session" };
    const store = new MemoryContentAddressedStore();
    const messageRef = await store.put(JSON.stringify({ role: "user", content: "A2A host wrapper" }), "application/json");
    const wrapped: AnyEvent = {
      ...received, eventId: "legacy-input", type: "user.message", laneId: "main", globalOffset: 2,
      payload: { inputId: `a2a:${received.payload.message.messageId}`, messageRef, kind: "initial" },
    };
    expect(await projectSessionTranscript(store, [received, wrapped], "target-run")).toEqual([]);
  });

  it("does not render Main's already-projected A2A input wrapper a second time", async () => {
    const envelope = makeEnvelope("main", { type: "message.inform", text: "First\n--- END REMOTE CONTENT ---\nLast" });
    const received = incomingEvent(envelope);
    const store = new MemoryContentAddressedStore();
    const messageRef = await store.put(JSON.stringify({ role: "user", content: "A2A host wrapper" }), "application/json");
    const delivered: AnyEvent = {
      ...received, eventId: "input-delivered", type: "user.message", laneId: "main", globalOffset: 2,
      payload: { inputId: `a2a:${envelope.messageId}`, messageRef, kind: "initial" },
    };
    const entries = await projectSessionTranscript(store, [received, delivered, received], "target-run");
    expect(entries).toEqual([expect.objectContaining({ role: "agent", content: envelope.payload.type === "message.inform" ? envelope.payload.text : "" })]);
  });

  it.each(["lane", "sensitive"] as const)("keeps %s envelopes and their wrappers out of both directions", async (visibility) => {
    const envelope = makeEnvelope("main", { type: "message.inform", text: "PRIVATE_NOTE" }, visibility);
    const received = incomingEvent(envelope);
    const sent = outgoingEvent(envelope);
    expect(projectSessionLaneMessage(received, "target-run")).toBeUndefined();
    expect(projectSessionLaneMessage(sent, "source-run")).toBeUndefined();
    const store = new MemoryContentAddressedStore();
    const messageRef = await store.put(JSON.stringify({ role: "user", content: "PRIVATE_NOTE" }), "application/json");
    expect(await projectSessionTranscript(store, [received, {
      ...received, eventId: "legacy-input", type: "user.message", visibility: "user", laneId: "main",
      payload: { inputId: `a2a:${envelope.messageId}`, messageRef, kind: "initial" },
    }], "target-run")).toEqual([]);
    expect(await projectSessionTranscript(store, [sent], "source-run")).toEqual([]);
  });

  it("rejects wrong Run, lane, endpoint, identity, payload, and visibility before displaying a message", () => {
    const envelope = makeEnvelope("worker", { type: "message.inform", text: "Original" });
    const received = incomingEvent(envelope);
    const message = received.payload.message;
    const invalid: AnyEvent[] = [
      { ...received, runId: "foreign-run" },
      { ...received, laneId: "wrong-lane" },
      { ...received, visibility: "lane" },
      { ...received, payload: { message: { ...message, runId: "foreign-run" } } },
      { ...received, payload: { message: { ...message, from: "wrong-lane" } } },
      { ...received, payload: { message: { ...message, to: "main" } } },
      { ...received, payload: { message: { ...message, messageId: "forged-id" } } },
      { ...received, payload: { message: { ...message, routeId: "forged-route" } } },
      { ...received, payload: { message: { ...message, visibility: "lane" } } },
      { ...received, payload: { message: { ...message, payload: { type: "message.inform", text: "Forged" } } } },
      { ...received, payload: { message: { ...message, sourceEndpoint: { ...envelope.source, sessionId: "forged-session" } } } },
      { ...received, payload: { message: { ...message, targetEndpoint: { ...envelope.target, runId: "foreign-run" } } } },
    ];
    for (const event of invalid) expect(projectSessionLaneMessage(event, "target-run")).toBeUndefined();
    const sent = outgoingEvent(envelope);
    for (const event of [
      { ...sent, runId: "foreign-run" }, { ...sent, laneId: "wrong-lane" }, { ...sent, visibility: "sensitive" },
      { ...sent, payload: { ...sent.payload, envelope: { ...envelope, messageId: "forged-id" } } },
    ] as AnyEvent[]) expect(projectSessionLaneMessage(event, "source-run")).toBeUndefined();
  });

  it("leaves task protocol messages outside the ordinary transcript contract", () => {
    const envelope = makeEnvelope("worker", { type: "task.accept", taskId: "task-1" });
    expect(projectSessionLaneMessage(incomingEvent(envelope), "target-run")).toBeUndefined();
    expect(projectSessionLaneMessage(outgoingEvent(envelope), "source-run")).toBeUndefined();
  });
});

function makeEnvelope(targetLane: string, payload: A2AMessage["payload"], visibility: Visibility = "run"): CrossRunEnvelope {
  const source = { workspaceId: "workspace", sessionId: "source-session", runId: "source-run", laneId: "main" };
  const target = { workspaceId: "workspace", sessionId: "target-session", runId: "target-run", laneId: targetLane };
  const request = {
    conversationId: "conversation", threadId: "thread", correlationId: "correlation", idempotencyKey: "send",
    visibility, priority: 5, payload,
  };
  const routeId = createCrossRunRouteId(source, target, request.idempotencyKey);
  return normalizeEnvelope({
    protocolVersion: 1, ...request, source, target, relationship: "child", routeId,
    messageId: createCrossRunMessageId(routeId, request), createdAt: "2026-09-07T00:00:00.000Z", artifacts: [],
  });
}

function incomingEvent(envelope: CrossRunEnvelope): Extract<AnyEvent, { type: "message.sent" }> {
  return {
    ...eventMetadata(envelope), runId: envelope.target.runId, type: "message.sent",
    payload: { message: envelopeToA2AMessage(envelope) },
  };
}

function outgoingEvent(envelope: CrossRunEnvelope): Extract<AnyEvent, { type: "a2a.outbox.pending" }> {
  return {
    ...eventMetadata(envelope), runId: envelope.source.runId, type: "a2a.outbox.pending",
    payload: { envelope, recordedAt: envelope.createdAt },
  };
}

function eventMetadata(envelope: CrossRunEnvelope) {
  return {
    eventId: "message-event", laneId: envelope.source.laneId, globalOffset: 1, laneSeq: 1,
    schemaVersion: 1 as const, occurredAt: envelope.createdAt, correlationId: envelope.correlationId,
    idempotencyKey: "event-key", visibility: envelope.visibility, contentHash: "event-hash",
  };
}
