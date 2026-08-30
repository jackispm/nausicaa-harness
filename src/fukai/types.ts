import type {
  ArtifactRef,
  ConversationMessage,
  Goal,
  LaneId,
  RunId,
  TokenUsage,
} from "../domain/types.js";
import type { EventEnvelope } from "../domain/events.js";
import type {
  ContextCompactionBudget,
  ContextCompactionCapsule,
  ContextCompactionGeneration,
  ContextCompactionSummary,
  ContextManifest,
  ContextProjectInstructionsManifest,
  ContextSourceRef,
} from "../domain/context.js";
import type { ToolDefinition } from "../domain/ports.js";

export type FukaiLaneKind = "main" | "explorer" | "worker";

export interface FukaiConversationRef {
  ref: ArtifactRef;
  sequence: number;
  groupId?: string;
}

export interface FukaiArtifactSelection {
  ref: ArtifactRef;
  reason: string;
  priority?: number;
  range?: {
    offset: number;
    length: number;
  };
}

/** Exact trusted Markdown selected for this request's stable system prefix. */
export interface FukaiProjectInstruction {
  path: string;
  content: string;
  byteLength: number;
  pathHash: string;
  contentHash: string;
}

/** Selected edge text is untrusted context data, never host/system policy. */
export interface FukaiEdgeContextContribution {
  readonly sourceId: string;
  readonly contributionId: string;
  readonly sourceType: "skill" | "plugin";
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly disabled?: boolean;
  readonly selected?: boolean;
  readonly contentHash?: string;
  readonly precedence?: number;
  readonly provenance?: unknown;
}

export interface FukaiBudget {
  maxInputTokens: number;
  maxConversationMessages: number;
  maxArtifacts: number;
  maxArtifactBytes: number;
  maxQueries: number;
}

/** Inputs required to create a durable, structured summary of old context. */
export interface FukaiCompactionRequest {
  compactionId: string;
  runId: RunId;
  laneId: LaneId;
  goal: Goal;
  policyVersion: string;
  cursor: string;
  upperWatermark: number;
  sourceRefs: readonly ContextSourceRef[];
  deferredConversationRefs?: readonly ArtifactRef[];
  generation?: ContextCompactionGeneration;
  budget: ContextCompactionBudget;
  signal?: AbortSignal;
}

/**
 * A provider returns metadata plus the structured body it persisted under
 * `capsule.summaryRef`. Keeping this boundary separate avoids coupling
 * context assembly to a model or a particular Store implementation.
 */
export interface FukaiCompactionSelection {
  capsule: ContextCompactionCapsule;
  summary: ContextCompactionSummary;
  /** Transient provider accounting; Core never persists it in the capsule body. */
  providerUsage?: TokenUsage;
}

export interface FukaiCompactionProvider {
  compact(request: FukaiCompactionRequest): Promise<FukaiCompactionSelection>;
}

/** Durable admission for a summary already persisted by a compaction provider. */
export interface FukaiCompactionCommitRequest {
  runId: RunId;
  laneId: LaneId;
  compactionId: string;
  /** Stale capsule the caller expects this standalone commit to replace. */
  repairFromCompactionId?: string;
  attemptId?: string;
  causationId?: string;
  goal: Goal;
  policyVersion: string;
  selection: FukaiCompactionSelection;
  signal?: AbortSignal;
}

export interface FukaiCompactionReadRequest {
  runId: RunId;
  laneId: LaneId;
  goalVersion: number;
  policyVersion: string;
  signal?: AbortSignal;
}

export interface FukaiCompactionView {
  status: "ready" | "stale" | "not-found";
  reasons: string[];
  dependenciesVerified: boolean;
  compactionId?: string;
  selection?: FukaiCompactionSelection;
  event?: EventEnvelope<"fukai.compaction.committed">;
}

export interface FukaiContextRequest {
  runId: RunId;
  laneId: LaneId;
  laneKind: FukaiLaneKind;
  goal: Goal;
  /** Current Turn intent, pinned as a dynamic user reminder outside the stable prefix. */
  activeObjective?: string;
  systemPrompt: string;
  projectInstructions?: readonly FukaiProjectInstruction[];
  /** Hash-only Ledger projection plus a Store ref for exact reconstruction. */
  projectInstructionManifest?: ContextProjectInstructionsManifest;
  /** Selected, enabled Skill/plugin text projected as bounded untrusted data. */
  edgeContext?: readonly FukaiEdgeContextContribution[];
  /** Explicit name for the dedicated untrusted Skill slot. */
  skillContext?: readonly FukaiEdgeContextContribution[];
  conversationRefs: readonly FukaiConversationRef[];
  artifactSelections: readonly FukaiArtifactSelection[];
  tools: readonly ToolDefinition[];
  upperWatermark: number;
  policyVersion: string;
  budget: FukaiBudget;
  /** False removes image blocks while retaining an explicit textual marker. */
  imageInputSupported?: boolean;
  /** Optional verified capsule selected for this request. */
  compaction?: FukaiCompactionSelection;
  signal?: AbortSignal;
}

export type FukaiTruncationKind =
  | "input-token-budget"
  | "conversation-message-limit"
  | "artifact-count-limit"
  | "artifact-byte-limit"
  | "query-limit"
  | "missing-conversation"
  | "missing-artifact"
  | "image-budget"
  | "conversation-shape";

export interface FukaiTruncation {
  kind: FukaiTruncationKind;
  ref?: string;
  detail: string;
}

export interface FukaiContextView {
  systemPrompt: string;
  messages: ConversationMessage[];
  /** Hash of the deterministic prompt/tool prefix, excluding dynamic context. */
  prefixHash: string;
  cacheKey: string;
  dependencyRefs: string[];
  upperWatermark: number;
  truncated: boolean;
  truncations: FukaiTruncation[];
  /** Redacted metadata for replaying the six context slots. */
  manifest: ContextManifest;
  usage: {
    estimatedInputTokens: number;
    conversationMessages: number;
    artifactBytes: number;
    queries: number;
  };
}

export interface FukaiReadOptions {
  signal?: AbortSignal;
}

export interface FukaiArtifactRead {
  content: string;
  contentHash: string;
  byteLength: number;
}

export interface FukaiSource {
  hasArtifact(ref: ArtifactRef, options?: FukaiReadOptions): Promise<boolean>;
  readConversation(
    ref: ArtifactRef,
    options?: FukaiReadOptions,
  ): Promise<ConversationMessage | undefined>;
  readArtifact(
    ref: ArtifactRef,
    range: { offset: number; length: number },
    options?: FukaiReadOptions,
  ): Promise<FukaiArtifactRead | undefined>;
}

export interface MainContextProvider {
  build(request: FukaiContextRequest): Promise<FukaiContextView>;
}
