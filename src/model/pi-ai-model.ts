import {
  createModels,
  type AuthOperationOptions,
  type AuthCheck,
  type AuthContext,
  type AuthInteraction,
  type AuthType,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Credential,
  type CredentialStore,
  type FetchFunction,
  type Message,
  type Model,
  type Models,
  type ModelsRefreshOptions,
  type MutableModels,
  type Tool as PiTool,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
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

/** In-memory-only selector used while first-run setup has no configured model. */
export const UNCONFIGURED_MODEL_SELECTOR = "openrouter:__nausicaa_unconfigured__";

export interface PiAiModelPortOptions {
  models: Models;
  defaultProvider?: string;
  fetch?: FetchFunction;
}

export interface OpenRouterModelPortOptions {
  models?: MutableModels;
  /** Persistent credentials are injected by the application boundary. */
  credentials?: CredentialStore;
  /** Optional auth context seam for embedders and offline tests. */
  authContext?: AuthContext;
  fetch?: FetchFunction;
}

export interface BuiltinModelPortOptions {
  /** Inject a prepared collection when the host owns provider registration. */
  models?: MutableModels;
  /** Persistent credentials are injected by the application boundary. */
  credentials?: CredentialStore;
  /** Optional auth context seam for embedders and offline tests. */
  authContext?: AuthContext;
  /** Provider used when a selector omits the `provider:` prefix. */
  defaultProvider?: string;
  fetch?: FetchFunction;
}

export interface ModelCatalogEntry {
  selector: string;
  provider: string;
  id: string;
  name: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  imageInput: boolean;
  toolUse: "unknown";
  reasoning: boolean;
  authStatus: "unverified";
}

export interface ModelCatalogRefreshResult {
  /** True when the caller's signal cancelled the refresh before completion. */
  aborted: boolean;
  /** Provider-scoped refresh failures; successful providers remain published. */
  errors: ReadonlyMap<string, Error>;
  /** Last-known catalog after cache restore and any successful refreshes. */
  catalog: readonly ModelCatalogEntry[];
}

/** Provider metadata needed by host setup surfaces without exposing internals. */
export interface ModelProviderInfo {
  id: string;
  name: string;
  modelCount: number;
  authTypes: readonly AuthType[];
  /** Provider-owned labels used by setup surfaces when available. */
  apiKeyName?: string;
  oauthName?: string;
  oauthLoginLabel?: string;
  oauthSubscription?: boolean;
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
    this.defaultProvider = normalizeProviderId(options.defaultProvider ?? "openrouter");
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

  /** Read the last-known in-memory catalog without refreshing or authenticating. */
  catalog(): readonly ModelCatalogEntry[] {
    return this.models.getProviders().flatMap((provider) => provider.getModels().map((model) => (
      catalogEntry(provider.id, model)
    )));
  }

  /** Read provider registration/auth capabilities without performing I/O. */
  providers(): readonly ModelProviderInfo[] {
    return this.models.getProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      modelCount: provider.getModels().length,
      authTypes: Object.freeze([
        ...(provider.auth.apiKey === undefined ? [] : ["api_key" as const]),
        ...(provider.auth.oauth === undefined ? [] : ["oauth" as const]),
      ]),
      ...(provider.auth.apiKey === undefined ? {} : { apiKeyName: provider.auth.apiKey.name }),
      ...(provider.auth.oauth === undefined ? {} : {
        oauthName: provider.auth.oauth.name,
        ...(provider.auth.oauth.loginLabel === undefined
          ? {}
          : { oauthLoginLabel: provider.auth.oauth.loginLabel }),
        ...(provider.auth.oauth.isSubscription === undefined
          ? {}
          : { oauthSubscription: provider.auth.oauth.isSubscription }),
      }),
    }));
  }

  hasProvider(provider: string): boolean {
    return this.models.getProvider(normalizeProviderId(provider)) !== undefined;
  }

  providerAuthTypes(provider: string): readonly AuthType[] {
    const entry = this.models.getProvider(normalizeProviderId(provider));
    if (entry === undefined) return [];
    return [
      ...(entry.auth.apiKey === undefined ? [] : ["api_key" as const]),
      ...(entry.auth.oauth === undefined ? [] : ["oauth" as const]),
    ];
  }

  /**
   * Refresh selected dynamic providers through pi-ai's generation-checked
   * publication boundary. Static providers are no-ops and cached catalogs are
   * retained when one provider fails.
   */
  async refreshCatalog(
    options: ModelsRefreshOptions = {},
  ): Promise<ModelCatalogRefreshResult> {
    const normalizedProviders = options.providers?.map((provider) => normalizeProviderId(provider));
    const result = await this.models.refresh({
      ...options,
      ...(normalizedProviders === undefined ? {} : { providers: normalizedProviders }),
    });
    return {
      aborted: result.aborted,
      errors: new Map(result.errors),
      catalog: this.catalog(),
    };
  }

  /**
   * Return only models whose provider reports complete local authentication.
   * This performs provider-owned auth checks but never changes the catalog.
   */
  async availableCatalog(
    provider?: string,
    options?: AuthOperationOptions,
  ): Promise<readonly ModelCatalogEntry[]> {
    const models = await this.models.getAvailable(provider, options);
    return models.map((model) => catalogEntry(model.provider, model));
  }

  /** Check local credential configuration without making a provider request. */
  async checkAuth(provider = this.defaultProvider): Promise<AuthCheck | undefined> {
    return this.models.checkAuth(normalizeProviderId(provider));
  }

  /** Run the provider-owned login flow and persist its credential. */
  async login(
    type: AuthType,
    interaction: AuthInteraction,
    provider = this.defaultProvider,
  ): Promise<Credential> {
    return this.models.login(normalizeProviderId(provider), type, interaction);
  }

  /** Remove the saved credential for a provider; ambient environment remains untouched. */
  async logout(provider = this.defaultProvider): Promise<void> {
    await this.models.logout(normalizeProviderId(provider));
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
      result = await raceAbort(
        this.models.complete(model, context, {
          maxTokens: request.maxOutputTokens,
          sessionId: request.sessionId,
          maxRetries: 0,
          fetch: probe.fetch,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        }),
        request.signal,
      );
      // Some provider implementations resolve despite an aborted signal.
      // Cancellation remains authoritative at this adapter boundary.
      throwIfAborted(request.signal);
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
    let iterator: AsyncIterator<AssistantMessageEvent> | undefined;
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
      const currentIterator = stream[Symbol.asyncIterator]();
      iterator = currentIterator;
      while (true) {
        const next = await raceAbort(currentIterator.next(), request.signal);
        if (next.done) break;
        const event = next.value;
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
            void closeIterator(iterator);
            return;
        }
      }

      if (request.signal?.aborted) {
        yield { type: "error", error: abortError(request.signal) };
        return;
      }

      yield {
        type: "error",
        error: providerFailure(new Error("Model request failed"), probe, undefined),
      };
    } catch (error: unknown) {
      // Close provider iterators on cancellation/error without making cleanup
      // part of the user-visible cancellation latency.
      // `stream` may have failed before an iterator was created.
      void closeIterator(iterator);
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

function catalogEntry(provider: string, model: Model<Api>): ModelCatalogEntry {
  return {
    selector: `${provider}:${model.id}`,
    provider,
    id: model.id,
    name: model.name,
    contextWindowTokens: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    imageInput: model.input.includes("image"),
    toolUse: "unknown",
    reasoning: model.reasoning,
    authStatus: "unverified",
  };
}

export function createOpenRouterModelPort(
  options: OpenRouterModelPortOptions = {},
): PiAiModelPort {
  const models = options.models ?? createModels(
    options.credentials === undefined && options.authContext === undefined
      ? undefined
      : {
          ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
          ...(options.authContext === undefined ? {} : { authContext: options.authContext }),
        },
  );
  if (models.getProvider("openrouter") === undefined) {
    models.setProvider(openrouterProvider());
  }
  return new PiAiModelPort({
    models,
    defaultProvider: "openrouter",
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

/** Construct the complete provider/model catalog shipped by pi-ai. */
export function createBuiltinModelPort(
  options: BuiltinModelPortOptions = {},
): PiAiModelPort {
  const models = options.models ?? builtinModels(
    options.credentials === undefined && options.authContext === undefined
      ? undefined
      : {
          ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
          ...(options.authContext === undefined ? {} : { authContext: options.authContext }),
        },
  );
  return new PiAiModelPort({
    models,
    defaultProvider: options.defaultProvider ?? "openrouter",
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
    return { provider: normalizeProviderId(defaultProvider), model: selector };
  }

  const rawProvider = selector.slice(0, separator);
  const model = selector.slice(separator + 1);
  if (rawProvider.trim().length === 0 || model.length === 0) {
    throw new Error(`Invalid model selector: ${selector}`);
  }
  const provider = normalizeProviderId(rawProvider);
  return { provider, model };
}

/** Provider identifiers are case-insensitive at every public host boundary. */
export function normalizeProviderId(value: string): string {
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized.length === 0 || !/^[a-z0-9][a-z0-9._-]*$/u.test(normalized)) {
    throw new Error("Provider id must contain only letters, numbers, dots, underscores, or hyphens");
  }
  return normalized;
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
  const separator = selector.indexOf(":");
  const parsed = parseModelSelector(selector);
  // Provider ids are case-insensitive in the CLI and catalog. Preserve
  // unqualified selectors for compatibility with injected/test models.
  return separator < 0 ? selector : `${parsed.provider}:${parsed.model}`;
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
  if (message.reasoning !== undefined && message.reasoning.length > 0) {
    content.push({ type: "thinking", thinking: message.reasoning });
  }
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
    stopReason: message.interrupted
      ? "aborted"
      : message.toolCalls.length > 0
        ? "toolUse"
        : "stop",
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

/** Make cancellation authoritative even when a provider ignores its signal. */
function raceAbort<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return pending;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function closeIterator(
  iterator: AsyncIterator<AssistantMessageEvent> | undefined,
): Promise<void> {
  if (iterator === undefined) return;
  try {
    await iterator.return?.();
  } catch {
    // Preserve the provider/cancellation error if cleanup itself fails.
  }
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
