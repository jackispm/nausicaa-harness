import type { UserImage } from "./images.js";

export type RunId = string;
export type TurnId = string;
export type InputId = string;
export type LaneId = string;
export type EventId = string;
export type ArtifactId = string;
export type MessageId = string;
export type OperationId = string;

export type LaneKind = "main" | "intent-navigator" | "reflection" | "worker" | "team";
export type LaneStatus =
  | "dormant"
  | "ready"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export type Visibility = "lane" | "run" | "user" | "sensitive";

export interface Goal {
  version: number;
  statement: string;
  successCriteria: string[];
  hardConstraints: string[];
}

/**
 * Persistent, user-owned objective for an interactive Session. This is
 * deliberately separate from Goal, which remains the bounded task contract
 * used by Worker, Team, Teto, Reflection, and one-shot execution.
 */
export type ThreadGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

export type ThreadGoalOperation =
  | "create"
  | "edit"
  | "progress"
  | "pause"
  | "resume"
  | "complete"
  | "blocked"
  | "usageLimited"
  | "budgetLimited";

/** Runtime boundary at which the persistent thread Goal may be shown to Main. */
export type GoalContextKind = "continuation" | "objective-updated" | "budget-limit";

/** Host-owned persistent Goal state. Absence means the Session is idle. */
export interface ThreadGoal {
  goalId: string;
  revision: number;
  objective: string;
  status: ThreadGoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  continuationsUsed: number;
  createdAt: string;
  updatedAt: string;
  blockedReason?: string;
}

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

/** Structured, host-visible work item kept independent from model prose. */
export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd?: number;
}

/** Provider cache semantics are deliberately conservative when usage is absent. */
export type CacheOutcome = "hit" | "write" | "hit-write" | "unknown";

export interface ArtifactRef {
  id: ArtifactId;
  contentHash: string;
  mediaType: string;
  byteLength: number;
}

/** Stable machine identity for one addressable lane in a persisted Session/Run. */
export interface CrossRunEndpoint {
  workspaceId: string;
  sessionId: string;
  runId: RunId;
  laneId: LaneId;
}

export type CrossRunRelationship = "parent" | "sibling" | "child" | "direct";
export type CrossRunEndpointStatus = "idle" | "busy" | "inactive";

/**
 * A verified content-addressed copy. Paths and transport credentials are
 * deliberately absent from the durable contract.
 */
export interface CrossRunArtifactDelivery {
  sourceRef: ArtifactRef;
  targetRef: ArtifactRef;
  visibility: Visibility;
  targetWorkspaceId: string;
}

/** Trusted route metadata attached by the host, never accepted from model input. */
export interface CrossRunRoute {
  routeId: string;
  source: CrossRunEndpoint;
  target: CrossRunEndpoint;
  relationship: CrossRunRelationship;
  artifacts: CrossRunArtifactDelivery[];
}

/** Trusted envelope assembled after target resolution and authorization. */
export interface CrossRunEnvelope {
  readonly protocolVersion: 1;
  readonly messageId: string;
  readonly routeId: string;
  readonly source: CrossRunEndpoint;
  readonly target: CrossRunEndpoint;
  readonly relationship: CrossRunRelationship;
  readonly conversationId: string;
  readonly threadId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly causationId?: string;
  readonly visibility: Visibility;
  readonly priority: number;
  readonly payload: A2APayload;
  readonly artifacts: readonly CrossRunArtifactDelivery[];
}

export type CrossRunReceiptStatus =
  | "accepted"
  | "queued"
  | "delivered"
  | "handled"
  | "duplicate"
  | "expired"
  | "rejected"
  | "uncertain"
  | "conflict";

export type CrossRunReceiptReason =
  | "authorization-denied"
  | "cross-workspace-reauthentication-required"
  | "target-capacity"
  | "rate-limited"
  | "stale-lease"
  | "target-unavailable"
  | "artifact-rejected"
  | "artifact-integrity"
  | "wake-failed"
  | "target-admission-failed"
  | "source-receipt-failed"
  | "delivery-attempt-without-receipt"
  | "idempotency-conflict"
  | "expired";

