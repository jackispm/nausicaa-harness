import { constants } from "node:fs";
import type { Stats } from "node:fs";

import type { AgentTool, ToolResult } from "../domain/ports.js";
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  type Edit,
  generateDiffString,
  normalizeToLf,
  restoreLineEndings,
  stripBom,
} from "./edit-diff.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import {
  assertSameFile,
  openNoFollow,
  resolveExistingWorkspacePath,
  revalidateExistingWorkspacePath,
  type WorkspacePathPolicy,
} from "./workspace-path.js";
import { writeResolvedWorkspaceFile } from "./workspace-write.js";

const HARD_MAX_BYTES = 1024 * 1024;

export function createEditFileTool(policy: WorkspacePathPolicy = {}): AgentTool {
  const pathPolicy = snapshotPolicy(policy);
  return {
    definition: {
      name: "edit",
      description: [
        "Edit one workspace file with exact text replacement.",
        "Every edits[].oldText must uniquely match the original file and edits must not overlap.",
        "Put multiple disjoint replacements in one call.",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path" },
          edits: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                oldText: { type: "string", description: "Unique text to replace" },
                newText: { type: "string", description: "Replacement text" },
              },
              required: ["oldText", "newText"],
              additionalProperties: false,
            },
          },
        },
        required: ["path", "edits"],
        additionalProperties: false,
      },
    },

    async execute(arguments_, context): Promise<ToolResult> {
      try {
        throwIfAborted(context.signal);
        const requestedPath = stringArgument(arguments_.path, "path");
        const edits = editArguments(arguments_.edits);
        const resolved = await resolveExistingWorkspacePath(
          context.workspace,
          requestedPath,
          pathPolicy,
        );

        return await withFileMutationQueue(resolved.absolute, async () => {
          const handle = await openNoFollow(resolved.absolute, constants.O_RDONLY);
          let rawContent: string;
          let originalStat: Stats;
          try {
            originalStat = await handle.stat();
            if (!originalStat.isFile() || originalStat.nlink !== 1) {
              throw new Error("Path is not a private regular file");
            }
            if (originalStat.size > HARD_MAX_BYTES) {
              throw new Error(`File exceeds the ${HARD_MAX_BYTES}-byte edit limit`);
            }
            assertSameFile(originalStat, await revalidateExistingWorkspacePath(resolved));
            rawContent = (await handle.readFile()).toString("utf8");
          } finally {
            await handle.close();
          }
          throwIfAborted(context.signal);
          assertSameFile(originalStat, await revalidateExistingWorkspacePath(resolved));

          const { bom, text } = stripBom(rawContent);
          const ending = detectLineEnding(text);
          const normalized = normalizeToLf(text);
          const applied = applyEditsToNormalizedContent(normalized, edits, resolved.relative);
          const finalContent = bom + restoreLineEndings(applied.newContent, ending);
          const bytes = Buffer.from(finalContent, "utf8");
          if (bytes.byteLength > HARD_MAX_BYTES) {
            throw new Error(`Edited file exceeds the ${HARD_MAX_BYTES}-byte write limit`);
          }

          const written = await writeResolvedWorkspaceFile(
            resolved,
            bytes,
            context.signal,
            { mode: originalStat.mode },
          );
          const diff = generateDiffString(applied.baseContent, applied.newContent);
          return success({
            ...written,
            replacements: edits.length,
            diff: diff.diff,
            ...(diff.firstChangedLine === undefined
              ? {}
              : { firstChangedLine: diff.firstChangedLine }),
          });
        });
      } catch (error: unknown) {
        return failure(error instanceof Error ? error.message : "File edit failed");
      }
    },
  };
}

export const editFileTool: AgentTool = createEditFileTool();

function editArguments(value: unknown): Edit[] {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      throw new TypeError("edits must be an array");
    }
  }
  if (!Array.isArray(candidate) || candidate.length === 0) {
    throw new TypeError("edits must contain at least one replacement");
  }
  return candidate.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(`edits[${index}] must be an object`);
    }
    const values = entry as Record<string, unknown>;
    if (typeof values.oldText !== "string" || typeof values.newText !== "string") {
      throw new TypeError(`edits[${index}] requires string oldText and newText`);
    }
    return { oldText: values.oldText, newText: values.newText };
  });
}

function snapshotPolicy(policy: WorkspacePathPolicy): WorkspacePathPolicy {
  return { protectedPaths: [...(policy.protectedPaths ?? [])] };
}

function stringArgument(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
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
