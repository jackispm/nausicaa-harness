import type { AnyEvent, RunId, TokenUsage } from "../domain/index.js";

type UsageTerminal = Extract<AnyEvent, {
  type: "model.completed" | "teto.observed" | "reflection.observed";
}>;

const MODEL_COMPLETED_SUFFIX = ":model:completed";
const OBSERVED_SUFFIX = ":observed";
const BUDGET_SUFFIX = ":budget";

/**
 * Rebuild the billable usage of one Run from durable events. Charges are the
 * authority; terminal usage only closes the crash window before its charge.
 */
export function recoverRunTokenUsage(
  events: readonly AnyEvent[],
  runId: RunId,
): TokenUsage {
  const ordered = uniqueRunEvents(events, runId);
  const chargedCalls = new Set<string>();
  let usage = emptyUsage();

  for (const event of ordered) {
    if (event.type !== "budget.charged") continue;
    usage = addUsage(usage, event.payload.usage);
    const call = chargedCallKey(event);
    if (call !== undefined) chargedCalls.add(call);
  }

  const unchargedTerminals = new Map<string, UsageTerminal>();
  for (const event of ordered) {
    if (!isUsageTerminal(event)) continue;
    const call = terminalCallKey(event);
    if (chargedCalls.has(call) || unchargedTerminals.has(call)) continue;
    unchargedTerminals.set(call, event);
  }

  for (const terminal of unchargedTerminals.values()) {
    usage = addUsage(usage, terminal.payload.usage);
  }
  return usage;
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
    || event.type === "reflection.observed";
}

function terminalCallKey(event: UsageTerminal): string {
  const suffix = event.type === "model.completed"
    ? MODEL_COMPLETED_SUFFIX
    : OBSERVED_SUFFIX;
  const prefix = stripSuffix(event.idempotencyKey, suffix);
  return callKey(event.runId, event.laneId, prefix ?? event.idempotencyKey);
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
