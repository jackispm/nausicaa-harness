import {
  DaemonHost,
  type DaemonActivationRequest,
  type DaemonHostEvent,
  type DaemonHostOptions,
  type DaemonHostSnapshot,
  type DaemonWakeAdmitter,
  type DaemonWakeRequest,
} from "./daemon-host.js";
import type {
  DaemonServiceStatus,
} from "./daemon-service.js";
import type {
  DaemonWorkerActivationReceipt,
  DaemonWorkerClientSnapshot,
  DaemonWorkerActivationRequest,
} from "./daemon-worker-client.js";
import type { DaemonWorkerLeaseIdentity, DaemonWorkerWake } from "./daemon-worker-protocol.js";
import { DaemonWorkerProcess } from "./daemon-worker-process.js";
import type { DaemonWorkerDescriptorPublisher } from "./daemon-worker-protocol.js";
import { persistedErrorText } from "./redaction.js";

const DEFAULT_MAX_WORKERS = 4;
const DEFAULT_MAX_PENDING_RUNS = 16;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const MAX_READY_TIMEOUT_MS = 5 * 60_000;
const MAX_ERROR_LENGTH = 512;

/** The supervisor's state is host control state, not a Ledger fact. */
export type DaemonSupervisorLifecycle =
  | "stopped"
  | "starting"
  | "ready"
  | "draining"
  | "failed";

export type DaemonSupervisorWorkerState =
  | "starting"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "crashed"
  | "ready-timeout"
  | "lease-lost"
  | "uncertain"
  | "draining"
  | "closed";

export interface DaemonSupervisorFailure {
  readonly code:
    | "service_not_ready"
    | "service_failed"
    | "host_failed"
    | "capacity"
    | "worker_create_failed"
    | "worker_ready_timeout"
    | "worker_ready_failed"
    | "worker_crashed"
    | "worker_lease_lost"
    | "worker_uncertain"
    | "worker_failed"
    | "descriptor_mismatch"
    | "closed"
    | "draining";
  readonly message: string;
}

export interface DaemonSupervisorWorkerSnapshot {
  readonly runId: string;
  readonly workerId: string;
  readonly generation: number;
  readonly state: DaemonSupervisorWorkerState;
  readonly instanceTokenPresent: boolean;
  readonly activationId?: string;
  readonly lastError?: string;
}

export interface DaemonSupervisorSnapshot {
  readonly lifecycle: DaemonSupervisorLifecycle;
  readonly host?: DaemonHostSnapshot;
  readonly service?: DaemonServiceStatus;
  readonly maxWorkers: number;
  readonly maxPendingRuns: number;
  readonly workers: readonly DaemonSupervisorWorkerSnapshot[];
  readonly lastFailure?: DaemonSupervisorFailure;
}

export type DaemonSupervisorEvent =
  | { readonly type: "state"; readonly snapshot: DaemonSupervisorSnapshot }
  | {
      readonly type: "worker";
      readonly runId: string;
      readonly workerId: string;
      readonly generation: number;
      readonly state: DaemonSupervisorWorkerState;
      readonly error?: string;
    }
  | { readonly type: "descriptor"; readonly runId: string; readonly result: "matched" | "stale" | "replaced" | "unknown" };

/**
 * A deliberately small view of DaemonWorkerProcess. Keeping this as a port
 * lets the supervisor use the existing process/client implementation while
 * protocol tests use an in-memory fake.
 */
export interface DaemonSupervisorWorkerClient {
  readonly snapshot: DaemonWorkerClientSnapshot;
  initialize(): Promise<DaemonWorkerClientSnapshot>;
  activate(request: DaemonWorkerActivationRequest): Promise<DaemonWorkerActivationReceipt>;
  cancel?(activationId: string, reason?: string): Promise<DaemonWorkerClientSnapshot>;
  drain(): Promise<DaemonWorkerClientSnapshot>;
  shutdown?(reason?: string): Promise<DaemonWorkerClientSnapshot>;
  close(): Promise<void>;
}

export interface DaemonSupervisorWorker {
  readonly client: DaemonSupervisorWorkerClient;
  /** Optional descriptor identity observed/published by the worker adapter. */
  readonly descriptor?: DaemonSupervisorDescriptor;
  close?(): Promise<void>;
}

