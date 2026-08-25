import { readdir, realpath } from "node:fs/promises";
import path from "node:path";

import type { AgentTool, ToolResult } from "../domain/ports.js";
import {
  relativePath,
  resolveExistingWorkspacePath,
} from "./workspace-path.js";

const DEFAULT_MAX_ENTRIES = 200;
const HARD_MAX_ENTRIES = 1_000;

export const listFilesTool: AgentTool = {
  definition: {
    name: "list_files",
    description: "List workspace files in stable order without following directory symlinks.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative directory; defaults to ." },
        recursive: { type: "boolean" },
        maxEntries: { type: "integer", minimum: 1, maximum: HARD_MAX_ENTRIES },
      },
      additionalProperties: false,
    },
  },

  async execute(arguments_, context): Promise<ToolResult> {
    try {
      throwIfAborted(context.signal);
      const requestedPath = optionalString(arguments_.path, "path") ?? ".";
      const recursive = optionalBoolean(arguments_.recursive, "recursive") ?? false;
      const maxEntries = boundedInteger(
        arguments_.maxEntries,
        "maxEntries",
        DEFAULT_MAX_ENTRIES,
        HARD_MAX_ENTRIES,
      );
      const resolved = await resolveExistingWorkspacePath(context.workspace, requestedPath);
      const entries: Array<{ path: string; type: "file" | "directory" | "symlink" | "other" }> = [];
      let truncated = false;

      const visit = async (directory: string): Promise<void> => {
        const children = await readdir(directory, { withFileTypes: true });
        children.sort((left, right) => left.name.localeCompare(right.name));
        for (const child of children) {
          throwIfAborted(context.signal);
          if (entries.length >= maxEntries) {
            truncated = true;
            return;
          }
          const absolute = path.join(directory, child.name);
          const type = child.isFile()
            ? "file"
            : child.isDirectory()
              ? "directory"
              : child.isSymbolicLink()
                ? "symlink"
                : "other";
          entries.push({ path: relativePath(resolved.workspace, absolute), type });
          if (recursive && child.isDirectory()) {
            await visit(absolute);
            if (truncated) {
              return;
            }
          }
        }
      };

      const canonical = await realpath(resolved.absolute);
      await visit(canonical);
      return success({ path: resolved.relative, entries, truncated });
    } catch (error: unknown) {
      return failure(error instanceof Error ? error.message : "Directory listing failed");
    }
  },
};

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new TypeError(`${name} must be a boolean`);
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted", "AbortError");
  }
}
