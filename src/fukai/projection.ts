import type { EventEnvelope } from "../domain/events.js";
import type { ArtifactRef, RunId, LaneId } from "../domain/types.js";
import {
  FUKAI_COMPACTION_MEDIA_TYPE,
  type ContextSourceRef,
} from "../domain/context.js";
import { cloneJson, sha256, stableJson } from "../ledger/hash.js";
import type { AnyEvent } from "../domain/events.js";
import { assertArtifactRef } from "../store/store.js";

export type FukaiCheckpointIntegrityReason =
  | "cursor-invalid"
  | "watermark-invalid"
  | "state-hash-mismatch"
  | "cursor-regressed"
  | "watermark-regressed"
  | "state-refs-limit"
  | "state-refs-invalid";

export type FukaiCompactionIntegrityReason =
  | "compaction-id-invalid"
  | "summary-ref-invalid"
  | "summary-media-type-invalid"
  | "summary-hash-mismatch"
  | "source-refs-invalid"
  | "source-refs-empty"
  | "source-refs-limit"
  | "source-ref-duplicate"
  | "deferred-conversation-refs-invalid"
  | "generation-invalid"
  | "reset-invalid"
  | "lineage-invalid"
  | "cursor-invalid"
  | "watermark-invalid"
  | "cursor-regressed"
  | "watermark-regressed"
  | "goal-version-invalid"
  | "policy-version-invalid"
  | "estimated-tokens-invalid";

const MAX_CHECKPOINT_STATE_REFS = 128;

export interface FukaiInvalidCheckpoint {
  checkpoint: EventEnvelope<"fukai.checkpoint.committed">;
  reasons: FukaiCheckpointIntegrityReason[];
}

export interface FukaiInvalidCompaction {
  compaction: EventEnvelope<"fukai.compaction.committed">;
  reasons: FukaiCompactionIntegrityReason[];
}

export interface FukaiProjection {
  runId: RunId;
  laneId?: LaneId;
  queryAudits: EventEnvelope<"fukai.query.audit">[];
  checkpoints: EventEnvelope<"fukai.checkpoint.committed">[];
  invalidCheckpoints: FukaiInvalidCheckpoint[];
  /** Most recent checkpoint whose cursor and state hash are internally valid. */
  latestCheckpoint?: EventEnvelope<"fukai.checkpoint.committed">;
  compactions: EventEnvelope<"fukai.compaction.committed">[];
  invalidCompactions: FukaiInvalidCompaction[];
  /** Most recent compaction whose durable metadata is internally valid. */
  latestCompaction?: EventEnvelope<"fukai.compaction.committed">;
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
  const compactions = selected
    .filter((event): event is EventEnvelope<"fukai.compaction.committed"> => event.type === "fukai.compaction.committed")
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
  const invalidCompactions: FukaiInvalidCompaction[] = [];
  const validCompactions: EventEnvelope<"fukai.compaction.committed">[] = [];
  let previousCompactionPosition: { cursor: number; upperWatermark: number } | undefined;
  let latestTrustedCompaction: EventEnvelope<"fukai.compaction.committed"> | undefined;
  for (const compaction of compactions) {
    const reasons = compactionIntegrityReasons(compaction);
    const comparable = comparableCompactionPosition(compaction);
    if (comparable !== undefined && previousCompactionPosition !== undefined) {
      if (comparable.cursor < previousCompactionPosition.cursor) {
        reasons.push("cursor-regressed");
      }
      if (comparable.upperWatermark < previousCompactionPosition.upperWatermark) {
        reasons.push("watermark-regressed");
      }
    }
    if (comparable !== undefined) {
      previousCompactionPosition = comparable;
    }
    if (reasons.length === 0) {
      reasons.push(...projectedCompactionLineageReasons(
        compaction,
        latestTrustedCompaction,
      ));
    }
    if (reasons.length === 0) {
      validCompactions.push(compaction);
      latestTrustedCompaction = compaction;
    } else {
      invalidCompactions.push({
        compaction: cloneJson(compaction),
        reasons: [...new Set(reasons)],
      });
    }
  }
  const latestCompaction = latestTrustedCompaction;
  return {
    runId,
    ...(laneId === undefined ? {} : { laneId }),
    queryAudits,
    checkpoints,
    invalidCheckpoints,
    ...(latestCheckpoint === undefined ? {} : { latestCheckpoint }),
    compactions,
    invalidCompactions,
    ...(latestCompaction === undefined ? {} : { latestCompaction }),
  };
}