export interface DaemonSupervisorDescriptor {
  readonly runId: string;
  readonly workerId: string;
  readonly generation: number;
  readonly instanceToken: string;
}

export interface DaemonSupervisorWorkerCreateRequest {
  readonly runId: string;
  readonly workerId: string;
  readonly activationId: string;
  readonly generation: number;
  readonly lease: DaemonWorkerLeaseIdentity;
}

export type DaemonSupervisorWorkerFactory = (
  request: DaemonSupervisorWorkerCreateRequest,
) => DaemonSupervisorWorker | Promise<DaemonSupervisorWorker>;

/**
 * Bind the supervisor to the reviewed detached worker process implementation.
 * The caller supplies the worker executable/argv and child descriptor
 * publisher; no process or runtime policy is invented here.
 */
export interface DaemonSupervisorProcessFactoryOptions {
  readonly command?: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly descriptorPublisherForRun?: (
    request: DaemonSupervisorWorkerCreateRequest,
  ) => DaemonWorkerDescriptorPublisher | undefined;
  readonly maxFrameBytes?: number;
  readonly maxPendingActivations?: number;
  readonly commandTimeoutMs?: number;
  readonly activationTimeoutMs?: number;
  readonly cancelGraceMs?: number;
}

export function createDaemonSupervisorWorkerFactory(
  options: DaemonSupervisorProcessFactoryOptions,
): DaemonSupervisorWorkerFactory {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new DaemonSupervisorError("worker_create_failed", "process factory options must be an object");
  }
  if (!Array.isArray(options.args)) {
    throw new DaemonSupervisorError("worker_create_failed", "process factory args must be an array");
  }
  return (request) => {
    const publisher = options.descriptorPublisherForRun?.(request);
    const process = new DaemonWorkerProcess({
      runId: request.runId,
      workerId: request.workerId,
      lease: request.lease,
      args: [...options.args],
      ...(options.command === undefined ? {} : { command: options.command }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(publisher === undefined ? {} : { descriptorPublisher: publisher }),
      ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
      ...(options.maxPendingActivations === undefined ? {} : { maxPendingActivations: options.maxPendingActivations }),
      ...(options.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: options.commandTimeoutMs }),
      ...(options.activationTimeoutMs === undefined ? {} : { activationTimeoutMs: options.activationTimeoutMs }),
      ...(options.cancelGraceMs === undefined ? {} : { cancelGraceMs: options.cancelGraceMs }),
    });
    return { client: process.client, close: () => process.close() };
  };
}

export type DaemonSupervisorHostFactory = (
  options: DaemonHostOptions,
) => DaemonHost | Promise<DaemonHost>;

/** Only the service lifecycle is visible to this composition adapter. */
export interface DaemonSupervisorService {
  start(): Promise<DaemonServiceStatus>;
  status(): Promise<DaemonServiceStatus>;
  stop(): Promise<DaemonServiceStatus>;
  close(): Promise<void>;
}

export interface DaemonSupervisorDescriptorReader {
  read(): Promise<readonly DaemonSupervisorDescriptor[]>;
}

export interface DaemonSupervisorOptions {
  /** Host options other than the injected wake/activation callbacks. */
  readonly host?: Omit<DaemonHostOptions, "admitWake" | "activate" | "maxConcurrentActivations">;
  readonly createHost?: DaemonSupervisorHostFactory;
  readonly service?: DaemonSupervisorService;
  readonly admitWake: DaemonWakeAdmitter;
  readonly createWorker: DaemonSupervisorWorkerFactory;
  /** Child workers reopen this path to perform their own fencing checks. */
  readonly leasePathForRun: (runId: string) => string;
  readonly descriptorReader?: DaemonSupervisorDescriptorReader;
  readonly maxWorkers?: number;
  readonly maxPendingRuns?: number;
  readonly readyTimeoutMs?: number;
  readonly createWorkerId?: () => string;
}

export type DaemonSupervisorWakeResult =
  | {
      readonly status: "queued" | "duplicate";
      readonly host: Awaited<ReturnType<DaemonHost["wake"]>>;
    }
  | {
      readonly status: "capacity";
      readonly failure: DaemonSupervisorFailure;
    };

