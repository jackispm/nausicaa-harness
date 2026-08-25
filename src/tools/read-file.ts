import { constants } from "node:fs";

import type { AgentTool, ToolResult } from "../domain/ports.js";
import {
  assertSameFile,
  openNoFollow,
  resolveExistingWorkspacePath,
  revalidateExistingWorkspacePath,
} from "./workspace-path.js";

const DEFAULT_MAX_BYTES = 64 * 1024;
const HARD_MAX_BYTES = 256 * 1024;

export const readFileTool: AgentTool = {
  definition: {
    name: "read_file",
    description: "Read a UTF-8 file inside the workspace with an explicit size bound.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path" },
        maxBytes: { type: "integer", minimum: 1, maximum: HARD_MAX_BYTES },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },

  async execute(arguments_, context): Promise<ToolResult> {
    try {
      throwIfAborted(context.signal);
      const requestedPath = stringArgument(arguments_.path, "path");
      const maxBytes = boundedInteger(arguments_.maxBytes, "maxBytes", DEFAULT_MAX_BYTES, HARD_MAX_BYTES);
      const resolved = await resolveExistingWorkspacePath(context.workspace, requestedPath);
      await revalidateExistingWorkspacePath(resolved);
      const handle = await openNoFollow(resolved.absolute, constants.O_RDONLY);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1) {
          return failure("Path is not a regular file");
        }
        assertSameFile(stat, await revalidateExistingWorkspacePath(resolved));
        const requested = Math.min(stat.size, maxBytes);
        const buffer = Buffer.alloc(requested);
        const { bytesRead } = await handle.read(buffer, 0, requested, 0);
        throwIfAborted(context.signal);
        assertSameFile(stat, await revalidateExistingWorkspacePath(resolved));
        return success({
          path: resolved.relative,
          content: new TextDecoder().decode(buffer.subarray(0, bytesRead)),
          byteLength: stat.size,
          truncated: stat.size > bytesRead,
        });
      } finally {
        await handle.close();
      }
    } catch (error: unknown) {
      return failure(safeMessage(error));
    }
  },
};

function stringArgument(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  name: string,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value as number;
}

function success(value: unknown): ToolResult {
  return { content: JSON.stringify(value), isError: false };
}

function failure(message: string): ToolResult {
  return { content: JSON.stringify({ error: message }), isError: true };
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "File read failed";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted", "AbortError");
  }
}