/**
 * Validate lineage that becomes knowable only while replaying ordered events.
 * The latest trusted compaction is the sole admissible base, so an invalid
 * reset cannot authorize its summary as the base of a later compaction.
 */
function projectedCompactionLineageReasons(
  compaction: EventEnvelope<"fukai.compaction.committed">,
  previous: EventEnvelope<"fukai.compaction.committed"> | undefined,
): FukaiCompactionIntegrityReason[] {
  const payload = compaction.payload;
  const bases = payload.sourceRefs.flatMap((source) => (
    source.kind === "artifact" && source.ref.mediaType === FUKAI_COMPACTION_MEDIA_TYPE
      ? [source.ref]
      : []
  ));

  if (payload.resetFromCompactionId !== undefined) {
    return previous?.payload.compactionId === payload.resetFromCompactionId
      && previous.payload.goalVersion === payload.goalVersion
      && previous.payload.policyVersion === payload.policyVersion
      ? []
      : ["reset-invalid"];
  }

  if (bases.length === 0) {
    return previous !== undefined
      && previous.payload.goalVersion === payload.goalVersion
      && previous.payload.policyVersion === payload.policyVersion
      ? ["lineage-invalid"]
      : [];
  }

  if (
    bases.length !== 1
    || previous === undefined
    || !sameArtifactRef(previous.payload.summaryRef, bases[0]!)
    || previous.payload.goalVersion !== payload.goalVersion
    || previous.payload.policyVersion !== payload.policyVersion
  ) {
    return ["lineage-invalid"];
  }
  return [];
}

