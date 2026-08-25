import { randomUUID } from "node:crypto";
import { lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import type { AgentTool, ToolResult } from "../domain/ports.js";
import { resolveWorkspaceWritePath } from "./workspace-path.js";

const HARD_MAX_BYTES = 1024 * 1024;

export const writeFileTool: AgentTool = {
  definition: {
    name: "write_file",
    description: "Atomically write one UTF-8 file inside the workspace.",
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
    try {
      throwIfAborted(context.signal);
      const requestedPath = stringArgument(arguments_.path, "path");
      const content = stringArgument(arguments_.content, "content", true);
      const bytes = Buffer.from(content, "utf8");
      if (bytes.byteLength > HARD_MAX_BYTES) {
        throw new RangeError(`content exceeds the ${HARD_MAX_BYTES}-byte write limit`);
      }

      const resolved = await resolveWorkspaceWritePath(context.workspace, requestedPath);
      temporaryPath = path.join(path.dirname(resolved.absolute), `.nausicaa-${randomUUID()}.tmp`);
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      throwIfAborted(context.signal);

      // Recheck immediately before rename so a newly inserted symlink is not
      // silently replaced after authorization.
      try {
        if ((await lstat(resolved.absolute)).isSymbolicLink()) {
          throw new Error("Refusing to replace a symbolic link");
        }
      } catch (error: unknown) {
        if (!isNotFound(error)) {
          throw error;
        }
      }
      await rename(temporaryPath, resolved.absolute);
      temporaryPath = undefined;
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
      if (temporaryPath !== undefined) {
        await unlink(temporaryPath).catch(() => undefined);
      }
    }
  },
};

function stringArgument(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${name} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return value;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted", "AbortError");
  }
}
