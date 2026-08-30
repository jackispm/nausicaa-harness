import type { ArtifactRef } from "../domain/index.js";

/** Version of the detached Run worker protocol. */
export const DAEMON_WORKER_PROTOCOL_VERSION = 1 as const;

export const DEFAULT_DAEMON_WORKER_MAX_FRAME_BYTES = 256 * 1024;
export const MAX_DAEMON_WORKER_MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const DEFAULT_DAEMON_WORKER_MAX_PENDING_ACTIVATIONS = 4;
export const MAX_DAEMON_WORKER_MAX_PENDING_ACTIVATIONS = 32;
export const DEFAULT_DAEMON_WORKER_ACTIVATION_TIMEOUT_MS = 30 * 60 * 1_000;
export const MAX_DAEMON_WORKER_ACTIVATION_TIMEOUT_MS = 60 * 60 * 1_000;
export const DEFAULT_DAEMON_WORKER_CANCEL_GRACE_MS = 2_000;
export const MAX_DAEMON_WORKER_CANCEL_GRACE_MS = 60_000;

/** A lease identity is safe to pass over IPC; closures and actionable tokens are not. */
export interface DaemonWorkerLeaseIdentity {
  readonly runId: string;
  /** The child reopens this path with FileExecutionLeaseStore at its boundary. */
  readonly leasePath: string;
  readonly fencingToken: number;
}

export type DaemonWorkerLifecycle =
  | "starting"
  | "ready"
  | "draining"
  | "stopped"
  | "failed";

export type DaemonWorkerActivationStatus =
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "uncertain";

export interface DaemonWorkerWake {
  readonly inputId: string;
  readonly dedupeKey: string;
  readonly source: string;
  readonly payloadRef?: ArtifactRef;
}

export interface DaemonWorkerInitializeFrame {
  readonly kind: "initialize";
  readonly version: typeof DAEMON_WORKER_PROTOCOL_VERSION;
  readonly commandId: string;
  readonly runId: string;
  readonly workerId: string;
  readonly lease: DaemonWorkerLeaseIdentity;
}

export interface DaemonWorkerReadyFrame {
  readonly kind: "ready";
  readonly version: typeof DAEMON_WORKER_PROTOCOL_VERSION;
  readonly commandId: string;
  readonly runId: string;
  readonly workerId: string;
  readonly instanceToken: string;
}

export interface DaemonWorkerActivateFrame {
  readonly kind: "activate";
  readonly version: typeof DAEMON_WORKER_PROTOCOL_VERSION;
  readonly commandId: string;
  readonly runId: string;
  readonly activationId: string;
  readonly lease: DaemonWorkerLeaseIdentity;
  readonly wakes: readonly DaemonWorkerWake[];
}

export interface DaemonWorkerCancelFrame {
  readonly kind: "cancel";
  readonly version: typeof DAEMON_WORKER_PROTOCOL_VERSION;
  readonly commandId: string;
  readonly runId: string;
  readonly activationId: string;
  readonly reason: string;
}

export interface DaemonWorkerDrainFrame {
  readonly kind: "drain";
  readonly version: typeof DAEMON_WORKER_PROTOCOL_VERSION;
  readonly commandId: string;
  readonly runId: string;
}

export interface DaemonWorkerShutdownFrame {
  readonly kind: "shutdown";
  readonly version: typeof DAEMON_WORKER_PROTOCOL_VERSION;
  readonly commandId: string;
  readonly runId: string;
  readonly reason?: string;
}

export type DaemonWorkerCommand =
  | DaemonWorkerInitializeFrame
  | DaemonWorkerActivateFrame
  | DaemonWorkerCancelFrame
  | DaemonWorkerDrainFrame
  | DaemonWorkerShutdownFrame;

export interface DaemonWorkerAcceptedFrame {
  readonly kind: "accepted";
  readonly version: typeof DAEMON_WORKER_PROTOCOL_VERSION;
  readonly commandId: string;
  readonly runId: string;
  readonly activationId: string;
}

export interface DaemonWorkerActivationTerminalFrame {
  readonly kind: "activation.terminal";
  readonly version: typeof DAEMON_WORKER_PROTOCOL_VERSION;
  readonly commandId: string;
  readonly runId: string;
  readonly activationId: string;
  readonly status: Extract<DaemonWorkerActivationStatus, "completed" | "failed" | "cancelled" | "uncertain">;
  readonly error?: DaemonWorkerErrorShape;
}

