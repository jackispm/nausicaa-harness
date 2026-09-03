import { constants } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import type { AgentTool, ToolResult } from "../domain/ports.js";
import {
  assertSameFile,
  isWorkspacePathAllowed,
  openNoFollow,
  relativePath,
  type ResolvedWorkspacePath,
  resolveExistingWorkspacePath,
  revalidateExistingWorkspacePath,
  type WorkspacePathPolicy,
} from "./workspace-path.js";

const DEFAULT_MAX_ENTRIES = 200;
const HARD_MAX_ENTRIES = 1_000;
const HARD_MAX_OFFSET = 1_000_000;

interface ListFilesOutput {
  path: string;
  offset: number;
  entries: Array<{ path: string; type: "file" | "directory" | "symlink" | "other" }>;
  truncated: boolean;
  nextOffset?: number;
}

export function createListFilesTool(policy: WorkspacePathPolicy = {}): AgentTool {
  const pathPolicy = snapshotPolicy(policy);
  return {
    definition: {
      name: "list_files",
      description: "List workspace files in stable order without following directory symlinks. A returned nextOffset continues a large listing.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative directory; defaults to ." },
          recursive: { type: "boolean" },
          offset: { type: "integer", minimum: 0, maximum: HARD_MAX_OFFSET, description: "Number of stable entries to skip before returning this page" },
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
      const offset = boundedOffset(arguments_.offset);
      const maxEntries = boundedInteger(
        arguments_.maxEntries,
        "maxEntries",
        DEFAULT_MAX_ENTRIES,
        HARD_MAX_ENTRIES,
      );
      const resolved = await resolveExistingWorkspacePath(
        context.workspace,
        requestedPath,
        pathPolicy,
      );
      const entries: ListFilesOutput["entries"] = [];
      const stopAfter = offset + maxEntries;
      let discovered = 0;
      let truncated = false;

      const visit = async (directory: ResolvedWorkspacePath): Promise<void> => {
        const before = await revalidateExistingWorkspacePath(directory);
        if (!before.isDirectory()) {
          throw new Error("Path is not a directory");
        }
        const handle = await openNoFollow(directory.absolute, constants.O_RDONLY);
        let children;
        try {
          const opened = await handle.stat();
          if (!opened.isDirectory()) {
            throw new Error("Path is not a directory");
          }
          assertSameFile(opened, before);
          children = await readdir(directory.absolute, { withFileTypes: true });
          assertSameFile(opened, await revalidateExistingWorkspacePath(directory));
        } finally {
          await handle.close();
        }
        children.sort((left, right) => left.name.localeCompare(right.name));
        for (const child of children) {
          throwIfAborted(context.signal);
          if (discovered >= stopAfter) {
            truncated = true;
            return;
          }
          const absolute = path.join(directory.absolute, child.name);
          if (!isWorkspacePathAllowed(resolved.workspace, absolute, pathPolicy)) {
            continue;
          }
          const type = child.isFile()
            ? "file"
            : child.isDirectory()
              ? "directory"
              : child.isSymbolicLink()
                ? "symlink"
                : "other";
          discovered += 1;
          if (discovered > offset) {
            entries.push({ path: relativePath(resolved.workspace, absolute), type });
          }
          if (recursive && child.isDirectory()) {
            await visit(await resolveExistingWorkspacePath(
              resolved.workspace,
              relativePath(resolved.workspace, absolute),
              pathPolicy,
            ));
            if (truncated) {
              return;
            }
          }
        }
      };

      await visit(resolved);
      return success({
        path: resolved.relative,
        offset,
        entries,
        truncated,
        ...(truncated ? { nextOffset: offset + entries.length } : {}),
      });
    } catch (error: unknown) {
      return failure(error instanceof Error ? error.message : "Directory listing failed");
    }
  },
  };
}

export const listFilesTool: AgentTool = createListFilesTool();

function snapshotPolicy(policy: WorkspacePathPolicy): WorkspacePathPolicy {
  return { protectedPaths: [...(policy.protectedPaths ?? [])] };
}

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

function boundedOffset(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > HARD_MAX_OFFSET) {
    throw new TypeError(`offset must be an integer between 0 and ${HARD_MAX_OFFSET}`);
  }
  return value as number;
}

function success(value: ListFilesOutput): ToolResult {
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
