import type { AnyEvent } from "../domain/events.js";
import type {
  CacheOutcome,
  LaneId,
  TokenUsage,
} from "../domain/types.js";

export interface LatencyStats {
  count: number;
  totalMs: number;
  p50Ms: number;
  p95Ms: number;
}

export interface CacheMetrics {
  total: number;
  hit: number;
  write: number;
  hitWrite: number;
  unknown: number;
  known: number;
  hitRate: number;
  writeRate: number;
  /** Number of model requests that carried a stable prompt/tool prefix hash. */
  prefixSamples: number;
  /** Distinct prefix hashes observed by this lane. */
  uniquePrefixes: number;
  /** Adjacent prefix changes; high churn can reduce provider cache reuse. */
  prefixChanges: number;
  /** Fraction of adjacent samples that kept the same stable prefix. */
  stablePrefixRate: number;
}

export interface AdviceMetrics {
  total: number;
  accept: number;
  defer: number;
  reject: number;
  pending: number;
}

export interface LaneRunMetrics {
  laneId: LaneId;
  modelRequests: number;
  modelCompletions: number;
  modelFailures: number;
  usage: TokenUsage;
  /** Usage explicitly charged by the runtime budget ledger. */
  chargedUsage: TokenUsage;
  /** Usage reported by model/teto completion events, before budget fallback. */
  modelUsage: TokenUsage;
  contextBuild: LatencyStats;
  modelLatency: LatencyStats;
  cache: CacheMetrics;
  tetoPasses: number;
  advice: AdviceMetrics;
}

export interface RunMetrics {
  runId: string;
  eventCount: number;
  durationMs: number;
  lanes: Record<LaneId, LaneRunMetrics>;
  total: LaneRunMetrics;
  advice: AdviceMetrics;
  toolCalls: number;
  toolFailures: number;
  unknownOperations: number;
  checkpoints: number;
  cacheReadRatio: number;
}

interface MutableLaneMetrics {
  laneId: LaneId;
  modelRequests: number;
  modelCompletions: number;
  modelFailures: number;
  chargedUsage: TokenUsage;
  modelUsage: TokenUsage;
  usageCharges: UsageFact[];
  usageTerminals: UsageFact[];
  contextBuildMs: number[];
  modelLatencyMs: number[];
  cacheOutcomes: CacheOutcome[];
  prefixObservations: PrefixObservation[];
  tetoPasses: number;
  advice: AdviceMetrics;
  budgetEvents: number;
}

interface UsageFact {
  callKey?: string;
  usage: TokenUsage;
}

interface PrefixObservation {
  hash: string;
  laneId: LaneId;
  globalOffset: number;
}

const emptyUsage = (): TokenUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

const emptyAdvice = (): AdviceMetrics => ({
  total: 0,
  accept: 0,
  defer: 0,
  reject: 0,
  pending: 0,
});

const emptyCache = (): CacheMetrics => ({
  total: 0,
  hit: 0,
  write: 0,
  hitWrite: 0,
  unknown: 0,
  known: 0,
  hitRate: 0,
  writeRate: 0,
  prefixSamples: 0,
  uniquePrefixes: 0,
  prefixChanges: 0,
  stablePrefixRate: 0,
});

const emptyLatency = (): LatencyStats => ({
  count: 0,
  totalMs: 0,
  p50Ms: 0,
  p95Ms: 0,
});

/**
 * Project immutable run facts into compact performance metrics. This reducer
 * never reads stores or mutates events, so it is safe to use on a replayed
 * ledger prefix or a complete run.
 */
