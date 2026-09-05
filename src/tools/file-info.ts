import { createHash } from "node:crypto";
import { constants } from "node:fs";

import type { AgentTool, ToolResult } from "../domain/ports.js";
import {
  assertSameFile,
  openNoFollow,
  resolveExistingWorkspacePath,
  revalidateExistingWorkspacePath,
  type WorkspacePathPolicy,
} from "./workspace-path.js";

/** Hashing is opt-in and bounded so metadata inspection stays cheap by default. */
const DEFAULT_MAX_HASH_BYTES = 16 * 1024 * 1024;

export interface FileInfoToolOptions extends WorkspacePathPolicy {
  /** Maximum file size accepted when the caller requests a content hash. */
  maxHashBytes?: number;
}

export interface FileInfo {
  path: string;
  type: "file" | "directory" | "other";
  byteLength?: number;
  modifiedAt: string;
  createdAt: string;
  mode: number;
  executable: boolean;
  hash?: string;
}

/**
 * Return bounded metadata for one existing workspace path.
 *
 * This is intentionally separate from read_file: agents can cheaply compare
 * timestamps, sizes and an optional content fingerprint without consuming the
 * file body as model context. Paths are resolved and revalidated with the same
 * no-follow policy as every other workspace tool.
 */
export function createFileInfoTool(options: FileInfoToolOptions = {}): AgentTool {
  const pathPolicy = snapshotPolicy(options);
  const maxHashBytes = boundedMaxHashBytes(options.maxHashBytes);
  return {
    definition: {
      name: "file_info",
      description: "Inspect workspace file metadata (type, size, timestamps, mode) and optionally compute a bounded SHA-256 fingerprint.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file or directory path" },
          hash: { type: "boolean", description: "Compute a SHA-256 fingerprint for regular files (bounded to 16 MiB by default)" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },

    async execute(arguments_, context): Promise<ToolResult> {
      try {
        throwIfAborted(context.signal);
        const requestedPath = requiredString(arguments_.path, "path");
        const hash = optionalBoolean(arguments_.hash, "hash") ?? false;
        const resolved = await resolveExistingWorkspacePath(
          context.workspace,
          requestedPath,
          pathPolicy,
        );
        const before = await revalidateExistingWorkspacePath(resolved);
        const info = metadata(resolved.relative, before);
        if (hash) {
          if (!before.isFile() || before.nlink !== 1) {
            throw new Error("hash is only supported for private regular files");
          }
          if (before.size > maxHashBytes) {
            throw new Error(`File exceeds the ${maxHashBytes}-byte hash limit`);
          }
          info.hash = await hashFile(resolved.absolute, before.size, resolved, context.signal);
        }
        assertSameFile(before, await revalidateExistingWorkspacePath(resolved));
        return success(info);
      } catch (error: unknown) {
        return failure(error instanceof Error ? error.message : "File metadata inspection failed");
      }
    },
  };
}

export const fileInfoTool: AgentTool = createFileInfoTool();

function metadata(
  relativePath: string,
  stats: { isFile(): boolean; isDirectory(): boolean; size: number; mtime: Date; birthtime: Date; mode: number },
): FileInfo {
  const type = stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "other";
  return {
    path: relativePath,
    type,
    ...(stats.isFile() ? { byteLength: stats.size } : {}),
    modifiedAt: stats.mtime.toISOString(),
    createdAt: stats.birthtime.toISOString(),
    mode: stats.mode & 0o777,
    executable: (stats.mode & 0o111) !== 0,
  };
}

async function hashFile(
  absolutePath: string,
  expectedSize: number,
  resolved: Awaited<ReturnType<typeof resolveExistingWorkspacePath>>,
  signal: AbortSignal | undefined,
): Promise<string> {
  const handle = await openNoFollow(absolutePath, constants.O_RDONLY);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== expectedSize) {
      throw new Error("File changed while hashing");
    }
    assertSameFile(opened, await revalidateExistingWorkspacePath(resolved));
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    let total = 0;
    while (total < expectedSize) {
      throwIfAborted(signal);
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, expectedSize - total), position);
      if (bytesRead === 0) throw new Error("File changed while hashing");
      digest.update(buffer.subarray(0, bytesRead));
      total += bytesRead;
      position += bytesRead;
    }
    // Reading exactly the initial size is not enough: an in-place writer can
    // append or truncate while the loop is running, leaving a valid hash of a
    // stale prefix.  Check the open handle after the final read as well as the
    // path identity before publishing the digest.
    const finished = await handle.stat();
    if (!finished.isFile() || finished.nlink !== 1 || finished.size !== expectedSize) {
      throw new Error("File changed while hashing");
    }
    assertSameFile(opened, finished);
    const current = await revalidateExistingWorkspacePath(resolved);
    if (!current.isFile() || current.nlink !== 1 || current.size !== expectedSize) {
      throw new Error("File changed while hashing");
    }
    assertSameFile(opened, current);
    // Probe one byte past the expected end.  This closes the common append
    // race where the size changed just before the fstat above.
    const probe = await handle.read(buffer, 0, 1, expectedSize);
    if (probe.bytesRead !== 0) throw new Error("File changed while hashing");
    const settled = await handle.stat();
    if (!settled.isFile() || settled.nlink !== 1 || settled.size !== expectedSize) {
      throw new Error("File changed while hashing");
    }
    assertSameFile(opened, settled);
    const finalPath = await revalidateExistingWorkspacePath(resolved);
    if (!finalPath.isFile() || finalPath.nlink !== 1 || finalPath.size !== expectedSize) {
      throw new Error("File changed while hashing");
    }
    assertSameFile(opened, finalPath);
    return `sha256:${digest.digest("hex")}`;
  } finally {
    await handle.close();
  }
}

function snapshotPolicy(options: FileInfoToolOptions): WorkspacePathPolicy {
  return { protectedPaths: [...(options.protectedPaths ?? [])] };
}

function boundedMaxHashBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_HASH_BYTES;
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_MAX_HASH_BYTES) {
    throw new RangeError(`maxHashBytes must be an integer between 1 and ${DEFAULT_MAX_HASH_BYTES}`);
  }
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
  return value;
}

function success(value: unknown): ToolResult {
  return { content: JSON.stringify(value), isError: false };
}

function failure(message: string): ToolResult {
  return { content: JSON.stringify({ error: message }), isError: true };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}
