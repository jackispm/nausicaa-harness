import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { hostname } from "node:os";
import { link, lstat, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

import type { Clock } from "../domain/index.js";
import { systemClock } from "../domain/index.js";
import {
  assertRegularFile,
  canonicalFilePath,
  openNoFollow,
  syncDirectory,
  assertRealDirectory,
} from "../ledger/file-utils.js";
import {
  ExecutionLeaseProtocolError,
  MAX_EXECUTION_LEASE_TTL_MS,
  type ExecutionLease,
  type ExecutionLeaseClaim,
  type ExecutionLeaseClaimResult,
  type ExecutionLeaseCommitResult,
  type ExecutionLeaseIdentity,
  type ExecutionLeaseRelease,
  type ExecutionLeaseReleaseResult,
  type ExecutionLeaseRenewal,
  type ExecutionLeaseRenewResult,
  type ExecutionLeaseStatus,
  type ExecutionLeaseStore,
} from "./execution-lease.js";

/** Options for the restart-safe, file-backed execution lease store. */
export interface FileExecutionLeaseStoreOptions {
  readonly clock?: Clock;
  readonly createLeaseId?: () => string;
}

interface StoredLease {
  readonly value: ExecutionLease;
  readonly expiresAtMs: number;
}

interface ClaimReceipt {
  readonly ownerId: string;
  readonly ttlMs: number;
  readonly result: ExecutionLeaseClaimResult;
}

type MutationReceipt =
  | Readonly<{
      kind: "renew";
      ownerId: string;
      leaseId: string;
      fencingToken: number;
      ttlMs: number;
      result: ExecutionLeaseRenewResult;
    }>
  | Readonly<{
      kind: "release";
      ownerId: string;
      leaseId: string;
      fencingToken: number;
      result: ExecutionLeaseReleaseResult;
    }>;

interface LeaseSnapshot {
  readonly version: 1;
  readonly active: Record<string, StoredLease>;
  readonly fencingHighWatermarks: Record<string, number>;
  readonly timeHighWatermarks: Record<string, number>;
  readonly claimReceipts: Record<string, Record<string, ClaimReceipt>>;
  readonly mutationReceipts: Record<string, Record<string, MutationReceipt>>;
  readonly issuedLeaseIds: string[];
}

interface LockOwner {
  readonly version: 1;
  readonly pid: number;
  readonly hostname: string;
  readonly token: string;
}

interface FileLock {
  readonly handle: FileHandle;
  readonly path: string;
  readonly parent: string;
}

interface Location {
  readonly path: string;
  readonly parent: string;
}

interface ObservedTime {
  readonly nowMs: number;
  readonly regressed: boolean;
}

const LOST_RENEWAL: ExecutionLeaseRenewResult = Object.freeze({ status: "lost" });
const LOST_RELEASE: ExecutionLeaseReleaseResult = Object.freeze({ status: "lost" });
const RELEASED: ExecutionLeaseReleaseResult = Object.freeze({ status: "released" });
const LOCK_RETRY_ATTEMPTS = 20;
const LOCK_RETRY_DELAY_MS = 5;

/** Raised when another host currently owns the short file-operation lock. */
export class ExecutionLeaseStoreLockedError extends ExecutionLeaseProtocolError {
  override readonly name = "ExecutionLeaseStoreLockedError";
}

/** Raised when the durable lease snapshot cannot be trusted. */
export class ExecutionLeaseSnapshotError extends ExecutionLeaseProtocolError {
  override readonly name = "ExecutionLeaseSnapshotError";
}

/**
 * Restart-safe execution lease store.
 *
 * The snapshot is deliberately small and replaced atomically. A hard-link
 * lock (the same pattern used by JsonlLedger) serializes independent Node
 * processes without holding a descriptor for the lifetime of the daemon.
 */
export class FileExecutionLeaseStore implements ExecutionLeaseStore {
  readonly #location: Location;
  readonly #clock: Clock;
  readonly #createLeaseId: () => string;
  #tail: Promise<void> = Promise.resolve();

  private constructor(location: Location, options: FileExecutionLeaseStoreOptions) {
    this.#location = location;
    this.#clock = options.clock ?? systemClock;
    this.#createLeaseId = options.createLeaseId ?? randomUUID;
  }

  /** Open a store. The path's parent is created with the repository file policy. */
  static async open(
    path: string,
    options: FileExecutionLeaseStoreOptions = {},
  ): Promise<FileExecutionLeaseStore> {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new TypeError("options must be an object");
    }
    validateClock(options.clock);
    if (options.createLeaseId !== undefined && typeof options.createLeaseId !== "function") {
      throw new TypeError("createLeaseId must be a function");
    }
    const location = await canonicalFilePath(identifier(path, "path"));
    try {
      const info = await lstat(location.path);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new ExecutionLeaseSnapshotError(
          `Lease snapshot is not a regular file: ${location.path}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return new FileExecutionLeaseStore(location, options);
  }

  /** Absolute canonical snapshot path, useful for diagnostics and lock tests. */
  get path(): string {
    return this.#location.path;
  }

  async claim(input: ExecutionLeaseClaim): Promise<ExecutionLeaseClaimResult> {
    const claim = validateClaim(input);
    return this.#runExclusive(() => this.#withSnapshot((state) => claimNow(
      state,
      claim,
      this.#clock,
      this.#createLeaseId,
    )));
  }

  async renew(input: ExecutionLeaseRenewal): Promise<ExecutionLeaseRenewResult> {
    const renewal = validateRenewal(input);
    return this.#runExclusive(() => this.#withSnapshot((state) => renewNow(
      state,
      renewal,
      this.#clock,
    )));
  }

  async verify(input: ExecutionLeaseIdentity): Promise<boolean> {
    const identity = validateIdentity(input);
    return this.#runExclusive(() => this.#withSnapshot((state) => {
      const observed = observeTime(state, identity.runId, this.#clock);
      const current = liveLease(state, identity.runId, observed.nowMs);
      return current !== undefined && sameIdentity(current.value, identity);
    }));
  }

  async runIfCurrent<T>(
    input: ExecutionLeaseIdentity,
    operation: () => Promise<T>,
  ): Promise<ExecutionLeaseCommitResult<T>> {
    const identity = validateIdentity(input);
    if (typeof operation !== "function") throw new TypeError("operation must be a function");
    return this.#runExclusive(async () => {
      const lock = await acquireLeaseLock(`${this.#location.path}.lock`, this.#location.parent);
      try {
        const state = await readSnapshot(this.#location.path);
        const observed = observeTime(state, identity.runId, this.#clock);
        const current = liveLease(state, identity.runId, observed.nowMs);
        if (current === undefined || !sameIdentity(current.value, identity)) {
          await writeSnapshot(this.#location, state);
          return Object.freeze({ status: "lost" as const });
        }
        let value: T;
        try {
          value = await operation();
        } finally {
          // Persist clock observations even when the caller's commit fails.
          await writeSnapshot(this.#location, state);
        }
        return Object.freeze({ status: "committed" as const, value });
      } finally {
        await releaseLeaseLock(lock);
      }
    });
  }

  /**
   * Child-process fence which deliberately needs no leaseId or ownerId over
   * IPC. The fencing token is monotonic and checked under the same file lock
   * that serializes successor claims with the complete durable operation.
   */
  async runIfFencingTokenCurrent<T>(
    runId: string,
    fencingToken: number,
    operation: () => Promise<T>,
  ): Promise<ExecutionLeaseCommitResult<T>> {
    const normalizedRunId = identifier(runId, "runId");
    const normalizedToken = positiveInteger(fencingToken, "fencingToken");
    if (typeof operation !== "function") throw new TypeError("operation must be a function");
    return this.#runExclusive(async () => {
      const lock = await acquireLeaseLock(`${this.#location.path}.lock`, this.#location.parent);
      try {
        const state = await readSnapshot(this.#location.path);
        const observed = observeTime(state, normalizedRunId, this.#clock);
        const current = liveLease(state, normalizedRunId, observed.nowMs);
        if (current === undefined || current.value.fencingToken !== normalizedToken) {
          await writeSnapshot(this.#location, state);
          return Object.freeze({ status: "lost" as const });
        }
        let value: T;
        try {
          value = await operation();
        } finally {
          await writeSnapshot(this.#location, state);
        }
        return Object.freeze({ status: "committed" as const, value });
      } finally {
        await releaseLeaseLock(lock);
      }
    });
  }

  async release(input: ExecutionLeaseRelease): Promise<ExecutionLeaseReleaseResult> {
    const release = validateRelease(input);
    return this.#runExclusive(() => this.#withSnapshot((state) => releaseNow(
      state,
      release,
      this.#clock,
    )));
  }

  async inspect(runId: string): Promise<ExecutionLeaseStatus | undefined> {
    const normalizedRunId = identifier(runId, "runId");
    return this.#runExclusive(() => this.#withSnapshot((state) => {
      const observed = observeTime(state, normalizedRunId, this.#clock);
      const current = liveLease(state, normalizedRunId, observed.nowMs);
      return current === undefined ? undefined : immutableStatus(current.value);
    }));
  }

  async #withSnapshot<T>(operation: (state: MutableSnapshot) => T): Promise<T> {
    const lock = await acquireLeaseLock(`${this.#location.path}.lock`, this.#location.parent);
    try {
      const state = await readSnapshot(this.#location.path);
      let result: T | undefined;
      let failure: unknown;
      let failed = false;
      try {
        result = operation(state);
      } catch (error: unknown) {
        failed = true;
        failure = error;
      }
      // Clock observations are durable even when a later protocol check fails;
      // otherwise a restart could make a regressed wall clock look fresh again.
      await writeSnapshot(this.#location, state);
      if (failed) throw failure;
      return result as T;
    } finally {
      await releaseLeaseLock(lock);
    }
  }

  #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

interface MutableSnapshot {
  active: Map<string, StoredLease>;
  fencingHighWatermarks: Map<string, number>;
  timeHighWatermarks: Map<string, number>;
  claimReceipts: Map<string, Map<string, ClaimReceipt>>;
  mutationReceipts: Map<string, Map<string, MutationReceipt>>;
  issuedLeaseIds: Set<string>;
}

function emptyMutableSnapshot(): MutableSnapshot {
  return {
    active: new Map(),
    fencingHighWatermarks: new Map(),
    timeHighWatermarks: new Map(),
    claimReceipts: new Map(),
    mutationReceipts: new Map(),
    issuedLeaseIds: new Set(),
  };
}

async function readSnapshot(path: string): Promise<MutableSnapshot> {
  let handle: FileHandle | undefined;
  try {
    handle = await openNoFollow(path, constants.O_RDONLY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyMutableSnapshot();
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new ExecutionLeaseSnapshotError(`Refusing symbolic-link lease snapshot: ${path}`);
    }
    throw error;
  }
  try {
    await assertRegularFile(handle, path, true);
    const contents = await handle.readFile("utf8");
    if (contents.trim().length === 0) return emptyMutableSnapshot();
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new ExecutionLeaseSnapshotError(`Invalid lease snapshot JSON: ${String(error)}`);
    }
    return decodeSnapshot(parsed);
  } finally {
    await handle.close();
  }
}

async function writeSnapshot(location: Location, state: MutableSnapshot): Promise<void> {
  const parent = await assertRealDirectory(location.parent);
  if (parent !== location.parent) {
    throw new ExecutionLeaseSnapshotError("Lease snapshot parent identity changed");
  }
  const temporaryPath = `${location.path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await openNoFollow(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  let writeError: unknown;
  try {
    const bytes = Buffer.from(`${JSON.stringify(encodeSnapshot(state))}\n`, "utf8");
    let written = 0;
    while (written < bytes.byteLength) {
      const result = await handle.write(bytes, written, bytes.byteLength - written, written);
      if (result.bytesWritten === 0) {
        throw new ExecutionLeaseSnapshotError("Lease snapshot write made no progress");
      }
      written += result.bytesWritten;
    }
    await handle.sync();
  } catch (error: unknown) {
    writeError = error;
  } finally {
    await handle.close();
  }
  if (writeError !== undefined) {
    await unlink(temporaryPath).catch(() => undefined);
    throw writeError;
  }
  try {
    await rename(temporaryPath, location.path);
    await syncDirectory(location.parent);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function acquireLeaseLock(path: string, parent: string): Promise<FileLock> {
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
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      let existing: { owner: LockOwner; handle: FileHandle };
      try {
        existing = await readLeaseLockOwner(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      try {
        if (existing.owner.hostname !== owner.hostname || isProcessAlive(existing.owner.pid)) {
          if (attempt + 1 >= LOCK_RETRY_ATTEMPTS) {
            throw new ExecutionLeaseStoreLockedError(
              `Lease store is locked (pid ${existing.owner.pid})`,
            );
          }
          await delay(LOCK_RETRY_DELAY_MS);
          continue;
        }
        if (await sameFile(path, existing.handle)) {
          await unlink(path);
          await syncDirectory(parent);
        }
      } finally {
        await existing.handle.close();
      }
    }
    throw new ExecutionLeaseStoreLockedError("Could not acquire the lease store lock");
  } catch (error) {
    await claim.close();
    await unlink(claimPath).catch(() => undefined);
    throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readLeaseLockOwner(path: string): Promise<{
  owner: LockOwner;
  handle: FileHandle;
}> {
  let handle: FileHandle;
  try {
    handle = await openNoFollow(path, constants.O_RDONLY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new ExecutionLeaseStoreLockedError(`Refusing symbolic-link lease lock: ${path}`);
    }
    throw error;
  }
  try {
    await assertRegularFile(handle, path);
    const parsed = JSON.parse(await handle.readFile("utf8")) as Partial<LockOwner>;
    if (
      parsed.version !== 1
      || !Number.isSafeInteger(parsed.pid)
      || (parsed.pid as number) < 1
      || typeof parsed.hostname !== "string"
      || parsed.hostname.length === 0
      || typeof parsed.token !== "string"
      || parsed.token.length === 0
    ) {
      throw new ExecutionLeaseStoreLockedError(`Invalid lease store lock: ${path}`);
    }
    return { owner: parsed as LockOwner, handle };
  } catch (error) {
    await handle.close();
    if (error instanceof ExecutionLeaseStoreLockedError) throw error;
    throw new ExecutionLeaseStoreLockedError(`Invalid lease store lock: ${path}`);
  }
}

async function releaseLeaseLock(lock: FileLock): Promise<void> {
  try {
    if (await sameFile(lock.path, lock.handle)) {
      await unlink(lock.path);
      await syncDirectory(lock.parent);
    }
  } finally {
    await lock.handle.close();
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function sameFile(path: string, handle: FileHandle): Promise<boolean> {
  try {
    const [pathInfo, handleInfo] = await Promise.all([lstat(path), handle.stat()]);
    return pathInfo.dev === handleInfo.dev && pathInfo.ino === handleInfo.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function claimNow(
  state: MutableSnapshot,
  input: ExecutionLeaseClaim,
  clock: Clock,
  createLeaseId: () => string,
): ExecutionLeaseClaimResult {
  const observed = observeTime(state, input.runId, clock);
  const current = liveLease(state, input.runId, observed.nowMs);
  const receipt = state.claimReceipts.get(input.runId)?.get(input.acquisitionId);
  if (receipt !== undefined) {
    if (receipt.ownerId !== input.ownerId || receipt.ttlMs !== input.ttlMs) {
      throw new ExecutionLeaseProtocolError("acquisitionId was reused with different input");
    }
    if (receipt.result.status !== "acquired") return immutableClaimResult(receipt.result);
    if (current !== undefined && sameIdentity(current.value, receipt.result.lease)) {
      return immutableClaimResult(receipt.result);
    }
    return immutableClaimResult({ status: "stale" });
  }
  if (current !== undefined) {
    const result = immutableClaimResult({ status: "held", holder: immutableStatus(current.value) });
    storeClaimReceipt(state, input, result);
    return immutableClaimResult(result);
  }
  if (observed.regressed) {
    const result = immutableClaimResult({ status: "clock-regressed" });
    storeClaimReceipt(state, input, result);
    return result;
  }
  const previousToken = state.fencingHighWatermarks.get(input.runId) ?? 0;
  if (previousToken >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`fencing token exhausted for Run ${input.runId}`);
  }
  const fencingToken = previousToken + 1;
  const leaseId = identifier(createLeaseId(), "generated leaseId");
  if (state.issuedLeaseIds.has(leaseId)) {
    throw new ExecutionLeaseProtocolError("lease ID generator returned a duplicate value");
  }
  const expiresAtMs = expiration(observed.nowMs, input.ttlMs);
  const timestamp = iso(observed.nowMs);
  const lease = immutableLease({
    runId: input.runId,
    ownerId: input.ownerId,
    acquisitionId: input.acquisitionId,
    leaseId,
    fencingToken,
    acquiredAt: timestamp,
    renewedAt: timestamp,
    expiresAt: iso(expiresAtMs),
  });
  const result = immutableClaimResult({ status: "acquired", lease });
  state.active.set(input.runId, { value: lease, expiresAtMs });
  state.fencingHighWatermarks.set(input.runId, fencingToken);
  state.issuedLeaseIds.add(leaseId);
  storeClaimReceipt(state, input, result);
  return immutableClaimResult(result);
}

function renewNow(
  state: MutableSnapshot,
  input: ExecutionLeaseRenewal,
  clock: Clock,
): ExecutionLeaseRenewResult {
  const receipt = state.mutationReceipts.get(input.runId)?.get(input.commandId);
  if (receipt !== undefined) {
    assertRenewalReceipt(receipt, input);
    if (receipt.result.status !== "lost") {
      const observed = observeTime(state, input.runId, clock);
      const current = liveLease(state, input.runId, observed.nowMs);
      if (current === undefined || !sameIdentity(current.value, input)) return LOST_RENEWAL;
    }
    return immutableRenewResult(receipt.result);
  }
  const observed = observeTime(state, input.runId, clock);
  const current = liveLease(state, input.runId, observed.nowMs);
  if (current === undefined || !sameIdentity(current.value, input)) {
    storeMutationReceipt(state, input.runId, input.commandId, {
      kind: "renew", ownerId: input.ownerId, leaseId: input.leaseId,
      fencingToken: input.fencingToken, ttlMs: input.ttlMs, result: LOST_RENEWAL,
    });
    return LOST_RENEWAL;
  }
  if (observed.regressed) {
    const result: ExecutionLeaseRenewResult = Object.freeze({
      status: "clock-regressed", lease: immutableLease(current.value),
    });
    storeMutationReceipt(state, input.runId, input.commandId, {
      kind: "renew", ownerId: input.ownerId, leaseId: input.leaseId,
      fencingToken: input.fencingToken, ttlMs: input.ttlMs, result,
    });
    return immutableRenewResult(result);
  }
  const expiresAtMs = Math.max(current.expiresAtMs, expiration(observed.nowMs, input.ttlMs));
  const renewed = immutableLease({
    ...current.value,
    renewedAt: iso(observed.nowMs),
    expiresAt: iso(expiresAtMs),
  });
  state.active.set(input.runId, { value: renewed, expiresAtMs });
  const result: ExecutionLeaseRenewResult = Object.freeze({
    status: "renewed", lease: immutableLease(renewed),
  });
  storeMutationReceipt(state, input.runId, input.commandId, {
    kind: "renew", ownerId: input.ownerId, leaseId: input.leaseId,
    fencingToken: input.fencingToken, ttlMs: input.ttlMs, result,
  });
  return immutableRenewResult(result);
}

function releaseNow(
  state: MutableSnapshot,
  input: ExecutionLeaseRelease,
  clock: Clock,
): ExecutionLeaseReleaseResult {
  const receipt = state.mutationReceipts.get(input.runId)?.get(input.commandId);
  if (receipt !== undefined) {
    assertReleaseReceipt(receipt, input);
    return receipt.result;
  }
  const observed = observeTime(state, input.runId, clock);
  const current = liveLease(state, input.runId, observed.nowMs);
  const result = current !== undefined && sameIdentity(current.value, input)
    ? RELEASED
    : LOST_RELEASE;
  if (result.status === "released") state.active.delete(input.runId);
  storeMutationReceipt(state, input.runId, input.commandId, {
    kind: "release", ownerId: input.ownerId, leaseId: input.leaseId,
    fencingToken: input.fencingToken, result,
  });
  return result;
}

function observeTime(state: MutableSnapshot, runId: string, clock: Clock): ObservedTime {
  const raw = clock.now();
  if (!(raw instanceof Date) || !Number.isFinite(raw.getTime())) {
    throw new ExecutionLeaseProtocolError("clock returned an invalid Date");
  }
  const rawMs = raw.getTime();
  const previous = state.timeHighWatermarks.get(runId);
  if (previous !== undefined && rawMs < previous) return { nowMs: previous, regressed: true };
  state.timeHighWatermarks.set(runId, rawMs);
  return { nowMs: rawMs, regressed: false };
}

function liveLease(state: MutableSnapshot, runId: string, nowMs: number): StoredLease | undefined {
  const current = state.active.get(runId);
  if (current === undefined) return undefined;
  if (current.expiresAtMs > nowMs) return current;
  state.active.delete(runId);
  return undefined;
}

function storeClaimReceipt(
  state: MutableSnapshot,
  input: ExecutionLeaseClaim,
  result: ExecutionLeaseClaimResult,
): void {
  let receipts = state.claimReceipts.get(input.runId);
  if (receipts === undefined) {
    receipts = new Map();
    state.claimReceipts.set(input.runId, receipts);
  }
  receipts.set(input.acquisitionId, {
    ownerId: input.ownerId,
    ttlMs: input.ttlMs,
    result: immutableClaimResult(result),
  });
}

function storeMutationReceipt(
  state: MutableSnapshot,
  runId: string,
  commandId: string,
  receipt: MutationReceipt,
): void {
  let receipts = state.mutationReceipts.get(runId);
  if (receipts === undefined) {
    receipts = new Map();
    state.mutationReceipts.set(runId, receipts);
  }
  receipts.set(commandId, Object.freeze(receipt));
}

function assertRenewalReceipt(
  receipt: MutationReceipt,
  input: ExecutionLeaseRenewal,
): asserts receipt is Extract<MutationReceipt, { kind: "renew" }> {
  if (
    receipt.kind !== "renew"
    || receipt.ownerId !== input.ownerId
    || receipt.leaseId !== input.leaseId
    || receipt.fencingToken !== input.fencingToken
    || receipt.ttlMs !== input.ttlMs
  ) throw new ExecutionLeaseProtocolError("commandId was reused with different input");
}

function assertReleaseReceipt(
  receipt: MutationReceipt,
  input: ExecutionLeaseRelease,
): asserts receipt is Extract<MutationReceipt, { kind: "release" }> {
  if (
    receipt.kind !== "release"
    || receipt.ownerId !== input.ownerId
    || receipt.leaseId !== input.leaseId
    || receipt.fencingToken !== input.fencingToken
  ) throw new ExecutionLeaseProtocolError("commandId was reused with different input");
}

function encodeSnapshot(state: MutableSnapshot): LeaseSnapshot {
  const active: Record<string, StoredLease> = Object.create(null) as Record<string, StoredLease>;
  for (const [runId, value] of state.active) active[runId] = value;
  const fencingHighWatermarks: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [runId, value] of state.fencingHighWatermarks) fencingHighWatermarks[runId] = value;
  const timeHighWatermarks: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [runId, value] of state.timeHighWatermarks) timeHighWatermarks[runId] = value;
  const claimReceipts: Record<string, Record<string, ClaimReceipt>> = Object.create(null) as Record<string, Record<string, ClaimReceipt>>;
  for (const [runId, receipts] of state.claimReceipts) {
    claimReceipts[runId] = Object.create(null) as Record<string, ClaimReceipt>;
    for (const [id, receipt] of receipts) claimReceipts[runId]![id] = receipt;
  }
  const mutationReceipts: Record<string, Record<string, MutationReceipt>> = Object.create(null) as Record<string, Record<string, MutationReceipt>>;
  for (const [runId, receipts] of state.mutationReceipts) {
    mutationReceipts[runId] = Object.create(null) as Record<string, MutationReceipt>;
    for (const [id, receipt] of receipts) mutationReceipts[runId]![id] = receipt;
  }
  return {
    version: 1,
    active,
    fencingHighWatermarks,
    timeHighWatermarks,
    claimReceipts,
    mutationReceipts,
    issuedLeaseIds: [...state.issuedLeaseIds].sort(),
  };
}

function decodeSnapshot(value: unknown): MutableSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionLeaseSnapshotError("Lease snapshot must be an object");
  }
  const candidate = value as Partial<LeaseSnapshot>;
  if (candidate.version !== 1) throw new ExecutionLeaseSnapshotError("Unsupported lease snapshot version");
  const state = emptyMutableSnapshot();
  decodeRecord(candidate.active, "active", (runId, stored) => {
    state.active.set(runId, decodeStoredLease(runId, stored));
  });
  decodeRecord(candidate.fencingHighWatermarks, "fencingHighWatermarks", (runId, token) => {
    state.fencingHighWatermarks.set(runId, safePositive(token, "fencing token"));
  });
  decodeRecord(candidate.timeHighWatermarks, "timeHighWatermarks", (runId, timestamp) => {
    state.timeHighWatermarks.set(runId, safeDateMs(timestamp, "time high watermark"));
  });
  decodeRecord(candidate.claimReceipts, "claimReceipts", (runId, receipts) => {
    if (receipts === null || typeof receipts !== "object" || Array.isArray(receipts)) {
      throw new ExecutionLeaseSnapshotError(`Invalid claim receipts for ${runId}`);
    }
    const map = new Map<string, ClaimReceipt>();
    for (const [id, receipt] of Object.entries(receipts as Record<string, unknown>)) {
      const parsed = decodeClaimReceipt(receipt);
      map.set(identifier(id, "acquisitionId"), parsed);
    }
    state.claimReceipts.set(identifier(runId, "runId"), map);
  });
  decodeRecord(candidate.mutationReceipts, "mutationReceipts", (runId, receipts) => {
    if (receipts === null || typeof receipts !== "object" || Array.isArray(receipts)) {
      throw new ExecutionLeaseSnapshotError(`Invalid mutation receipts for ${runId}`);
    }
    const map = new Map<string, MutationReceipt>();
    for (const [id, receipt] of Object.entries(receipts as Record<string, unknown>)) {
      map.set(identifier(id, "commandId"), decodeMutationReceipt(receipt));
    }
    state.mutationReceipts.set(identifier(runId, "runId"), map);
  });
  if (!Array.isArray(candidate.issuedLeaseIds)) {
    throw new ExecutionLeaseSnapshotError("Invalid issuedLeaseIds");
  }
  for (const leaseId of candidate.issuedLeaseIds) {
    state.issuedLeaseIds.add(identifier(leaseId, "leaseId"));
  }
  validateSnapshotConsistency(state);
  return state;
}

function validateSnapshotConsistency(state: MutableSnapshot): void {
  for (const [runId, stored] of state.active) {
    const highWatermark = state.fencingHighWatermarks.get(runId) ?? 0;
    if (highWatermark < stored.value.fencingToken) {
      throw new ExecutionLeaseSnapshotError(`Fencing high watermark is below active lease for ${runId}`);
    }
    if (!state.issuedLeaseIds.has(stored.value.leaseId)) {
      throw new ExecutionLeaseSnapshotError(`Active lease ID is missing from issuedLeaseIds for ${runId}`);
    }
    const timeHighWatermark = state.timeHighWatermarks.get(runId);
    if (timeHighWatermark === undefined || timeHighWatermark < Date.parse(stored.value.renewedAt)) {
      throw new ExecutionLeaseSnapshotError(`Time high watermark is below active lease for ${runId}`);
    }
  }
  for (const [runId, receipts] of state.claimReceipts) {
    for (const [acquisitionId, receipt] of receipts) {
      if (receipt.result.status === "acquired") {
        const lease = receipt.result.lease;
        if (
          lease.runId !== runId
          || lease.ownerId !== receipt.ownerId
          || lease.acquisitionId !== acquisitionId
          || !state.issuedLeaseIds.has(lease.leaseId)
        ) {
          throw new ExecutionLeaseSnapshotError(`Claim receipt lease mismatch for ${runId}`);
        }
        const highWatermark = state.fencingHighWatermarks.get(runId) ?? 0;
        if (highWatermark < lease.fencingToken) {
          throw new ExecutionLeaseSnapshotError(`Claim receipt fence is above high watermark for ${runId}`);
        }
      } else if (receipt.result.status === "held" && receipt.result.holder.runId !== runId) {
        throw new ExecutionLeaseSnapshotError(`Held claim receipt Run mismatch for ${runId}`);
      }
    }
  }
  for (const [runId, receipts] of state.mutationReceipts) {
    for (const receipt of receipts.values()) {
      if (receipt.result.status === "renewed" || receipt.result.status === "clock-regressed") {
        const lease = receipt.result.lease;
        if (lease.runId !== runId || lease.leaseId !== receipt.leaseId || lease.ownerId !== receipt.ownerId || lease.fencingToken !== receipt.fencingToken) {
          throw new ExecutionLeaseSnapshotError(`Mutation receipt lease mismatch for ${runId}`);
        }
        const highWatermark = state.fencingHighWatermarks.get(runId) ?? 0;
        if (highWatermark < lease.fencingToken) {
          throw new ExecutionLeaseSnapshotError(`Mutation receipt fence is above high watermark for ${runId}`);
        }
      }
    }
  }
}

function decodeRecord(
  value: unknown,
  label: string,
  visit: (key: string, value: unknown) => void,
): void {
  if (value === undefined) return;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionLeaseSnapshotError(`Invalid ${label}`);
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    visit(identifier(key, `${label} key`), entry);
  }
}

function decodeStoredLease(runId: string, value: unknown): StoredLease {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionLeaseSnapshotError(`Invalid active lease for ${runId}`);
  }
  const candidate = value as Partial<StoredLease>;
  if (candidate.value === undefined) throw new ExecutionLeaseSnapshotError(`Invalid active lease for ${runId}`);
  const lease = decodeLease(candidate.value);
  if (lease.runId !== runId) throw new ExecutionLeaseSnapshotError("Active lease runId mismatch");
  const expiresAtMs = safeDateMs(candidate.expiresAtMs, "lease expiration");
  if (expiresAtMs !== Date.parse(lease.expiresAt)) {
    throw new ExecutionLeaseSnapshotError("Active lease expiration mismatch");
  }
  return { value: lease, expiresAtMs };
}

function decodeLease(value: unknown): ExecutionLease {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionLeaseSnapshotError("Invalid lease");
  }
  const candidate = value as Partial<ExecutionLease>;
  const acquiredAt = safeDateMs(candidate.acquiredAt, "acquiredAt");
  const renewedAt = safeDateMs(candidate.renewedAt, "renewedAt");
  const expiresAt = safeDateMs(candidate.expiresAt, "expiresAt");
  if (renewedAt < acquiredAt || expiresAt < renewedAt) {
    throw new ExecutionLeaseSnapshotError("Lease timestamps are not monotonic");
  }
  const lease: ExecutionLease = {
    runId: identifier(candidate.runId, "runId"),
    ownerId: identifier(candidate.ownerId, "ownerId"),
    acquisitionId: identifier(candidate.acquisitionId, "acquisitionId"),
    leaseId: identifier(candidate.leaseId, "leaseId"),
    fencingToken: safePositive(candidate.fencingToken, "fencingToken"),
    acquiredAt: iso(acquiredAt),
    renewedAt: iso(renewedAt),
    expiresAt: iso(expiresAt),
  };
  return immutableLease(lease);
}

function decodeClaimReceipt(value: unknown): ClaimReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionLeaseSnapshotError("Invalid claim receipt");
  }
  const candidate = value as Partial<ClaimReceipt>;
  return {
    ownerId: identifier(candidate.ownerId, "ownerId"),
    ttlMs: leaseTtl(candidate.ttlMs),
    result: decodeClaimResult(candidate.result),
  };
}

function decodeClaimResult(value: unknown): ExecutionLeaseClaimResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionLeaseSnapshotError("Invalid claim result");
  }
  const candidate = value as { status?: unknown; lease?: unknown; holder?: unknown };
  if (candidate.status === "acquired") {
    if (candidate.lease === undefined) throw new ExecutionLeaseSnapshotError("Invalid acquired claim result");
    return immutableClaimResult({ status: "acquired", lease: decodeLease(candidate.lease) });
  }
  if (candidate.status === "held") {
    if (candidate.holder === undefined) throw new ExecutionLeaseSnapshotError("Invalid held claim result");
    return immutableClaimResult({ status: "held", holder: decodeStatus(candidate.holder) });
  }
  if (candidate.status === "clock-regressed" || candidate.status === "stale") {
    return immutableClaimResult({ status: candidate.status });
  }
  throw new ExecutionLeaseSnapshotError("Invalid claim result status");
}

function decodeMutationReceipt(value: unknown): MutationReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionLeaseSnapshotError("Invalid mutation receipt");
  }
  const candidate = value as Partial<MutationReceipt>;
  const kind = candidate.kind;
  if (kind !== "renew" && kind !== "release") throw new ExecutionLeaseSnapshotError("Invalid mutation receipt kind");
  const common = {
    ownerId: identifier(candidate.ownerId, "ownerId"),
    leaseId: identifier(candidate.leaseId, "leaseId"),
    fencingToken: safePositive(candidate.fencingToken, "fencingToken"),
  };
  if (kind === "renew") {
    return {
      kind,
      ...common,
      ttlMs: leaseTtl(candidate.ttlMs),
      result: decodeRenewResult(candidate.result),
    };
  }
  return { kind, ...common, result: decodeReleaseResult(candidate.result) };
}

function decodeRenewResult(value: unknown): ExecutionLeaseRenewResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionLeaseSnapshotError("Invalid renewal result");
  }
  const candidate = value as { status?: unknown; lease?: unknown };
  if (candidate.status === "lost") return LOST_RENEWAL;
  if (candidate.status === "renewed" || candidate.status === "clock-regressed") {
    if (candidate.lease === undefined) throw new ExecutionLeaseSnapshotError("Invalid renewal lease");
    return immutableRenewResult({ status: candidate.status, lease: decodeLease(candidate.lease) });
  }
  throw new ExecutionLeaseSnapshotError("Invalid renewal result status");
}

function decodeReleaseResult(value: unknown): ExecutionLeaseReleaseResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionLeaseSnapshotError("Invalid release result");
  }
  const status = (value as { status?: unknown }).status;
  if (status === "released") return RELEASED;
  if (status === "lost") return LOST_RELEASE;
  throw new ExecutionLeaseSnapshotError("Invalid release result status");
}

function decodeStatus(value: unknown): ExecutionLeaseStatus {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionLeaseSnapshotError("Invalid lease status");
  }
  const candidate = value as Partial<ExecutionLeaseStatus>;
  return immutableStatus({
    runId: identifier(candidate.runId, "runId"),
    ownerId: identifier(candidate.ownerId, "ownerId"),
    fencingToken: safePositive(candidate.fencingToken, "fencingToken"),
    acquiredAt: iso(safeDateMs(candidate.acquiredAt, "acquiredAt")),
    renewedAt: iso(safeDateMs(candidate.renewedAt, "renewedAt")),
    expiresAt: iso(safeDateMs(candidate.expiresAt, "expiresAt")),
  });
}

function validateClaim(input: ExecutionLeaseClaim): ExecutionLeaseClaim {
  object(input, "claim");
  return Object.freeze({
    runId: identifier(input.runId, "runId"),
    ownerId: identifier(input.ownerId, "ownerId"),
    acquisitionId: identifier(input.acquisitionId, "acquisitionId"),
    ttlMs: leaseTtl(input.ttlMs),
  });
}

function validateRenewal(input: ExecutionLeaseRenewal): ExecutionLeaseRenewal {
  object(input, "renewal");
  return Object.freeze({
    ...validateIdentity(input),
    commandId: identifier(input.commandId, "commandId"),
    ttlMs: leaseTtl(input.ttlMs),
  });
}

function validateRelease(input: ExecutionLeaseRelease): ExecutionLeaseRelease {
  object(input, "release");
  return Object.freeze({ ...validateIdentity(input), commandId: identifier(input.commandId, "commandId") });
}

function validateIdentity(input: ExecutionLeaseIdentity): ExecutionLeaseIdentity {
  object(input, "lease identity");
  return Object.freeze({
    runId: identifier(input.runId, "runId"),
    ownerId: identifier(input.ownerId, "ownerId"),
    leaseId: identifier(input.leaseId, "leaseId"),
    fencingToken: positiveInteger(input.fencingToken, "fencingToken"),
  });
}

function validateClock(clock: Clock | undefined): void {
  if (clock !== undefined && (typeof clock !== "object" || clock === null || typeof clock.now !== "function")) {
    throw new TypeError("clock must provide now()");
  }
}

function object(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty, trimmed string without NUL`);
  }
  return value;
}

function safePositive(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new ExecutionLeaseSnapshotError(`Invalid ${label}`);
  return value;
}

function leaseTtl(value: unknown): number {
  const ttlMs = positiveInteger(value, "ttlMs");
  if (ttlMs > MAX_EXECUTION_LEASE_TTL_MS) {
    throw new RangeError(`ttlMs must not exceed ${MAX_EXECUTION_LEASE_TTL_MS}`);
  }
  return ttlMs;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function safeDateMs(value: unknown, label: string): number {
  const milliseconds = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < -8_640_000_000_000_000 || milliseconds > 8_640_000_000_000_000) {
    throw new ExecutionLeaseSnapshotError(`Invalid ${label}`);
  }
  return milliseconds;
}

function expiration(nowMs: number, ttlMs: number): number {
  const expiresAtMs = nowMs + ttlMs;
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs > 8_640_000_000_000_000) throw new RangeError("lease expiration exceeds the supported Date range");
  return expiresAtMs;
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function sameIdentity(lease: ExecutionLease, identity: ExecutionLeaseIdentity): boolean {
  return lease.runId === identity.runId && lease.ownerId === identity.ownerId && lease.leaseId === identity.leaseId && lease.fencingToken === identity.fencingToken;
}

function immutableLease(lease: ExecutionLease): ExecutionLease { return Object.freeze({ ...lease }); }

function immutableStatus(
  lease: Pick<ExecutionLease, "runId" | "ownerId" | "fencingToken" | "acquiredAt" | "renewedAt" | "expiresAt">,
): ExecutionLeaseStatus {
  return Object.freeze({
    runId: lease.runId,
    ownerId: lease.ownerId,
    fencingToken: lease.fencingToken,
    acquiredAt: lease.acquiredAt,
    renewedAt: lease.renewedAt,
    expiresAt: lease.expiresAt,
  });
}

function immutableClaimResult(result: ExecutionLeaseClaimResult): ExecutionLeaseClaimResult {
  if (result.status === "acquired") return Object.freeze({ status: "acquired", lease: immutableLease(result.lease) });
  if (result.status === "held") return Object.freeze({ status: "held", holder: Object.freeze({ ...result.holder }) });
  return Object.freeze({ status: result.status });
}

function immutableRenewResult(result: ExecutionLeaseRenewResult): ExecutionLeaseRenewResult {
  if (result.status === "lost") return LOST_RENEWAL;
  return Object.freeze({ status: result.status, lease: immutableLease(result.lease) });
}
