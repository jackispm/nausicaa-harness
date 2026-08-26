import { randomUUID } from "node:crypto";

import type {
  AnyEvent,
  EventEnvelope,
  EventPayloadMap,
  EventType,
} from "../domain/events.js";
import type { Clock } from "../domain/ports.js";
import { systemClock } from "../domain/ports.js";
import type { ArtifactRef, LaneId, RunId } from "../domain/types.js";
import { assertArtifactRef } from "../store/store.js";
import { cloneJson, sha256, stableJson } from "../ledger/hash.js";
import {
  IdempotencyConflictError,
  type Ledger,
} from "../ledger/index.js";
import type {
  FukaiArtifactRead,
  FukaiReadOptions,
  FukaiSource,
} from "./types.js";
import { projectFukai } from "./projection.js";

/** Fukai is intentionally bounded even when a caller supplies a valid integer. */
const MAX_QUERY_ID_LENGTH = 256;
const MAX_REASON_LENGTH = 1_024;
const MAX_FILTER_ARRAY_ITEMS = 128;
const MAX_FILTER_ITEM_LENGTH = 512;
const MAX_STATE_REFS = 128;
const MAX_LEDGER_SCAN_EVENTS = 100_000;
const MAX_PAYLOAD_SCAN_DEPTH = 32;
const MAX_PAYLOAD_SCAN_NODES = 4_096;
const MAX_QUERY_EVENTS = 100_000;
const MAX_QUERY_BYTES = 64 * 1024 * 1024;
const MAX_QUERY_TOKENS = 16 * 1024 * 1024;
const MAX_QUERY_WALL_CLOCK_MS = 5 * 60 * 1_000;

/** Checkpoint monotonicity belongs to the durable Ledger, not a Core instance. */
const checkpointLocksByLedger = new WeakMap<Ledger, Map<string, Promise<void>>>();

export type FukaiQueryStatus =
  | "ok"
  | "truncated"
  | "denied"
  | "not-found"
  | "stale";

export interface FukaiEventFilters {
  /** Match a durable event reference: either eventId or event contentHash. */
  eventRefs?: readonly string[];
  /** Compatibility alias for callers that only retain event IDs. */
  eventIds?: readonly string[];
  types?: readonly EventType[];
  laneIds?: readonly LaneId[];
  causationIds?: readonly string[];
  correlationIds?: readonly string[];
}

export interface FukaiQueryBudget {
  maxEvents: number;
  maxBytes: number;
  maxTokens: number;
  maxWallClockMs: number;
}

export interface FukaiEventsQuery {
  queryId?: string;
  runId: RunId;
  laneId: LaneId;
  reason: string;
  cursor?: string;
  upperWatermark: number;
  filters?: FukaiEventFilters;
  budget: FukaiQueryBudget;
  signal?: AbortSignal;
}

/** An event crossing the Fukai boundary retains metadata and an authorized payload. */
export interface FukaiEventEvidence {
  eventId: string;
  globalOffset: number;
  laneSeq: number;
  laneId: LaneId;
  type: EventType;
  occurredAt: string;
  causationId?: string;
  correlationId: string;
  visibility: AnyEvent["visibility"];
  contentHash: string;
  payload: Record<string, unknown>;
}

export interface FukaiEventsResult {
  queryId: string;
  cursor: string;
  nextCursor: string;
  upperWatermark: number;
  status: FukaiQueryStatus;
  truncated: boolean;
  events: FukaiEventEvidence[];
  evidenceRefs: string[];
  resultHash: string;
  deniedCount: number;
  usage: {
    events: number;
    bytes: number;
    tokens: number;
    wallClockMs: number;
  };
}

export interface FukaiArtifactQuery {
  queryId?: string;
  runId: RunId;
  laneId: LaneId;
  reason: string;
  ref: ArtifactRef;
  range: { offset: number; length: number };
  upperWatermark: number;
  budget: {
    maxBytes: number;
    maxTokens: number;
    maxWallClockMs: number;
  };
  signal?: AbortSignal;
}

export interface FukaiArtifactResult {
  queryId: string;
  ref: ArtifactRef;
  requestedRange: { offset: number; length: number };
  status: FukaiQueryStatus;
  truncated: boolean;
  content: string;
  contentHash?: string;
  byteLength?: number;
  evidenceRefs: string[];
  resultHash: string;
  usage: {
    events: number;
    bytes: number;
    tokens: number;
    wallClockMs: number;
  };
}

export interface FukaiCheckpointRequest {
  runId: RunId;
  laneId: LaneId;
  cursor: string;
  upperWatermark: number;
  goalVersion: number;
  stateRefs: readonly ArtifactRef[];
  policyVersion: string;
  stateHash?: string;
  signal?: AbortSignal;
}

export interface FukaiCheckpointReadRequest {
  runId: RunId;
  laneId: LaneId;
  goalVersion: number;
  policyVersion: string;
  signal?: AbortSignal;
}

export interface FukaiCheckpointView {
  status: "ready" | "stale" | "not-found";
  reasons: string[];
  dependenciesVerified: boolean;
  checkpoint?: EventEnvelope<"fukai.checkpoint.committed">;
}

type FukaiQueryAuditEvent = EventEnvelope<"fukai.query.audit">;

export class FukaiCoreError extends Error {
  override readonly name: string = "FukaiCoreError";
}

