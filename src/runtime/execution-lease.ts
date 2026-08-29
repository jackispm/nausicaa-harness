import { randomUUID } from "node:crypto";

import type { Clock } from "../domain/index.js";
import { systemClock } from "../domain/index.js";

export interface ExecutionLease {
  readonly runId: string;
  readonly ownerId: string;
  readonly acquisitionId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly acquiredAt: string;
  readonly renewedAt: string;
  readonly expiresAt: string;
}

/** Read-only holder metadata. It intentionally omits the actionable leaseId. */
export type ExecutionLeaseStatus = Readonly<Omit<
  ExecutionLease,
  "acquisitionId" | "leaseId"
>>;

export interface ExecutionLeaseClaim {
  readonly runId: string;
  readonly ownerId: string;
  /** Caller-generated, unguessable idempotency key for one acquisition attempt. */
  readonly acquisitionId: string;
  readonly ttlMs: number;
}

export interface ExecutionLeaseIdentity {
  readonly runId: string;
  readonly ownerId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
}

export interface ExecutionLeaseRenewal extends ExecutionLeaseIdentity {
  /** Stable idempotency key for this renewal command. */
  readonly commandId: string;
  readonly ttlMs: number;
}

export interface ExecutionLeaseRelease extends ExecutionLeaseIdentity {
  /** Stable idempotency key for this release command. */
  readonly commandId: string;
}

export type ExecutionLeaseClaimResult =
  | Readonly<{ status: "acquired"; lease: ExecutionLease }>
  | Readonly<{ status: "held"; holder: ExecutionLeaseStatus }>
  | Readonly<{ status: "clock-regressed" }>
  | Readonly<{ status: "stale" }>;

export type ExecutionLeaseRenewResult =
  | Readonly<{ status: "renewed"; lease: ExecutionLease }>
  | Readonly<{ status: "clock-regressed"; lease: ExecutionLease }>
  | Readonly<{ status: "lost" }>;

export type ExecutionLeaseReleaseResult =
  | Readonly<{ status: "released" }>
  | Readonly<{ status: "lost" }>;

export type ExecutionLeaseCommitResult<T> =
  | Readonly<{ status: "committed"; value: T }>
  | Readonly<{ status: "lost" }>;

/** Operational execution authority only; durable Run state remains elsewhere. */
export interface ExecutionLeaseStore {
  claim(input: ExecutionLeaseClaim): Promise<ExecutionLeaseClaimResult>;
  renew(input: ExecutionLeaseRenewal): Promise<ExecutionLeaseRenewResult>;
  /**
   * Checks this store only. Callers must use `runIfCurrent` for a durable
   * mutation because verify-then-append is not an atomic fence.
   */
  verify(input: ExecutionLeaseIdentity): Promise<boolean>;
  /**
   * Run one durable commit while the lease identity is still current. The
   * implementation must serialize takeover with the complete async operation,
   * not merely verify before invoking it.
   */
  runIfCurrent<T>(
    input: ExecutionLeaseIdentity,
    operation: () => Promise<T>,
  ): Promise<ExecutionLeaseCommitResult<T>>;
  release(input: ExecutionLeaseRelease): Promise<ExecutionLeaseReleaseResult>;
  inspect(runId: string): Promise<ExecutionLeaseStatus | undefined>;
}

export interface MemoryExecutionLeaseStoreOptions {
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

interface ObservedTime {
  readonly nowMs: number;
  readonly regressed: boolean;
}

const LOST_RENEWAL: ExecutionLeaseRenewResult = Object.freeze({ status: "lost" });
const LOST_RELEASE: ExecutionLeaseReleaseResult = Object.freeze({ status: "lost" });
const RELEASED: ExecutionLeaseReleaseResult = Object.freeze({ status: "released" });
export const MAX_EXECUTION_LEASE_TTL_MS = 5 * 60_000;

/**
 * Single-process reference implementation. All mutations share one async queue
 * so a future file or database adapter can preserve the same atomic contract.
 * Receipts are intentionally retained without GC; do not use this adapter as a
 * long-running daemon backend.
 */
export class MemoryExecutionLeaseStore implements ExecutionLeaseStore {
  private readonly clock: Clock;
  private readonly createLeaseId: () => string;
  private readonly active = new Map<string, StoredLease>();
  private readonly fencingHighWatermarks = new Map<string, number>();
  private readonly timeHighWatermarks = new Map<string, number>();
  private readonly claimReceipts = new Map<string, Map<string, ClaimReceipt>>();
  private readonly mutationReceipts = new Map<string, Map<string, MutationReceipt>>();
  private readonly issuedLeaseIds = new Set<string>();
  private tail: Promise<void> = Promise.resolve();