export type DaemonSupervisorReconcileResult = {
  readonly matched: readonly string[];
  readonly stale: readonly string[];
  readonly replaced: readonly string[];
  readonly unknown: readonly string[];
};

export class DaemonSupervisorError extends Error {
  override readonly name = "DaemonSupervisorError";

  constructor(
    readonly code: DaemonSupervisorFailure["code"],
    message: string,
  ) {
    super(boundedError(message));
  }
}

interface WorkerRecord {
  readonly runId: string;
  readonly workerId: string;
  readonly generation: number;
  readonly activationId: string;
  readonly worker: DaemonSupervisorWorker;
  state: DaemonSupervisorWorkerState;
  instanceToken?: string;
  lastError?: string;
}

/**
 * Composition-only supervisor for detached Run workers.
 *
 * DaemonHost remains the scheduler and lease owner. This object only starts
 * the service, creates a ready worker for a Host activation, and classifies
 * worker outcomes. It owns no Ledger, scheduler, transcript, or Agent loop.
 */
export class DaemonSupervisor {
  private readonly host: DaemonHost;
  private readonly service: DaemonSupervisorService | undefined;
  private readonly createWorker: DaemonSupervisorWorkerFactory;
  private readonly leasePathForRun: (runId: string) => string;
  private readonly descriptorReader: DaemonSupervisorDescriptorReader | undefined;
  private readonly maxWorkers: number;
  private readonly maxPendingRuns: number;
  private readonly readyTimeoutMs: number;
  private readonly createWorkerId: () => string;
  private readonly workers = new Map<string, WorkerRecord>();
  /** Reservations close the async admission race between concurrent wakes. */
  private readonly wakeReservations = new Set<string>();
  private readonly listeners = new Set<(event: DaemonSupervisorEvent) => void>();
  private readonly hostUnsubscribe: () => void;
  private supervisorState: DaemonSupervisorLifecycle = "stopped";
  private lastFailure: DaemonSupervisorFailure | undefined;
  private serviceStatus: DaemonServiceStatus | undefined;
  private startPromise: Promise<DaemonSupervisorSnapshot> | undefined;
  private drainPromise: Promise<DaemonSupervisorSnapshot> | undefined;
  private stopPromise: Promise<DaemonSupervisorSnapshot> | undefined;
  private closePromise: Promise<void> | undefined;
  private nextWorkerSequence = 0;
  private readonly generationsByRun = new Map<string, number>();
  private closed = false;

  private constructor(
    options: DaemonSupervisorOptions,
    host: DaemonHost,
  ) {
    this.host = host;
    this.service = options.service;
    this.createWorker = options.createWorker;
    this.leasePathForRun = options.leasePathForRun;
    this.descriptorReader = options.descriptorReader;
    this.maxWorkers = boundedInteger(options.maxWorkers, DEFAULT_MAX_WORKERS, 1, 64, "maxWorkers");
    this.maxPendingRuns = boundedInteger(
      options.maxPendingRuns,
      Math.max(DEFAULT_MAX_PENDING_RUNS, this.maxWorkers),
      this.maxWorkers,
      1024,
      "maxPendingRuns",
    );
    this.readyTimeoutMs = boundedInteger(
      options.readyTimeoutMs,
      DEFAULT_READY_TIMEOUT_MS,
      1,
      MAX_READY_TIMEOUT_MS,
      "readyTimeoutMs",
    );
    this.createWorkerId = options.createWorkerId ?? (() => `worker:${++this.nextWorkerSequence}`);
    if (typeof this.createWorkerId !== "function") {
      throw new DaemonSupervisorError("worker_create_failed", "createWorkerId must be a function");
    }
    this.hostUnsubscribe = this.host.subscribe((event) => this.forwardHostEvent(event));
  }

