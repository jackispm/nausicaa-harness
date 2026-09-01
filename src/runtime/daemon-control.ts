import { randomUUID } from "node:crypto";
import { lstat, mkdir, unlink, chmod } from "node:fs/promises";
import { isAbsolute, dirname } from "node:path";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";

import {
  DaemonHost,
  DaemonHostProtocolError,
  type DaemonHostEvent,
  type DaemonHostSnapshot,
  type DaemonWakeRequest,
} from "./daemon-host.js";
import {
  DaemonRunObserver,
  DaemonRunObserverProtocolError,
  type DaemonRunObservation,
  type DaemonRunSubscription,
} from "./daemon-observer.js";
import { persistedErrorText } from "./redaction.js";

/** Version of the local daemon control protocol. */
export const DAEMON_CONTROL_PROTOCOL_VERSION = 1 as const;

const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_PENDING_WRITE_BYTES = 1024 * 1024;
const MAX_PENDING_WRITE_BYTES = 16 * 1024 * 1024;

export type DaemonControlMethod =
  | "start"
  | "stop"
  | "status"
  | "attach"
  | "detach"
  | "wake"
  | "events.subscribe";

export interface DaemonControlRequest {
  readonly version?: number;
  readonly id: string;
  readonly method: DaemonControlMethod;
  readonly params?: unknown;
}

export interface DaemonControlResponse {
  readonly version: typeof DAEMON_CONTROL_PROTOCOL_VERSION;
  readonly kind: "response";
  readonly id: string | null;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface DaemonControlEventFrame {
  readonly version: typeof DAEMON_CONTROL_PROTOCOL_VERSION;
  readonly kind: "event";
  readonly event: DaemonHostEvent;
}

/** Durable Run-Ledger observation, distinct from best-effort Host events. */
export interface DaemonControlRunEventFrame {
  readonly version: typeof DAEMON_CONTROL_PROTOCOL_VERSION;
  readonly kind: "run.event";
  readonly observation: DaemonRunObservation;
}

export class DaemonControlProtocolError extends Error {
  override readonly name = "DaemonControlProtocolError";
}

export interface DaemonControlLifecycle {
  start(): Promise<DaemonHostSnapshot>;
  stop(): Promise<DaemonHostSnapshot>;
}

export interface DaemonControlServerOptions {
  /** The in-process host exposed by this control socket. */
  readonly host: DaemonHost;
  /** Optional complete runtime lifecycle, including supervisor/edge cleanup. */
  readonly lifecycle?: DaemonControlLifecycle;
  /** Invoked on the next turn after a successful stop response is queued. */
  readonly onStopResponse?: () => void;
  /** Absolute Unix socket path. The parent is created with mode 0700 when absent. */
  readonly socketPath: string;
  /** Maximum JSONL request frame, including the newline. */
  readonly maxFrameBytes?: number;
  /** Disconnect a slow client once its unsent control frames exceed this bound. */
  readonly maxPendingWriteBytes?: number;
  /** Factory for connection-local client IDs, useful for deterministic tests. */
  readonly createClientId?: () => string;
  /** Optional durable Run observer. Without it only Host events are available. */
  readonly observer?: DaemonRunObserver;
}

interface BoundIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface Subscription {
  readonly runId?: string;
}

interface Connection {
  readonly id: string;
  readonly socket: Socket;
  buffer: string;
  tail: Promise<void>;
  readonly writeQueue: string[];
  queuedWriteBytes: number;
  writeBlocked: boolean;
  subscription?: Subscription;
  runSubscription?: DaemonRunSubscription;
  runSubscriptionEpoch: number;
  readonly attachedClientIds: Set<string>;
}

/**
 * Local JSONL control plane for a DaemonHost.
 *
 * The server owns transport and observation only. Every mutating command is
 * delegated to DaemonHost, so Run leases, wake admission and lifecycle
 * semantics remain in one place. Event frames are best-effort live updates;
 * callers that need recovery must read the Ledger/projection after reconnect.
 */
export class DaemonControlServer {
  readonly socketPath: string;

