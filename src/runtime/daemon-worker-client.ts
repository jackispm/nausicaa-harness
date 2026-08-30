import { randomUUID } from "node:crypto";

import type {
  DaemonWorkerAcceptedFrame,
  DaemonWorkerActivateFrame,
  DaemonWorkerActivationTerminalFrame,
  DaemonWorkerCommandResultFrame,
  DaemonWorkerCommand,
  DaemonWorkerDrainFrame,
  DaemonWorkerErrorFrame,
  DaemonWorkerFrame,
  DaemonWorkerInitializeFrame,
  DaemonWorkerLeaseIdentity,
  DaemonWorkerRunnerOutcome,
  DaemonWorkerShutdownFrame,
  DaemonWorkerTransport,
  DaemonWorkerWake,
} from "./daemon-worker-protocol.js";
import {
  DAEMON_WORKER_PROTOCOL_VERSION,
  DEFAULT_DAEMON_WORKER_ACTIVATION_TIMEOUT_MS,
  DEFAULT_DAEMON_WORKER_CANCEL_GRACE_MS,
  DEFAULT_DAEMON_WORKER_MAX_FRAME_BYTES,
  DEFAULT_DAEMON_WORKER_MAX_PENDING_ACTIVATIONS,
  MAX_DAEMON_WORKER_ACTIVATION_TIMEOUT_MS,
  MAX_DAEMON_WORKER_CANCEL_GRACE_MS,
  MAX_DAEMON_WORKER_MAX_FRAME_BYTES,
  MAX_DAEMON_WORKER_MAX_PENDING_ACTIVATIONS,
  DaemonWorkerProtocolError,
  DaemonWorkerTransportError,
  encodeDaemonWorkerFrame,
  validateDaemonWorkerFrame,
  validateDaemonWorkerLease,
} from "./daemon-worker-protocol.js";

const MAX_COMPLETED_ACTIVATIONS = 1_024;

export interface DaemonWorkerTransportFactory {
  connect(): Promise<DaemonWorkerTransport>;
}

export interface DaemonWorkerClientOptions {
  readonly runId: string;
  readonly workerId: string;
  readonly lease: DaemonWorkerLeaseIdentity;
  readonly transport?: DaemonWorkerTransport;
  readonly transportFactory?: DaemonWorkerTransportFactory;
  readonly maxFrameBytes?: number;
  readonly maxPendingActivations?: number;
  readonly commandTimeoutMs?: number;
  readonly activationTimeoutMs?: number;
  readonly cancelGraceMs?: number;
  readonly createCommandId?: () => string;
}

export type DaemonWorkerClientLifecycle =
  | "disconnected"
  | "starting"
  | "ready"
  | "draining"
  | "stopped"
  | "failed";

export interface DaemonWorkerActivationRequest {
  readonly activationId: string;
  readonly wakes: readonly DaemonWorkerWake[];
  readonly lease?: DaemonWorkerLeaseIdentity;
}

