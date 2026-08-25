import {
  createModels,
  type Api,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type Models,
  type MutableModels,
  type Tool as PiTool,
} from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

import type {
  ModelPort,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "../domain/ports.js";
import type { ConversationMessage, TokenUsage } from "../domain/types.js";

export interface PiAiModelPortOptions {
  models: Models;
  defaultProvider?: string;
}

export interface OpenRouterModelPortOptions {
  models?: MutableModels;
}

/**
 * Thin pi-ai adapter. Authentication remains entirely inside the injected
 * pi-ai provider collection; this adapter has no key-bearing configuration.
 */
export class PiAiModelPort implements ModelPort {
  private readonly models: Models;
  private readonly defaultProvider: string;

  constructor(options: PiAiModelPortOptions) {
    this.models = options.models;
    this.defaultProvider = options.defaultProvider ?? "openrouter";
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    throwIfAborted(request.signal);

    const selector = parseModelSelector(request.model, this.defaultProvider);
    const model = this.models.getModel(selector.provider, selector.model);
    if (model === undefined) {
      throw new Error(`Unknown model: ${selector.provider}:${selector.model}`);
    }

    const context = toPiContext(request, model);

    let result: AssistantMessage;
    try {
      result = await this.models.complete(model, context, {
        maxTokens: request.maxOutputTokens,
        sessionId: request.sessionId,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch {
      throwIfAborted(request.signal);
      // Never propagate provider/auth payloads into the Ledger error path.
      throw new Error("Model request failed");
    }

    if (result.stopReason === "error" || result.stopReason === "aborted") {
      // Provider diagnostics can contain request metadata. Keep the public
      // failure deliberately small; the adapter never logs provider payloads.
      throw new Error(`Model request ${result.stopReason}`);
    }

    return fromPiMessage(result);
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (request.signal?.aborted) {
      yield { type: "error", error: abortError(request.signal) };
      return;
    }

    let model: Model<Api>;
    let context: Context;
    try {
      const selector = parseModelSelector(request.model, this.defaultProvider);
      const selectedModel = this.models.getModel(selector.provider, selector.model);
      if (selectedModel === undefined) {
        throw new Error(`Unknown model: ${selector.provider}:${selector.model}`);
      }
      model = selectedModel;
      context = toPiContext(request, model);
    } catch (error: unknown) {
      // Selector and catalog failures are local configuration errors, not
      // provider payloads, so they are safe and useful to return verbatim.
      yield { type: "error", error: asError(error) };
      return;
    }

    try {
      const stream = this.models.stream(model, context, {
        maxTokens: request.maxOutputTokens,
        sessionId: request.sessionId,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      let textBlockCount = 0;
      for await (const event of stream) {
        switch (event.type) {
          case "start":
            yield { type: "start" };
            break;
          case "text_start":
            // complete() historically joins separate pi-ai text blocks with a
            // newline. Mirror that boundary so streamed text equals done.content.
            if (textBlockCount > 0) {
              yield { type: "text-delta", delta: "\n" };
            }
            textBlockCount += 1;
            break;
          case "text_delta":
            yield { type: "text-delta", delta: event.delta };
            break;
          case "done":
            yield { type: "done", response: fromPiMessage(event.message) };
            return;
          case "error":
            yield {
              type: "error",
              error: streamError(request.signal, event.reason),
            };
            return;
        }
      }

      yield { type: "error", error: new Error("Model request failed") };
    } catch {
      yield {
        type: "error",
        error: request.signal?.aborted
          ? abortError(request.signal)
          : new Error("Model request failed"),
      };
    }
  }
}

export function createOpenRouterModelPort(
  options: OpenRouterModelPortOptions = {},
): PiAiModelPort {
  const models = options.models ?? createModels();
  if (models.getProvider("openrouter") === undefined) {
    models.setProvider(openrouterProvider());
  }
  return new PiAiModelPort({ models, defaultProvider: "openrouter" });
}

export function parseModelSelector(
  selector: string,
  defaultProvider = "openrouter",
): { provider: string; model: string } {
  const separator = selector.indexOf(":");
  if (separator < 0) {
    if (selector.length === 0) {
      throw new Error("Model selector cannot be empty");
    }
    return { provider: defaultProvider, model: selector };
  }

  const provider = selector.slice(0, separator);
  const model = selector.slice(separator + 1);
  if (provider.length === 0 || model.length === 0) {
    throw new Error(`Invalid model selector: ${selector}`);
  }
  return { provider, model };
}

function toPiMessage(
  message: ConversationMessage,
  model: Model<Api>,
): Message {
  const timestamp = timestampOf(message.createdAt);
  if (message.role === "user") {
    return { role: "user", content: message.content, timestamp };
  }
  if (message.role === "tool") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: [{ type: "text", text: message.content }],
      isError: message.isError,
      timestamp,
    };
  }

  const content: AssistantMessage["content"] = [];
  if (message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }
  content.push(
    ...message.toolCalls.map((call) => ({
      type: "toolCall" as const,
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    })),
  );

  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyPiUsage(),
    stopReason: message.toolCalls.length > 0 ? "toolUse" : "stop",
    timestamp,
  };
}

function toPiTool(tool: ModelRequest["tools"][number]): PiTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as PiTool["parameters"],
  };
}

function toPiContext(request: ModelRequest, model: Model<Api>): Context {
  return {
    systemPrompt: request.systemPrompt,
    messages: request.messages.map((message) => toPiMessage(message, model)),
    tools: request.tools.map(toPiTool),
  };
}

function fromPiMessage(message: AssistantMessage): ModelResponse {
  return {
    content: message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n"),
    toolCalls: message.content
      .filter((block) => block.type === "toolCall")
      .map((call) => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      })),
    stopReason: message.stopReason,
    usage: toDomainUsage(message),
  };
}

function toDomainUsage(message: AssistantMessage): TokenUsage {
  return {
    input: message.usage.input,
    output: message.usage.output,
    cacheRead: message.usage.cacheRead,
    cacheWrite: message.usage.cacheWrite,
    costUsd: message.usage.cost.total,
  };
}

function emptyPiUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function timestampOf(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw abortError(signal);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function streamError(
  signal: AbortSignal | undefined,
  reason: "aborted" | "error",
): Error {
  if (signal?.aborted) {
    return abortError(signal);
  }
  return reason === "aborted"
    ? new DOMException("The model request was aborted", "AbortError")
    : new Error("Model request failed");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
