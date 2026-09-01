import type {
  A2AMessage,
  Advice,
  AdviceDisposition,
  ArtifactRef,
  EventId,
  Goal,
  LaneId,
  LaneKind,
  LaneStatus,
  NavigationDelta,
  InputId,
  RunId,
  RunPolicy,
  CacheOutcome,
  TokenUsage,
  TurnId,
  Visibility,
  CrossRunEnvelope,
  CrossRunReceipt,
} from "./types.js";
import type {
  ContextCompactionBudget,
  ContextCompactionGeneration,
  ContextManifest,
  ContextSourceRef,
} from "./context.js";

export type InputDelivery = "new-turn" | "steering" | "follow-up";
export type UserMessageKind = "initial" | "steering";

export interface TurnExecutionBoundary {
  collaborationMode: "default" | "plan";
  capabilities: {
    allowWrite: boolean;
    allowShell: boolean;
    allowNetwork: boolean;
  };
}

export type ContextTruncationKind =
  | "input-token-budget"
  | "conversation-message-limit"
  | "artifact-count-limit"
  | "artifact-byte-limit"
  | "query-limit"
  | "missing-conversation"
  | "missing-artifact"
  | "image-budget"
  | "conversation-shape";

export interface ContextTruncation {
  kind: ContextTruncationKind;
  ref?: string;
  detail: string;
}

