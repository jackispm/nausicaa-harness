import { describe, expect, it } from "vitest";

import type { AnyEvent } from "../../src/domain/index.js";
import {
  projectSessionCompactionNotices,
  type SessionCompactionNotice,
} from "../../src/runtime/session-artifacts.js";

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
});

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
