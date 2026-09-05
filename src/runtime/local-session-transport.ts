import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  unlink,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, join } from "node:path";

import type { A2AMessage } from "../domain/types.js";
import { sha256, stableJson } from "../ledger/hash.js";
import {
  assertNoSymlinkComponents,
  assertRegularFile,
  ensureRealDirectory,
  openNoFollow,
} from "../ledger/file-utils.js";

/** Version of the local, filesystem-backed A2A delivery queue. */
export const LOCAL_SESSION_TRANSPORT_VERSION = 1 as const;
const QUEUE_DIRECTORY = "a2a-inbox";
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const QUEUE_FILE = /^a2a-[0-9a-f]{64}\.json$/u;
const MAX_QUEUE_BYTES = 64 * 1024;

export interface LocalSessionQueueEntry {
  readonly version: typeof LOCAL_SESSION_TRANSPORT_VERSION;
  readonly queuedAt: string;
  readonly message: A2AMessage;
}

export interface LocalSessionQueueRecord extends LocalSessionQueueEntry {
  readonly path: string;
}

export interface EnqueueLocalSessionMessageOptions {
  readonly dataDir: string;
  readonly targetRunId: string;
  readonly message: A2AMessage;
  readonly queuedAt?: string;
}

export type EnqueueLocalSessionMessageResult =
  | { readonly status: "queued"; readonly messageId: string }
  | { readonly status: "duplicate"; readonly messageId: string };

/**
 * Queue one already-authenticated local A2A message without opening the
 * target Ledger. The target process owns that Ledger's writer lock and will
 * ingest this record on its next read-only transport poll.
 */
export async function enqueueLocalSessionMessage(
  options: EnqueueLocalSessionMessageOptions,
): Promise<EnqueueLocalSessionMessageResult> {
  const targetRunId = validateRunId(options.targetRunId);
  if (options.message === null || typeof options.message !== "object" || Array.isArray(options.message)) {
    throw new TypeError("local A2A message must be an object");
  }
  if (options.message.runId !== targetRunId) {
    throw new TypeError("local A2A message runId does not match the target Run");
  }
  const queuedAt = options.queuedAt ?? new Date().toISOString();
  if (typeof queuedAt !== "string" || !Number.isFinite(Date.parse(queuedAt))) {
    throw new TypeError("local A2A queuedAt must be an ISO date");
  }
  const entry: LocalSessionQueueEntry = {
    version: LOCAL_SESSION_TRANSPORT_VERSION,
    queuedAt: new Date(Date.parse(queuedAt)).toISOString(),
    message: structuredClone(options.message),
  };
  const directory = await queueDirectory(options.dataDir, targetRunId);
  if (directory === undefined) throw new Error("local A2A queue directory is unavailable");
  const path = join(directory, queueFileName(options.message.messageId));
  await assertNoSymlinkComponents(path);
  const payload = `${stableJson(entry)}\n`;
  let handle;
  try {
    handle = await openNoFollow(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    await handle.writeFile(payload, "utf8");
    await handle.sync();
    return { status: "queued", messageId: options.message.messageId };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readQueueEntry(path, targetRunId);
    if (existing === undefined || stableJson(existing.message) !== stableJson(entry.message)) {
      throw new Error("local A2A queue message id conflicts with existing content");
    }
    return { status: "duplicate", messageId: options.message.messageId };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Read valid queue records for one Run. Invalid records are ignored safely. */
export async function readLocalSessionMessageQueue(
  dataDir: string,
  targetRunId: string,
): Promise<readonly LocalSessionQueueRecord[]> {
  const runId = validateRunId(targetRunId);
  const directory = await queueDirectory(dataDir, runId, false);
  if (directory === undefined) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const records: LocalSessionQueueRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !QUEUE_FILE.test(entry.name)) continue;
    const path = join(directory, entry.name);
    const parsed = await readQueueEntry(path, runId);
    if (parsed === undefined || queueFileName(parsed.message.messageId) !== entry.name) continue;
    records.push({ ...parsed, path });
  }
  return records.sort((left, right) => (
    left.queuedAt.localeCompare(right.queuedAt)
    || left.message.messageId.localeCompare(right.message.messageId)
  ));
}

/** Remove a record only after the target Session has durably admitted it. */
export async function removeLocalSessionMessage(record: LocalSessionQueueRecord): Promise<void> {
  try {
    const info = await lstat(record.path);
    if (!info.isFile() || info.isSymbolicLink()) return;
    await unlink(record.path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function validateRunId(value: string): string {
  if (typeof value !== "string" || !RUN_ID.test(value)) {
    throw new TypeError("local A2A target Run id is invalid");
  }
  return value;
}

async function queueDirectory(
  dataDir: string,
  runId: string,
  create = true,
): Promise<string | undefined> {
  const root = resolve(dataDir);
  const runsRoot = resolve(root, "runs");
  const runPath = resolve(runsRoot, runId);
  if (!isWithin(runsRoot, runPath)) throw new TypeError("local A2A target path escapes runs root");
  const queuePath = resolve(runPath, QUEUE_DIRECTORY);
  if (!isWithin(runPath, queuePath)) throw new TypeError("local A2A queue path escapes Run");
  await assertNoSymlinkComponents(queuePath);
  if (!create) {
    try {
      const info = await lstat(queuePath);
      if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
      return queuePath;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return undefined;
    }
  }
  return (await ensureRealDirectory(queuePath)).path;
}

async function readQueueEntry(path: string, targetRunId: string): Promise<LocalSessionQueueEntry | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_QUEUE_BYTES) return undefined;
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      await assertRegularFile(handle, path);
      const value: unknown = JSON.parse(await handle.readFile("utf8"));
      if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
      const item = value as Record<string, unknown>;
      if (item.version !== LOCAL_SESSION_TRANSPORT_VERSION
        || typeof item.queuedAt !== "string"
        || !Number.isFinite(Date.parse(item.queuedAt))
        || item.message === null
        || typeof item.message !== "object"
        || Array.isArray(item.message)) return undefined;
      const message = item.message as Partial<A2AMessage>;
      if (typeof message.messageId !== "string" || message.runId !== targetRunId) return undefined;
      return {
        version: LOCAL_SESSION_TRANSPORT_VERSION,
        queuedAt: new Date(Date.parse(item.queuedAt)).toISOString(),
        message: structuredClone(message as A2AMessage),
      };
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

function queueFileName(messageId: string): string {
  return `a2a-${sha256(messageId).replace(/^sha256:/u, "")}.json`;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (
    path !== ".."
    && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    && !isAbsolute(path)
  );
}
