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

function resultMessage(branch: string, messageId: string, status: "completed" | "partial" = "completed"): A2AMessage {
  const request = requestMessage(branch);
  return {
    ...request, messageId, idempotencyKey: messageId, from: request.to, to: request.from,
    parentId: request.messageId,
    payload: {
      type: "task.result", taskId: `alpha:${branch}`, status, summary: messageId,
      evidenceRefs: [], artifactRefs: [], openQuestions: [],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
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

  it("keeps supplied Inbox snapshots isolated to the selected Run", async () => {
    const ledger = new MemoryLedger({ clock });
    const inbox = new A2AInbox({ sink: ledger, clock });
    await inbox.send(requestMessage("a"));
    await inbox.send({ ...requestMessage("b"), runId: "other-run", messageId: "other-request", idempotencyKey: "other-request" });
    const boards = projectTeamBoards(await ledger.read(), { runId: "run-board", inbox: inbox.snapshot() });
    expect(boards).toHaveLength(1);
    expect(boards[0]?.members.map((member) => member.memberId)).toEqual(["a"]);
  });

  it.each(["completed", "failed", "cancelled"] as const)("does not treat legacy lane %s as task settlement", async (status) => {
    const ledger = new MemoryLedger({ clock });
    const inbox = new A2AInbox({ sink: ledger, clock });
    await inbox.send(requestMessage("one"));
    await appendLaneFact(ledger, "team:alpha:one", "lane.status", { status });
    const board = projectTeamBoard(await ledger.read(), "alpha");
    expect(board).toMatchObject({ joinReady: false, joinSatisfied: false, status: "unknown" });
    expect(board?.members[0]).toMatchObject({ execution: "terminal", terminal: false, status: "unknown" });
    expect(board?.members[0]?.outcome).toBeUndefined();
  });

  it("retains the first validated partial reply when later replies conflict", async () => {
    const ledger = new MemoryLedger({ clock });
    const inbox = new A2AInbox({ sink: ledger, clock });
    await inbox.send(requestMessage("one"));
    await inbox.send(resultMessage("one", "partial-result", "partial"));
    await inbox.send(resultMessage("one", "completed-result"));
    const board = projectTeamBoard(await ledger.read(), "alpha");
    expect(board).toMatchObject({ joinSatisfied: true, status: "partial" });
    expect(board?.members[0]).toMatchObject({ outcome: "partial", result: { summary: "partial-result" } });
    expect(board?.anomalies).toContain("multiple terminal replies: partial-result, completed-result");
  });

  it.each(["sender", "task", "parent", "recipient"] as const)("ignores legacy replies with a mismatched %s", async (kind) => {
    const ledger = new MemoryLedger({ clock });
    const inbox = new A2AInbox({ sink: ledger, clock });
    await inbox.send(requestMessage("one"));
    const reply = resultMessage("one", "invalid-result");
    if (kind === "sender") reply.from = "team:alpha:other";
    if (kind === "recipient") reply.to = "other-lead";
    if (kind === "parent") reply.parentId = "other-request";
    if (kind === "task" && reply.payload.type === "task.result") reply.payload.taskId = "other-task";
    await inbox.send(reply);
    expect(projectTeamBoard(await ledger.read(), "alpha")?.members[0]?.terminal).toBe(false);
  });
});