export function projectRunMetrics(
  events: readonly AnyEvent[],
  runId: string,
): RunMetrics {
  const lanes = new Map<LaneId, MutableLaneMetrics>();
  const adviceById = new Map<string, LaneId>();
  const acknowledgedAdvice = new Set<string>();
  const requestedOperations = new Set<string>();
  const terminalOperations = new Set<string>();
  let toolCalls = 0;
  let toolFailures = 0;
  let checkpoints = 0;
  let firstTime: number | undefined;
  let lastTime: number | undefined;

  const lane = (laneId: LaneId): MutableLaneMetrics => {
    const existing = lanes.get(laneId);
    if (existing !== undefined) return existing;
    const created: MutableLaneMetrics = {
      laneId,
      modelRequests: 0,
      modelCompletions: 0,
      modelFailures: 0,
      chargedUsage: emptyUsage(),
      modelUsage: emptyUsage(),
      usageCharges: [],
      usageTerminals: [],
      contextBuildMs: [],
      modelLatencyMs: [],
      cacheOutcomes: [],
      prefixObservations: [],
      tetoPasses: 0,
      advice: emptyAdvice(),
      budgetEvents: 0,
    };
    lanes.set(laneId, created);
    return created;
  };

  const ordered = events
    .filter((event) => event.runId === runId)
    .slice()
    .sort((left, right) => left.globalOffset - right.globalOffset);

  for (const event of ordered) {
    const timestamp = Date.parse(event.occurredAt);
    if (Number.isFinite(timestamp)) {
      firstTime = firstTime === undefined ? timestamp : Math.min(firstTime, timestamp);
      lastTime = lastTime === undefined ? timestamp : Math.max(lastTime, timestamp);
    }
    const current = lane(event.laneId);
    switch (event.type) {
      case "model.requested":
        current.modelRequests += 1;
        if (event.payload.prefixHash !== undefined) {
          current.prefixObservations.push({
            hash: event.payload.prefixHash,
            laneId: event.laneId,
            globalOffset: event.globalOffset,
          });
        }
        if (event.payload.contextBuildMs !== undefined) {
          current.contextBuildMs.push(event.payload.contextBuildMs);
        }
        break;
      case "model.completed":
        current.modelCompletions += 1;
        current.modelUsage = addUsage(current.modelUsage, event.payload.usage);
        current.usageTerminals.push(usageFact(
          event.idempotencyKey,
          ":model:completed",
          event.payload.usage,
        ));
        if (event.payload.modelLatencyMs !== undefined) {
          current.modelLatencyMs.push(event.payload.modelLatencyMs);
        }
        current.cacheOutcomes.push(
          event.payload.cacheOutcome ?? inferCacheOutcome(event.payload.usage),
        );
        break;
      case "model.failed":
        current.modelFailures += 1;
        break;
      case "budget.charged":
        current.budgetEvents += 1;
        current.chargedUsage = addUsage(current.chargedUsage, event.payload.usage);
        current.usageCharges.push(usageFact(
          event.idempotencyKey,
          ":budget",
          event.payload.usage,
        ));
        break;
      case "teto.observed":
        current.tetoPasses += 1;
        current.modelUsage = addUsage(current.modelUsage, event.payload.usage);
        current.usageTerminals.push(usageFact(
          event.idempotencyKey,
          ":observed",
          event.payload.usage,
        ));
        break;
      case "reflection.observed":
        current.modelUsage = addUsage(current.modelUsage, event.payload.usage);
        current.usageTerminals.push(usageFact(
          event.idempotencyKey,
          ":observed",
          event.payload.usage,
        ));
        break;
      case "tool.requested":
        toolCalls += 1;
        requestedOperations.add(event.payload.operationId);
        break;
      case "tool.succeeded":
        terminalOperations.add(event.payload.operationId);
        break;
      case "tool.failed":
        terminalOperations.add(event.payload.operationId);
        toolFailures += 1;
        break;
      case "message.sent":
        if (event.payload.message.payload.type === "advice.propose") {
          const advice = event.payload.message.payload.advice;
          adviceById.set(advice.adviceId, event.payload.message.from);
          lane(event.payload.message.from).advice.total += 1;
          lane(event.payload.message.from).advice.pending += 1;
        }
        break;
      case "advice.acknowledged": {
        const sourceLane = adviceById.get(event.payload.adviceId);
        const adviceMetrics = lane(sourceLane ?? event.laneId).advice;
        if (!acknowledgedAdvice.has(event.payload.adviceId)) {
          acknowledgedAdvice.add(event.payload.adviceId);
          if (adviceMetrics.pending > 0) adviceMetrics.pending -= 1;
          adviceMetrics[event.payload.disposition] += 1;
        }
        break;
      }
      case "checkpoint.committed":
        checkpoints += 1;
        break;
      default:
        break;
    }
  }

  const materialized = new Map<LaneId, LaneRunMetrics>();
  for (const [laneId, item] of lanes) {
    materialized.set(laneId, finalizeLane(item));
  }
  const laneValues = [...materialized.values()];
  const mergedTotal = finalizeLane(mergeMutableLanes("total", [...lanes.values()]));
  const total: LaneRunMetrics = {
    ...mergedTotal,
    usage: laneValues.reduce(
      (sum, item) => addUsage(sum, item.usage),
      emptyUsage(),
    ),
  };
  const advice = laneValues.reduce((sum, item) => mergeAdvice(sum, item.advice), emptyAdvice());
  const cacheTokens = total.usage.input + total.usage.cacheRead + total.usage.cacheWrite;
  return {
    runId,
    eventCount: ordered.length,
    durationMs: firstTime === undefined || lastTime === undefined
      ? 0
      : Math.max(0, lastTime - firstTime),
    lanes: Object.fromEntries(materialized.entries()),
    total,
    advice,
    toolCalls,
    toolFailures,
    unknownOperations: [...requestedOperations]
      .filter((operationId) => !terminalOperations.has(operationId)).length,
    checkpoints,
    cacheReadRatio: cacheTokens === 0 ? 0 : total.usage.cacheRead / cacheTokens,
  };
}