export interface EventPayloadMap {
  "run.created": { goal: Goal; workspace: string; policy: RunPolicy };
  "run.resumed": { fromOffset: number; reason?: "new-turn" };
  "run.completed": { answerRef?: ArtifactRef };
  "run.failed": { error: string };
  "goal.revised": { goal: Goal };
  "lane.registered": { kind: LaneKind };
  "lane.status": { status: LaneStatus; reason?: string };
  "step.started": { step: number };
  "step.completed": {
    step: number;
    hasToolCalls: boolean;
    /** Boundary messages durably consumed by this committed Main Step. */
    boundaryMessageIds?: string[];
  };
  "step.failed": { step: number; error: string };
  "input.admitted": {
    inputId: InputId;
    messageRef: ArtifactRef;
    delivery: InputDelivery;
    targetTurnId?: TurnId;
    sequence: number;
  };
  "input.replaced": {
    inputId: InputId;
    expectedRevision: number;
    expectedMessageRef: ArtifactRef;
    revision: number;
    messageRef: ArtifactRef;
    delivery: Exclude<InputDelivery, "new-turn">;
    targetTurnId?: TurnId;
    sequence: number;
  };
  "input.withdrawn": {
    inputId: InputId;
    expectedRevision: number;
    expectedMessageRef: ArtifactRef;
  };
  "input.delivered": {
    inputId: InputId;
    turnId: TurnId;
    boundary: string;
    /** Present on modern transitions; omitted only for legacy replay. */
    expectedRevision?: number;
    expectedMessageRef?: ArtifactRef;
  };
  "turn.started": {
    turnId: TurnId;
    inputId: InputId;
    ordinal: number;
    /** Present on modern Turns; omitted only for legacy replay. */
    boundary?: TurnExecutionBoundary;
  };
  "turn.completed": { turnId: TurnId; answerRef?: ArtifactRef };
  "turn.failed": { turnId: TurnId; error: string };
  "turn.cancelled": { turnId: TurnId; reason: string; lastCommittedStep: number };
  "turn.waiting": {
    turnId: TurnId;
    reason: string;
    lastCommittedStep: number;
    resumeRequires: string;
  };
  "turn.interrupted": {
    turnId: TurnId;
    reason: string;
    retryable: boolean;
    lastCommittedStep: number;
  };
  "turn.resumed": { turnId: TurnId; fromStep: number; stepAllowance: number };
  "user.message":
    | { messageRef: ArtifactRef; inputId?: never; kind?: never }
    | { inputId: InputId; messageRef: ArtifactRef; kind: UserMessageKind };
  "assistant.message": { messageRef: ArtifactRef };
  "navigation.updated": { delta: NavigationDelta };
  /** Run-scoped Main-lane selection. Teto and Worker keep independent selectors. */
  "model.selected": { model: string };
  "model.requested": {
    model: string;
    requestHash: string;
    contextWatermark: number;
    /** Runtime-owned bounded Main request deadline. Optional for legacy events. */
    deadlineMs?: number;
    deadlineAt?: string;
    /** Provider cache affinity. Optional for schema-v1 legacy events. */
    sessionId?: string;
    /** Stable prompt/tool prefix hash. Optional for schema-v1 legacy events. */
    prefixHash?: string;
    /** Artifact/content dependencies selected by Fukai. */
    dependencyRefs?: string[];
    /** Explicit context omissions/bounds. Optional for schema-v1 legacy events. */
    truncations?: ContextTruncation[];
    /** Time spent building the model context, in milliseconds. */
    contextBuildMs?: number;
    /** Deterministic request estimate used by admission and pressure gates. */
    estimatedInputTokens?: number;
    /** Redacted six-slot context contract used to build this request. */
    contextManifest?: ContextManifest;
  };
  "model.completed": {
    model: string;
    responseRef: ArtifactRef;
    stopReason: string;
    usage: TokenUsage;
    /** Time spent waiting for the provider response, in milliseconds. */
    modelLatencyMs?: number;
    cacheOutcome?: CacheOutcome;
  };
  "model.failed": {
    model: string;
    error: string;
    /** Optional for schema-v1 compatibility; absent legacy failures recover conservatively. */
    retryable?: boolean;
  };
  "model.cancelled": { requestId: EventId; reason: string };
  "tool.requested": {
    operationId: string;
    toolCallId: string;
    name: string;
    argumentsRef: ArtifactRef;
  };
  "tool.succeeded": {
    operationId: string;
    toolCallId: string;
    name: string;
    resultRef: ArtifactRef;
    /** Bounded model-visible projection; legacy events may omit it. */
    contextRef?: ArtifactRef;
    /** Complete Mowe result retained behind the bounded context projection. */
    sourceArtifactRef?: ArtifactRef;
  };
  "tool.failed": {
    operationId: string;
    toolCallId: string;
    name: string;
    error: string;
    resultRef: ArtifactRef;
    /** Bounded model-visible projection; legacy events may omit it. */
    contextRef?: ArtifactRef;
    /** Complete Mowe result retained behind the bounded context projection. */
    sourceArtifactRef?: ArtifactRef;
    resolution?: "operator";
  };
  "tool.unknown": {
    operationId: string;
    toolCallId: string;
    name: string;
    reason: string;
  };
  "message.sent": { message: A2AMessage };
  /** Source-side cross-Run delivery saga facts. */
  "a2a.outbox.pending": { envelope: CrossRunEnvelope; recordedAt: string };
  "a2a.outbox.attempted": {
    routeId: string;
    messageId: string;
    attemptId: string;
    attemptedAt: string;
  };
  "a2a.outbox.receipt": { receipt: CrossRunReceipt };
  "message.claimed": { messageId: string; claimedBy: LaneId };
  "message.handled": { messageId: string };
  "teto.advice.generated": {
    advice: Advice;
    delivery: "live" | "shadow";
  };
  "reflection.observed": {
    mainCallIndex: number;
    trigger: string;
    action: "silent" | "revise";
    reflectionRef: ArtifactRef;
    usage: TokenUsage;
  };
  "reflection.delivered": { mainCallIndex: number; messageId: string };
  "advice.acknowledged": {
    adviceId: string;
    disposition: AdviceDisposition;
    reason?: string;
  };
  "teto.observed": {
    mainCallIndex: number;
    trigger: string;
    frameHash: string;
    usage: TokenUsage;
  };
  "budget.charged": { laneId: LaneId; usage: TokenUsage };
  "checkpoint.committed": { watermark: number; checksum: string };
  "fukai.query.audit": {
    queryId: string;
    operation: "events" | "artifact";
    reason: string;
    filterHash: string;
    cursor: string;
    nextCursor: string;
    upperWatermark: number;
    status: "ok" | "truncated" | "denied" | "not-found" | "stale";
    budget: {
      maxEvents: number;
      maxBytes: number;
      maxTokens: number;
      maxWallClockMs: number;
    };
    usage: { events: number; bytes: number; tokens: number };
    returnedCount: number;
    deniedCount: number;
    evidenceRefs: string[];
    resultHash: string;
  };
  "fukai.checkpoint.committed": {
    cursor: string;
    upperWatermark: number;
    goalVersion: number;
    stateRefs: ArtifactRef[];
    stateHash: string;
    policyVersion: string;
  };
  /** One opt-in Main pre-request pressure decision; never emitted while disabled. */
  "fukai.compaction.pressure": {
    trigger: "main-pre-step";
    model: string;
    contextWindowTokens: number | null;
    currentTokens: number;
    thresholdTokens: number | null;
    minimumRetainedRawTokens: number | null;
    selectedRawTokens: number;
    retainedRawTokens: number;
    predictedGainTokens: number;
    decision: "compact" | "skip";
    reason:
      | "pressure-threshold-reached"
      | "below-threshold"
      | "no-compactable-prefix"
      | "insufficient-predicted-gain"
      | "context-window-unknown"
      | "source-window-unavailable";
  };
  /** A physical provider attempt was durably admitted before model IO. */
  "fukai.compaction.requested": {
    compactionId: string;
    attemptId: string;
    attempt: number;
    /** Stale capsule this deterministic request intends to repair. */
    repairFromCompactionId?: string;
    cursor: string;
    upperWatermark: number;
    goalVersion: number;
    policyVersion: string;
    sourceRefs: ContextSourceRef[];
    deferredConversationRefs?: ArtifactRef[];
    generation?: ContextCompactionGeneration;
    budget: ContextCompactionBudget;
  };
  /** The provider returned a persisted summary selection. */
  "fukai.compaction.completed": {
    compactionId: string;
    attemptId: string;
    attempt: number;
    elapsedMs: number;
    usage: TokenUsage | null;
    summaryRef: ArtifactRef;
    summaryHash: string;
    estimatedTokens: number;
    generationSpecHash?: string;
  };
  /** The provider attempt terminated without a usable selection. */
  "fukai.compaction.failed": {
    compactionId: string;
    attemptId: string;
    attempt: number;
    status: "failed" | "timed-out" | "cancelled";
    elapsedMs: number;
    usage: TokenUsage | null;
  };
  /** Durable record for a structured Fukai summary stored out-of-line. */
  "fukai.compaction.committed": {
    compactionId: string;
    attemptId: string | null;
    summaryRef: ArtifactRef;
    sourceRefs: ContextSourceRef[];
    deferredConversationRefs?: ArtifactRef[];
    generation?: ContextCompactionGeneration;
    /** Explicit repair lineage when an unusable latest capsule is replaced. */
    resetFromCompactionId?: string;
    cursor: string;
    upperWatermark: number;
    goalVersion: number;
    policyVersion: string;
    summaryHash: string;
    estimatedTokens: number;
  };
  /** A preflight admission or capsule verification failure forced raw fallback. */
  "fukai.compaction.fallback": {
    compactionId: string;
    attemptId: string | null;
    attempt: number | null;
    reason: "budget-exhausted" | "stale" | "verification-failed";
    phase: "preflight" | "commit" | "read-back";
  };
}

export type EventType = keyof EventPayloadMap;

export interface EventEnvelope<K extends EventType = EventType> {
  eventId: EventId;
  runId: RunId;
  /** Absent only for run-scoped facts and schema-v1 legacy events. */
  turnId?: TurnId;
  laneId: LaneId;
  globalOffset: number;
  laneSeq: number;
  type: K;
  schemaVersion: 1;
  occurredAt: string;
  causationId?: string;
  correlationId: string;
  idempotencyKey: string;
  visibility: Visibility;
  contentHash: string;
  payload: EventPayloadMap[K];
}

export type AnyEvent = {
  [K in EventType]: EventEnvelope<K>;
}[EventType];

export interface AppendEvent<K extends EventType = EventType> {
  runId: RunId;
  turnId?: TurnId;
  laneId: LaneId;
  type: K;
  payload: EventPayloadMap[K];
  causationId?: string;
  correlationId: string;
  idempotencyKey: string;
  visibility?: Visibility;
  occurredAt?: string;
}
