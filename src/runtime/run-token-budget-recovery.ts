import type { AnyEvent, RunId, TokenUsage } from "../domain/index.js";

type UsageTerminal = Extract<AnyEvent, {
  type:
    | "model.completed"
    | "teto.observed"
    | "reflection.observed"
    | "fukai.compaction.completed"
    | "fukai.compaction.failed";
}>;

type CompactionRequested = Extract<AnyEvent, {
  type: "fukai.compaction.requested";
}>;

/** Usage recovered for one execution lane, including an uncharged crash window. */
export interface RecoveredLaneUsage {
  laneId: string;
  usage: TokenUsage;
}

const MODEL_COMPLETED_SUFFIX = ":model:completed";
const OBSERVED_SUFFIX = ":observed";
const COMPACTION_TERMINAL_SUFFIX = ":terminal";
const BUDGET_SUFFIX = ":budget";

/**
 * Rebuild the billable usage of one Run from durable events. Charges are the
 * authority; terminal usage only closes the crash window before its charge.
 */
export function recoverRunTokenUsage(
  events: readonly AnyEvent[],
  runId: RunId,
): TokenUsage {
  return recoverRunTokenUsageByLane(events, runId).reduce(
    (total, lane) => addUsage(total, lane.usage),
    emptyUsage(),
  );
}

/**
 * Rebuild usage while retaining lane ownership. The pairing and crash-window
 * rules intentionally mirror recoverRunTokenUsage(), so callers cannot make a
 * different accounting decision merely by asking for a breakdown.
 */
export function recoverRunTokenUsageByLane(
  events: readonly AnyEvent[],
  runId: RunId,
): RecoveredLaneUsage[] {
  const ordered = uniqueRunEvents(events, runId);
  const chargedCalls = new Set<string>();
  const compactionRequests = new Map<string, CompactionRequested>();
  const usageByLane = new Map<string, TokenUsage>();

  for (const event of ordered) {
    if (event.type === "fukai.compaction.requested") {
      compactionRequests.set(compactionAttemptKey(event), event);
    }
    if (event.type !== "budget.charged") continue;
    addLaneUsage(usageByLane, event.payload.laneId, event.payload.usage);
    const call = chargedCallKey(event);
    if (call !== undefined) chargedCalls.add(call);
  }

  const unchargedTerminals = new Map<string, RecoveredLaneUsage>();
  for (const event of ordered) {
    if (!isUsageTerminal(event)) continue;
    const recoveredUsage = terminalUsage(event, compactionRequests);
    if (recoveredUsage === null) continue;
    const call = terminalCallKey(event);
    if (chargedCalls.has(call) || unchargedTerminals.has(call)) continue;
    unchargedTerminals.set(call, { laneId: event.laneId, usage: recoveredUsage });
  }

  for (const terminal of unchargedTerminals.values()) {
    addLaneUsage(usageByLane, terminal.laneId, terminal.usage);
  }
  return [...usageByLane.entries()]
    .map(([laneId, usage]) => ({ laneId, usage }))
    .sort((left, right) => left.laneId.localeCompare(right.laneId));
}

function addLaneUsage(
  usageByLane: Map<string, TokenUsage>,
  laneId: string,
  usage: TokenUsage,
): void {
  usageByLane.set(laneId, addUsage(usageByLane.get(laneId) ?? emptyUsage(), usage));
}

/** Ledger retries replay the original key. Earliest durable fact wins. */
function uniqueRunEvents(events: readonly AnyEvent[], runId: RunId): AnyEvent[] {
  const ordered = events
    .filter((event) => event.runId === runId)
    .toSorted(compareEvents);
  const byIdempotencyKey = new Map<string, AnyEvent>();
  for (const event of ordered) {
    if (!byIdempotencyKey.has(event.idempotencyKey)) {
      byIdempotencyKey.set(event.idempotencyKey, event);
    }
  }
  return [...byIdempotencyKey.values()];
}

function compareEvents(left: AnyEvent, right: AnyEvent): number {
  return left.globalOffset - right.globalOffset
    || left.eventId.localeCompare(right.eventId)
    || left.type.localeCompare(right.type);
}

function isUsageTerminal(event: AnyEvent): event is UsageTerminal {
  return event.type === "model.completed"
    || event.type === "teto.observed"
    || event.type === "reflection.observed"
    || event.type === "fukai.compaction.completed"
    || event.type === "fukai.compaction.failed";
}

function terminalCallKey(event: UsageTerminal): string {
  const suffix = event.type === "model.completed"
    ? MODEL_COMPLETED_SUFFIX
    : event.type === "fukai.compaction.completed" || event.type === "fukai.compaction.failed"
      ? COMPACTION_TERMINAL_SUFFIX
      : OBSERVED_SUFFIX;
  const prefix = stripSuffix(event.idempotencyKey, suffix);
  return callKey(event.runId, event.laneId, prefix ?? event.idempotencyKey);
}

function terminalUsage(
  event: UsageTerminal,
  compactionRequests: ReadonlyMap<string, CompactionRequested>,
): TokenUsage | null {
  if (event.payload.usage !== null) return event.payload.usage;
  if (event.type !== "fukai.compaction.completed") return null;

  const requested = compactionRequests.get(compactionAttemptKey(event));
  return requested === undefined
    ? null
    : {
        input: requested.payload.budget.maxInputTokens,
        output: requested.payload.budget.maxOutputTokens,
        cacheRead: 0,
        cacheWrite: 0,
      };
}

function compactionAttemptKey(
  event: CompactionRequested | Extract<AnyEvent, { type: "fukai.compaction.completed" }>,
): string {
  return [
    event.runId,
    event.laneId,
    event.payload.compactionId,
    event.payload.attemptId,
  ].join("\0");
}

function chargedCallKey(
  event: Extract<AnyEvent, { type: "budget.charged" }>,
): string | undefined {
  const prefix = stripSuffix(event.idempotencyKey, BUDGET_SUFFIX);
  return prefix === undefined
    ? undefined
    : callKey(event.runId, event.payload.laneId, prefix);
}

function stripSuffix(value: string, suffix: string): string | undefined {
  return value.endsWith(suffix)
    ? value.slice(0, -suffix.length)
    : undefined;
}

function callKey(runId: RunId, laneId: string, prefix: string): string {
  return `${runId}\0${laneId}\0${prefix}`;
}

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    ...(
      left.costUsd === undefined && right.costUsd === undefined
        ? {}
        : { costUsd: (left.costUsd ?? 0) + (right.costUsd ?? 0) }
    ),
  };
}
