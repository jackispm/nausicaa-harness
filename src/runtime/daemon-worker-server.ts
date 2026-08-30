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
  DaemonWorkerCommand,
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
import { persistedErrorText } from "./redaction.js";

const MAX_COMPLETED_ACTIVATIONS = 1_024;
const MAX_COMMAND_RECORDS = 4_096;
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
  readonly commandIds: Set<string>;
  promise: Promise<void>;
  terminal?: DaemonWorkerActivationTerminalFrame;
}

interface CompletedActivation {
  readonly commandId: string;
  readonly fingerprint: string;
  readonly terminal: DaemonWorkerActivationTerminalFrame;
}

interface CommandRecord {
  readonly signature: string;
  readonly kind: DaemonWorkerCommand["kind"];
  readonly activationId?: string;
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
  private readonly completed = new Map<string, CompletedActivation>();
  private readonly commandRecords = new Map<string, CommandRecord>();
  private readonly activeCommandIds = new Set<string>();
  private dispatchTail: Promise<void> = Promise.resolve();
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
    if (this.closed) return this.snapshot;
    if (this.unsubscribeFrame !== undefined) return this.snapshot;
    this.unsubscribeFrame = this.transport.onFrame((value) => {
      this.enqueue(() => this.handle(value));
    });
    this.unsubscribeClose = this.transport.onClose(() => {
      this.enqueue(() => this.shutdown("transport closed"));
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
    // Preserve runner-before-transport ordering while bounding each hook.
    // A child must finish its own cleanup attempt before its IPC stream is
    // torn down, but a misbehaving hook cannot hold shutdown indefinitely.
    await settleWithin(
      Promise.resolve().then(() => this.runner.close?.()),
      this.cancelGraceMs,
    );
    await settleWithin(
      Promise.resolve().then(() => this.transport.close?.()),
      this.cancelGraceMs,
    );
    this.initialized = false;
    this.instanceToken = undefined;
    this.lease = undefined;
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
      if (!isDaemonWorkerCommand(frame)) {
        await this.sendError(frame.commandId, "invalid_frame", "worker frame is not a host command", false);
        return;
      }
      if (frame.kind === "initialize") {
        this.rememberCommand(frame);
        this.activeCommandIds.add(frame.commandId);
        try {
          await this.initialize(frame);
        } finally {
          this.activeCommandIds.delete(frame.commandId);
          this.pruneCommandRecords();
        }
      } else {
        if (frame.runId !== this.runId) {
          throw new DaemonWorkerProtocolError("identity_mismatch", "worker command Run ID mismatch");
        }
        this.rememberCommand(frame);
        this.activeCommandIds.add(frame.commandId);
        try {
          if (frame.kind === "activate") await this.activate(frame);
          else if (frame.kind === "cancel") await this.cancel(frame.activationId, frame.commandId, frame.reason);
          else if (frame.kind === "drain") await this.drain(frame.commandId);
          else if (frame.kind === "shutdown") await this.shutdown(frame.reason ?? "shutdown requested", frame.commandId);
        } finally {
          this.activeCommandIds.delete(frame.commandId);
          this.pruneCommandRecords();
        }
      }
    } catch (error: unknown) {
      const code = error instanceof DaemonWorkerProtocolError ? error.code : "internal";
      const retryable = error instanceof DaemonWorkerProtocolError ? error.retryable : false;
      await this.sendError(frame.commandId, code, errorMessage(error), retryable);
    }
  }

  /**
   * Transport callbacks can arrive back-to-back (notably initialize followed
   * by activate). Keep protocol handling serialized so the handshake and
   * command state transitions cannot overtake one another.
   */
  private enqueue(operation: () => Promise<void>): void {
    this.dispatchTail = this.dispatchTail
      .then(operation)
      .catch(async (error: unknown) => {
        if (this.closed) return;
        try {
          await this.sendError(null, "internal", errorMessage(error), false);
        } catch {
          // A transport failure is reported through its close callback. Do
          // not leave an unhandled rejection on the dispatch chain.
        }
      });
  }

  private rememberCommand(frame: DaemonWorkerCommand): void {
    const signature = commandSignature(frame);
    const activationId = commandActivationId(frame);
    const prior = this.commandRecords.get(frame.commandId);
    if (prior !== undefined) {
      if (
        prior.kind !== frame.kind
        || prior.activationId !== activationId
        || prior.signature !== signature
      ) {
        throw new DaemonWorkerProtocolError("command_conflict", "worker command ID was reused with different input");
      }
      return;
    }
    const record: CommandRecord = {
      signature,
      kind: frame.kind,
      ...(activationId === undefined ? {} : { activationId }),
    };
    this.commandRecords.set(frame.commandId, record);
    this.pruneCommandRecords();
  }

  private pruneCommandRecords(): void {
    while (this.commandRecords.size > MAX_COMMAND_RECORDS) {
      const candidate = [...this.commandRecords.keys()]
        .find((commandId) => !this.commandRecordProtected(commandId));
      if (candidate === undefined) return;
      this.commandRecords.delete(candidate);
    }
  }

