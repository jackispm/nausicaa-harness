import type {
  ArtifactRef,
  ConversationMessage,
  Goal,
  LaneId,
  RunId,
} from "../domain/types.js";
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

export interface FukaiBudget {
  maxInputTokens: number;
  maxConversationMessages: number;
  maxArtifacts: number;
  maxArtifactBytes: number;
  maxQueries: number;
}

export interface FukaiContextRequest {
  runId: RunId;
  laneId: LaneId;
  laneKind: FukaiLaneKind;
  goal: Goal;
  /** Current Turn intent, pinned as a dynamic user reminder outside the stable prefix. */
  activeObjective?: string;
  systemPrompt: string;
  conversationRefs: readonly FukaiConversationRef[];
  artifactSelections: readonly FukaiArtifactSelection[];
  tools: readonly ToolDefinition[];
  upperWatermark: number;
  policyVersion: string;
  budget: FukaiBudget;
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
