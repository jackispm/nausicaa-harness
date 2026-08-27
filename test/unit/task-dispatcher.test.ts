import { describe, expect, it } from "vitest";

import { A2AInbox, A2AProtocolError } from "../../src/a2a/index.js";
import type { ArtifactRef, Clock, Goal } from "../../src/domain/index.js";
import {
  MAX_TASK_MODEL_TOKENS,
  MAX_TASK_WALL_CLOCK_MS,
} from "../../src/domain/index.js";
import {
  TaskBackpressureError,
  TaskDispatcher,
} from "../../src/runtime/task-dispatcher.js";

class MutableClock implements Clock {
  constructor(private instant: Date) {}

  now(): Date {
    return new Date(this.instant);
  }

  advance(milliseconds: number): void {
    this.instant = new Date(this.instant.getTime() + milliseconds);
  }
}

const baseGoal: Goal = {
  version: 1,
  statement: "Inspect the package installation contract",
  successCriteria: ["Return the command with evidence"],
  hardConstraints: ["Do not modify files"],
};

const baseArtifact: ArtifactRef = {
  id: "artifact-1",
  contentHash: "sha256:artifact-1",
  mediaType: "text/plain",
  byteLength: 12,
};

const baseBudget = { maxModelTokens: 1_000, maxWallClockMs: 30_000 };

