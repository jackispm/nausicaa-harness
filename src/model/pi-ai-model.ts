import {
  createModels,
  type Api,
  type AssistantMessage,
  type Context,
  type FetchFunction,
  type Message,
  type Model,
  type Models,
  type MutableModels,
  type Tool as PiTool,
} from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

import type {
  ModelCapabilities,
  ModelPort,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "../domain/ports.js";
import type { ConversationMessage, TokenUsage } from "../domain/types.js";
import {
  ProviderModelError,
  type ProviderFailureCategory,
} from "./provider-error.js";

const MAX_FAILURE_TEXT_CHARS = 4_096;
const MAX_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1_000;

export interface PiAiModelPortOptions {
  models: Models;
  defaultProvider?: string;
  fetch?: FetchFunction;
}

export interface OpenRouterModelPortOptions {
  models?: MutableModels;
  fetch?: FetchFunction;
}

/**
 * Thin pi-ai adapter. Authentication remains entirely inside the injected
 * pi-ai provider collection; this adapter has no key-bearing configuration.
 */
export class PiAiModelPort implements ModelPort {
  private readonly models: Models;
  private readonly defaultProvider: string;
  private readonly fetch: FetchFunction;

  constructor(options: PiAiModelPortOptions) {
    this.models = options.models;
    this.defaultProvider = options.defaultProvider ?? "openrouter";
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  capabilities(modelSelector: string): ModelCapabilities {
    const selector = parseModelSelector(modelSelector, this.defaultProvider);
    const model = this.models.getModel(selector.provider, selector.model);
    if (model === undefined) {
      throw new Error(`Unknown model: ${selector.provider}:${selector.model}`);
    }
    return {
      imageInput: model.input.includes("image"),
      ...(isPositiveInteger(model.contextWindow)
        ? { contextWindowTokens: model.contextWindow }
        : {}),
    };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    throwIfAborted(request.signal);

    const selector = parseModelSelector(request.model, this.defaultProvider);
    const model = this.models.getModel(selector.provider, selector.model);
    if (model === undefined) {
      throw new Error(`Unknown model: ${selector.provider}:${selector.model}`);
    }

    const context = toPiContext(request, model);
    const probe = new ProviderFailureProbe(this.fetch);

    let result: AssistantMessage;
    try {
      result = await this.models.complete(model, context, {
        maxTokens: request.maxOutputTokens,
        sessionId: request.sessionId,
        maxRetries: 0,
        fetch: probe.fetch,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error: unknown) {
      throwIfAborted(request.signal);
      throw providerFailure(error, probe, undefined);
    }

    if (result.stopReason === "error" || result.stopReason === "aborted") {
      throw providerFailure(result, probe, result.stopReason);
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
    const probe = new ProviderFailureProbe(this.fetch);
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
        maxRetries: 0,
        fetch: probe.fetch,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      let textBlockCount = 0;
      for await (const event of stream) {
        switch (event.type) {
          case "start":
            yield { type: "start" };
            break;
          case "thinking_start":
            yield { type: "thinking-start" };
            break;
          case "thinking_delta":
            yield { type: "thinking-delta", delta: event.delta };
            break;
          case "thinking_end":
            yield { type: "thinking-end" };
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
              error: streamError(request.signal, event.reason, event.error, probe),
            };
            return;
        }
      }

      yield {
        type: "error",
        error: providerFailure(new Error("Model request failed"), probe, undefined),
      };
    } catch (error: unknown) {
      yield {
        type: "error",
        error: request.signal?.aborted
          ? abortError(request.signal)
          : providerFailure(error, probe, undefined),
      };
    }
  }
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export function createOpenRouterModelPort(
  options: OpenRouterModelPortOptions = {},
): PiAiModelPort {
  const models = options.models ?? createModels();
  if (models.getProvider("openrouter") === undefined) {
    models.setProvider(openrouterProvider());
  }
  return new PiAiModelPort({
    models,
    defaultProvider: "openrouter",
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
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

/** Normalize and validate a user/config supplied model selector. */
export function normalizeModelSelector(value: string): string {
  const selector = value.trim();
  if (
    selector.length === 0
    || selector.length > 256
    || /[\s\u0000-\u001f\u007f]/u.test(selector)
  ) {
    throw new Error("Model selector must be non-empty, at most 256 characters, and contain no spaces");
  }
  parseModelSelector(selector);
  return selector;
}

function toPiMessage(
  message: ConversationMessage,
  model: Model<Api>,
): Message {
  const timestamp = timestampOf(message.createdAt);
  if (message.role === "user") {
    if ((message.images?.length ?? 0) === 0) {
      return { role: "user", content: message.content, timestamp };
    }
    if (!model.input.includes("image")) {
      throw new Error("Selected model does not support image input");
    }
    return {
      role: "user",
      content: [
        ...(message.content.length === 0
          ? []
          : [{ type: "text" as const, text: message.content }]),
        ...message.images!.map((image) => structuredClone(image)),
      ],
      timestamp,
    };
  }
  if (message.role === "tool") {
    if ((message.images?.length ?? 0) > 0 && !model.input.includes("image")) {
      throw new Error("Selected model does not support image input");
    }
    const content: Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    > = [];
    if (message.content.length > 0) {
      content.push({ type: "text", text: message.content });
    }
    content.push(...(message.images ?? []).map((image) => structuredClone(image)));
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content,
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
  message: AssistantMessage,
  probe: ProviderFailureProbe,
): Error {
  if (signal?.aborted) {
    return abortError(signal);
  }
  return reason === "aborted"
    ? new ProviderModelError({ category: "aborted", retryable: false })
    : providerFailure(message, probe, message.stopReason);
}

interface ProviderFailureEvidence {
  status?: number;
  retryDirective?: boolean;
  retryAfterMs?: number;
  transportFailure: boolean;
}

class ProviderFailureProbe {
  private readonly evidence: ProviderFailureEvidence = { transportFailure: false };
  readonly fetch: FetchFunction;

  constructor(baseFetch: FetchFunction) {
    this.fetch = async (input, init) => {
      try {
        const response = await baseFetch(input, init);
        if (!response.ok) this.captureResponse(response);
        return response;
      } catch (error: unknown) {
        this.evidence.transportFailure = true;
        throw error;
      }
    };
  }

  snapshot(): ProviderFailureEvidence {
    return { ...this.evidence };
  }

  private captureResponse(response: Response): void {
    this.evidence.status = response.status;
    const retryDirective = response.headers.get("x-should-retry")?.toLowerCase();
    if (retryDirective === "true") this.evidence.retryDirective = true;
    if (retryDirective === "false") this.evidence.retryDirective = false;
    const retryAfterMs = parseRetryAfter(response.headers);
    if (retryAfterMs !== undefined) this.evidence.retryAfterMs = retryAfterMs;
  }
}

function providerFailure(
  source: unknown,
  probe: ProviderFailureProbe,
  stopReason: AssistantMessage["stopReason"] | undefined,
): ProviderModelError {
  if (source instanceof ProviderModelError) return source;
  const evidence = probe.snapshot();
  const text = failureText(source);
  const status = evidence.status ?? statusFromText(text);
  const category = failureCategory(source, text, status, evidence, stopReason);
  const retryable = isRetryable(category, status, evidence.retryDirective);
  const providerUsage = providerUsageFromFailure(source);
  return new ProviderModelError({
    category,
    retryable,
    ...(status === undefined ? {} : { status }),
    ...(evidence.retryAfterMs === undefined ? {} : { retryAfterMs: evidence.retryAfterMs }),
    ...(providerUsage === undefined ? {} : { providerUsage }),
  });
}

function providerUsageFromFailure(source: unknown): TokenUsage | undefined {
  if (!isAssistantMessage(source)) return undefined;
  try {
    return toDomainUsage(source);
  } catch {
    return undefined;
  }
}

function failureCategory(
  source: unknown,
  text: string,
  status: number | undefined,
  evidence: ProviderFailureEvidence,
  stopReason: AssistantMessage["stopReason"] | undefined,
): ProviderFailureCategory {
  if (stopReason === "aborted") return "aborted";
  const code = errorCode(source);
  if (code === "auth" || code === "oauth" || status === 401 || looksLikeAuth(text)) {
    return "authentication";
  }
  if (status === 403) return "permission";
  if (status === 402 || looksLikeQuota(text)) return "quota";
  if (status === 408) return "timeout";
  if (status === 409) return "transient";
  if (status === 429) return "rate-limit";
  if (status !== undefined && status >= 500) return "server";
  if (status !== undefined && status >= 400 && status < 500) return "invalid-request";
  if (looksLikeTimeout(text)) return "timeout";
  if (evidence.transportFailure || looksLikeNetwork(text)) return "network";
  if (evidence.retryDirective === true) return "transient";
  return "provider";
}

function isRetryable(
  category: ProviderFailureCategory,
  status: number | undefined,
  directive: boolean | undefined,
): boolean {
  if (
    category === "aborted"
    || category === "authentication"
    || category === "invalid-request"
    || category === "permission"
    || category === "quota"
    || status === 403
  ) {
    return false;
  }
  if (directive !== undefined) return directive;
  return category === "network"
    || category === "rate-limit"
    || category === "server"
    || category === "timeout"
    || category === "transient";
}

function failureText(source: unknown): string {
  let text = "";
  if (isAssistantMessage(source)) text = source.errorMessage ?? "";
  else if (source instanceof Error) text = source.message;
  else if (typeof source === "string") text = source;
  return text.slice(0, MAX_FAILURE_TEXT_CHARS).toLowerCase();
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  return typeof value === "object"
    && value !== null
    && "role" in value
    && value.role === "assistant"
    && "stopReason" in value;
}

function errorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("code" in value)) return undefined;
  return typeof value.code === "string" ? value.code.toLowerCase() : undefined;
}

function statusFromText(text: string): number | undefined {
  const match = /(?:^|\bhttp(?:\s+status)?[\s:<(]*)\b([1-5]\d{2})\b/i.exec(text)
    ?? /^([1-5]\d{2})\b/.exec(text);
  if (match?.[1] === undefined) return undefined;
  return Number(match[1]);
}

function looksLikeAuth(text: string): boolean {
  return /\b(?:api[ _-]?key|auth(?:entication|orization)?|oauth|unauthorized|invalid key|not configured)\b/.test(text);
}

function looksLikeQuota(text: string): boolean {
  return /\b(?:billing|credit balance|insufficient credits?|payment required|quota|usage limit)\b/.test(text);
}

function looksLikeTimeout(text: string): boolean {
  return /\b(?:timed out|timeout)\b/.test(text);
}

function looksLikeNetwork(text: string): boolean {
  return /\b(?:connection error|connection reset|fetch failed|network_error|network error)\b/.test(text);
}

function parseRetryAfter(headers: Headers): number | undefined {
  const milliseconds = headers.get("retry-after-ms");
  if (milliseconds !== null) return boundedDelay(Number.parseFloat(milliseconds));
  const retryAfter = headers.get("retry-after");
  if (retryAfter === null) return undefined;
  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds)) return boundedDelay(seconds * 1_000);
  const timestamp = Date.parse(retryAfter);
  if (Number.isNaN(timestamp)) return undefined;
  return boundedDelay(timestamp - Date.now());
}

function boundedDelay(value: number): number | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.min(value, MAX_RETRY_AFTER_MS);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