export interface CrossRunReceipt {
  readonly protocolVersion: 1;
  readonly receiptId: string;
  readonly routeId: string;
  readonly messageId: string;
  readonly idempotencyKey: string;
  readonly source: CrossRunEndpoint;
  readonly target: CrossRunEndpoint;
  readonly relationship: CrossRunRelationship;
  readonly status: CrossRunReceiptStatus;
  readonly recordedAt: string;
  readonly targetMessageId?: string;
  readonly attemptId?: string;
  readonly reason?: CrossRunReceiptReason;
  readonly retryAt?: string;
  readonly diagnostic?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ConversationMessage =
  | {
      role: "user";
      content: string;
      images?: UserImage[];
      /** Optional origin used by lane projections to recover event cursors. */
      sourceEventId?: EventId;
      sourceLane?: LaneId;
      createdAt: string;
    }
  | {
      role: "assistant";
      content: string;
      toolCalls: ToolCall[];
      /** Displayed reasoning retained for interrupted-stream audit/replay metadata. */
      reasoning?: string;
      /** Optional for legacy artifacts; true means the provider response never committed. */
      interrupted?: boolean;
      interruptionReason?: "cancelled" | "timeout" | "error";
      createdAt: string;
    }
  | {
      role: "tool";
      content: string;
      toolCallId: string;
      toolName: string;
      isError: boolean;
      /** Tool-produced media is kept with the durable conversation message. */
      images?: UserImage[];
      createdAt: string;
    };

export type MainTriggerKind =
  | "normal"
  | "decision"
  | "goal-change"
  | "repeated-failure"
  | "contradiction";

export interface NavigationDelta {
  boundaryId: string;
  triggerKind: MainTriggerKind;
  activeObjective: string;
  actionOrDecision: string;
  expectedOutcome: string;
  outcome: string;
  status: "progress" | "blocked" | "uncertain" | "complete";
  uncertainties: string[];
  openQuestions: string[];
}

/**
 * Durable, explicit Fukai compaction capability settings.
 *
 * This is a policy value rather than a provider implementation. Keeping it
 * on the Run policy makes resume behavior deterministic without coupling the
 * domain to a particular model or transport.
 */
export interface FukaiCompactionPolicy {
  enabled: boolean;
  provider: "none" | "pi-ai";
  maxInputTokens: number;
  maxOutputTokens: number;
  maxWallClockMs: number;
  /** Schema-v1 logs may omit cadence fields; new Runs always persist them. */
  thresholdRatio?: number;
  retainRatio?: number;
  minimumGainTokens?: number;
}

/** DeepSeek-style pressure defaults, made durable on every newly created Run. */
export const DEFAULT_FUKAI_COMPACTION_THRESHOLD_RATIO = 0.8;
export const DEFAULT_FUKAI_COMPACTION_RETAIN_RATIO = 0.16;
export const DEFAULT_FUKAI_COMPACTION_MINIMUM_GAIN_TOKENS = 1;

export interface ObservationFrame {
  mission: {
    goalVersion: number;
    goal: string;
    successCriteria: string[];
    hardConstraints: string[];
  };
  mainDelta: NavigationDelta;
  previousAdviceOutcome?: {
    adviceId: string;
    disposition: AdviceDisposition;
    reason?: string;
  };
  budget: {
    maxOutputTokens: number;
    deadline: string;
  };
  truncated: boolean;
}

export type AdviceKind = "orientation" | "intent-gap" | "method-alternative";
export type AdviceDisposition = "accept" | "defer" | "reject";

export const DEFAULT_MAIN_OUTPUT_TOKENS = 4_096;
export const MAX_MAIN_OUTPUT_TOKENS = 1_000_000;

export interface Advice {
  adviceId: string;
  kind: AdviceKind;
  claim: string;
  evidenceRefs: string[];
  confidence: number;
  risk: "low" | "medium" | "high";
  suggestedAction: string;
  urgency: "next-step" | "next-turn" | "deferred";
  expiresAt: string;
  dedupeKey: string;
  sourceLane: LaneId;
}

export type DeliveryMode = "next-step" | "next-turn" | "deferred" | "urgent";
export type AuxiliaryMode = "none" | "teto" | "reflection";
/** Whether a lane's optional Teto is opened by the host or by the lane tool. */
export type TetoActivationMode = "automatic" | "manual";

export interface TaskBudget {
  maxModelTokens: number;
  maxWallClockMs: number;
  /** Absolute task deadline. Legacy task messages may omit this field. */
  deadline?: string;
  /** Maximum provider attempts. Legacy task messages default conservatively. */
  maxAttempts?: number;
}

/** Hard protocol bounds keep delegated work finite even for untrusted senders. */
export const MAX_TASK_MODEL_TOKENS = 1_000_000;
export const MAX_TASK_WALL_CLOCK_MS = 30 * 60 * 1_000;
export const DEFAULT_TASK_MAX_ATTEMPTS = 2;
export const MAX_TASK_ATTEMPTS = 8;

export interface TaskRequest {
  type: "task.request";
  taskId: string;
  goal: Goal;
  inputRefs: ArtifactRef[];
  budget: TaskBudget;
}

export interface TaskAccept {
  type: "task.accept";
  taskId: string;
}

export interface TaskResult {
  type: "task.result";
  taskId: string;
  status: "completed" | "partial";
  summary: string;
  evidenceRefs: string[];
  artifactRefs: ArtifactRef[];
  openQuestions: string[];
  usage: TokenUsage;
}

export interface TaskFailed {
  type: "task.failed";
  taskId: string;
  reason: string;
  retryable: boolean;
  evidenceRefs: string[];
}

export type A2APayload =
  | { type: "advice.propose"; advice: Advice }
  | TaskRequest
  | TaskAccept
  | TaskResult
  | TaskFailed
  | { type: "question.ask"; question: string }
  | { type: "question.answer"; answer: string }
  | { type: "message.inform"; text: string };

export interface A2AMessage {
  messageId: MessageId;
  runId: RunId;
  conversationId: string;
  threadId: string;
  from: LaneId;
  to: LaneId;
  parentId?: MessageId;
  replyTo?: MessageId;
  createdAt: string;
  expiresAt?: string;
  causationId?: string;
  correlationId: string;
  idempotencyKey: string;
  visibility: Visibility;
  priority: number;
  delivery: DeliveryMode;
  payload: A2APayload;
  /** Optional metadata for the cross-Run adapter; ignored by legacy Inbox consumers. */
  routeId?: string;
  routeRelationship?: CrossRunRelationship;
  routeArtifacts?: CrossRunArtifactDelivery[];
  sourceEndpoint?: CrossRunEndpoint;
  targetEndpoint?: CrossRunEndpoint;
}

interface RunPolicyBase {
  maxModelTokens: number;
  /** Optional for legacy Runs; runtime applies the durable default when absent. */
  mainRequestTimeoutMs?: number;
  tetoEnabled: boolean;
  tetoMaxOutputTokens: number;
  tetoTokenRatio: number;
  /** Optional for legacy Runs; manual makes `teto_start` the only opener. */
  tetoActivation?: TetoActivationMode;
  /** Optional for schema-v1 compatibility; omitted means the Worker lane is off. */
  workerEnabled?: boolean;
  /** Present only for preregistered evaluation arms. */
  auxiliaryMode?: AuxiliaryMode;
  /** Shadow records generated Advice without publishing it to Main's Inbox. */
  tetoAdviceDelivery?: "live" | "shadow";
  /** Optional, explicit Fukai compaction capability; absent means disabled. */
  fukaiCompaction?: FukaiCompactionPolicy;
}

/** New runs use an activation allowance; maxMainSteps is replay-only legacy data. */
export type RunPolicy = RunPolicyBase & (
  | { maxMainStepsPerActivation: number; maxMainSteps?: never }
  | { maxMainSteps: number; maxMainStepsPerActivation?: never }
);

export function mainStepAllowance(policy: RunPolicy): number {
  return policy.maxMainStepsPerActivation ?? policy.maxMainSteps;
}

export const DEFAULT_MAIN_REQUEST_TIMEOUT_MS = 5 * 60 * 1_000;
export const MAX_MAIN_REQUEST_TIMEOUT_MS = 60 * 60 * 1_000;
