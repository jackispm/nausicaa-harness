import type {
  ConversationMessage,
  EventId,
  LaneId,
  RunId,
  TokenUsage,
  ToolCall,
} from "./types.js";
import type { UserImage } from "./images.js";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/** Provider-neutral levels defined by the adopted Pi transport contract. */
export type ThinkingLevel = ModelThinkingLevel;
export type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export interface JsonSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ModelRequest {
  runId: RunId;
  laneId: LaneId;
  /** Durable logical request identity, supplied by the L1 runtime when available. */
  requestId?: EventId;
  sessionId: string;
  model: string;
  /** Omission retains the provider default; explicit off follows Pi's simple API. */
  thinkingLevel?: ThinkingLevel;
  systemPrompt: string;
  messages: ConversationMessage[];
  tools: ToolDefinition[];
  maxOutputTokens: number;
  /** Runtime-owned per-request wall-clock budget; provider must treat signal as authoritative. */
  deadlineMs?: number;
  /** ISO timestamp recorded for diagnostics/replay; not used as provider authority. */
  deadlineAt?: string;
  signal?: AbortSignal;
}

export interface ModelResponse {
  content: string;
  toolCalls: ToolCall[];
  stopReason: string;
  usage: TokenUsage;
}

export interface ModelCapabilities {
  imageInput: boolean;
  contextWindowTokens?: number;
  /** Advertised by the provider catalog; absent means unknown, not unsupported. */
  thinkingLevels?: readonly ThinkingLevel[];
}

export type ModelStreamEvent =
  | { type: "start" }
  | { type: "thinking-start" }
  | { type: "thinking-delta"; delta: string }
  | { type: "thinking-end" }
  | { type: "text-delta"; delta: string }
  | { type: "done"; response: ModelResponse }
  | { type: "error"; error: Error };

export interface ModelPort {
  /** Optional because custom model ports may not have a local capability catalog. */
  capabilities?(model: string): ModelCapabilities;
  complete(request: ModelRequest): Promise<ModelResponse>;
  stream?(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}

export interface ToolExecutionContext {
  runId: RunId;
  /** Authenticated owner lane for lane-scoped runtime capabilities. */
  laneId?: LaneId;
  workspace: string;
  operationId: string;
  signal?: AbortSignal;
}

export interface ToolResult {
  content: string;
  isError: boolean;
  /** Optional multimodal blocks returned by tools such as read_image. */
  images?: UserImage[];
}

export interface AgentTool {
  definition: ToolDefinition;
  execute(
    arguments_: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