export interface DaemonWorkerCommandResultFrame {
  readonly kind: "command.result";
  readonly version: typeof DAEMON_WORKER_PROTOCOL_VERSION;
  readonly commandId: string;
  readonly runId: string;
  readonly command: Exclude<DaemonWorkerCommand["kind"], "activate" | "initialize">;
  readonly status: "ok" | "duplicate";
  readonly lifecycle: DaemonWorkerLifecycle;
  readonly activationId?: string;
}

export interface DaemonWorkerDrainedFrame {
  readonly kind: "drained";
  readonly version: typeof DAEMON_WORKER_PROTOCOL_VERSION;
  readonly commandId: string;
  readonly runId: string;
}

export interface DaemonWorkerErrorShape {
  readonly code: DaemonWorkerErrorCode;
  readonly message: string;
}

export type DaemonWorkerErrorCode =
  | "invalid_frame"
  | "unsupported_version"
  | "not_ready"
  | "already_initialized"
  | "identity_mismatch"
  | "lease_mismatch"
  | "draining"
  | "stopped"
  | "activation_busy"
  | "activation_unknown"
  | "queue_full"
  | "command_conflict"
  | "runner_failed"
  | "cancel_timeout"
  | "descriptor_failed"
  | "internal";

export interface DaemonWorkerErrorFrame {
  readonly kind: "error";
  readonly version: typeof DAEMON_WORKER_PROTOCOL_VERSION;
  readonly commandId: string | null;
  readonly runId?: string;
  readonly code: DaemonWorkerErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export type DaemonWorkerFrame =
  | DaemonWorkerCommand
  | DaemonWorkerReadyFrame
  | DaemonWorkerAcceptedFrame
  | DaemonWorkerActivationTerminalFrame
  | DaemonWorkerCommandResultFrame
  | DaemonWorkerDrainedFrame
  | DaemonWorkerErrorFrame;

export interface DaemonWorkerTransport {
  send(frame: DaemonWorkerFrame): void | Promise<void>;
  onFrame(listener: (frame: unknown) => void): () => void;
  onClose(listener: (error?: Error) => void): () => void;
  close?(): void | Promise<void>;
}

export interface DaemonWorkerRunnerContext {
  readonly runId: string;
  readonly activationId: string;
  readonly lease: DaemonWorkerLeaseIdentity;
  readonly wakes: readonly DaemonWorkerWake[];
  readonly signal: AbortSignal;
  /** Child-side lease checks; closures stay inside the child process. */
  readonly assertLease: () => Promise<void>;
  /** Fence one durable mutation with the reopened child-side lease store. */
  readonly commitLease: <T>(operation: () => Promise<T>) => Promise<T>;
}

export type DaemonWorkerRunnerOutcome =
  | { readonly status: "completed" }
  | { readonly status: "failed"; readonly error?: string }
  | { readonly status: "cancelled"; readonly error?: string }
  | { readonly status: "uncertain"; readonly error?: string };

export interface DaemonWorkerRunner {
  /** The runner owns the child-side SessionController composition. */
  activate(context: DaemonWorkerRunnerContext): Promise<DaemonWorkerRunnerOutcome>;
  /** Optional cooperative cancellation hook; it must not receive a closure over a lease store. */
  cancel?(context: Pick<DaemonWorkerRunnerContext, "runId" | "activationId"> & { readonly reason: string }):
    void | Promise<void>;
  close?(): void | Promise<void>;
}

export interface DaemonWorkerDescriptor {
  readonly version: typeof DAEMON_WORKER_PROTOCOL_VERSION;
  readonly runId: string;
  readonly workerId: string;
  readonly leasePath: string;
  readonly fencingToken: number;
  readonly instanceToken: string;
  readonly publishedAt: string;
}

/** Publication must be atomic: readers see either no descriptor or a complete one. */
export interface DaemonWorkerDescriptorPublisher {
  publish(descriptor: DaemonWorkerDescriptor): void | Promise<void>;
  clear?(instanceToken: string): void | Promise<void>;
}

export class DaemonWorkerProtocolError extends Error {
  override readonly name: string = "DaemonWorkerProtocolError";
  readonly code: DaemonWorkerErrorCode;
  readonly retryable: boolean;

