import { createHash } from "node:crypto";

import type { ArtifactRef, Goal, LaneId, RunId } from "./types.js";

/** The media type used for Store objects containing a Fukai summary. */
export const FUKAI_COMPACTION_MEDIA_TYPE =
  "application/vnd.nausicaa.fukai-compaction+json" as const;

/** Store object containing the exact trusted project-instruction request input. */
export const PROJECT_INSTRUCTIONS_MEDIA_TYPE =
  "application/vnd.nausicaa.project-instructions+json" as const;

export const CONTEXT_MANIFEST_SCHEMA_VERSION = 1 as const;
export const CONTEXT_COMPACTION_SCHEMA_VERSION = 1 as const;

/**
 * A source that a compaction summary can be checked against during replay.
 * Conversation messages are content-addressed artifacts; event refs retain
 * both the event identity and its content hash.
 */
export type ContextSourceRef =
  | { kind: "artifact" | "conversation"; ref: ArtifactRef }
  | { kind: "event"; eventId: string; contentHash: string };

export interface ContextCompactionBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxWallClockMs: number;
}

/** Bounded, auditable identity of the implementation that generated a summary. */
export interface ContextCompactionGeneration {
  provider: string;
  model: string;
  summarizerVersion: string;
  promptHash: string;
}

export interface ContextCompactionIdentity {
  runId: RunId;
  laneId: LaneId;
  cursor: string;
  upperWatermark: number;
  goalVersion: number;
  policyVersion: string;
  sourceRefs: readonly ContextSourceRef[];
  /** Admitted conversation refs intentionally left outside this summary. */
  deferredConversationRefs?: readonly ArtifactRef[];
  /** Stale capsule intentionally replaced by this standalone compaction. */
  repairFromCompactionId?: string;
  generation?: ContextCompactionGeneration;
  budget: ContextCompactionBudget;
}

/** Stable logical identity shared by provider attempts, capsules, and Ledger facts. */
export function deriveContextCompactionId(identity: ContextCompactionIdentity): string {
  const sourceRefs = identity.sourceRefs.map(canonicalSourceRef);
  const serialized = JSON.stringify({
    runId: identity.runId,
    laneId: identity.laneId,
    cursor: canonicalCompactionCursor(identity.cursor),
    upperWatermark: identity.upperWatermark,
    goalVersion: identity.goalVersion,
    policyVersion: identity.policyVersion,
    sourceRefs,
    deferredConversationRefs: (identity.deferredConversationRefs ?? []).map(canonicalArtifactRef),
    ...(identity.repairFromCompactionId === undefined
      ? {}
      : { repairFromCompactionId: canonicalCompactionId(identity.repairFromCompactionId) }),
    ...(identity.generation === undefined
      ? {}
      : { generation: canonicalGeneration(identity.generation) }),
    budget: {
      maxInputTokens: identity.budget.maxInputTokens,
      maxOutputTokens: identity.budget.maxOutputTokens,
      maxWallClockMs: identity.budget.maxWallClockMs,
    },
  });
  const digest = createHash("sha256").update(serialized, "utf8").digest("hex");
  return `fukai-compaction:sha256:${digest}`;
}

function canonicalCompactionId(compactionId: string): string {
  if (!/^fukai-compaction:sha256:[0-9a-f]{64}$/.test(compactionId)) {
    throw new TypeError("Context compaction repair source ID is invalid");
  }
  return compactionId;
}

function canonicalCompactionCursor(cursor: string): string {
  const match = typeof cursor === "string" ? /^offset:(\d+)$/.exec(cursor) : null;
  const offset = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new TypeError("Context compaction cursor must be offset:<safe integer>");
  }
  return `offset:${offset}`;
}

export function deriveContextCompactionAttemptId(
  compactionId: string,
  attempt: number,
): string {
  return `${compactionId}:attempt:${attempt}`;
}

/** Structured payload stored behind a ContextCompactionCapsule.summaryRef. */
export interface ContextCompactionSummary {
  schemaVersion: 1;
  goal: Goal;
  decisions: string[];
  verifiedResults: string[];
  openQuestions: string[];
  sourceRefs: ContextSourceRef[];
  /** Cursor exceptions that remain eligible for bounded raw-context selection. */
  deferredConversationRefs?: ArtifactRef[];
  generation?: ContextCompactionGeneration;
}