export interface DaemonWorkerActivationReceipt {
  readonly activationId: string;
  readonly runId: string;
  readonly status: "completed" | "failed" | "cancelled" | "uncertain";
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface DaemonWorkerClientSnapshot {
  readonly lifecycle: DaemonWorkerClientLifecycle;
  readonly connected: boolean;
  readonly initialized: boolean;
  readonly runId: string;
  readonly workerId: string;
  readonly instanceToken?: string;
  readonly activeActivationId?: string;
  readonly pendingActivations: number;
}

interface PendingCommand<T> {
  readonly commandId: string;
  readonly kind: DaemonWorkerCommand["kind"];
  readonly activationId?: string;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface PendingActivation {
  readonly activationId: string;
  readonly commandId: string;
  readonly fingerprint: string;
  accepted: boolean;
  settled: boolean;
  readonly resolve: (receipt: DaemonWorkerActivationReceipt) => void;
  readonly promise: Promise<DaemonWorkerActivationReceipt>;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Client for one detached Run worker. The client is transport-only: it never
 * owns a Ledger and it never passes an execution-lease closure across IPC.
 */
export class DaemonWorkerClient {
  readonly runId: string;
  readonly workerId: string;

  private readonly lease: DaemonWorkerLeaseIdentity;
  private readonly maxFrameBytes: number;
  private readonly maxPendingActivations: number;
  private readonly commandTimeoutMs: number;
  private readonly activationTimeoutMs: number;
  private readonly cancelGraceMs: number;
  private readonly createCommandId: () => string;
  private readonly initialTransport: DaemonWorkerTransport | undefined;
  private readonly transportFactory: DaemonWorkerTransportFactory | undefined;
  private transport: DaemonWorkerTransport | undefined;
  private unsubscribeFrame: (() => void) | undefined;
  private unsubscribeClose: (() => void) | undefined;
  private readonly pendingCommands = new Map<string, PendingCommand<unknown>>();
  private readonly pendingActivations = new Map<string, PendingActivation>();
  private readonly completedActivations = new Map<string, DaemonWorkerActivationReceipt>();
  private initialized = false;
  private instanceToken: string | undefined;
  private lifecycle: DaemonWorkerClientLifecycle = "disconnected";
  private closed = false;
  private connectionPromise: Promise<void> | undefined;

  constructor(options: DaemonWorkerClientOptions) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new DaemonWorkerProtocolError("invalid_frame", "worker client options must be an object");
    }
    this.runId = identifier(options.runId, "runId");
    this.workerId = identifier(options.workerId, "workerId");
    validateDaemonWorkerLease(options.lease);
    if (options.lease.runId !== this.runId) {
      throw new DaemonWorkerProtocolError("identity_mismatch", "worker lease Run does not match client");
    }
    this.lease = Object.freeze({ ...options.lease });
    if (options.transport !== undefined && options.transportFactory !== undefined) {
      throw new DaemonWorkerProtocolError("invalid_frame", "worker client accepts one transport source");
    }
    if (options.transport === undefined && options.transportFactory === undefined) {
      throw new DaemonWorkerProtocolError("invalid_frame", "worker client requires a transport source");
    }
    this.initialTransport = options.transport;
    this.transportFactory = options.transportFactory;
    this.maxFrameBytes = boundedInteger(
      options.maxFrameBytes,
      DEFAULT_DAEMON_WORKER_MAX_FRAME_BYTES,
      1,
      MAX_DAEMON_WORKER_MAX_FRAME_BYTES,
      "maxFrameBytes",
    );
    this.maxPendingActivations = boundedInteger(
      options.maxPendingActivations,
      DEFAULT_DAEMON_WORKER_MAX_PENDING_ACTIVATIONS,
      1,
      MAX_DAEMON_WORKER_MAX_PENDING_ACTIVATIONS,
      "maxPendingActivations",
    );
    this.commandTimeoutMs = boundedInteger(options.commandTimeoutMs, 10_000, 1, 5 * 60_000, "commandTimeoutMs");
    this.activationTimeoutMs = boundedInteger(
      options.activationTimeoutMs,
      DEFAULT_DAEMON_WORKER_ACTIVATION_TIMEOUT_MS,
      1,
      MAX_DAEMON_WORKER_ACTIVATION_TIMEOUT_MS,
      "activationTimeoutMs",
    );
    this.cancelGraceMs = boundedInteger(
      options.cancelGraceMs,
      DEFAULT_DAEMON_WORKER_CANCEL_GRACE_MS,
      1,
      MAX_DAEMON_WORKER_CANCEL_GRACE_MS,
      "cancelGraceMs",
    );
    this.createCommandId = options.createCommandId ?? randomUUID;
    if (typeof this.createCommandId !== "function") {
      throw new DaemonWorkerProtocolError("invalid_frame", "createCommandId must be a function");
    }
  }

  get snapshot(): DaemonWorkerClientSnapshot {
    const active = [...this.pendingActivations.values()].find((item) => !item.settled);
    return {
      lifecycle: this.lifecycle,
      connected: this.transport !== undefined,
      initialized: this.initialized,
      runId: this.runId,
      workerId: this.workerId,
      ...(this.instanceToken === undefined ? {} : { instanceToken: this.instanceToken }),
      ...(active === undefined ? {} : { activeActivationId: active.activationId }),
      pendingActivations: this.pendingActivations.size,
    };
  }