  /** Construct the Host and supervisor together so activation is always bound to this adapter. */
  static async open(options: DaemonSupervisorOptions): Promise<DaemonSupervisor> {
    validateOptions(options);
    let supervisor: DaemonSupervisor | undefined;
    const activate = (request: DaemonActivationRequest): Promise<void> => {
      if (supervisor === undefined) {
        return Promise.reject(new DaemonSupervisorError("host_failed", "supervisor host is not bound"));
      }
      return supervisor.activateWorker(request);
    };
    const maxWorkers = boundedInteger(options.maxWorkers, DEFAULT_MAX_WORKERS, 1, 64, "maxWorkers");
    const createHost = options.createHost ?? ((hostOptions: DaemonHostOptions) => DaemonHost.open(hostOptions));
    const hostOptions: DaemonHostOptions = {
      ...(options.host ?? {}),
      maxConcurrentActivations: maxWorkers,
      admitWake: options.admitWake,
      activate,
    };
    const host = await createHost(hostOptions);
    if (!(host instanceof DaemonHost)) {
      throw new DaemonSupervisorError("host_failed", "createHost must return a DaemonHost");
    }
    supervisor = new DaemonSupervisor(options, host);
    return supervisor;
  }

  get lifecycle(): DaemonSupervisorLifecycle {
    return this.supervisorState;
  }

  get daemonHost(): DaemonHost {
    return this.host;
  }

  /** Return a fresh control projection without changing execution state. */
  async status(): Promise<DaemonSupervisorSnapshot> {
    if (this.service !== undefined) this.serviceStatus = await this.service.status();
    return this.snapshot();
  }

