import { describe, expect, it } from "vitest";

import type { AppendEvent, EventType } from "../../src/domain/events.js";
import type {
  A2AMessage,
  Goal,
  RunPolicy,
  TaskFailed,
  TaskResult,
} from "../../src/domain/types.js";
import { MemoryLedger, projectTaskGraph } from "../../src/ledger/index.js";

const goal: Goal = {
  version: 1,
  statement: "Inspect the package",
  successCriteria: ["Return grounded evidence"],
  hardConstraints: ["Do not modify files"],
};

const policy: RunPolicy = {
  maxMainStepsPerActivation: 8,
  maxModelTokens: 10_000,
  tetoEnabled: false,
  tetoMaxOutputTokens: 64,
  tetoTokenRatio: 0.1,
  workerEnabled: true,
};

describe("projectTaskGraph", () => {
  it("moves a task from delegated through terminal to a committed join", async () => {
    const ledger = await initializedLedger();
    const request = taskRequest("task-1");
    await send(ledger, request);

    let projection = projectTaskGraph(await ledger.read(), "run-1");
    expect(projection.tasks[0]).toMatchObject({
      requestMessageId: request.messageId,
      taskId: "task-1",
      runGoalVersion: 1,
      state: { kind: "delegated" },
    });

    await send(ledger, taskAccept(request));
    projection = projectTaskGraph(await ledger.read(), "run-1");
    expect(projection.tasks[0]).toMatchObject({
      accept: { messageId: "run-1:worker:task:task-1:accept" },
      state: { kind: "delegated" },
    });

    const terminal = taskResult(request);
    await send(ledger, terminal);
    await ledger.append(command("message.claimed", {
      messageId: terminal.messageId,
      claimedBy: "main",
    }));
    projection = projectTaskGraph(await ledger.read(), "run-1");
    expect(projection.tasks[0]?.state).toMatchObject({
      kind: "terminal",
      terminal: { messageId: terminal.messageId, type: "task.result" },
    });

    await ledger.append({
      ...command("step.completed", {
        step: 2,
        hasToolCalls: false,
        boundaryMessageIds: [terminal.messageId],
      }),
      turnId: "turn-1",
    });
    await ledger.append(command("message.handled", { messageId: terminal.messageId }));
    projection = projectTaskGraph(await ledger.read(), "run-1");
    expect(projection.tasks[0]?.state).toMatchObject({
      kind: "joined",
      join: { laneId: "main", step: 2, turnId: "turn-1" },
    });
    expect(projection.anomalies).toEqual([]);
  });

  it("treats partial results and failures as terminal facts", async () => {
    const ledger = await initializedLedger();
    const partialRequest = taskRequest("partial");
    const failedRequest = taskRequest("failed");
    await send(ledger, partialRequest);
    await send(ledger, failedRequest);
    await send(ledger, taskResult(partialRequest, { status: "partial" }));
    await send(ledger, taskFailure(failedRequest));

    const projection = projectTaskGraph(await ledger.read(), "run-1");
    expect(projection.tasks.map((task) => task.state)).toEqual([
      expect.objectContaining({
        kind: "terminal",
        terminal: expect.objectContaining({
          type: "task.result",
          payload: expect.objectContaining({ status: "partial" }),
        }),
      }),
      expect.objectContaining({
        kind: "terminal",
        terminal: expect.objectContaining({
          type: "task.failed",
          payload: expect.objectContaining({ retryable: true }),
        }),
      }),
    ]);
  });

  it("does not confuse a claim with a join and marks handled-without-commit stale", async () => {
    const ledger = await initializedLedger();
    const request = taskRequest("task-1");
    const terminal = taskResult(request);
    await send(ledger, request);
    await send(ledger, terminal);
    await ledger.append(command("message.claimed", {
      messageId: terminal.messageId,
      claimedBy: "main",
    }));

    expect(projectTaskGraph(await ledger.read(), "run-1").tasks[0]?.state.kind)
      .toBe("terminal");
    await ledger.append(command("message.handled", { messageId: terminal.messageId }));
    expect(projectTaskGraph(await ledger.read(), "run-1").tasks[0]?.state).toMatchObject({
      kind: "stale",
      reason: "terminal-handled-without-join",
      terminal: { messageId: terminal.messageId },
    });
  });

  it("invalidates unjoined work on a later parent Goal revision", async () => {
    const ledger = await initializedLedger();
    const beforeTerminal = taskRequest("before-terminal");
    const afterTerminal = taskRequest("after-terminal");
    await send(ledger, beforeTerminal);
    await send(ledger, afterTerminal);
    await send(ledger, taskResult(afterTerminal));
    await ledger.append(command("goal.revised", {
      goal: { ...goal, version: 2, statement: "Inspect a different package" },
    }));

    const nextGoalTask = taskRequest("new-goal");
    await send(ledger, nextGoalTask);
    const projection = projectTaskGraph(await ledger.read(), "run-1");
    expect(projection.tasks[0]?.state).toMatchObject({
      kind: "stale",
      reason: "goal-revised-before-join",
    });
    expect(projection.tasks[1]?.state).toMatchObject({
      kind: "stale",
      reason: "goal-revised-before-join",
      terminal: { type: "task.result" },
    });
    expect(projection.tasks[2]).toMatchObject({
      runGoalVersion: 2,
      request: { goal: { version: 1 } },
      state: { kind: "delegated" },
    });
  });

  it("does not retroactively stale a joined task after Goal revision", async () => {
    const ledger = await initializedLedger();
    const request = taskRequest("task-1");
    const terminal = taskResult(request);
    await send(ledger, request);
    await send(ledger, terminal);
    await ledger.append(command("step.completed", {
      step: 1,
      hasToolCalls: false,
      boundaryMessageIds: [terminal.messageId],
    }));
    await ledger.append(command("goal.revised", {
      goal: { ...goal, version: 2 },
    }));

    expect(projectTaskGraph(await ledger.read(), "run-1").tasks[0]?.state.kind)
      .toBe("joined");
  });

  it("keeps unjoined Worker results alive across Turn boundaries", async () => {
    const ledger = await initializedLedger();
    const request = taskRequest("task-1");
    await send(ledger, request);
    await send(ledger, taskResult(request));
    await ledger.append({
      ...command("turn.completed", { turnId: "turn-1" }),
      turnId: "turn-1",
    });

    expect(projectTaskGraph(await ledger.read(), "run-1").tasks[0]?.state.kind)
      .toBe("terminal");
  });

  it("rejects orphaned and causally invalid replies", async () => {
    const ledger = await initializedLedger();
    const request = taskRequest("task-1");
    await send(ledger, request);
    await send(ledger, {
      ...taskResult(request),
      messageId: "orphan-result",
      parentId: "missing-request",
      replyTo: "missing-request",
    });
    await send(ledger, {
      ...taskResult(request),
      messageId: "invalid-result",
      correlationId: "wrong-correlation",
    });
    await send(ledger, {
      ...taskAccept(request),
      messageId: "invalid-accept",
      to: "someone-else",
    });

    const projection = projectTaskGraph(await ledger.read(), "run-1");
    expect(projection.tasks[0]?.state.kind).toBe("delegated");
    expect(projection.anomalies.map((item) => item.kind)).toEqual([
      "orphan-terminal",
      "invalid-terminal-link",
      "invalid-accept-link",
    ]);
  });

  it("marks conflicting terminals stale before join", async () => {
    const ledger = await initializedLedger();
    const request = taskRequest("task-1");
    await send(ledger, request);
    await send(ledger, taskResult(request));
    await send(ledger, {
      ...taskFailure(request),
      messageId: "run-1:worker:task:task-1:second-terminal",
    });

    const projection = projectTaskGraph(await ledger.read(), "run-1");
    expect(projection.tasks[0]?.state).toMatchObject({
      kind: "stale",
      reason: "conflicting-terminal",
      terminal: { type: "task.result" },
    });
    expect(projection.anomalies).toEqual([
      expect.objectContaining({ kind: "conflicting-terminal" }),
    ]);
  });

  it("preserves a committed join when a conflicting terminal arrives later", async () => {
    const ledger = await initializedLedger();
    const request = taskRequest("task-1");
    const terminal = taskResult(request);
    await send(ledger, request);
    await send(ledger, terminal);
    await ledger.append(command("step.completed", {
      step: 1,
      hasToolCalls: false,
      boundaryMessageIds: [terminal.messageId],
    }));
    await send(ledger, {
      ...taskFailure(request),
      messageId: "run-1:worker:task:task-1:second-terminal",
    });

    const projection = projectTaskGraph(await ledger.read(), "run-1");
    expect(projection.tasks[0]?.state.kind).toBe("joined");
    expect(projection.anomalies.map((item) => item.kind)).toContain("conflicting-terminal");
  });

  it("requires the parent lane to commit the join", async () => {
    const ledger = await initializedLedger();
    const request = taskRequest("task-1");
    const terminal = taskResult(request);
    await send(ledger, request);
    await send(ledger, terminal);
    await ledger.append(command("step.completed", {
      step: 1,
      hasToolCalls: false,
      boundaryMessageIds: [terminal.messageId],
    }, "worker"));

    const projection = projectTaskGraph(await ledger.read(), "run-1");
    expect(projection.tasks[0]?.state.kind).toBe("terminal");
    expect(projection.anomalies.map((item) => item.kind)).toContain("join-from-wrong-lane");
  });

  it("is Run-isolated, order-independent, duplicate-safe, and prototype-safe", async () => {
    const ledger = await initializedLedger();
    const request = taskRequest("__proto__");
    await send(ledger, request);
    await send(ledger, taskResult(request));
    const events = await ledger.read();
    const otherRun = events.map((event) => ({ ...event, runId: "run-2" }));
    const scrambled = [...otherRun, ...events.slice().reverse(), events[1]!];

    const projection = projectTaskGraph(scrambled, "run-1");
    expect(projection.tasks).toHaveLength(1);
    expect(projection.tasks[0]).toMatchObject({
      taskId: "__proto__",
      state: { kind: "terminal" },
    });
    expect(projection.anomalies).toEqual([]);
  });
});