export class FukaiStaleError extends FukaiCoreError {
  override readonly name: string = "FukaiStaleError";
}

export class FukaiTimeoutError extends FukaiCoreError {
  override readonly name: string = "FukaiTimeoutError";
}

/**
 * The bounded Fukai capability. It queries the Ledger/Store, never exposes
 * either dependency to a model, and records each successful boundary call.
 */
export class FukaiCore {
  /**
   * Query retries are serialized per durable query identity. This is a
   * process-local admission guard; the Ledger remains the durable arbiter.
   */
  private readonly queryTails = new Map<string, Promise<void>>();
  constructor(
    private readonly ledger: Ledger,
    private readonly source: FukaiSource,
    private readonly clock: Clock = systemClock,
  ) {}

  async queryEvents(request: FukaiEventsQuery): Promise<FukaiEventsResult> {
    validateEventsQuery(request);
    throwIfAborted(request.signal);
    const queryId = request.queryId ?? randomUUID();
    return this.withQueryLock(request.runId, queryId, request.signal, () => (
      this.queryEventsInternal(request, queryId)
    ));
  }

  private async queryEventsInternal(
    request: FukaiEventsQuery,
    queryId: string,
  ): Promise<FukaiEventsResult> {
    const filters = normalizeFilters(request.filters);
    const cursorOffset = decodeCursor(request.cursor);
    const cursor = encodeCursor(cursorOffset);
    const startedAt = Date.now();
    const deadlineAt = startedAt + request.budget.maxWallClockMs;
    const budget = request.budget;
    const filterHash = sha256(stableJson(filters));
    const requestFingerprint = queryRequestFingerprint("events", request, filterHash);

    let status: FukaiQueryStatus = "ok";
    let truncated = false;
    let deniedCount = 0;
    let events: FukaiEventEvidence[] = [];
    let preflightTimedOut = false;
    let existingAudit: FukaiQueryAuditEvent | undefined;
    let currentWatermark = 0;
    let checkpoint: EventEnvelope<"fukai.checkpoint.committed"> | undefined;
    try {
      existingAudit = await withDeadline(
        this.findQueryAudit(request.runId, queryId),
        remainingMs(deadlineAt),
        request.signal,
      );
      if (existingAudit !== undefined) {
        if (queryAuditFingerprint(existingAudit) !== requestFingerprint) {
          throw queryIdConflict(queryId);
        }
      }
      currentWatermark = await withDeadline(
        this.ledger.watermark(),
        remainingMs(deadlineAt),
        request.signal,
      );
      checkpoint = (await withDeadline(
        selectCheckpoint(this.ledger, request.runId, request.laneId, request.upperWatermark),
        remainingMs(deadlineAt),
        request.signal,
      )).checkpoint;
    } catch (error: unknown) {
      if (!(error instanceof FukaiTimeoutError)) {
        throw error;
      }
      preflightTimedOut = true;
      status = "truncated";
      truncated = true;
    }

    const committedCursor = checkpoint === undefined
      ? 0
      : decodeCursor(checkpoint.payload.cursor);
    if (!preflightTimedOut && (
      currentWatermark < request.upperWatermark
      || cursorOffset > request.upperWatermark
      || cursorOffset < committedCursor
      || (
        checkpoint !== undefined
        && request.upperWatermark < checkpoint.payload.upperWatermark
      )
    )) {
      status = "stale";
    } else if (!preflightTimedOut && budget.maxEvents > 0 && budget.maxBytes > 0 && budget.maxTokens > 0) {
      try {
        const candidates = await withDeadline(
          readLedgerBounded(this.ledger, { runId: request.runId, afterOffset: cursorOffset }),
          remainingMs(deadlineAt),
          request.signal,
        );
        ensureDeadline(deadlineAt, request.signal);
        const matching = candidates
          .filter((event) => event.globalOffset <= request.upperWatermark)
          .filter((event) => matchesFilters(event, filters));
        const visible: AnyEvent[] = [];
        for (const event of matching) {
          ensureDeadline(deadlineAt, request.signal);
          const allowed = canReadEvent(event, request.laneId);
          if (!allowed) {
            deniedCount += 1;
          } else {
            visible.push(event);
          }
        }
        if (visible.length === 0) {
          status = matching.length > 0 ? "denied" : "not-found";
        }

        let usedBytes = 0;
        let usedTokens = 0;
        for (const event of visible) {
          ensureDeadline(deadlineAt, request.signal);
          if (events.length >= budget.maxEvents) {
            truncated = true;
            break;
          }
          const evidence = eventEvidence(event);
          const bytes = byteLength(evidence);
          const tokens = estimateTokens(evidence);
          if (usedBytes + bytes > budget.maxBytes || usedTokens + tokens > budget.maxTokens) {
            truncated = true;
            break;
          }
          events.push(evidence);
          usedBytes += bytes;
          usedTokens += tokens;
        }
        if (events.length < visible.length) {
          truncated = true;
        }
        if (truncated) {
          status = "truncated";
        }
      } catch (error: unknown) {
        if (!(error instanceof FukaiTimeoutError)) {
          throw error;
        }
        truncated = true;
        status = "truncated";
      }
    } else {
      truncated = true;
      status = "truncated";
    }

    if (Date.now() >= deadlineAt && status === "ok") {
      status = "truncated";
      truncated = true;
    }

    // A stale snapshot is not a consumable page. Keep its cursor pinned so a
    // caller cannot skip events merely because the requested watermark aged.
    const nextOffset = status === "stale"
      ? cursorOffset
      : truncated
      ? events.at(-1)?.globalOffset ?? cursorOffset
      : request.upperWatermark;
    const nextCursor = encodeCursor(nextOffset);
    const evidenceRefs = events.map((event) => event.contentHash);
    const resultHash = sha256(stableJson(events));
    const elapsed = Date.now() - startedAt;
    const usedBytes = events.reduce((sum, event) => sum + byteLength(event), 0);
    const usedTokens = events.reduce((sum, event) => sum + estimateTokens(event), 0);
    const result: FukaiEventsResult = {
      queryId,
      cursor,
      nextCursor,
      upperWatermark: request.upperWatermark,
      status,
      truncated,
      events,
      evidenceRefs,
      resultHash,
      deniedCount,
      usage: {
        events: events.length,
        bytes: usedBytes,
        tokens: usedTokens,
        wallClockMs: elapsed,
      },
    };
    if (Date.now() < deadlineAt) {
      try {
        await withDeadline(this.appendQueryAudit("events", request, result, {
          filterHash,
          budget: {
            maxEvents: budget.maxEvents,
            maxBytes: budget.maxBytes,
            maxTokens: budget.maxTokens,
            maxWallClockMs: budget.maxWallClockMs,
          },
        }), remainingMs(deadlineAt), request.signal);
      } catch (error: unknown) {
        if (!(error instanceof FukaiTimeoutError)) {
          throw error;
        }
        // Ledger append has no cancellation contract. The caller still gets a
        // bounded result; the append may finish in the background.
        result.status = "truncated";
        result.truncated = true;
      }
    }
    return result;
  }

