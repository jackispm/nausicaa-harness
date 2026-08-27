import type { UserImage } from "./images.js";

export type RunId = string;
export type TurnId = string;
export type InputId = string;
export type LaneId = string;
export type EventId = string;
export type ArtifactId = string;
export type MessageId = string;
export type OperationId = string;

export type LaneKind = "main" | "intent-navigator" | "reflection" | "worker";
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
      createdAt: string;
    }
  | {
      role: "assistant";
      content: string;
      toolCalls: ToolCall[];
      createdAt: string;
    }
  | {
      role: "tool";
      content: string;
      toolCallId: string;
      toolName: string;
      isError: boolean;
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

export interface TaskBudget {
  maxModelTokens: number;
  maxWallClockMs: number;
}

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
}

interface RunPolicyBase {
  maxModelTokens: number;
  tetoEnabled: boolean;
  tetoMaxOutputTokens: number;
  tetoTokenRatio: number;
  /** Present only for preregistered evaluation arms. */
  auxiliaryMode?: AuxiliaryMode;
  /** Shadow records generated Advice without publishing it to Main's Inbox. */
  tetoAdviceDelivery?: "live" | "shadow";
}

/** New runs use an activation allowance; maxMainSteps is replay-only legacy data. */
export type RunPolicy = RunPolicyBase & (
  | { maxMainStepsPerActivation: number; maxMainSteps?: never }
  | { maxMainSteps: number; maxMainStepsPerActivation?: never }
);

export function mainStepAllowance(policy: RunPolicy): number {
  return policy.maxMainStepsPerActivation ?? policy.maxMainSteps;
}
