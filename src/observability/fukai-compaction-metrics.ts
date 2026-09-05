import type { AnyEvent } from "../domain/events.js";
import type { LaneId, TokenUsage } from "../domain/types.js";
import {
  FukaiCompactionTimeoutError,
} from "../fukai/compaction-provider.js";
import type {
  FukaiCompactionProvider,
  FukaiCompactionRequest,
  FukaiCompactionSelection,
} from "../fukai/types.js";
import type { LatencyStats } from "./run-metrics.js";

export type FukaiCompactionProviderStatus =
  | "completed"
  | "failed"
  | "timed-out"
  | "cancelled";

export interface FukaiCompactionProviderObservation {
  attemptId: string;
  runId: string;
  laneId: LaneId;
  status: FukaiCompactionProviderStatus;
  budget: {
    maxInputTokens: number;
    maxOutputTokens: number;
    maxWallClockMs: number;
  };
  elapsedMs: number;
  /** Actual provider usage when the adapter can expose it; otherwise absent. */
  usage?: TokenUsage;
  /** Estimated size of a successful structured summary. */
  estimatedOutputTokens?: number;
  summaryBytes?: number;
}

export interface FukaiCompactionStatusMetrics {
  completed: number;
  failed: number;
  timedOut: number;
  cancelled: number;
}

export interface FukaiCompactionBudgetMetrics {
  calls: number;
  allocatedInputTokens: number;
  allocatedOutputTokens: number;
  allocatedWallClockMs: number;
  peakInputTokens: number;
  peakOutputTokens: number;
  peakWallClockMs: number;
}

export interface FukaiCompactionUsageMetrics {
  knownCalls: number;
  unknownCalls: number;
  total: TokenUsage;
}

export interface FukaiCompactionFallbackMetrics {
  total: number;
  budgetExhausted: number;
  stale: number;
  verificationFailed: number;
  preflight: number;
  commit: number;
  readBack: number;
}

/** Request-time compaction selections reconstructed from ContextManifest. */
export interface FukaiCompactionContextMetrics {
  /** Model requests carrying a schema-v1 ContextManifest. */
  knownRequests: number;
  /** Legacy or non-Main requests without a ContextManifest. */
  unknownRequests: number;
  emptySelections: number;
  readySelections: number;
  /** Stale capsules deliberately omitted from the model context. */
  staleFallbacks: number;
  /** Estimated summary tokens actually selected into ready model requests. */
  injectedSummaryTokens: number;
}

export interface FukaiCompactionMetricSummary {
  providerCalls: number;
  providerStatus: FukaiCompactionStatusMetrics;
  providerLatency: LatencyStats;
  budget: FukaiCompactionBudgetMetrics;
  usage: FukaiCompactionUsageMetrics;
  context: FukaiCompactionContextMetrics;
  fallbacks: FukaiCompactionFallbackMetrics;
  selectedOutputTokens: number;
  selectedSummaryBytes: number;
  committedCompactions: number;
  committedOutputTokens: number;
  committedSummaryBytes: number;
}

export interface FukaiCompactionLaneMetrics extends FukaiCompactionMetricSummary {
  laneId: LaneId;
}

export interface FukaiCompactionMetrics {
  runId: string;
  /** Number of run events inspected, including non-compaction facts. */
  eventCount: number;
  /** Unique transient observations used to supplement absent durable facts. */
  observationCount: number;
  lanes: Record<LaneId, FukaiCompactionLaneMetrics>;
  total: FukaiCompactionMetricSummary;
}

export interface MeteredFukaiCompactionProviderOptions {
  provider: FukaiCompactionProvider;
  now?: () => number;
  /** Supplies the coordinator's deterministic lifecycle identity for this call. */
  attemptIdForRequest: (request: FukaiCompactionRequest) => string;
  /** Reads actual usage from a provider-specific result when it is available. */
  usageFromSelection?: (
    selection: FukaiCompactionSelection,
  ) => TokenUsage | undefined;
}

/**
 * Opt-in decorator for a physical compaction provider call. Constructing it
 * and reading its snapshot perform no provider or model requests.
 */