  private readonly host: DaemonHost;
  private readonly lifecycle: DaemonControlLifecycle;
  private readonly onStopResponse: (() => void) | undefined;
  private readonly maxFrameBytes: number;
  private readonly maxPendingWriteBytes: number;
  private readonly createClientId: () => string;
  private readonly observer: DaemonRunObserver | undefined;
  private readonly connections = new Set<Connection>();
  /** Ownership fence for caller-supplied IDs shared by attach/detach. */
  private readonly attachmentOwners = new Map<string, Connection>();
  private server: Server | undefined;
  private boundIdentity: BoundIdentity | undefined;
  private unsubscribeHost: (() => void) | undefined;
  private listenPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(options: DaemonControlServerOptions) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new DaemonControlProtocolError("options must be an object");
    }
    if (!(options.host instanceof DaemonHost)) {
      throw new DaemonControlProtocolError("host must be a DaemonHost");
    }
    this.socketPath = controlPath(options.socketPath);
    this.host = options.host;
    if (
      options.lifecycle !== undefined
      && (
        options.lifecycle === null
        || typeof options.lifecycle !== "object"
        || typeof options.lifecycle.start !== "function"
        || typeof options.lifecycle.stop !== "function"
      )
    ) {
      throw new DaemonControlProtocolError("lifecycle must provide start and stop functions");
    }
    this.lifecycle = options.lifecycle ?? this.host;
    if (options.onStopResponse !== undefined && typeof options.onStopResponse !== "function") {
      throw new DaemonControlProtocolError("onStopResponse must be a function");
    }
    this.onStopResponse = options.onStopResponse;
    this.maxFrameBytes = positiveInteger(
      options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      "maxFrameBytes",
      MAX_FRAME_BYTES,
    );
    this.maxPendingWriteBytes = positiveInteger(
      options.maxPendingWriteBytes ?? DEFAULT_MAX_PENDING_WRITE_BYTES,
      "maxPendingWriteBytes",
      MAX_PENDING_WRITE_BYTES,
    );
    this.createClientId = options.createClientId ?? (() => `client:${randomUUID()}`);
    if (typeof this.createClientId !== "function") {
      throw new DaemonControlProtocolError("createClientId must be a function");
    }
    if (options.observer !== undefined && !(options.observer instanceof DaemonRunObserver)) {
      throw new DaemonControlProtocolError("observer must be a DaemonRunObserver");
    }
    this.observer = options.observer;
  }

  get listening(): boolean {
    return this.server !== undefined;
  }

  /** Start listening. Calling this repeatedly is idempotent. */
  async listen(): Promise<void> {
    if (this.listenPromise !== undefined) return this.listenPromise;
    if (this.server !== undefined) return;

    const promise = this.open();
    this.listenPromise = promise;
    try {
      await promise;
    } finally {
      if (this.listenPromise === promise) this.listenPromise = undefined;
    }
  }

  /**
   * Stop the control plane only. The Host/runtime keeps running; use the
   * `stop` command (or call the injected lifecycle stop) when execution
   * should be drained.
   */
  async close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    const pendingListen = this.listenPromise;
    if (pendingListen !== undefined) await pendingListen.catch(() => undefined);
    const server = this.server;
    if (server === undefined) return;

    const promise = this.closeServer(server);
    this.closePromise = promise;
    try {
      await promise;
    } finally {
      if (this.closePromise === promise) this.closePromise = undefined;
    }
  }

  private async open(): Promise<void> {
    await prepareSocketPath(this.socketPath);
    const server = createServer((socket) => this.handleConnection(socket));
    // A server error after bind must not become an uncaught process error.
    // The control plane has no durable error channel; clients can reconnect
    // and inspect the Host snapshot after a transport failure.
    server.on("error", () => undefined);
    this.server = server;
    this.unsubscribeHost = this.host.subscribe((event) => this.broadcast(event));
    let bound = false;

    try {
      await listenServer(server, this.socketPath);
      bound = true;
      const stat = await lstat(this.socketPath);
      if (!stat.isSocket()) {
        throw new DaemonControlProtocolError("control path is not a Unix socket");
      }
      this.boundIdentity = { dev: stat.dev, ino: stat.ino };
      await chmod(this.socketPath, 0o600);
    } catch (error: unknown) {
      this.unsubscribeHost?.();
      this.unsubscribeHost = undefined;
      this.server = undefined;
      // A transient post-bind lstat failure happens before boundIdentity is
      // populated. Retry once while the server still owns the socket, then
      // use the same inode fence as the normal close path.
      const identity = this.boundIdentity
        ?? (bound ? await socketIdentityWithRetry(this.socketPath) : undefined);
      this.boundIdentity = undefined;
      await closeServer(server).catch(() => undefined);
      await unlinkMatchingSocket(this.socketPath, identity);
      throw error;
    }
  }

  private async closeServer(server: Server): Promise<void> {
    this.unsubscribeHost?.();
    this.unsubscribeHost = undefined;
    for (const connection of this.connections) {
      this.releaseConnectionAttachments(connection);
      connection.socket.destroy();
    }
    this.connections.clear();

    await closeServer(server);
    this.server = undefined;
    const identity = this.boundIdentity;
    this.boundIdentity = undefined;
    await unlinkMatchingSocket(this.socketPath, identity);
  }

  private handleConnection(socket: Socket): void {
    const connection: Connection = {
      id: this.createClientId(),
      socket,
      buffer: "",
      tail: Promise.resolve(),
      writeQueue: [],
      queuedWriteBytes: 0,
      writeBlocked: false,
      runSubscriptionEpoch: 0,
      attachedClientIds: new Set(),
    };
    this.connections.add(connection);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      connection.buffer += text;
      if (
        connection.buffer.indexOf("\n") < 0
        && Buffer.byteLength(connection.buffer, "utf8") > this.maxFrameBytes
      ) {
        this.sendError(connection, null, "frame_too_large", "request frame exceeds the configured limit");
        socket.destroy();
        return;
      }
      for (;;) {
        const newline = connection.buffer.indexOf("\n");
        if (newline < 0) break;
        let line = connection.buffer.slice(0, newline);
        connection.buffer = connection.buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length === 0) continue;
        if (Buffer.byteLength(line, "utf8") + 1 > this.maxFrameBytes) {
          this.sendError(
            connection,
            null,
            "frame_too_large",
            "request frame exceeds the configured limit",
          );
          socket.destroy();
          return;
        }
        const requestLine = line;
        connection.tail = connection.tail
          .then(() => this.processLine(connection, requestLine))
          .catch(() => undefined);
      }
      if (Buffer.byteLength(connection.buffer, "utf8") > this.maxFrameBytes) {
        this.sendError(connection, null, "frame_too_large", "request frame exceeds the configured limit");
        socket.destroy();
      }
    });
    socket.on("drain", () => this.flushWrites(connection));
    socket.on("close", () => {
      this.releaseConnectionAttachments(connection);
      this.connections.delete(connection);
    });
    socket.on("error", () => {
      this.releaseConnectionAttachments(connection);
      this.connections.delete(connection);
    });
  }

  private releaseConnectionAttachments(connection: Connection): void {
    connection.runSubscriptionEpoch += 1;
    connection.runSubscription?.unsubscribe();
    delete connection.runSubscription;
    delete connection.subscription;
    for (const clientId of connection.attachedClientIds) {
      if (this.attachmentOwners.get(clientId) !== connection) continue;
      this.attachmentOwners.delete(clientId);
      this.host.detach(clientId);
    }
    connection.attachedClientIds.clear();
  }

  private async processLine(connection: Connection, line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.sendError(connection, null, "invalid_json", "request is not valid JSON");
      return;
    }

    let request: DaemonControlRequest;
    try {
      request = parseRequest(parsed);
    } catch (error: unknown) {
      this.sendError(
        connection,
        requestId(parsed),
        "invalid_request",
        persistedErrorText(error, "invalid control request", 512),
      );
      return;
    }

    try {
      const result = await this.dispatch(connection, request);
      this.sendResponse(connection, {
        version: DAEMON_CONTROL_PROTOCOL_VERSION,
        kind: "response",
        id: request.id,
        ok: true,
        result,
      });
      if (request.method === "stop") {
        // Keep the response writable before a composition root tears down the
        // control server and resolves its foreground daemon process.
        setImmediate(() => {
          try {
            this.onStopResponse?.();
          } catch {
            // A composition notification cannot change the completed command.
          }
        });
      }
    } catch (error: unknown) {
      const code = error instanceof DaemonHostProtocolError
        ? "host_rejected"
        : error instanceof DaemonControlProtocolError
          || error instanceof DaemonRunObserverProtocolError
          ? "invalid_params"
          : "command_failed";
      this.sendError(
        connection,
        request.id,
        code,
        persistedErrorText(error, "control command failed", 512),
      );
    }
  }

  private async dispatch(
    connection: Connection,
    request: DaemonControlRequest,
  ): Promise<unknown> {
    switch (request.method) {
      case "start":
        expectNoParams(request.params);
        return this.lifecycle.start();
      case "stop":
        expectNoParams(request.params);
        return this.lifecycle.stop();
      case "status":
        expectNoParams(request.params);
        return this.host.snapshot();
      case "attach": {
        const params = recordParams(request.params, "attach");
        const runId = requiredString(params.runId, "attach.runId");
        const clientId = params.clientId === undefined
          ? connection.id
          : requiredString(params.clientId, "attach.clientId");
        const owner = this.attachmentOwners.get(clientId);
        if (owner !== undefined && owner !== connection) {
          throw new DaemonControlProtocolError(
            "attach.clientId is already owned by another connection",
          );
        }
        const snapshot = this.host.attach(clientId, runId);
        this.attachmentOwners.set(clientId, connection);
        connection.attachedClientIds.add(clientId);
        return { clientId, snapshot };
      }
      case "detach": {
        const params = recordParams(request.params, "detach");
        const clientId = params.clientId === undefined
          ? connection.id
          : requiredString(params.clientId, "detach.clientId");
        if (this.attachmentOwners.get(clientId) !== connection) {
          throw new DaemonControlProtocolError(
            "detach.clientId is not owned by this connection",
          );
        }
        this.attachmentOwners.delete(clientId);
        connection.attachedClientIds.delete(clientId);
        return { clientId, snapshot: this.host.detach(clientId) };
      }
      case "wake": {
        const params = recordParams(request.params, "wake");
        return this.host.wake(params as unknown as DaemonWakeRequest);
      }
      case "events.subscribe": {
        const params = request.params === undefined
          ? {}
          : recordParams(request.params, "events.subscribe");
        const runId = params.runId === undefined
          ? undefined
          : requiredString(params.runId, "events.subscribe.runId");
        if (this.observer !== undefined && runId !== undefined) {
          const cursor = params.cursor === undefined
            ? undefined
            : requiredString(params.cursor, "events.subscribe.cursor");
          const limit = params.limit === undefined
            ? undefined
            : positiveInteger(params.limit, "events.subscribe.limit", 512);
          const upperWatermark = params.upperWatermark === undefined
            ? undefined
            : nonNegativeInteger(
                params.upperWatermark,
                "events.subscribe.upperWatermark",
              );
          const generation = params.generation === undefined
            ? undefined
            : nonNegativeInteger(params.generation, "events.subscribe.generation");
          const subscriptionEpoch = connection.runSubscriptionEpoch + 1;
          connection.runSubscriptionEpoch = subscriptionEpoch;
          connection.runSubscription?.unsubscribe();
          delete connection.runSubscription;
          delete connection.subscription;
          const durable = await this.observer.subscribe(
            {
              runId,
              ...(cursor === undefined ? {} : { cursor }),
              ...(limit === undefined ? {} : { limit }),
              ...(upperWatermark === undefined ? {} : { upperWatermark }),
              ...(generation === undefined ? {} : { generation }),
            },
            (observation) => this.sendRunObservation(
              connection,
              subscriptionEpoch,
              observation,
            ),
          );
          if (
            !this.connections.has(connection)
            || connection.socket.destroyed
            || connection.runSubscriptionEpoch !== subscriptionEpoch
          ) {
            durable.unsubscribe();
            return {
              subscribed: false,
              runId,
              replay: durable.replay,
            };
          }
          connection.subscription = { runId };
          connection.runSubscription = durable;
          return {
            subscribed: durable.subscribed,
            runId,
            replay: durable.replay,
          };
        }
        if (
          params.cursor !== undefined
          || params.limit !== undefined
          || params.upperWatermark !== undefined
          || params.generation !== undefined
        ) {
          throw new DaemonControlProtocolError(
            "events.subscribe replay parameters require a Run observer and runId",
          );
        }
        connection.runSubscriptionEpoch += 1;
        connection.runSubscription?.unsubscribe();
        delete connection.runSubscription;
        connection.subscription = runId === undefined ? {} : { runId };
        return {
          subscribed: true,
          ...(runId === undefined ? {} : { runId }),
        };
      }
    }
  }

  private sendRunObservation(
    connection: Connection,
    subscriptionEpoch: number,
    observation: DaemonRunObservation,
  ): void {
    if (connection.runSubscriptionEpoch !== subscriptionEpoch) return;
    if (!this.connections.has(connection) || connection.socket.destroyed) return;
    this.sendFrame(connection, {
      version: DAEMON_CONTROL_PROTOCOL_VERSION,
      kind: "run.event",
      observation,
    });
  }

  private broadcast(event: DaemonHostEvent): void {
    for (const connection of this.connections) {
      const subscription = connection.subscription;
      if (subscription === undefined || !eventMatchesRun(event, subscription.runId)) continue;
      this.sendFrame(connection, {
        version: DAEMON_CONTROL_PROTOCOL_VERSION,
        kind: "event",
        event,
      });
    }
  }

  private sendResponse(connection: Connection, response: DaemonControlResponse): void {
    this.sendFrame(connection, response);
  }

  private sendError(
    connection: Connection,
    id: string | null,
    code: string,
    message: string,
  ): void {
    this.sendResponse(connection, {
      version: DAEMON_CONTROL_PROTOCOL_VERSION,
      kind: "response",
      id,
      ok: false,
      error: { code, message },
    });
  }

  private sendFrame(
    connection: Connection,
    frame: DaemonControlResponse | DaemonControlEventFrame | DaemonControlRunEventFrame,
  ): void {
    const socket = connection.socket;
    if (socket.destroyed || !socket.writable) return;
    let encoded: string;
    try {
      encoded = `${JSON.stringify(frame)}\n`;
    } catch {
      socket.destroy();
      return;
    }
    const bytes = Buffer.byteLength(encoded, "utf8");
    if (bytes > this.maxFrameBytes) {
      socket.destroy();
      return;
    }
    if (connection.writeBlocked || connection.writeQueue.length > 0) {
      if (socket.writableLength + connection.queuedWriteBytes + bytes > this.maxPendingWriteBytes) {
        socket.destroy();
        return;
      }
      connection.writeQueue.push(encoded);
      connection.queuedWriteBytes += bytes;
      return;
    }
    try {
      connection.writeBlocked = !socket.write(encoded);
      if (socket.writableLength > this.maxPendingWriteBytes) socket.destroy();
    } catch {
      socket.destroy();
    }
  }

  private flushWrites(connection: Connection): void {
    const socket = connection.socket;
    if (socket.destroyed || !socket.writable) return;
    connection.writeBlocked = false;
    while (connection.writeQueue.length > 0) {
      const encoded = connection.writeQueue.shift();
      if (encoded === undefined) break;
      connection.queuedWriteBytes -= Buffer.byteLength(encoded, "utf8");
      try {
        if (!socket.write(encoded)) {
          connection.writeBlocked = true;
          break;
        }
      } catch {
        socket.destroy();
        return;
      }
      if (socket.writableLength + connection.queuedWriteBytes > this.maxPendingWriteBytes) {
        socket.destroy();
        return;
      }
    }
  }
}

