import type { AnyEvent } from "../domain/events.js";
import { validateEvent } from "../ledger/index.js";
import {
  DaemonControlClient,
  DaemonControlClientError,
} from "./daemon-control-client.js";
import type { DaemonHostSnapshot } from "./daemon-host.js";
import type {
  DaemonObserverCursor,
  DaemonRunObservation,
  DaemonRunReplayResult,
} from "./daemon-observer.js";

const DEFAULT_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 30_000;

export type DaemonRemoteAttachmentStatus =
  | "connecting"
  | "attached"
  | "reconnecting"
  | "resyncing"
  | "closed";

export interface DaemonRemoteAttachmentSnapshot {
  readonly runId: string;
  readonly status: DaemonRemoteAttachmentStatus;
  readonly cursor: DaemonObserverCursor;
  readonly generation?: number;
  readonly events: readonly AnyEvent[];
  readonly host?: DaemonHostSnapshot;
  readonly error?: string;
}

export interface DaemonRemoteAttachmentOptions {
  readonly socketPath: string;
  readonly runId: string;
  readonly reconnectDelayMs?: number;
  /** Test/embedding seam; production owns one DaemonControlClient. */
  readonly client?: DaemonControlClient;
}

interface AttachResult {
  readonly clientId: string;
  readonly snapshot: DaemonHostSnapshot;
}

interface SubscribeResult {
  readonly subscribed: boolean;
  readonly runId: string;
  readonly replay: DaemonRunReplayResult;
  /** Presence is part of the generation contract, even when a source omits it. */
  readonly generationPresent: boolean;
}

/**
 * Cursor-safe, read-only attachment to one daemon-owned Run.
 *
 * The Ledger frames remain authoritative. Host events only refine transient
 * connection/activity presentation, and a reconnect always catches up from
 * the last contiguous cursor before live observation resumes.
 */
export class DaemonRemoteAttachment {
  readonly runId: string;
  readonly socketPath: string;

  private readonly client: DaemonControlClient;
  private readonly reconnectDelayMs: number;
  private readonly listeners = new Set<(snapshot: DaemonRemoteAttachmentSnapshot) => void>();
  private events: AnyEvent[] = [];
  /** Content identities for accepted offsets; duplicates must match exactly. */
  private readonly seenEventHashes = new Map<number, string>();
  private cursorOffset = 0;
  private generation: number | undefined;
  private generationSeen = false;
  private generationPresent = false;
  private host: DaemonHostSnapshot | undefined;
  private status: DaemonRemoteAttachmentStatus = "connecting";
  private error: string | undefined;
  private attachedClientId: string | undefined;
  private operation: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private everAttached = false;
  private closed = false;
  /** A history reset that cannot be satisfied must not spin reconnect forever. */
  private terminalFailure = false;
  private readonly unsubscribeRun: () => void;
  private readonly unsubscribeHost: () => void;
  private readonly unsubscribeConnection: () => void;

  private constructor(options: DaemonRemoteAttachmentOptions) {
    this.runId = pathSafeIdentifier(options.runId, "runId");
    this.client = options.client ?? new DaemonControlClient({ socketPath: options.socketPath });
    this.socketPath = this.client.socketPath;
    this.reconnectDelayMs = boundedReconnectDelay(options.reconnectDelayMs);
    this.unsubscribeRun = this.client.onRunEvent((observation) => {
      this.handleRunObservation(observation);
    });
    this.unsubscribeHost = this.client.onEvent((event) => {
      if (event.type === "state") {
        this.host = structuredClone(event.snapshot);
      }
      this.publish();
    });
    this.unsubscribeConnection = this.client.onConnection((event) => {
      if (event.type !== "disconnected" || this.closed || this.terminalFailure || !this.everAttached) return;
      this.status = "reconnecting";
      this.error = event.error.message;
      this.publish();
      this.scheduleReconnect();
    });
  }

