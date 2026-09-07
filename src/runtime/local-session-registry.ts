import { randomUUID } from "node:crypto";
import {
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
  lstat,
  realpath,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import type { Clock } from "../domain/ports.js";
import { systemClock } from "../domain/ports.js";
import { RUNTIME_BUILD_ID } from "./build-identity.js";
import {
  assertNoSymlinkComponents,
  ensureRealDirectory,
} from "../ledger/file-utils.js";

/** Versioned, host-owned presence state. It is not a conversation fact. */
export const LOCAL_SESSION_REGISTRY_VERSION = 1 as const;
export const DEFAULT_LOCAL_SESSION_HEARTBEAT_MS = 2_000;
export const DEFAULT_LOCAL_SESSION_STALE_MS = 10_000;

export type LocalSessionState =
  | "starting"
  | "active"
  | "waiting"
  | "idle"
  | "sleeping"
  | "offline"
  | "terminal";

export interface LocalSessionRegistryEntry {
  readonly version: typeof LOCAL_SESSION_REGISTRY_VERSION;
  readonly sessionId: string;
  readonly workspace: string;
  readonly runId?: string;
  readonly laneId: string;
  readonly state: LocalSessionState;
  readonly startedAt: string;
  readonly lastSeen: string;
  /** Identity of the code loaded by this process; absent for legacy/source-mode hosts. */
  readonly runtimeBuildId?: string;
  readonly activitySummary?: string;
}

export interface LocalSessionObservation extends LocalSessionRegistryEntry {
  /** True when the heartbeat is within the configured stale window. */
  readonly live: boolean;
}

export interface LocalSessionRegistryOptions {
  readonly dataDir: string;
  readonly workspace: string;
  readonly sessionId?: string;
  readonly clock?: Clock;
  readonly heartbeatMs?: number;
  readonly staleMs?: number;
  readonly runtimeBuildId?: string;
}

export interface LocalSessionPresenceUpdate {
  /** `null` clears the currently attached Run. */
  readonly runId?: string | null;
  readonly laneId?: string;
  readonly state?: LocalSessionState;
  readonly activitySummary?: string;
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_SUMMARY_LENGTH = 256;
const MAX_REGISTRY_BYTES = 32 * 1024;

/**
 * Restart-safe, per-process presence record used by local Awareness/A2A.
 * Each process owns one file, so concurrent sessions never rewrite one
 * shared JSON array. A stale file is retained for diagnostics and projected
 * as offline instead of being silently deleted.
 */
export class LocalSessionRegistry {
  readonly sessionId: string;
  readonly workspace: string;
  readonly dataDir: string;

  private readonly clock: Clock;
  private readonly heartbeatMs: number;
  private readonly staleMs: number;
  private readonly instanceToken = randomUUID();
  private readonly startedAt: string;
  private filePath: string;
  private writeTail: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private current: LocalSessionRegistryEntry;

  constructor(options: LocalSessionRegistryOptions) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("session registry options must be an object");
    }
    if (typeof options.dataDir !== "string" || options.dataDir.trim().length === 0) {
      throw new TypeError("session registry dataDir must be non-empty");
    }
    if (typeof options.workspace !== "string" || options.workspace.trim().length === 0) {
      throw new TypeError("session registry workspace must be non-empty");
    }
    const sessionId = options.sessionId ?? `session-${randomUUID()}`;
    if (!SESSION_ID.test(sessionId)) throw new TypeError("session registry sessionId is invalid");
    this.sessionId = sessionId;
    this.workspace = resolve(options.workspace);
    this.dataDir = resolve(options.dataDir);
    this.clock = options.clock ?? systemClock;
    this.heartbeatMs = boundedPositive(
      options.heartbeatMs ?? DEFAULT_LOCAL_SESSION_HEARTBEAT_MS,
      "heartbeatMs",
    );
    this.staleMs = boundedPositive(
      options.staleMs ?? DEFAULT_LOCAL_SESSION_STALE_MS,
      "staleMs",
    );
    this.startedAt = this.nowIso();
    this.filePath = join(this.dataDir, "sessions", `${this.sessionId}.json`);
    this.current = {
      version: LOCAL_SESSION_REGISTRY_VERSION,
      sessionId: this.sessionId,
      workspace: this.workspace,
      laneId: "main",
      state: "starting",
      startedAt: this.startedAt,
      lastSeen: this.startedAt,
    };
    const runtimeBuildId = options.runtimeBuildId ?? RUNTIME_BUILD_ID;
    if (runtimeBuildId !== undefined) {
      if (!validRuntimeBuildId(runtimeBuildId)) throw new TypeError("session registry runtimeBuildId is invalid");
      this.current = { ...this.current, runtimeBuildId };
    }
  }

  async start(update: LocalSessionPresenceUpdate = {}): Promise<void> {
    if (this.closed) throw new Error("session registry is closed");
    await this.update(update);
    this.timer = setInterval(() => {
      void this.update({}).catch(() => undefined);
    }, this.heartbeatMs);
    this.timer.unref?.();
  }

  async update(update: LocalSessionPresenceUpdate): Promise<void> {
    if (this.closed) return;
    if (update === null || typeof update !== "object" || Array.isArray(update)) {
      throw new TypeError("session presence update must be an object");
    }
    const nextRunId = update.runId === null
      ? undefined
      : update.runId === undefined
        ? this.current.runId
        : boundedLabel(update.runId, "runId");
    const nextSummary = update.activitySummary === undefined
      ? this.current.activitySummary
      : boundedSummary(update.activitySummary);
    const next: LocalSessionRegistryEntry = {
      version: LOCAL_SESSION_REGISTRY_VERSION,
      sessionId: this.sessionId,
      workspace: this.workspace,
      laneId: update.laneId === undefined
        ? this.current.laneId
        : boundedLabel(update.laneId, "laneId"),
      state: update.state === undefined ? this.current.state : validateState(update.state),
      startedAt: this.current.startedAt,
      lastSeen: this.nowIso(),
      ...(this.current.runtimeBuildId === undefined ? {} : { runtimeBuildId: this.current.runtimeBuildId }),
      ...(nextRunId === undefined ? {} : { runId: nextRunId }),
      ...(nextSummary === undefined ? {} : { activitySummary: nextSummary }),
    };
    this.current = next;
    await this.enqueueWrite(next);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.writeTail.catch(() => undefined);
    try {
      const contents = await readFile(this.filePath, "utf8");
      const parsed = parseRegistryRecord(JSON.parse(contents));
      if (parsed?.instanceToken === this.instanceToken) await unlink(this.filePath);
    } catch {
      // Presence is advisory; a stale record is safe and will age out.
    }
  }

  async list(): Promise<readonly LocalSessionObservation[]> {
    return readLocalSessionRegistry(this.dataDir, this.workspace, {
      clock: this.clock,
      staleMs: this.staleMs,
    });
  }

  private async enqueueWrite(entry: LocalSessionRegistryEntry): Promise<void> {
    const operation = this.writeTail.then(async () => {
      const directory = await ensureRealDirectory(join(this.dataDir, "sessions"));
      const path = join(directory.path, `${this.sessionId}.json`);
      await assertNoSymlinkComponents(path);
      const payload = JSON.stringify({ ...entry, instanceToken: this.instanceToken });
      const temporary = `${path}.${this.instanceToken}.tmp`;
      await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, path);
      this.filePath = path;
    });
    this.writeTail = operation.then(() => undefined, () => undefined);
    await operation;
  }

  private nowIso(): string {
    const now = this.clock.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new TypeError("session registry clock returned an invalid Date");
    }
    return now.toISOString();
  }
}