  constructor(
    code: DaemonWorkerErrorCode,
    message: string,
    retryable = false,
  ) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export class DaemonWorkerTransportError extends DaemonWorkerProtocolError {
  override readonly name: string = "DaemonWorkerTransportError";
  readonly transportCode: "disconnected" | "timeout" | "malformed" | "closed";

  constructor(
    transportCode: "disconnected" | "timeout" | "malformed" | "closed",
    message: string,
  ) {
    super("internal", message, transportCode === "disconnected" || transportCode === "timeout");
    this.transportCode = transportCode;
  }
}

export function encodeDaemonWorkerFrame(
  frame: DaemonWorkerFrame,
  maxBytes = DEFAULT_DAEMON_WORKER_MAX_FRAME_BYTES,
): string {
  validateDaemonWorkerFrame(frame);
  const serialized = `${JSON.stringify(frame)}\n`;
  if (byteLength(serialized) > boundedFrameBytes(maxBytes)) {
    throw new DaemonWorkerProtocolError("invalid_frame", "worker frame exceeds its byte limit");
  }
  return serialized;
}

export function decodeDaemonWorkerFrame(
  value: string | Uint8Array,
  maxBytes = DEFAULT_DAEMON_WORKER_MAX_FRAME_BYTES,
): DaemonWorkerFrame {
  if (byteLength(value) > boundedFrameBytes(maxBytes)) {
    throw new DaemonWorkerProtocolError("invalid_frame", "worker frame exceeds its byte limit");
  }
  const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
  const line = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (line.includes("\n") || line.includes("\r")) {
    throw new DaemonWorkerProtocolError("invalid_frame", "worker frame must contain one JSON record");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new DaemonWorkerProtocolError("invalid_frame", "worker frame is not valid JSON");
  }
  validateDaemonWorkerFrame(parsed);
  return parsed;
}

export function validateDaemonWorkerFrame(value: unknown): asserts value is DaemonWorkerFrame {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DaemonWorkerProtocolError("invalid_frame", "worker frame must be an object");
  }
  const frame = value as Record<string, unknown>;
  if (frame.version !== DAEMON_WORKER_PROTOCOL_VERSION) {
    throw new DaemonWorkerProtocolError("unsupported_version", "worker protocol version is unsupported");
  }
  const kind = frame.kind;
  if (
    kind !== "initialize"
    && kind !== "ready"
    && kind !== "activate"
    && kind !== "accepted"
    && kind !== "activation.terminal"
    && kind !== "cancel"
    && kind !== "drain"
    && kind !== "drained"
    && kind !== "shutdown"
    && kind !== "command.result"
    && kind !== "error"
  ) {
    throw new DaemonWorkerProtocolError("invalid_frame", "worker frame kind is unsupported");
  }
  requiredIdentifier(frame.commandId, "commandId", kind === "error");
  if (kind !== "error") requiredIdentifier(frame.runId, "runId");
  if (kind === "initialize") {
    requiredIdentifier(frame.workerId, "workerId");
    validateLease(frame.lease);
  } else if (kind === "activate") {
    requiredIdentifier(frame.activationId, "activationId");
    validateLease(frame.lease);
    if (!Array.isArray(frame.wakes) || frame.wakes.length > MAX_DAEMON_WORKER_MAX_PENDING_ACTIVATIONS * 16) {
      throw new DaemonWorkerProtocolError("invalid_frame", "worker activation wakes exceed the bound");
    }
    for (const wake of frame.wakes) validateWake(wake);
  } else if (kind === "cancel") {
    requiredIdentifier(frame.activationId, "activationId");
    if (typeof frame.reason !== "string" || frame.reason.trim().length === 0 || frame.reason.length > 512) {
      throw new DaemonWorkerProtocolError("invalid_frame", "worker cancellation reason is invalid");
    }
  } else if (kind === "ready") {
    requiredIdentifier(frame.workerId, "workerId");
    requiredIdentifier(frame.instanceToken, "instanceToken");
  } else if (kind === "accepted") {
    requiredIdentifier(frame.activationId, "activationId");
  } else if (kind === "activation.terminal") {
    requiredIdentifier(frame.activationId, "activationId");
    if (
      frame.status !== "completed"
      && frame.status !== "failed"
      && frame.status !== "cancelled"
      && frame.status !== "uncertain"
    ) {
      throw new DaemonWorkerProtocolError("invalid_frame", "worker terminal status is invalid");
    }
    if (frame.error !== undefined) validateErrorShape(frame.error);
  } else if (kind === "command.result") {
    if (frame.command !== "cancel" && frame.command !== "drain" && frame.command !== "shutdown") {
      throw new DaemonWorkerProtocolError("invalid_frame", "worker command result is invalid");
    }
    if (frame.status !== "ok" && frame.status !== "duplicate") {
      throw new DaemonWorkerProtocolError("invalid_frame", "worker command result status is invalid");
    }
    if (
      frame.lifecycle !== "starting"
      && frame.lifecycle !== "ready"
      && frame.lifecycle !== "draining"
      && frame.lifecycle !== "stopped"
      && frame.lifecycle !== "failed"
    ) {
      throw new DaemonWorkerProtocolError("invalid_frame", "worker lifecycle is invalid");
    }
    if (frame.activationId !== undefined) requiredIdentifier(frame.activationId, "activationId");
  } else if (kind === "drained") {
    // No additional payload.
  } else if (kind === "error") {
    if (frame.commandId !== null) requiredIdentifier(frame.commandId, "commandId");
    if (frame.runId !== undefined) requiredIdentifier(frame.runId, "runId");
    validateErrorShape({ code: frame.code, message: frame.message });
    if (typeof frame.retryable !== "boolean") {
      throw new DaemonWorkerProtocolError("invalid_frame", "worker error retryability is invalid");
    }
  }
}

export function validateDaemonWorkerLease(value: unknown): asserts value is DaemonWorkerLeaseIdentity {
  validateLease(value);
}

export function sameDaemonWorkerLease(
  left: DaemonWorkerLeaseIdentity,
  right: DaemonWorkerLeaseIdentity,
): boolean {
  return left.runId === right.runId
    && left.leasePath === right.leasePath
    && left.fencingToken === right.fencingToken;
}

function validateLease(value: unknown): asserts value is DaemonWorkerLeaseIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DaemonWorkerProtocolError("invalid_frame", "worker lease identity is invalid");
  }
  const lease = value as Record<string, unknown>;
  requiredIdentifier(lease.runId, "lease.runId");
  if (
    typeof lease.leasePath !== "string"
    || lease.leasePath.length === 0
    || lease.leasePath.length > 4_096
    || lease.leasePath.includes("\0")
  ) {
    throw new DaemonWorkerProtocolError("invalid_frame", "worker lease path is invalid");
  }
  if (!Number.isSafeInteger(lease.fencingToken) || (lease.fencingToken as number) < 1) {
    throw new DaemonWorkerProtocolError("invalid_frame", "worker fencing token is invalid");
  }
}

