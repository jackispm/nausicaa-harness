import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, rename, unlink } from "node:fs/promises";
import path from "node:path";

import {
  assertSameFile,
  openNoFollow,
  type ResolvedWorkspacePath,
  revalidateWorkspaceParent,
  revalidateWorkspaceWritePath,
  syncDirectory,
} from "./workspace-path.js";

export interface WorkspaceWriteResult {
  path: string;
  byteLength: number;
  atomic: true;
}

export async function writeResolvedWorkspaceFile(
  resolved: ResolvedWorkspacePath,
  bytes: Uint8Array,
  signal?: AbortSignal,
  options: { mode?: number } = {},
): Promise<WorkspaceWriteResult> {
  const temporaryPath = path.join(
    path.dirname(resolved.absolute),
    `.nausicaa-${randomUUID()}.tmp`,
  );
  let temporaryStat: Stats | undefined;
  try {
    throwIfAborted(signal);
    await revalidateWorkspaceParent(resolved);
    const handle = await openNoFollow(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      options.mode ?? 0o600,
    );
    try {
      temporaryStat = await handle.stat();
      if (!temporaryStat.isFile() || temporaryStat.nlink !== 1) {
        throw new Error("Temporary path is not a private regular file");
      }
      await revalidateWorkspaceParent(resolved);
      assertSameFile(temporaryStat, await lstat(temporaryPath));
      await handle.writeFile(bytes);
      if (options.mode !== undefined) {
        await handle.chmod(options.mode & 0o777);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    throwIfAborted(signal);

    await revalidateWorkspaceParent(resolved);
    assertSameFile(temporaryStat, await lstat(temporaryPath));
    await revalidateWorkspaceWritePath(resolved);
    await rename(temporaryPath, resolved.absolute);
    temporaryStat = undefined;
    await revalidateWorkspaceParent(resolved);
    await revalidateWorkspaceWritePath(resolved);
    await syncDirectory(path.dirname(resolved.absolute));
    return { path: resolved.relative, byteLength: bytes.byteLength, atomic: true };
  } finally {
    if (temporaryStat !== undefined) {
      await safeUnlinkTemporary(resolved, temporaryPath, temporaryStat);
    }
  }
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted", "AbortError");
  }
}
