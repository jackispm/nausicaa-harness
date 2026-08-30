import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { createConnection, type Socket } from "node:net";

import {
  DAEMON_CONTROL_PROTOCOL_VERSION,
  type DaemonControlEventFrame,
  type DaemonControlRunEventFrame,
  type DaemonControlMethod,
  type DaemonControlRequest,
} from "./daemon-control.js";
import type { DaemonHostEvent } from "./daemon-host.js";
import type { DaemonRunObservation } from "./daemon-observer.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export interface DaemonControlClientOptions {
  /** Absolute path to the daemon's Unix JSONL control socket. */
  readonly socketPath: string;
  /** Connection and per-request timeout. */
  readonly requestTimeoutMs?: number;
  /** Maximum JSONL response frame, including its newline. */
  readonly maxFrameBytes?: number;
  /** Request id factory, useful for deterministic protocol tests. */
  readonly createRequestId?: () => string;
}

export class DaemonControlClientError extends Error {
  override readonly name = "DaemonControlClientError";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type DaemonControlEventListener = (event: DaemonHostEvent) => void;
export type DaemonControlRunEventListener = (observation: DaemonRunObservation) => void;

interface PendingRequest {
  readonly generation: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Small client for the daemon's local JSONL control plane.
 *
 * The client is transport-only: it does not cache Host state and it does not
 * turn event frames into a second source of truth. Callers can request a
 * fresh snapshot after reconnect and use listeners for live UI updates.
 */
export class DaemonControlClient {
  readonly socketPath: string;

  private readonly requestTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly createRequestId: () => string;
  private readonly listeners = new Set<DaemonControlEventListener>();
  private readonly runListeners = new Set<DaemonControlRunEventListener>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly issuedRequestIds = new Set<string>();
  private socket: Socket | undefined;
  private socketGeneration = 0;
  private connectPromise: Promise<void> | undefined;
  private connectReject: ((error: Error) => void) | undefined;
  private buffer = "";
  private closed = false;

