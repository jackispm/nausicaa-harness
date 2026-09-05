import { describe, expect, it } from "vitest";

import type { AppendEvent, EventPayloadMap, EventType } from "../../src/domain/events.js";
import type { Goal, RunPolicy } from "../../src/domain/types.js";
import { MemoryLedger, projectRun, projectTodos } from "../../src/ledger/index.js";

const goal: Goal = {
  version: 1,
  statement: "Ship the change",
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

describe("structured Todo projection", () => {
  it("replays the newest revision and ignores stale snapshots", async () => {
    const ledger = new MemoryLedger();
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    await ledger.append(command("todo.updated", {
      revision: 2,
      items: [{ id: "second", content: "Verify tests", status: "completed" }],
      source: "model",
    }));
    await ledger.append(command("todo.updated", {
      revision: 1,
      items: [{ id: "first", content: "Implement change", status: "in_progress" }],
      source: "operator",
    }));

    const projection = projectTodos(await ledger.read(), "run-1");
    expect(projection).toMatchObject({
      revision: 2,
      items: [{ id: "second", status: "completed" }],
      source: "model",
      updatedByLane: "main",
    });
    expect(projectRun(await ledger.read(), "run-1").todos).toEqual(projection);
  });

  it("allows an empty snapshot to clear completed work", async () => {
    const ledger = new MemoryLedger();
    await ledger.append(command("todo.updated", {
      revision: 1,
      items: [{ id: "todo", content: "Temporary", status: "completed" }],
    }));
    await ledger.append(command("todo.updated", { revision: 2, items: [] }));

    expect(projectTodos(await ledger.read(), "run-1")).toMatchObject({
      revision: 2,
      items: [],
    });
  });
});

function command<K extends EventType>(
  type: K,
  payload: EventPayloadMap[K],
): AppendEvent<K> {
  return {
    runId: "run-1",
    laneId: "main",
    type,
    payload,
    correlationId: "test",
    idempotencyKey: `test:${type}:${JSON.stringify(payload)}`,
    visibility: "run",
    occurredAt: "2026-09-04T00:00:00.000Z",
  } as AppendEvent<K>;
}
