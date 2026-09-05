import { randomUUID } from "node:crypto";

import {
  MAX_EXECUTION_LEASE_TTL_MS,
  type ExecutionLease,
  type ExecutionLeaseClaimResult,
  type ExecutionLeaseStore,
} from "./execution-lease.js";

export const MIN_LEASED_BACKGROUND_JOB_TTL_MS = 20;

export interface LeasedBackgroundJobContext {
  readonly jobId: string;
  readonly lease: ExecutionLease;
  readonly signal: AbortSignal;
}

export interface LeasedBackgroundJobHeld {
  readonly status: "held";
  readonly holder: NonNullable<Extract<ExecutionLeaseClaimResult, { status: "held" }>["holder"]>;
}

export interface LeasedBackgroundJobLost {
  readonly status: "lost" | "cancelled";
  readonly reason?: string;
}

export type LeasedBackgroundJobOutcome<T> =
  | Readonly<{ status: "completed"; value: T }>
  | LeasedBackgroundJobHeld
  | LeasedBackgroundJobLost;

export interface LeasedBackgroundJobRunnerOptions {
  readonly leaseStore: ExecutionLeaseStore;
  /** Namespace used to isolate job leases from Run execution leases. */
  readonly namespace: string;
  readonly ownerId: string;
  readonly ttlMs: number;
  readonly createAcquisitionId?: () => string;
}

/**
 * Runs one asynchronous background job under a renewable execution lease.
 * Handlers should use `lease` as their durable commit fence; the runner also
 * fences the returned value before reporting completion.
 */
export class LeasedBackgroundJobRunner {
  readonly #leaseStore: ExecutionLeaseStore;
  readonly #namespace: string;
  readonly #ownerId: string;
  readonly #ttlMs: number;
  readonly #createAcquisitionId: () => string;

  constructor(options: LeasedBackgroundJobRunnerOptions) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("options must be an object");
    }
    if (
      options.leaseStore === null
      || typeof options.leaseStore !== "object"
      || typeof options.leaseStore.claim !== "function"
      || typeof options.leaseStore.renew !== "function"
      || typeof options.leaseStore.runIfCurrent !== "function"
      || typeof options.leaseStore.release !== "function"
    ) {
      throw new TypeError("leaseStore must provide the execution lease methods");
    }
    if (typeof options.namespace !== "string" || options.namespace.trim().length === 0) {
      throw new TypeError("namespace must be a non-empty string");
    }
    if (typeof options.ownerId !== "string" || options.ownerId.trim().length === 0) {
      throw new TypeError("ownerId must be a non-empty string");
    }
    if (
      !Number.isSafeInteger(options.ttlMs)
      || options.ttlMs < MIN_LEASED_BACKGROUND_JOB_TTL_MS
      || options.ttlMs > MAX_EXECUTION_LEASE_TTL_MS
    ) {
      throw new RangeError(
        `ttlMs must be an integer between ${MIN_LEASED_BACKGROUND_JOB_TTL_MS} and ${MAX_EXECUTION_LEASE_TTL_MS}`,
      );
    }
    if (options.createAcquisitionId !== undefined && typeof options.createAcquisitionId !== "function") {
      throw new TypeError("createAcquisitionId must be a function");
    }
    this.#leaseStore = options.leaseStore;
    this.#namespace = options.namespace;
    this.#ownerId = options.ownerId;
    this.#ttlMs = options.ttlMs;
    this.#createAcquisitionId = options.createAcquisitionId ?? randomUUID;
  }

  async run<T>(
    jobId: string,
    handler: (context: LeasedBackgroundJobContext) => Promise<T>,
    options: { signal?: AbortSignal; acquisitionId?: string } = {},
  ): Promise<LeasedBackgroundJobOutcome<T>> {
    if (typeof jobId !== "string" || jobId.trim().length === 0) {
      throw new TypeError("jobId must be a non-empty string");
    }
    if (typeof handler !== "function") throw new TypeError("handler must be a function");
    const signal = options.signal;
    if (signal?.aborted === true) {
      const reason = reasonText(signal.reason);
      return reason === undefined
        ? { status: "cancelled" }
        : { status: "cancelled", reason };
    }
    const runId = `${this.#namespace}:job:${jobId}`;
    const acquisitionId = options.acquisitionId ?? this.#createAcquisitionId();
    const claim = await this.#leaseStore.claim({
      runId,
      ownerId: this.#ownerId,
      acquisitionId,
      ttlMs: this.#ttlMs,
    });
    if (claim.status !== "acquired") {
      return claim.status === "held"
        ? { status: "held", holder: claim.holder }
        : { status: "lost", reason: claim.status };
    }

    let lease = claim.lease;
    const controller = new AbortController();
    let parentCancelled = false;
    const abortFromParent = (): void => {
      parentCancelled = true;
      controller.abort(signal?.reason);
    };
    if (isAborted(signal)) abortFromParent();
    else signal?.addEventListener("abort", abortFromParent, { once: true });
    let lost = false;
    let renewalSequence = 0;
    let renewalTail: Promise<void> = Promise.resolve();
    const renewalInterval = Math.max(10, Math.floor(this.#ttlMs / 2));
    const renewalTimer = setInterval(() => {
      renewalTail = renewalTail.then(async () => {
        if (lost || controller.signal.aborted) return;
        const renewed = await this.#leaseStore.renew({
          runId: lease.runId,
          ownerId: lease.ownerId,
          leaseId: lease.leaseId,
          fencingToken: lease.fencingToken,
          commandId: `renew:${acquisitionId}:${++renewalSequence}`,
          ttlMs: this.#ttlMs,
        });
        if (renewed.status === "renewed") {
          lease = renewed.lease;
          return;
        }
        lost = true;
        controller.abort(new Error("Background job lease lost"));
      }).catch(() => {
        lost = true;
        controller.abort(new Error("Background job lease renewal failed"));
      });
    }, renewalInterval);
    renewalTimer.unref?.();
    try {
      let value: T;
      try {
        value = await handler({ jobId, lease, signal: controller.signal });
      } catch (error: unknown) {
        await renewalTail;
        const interrupted = interruptedOutcome(controller.signal, parentCancelled, lost);
        if (interrupted !== undefined) return interrupted;
        throw error;
      }
      await renewalTail;
      const interrupted = interruptedOutcome(controller.signal, parentCancelled, lost);
      if (interrupted !== undefined) return interrupted;
      const committed = await this.#leaseStore.runIfCurrent(lease, async () => value);
      if (committed.status === "lost") return { status: "lost", reason: "lease lost before completion" };
      return { status: "completed", value: committed.value };
    } finally {
      clearInterval(renewalTimer);
      await renewalTail;
      signal?.removeEventListener("abort", abortFromParent);
      await this.#leaseStore.release({
        runId: lease.runId,
        ownerId: lease.ownerId,
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
        commandId: `release:${acquisitionId}`,
      }).catch(() => undefined);
    }
  }
}

function reasonText(reason: unknown): string | undefined {
  if (reason === undefined) return undefined;
  return reason instanceof Error ? reason.message : String(reason);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function interruptedOutcome(
  signal: AbortSignal,
  parentCancelled: boolean,
  lost: boolean,
): LeasedBackgroundJobLost | undefined {
  if (!lost && !signal.aborted) return undefined;
  const status = parentCancelled ? "cancelled" : "lost";
  const reason = reasonText(signal.reason);
  return reason === undefined ? { status } : { status, reason };
}
