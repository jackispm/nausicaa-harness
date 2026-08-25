import type {
  A2AMessage,
  AdviceDisposition,
  ArtifactRef,
  EventId,
  Goal,
  LaneId,
  LaneKind,
  LaneStatus,
  NavigationDelta,
  RunId,
  RunPolicy,
  CacheOutcome,
  TokenUsage,
  Visibility,
} from "./types.js";

export interface EventPayloadMap {
  "run.created": { goal: Goal; workspace: string; policy: RunPolicy };
  "run.resumed": { fromOffset: number };
  "run.completed": { answerRef?: ArtifactRef };
  "run.failed": { error: string };
  "goal.revised": { goal: Goal };
  "lane.registered": { kind: LaneKind };
  "lane.status": { status: LaneStatus; reason?: string };
  "step.started": { step: number };
  "step.completed": { step: number; hasToolCalls: boolean };
  "step.failed": { step: number; error: string };
  "user.message": { messageRef: ArtifactRef };
  "assistant.message": { messageRef: ArtifactRef };
  "navigation.updated": { delta: NavigationDelta };
  "model.requested": {
    model: string;
    requestHash: string;
    contextWatermark: number;
    /** Stable prompt/tool prefix hash. Optional for schema-v1 legacy events. */
    prefixHash?: string;
    /** Artifact/content dependencies selected by Fukai. */
    dependencyRefs?: string[];
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
  };
  "message.sent": { message: A2AMessage };
  "message.claimed": { messageId: string; claimedBy: LaneId };
  "message.handled": { messageId: string };
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
}

export type EventType = keyof EventPayloadMap;

export interface EventEnvelope<K extends EventType = EventType> {
  eventId: EventId;
  runId: RunId;
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
  laneId: LaneId;
  type: K;
  payload: EventPayloadMap[K];
  causationId?: string;
  correlationId: string;
  idempotencyKey: string;
  visibility?: Visibility;
  occurredAt?: string;
}
