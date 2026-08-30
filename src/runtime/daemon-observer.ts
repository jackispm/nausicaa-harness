import { constants } from "node:fs";
import { lstat, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";

import type { AnyEvent } from "../domain/events.js";
import {
  assertNoSymlinkComponents,
  assertRegularFile,
  openNoFollow,
} from "../ledger/file-utils.js";
import { validateEvent } from "../ledger/ledger.js";

const DEFAULT_REPLAY_LIMIT = 128;
const MAX_REPLAY_LIMIT = 512;
const DEFAULT_REPLAY_BYTES = 128 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 250;
const FILE_TAIL_ANCHOR_BYTES = 64;
const validatedFileSnapshot = Symbol("validatedFileSnapshot");

export type DaemonObserverCursor = `offset:${number}`;

export interface DaemonRunEventSnapshot {
  readonly runId: string;
  /** Source-local logical history generation, when rotation detection is available. */
  readonly generation?: number;
  /** First retained offset, or watermark + 1 when all history was truncated. */
  readonly firstOffset: number;
  /** Highest committed offset currently visible to the observer. */
  readonly watermark: number;
  /** A complete retained suffix ending at watermark. */
  readonly events: readonly AnyEvent[];
}

export interface DaemonRunEventSource {
  read(runId: string): Promise<DaemonRunEventSnapshot>;
  /** Optional bounded path for sources which already validate their append-only tail. */
  readReplay?(
    request: DaemonRunReplayRequest,
    maxReplayBytes: number,
  ): Promise<DaemonRunReplayResult>;
}

export interface DaemonRunReplayRequest {
  readonly runId: string;
  readonly cursor?: string;
  readonly limit?: number;
  /** Fixed replay boundary returned by the first page. Omit only for the first page or live tail. */
  readonly upperWatermark?: number;
  /** Source-local history generation returned by the first page. */
  readonly generation?: number;
}

export interface DaemonRunReplayPage {
  readonly status: "ok";
  readonly runId: string;
  readonly cursor: DaemonObserverCursor;
  readonly nextCursor: DaemonObserverCursor;
  /** Fixed upper boundary for every page in this replay. */
  readonly watermark: number;
  readonly generation?: number;
  readonly hasMore: boolean;
  readonly events: readonly AnyEvent[];
}

export type DaemonRunResyncReason =
  | "cursor-ahead"
  | "history-truncated"
  | "offset-gap";

export interface DaemonRunResyncRequired {
  readonly status: "resync_required";
  readonly runId: string;
  readonly cursor: DaemonObserverCursor;
  readonly firstOffset: number;
  readonly watermark: number;
  readonly generation?: number;
  readonly reason: DaemonRunResyncReason;
}

export type DaemonRunReplayResult = DaemonRunReplayPage | DaemonRunResyncRequired;

export type DaemonRunObservation =
  | {
      readonly type: "event";
      readonly runId: string;
      readonly cursor: DaemonObserverCursor;
      readonly event: AnyEvent;
    }
  | {
      readonly type: "resync_required";
      readonly result: DaemonRunResyncRequired;
    }
  | {
      readonly type: "source_error";
      readonly runId: string;
      readonly cursor: DaemonObserverCursor;
      readonly error: string;
    };

export type DaemonRunObservationListener = (observation: DaemonRunObservation) => void;

export interface DaemonRunSubscription {
  readonly replay: DaemonRunReplayResult;
  readonly subscribed: boolean;
  unsubscribe(): void;
}

export interface DaemonRunObserverOptions {
  readonly source: DaemonRunEventSource;
  readonly pollIntervalMs?: number;
  readonly maxReplayBytes?: number;
}

export class DaemonRunObserverProtocolError extends Error {
  override readonly name = "DaemonRunObserverProtocolError";
}

/**
 * Cursor-based observer over the Run Ledger.
 *
 * The Ledger remains the only durable event source. A subscription first
 * returns a bounded replay page. Live polling starts only when that page has
 * reached its fixed watermark, so callers never cross a replay/live gap.
 */
export class DaemonRunObserver {
  private readonly source: DaemonRunEventSource;
  private readonly pollIntervalMs: number;
  private readonly maxReplayBytes: number;

  constructor(options: DaemonRunObserverOptions) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new DaemonRunObserverProtocolError("observer options must be an object");
    }
    if (options.source === null || typeof options.source?.read !== "function") {
      throw new DaemonRunObserverProtocolError("observer source must provide read(runId)");
    }
    this.source = options.source;
    this.pollIntervalMs = boundedInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
      1,
      60_000,
    );
    this.maxReplayBytes = boundedInteger(
      options.maxReplayBytes ?? DEFAULT_REPLAY_BYTES,
      "maxReplayBytes",
      1_024,
      1024 * 1024,
    );
  }

  async replay(request: DaemonRunReplayRequest): Promise<DaemonRunReplayResult> {
    const normalized = replayRequest(request);
    if (this.source.readReplay !== undefined) {
      return this.source.readReplay(normalized, this.maxReplayBytes);
    }
    const snapshot = await this.source.read(normalized.runId);
    return projectDaemonRunReplay(snapshot, normalized, this.maxReplayBytes);
  }

  /**
   * Replay once and, only when fully caught up, poll from the returned cursor.
   * Listener failures are isolated from the observer lifecycle.
   */
  async subscribe(
    request: DaemonRunReplayRequest,
    listener: DaemonRunObservationListener,
  ): Promise<DaemonRunSubscription> {
    if (typeof listener !== "function") {
      throw new DaemonRunObserverProtocolError("observation listener must be a function");
    }
    const normalized = replayRequest(request);
    const replay = await this.replay(normalized);
    const sourceGeneration = replay.generation;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor = replay.status === "ok" ? replay.nextCursor : replay.cursor;
    const subscribed = replay.status === "ok" && !replay.hasMore;

    const unsubscribe = (): void => {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };

    const notify = (observation: DaemonRunObservation): void => {
      try {
        listener(observation);
      } catch {
        // A presentation observer never owns the durable observation stream.
      }
    };

    const schedule = (delay: number): void => {
      if (stopped || !subscribed) return;
      timer = setTimeout(() => {
        timer = undefined;
        void pump();
      }, delay);
      timer.unref?.();
    };

    const pump = async (): Promise<void> => {
      if (stopped || !subscribed) return;
      try {
        const page = await this.replay({
          runId: normalized.runId,
          cursor,
          limit: normalized.limit,
          ...(sourceGeneration === undefined ? {} : { generation: sourceGeneration }),
        });
        if (stopped) return;
        if (page.status === "resync_required") {
          notify({ type: "resync_required", result: page });
          unsubscribe();
          return;
        }
        for (const event of page.events) {
          if (stopped) return;
          cursor = encodeDaemonObserverCursor(event.globalOffset);
          notify({ type: "event", runId: normalized.runId, cursor, event });
        }
        cursor = page.nextCursor;
        schedule(page.hasMore ? 0 : this.pollIntervalMs);
      } catch (error: unknown) {
        notify({
          type: "source_error",
          runId: normalized.runId,
          cursor,
          error: error instanceof Error ? error.message : String(error),
        });
        unsubscribe();
      }
    };

    if (subscribed) schedule(this.pollIntervalMs);
    return { replay, subscribed, unsubscribe };
  }
}