  async readArtifact(request: FukaiArtifactQuery): Promise<FukaiArtifactResult> {
    validateArtifactQuery(request);
    throwIfAborted(request.signal);
    const queryId = request.queryId ?? randomUUID();
    return this.withQueryLock(request.runId, queryId, request.signal, () => (
      this.readArtifactInternal(request, queryId)
    ));
  }

  private async readArtifactInternal(
    request: FukaiArtifactQuery,
    queryId: string,
  ): Promise<FukaiArtifactResult> {
    const requestedRange = { ...request.range };
    const startedAt = Date.now();
    const deadlineAt = startedAt + request.budget.maxWallClockMs;
    let status: FukaiQueryStatus = "ok";
    let truncated = false;
    let read: FukaiArtifactRead | undefined;
    const filterHash = sha256(stableJson({ ref: request.ref, range: requestedRange }));
    const requestFingerprint = queryRequestFingerprint("artifact", request, filterHash);

    let preflightTimedOut = false;
    let currentWatermark = 0;
    let checkpoint: EventEnvelope<"fukai.checkpoint.committed"> | undefined;
    try {
      const existingAudit = await withDeadline(
        this.findQueryAudit(request.runId, queryId),
        remainingMs(deadlineAt),
        request.signal,
      );
      if (existingAudit !== undefined) {
        if (queryAuditFingerprint(existingAudit) !== requestFingerprint) {
          throw queryIdConflict(queryId);
        }
        // The durable audit is the idempotency authority. The read is repeated
        // only to reconstruct a response; content-addressed refs keep it stable.
      }
      currentWatermark = await withDeadline(
        this.ledger.watermark(),
        remainingMs(deadlineAt),
        request.signal,
      );
      checkpoint = (await withDeadline(
        selectCheckpoint(this.ledger, request.runId, request.laneId, request.upperWatermark),
        remainingMs(deadlineAt),
        request.signal,
      )).checkpoint;
    } catch (error: unknown) {
      if (!(error instanceof FukaiTimeoutError)) {
        throw error;
      }
      preflightTimedOut = true;
      status = "truncated";
      truncated = true;
    }

    if (!preflightTimedOut && (
      currentWatermark < request.upperWatermark
      || (checkpoint !== undefined && request.upperWatermark < checkpoint.payload.upperWatermark)
    )) {
      status = "stale";
    } else if (!preflightTimedOut && request.budget.maxBytes > 0 && request.budget.maxTokens > 0) {
      const boundedRange = {
        offset: request.range.offset,
        length: Math.min(request.range.length, request.budget.maxBytes),
      };
      try {
        const authorized = await withDeadline(
          this.isArtifactAuthorized(request),
          remainingMs(deadlineAt),
          request.signal,
        );
        if (authorized === "denied") {
          status = "denied";
        } else if (authorized === "not-found") {
          status = "not-found";
        } else {
          read = await withDeadline(
            this.source.readArtifact(request.ref, boundedRange, signalOptions(request.signal)),
            remainingMs(deadlineAt),
            request.signal,
          );
        }
      } catch (error: unknown) {
        if (!(error instanceof FukaiTimeoutError)) {
          throw error;
        }
        truncated = true;
        status = "truncated";
      }
      if (read === undefined && status === "ok") {
        status = "not-found";
      }
      if (read !== undefined) {
        if (read.contentHash !== request.ref.contentHash) {
          throw new FukaiCoreError(`Artifact hash mismatch for ${request.ref.id}`);
        }
        if (boundedRange.length < request.range.length) {
          truncated = true;
        }
      }
    } else {
      truncated = true;
      status = "truncated";
    }

    let content = read?.content ?? "";
    if (Date.now() >= deadlineAt && status === "ok") {
      status = "truncated";
      truncated = true;
    }
    if (read !== undefined && estimateTokens(content) > request.budget.maxTokens) {
      content = truncateUtf8(content, request.budget.maxTokens * 4);
      truncated = true;
    }
    if (truncated && status === "ok") {
      status = "truncated";
    }
    const evidenceRefs = read === undefined ? [] : [request.ref.id];
    const resultHash = sha256(stableJson({
      ref: request.ref.id,
      range: requestedRange,
      content,
      contentHash: read?.contentHash,
    }));
    const result: FukaiArtifactResult = {
      queryId,
      ref: cloneJson(request.ref),
      requestedRange,
      status,
      truncated,
      content,
      ...(read === undefined ? {} : {
        contentHash: read.contentHash,
        byteLength: read.byteLength,
      }),
      evidenceRefs,
      resultHash,
      usage: {
        events: read === undefined ? 0 : 1,
        bytes: Buffer.byteLength(content, "utf8"),
        tokens: estimateTokens(content),
        wallClockMs: Date.now() - startedAt,
      },
    };
    if (Date.now() < deadlineAt) {
      try {
        await withDeadline(this.appendQueryAudit("artifact", request, result, {
          filterHash,
          budget: {
            maxEvents: 1,
            maxBytes: request.budget.maxBytes,
            maxTokens: request.budget.maxTokens,
            maxWallClockMs: request.budget.maxWallClockMs,
          },
        }), remainingMs(deadlineAt), request.signal);
      } catch (error: unknown) {
        if (!(error instanceof FukaiTimeoutError)) {
          throw error;
        }
        result.status = "truncated";
        result.truncated = true;
      }
    }
    return result;
  }

