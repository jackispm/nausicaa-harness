import { randomUUID } from "node:crypto";

import type { ArtifactRef, Clock } from "../domain/index.js";
import { systemClock } from "../domain/index.js";
import {
  MAX_EXECUTION_LEASE_TTL_MS,
  MemoryExecutionLeaseStore,
  type ExecutionLease,
  type ExecutionLeaseStore,
} from "./execution-lease.js";
import { FileExecutionLeaseStore } from "./file-execution-lease.js";
import { persistedErrorText } from "./redaction.js";

/** Sources that may wake a Run. The source is metadata, not a new event type. */
export type DaemonWakeSource =
  | "timer"
  | "webhook"
  | "file"
  | "a2a"
  | "user"
  | "system";

/**
 * A wake request is deliberately small. The adapter which admits it is
 * responsible for converting it into a Ledger-backed input and an Artifact
 * reference when the payload has durable content.
 */
export interface DaemonWakeRequest {
  readonly runId: string;
  readonly source: DaemonWakeSource;
  readonly dedupeKey: string;
  readonly wakeId?: string;
  readonly inputId?: string;
  readonly payloadRef?: ArtifactRef;
  readonly occurredAt?: string;
}

/**
 * A wake whose `input.admitted` fact already exists in the Run Ledger.
 *
 * Recovery uses this narrow shape to requeue durable work without passing
 * through `admitWake` a second time (which would create a new input fact).
 */
export type DaemonRecoveredWakeRequest = Omit<DaemonWakeRequest, "inputId"> & {
  readonly inputId: string;
};

/** Result of the durable wake/input admission boundary. */
export interface DaemonWakeAdmission {
  readonly status: "admitted" | "duplicate";
  readonly inputId: string;
  /**
   * A duplicate normally means the input was already consumed. Adapters may
   * set this when projection shows that the durable input is still pending
   * (for example, after a daemon restart).
   */
  readonly shouldActivate?: boolean;
}

export type DaemonWakeAdmitter = (
  request: DaemonWakeRequest,
) => Promise<DaemonWakeAdmission>;

export interface DaemonActivationRequest {
  readonly runId: string;
  readonly activationId: string;
  /** Wakes admitted before this activation began; later wakes queue another activation. */
  readonly wakes: readonly DaemonWakeRequest[];
  readonly lease: ExecutionLease;
  readonly signal: AbortSignal;
  /**
   * Re-check execution ownership at a non-committing boundary. Durable writes
   * use `commitLease` so takeover and commit are linearized.
   */
  readonly assertLease?: () => Promise<void>;
  /**
   * Commit one durable mutation while takeover is excluded by the lease
   * store. The built-in Host always supplies this atomic fencing seam.
   */
  readonly commitLease?: <T>(operation: () => Promise<T>) => Promise<T>;
}

export type DaemonActivator = (
  request: DaemonActivationRequest,
) => Promise<void>;

export interface DaemonHostOptions {
  /** Stable process/host identity. It is included in lease claims, never in user output. */
  readonly ownerId?: string;
  readonly leaseStore?: ExecutionLeaseStore;
  /** Optional path for the restart-safe local lease adapter. */
  readonly leasePath?: string;
  readonly clock?: Clock;
  /** Execution lease TTL. The lease protocol caps this at five minutes. */
  readonly leaseTtlMs?: number;
  /** Maximum number of different Runs activated concurrently by this Host. */
  readonly maxConcurrentActivations?: number;
  /** Durable input admission. This callback must append an input fact before returning. */
  readonly admitWake: DaemonWakeAdmitter;
  /** Existing SessionController/executeRun integration point. */
  readonly activate: DaemonActivator;
  readonly createWakeId?: () => string;
  readonly createActivationId?: () => string;
}

export type DaemonLifecycleStatus = "stopped" | "running" | "stopping";
export type DaemonRunState = "queued" | "running" | "held" | "failed";

export interface DaemonRunSnapshot {
  readonly runId: string;
  readonly state: DaemonRunState;
  readonly pendingWakeCount: number;
  readonly activationId?: string;
  readonly fencingToken?: number;
  readonly lastError?: string;
}

export interface DaemonHostSnapshot {
  readonly status: DaemonLifecycleStatus;
  readonly ownerId: string;
  readonly queuedRuns: number;
  readonly runningRuns: number;
  readonly attachedClients: number;
  readonly runs: readonly DaemonRunSnapshot[];
}

