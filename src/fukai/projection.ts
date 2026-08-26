import type { EventEnvelope } from "../domain/events.js";
import type { RunId, LaneId } from "../domain/types.js";
import { cloneJson, sha256, stableJson } from "../ledger/hash.js";
import type { AnyEvent } from "../domain/events.js";

export type FukaiCheckpointIntegrityReason =
  | "cursor-invalid"
  | "watermark-invalid"
  | "state-hash-mismatch"
  | "cursor-regressed"
  | "watermark-regressed"
  | "state-refs-limit"
  | "state-refs-invalid";

const MAX_CHECKPOINT_STATE_REFS = 128;

export interface FukaiInvalidCheckpoint {
  checkpoint: EventEnvelope<"fukai.checkpoint.committed">;
  reasons: FukaiCheckpointIntegrityReason[];
}

export interface FukaiProjection {
  runId: RunId;
  laneId?: LaneId;
  queryAudits: EventEnvelope<"fukai.query.audit">[];
  checkpoints: EventEnvelope<"fukai.checkpoint.committed">[];
  invalidCheckpoints: FukaiInvalidCheckpoint[];
  /** Most recent checkpoint whose cursor and state hash are internally valid. */
  latestCheckpoint?: EventEnvelope<"fukai.checkpoint.committed">;
}

/** Rebuilds the durable Fukai view without consulting a mutable provider cache. */
export function projectFukai(
  events: readonly AnyEvent[],
  runId: RunId,
  laneId?: LaneId,
): FukaiProjection {
  const selected = events
    .filter((event) => event.runId === runId)
    .filter((event) => laneId === undefined || event.laneId === laneId)
    .slice()
    .sort((left, right) => left.globalOffset - right.globalOffset);
  const queryAudits = selected
    .filter((event): event is EventEnvelope<"fukai.query.audit"> => event.type === "fukai.query.audit")
    .map((event) => cloneJson(event));
  const checkpoints = selected
    .filter((event): event is EventEnvelope<"fukai.checkpoint.committed"> => event.type === "fukai.checkpoint.committed")
    .map((event) => cloneJson(event));
  const invalidCheckpoints: FukaiInvalidCheckpoint[] = [];
  const validCheckpoints: EventEnvelope<"fukai.checkpoint.committed">[] = [];
  let previousComparable: { cursor: number; upperWatermark: number } | undefined;
  for (const checkpoint of checkpoints) {
    const reasons = checkpointIntegrityReasons(checkpoint);
    const comparable = comparableCheckpointPosition(checkpoint);
    if (comparable !== undefined && previousComparable !== undefined) {
      if (comparable.cursor < previousComparable.cursor) {
        reasons.push("cursor-regressed");
      }
      if (comparable.upperWatermark < previousComparable.upperWatermark) {
        reasons.push("watermark-regressed");
      }
    }
    // Keep a position from every structurally comparable checkpoint, including
    // one whose state hash is damaged. A later rollback must not hide behind a
    // corrupt intermediate record.
    if (comparable !== undefined) {
      previousComparable = comparable;
    }
    if (reasons.length === 0) {
      validCheckpoints.push(checkpoint);
      continue;
    }
    invalidCheckpoints.push({ checkpoint: cloneJson(checkpoint), reasons });
  }
  const latestCheckpoint = validCheckpoints.at(-1);
  return {
    runId,
    ...(laneId === undefined ? {} : { laneId }),
    queryAudits,
    checkpoints,
    invalidCheckpoints,
    ...(latestCheckpoint === undefined ? {} : { latestCheckpoint }),
  };
}

/** Checks only intrinsic checkpoint integrity; Store dependencies are verified by Core. */
export function checkpointIntegrityReasons(
  checkpoint: EventEnvelope<"fukai.checkpoint.committed">,
): FukaiCheckpointIntegrityReason[] {
  const reasons: FukaiCheckpointIntegrityReason[] = [];
  const match = /^offset:(\d+)$/.exec(checkpoint.payload.cursor);
  const cursorOffset = match === null ? Number.NaN : Number(match[1]);
  if (
    !Number.isSafeInteger(cursorOffset)
    || cursorOffset < 0
    || cursorOffset > checkpoint.payload.upperWatermark
  ) {
    reasons.push("cursor-invalid");
  }
  if (
    !Number.isSafeInteger(checkpoint.payload.upperWatermark)
    || checkpoint.payload.upperWatermark < 0
  ) {
    reasons.push("watermark-invalid");
  }
  const stateRefsValid = Array.isArray(checkpoint.payload.stateRefs);
  if (!stateRefsValid) {
    reasons.push("state-refs-invalid");
  } else if (checkpoint.payload.stateRefs.length > MAX_CHECKPOINT_STATE_REFS) {
    reasons.push("state-refs-limit");
  }
  // Do not canonicalize an unbounded stateRefs array merely to calculate a
  // hash for a record that is already outside the projection contract.
  if (stateRefsValid && checkpoint.payload.stateRefs.length <= MAX_CHECKPOINT_STATE_REFS) {
    const { stateHash: _stateHash, ...state } = checkpoint.payload;
    if (sha256(stableJson(state)) !== checkpoint.payload.stateHash) {
      reasons.push("state-hash-mismatch");
    }
  }
  return reasons;
}

function comparableCheckpointPosition(
  checkpoint: EventEnvelope<"fukai.checkpoint.committed">,
): { cursor: number; upperWatermark: number } | undefined {
  const match = /^offset:(\d+)$/.exec(checkpoint.payload.cursor);
  if (match === null) {
    return undefined;
  }
  const cursor = Number(match[1]);
  const upperWatermark = checkpoint.payload.upperWatermark;
  if (
    !Number.isSafeInteger(cursor)
    || cursor < 0
    || !Number.isSafeInteger(upperWatermark)
    || upperWatermark < 0
  ) {
    return undefined;
  }
  return { cursor, upperWatermark };
}