export class MeteredFukaiCompactionProvider implements FukaiCompactionProvider {
  readonly #provider: FukaiCompactionProvider;
  readonly #now: () => number;
  readonly #attemptIdForRequest: (request: FukaiCompactionRequest) => string;
  readonly #usageFromSelection: ((
    selection: FukaiCompactionSelection,
  ) => TokenUsage | undefined) | undefined;
  readonly #observations: FukaiCompactionProviderObservation[] = [];

  constructor(options: MeteredFukaiCompactionProviderOptions) {
    if (options.provider === null || typeof options.provider?.compact !== "function") {
      throw new TypeError("Fukai compaction provider must provide compact");
    }
    if (typeof options.attemptIdForRequest !== "function") {
      throw new TypeError("Fukai compaction metrics require an attempt identity resolver");
    }
    this.#provider = options.provider;
    this.#now = options.now ?? Date.now;
    this.#attemptIdForRequest = options.attemptIdForRequest;
    this.#usageFromSelection = options.usageFromSelection;
  }

  async compact(request: FukaiCompactionRequest): Promise<FukaiCompactionSelection> {
    const attemptId = requireAttemptId(this.#attemptIdForRequest(request));
    const startedAt = this.#now();
    try {
      const selection = await this.#provider.compact(request);
      const usage = safelyReadUsage(this.#usageFromSelection, selection);
      this.#observations.push({
        attemptId,
        runId: request.runId,
        laneId: request.laneId,
        status: "completed",
        budget: { ...request.budget },
        elapsedMs: elapsed(startedAt, this.#now()),
        ...(usage === undefined ? {} : { usage }),
        estimatedOutputTokens: selection.capsule.estimatedTokens,
        summaryBytes: selection.capsule.summaryRef.byteLength,
      });
      return selection;
    } catch (error: unknown) {
      this.#observations.push({
        attemptId,
        runId: request.runId,
        laneId: request.laneId,
        status: providerStatus(error, request.signal),
        budget: { ...request.budget },
        elapsedMs: elapsed(startedAt, this.#now()),
      });
      throw error;
    }
  }

  snapshot(): FukaiCompactionProviderObservation[] {
    return this.#observations.map(cloneObservation);
  }
}

export function createMeteredFukaiCompactionProvider(
  options: MeteredFukaiCompactionProviderOptions,
): MeteredFukaiCompactionProvider {
  return new MeteredFukaiCompactionProvider(options);
}

/** Durable lifecycle facts are authoritative; observations only backfill old logs. */
export function projectFukaiCompactionMetrics(
  events: readonly AnyEvent[],
  runId: string,
  observations: readonly FukaiCompactionProviderObservation[] = [],
): FukaiCompactionMetrics {
  const runEvents = uniqueEvents(events.filter((event) => event.runId === runId))
    .sort((left, right) => left.globalOffset - right.globalOffset);
  const candidateObservations = uniqueObservations(observations)
    .filter((observation) => observation.runId === runId);
  const attempts = projectAttempts(runEvents, candidateObservations);
  const usedObservations = attempts.flatMap((attempt) => (
    attempt.observationUsed && attempt.observation !== undefined
      ? [attempt.observation]
      : []
  ));
  const laneIds = new Set<LaneId>();
  for (const attempt of attempts) laneIds.add(attempt.laneId);
  for (const event of runEvents) {
    if (
      event.type === "fukai.compaction.committed"
      || event.type === "fukai.compaction.fallback"
      || event.type === "model.requested"
    ) {
      laneIds.add(event.laneId);
    }
  }
  const commitEvents = uniqueCompactionCommits(runEvents.filter(isCompactionCommit));
  const fallbackEvents = runEvents.filter(isCompactionFallback);
  const modelRequestEvents = runEvents.filter(
    (event): event is Extract<AnyEvent, { type: "model.requested" }> =>
      event.type === "model.requested",
  );

  const lanes = Object.fromEntries([...laneIds].map((laneId) => [
    laneId,
    summarizeLane(
      attempts.filter((attempt) => attempt.laneId === laneId),
      commitEvents.filter((event) => event.laneId === laneId),
      fallbackEvents.filter((event) => event.laneId === laneId),
      modelRequestEvents.filter((event) => event.laneId === laneId),
      laneId,
    ),
  ]));

  return {
    runId,
    eventCount: runEvents.length,
    observationCount: usedObservations.length,
    lanes,
    total: summarize(
      attempts,
      commitEvents,
      fallbackEvents,
      modelRequestEvents,
    ),
  };
}

