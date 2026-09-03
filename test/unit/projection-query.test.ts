import { describe, expect, it } from "vitest";

import type { AppendEvent, EventPayloadMap, EventType } from "../../src/domain/events.js";
import type { Goal, RunPolicy } from "../../src/domain/types.js";
import {
  MemoryLedger,
  projectionCheckpoint,
  queryProjectionChanges,
} from "../../src/ledger/index.js";

const goal: Goal = {
  version: 1,
  statement: "Observe changes",
  successCriteria: [],
  hardConstraints: [],
};
const policy: RunPolicy = {
  maxMainStepsPerActivation: 4,
  maxModelTokens: 10_000,
  tetoEnabled: false,
  tetoMaxOutputTokens: 100,
  tetoTokenRatio: 0.1,
};

describe("projection checkpoints", () => {
  it("pages durable changes with a stable cursor checkpoint", async () => {
    const ledger = new MemoryLedger();
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    await ledger.append(command("goal.revised", { goal: { ...goal, version: 2 } }));
    await ledger.append(command("todo.updated", { revision: 1, items: [] }));
    const events = await ledger.read({ runId: "run-1" });
    const first = queryProjectionChanges(events, "run-1", { maxEvents: 2 });
    expect(first.events).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.nextOffset).toBe(first.events.at(-1)?.globalOffset);

    const cursor = projectionCheckpoint(events, "run-1", first.nextOffset);
    const second = queryProjectionChanges(events, "run-1", {
      afterOffset: first.nextOffset,
      afterChecksum: cursor.checksum,
    });
    expect(second.stale).toBe(false);
    expect(second.events.map((event) => event.type)).toEqual(["todo.updated"]);
    expect(second.checkpoint).toEqual(projectionCheckpoint(events, "run-1"));
  });

  it("marks a cursor ahead or with a mismatched checksum stale", async () => {
    const ledger = new MemoryLedger();
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    const events = await ledger.read({ runId: "run-1" });
    expect(queryProjectionChanges(events, "run-1", { afterOffset: 99 }).staleReason)
      .toBe("cursor-ahead");
    expect(queryProjectionChanges(events, "run-1", {
      afterOffset: 0,
      afterChecksum: "sha256:wrong",
    })).toMatchObject({ stale: true, staleReason: "cursor-mismatch", events: [] });
  });

  it("treats offsets from another Run as valid global cursors", async () => {
    const ledger = new MemoryLedger();
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }, "run-2"));
    const events = await ledger.read();

    const page = queryProjectionChanges(events, "run-1", { afterOffset: 2 });
    expect(page.stale).toBe(false);
    expect(page.events).toEqual([]);
    expect(page.checkpoint.watermark).toBe(1);
    expect(queryProjectionChanges(events, "run-1", { afterOffset: 3 }).staleReason)
      .toBe("cursor-ahead");

    const runEvents = await ledger.read({ runId: "run-1" });
    expect(queryProjectionChanges(runEvents, "run-1", {
      afterOffset: 2,
      globalWatermark: 2,
    }).stale).toBe(false);
    expect(() => queryProjectionChanges(runEvents, "run-1", {
      globalWatermark: 0,
    })).toThrow(/cannot be lower/u);
  });
});

function command<K extends EventType>(
  type: K,
  payload: EventPayloadMap[K],
  runId = "run-1",
): AppendEvent<K> {
  return {
    runId,
    laneId: "main",
    type,
    payload,
    correlationId: "test",
    idempotencyKey: `test:${type}:${JSON.stringify(payload)}`,
    visibility: "run",
    occurredAt: "2026-09-04T00:00:00.000Z",
  } as AppendEvent<K>;
}