export interface FileDaemonRunEventSourceOptions {
  /** Root containing `<dataDir>/runs/<runId>/ledger.jsonl`. */
  readonly dataDir: string;
}

/**
 * Read committed JSONL records without acquiring the Ledger writer lock.
 * A partial trailing record is intentionally invisible until its newline is
 * present, matching JsonlLedger recovery semantics.
 */
export class FileDaemonRunEventSource implements DaemonRunEventSource {
  private readonly dataDir: string;
  private readonly states = new Map<string, FileTailState>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(options: FileDaemonRunEventSourceOptions) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new DaemonRunObserverProtocolError("file source options must be an object");
    }
    if (
      typeof options.dataDir !== "string"
      || options.dataDir.trim().length === 0
      || options.dataDir.includes("\0")
    ) {
      throw new DaemonRunObserverProtocolError("dataDir must be a non-empty path without NUL");
    }
    this.dataDir = resolve(options.dataDir);
  }

  async read(runId: string): Promise<DaemonRunEventSnapshot> {
    const safeRunId = requiredIdentifier(runId, "runId");
    assertPathSafeRunId(safeRunId);
    return this.withTail(safeRunId, (state) => fileTailSnapshot(safeRunId, state, true));
  }

  async readReplay(
    request: DaemonRunReplayRequest,
    maxReplayBytes: number,
  ): Promise<DaemonRunReplayResult> {
    const normalized = replayRequest(request);
    assertPathSafeRunId(normalized.runId);
    return this.withTail(normalized.runId, (state) => projectDaemonRunReplay(
      fileTailSnapshot(normalized.runId, state, false),
      normalized,
      maxReplayBytes,
    ));
  }

  private async withTail<T>(
    safeRunId: string,
    project: (state: FileTailState) => T,
  ): Promise<T> {
    const prior = this.tails.get(safeRunId) ?? Promise.resolve();
    const operation = prior.then(
      async () => project(await this.readTail(safeRunId)),
      async () => project(await this.readTail(safeRunId)),
    );
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(safeRunId, tail);
    void tail.finally(() => {
      if (this.tails.get(safeRunId) === tail) this.tails.delete(safeRunId);
    });
    return operation;
  }

  private async readTail(safeRunId: string): Promise<FileTailState> {
    const runsRoot = resolve(this.dataDir, "runs");
    const runPath = resolve(runsRoot, safeRunId);
    const ledgerPath = resolve(runPath, "ledger.jsonl");
    await assertNoSymlinkComponents(ledgerPath);
    await assertDirectory(runsRoot, "Run root");
    await assertDirectory(runPath, `Run ${safeRunId}`);
    const handle = await openNoFollow(ledgerPath, constants.O_RDONLY);
    try {
      await assertRegularFile(handle, ledgerPath, true);
      const info = await handle.stat();
      const previous = this.states.get(safeRunId);
      const identityMatches = previous !== undefined
        && previous.dev === info.dev
        && previous.ino === info.ino;
      const anchorMatches = identityMatches
        && info.size >= previous.physicalOffset
        && await fileAnchorMatches(handle, previous);

      const state = anchorMatches
        ? await appendFileTail(handle, info.size, previous, safeRunId)
        : await rebuildFileTail(handle, info.size, previous, safeRunId, info.dev, info.ino);
      this.states.set(safeRunId, state);
      return state;
    } finally {
      await handle.close();
    }
  }
}

