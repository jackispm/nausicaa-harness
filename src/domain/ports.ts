import type {
  ConversationMessage,
  LaneId,
  RunId,
  TokenUsage,
  ToolCall,
} from "./types.js";

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

export interface ModelPort {
  complete(request: ModelRequest): Promise<ModelResponse>;
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