async function initializedLedger(): Promise<MemoryLedger> {
  const ledger = new MemoryLedger();
  await ledger.append(command("run.created", {
    goal,
    workspace: "/workspace",
    policy,
  }));
  return ledger;
}

async function send(ledger: MemoryLedger, message: A2AMessage): Promise<void> {
  await ledger.append(command("message.sent", { message }, message.from));
}

function command<K extends EventType>(
  type: K,
  payload: AppendEvent<K>["payload"],
  laneId = "main",
): AppendEvent<K> {
  return {
    runId: "run-1",
    laneId,
    type,
    payload,
    correlationId: "run-1",
    idempotencyKey: `${type}:${laneId}:${JSON.stringify(payload)}`,
  };
}

function taskRequest(taskId: string): A2AMessage {
  const requestMessageId = `run-1:task:${taskId}:request`;
  return {
    messageId: requestMessageId,
    runId: "run-1",
    conversationId: "run-1",
    threadId: "run-1:main",
    from: "main",
    to: "worker",
    createdAt: "2026-08-27T12:00:00.000Z",
    correlationId: "run-1",
    idempotencyKey: requestMessageId,
    visibility: "run",
    priority: 1,
    delivery: "next-step",
    payload: {
      type: "task.request",
      taskId,
      goal,
      inputRefs: [],
      budget: { maxModelTokens: 500, maxWallClockMs: 5_000 },
    },
  };
}