function finalizeLane(item: MutableLaneMetrics): LaneRunMetrics {
  const cache = cacheMetrics(item.cacheOutcomes, item.prefixObservations);
  const chargedUsage = item.chargedUsage;
  const usage = billableUsage(item.usageCharges, item.usageTerminals);
  return {
    laneId: item.laneId,
    modelRequests: item.modelRequests,
    modelCompletions: item.modelCompletions,
    modelFailures: item.modelFailures,
    usage,
    chargedUsage,
    modelUsage: item.modelUsage,
    contextBuild: latencyStats(item.contextBuildMs),
    modelLatency: latencyStats(item.modelLatencyMs),
    cache,
    tetoPasses: item.tetoPasses,
    advice: { ...item.advice },
  };
}

function mergeMutableLanes(
  laneId: LaneId,
  values: readonly MutableLaneMetrics[],
): MutableLaneMetrics {
  return {
    laneId,
    modelRequests: values.reduce((sum, item) => sum + item.modelRequests, 0),
    modelCompletions: values.reduce((sum, item) => sum + item.modelCompletions, 0),
    modelFailures: values.reduce((sum, item) => sum + item.modelFailures, 0),
    chargedUsage: values.reduce(
      (sum, item) => addUsage(sum, item.chargedUsage),
      emptyUsage(),
    ),
    modelUsage: values.reduce(
      (sum, item) => addUsage(sum, item.modelUsage),
      emptyUsage(),
    ),
    usageCharges: values.flatMap((item) => item.usageCharges),
    usageTerminals: values.flatMap((item) => item.usageTerminals),
    contextBuildMs: values.flatMap((item) => item.contextBuildMs),
    modelLatencyMs: values.flatMap((item) => item.modelLatencyMs),
    cacheOutcomes: values.flatMap((item) => item.cacheOutcomes),
    prefixObservations: values
      .flatMap((item) => item.prefixObservations)
      .sort((left, right) => left.globalOffset - right.globalOffset),
    tetoPasses: values.reduce((sum, item) => sum + item.tetoPasses, 0),
    advice: values.reduce((sum, item) => mergeAdvice(sum, item.advice), emptyAdvice()),
    budgetEvents: values.reduce((sum, item) => sum + item.budgetEvents, 0),
  };
}