describe("TaskDispatcher", () => {
  it("sends a bounded task request with stable defaults and cloned inputs", async () => {
    const clock = new MutableClock(new Date("2026-08-27T12:00:00.000Z"));
    const inbox = new A2AInbox({ clock });
    const dispatcher = new TaskDispatcher({ inbox, runId: "run-1", clock });

    const goal = structuredClone(baseGoal);
    const artifact = structuredClone(baseArtifact);
    const budget = structuredClone(baseBudget);
    const request = {
      taskId: "task-1",
      goal,
      inputRefs: [artifact],
      budget,
    };
    const sent = await dispatcher.dispatch(request);

    expect(sent).toEqual({
      status: "queued",
      taskId: "task-1",
      messageId: "run-1:task:task-1:request",
    });
    const stored = inbox.snapshot().records[0]?.message;
    expect(stored).toMatchObject({
      messageId: "run-1:task:task-1:request",
      runId: "run-1",
      conversationId: "run-1",
      threadId: "run-1:main",
      from: "main",
      to: "worker",
      correlationId: "run-1",
      idempotencyKey: "run-1:task:task-1:request",
      visibility: "run",
      priority: 1,
      delivery: "next-step",
      payload: { type: "task.request", taskId: "task-1" },
    });

    goal.statement = "mutated";
    artifact.byteLength = 99;
    budget.maxModelTokens = 2_000;
    expect(stored?.payload).toMatchObject({
      goal: { statement: "Inspect the package installation contract" },
      inputRefs: [{ byteLength: 12 }],
      budget: { maxModelTokens: 1_000 },
    });
  });

  it("retries an explicit task id as a duplicate despite a new clock time", async () => {
    const clock = new MutableClock(new Date("2026-08-27T12:00:00.000Z"));
    const inbox = new A2AInbox({ clock });
    const dispatcher = new TaskDispatcher({ inbox, runId: "run-1", clock });
    const request = {
      taskId: "task-1",
      goal: baseGoal,
      inputRefs: [],
      budget: baseBudget,
    };

    await expect(dispatcher.dispatch(request)).resolves.toMatchObject({ status: "queued" });
    clock.advance(5_000);
    await expect(dispatcher.dispatch(request)).resolves.toEqual({
      status: "duplicate",
      taskId: "task-1",
      messageId: "run-1:task:task-1:request",
    });
    expect(inbox.snapshot().records).toHaveLength(1);
  });

  it("uses an injected id factory when the caller omits a task id", async () => {
    const inbox = new A2AInbox();
    let calls = 0;
    const dispatcher = new TaskDispatcher({
      inbox,
      runId: "run-1",
      createId: () => `generated-${++calls}`,
    });

    await expect(dispatcher.dispatch({ goal: baseGoal, budget: baseBudget })).resolves.toEqual({
      status: "queued",
      taskId: "generated-1",
      messageId: "run-1:task:generated-1:request",
    });
    expect(calls).toBe(1);
  });

  it("allows per-task metadata overrides", async () => {
    const inbox = new A2AInbox();
    const dispatcher = new TaskDispatcher({ inbox, runId: "run-1" });

    await dispatcher.dispatch({
      taskId: "task-override",
      goal: baseGoal,
      budget: baseBudget,
      from: "explorer",
      to: "worker-2",
      conversationId: "conversation-1",
      threadId: "thread-1",
      correlationId: "correlation-1",
      priority: 8,
      delivery: "deferred",
      visibility: "lane",
    });
    expect(inbox.snapshot().records[0]?.message).toMatchObject({
      from: "explorer",
      to: "worker-2",
      conversationId: "conversation-1",
      threadId: "thread-1",
      correlationId: "correlation-1",
      priority: 8,
      delivery: "deferred",
      visibility: "lane",
    });
  });

  it("preserves a constructor thread when only the task sender is overridden", async () => {
    const inbox = new A2AInbox();
    const dispatcher = new TaskDispatcher({
      inbox,
      runId: "run-1",
      threadId: "shared-thread",
    });

    await dispatcher.dispatch({
      taskId: "task-thread",
      goal: baseGoal,
      budget: baseBudget,
      from: "explorer",
    });

    expect(inbox.snapshot().records[0]?.message.threadId).toBe("shared-thread");
  });

  it.each([
    ["model tokens", { maxModelTokens: MAX_TASK_MODEL_TOKENS + 1, maxWallClockMs: 1_000 }],
    ["wall clock", { maxModelTokens: 1_000, maxWallClockMs: MAX_TASK_WALL_CLOCK_MS + 1 }],
  ])("rejects a task budget beyond the protocol bound (%s)", async (_label, invalidBudget) => {
    const inbox = new A2AInbox();
    const dispatcher = new TaskDispatcher({ inbox, runId: "run-1" });

    await expect(dispatcher.dispatch({ goal: baseGoal, budget: invalidBudget })).rejects.toThrow(/budget/);
    expect(inbox.snapshot().records).toEqual([]);
  });

  it("rejects a changed payload under an existing task id", async () => {
    const inbox = new A2AInbox();
    const dispatcher = new TaskDispatcher({ inbox, runId: "run-1" });
    await dispatcher.dispatch({ taskId: "task-1", goal: baseGoal, budget: baseBudget });

    await expect(dispatcher.dispatch({
      taskId: "task-1",
      goal: { ...baseGoal, statement: "a different task" },
      budget: baseBudget,
    })).rejects.toBeInstanceOf(A2AProtocolError);
  });

  it("bounds outstanding tasks while preserving idempotent retries", async () => {
    const inbox = new A2AInbox();
    const dispatcher = new TaskDispatcher({
      inbox,
      runId: "run-1",
      maxOutstandingTasks: 1,
    });
    const first = { taskId: "task-1", goal: baseGoal, budget: baseBudget };

    await expect(dispatcher.dispatch(first)).resolves.toMatchObject({ status: "queued" });
    await expect(dispatcher.dispatch(first)).resolves.toMatchObject({ status: "duplicate" });
    await expect(dispatcher.dispatch({
      taskId: "task-2",
      goal: baseGoal,
      budget: baseBudget,
    })).rejects.toBeInstanceOf(TaskBackpressureError);

    const [claimed] = await inbox.claim("worker", "worker", { claimId: "claim-1" });
    await inbox.handle(claimed!.message.messageId, "worker");
    await expect(dispatcher.dispatch({
      taskId: "task-2",
      goal: baseGoal,
      budget: baseBudget,
    })).resolves.toMatchObject({ status: "queued" });
  });

  it("serializes concurrent dispatchers sharing an Inbox at the capacity boundary", async () => {
    const inbox = new A2AInbox();
    const first = new TaskDispatcher({
      inbox,
      runId: "run-1",
      maxOutstandingTasks: 1,
    });
    const second = new TaskDispatcher({
      inbox,
      runId: "run-1",
      maxOutstandingTasks: 1,
    });

    const settled = await Promise.allSettled([
      first.dispatch({ taskId: "task-1", goal: baseGoal, budget: baseBudget }),
      second.dispatch({ taskId: "task-2", goal: baseGoal, budget: baseBudget }),
    ]);

    expect(settled.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(inbox.snapshot().records).toHaveLength(1);
  });

  it("does not let an expired task occupy queue capacity forever", async () => {
    const clock = new MutableClock(new Date("2026-08-27T12:00:00.000Z"));
    const inbox = new A2AInbox({ clock });
    const expiring = new TaskDispatcher({
      inbox,
      runId: "run-1",
      clock,
      maxOutstandingTasks: 1,
    });
    await inbox.send({
      messageId: "external-task",
      runId: "run-1",
      conversationId: "run-1",
      threadId: "run-1:main",
      from: "main",
      to: "worker",
      createdAt: clock.now().toISOString(),
      expiresAt: "2026-08-27T12:00:01.000Z",
      correlationId: "run-1",
      idempotencyKey: "external-task",
      visibility: "run",
      priority: 1,
      delivery: "next-step",
      payload: {
        type: "task.request",
        taskId: "external-task",
        goal: baseGoal,
        inputRefs: [],
        budget: baseBudget,
      },
    });
    clock.advance(1_001);

    await expect(expiring.dispatch({
      taskId: "task-2",
      goal: baseGoal,
      budget: baseBudget,
    })).resolves.toMatchObject({ status: "queued" });
  });

  it.each([0, 65])("rejects an invalid outstanding task bound (%s)", (maxOutstandingTasks) => {
    expect(() => new TaskDispatcher({
      inbox: new A2AInbox(),
      runId: "run-1",
      maxOutstandingTasks,
    })).toThrow(/maxOutstandingTasks/);
  });
});
