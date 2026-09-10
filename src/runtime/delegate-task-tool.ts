import type { AgentTool } from "../domain/ports.js";
import type { Goal, TaskBudget } from "../domain/types.js";
import type { ContentAddressedStore } from "../store/index.js";
import { TaskDispatcher, validateTaskDispatchRequest } from "./task-dispatcher.js";
import {
  DEFAULT_SUBAGENT_MAX_DEPTH,
  assertSubagentSpawnAllowed,
  evaluateSubagentDepth,
} from "./subagent-policy.js";

const DEFAULT_MAX_INPUT_BYTES = 64 * 1024;
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
 * Main-facing capability for creating an asynchronous Worker task. The tool stores
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
      description: "Queue a read-only Worker task. The Worker may use read-only workspace tools and returns a result asynchronously at one of your later steps or turns.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Stable id for retrying this task" },
          statement: { type: "string", description: "The delegated task objective" },
          input: { type: "string", description: "Optional bounded input data" },
        },
        required: ["statement"],
        additionalProperties: false,
      },
    },

    async execute(arguments_, context) {
      try {
        context.signal?.throwIfAborted();
        // Admission happens before input persistence or Inbox mutation. A
        // denied recursive spawn therefore leaves no orphaned artifacts.
        assertSubagentSpawnAllowed(depth, maxDepth);
        for (const field of Object.keys(arguments_)) {
          if (!["taskId", "statement", "input"].includes(field)) {
            throw new TypeError(`${field} is not supported by delegate_task`);
          }
        }
        const statement = requiredString(arguments_.statement, "statement");
        const input = optionalString(arguments_.input, "input");
        if (input !== undefined && Buffer.byteLength(input, "utf8") > maxInputBytes) {
          throw new RangeError(`input exceeds ${maxInputBytes} bytes`);
        }

        const taskId = arguments_.taskId === undefined
          ? undefined
          : requiredString(arguments_.taskId, "taskId");
        const goal = {
          version: 1,
          statement,
          successCriteria: [],
          hardConstraints: [],
        } satisfies Goal;
        const budget = {} satisfies TaskBudget;
        const request = { ...(taskId === undefined ? {} : { taskId }), goal, budget };
        validateTaskDispatchRequest(request);
        const inputRefs = input === undefined
          ? []
          : [await options.store.put(input, "text/plain")];
        context.signal?.throwIfAborted();
        const result = await options.dispatcher.dispatch({
          ...request,
          inputRefs,
        }, context.signal === undefined ? undefined : { signal: context.signal });
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