/** Read all valid records for one workspace, projecting stale heartbeats. */
export async function readLocalSessionRegistry(
  dataDir: string,
  workspace: string,
  options: { readonly clock?: Clock; readonly staleMs?: number } = {},
): Promise<readonly LocalSessionObservation[]> {
  const root = resolve(dataDir);
  // SessionController canonicalizes its workspace before writing presence.
  // Readers may be invoked from a symlinked checkout, so canonicalize here as
  // well; retain the resolved path when the workspace has not been created.
  const resolvedWorkspace = resolve(workspace);
  const workspaceLabel = await canonicalWorkspace(workspace);
  const clock = options.clock ?? systemClock;
  const staleMs = boundedPositive(
    options.staleMs ?? DEFAULT_LOCAL_SESSION_STALE_MS,
    "staleMs",
  );
  const directory = join(root, "sessions");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [];
  }
  const nowMs = clock.now().getTime();
  const records: LocalSessionObservation[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_REGISTRY_BYTES) continue;
      const parsed = parseRegistryRecord(JSON.parse(await readFile(path, "utf8")));
      // Older/direct registry instances may have persisted the lexical
      // `/var/...` spelling while realpath() returns macOS's `/private/var/...`
      // spelling. Both identify the same workspace and must be accepted.
      if (parsed === undefined) continue;
      const parsedWorkspace = await canonicalWorkspace(parsed.workspace);
      if (parsedWorkspace !== workspaceLabel
        && parsed.workspace !== workspaceLabel
        && parsed.workspace !== resolvedWorkspace) continue;
      const lastSeenMs = Date.parse(parsed.lastSeen);
      const live = Number.isFinite(lastSeenMs)
        && lastSeenMs <= nowMs + 5 * 60_000
        && nowMs - lastSeenMs <= staleMs;
      records.push({
        ...parsed,
        state: live || parsed.state === "terminal" ? parsed.state : "offline",
        live,
      });
    } catch {
      // One half-written or corrupt record must not hide healthy sessions.
    }
  }
  return records.sort((left, right) => (
    right.lastSeen.localeCompare(left.lastSeen) || left.sessionId.localeCompare(right.sessionId)
  ));
}