export type DaemonHostEvent =
  | { readonly type: "state"; readonly snapshot: DaemonHostSnapshot }
  | {
      readonly type: "wake";
      readonly request: DaemonWakeRequest;
      readonly admission: DaemonWakeAdmission;
      readonly queued: boolean;
    }
  | {
      readonly type: "activation.started";
      readonly runId: string;
      readonly activationId: string;
      readonly fencingToken: number;
      readonly wakeCount: number;
    }
  | {
      readonly type: "activation.held";
      readonly runId: string;
      readonly reason: "held" | "clock-regressed" | "stale";
    }
  | {
      readonly type: "activation.finished";
      readonly runId: string;
      readonly activationId: string;
      readonly outcome: "completed" | "failed" | "cancelled";
      readonly error?: string;
    }
  | {
      readonly type: "activation.lease-lost";
      readonly runId: string;
      readonly activationId: string;
    };

export class DaemonHostProtocolError extends Error {
  override readonly name = "DaemonHostProtocolError";
}

interface PendingRun {
  readonly runId: string;
  readonly wakes: DaemonWakeRequest[];
  state: DaemonRunState;
  lastError?: string;
  activationId?: string;
  fencingToken?: number;
}

interface RunningActivation {
  readonly runId: string;
  readonly activationId: string;
  readonly wakeKeys: readonly string[];
  readonly wakeInputIds: readonly string[];
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

interface LeaseRenewalLoop {
  stop(): void;
}

interface LeaseRetryTimer {
  readonly expiresAtMs: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Minimal in-process daemon host.
 *
 * The host owns scheduling and execution authority only. It does not own a
 * transcript, a second event bus, or a second Agent loop: wake admission and
 * activation are injected at the runtime boundary. One Run has at most one
 * activation in this host, and the execution lease also fences competing
 * hosts.
 */
export class DaemonHost {
  readonly ownerId: string;

  private readonly leaseStore: ExecutionLeaseStore;
  private readonly clock: Clock;
  private readonly leaseTtlMs: number;
  private readonly maxConcurrentActivations: number;
  private readonly admitWake: DaemonWakeAdmitter;
  private readonly activate: DaemonActivator;
  private readonly createWakeId: () => string;
  private readonly createActivationId: () => string;
  private readonly listeners = new Set<(event: DaemonHostEvent) => void>();
  private readonly attachments = new Map<string, string>();
  private readonly pending = new Map<string, PendingRun>();
  /** Inputs admitted while this Host is stopped are parked for the next start. */
  private readonly parked = new Map<string, PendingRun>();
  private readonly ready: string[] = [];
  private readonly running = new Map<string, RunningActivation>();
  private readonly leaseRetries = new Map<string, LeaseRetryTimer>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly admissionWaiters = new Set<() => void>();
  private lifecycle: DaemonLifecycleStatus = "stopped";
  private stopPromise: Promise<void> | undefined;
  private pumping = false;
  private wakeAdmissions = 0;

  constructor(options: DaemonHostOptions) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new DaemonHostProtocolError("options must be an object");
    }
    if (typeof options.admitWake !== "function") {
      throw new DaemonHostProtocolError("admitWake must be a function");
    }
    if (typeof options.activate !== "function") {
      throw new DaemonHostProtocolError("activate must be a function");
    }
    if (options.leaseStore !== undefined && options.leasePath !== undefined) {
      throw new DaemonHostProtocolError("leaseStore and leasePath are mutually exclusive");
    }
    if (options.leasePath !== undefined) {
      throw new DaemonHostProtocolError(
        "leasePath requires DaemonHost.open(); opening the durable adapter is asynchronous",
      );
    }
    this.ownerId = identifier(options.ownerId ?? `daemon:${randomUUID()}`, "ownerId");
    this.leaseStore = options.leaseStore ?? (
      options.clock === undefined
        ? new MemoryExecutionLeaseStore()
        : new MemoryExecutionLeaseStore({ clock: options.clock })
    );
    this.clock = options.clock ?? systemClock;
    this.leaseTtlMs = positiveInteger(
      options.leaseTtlMs ?? 30_000,
      "leaseTtlMs",
      MAX_EXECUTION_LEASE_TTL_MS,
    );
    this.maxConcurrentActivations = positiveInteger(
      options.maxConcurrentActivations ?? 4,
      "maxConcurrentActivations",
      64,
    );
    this.admitWake = options.admitWake;
    this.activate = options.activate;
    this.createWakeId = options.createWakeId ?? randomUUID;
    this.createActivationId = options.createActivationId ?? randomUUID;
    if (typeof this.createWakeId !== "function") {
      throw new DaemonHostProtocolError("createWakeId must be a function");
    }
    if (typeof this.createActivationId !== "function") {
      throw new DaemonHostProtocolError("createActivationId must be a function");
    }
  }