  async readCheckpoint(
    request: FukaiCheckpointReadRequest,
  ): Promise<FukaiCheckpointView> {
    validateIdentity(request.runId, "runId");
    validateIdentity(request.laneId, "laneId");
    if (!Number.isSafeInteger(request.goalVersion) || request.goalVersion < 1) {
      throw new FukaiCoreError("Fukai checkpoint goalVersion must be a positive integer");
    }
    validateIdentity(request.policyVersion, "policyVersion");
    throwIfAborted(request.signal);
    const currentWatermark = await this.ledger.watermark();
    const selection = await selectCheckpoint(this.ledger, request.runId, request.laneId);
    const checkpoint = selection.checkpoint;
    if (checkpoint === undefined) {
      if (selection.fallbackReasons.length > 0) {
        return {
          status: "stale",
          reasons: selection.fallbackReasons,
          dependenciesVerified: false,
        };
      }
      return {
        status: "not-found",
        reasons: [],
        dependenciesVerified: true,
      };
    }

    const reasons: string[] = [...selection.fallbackReasons];
    if (checkpoint.payload.upperWatermark > currentWatermark) {
      reasons.push(
        `checkpoint-future-watermark:${checkpoint.payload.upperWatermark}:${currentWatermark}`,
      );
    }
    if (checkpoint.payload.goalVersion !== request.goalVersion) {
      reasons.push("goal-version-changed");
    }
    if (checkpoint.payload.policyVersion !== request.policyVersion) {
      reasons.push("policy-version-changed");
    }
    const dependencyEvents = await readLedgerBounded(this.ledger, { runId: request.runId });
    const dependencyWatermark = Math.min(
      checkpoint.payload.upperWatermark,
      currentWatermark,
    );
    for (const ref of checkpoint.payload.stateRefs) {
      throwIfAborted(request.signal);
      if (!hasVisibleArtifactReference(
        dependencyEvents,
        request.laneId,
        dependencyWatermark,
        ref,
      )) {
        reasons.push(`missing-state-ref-reference:${ref.id}`);
      }
      if (!await this.source.hasArtifact(ref, signalOptions(request.signal))) {
        reasons.push(`missing-state-ref:${ref.id}`);
      }
    }
    return {
      status: reasons.length === 0 ? "ready" : "stale",
      reasons,
      dependenciesVerified: true,
      checkpoint: cloneJson(checkpoint),
    };
  }

  async commitCheckpoint(
    request: FukaiCheckpointRequest,
  ): Promise<EventEnvelope<"fukai.checkpoint.committed">> {
    validateCheckpointRequest(request);
    throwIfAborted(request.signal);
    return this.withCheckpointLock(request.runId, request.laneId, request.signal, () => (
      this.commitCheckpointInternal(request)
    ));
  }

