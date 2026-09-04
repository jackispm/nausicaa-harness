import { watch, type FSWatcher, type WatchOptions } from "node:fs";
import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { ArtifactRef, Clock } from "../domain/index.js";
import { systemClock } from "../domain/index.js";
import { sha256, stableJson } from "../ledger/hash.js";
import type {
  DaemonWakeRequest,
} from "./daemon-host.js";

const MAX_TIMER_INTERVAL_MS = 2_147_483_647;
const MAX_WEBHOOK_PAYLOAD_BYTES = 256 * 1024 * 1024;

/** A source only emits requests; admission remains the Host/ Ledger boundary. */
export type DaemonWakeEmitter = (
  request: DaemonWakeRequest,
) => void | Promise<void>;

export interface DaemonWakeSourceController {
  readonly running: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export class DaemonWakeSourceError extends Error {
  override readonly name = "DaemonWakeSourceError";
}

interface WakeSourceOptions {
  readonly runId: string;
  readonly onWake: DaemonWakeEmitter;
  readonly clock?: Clock;
}

export interface TimerWakeSourceOptions extends WakeSourceOptions {
  /** Stable identity for this schedule. It must remain unchanged on restart. */
  readonly scheduleId: string;
  /** Milliseconds between timer callbacks. The value is also the slot width. */
  readonly intervalMs: number;
  /** Optional phase origin. Defaults to the Unix epoch. */
  readonly epochMs?: number;
  readonly startImmediately?: boolean;
  readonly onError?: (error: Error) => void;
}

export interface TimerWakeSource extends DaemonWakeSourceController {
  /** Emit one tick through the same serialized path used by setInterval. */
  tick(): Promise<DaemonWakeRequest>;
}

/**
 * A wall-clock source with deterministic slot identities.
 *
 * The slot, rather than an in-memory counter, is part of the dedupe key. A
 * restarted daemon which observes the same slot therefore emits the same
 * request and lets Ledger admission decide whether it is new or duplicate.
 */
export class TimerWakeSourceImpl implements TimerWakeSource {
  readonly #runId: string;
  readonly #scheduleId: string;
  readonly #intervalMs: number;
  readonly #epochMs: number;
  readonly #onWake: DaemonWakeEmitter;
  readonly #clock: Clock;
  readonly #onError: (error: Error) => void;
  readonly #startImmediately: boolean;
  #lastSlot: number | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;
  #closed = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: TimerWakeSourceOptions) {
    validateWakeSourceOptions(options);
    this.#runId = identifier(options.runId, "runId");
    this.#scheduleId = identifier(options.scheduleId, "scheduleId");
    this.#intervalMs = positiveInteger(
      options.intervalMs,
      "intervalMs",
      MAX_TIMER_INTERVAL_MS,
    );
    this.#epochMs = options.epochMs ?? 0;
    if (!Number.isSafeInteger(this.#epochMs) || this.#epochMs < 0) {
      throw new DaemonWakeSourceError("epochMs must be a non-negative safe integer");
    }
    this.#onWake = options.onWake;
    this.#clock = options.clock ?? systemClock;
    this.#onError = errorHandler(options.onError);
    this.#startImmediately = options.startImmediately === true;
  }

  get running(): boolean {
    return this.#running;
  }

