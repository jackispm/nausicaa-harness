import { constants } from "node:fs";
import { unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";

import type { AgentTool, ToolExecutionContext, ToolResult } from "../domain/ports.js";
import type { MoweToolMetadata } from "../mowe/types.js";
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  normalizeToLf,
  restoreLineEndings,
  stripBom,
  type Edit,
} from "./edit-diff.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import {
  assertSameFile,
  openNoFollow,
  resolveExistingWorkspacePath,
  resolveWorkspaceWritePath,
  revalidateExistingWorkspacePath,
  revalidateWorkspaceParent,
  syncDirectory,
  type ResolvedWorkspacePath,
  type WorkspacePathPolicy,
} from "./workspace-path.js";
import { writeResolvedWorkspaceFile } from "./workspace-write.js";

/*
 * The envelope mirrors OpenAI Codex CLI 0.151.0 (Apache-2.0): its
 * apply-patch grammar is a small, useful boundary for Add/Update/Delete.
 * Pi/Prime Agent 0.7.2 (MIT) already supplies the single-file edit semantics
 * used below, so this remains a thin multi-file envelope adapter.
 * Codex's shell, approval, and filesystem adapters are intentionally not
 * imported; Nausicaa supplies its own guarded workspace and writer seams.
 */

const MAX_PATCH_BYTES = 4 * 1024 * 1024;
const MAX_PATCH_FILES = 64;
const MAX_PATCH_HUNKS = 256;
const MAX_PATCH_PATH_LENGTH = 16 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;

export const APPLY_PATCH_MOWE_METADATA: MoweToolMetadata = Object.freeze({
  effect: "write",
  deterministic: false,
  supportsBatch: false,
  concurrencySafe: false,
  scope: "workspace",
  inputKinds: ["text"] as const,
  outputKinds: ["json", "text"] as const,
});

type OperationKind = "add" | "update" | "delete";

interface ParsedOperation {
  readonly kind: OperationKind;
  readonly path: string;
  readonly edits?: readonly ParsedHunk[];
  readonly appendTexts?: readonly string[];
  readonly content?: string;
}

interface ParsedHunk extends Edit {
  readonly context?: string;
}

interface PlannedOperation {
  readonly kind: OperationKind;
  readonly path: string;
  readonly resolved: ResolvedWorkspacePath;
  readonly bytes?: Uint8Array;
  readonly originalStat?: Stats;
}

export function createApplyPatchTool(policy: WorkspacePathPolicy = {}): AgentTool {
  const pathPolicy = { protectedPaths: [...(policy.protectedPaths ?? [])] };
  const tool: AgentTool = {
    definition: {
      name: "apply_patch",
      description: [
        "Apply a structured Codex-style patch to workspace files.",
        "Supports Add File, Update File with @@ hunks, and Delete File.",
        "The complete patch is parsed and preflighted before any mutation starts.",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          patch: { type: "string", description: "*** Begin Patch ... *** End Patch" },
        },
        required: ["patch"],
        additionalProperties: false,
      },
    },
    async execute(arguments_, context): Promise<ToolResult> {
      try {
        throwIfAborted(context.signal);
        const patch = requiredString(arguments_.patch, "patch");
        if (Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES) {
          throw new RangeError(`patch exceeds the ${MAX_PATCH_BYTES}-byte limit`);
        }
        const operations = parsePatch(patch, context.signal);
        throwIfAborted(context.signal);
        const plan = await preflight(operations, context, pathPolicy);
        throwIfAborted(context.signal);
        const changes: Array<{ path: string; operation: OperationKind; byteLength: number }> = [];
        for (const operation of plan) {
          try {
            throwIfAborted(context.signal);
            const change = await commitOperation(operation, context);
            changes.push(change);
          } catch (error: unknown) {
            return failure({
              ok: false,
              status: changes.length === 0 ? "failed" : "partial",
              atomic: false,
              error: error instanceof Error ? error.message : "Patch application failed",
              applied: changes,
              appliedCount: changes.length,
              appliedBytes: changes.reduce((total, change) => total + change.byteLength, 0),
              failedPath: operation.path,
            });
          }
        }
        return success({ ok: true, status: "applied", atomic: false, changes });
      } catch (error: unknown) {
        return failure({
          ok: false,
          status: "failed",
          atomic: false,
          error: error instanceof Error ? error.message : "Patch application failed",
        });
      }
    },
  };
  return Object.freeze({ ...tool, metadata: APPLY_PATCH_MOWE_METADATA });
}

export const applyPatchTool = createApplyPatchTool();