async function socketIdentity(socketPath: string): Promise<BoundIdentity | undefined> {
  const stat = await lstat(socketPath).catch(() => undefined);
  if (stat === undefined || !stat.isSocket()) return undefined;
  return { dev: stat.dev, ino: stat.ino };
}

/** Give a just-bound Unix socket one event-loop turn to become stat-able. */
async function socketIdentityWithRetry(socketPath: string): Promise<BoundIdentity | undefined> {
  const first = await socketIdentity(socketPath);
  if (first !== undefined) return first;
  await new Promise<void>((resolve) => setImmediate(resolve));
  return socketIdentity(socketPath);
}

async function unlinkMatchingSocket(
  socketPath: string,
  identity: BoundIdentity | undefined,
): Promise<void> {
  if (identity === undefined) return;
  const current = await lstat(socketPath).catch(() => undefined);
  if (
    current?.isSocket() === true
    && current.dev === identity.dev
    && current.ino === identity.ino
  ) {
    await unlink(socketPath).catch(() => undefined);
  }
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  const parent = dirname(socketPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const existing = await lstat(socketPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (existing === undefined) return;
  if (!existing.isSocket()) {
    throw new DaemonControlProtocolError("control path exists and is not a Unix socket");
  }

  const identity = { dev: existing.dev, ino: existing.ino };
  const live = await probeSocket(socketPath);
  if (live) {
    throw new DaemonControlProtocolError("control socket is already in use");
  }
  const current = await lstat(socketPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (
    current === undefined
    || !current.isSocket()
    || current.dev !== identity.dev
    || current.ino !== identity.ino
  ) {
    throw new DaemonControlProtocolError("control socket changed while checking for stale state");
  }
  await unlink(socketPath);
}

async function probeSocket(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
        finish(false);
        return;
      }
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    });
  });
}