function taskAccept(request: A2AMessage): A2AMessage {
  const taskId = request.payload.type === "task.request" ? request.payload.taskId : "invalid";
  return reply(request, {
    type: "task.accept",
    taskId,
  }, `run-1:worker:task:${taskId}:accept`);
}

function taskResult(
  request: A2AMessage,
  overrides: Partial<TaskResult> = {},
): A2AMessage {
  const taskId = request.payload.type === "task.request" ? request.payload.taskId : "invalid";
  return reply(request, {
    type: "task.result",
    taskId,
    status: "completed",
    summary: "Grounded result",
    evidenceRefs: [],
    artifactRefs: [],
    openQuestions: [],
    usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  }, `run-1:worker:task:${taskId}:result`);
}

function taskFailure(request: A2AMessage): A2AMessage {
  const taskId = request.payload.type === "task.request" ? request.payload.taskId : "invalid";
  const payload: TaskFailed = {
    type: "task.failed",
    taskId,
    reason: "Provider unavailable",
    retryable: true,
    evidenceRefs: [],
  };
  return reply(request, payload, `run-1:worker:task:${taskId}:failed`);
}

function reply(
  request: A2AMessage,
  payload: A2AMessage["payload"],
  messageId: string,
): A2AMessage {
  return {
    messageId,
    runId: request.runId,
    conversationId: request.conversationId,
    threadId: request.threadId,
    from: request.to,
    to: request.from,
    parentId: request.messageId,
    replyTo: request.messageId,
    createdAt: "2026-08-27T12:00:01.000Z",
    correlationId: request.correlationId,
    idempotencyKey: messageId,
    visibility: request.visibility,
    priority: request.priority,
    delivery: request.delivery,
    payload,
  };
}