function summarize(
  attempts: readonly ProviderAttemptMetrics[],
  commits: readonly Extract<AnyEvent, { type: "fukai.compaction.committed" }>[],
  fallbacks: readonly Extract<AnyEvent, { type: "fukai.compaction.fallback" }>[],
  requests: readonly Extract<AnyEvent, { type: "model.requested" }>[],
): FukaiCompactionMetricSummary {
  const latencies = attempts.flatMap((attempt) => {
    const value = attemptElapsedMs(attempt);
    return value === undefined ? [] : [value];
  });
  const knownUsage = attempts.flatMap((attempt) => {
    const usage = attemptUsage(attempt);
    return usage === undefined ? [] : [usage];
  });
  const completed = attempts.filter((attempt) => attemptStatus(attempt) === "completed");
  return {
    providerCalls: attempts.length,
    providerStatus: statusMetrics(attempts),
    providerLatency: latencyStats(latencies),
    budget: budgetMetrics(attempts),
    usage: {
      knownCalls: knownUsage.length,
      unknownCalls: attempts.length - knownUsage.length,
      total: knownUsage.reduce(addUsage, emptyUsage()),
    },
    context: contextMetrics(requests),
    fallbacks: fallbackMetrics(fallbacks),
    selectedOutputTokens: completed.reduce(
      (sum, attempt) => sum + (attemptOutputTokens(attempt) ?? 0),
      0,
    ),
    selectedSummaryBytes: completed.reduce(
      (sum, attempt) => sum + (attemptSummaryBytes(attempt) ?? 0),
      0,
    ),
    committedCompactions: commits.length,
    committedOutputTokens: commits.reduce(
      (sum, event) => sum + event.payload.estimatedTokens,
      0,
    ),
    committedSummaryBytes: commits.reduce(
      (sum, event) => sum + event.payload.summaryRef.byteLength,
      0,
    ),
  };
}

function summarizeLane(
  attempts: readonly ProviderAttemptMetrics[],
  commits: readonly Extract<AnyEvent, { type: "fukai.compaction.committed" }>[],
  fallbacks: readonly Extract<AnyEvent, { type: "fukai.compaction.fallback" }>[],
  requests: readonly Extract<AnyEvent, { type: "model.requested" }>[],
  laneId: LaneId,
): FukaiCompactionLaneMetrics {
  return { laneId, ...summarize(attempts, commits, fallbacks, requests) };
}

type CompactionRequestedEvent = Extract<AnyEvent, { type: "fukai.compaction.requested" }>;
type CompactionCompletedEvent = Extract<AnyEvent, { type: "fukai.compaction.completed" }>;
type CompactionFailedEvent = Extract<AnyEvent, { type: "fukai.compaction.failed" }>;
type CompactionTerminalEvent = CompactionCompletedEvent | CompactionFailedEvent;

interface ProviderAttemptMetrics {
  attemptId: string;
  laneId: LaneId;
  requested?: CompactionRequestedEvent;
  terminal?: CompactionTerminalEvent;
  observation?: FukaiCompactionProviderObservation;
  observationUsed: boolean;
}

function projectAttempts(
  events: readonly AnyEvent[],
  observations: readonly FukaiCompactionProviderObservation[],
): ProviderAttemptMetrics[] {
  const attempts = new Map<string, ProviderAttemptMetrics>();
  const ensure = (laneId: LaneId, attemptId: string): ProviderAttemptMetrics => {
    const key = `${laneId}\0${attemptId}`;
    const existing = attempts.get(key);
    if (existing !== undefined) return existing;
    const created: ProviderAttemptMetrics = {
      attemptId,
      laneId,
      observationUsed: false,
    };
    attempts.set(key, created);
    return created;
  };

  for (const event of events) {
    if (event.type === "fukai.compaction.requested") {
      const attempt = ensure(event.laneId, event.payload.attemptId);
      attempt.requested ??= event;
    } else if (
      event.type === "fukai.compaction.completed"
      || event.type === "fukai.compaction.failed"
    ) {
      const attempt = ensure(event.laneId, event.payload.attemptId);
      attempt.terminal ??= event;
    }
  }

  for (const observation of observations) {
    const attempt = ensure(observation.laneId, observation.attemptId);
    attempt.observation = observation;
    attempt.observationUsed = attempt.requested === undefined || attempt.terminal === undefined;
  }
  return [...attempts.values()];
}