  constructor(options: MemoryExecutionLeaseStoreOptions = {}) {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new TypeError("options must be an object");
    }
    if (
      options.clock !== undefined
      && (
        typeof options.clock !== "object"
        || options.clock === null
        || typeof options.clock.now !== "function"
      )
    ) {
      throw new TypeError("clock must provide now()");
    }
    if (options.createLeaseId !== undefined && typeof options.createLeaseId !== "function") {
      throw new TypeError("createLeaseId must be a function");
    }
    this.clock = options.clock ?? systemClock;
    this.createLeaseId = options.createLeaseId ?? randomUUID;
  }

  async claim(input: ExecutionLeaseClaim): Promise<ExecutionLeaseClaimResult> {
    const claim = validateClaim(input);
    return this.runExclusive(() => this.claimNow(claim));
  }

  async renew(input: ExecutionLeaseRenewal): Promise<ExecutionLeaseRenewResult> {
    const renewal = validateRenewal(input);
    return this.runExclusive(() => this.renewNow(renewal));
  }

  async verify(input: ExecutionLeaseIdentity): Promise<boolean> {
    const identity = validateIdentity(input);
    return this.runExclusive(() => {
      const { nowMs } = this.observeTime(identity.runId);
      const current = this.liveLease(identity.runId, nowMs);
      return current !== undefined && sameIdentity(current.value, identity);
    });
  }

  async runIfCurrent<T>(
    input: ExecutionLeaseIdentity,
    operation: () => Promise<T>,
  ): Promise<ExecutionLeaseCommitResult<T>> {
    const identity = validateIdentity(input);
    if (typeof operation !== "function") {
      throw new TypeError("operation must be a function");
    }
    return this.runExclusive(async () => {
      const { nowMs } = this.observeTime(identity.runId);
      const current = this.liveLease(identity.runId, nowMs);
      if (current === undefined || !sameIdentity(current.value, identity)) {
        return Object.freeze({ status: "lost" as const });
      }
      const value = await operation();
      return Object.freeze({ status: "committed" as const, value });
    });
  }

  async release(input: ExecutionLeaseRelease): Promise<ExecutionLeaseReleaseResult> {
    const release = validateRelease(input);
    return this.runExclusive(() => this.releaseNow(release));
  }

  async inspect(runId: string): Promise<ExecutionLeaseStatus | undefined> {
    const normalizedRunId = identifier(runId, "runId");
    return this.runExclusive(() => {
      const { nowMs } = this.observeTime(normalizedRunId);
      const current = this.liveLease(normalizedRunId, nowMs);
      return current === undefined ? undefined : immutableStatus(current.value);
    });
  }

