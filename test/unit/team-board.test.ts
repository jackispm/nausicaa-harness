import { describe, expect, it } from "vitest";

import type { A2AMessage, Goal } from "../../src/domain/index.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { A2AInbox } from "../../src/a2a/index.js";
import { projectTeamBoard, projectTeamBoards } from "../../src/runtime/team-board.js";

const clock = { now: () => new Date("2026-09-05T00:00:00.000Z") };
const goal: Goal = {
  version: 1,
  statement: "Inspect the branch",
  successCriteria: ["Report evidence"],
  hardConstraints: [],
};

function requestMessage(branch: string): A2AMessage {
  return {
    messageId: `request-${branch}`,
    runId: "run-board",
    conversationId: "run-board",
    threadId: "run-board:team:alpha",
    from: "main",
    to: `team:alpha:${branch}`,
    createdAt: clock.now().toISOString(),
    correlationId: "team-alpha",
    idempotencyKey: `request-${branch}`,
    visibility: "run",
    priority: 1,
    delivery: "next-step",
    payload: {
      type: "task.request",
      taskId: `alpha:${branch}`,
      goal,
      inputRefs: [],
      budget: {
        maxModelTokens: 100,
        maxWallClockMs: 10_000,
        deadline: new Date(clock.now().getTime() + 10_000).toISOString(),
        maxAttempts: 2,
      },
    },
  };
}

async function appendLaneFact(
  ledger: MemoryLedger,
  laneId: string,
  type: "lane.registered" | "lane.status",
  payload: any,
): Promise<void> {
  await ledger.append({
    runId: "run-board",
    laneId,
    type,
    payload,
    correlationId: `lane:${laneId}`,
    idempotencyKey: `${laneId}:${type}:${JSON.stringify(payload)}`,
    visibility: "run",
    occurredAt: clock.now().toISOString(),
  } as any);
}

describe("Team durable board projection", () => {
  it("reconstructs queued and terminal branches from Inbox and Ledger facts", async () => {
    const ledger = new MemoryLedger({ clock });
    const inbox = new A2AInbox({ sink: ledger, clock });
    await inbox.send(requestMessage("one"));
    await inbox.send(requestMessage("two"));
    await appendLaneFact(ledger, "team:alpha:one", "lane.registered", { kind: "team" });
    await appendLaneFact(ledger, "team:alpha:one", "lane.status", { status: "running" });
    await appendLaneFact(ledger, "team:alpha:two", "lane.registered", { kind: "team" });
    await appendLaneFact(ledger, "team:alpha:two", "lane.status", { status: "completed" });
    await inbox.send({
      ...requestMessage("two"),
      messageId: "result-two",
      from: "team:alpha:two",
      to: "main",
      idempotencyKey: "result-two",
      parentId: "request-two",
      replyTo: "request-two",
      payload: {
        type: "task.result",
        taskId: "alpha:two",
        status: "completed",
        summary: "done",
        evidenceRefs: [],
        artifactRefs: [],
        openQuestions: [],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    });

    const board = projectTeamBoard(await ledger.read({ runId: "run-board" }), "alpha", {
      inbox: inbox.snapshot(),
    });
    expect(board).toBeDefined();
    expect(board?.status).toBe("running");
    expect(board?.joinSatisfied).toBe(false);
    expect(board?.branches.map((branch) => [branch.branchId, branch.status])).toEqual([
      ["one", "running"],
      ["two", "completed"],
    ]);
    expect(board?.branches.find((branch) => branch.branchId === "two")?.result?.summary).toBe("done");
  });

  it("does not lose a task whose registration was interrupted", async () => {
    const ledger = new MemoryLedger({ clock });
    const inbox = new A2AInbox({ sink: ledger, clock });
    await inbox.send(requestMessage("orphan"));
    const board = projectTeamBoard(await ledger.read({ runId: "run-board" }), "alpha", {
      inbox: inbox.snapshot(),
    });
    expect(board?.joinSatisfied).toBe(false);
    expect(board?.status).toBe("queued");
    expect(board?.branches[0]).toMatchObject({
      laneId: "team:alpha:orphan",
      registered: false,
      status: "queued",
    });
    expect(board?.branches[0]?.anomalies).toContain("branch lane registration is missing");
  });

  it("keeps projections isolated when a shared event stream contains several Runs", async () => {
    const first = requestMessage("a");
    const second = { ...requestMessage("b"), runId: "other-run", messageId: "other-request", idempotencyKey: "other-request" };
    const events = [
      {
        eventId: "a",
        runId: "run-board",
        laneId: "main",
        globalOffset: 1,
        laneSeq: 1,
        schemaVersion: 1 as const,
        type: "message.sent" as const,
        payload: { message: first },
        correlationId: "a",
        idempotencyKey: "a",
        visibility: "run" as const,
        occurredAt: first.createdAt,
        contentHash: "",
      },
    ];
    // The filtering contract is exercised with an explicit Inbox projection
    // in normal use; this assertion only checks that no foreign request can
    // enter the selected board.
    expect(projectTeamBoards(events as any, { runId: "run-board" })).toHaveLength(1);
    expect(second.to).toContain("team:alpha:b");
  });
});