  /** Establish transport and complete initialize -> ready handshake. */
  async initialize(): Promise<DaemonWorkerClientSnapshot> {
    this.assertOpen();
    if (this.initialized && this.transport !== undefined) return this.snapshot;
    await this.connectTransport();
    const commandId = this.newCommandId();
    const frame: DaemonWorkerInitializeFrame = {
      kind: "initialize",
      version: DAEMON_WORKER_PROTOCOL_VERSION,
      commandId,
      runId: this.runId,
      workerId: this.workerId,
      lease: structuredClone(this.lease),
    };
    const ready = await this.sendAwait<DaemonWorkerReadyLike>(frame, "initialize");
    if (
      ready.runId !== this.runId
      || ready.workerId !== this.workerId
      || typeof ready.instanceToken !== "string"
    ) {
      const error = new DaemonWorkerProtocolError("identity_mismatch", "worker ready identity mismatch");
      this.failConnection(error);
      throw error;
    }
    this.initialized = true;
    this.instanceToken = ready.instanceToken;
    this.lifecycle = "ready";
    return this.snapshot;
  }

  /** Submit one activation and await exactly one terminal receipt. */
  async activate(request: DaemonWorkerActivationRequest): Promise<DaemonWorkerActivationReceipt> {
    this.assertOpen();
    await this.initialize();
    const activationId = identifier(request.activationId, "activationId");
    const wakes = structuredClone(request.wakes);
    if (!Array.isArray(wakes)) {
      throw new DaemonWorkerProtocolError("invalid_frame", "activation wakes must be an array");
    }
    const lease = request.lease ?? this.lease;
    validateDaemonWorkerLease(lease);
    if (!sameLease(lease, this.lease)) {
      throw new DaemonWorkerProtocolError("lease_mismatch", "activation lease does not match initialized lease");
    }
    const fingerprint = JSON.stringify({ activationId, lease, wakes });
    const existing = this.pendingActivations.get(activationId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new DaemonWorkerProtocolError("command_conflict", "activation ID was reused with different input");
      }
      return existing.promise;
    }
    const completed = this.completedActivations.get(activationId);
    if (completed !== undefined) return completed;
    if (this.pendingActivations.size >= this.maxPendingActivations) {
      throw new DaemonWorkerProtocolError("queue_full", "worker activation queue is full", true);
    }
    const commandId = this.newCommandId();
    let resolveReceipt!: (receipt: DaemonWorkerActivationReceipt) => void;
    const promise = new Promise<DaemonWorkerActivationReceipt>((resolve) => {
      resolveReceipt = resolve;
    });
    const timer = setTimeout(() => {
      this.settleActivation(activationId, {
        activationId,
        runId: this.runId,
        status: "uncertain",
        error: {
          code: "activation_timeout",
          message: "worker activation did not reach a terminal receipt before its deadline",
        },
      });
    }, this.activationTimeoutMs);
    timer.unref?.();
    const pending: PendingActivation = {
      activationId,
      commandId,
      fingerprint,
      accepted: false,
      settled: false,
      resolve: resolveReceipt,
      promise,
      timer,
    };
    this.pendingActivations.set(activationId, pending);
    const frame: DaemonWorkerActivateFrame = {
      kind: "activate",
      version: DAEMON_WORKER_PROTOCOL_VERSION,
      commandId,
      runId: this.runId,
      activationId,
      lease: structuredClone(lease),
      wakes,
    };
    // The transport is allowed to remain unresolved while the worker is still
    // processing the activation.  The activation deadline, close handler, or
    // terminal frame owns the receipt lifecycle; do not make the caller wait
    // for a potentially hung send promise.
    void this.send(frame).catch((error: unknown) => {
      if (!pending.settled) {
        this.settleActivation(activationId, uncertainReceipt(this.runId, activationId, error));
      }
    });
    return promise;
  }

  async cancel(activationId: string, reason = "Cancelled by host"): Promise<DaemonWorkerClientSnapshot> {
    this.assertOpen();
    await this.requireReady();
    const id = identifier(activationId, "activationId");
    const pending = this.pendingActivations.get(id);
    if (pending === undefined && !this.completedActivations.has(id)) {
      throw new DaemonWorkerProtocolError("activation_unknown", "worker activation is unknown");
    }
    const frame: DaemonWorkerCommand = {
      kind: "cancel",
      version: DAEMON_WORKER_PROTOCOL_VERSION,
      commandId: this.newCommandId(),
      runId: this.runId,
      activationId: id,
      reason: boundedReason(reason),
    };
    await this.sendAwait<DaemonWorkerCommandResultFrame>(frame, "cancel");
    return this.snapshot;
  }

