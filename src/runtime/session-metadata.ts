import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  assertNoSymlinkComponents,
  assertRealDirectory,
  assertRegularFile,
  openNoFollow,
  syncDirectory,
} from "../ledger/file-utils.js";

export function normalizeSessionName(name: string): string {
  if (typeof name !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) {
    throw new TypeError("Session name must not contain control characters");
  }
  const normalized = name.trim();
  if (normalized.length === 0 || normalized.length > 160) {
    throw new RangeError("Session name must contain between 1 and 160 characters");
  }
  return normalized;
}

function metadataPath(dataDir: string, runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) {
    throw new TypeError("Run id contains unsupported characters");
  }
  return resolve(dataDir, "runs", runId, "title.json");
}

export async function readSessionName(dataDir: string, runId: string): Promise<string | undefined> {
  const path = metadataPath(dataDir, runId);
  await assertNoSymlinkComponents(path);
  let handle;
  try {
    handle = await openNoFollow(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    await assertRegularFile(handle, path, true);
    if ((await handle.stat()).size > 4_096) throw new RangeError("Session metadata is too large");
    const value: unknown = JSON.parse(await handle.readFile("utf8"));
    if (value === null || typeof value !== "object"
      || (value as { version?: unknown }).version !== 1
      || typeof (value as { name?: unknown }).name !== "string") {
      throw new TypeError("Invalid session metadata");
    }
    return normalizeSessionName((value as { name: string }).name);
  } finally {
    await handle.close();
  }
}

export async function writeSessionName(dataDir: string, runId: string, name: string): Promise<string> {
  const normalized = normalizeSessionName(name);
  const path = metadataPath(dataDir, runId);
  const directory = await assertRealDirectory(resolve(dataDir, "runs", runId));
  await assertNoSymlinkComponents(path);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new TypeError("Session metadata is not a private regular file");
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(directory, `.title-${randomUUID()}.tmp`);
  const handle = await openNoFollow(
    temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600,
  );
  try {
    try {
      await handle.writeFile(`${JSON.stringify({ version: 1, name: normalized })}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertNoSymlinkComponents(path);
    await rename(temporary, path);
    await syncDirectory(directory);
  } catch (error: unknown) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return normalized;
}