export type ContextCompactionStatus = "none" | "ready" | "stale";

/**
 * The durable metadata needed to decide whether a summary is usable. The
 * summary body is intentionally kept in the content store, not in the
 * Ledger event or model request manifest.
 */
export interface ContextCompactionCapsule {
  schemaVersion: 1;
  compactionId: string;
  status: Exclude<ContextCompactionStatus, "none">;
  summaryRef: ArtifactRef;
  sourceRefs: ContextSourceRef[];
  /** Conversation refs below the cursor that the summary does not cover. */
  deferredConversationRefs?: ArtifactRef[];
  /** Auditable identity of the summarizer used for this capsule. */
  generation?: ContextCompactionGeneration;
  summaryHash: string;
  cursor: string;
  upperWatermark: number;
  goalVersion: number;
  policyVersion: string;
  estimatedTokens: number;
}

/**
 * Redacted, replayable metadata for one compiled model request.
 * Slot hashes identify selected inputs without putting their contents in the
 * Ledger event.
 */
export const CONTEXT_SLOT_NAMES = [
  "goal",
  "policy",
  "tools",
  "inbox",
  "compaction",
  "lane-context",
] as const;

export type ContextSlotName = (typeof CONTEXT_SLOT_NAMES)[number];
export type ContextSlotState = "empty" | "present" | "bounded";

export interface ContextSlotManifest {
  state: ContextSlotState;
  itemCount: number;
  estimatedTokens: number;
  hash: string;
}

/** Compaction carries provenance beyond the generic slot counters. */
export interface ContextCompactionSlotManifest extends ContextSlotManifest {
  status: ContextCompactionStatus;
  compactionId?: string;
  summaryRef?: ArtifactRef;
  sourceRefs: ContextSourceRef[];
  deferredConversationRefs?: ArtifactRef[];
  generation?: ContextCompactionGeneration;
  summaryHash?: string;
  cursor?: string;
  upperWatermark?: number;
  goalVersion?: number;
  policyVersion?: string;
}

/** Redacted identity of one trusted project instruction source. */
export interface ContextProjectInstructionSource {
  pathHash: string;
  contentHash: string;
  byteLength: number;
}

/**
 * Durable request fact for the trusted project prefix. Markdown bodies stay
 * in the content-addressed Store and are not copied into the Ledger event.
 */
export interface ContextProjectInstructionsManifest {
  schemaVersion: 1;
  state: "empty" | "present";
  itemCount: number;
  totalBytes: number;
  sourceHash: string;
  contentHash: string;
  sources: ContextProjectInstructionSource[];
  bundleRef?: ArtifactRef;
}

function canonicalSourceRef(source: ContextSourceRef): ContextSourceRef {
  if (source.kind === "event") {
    return {
      kind: "event",
      eventId: source.eventId,
      contentHash: source.contentHash,
    };
  }
  return {
    kind: source.kind,
    ref: {
      id: source.ref.id,
      contentHash: source.ref.contentHash,
      mediaType: source.ref.mediaType,
      byteLength: source.ref.byteLength,
    },
  };
}

function canonicalArtifactRef(ref: ArtifactRef): ArtifactRef {
  return {
    id: ref.id,
    contentHash: ref.contentHash,
    mediaType: ref.mediaType,
    byteLength: ref.byteLength,
  };
}

function canonicalGeneration(
  generation: ContextCompactionGeneration,
): ContextCompactionGeneration {
  return {
    provider: generation.provider,
    model: generation.model,
    summarizerVersion: generation.summarizerVersion,
    promptHash: generation.promptHash,
  };
}

export interface ContextManifest {
  schemaVersion: typeof CONTEXT_MANIFEST_SCHEMA_VERSION;
  slots: {
    goal: ContextSlotManifest;
    policy: ContextSlotManifest;
    tools: ContextSlotManifest;
    inbox: ContextSlotManifest;
    compaction: ContextCompactionSlotManifest;
    "lane-context": ContextSlotManifest;
  };
  /** Optional only for schema-v1 events written before project loading existed. */
  projectInstructions?: ContextProjectInstructionsManifest;
  prefixHash: string;
  dynamicHash: string;
  upperWatermark: number;
  policyVersion: string;
}