  constructor(options: DaemonControlClientOptions) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new DaemonControlClientError("invalid_options", "client options must be an object");
    }
    if (
      typeof options.socketPath !== "string"
      || options.socketPath.length === 0
      || options.socketPath.trim() !== options.socketPath
      || options.socketPath.includes("\0")
      || !isAbsolute(options.socketPath)
    ) {
      throw new DaemonControlClientError(
        "invalid_options",
        "socketPath must be an absolute path without NUL",
      );
    }
    this.socketPath = options.socketPath;
    this.requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs,
      "requestTimeoutMs",
      DEFAULT_REQUEST_TIMEOUT_MS,
      1,
      MAX_REQUEST_TIMEOUT_MS,
    );
    this.maxFrameBytes = boundedInteger(
      options.maxFrameBytes,
      "maxFrameBytes",
      DEFAULT_MAX_FRAME_BYTES,
      1,
      MAX_FRAME_BYTES,
    );
    this.createRequestId = options.createRequestId ?? randomUUID;
    if (typeof this.createRequestId !== "function") {
      throw new DaemonControlClientError("invalid_options", "createRequestId must be a function");
    }
  }

  get connected(): boolean {
    return this.socket !== undefined && !this.socket.destroyed;
  }

  /** Connect once; subsequent calls reuse the same transport. */
  async connect(): Promise<void> {
    if (this.closed) throw new DaemonControlClientError("closed", "control client is closed");
    if (this.connected) return;
    if (this.connectPromise !== undefined) return this.connectPromise;
    const previousSocket = this.socket;
    if (previousSocket !== undefined) {
      this.failSocket(
        previousSocket,
        this.socketGeneration,
        new DaemonControlClientError("disconnected", "replacing a closed control socket"),
        false,
      );
    }

    const promise = new Promise<void>((resolve, reject) => {
      this.connectReject = reject;
      const socket = createConnection(this.socketPath);
      const generation = ++this.socketGeneration;
      this.socket = socket;
      this.buffer = "";
      this.issuedRequestIds.clear();
      socket.setEncoding("utf8");
      const timer = setTimeout(() => {
        if (!this.isCurrent(socket, generation)) return;
        const error = new DaemonControlClientError(
          "timeout",
          "timed out connecting to daemon control socket",
        );
        this.failSocket(socket, generation, error);
        reject(error);
      }, this.requestTimeoutMs);
      timer.unref?.();
      const onConnect = (): void => {
        if (!this.isCurrent(socket, generation)) {
          socket.destroy();
          return;
        }
        clearTimeout(timer);
        this.connectReject = undefined;
        socket.off("error", onInitialError);
        resolve();
      };
      const onInitialError = (error: Error): void => {
        if (!this.isCurrent(socket, generation)) return;
        clearTimeout(timer);
        const clientError = new DaemonControlClientError("connect_failed", error.message);
        this.failSocket(socket, generation, clientError);
        if (this.connectReject === reject) this.connectReject = undefined;
        reject(clientError);
      };
      socket.once("connect", onConnect);
      socket.once("error", onInitialError);
      socket.on("data", (chunk: string | Buffer) => this.read(socket, generation, chunk));
      socket.on("error", (error: Error) => {
        this.failSocket(
          socket,
          generation,
          new DaemonControlClientError("transport", error.message),
        );
      });
      socket.on("close", () => {
        // A reconnect starts a fresh JSONL stream. Never carry an incomplete
        // frame from the current transport into that stream. An older socket
        // may close after a replacement has already been connected, so it
        // must not clear the replacement's parser state.
        this.failSocket(
          socket,
          generation,
          new DaemonControlClientError("disconnected", "daemon control socket closed"),
          false,
        );
      });
    });
    this.connectPromise = promise;
    try {
      await promise;
    } finally {
      if (this.connectPromise === promise) this.connectPromise = undefined;
      if (this.connectReject !== undefined && this.connectPromise === undefined) {
        this.connectReject = undefined;
      }
    }
  }

  /**
   * Send one control request and resolve its response result. Events received
   * while waiting are delivered to listeners and never consume the response.
   */
  async request<T = unknown>(
    method: DaemonControlMethod,
    params?: unknown,
  ): Promise<T> {
    await this.connect();
    const socket = this.socket;
    if (socket === undefined || socket.destroyed || !socket.writable) {
      throw new DaemonControlClientError("disconnected", "daemon control socket is not writable");
    }
    const generation = this.socketGeneration;
    const id = requiredRequestId(this.createRequestId());
    if (this.issuedRequestIds.has(id)) {
      throw new DaemonControlClientError(
        "duplicate_request_id",
        `request id ${id} was already used on this connection`,
      );
    }
    this.issuedRequestIds.add(id);
    const request: DaemonControlRequest = {
      version: DAEMON_CONTROL_PROTOCOL_VERSION,
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };
    const response = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DaemonControlClientError("timeout", `control request timed out: ${method}`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        generation,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
    });
    try {
      socket.write(`${JSON.stringify(request)}\n`);
    } catch (error: unknown) {
      const pending = this.pending.get(id);
      if (pending !== undefined) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(asClientError(error, "write_failed"));
      }
    }
    return response;
  }

  /** Subscribe to live Host event frames. Returns an idempotent unsubscribe. */
  onEvent(listener: DaemonControlEventListener): () => void {
    if (typeof listener !== "function") {
      throw new DaemonControlClientError("invalid_listener", "event listener must be a function");
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Observe cursor-bearing Run Ledger frames. Replay pages arrive in the subscribe response. */
  onRunEvent(listener: DaemonControlRunEventListener): () => void {
    if (typeof listener !== "function") {
      throw new DaemonControlClientError("invalid_listener", "Run event listener must be a function");
    }
    this.runListeners.add(listener);
    return () => this.runListeners.delete(listener);
  }

  /** Close the transport and reject requests which have not received a reply. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const connectReject = this.connectReject;
    this.connectReject = undefined;
    connectReject?.(new DaemonControlClientError("closed", "control client closed"));
    const socket = this.socket;
    this.socket = undefined;
    this.socketGeneration += 1;
    if (socket !== undefined && !socket.destroyed) socket.destroy();
    this.failPending(new DaemonControlClientError("closed", "control client closed"));
    this.buffer = "";
    this.issuedRequestIds.clear();
  }

  private read(socket: Socket, generation: number, chunk: string | Buffer): void {
    if (!this.isCurrent(socket, generation)) return;
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (
      this.buffer.indexOf("\n") < 0
      && Buffer.byteLength(this.buffer, "utf8") > this.maxFrameBytes
    ) {
      this.failProtocol(socket, generation, "frame_too_large", "daemon response frame exceeds the configured limit");
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length === 0) continue;
      if (Buffer.byteLength(line, "utf8") + 1 > this.maxFrameBytes) {
        this.failProtocol(socket, generation, "frame_too_large", "daemon response frame exceeds the configured limit");
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        this.failProtocol(socket, generation, "invalid_json", "daemon response is not valid JSON");
        return;
      }
      this.handleFrame(socket, generation, frame);
      if (!this.isCurrent(socket, generation)) return;
    }
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxFrameBytes) {
      this.failProtocol(socket, generation, "frame_too_large", "daemon response frame exceeds the configured limit");
    }
  }

  private handleFrame(socket: Socket, generation: number, value: unknown): void {
    if (!this.isCurrent(socket, generation)) return;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      this.failProtocol(socket, generation, "invalid_frame", "daemon response frame must be an object");
      return;
    }
    const frame = value as {
      readonly version?: unknown;
      readonly kind?: unknown;
      readonly id?: unknown;
      readonly ok?: unknown;
      readonly result?: unknown;
      readonly error?: { readonly code?: unknown; readonly message?: unknown };
      readonly event?: DaemonControlEventFrame["event"];
      readonly observation?: DaemonControlRunEventFrame["observation"];
    };
    if (frame.version !== DAEMON_CONTROL_PROTOCOL_VERSION) {
      this.failProtocol(socket, generation, "unsupported_version", "daemon response version is unsupported");
      return;
    }
    if (frame.kind === "event") {
      if (frame.event === undefined || typeof frame.event !== "object") {
        this.failProtocol(socket, generation, "invalid_frame", "daemon event frame is missing event");
        return;
      }
      for (const listener of this.listeners) {
        try {
          listener(frame.event as DaemonHostEvent);
        } catch {
          // Observers cannot own the transport.
        }
      }
      return;
    }
    if (frame.kind === "run.event") {
      if (frame.observation === undefined || typeof frame.observation !== "object") {
        this.failProtocol(socket, generation, "invalid_frame", "daemon Run event frame is missing observation");
        return;
      }
      for (const listener of this.runListeners) {
        try {
          listener(frame.observation as DaemonRunObservation);
        } catch {
          // Observers cannot own the transport.
        }
      }
      return;
    }
    if (frame.kind !== "response" || typeof frame.id !== "string") {
      this.failProtocol(socket, generation, "invalid_frame", "daemon response frame is invalid");
      return;
    }
    const pending = this.pending.get(frame.id);
    if (pending === undefined || pending.generation !== generation) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.ok === true) {
      pending.resolve(frame.result);
      return;
    }
    const error = frame.error;
    pending.reject(new DaemonControlClientError(
      typeof error?.code === "string" ? error.code : "command_failed",
      typeof error?.message === "string" ? error.message : "daemon control command failed",
    ));
  }

  private failProtocol(socket: Socket, generation: number, code: string, message: string): void {
    this.failSocket(socket, generation, new DaemonControlClientError(code, message));
  }

  private failSocket(
    socket: Socket,
    generation: number,
    error: Error,
    destroy = true,
  ): void {
    if (!this.isCurrent(socket, generation)) return;
    this.socket = undefined;
    this.buffer = "";
    this.issuedRequestIds.clear();
    this.socketGeneration += 1;
    if (destroy && !socket.destroyed) socket.destroy();
    this.failPending(error, generation);
  }

  private failPending(error: Error, generation?: number): void {
    for (const [id, pending] of this.pending) {
      if (generation !== undefined && pending.generation !== generation) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private isCurrent(socket: Socket, generation: number): boolean {
    return this.socket === socket && this.socketGeneration === generation;
  }
}

export function createDaemonControlClient(
  options: DaemonControlClientOptions,
): DaemonControlClient {
  return new DaemonControlClient(options);
}

function boundedInteger(
  value: number | undefined,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new DaemonControlClientError(
      "invalid_options",
      `${field} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return selected;
}

function requiredRequestId(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.includes("\0")
  ) {
    throw new DaemonControlClientError(
      "invalid_request_id",
      "createRequestId must return a non-empty string without NUL",
    );
  }
  return value;
}

function asClientError(error: unknown, code: string): DaemonControlClientError {
  return new DaemonControlClientError(
    code,
    error instanceof Error ? error.message : String(error),
  );
}