interface FileTailState {
  readonly dev: number;
  readonly ino: number;
  readonly physicalOffset: number;
  readonly partial: Buffer;
  readonly events: AnyEvent[];
  readonly generation: number;
  readonly anchorOffset: number;
  readonly anchor: Buffer;
}

interface ValidatedFileSnapshot extends DaemonRunEventSnapshot {
  readonly [validatedFileSnapshot]: {
    readonly eventCount: number;
  };
}

async function appendFileTail(
  handle: FileHandle,
  size: number,
  previous: FileTailState,
  runId: string,
): Promise<FileTailState> {
  if (size === previous.physicalOffset) return previous;
  const appended = await readFileRange(handle, previous.physicalOffset, size - previous.physicalOffset);
  const combined = previous.partial.length === 0
    ? appended
    : Buffer.concat([previous.partial, appended]);
  const parsed = parseCompleteRecords(combined, runId, previous.events.length + 1);
  assertAppendedOffsets(previous.events.at(-1)?.globalOffset ?? 0, parsed.events, runId);
  const anchor = await readFileAnchor(handle, size);
  for (const event of parsed.events) previous.events.push(event);
  return {
    dev: previous.dev,
    ino: previous.ino,
    physicalOffset: size,
    partial: parsed.partial,
    events: previous.events,
    generation: previous.generation,
    anchorOffset: size - anchor.length,
    anchor,
  };
}

async function rebuildFileTail(
  handle: FileHandle,
  size: number,
  previous: FileTailState | undefined,
  runId: string,
  dev: number,
  ino: number,
): Promise<FileTailState> {
  const contents = await readFileRange(handle, 0, size);
  const parsed = parseCompleteRecords(contents, runId, 1);
  assertContiguousOffsets(parsed.events, runId);
  const destructive = previous !== undefined
    && !replacementContinuesHistory(previous.events, parsed.events);
  const anchor = contents.subarray(Math.max(0, contents.length - FILE_TAIL_ANCHOR_BYTES));
  return {
    dev,
    ino,
    physicalOffset: size,
    partial: parsed.partial,
    events: parsed.events,
    generation: destructive ? (previous?.generation ?? 0) + 1 : (previous?.generation ?? 0),
    anchorOffset: size - anchor.length,
    anchor: Buffer.from(anchor),
  };
}