/** Checks only intrinsic compaction metadata; Store/source freshness is Core's job. */
export function compactionIntegrityReasons(
  compaction: EventEnvelope<"fukai.compaction.committed">,
): FukaiCompactionIntegrityReason[] {
  const payload = compaction.payload;
  const reasons: FukaiCompactionIntegrityReason[] = [];
  if (
    typeof payload.compactionId !== "string"
    || !/^fukai-compaction:sha256:[0-9a-f]{64}$/.test(payload.compactionId)
  ) {
    reasons.push("compaction-id-invalid");
  }
  if (!validGeneration(payload.generation)) {
    reasons.push("generation-invalid");
  }
  if (
    payload.resetFromCompactionId !== undefined
    && (
      typeof payload.resetFromCompactionId !== "string"
      || !/^fukai-compaction:sha256:[0-9a-f]{64}$/.test(
        payload.resetFromCompactionId,
      )
      || payload.resetFromCompactionId === payload.compactionId
    )
  ) {
    reasons.push("reset-invalid");
  }
  let summaryRefValid = true;
  try {
    assertArtifactRef(payload.summaryRef);
  } catch {
    summaryRefValid = false;
    reasons.push("summary-ref-invalid");
  }
  if (summaryRefValid && payload.summaryRef.mediaType !== FUKAI_COMPACTION_MEDIA_TYPE) {
    reasons.push("summary-media-type-invalid");
  }
  if (summaryRefValid && payload.summaryHash !== payload.summaryRef.contentHash) {
    reasons.push("summary-hash-mismatch");
  }
  const validSourceRefs: ContextSourceRef[] = [];
  if (!Array.isArray(payload.sourceRefs)) {
    reasons.push("source-refs-invalid");
  } else if (payload.sourceRefs.length === 0) {
    reasons.push("source-refs-empty");
  } else if (payload.sourceRefs.length > MAX_CHECKPOINT_STATE_REFS) {
    reasons.push("source-refs-limit");
  } else {
    const identities = new Set<string>();
    for (const source of payload.sourceRefs) {
      if (!isContextSourceRef(source)) {
        reasons.push("source-refs-invalid");
        continue;
      }
      validSourceRefs.push(source);
      const identity = stableJson(source);
      if (identities.has(identity)) {
        reasons.push("source-ref-duplicate");
      }
      identities.add(identity);
    }
  }
  if (!validDeferredConversationRefs(
    payload.deferredConversationRefs,
    validSourceRefs,
  )) {
    reasons.push("deferred-conversation-refs-invalid");
  }
  if (
    payload.resetFromCompactionId !== undefined
    && validSourceRefs.some((source) => (
      source.kind === "artifact"
      && source.ref.mediaType === FUKAI_COMPACTION_MEDIA_TYPE
    ))
  ) {
    reasons.push("reset-invalid");
  }
  const position = comparableCompactionPosition(compaction);
  if (position === undefined) {
    const match = typeof payload.cursor === "string"
      ? /^offset:(\d+)$/.exec(payload.cursor)
      : null;
    const cursor = match === null ? Number.NaN : Number(match[1]);
    if (
      !Number.isSafeInteger(cursor)
      || cursor < 0
      || payload.cursor !== `offset:${cursor}`
      || !Number.isSafeInteger(payload.upperWatermark)
      || payload.upperWatermark < 0
      || cursor > payload.upperWatermark
    ) {
      reasons.push("cursor-invalid");
    }
    if (!Number.isSafeInteger(payload.upperWatermark) || payload.upperWatermark < 0) {
      reasons.push("watermark-invalid");
    }
  }
  if (!Number.isSafeInteger(payload.goalVersion) || payload.goalVersion < 1) {
    reasons.push("goal-version-invalid");
  }
  if (typeof payload.policyVersion !== "string" || payload.policyVersion.length === 0) {
    reasons.push("policy-version-invalid");
  }
  if (!Number.isSafeInteger(payload.estimatedTokens) || payload.estimatedTokens < 0) {
    reasons.push("estimated-tokens-invalid");
  }
  return [...new Set(reasons)];
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

function comparableCompactionPosition(
  compaction: EventEnvelope<"fukai.compaction.committed">,
): { cursor: number; upperWatermark: number } | undefined {
  const match = typeof compaction.payload.cursor === "string"
    ? /^offset:(\d+)$/.exec(compaction.payload.cursor)
    : null;
  if (match === null) {
    return undefined;
  }
  const cursor = Number(match[1]);
  const upperWatermark = compaction.payload.upperWatermark;
  if (
    !Number.isSafeInteger(cursor)
    || cursor < 0
    || compaction.payload.cursor !== `offset:${cursor}`
    || !Number.isSafeInteger(upperWatermark)
    || upperWatermark < 0
    || cursor > upperWatermark
  ) {
    return undefined;
  }
  return { cursor, upperWatermark };
}

function isContextSourceRef(value: unknown): value is ContextSourceRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const item = value as Record<string, unknown>;
  if (item.kind === "event") {
    return typeof item.eventId === "string"
      && item.eventId.length > 0
      && typeof item.contentHash === "string"
      && item.contentHash.length > 0;
  }
  if (item.kind !== "artifact" && item.kind !== "conversation") {
    return false;
  }
  try {
    assertArtifactRef(item.ref as Parameters<typeof assertArtifactRef>[0]);
    return true;
  } catch {
    return false;
  }
}

function sameArtifactRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return left.id === right.id
    && left.contentHash === right.contentHash
    && left.mediaType === right.mediaType
    && left.byteLength === right.byteLength;
}

function validDeferredConversationRefs(
  refs: readonly ArtifactRef[] | undefined,
  sourceRefs: readonly ContextSourceRef[],
): boolean {
  if (refs === undefined) return true;
  if (!Array.isArray(refs) || refs.length > MAX_CHECKPOINT_STATE_REFS) return false;
  const summarized = new Set(sourceRefs.flatMap((source) => (
    source.kind === "conversation" ? [stableJson(source.ref)] : []
  )));
  const seen = new Set<string>();
  for (const ref of refs) {
    try {
      assertArtifactRef(ref);
    } catch {
      return false;
    }
    const identity = stableJson(ref);
    if (seen.has(identity) || summarized.has(identity)) return false;
    seen.add(identity);
  }
  return true;
}

function validGeneration(generation: unknown): boolean {
  if (generation === undefined) return true;
  if (generation === null || typeof generation !== "object" || Array.isArray(generation)) {
    return false;
  }
  const item = generation as Record<string, unknown>;
  return boundedIdentity(item.provider)
    && boundedIdentity(item.model)
    && boundedIdentity(item.summarizerVersion)
    && typeof item.promptHash === "string"
    && /^sha256:[0-9a-f]{64}$/.test(item.promptHash);
}

function boundedIdentity(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !value.includes("\0");
}
