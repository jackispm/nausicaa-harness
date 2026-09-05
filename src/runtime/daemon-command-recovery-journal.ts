import { constants } from "node:fs";
import { hostname } from "node:os";
import { link, lstat, unlink, type FileHandle } from "node:fs/promises";

import type { DaemonControlMethod } from "./daemon-control.js";
import {
  assertRegularFile,
  canonicalFilePath,
  openNoFollow,
  syncDirectory,
} from "../ledger/file-utils.js";
import { cloneJson, sha256, stableJson } from "../ledger/hash.js";

/** Durable command protocol version. Bump only when replay semantics change. */
export const DAEMON_COMMAND_RECOVERY_JOURNAL_VERSION = 1 as const;
export const MAX_DAEMON_COMMAND_RECOVERY_RECORD_BYTES = 64 * 1024;

export type DaemonCommandRecoveryStatus = "received" | "result" | "acknowledged";

export interface DaemonCommandRecoveryResponse {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface DaemonCommandRecoveryRecord {
  readonly version: typeof DAEMON_COMMAND_RECOVERY_JOURNAL_VERSION;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly clientId: string;
  readonly commandId: string;
  readonly method: DaemonControlMethod;
  /** Hash of method and params; raw control input is not persisted here. */
  readonly fingerprint: string;
  readonly status: DaemonCommandRecoveryStatus;
  readonly response?: DaemonCommandRecoveryResponse;
}

export type DaemonCommandRecoveryRecordInput = Omit<
  DaemonCommandRecoveryRecord,
  "version" | "sequence" | "occurredAt"
> & { readonly occurredAt?: string };

export interface DaemonCommandRecoveryJournal {
  read(): Promise<readonly DaemonCommandRecoveryRecord[]>;
  append(input: DaemonCommandRecoveryRecordInput): Promise<DaemonCommandRecoveryRecord>;
  close?(): Promise<void>;
}

export class DaemonCommandRecoveryJournalError extends Error {
  override readonly name: string = "DaemonCommandRecoveryJournalError";
}

export class DaemonCommandRecoveryJournalLockedError extends DaemonCommandRecoveryJournalError {
  override readonly name = "DaemonCommandRecoveryJournalLockedError";
}

export class DaemonCommandRecoveryJournalCorruptionError extends DaemonCommandRecoveryJournalError {
  override readonly name = "DaemonCommandRecoveryJournalCorruptionError";
}

export function daemonCommandRecoveryKey(clientId: string, commandId: string): string {
  return `${clientId}\u0000${commandId}`;
}

export function daemonCommandRecoveryFingerprint(method: DaemonControlMethod, params: unknown): string {
  return sha256(stableJson({ method, params: params === undefined ? null : params }));
}

/** Validate the full append-only history before it is used for replay. */
export function validateDaemonCommandRecoveryHistory(
  records: readonly DaemonCommandRecoveryRecord[],
): void {
  if (!Array.isArray(records)) {
    throw new DaemonCommandRecoveryJournalCorruptionError("command recovery records must be an array");
  }
  const latest = new Map<string, DaemonCommandRecoveryRecord>();
  records.forEach((candidate, index) => {
    let record: DaemonCommandRecoveryRecord;
    try {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new TypeError("record must be an object");
      }
      if (candidate.version !== DAEMON_COMMAND_RECOVERY_JOURNAL_VERSION) {
        throw new TypeError("record version is unsupported");
      }
      if (candidate.sequence !== index + 1) {
        throw new TypeError("record sequence is not contiguous");
      }
      record = makeRecord(candidate as DaemonCommandRecoveryRecordInput, index + 1, () => new Date(candidate.occurredAt));
    } catch (error: unknown) {
      throw new DaemonCommandRecoveryJournalCorruptionError(
        `Invalid command recovery record ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const key = daemonCommandRecoveryKey(record.clientId, record.commandId);
    const prior = latest.get(key);
    if (prior !== undefined) {
      if (!validTransition(prior, record)) {
        throw new DaemonCommandRecoveryJournalCorruptionError(
          `Command ${record.commandId} has an invalid transition or changed identity`,
        );
      }
    }
    latest.set(key, record);
  });
}

export function projectDaemonCommandRecovery(
  records: readonly DaemonCommandRecoveryRecord[],
): Map<string, DaemonCommandRecoveryRecord> {
  validateDaemonCommandRecoveryHistory(records);
  const latest = new Map<string, DaemonCommandRecoveryRecord>();
  for (const record of records) {
    latest.set(daemonCommandRecoveryKey(record.clientId, record.commandId), Object.freeze({ ...record }));
  }
  return latest;
}

export interface MemoryDaemonCommandRecoveryJournalOptions {
  readonly now?: () => Date;
}

export class MemoryDaemonCommandRecoveryJournal implements DaemonCommandRecoveryJournal {
  readonly #now: () => Date;
  readonly #records: DaemonCommandRecoveryRecord[] = [];

  constructor(options: MemoryDaemonCommandRecoveryJournalOptions = {}) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("journal options must be an object");
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new TypeError("now must be a function");
    }
    this.#now = options.now ?? (() => new Date());
  }

  async read(): Promise<readonly DaemonCommandRecoveryRecord[]> {
    return this.#records.map((record) => cloneJson(record));
  }

  async append(input: DaemonCommandRecoveryRecordInput): Promise<DaemonCommandRecoveryRecord> {
    const record = makeRecord(input, this.#records.length + 1, this.#now);
    if (this.#records.length > 0) {
      const key = daemonCommandRecoveryKey(record.clientId, record.commandId);
      const prior = [...this.#records].reverse().find((candidate) => (
        daemonCommandRecoveryKey(candidate.clientId, candidate.commandId) === key
      ));
      if (prior !== undefined && !validTransition(prior, record)) {
        throw new DaemonCommandRecoveryJournalError("invalid command recovery transition or changed identity");
      }
    }
    this.#records.push(record);
    return cloneJson(record);
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
  readonly records: DaemonCommandRecoveryRecord[];
  readonly committedBytes: number;
}

const LOCK_RETRY_ATTEMPTS = 3;

/** Restart-safe JSONL journal. The final torn line is the only repairable tail. */
export class FileDaemonCommandRecoveryJournal implements DaemonCommandRecoveryJournal {
  readonly #location: Location;
  readonly #lock: JournalLock;
  readonly #handle: FileHandle;
  #records: DaemonCommandRecoveryRecord[];
  #tail: Promise<void> = Promise.resolve();
  #accepting = true;
  #failure: Error | undefined;
  #closePromise: Promise<void> | undefined;

  private constructor(location: Location, lock: JournalLock, handle: FileHandle, parsed: ParsedJournal) {
    this.#location = location;
    this.#lock = lock;
    this.#handle = handle;
    this.#records = parsed.records;
  }

  static async open(path: string): Promise<FileDaemonCommandRecoveryJournal> {
    const location = await canonicalFilePath(identifier(path, "path"));
    const lock = await acquireJournalLock(`${location.path}.lock`, location.parent);
    let handle: FileHandle | undefined;
    try {
      let created = false;
      try {
        const info = await lstat(location.path);
        if (!info.isFile() || info.isSymbolicLink()) {
          throw new DaemonCommandRecoveryJournalCorruptionError(
            `Command recovery journal is not a regular file: ${location.path}`,
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
      return new FileDaemonCommandRecoveryJournal(location, lock, handle, parsed);
    } catch (error: unknown) {
      await handle?.close();
      await releaseJournalLock(lock);
      throw error;
    }
  }

  get path(): string {
    return this.#location.path;
  }

  async read(): Promise<readonly DaemonCommandRecoveryRecord[]> {
    this.#assertAvailable();
    await this.#tail;
    this.#assertHealthy();
    return this.#records.map((record) => cloneJson(record));
  }

  append(input: DaemonCommandRecoveryRecordInput): Promise<DaemonCommandRecoveryRecord> {
    this.#assertAvailable();
    const operation = this.#tail.then(async () => {
      this.#assertHealthy();
      const record = makeRecord(input, this.#records.length + 1, () => new Date());
      const prior = [...this.#records].reverse().find((candidate) => (
        daemonCommandRecoveryKey(candidate.clientId, candidate.commandId)
          === daemonCommandRecoveryKey(record.clientId, record.commandId)
      ));
      if (prior !== undefined && !validTransition(prior, record)) {
        throw new DaemonCommandRecoveryJournalError("invalid command recovery transition or changed identity");
      }
      const bytes = Buffer.from(`${stableJson(record)}\n`, "utf8");
      if (bytes.byteLength > MAX_DAEMON_COMMAND_RECOVERY_RECORD_BYTES) {
        throw new RangeError("command recovery journal record exceeds its byte limit");
      }
      try {
        let written = 0;
        while (written < bytes.byteLength) {
          const result = await this.#handle.write(bytes, written, bytes.byteLength - written, null);
          if (result.bytesWritten === 0) throw new DaemonCommandRecoveryJournalError("command recovery append made no progress");
          written += result.bytesWritten;
        }
        await this.#handle.sync();
        this.#records.push(record);
        return cloneJson(record);
      } catch (error: unknown) {
        this.#failure = error instanceof Error ? error : new DaemonCommandRecoveryJournalError(String(error));
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
    if (!this.#accepting) throw new DaemonCommandRecoveryJournalError("command recovery journal is closed");
    this.#assertHealthy();
  }

  #assertHealthy(): void {
    if (this.#failure !== undefined) {
      throw new DaemonCommandRecoveryJournalError(`command recovery journal state is uncertain: ${this.#failure.message}`);
    }
  }
}

export class LazyFileDaemonCommandRecoveryJournal implements DaemonCommandRecoveryJournal {
  readonly #path: string;
  #journalPromise: Promise<FileDaemonCommandRecoveryJournal> | undefined;
  #operationTail: Promise<void> = Promise.resolve();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(path: string) {
    this.#path = identifier(path, "path");
  }

  read(): Promise<readonly DaemonCommandRecoveryRecord[]> {
    return this.#withJournal((journal) => journal.read());
  }

  append(input: DaemonCommandRecoveryRecordInput): Promise<DaemonCommandRecoveryRecord> {
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

  #withJournal<T>(operation: (journal: FileDaemonCommandRecoveryJournal) => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new DaemonCommandRecoveryJournalError("command recovery journal is closed"));
    const journal = this.#journalPromise ?? FileDaemonCommandRecoveryJournal.open(this.#path);
    this.#journalPromise = journal;
    const result = journal.then(operation);
    this.#operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function createFileDaemonCommandRecoveryJournal(path: string): LazyFileDaemonCommandRecoveryJournal {
  return new LazyFileDaemonCommandRecoveryJournal(path);
}

function makeRecord(
  input: DaemonCommandRecoveryRecordInput,
  sequence: number,
  now: () => Date,
): DaemonCommandRecoveryRecord {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("record must be an object");
  for (const [field, value] of Object.entries({
    clientId: input.clientId,
    commandId: input.commandId,
    method: input.method,
    fingerprint: input.fingerprint,
  })) {
    if (typeof value !== "string" || value.length === 0 || value.length > 1024 || value.includes("\0")) {
      throw new TypeError(`command recovery record ${field} is invalid`);
    }
  }
  if (!(input.method === "start" || input.method === "stop" || input.method === "status"
    || input.method === "attach" || input.method === "detach" || input.method === "wake"
    || input.method === "events.subscribe")) {
    throw new TypeError("command recovery record method is invalid");
  }
  if (!(input.status === "received" || input.status === "result" || input.status === "acknowledged")) {
    throw new TypeError("command recovery record status is invalid");
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new TypeError("command recovery record sequence is invalid");
  const occurredAt = input.occurredAt ?? now().toISOString();
  if (typeof occurredAt !== "string" || !Number.isFinite(Date.parse(occurredAt))) throw new TypeError("command recovery record occurredAt is invalid");
  const response = input.response === undefined ? undefined : normalizeResponse(input.response);
  if (input.status === "received" && response !== undefined) {
    throw new TypeError("received records cannot contain a response");
  }
  if (input.status !== "received" && response === undefined) throw new TypeError("result and acknowledged records require a response");
  return Object.freeze({
    version: DAEMON_COMMAND_RECOVERY_JOURNAL_VERSION,
    sequence,
    occurredAt,
    clientId: input.clientId,
    commandId: input.commandId,
    method: input.method,
    fingerprint: input.fingerprint,
    status: input.status,
    ...(response === undefined ? {} : { response }),
  });
}

function normalizeResponse(value: DaemonCommandRecoveryResponse): DaemonCommandRecoveryResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value) || typeof value.ok !== "boolean") {
    throw new TypeError("command recovery response is invalid");
  }
  if (value.ok && value.error !== undefined) throw new TypeError("successful response cannot contain an error");
  if (!value.ok && value.result !== undefined) throw new TypeError("failed response cannot contain a result");
  if (value.error !== undefined && (value.error === null || typeof value.error !== "object"
    || typeof value.error.code !== "string" || typeof value.error.message !== "string")) {
    throw new TypeError("command recovery response error is invalid");
  }
  stableJson(value);
  return cloneJson(value);
}

function validTransition(prior: DaemonCommandRecoveryRecord, next: DaemonCommandRecoveryRecord): boolean {
  if (prior.method !== next.method || prior.fingerprint !== next.fingerprint) return false;
  if (
    prior.response !== undefined
    && next.response !== undefined
    && stableJson(prior.response) !== stableJson(next.response)
  ) return false;
  if (prior.status === "received") return next.status === "received" || next.status === "result";
  if (prior.status === "result") return next.status === "result" || next.status === "acknowledged";
  return next.status === "acknowledged";
}

function parseJournal(contents: Buffer): ParsedJournal {
  if (contents.byteLength === 0) return { records: [], committedBytes: 0 };
  const lastNewline = contents.lastIndexOf(0x0a);
  const committedBytes = lastNewline + 1;
  if (committedBytes === 0) return { records: [], committedBytes: 0 };
  const lines = contents.subarray(0, committedBytes).toString("utf8").split("\n");
  lines.pop();
  const records = lines.map((line, index) => {
    if (line.length === 0 || Buffer.byteLength(line, "utf8") > MAX_DAEMON_COMMAND_RECOVERY_RECORD_BYTES) {
      throw new DaemonCommandRecoveryJournalCorruptionError(`Invalid command recovery line ${index + 1}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error: unknown) {
      throw new DaemonCommandRecoveryJournalCorruptionError(`Invalid command recovery JSON at line ${index + 1}: ${String(error)}`);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new DaemonCommandRecoveryJournalCorruptionError(`Invalid command recovery record at line ${index + 1}`);
    try {
      return makeRecord(value as DaemonCommandRecoveryRecordInput, index + 1, () => new Date((value as { occurredAt: string }).occurredAt));
    } catch (error: unknown) {
      throw new DaemonCommandRecoveryJournalCorruptionError(`Invalid command recovery record at line ${index + 1}: ${String(error)}`);
    }
  });
  validateDaemonCommandRecoveryHistory(records);
  return { records, committedBytes };
}

async function acquireJournalLock(path: string, parent: string): Promise<JournalLock> {
  const owner: LockOwner = { version: 1, pid: process.pid, hostname: hostname(), token: cryptoRandomId() };
  const claimPath = `${path}.${owner.pid}.${owner.token}.claim`;
  const claim = await openNoFollow(claimPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
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
          throw new DaemonCommandRecoveryJournalLockedError("command recovery journal already has a live writer");
        }
        if (await sameFile(path, existing.handle)) {
          await unlink(path);
          await syncDirectory(parent);
        }
      } finally {
        await existing.handle.close();
      }
    }
    throw new DaemonCommandRecoveryJournalLockedError("could not acquire command recovery journal writer lock");
  } catch (error: unknown) {
    await claim.close();
    await unlink(claimPath).catch(() => undefined);
    throw error;
  }
}

async function readJournalLockOwner(path: string): Promise<{ owner: LockOwner; handle: FileHandle }> {
  const handle = await openNoFollow(path, constants.O_RDONLY);
  try {
    await assertRegularFile(handle, path, false);
    const parsed = JSON.parse(await handle.readFile("utf8")) as Partial<LockOwner>;
    if (parsed.version !== 1 || !Number.isSafeInteger(parsed.pid) || (parsed.pid as number) < 1
      || typeof parsed.hostname !== "string" || parsed.hostname.length === 0
      || typeof parsed.token !== "string" || parsed.token.length === 0) {
      throw new DaemonCommandRecoveryJournalLockedError("invalid command recovery journal writer lock");
    }
    return { owner: parsed as LockOwner, handle };
  } catch (error: unknown) {
    await handle.close();
    if (error instanceof DaemonCommandRecoveryJournalLockedError) throw error;
    throw new DaemonCommandRecoveryJournalLockedError("invalid command recovery journal writer lock");
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

function cryptoRandomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