  private async commitCheckpointInternal(
    request: FukaiCheckpointRequest,
  ): Promise<EventEnvelope<"fukai.checkpoint.committed">> {
    throwIfAborted(request.signal);
    const cursorOffset = decodeCursor(request.cursor);
    const currentWatermark = await this.ledger.watermark();
    if (request.upperWatermark > currentWatermark) {
      throw new FukaiStaleError(
        `Checkpoint watermark ${request.upperWatermark} is ahead of Ledger ${currentWatermark}`,
      );
    }

    const { checkpoint: previous } = await selectCheckpoint(
      this.ledger,
      request.runId,
      request.laneId,
    );
    if (previous !== undefined) {
      const previousOffset = decodeCursor(previous.payload.cursor);
      if (cursorOffset < previousOffset || request.upperWatermark < previous.payload.upperWatermark) {
        throw new FukaiStaleError("Fukai checkpoint cursor and watermark must be monotonic");
      }
    }

    const preExistingEvents = await readLedgerBounded(this.ledger, { runId: request.runId });
    const stateRefs = canonicalArtifactRefs(request.stateRefs);
    for (const ref of stateRefs) {
      throwIfAborted(request.signal);
      if (!hasVisibleArtifactReference(preExistingEvents, request.laneId, request.upperWatermark, ref)) {
        throw new FukaiStaleError(
          `Fukai checkpoint state ref has no pre-existing visible reference: ${ref.id}`,
        );
      }
      if (!await this.source.hasArtifact(ref, signalOptions(request.signal))) {
        throw new FukaiStaleError(`Fukai checkpoint state ref is missing: ${ref.id}`);
      }
    }
    const stateHash = checkpointStateHash({
      cursor: encodeCursor(cursorOffset),
      upperWatermark: request.upperWatermark,
      goalVersion: request.goalVersion,
      stateRefs,
      policyVersion: request.policyVersion,
    });
    if (request.stateHash !== undefined && request.stateHash !== stateHash) {
      throw new FukaiCoreError("Fukai checkpoint stateHash does not match checkpoint state");
    }
    return this.ledger.append({
      runId: request.runId,
      laneId: request.laneId,
      type: "fukai.checkpoint.committed",
      payload: {
        cursor: encodeCursor(cursorOffset),
        upperWatermark: request.upperWatermark,
        goalVersion: request.goalVersion,
        stateRefs,
        stateHash,
        policyVersion: request.policyVersion,
      },
      correlationId: `fukai:checkpoint:${request.runId}:${request.laneId}`,
      idempotencyKey: `fukai:checkpoint:${request.laneId}:${encodeCursor(cursorOffset)}:${request.upperWatermark}`,
      visibility: "lane",
    });
  }

  private async withQueryLock<T>(
    runId: RunId,
    queryId: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    return withKeyedLock(this.queryTails, `${runId}\0${queryId}`, signal, operation);
  }

  private async withCheckpointLock<T>(
    runId: RunId,
    laneId: LaneId,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    let tails = checkpointLocksByLedger.get(this.ledger);
    if (tails === undefined) {
      tails = new Map<string, Promise<void>>();
      checkpointLocksByLedger.set(this.ledger, tails);
    }
    return withKeyedLock(tails, `${runId}\0${laneId}`, signal, operation);
  }

  private async findQueryAudit(
    runId: RunId,
    queryId: string,
  ): Promise<FukaiQueryAuditEvent | undefined> {
    return (await readLedgerBounded(this.ledger, { runId }))
      .filter((event): event is FukaiQueryAuditEvent => (
        event.type === "fukai.query.audit" && event.payload.queryId === queryId
      ))
      .at(-1);
  }

  private async isArtifactAuthorized(
    request: FukaiArtifactQuery,
  ): Promise<"allowed" | "denied" | "not-found"> {
    const events = (await readLedgerBounded(this.ledger, { runId: request.runId }))
      .filter((event) => event.globalOffset <= request.upperWatermark)
      .filter((event) => payloadReferencesArtifact(event.payload, request.ref));
    if (events.length === 0) {
      return "not-found";
    }
    return hasVisibleArtifactReference(events, request.laneId, request.upperWatermark, request.ref)
      ? "allowed"
      : "denied";
  }

  private async appendQueryAudit(
    operation: "events" | "artifact",
    request: FukaiEventsQuery | FukaiArtifactQuery,
    result: FukaiEventsResult | FukaiArtifactResult,
    details: {
      filterHash: string;
      budget: FukaiQueryBudget;
    },
  ): Promise<void> {
    const cursor = operation === "events"
      ? encodeCursor(decodeCursor((request as FukaiEventsQuery).cursor))
      : `artifact:${(request as FukaiArtifactQuery).range.offset}`;
    await this.ledger.append({
      runId: request.runId,
      laneId: request.laneId,
      type: "fukai.query.audit",
      payload: {
        queryId: result.queryId,
        operation,
        reason: request.reason,
        filterHash: details.filterHash,
        cursor,
        nextCursor: isEventsResult(result) ? result.nextCursor : cursor,
        upperWatermark: request.upperWatermark,
        status: result.status,
        budget: details.budget,
        usage: {
          events: result.usage.events,
          bytes: result.usage.bytes,
          tokens: result.usage.tokens,
        },
        returnedCount: result.evidenceRefs.length,
        deniedCount: "deniedCount" in result ? result.deniedCount : 0,
        evidenceRefs: result.evidenceRefs,
        resultHash: result.resultHash,
      },
      correlationId: `fukai:query:${request.runId}:${request.laneId}`,
      idempotencyKey: `fukai:query:${result.queryId}`,
      visibility: "lane",
      occurredAt: this.clock.now().toISOString(),
    });
  }
}

function isEventsResult(
  result: FukaiEventsResult | FukaiArtifactResult,
): result is FukaiEventsResult {
  return "nextCursor" in result;
}

function queryIdConflict(queryId: string): IdempotencyConflictError {
  return new IdempotencyConflictError(
    `Fukai queryId ${queryId} was reused with a different request`,
  );
}

