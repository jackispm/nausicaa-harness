import type { AgentTool } from "../domain/ports.js";
import {
  DEFAULT_TASK_MAX_ATTEMPTS,
  MAX_TASK_ATTEMPTS,
} from "../domain/types.js";
import type { Goal, TaskBudget } from "../domain/types.js";
import type { ContentAddressedStore } from "../store/index.js";
import { TaskDispatcher } from "./task-dispatcher.js";
import {
  DEFAULT_SUBAGENT_MAX_DEPTH,
  assertSubagentSpawnAllowed,
  evaluateSubagentDepth,
} from "./subagent-policy.js";

const DEFAULT_MAX_INPUT_BYTES = 64 * 1024;
/** Small defaults keep an unconfigured Worker slice bounded and cheap. */
export const DEFAULT_DELEGATED_MODEL_TOKENS = 2_000;
export const DEFAULT_DELEGATED_WALL_CLOCK_MS = 30_000;
export const DEFAULT_DELEGATED_ATTEMPTS = DEFAULT_TASK_MAX_ATTEMPTS;
const MAX_STRING_LENGTH = 4_096;

export interface DelegateTaskToolOptions {
  dispatcher: TaskDispatcher;
  store: ContentAddressedStore;
  maxInputBytes?: number;
  /** Current parent depth; root Main uses zero. */
  depth?: number;
  /** Absolute recursion limit for this host composition. */
  maxDepth?: number;
}

/**
 * Main-facing capability for creating a bounded Worker task. The tool stores
 * optional task input as an artifact so the A2A message remains small.
 */
export function createDelegateTaskTool(options: DelegateTaskToolOptions): AgentTool {
  const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes <= 0) {
    throw new RangeError("maxInputBytes must be a positive integer");
  }
  const depth = options.depth ?? 0;
  const maxDepth = options.maxDepth ?? DEFAULT_SUBAGENT_MAX_DEPTH;
  evaluateSubagentDepth(depth, maxDepth);

  return {
    definition: {
      name: "delegate_task",
      description: "Queue a bounded read-only Worker task. The Worker may use bounded read-only workspace tools and returns a result asynchronously at a later Main step or turn.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Stable id for retrying this task" },
          statement: { type: "string", description: "The delegated task objective" },
          successCriteria: { type: "array", items: { type: "string" }, description: "Optional observable completion criteria" },
          hardConstraints: { type: "array", items: { type: "string" }, description: "Optional constraints, such as read-only or path limits" },
          input: { type: "string", description: "Optional bounded input data" },
          maxModelTokens: { type: "integer", minimum: 1, description: `Optional model-token budget (default ${DEFAULT_DELEGATED_MODEL_TOKENS})` },
          maxWallClockMs: { type: "integer", minimum: 1, description: `Optional wall-clock budget in milliseconds (default ${DEFAULT_DELEGATED_WALL_CLOCK_MS})` },
          maxAttempts: { type: "integer", minimum: 1, maximum: MAX_TASK_ATTEMPTS, description: `Optional provider-attempt budget (default ${DEFAULT_DELEGATED_ATTEMPTS})` },
        },
        required: ["statement"],
        additionalProperties: false,
      },
    },

    async execute(arguments_) {
      try {
        // Admission happens before input persistence or Inbox mutation. A
        // denied recursive spawn therefore leaves no orphaned artifacts.
        assertSubagentSpawnAllowed(depth, maxDepth);
        const statement = requiredString(arguments_.statement, "statement");
        const successCriteria = stringArray(arguments_.successCriteria, "successCriteria");
        const hardConstraints = stringArray(arguments_.hardConstraints, "hardConstraints");
        const maxModelTokens = arguments_.maxModelTokens === undefined
          ? DEFAULT_DELEGATED_MODEL_TOKENS
          : positiveInteger(arguments_.maxModelTokens, "maxModelTokens");
        const maxWallClockMs = arguments_.maxWallClockMs === undefined
          ? DEFAULT_DELEGATED_WALL_CLOCK_MS
          : positiveInteger(arguments_.maxWallClockMs, "maxWallClockMs");
        const maxAttempts = arguments_.maxAttempts === undefined
          ? DEFAULT_DELEGATED_ATTEMPTS
          : optionalPositiveInteger(arguments_.maxAttempts, "maxAttempts");
        const input = optionalString(arguments_.input, "input");
        if (input !== undefined && Buffer.byteLength(input, "utf8") > maxInputBytes) {
          throw new RangeError(`input exceeds ${maxInputBytes} bytes`);
        }

        const inputRefs = input === undefined
          ? []
          : [await options.store.put(input, "text/plain")];
        const taskId = arguments_.taskId === undefined
          ? undefined
          : requiredString(arguments_.taskId, "taskId");
        const goal = {
          version: 1,
          statement,
          successCriteria,
          hardConstraints,
        } satisfies Goal;
        const budget = {
          maxModelTokens,
          maxWallClockMs,
          ...(maxAttempts === undefined ? {} : { maxAttempts }),
        } satisfies TaskBudget;
        const result = await options.dispatcher.dispatch({
          ...(taskId === undefined ? {} : { taskId }),
          goal,
          inputRefs,
          budget,
        });
        return {
          content: JSON.stringify({
            status: result.status,
            taskId: result.taskId,
            messageId: result.messageId,
          }),
          isError: false,
        };
      } catch (error: unknown) {
        return {
          content: JSON.stringify({
            error: error instanceof Error ? error.message : "Task delegation failed",
          }),
          isError: true,
        };
      }
    },
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (value.length > MAX_STRING_LENGTH) {
    throw new RangeError(`${field} exceeds ${MAX_STRING_LENGTH} characters`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field);
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array of strings`);
  return value.map((item, index) => requiredString(item, `${field}[${index}]`));
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value as number;
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, field);
}