  subscribe(listener: (event: DaemonSupervisorEvent) => void): () => void {
    if (typeof listener !== "function") {
      throw new DaemonSupervisorError("host_failed", "listener must be a function");
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): DaemonSupervisorSnapshot {
    const workers = [...this.workers.values()]
      .sort((left, right) => left.runId.localeCompare(right.runId))
      .map((record): DaemonSupervisorWorkerSnapshot => ({
        runId: record.runId,
        workerId: record.workerId,
        generation: record.generation,
        state: record.state,
        instanceTokenPresent: record.instanceToken !== undefined,
        ...(record.activationId === undefined ? {} : { activationId: record.activationId }),
        ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
      }));
    return {
      lifecycle: this.supervisorState,
      host: this.host.snapshot(),
      ...(this.serviceStatus === undefined ? {} : { service: this.serviceStatus }),
      maxWorkers: this.maxWorkers,
      maxPendingRuns: this.maxPendingRuns,
      workers,
      ...(this.lastFailure === undefined ? {} : { lastFailure: this.lastFailure }),
    };
  }

  async start(): Promise<DaemonSupervisorSnapshot> {
    if (this.closed) throw new DaemonSupervisorError("closed", "supervisor is closed");
    if (this.startPromise !== undefined) return this.startPromise;
    if (this.supervisorState === "ready") return this.snapshot();
    if (this.supervisorState === "draining") {
      throw new DaemonSupervisorError("draining", "daemon supervisor is draining");
    }
    const operation = this.startInternal();
    this.startPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.startPromise === operation) this.startPromise = undefined;
    }
  }

  private async startInternal(): Promise<DaemonSupervisorSnapshot> {
    this.supervisorState = "starting";
    this.lastFailure = undefined;
    this.emitState();
    let serviceStarted = false;
    try {
      if (this.service !== undefined) {
        const service = await this.service.start();
        this.serviceStatus = service;
        serviceStarted = service.state === "ready";
        if (service.state !== "ready") {
          throw new DaemonSupervisorError(
            service.state === "failed" ? "service_failed" : "service_not_ready",
            "daemon service did not reach ready state",
          );
        }
      }
      await this.host.start();
      if (this.closed) {
        await this.host.stop().catch(() => undefined);
        if (this.service !== undefined) this.serviceStatus = await this.service.stop().catch(() => this.serviceStatus);
        this.supervisorState = "stopped";
        this.emitState();
        return this.snapshot();
      }
      this.supervisorState = "ready";
      this.emitState();
      return this.snapshot();
    } catch (error: unknown) {
      if (serviceStarted && this.service !== undefined) {
        this.serviceStatus = await this.service.stop().catch(() => this.serviceStatus);
      }
      this.lastFailure = failure(
        error instanceof DaemonSupervisorError ? error.code : "host_failed",
        error,
      );
      this.supervisorState = "failed";
      this.emitState();
      throw new DaemonSupervisorError(this.lastFailure.code, this.lastFailure.message);
    }
  }

  /** Submit one durable wake; DaemonHost performs Run-level coalescing. */
  async wake(input: DaemonWakeRequest): Promise<DaemonSupervisorWakeResult> {
    this.requireReady();
    if (typeof input?.runId !== "string" || input.runId.length === 0) {
      throw new DaemonSupervisorError("host_failed", "wake runId is invalid");
    }
    const existing = this.host.snapshot().runs.some((run) => run.runId === input.runId);
    const hostSnapshot = this.host.snapshot();
    const reserved = this.wakeReservations.has(input.runId);
    if (
      !existing
      && !reserved
      && hostSnapshot.queuedRuns + hostSnapshot.runningRuns + this.wakeReservations.size >= this.maxPendingRuns
    ) {
      const capacity = failure("capacity", "daemon supervisor capacity is full");
      this.lastFailure = capacity;
      return { status: "capacity", failure: capacity };
    }
    if (!existing && !reserved) this.wakeReservations.add(input.runId);
    try {
      const host = await this.host.wake(input);
      return { status: host.status, host };
    } finally {
      if (!existing && !reserved) this.wakeReservations.delete(input.runId);
    }
  }

  attach(clientId: string, runId: string): DaemonHostSnapshot {
    this.requireReady();
    return this.host.attach(clientId, runId);
  }

  /** Detach only removes observation; it cannot cancel the worker or release its lease. */
  detach(clientId: string): DaemonHostSnapshot {
    return this.host.detach(clientId);
  }

  /** Ask active child workers to drain. New activations are rejected after this point. */
  async drain(): Promise<DaemonSupervisorSnapshot> {
    if (this.drainPromise !== undefined) return this.drainPromise;
    if (this.supervisorState === "stopped" || this.supervisorState === "failed") return this.snapshot();
    if (this.supervisorState === "draining") return this.snapshot();
    const operation = this.drainInternal();
    this.drainPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.drainPromise === operation) this.drainPromise = undefined;
    }
  }

  private async drainInternal(): Promise<DaemonSupervisorSnapshot> {
    if (this.supervisorState === "starting" && this.startPromise !== undefined) {
      await this.startPromise.catch(() => undefined);
      if ((this.supervisorState as DaemonSupervisorLifecycle) !== "ready") return this.snapshot();
    }
    this.supervisorState = "draining";
    this.emitState();
    await Promise.allSettled([...this.workers.values()].map(async (record) => {
      record.state = "draining";
      this.emitWorker(record);
      if (record.state === "draining" && record.worker.client.snapshot.initialized !== true) {
        // A worker which has not passed ready cannot accept a drain command;
        // closing it releases a stuck handshake without replaying anything.
        await this.closeWorker(record);
        return;
      }
      await record.worker.client.drain();
    }));
    this.emitState();
    return this.snapshot();
  }

  /** Stop is the explicit cancellation boundary: drain workers, then stop Host and service. */
  async stop(): Promise<DaemonSupervisorSnapshot> {
    if (this.stopPromise !== undefined) return this.stopPromise;
    if (this.supervisorState === "stopped") return this.snapshot();
    const operation = this.stopInternal();
    this.stopPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.stopPromise === operation) this.stopPromise = undefined;
    }
  }

  private async stopInternal(): Promise<DaemonSupervisorSnapshot> {
    if (this.supervisorState === "starting" && this.startPromise !== undefined) {
      await this.startPromise.catch(() => undefined);
    }
    await this.drain();
    await this.host.stop();
    await Promise.allSettled([...this.workers.values()].map((record) => this.closeWorker(record)));
    if (this.service !== undefined) this.serviceStatus = await this.service.stop();
    this.supervisorState = "stopped";
    this.emitState();
    return this.snapshot();
  }

  /** Reconcile descriptors without deleting or killing an identity it cannot prove. */
  async reconcile(
    descriptors?: readonly DaemonSupervisorDescriptor[],
  ): Promise<DaemonSupervisorReconcileResult> {
    const observed = descriptors ?? await this.descriptorReader?.read() ?? [];
    const matched: string[] = [];
    const stale: string[] = [];
    const replaced: string[] = [];
    const unknown: string[] = [];
    const seen = new Set<string>();
    for (const descriptor of observed) {
      validateDescriptor(descriptor);
      seen.add(descriptor.runId);
      const record = this.workers.get(descriptor.runId);
      if (record === undefined) {
        unknown.push(descriptor.runId);
        this.emit({ type: "descriptor", runId: descriptor.runId, result: "unknown" });
      } else if (
        record.workerId !== descriptor.workerId
        || record.generation !== descriptor.generation
        || record.instanceToken !== descriptor.instanceToken
      ) {
        replaced.push(descriptor.runId);
        this.emit({ type: "descriptor", runId: descriptor.runId, result: "replaced" });
      } else {
        matched.push(descriptor.runId);
        this.emit({ type: "descriptor", runId: descriptor.runId, result: "matched" });
      }
    }
    for (const record of this.workers.values()) {
      if (seen.has(record.runId)) continue;
      stale.push(record.runId);
      this.emit({ type: "descriptor", runId: record.runId, result: "stale" });
    }
    return { matched, stale, replaced, unknown };
  }

  async close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    if (this.closed) return;
    const pendingStart = this.startPromise;
    this.closed = true;
    const operation = (async () => {
      try {
        await pendingStart?.catch(() => undefined);
        await this.stop();
      } finally {
        this.hostUnsubscribe();
        if (this.service !== undefined) await this.service.close().catch(() => undefined);
        this.supervisorState = "stopped";
        this.emitState();
      }
    })();
    this.closePromise = operation;
    return operation;
  }

  private async activateWorker(request: DaemonActivationRequest): Promise<void> {
    if (this.supervisorState === "draining") {
      throw new DaemonSupervisorError("draining", "daemon supervisor is draining");
    }
    if (this.supervisorState !== "ready") {
      throw new DaemonSupervisorError("host_failed", "daemon supervisor is not ready");
    }
    if (this.workers.size >= this.maxWorkers) {
      throw new DaemonSupervisorError("capacity", "daemon supervisor worker capacity is full");
    }
    const workerId = identifier(this.createWorkerId(), "workerId");
    const generation = (this.generationsByRun.get(request.runId) ?? 0) + 1;
    this.generationsByRun.set(request.runId, generation);
    const leasePath = identifier(this.leasePathForRun(request.runId), "leasePath");
    const lease: DaemonWorkerLeaseIdentity = {
      runId: request.runId,
      leasePath,
      fencingToken: request.lease.fencingToken,
    };
    let worker: DaemonSupervisorWorker;
    try {
      worker = await this.createWorker({
        runId: request.runId,
        workerId,
        activationId: request.activationId,
        generation,
        lease,
      });
      if (!isWorker(worker)) throw new TypeError("worker factory returned an invalid worker");
    } catch (error: unknown) {
      throw new DaemonSupervisorError("worker_create_failed", persistedErrorText(error));
    }
    const record: WorkerRecord = {
      runId: request.runId,
      workerId,
      generation,
      activationId: request.activationId,
      worker,
      state: "starting",
    };
    this.workers.set(request.runId, record);
    this.emitWorker(record);
    let activationStarted = false;
    const cancelWorker = (): void => {
      if (activationStarted) {
        void Promise.resolve(worker.client.cancel?.(request.activationId, "daemon activation cancelled"))
          .catch(() => undefined);
        return;
      }
      // Closing an unready client wakes a pending initialize/connect promise.
      void Promise.resolve(worker.close?.() ?? worker.client.close())
        .catch(() => undefined);
    };
    request.signal.addEventListener("abort", cancelWorker, { once: true });
    try {
      await request.assertLease?.();
      const ready = await withTimeout(
        worker.client.initialize(),
        this.readyTimeoutMs,
        new DaemonSupervisorError("worker_ready_timeout", "worker ready handshake timed out"),
      );
      if (
        ready.lifecycle !== "ready"
        || ready.initialized !== true
        || typeof ready.instanceToken !== "string"
        || ready.runId !== record.runId
        || ready.workerId !== record.workerId
      ) {
        throw new DaemonSupervisorError("worker_ready_failed", "worker did not complete a ready handshake");
      }
      record.instanceToken = ready.instanceToken;
      if (worker.descriptor !== undefined) {
        validateDescriptor(worker.descriptor);
        if (
          worker.descriptor.runId !== record.runId
          || worker.descriptor.workerId !== record.workerId
          || worker.descriptor.generation !== record.generation
          || worker.descriptor.instanceToken !== record.instanceToken
        ) {
          throw new DaemonSupervisorError("descriptor_mismatch", "worker descriptor identity did not match ready worker");
        }
      }
      record.state = "ready";
      this.emitWorker(record);
      record.state = "running";
      this.emitWorker(record);
      activationStarted = true;
      if (request.signal.aborted) {
        throw new DaemonSupervisorError("worker_failed", "worker activation was cancelled before dispatch");
      }
      await request.assertLease?.();
      const receipt = await worker.client.activate({
        activationId: request.activationId,
        lease,
        wakes: request.wakes.map((wake) => toWorkerWake(wake)),
      });
      classifyReceipt(record, receipt);
      this.emitWorker(record);
      if (receipt.status === "completed") return;
      if (receipt.status === "cancelled") {
        if (isLeaseError(receipt.error?.code)) {
          record.state = "lease-lost";
          throw new DaemonSupervisorError("worker_lease_lost", "worker activation lost its execution lease");
        }
        throw new DaemonSupervisorError("worker_failed", "worker activation was cancelled");
      }
      if (receipt.status === "uncertain") {
        record.state = "uncertain";
        throw new DaemonSupervisorError("worker_uncertain", "worker activation has an uncertain outcome");
      }
      if (receipt.status === "failed") {
        if (isLeaseError(receipt.error?.code)) {
          record.state = "lease-lost";
          throw new DaemonSupervisorError("worker_lease_lost", "worker activation lost its execution lease");
        }
        throw new DaemonSupervisorError("worker_failed", "worker activation failed");
      }
    } catch (error: unknown) {
      if (error instanceof DaemonSupervisorError) {
        record.lastError = error.message;
        if (error.code === "worker_ready_timeout") record.state = "ready-timeout";
        else if (error.code === "worker_uncertain") record.state = "uncertain";
        else if (error.code === "worker_lease_lost") record.state = "lease-lost";
        else if (record.state !== "lease-lost" && record.state !== "uncertain" && record.state !== "ready-timeout") record.state = "failed";
        this.emitWorker(record);
        throw error;
      }
      const snapshot = worker.client.snapshot;
      const code = isLeaseFailure(error)
        ? "worker_lease_lost"
        : snapshot.lifecycle === "failed" || snapshot.lifecycle === "disconnected"
          ? "worker_crashed"
          : "worker_failed";
      record.state = code === "worker_lease_lost" ? "lease-lost" : code === "worker_crashed" ? "crashed" : "failed";
      record.lastError = boundedError(persistedErrorText(error));
      this.emitWorker(record);
      throw new DaemonSupervisorError(code, record.lastError);
    } finally {
      request.signal.removeEventListener("abort", cancelWorker);
      if (record.state === "ready" || record.state === "running") {
        record.state = "completed";
        this.emitWorker(record);
      }
      await this.closeWorker(record);
      this.workers.delete(record.runId);
    }
  }

  private async closeWorker(record: WorkerRecord): Promise<void> {
    try {
      // A completed/failed worker can receive the normal shutdown command.
      // Uncertain, crashed, and fenced workers are closed without a second
      // command so we never turn an unknown side effect into a replay.
      if (
        record.state !== "uncertain"
        && record.state !== "crashed"
        && record.state !== "lease-lost"
        && record.worker.client.shutdown !== undefined
      ) {
        await record.worker.client.shutdown("activation complete");
      }
      if (record.worker.close !== undefined) await record.worker.close();
      else await record.worker.client.close();
    } catch (error: unknown) {
      record.lastError ??= boundedError(persistedErrorText(error));
    }
    record.state = "closed";
    this.emitWorker(record);
  }

  private requireReady(): void {
    if (this.closed) throw new DaemonSupervisorError("closed", "supervisor is closed");
    if (this.supervisorState !== "ready") throw new DaemonSupervisorError("host_failed", "daemon supervisor is not ready");
  }

  private forwardHostEvent(event: DaemonHostEvent): void {
    for (const listener of this.listeners) {
      try {
        listener({ type: "state", snapshot: this.snapshot() });
      } catch {
        // Observers are never allowed to break Host scheduling.
      }
    }
    void event;
  }

  private emitState(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener({ type: "state", snapshot });
      } catch {
        // Observer failures are isolated from lifecycle operations.
      }
    }
  }

  private emitWorker(record: WorkerRecord): void {
    const event: DaemonSupervisorEvent = {
      type: "worker",
      runId: record.runId,
      workerId: record.workerId,
      generation: record.generation,
      state: record.state,
      ...(record.lastError === undefined ? {} : { error: record.lastError }),
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Observer failures are isolated from worker cleanup.
      }
    }
  }

  private emit(event: DaemonSupervisorEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Observer failures are isolated from lifecycle operations.
      }
    }
  }
}

