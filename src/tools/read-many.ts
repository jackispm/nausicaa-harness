import type { AgentTool, ToolExecutionContext, ToolResult } from "../domain/ports.js";
import { createReadFileTool } from "./read-file.js";
import type { WorkspacePathPolicy } from "./workspace-path.js";

const DEFAULT_MAX_TOTAL_BYTES = 192 * 1024;
const HARD_MAX_TOTAL_BYTES = 256 * 1024;
const DEFAULT_TARGET_MAX_BYTES = 32 * 1024;
const HARD_MAX_TARGETS = 16;
const MAX_CONCURRENCY = 6;

interface ReadTarget {
  path: string;
  offset?: number;
  lineByteOffset?: number;
  limit?: number;
  maxBytes?: number;
}

interface ReadManyResult {
  results: Array<Record<string, unknown>>;
  count: number;
  succeeded: number;
  failed: number;
  truncated: boolean;
}

/**
 * A bounded convenience surface for models that do not reliably emit several
 * independent tool calls in one response. Each target still passes through the
 * same workspace path and file identity checks as read_file.
 */
export function createReadManyTool(policy: WorkspacePathPolicy = {}): AgentTool {
  const readFile = createReadFileTool({
    protectedPaths: [...(policy.protectedPaths ?? [])],
  });
  return {
    definition: {
      name: "read_many",
      description: "Read up to 16 workspace file windows in one bounded batch. Results preserve target order and isolate per-file failures. Each truncated file includes nextOffset/nextLineByteOffset for continuation.",
      parameters: {
        type: "object",
        properties: {
          targets: {
            type: "array",
            minItems: 1,
            maxItems: HARD_MAX_TARGETS,
            description: "File windows to read in target order",
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "Workspace-relative file path" },
                offset: { type: "integer", minimum: 1 },
                lineByteOffset: { type: "integer", minimum: 0 },
                limit: { type: "integer", minimum: 1, maximum: 10_000 },
                maxBytes: { type: "integer", minimum: 1, maximum: 256 * 1024 },
              },
              required: ["path"],
              additionalProperties: false,
            },
          },
          maxTotalBytes: {
            type: "integer",
            minimum: 1,
            maximum: HARD_MAX_TOTAL_BYTES,
            description: `Total file-content budget; defaults to ${DEFAULT_MAX_TOTAL_BYTES}`,
          },
        },
        required: ["targets"],
        additionalProperties: false,
      },
    },

    async execute(arguments_, context): Promise<ToolResult> {
      try {
        const targets = parseTargets(arguments_.targets);
        const maxTotalBytes = boundedPositiveInteger(
          arguments_.maxTotalBytes,
          "maxTotalBytes",
          DEFAULT_MAX_TOTAL_BYTES,
          HARD_MAX_TOTAL_BYTES,
        );
        if (maxTotalBytes < targets.length) {
          throw new TypeError(
            `maxTotalBytes must be at least the target count (${targets.length})`,
          );
        }
        const perTargetBudget = Math.floor(maxTotalBytes / targets.length);
        const results: Array<Record<string, unknown>> = new Array(targets.length);

        for (let start = 0; start < targets.length; start += MAX_CONCURRENCY) {
          const batch = targets.slice(start, start + MAX_CONCURRENCY);
          const settled = await Promise.all(batch.map(async (target, batchIndex) => {
            const index = start + batchIndex;
            const maxBytes = Math.min(
              target.maxBytes ?? DEFAULT_TARGET_MAX_BYTES,
              perTargetBudget,
            );
            const result = await readFile.execute(
              { ...target, maxBytes },
              childContext(context, index),
            );
            return normalizeResult(target.path, result);
          }));
          for (const [batchIndex, result] of settled.entries()) {
            results[start + batchIndex] = result;
          }
        }

        const succeeded = results.filter((result) => result.ok === true).length;
        const failed = results.length - succeeded;
        const output: ReadManyResult = {
          results,
          count: results.length,
          succeeded,
          failed,
          truncated: results.some((result) => result.truncated === true),
        };
        return { content: JSON.stringify(output), isError: succeeded === 0 };
      } catch (error: unknown) {
        return failure(error instanceof Error ? error.message : "Batch file read failed");
      }
    },
  };
}

export const readManyTool: AgentTool = createReadManyTool();

function parseTargets(value: unknown): ReadTarget[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > HARD_MAX_TARGETS) {
    throw new TypeError(`targets must contain between 1 and ${HARD_MAX_TARGETS} entries`);
  }
  return value.map((target, index) => {
    if (!isRecord(target)) throw new TypeError(`targets[${index}] must be an object`);
    const allowed = new Set(["path", "offset", "lineByteOffset", "limit", "maxBytes"]);
    const unknown = Object.keys(target).find((key) => !allowed.has(key));
    if (unknown !== undefined) {
      throw new TypeError(`targets[${index}] contains unsupported property ${unknown}`);
    }
    if (typeof target.path !== "string" || target.path.length === 0) {
      throw new TypeError(`targets[${index}].path must be a non-empty string`);
    }
    return {
      path: target.path,
      ...optionalPositiveInteger(target.offset, `targets[${index}].offset`, Number.MAX_SAFE_INTEGER),
      ...optionalNonnegativeInteger(
        target.lineByteOffset,
        `targets[${index}].lineByteOffset`,
        Number.MAX_SAFE_INTEGER,
      ),
      ...optionalPositiveInteger(target.limit, `targets[${index}].limit`, 10_000),
      ...optionalPositiveInteger(target.maxBytes, `targets[${index}].maxBytes`, 256 * 1024),
    };
  });
}

function optionalPositiveInteger(
  value: unknown,
  name: string,
  maximum: number,
): Record<string, number> {
  if (value === undefined) return {};
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return { [name.slice(name.lastIndexOf(".") + 1)]: value as number };
}

function optionalNonnegativeInteger(
  value: unknown,
  name: string,
  maximum: number,
): Record<string, number> {
  if (value === undefined) return {};
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new TypeError(`${name} must be an integer between 0 and ${maximum}`);
  }
  return { [name.slice(name.lastIndexOf(".") + 1)]: value as number };
}

function boundedPositiveInteger(
  value: unknown,
  name: string,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value as number;
}

function normalizeResult(path: string, result: ToolResult): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(result.content) as unknown;
  } catch {
    payload = { error: result.content };
  }
  const normalized = isRecord(payload)
    ? payload
    : { error: "read_file returned an invalid result" };
  return {
    ...normalized,
    path,
    ok: !result.isError,
  };
}

function childContext(context: ToolExecutionContext, index: number): ToolExecutionContext {
  return {
    ...context,
    operationId: `${context.operationId}:${index}`,
  };
}

function failure(message: string): ToolResult {
  return { content: JSON.stringify({ error: message }), isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