async function canonicalWorkspace(workspace: string): Promise<string> {
  const resolved = resolve(workspace);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

interface ParsedRegistryRecord extends LocalSessionRegistryEntry {
  readonly instanceToken?: string;
}

function parseRegistryRecord(value: unknown): ParsedRegistryRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (item.version !== LOCAL_SESSION_REGISTRY_VERSION
    || typeof item.sessionId !== "string"
    || !SESSION_ID.test(item.sessionId)
    || typeof item.workspace !== "string"
    || typeof item.laneId !== "string"
    || typeof item.state !== "string"
    || typeof item.startedAt !== "string"
    || typeof item.lastSeen !== "string") return undefined;
  if (item.runId !== undefined && typeof item.runId !== "string") return undefined;
  if (item.activitySummary !== undefined && typeof item.activitySummary !== "string") return undefined;
  if (!Number.isFinite(Date.parse(item.startedAt)) || !Number.isFinite(Date.parse(item.lastSeen))) return undefined;
  try {
    const activitySummary = item.activitySummary === undefined
      ? undefined
      : boundedSummary(item.activitySummary);
    return {
      version: LOCAL_SESSION_REGISTRY_VERSION,
      sessionId: item.sessionId,
      workspace: resolve(item.workspace),
      ...(item.runId === undefined ? {} : { runId: boundedLabel(item.runId, "runId") }),
      laneId: boundedLabel(item.laneId, "laneId"),
      state: validateState(item.state),
      startedAt: new Date(Date.parse(item.startedAt)).toISOString(),
      lastSeen: new Date(Date.parse(item.lastSeen)).toISOString(),
      ...(validRuntimeBuildId(item.runtimeBuildId) ? { runtimeBuildId: item.runtimeBuildId } : {}),
      ...(activitySummary === undefined ? {} : { activitySummary }),
      ...(typeof item.instanceToken === "string" ? { instanceToken: item.instanceToken } : {}),
    };
  } catch {
    return undefined;
  }
}

function validRuntimeBuildId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{12}$/u.test(value);
}

function validateState(value: string): LocalSessionState {
  if (["starting", "active", "waiting", "idle", "sleeping", "offline", "terminal"].includes(value)) {
    return value as LocalSessionState;
  }
  throw new TypeError("session registry state is invalid");
}

function boundedLabel(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`session registry ${field} is invalid`);
  }
  return value;
}

function boundedSummary(value: string): string | undefined {
  if (typeof value !== "string") throw new TypeError("session registry activitySummary is invalid");
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return normalized.length === 0 ? undefined : normalized.slice(0, MAX_SUMMARY_LENGTH);
}

function boundedPositive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 24 * 60 * 60 * 1_000) {
    throw new RangeError(`session registry ${field} must be a positive integer`);
  }
  return value;
}
