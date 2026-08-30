import { randomUUID } from "node:crypto";

import {
  FileExecutionLeaseStore,
} from "./file-execution-lease.js";
import type {
  ExecutionLeaseCommitResult,
  ExecutionLeaseStatus,
} from "./execution-lease.js";
import type {
  DaemonWorkerAcceptedFrame,
  DaemonWorkerActivateFrame,
  DaemonWorkerActivationTerminalFrame,
  DaemonWorkerCommandResultFrame,
  DaemonWorkerErrorCode,
  DaemonWorkerFrame,
  DaemonWorkerInitializeFrame,
  DaemonWorkerLeaseIdentity,
  DaemonWorkerRunner,
  DaemonWorkerRunnerContext,
  DaemonWorkerShutdownFrame,
  DaemonWorkerTransport,
} from "./daemon-worker-protocol.js";
import { DaemonWorkerStdioTransport } from "./daemon-worker-transport.js";
import type { Readable, Writable } from "node:stream";

const MAX_COMPLETED_ACTIVATIONS = 1_024;
import {
  DAEMON_WORKER_PROTOCOL_VERSION,
  DEFAULT_DAEMON_WORKER_CANCEL_GRACE_MS,
  DEFAULT_DAEMON_WORKER_MAX_FRAME_BYTES,
  DEFAULT_DAEMON_WORKER_MAX_PENDING_ACTIVATIONS,
  MAX_DAEMON_WORKER_CANCEL_GRACE_MS,
  MAX_DAEMON_WORKER_MAX_FRAME_BYTES,
  MAX_DAEMON_WORKER_MAX_PENDING_ACTIVATIONS,
  DaemonWorkerProtocolError,
  encodeDaemonWorkerFrame,
  validateDaemonWorkerFrame,
  validateDaemonWorkerLease,
} from "./daemon-worker-protocol.js";

export interface DaemonWorkerLeaseStoreFactory {
  open(path: string): Promise<DaemonWorkerLeaseStore>;
}

export interface DaemonWorkerLeaseStore {
  inspect(runId: string): Promise<ExecutionLeaseStatus | undefined>;
  runIfFencingTokenCurrent<T>(
    runId: string,
    fencingToken: number,
    operation: () => Promise<T>,
  ): Promise<ExecutionLeaseCommitResult<T>>;
}

export interface DaemonWorkerServerOptions {
  readonly runId: string;
  readonly workerId: string;
  readonly transport: DaemonWorkerTransport;
  readonly runner: DaemonWorkerRunner;
  readonly leaseStoreFactory?: DaemonWorkerLeaseStoreFactory;
  readonly maxFrameBytes?: number;
  readonly maxPendingActivations?: number;
  readonly cancelGraceMs?: number;
  readonly createInstanceToken?: () => string;
}

export type DaemonWorkerServerLifecycle = "starting" | "ready" | "draining" | "stopped" | "failed";

export interface DaemonWorkerServerSnapshot {
  readonly lifecycle: DaemonWorkerServerLifecycle;
  readonly initialized: boolean;
  readonly runId: string;
  readonly workerId: string;
  readonly pendingActivations: number;
}

interface Activation {
  readonly frame: DaemonWorkerActivateFrame;
  readonly fingerprint: string;
  readonly controller: AbortController;
  promise: Promise<void>;
  terminal: boolean;
}

/**
 * Child-side implementation of the detached worker protocol.
 *
 * It owns no Host state. The only durable authority it can use is the lease
 * file named by the initialize/activate frame, reopened at the child boundary.
 */
export class DaemonWorkerServer {
  readonly runId: string;
  readonly workerId: string;

  private readonly transport: DaemonWorkerTransport;
  private readonly runner: DaemonWorkerRunner;
  private readonly leaseStoreFactory: DaemonWorkerLeaseStoreFactory;
  private readonly maxFrameBytes: number;
  private readonly maxPendingActivations: number;
  private readonly cancelGraceMs: number;
  private readonly createInstanceToken: () => string;
  private readonly activations = new Map<string, Activation>();
  private readonly completed = new Set<string>();
  private unsubscribeFrame: (() => void) | undefined;
  private unsubscribeClose: (() => void) | undefined;
  private initialized = false;
  private closed = false;
  private lifecycle: DaemonWorkerServerLifecycle = "starting";
  private instanceToken: string | undefined;
  private lease: DaemonWorkerLeaseIdentity | undefined;
  private leaseStore: DaemonWorkerLeaseStore | undefined;