function parseCompleteRecords(
  contents: Buffer,
  runId: string,
  firstLine: number,
): { readonly events: AnyEvent[]; readonly partial: Buffer } {
  const lastNewline = contents.lastIndexOf(0x0a);
  if (lastNewline < 0) return { events: [], partial: Buffer.from(contents) };
  const committed = contents.subarray(0, lastNewline).toString("utf8");
  const partial = Buffer.from(contents.subarray(lastNewline + 1));
  const lines = committed.length === 0 ? [] : committed.split("\n");
  const events = lines.map((line, index) => {
    const lineNumber = firstLine + index;
    if (line.trim().length === 0) {
      throw new DaemonRunObserverProtocolError(
        `Run ${runId} Ledger has an empty record at line ${lineNumber}`,
      );
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      throw new DaemonRunObserverProtocolError(
        `Run ${runId} Ledger has invalid JSON at line ${lineNumber}`,
      );
    }
    validateEvent(event);
    if (event.runId !== runId) {
      throw new DaemonRunObserverProtocolError(
        `Run ${runId} Ledger contains event for ${event.runId}`,
      );
    }
    return event;
  });
  return { events, partial };
}

function assertContiguousOffsets(events: readonly AnyEvent[], runId: string): void {
  let expected = events.at(0)?.globalOffset;
  for (const event of events) {
    if (event.globalOffset !== expected) {
      throw new DaemonRunObserverProtocolError(
        `Run ${runId} Ledger has an offset gap at ${event.globalOffset}`,
      );
    }
    expected = event.globalOffset + 1;
  }
}

function assertAppendedOffsets(
  previousWatermark: number,
  events: readonly AnyEvent[],
  runId: string,
): void {
  let expected = previousWatermark + 1;
  for (const event of events) {
    if (event.globalOffset !== expected) {
      throw new DaemonRunObserverProtocolError(
        `Run ${runId} Ledger has an offset gap at ${event.globalOffset}`,
      );
    }
    expected += 1;
  }
}

function replacementContinuesHistory(
  previous: readonly AnyEvent[],
  replacement: readonly AnyEvent[],
): boolean {
  const previousFirst = previous.at(0)?.globalOffset ?? 0;
  const previousLast = previous.at(-1)?.globalOffset ?? 0;
  const replacementFirst = replacement.at(0)?.globalOffset ?? 0;
  const replacementLast = replacement.at(-1)?.globalOffset ?? 0;
  if (previousLast === 0) return true;
  if (replacementLast < previousLast || replacementFirst > previousLast + 1) return false;
  if (replacementFirst === previousLast + 1) return true;

  const overlapStart = Math.max(previousFirst, replacementFirst);
  const overlapEnd = Math.min(previousLast, replacementLast);
  for (let offset = overlapStart; offset <= overlapEnd; offset += 1) {
    const before = previous[offset - previousFirst];
    const after = replacement[offset - replacementFirst];
    if (before?.contentHash !== after?.contentHash) return false;
  }
  return true;
}

function fileTailSnapshot(
  runId: string,
  state: FileTailState,
  stable: boolean,
): DaemonRunEventSnapshot {
  const watermark = state.events.at(-1)?.globalOffset ?? 0;
  const events = stable
    ? state.events.map((event) => structuredClone(event))
    : state.events;
  const firstOffset = events.at(0)?.globalOffset ?? (watermark === 0 ? 0 : watermark + 1);
  if (stable) return { runId, generation: state.generation, firstOffset, watermark, events };
  const snapshot: ValidatedFileSnapshot = {
    runId,
    generation: state.generation,
    firstOffset,
    watermark,
    events,
    [validatedFileSnapshot]: { eventCount: events.length },
  };
  return snapshot;
}

function assertPathSafeRunId(runId: string): void {
  if (runId === "." || runId === ".." || /[\\/]/u.test(runId)) {
    throw new DaemonRunObserverProtocolError("runId must be a path-safe identifier");
  }
}

async function fileAnchorMatches(handle: FileHandle, state: FileTailState): Promise<boolean> {
  if (state.anchor.length === 0) return true;
  const current = await readFileRange(handle, state.anchorOffset, state.anchor.length);
  return current.equals(state.anchor);
}

async function readFileAnchor(handle: FileHandle, size: number): Promise<Buffer> {
  const length = Math.min(FILE_TAIL_ANCHOR_BYTES, size);
  return readFileRange(handle, size - length, length);
}

async function readFileRange(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  if (length === 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(buffer, read, length - read, position + read);
    if (result.bytesRead === 0) {
      throw new DaemonRunObserverProtocolError("Run Ledger changed while it was being read");
    }
    read += result.bytesRead;
  }
  return buffer;
}