  private commandRecordProtected(commandId: string): boolean {
    if (this.activeCommandIds.has(commandId)) return true;
    for (const activation of this.activations.values()) {
      if (activation.frame.commandId === commandId) return true;
    }
    for (const activation of this.completed.values()) {
      if (activation.commandId === commandId) return true;
    }
    return false;
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
      existing.commandIds.add(frame.commandId);
      await settleWithin(this.sendAccepted(frame), this.cancelGraceMs);
      if (existing.terminal !== undefined) {
        await this.sendTerminalReplay(existing.terminal, frame.commandId);
      }
      return;
    }
    const completed = this.completed.get(frame.activationId);
    if (completed !== undefined) {
      if (completed.fingerprint !== fingerprint) {
        throw new DaemonWorkerProtocolError("command_conflict", "activation ID was reused with different input");
      }
      await settleWithin(this.sendAccepted(frame), this.cancelGraceMs);
      await this.sendTerminalReplay(completed.terminal, frame.commandId);
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
      commandIds: new Set([frame.commandId]),
      promise: Promise.resolve(),
    };
    this.activations.set(frame.activationId, activation);
    // Give the accepted write a bounded chance to cross the transport before
    // scheduling the runner. A broken transport must not strand the admitted
    // activation, but healthy transports retain accepted-before-terminal order.
    const accepted = settleWithin(this.sendAccepted(frame), this.cancelGraceMs);
    activation.promise = accepted.then(async () => {
      if (this.closed || this.activations.get(frame.activationId) !== activation) {
        this.activations.delete(frame.activationId);
        return;
      }
      await this.runActivation(activation);
    });
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
    // The optional hook is advisory and may itself hang. Bound its wait so the
    // command still reaches a terminal result within a finite grace window;
    // the activation signal remains authoritative if the hook fails.
    await settleWithin(
      Promise.resolve()
        .then(() => this.runner.cancel?.({ runId: this.runId, activationId, reason }))
        .catch(() => undefined),
      this.cancelGraceMs,
    );
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
    try {
      if (commandId !== undefined) await this.sendCommandResult(commandId, "shutdown", "ok");
    } finally {
      await this.close(reason);
    }
  }

  private async waitForActivations(): Promise<void> {
    const pending = [...this.activations.values()].map((activation) => activation.promise);
    if (pending.length === 0) return;
    await Promise.race([
      Promise.allSettled(pending).then(() => undefined),
      delay(this.cancelGraceMs),
    ]);
  }

  private rememberCompleted(activation: Activation, terminal: DaemonWorkerActivationTerminalFrame): void {
    this.completed.set(activation.frame.activationId, {
      commandId: activation.frame.commandId,
      fingerprint: activation.fingerprint,
      terminal,
    });
    while (this.completed.size > MAX_COMPLETED_ACTIVATIONS) {
      const oldest = this.completed.keys().next().value as string | undefined;
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
    if (activation.terminal !== undefined) return;
    const terminal: DaemonWorkerActivationTerminalFrame = {
      kind: "activation.terminal",
      version: DAEMON_WORKER_PROTOCOL_VERSION,
      commandId: activation.frame.commandId,
      runId: this.runId,
      activationId: activation.frame.activationId,
      status,
      ...(message === undefined ? {} : {
        error: {
          code: status === "uncertain" ? "cancel_timeout" : "runner_failed",
          message: errorMessage(message),
        },
      }),
    };
    activation.terminal = terminal;
    // Cache before writing to the transport so a disconnect cannot lose the
    // terminal receipt or allow a later duplicate to execute the runner.
    this.rememberCompleted(activation, terminal);
    await Promise.all([...activation.commandIds].map((commandId) => this.sendTerminalReplay(terminal, commandId)));
  }

  private async sendTerminalReplay(
    terminal: DaemonWorkerActivationTerminalFrame,
    commandId: string,
  ): Promise<void> {
    try {
      await settleWithin(
        this.send({ ...terminal, commandId }),
        this.cancelGraceMs,
      );
    } catch {
      // The transport close path owns reconnect/uncertain handling. A failed
      // best-effort replay must not reject the activation promise.
    }
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
      message: errorMessage(message),
      retryable,
    });
  }

  private async send(frame: DaemonWorkerFrame): Promise<void> {
    encodeDaemonWorkerFrame(frame, this.maxFrameBytes);
    await awaitWithin(
      Promise.resolve().then(() => this.transport.send(frame)),
      this.cancelGraceMs,
    );
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
  return persistedErrorText(error, "Unknown worker error", 512).replace(/[\r\n]+/g, " ");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

async function settleWithin<T>(promise: Promise<T>, milliseconds: number): Promise<void> {
  await Promise.race([
    promise.then(() => undefined, () => undefined),
    delay(milliseconds),
  ]);
}

async function awaitWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new DaemonWorkerProtocolError("internal", "worker transport write timed out", true));
      }, milliseconds);
      timer.unref?.();
      promise.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isDaemonWorkerCommand(frame: DaemonWorkerFrame): frame is DaemonWorkerCommand {
  return frame.kind === "initialize"
    || frame.kind === "activate"
    || frame.kind === "cancel"
    || frame.kind === "drain"
    || frame.kind === "shutdown";
}

function commandActivationId(frame: DaemonWorkerCommand): string | undefined {
  return frame.kind === "activate" || frame.kind === "cancel" ? frame.activationId : undefined;
}

function commandSignature(frame: DaemonWorkerCommand): string {
  switch (frame.kind) {
    case "initialize":
      return JSON.stringify({ kind: frame.kind, runId: frame.runId, workerId: frame.workerId, lease: frame.lease });
    case "activate":
      return JSON.stringify({
        kind: frame.kind,
        runId: frame.runId,
        activationId: frame.activationId,
        lease: frame.lease,
        wakes: frame.wakes,
      });
    case "cancel":
      return JSON.stringify({ kind: frame.kind, runId: frame.runId, activationId: frame.activationId, reason: frame.reason });
    case "drain":
      return JSON.stringify({ kind: frame.kind, runId: frame.runId });
    case "shutdown":
      return JSON.stringify({ kind: frame.kind, runId: frame.runId, reason: frame.reason });
  }
}