function validateOptions(options: DaemonSupervisorOptions): void {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new DaemonSupervisorError("host_failed", "supervisor options must be an object");
  }
  if (typeof options.admitWake !== "function") throw new DaemonSupervisorError("host_failed", "admitWake must be a function");
  if (typeof options.createWorker !== "function") throw new DaemonSupervisorError("worker_create_failed", "createWorker must be a function");
  if (typeof options.leasePathForRun !== "function") throw new DaemonSupervisorError("worker_create_failed", "leasePathForRun must be a function");
  if (options.createHost !== undefined && typeof options.createHost !== "function") throw new DaemonSupervisorError("host_failed", "createHost must be a function");
  if (options.descriptorReader !== undefined && typeof options.descriptorReader.read !== "function") throw new DaemonSupervisorError("descriptor_mismatch", "descriptorReader must provide read");
}

function isWorker(value: unknown): value is DaemonSupervisorWorker {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<DaemonSupervisorWorker>;
  return candidate.client !== undefined
    && typeof candidate.client.initialize === "function"
    && typeof candidate.client.activate === "function"
    && typeof candidate.client.drain === "function"
    && typeof candidate.client.close === "function";
}

function validateDescriptor(value: DaemonSupervisorDescriptor): void {
  if (value === null || typeof value !== "object") throw new DaemonSupervisorError("descriptor_mismatch", "descriptor must be an object");
  for (const [field, candidate] of Object.entries({
    runId: value.runId,
    workerId: value.workerId,
    instanceToken: value.instanceToken,
  })) {
    if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0")) {
      throw new DaemonSupervisorError("descriptor_mismatch", `descriptor ${field} is invalid`);
    }
  }
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) {
    throw new DaemonSupervisorError("descriptor_mismatch", "descriptor generation is invalid");
  }
}