function attemptStatus(
  attempt: ProviderAttemptMetrics,
): FukaiCompactionProviderStatus | undefined {
  if (attempt.terminal?.type === "fukai.compaction.completed") return "completed";
  if (attempt.terminal?.type === "fukai.compaction.failed") {
    return attempt.terminal.payload.status;
  }
  return attempt.observation?.status;
}

function attemptElapsedMs(attempt: ProviderAttemptMetrics): number | undefined {
  return attempt.terminal?.payload.elapsedMs ?? attempt.observation?.elapsedMs;
}

function attemptUsage(attempt: ProviderAttemptMetrics): TokenUsage | undefined {
  if (attempt.terminal !== undefined) return attempt.terminal.payload.usage ?? undefined;
  return attempt.observation?.usage;
}

function attemptBudget(
  attempt: ProviderAttemptMetrics,
): FukaiCompactionProviderObservation["budget"] | undefined {
  return attempt.requested?.payload.budget ?? attempt.observation?.budget;
}

function attemptOutputTokens(attempt: ProviderAttemptMetrics): number | undefined {
  return attempt.terminal?.type === "fukai.compaction.completed"
    ? attempt.terminal.payload.estimatedTokens
    : attempt.observation?.estimatedOutputTokens;
}

function attemptSummaryBytes(attempt: ProviderAttemptMetrics): number | undefined {
  return attempt.terminal?.type === "fukai.compaction.completed"
    ? attempt.terminal.payload.summaryRef.byteLength
    : attempt.observation?.summaryBytes;
}

function isCompactionCommit(
  event: AnyEvent,
): event is Extract<AnyEvent, { type: "fukai.compaction.committed" }> {
  return event.type === "fukai.compaction.committed";
}

function isCompactionFallback(
  event: AnyEvent,
): event is Extract<AnyEvent, { type: "fukai.compaction.fallback" }> {
  return event.type === "fukai.compaction.fallback";
}

function uniqueCompactionCommits(
  events: readonly Extract<AnyEvent, { type: "fukai.compaction.committed" }>[],
): Extract<AnyEvent, { type: "fukai.compaction.committed" }>[] {
  const unique = new Map<string, Extract<AnyEvent, { type: "fukai.compaction.committed" }>>();
  for (const event of events) {
    const key = `${event.laneId}\0${event.payload.compactionId}`;
    if (!unique.has(key)) unique.set(key, event);
  }
  return [...unique.values()];
}

function uniqueEvents(events: readonly AnyEvent[]): AnyEvent[] {
  const unique = new Map<string, AnyEvent>();
  for (const event of events) {
    const key = `${event.laneId}\0${event.type}\0${event.idempotencyKey}`;
    if (!unique.has(key)) unique.set(key, event);
  }
  return [...unique.values()];
}

function fallbackMetrics(
  events: readonly Extract<AnyEvent, { type: "fukai.compaction.fallback" }>[],
): FukaiCompactionFallbackMetrics {
  const result: FukaiCompactionFallbackMetrics = {
    total: 0,
    budgetExhausted: 0,
    stale: 0,
    verificationFailed: 0,
    preflight: 0,
    commit: 0,
    readBack: 0,
  };
  for (const event of events) {
    result.total += 1;
    if (event.payload.reason === "budget-exhausted") result.budgetExhausted += 1;
    else if (event.payload.reason === "stale") result.stale += 1;
    else result.verificationFailed += 1;
    if (event.payload.phase === "read-back") result.readBack += 1;
    else result[event.payload.phase] += 1;
  }
  return result;
}

function contextMetrics(
  requests: readonly Extract<AnyEvent, { type: "model.requested" }>[],
): FukaiCompactionContextMetrics {
  const result: FukaiCompactionContextMetrics = {
    knownRequests: 0,
    unknownRequests: 0,
    emptySelections: 0,
    readySelections: 0,
    staleFallbacks: 0,
    injectedSummaryTokens: 0,
  };
  for (const request of requests) {
    const slot = request.payload.contextManifest?.slots.compaction;
    if (slot === undefined) {
      result.unknownRequests += 1;
      continue;
    }
    result.knownRequests += 1;
    if (slot.status === "none") {
      result.emptySelections += 1;
    } else if (slot.status === "ready") {
      result.readySelections += 1;
      result.injectedSummaryTokens += slot.estimatedTokens;
    } else {
      result.staleFallbacks += 1;
    }
  }
  return result;
}