  /**
   * Open a host with a restart-safe local lease store. The rest of the Host
   * remains in-process; wake admission and activation are still injected.
   */
  static async open(options: DaemonHostOptions): Promise<DaemonHost> {
    const { leasePath, leaseStore: existingLeaseStore, ...hostOptions } = options;
    if (leasePath === undefined) return new DaemonHost(options);
    if (existingLeaseStore !== undefined) {
      throw new DaemonHostProtocolError("leaseStore and leasePath are mutually exclusive");
    }
    const leaseStore = await FileExecutionLeaseStore.open(leasePath, {
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    return new DaemonHost({ ...hostOptions, leaseStore });
  }

  get status(): DaemonLifecycleStatus {
    return this.lifecycle;
  }

  subscribe(listener: (event: DaemonHostEvent) => void): () => void {
    if (typeof listener !== "function") {
      throw new DaemonHostProtocolError("listener must be a function");
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): DaemonHostSnapshot {
    const runs = [...this.pending.values()]
      .sort((left, right) => left.runId.localeCompare(right.runId))
      .map((run): DaemonRunSnapshot => ({
        runId: run.runId,
        state: run.state,
        pendingWakeCount: run.wakes.length,
        ...(run.activationId === undefined ? {} : { activationId: run.activationId }),
        ...(run.fencingToken === undefined ? {} : { fencingToken: run.fencingToken }),
        ...(run.lastError === undefined ? {} : { lastError: run.lastError }),
      }));
    return {
      status: this.lifecycle,
      ownerId: this.ownerId,
      queuedRuns: this.ready.length,
      runningRuns: this.running.size,
      attachedClients: this.attachments.size,
      runs,
    };
  }

  async start(): Promise<DaemonHostSnapshot> {
    if (this.lifecycle === "stopping" && this.stopPromise !== undefined) {
      await this.stopPromise;
    }
    if (this.lifecycle === "stopped") {
      this.lifecycle = "running";
      this.restoreParkedRuns();
      this.emit({ type: "state", snapshot: this.snapshot() });
      this.pump();
    }
    return this.snapshot();
  }

  async stop(): Promise<DaemonHostSnapshot> {
    if (this.lifecycle === "stopped") return this.snapshot();
    if (this.stopPromise !== undefined) {
      await this.stopPromise;
      return this.snapshot();
    }
    this.lifecycle = "stopping";
    this.cancelAllLeaseRetries();
    this.emit({ type: "state", snapshot: this.snapshot() });
    const promise = this.finishStop();
    this.stopPromise = promise;
    try {
      await promise;
    } finally {
      this.stopPromise = undefined;
    }
    return this.snapshot();
  }

  /** Wait until this Host has no queued or active activations. */
  async waitForIdle(): Promise<void> {
    if (
      this.ready.length === 0
      && this.running.size === 0
      && !this.pumping
      && this.wakeAdmissions === 0
    ) return;
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  /** Attach a client as an observer. Detaching never releases a Run lease. */
  attach(clientId: string, runId: string): DaemonHostSnapshot {
    this.assertRunning();
    const client = identifier(clientId, "clientId");
    const run = identifier(runId, "runId");
    this.attachments.set(client, run);
    this.emit({ type: "state", snapshot: this.snapshot() });
    return this.snapshot();
  }

  detach(clientId: string): DaemonHostSnapshot {
    const client = identifier(clientId, "clientId");
    this.attachments.delete(client);
    this.emit({ type: "state", snapshot: this.snapshot() });
    return this.snapshot();
  }

  /**
   * Admit one external wake and schedule the corresponding Run. Duplicate
   * handling is delegated to the durable adapter; only a duplicate explicitly
   * marked `shouldActivate` can revive a pending input after a restart.
   */
  async wake(input: DaemonWakeRequest): Promise<{
    readonly status: "queued" | "duplicate";
    readonly admission: DaemonWakeAdmission;
    readonly wake: DaemonWakeRequest;
  }> {
    this.assertRunning();
    const wake = normalizeWake(input, this.createWakeId, this.clock);
    this.wakeAdmissions += 1;
    try {
      const admission = await this.admitWake(wake);
      validateAdmission(admission);
      if (this.lifecycle !== "running") {
        // The input is already durable. Keep a scheduler copy hidden from the
        // stopped snapshot so a same-process start can resume it; a process
        // restart uses Ledger recovery instead.
        this.parkWake(wake, admission);
        throw new DaemonHostProtocolError(
          "Daemon stopped during wake admission; the durable input requires recovery",
        );
      }
      return this.enqueueWake(wake, admission);
    } finally {
      this.wakeAdmissions -= 1;
      if (this.wakeAdmissions === 0) {
        for (const resolve of this.admissionWaiters) resolve();
        this.admissionWaiters.clear();
      }
      // Admission and queueing both completed before this finally block. A
      // duplicate/no-op wake can therefore resolve idle waiters here, while a
      // queued wake keeps them pending behind the scheduled pump.
      this.resolveIdleWaitersIfReady();
    }
  }

  /**
   * Re-queue inputs which were already admitted before this Host started.
   * Recovery deliberately skips `admitWake`: the Ledger fact already exists,
   * so writing another admission would create a second identity rather than
   * repairing scheduling state.
   */
  restorePending(wakes: readonly DaemonWakeRequest[]): DaemonHostSnapshot {
    this.assertRunning();
    if (!Array.isArray(wakes)) {
      throw new DaemonHostProtocolError("restorePending wakes must be an array");
    }
    let queued = false;
    for (const candidate of wakes) {
      const wake = normalizeWake(candidate, this.createWakeId, this.clock);
      if (wake.inputId === undefined) {
        throw new DaemonHostProtocolError("restored wake requires inputId");
      }
      const run = this.pending.get(wake.runId) ?? {
        runId: wake.runId,
        wakes: [],
        state: "queued" as const,
      };
      const active = this.running.get(wake.runId);
      const activeHasWake = active?.wakeKeys.includes(wake.dedupeKey) === true
        || active?.wakeInputIds.includes(wake.inputId) === true;
      const known = run.wakes.some((existing) => (
        existing.inputId === wake.inputId || existing.dedupeKey === wake.dedupeKey
      ));
      if (known || activeHasWake) {
        this.pending.set(wake.runId, run);
        continue;
      }
      run.wakes.push(wake);
      if (run.state !== "running" && run.state !== "queued") {
        this.cancelLeaseRetry(run.runId);
        run.state = "queued";
        delete run.lastError;
      }
      this.pending.set(wake.runId, run);
      if (run.state === "queued" && !this.ready.includes(wake.runId)) {
        this.ready.push(wake.runId);
      }
      queued = true;
    }
    if (queued) {
      this.emit({ type: "state", snapshot: this.snapshot() });
      this.pump();
    }
    return this.snapshot();
  }

  /**
   * Requeue an input which was already durably admitted before this Host
   * started. This deliberately bypasses `admitWake`: the Ledger is the source
   * of truth and recovery must never append a second `input.admitted` fact.
   */
  async recoverPendingWake(input: DaemonRecoveredWakeRequest): Promise<{
    readonly status: "queued" | "duplicate";
    readonly admission: DaemonWakeAdmission;
    readonly wake: DaemonWakeRequest;
  }> {
    this.assertRunning();
    const wake = normalizeWake(input, this.createWakeId, this.clock);
    const inputId = identifier(input.inputId, "inputId");
    const admission: DaemonWakeAdmission = {
      status: "duplicate",
      inputId,
      shouldActivate: true,
    };
    return this.enqueueWake(wake, admission);
  }

  private enqueueWake(
    wake: DaemonWakeRequest,
    admission: DaemonWakeAdmission,
  ): {
    readonly status: "queued" | "duplicate";
    readonly admission: DaemonWakeAdmission;
    readonly wake: DaemonWakeRequest;
  } {
    const shouldQueue = admission.status === "admitted" || admission.shouldActivate === true;
    if (shouldQueue) {
      // Admission owns the durable input identity. Preserve it on the
      // scheduler copy even when an external wake omitted inputId, so a
      // recovery or retry can match an activation by identity as well as by
      // its source dedupe key.
      const queuedWake = wake.inputId === undefined
        ? Object.freeze({ ...wake, inputId: admission.inputId })
        : wake;
      const run = this.pending.get(wake.runId) ?? {
        runId: wake.runId,
        wakes: [],
        state: "queued" as const,
      };
      const active = this.running.get(wake.runId);
      const activeHasWake = active?.wakeKeys.includes(queuedWake.dedupeKey) === true
        || (
          queuedWake.inputId !== undefined
          && active?.wakeInputIds.includes(queuedWake.inputId) === true
        );
      if (
        !activeHasWake
        && !run.wakes.some((queued) => (
          queued.dedupeKey === queuedWake.dedupeKey
          || (
            queuedWake.inputId !== undefined
            && queued.inputId === queuedWake.inputId
          )
        ))
      ) {
        run.wakes.push(queuedWake);
      }
      this.pending.set(wake.runId, run);
      if (run.state !== "running" && run.state !== "queued") {
        this.cancelLeaseRetry(run.runId);
        run.state = "queued";
        delete run.lastError;
      }
      if (run.state === "queued" && !this.ready.includes(wake.runId)) {
        this.ready.push(wake.runId);
      }
    }
    const queued = shouldQueue;
    this.emit({ type: "wake", request: wake, admission, queued });
    if (queued) this.pump();
    return {
      status: admission.status === "admitted" || admission.shouldActivate === true
        ? "queued"
        : "duplicate",
      admission,
      wake,
    };
  }

  private async finishStop(): Promise<void> {
    for (const activation of this.running.values()) {
      activation.controller.abort(new DaemonHostProtocolError("Daemon stopped"));
    }
    await Promise.allSettled([...this.running.values()].map((activation) => activation.promise));
    // `stop()` is a lifecycle barrier: a wake which began while running may
    // finish durable admission, but it must settle before stopped is exposed.
    // Its scheduler copy is parked for a same-process start; after a process
    // restart the Ledger remains the recovery source.
    if (this.wakeAdmissions > 0) {
      await new Promise<void>((resolve) => this.admissionWaiters.add(resolve));
    }
    this.parkPendingRuns();
    this.ready.length = 0;
    this.pending.clear();
    this.attachments.clear();
    this.lifecycle = "stopped";
    this.emit({ type: "state", snapshot: this.snapshot() });
    this.resolveIdleWaiters();
  }

  private pump(): void {
    if (this.pumping || this.lifecycle !== "running") return;
    this.pumping = true;
    queueMicrotask(() => {
      this.pumping = false;
      while (
        this.lifecycle === "running"
        && this.running.size < this.maxConcurrentActivations
        && this.ready.length > 0
      ) {
        const runId = this.ready.shift();
        if (runId === undefined) break;
        const pending = this.pending.get(runId);
        if (pending === undefined || pending.wakes.length === 0 || pending.state === "running") {
          continue;
        }
        const wakeKeys = pending.wakes.map((wake) => wake.dedupeKey);
        const wakeInputIds = pending.wakes
          .flatMap((wake) => wake.inputId === undefined ? [] : [wake.inputId]);
        this.cancelLeaseRetry(runId);
        pending.state = "running";
        const activationId = identifier(this.createActivationId(), "activationId");
        const controller = new AbortController();
        const promise = this.executeActivation(pending, activationId, controller);
        this.running.set(runId, {
          runId,
          activationId,
          wakeKeys,
          wakeInputIds,
          controller,
          promise,
        });
        // Keep the rejection inside the owned promise; callers observe it via
        // the lifecycle event and the run remains available for a later wake.
        void promise.catch(() => undefined);
      }
      this.resolveIdleWaitersIfReady();
    });
  }

  /** Move scheduler state out of the visible stopped snapshot. */
  private parkPendingRuns(): void {
    for (const run of this.pending.values()) {
      if (run.wakes.length === 0) continue;
      run.state = "queued";
      delete run.activationId;
      delete run.fencingToken;
      delete run.lastError;
      const parked = this.parked.get(run.runId);
      if (parked === undefined) {
        this.parked.set(run.runId, run);
      } else {
        // The pending activation batch predates admissions which completed
        // during shutdown, so preserve it at the front of the retry batch.
        appendUniqueWakes(run.wakes, parked.wakes);
        this.parked.set(run.runId, run);
      }
    }
  }

  /** Requeue parked scheduler state after a same-process start. */
  private restoreParkedRuns(): void {
    for (const run of this.parked.values()) {
      run.state = "queued";
      delete run.activationId;
      delete run.fencingToken;
      delete run.lastError;
      const current = this.pending.get(run.runId);
      if (current === undefined) {
        this.pending.set(run.runId, run);
      } else {
        appendUniqueWakes(current.wakes, run.wakes);
        current.state = "queued";
        delete current.lastError;
      }
      if (!this.ready.includes(run.runId)) this.ready.push(run.runId);
    }
    this.parked.clear();
  }

  /** Park one durable wake whose admission completed during shutdown. */
  private parkWake(wake: DaemonWakeRequest, admission: DaemonWakeAdmission): void {
    if (admission.status !== "admitted" && admission.shouldActivate !== true) return;
    const queuedWake = wake.inputId === undefined
      ? Object.freeze({ ...wake, inputId: admission.inputId })
      : wake;
    const parked = this.parked.get(wake.runId) ?? {
      runId: wake.runId,
      wakes: [],
      state: "queued" as const,
    };
    appendUniqueWakes(parked.wakes, [queuedWake]);
    parked.state = "queued";
    delete parked.lastError;
    this.parked.set(wake.runId, parked);
  }

  private async executeActivation(
    pending: PendingRun,
    activationId: string,
    controller: AbortController,
  ): Promise<void> {
    const wakes = pending.wakes.splice(0);
    let lease: ExecutionLease | undefined;
    let renewal: LeaseRenewalLoop | undefined;
    let leaseLostReported = false;
    let retryAfterLeaseFailure = false;
    let commitAuthorityValid = true;
    const reportLeaseLost = (): void => {
      if (leaseLostReported) return;
      leaseLostReported = true;
      this.emit({
        type: "activation.lease-lost",
        runId: pending.runId,
        activationId,
      });
    };
    const recordLeaseFailure = (): void => {
      // This activation can no longer prove that it owns the Run. Revoke its
      // local commit authority before abort listeners attempt terminal writes.
      commitAuthorityValid = false;
      retryAfterLeaseFailure = true;
      reportLeaseLost();
    };
    try {
      const claim = await this.leaseStore.claim({
        runId: pending.runId,
        ownerId: this.ownerId,
        acquisitionId: `claim:${this.ownerId}:${pending.runId}:${activationId}`,
        ttlMs: this.leaseTtlMs,
      });
      if (claim.status !== "acquired") {
        // A different Host currently owns this Run. Keep the admitted wakes
        // visible so a later wake can retry after the owner releases its
        // lease; never silently drop durable input on a held claim.
        prependUniqueWakes(pending.wakes, wakes);
        pending.state = "held";
        const reason = claim.status === "held" ? "held" : claim.status;
        if (claim.status === "held") {
          this.scheduleLeaseRetry(pending, claim.holder.expiresAt);
        }
        this.emit({ type: "activation.held", runId: pending.runId, reason });
        return;
      }
      const acquiredLease = claim.lease;
      lease = acquiredLease;
      pending.activationId = activationId;
      pending.fencingToken = lease.fencingToken;
      this.emit({
        type: "activation.started",
        runId: pending.runId,
        activationId,
        fencingToken: lease.fencingToken,
        wakeCount: wakes.length,
      });
      let verified: boolean;
      try {
        verified = await this.leaseStore.verify({
          runId: lease.runId,
          ownerId: lease.ownerId,
          leaseId: lease.leaseId,
          fencingToken: lease.fencingToken,
        });
      } catch (error: unknown) {
        recordLeaseFailure();
        throw error;
      }
      if (!verified) {
        prependUniqueWakes(pending.wakes, wakes);
        pending.state = "held";
        recordLeaseFailure();
        return;
      }
      renewal = this.startRenewal(lease, activationId, controller, recordLeaseFailure);
      if (controller.signal.aborted || this.lifecycle !== "running") {
        prependUniqueWakes(pending.wakes, wakes);
        pending.state = this.lifecycle === "running" ? "held" : "queued";
        this.emit({
          type: "activation.finished",
          runId: pending.runId,
          activationId,
          outcome: "cancelled",
        });
        return;
      }
      const assertLease = async (): Promise<void> => {
        if (!commitAuthorityValid) {
          throw new DaemonHostProtocolError("Execution lease commit authority lost");
        }
        let current: boolean;
        try {
          current = await this.leaseStore.verify({
            runId: acquiredLease.runId,
            ownerId: acquiredLease.ownerId,
            leaseId: acquiredLease.leaseId,
            fencingToken: acquiredLease.fencingToken,
          });
        } catch (error: unknown) {
          recordLeaseFailure();
          controller.abort(new DaemonHostProtocolError("Execution lease verification failed"));
          throw error;
        }
        if (!current) {
          recordLeaseFailure();
          controller.abort(new DaemonHostProtocolError("Execution lease lost"));
          throw new DaemonHostProtocolError("Execution lease lost");
        }
      };
      const commitLease = async <T>(operation: () => Promise<T>): Promise<T> => {
        if (typeof operation !== "function") {
          throw new DaemonHostProtocolError("Lease commit operation must be a function");
        }
        if (!commitAuthorityValid) {
          throw new DaemonHostProtocolError("Execution lease commit authority lost");
        }
        const result = await this.leaseStore.runIfCurrent({
          runId: acquiredLease.runId,
          ownerId: acquiredLease.ownerId,
          leaseId: acquiredLease.leaseId,
          fencingToken: acquiredLease.fencingToken,
        }, operation).catch((error: unknown) => {
          // A thrown guarded commit has an unknown durable outcome. Retire
          // this activation even when the operation itself caused the error.
          recordLeaseFailure();
          controller.abort(new DaemonHostProtocolError("Execution lease commit failed"));
          throw error;
        });
        if (result.status === "lost") {
          recordLeaseFailure();
          controller.abort(new DaemonHostProtocolError("Execution lease lost"));
          throw new DaemonHostProtocolError("Execution lease lost");
        }
        return result.value;
      };
      await assertLease();
      await this.activate({
        runId: pending.runId,
        activationId,
        wakes: Object.freeze(wakes.map((wake) => ({ ...wake }))),
        lease,
        signal: controller.signal,
        assertLease,
        commitLease,
      });
      const cancelled = controller.signal.aborted || this.lifecycle !== "running";
      if (cancelled) {
        prependUniqueWakes(pending.wakes, wakes);
        pending.state = this.lifecycle === "running" ? "held" : "queued";
      }
      this.emit({
        type: "activation.finished",
        runId: pending.runId,
        activationId,
        outcome: cancelled ? "cancelled" : "completed",
      });
    } catch (error: unknown) {
      const cancelled = controller.signal.aborted;
      const message = persistedErrorText(error);
      // Activation is a delivery attempt, not the durable acknowledgement.
      // Keep its wakes available for a later explicit wake or recovery rather
      // than silently losing an admitted input on an activator failure.
      prependUniqueWakes(pending.wakes, wakes);
      pending.lastError = message;
      // Do not immediately spin on a permanent provider/runtime failure.
      // A subsequent wake (or a fresh daemon recovery) moves this Run back to
      // the queued state and retries the preserved inputs.
      pending.state = "held";
      this.emit({
        type: "activation.finished",
        runId: pending.runId,
        activationId,
        outcome: cancelled ? "cancelled" : "failed",
        ...(cancelled ? {} : { error: message }),
      });
    } finally {
      renewal?.stop();
      if (lease !== undefined) {
        const released = await this.leaseStore.release({
          runId: lease.runId,
          ownerId: lease.ownerId,
          leaseId: lease.leaseId,
          fencingToken: lease.fencingToken,
          commandId: `release:${this.ownerId}:${pending.runId}:${activationId}`,
        }).catch(() => ({ status: "lost" as const }));
        if (released.status === "lost") {
          reportLeaseLost();
        }
      }
      const current = this.pending.get(pending.runId);
      if (current === pending) {
        delete current.activationId;
        delete current.fencingToken;
        if (current.wakes.length > 0) {
          if (this.lifecycle !== "running") {
            // finishStop parks this Run after all activation promises settle.
            current.state = "queued";
          } else if (retryAfterLeaseFailure) {
            current.state = "held";
            this.scheduleLeaseFailureRetry(current);
          } else if (current.state !== "held") {
            current.state = "queued";
            if (!this.ready.includes(current.runId)) this.ready.push(current.runId);
          }
        } else if (current.state !== "held" && current.state !== "failed") {
          this.cancelLeaseRetry(current.runId);
          this.pending.delete(current.runId);
        }
      }
      this.running.delete(pending.runId);
      this.pump();
      this.resolveIdleWaitersIfReady();
    }
  }

  private startRenewal(
    lease: ExecutionLease,
    activationId: string,
    controller: AbortController,
    onLeaseLost: () => void,
  ): LeaseRenewalLoop {
    const intervalMs = Math.max(10, Math.floor(this.leaseTtlMs / 2));
    let sequence = 0;
    let active = true;
    const timer = setInterval(() => {
      if (!active) return;
      sequence += 1;
      void this.leaseStore.renew({
        runId: lease.runId,
        ownerId: lease.ownerId,
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
        commandId: `renew:${this.ownerId}:${lease.runId}:${activationId}:${sequence}`,
        ttlMs: this.leaseTtlMs,
      }).then((result) => {
        if (!active) return;
        if (result.status !== "renewed") {
          active = false;
          clearInterval(timer);
          onLeaseLost();
          controller.abort(new DaemonHostProtocolError("Execution lease lost"));
        }
      }).catch(() => {
        if (!active) return;
        active = false;
        clearInterval(timer);
        onLeaseLost();
        controller.abort(new DaemonHostProtocolError("Execution lease renewal failed"));
      });
    }, intervalMs);
    timer.unref?.();
    return {
      stop(): void {
        active = false;
        clearInterval(timer);
      },
    };
  }

  /** Retry a lease protocol failure with bounded backoff instead of spinning. */
  private scheduleLeaseFailureRetry(pending: PendingRun): void {
    const nowMs = this.clock.now().getTime();
    if (!Number.isFinite(nowMs)) {
      throw new DaemonHostProtocolError("Cannot schedule retry with an invalid clock");
    }
    const delayMs = Math.max(25, Math.min(this.leaseTtlMs, 1_000));
    this.scheduleLeaseRetry(pending, new Date(nowMs + delayMs).toISOString());
  }

  /** Retry one held Run after the competing lease can no longer be live. */
  private scheduleLeaseRetry(pending: PendingRun, expiresAt: string): void {
    if (
      this.lifecycle !== "running"
      || pending.state !== "held"
      || pending.wakes.length === 0
    ) {
      this.cancelLeaseRetry(pending.runId);
      return;
    }
    const expiresAtMs = Date.parse(expiresAt);
    const nowMs = this.clock.now().getTime();
    if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) {
      throw new DaemonHostProtocolError("Cannot schedule retry for an invalid lease expiration");
    }
    const existing = this.leaseRetries.get(pending.runId);
    if (existing?.expiresAtMs === expiresAtMs) return;
    this.cancelLeaseRetry(pending.runId);

    // One millisecond of grace keeps the retry on the expired side of stores
    // whose lease comparison treats expiresAt as inclusive.
    const delayMs = Math.max(1, expiresAtMs - nowMs + 1);
    const timer = setTimeout(() => {
      const scheduled = this.leaseRetries.get(pending.runId);
      if (scheduled?.timer !== timer) return;
      this.leaseRetries.delete(pending.runId);
      if (this.lifecycle !== "running") return;
      const current = this.pending.get(pending.runId);
      if (current !== pending || current.state !== "held" || current.wakes.length === 0) {
        return;
      }
      current.state = "queued";
      delete current.lastError;
      if (!this.ready.includes(current.runId)) this.ready.push(current.runId);
      this.emit({ type: "state", snapshot: this.snapshot() });
      this.pump();
    }, delayMs);
    timer.unref?.();
    this.leaseRetries.set(pending.runId, { expiresAtMs, timer });
  }

  private cancelLeaseRetry(runId: string): void {
    const retry = this.leaseRetries.get(runId);
    if (retry === undefined) return;
    clearTimeout(retry.timer);
    this.leaseRetries.delete(runId);
  }

  private cancelAllLeaseRetries(): void {
    for (const retry of this.leaseRetries.values()) clearTimeout(retry.timer);
    this.leaseRetries.clear();
  }

  private resolveIdleWaiters(): void {
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private resolveIdleWaitersIfReady(): void {
    if (
      this.ready.length === 0
      && this.running.size === 0
      && !this.pumping
      && this.wakeAdmissions === 0
    ) {
      this.resolveIdleWaiters();
    }
  }

  private emit(event: DaemonHostEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Observers never own daemon state.
      }
    }
  }

  private assertRunning(): void {
    if (this.lifecycle !== "running") {
      throw new DaemonHostProtocolError(`Daemon is ${this.lifecycle}`);
    }
  }
}

/** Reinsert an activation batch without duplicating a concurrent external wake. */
function prependUniqueWakes(target: DaemonWakeRequest[], wakes: readonly DaemonWakeRequest[]): void {
  const existingKeys = new Set(target.map((wake) => wake.dedupeKey));
  const existingInputs = new Set(
    target.flatMap((wake) => wake.inputId === undefined ? [] : [wake.inputId]),
  );
  const unique = wakes.filter((wake) => (
    !existingKeys.has(wake.dedupeKey)
    && (wake.inputId === undefined || !existingInputs.has(wake.inputId))
  ));
  target.unshift(...unique);
}

/** Append wakes while preserving one scheduler copy per durable identity. */
function appendUniqueWakes(target: DaemonWakeRequest[], wakes: readonly DaemonWakeRequest[]): void {
  const existingKeys = new Set(target.map((wake) => wake.dedupeKey));
  const existingInputs = new Set(
    target.flatMap((wake) => wake.inputId === undefined ? [] : [wake.inputId]),
  );
  for (const wake of wakes) {
    if (
      existingKeys.has(wake.dedupeKey)
      || (wake.inputId !== undefined && existingInputs.has(wake.inputId))
    ) continue;
    target.push(wake);
    existingKeys.add(wake.dedupeKey);
    if (wake.inputId !== undefined) existingInputs.add(wake.inputId);
  }
}

function normalizeWake(
  input: DaemonWakeRequest,
  createWakeId: () => string,
  clock: Clock,
): DaemonWakeRequest {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new DaemonHostProtocolError("wake must be an object");
  }
  const source = input.source;
  if (
    source !== "timer"
    && source !== "webhook"
    && source !== "file"
    && source !== "a2a"
    && source !== "user"
    && source !== "system"
  ) {
    throw new DaemonHostProtocolError("wake.source is unsupported");
  }
  const runId = identifier(input.runId, "runId");
  const dedupeKey = identifier(input.dedupeKey, "dedupeKey");
  const wakeId = identifier(input.wakeId ?? createWakeId(), "wakeId");
  const occurredAt = input.occurredAt ?? clock.now().toISOString();
  if (typeof occurredAt !== "string" || !Number.isFinite(Date.parse(occurredAt))) {
    throw new DaemonHostProtocolError("wake.occurredAt must be a valid date-time");
  }
  return Object.freeze({
    runId,
    source,
    dedupeKey,
    wakeId,
    ...(input.inputId === undefined ? {} : { inputId: identifier(input.inputId, "inputId") }),
    ...(input.payloadRef === undefined ? {} : { payloadRef: structuredClone(input.payloadRef) }),
    occurredAt,
  });
}

function validateAdmission(value: DaemonWakeAdmission): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DaemonHostProtocolError("admitWake must return an object");
  }
  if (value.status !== "admitted" && value.status !== "duplicate") {
    throw new DaemonHostProtocolError("admission.status is unsupported");
  }
  identifier(value.inputId, "admission.inputId");
  if (value.shouldActivate !== undefined && typeof value.shouldActivate !== "boolean") {
    throw new DaemonHostProtocolError("admission.shouldActivate must be a boolean");
  }
}

function identifier(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.includes("\0")
  ) {
    throw new DaemonHostProtocolError(`${field} must be a non-empty, trimmed string without NUL`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new DaemonHostProtocolError(`${field} must be a positive integer <= ${maximum}`);
  }
  return value as number;
}
