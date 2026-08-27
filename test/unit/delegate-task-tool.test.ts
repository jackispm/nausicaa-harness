import { describe, expect, it } from "vitest";

import { A2AInbox } from "../../src/a2a/index.js";
import type { ToolExecutionContext } from "../../src/domain/index.js";
import { TaskDispatcher } from "../../src/runtime/index.js";
import {
  createDelegateTaskTool,
  DEFAULT_DELEGATED_ATTEMPTS,
  DEFAULT_DELEGATED_MODEL_TOKENS,
  DEFAULT_DELEGATED_WALL_CLOCK_MS,
} from "../../src/runtime/index.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

const context: ToolExecutionContext = {
  runId: "run-1",
  workspace: "/workspace",
  operationId: "operation-1",
};

function setup(maxInputBytes?: number) {
  const inbox = new A2AInbox();
  const store = new MemoryContentAddressedStore();
  const dispatcher = new TaskDispatcher({ inbox, runId: "run-1" });
  const tool = createDelegateTaskTool({ dispatcher, store, ...(maxInputBytes === undefined ? {} : { maxInputBytes }) });
  return { inbox, store, tool };
}

describe("delegate_task tool", () => {
  it("exposes an optional-budget async delegation contract", () => {
    const { tool } = setup();
    expect(tool.definition.parameters.required).toEqual(["statement"]);
    expect(tool.definition.description).toMatch(/asynchronously/i);
    expect(tool.definition.description).toMatch(/read-only workspace tools/i);
    expect(tool.definition.description).toMatch(/continue other work/i);
  });

  it("stores optional input and queues a bounded task request", async () => {
    const { inbox, store, tool } = setup();
    const result = await tool.execute({
      taskId: "task-1",
      statement: "Find the install command",
      successCriteria: ["Return a command"],
      hardConstraints: ["Do not modify files"],
      input: "package metadata",
      maxModelTokens: 500,
      maxWallClockMs: 30_000,
      maxAttempts: 3,
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
      budget: {
        maxModelTokens: 500,
        maxWallClockMs: 30_000,
        maxAttempts: 3,
      },
    });
    const refs = message?.payload.type === "task.request" ? message.payload.inputRefs : [];
    expect(refs).toHaveLength(1);
    await expect(store.get(refs[0]!)).resolves.toEqual(
      new TextEncoder().encode("package metadata"),
    );
  });

  it("uses conservative runtime defaults when budget fields are omitted", async () => {
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
      budget: {
        maxModelTokens: DEFAULT_DELEGATED_MODEL_TOKENS,
        maxWallClockMs: DEFAULT_DELEGATED_WALL_CLOCK_MS,
        maxAttempts: DEFAULT_DELEGATED_ATTEMPTS,
      },
    });
  });

  it("rejects overlarge input without sending a task", async () => {
    const { inbox, tool } = setup(4);
    const result = await tool.execute({
      statement: "Inspect input",
      input: "too large",
      maxModelTokens: 100,
      maxWallClockMs: 1_000,
    }, context);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("exceeds");
    expect(inbox.snapshot().records).toEqual([]);
  });

  it("rejects a Worker attempt budget beyond the protocol bound", async () => {
    const { inbox, tool } = setup();
    const result = await tool.execute({
      statement: "Inspect input",
      maxModelTokens: 100,
      maxWallClockMs: 1_000,
      maxAttempts: 9,
    }, context);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("maxAttempts");
    expect(inbox.snapshot().records).toEqual([]);
  });
});