function queryRequestFingerprint(
  operation: "events" | "artifact",
  request: FukaiEventsQuery | FukaiArtifactQuery,
  filterHash: string,
): string {
  const cursor = operation === "events"
    ? encodeCursor(decodeCursor((request as FukaiEventsQuery).cursor))
    : `artifact:${(request as FukaiArtifactQuery).range.offset}`;
  const budget = operation === "events"
    ? (request as FukaiEventsQuery).budget
    : {
        maxEvents: 1,
        maxBytes: (request as FukaiArtifactQuery).budget.maxBytes,
        maxTokens: (request as FukaiArtifactQuery).budget.maxTokens,
        maxWallClockMs: (request as FukaiArtifactQuery).budget.maxWallClockMs,
      };
  return sha256(stableJson({
    operation,
    runId: request.runId,
    laneId: request.laneId,
    reason: request.reason,
    filterHash,
    cursor,
    upperWatermark: request.upperWatermark,
    budget,
  }));
}

function queryAuditFingerprint(audit: FukaiQueryAuditEvent): string {
  return sha256(stableJson({
    operation: audit.payload.operation,
    runId: audit.runId,
    laneId: audit.laneId,
    reason: audit.payload.reason,
    filterHash: audit.payload.filterHash,
    cursor: audit.payload.cursor,
    upperWatermark: audit.payload.upperWatermark,
    budget: audit.payload.budget,
  }));
}

async function withKeyedLock<T>(
  tails: Map<string, Promise<void>>,
  key: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Keep a cancelled waiter chained behind its predecessor. Releasing its
  // gate early must not let a later caller overlap the operation ahead of it.
  const ownTurn = predecessor.then(() => gate, () => gate);
  tails.set(key, ownTurn);
  try {
    await waitForLock(predecessor, signal);
    throwIfAborted(signal);
    return await operation();
  } finally {
    release();
    void ownTurn.then(() => {
      if (tails.get(key) === ownTurn) {
        tails.delete(key);
      }
    });
  }
}

async function waitForLock(
  predecessor: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    await predecessor;
    return;
  }
  if (signal.aborted) {
    throwIfAborted(signal);
  }
  let abortListener: (() => void) | undefined;
  const abort = new Promise<never>((_, reject) => {
    abortListener = () => reject(abortReason(signal));
    signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    await Promise.race([predecessor, abort]);
  } finally {
    if (abortListener !== undefined) {
      signal.removeEventListener("abort", abortListener);
    }
    // A rejected abort branch must never become an unhandled rejection after
    // the predecessor wins the race.
    abort.catch(() => undefined);
  }
}

function validateEventsQuery(request: FukaiEventsQuery): void {
  validateIdentity(request.runId, "runId");
  validateIdentity(request.laneId, "laneId");
  validateReason(request.reason);
  validateWatermark(request.upperWatermark);
  validateBudget(request.budget);
  validateEventFilters(request.filters);
  decodeCursor(request.cursor);
  validateQueryId(request.queryId);
}

function validateArtifactQuery(request: FukaiArtifactQuery): void {
  validateIdentity(request.runId, "runId");
  validateIdentity(request.laneId, "laneId");
  validateReason(request.reason);
  validateWatermark(request.upperWatermark);
  validateQueryId(request.queryId);
  assertArtifactRef(request.ref);
  if (!Number.isSafeInteger(request.range.offset) || request.range.offset < 0) {
    throw new FukaiCoreError("Artifact offset must be a non-negative integer");
  }
  if (!Number.isSafeInteger(request.range.length) || request.range.length < 0) {
    throw new FukaiCoreError("Artifact length must be a non-negative integer");
  }
  validateBudget({
    maxEvents: 1,
    maxBytes: request.budget.maxBytes,
    maxTokens: request.budget.maxTokens,
    maxWallClockMs: request.budget.maxWallClockMs,
  });
}

function validateCheckpointRequest(request: FukaiCheckpointRequest): void {
  validateIdentity(request.runId, "runId");
  validateIdentity(request.laneId, "laneId");
  validateWatermark(request.upperWatermark);
  const cursor = decodeCursor(request.cursor);
  if (cursor > request.upperWatermark) {
    throw new FukaiStaleError("Fukai checkpoint cursor cannot exceed its watermark");
  }
  if (!Number.isSafeInteger(request.goalVersion) || request.goalVersion < 1) {
    throw new FukaiCoreError("Fukai checkpoint goalVersion must be a positive integer");
  }
  validateIdentity(request.policyVersion, "policyVersion");
  if (!Array.isArray(request.stateRefs)) {
    throw new FukaiCoreError("Fukai checkpoint stateRefs must be an array");
  }
  if (request.stateRefs.length > MAX_STATE_REFS) {
    throw new FukaiCoreError(`Fukai checkpoint stateRefs exceeds ${MAX_STATE_REFS}`);
  }
  for (const ref of request.stateRefs) {
    assertArtifactRef(ref);
  }
  if (request.stateHash !== undefined) {
    validateIdentity(request.stateHash, "stateHash");
  }
}

