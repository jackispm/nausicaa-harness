import { describe, expect, it, vi } from "vitest";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

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
      budget: {
        maxModelTokens: 1_000,
        maxWallClockMs: 30_000,
        deadline: "2026-08-27T12:00:30.000Z",
        maxAttempts: 2,
      },
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
    expect(inbox.snapshot().records[0]?.message.payload).toMatchObject({
      type: "task.request",
      budget: {
        deadline: "2026-08-27T12:00:30.000Z",
        maxAttempts: 2,
      },
    });
  });

  it("preserves unlimited tasks during dispatch, restart and duplicate admission", async () => {
    const admittedAt = "2026-08-27T12:00:00.000Z";
    const clock = new MutableClock(new Date("2026-08-28T12:00:00.000Z"));
    const inbox = new A2AInbox({ clock });
    const request = { taskId: "unlimited-task", goal: baseGoal, budget: {} };
    const dispatcher = new TaskDispatcher({ inbox, runId: "run-1", clock, admittedAt });

    await expect(dispatcher.dispatch(request)).resolves.toMatchObject({ status: "queued" });
    clock.advance(24 * 60 * 60 * 1_000);
    const restarted = new TaskDispatcher({ inbox, runId: "run-1", clock, admittedAt });
    await expect(restarted.dispatch(request)).resolves.toMatchObject({ status: "duplicate" });
    expect(inbox.snapshot().records).toHaveLength(1);
    const message = inbox.snapshot().records[0]!.message;
    expect(message.createdAt).toBe(admittedAt);
    expect(message.payload.type === "task.request" ? message.payload.budget : undefined).toEqual({});
  });

  it("restores a Team task from its host admission time without extending the deadline", async () => {
    const admittedAt = "2026-08-27T12:00:00.000Z";
    const clock = new MutableClock(new Date("2026-08-27T12:00:05.000Z"));
    const inbox = new A2AInbox({ clock });
    const dispatcher = new TaskDispatcher({ inbox, runId: "run-1", clock, admittedAt });
    const request = {
      taskId: "restored-task",
      goal: baseGoal,
      budget: { ...baseBudget, deadline: "2026-08-27T12:00:30.000Z" },
    };
    expect((await dispatcher.dispatch(request)).status).toBe("queued");
    expect(inbox.snapshot().records[0]?.message).toMatchObject({
      createdAt: admittedAt,
      payload: { budget: { deadline: "2026-08-27T12:00:30.000Z" } },
    });
    clock.advance(5_000);
    const restarted = new TaskDispatcher({ inbox, runId: "run-1", clock, admittedAt });
    expect((await restarted.dispatch(request)).status).toBe("duplicate");
    expect(inbox.snapshot().records).toHaveLength(1);
  });

  it("keeps the existing request timestamp authoritative over a later host default", async () => {
    const clock = new MutableClock(new Date("2026-08-27T12:00:00.000Z"));
    const inbox = new A2AInbox({ clock });
    const request = { taskId: "already-sent", goal: baseGoal, budget: baseBudget };
    await new TaskDispatcher({ inbox, runId: "run-1", clock }).dispatch(request);
    clock.advance(5_000);
    const dispatcher = new TaskDispatcher({ inbox, runId: "run-1", clock, admittedAt: clock.now().toISOString() });
    expect((await dispatcher.dispatch(request)).status).toBe("duplicate");
    expect(inbox.snapshot().records[0]?.message.createdAt).toBe("2026-08-27T12:00:00.000Z");
  });

  it("rejects a future host admission timestamp before writing a task", async () => {
    const clock = new MutableClock(new Date("2026-08-27T12:00:00.000Z"));
    const inbox = new A2AInbox({ clock });
    const dispatcher = new TaskDispatcher({
      inbox, runId: "run-1", clock, admittedAt: "2026-08-27T12:00:01.000Z",
    });
    await expect(dispatcher.dispatch({ taskId: "future", goal: baseGoal, budget: baseBudget })).rejects.toThrow(/future/);
    expect(inbox.snapshot().records).toEqual([]);
  });

  it("lets the Inbox reject a host admission timestamp ahead of its authoritative clock", async () => {
    const inboxClock = new MutableClock(new Date("2026-08-27T12:00:00.000Z"));
    const dispatcherClock = new MutableClock(new Date("2026-08-27T12:00:05.000Z"));
    const inbox = new A2AInbox({ clock: inboxClock });
    const dispatcher = new TaskDispatcher({
      inbox, runId: "run-1", clock: dispatcherClock, admittedAt: "2026-08-27T12:00:01.000Z",
    });
    await expect(dispatcher.dispatch({ taskId: "clock-skew", goal: baseGoal, budget: baseBudget })).rejects.toThrow(/future/);
    expect(inbox.snapshot().records).toEqual([]);
  });

  it.each(["", "not-a-date"])("rejects malformed host admission time %j", (admittedAt) => {
    expect(() => new TaskDispatcher({ inbox: new A2AInbox(), runId: "run-1", admittedAt })).toThrow(/admittedAt/);
  });

  it("rejects an explicit deadline that is not derived from task creation", async () => {
    const clock = new MutableClock(new Date("2026-08-27T12:00:00.000Z"));
    const inbox = new A2AInbox({ clock });
    const dispatcher = new TaskDispatcher({ inbox, runId: "run-1", clock });

    await expect(dispatcher.dispatch({
      taskId: "task-bad-deadline",
      goal: baseGoal,
      budget: {
        ...baseBudget,
        deadline: "2026-08-27T12:00:31.000Z",
      },
    })).rejects.toThrow(/deadline/);
    expect(inbox.snapshot().records).toEqual([]);
  });

  it("rejects a changed explicit maxAttempts under an existing task id", async () => {
    const clock = new MutableClock(new Date("2026-08-27T12:00:00.000Z"));
    const inbox = new A2AInbox({ clock });
    const dispatcher = new TaskDispatcher({ inbox, runId: "run-1", clock });
    await dispatcher.dispatch({ taskId: "task-attempts", goal: baseGoal, budget: baseBudget });

    await expect(dispatcher.dispatch({
      taskId: "task-attempts",
      goal: baseGoal,
      budget: { ...baseBudget, maxAttempts: 3 },
    })).rejects.toBeInstanceOf(A2AProtocolError);
  });

  it("rejects a changed explicit deadline under an existing task id", async () => {
    const clock = new MutableClock(new Date("2026-08-27T12:00:00.000Z"));
    const inbox = new A2AInbox({ clock });
    const dispatcher = new TaskDispatcher({ inbox, runId: "run-1", clock });
    await dispatcher.dispatch({ taskId: "task-deadline", goal: baseGoal, budget: baseBudget });

    await expect(dispatcher.dispatch({
      taskId: "task-deadline",
      goal: baseGoal,
      budget: {
        ...baseBudget,
        deadline: "2026-08-27T12:00:31.000Z",
      },
    })).rejects.toBeInstanceOf(A2AProtocolError);
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

  it.each([
    { label: "another destination", runId: "run-1", to: "worker-2" },
    { label: "another Run", runId: "run-2", to: "worker-1" },
  ])("admits $label while a same-destination send holds capacity", async ({ runId, to }) => {
    const inbox = new A2AInbox();
    const first = new TaskDispatcher({ inbox, runId: "run-1", to: "worker-1", maxOutstandingTasks: 1 });
    const sameDestination = new TaskDispatcher({ inbox, runId: "run-1", to: "unused-default", maxOutstandingTasks: 1 });
    const independent = new TaskDispatcher({ inbox, runId, to: "unused-default", maxOutstandingTasks: 1 });
    const entered = deferred<void>();
    const release = deferred<void>();
    const send = inbox.send.bind(inbox);
    const sendSpy = vi.spyOn(inbox, "send").mockImplementation(async (message) => {
      if (message.payload.type === "task.request" && message.payload.taskId === "first") {
        entered.resolve();
        await release.promise;
      }
      return send(message);
    });
    const admitted = first.dispatch({ taskId: "first", goal: baseGoal, budget: {} });
    await entered.promise;
    let overflowFinished = false;
    const overflow = sameDestination.dispatch({ taskId: "overflow", goal: baseGoal, budget: {}, to: "worker-1" })
      .then((result) => { overflowFinished = true; return result; }, (error: unknown) => { overflowFinished = true; return error; });
    let independentResult: unknown;
    const separate = independent.dispatch({ taskId: "independent", goal: baseGoal, budget: {}, to })
      .then((result) => { independentResult = result; }, (error: unknown) => { independentResult = error; });
    try {
      await expect.poll(() => independentResult).toMatchObject({ status: "queued", taskId: "independent" });
      expect(overflowFinished).toBe(false);
      expect(sendSpy).toHaveBeenCalledTimes(2);
      release.resolve();
      await expect(admitted).resolves.toMatchObject({ status: "queued", taskId: "first" });
      await expect(overflow).resolves.toBeInstanceOf(TaskBackpressureError);
      expect(inbox.snapshot().records.filter((record) => (
        record.message.runId === "run-1" && record.message.to === "worker-1"
      ))).toHaveLength(1);
    } finally {
      release.resolve();
      await Promise.allSettled([admitted, overflow, separate]);
      sendSpy.mockRestore();
    }
  });

  it("rejects an already aborted dispatch without publishing a request", async () => {
    const inbox = new A2AInbox();
    const dispatcher = new TaskDispatcher({ inbox, runId: "run-1" });
    const abort = new AbortController();
    abort.abort(new Error("Cancelled before admission"));

    await expect(dispatcher.dispatch({ goal: baseGoal, budget: baseBudget }, { signal: abort.signal }))
      .rejects.toThrow("Cancelled before admission");
    expect(inbox.snapshot().records).toEqual([]);
  });

  it("rechecks cancellation after waiting for another dispatcher's admission", async () => {
    const inbox = new A2AInbox();
    const first = new TaskDispatcher({ inbox, runId: "run-1" });
    const second = new TaskDispatcher({ inbox, runId: "run-1" });
    const entered = deferred<void>();
    const release = deferred<void>();
    const send = inbox.send.bind(inbox);
    vi.spyOn(inbox, "send").mockImplementationOnce(async (message) => {
      entered.resolve();
      await release.promise;
      return send(message);
    });
    const admitted = first.dispatch({ taskId: "first", goal: baseGoal, budget: baseBudget });
    await entered.promise;
    const abort = new AbortController();
    const cancelled = second.dispatch({ taskId: "cancelled", goal: baseGoal, budget: baseBudget }, {
      signal: abort.signal,
    });
    abort.abort(new Error("Cancelled while awaiting admission"));
    release.resolve();

    await Promise.all([
      expect(admitted).resolves.toMatchObject({ status: "queued", taskId: "first" }),
      expect(cancelled).rejects.toThrow("Cancelled while awaiting admission"),
    ]);
    expect(inbox.snapshot().records.map((record) => record.message.messageId))
      .toEqual(["run-1:task:first:request"]);
    await expect(second.dispatch({ taskId: "later", goal: baseGoal, budget: baseBudget }))
      .resolves.toMatchObject({ status: "queued", taskId: "later" });
  });

  it("preserves the admission result if cancellation follows persistence", async () => {
    const inbox = new A2AInbox();
    const dispatcher = new TaskDispatcher({ inbox, runId: "run-1" });
    const persisted = deferred<void>();
    const release = deferred<void>();
    const send = inbox.send.bind(inbox);
    vi.spyOn(inbox, "send").mockImplementationOnce(async (message) => {
      const result = await send(message);
      persisted.resolve();
      await release.promise;
      return result;
    });
    const abort = new AbortController();
    const execution = dispatcher.dispatch({ taskId: "admitted", goal: baseGoal, budget: baseBudget }, {
      signal: abort.signal,
    });
    await persisted.promise;
    abort.abort(new Error("Cancelled after persistence"));
    release.resolve();

    await expect(execution).resolves.toMatchObject({ status: "queued", taskId: "admitted" });
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