  private claimNow(input: ExecutionLeaseClaim): ExecutionLeaseClaimResult {
    const observed = this.observeTime(input.runId);
    const current = this.liveLease(input.runId, observed.nowMs);
    const receipts = this.claimReceipts.get(input.runId);
    const receipt = receipts?.get(input.acquisitionId);
    if (receipt !== undefined) {
      if (receipt.ownerId !== input.ownerId || receipt.ttlMs !== input.ttlMs) {
        throw new ExecutionLeaseProtocolError(
          "acquisitionId was reused with different input",
        );
      }
      if (receipt.result.status !== "acquired") return immutableClaimResult(receipt.result);
      if (current !== undefined && sameIdentity(current.value, receipt.result.lease)) {
        return immutableClaimResult(receipt.result);
      }
      return immutableClaimResult({ status: "stale" });
    }

    if (current !== undefined) {
      const result = immutableClaimResult({
        status: "held",
        holder: immutableStatus(current.value),
      });
      this.storeClaimReceipt(input, result);
      return immutableClaimResult(result);
    }
    if (observed.regressed) {
      const result = immutableClaimResult({ status: "clock-regressed" });
      this.storeClaimReceipt(input, result);
      return result;
    }

    const previousToken = this.fencingHighWatermarks.get(input.runId) ?? 0;
    if (previousToken >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError(`fencing token exhausted for Run ${input.runId}`);
    }
    const fencingToken = previousToken + 1;
    const leaseId = identifier(this.createLeaseId(), "generated leaseId");
    if (this.issuedLeaseIds.has(leaseId)) {
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
    this.active.set(input.runId, { value: lease, expiresAtMs });
    this.fencingHighWatermarks.set(input.runId, fencingToken);
    this.issuedLeaseIds.add(leaseId);
    this.storeClaimReceipt(input, result);
    return immutableClaimResult(result);
  }

  private renewNow(input: ExecutionLeaseRenewal): ExecutionLeaseRenewResult {
    const receipt = this.getMutationReceipt(input.runId, input.commandId);
    if (receipt !== undefined) {
      this.assertRenewalReceipt(receipt, input);
      if (receipt.result.status !== "lost") {
        const { nowMs } = this.observeTime(input.runId);
        const current = this.liveLease(input.runId, nowMs);
        if (current === undefined || !sameIdentity(current.value, input)) {
          return LOST_RENEWAL;
        }
      }
      return immutableRenewResult(receipt.result);
    }
    const observed = this.observeTime(input.runId);
    const current = this.liveLease(input.runId, observed.nowMs);
    if (current === undefined || !sameIdentity(current.value, input)) {
      this.storeMutationReceipt(input.runId, input.commandId, {
        kind: "renew",
        ownerId: input.ownerId,
        leaseId: input.leaseId,
        fencingToken: input.fencingToken,
        ttlMs: input.ttlMs,
        result: LOST_RENEWAL,
      });
      return LOST_RENEWAL;
    }
    if (observed.regressed) {
      const result: ExecutionLeaseRenewResult = Object.freeze({
        status: "clock-regressed",
        lease: immutableLease(current.value),
      });
      this.storeMutationReceipt(input.runId, input.commandId, {
        kind: "renew",
        ownerId: input.ownerId,
        leaseId: input.leaseId,
        fencingToken: input.fencingToken,
        ttlMs: input.ttlMs,
        result,
      });
      return immutableRenewResult(result);
    }

    // A heartbeat may choose a shorter future TTL, but it must never revoke
    // time already granted by an earlier successful renewal receipt.
    const expiresAtMs = Math.max(
      current.expiresAtMs,
      expiration(observed.nowMs, input.ttlMs),
    );
    const renewed = immutableLease({
      ...current.value,
      renewedAt: iso(observed.nowMs),
      expiresAt: iso(expiresAtMs),
    });
    this.active.set(input.runId, { value: renewed, expiresAtMs });
    const result: ExecutionLeaseRenewResult = Object.freeze({
      status: "renewed",
      lease: immutableLease(renewed),
    });
    this.storeMutationReceipt(input.runId, input.commandId, {
      kind: "renew",
      ownerId: input.ownerId,
      leaseId: input.leaseId,
      fencingToken: input.fencingToken,
      ttlMs: input.ttlMs,
      result,
    });
    return immutableRenewResult(result);
  }

  private releaseNow(input: ExecutionLeaseRelease): ExecutionLeaseReleaseResult {
    const receipt = this.getMutationReceipt(input.runId, input.commandId);
    if (receipt !== undefined) {
      this.assertReleaseReceipt(receipt, input);
      return receipt.result;
    }
    const { nowMs } = this.observeTime(input.runId);
    const current = this.liveLease(input.runId, nowMs);
    const result = current !== undefined && sameIdentity(current.value, input)
      ? RELEASED
      : LOST_RELEASE;
    if (result.status === "released") this.active.delete(input.runId);
    this.storeMutationReceipt(input.runId, input.commandId, {
      kind: "release",
      ownerId: input.ownerId,
      leaseId: input.leaseId,
      fencingToken: input.fencingToken,
      result,
    });
    return result;
  }

  private observeTime(runId: string): ObservedTime {
    const raw = this.clock.now();
    if (!(raw instanceof Date) || !Number.isFinite(raw.getTime())) {
      throw new ExecutionLeaseProtocolError("clock returned an invalid Date");
    }
    const rawMs = raw.getTime();
    const previous = this.timeHighWatermarks.get(runId);
    if (previous !== undefined && rawMs < previous) {
      return { nowMs: previous, regressed: true };
    }
    this.timeHighWatermarks.set(runId, rawMs);
    return { nowMs: rawMs, regressed: false };
  }

  private liveLease(runId: string, nowMs: number): StoredLease | undefined {
    const current = this.active.get(runId);
    if (current === undefined) return undefined;
    if (current.expiresAtMs > nowMs) return current;
    this.active.delete(runId);
    return undefined;
  }

  private storeClaimReceipt(
    input: ExecutionLeaseClaim,
    result: ExecutionLeaseClaimResult,
  ): void {
    let receipts = this.claimReceipts.get(input.runId);
    if (receipts === undefined) {
      receipts = new Map();
      this.claimReceipts.set(input.runId, receipts);
    }
    receipts.set(input.acquisitionId, {
      ownerId: input.ownerId,
      ttlMs: input.ttlMs,
      result: immutableClaimResult(result),
    });
  }

  private getMutationReceipt(runId: string, commandId: string): MutationReceipt | undefined {
    return this.mutationReceipts.get(runId)?.get(commandId);
  }

  private storeMutationReceipt(
    runId: string,
    commandId: string,
    receipt: MutationReceipt,
  ): void {
    let receipts = this.mutationReceipts.get(runId);
    if (receipts === undefined) {
      receipts = new Map();
      this.mutationReceipts.set(runId, receipts);
    }
    receipts.set(commandId, Object.freeze(receipt));
  }

  private assertRenewalReceipt(
    receipt: MutationReceipt,
    input: ExecutionLeaseRenewal,
  ): asserts receipt is Extract<MutationReceipt, { kind: "renew" }> {
    if (
      receipt.kind !== "renew"
      || receipt.ownerId !== input.ownerId
      || receipt.leaseId !== input.leaseId
      || receipt.fencingToken !== input.fencingToken
      || receipt.ttlMs !== input.ttlMs
    ) {
      throw new ExecutionLeaseProtocolError(
        "commandId was reused with different input",
      );
    }
  }

  private assertReleaseReceipt(
    receipt: MutationReceipt,
    input: ExecutionLeaseRelease,
  ): asserts receipt is Extract<MutationReceipt, { kind: "release" }> {
    if (
      receipt.kind !== "release"
      || receipt.ownerId !== input.ownerId
      || receipt.leaseId !== input.leaseId
      || receipt.fencingToken !== input.fencingToken
    ) {
      throw new ExecutionLeaseProtocolError(
        "commandId was reused with different input",
      );
    }
  }

  private runExclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class ExecutionLeaseProtocolError extends Error {
  override readonly name: string = "ExecutionLeaseProtocolError";
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
  return Object.freeze({
    ...validateIdentity(input),
    commandId: identifier(input.commandId, "commandId"),
  });
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

function object(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.includes("\0")
  ) {
    throw new TypeError(`${label} must be a non-empty, trimmed string without NUL`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function leaseTtl(value: unknown): number {
  const ttlMs = positiveInteger(value, "ttlMs");
  if (ttlMs > MAX_EXECUTION_LEASE_TTL_MS) {
    throw new RangeError(`ttlMs must not exceed ${MAX_EXECUTION_LEASE_TTL_MS}`);
  }
  return ttlMs;
}

function expiration(nowMs: number, ttlMs: number): number {
  const expiresAtMs = nowMs + ttlMs;
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs > 8_640_000_000_000_000) {
    throw new RangeError("lease expiration exceeds the supported Date range");
  }
  return expiresAtMs;
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function sameIdentity(
  lease: ExecutionLease,
  identity: ExecutionLeaseIdentity,
): boolean {
  return lease.runId === identity.runId
    && lease.ownerId === identity.ownerId
    && lease.leaseId === identity.leaseId
    && lease.fencingToken === identity.fencingToken;
}

function immutableLease(lease: ExecutionLease): ExecutionLease {
  return Object.freeze({ ...lease });
}

function immutableStatus(lease: ExecutionLease): ExecutionLeaseStatus {
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
  if (result.status === "acquired") {
    return Object.freeze({ status: "acquired", lease: immutableLease(result.lease) });
  }
  if (result.status === "held") {
    return Object.freeze({ status: "held", holder: Object.freeze({ ...result.holder }) });
  }
  return Object.freeze({ status: result.status });
}

function immutableRenewResult(result: ExecutionLeaseRenewResult): ExecutionLeaseRenewResult {
  if (result.status === "lost") return LOST_RENEWAL;
  return Object.freeze({ status: result.status, lease: immutableLease(result.lease) });
}