function statusMetrics(
  attempts: readonly ProviderAttemptMetrics[],
): FukaiCompactionStatusMetrics {
  const result: FukaiCompactionStatusMetrics = {
    completed: 0,
    failed: 0,
    timedOut: 0,
    cancelled: 0,
  };
  for (const attempt of attempts) {
    const status = attemptStatus(attempt);
    if (status === undefined) continue;
    if (status === "timed-out") result.timedOut += 1;
    else result[status] += 1;
  }
  return result;
}

function budgetMetrics(
  attempts: readonly ProviderAttemptMetrics[],
): FukaiCompactionBudgetMetrics {
  const budgets = attempts.flatMap((attempt) => {
    const budget = attemptBudget(attempt);
    return budget === undefined ? [] : [budget];
  });
  const result: FukaiCompactionBudgetMetrics = {
    calls: budgets.length,
    allocatedInputTokens: 0,
    allocatedOutputTokens: 0,
    allocatedWallClockMs: 0,
    peakInputTokens: 0,
    peakOutputTokens: 0,
    peakWallClockMs: 0,
  };
  for (const budget of budgets) {
    result.allocatedInputTokens += budget.maxInputTokens;
    result.allocatedOutputTokens += budget.maxOutputTokens;
    result.allocatedWallClockMs += budget.maxWallClockMs;
    result.peakInputTokens = Math.max(result.peakInputTokens, budget.maxInputTokens);
    result.peakOutputTokens = Math.max(result.peakOutputTokens, budget.maxOutputTokens);
    result.peakWallClockMs = Math.max(result.peakWallClockMs, budget.maxWallClockMs);
  }
  return result;
}

function latencyStats(values: readonly number[]): LatencyStats {
  if (values.length === 0) {
    return { count: 0, totalMs: 0, p50Ms: 0, p95Ms: 0 };
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    totalMs: sorted.reduce((sum, value) => sum + value, 0),
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

function percentile(sorted: readonly number[], quantile: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function providerStatus(
  error: unknown,
  signal: AbortSignal | undefined,
): FukaiCompactionProviderStatus {
  if (error instanceof FukaiCompactionTimeoutError || errorName(error) === "TimeoutError") {
    return "timed-out";
  }
  if (signal?.aborted || errorName(error) === "AbortError") return "cancelled";
  return "failed";
}

function errorName(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "name" in error
    && typeof error.name === "string"
    ? error.name
    : undefined;
}

function safelyReadUsage(
  readUsage: MeteredFukaiCompactionProviderOptions["usageFromSelection"],
  selection: FukaiCompactionSelection,
): TokenUsage | undefined {
  if (readUsage === undefined) return undefined;
  try {
    const usage = readUsage(selection);
    return usage === undefined || !validUsage(usage) ? undefined : { ...usage };
  } catch {
    return undefined;
  }
}

function requireAttemptId(attemptId: string): string {
  if (typeof attemptId !== "string" || attemptId.length === 0 || attemptId.includes("\0")) {
    throw new TypeError("Fukai compaction attempt ID must be non-empty");
  }
  return attemptId;
}

function validUsage(usage: TokenUsage): boolean {
  return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
    .every((value) => Number.isFinite(value) && value >= 0)
    && (usage.costUsd === undefined
      || (Number.isFinite(usage.costUsd) && usage.costUsd >= 0));
}

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  const hasCost = left.costUsd !== undefined || right.costUsd !== undefined;
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    ...(hasCost ? { costUsd: (left.costUsd ?? 0) + (right.costUsd ?? 0) } : {}),
  };
}

function elapsed(startedAt: number, completedAt: number): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return 0;
  return Math.max(0, completedAt - startedAt);
}

function uniqueObservations(
  observations: readonly FukaiCompactionProviderObservation[],
): FukaiCompactionProviderObservation[] {
  const unique = new Map<string, FukaiCompactionProviderObservation>();
  for (const observation of observations) {
    const key = `${observation.runId}\0${observation.laneId}\0${observation.attemptId}`;
    if (!unique.has(key)) unique.set(key, cloneObservation(observation));
  }
  return [...unique.values()];
}

function cloneObservation(
  observation: FukaiCompactionProviderObservation,
): FukaiCompactionProviderObservation {
  return {
    ...observation,
    budget: { ...observation.budget },
    ...(observation.usage === undefined ? {} : { usage: { ...observation.usage } }),
  };
}