  async start(): Promise<void> {
    if (this.#closed) throw new DaemonWakeSourceError("Timer wake source is closed");
    if (this.#running) return;
    this.#running = true;
    if (this.#timer === undefined) {
      this.#timer = setInterval(() => {
        void this.#enqueueTick().catch((error: unknown) => this.#report(error));
      }, this.#intervalMs);
      this.#timer.unref?.();
    }
    if (this.#startImmediately) {
      try {
        await this.tick();
      } catch (error: unknown) {
        // A failed bootstrap wake must not leave a live interval behind or
        // make a later start() silently return the poisoned running state.
        await this.stop();
        throw error;
      }
    }
  }

  async tick(): Promise<DaemonWakeRequest> {
    if (this.#closed) throw new DaemonWakeSourceError("Timer wake source is closed");
    if (!this.#running) throw new DaemonWakeSourceError("Timer wake source is stopped");
    return this.#enqueueTick();
  }

  async stop(): Promise<void> {
    if (!this.#running && this.#timer === undefined) {
      await this.#tail;
      return;
    }
    this.#running = false;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    await this.#tail;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.stop();
  }

  #enqueueTick(): Promise<DaemonWakeRequest> {
    const operation = this.#tail.then(async () => {
      if (!this.#running || this.#closed) {
        throw new DaemonWakeSourceError("Timer wake source is stopped");
      }
      const now = this.#clock.now();
      const nowMs = now.getTime();
      if (!Number.isFinite(nowMs)) {
        throw new DaemonWakeSourceError("clock returned an invalid date");
      }
      const slot = Math.floor((nowMs - this.#epochMs) / this.#intervalMs);
      if (!Number.isSafeInteger(slot)) {
        throw new DaemonWakeSourceError("clock produced an unsafe timer slot");
      }
      if (this.#lastSlot !== undefined && slot < this.#lastSlot) {
        throw new DaemonWakeSourceError("clock moved backwards for timer wake source");
      }
      const digest = sha256(stableJson([this.#scheduleId, slot]));
      const request: DaemonWakeRequest = Object.freeze({
        runId: this.#runId,
        source: "timer",
        dedupeKey: `timer:${digest}`,
        wakeId: `timer:${digest}`,
        occurredAt: now.toISOString(),
      });
      await this.#onWake(request);
      this.#lastSlot = slot;
      return request;
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  #report(error: unknown): void {
    this.#onError(error instanceof Error ? error : new Error(String(error)));
  }
}

export function createTimerWakeSource(options: TimerWakeSourceOptions): TimerWakeSource {
  return new TimerWakeSourceImpl(options);
}

export interface WebhookWakeEvent {
  /** Provider event ID; required for stable retry/dedupe semantics. */
  readonly eventId: string;
  readonly payloadRef?: ArtifactRef;
  readonly inputId?: string;
  readonly occurredAt?: string;
}

export interface WebhookWakeSourceOptions extends WakeSourceOptions {
  /** Stable identity for this webhook endpoint or subscription. */
  readonly webhookId: string;
  /** Optional upper bound for the referenced request payload. */
  readonly maxPayloadBytes?: number;
}

export interface WebhookWakeSource extends DaemonWakeSourceController {
  receive(event: WebhookWakeEvent): Promise<DaemonWakeRequest>;
}

interface NormalizedWebhookWakeEvent {
  readonly eventId: string;
  readonly payloadRef?: ArtifactRef;
  readonly inputId?: string;
  readonly occurredAt: string;
}

/** Converts an external webhook event into one ordinary daemon wake request. */
export class WebhookWakeSourceImpl implements WebhookWakeSource {
  readonly #runId: string;
  readonly #webhookId: string;
  readonly #onWake: DaemonWakeEmitter;
  readonly #clock: Clock;
  readonly #maxPayloadBytes: number | undefined;
  #running = false;
  #closed = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: WebhookWakeSourceOptions) {
    validateWakeSourceOptions(options);
    this.#runId = identifier(options.runId, "runId");
    this.#webhookId = identifier(options.webhookId, "webhookId");
    this.#onWake = options.onWake;
    this.#clock = options.clock ?? systemClock;
    this.#maxPayloadBytes = options.maxPayloadBytes === undefined
      ? undefined
      : nonNegativeInteger(options.maxPayloadBytes, "maxPayloadBytes", MAX_WEBHOOK_PAYLOAD_BYTES);
  }

  get running(): boolean {
    return this.#running;
  }

  async start(): Promise<void> {
    if (this.#closed) throw new DaemonWakeSourceError("Webhook wake source is closed");
    this.#running = true;
  }

  async stop(): Promise<void> {
    this.#running = false;
    await this.#tail;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.stop();
  }

  async receive(event: WebhookWakeEvent): Promise<DaemonWakeRequest> {
    if (this.#closed) throw new DaemonWakeSourceError("Webhook wake source is closed");
    if (!this.#running) throw new DaemonWakeSourceError("Webhook wake source is stopped");
    const normalized = normalizeWebhookEvent(event, this.#clock, this.#maxPayloadBytes);
    const operation = this.#tail.then(async () => {
      if (!this.#running || this.#closed) {
        throw new DaemonWakeSourceError("Webhook wake source is stopped");
      }
      const digest = sha256(stableJson([this.#webhookId, normalized.eventId]));
      const request: DaemonWakeRequest = Object.freeze({
        runId: this.#runId,
        source: "webhook",
        dedupeKey: `webhook:${digest}`,
        wakeId: `webhook:${digest}`,
        ...(normalized.inputId === undefined ? {} : { inputId: normalized.inputId }),
        ...(normalized.payloadRef === undefined ? {} : { payloadRef: structuredClone(normalized.payloadRef) }),
        occurredAt: normalized.occurredAt,
      });
      await this.#onWake(request);
      return request;
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

export function createWebhookWakeSource(options: WebhookWakeSourceOptions): WebhookWakeSource {
  return new WebhookWakeSourceImpl(options);
}

export type FileWakeEventType = "change" | "rename";

export interface FileWakeNotification {
  readonly eventType: FileWakeEventType;
  /** Path relative to the watched directory; omitted for a watched file. */
  readonly relativePath?: string;
  /** Caller-supplied revision. The default resolver uses filesystem metadata. */
  readonly revision?: string;
  readonly payloadRef?: ArtifactRef;
  readonly inputId?: string;
  readonly occurredAt?: string;
}

export interface DaemonFileWatcher {
  on(event: "error", listener: (error: Error) => void): DaemonFileWatcher;
  close(): void;
}

export type DaemonFileWatchFactory = (
  path: string,
  options: WatchOptions,
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => DaemonFileWatcher;

export interface FileWakeSourceOptions extends WakeSourceOptions {
  /** File or directory to observe; it is canonicalized to an absolute path. */
  readonly path: string;
  /** Stable identity for this watch. */
  readonly watchId: string;
  readonly watchOptions?: WatchOptions;
  readonly watchFactory?: DaemonFileWatchFactory;
  /** Override metadata reads when the watched resource is virtual/test-backed. */
  readonly resolveRevision?: (
    targetPath: string,
    notification: FileWakeNotification,
  ) => string | Promise<string>;
  readonly onError?: (error: Error) => void;
}

export interface FileWakeSource extends DaemonWakeSourceController {
  notify(notification: FileWakeNotification): Promise<DaemonWakeRequest>;
}

/**
 * Turns filesystem notifications into requests. The source does not persist
 * revisions or perform admission; duplicate notifications remain safe because
 * their deterministic revision key is handed to the Ledger adapter.
 */
export class FileWakeSourceImpl implements FileWakeSource {
  readonly #runId: string;
  readonly #watchId: string;
  readonly #path: string;
  readonly #watchOptions: WatchOptions;
  readonly #watchFactory: DaemonFileWatchFactory;
  readonly #resolveRevision: (
    targetPath: string,
    notification: FileWakeNotification,
  ) => string | Promise<string>;
  readonly #onWake: DaemonWakeEmitter;
  readonly #clock: Clock;
  readonly #onError: (error: Error) => void;
  #watcher: DaemonFileWatcher | undefined;
  #running = false;
  #closed = false;
  #directory = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: FileWakeSourceOptions) {
    validateWakeSourceOptions(options);
    this.#runId = identifier(options.runId, "runId");
    this.#watchId = identifier(options.watchId, "watchId");
    if (typeof options.path !== "string" || options.path.trim().length === 0 || options.path.includes("\0")) {
      throw new DaemonWakeSourceError("path must be a non-empty string without NUL");
    }
    this.#path = resolve(options.path);
    this.#watchOptions = {
      persistent: false,
      ...(options.watchOptions ?? {}),
    };
    this.#watchFactory = options.watchFactory ?? defaultWatchFactory;
    this.#resolveRevision = options.resolveRevision ?? defaultResolveRevision;
    this.#onWake = options.onWake;
    this.#clock = options.clock ?? systemClock;
    this.#onError = errorHandler(options.onError);
  }

  get running(): boolean {
    return this.#running;
  }

  async start(): Promise<void> {
    if (this.#closed) throw new DaemonWakeSourceError("File wake source is closed");
    if (this.#running) return;
    const info = await lstat(this.#path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (this.#closed) throw new DaemonWakeSourceError("File wake source is closed");
    this.#directory = info?.isDirectory() === true;
    this.#running = true;
    try {
      this.#watcher = this.#watchFactory(
        this.#path,
        this.#watchOptions,
        (eventType, filename) => {
          if (!this.#running || this.#closed) return;
          if (eventType !== "change" && eventType !== "rename") {
            this.#report(new DaemonWakeSourceError(`unsupported file event type: ${eventType}`));
            return;
          }
          void this.#enqueueNotification({
            eventType,
            ...(filename === null
              ? {}
              : { relativePath: typeof filename === "string" ? filename : filename.toString("utf8") }),
          }).catch((error: unknown) => this.#report(error));
        },
      );
      this.#watcher.on("error", (error) => this.#report(error));
    } catch (error: unknown) {
      this.#running = false;
      this.#watcher = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#running = false;
    const watcher = this.#watcher;
    this.#watcher = undefined;
    watcher?.close();
    await this.#tail;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.stop();
  }

  notify(notification: FileWakeNotification): Promise<DaemonWakeRequest> {
    if (this.#closed) return Promise.reject(new DaemonWakeSourceError("File wake source is closed"));
    if (!this.#running) return Promise.reject(new DaemonWakeSourceError("File wake source is stopped"));
    return this.#enqueueNotification(notification);
  }

  #enqueueNotification(notification: FileWakeNotification): Promise<DaemonWakeRequest> {
    const operation = this.#tail.then(async () => {
      if (!this.#running || this.#closed) {
        throw new DaemonWakeSourceError("File wake source is stopped");
      }
      const normalized = normalizeFileNotification(notification);
      const targetPath = this.#targetPath(normalized.relativePath);
      const revision = normalized.revision
        ?? await this.#resolveRevision(targetPath, normalized);
      const revisionId = identifier(revision, "revision");
      const digest = sha256(stableJson([
        this.#watchId,
        normalized.eventType,
        this.#directory ? normalized.relativePath ?? "." : ".",
        revisionId,
      ]));
      const occurredAt = normalized.occurredAt ?? this.#clock.now().toISOString();
      validateOccurredAt(occurredAt, "notification.occurredAt");
      const request: DaemonWakeRequest = Object.freeze({
        runId: this.#runId,
        source: "file",
        dedupeKey: `file:${digest}`,
        wakeId: `file:${digest}`,
        occurredAt,
        ...(normalized.payloadRef === undefined ? {} : { payloadRef: structuredClone(normalized.payloadRef) }),
        ...(normalized.inputId === undefined ? {} : { inputId: identifier(normalized.inputId, "inputId") }),
      });
      await this.#onWake(request);
      return request;
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  #targetPath(relativePath: string | undefined): string {
    if (!this.#directory || relativePath === undefined || relativePath === ".") return this.#path;
    const target = resolve(this.#path, relativePath);
    const outside = relative(this.#path, target);
    if (outside === ".." || outside.startsWith("../")) {
      throw new DaemonWakeSourceError("file notification escapes the watched path");
    }
    return target;
  }

  #report(error: unknown): void {
    this.#onError(error instanceof Error ? error : new Error(String(error)));
  }
}

export function createFileWakeSource(options: FileWakeSourceOptions): FileWakeSource {
  return new FileWakeSourceImpl(options);
}

function defaultWatchFactory(
  path: string,
  options: WatchOptions,
  listener: (eventType: string, filename: string | Buffer | null) => void,
): FSWatcher {
  return watch(path, options, listener);
}

async function defaultResolveRevision(
  targetPath: string,
): Promise<string> {
  const info = await lstat(targetPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (info === undefined) return "missing";
  return stableJson({
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mode: info.mode,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  });
}

function validateWakeSourceOptions(options: WakeSourceOptions): void {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new DaemonWakeSourceError("wake source options must be an object");
  }
  if (typeof options.onWake !== "function") {
    throw new DaemonWakeSourceError("onWake must be a function");
  }
  identifier(options.runId, "runId");
}

function normalizeFileNotification(notification: FileWakeNotification): FileWakeNotification {
  if (notification === null || typeof notification !== "object" || Array.isArray(notification)) {
    throw new DaemonWakeSourceError("file notification must be an object");
  }
  if (notification.eventType !== "change" && notification.eventType !== "rename") {
    throw new DaemonWakeSourceError("notification.eventType must be change or rename");
  }
  const relativePath = notification.relativePath === undefined
    ? undefined
    : normalizeRelativePath(notification.relativePath);
  if (notification.revision !== undefined) identifier(notification.revision, "revision");
  if (notification.payloadRef !== undefined && !isArtifactRef(notification.payloadRef)) {
    throw new DaemonWakeSourceError("notification.payloadRef must be an ArtifactRef");
  }
  if (notification.occurredAt !== undefined) {
    validateOccurredAt(notification.occurredAt, "notification.occurredAt");
  }
  return {
    eventType: notification.eventType,
    ...(relativePath === undefined ? {} : { relativePath }),
    ...(notification.revision === undefined ? {} : { revision: notification.revision }),
    ...(notification.payloadRef === undefined ? {} : { payloadRef: structuredClone(notification.payloadRef) }),
    ...(notification.inputId === undefined ? {} : { inputId: identifier(notification.inputId, "inputId") }),
    ...(notification.occurredAt === undefined ? {} : { occurredAt: notification.occurredAt }),
  };
}

function normalizeRelativePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || isAbsolute(value)) {
    throw new DaemonWakeSourceError("relativePath must be relative and NUL-free");
  }
  const normalized = value.replaceAll("\\", "/");
  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      throw new DaemonWakeSourceError("relativePath must remain within the watched directory");
    }
    segments.push(segment);
  }
  return segments.length === 0 ? "." : segments.join("/");
}

function validateOccurredAt(value: string, field: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new DaemonWakeSourceError(`${field} must be a valid date-time`);
  }
}

function identifier(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.includes("\0")
  ) {
    throw new DaemonWakeSourceError(`${field} must be a non-empty, trimmed string without NUL`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new DaemonWakeSourceError(`${field} must be a positive integer <= ${maximum}`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new DaemonWakeSourceError(`${field} must be a non-negative integer <= ${maximum}`);
  }
  return value as number;
}

function normalizeWebhookEvent(
  event: WebhookWakeEvent,
  clock: Clock,
  maxPayloadBytes: number | undefined,
): NormalizedWebhookWakeEvent {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw new DaemonWakeSourceError("webhook event must be an object");
  }
  const eventId = identifier(event.eventId, "eventId");
  const inputId = event.inputId === undefined ? undefined : identifier(event.inputId, "inputId");
  if (event.payloadRef !== undefined && !isArtifactRef(event.payloadRef)) {
    throw new DaemonWakeSourceError("webhook payloadRef must be an ArtifactRef");
  }
  const payloadRef = event.payloadRef === undefined ? undefined : structuredClone(event.payloadRef);
  if (payloadRef !== undefined && maxPayloadBytes !== undefined && payloadRef.byteLength > maxPayloadBytes) {
    throw new DaemonWakeSourceError(
      `webhook payload exceeds maxPayloadBytes (${maxPayloadBytes})`,
    );
  }
  const occurredAt = event.occurredAt ?? clock.now().toISOString();
  validateOccurredAt(occurredAt, "event.occurredAt");
  return {
    eventId,
    ...(inputId === undefined ? {} : { inputId }),
    ...(payloadRef === undefined ? {} : { payloadRef }),
    occurredAt,
  };
}

function isArtifactRef(value: unknown): value is ArtifactRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ArtifactRef>;
  return (
    typeof candidate.id === "string"
    && candidate.id.length > 0
    && typeof candidate.contentHash === "string"
    && /^sha256:[0-9a-f]{64}$/u.test(candidate.contentHash)
    && candidate.id === candidate.contentHash
    && typeof candidate.mediaType === "string"
    && candidate.mediaType.length > 0
    && Number.isSafeInteger(candidate.byteLength)
    && (candidate.byteLength as number) >= 0
  );
}

function errorHandler(handler: ((error: Error) => void) | undefined): (error: Error) => void {
  if (handler !== undefined && typeof handler !== "function") {
    throw new DaemonWakeSourceError("onError must be a function");
  }
  return (error) => {
    try {
      handler?.(error);
    } catch {
      // Error observers never own source lifecycle.
    }
  };
}