export function decodeDaemonObserverCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (typeof cursor !== "string") {
    throw new DaemonRunObserverProtocolError("cursor must use offset:<integer> format");
  }
  const match = /^offset:(0|[1-9]\d*)$/u.exec(cursor);
  if (match === null) {
    throw new DaemonRunObserverProtocolError(
      "cursor must be canonical offset:<integer> without leading zeroes",
    );
  }
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new DaemonRunObserverProtocolError("cursor offset must be a non-negative safe integer");
  }
  return offset;
}

export function encodeDaemonObserverCursor(offset: number): DaemonObserverCursor {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new DaemonRunObserverProtocolError("cursor offset must be a non-negative safe integer");
  }
  return `offset:${offset}`;
}

export function projectDaemonRunReplay(
  snapshot: DaemonRunEventSnapshot,
  request: DaemonRunReplayRequest,
  maxReplayBytes = DEFAULT_REPLAY_BYTES,
): DaemonRunReplayResult {
  const normalized = replayRequest(request);
  const boundedReplayBytes = boundedInteger(
    maxReplayBytes,
    "maxReplayBytes",
    1_024,
    1024 * 1024,
  );
  const cursorOffset = decodeDaemonObserverCursor(normalized.cursor);
  const cursor = encodeDaemonObserverCursor(cursorOffset);
  const checked = checkedSnapshot(snapshot, normalized.runId);
  const replayWatermark = normalized.upperWatermark ?? checked.watermark;
  const resync = (reason: DaemonRunResyncReason): DaemonRunResyncRequired => ({
    status: "resync_required",
    runId: normalized.runId,
    cursor,
    firstOffset: checked.firstOffset,
    watermark: checked.watermark,
    ...(checked.generation === undefined ? {} : { generation: checked.generation }),
    reason,
  });

  if (checked.offsetGap) return resync("offset-gap");
  if (cursorOffset > checked.watermark) return resync("cursor-ahead");
  if (replayWatermark > checked.watermark) return resync("history-truncated");
  if (
    normalized.generation !== undefined
    && checked.generation === undefined
  ) {
    throw new DaemonRunObserverProtocolError(
      "generation cannot be used with a source that does not expose one",
    );
  }
  if (
    normalized.generation !== undefined
    && normalized.generation !== checked.generation
  ) {
    return resync("history-truncated");
  }
  if (
    normalized.generation === undefined
    && cursorOffset > 0
    && (checked.generation ?? 0) > 0
  ) {
    return resync("history-truncated");
  }
  if (replayWatermark === 0) {
    return {
      status: "ok",
      runId: normalized.runId,
      cursor,
      nextCursor: cursor,
      watermark: 0,
      ...(checked.generation === undefined ? {} : { generation: checked.generation }),
      hasMore: false,
      events: [],
    };
  }
  if (cursorOffset < checked.firstOffset - 1) return resync("history-truncated");
  if (checked.eventCount === 0 || cursorOffset === replayWatermark) {
    return {
      status: "ok",
      runId: normalized.runId,
      cursor,
      nextCursor: cursor,
      watermark: replayWatermark,
      ...(checked.generation === undefined ? {} : { generation: checked.generation }),
      hasMore: false,
      events: [],
    };
  }

  const selected: AnyEvent[] = [];
  let bytes = 0;
  const firstSelectedOffset = Math.max(cursorOffset + 1, checked.firstOffset);
  const finalSelectedOffset = Math.min(replayWatermark, checked.watermark);
  const startIndex = Math.max(0, firstSelectedOffset - checked.firstOffset);
  const endIndex = Math.min(
    checked.eventCount,
    Math.max(startIndex, finalSelectedOffset - checked.firstOffset + 1),
  );
  for (let index = startIndex; index < endIndex; index += 1) {
    if (selected.length >= normalized.limit) break;
    const event = checked.events[index]!;
    const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    if (eventBytes > boundedReplayBytes) {
      throw new DaemonRunObserverProtocolError(
        `event at offset ${event.globalOffset} exceeds the replay byte limit`,
      );
    }
    if (selected.length > 0 && bytes + eventBytes > boundedReplayBytes) break;
    selected.push(structuredClone(event));
    bytes += eventBytes;
  }
  const nextOffset = selected.at(-1)?.globalOffset ?? cursorOffset;
  return {
    status: "ok",
    runId: normalized.runId,
    cursor,
    nextCursor: encodeDaemonObserverCursor(nextOffset),
    watermark: replayWatermark,
    ...(checked.generation === undefined ? {} : { generation: checked.generation }),
    hasMore: nextOffset < replayWatermark,
    events: selected,
  };
}

interface NormalizedReplayRequest {
  readonly runId: string;
  readonly cursor: DaemonObserverCursor;
  readonly limit: number;
  readonly upperWatermark?: number;
  readonly generation?: number;
}