function listenServer(server: Server, socketPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (error !== undefined && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function controlPath(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.includes("\0")
    || !isAbsolute(value)
  ) {
    throw new DaemonControlProtocolError("socketPath must be an absolute path without NUL");
  }
  return value;
}

function positiveInteger(value: unknown, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new DaemonControlProtocolError(`${field} must be a positive integer <= ${maximum}`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DaemonControlProtocolError(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function parseRequest(value: unknown): DaemonControlRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DaemonControlProtocolError("request must be an object");
  }
  const record = value as Record<string, unknown>;
  const id = requiredString(record.id, "request.id");
  const method = record.method;
  if (
    method !== "start"
    && method !== "stop"
    && method !== "status"
    && method !== "attach"
    && method !== "detach"
    && method !== "wake"
    && method !== "events.subscribe"
  ) {
    throw new DaemonControlProtocolError("request.method is unsupported");
  }
  if (record.version !== undefined && record.version !== DAEMON_CONTROL_PROTOCOL_VERSION) {
    throw new DaemonControlProtocolError("request.version is unsupported");
  }
  return {
    ...(record.version === undefined ? {} : { version: record.version as number }),
    id,
    method,
    ...(record.params === undefined ? {} : { params: record.params }),
  };
}

function requestId(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" && id.trim() === id && id.length > 0 ? id : null;
}

function recordParams(value: unknown, method: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DaemonControlProtocolError(`${method} params must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.includes("\0")
  ) {
    throw new DaemonControlProtocolError(`${field} must be a non-empty, trimmed string without NUL`);
  }
  return value;
}

function expectNoParams(value: unknown): void {
  if (value !== undefined) {
    throw new DaemonControlProtocolError("this command does not accept params");
  }
}

function eventMatchesRun(event: DaemonHostEvent, runId: string | undefined): boolean {
  if (runId === undefined) return true;
  if (event.type === "state") return true;
  if (event.type === "wake") return event.request.runId === runId;
  return event.runId === runId;
}
