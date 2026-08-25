export type RunId = string;
export type LaneId = string;
export type EventId = string;
export type ArtifactId = string;
export type MessageId = string;
export type OperationId = string;

export type LaneKind = "main" | "intent-navigator";
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

export type A2APayload =
  | { type: "advice.propose"; advice: Advice }
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

export interface RunPolicy {
  maxMainSteps: number;
  maxModelTokens: number;
  tetoEnabled: boolean;
  tetoMaxOutputTokens: number;
  tetoTokenRatio: number;
}