function parsePatch(source: string, signal?: AbortSignal): ParsedOperation[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0] !== "*** Begin Patch") {
    throw new SyntaxError("patch must start with *** Begin Patch");
  }
  if (lines.length < 2) {
    throw new SyntaxError("patch must end with *** End Patch");
  }
  const hasTrailingNewline = lines.at(-1) === "";
  const endIndex = hasTrailingNewline ? lines.length - 2 : lines.length - 1;
  if (lines[endIndex] !== "*** End Patch") {
    throw new SyntaxError("patch must end with *** End Patch");
  }

  const operations: ParsedOperation[] = [];
  const seenPaths = new Set<string>();
  let totalHunks = 0;
  let index = 1;
  while (index < endIndex) {
    throwIfAborted(signal);
    const header = lines[index] ?? "";
    const add = /^\*\*\* Add File: (.+)$/.exec(header);
    const update = /^\*\*\* Update File: (.+)$/.exec(header);
    const del = /^\*\*\* Delete File: (.+)$/.exec(header);
    if (add === null && update === null && del === null) {
      throw new SyntaxError(`Malformed patch header at line ${index + 1}`);
    }
    const path = (add?.[1] ?? update?.[1] ?? del?.[1] ?? "");
    if (path.length === 0 || path.includes("\0")) {
      throw new SyntaxError(`Invalid patch path at line ${index + 1}`);
    }
    if (path.length > MAX_PATCH_PATH_LENGTH) {
      throw new RangeError(`Patch path exceeds the ${MAX_PATCH_PATH_LENGTH}-character limit at line ${index + 1}`);
    }
    if (seenPaths.has(path)) {
      throw new SyntaxError(`Duplicate patch path: ${path}`);
    }
    seenPaths.add(path);
    if (operations.length >= MAX_PATCH_FILES) {
      throw new RangeError(`patch exceeds the ${MAX_PATCH_FILES}-file limit`);
    }
    index += 1;
    if (add !== null) {
      const body: string[] = [];
      while (index < endIndex && !isOperationHeader(lines[index] ?? "")) {
        throwIfAborted(signal);
        const line = lines[index] ?? "";
        if (!line.startsWith("+")) {
          throw new SyntaxError(`Add File content must use + lines at line ${index + 1}`);
        }
        body.push(line.slice(1));
        index += 1;
      }
      if (body.length === 0) {
        throw new SyntaxError(`Add File ${path} must contain at least one + line`);
      }
      const content = `${body.join("\n")}\n`;
      operations.push({ kind: "add", path, content });
      continue;
    }
    if (del !== null) {
      if (index < endIndex && !isOperationHeader(lines[index] ?? "")) {
        throw new SyntaxError(`Delete File must not contain content at line ${index + 1}`);
      }
      operations.push({ kind: "delete", path });
      continue;
    }

    const edits: ParsedHunk[] = [];
    const appendTexts: string[] = [];
    let sawAppend = false;
    while (index < endIndex && !isOperationHeader(lines[index] ?? "")) {
      throwIfAborted(signal);
      const marker = lines[index] ?? "";
      if (!/^@@(?: |$)/.test(marker)) {
        throw new SyntaxError(`Update File requires @@ hunk headers at line ${index + 1}`);
      }
      const context = marker.startsWith("@@ ") ? marker.slice(3) : undefined;
      totalHunks += 1;
      if (totalHunks > MAX_PATCH_HUNKS) {
        throw new RangeError(`patch exceeds the ${MAX_PATCH_HUNKS}-hunk limit`);
      }
      index += 1;
      const oldLines: string[] = [];
      const newLines: string[] = [];
      let changed = false;
      while (index < endIndex && !lines[index]!.startsWith("@@") && !isOperationHeader(lines[index] ?? "")) {
        throwIfAborted(signal);
        const line = lines[index] ?? "";
        if (line === "*** End of File") {
          index += 1;
          continue;
        }
        if (line === "") {
          oldLines.push("");
          newLines.push("");
          index += 1;
          continue;
        }
        const prefix = line[0];
        if (prefix !== " " && prefix !== "+" && prefix !== "-") {
          throw new SyntaxError(`Malformed hunk line at line ${index + 1}`);
        }
        const text = line.slice(1);
        if (prefix === " " || prefix === "-") oldLines.push(text);
        if (prefix === " " || prefix === "+") newLines.push(text);
        if (prefix !== " ") changed = true;
        index += 1;
      }
      if (!changed) {
        throw new SyntaxError(`Hunk in ${path} must contain a change`);
      }
      if (oldLines.length === 0) {
        if (newLines.length === 0) throw new SyntaxError(`Hunk in ${path} must contain a change`);
        if (context !== undefined) {
          edits.push({
            oldText: context,
            newText: `${context}\n${newLines.join("\n")}`,
            context,
          });
        } else {
          if (sawAppend) throw new SyntaxError(`EOF insertion hunk in ${path} must be last`);
          sawAppend = true;
          appendTexts.push(newLines.join("\n"));
        }
        continue;
      }
      edits.push({
        oldText: newLines.length === 0 ? `${oldLines.join("\n")}\n` : oldLines.join("\n"),
        newText: newLines.join("\n"),
        ...(context === undefined ? {} : { context }),
      });
    }
    if (edits.length === 0 && appendTexts.length === 0) throw new SyntaxError(`Update File ${path} has no hunks`);
    operations.push({ kind: "update", path, edits, appendTexts });
  }
  if (operations.length === 0) throw new SyntaxError("Patch contains no file operations");
  return operations;
}

