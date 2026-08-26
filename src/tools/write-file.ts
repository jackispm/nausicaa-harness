import type { AgentTool, ToolResult } from "../domain/ports.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { resolveWorkspaceWritePath, type WorkspacePathPolicy } from "./workspace-path.js";
import { writeResolvedWorkspaceFile } from "./workspace-write.js";

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
    try {
      throwIfAborted(context.signal);
      const requestedPath = stringArgument(arguments_.path, "path");
      const content = stringArgument(arguments_.content, "content", true);
      const bytes = Buffer.from(content, "utf8");
      if (bytes.byteLength > HARD_MAX_BYTES) {
        throw new RangeError(`content exceeds the ${HARD_MAX_BYTES}-byte write limit`);
      }

      const resolved = await resolveWorkspaceWritePath(
        context.workspace,
        requestedPath,
        pathPolicy,
      );
      const result = await withFileMutationQueue(resolved.absolute, () =>
        writeResolvedWorkspaceFile(resolved, bytes, context.signal));
      return {
        content: JSON.stringify(result),
        isError: false,
      };
    } catch (error: unknown) {
      return {
        content: JSON.stringify({
          error: error instanceof Error ? error.message : "File write failed",
        }),
        isError: true,
      };
    }
  },
  };
}

export const writeFileTool: AgentTool = createWriteFileTool();

function snapshotPolicy(policy: WorkspacePathPolicy): WorkspacePathPolicy {
  return { protectedPaths: [...(policy.protectedPaths ?? [])] };
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
