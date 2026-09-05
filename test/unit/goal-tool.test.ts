import { describe, expect, it } from "vitest";

import type { ThreadGoal, ToolExecutionContext } from "../../src/domain/index.js";
import { createGoalTools } from "../../src/runtime/index.js";

const context: ToolExecutionContext = {
  runId: "goal-tool-run",
  workspace: "/workspace",
  operationId: "goal-tool-operation",
};

function goal(status: ThreadGoal["status"] = "active"): ThreadGoal {
  return {
    goalId: "goal-1",
    revision: 1,
    objective: "Verify the change",
    status,
    tokenBudget: 100,
    tokensUsed: 12,
    timeUsedSeconds: 3,
    continuationsUsed: 1,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    ...(status === "blocked" ? { blockedReason: "missing evidence" } : {}),
  };
}

describe("persistent Goal tools", () => {
  it("uses the Codex-shaped tool catalog and response fields", async () => {
    let current: ThreadGoal | undefined;
    const tools = createGoalTools({
      get: () => current,
      create: async (objective, tokenBudget) => {
        current = {
          ...goal(),
          objective,
          ...(tokenBudget === undefined ? {} : { tokenBudget }),
        };
        return current;
      },
      update: async (status) => {
        current = { ...goal(status), status, revision: 2 };
        return current;
      },
    });

    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "get_goal",
      "create_goal",
      "update_goal",
    ]);
    expect(tools[1]?.definition.parameters.required).toEqual(["objective"]);
    expect(tools[2]?.definition.parameters.properties?.status).toMatchObject({
      enum: ["complete", "blocked"],
    });

    const empty = await tools[0]!.execute({}, context);
    expect(JSON.parse(empty.content)).toEqual({
      goal: null,
      remainingTokens: null,
      completionBudgetReport: null,
    });

    const created = await tools[1]!.execute({
      objective: "  Verify the change  ",
      token_budget: 200,
    }, context);
    expect(JSON.parse(created.content)).toMatchObject({
      goal: { objective: "Verify the change", tokenBudget: 200 },
      remainingTokens: 188,
      completionBudgetReport: null,
    });

    const completed = await tools[2]!.execute({ status: "complete" }, context);
    expect(JSON.parse(completed.content)).toMatchObject({
      goal: { status: "complete" },
      remainingTokens: 88,
    });
  });

  it("serializes model-side reads and writes in call order", async () => {
    let current: ThreadGoal | undefined;
    const tools = createGoalTools({
      get: () => current,
      create: async (objective) => {
        current = { ...goal(), objective };
        return current;
      },
      update: async () => {
        current = { ...goal("complete"), revision: 2 };
        return current;
      },
    });

    const results = await Promise.all([
      tools[1]!.execute({ objective: "Verify" }, { ...context, operationId: "create" }),
      tools[0]!.execute({}, { ...context, operationId: "get" }),
    ]);
    expect(JSON.parse(results[0]!.content).goal.objective).toBe("Verify");
    expect(JSON.parse(results[1]!.content).goal.objective).toBe("Verify");
  });
});
