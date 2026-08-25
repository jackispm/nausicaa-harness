import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, rename, unlink } from "node:fs/promises";
import path from "node:path";

import type { AgentTool, ToolResult } from "../domain/ports.js";
import {
  assertSameFile,
  openNoFollow,
  type ResolvedWorkspacePath,
  resolveWorkspaceWritePath,
  revalidateWorkspaceParent,
  revalidateWorkspaceWritePath,
  syncDirectory,
  type WorkspacePathPolicy,
} from "./workspace-path.js";

const HARD_MAX_BYTES = 1024 * 1024;

export function createWriteFileTool(policy: WorkspacePathPolicy = {}): AgentTool {
  const pathPolicy = snapshotPolicy(policy);
  return {
  definition: {
    name: "write_file",
    description: "Atomically write one UTF-8 file inside an existing workspace directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative destination" },
        content: { type: "string", description: "Complete UTF-8 file content" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },

  async execute(arguments_, context): Promise<ToolResult> {
    let temporaryPath: string | undefined;
    let temporaryStat: Stats | undefined;
    let resolved: ResolvedWorkspacePath | undefined;
    try {
      throwIfAborted(context.signal);
      const requestedPath = stringArgument(arguments_.path, "path");
      const content = stringArgument(arguments_.content, "content", true);
      const bytes = Buffer.from(content, "utf8");
      if (bytes.byteLength > HARD_MAX_BYTES) {
        throw new RangeError(`content exceeds the ${HARD_MAX_BYTES}-byte write limit`);
      }

      resolved = await resolveWorkspaceWritePath(
        context.workspace,
        requestedPath,
        pathPolicy,
      );
      temporaryPath = path.join(path.dirname(resolved.absolute), `.nausicaa-${randomUUID()}.tmp`);
      await revalidateWorkspaceParent(resolved);
      const handle = await openNoFollow(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        temporaryStat = await handle.stat();
        if (!temporaryStat.isFile() || temporaryStat.nlink !== 1) {
          throw new Error("Temporary path is not a private regular file");
        }
        await revalidateWorkspaceParent(resolved);
        assertSameFile(temporaryStat, await lstat(temporaryPath));
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      throwIfAborted(context.signal);

      await revalidateWorkspaceParent(resolved);
      assertSameFile(temporaryStat, await lstat(temporaryPath));
      await revalidateWorkspaceWritePath(resolved);
      await rename(temporaryPath, resolved.absolute);
      temporaryPath = undefined;
      await revalidateWorkspaceParent(resolved);
      await revalidateWorkspaceWritePath(resolved);
      await syncDirectory(path.dirname(resolved.absolute));
      return {
        content: JSON.stringify({
          path: resolved.relative,
          byteLength: bytes.byteLength,
          atomic: true,
        }),
        isError: false,
      };
    } catch (error: unknown) {
      return {
        content: JSON.stringify({
          error: error instanceof Error ? error.message : "File write failed",
        }),
        isError: true,
      };
    } finally {
      if (
        temporaryPath !== undefined
        && temporaryStat !== undefined
        && resolved !== undefined
      ) {
        await safeUnlinkTemporary(resolved, temporaryPath, temporaryStat);
      }
    }
  },
  };
}

export const writeFileTool: AgentTool = createWriteFileTool();

function snapshotPolicy(policy: WorkspacePathPolicy): WorkspacePathPolicy {
  return { protectedPaths: [...(policy.protectedPaths ?? [])] };
}

async function safeUnlinkTemporary(
  resolved: ResolvedWorkspacePath,
  temporaryPath: string,
  expected: Pick<Stats, "dev" | "ino">,
): Promise<void> {
  try {
    await revalidateWorkspaceParent(resolved);
    assertSameFile(expected, await lstat(temporaryPath));
    await unlink(temporaryPath);
  } catch {
    // A changed parent is no longer safe to clean up by pathname.
  }
}

function stringArgument(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${name} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted", "AbortError");
  }
}
