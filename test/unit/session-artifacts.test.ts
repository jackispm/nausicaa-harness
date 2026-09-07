import { describe, expect, it } from "vitest";

import type { A2AMessage, AnyEvent } from "../../src/domain/index.js";
import {
  projectSessionCompactionNotices,
  projectSessionLaneMessage,
  projectSessionTranscript,
  projectPendingInputs,
  type SessionCompactionNotice,
} from "../../src/runtime/session-artifacts.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

describe("session artifact projections", () => {
  it("projects replayed compaction lifecycle and deduplicates durable event identity", () => {
    const events = [
      compactionEvent("event-committed", 4, "run-1", "fukai.compaction.committed", "compact-1"),
      compactionEvent("event-requested", 2, "run-1", "fukai.compaction.requested", "compact-1"),
      compactionEvent("event-requested", 2, "run-1", "fukai.compaction.requested", "compact-1"),
      compactionEvent("event-foreign", 3, "other-run", "fukai.compaction.failed", "compact-x"),
      compactionEvent("event-fallback", 5, "run-1", "fukai.compaction.fallback", "compact-1"),
      compactionEvent("event-completed", 6, "run-1", "fukai.compaction.completed", "compact-1"),
    ];

    expect(projectSessionCompactionNotices(events, "run-1")).toEqual([
      {
        eventId: "event-requested",
        globalOffset: 2,
        compactionId: "compact-1",
        status: "requested",
      },
      {
        eventId: "event-committed",
        globalOffset: 4,
        compactionId: "compact-1",
        status: "committed",
      },
      {
        eventId: "event-fallback",
        globalOffset: 5,
        compactionId: "compact-1",
        status: "fallback",
      },
    ] satisfies SessionCompactionNotice[]);
  });

  it("replays public lane communication once without projecting sibling transcripts or receipts", async () => {
    const store = new MemoryContentAddressedStore();
    const userRef = await store.put(JSON.stringify({ role: "user", content: "Main task" }), "application/json");
    const advice = laneMessageEvent("teto-note", "teto", "main", { type: "message.inform", text: "Evidence needs another check" });
    const request = laneMessageEvent("main-question", "main", "teto", { type: "question.ask", question: "Which evidence?" });
    const answer = laneMessageEvent("peer-answer", "team:review:a", "team:review:b", { type: "question.answer", answer: "The timeout log" });
    const events: AnyEvent[] = [
      { ...advice, eventId: "user", laneId: "main", type: "user.message", payload: { messageRef: userRef } },
      advice,
      { ...advice, eventId: "duplicate-send" },
      { ...advice, eventId: "receipt", type: "message.handled", payload: { messageId: advice.payload.message.messageId, handledBy: "main" } } as AnyEvent,
      { ...advice, eventId: "private-assistant", type: "assistant.message", payload: { messageRef: userRef } },
      request,
      answer,
    ];
    const entries = await projectSessionTranscript(store, events, "run-1");
    expect(entries).toEqual([
      expect.objectContaining({ role: "user", content: "Main task" }),
      expect.objectContaining({ role: "agent", messageId: "teto-note", from: "teto", to: "main", content: "Evidence needs another check" }),
      expect.objectContaining({ role: "agent", messageId: "main-question", from: "main", to: "teto", payloadType: "question.ask" }),
      expect.objectContaining({ role: "agent", messageId: "peer-answer", from: "team:review:a", to: "team:review:b", payloadType: "question.answer" }),
    ]);
  });

  it.each(["lane", "sensitive", "private", "private-ledger"])("keeps %s event and message visibility out of the presentation", async (visibility) => {
    const event = laneMessageEvent("hidden", "teto", "main", { type: "message.inform", text: "PRIVATE_SENTINEL" });
    const hiddenEvent = { ...event, visibility } as AnyEvent;
    const hiddenMessage = { ...event, payload: { message: { ...event.payload.message, visibility } } } as AnyEvent;
    expect(projectSessionLaneMessage(hiddenEvent, "run-1")).toBeUndefined();
    expect(projectSessionLaneMessage(hiddenMessage, "run-1")).toBeUndefined();
    expect(await projectSessionTranscript(new MemoryContentAddressedStore(), [hiddenEvent, hiddenMessage], "run-1")).toEqual([]);
  });

  it("excludes cross-Run, mismatched, self-notice, and task protocol messages", () => {
    const event = laneMessageEvent("note", "teto", "main", { type: "message.inform", text: "Visible" });
    const message = event.payload.message;
    for (const candidate of [
      { ...event, runId: "other-run" },
      { ...event, laneId: "different-sender" },
      { ...event, payload: { message: { ...message, runId: "other-run" } } },
      { ...event, payload: { message: { ...message, to: "teto" } } },
      { ...event, payload: { message: { ...message, routeId: "remote-route" } } },
      { ...event, payload: { message: { ...message, sourceEndpoint: { workspaceId: "w", sessionId: "s", runId: "r", laneId: "teto" } } } },
      laneMessageEvent("accepted", "teto", "main", { type: "task.accept", taskId: "task" }),
      laneMessageEvent("failed", "teto", "main", { type: "task.failed", taskId: "task", reason: "Internal result", retryable: false, evidenceRefs: [] }),
    ] as AnyEvent[]) expect(projectSessionLaneMessage(candidate, "run-1")).toBeUndefined();
  });

  it("keeps private A2A inputs hidden when replaying legacy public admission and replacement facts", async () => {
    const store = new MemoryContentAddressedStore();
    const messageRef = await store.put(JSON.stringify({ role: "user", content: "PRIVATE_REPLAY_NOTE" }), "application/json");
    const original = laneMessageEvent("private-external", "main", "main", { type: "message.inform", text: "PRIVATE_REPLAY_NOTE" });
    original.visibility = "lane";
    original.payload.message.visibility = "lane";
    original.payload.message.sourceEndpoint = { workspaceId: "w", sessionId: "source", runId: "source", laneId: "main" };
    original.payload.message.targetEndpoint = { workspaceId: "w", sessionId: "target", runId: "run-1", laneId: "main" };
    const inputId = "a2a:private-external";
    const admitted: AnyEvent = {
      ...original, eventId: "admission", type: "input.admitted", visibility: "user", globalOffset: 2,
      payload: { inputId, messageRef, delivery: "new-turn", sequence: 1 },
    };
    const replaced: AnyEvent = {
      ...admitted, eventId: "replacement", type: "input.replaced", globalOffset: 3,
      payload: { inputId, expectedRevision: 1, expectedMessageRef: messageRef, revision: 2, messageRef, delivery: "follow-up", sequence: 1 },
    };
    const delivered: AnyEvent = {
      ...admitted, eventId: "user", type: "user.message", globalOffset: 4,
      payload: { inputId, messageRef, kind: "initial" },
    };
    expect(await projectPendingInputs(store, [original, admitted, replaced])).toEqual([]);
    expect(await projectSessionTranscript(store, [original, admitted, replaced, delivered], "run-1")).toEqual([]);
  });
});