  async drain(): Promise<DaemonWorkerClientSnapshot> {
    this.assertOpen();
    await this.requireReady();
    const frame: DaemonWorkerDrainFrame = {
      kind: "drain",
      version: DAEMON_WORKER_PROTOCOL_VERSION,
      commandId: this.newCommandId(),
      runId: this.runId,
    };
    const result = await this.sendAwait<DaemonWorkerCommandResultFrame>(frame, "drain");
    this.lifecycle = result.lifecycle === "draining" ? "draining" : result.lifecycle;
    return this.snapshot;
  }

  async shutdown(reason = "Shutdown requested"): Promise<DaemonWorkerClientSnapshot> {
    if (this.closed) return this.snapshot;
    if (this.transport === undefined || !this.initialized) {
      this.lifecycle = "stopped";
      await this.close();
      return this.snapshot;
    }
    const frame: DaemonWorkerShutdownFrame = {
      kind: "shutdown",
      version: DAEMON_WORKER_PROTOCOL_VERSION,
      commandId: this.newCommandId(),
      runId: this.runId,
      reason: boundedReason(reason),
    };
    try {
      const result = await this.sendAwait<DaemonWorkerCommandResultFrame>(frame, "shutdown");
      this.lifecycle = result.lifecycle === "stopped" ? "stopped" : result.lifecycle;
    } finally {
      await this.close();
    }
    return this.snapshot;
  }

