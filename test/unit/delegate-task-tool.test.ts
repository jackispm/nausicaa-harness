import { describe, expect, it, vi } from "vitest";

import { A2AInbox } from "../../src/a2a/index.js";
import type { ToolExecutionContext } from "../../src/domain/index.js";
import { TaskDispatcher } from "../../src/runtime/index.js";
import { createDelegateTaskTool } from "../../src/runtime/index.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

const context: ToolExecutionContext = {
  runId: "run-1",
  workspace: "/workspace",
  operationId: "operation-1",
};

function setup(maxInputBytes?: number, policy?: { depth?: number; maxDepth?: number }) {
  const inbox = new A2AInbox();
  const store = new MemoryContentAddressedStore();
  const dispatcher = new TaskDispatcher({ inbox, runId: "run-1" });
  const tool = createDelegateTaskTool({
    dispatcher,
    store,
    ...(maxInputBytes === undefined ? {} : { maxInputBytes }),
    ...(policy ?? {}),
  });
  return { inbox, store, tool };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("delegate_task tool", () => {
  it("exposes asynchronous delegation without model-controlled execution limits", () => {
    const { tool } = setup();
    expect(tool.definition.parameters.required).toEqual(["statement"]);
    expect(Object.keys(tool.definition.parameters.properties ?? {})).toEqual(["taskId", "statement", "input"]);
    expect(tool.definition.description).toMatch(/asynchronously/i);
    expect(tool.definition.description).toMatch(/read-only workspace tools/i);
    expect(tool.definition.description).not.toMatch(/continue other work/i);
  });

  it("stores optional input and queues a task without synthetic limits", async () => {
    const { inbox, store, tool } = setup();
    const result = await tool.execute({
      taskId: "task-1",
      statement: "Find the install command",
      input: "package metadata",
    }, context);

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      status: "queued",
      taskId: "task-1",
    });
    const message = inbox.snapshot().records[0]?.message;
    expect(message?.payload).toMatchObject({
      type: "task.request",
      taskId: "task-1",
      goal: { statement: "Find the install command" },
      budget: {},
    });
    const refs = message?.payload.type === "task.request" ? message.payload.inputRefs : [];
    expect(refs).toHaveLength(1);
    await expect(store.get(refs[0]!)).resolves.toEqual(
      new TextEncoder().encode("package metadata"),
    );
  });

  it("rejects an already cancelled delegation before storing input", async () => {
    const { inbox, store, tool } = setup();
    const abort = new AbortController();
    abort.abort(new Error("Cancelled before delegation"));

    const result = await tool.execute({ statement: "Inspect input", input: "private input" }, {
      ...context, signal: abort.signal,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Cancelled before delegation");
    expect(await store.listObjects()).toEqual([]);
    expect(inbox.snapshot().records).toEqual([]);
  });

  it("does not dispatch when cancelled during input persistence", async () => {
    const { inbox, store, tool } = setup();
    const entered = deferred<void>();
    const release = deferred<void>();
    const put = store.put.bind(store);
    vi.spyOn(store, "put").mockImplementationOnce(async (...arguments_) => {
      entered.resolve();
      await release.promise;
      return put(...arguments_);
    });
    const abort = new AbortController();
    const execution = tool.execute({ statement: "Inspect input", input: "saved input" }, {
      ...context, signal: abort.signal,
    });
    await entered.promise;
    abort.abort(new Error("Cancelled while storing input"));
    release.resolve();

    const result = await execution;
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Cancelled while storing input");
    expect(inbox.snapshot().records).toEqual([]);
    expect(await store.listObjects()).toHaveLength(1);
  });

  it("propagates cancellation while waiting for serialized task admission", async () => {
    const { inbox, tool } = setup();
    const entered = deferred<void>();
    const release = deferred<void>();
    const send = inbox.send.bind(inbox);
    vi.spyOn(inbox, "send").mockImplementationOnce(async (message) => {
      entered.resolve();
      await release.promise;
      return send(message);
    });
    const first = tool.execute({ taskId: "first", statement: "First task" }, context);
    await entered.promise;
    const abort = new AbortController();
    const second = tool.execute({ taskId: "cancelled", statement: "Must not start" }, {
      ...context, operationId: "second-operation", signal: abort.signal,
    });
    abort.abort(new Error("Cancelled while queued for admission"));
    release.resolve();

    const [admitted, cancelled] = await Promise.all([first, second]);
    expect(admitted.isError).toBe(false);
    expect(cancelled.isError).toBe(true);
    expect(cancelled.content).toContain("Cancelled while queued for admission");
    expect(inbox.snapshot().records.map((record) => record.message.messageId))
      .toEqual(["run-1:task:first:request"]);
  });

  it("returns an admitted task truthfully when cancelled after persistence", async () => {
    const { inbox, tool } = setup();
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
    const execution = tool.execute({ taskId: "admitted", statement: "Already admitted" }, {
      ...context, signal: abort.signal,
    });
    await persisted.promise;
    abort.abort(new Error("Cancelled after persistence"));
    release.resolve();

    const result = await execution;
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({ status: "queued", taskId: "admitted" });
    expect(inbox.snapshot().records).toHaveLength(1);
  });

  it.each([
    { taskId: "" },
    { taskId: "invalid\0task" },
    { taskId: "x".repeat(129) },
    { statement: "invalid\0goal" },
    { maxAttempts: 2 },
    { maxModelTokens: 2_000 },
    { maxWallClockMs: 30_000 },
    { successCriteria: ["Return a command"] },
    { hardConstraints: ["Do not modify files"] },
  ])("validates task fields before input persistence: %j", async (invalid) => {
    const { inbox, store, tool } = setup();
    const result = await tool.execute({ statement: "Inspect input", input: "Do not persist", ...invalid }, context);

    expect(result.isError).toBe(true);
    expect(await store.listObjects()).toEqual([]);
    expect(inbox.snapshot().records).toEqual([]);
  });

  it("does not add a token, time or model call limit to new requests", async () => {
    const { inbox, tool } = setup();
    const result = await tool.execute({
      statement: "Summarize the supplied context",
    }, context);

    expect(result.isError).toBe(false);
    const message = inbox.snapshot().records[0]?.message;
    expect(message?.payload).toMatchObject({
      type: "task.request",
      inputRefs: [],
      goal: { successCriteria: [], hardConstraints: [] },
      budget: {},
    });
    expect(message?.payload.type === "task.request" ? message.payload.budget : undefined).toEqual({});
  });

  it("rejects overlarge input without sending a task", async () => {
    const { inbox, tool } = setup(4);
    const result = await tool.execute({
      statement: "Inspect input",
      input: "too large",
    }, context);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("exceeds");
    expect(inbox.snapshot().records).toEqual([]);
  });

  it("rejects unsupported limits even when called without schema validation", async () => {
    const { inbox, tool } = setup();
    const result = await tool.execute({
      statement: "Inspect input",
      maxAttempts: 2,
    }, context);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("maxAttempts");
    expect(inbox.snapshot().records).toEqual([]);
  });

  it("rejects recursive delegation before writing input or sending a task", async () => {
    const { inbox, tool } = setup(undefined, { depth: 1, maxDepth: 1 });
    const result = await tool.execute({
      statement: "Nested work",
      input: "must not be persisted",
    }, context);

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/recursion depth limit/i);
    expect(inbox.snapshot().records).toEqual([]);
  });
});