function laneMessageEvent(id: string, from: string, to: string, payload: A2AMessage["payload"]): Extract<AnyEvent, { type: "message.sent" }> {
  return {
    eventId: id, runId: "run-1", laneId: from, globalOffset: 1, laneSeq: 1,
    type: "message.sent", schemaVersion: 1, occurredAt: "2026-09-04T00:00:00.000Z",
    correlationId: id, idempotencyKey: id, visibility: "run", contentHash: `hash:${id}`,
    payload: { message: {
      messageId: id, runId: "run-1", from, to, payload, createdAt: "2026-09-04T00:00:00.000Z",
      conversationId: "run-1", threadId: id, correlationId: id, idempotencyKey: id,
      visibility: "run", priority: 5, delivery: "next-step",
    } },
  };
}

function compactionEvent(
  eventId: string,
  globalOffset: number,
  runId: string,
  type:
    | "fukai.compaction.requested"
    | "fukai.compaction.completed"
    | "fukai.compaction.committed"
    | "fukai.compaction.failed"
    | "fukai.compaction.fallback",
  compactionId: string,
): AnyEvent {
  return {
    eventId,
    runId,
    laneId: "main",
    globalOffset,
    laneSeq: globalOffset,
    type,
    schemaVersion: 1,
    occurredAt: "2026-09-04T00:00:00.000Z",
    correlationId: `run:${runId}`,
    idempotencyKey: `${eventId}:idempotency`,
    visibility: "run",
    contentHash: `hash:${eventId}`,
    payload: { compactionId } as never,
  } as AnyEvent;
}