function usageFact(
  idempotencyKey: string,
  suffix: string,
  usage: TokenUsage,
): UsageFact {
  return {
    ...(idempotencyKey.endsWith(suffix)
      ? { callKey: idempotencyKey.slice(0, -suffix.length) }
      : {}),
    usage,
  };
}

function billableUsage(
  charges: readonly UsageFact[],
  terminals: readonly UsageFact[],
): TokenUsage {
  let total = charges.reduce(
    (usage, fact) => addUsage(usage, fact.usage),
    emptyUsage(),
  );
  const chargedCalls = new Set(charges.flatMap((fact) => (
    fact.callKey === undefined ? [] : [fact.callKey]
  )));
  const unkeyedCharges = charges
    .filter((fact) => fact.callKey === undefined)
    .map((fact) => fact.usage);

  for (const terminal of terminals) {
    if (terminal.callKey !== undefined) {
      if (!chargedCalls.has(terminal.callKey)) {
        total = addUsage(total, terminal.usage);
      }
      continue;
    }
    const charge = unkeyedCharges.findIndex((usage) => sameUsage(usage, terminal.usage));
    if (charge >= 0) {
      unkeyedCharges.splice(charge, 1);
    } else {
      total = addUsage(total, terminal.usage);
    }
  }
  return total;
}

function sameUsage(left: TokenUsage, right: TokenUsage): boolean {
  return left.input === right.input
    && left.output === right.output
    && left.cacheRead === right.cacheRead
    && left.cacheWrite === right.cacheWrite
    && (left.costUsd ?? 0) === (right.costUsd ?? 0);
}

function mergeAdvice(left: AdviceMetrics, right: AdviceMetrics): AdviceMetrics {
  return {
    total: left.total + right.total,
    accept: left.accept + right.accept,
    defer: left.defer + right.defer,
    reject: left.reject + right.reject,
    pending: left.pending + right.pending,
  };
}

function cacheMetrics(
  outcomes: readonly CacheOutcome[],
  prefixObservations: readonly PrefixObservation[],
): CacheMetrics {
  const result = emptyCache();
  for (const outcome of outcomes) {
    result.total += 1;
    result[outcome === "hit-write" ? "hitWrite" : outcome] += 1;
  }
  result.known = result.total - result.unknown;
  result.hitRate = result.known === 0 ? 0 : (result.hit + result.hitWrite) / result.known;
  result.writeRate = result.known === 0 ? 0 : (result.write + result.hitWrite) / result.known;
  const ordered = prefixObservations
    .slice()
    .sort((left, right) => left.globalOffset - right.globalOffset);
  const previousByLane = new Map<LaneId, string>();
  let comparable = 0;
  for (const observation of ordered) {
    const previous = previousByLane.get(observation.laneId);
    if (previous !== undefined) {
      comparable += 1;
      if (previous !== observation.hash) result.prefixChanges += 1;
    }
    previousByLane.set(observation.laneId, observation.hash);
  }
  result.prefixSamples = ordered.length;
  result.uniquePrefixes = new Set(ordered.map((observation) => observation.hash)).size;
  result.stablePrefixRate = ordered.length === 0
    ? 0
    : comparable === 0
      ? 1
      : 1 - result.prefixChanges / comparable;
  return result;
}

function latencyStats(values: readonly number[]): LatencyStats {
  if (values.length === 0) return emptyLatency();
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    totalMs: sorted.reduce((sum, value) => sum + value, 0),
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

function percentile(sorted: readonly number[], quantile: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
}

function inferCacheOutcome(usage: TokenUsage): CacheOutcome {
  if (usage.cacheRead > 0 && usage.cacheWrite > 0) return "hit-write";
  if (usage.cacheRead > 0) return "hit";
  if (usage.cacheWrite > 0) return "write";
  return "unknown";
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