  constructor(options: DaemonWorkerServerOptions) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new DaemonWorkerProtocolError("invalid_frame", "worker server options must be an object");
    }
    this.runId = identifier(options.runId, "runId");
    this.workerId = identifier(options.workerId, "workerId");
    if (typeof options.transport?.send !== "function"
      || typeof options.transport.onFrame !== "function"
      || typeof options.transport.onClose !== "function") {
      throw new DaemonWorkerProtocolError("invalid_frame", "worker server transport is invalid");
    }
    if (typeof options.runner?.activate !== "function") {
      throw new DaemonWorkerProtocolError("invalid_frame", "worker server runner is invalid");
    }
    this.transport = options.transport;
    this.runner = options.runner;
    this.leaseStoreFactory = options.leaseStoreFactory ?? {
      open: (path) => FileExecutionLeaseStore.open(path),
    };
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
    this.cancelGraceMs = boundedInteger(
      options.cancelGraceMs,
      DEFAULT_DAEMON_WORKER_CANCEL_GRACE_MS,
      1,
      MAX_DAEMON_WORKER_CANCEL_GRACE_MS,
      "cancelGraceMs",
    );
    this.createInstanceToken = options.createInstanceToken ?? randomUUID;
  }

  get snapshot(): DaemonWorkerServerSnapshot {
    return {
      lifecycle: this.lifecycle,
      initialized: this.initialized,
      runId: this.runId,
      workerId: this.workerId,
      pendingActivations: this.activations.size,
    };
  }

  start(): DaemonWorkerServerSnapshot {
    if (this.unsubscribeFrame !== undefined) return this.snapshot;
    this.unsubscribeFrame = this.transport.onFrame((value) => {
      void this.handle(value);
    });
    this.unsubscribeClose = this.transport.onClose(() => {
      void this.shutdown("transport closed");
    });
    return this.snapshot;
  }

  async close(reason = "worker closed"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lifecycle = "stopped";
    this.unsubscribeFrame?.();
    this.unsubscribeClose?.();
    this.unsubscribeFrame = undefined;
    this.unsubscribeClose = undefined;
    for (const activation of this.activations.values()) activation.controller.abort(new Error(reason));
    await this.waitForActivations();
    try {
      await this.runner.close?.();
    } finally {
      await this.transport.close?.();
    }
  }

  private async handle(value: unknown): Promise<void> {
    if (this.closed) return;
    let frame: DaemonWorkerFrame;
    try {
      if (typeof value === "string" || value instanceof Uint8Array) {
        const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
        frame = JSON.parse(text) as DaemonWorkerFrame;
      } else frame = value as DaemonWorkerFrame;
      validateDaemonWorkerFrame(frame);
    } catch (error: unknown) {
      await this.sendError(null, "invalid_frame", errorMessage(error), false);
      return;
    }
    try {
      if (frame.kind === "initialize") await this.initialize(frame);
      else {
        if (frame.runId !== this.runId) {
          throw new DaemonWorkerProtocolError("identity_mismatch", "worker command Run ID mismatch");
        }
        if (frame.kind === "activate") await this.activate(frame);
        else if (frame.kind === "cancel") await this.cancel(frame.activationId, frame.commandId, frame.reason);
        else if (frame.kind === "drain") await this.drain(frame.commandId);
        else if (frame.kind === "shutdown") await this.shutdown(frame.reason ?? "shutdown requested", frame.commandId);
        else await this.sendError(frame.commandId, "invalid_frame", "worker command is not accepted from the host", false);
      }
    } catch (error: unknown) {
      const code = error instanceof DaemonWorkerProtocolError ? error.code : "internal";
      const retryable = error instanceof DaemonWorkerProtocolError ? error.retryable : false;
      await this.sendError(frame.commandId, code, errorMessage(error), retryable);
    }
  }

  private async initialize(frame: DaemonWorkerInitializeFrame): Promise<void> {
    if (frame.runId !== this.runId || frame.workerId !== this.workerId) {
      throw new DaemonWorkerProtocolError("identity_mismatch", "worker initialize identity mismatch");
    }
    if (this.initialized) {
      if (this.lease !== undefined && sameLease(this.lease, frame.lease)) {
        await this.sendReady(frame.commandId);
        return;
      }
      throw new DaemonWorkerProtocolError("already_initialized", "worker is already initialized");
    }
    validateDaemonWorkerLease(frame.lease);
    if (frame.lease.runId !== this.runId) {
      throw new DaemonWorkerProtocolError("lease_mismatch", "worker lease Run does not match server");
    }
    this.lease = Object.freeze({ ...frame.lease });
    this.instanceToken = identifier(this.createInstanceToken(), "instanceToken");
    this.initialized = true;
    this.lifecycle = "ready";
    await this.sendReady(frame.commandId);
  }

  private async activate(frame: DaemonWorkerActivateFrame): Promise<void> {
    this.requireReady();
    if (this.lifecycle === "draining") {
      throw new DaemonWorkerProtocolError("draining", "worker is draining");
    }
    if (frame.runId !== this.runId || this.lease === undefined || !sameLease(this.lease, frame.lease)) {
      throw new DaemonWorkerProtocolError("lease_mismatch", "worker activation lease does not match initialize");
    }
    const fingerprint = JSON.stringify({ activationId: frame.activationId, lease: frame.lease, wakes: frame.wakes });
    const existing = this.activations.get(frame.activationId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new DaemonWorkerProtocolError("command_conflict", "activation ID was reused with different input");
      }
      await this.sendAccepted(frame);
      return;
    }
    if (this.completed.has(frame.activationId)) {
      await this.sendAccepted(frame);
      return;
    }
    if (this.activations.size >= this.maxPendingActivations) {
      throw new DaemonWorkerProtocolError("queue_full", "worker activation queue is full", true);
    }
    const controller = new AbortController();
    const activation: Activation = {
      frame,
      fingerprint,
      controller,
      terminal: false,
      promise: Promise.resolve(),
    };
    this.activations.set(frame.activationId, activation);
    activation.promise = Promise.resolve().then(() => this.runActivation(activation));
    await this.sendAccepted(frame);
  }

  private async runActivation(activation: Activation): Promise<void> {
    const { frame, controller } = activation;
    try {
      const store = await this.openStore(frame.lease);
      const assertLease = async (): Promise<void> => {
        if (!(await this.leaseIsCurrent(frame.lease, store))) {
          controller.abort(new DaemonWorkerProtocolError("lease_mismatch", "worker execution lease is no longer current"));
          throw new DaemonWorkerProtocolError("lease_mismatch", "worker execution lease is no longer current");
        }
      };
      const commitLease = async <T>(operation: () => Promise<T>): Promise<T> => {
        if (typeof operation !== "function") throw new DaemonWorkerProtocolError("invalid_frame", "commit operation must be a function");
        await assertLease();
        const result = await store.runIfFencingTokenCurrent(
          frame.lease.runId,
          frame.lease.fencingToken,
          operation,
        );
        if (result.status === "lost") throw new DaemonWorkerProtocolError("lease_mismatch", "worker execution lease was fenced");
        return result.value;
      };
      const context: DaemonWorkerRunnerContext = {
        runId: this.runId,
        activationId: frame.activationId,
        lease: frame.lease,
        wakes: Object.freeze(frame.wakes.map((wake) => ({ ...wake }))),
        signal: controller.signal,
        assertLease,
        commitLease,
      };
      // The runner may not call assertLease itself. Fence the execution
      // boundary before handing it any chance to perform side effects.
      await assertLease();
      const outcome = await this.runner.activate(context);
      const status = outcome.status;
      await this.sendTerminal(activation, status, "error" in outcome ? outcome.error : undefined);
    } catch (error: unknown) {
      const cancelled = controller.signal.aborted;
      await this.sendTerminal(
        activation,
        cancelled ? "cancelled" : "failed",
        errorMessage(error),
      );
    } finally {
      this.markCompleted(frame.activationId);
      this.activations.delete(frame.activationId);
    }
  }

  private async cancel(activationId: string, commandId: string, reason: string): Promise<void> {
    this.requireReady();
    const activation = this.activations.get(activationId);
    if (activation === undefined) {
      if (this.completed.has(activationId)) {
        await this.sendCommandResult(commandId, "cancel", "duplicate");
        return;
      }
      throw new DaemonWorkerProtocolError("activation_unknown", "worker activation is unknown");
    }
    activation.controller.abort(new Error(reason));
    await this.runner.cancel?.({ runId: this.runId, activationId, reason });
    const settled = await Promise.race([activation.promise.then(() => true), delay(this.cancelGraceMs).then(() => false)]);
    if (!settled) await this.sendTerminal(activation, "uncertain", "worker did not stop within cancellation grace");
    await this.sendCommandResult(commandId, "cancel", "ok", activationId);
  }

  private async drain(commandId: string): Promise<void> {
    this.requireReady();
    this.lifecycle = "draining";
    await this.sendCommandResult(commandId, "drain", "ok");
  }

  private async shutdown(reason: string, commandId?: string): Promise<void> {
    if (this.closed) return;
    this.lifecycle = "draining";
    for (const activation of this.activations.values()) activation.controller.abort(new Error(reason));
    await this.waitForActivations();
    this.lifecycle = "stopped";
    if (commandId !== undefined) await this.sendCommandResult(commandId, "shutdown", "ok");
    await this.close(reason);
  }

  private async waitForActivations(): Promise<void> {
    const pending = [...this.activations.values()].map((activation) => activation.promise);
    if (pending.length === 0) return;
    await Promise.race([
      Promise.allSettled(pending).then(() => undefined),
      delay(this.cancelGraceMs),
    ]);
  }

  private markCompleted(activationId: string): void {
    this.completed.add(activationId);
    while (this.completed.size > MAX_COMPLETED_ACTIVATIONS) {
      const oldest = this.completed.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.completed.delete(oldest);
    }
  }

  private requireReady(): void {
    if (!this.initialized) throw new DaemonWorkerProtocolError("not_ready", "worker has not completed initialize");
    if (this.lifecycle === "stopped") throw new DaemonWorkerProtocolError("stopped", "worker is stopped");
  }

  private async openStore(lease: DaemonWorkerLeaseIdentity): Promise<DaemonWorkerLeaseStore> {
    if (this.leaseStore !== undefined) return this.leaseStore;
    this.leaseStore = await this.leaseStoreFactory.open(lease.leasePath);
    return this.leaseStore;
  }

  private async leaseIsCurrent(lease: DaemonWorkerLeaseIdentity, store: DaemonWorkerLeaseStore): Promise<boolean> {
    const status = await store.inspect(lease.runId);
    return status !== undefined && status.fencingToken === lease.fencingToken;
  }

  private async sendReady(commandId: string): Promise<void> {
    await this.send({
      kind: "ready",
      version: DAEMON_WORKER_PROTOCOL_VERSION,
      commandId,
      runId: this.runId,
      workerId: this.workerId,
      instanceToken: this.instanceToken!,
    });
  }

  private async sendAccepted(frame: DaemonWorkerActivateFrame): Promise<void> {
    const accepted: DaemonWorkerAcceptedFrame = {
      kind: "accepted",
      version: DAEMON_WORKER_PROTOCOL_VERSION,
      commandId: frame.commandId,
      runId: this.runId,
      activationId: frame.activationId,
    };
    await this.send(accepted);
  }

  private async sendTerminal(
    activation: Activation,
    status: DaemonWorkerActivationTerminalFrame["status"],
    message?: string,
  ): Promise<void> {
    if (activation.terminal) return;
    activation.terminal = true;
    await this.send({
      kind: "activation.terminal",
      version: DAEMON_WORKER_PROTOCOL_VERSION,
      commandId: activation.frame.commandId,
      runId: this.runId,
      activationId: activation.frame.activationId,
      status,
      ...(message === undefined ? {} : { error: { code: status === "uncertain" ? "cancel_timeout" : "runner_failed", message: message.slice(0, 512) } }),
    });
  }

  private async sendCommandResult(
    commandId: string,
    command: DaemonWorkerCommandResultFrame["command"],
    status: DaemonWorkerCommandResultFrame["status"],
    activationId?: string,
  ): Promise<void> {
    await this.send({
      kind: "command.result",
      version: DAEMON_WORKER_PROTOCOL_VERSION,
      commandId,
      runId: this.runId,
      command,
      status,
      lifecycle: this.lifecycle,
      ...(activationId === undefined ? {} : { activationId }),
    });
  }

  private async sendError(commandId: string | null, code: DaemonWorkerErrorCode, message: string, retryable: boolean): Promise<void> {
    await this.send({
      kind: "error",
      version: DAEMON_WORKER_PROTOCOL_VERSION,
      commandId,
      runId: this.runId,
      code,
      message: message.slice(0, 512),
      retryable,
    });
  }

  private async send(frame: DaemonWorkerFrame): Promise<void> {
    encodeDaemonWorkerFrame(frame, this.maxFrameBytes);
    await this.transport.send(frame);
  }
}

export function createDaemonWorkerServer(options: DaemonWorkerServerOptions): DaemonWorkerServer {
  const server = new DaemonWorkerServer(options);
  server.start();
  return server;
}

export interface DaemonWorkerStdioServerOptions extends Omit<DaemonWorkerServerOptions, "transport"> {
  readonly input?: Readable;
  readonly output?: Writable;
}

/** Bootstrap helper for a child entrypoint using stdin/stdout JSONL. */
export function runDaemonWorkerStdioServer(options: DaemonWorkerStdioServerOptions): DaemonWorkerServer {
  const transport = new DaemonWorkerStdioTransport({
    input: options.input ?? process.stdin,
    output: options.output ?? process.stdout,
    ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
  });
  return createDaemonWorkerServer({ ...options, transport });
}

function sameLease(left: DaemonWorkerLeaseIdentity, right: DaemonWorkerLeaseIdentity): boolean {
  return left.runId === right.runId
    && left.leasePath === right.leasePath
    && left.fencingToken === right.fencingToken;
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.includes("\0")) {
    throw new DaemonWorkerProtocolError("invalid_frame", `worker ${field} is invalid`);
  }
  return value;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, field: string): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) throw new RangeError(`${field} is outside its supported range`);
  return candidate;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}