function validateWake(value: unknown): asserts value is DaemonWorkerWake {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DaemonWorkerProtocolError("invalid_frame", "worker wake is invalid");
  }
  const wake = value as Record<string, unknown>;
  requiredIdentifier(wake.inputId, "wake.inputId");
  requiredIdentifier(wake.dedupeKey, "wake.dedupeKey");
  requiredIdentifier(wake.source, "wake.source");
  if (wake.payloadRef !== undefined) validateArtifactRef(wake.payloadRef);
}

function validateArtifactRef(value: unknown): asserts value is ArtifactRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DaemonWorkerProtocolError("invalid_frame", "worker artifact reference is invalid");
  }
  const ref = value as Record<string, unknown>;
  requiredIdentifier(ref.id, "artifact.id");
  requiredIdentifier(ref.contentHash, "artifact.contentHash");
  if (typeof ref.mediaType !== "string" || ref.mediaType.length === 0 || ref.mediaType.length > 256) {
    throw new DaemonWorkerProtocolError("invalid_frame", "worker artifact media type is invalid");
  }
  if (!Number.isSafeInteger(ref.byteLength) || (ref.byteLength as number) < 0) {
    throw new DaemonWorkerProtocolError("invalid_frame", "worker artifact byte length is invalid");
  }
}

function validateErrorShape(value: unknown): asserts value is DaemonWorkerErrorShape {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DaemonWorkerProtocolError("invalid_frame", "worker error is invalid");
  }
  const error = value as Record<string, unknown>;
  if (typeof error.code !== "string" || !isErrorCode(error.code)) {
    throw new DaemonWorkerProtocolError("invalid_frame", "worker error code is invalid");
  }
  if (typeof error.message !== "string" || error.message.length === 0 || error.message.length > 512) {
    throw new DaemonWorkerProtocolError("invalid_frame", "worker error message is invalid");
  }
}

function isErrorCode(value: string): value is DaemonWorkerErrorCode {
  return [
    "invalid_frame",
    "unsupported_version",
    "not_ready",
    "already_initialized",
    "identity_mismatch",
    "lease_mismatch",
    "draining",
    "stopped",
    "activation_busy",
    "activation_unknown",
    "queue_full",
    "command_conflict",
    "runner_failed",
    "cancel_timeout",
    "descriptor_failed",
    "internal",
  ].includes(value);
}

function requiredIdentifier(value: unknown, field: string, nullable = false): void {
  if (nullable && value === null) return;
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
}

function boundedFrameBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DAEMON_WORKER_MAX_FRAME_BYTES) {
    throw new RangeError("worker maxFrameBytes is outside its supported range");
  }
  return value;
}

function byteLength(value: string | Uint8Array): number {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
}