function isOperationHeader(line: string): boolean {
  return /^\*\*\* (?:Add|Update|Delete) File: /.test(line);
}

async function preflight(
  operations: readonly ParsedOperation[],
  context: ToolExecutionContext,
  policy: WorkspacePathPolicy,
): Promise<PlannedOperation[]> {
  const plan: PlannedOperation[] = [];
  const seenResolved = new Set<string>();
  let totalOutputBytes = 0;
  for (const operation of operations) {
    throwIfAborted(context.signal);
    if (operation.kind === "add") {
      const resolved = await resolveWorkspaceWritePath(context.workspace, operation.path, policy);
      if (seenResolved.has(resolved.relative)) throw new SyntaxError(`Duplicate patch path: ${resolved.relative}`);
      seenResolved.add(resolved.relative);
      const bytes = Buffer.from(operation.content ?? "", "utf8");
      if (bytes.byteLength > MAX_FILE_BYTES) throw new RangeError(`File exceeds the ${MAX_FILE_BYTES}-byte limit: ${resolved.relative}`);
      totalOutputBytes += bytes.byteLength;
      if (totalOutputBytes > MAX_TOTAL_OUTPUT_BYTES) throw new RangeError(`Patch output exceeds the ${MAX_TOTAL_OUTPUT_BYTES}-byte aggregate limit`);
      plan.push({ kind: "add", path: resolved.relative, resolved, bytes });
      continue;
    }
    const resolved = await resolveExistingWorkspacePath(context.workspace, operation.path, policy);
    if (seenResolved.has(resolved.relative)) throw new SyntaxError(`Duplicate patch path: ${resolved.relative}`);
    seenResolved.add(resolved.relative);
    const originalStat = await revalidateExistingWorkspacePath(resolved);
    if (operation.kind === "delete") {
      if (!originalStat.isFile() || originalStat.nlink !== 1) throw new Error("Only private regular files can be deleted");
      plan.push({ kind: "delete", path: resolved.relative, resolved, originalStat });
      continue;
    }
    if (!originalStat.isFile() || originalStat.nlink !== 1) throw new Error("Only private regular files can be updated");
    if (originalStat.size > MAX_FILE_BYTES) throw new RangeError(`File exceeds the ${MAX_FILE_BYTES}-byte edit limit: ${resolved.relative}`);
    const handle = await openNoFollow(resolved.absolute, constants.O_RDONLY);
    let rawContent: string;
    try {
      assertSameFile(originalStat, await handle.stat());
      rawContent = (await handle.readFile({ signal: context.signal })).toString("utf8");
    } finally {
      await handle.close();
    }
    assertSameFile(originalStat, await revalidateExistingWorkspacePath(resolved));
    const { bom, text } = stripBom(rawContent);
    const normalized = normalizeToLf(text);
    const edits = (operation.edits ?? []).map((edit) => {
      const oldText = edit.context === undefined
        ? edit.oldText
        : `${edit.context}\n${edit.oldText}`;
      const adjustedOldText = oldText.endsWith("\n") && !normalized.endsWith("\n")
        && normalized.includes(oldText.slice(0, -1))
        ? oldText.slice(0, -1)
        : oldText;
      return {
      oldText: adjustedOldText,
      newText: edit.context === undefined
        ? edit.newText
        : `${edit.context}${edit.newText.length === 0 ? "" : `\n${edit.newText}`}`,
      };
    });
    const applied = edits.length
      ? applyEditsToNormalizedContent(normalized, edits, resolved.relative)
      : { baseContent: normalized, newContent: normalized };
    let newContent = applied.newContent;
    for (const appendText of operation.appendTexts ?? []) {
      newContent += `${newContent.length > 0 && !newContent.endsWith("\n") ? "\n" : ""}${appendText}\n`;
    }
    const ending = detectLineEnding(text);
    const bytes = Buffer.from(bom + restoreLineEndings(newContent, ending), "utf8");
    if (bytes.byteLength > MAX_FILE_BYTES) throw new RangeError(`Edited file exceeds the ${MAX_FILE_BYTES}-byte write limit: ${resolved.relative}`);
    totalOutputBytes += bytes.byteLength;
    if (totalOutputBytes > MAX_TOTAL_OUTPUT_BYTES) throw new RangeError(`Patch output exceeds the ${MAX_TOTAL_OUTPUT_BYTES}-byte aggregate limit`);
    plan.push({ kind: "update", path: resolved.relative, resolved, bytes, originalStat });
  }
  return plan;
}

