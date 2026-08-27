import type { AgentTool } from "../domain/ports.js";
import { MAX_TASK_ATTEMPTS } from "../domain/types.js";
import type { ContentAddressedStore } from "../store/index.js";
import { TaskDispatcher } from "./task-dispatcher.js";

const DEFAULT_MAX_INPUT_BYTES = 64 * 1024;
const MAX_STRING_LENGTH = 4_096;

export interface DelegateTaskToolOptions {
  dispatcher: TaskDispatcher;
  store: ContentAddressedStore;
  maxInputBytes?: number;
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

  return {
    definition: {
      name: "delegate_task",
      description: "Queue one bounded read-only Worker task and return its task id.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Stable id for retrying this task" },
          statement: { type: "string", description: "The delegated task objective" },
          successCriteria: { type: "array", items: { type: "string" } },
          hardConstraints: { type: "array", items: { type: "string" } },
          input: { type: "string", description: "Optional bounded input data" },
          maxModelTokens: { type: "integer", minimum: 1 },
          maxWallClockMs: { type: "integer", minimum: 1 },
          maxAttempts: { type: "integer", minimum: 1, maximum: MAX_TASK_ATTEMPTS },
        },
        required: ["statement", "maxModelTokens", "maxWallClockMs"],
        additionalProperties: false,
      },
    },

    async execute(arguments_) {
      try {
        const statement = requiredString(arguments_.statement, "statement");
        const successCriteria = stringArray(arguments_.successCriteria, "successCriteria");
        const hardConstraints = stringArray(arguments_.hardConstraints, "hardConstraints");
        const maxModelTokens = positiveInteger(arguments_.maxModelTokens, "maxModelTokens");
        const maxWallClockMs = positiveInteger(arguments_.maxWallClockMs, "maxWallClockMs");
        const maxAttempts = optionalPositiveInteger(arguments_.maxAttempts, "maxAttempts");
        const input = optionalString(arguments_.input, "input");
        if (input !== undefined && Buffer.byteLength(input, "utf8") > maxInputBytes) {
          throw new RangeError(`input exceeds ${maxInputBytes} bytes`);
        }

        const inputRefs = input === undefined
          ? []
          : [await options.store.put(input, "text/plain")];
        const result = await options.dispatcher.dispatch({
          ...(arguments_.taskId === undefined
            ? {}
            : { taskId: requiredString(arguments_.taskId, "taskId") }),
          goal: {
            version: 1,
            statement,
            successCriteria,
            hardConstraints,
          },
          inputRefs,
          budget: {
            maxModelTokens,
            maxWallClockMs,
            ...(maxAttempts === undefined ? {} : { maxAttempts }),
          },
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