function validateBudget(budget: FukaiQueryBudget): void {
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new FukaiCoreError(`Fukai query budget ${name} must be a non-negative integer`);
    }
  }
  if (budget.maxWallClockMs < 1) {
    throw new FukaiCoreError("Fukai query maxWallClockMs must be positive");
  }
  if (budget.maxEvents > MAX_QUERY_EVENTS) {
    throw new FukaiCoreError(`Fukai query maxEvents exceeds ${MAX_QUERY_EVENTS}`);
  }
  if (budget.maxBytes > MAX_QUERY_BYTES) {
    throw new FukaiCoreError(`Fukai query maxBytes exceeds ${MAX_QUERY_BYTES}`);
  }
  if (budget.maxTokens > MAX_QUERY_TOKENS) {
    throw new FukaiCoreError(`Fukai query maxTokens exceeds ${MAX_QUERY_TOKENS}`);
  }
  if (budget.maxWallClockMs > MAX_QUERY_WALL_CLOCK_MS) {
    throw new FukaiCoreError(
      `Fukai query maxWallClockMs exceeds ${MAX_QUERY_WALL_CLOCK_MS}`,
    );
  }
}

function validateIdentity(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new FukaiCoreError(`Fukai ${field} must be non-empty and contain no NUL`);
  }
}

function validateBoundedIdentity(value: unknown, field: string, maxLength: number): void {
  if (typeof value !== "string") {
    throw new FukaiCoreError(`Fukai ${field} must be a string`);
  }
  validateIdentity(value, field);
  if (value.length > maxLength) {
    throw new FukaiCoreError(`Fukai ${field} exceeds ${maxLength} characters`);
  }
}

function validateReason(reason: string): void {
  validateBoundedIdentity(reason, "reason", MAX_REASON_LENGTH);
}

function validateQueryId(queryId: string | undefined): void {
  if (queryId !== undefined) {
    validateBoundedIdentity(queryId, "queryId", MAX_QUERY_ID_LENGTH);
  }
}

function validateWatermark(watermark: number): void {
  if (!Number.isSafeInteger(watermark) || watermark < 0) {
    throw new FukaiCoreError("Fukai upperWatermark must be a non-negative integer");
  }
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") {
    return 0;
  }
  const match = /^offset:(\d+)$/.exec(cursor);
  if (match === null) {
    throw new FukaiCoreError("Fukai cursor must use the offset:<integer> format");
  }
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new FukaiCoreError("Fukai cursor offset is invalid");
  }
  return value;
}

function encodeCursor(offset: number): string {
  return `offset:${offset}`;
}

function matchesFilters(event: AnyEvent, filters: FukaiEventFilters): boolean {
  return (
    filters.eventRefs === undefined
    || filters.eventRefs.includes(event.eventId)
    || filters.eventRefs.includes(event.contentHash)
  )
    && (filters.types === undefined || filters.types.includes(event.type))
    && (filters.laneIds === undefined || filters.laneIds.includes(event.laneId))
    && (filters.causationIds === undefined || filters.causationIds.includes(event.causationId ?? ""))
    && (filters.correlationIds === undefined || filters.correlationIds.includes(event.correlationId));
}

function normalizeFilters(filters: FukaiEventFilters | undefined): FukaiEventFilters {
  if (filters === undefined) {
    return {};
  }
  const eventRefs = uniqueSorted([...(filters.eventRefs ?? []), ...(filters.eventIds ?? [])]);
  return {
    ...(eventRefs.length === 0 ? {} : { eventRefs }),
    ...(filters.types === undefined ? {} : { types: uniqueSorted(filters.types) as EventType[] }),
    ...(filters.laneIds === undefined ? {} : { laneIds: uniqueSorted(filters.laneIds) as LaneId[] }),
    ...(filters.causationIds === undefined ? {} : { causationIds: uniqueSorted(filters.causationIds) }),
    ...(filters.correlationIds === undefined ? {} : { correlationIds: uniqueSorted(filters.correlationIds) }),
  };
}

function validateEventFilters(filters: FukaiEventFilters | undefined): void {
  if (filters === undefined) {
    return;
  }
  let totalItems = 0;
  for (const [name, values] of Object.entries(filters)) {
    if (values === undefined) {
      continue;
    }
    if (!Array.isArray(values)) {
      throw new FukaiCoreError(`Fukai event filter ${name} must be an array`);
    }
    if (values.length > MAX_FILTER_ARRAY_ITEMS) {
      throw new FukaiCoreError(
        `Fukai event filter ${name} exceeds ${MAX_FILTER_ARRAY_ITEMS} items`,
      );
    }
    totalItems += values.length;
    if (totalItems > MAX_FILTER_ARRAY_ITEMS) {
      throw new FukaiCoreError(
        `Fukai event filters exceed ${MAX_FILTER_ARRAY_ITEMS} total items`,
      );
    }
    for (const value of values) {
      validateBoundedIdentity(value, `filter ${name}`, MAX_FILTER_ITEM_LENGTH);
    }
  }
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function canonicalArtifactRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const byValue = new Map<string, ArtifactRef>();
  for (const ref of refs) {
    const cloned = cloneJson(ref);
    byValue.set(stableJson(cloned), cloned);
  }
  return [...byValue.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, ref]) => ref);
}

function canReadEvent(event: AnyEvent, laneId: LaneId): boolean {
  // laneId is a trusted runtime capability identity. Model-provided lane IDs
  // must be admitted by the runtime before reaching FukaiCore.
  return event.visibility !== "sensitive"
    && (
      event.visibility === "run"
      || event.visibility === "user"
      || event.laneId === laneId
    );
}

interface CheckpointSelection {
  checkpoint?: EventEnvelope<"fukai.checkpoint.committed">;
  fallbackReasons: string[];
}

