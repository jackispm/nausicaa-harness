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
} from "./types.js";

export type InputDelivery = "new-turn" | "steering" | "follow-up";
export type UserMessageKind = "initial" | "steering";

export type ContextTruncationKind =
  | "input-token-budget"
  | "conversation-message-limit"
  | "artifact-count-limit"
  | "artifact-byte-limit"
  | "query-limit"
  | "missing-conversation"
  | "missing-artifact"
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
  "step.completed": { step: number; hasToolCalls: boolean };
  "step.failed": { step: number; error: string };
  "input.admitted": {
    inputId: InputId;
    messageRef: ArtifactRef;
    delivery: InputDelivery;
    targetTurnId?: TurnId;
    sequence: number;
  };
  "input.delivered": { inputId: InputId; turnId: TurnId; boundary: string };
  "turn.started": { turnId: TurnId; inputId: InputId; ordinal: number };
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
  "model.requested": {
    model: string;
    requestHash: string;
    contextWatermark: number;
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
  "model.failed": { model: string; error: string };
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
  };
  "tool.failed": {
    operationId: string;
    toolCallId: string;
    name: string;
    error: string;
    resultRef: ArtifactRef;
    resolution?: "operator";
  };
  "tool.unknown": {
    operationId: string;
    toolCallId: string;
    name: string;
    reason: string;
  };
  "message.sent": { message: A2AMessage };
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