  /** Close only the client transport; it never cancels a Run by itself. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeFrame?.();
    this.unsubscribeClose?.();
    this.unsubscribeFrame = undefined;
    this.unsubscribeClose = undefined;
    const transport = this.transport;
    this.transport = undefined;
    for (const activation of [...this.pendingActivations.values()]) {
      this.settleActivation(activation.activationId, uncertainReceipt(
        this.runId,
        activation.activationId,
        new DaemonWorkerTransportError("closed", "worker client closed during activation"),
      ));
    }
    this.rejectPendingCommands(new DaemonWorkerTransportError("closed", "worker client closed"));
    if (transport?.close !== undefined) await transport.close();
    this.initialized = false;
    this.instanceToken = undefined;
    this.lifecycle = "stopped";
  }

  private async requireReady(): Promise<void> {
    if (!this.initialized || this.transport === undefined || this.lifecycle !== "ready" && this.lifecycle !== "draining") {
      throw new DaemonWorkerProtocolError("not_ready", "worker has not completed initialize");
    }
  }

  private async connectTransport(): Promise<void> {
    if (this.transport !== undefined) return;
    if (this.connectionPromise !== undefined) return this.connectionPromise;
    this.lifecycle = "starting";
    const operation = (async (): Promise<void> => {
      const transport = this.initialTransport
        ?? await this.transportFactory!.connect();
      this.transport = transport;
      this.unsubscribeFrame = transport.onFrame((frame) => this.handleFrame(frame));
      this.unsubscribeClose = transport.onClose((error) => this.handleClose(error));
    })();
    this.connectionPromise = operation;
    try {
      await operation;
    } catch (error: unknown) {
      this.lifecycle = "failed";
      throw asError(error, "worker transport connection failed");
    } finally {
      if (this.connectionPromise === operation) this.connectionPromise = undefined;
    }
  }

  private async send(frame: DaemonWorkerFrame): Promise<void> {
    const transport = this.transport;
    if (transport === undefined) throw new DaemonWorkerTransportError("disconnected", "worker transport is disconnected");
    // Validation/encoding is intentionally performed before transport.send so
    // fake transports and real JSONL transports share the same byte boundary.
    encodeDaemonWorkerFrame(frame, this.maxFrameBytes);
    await transport.send(frame);
  }

  private sendAwait<T>(frame: DaemonWorkerFrame, kind: DaemonWorkerCommand["kind"]): Promise<T> {
    const commandId = frame.commandId;
    if (typeof commandId !== "string") {
      return Promise.reject(new DaemonWorkerProtocolError("invalid_frame", `worker ${kind} command ID is invalid`));
    }
    if (this.pendingCommands.has(commandId)) {
      return Promise.reject(new DaemonWorkerProtocolError(
        "command_conflict",
        `worker command ID is already pending: ${commandId}`,
      ));
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(commandId);
        reject(new DaemonWorkerTransportError("timeout", `worker ${kind} command timed out`));
      }, this.commandTimeoutMs);
      timer.unref?.();
      this.pendingCommands.set(commandId, {
        commandId,
        kind,
        ...(frame.kind === "activate" ? { activationId: frame.activationId } : {}),
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      void this.send(frame).catch((error: unknown) => {
        const pending = this.pendingCommands.get(commandId);
        if (pending === undefined) return;
        this.pendingCommands.delete(commandId);
        clearTimeout(pending.timer);
        pending.reject(asError(error, "worker command failed"));
      });
    });
  }

  private handleFrame(value: unknown): void {
    let frame: DaemonWorkerFrame;
    try {
      if (typeof value === "string" || value instanceof Uint8Array) {
        // Avoid a dynamic import in the hot path; fake transports normally send objects.
        const parsed = JSON.parse(typeof value === "string" ? value : Buffer.from(value).toString("utf8"));
        validateDaemonWorkerFrame(parsed);
        frame = parsed;
      } else {
        validateDaemonWorkerFrame(value);
        frame = value;
      }
    } catch (error: unknown) {
      this.failConnection(new DaemonWorkerTransportError(
        "malformed",
        error instanceof Error ? error.message : "worker sent a malformed frame",
      ));
      return;
    }
    if (frame.version !== DAEMON_WORKER_PROTOCOL_VERSION) {
      this.failConnection(new DaemonWorkerProtocolError("unsupported_version", "worker protocol version is unsupported"));
      return;
    }
    if (frame.kind === "accepted") {
      if (frame.runId !== this.runId) {
        this.failConnection(new DaemonWorkerProtocolError("identity_mismatch", "worker acceptance Run ID mismatch"));
        return;
      }
      this.handleAccepted(frame);
      return;
    }
    if (frame.kind === "activation.terminal") {
      if (frame.runId !== this.runId) {
        this.failConnection(new DaemonWorkerProtocolError("identity_mismatch", "worker terminal Run ID mismatch"));
        return;
      }
      this.handleTerminal(frame);
      return;
    }
    if (frame.kind === "error") {
      this.handleError(frame);
      return;
    }
    if (frame.kind === "ready") {
      if (frame.runId !== this.runId) {
        this.failConnection(new DaemonWorkerProtocolError("identity_mismatch", "worker ready Run ID mismatch"));
        return;
      }
      this.resolveCommand(frame.commandId, frame);
      return;
    }
    if (frame.kind === "command.result") {
      if (frame.runId !== this.runId) {
        this.failConnection(new DaemonWorkerProtocolError("identity_mismatch", "worker command result Run ID mismatch"));
        return;
      }
      this.resolveCommand(frame.commandId, frame);
    }
  }

  private handleAccepted(frame: DaemonWorkerAcceptedFrame): void {
    const pending = this.pendingActivations.get(frame.activationId);
    if (pending === undefined || pending.settled) return;
    if (pending.commandId !== frame.commandId) {
      this.failConnection(new DaemonWorkerProtocolError("command_conflict", "worker acceptance command does not match activation"));
      return;
    }
    pending.accepted = true;
    this.resolveCommand(frame.commandId, frame);
  }

  private handleTerminal(frame: DaemonWorkerActivationTerminalFrame): void {
    const pending = this.pendingActivations.get(frame.activationId);
    const prior = this.completedActivations.get(frame.activationId);
    const receipt = toReceipt(frame);
    if (prior !== undefined) {
      // Duplicate terminal frames are harmless; a conflicting second terminal
      // is ignored so the client never exposes two outcomes for one activation.
      return;
    }
    if (pending === undefined) {
      this.completedActivations.set(frame.activationId, receipt);
      return;
    }
    if (pending.commandId !== frame.commandId) {
      this.failConnection(new DaemonWorkerProtocolError("command_conflict", "worker terminal command does not match activation"));
      return;
    }
    this.settleActivation(frame.activationId, receipt);
  }

  private handleError(frame: DaemonWorkerErrorFrame): void {
    if (frame.runId !== undefined && frame.runId !== this.runId) {
      this.failConnection(new DaemonWorkerProtocolError("identity_mismatch", "worker error Run ID mismatch"));
      return;
    }
    if (frame.commandId === null) {
      this.failConnection(new DaemonWorkerProtocolError(frame.code, frame.message, frame.retryable));
      return;
    }
    const pending = this.pendingCommands.get(frame.commandId);
    if (pending?.activationId !== undefined) {
      this.pendingCommands.delete(frame.commandId);
      clearTimeout(pending.timer);
      this.settleActivation(pending.activationId, {
        activationId: pending.activationId,
        runId: this.runId,
        status: "failed",
        error: { code: frame.code, message: frame.message },
      });
      return;
    }
    if (pending === undefined) {
      const activation = [...this.pendingActivations.values()]
        .find((candidate) => candidate.commandId === frame.commandId);
      if (activation !== undefined) {
        this.settleActivation(activation.activationId, {
          activationId: activation.activationId,
          runId: this.runId,
          status: "failed",
          error: { code: frame.code, message: frame.message },
        });
        return;
      }
    }
    if (pending === undefined) return;
    this.pendingCommands.delete(frame.commandId);
    clearTimeout(pending.timer);
    pending.reject(new DaemonWorkerProtocolError(frame.code, frame.message, frame.retryable));
  }

  private resolveCommand(commandId: string, value: unknown): void {
    const pending = this.pendingCommands.get(commandId);
    if (pending === undefined) return;
    this.pendingCommands.delete(commandId);
    clearTimeout(pending.timer);
    pending.resolve(value);
  }

  private handleClose(error?: Error): void {
    if (this.closed) return;
    this.transport = undefined;
    this.initialized = false;
    this.instanceToken = undefined;
    if (this.lifecycle !== "failed") this.lifecycle = "disconnected";
    const transportError = new DaemonWorkerTransportError(
      "disconnected",
      error?.message === undefined ? "worker transport disconnected" : `worker transport disconnected: ${error.message}`,
    );
    for (const activation of [...this.pendingActivations.values()]) {
      this.settleActivation(activation.activationId, uncertainReceipt(this.runId, activation.activationId, transportError));
    }
    this.rejectPendingCommands(transportError);
  }

  private failConnection(error: Error): void {
    this.lifecycle = "failed";
    this.handleClose(error);
  }

  private settleActivation(activationId: string, receipt: DaemonWorkerActivationReceipt): void {
    const pending = this.pendingActivations.get(activationId);
    if (pending === undefined) {
      this.completedActivations.set(activationId, receipt);
      return;
    }
    if (pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timer);
    this.pendingActivations.delete(activationId);
    this.completedActivations.set(activationId, receipt);
    while (this.completedActivations.size > MAX_COMPLETED_ACTIVATIONS) {
      const oldest = this.completedActivations.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.completedActivations.delete(oldest);
    }
    pending.resolve(receipt);
  }

  private rejectPendingCommands(error: Error): void {
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingCommands.clear();
  }

  private newCommandId(): string {
    const value = this.createCommandId();
    return identifier(value, "commandId");
  }

  private assertOpen(): void {
    if (this.closed) throw new DaemonWorkerTransportError("closed", "worker client is closed");
  }
}

interface DaemonWorkerReadyLike {
  readonly runId: string;
  readonly workerId: string;
  readonly instanceToken: string;
}

function toReceipt(frame: DaemonWorkerActivationTerminalFrame): DaemonWorkerActivationReceipt {
  return {
    activationId: frame.activationId,
    runId: frame.runId,
    status: frame.status,
    ...(frame.error === undefined ? {} : { error: frame.error }),
  };
}

function uncertainReceipt(
  runId: string,
  activationId: string,
  error: unknown,
): DaemonWorkerActivationReceipt {
  return {
    activationId,
    runId,
    status: "uncertain",
    error: {
      code: error instanceof DaemonWorkerTransportError ? error.transportCode : "uncertain",
      message: error instanceof Error ? error.message : "worker activation outcome is uncertain",
    },
  };
}

function sameLease(left: DaemonWorkerLeaseIdentity, right: DaemonWorkerLeaseIdentity): boolean {
  return left.runId === right.runId
    && left.leasePath === right.leasePath
    && left.fencingToken === right.fencingToken;
}

function boundedReason(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) return "Cancelled by host";
  return value.trim().slice(0, 512);
}

function identifier(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 512
    || value.trim() !== value
    || value.includes("\0")
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new DaemonWorkerProtocolError("invalid_frame", `worker ${field} is invalid`);
  }
  return value;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new RangeError(`${field} is outside its supported range`);
  }
  return candidate;
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

// Keep the runner outcome import in the public module's declaration surface;
// S6 can use it when binding DaemonHost to the child runner.
export type { DaemonWorkerRunnerOutcome };
