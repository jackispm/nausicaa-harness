import type { AgentTool, ToolExecutionContext, ToolResult } from "../domain/ports.js";
import type { ThreadGoal } from "../domain/types.js";
import { annotateTool } from "../mowe/catalog.js";

const MAX_GOAL_OBJECTIVE_CHARS = 4_000;

export interface GoalToolOptions {
  /** Return the current host-owned thread Goal, if one exists. */
  get: () => ThreadGoal | undefined;
  /** Create a new Goal after the host has admitted the mutation. */
  create: (objective: string, tokenBudget?: number) => Promise<ThreadGoal>;
  /** Mark the current Goal complete or blocked. */
  update: (
    status: "complete" | "blocked",
    blockedReason?: string,
  ) => Promise<ThreadGoal>;
}

/**
 * Build the model-facing persistent thread Goal capability.
 *
 * Ordinary user requests do not create a Goal implicitly. The descriptions
 * make that rule explicit because whether a request is long-running is a
 * semantic decision made from the conversation, not from the host runtime.
 */
export function createGoalTools(options: GoalToolOptions): AgentTool[] {
  if (options === null || typeof options !== "object") {
    throw new TypeError("Goal tool options must be an object");
  }
  if (typeof options.get !== "function"
    || typeof options.create !== "function"
    || typeof options.update !== "function") {
    throw new TypeError("Goal tools require get, create, and update callbacks");
  }

  // Mowe may execute different tool names in the same response concurrently.
  // Goal reads and writes share one serialized host boundary so a later call
  // observes the revision committed by an earlier call in model order.
  let operationTail: Promise<void> = Promise.resolve();
  const serialize = async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const getGoal: AgentTool = {
    definition: {
      name: "get_goal",
      description:
        "Get the current persistent thread Goal, including status, token and elapsed-time usage, and remaining token budget. A normal task may have no Goal.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    async execute(_arguments_, context): Promise<ToolResult> {
      return serialize(async () => {
        try {
          assertContext(context);
          return success(goalToolResponse(options.get(), false));
        } catch (error: unknown) {
          return failure(error);
        }
      });
    },
  };

  const createGoal: AgentTool = {
    definition: {
      name: "create_goal",
      description:
        "Create a persistent Goal only when the user explicitly asks for a long-running objective; do not create one for routine single-turn work. Fails if an unfinished Goal exists. Set token_budget only when explicitly requested.",
      parameters: {
        type: "object",
        properties: {
          objective: {
            type: "string",
            minLength: 1,
            maxLength: MAX_GOAL_OBJECTIVE_CHARS,
            description: "Concrete completion objective for the persistent thread Goal.",
          },
          token_budget: {
            type: "integer",
            minimum: 1,
            description: "Optional positive token budget for this Goal.",
          },
        },
        required: ["objective"],
        additionalProperties: false,
      },
    },
    async execute(arguments_, context): Promise<ToolResult> {
      return serialize(async () => {
        try {
          assertContext(context);
          const objective = requiredObjective(arguments_.objective);
          const tokenBudget = optionalPositiveInteger(arguments_.token_budget, "token_budget");
          const goal = await options.create(objective, tokenBudget);
          return success(goalToolResponse(goal, false));
        } catch (error: unknown) {
          return failure(error);
        }
      });
    },
  };

  const updateGoal: AgentTool = {
    definition: {
      name: "update_goal",
      description:
        "Update the existing persistent Goal. Use status=complete only when its objective is actually achieved; use status=blocked only after the same genuine blocking condition has persisted for at least three consecutive Goal continuations. Difficulty, uncertainty, or useful remaining work is not blocked. Pause, resume, edit, clear, usage limits, and budget limits are host-controlled.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["complete", "blocked"],
            description: "Whether the current Goal is complete or genuinely blocked.",
          },
        },
        required: ["status"],
        additionalProperties: false,
      },
    },
    async execute(arguments_, context): Promise<ToolResult> {
      return serialize(async () => {
        try {
          assertContext(context);
          const status = arguments_.status;
          if (status !== "complete" && status !== "blocked") {
            throw new Error(
              "update_goal can only mark the existing Goal complete or blocked; pause, resume, and clearing are host-controlled",
            );
          }
          const goal = await options.update(status);
          return success(goalToolResponse(goal, status === "complete"));
        } catch (error: unknown) {
          return failure(error);
        }
      });
    },
  };

  return [
    annotateTool(getGoal, {
      effect: "read",
      deterministic: false,
      supportsBatch: true,
      concurrencySafe: true,
      scope: "run",
      inputKinds: ["json"],
      outputKinds: ["json"],
    }),
    annotateTool(createGoal, {
      effect: "write",
      deterministic: false,
      supportsBatch: false,
      concurrencySafe: false,
      scope: "run",
      inputKinds: ["json"],
      outputKinds: ["json"],
    }),
    annotateTool(updateGoal, {
      effect: "write",
      deterministic: false,
      supportsBatch: false,
      concurrencySafe: false,
      scope: "run",
      inputKinds: ["json"],
      outputKinds: ["json"],
    }),
  ];
}

function assertContext(context: ToolExecutionContext): void {
  if (context.runId.trim().length === 0) throw new Error("Goal tool requires a Run context");
}

function requiredObjective(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("objective must be a string");
  const objective = value.trim();
  if (objective.length === 0) throw new TypeError("objective must not be empty");
  if ([...objective].length > MAX_GOAL_OBJECTIVE_CHARS) {
    throw new TypeError(`objective must be at most ${MAX_GOAL_OBJECTIVE_CHARS} characters`);
  }
  if (objective.includes("\0")) throw new TypeError("objective must not contain NUL");
  return objective;
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value as number;
}

function goalToolResponse(goal: ThreadGoal | undefined, includeCompletionReport: boolean): {
  goal: ThreadGoal | null;
  remainingTokens: number | null;
  completionBudgetReport: string | null;
} {
  if (goal === undefined) {
    return {
      goal: null,
      remainingTokens: null,
      completionBudgetReport: null,
    };
  }
  const remainingTokens = goal.tokenBudget === undefined
    ? null
    : Math.max(0, goal.tokenBudget - goal.tokensUsed);
  const report = includeCompletionReport && goal.status === "complete"
    ? completionBudgetReport(goal)
    : null;
  return {
    goal: structuredClone(goal),
    remainingTokens,
    completionBudgetReport: report,
  };
}

function completionBudgetReport(goal: ThreadGoal): string | null {
  const parts: string[] = [];
  if (goal.tokenBudget !== undefined) {
    parts.push(`tokens used: ${goal.tokensUsed} of ${goal.tokenBudget}`);
  }
  if (goal.timeUsedSeconds > 0) {
    parts.push(`time used: ${goal.timeUsedSeconds} seconds`);
  }
  return parts.length === 0
    ? null
    : `Goal achieved. Report final usage to the user: ${parts.join("; ")}.`;
}

function success(value: unknown): ToolResult {
  return { content: JSON.stringify(value), isError: false };
}

function failure(error: unknown): ToolResult {
  return {
    content: JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }),
    isError: true,
  };
}
