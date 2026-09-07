import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { normalizeModelSelector } from "../model/index.js";
import type { Settings } from "./settings.js";
import { loadSettings, readSettingsFile } from "./settings.js";

const SETTINGS_FILE_MODE = 0o600;
const SETTINGS_DIRECTORY_MODE = 0o700;
const SETTINGS_LOCK_TIMEOUT_MS = 2_000;
const SETTINGS_STALE_LOCK_MS = 30_000;
const SETTINGS_LOCK_RETRY_MS = 20;

const settingsWriteChains = new Map<string, Promise<void>>();

export interface UserSettingsOptions {
  userHome?: string;
  filePath?: string;
}

/** Absolute path of the user-level settings file used by Nausicaa. */
export function userSettingsPath(options: UserSettingsOptions = {}): string {
  return options.filePath
    ?? join(options.userHome ?? homedir(), ".nausicaa", "settings.json");
}

/**
 * Persist one model default explicitly. Session `/model` changes remain
 * ephemeral; this command is the deliberate global-default operation.
 */
export async function saveUserModel(
  model: string,
  options: UserSettingsOptions = {},
): Promise<{ path: string; model: string }> {
  const normalized = normalizeModelSelector(model);
  const path = await updateUserSettings((existing) => ({ ...existing, model: normalized }), options);
  return { path, model: normalized };
}

/** Serialize validated host-side settings changes through the existing private file lock. */
export async function updateUserSettings(
  update: (existing: Settings) => Settings,
  options: UserSettingsOptions = {},
): Promise<string> {
  const path = userSettingsPath(options);
  const previous = settingsWriteChains.get(path) ?? Promise.resolve();
  const operation = previous.then(async () => withSettingsFileLock(path, async () => {
    // Read after acquiring the lock so concurrent invocations preserve all
    // user settings rather than overwriting a newer document.
    const existing = options.filePath === undefined
      ? await loadSettings(resolve(dirname(path)), {
          userHome: options.userHome ?? dirname(dirname(path)),
        })
      : await readSettingsFile(path);
    const next = update(existing);
    await writeSettingsFile(path, next);
  }));
  const tail = operation.then(() => undefined, () => undefined);
  settingsWriteChains.set(path, tail);
  void tail.then(() => {
    if (settingsWriteChains.get(path) === tail) settingsWriteChains.delete(path);
  });
  await operation;
  return path;
}

/** Read the validated user settings without trusting workspace configuration. */
export async function readUserSettings(
  options: UserSettingsOptions = {},
): Promise<Settings> {
  const path = userSettingsPath(options);
  return options.filePath === undefined
    ? loadSettings(resolve(dirname(path)), {
        userHome: options.userHome ?? dirname(dirname(path)),
      })
    : readSettingsFile(path);
}

async function writeSettingsFile(path: string, settings: Settings): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: SETTINGS_DIRECTORY_MODE });
  await chmod(parent, SETTINGS_DIRECTORY_MODE);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      SETTINGS_FILE_MODE,
    );
    await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await chmod(path, SETTINGS_FILE_MODE);
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw new Error(`Cannot write user settings at ${path}`, { cause: error });
  }
}

async function withSettingsFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const parent = dirname(path);
  await ensureSettingsDirectory(parent);
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + SETTINGS_LOCK_TIMEOUT_MS;
  let lock: FileHandle | undefined;
  while (lock === undefined) {
    try {
      lock = await open(
        lockPath,
        // O_EXCL makes an existing lock (including a symlink) fail closed.
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        SETTINGS_FILE_MODE,
      );
      await lock.writeFile(`${process.pid}\n`, "utf8");
    } catch (error: unknown) {
      await lock?.close().catch(() => undefined);
      lock = undefined;
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw new Error(`Cannot acquire user settings lock at ${lockPath}`, { cause: error });
      }
      if (await settingsLockIsStale(lockPath)) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`User settings are busy: ${path}`);
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, SETTINGS_LOCK_RETRY_MS));
    }
  }
  try {
    return await operation();
  } finally {
    await lock.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

async function ensureSettingsDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: SETTINGS_DIRECTORY_MODE });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`User settings directory is not a directory: ${path}`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`User settings directory is not owned by the current user: ${path}`);
  }
  if ((info.mode & 0o077) !== 0) await chmod(path, SETTINGS_DIRECTORY_MODE);
}

async function settingsLockIsStale(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return Date.now() - info.mtimeMs > SETTINGS_STALE_LOCK_MS;
  } catch {
    return false;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