/**
 * Ledger.read has no bounded-read API. Keep the residual allocation boundary
 * explicit so a Fukai scan never processes an unbounded result in memory.
 */
async function readLedgerBounded(
  ledger: Ledger,
  options: { runId?: string; afterOffset?: number },
): Promise<AnyEvent[]> {
  const events = await ledger.read(options);
  if (events.length > MAX_LEDGER_SCAN_EVENTS) {
    throw new FukaiCoreError(
      `Fukai Ledger scan exceeds ${MAX_LEDGER_SCAN_EVENTS} events`,
    );
  }
  return events;
}

async function selectCheckpoint(
  ledger: Ledger,
  runId: RunId,
  laneId: LaneId,
  atOrBeforeOffset?: number,
): Promise<CheckpointSelection> {
  const events = await readLedgerBounded(ledger, { runId });
  const projection = projectFukai(
    atOrBeforeOffset === undefined
      ? events
      : events.filter((event) => event.globalOffset <= atOrBeforeOffset),
    runId,
    laneId,
  );
  const checkpoint = projection.latestCheckpoint;
  const selectedOffset = checkpoint?.globalOffset ?? -1;
  const fallbackReasons = projection.invalidCheckpoints
    .filter(({ checkpoint: invalid }) => invalid.globalOffset > selectedOffset)
    .flatMap(({ checkpoint: invalid, reasons }) => reasons.map(
      (reason) => `checkpoint-fallback:${invalid.eventId}:${reason}`,
    ));
  return {
    ...(checkpoint === undefined ? {} : { checkpoint }),
    fallbackReasons,
  };
}

function checkpointStateHash(
  payload: EventPayloadMap["fukai.checkpoint.committed"]
    | Omit<EventPayloadMap["fukai.checkpoint.committed"], "stateHash">,
): string {
  const { stateHash: _stateHash, ...state } = payload as EventPayloadMap["fukai.checkpoint.committed"];
  return sha256(stableJson(state));
}

function payloadReferencesArtifact(value: unknown, ref: ArtifactRef): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (++nodes > MAX_PAYLOAD_SCAN_NODES || current.depth > MAX_PAYLOAD_SCAN_DEPTH) {
      // A malformed payload is not allowed to turn authorization into an
      // unbounded recursive walk. Treat an exhausted scan as no evidence.
      return false;
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        pending.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }
    if (current.value === null || typeof current.value !== "object") {
      continue;
    }
    const item = current.value as Record<string, unknown>;
    if (
      item.id === ref.id
      && item.contentHash === ref.contentHash
      && item.mediaType === ref.mediaType
      && item.byteLength === ref.byteLength
    ) {
      return true;
    }
    for (const child of Object.values(item)) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return false;
}

/**
 * Check an artifact's pre-existing visibility without allowing a Fukai
 * checkpoint to bootstrap access to its own state references.
 */
function hasVisibleArtifactReference(
  events: readonly AnyEvent[],
  laneId: LaneId,
  upperWatermark: number,
  ref: ArtifactRef,
): boolean {
  return events.some((event) => (
    event.globalOffset <= upperWatermark
    && event.type !== "fukai.checkpoint.committed"
    && canReadEvent(event, laneId)
    && payloadReferencesArtifact(event.payload, ref)
  ));
}

function eventEvidence(event: AnyEvent): FukaiEventEvidence {
  return {
    eventId: event.eventId,
    globalOffset: event.globalOffset,
    laneSeq: event.laneSeq,
    laneId: event.laneId,
    type: event.type,
    occurredAt: event.occurredAt,
    ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
    correlationId: event.correlationId,
    visibility: event.visibility,
    contentHash: event.contentHash,
    payload: cloneJson(event.payload) as Record<string, unknown>,
  };
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(stableJson(value), "utf8");
}

function estimateTokens(value: unknown): number {
  return Math.ceil(byteLength(value) / 4);
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) {
    return value;
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maxBytes; end >= Math.max(0, maxBytes - 3); end -= 1) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      // Retry at the previous UTF-8 code point boundary.
    }
  }
  return "";
}

async function withDeadline<T>(
  operation: Promise<T>,
  maxWallClockMs: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FukaiTimeoutError("Fukai query wall-clock budget exceeded")), maxWallClockMs);
  });
  const abort = signal === undefined
    ? undefined
    : new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(abortReason(signal));
          return;
        }
        abortListener = () => reject(abortReason(signal));
        signal.addEventListener("abort", abortListener, { once: true });
      });
  operation.catch(() => undefined);
  try {
    return await Promise.race(abort === undefined ? [operation, timeout] : [operation, timeout, abort]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (signal !== undefined && abortListener !== undefined) {
      signal.removeEventListener("abort", abortListener);
    }
    abort?.catch(() => undefined);
    timeout.catch(() => undefined);
  }
}

function signalOptions(signal: AbortSignal | undefined): FukaiReadOptions {
  return signal === undefined ? {} : { signal };
}

function remainingMs(deadlineAt: number): number {
  return Math.max(1, deadlineAt - Date.now());
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function ensureDeadline(deadlineAt: number, signal: AbortSignal | undefined): void {
  throwIfAborted(signal);
  if (Date.now() >= deadlineAt) {
    throw new FukaiTimeoutError("Fukai query wall-clock budget exceeded");
  }
}
