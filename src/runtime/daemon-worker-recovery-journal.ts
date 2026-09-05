import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { hostname } from "node:os";
import { link, lstat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

import {
  assertRegularFile,
  canonicalFilePath,
  openNoFollow,
  syncDirectory,
} from "../ledger/file-utils.js";
import { sha256, stableJson } from "../ledger/hash.js";

export const DAEMON_WORKER_RECOVERY_JOURNAL_VERSION = 1 as const;
export const MAX_DAEMON_WORKER_RECOVERY_RECORD_BYTES = 64 * 1024;

export type DaemonWorkerRecoveryStatus =
  | "accepted"
  | "started"
  | "completed"
  | "failed"
  | "cancelled"
  | "uncertain"
  | "interrupted";

export interface DaemonWorkerRecoveryRecord {
  readonly version: typeof DAEMON_WORKER_RECOVERY_JOURNAL_VERSION;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly runId: string;
  readonly workerId: string;
  readonly activationId: string;
  readonly commandId: string;
  /** Stable input digest; the raw activation frame is never persisted here. */
  readonly fingerprint: string;
  readonly status: DaemonWorkerRecoveryStatus;
  readonly error?: string;
}

export type DaemonWorkerRecoveryRecordInput = Omit<
  DaemonWorkerRecoveryRecord,
  "version" | "sequence" | "occurredAt"
> & { readonly occurredAt?: string };

export interface DaemonWorkerRecoveryJournal {
  read(): Promise<readonly DaemonWorkerRecoveryRecord[]>;
  append(input: DaemonWorkerRecoveryRecordInput): Promise<DaemonWorkerRecoveryRecord>;
  close?(): Promise<void>;
}

/**
 * Validate the append-only history before a worker uses it for replay.
 *
 * Injected journal implementations can still return a syntactically valid
 * record stream with a conflicting identity or a terminal status that was
 * later downgraded. Keeping this check explicit lets the worker fail closed.
 */
export function validateDaemonWorkerRecoveryHistory(
  records: readonly DaemonWorkerRecoveryRecord[],
): void {
  if (!Array.isArray(records)) {
    throw new DaemonWorkerRecoveryJournalCorruptionError("Recovery journal records must be an array");
  }
  const latest = new Map<string, DaemonWorkerRecoveryRecord>();
  records.forEach((record, index) => {
    let normalized: DaemonWorkerRecoveryRecord;
    try {
      if (record === null || typeof record !== "object" || Array.isArray(record)) {
        throw new TypeError("record must be an object");
      }
      if (record.version !== DAEMON_WORKER_RECOVERY_JOURNAL_VERSION) {
        throw new TypeError("record version is unsupported");
      }
      if (record.sequence !== index + 1) {
        throw new TypeError("record sequence is not contiguous");
      }
      normalized = makeRecord(
        record as DaemonWorkerRecoveryRecordInput,
        index + 1,
        () => new Date(record.occurredAt),
      );
    } catch (error: unknown) {
      throw new DaemonWorkerRecoveryJournalCorruptionError(
        `Invalid recovery history record ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const prior = latest.get(normalized.activationId);
    if (prior !== undefined) {
      if (prior.fingerprint !== normalized.fingerprint) {
        throw new DaemonWorkerRecoveryJournalCorruptionError(
          `Recovery activation ${normalized.activationId} changed fingerprint`,
        );
      }
      if (!validRecoveryTransition(prior, normalized)) {
        throw new DaemonWorkerRecoveryJournalCorruptionError(
          `Recovery activation ${normalized.activationId} has an invalid status transition`,
        );
      }
    }
    latest.set(normalized.activationId, normalized);
  });
}

export interface MemoryDaemonWorkerRecoveryJournalOptions {
  readonly now?: () => Date;
}

export class DaemonWorkerRecoveryJournalError extends Error {
  override name: string = "DaemonWorkerRecoveryJournalError";
}

export class DaemonWorkerRecoveryJournalLockedError extends DaemonWorkerRecoveryJournalError {
  override name: string = "DaemonWorkerRecoveryJournalLockedError";
}

export class DaemonWorkerRecoveryJournalCorruptionError extends DaemonWorkerRecoveryJournalError {
  override name: string = "DaemonWorkerRecoveryJournalCorruptionError";
}

/** In-memory reference journal used by embedders and protocol tests. */
export class MemoryDaemonWorkerRecoveryJournal implements DaemonWorkerRecoveryJournal {
  private readonly now: () => Date;
  private readonly records: DaemonWorkerRecoveryRecord[] = [];

  constructor(options: MemoryDaemonWorkerRecoveryJournalOptions = {}) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("journal options must be an object");
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new TypeError("now must be a function");
    }
    this.now = options.now ?? (() => new Date());
  }

  async read(): Promise<readonly DaemonWorkerRecoveryRecord[]> {
    return this.records.map((record) => Object.freeze({ ...record }));
  }

  async append(input: DaemonWorkerRecoveryRecordInput): Promise<DaemonWorkerRecoveryRecord> {
    const record = makeRecord(input, this.records.length + 1, this.now);
    assertRecoveryAppend(this.records, record);
    this.records.push(record);
    return Object.freeze({ ...record });
  }
}

interface LockOwner {
  readonly version: 1;
  readonly pid: number;
  readonly hostname: string;
  readonly token: string;
}

interface JournalLock {
  readonly handle: FileHandle;
  readonly path: string;
  readonly parent: string;
}

interface Location {
  readonly path: string;
  readonly parent: string;
}

interface ParsedJournal {
  readonly records: DaemonWorkerRecoveryRecord[];
  readonly committedBytes: number;
}

const LOCK_RETRY_ATTEMPTS = 3;

/**
 * Restart-safe JSONL journal for one detached worker identity.
 *
 * The writer lock is held for the lifetime of the opened journal, so a second
 * worker cannot append a competing history to the same file. Each record is
 * fsynced before append resolves; a final partial line is truncated on reopen.
 */
export class FileDaemonWorkerRecoveryJournal implements DaemonWorkerRecoveryJournal {
  readonly #location: Location;
  readonly #lock: JournalLock;
  readonly #handle: FileHandle;
  #records: DaemonWorkerRecoveryRecord[];
  #tail: Promise<void> = Promise.resolve();
  #accepting = true;
  #failure: Error | undefined;
  #closePromise: Promise<void> | undefined;

  private constructor(
    location: Location,
    lock: JournalLock,
    handle: FileHandle,
    parsed: ParsedJournal,
  ) {
    this.#location = location;
    this.#lock = lock;
    this.#handle = handle;
    this.#records = parsed.records;
  }

  static async open(path: string): Promise<FileDaemonWorkerRecoveryJournal> {
    const location = await canonicalFilePath(identifier(path, "path"));
    const lock = await acquireJournalLock(`${location.path}.lock`, location.parent);
    let handle: FileHandle | undefined;
    try {
      let created = false;
      try {
        const info = await lstat(location.path);
        if (!info.isFile() || info.isSymbolicLink()) {
          throw new DaemonWorkerRecoveryJournalCorruptionError(
            `Recovery journal is not a regular file: ${location.path}`,
          );
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        created = true;
      }
      handle = await openNoFollow(
        location.path,
        constants.O_RDWR | constants.O_CREAT | constants.O_APPEND,
        0o600,
      );
      await assertRegularFile(handle, location.path, true);
      if (created) await syncDirectory(location.parent);
      const contents = await handle.readFile();
      const parsed = parseJournal(contents);
      if (parsed.committedBytes !== contents.byteLength) {
        await handle.truncate(parsed.committedBytes);
        await handle.sync();
      }
      return new FileDaemonWorkerRecoveryJournal(location, lock, handle, parsed);
    } catch (error: unknown) {
      await handle?.close();
      await releaseJournalLock(lock);
      throw error;
    }
  }

  get path(): string {
    return this.#location.path;
  }

  async read(): Promise<readonly DaemonWorkerRecoveryRecord[]> {
    this.#assertAvailable();
    await this.#tail;
    this.#assertHealthy();
    return this.#records.map((record) => Object.freeze({ ...record }));
  }

  append(input: DaemonWorkerRecoveryRecordInput): Promise<DaemonWorkerRecoveryRecord> {
    this.#assertAvailable();
    const operation = this.#tail.then(async () => {
      this.#assertHealthy();
      const record = makeRecord(input, this.#records.length + 1, () => new Date());
      assertRecoveryAppend(this.#records, record);
      const bytes = Buffer.from(`${stableJson(record)}\n`, "utf8");
      if (bytes.byteLength > MAX_DAEMON_WORKER_RECOVERY_RECORD_BYTES) {
        throw new RangeError("Recovery journal record exceeds its byte limit");
      }
      try {
        let written = 0;
        while (written < bytes.byteLength) {
          const result = await this.#handle.write(
            bytes,
            written,
            bytes.byteLength - written,
            null,
          );
          if (result.bytesWritten === 0) {
            throw new DaemonWorkerRecoveryJournalError("Recovery journal append made no progress");
          }
          written += result.bytesWritten;
        }
        await this.#handle.sync();
        this.#records.push(record);
        return Object.freeze({ ...record });
      } catch (error: unknown) {
        this.#failure = error instanceof Error
          ? error
          : new DaemonWorkerRecoveryJournalError(String(error));
        throw error;
      }
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#accepting = false;
    const operation = (async () => {
      await this.#tail;
      try {
        if (this.#failure === undefined) await this.#handle.sync();
      } finally {
        try {
          await this.#handle.close();
        } finally {
          await releaseJournalLock(this.#lock);
        }
      }
    })();
    this.#closePromise = operation;
    return operation;
  }

  #assertAvailable(): void {
    if (!this.#accepting) throw new DaemonWorkerRecoveryJournalError("Recovery journal is closed");
    this.#assertHealthy();
  }

  #assertHealthy(): void {
    if (this.#failure !== undefined) {
      throw new DaemonWorkerRecoveryJournalError(
        `Recovery journal write state is uncertain: ${this.#failure.message}`,
      );
    }
  }
}

/**
 * Synchronous-bootstrap adapter for stdio workers. Opening the file remains
 * lazy because the public worker bootstrap returns its server immediately;
 * the first protocol command awaits the real file handle before dispatch.
 */
export class LazyFileDaemonWorkerRecoveryJournal implements DaemonWorkerRecoveryJournal {
  readonly #path: string;
  #journalPromise: Promise<FileDaemonWorkerRecoveryJournal> | undefined;
  #operationTail: Promise<void> = Promise.resolve();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(path: string) {
    this.#path = identifier(path, "path");
  }

  read(): Promise<readonly DaemonWorkerRecoveryRecord[]> {
    return this.#withJournal((journal) => journal.read());
  }

  append(input: DaemonWorkerRecoveryRecordInput): Promise<DaemonWorkerRecoveryRecord> {
    return this.#withJournal((journal) => journal.append(input));
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    const operation = (async () => {
      const pending = this.#journalPromise;
      if (pending === undefined) return;
      await this.#operationTail;
      const journal = await pending.catch(() => undefined);
      await journal?.close();
    })();
    this.#closePromise = operation;
    return operation;
  }

  #withJournal<T>(operation: (journal: FileDaemonWorkerRecoveryJournal) => Promise<T>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new DaemonWorkerRecoveryJournalError("Recovery journal is closed"));
    }
    const journal = this.#journalPromise ?? FileDaemonWorkerRecoveryJournal.open(this.#path);
    this.#journalPromise = journal;
    const result = journal.then(operation);
    this.#operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function createFileDaemonWorkerRecoveryJournal(path: string): LazyFileDaemonWorkerRecoveryJournal {
  return new LazyFileDaemonWorkerRecoveryJournal(path);
}

function makeRecord(
  input: DaemonWorkerRecoveryRecordInput,
  sequence: number,
  now: () => Date,
): DaemonWorkerRecoveryRecord {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("recovery record must be an object");
  }
  for (const [field, value] of Object.entries({
    runId: input.runId,
    workerId: input.workerId,
    activationId: input.activationId,
    commandId: input.commandId,
    fingerprint: input.fingerprint,
  })) {
    if (typeof value !== "string" || value.length === 0 || value.length > 1024 || value.includes("\0")) {
      throw new TypeError(`recovery record ${field} is invalid`);
    }
  }
  const statuses: readonly DaemonWorkerRecoveryStatus[] = [
    "accepted",
    "started",
    "completed",
    "failed",
    "cancelled",
    "uncertain",
    "interrupted",
  ];
  if (!statuses.includes(input.status)) throw new TypeError("recovery record status is invalid");
  if (input.error !== undefined && (typeof input.error !== "string" || input.error.length > 2048)) {
    throw new TypeError("recovery record error is invalid");
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new TypeError("recovery record sequence is invalid");
  const occurredAt = input.occurredAt ?? now().toISOString();
  if (typeof occurredAt !== "string" || !Number.isFinite(Date.parse(occurredAt))) {
    throw new TypeError("recovery record occurredAt is invalid");
  }
  return Object.freeze({
    version: DAEMON_WORKER_RECOVERY_JOURNAL_VERSION,
    sequence,
    occurredAt,
    runId: input.runId,
    workerId: input.workerId,
    activationId: input.activationId,
    commandId: input.commandId,
    fingerprint: input.fingerprint,
    status: input.status,
    ...(input.error === undefined ? {} : { error: input.error }),
  });
}

function validRecoveryTransition(
  prior: DaemonWorkerRecoveryRecord,
  next: DaemonWorkerRecoveryRecord,
): boolean {
  if (prior.runId !== next.runId || prior.workerId !== next.workerId) return false;
  if (prior.fingerprint !== next.fingerprint) return false;
  if (isTerminalRecoveryStatus(prior.status)) {
    // A terminal receipt may be replayed, but it must never be replaced by a
    // different terminal outcome or by a non-terminal status.
    return prior.status === next.status && prior.error === next.error;
  }
  switch (prior.status) {
    case "accepted":
      return next.status === "accepted"
        || next.status === "started"
        || next.status === "completed"
        || next.status === "failed"
        || next.status === "cancelled"
        || next.status === "uncertain"
        || next.status === "interrupted";
    case "started":
      return next.status === "started"
        || next.status === "completed"
        || next.status === "failed"
        || next.status === "cancelled"
        || next.status === "uncertain"
        || next.status === "interrupted";
    case "interrupted":
      return next.status === "interrupted" || next.status === "uncertain";
    default:
      return false;
  }
}

function assertRecoveryAppend(
  records: readonly DaemonWorkerRecoveryRecord[],
  record: DaemonWorkerRecoveryRecord,
): void {
  const prior = [...records].reverse().find((candidate) => (
    candidate.activationId === record.activationId
  ));
  if (prior !== undefined && !validRecoveryTransition(prior, record)) {
    throw new DaemonWorkerRecoveryJournalError(
      `Recovery activation ${record.activationId} has an invalid status transition or changed identity`,
    );
  }
}

function isTerminalRecoveryStatus(
  status: DaemonWorkerRecoveryStatus,
): status is Extract<DaemonWorkerRecoveryStatus, "completed" | "failed" | "cancelled" | "uncertain"> {
  return status === "completed"
    || status === "failed"
    || status === "cancelled"
    || status === "uncertain";
}

function parseJournal(contents: Buffer): ParsedJournal {
  if (contents.byteLength === 0) return { records: [], committedBytes: 0 };
  const lastNewline = contents.lastIndexOf(0x0a);
  const committedBytes = lastNewline + 1;
  if (committedBytes === 0) return { records: [], committedBytes: 0 };
  const lines = contents.subarray(0, committedBytes).toString("utf8").split("\n");
  lines.pop();
  const records = lines.map((line, index) => {
    if (line.length === 0 || Buffer.byteLength(line, "utf8") > MAX_DAEMON_WORKER_RECOVERY_RECORD_BYTES) {
      throw new DaemonWorkerRecoveryJournalCorruptionError(`Invalid recovery journal line ${index + 1}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error: unknown) {
      throw new DaemonWorkerRecoveryJournalCorruptionError(
        `Invalid recovery journal JSON at line ${index + 1}: ${String(error)}`,
      );
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new DaemonWorkerRecoveryJournalCorruptionError(`Invalid recovery record at line ${index + 1}`);
    }
    const candidate = value as Partial<DaemonWorkerRecoveryRecord>;
    if (candidate.version !== DAEMON_WORKER_RECOVERY_JOURNAL_VERSION || candidate.sequence !== index + 1) {
      throw new DaemonWorkerRecoveryJournalCorruptionError(`Recovery journal sequence mismatch at line ${index + 1}`);
    }
    try {
      return makeRecord(candidate as DaemonWorkerRecoveryRecordInput, candidate.sequence, () => new Date(candidate.occurredAt!));
    } catch (error: unknown) {
      throw new DaemonWorkerRecoveryJournalCorruptionError(
        `Invalid recovery record at line ${index + 1}: ${String(error)}`,
      );
    }
  });
  // Opening a file journal is a recovery boundary. Validate transitions and
  // fingerprints before exposing any record to a worker or appender; syntax
  // and contiguous sequence numbers alone cannot detect semantic corruption.
  validateDaemonWorkerRecoveryHistory(records);
  return { records, committedBytes };
}

async function acquireJournalLock(path: string, parent: string): Promise<JournalLock> {
  const owner: LockOwner = {
    version: 1,
    pid: process.pid,
    hostname: hostname(),
    token: randomUUID(),
  };
  const claimPath = `${path}.${owner.pid}.${owner.token}.claim`;
  const claim = await openNoFollow(
    claimPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await claim.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await claim.sync();
    for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt += 1) {
      try {
        await link(claimPath, path);
        await unlink(claimPath);
        await syncDirectory(parent);
        return { handle: claim, path, parent };
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      let existing: { owner: LockOwner; handle: FileHandle };
      try {
        existing = await readJournalLockOwner(path);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      try {
        if (existing.owner.hostname !== owner.hostname || isProcessAlive(existing.owner.pid)) {
          throw new DaemonWorkerRecoveryJournalLockedError("Recovery journal already has a live writer");
        }
        if (await sameFile(path, existing.handle)) {
          await unlink(path);
          await syncDirectory(parent);
        }
      } finally {
        await existing.handle.close();
      }
    }
    throw new DaemonWorkerRecoveryJournalLockedError("Could not acquire recovery journal writer lock");
  } catch (error: unknown) {
    await claim.close();
    await unlink(claimPath).catch(() => undefined);
    throw error;
  }
}

async function readJournalLockOwner(path: string): Promise<{ owner: LockOwner; handle: FileHandle }> {
  const handle = await openNoFollow(path, constants.O_RDONLY);
  try {
    // The lock is installed with a hard-link claim. A crash between the link
    // and claim unlink can leave the lock inode with two links; that is a
    // valid writer record, not corruption. The owner liveness check below
    // still prevents reclaiming a live writer.
    await assertRegularFile(handle, path, false);
    const parsed = JSON.parse(await handle.readFile("utf8")) as Partial<LockOwner>;
    if (
      parsed.version !== 1
      || !Number.isSafeInteger(parsed.pid)
      || (parsed.pid as number) < 1
      || typeof parsed.hostname !== "string"
      || parsed.hostname.length === 0
      || typeof parsed.token !== "string"
      || parsed.token.length === 0
    ) throw new DaemonWorkerRecoveryJournalLockedError("Invalid recovery journal writer lock");
    return { owner: parsed as LockOwner, handle };
  } catch (error: unknown) {
    await handle.close();
    if (error instanceof DaemonWorkerRecoveryJournalLockedError) throw error;
    throw new DaemonWorkerRecoveryJournalLockedError("Invalid recovery journal writer lock");
  }
}

async function releaseJournalLock(lock: JournalLock): Promise<void> {
  try {
    if (await sameFile(lock.path, lock.handle)) {
      await unlink(lock.path);
      await syncDirectory(lock.parent);
    }
  } finally {
    await lock.handle.close();
  }
}

async function sameFile(path: string, handle: FileHandle): Promise<boolean> {
  try {
    const [pathInfo, handleInfo] = await Promise.all([lstat(path), handle.stat()]);
    return pathInfo.dev === handleInfo.dev && pathInfo.ino === handleInfo.ino;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || value.includes("\0")) {
    throw new TypeError(`${field} must be a non-empty string without NUL`);
  }
  return value;
}

/** Stable fingerprint helper for callers that do not need the raw frame in the journal. */
export function daemonWorkerRecoveryFingerprint(value: unknown): string {
  return sha256(stableJson(value));
}