async function commitOperation(
  operation: PlannedOperation,
  context: ToolExecutionContext,
): Promise<{ path: string; operation: OperationKind; byteLength: number }> {
  return await withFileMutationQueue(operation.resolved.absolute, async () => {
    throwIfAborted(context.signal);
    if (operation.kind === "delete") {
      const current = await revalidateExistingWorkspacePath(operation.resolved);
      assertSameFile(operation.originalStat!, current);
      await revalidateWorkspaceParent(operation.resolved);
      await unlink(operation.resolved.absolute);
      await syncDirectory(path.dirname(operation.resolved.absolute));
      return { path: operation.path, operation: operation.kind, byteLength: 0 };
    }
    if (operation.kind === "update") {
      assertSameFile(operation.originalStat!, await revalidateExistingWorkspacePath(operation.resolved));
    }
    const result = await writeResolvedWorkspaceFile(operation.resolved, operation.bytes!, context.signal, operation.originalStat === undefined ? {} : { mode: operation.originalStat.mode });
    return { path: operation.path, operation: operation.kind, byteLength: result.byteLength };
  });
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
  }
}

function success(value: unknown): ToolResult {
  const content = JSON.stringify(value);
  if (Buffer.byteLength(content, "utf8") > MAX_OUTPUT_BYTES) {
    if (isPatchResult(value)) {
      return {
        content: JSON.stringify({
          ok: true,
          status: "applied",
          atomic: false,
          changeCount: value.changes.length,
          appliedBytes: value.changes.reduce((total, change) => total + change.byteLength, 0),
          truncated: true,
        }),
        isError: false,
      };
    }
    return failure({
      ok: false,
      status: "failed",
      error: `Patch result exceeds the ${MAX_OUTPUT_BYTES}-byte output limit`,
    });
  }
  return { content, isError: false };
}

function failure(value: unknown): ToolResult {
  const content = JSON.stringify(value);
  if (Buffer.byteLength(content, "utf8") <= MAX_OUTPUT_BYTES) {
    return { content, isError: true };
  }
  if (isPatchFailure(value)) {
    return {
      content: JSON.stringify({
        ok: false,
        status: value.status,
        atomic: false,
        error: value.error,
        ...(value.failedPath === undefined ? {} : { failedPath: value.failedPath }),
        appliedCount: value.appliedCount ?? value.applied?.length ?? 0,
        appliedBytes: value.appliedBytes ?? value.applied?.reduce((total, change) => total + change.byteLength, 0) ?? 0,
        truncated: true,
      }),
      isError: true,
    };
  }
  return {
    content: JSON.stringify({
      ok: false,
      status: "failed",
      error: `Patch error output exceeds the ${MAX_OUTPUT_BYTES}-byte limit`,
    }),
    isError: true,
  };
}

function isPatchResult(value: unknown): value is {
  ok: true;
  status: "applied";
  atomic: false;
  changes: Array<{ byteLength: number }>;
} {
  return isRecord(value)
    && value.ok === true
    && value.status === "applied"
    && Array.isArray(value.changes)
    && value.changes.every((change) => isRecord(change) && typeof change.byteLength === "number");
}

function isPatchFailure(value: unknown): value is {
  ok: false;
  status: "failed" | "partial";
  error: string;
  failedPath?: string;
  appliedCount?: number;
  appliedBytes?: number;
  applied?: Array<{ byteLength: number }>;
} {
  return isRecord(value)
    && value.ok === false
    && (value.status === "failed" || value.status === "partial")
    && typeof value.error === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
