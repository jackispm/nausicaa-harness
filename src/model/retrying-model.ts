import type {
  ModelCapabilities,
  ModelPort,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "../domain/ports.js";
import { ProviderModelError } from "./provider-error.js";

const MAX_ATTEMPTS = 10;
const MAX_DELAY_MS = 60_000;
const TRANSIENT_CATEGORIES = new Set([
  "network",
  "rate-limit",
  "server",
  "timeout",
  "transient",
]);

export interface RetryingModelPortOptions {
  /** Includes the initial request. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

/**
 * Default provider retry policy for the runtime's model boundary.
 *
 * Pi's coding-agent defaults to three retries with a two-second exponential
 * backoff. `maxAttempts` includes the initial request, so four attempts match
 * that contract while keeping the policy bounded by this adapter.
 */
export const DEFAULT_MODEL_RETRY_OPTIONS = {
  maxAttempts: 4,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
} as const satisfies Pick<RetryingModelPortOptions, "maxAttempts" | "baseDelayMs" | "maxDelayMs">;

/**
 * Apply the runtime's default retry boundary exactly once.
 *
 * Provider-specific surfaces (catalog and authentication) remain on the
 * underlying adapter; callers should retain that adapter for those concerns
 * and pass this ModelPort only to execution boundaries.
 */
export function withDefaultModelRetries(
  delegate: ModelPort,
  overrides: Partial<RetryingModelPortOptions> = {},
): RetryingModelPort {
  if (delegate instanceof RetryingModelPort) return delegate;
  return new RetryingModelPort(delegate, {
    ...DEFAULT_MODEL_RETRY_OPTIONS,
    ...overrides,
  });
}

/** Explicit retry boundary. Keep budget metering inside this decorator. */
export class RetryingModelPort implements ModelPort {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  readonly capabilities?: (model: string) => ModelCapabilities;
  readonly stream?: (request: ModelRequest) => AsyncIterable<ModelStreamEvent>;

  constructor(
    private readonly delegate: ModelPort,
    options: RetryingModelPortOptions,
  ) {
    assertIntegerInRange(options.maxAttempts, 1, MAX_ATTEMPTS, "maxAttempts");
    assertFiniteInRange(options.baseDelayMs, 0, MAX_DELAY_MS, "baseDelayMs");
    assertFiniteInRange(options.maxDelayMs, 0, MAX_DELAY_MS, "maxDelayMs");
    if (options.baseDelayMs > options.maxDelayMs) {
      throw new RangeError("baseDelayMs cannot exceed maxDelayMs");
    }
    this.maxAttempts = options.maxAttempts;
    this.baseDelayMs = options.baseDelayMs;
    this.maxDelayMs = options.maxDelayMs;
    this.sleep = options.sleep ?? abortableSleep;
    this.random = options.random ?? Math.random;
    if (delegate.capabilities !== undefined) {
      this.capabilities = (model) => delegate.capabilities!(model);
    }
    if (delegate.stream !== undefined) {
      this.stream = (request) => this.retryStream(request);
    }
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    for (let attempt = 1; ; attempt += 1) {
      throwIfAborted(request.signal);
      try {
        // Do not wait for a provider that ignores AbortSignal.  The caller's
        // cancellation must release this retry boundary even if the provider
        // promise never settles.
        const response = await raceAbort(
          this.delegate.complete(request),
          request.signal,
        );
        // A provider may ignore AbortSignal and resolve after cancellation.
        // Never let that late result cross the retry boundary.
        throwIfAborted(request.signal);
        return response;
      } catch (error: unknown) {
        if (!this.canRetry(error, attempt, request.signal)) throw error;
        await this.waitBeforeRetry(error, attempt, request.signal);
      }
    }
  }

  private async *retryStream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const stream = this.delegate.stream!;
    for (let attempt = 1; ; attempt += 1) {
      if (request.signal?.aborted) {
        yield { type: "error", error: abortError(request.signal) };
        return;
      }

      const buffered: ModelStreamEvent[] = [];
      let deltaPublished = false;
      let terminalError: Error | undefined;
      let iterator: AsyncIterator<ModelStreamEvent> | undefined;
      try {
        iterator = stream.call(this.delegate, request)[Symbol.asyncIterator]();
        while (true) {
          const next = await raceAbort(iterator.next(), request.signal);
          if (next.done) break;
          const event = next.value;
          // Providers are not required to stop their iterator immediately
          // after abort. Treat any late event as cancellation and discard it.
          if (request.signal?.aborted) {
            terminalError = abortError(request.signal);
            void closeIterator(iterator);
            break;
          }
          if (event.type === "error") {
            terminalError = event.error;
            void closeIterator(iterator);
            break;
          }

          if (isNonEmptyDelta(event)) {
            for (const pending of buffered) yield pending;
            buffered.length = 0;
            deltaPublished = true;
            yield event;
            continue;
          }

          if (deltaPublished || event.type === "done") {
            for (const pending of buffered) yield pending;
            buffered.length = 0;
            yield event;
            if (event.type === "done") return;
          } else {
            buffered.push(event);
          }
        }
      } catch (error: unknown) {
        terminalError = asError(error);
        void closeIterator(iterator);
      }

      terminalError ??= new Error("Model stream ended without a final response");
      if (!deltaPublished && this.canRetry(terminalError, attempt, request.signal)) {
        try {
          await this.waitBeforeRetry(terminalError, attempt, request.signal);
        } catch (error: unknown) {
          yield { type: "error", error: asError(error) };
          return;
        }
        continue;
      }

      for (const pending of buffered) yield pending;
      yield {
        type: "error",
        error: request.signal?.aborted
          ? abortError(request.signal)
          : terminalError,
      };
      return;
    }
  }

  private canRetry(
    error: unknown,
    attempt: number,
    signal: AbortSignal | undefined,
  ): error is ProviderModelError {
    return !signal?.aborted
      && attempt < this.maxAttempts
      && error instanceof ProviderModelError
      && error.retryable
      && TRANSIENT_CATEGORIES.has(error.category)
      && retryAfterFits(error.retryAfterMs, this.maxDelayMs);
  }

  private async waitBeforeRetry(
    error: ProviderModelError,
    attempt: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const delayMs = error.retryAfterMs ?? this.backoffDelay(attempt);
    await raceAbort(this.sleep(delayMs, signal), signal);
  }

  private backoffDelay(attempt: number): number {
    const jitter = 0.75 + clampRandom(this.random()) * 0.25;
    return Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1)) * jitter;
  }
}

function isNonEmptyDelta(event: ModelStreamEvent): boolean {
  return (event.type === "text-delta" || event.type === "thinking-delta")
    && event.delta.length > 0;
}

function clampRandom(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function retryAfterFits(value: number | undefined, maximum: number): boolean {
  return value === undefined
    || (Number.isFinite(value) && value >= 0 && value <= maximum);
}

function assertIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

function assertFiniteInRange(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError(signal!));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    }).catch(() => undefined);
  });
}

async function closeIterator(
  iterator: AsyncIterator<ModelStreamEvent> | undefined,
): Promise<void> {
  if (iterator === undefined) return;
  try {
    await iterator.return?.();
  } catch {
    // The terminal model error remains authoritative if iterator cleanup fails.
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
