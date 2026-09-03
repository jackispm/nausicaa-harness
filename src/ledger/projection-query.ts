import type { AnyEvent } from "../domain/events.js";
import type { RunId } from "../domain/types.js";
import { cloneJson, sha256, stableJson } from "./hash.js";

export interface ProjectionCheckpoint {
  runId: RunId;
  revision: number;
  watermark: number;
  checksum: string;
}

export type ProjectionChangeStaleReason = "cursor-ahead" | "cursor-mismatch";

export interface ProjectionChangeQueryOptions {
  afterOffset?: number;
  afterChecksum?: string;
  maxEvents?: number;
  /** Authoritative Ledger-global watermark when `events` is Run-filtered. */
  globalWatermark?: number;
}

export interface ProjectionChangePage {
  runId: RunId;
  fromOffset: number;
  nextOffset: number;
  checkpoint: ProjectionCheckpoint;
  events: AnyEvent[];
  hasMore: boolean;
  stale: boolean;
  staleReason?: ProjectionChangeStaleReason;
}

export class ProjectionCursorError extends Error {
  override readonly name = "ProjectionCursorError";
}

/** Build a stable, replayable identity for a run projection prefix. */
export function projectionCheckpoint(
  events: readonly AnyEvent[],
  runId: RunId,
  atOrBeforeOffset?: number,
): ProjectionCheckpoint {
  const selected = selectedEvents(events, runId, atOrBeforeOffset);
  const watermark = selected.at(-1)?.globalOffset ?? 0;
  const revision = selected.length;
  return {
    runId,
    revision,
    watermark,
    checksum: sha256(stableJson({
      runId,
      revision,
      watermark,
      events: selected.map((event) => [event.globalOffset, event.contentHash]),
    })),
  };
}

/**
 * Return a bounded suffix of durable events together with the current
 * projection checkpoint. A caller can persist `nextOffset` and checksum and
 * request only the next page after reconnecting.
 */
export function queryProjectionChanges(
  events: readonly AnyEvent[],
  runId: RunId,
  options: ProjectionChangeQueryOptions = {},
): ProjectionChangePage {
  const afterOffset = options.afterOffset ?? 0;
  if (!Number.isSafeInteger(afterOffset) || afterOffset < 0) {
    throw new ProjectionCursorError("afterOffset must be a non-negative safe integer");
  }
  const maxEvents = options.maxEvents ?? 256;
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 10_000) {
    throw new ProjectionCursorError("maxEvents must be an integer between 1 and 10000");
  }
  const selected = selectedEvents(events, runId);
  const checkpoint = projectionCheckpoint(selected, runId);
  const observedWatermark = events.reduce(
    (watermark, event) => Math.max(watermark, event.globalOffset),
    0,
  );
  const globalWatermark = options.globalWatermark ?? observedWatermark;
  if (!Number.isSafeInteger(globalWatermark) || globalWatermark < 0) {
    throw new ProjectionCursorError("globalWatermark must be a non-negative safe integer");
  }
  if (globalWatermark < observedWatermark) {
    throw new ProjectionCursorError(
      "globalWatermark cannot be lower than an event offset in the supplied snapshot",
    );
  }
  // Cursors are Ledger global offsets. The run checkpoint's watermark only
  // reflects the latest event belonging to this projection and can therefore
  // be lower than a valid cursor advanced by another Run.
  let staleReason: ProjectionChangeStaleReason | undefined;
  if (afterOffset > globalWatermark) {
    staleReason = "cursor-ahead";
  } else if (options.afterChecksum !== undefined) {
    const cursorCheckpoint = projectionCheckpoint(selected, runId, afterOffset);
    if (cursorCheckpoint.checksum !== options.afterChecksum) {
      staleReason = "cursor-mismatch";
    }
  }
  if (staleReason !== undefined) {
    return {
      runId,
      fromOffset: afterOffset,
      nextOffset: afterOffset,
      checkpoint,
      events: [],
      hasMore: false,
      stale: true,
      staleReason,
    };
  }
  const page = selected.filter((event) => event.globalOffset > afterOffset).slice(0, maxEvents);
  const nextOffset = page.at(-1)?.globalOffset ?? afterOffset;
  return {
    runId,
    fromOffset: afterOffset,
    nextOffset,
    checkpoint,
    events: page.map((event) => cloneJson(event)),
    hasMore: selected.some((event) => event.globalOffset > nextOffset),
    stale: false,
  };
}

function selectedEvents(
  events: readonly AnyEvent[],
  runId: RunId,
  atOrBeforeOffset?: number,
): AnyEvent[] {
  return events
    .filter((event) => (
      event.runId === runId
      && (atOrBeforeOffset === undefined || event.globalOffset <= atOrBeforeOffset)
    ))
    .slice()
    .sort((left, right) => left.globalOffset - right.globalOffset);
}