function replayRequest(
  request: DaemonRunReplayRequest,
): NormalizedReplayRequest {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new DaemonRunObserverProtocolError("replay request must be an object");
  }
  const runId = requiredIdentifier(request.runId, "runId");
  const cursor = encodeDaemonObserverCursor(decodeDaemonObserverCursor(request.cursor));
  const cursorOffset = decodeDaemonObserverCursor(cursor);
  const limit = boundedInteger(request.limit ?? DEFAULT_REPLAY_LIMIT, "limit", 1, MAX_REPLAY_LIMIT);
  const upperWatermark = request.upperWatermark === undefined
    ? undefined
    : boundedInteger(request.upperWatermark, "upperWatermark", 0, Number.MAX_SAFE_INTEGER);
  const generation = request.generation === undefined
    ? undefined
    : boundedInteger(request.generation, "generation", 0, Number.MAX_SAFE_INTEGER);
  if (upperWatermark !== undefined && upperWatermark < cursorOffset) {
    throw new DaemonRunObserverProtocolError(
      "upperWatermark must be greater than or equal to the cursor offset",
    );
  }
  return {
    runId,
    cursor,
    limit,
    ...(upperWatermark === undefined ? {} : { upperWatermark }),
    ...(generation === undefined ? {} : { generation }),
  };
}

interface CheckedSnapshot extends DaemonRunEventSnapshot {
  readonly eventCount: number;
  readonly offsetGap: boolean;
}

function checkedSnapshot(
  snapshot: DaemonRunEventSnapshot,
  runId: string,
): CheckedSnapshot {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new DaemonRunObserverProtocolError("event source returned an invalid snapshot");
  }
  if (snapshot.runId !== runId) {
    throw new DaemonRunObserverProtocolError("event source returned another Run");
  }
  for (const [field, value] of [
    ["firstOffset", snapshot.firstOffset],
    ["watermark", snapshot.watermark],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new DaemonRunObserverProtocolError(`${field} must be a non-negative safe integer`);
    }
  }
  if (!Array.isArray(snapshot.events)) {
    throw new DaemonRunObserverProtocolError("event source snapshot events must be an array");
  }
  if (
    snapshot.generation !== undefined
    && (!Number.isSafeInteger(snapshot.generation) || snapshot.generation < 0)
  ) {
    throw new DaemonRunObserverProtocolError(
      "event source snapshot generation must be a non-negative safe integer",
    );
  }
  const trusted = (snapshot as Partial<ValidatedFileSnapshot>)[validatedFileSnapshot];
  const eventCount = trusted?.eventCount ?? snapshot.events.length;
  if (!Number.isSafeInteger(eventCount) || eventCount < 0 || eventCount > snapshot.events.length) {
    throw new DaemonRunObserverProtocolError("event source snapshot event count is invalid");
  }
  let offsetGap = false;
  if (trusted === undefined) {
    for (let index = 0; index < eventCount; index += 1) {
      const event = snapshot.events[index]!;
      validateEvent(event);
      if (event.runId !== runId) {
        throw new DaemonRunObserverProtocolError("event source returned another Run's event");
      }
      if (event.globalOffset !== snapshot.firstOffset + index) offsetGap = true;
    }
  }
  if (
    eventCount === 0
    && snapshot.firstOffset !== (snapshot.watermark === 0 ? 0 : snapshot.watermark + 1)
  ) {
    throw new DaemonRunObserverProtocolError(
      "an empty snapshot firstOffset must be zero or watermark + 1",
    );
  }
  if (
    eventCount > 0
    && snapshot.events[0]?.globalOffset !== snapshot.firstOffset
  ) {
    throw new DaemonRunObserverProtocolError("snapshot firstOffset does not match its first event");
  }
  if (
    eventCount > 0
    && snapshot.events[eventCount - 1]?.globalOffset !== snapshot.watermark
  ) {
    offsetGap = true;
  }
  return { ...snapshot, eventCount, offsetGap };
}

function requiredIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.includes("\0")
  ) {
    throw new DaemonRunObserverProtocolError(
      `${field} must be a non-empty, trimmed string without NUL`,
    );
  }
  return value;
}

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new DaemonRunObserverProtocolError(
      `${field} must be a safe integer between ${minimum} and ${maximum}`,
    );
  }
  return value as number;
}

async function assertDirectory(path: string, name: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new DaemonRunObserverProtocolError(`${name} must be a regular directory`);
  }
}
