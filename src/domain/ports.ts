import type {
  ConversationMessage,
  LaneId,
  RunId,
  TokenUsage,
  ToolCall,
} from "./types.js";
import type { UserImage } from "./images.js";

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
  sessionId: string;
  model: string;
  systemPrompt: string;
  messages: ConversationMessage[];
  tools: ToolDefinition[];
  maxOutputTokens: number;
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