  static async open(options: DaemonRemoteAttachmentOptions): Promise<DaemonRemoteAttachment> {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new DaemonControlClientError("invalid_options", "attachment options must be an object");
    }
    const attachment = new DaemonRemoteAttachment(options);
    try {
      await attachment.connectAndSubscribe(false);
      return attachment;
    } catch (error: unknown) {
      await attachment.close();
      throw error;
    }
  }

  snapshot(): DaemonRemoteAttachmentSnapshot {
    return {
      runId: this.runId,
      status: this.status,
      cursor: `offset:${this.cursorOffset}`,
      ...(this.generationPresent && this.generation !== undefined
        ? { generation: this.generation }
        : {}),
      events: this.events.map((event) => structuredClone(event)),
      ...(this.host === undefined ? {} : { host: structuredClone(this.host) }),
      ...(this.error === undefined ? {} : { error: this.error }),
    };
  }

  subscribe(listener: (snapshot: DaemonRemoteAttachmentSnapshot) => void): () => void {
    if (typeof listener !== "function") {
      throw new DaemonControlClientError("invalid_listener", "attachment listener must be a function");
    }
    if (this.closed) {
      throw new DaemonControlClientError("closed", "remote attachment is closed");
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    const operation = this.performClose();
    this.closePromise = operation;
    return operation;
  }

  private async performClose(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const operation = this.operation;
    if (operation === undefined && this.client.connected && this.attachedClientId !== undefined) {
      await this.client.request("detach", { clientId: this.attachedClientId }).catch(() => undefined);
    } else if (operation !== undefined) {
      // Abort a connect/replay request rather than waiting for its request timeout.
      // Closing the socket also releases its daemon-side attachment.
      this.client.close();
      await operation.catch(() => undefined);
    }
    this.unsubscribeRun();
    this.unsubscribeHost();
    this.unsubscribeConnection();
    this.client.close();
    this.status = "closed";
    this.error = undefined;
    this.publish();
    this.listeners.clear();
  }

  private connectAndSubscribe(reconnecting: boolean): Promise<void> {
    if (this.closed || this.terminalFailure) {
      return Promise.reject(new DaemonControlClientError("closed", "remote attachment is closed"));
    }
    if (this.operation !== undefined) return this.operation;
    const operation = this.performConnectAndSubscribe(reconnecting);
    this.operation = operation;
    void operation.finally(() => {
      if (this.operation === operation) this.operation = undefined;
    }).catch(() => undefined);
    return operation;
  }

  private async performConnectAndSubscribe(reconnecting: boolean): Promise<void> {
    this.status = reconnecting ? "reconnecting" : "connecting";
    this.publish();
    await this.client.connect();
    if (this.closed) return;
    const attached = parseAttachResult(await this.client.request("attach", {
      runId: this.runId,
    }));
    this.attachedClientId = attached.clientId;
    this.host = structuredClone(attached.snapshot);
    await this.subscribeFromCursor();
    if (this.closed || this.terminalFailure) return;
    this.everAttached = true;
    this.status = "attached";
    this.error = undefined;
    this.publish();
  }

  private async subscribeFromCursor(): Promise<void> {
    let upperWatermark: number | undefined;
    for (;;) {
      const requestedCursor: DaemonObserverCursor = `offset:${this.cursorOffset}`;
      const result = parseSubscribeResult(await this.client.request("events.subscribe", {
        runId: this.runId,
        cursor: requestedCursor,
        ...(upperWatermark === undefined ? {} : { upperWatermark }),
        ...(this.generationPresent && this.generation !== undefined
          ? { generation: this.generation }
          : {}),
      }));
      if (result.runId !== this.runId) {
        throw new DaemonControlClientError(
          "invalid_frame",
          "daemon subscribed the attachment to a different Run",
        );
      }
      const replay = result.replay;
      if (replay.cursor !== requestedCursor) {
        throw new DaemonControlClientError(
          "invalid_frame",
          "daemon replay did not start at the requested cursor",
        );
      }
      this.observeGeneration(
        result.generationPresent,
        replay.generation,
        replay.status === "resync_required",
      );
      if (replay.status === "resync_required") {
        if (replay.runId !== this.runId) {
          throw new DaemonControlClientError(
            "invalid_frame",
            "daemon replay belongs to another Run",
          );
        }
        if (this.cursorOffset === 0 && this.events.length === 0) {
          this.terminalFailure = true;
          this.status = "resyncing";
          this.error = `daemon cannot replay Run history: ${replay.reason}`;
          this.client.close();
          throw new DaemonControlClientError(
            "resync_required",
            this.error,
          );
        }
        this.status = "resyncing";
        this.events = [];
        this.cursorOffset = 0;
        this.resetReplayIdentity();
        this.publish();
        upperWatermark = undefined;
        continue;
      }
      if (upperWatermark !== undefined && replay.watermark !== upperWatermark) {
        throw new DaemonControlClientError(
          "invalid_frame",
          "daemon replay watermark changed mid-pagination",
        );
      }
      this.applyReplay(replay);
      upperWatermark ??= replay.watermark;
      if (!replay.hasMore) {
        if (!result.subscribed) {
          throw new DaemonControlClientError(
            "invalid_frame",
            "daemon did not start live observation after replay",
          );
        }
        return;
      }
    }
  }

  private applyReplay(replay: Extract<DaemonRunReplayResult, { status: "ok" }>): void {
    if (replay.runId !== this.runId) {
      throw new DaemonControlClientError("invalid_frame", "daemon replay belongs to another Run");
    }
    const staged = this.stageEvents(replay.events);
    if (replay.nextCursor !== `offset:${staged.cursorOffset}`) {
      throw new DaemonControlClientError("invalid_frame", "daemon replay cursor does not match its events");
    }
    this.events.push(...staged.events);
    this.cursorOffset = staged.cursorOffset;
    this.commitEventIdentities(staged.identities);
    this.publish();
  }

  private observeGeneration(
    present: boolean,
    value: number | undefined,
    allowValueChange: boolean,
  ): void {
    if (!this.generationSeen) {
      this.generationSeen = true;
      this.generationPresent = present;
      this.generation = present ? value : undefined;
      return;
    }
    if (present !== this.generationPresent) {
      throw new DaemonControlClientError(
        "invalid_frame",
        "daemon replay generation presence changed mid-stream",
      );
    }
    if (present && value !== this.generation && !allowValueChange) {
      throw new DaemonControlClientError(
        "invalid_frame",
        "daemon replay generation changed mid-stream",
      );
    }
  }

  private handleRunObservation(observation: DaemonRunObservation): void {
    if (this.closed) return;
    if (observation.type === "event") {
      if (observation.runId !== this.runId) {
        const error = new DaemonControlClientError(
          "invalid_frame",
          "daemon emitted a live event for another Run",
        );
        this.status = "resyncing";
        this.error = error.message;
        this.publish();
        this.restartSubscription(true);
        return;
      }
      try {
        const staged = this.stageEvents([observation.event]);
        if (observation.cursor !== `offset:${staged.cursorOffset}`) {
          throw new DaemonControlClientError(
            "invalid_frame",
            "daemon live cursor does not match its event",
          );
        }
        this.events.push(...staged.events);
        this.cursorOffset = staged.cursorOffset;
        this.commitEventIdentities(staged.identities);
        this.publish();
      } catch (error: unknown) {
        this.status = "resyncing";
        this.error = error instanceof Error ? error.message : String(error);
        this.publish();
        this.restartSubscription(true);
      }
      return;
    }
    this.status = observation.type === "resync_required" ? "resyncing" : "reconnecting";
    this.error = observation.type === "resync_required"
      ? `daemon requested projection resync: ${observation.result.reason}`
      : observation.error;
    this.publish();
    this.restartSubscription(observation.type === "resync_required");
  }

  private stageEvents(candidates: readonly unknown[]): {
    readonly events: AnyEvent[];
    readonly cursorOffset: number;
    readonly identities: ReadonlyMap<number, string>;
  } {
    const events: AnyEvent[] = [];
    const identities = new Map<number, string>();
    let cursorOffset = this.cursorOffset;
    for (const candidate of candidates) {
      try {
        validateEvent(candidate);
      } catch (error: unknown) {
        throw new DaemonControlClientError(
          "invalid_frame",
          `daemon emitted an invalid Ledger event: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (candidate.runId !== this.runId) {
        throw new DaemonControlClientError("invalid_frame", "daemon emitted an event for another Run");
      }
      if (candidate.globalOffset <= cursorOffset) {
        const knownHash = identities.get(candidate.globalOffset)
          ?? this.seenEventHashes.get(candidate.globalOffset)
          ?? this.events.find((event) => event.globalOffset === candidate.globalOffset)?.contentHash;
        if (knownHash === undefined) {
          throw new DaemonControlClientError(
            "invalid_frame",
            `daemon repeated an unknown event offset ${candidate.globalOffset}`,
          );
        }
        if (candidate.contentHash !== knownHash) {
          throw new DaemonControlClientError(
            "invalid_frame",
            `daemon emitted different content for event offset ${candidate.globalOffset}`,
          );
        }
        identities.set(candidate.globalOffset, candidate.contentHash);
        continue;
      }
      if (candidate.globalOffset !== cursorOffset + 1) {
        throw new DaemonControlClientError("offset_gap", "daemon emitted a non-contiguous event offset");
      }
      events.push(structuredClone(candidate));
      identities.set(candidate.globalOffset, candidate.contentHash);
      cursorOffset = candidate.globalOffset;
    }
    return { events, cursorOffset, identities };
  }

  private commitEventIdentities(identities: ReadonlyMap<number, string>): void {
    for (const [offset, hash] of identities) this.seenEventHashes.set(offset, hash);
  }

  private resetReplayIdentity(): void {
    this.generation = undefined;
    this.generationSeen = false;
    this.generationPresent = false;
    this.seenEventHashes.clear();
  }

  private restartSubscription(reset: boolean): void {
    if (this.closed || this.terminalFailure || this.operation !== undefined) return;
    const operation = (async () => {
      if (reset) {
        this.events = [];
        this.cursorOffset = 0;
        this.resetReplayIdentity();
      }
      await this.subscribeFromCursor();
      if (this.closed || this.terminalFailure) return;
      this.status = "attached";
      this.error = undefined;
      this.publish();
    })();
    this.operation = operation;
    void operation.then(
      () => { if (this.operation === operation) this.operation = undefined; },
      (error: unknown) => {
        if (this.operation === operation) this.operation = undefined;
        if (this.closed) return;
        if (this.terminalFailure) return;
        this.status = "reconnecting";
        this.error = error instanceof Error ? error.message : String(error);
        this.publish();
        this.scheduleReconnect();
      },
    );
  }

  private scheduleReconnect(): void {
    if (this.closed || this.terminalFailure || this.reconnectTimer !== undefined) return;
    const timer = setTimeout(() => {
      if (this.reconnectTimer !== timer) return;
      this.reconnectTimer = undefined;
      void this.connectAndSubscribe(true).catch((error: unknown) => {
        if (this.closed || this.terminalFailure) return;
        this.status = "reconnecting";
        this.error = error instanceof Error ? error.message : String(error);
        this.publish();
        this.scheduleReconnect();
      });
    }, this.reconnectDelayMs);
    this.reconnectTimer = timer;
  }

  private publish(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Presentation observers cannot own attachment recovery.
      }
    }
  }
}

function pathSafeIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.includes("\0")
    || value === "."
    || value === ".."
    || /[\\/]/u.test(value)
  ) {
    throw new DaemonControlClientError(
      "invalid_options",
      `${field} must be a non-empty path-safe identifier`,
    );
  }
  return value;
}

function boundedReconnectDelay(value: number | undefined): number {
  const selected = value ?? DEFAULT_RECONNECT_DELAY_MS;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > MAX_RECONNECT_DELAY_MS) {
    throw new DaemonControlClientError(
      "invalid_options",
      `reconnectDelayMs must be an integer between 1 and ${MAX_RECONNECT_DELAY_MS}`,
    );
  }
  return selected;
}

function parseAttachResult(value: unknown): AttachResult {
  if (!isRecord(value)) {
    throw new DaemonControlClientError("invalid_frame", "daemon attach result must be an object");
  }
  const clientId = protocolIdentifier(value.clientId, "attach clientId");
  const snapshot = value.snapshot;
  if (!isDaemonHostSnapshot(snapshot)) {
    throw new DaemonControlClientError("invalid_frame", "daemon attach snapshot is invalid");
  }
  return { clientId, snapshot: structuredClone(snapshot) };
}

function parseSubscribeResult(value: unknown): SubscribeResult {
  if (!isRecord(value) || typeof value.subscribed !== "boolean") {
    throw new DaemonControlClientError("invalid_frame", "daemon subscribe result is invalid");
  }
  const runId = protocolIdentifier(value.runId, "subscribe runId");
  if (!isRecord(value.replay)) {
    throw new DaemonControlClientError("invalid_frame", "daemon replay result must be an object");
  }
  const replay = value.replay;
  const generationPresent = Object.prototype.hasOwnProperty.call(replay, "generation");
  const cursor = protocolCursor(replay.cursor, "replay cursor");
  if (generationPresent && replay.generation === undefined) {
    throw new DaemonControlClientError("invalid_frame", "replay generation cannot be undefined");
  }
  const generation = optionalGeneration(replay.generation);
  if (replay.status === "resync_required") {
    if (
      !nonNegativeInteger(replay.firstOffset)
      || !nonNegativeInteger(replay.watermark)
      || (replay.reason !== "cursor-ahead"
        && replay.reason !== "history-truncated"
        && replay.reason !== "offset-gap")
    ) {
      throw new DaemonControlClientError("invalid_frame", "daemon resync result is invalid");
    }
    return {
      subscribed: value.subscribed,
      runId,
      generationPresent,
      replay: {
        status: "resync_required",
        runId: protocolIdentifier(replay.runId, "replay runId"),
        cursor,
        firstOffset: replay.firstOffset,
        watermark: replay.watermark,
        ...(generation === undefined ? {} : { generation }),
        reason: replay.reason,
      },
    };
  }
  if (
    replay.status !== "ok"
    || !nonNegativeInteger(replay.watermark)
    || typeof replay.hasMore !== "boolean"
    || !Array.isArray(replay.events)
  ) {
    throw new DaemonControlClientError("invalid_frame", "daemon replay page is invalid");
  }
  const nextCursor = protocolCursor(replay.nextCursor, "replay nextCursor");
  const cursorOffset = decodeProtocolCursor(cursor);
  const nextCursorOffset = decodeProtocolCursor(nextCursor);
  if (
    cursorOffset > replay.watermark
    || nextCursorOffset > replay.watermark
    || (replay.hasMore && nextCursorOffset <= cursorOffset)
    || (replay.hasMore && nextCursorOffset >= replay.watermark)
    || (!replay.hasMore && nextCursorOffset !== replay.watermark)
  ) {
    throw new DaemonControlClientError("invalid_frame", "daemon replay pagination is invalid");
  }
  return {
    subscribed: value.subscribed,
    runId,
    generationPresent,
    replay: {
      status: "ok",
      runId: protocolIdentifier(replay.runId, "replay runId"),
      cursor,
      nextCursor,
      watermark: replay.watermark,
      ...(generation === undefined ? {} : { generation }),
      hasMore: replay.hasMore,
      events: replay.events as AnyEvent[],
    },
  };
}

function isDaemonHostSnapshot(value: unknown): value is DaemonHostSnapshot {
  if (!isRecord(value)) return false;
  if (
    (value.status !== "stopped" && value.status !== "running" && value.status !== "stopping")
    || !validProtocolIdentifier(value.ownerId)
    || !nonNegativeInteger(value.queuedRuns)
    || !nonNegativeInteger(value.runningRuns)
    || !nonNegativeInteger(value.attachedClients)
    || !Array.isArray(value.runs)
  ) return false;
  return value.runs.every((candidate) => (
    isRecord(candidate)
    && validProtocolIdentifier(candidate.runId)
    && (candidate.state === "queued"
      || candidate.state === "running"
      || candidate.state === "held"
      || candidate.state === "failed")
    && nonNegativeInteger(candidate.pendingWakeCount)
    && (candidate.activationId === undefined
      || validProtocolIdentifier(candidate.activationId))
    && (candidate.fencingToken === undefined
      || nonNegativeInteger(candidate.fencingToken))
    && (candidate.lastError === undefined || typeof candidate.lastError === "string")
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function protocolIdentifier(value: unknown, field: string): string {
  if (!validProtocolIdentifier(value)) {
    throw new DaemonControlClientError("invalid_frame", `${field} is invalid`);
  }
  return value;
}

function validProtocolIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && !value.includes("\0");
}

function protocolCursor(value: unknown, field: string): DaemonObserverCursor {
  if (typeof value !== "string" || !/^offset:(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new DaemonControlClientError("invalid_frame", `${field} is invalid`);
  }
  const offset = Number(value.slice("offset:".length));
  if (!Number.isSafeInteger(offset)) {
    throw new DaemonControlClientError("invalid_frame", `${field} is invalid`);
  }
  return value as DaemonObserverCursor;
}

function decodeProtocolCursor(value: DaemonObserverCursor): number {
  return Number(value.slice("offset:".length));
}

function optionalGeneration(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!nonNegativeInteger(value)) {
    throw new DaemonControlClientError("invalid_frame", "replay generation is invalid");
  }
  return value;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