function toWorkerWake(wake: DaemonWakeRequest): DaemonWorkerWake {
  if (typeof wake.inputId !== "string" || wake.inputId.length === 0) {
    throw new DaemonSupervisorError("worker_failed", "admitted wake is missing input identity");
  }
  return {
    inputId: wake.inputId,
    dedupeKey: wake.dedupeKey,
    source: wake.source,
    ...(wake.payloadRef === undefined ? {} : { payloadRef: wake.payloadRef }),
  };
}

function classifyReceipt(record: WorkerRecord, receipt: DaemonWorkerActivationReceipt): void {
  if (receipt.status === "completed") record.state = "completed";
  else if (receipt.status === "uncertain") record.state = "uncertain";
  else if (receipt.status === "cancelled" && isLeaseError(receipt.error?.code)) record.state = "lease-lost";
  else if (receipt.status === "failed" && isLeaseError(receipt.error?.code)) record.state = "lease-lost";
  else record.state = "failed";
}

function isLeaseError(code: unknown): boolean {
  return code === "lease_mismatch" || code === "stale-lease" || code === "worker_lease_lost";
}

function isLeaseFailure(error: unknown): boolean {
  if (isLeaseError((error as { code?: unknown }).code)) return true;
  return persistedErrorText(error).toLowerCase().includes("lease");
}

function failure(code: DaemonSupervisorFailure["code"], error: unknown): DaemonSupervisorFailure {
  return Object.freeze({ code, message: boundedError(persistedErrorText(error)) });
}

function boundedError(value: string): string {
  if (value.length <= MAX_ERROR_LENGTH) return value;
  return `${value.slice(0, MAX_ERROR_LENGTH - 15)}[TRUNCATED]`;
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.includes("\0")) {
    throw new DaemonSupervisorError("worker_create_failed", `${field} is invalid`);
  }
  return value;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, field: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new DaemonSupervisorError("host_failed", `${field} must be between ${minimum} and ${maximum}`);
  }
  return result;
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, error: Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(error), milliseconds);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
