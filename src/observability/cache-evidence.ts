import type {
  AnyEvent,
  ContextTruncationKind,
} from "../domain/events.js";
import type { CacheOutcome, LaneId, TokenUsage } from "../domain/types.js";

export type PrefixContinuity = "baseline" | "stable" | "changed" | "unknown";
export type CacheRequestStatus = "pending" | "completed" | "failed" | "cancelled";
export type TerminalLink = "causation" | "request-id" | "legacy-fifo" | "orphan" | "none";

/**
 * Cache evidence for one model attempt. Prompt fingerprints and artifact refs
 * are deliberately excluded so this projection is safe to expose to a UI.
 */
export interface CacheRequestEvidence {
  requestEventId: string | null;
  terminalEventId: string | null;
  laneId: LaneId;
  model: string | null;
  ordinal: number | null;
  status: CacheRequestStatus;
  prefixContinuity: PrefixContinuity;
  sessionContinuity: PrefixContinuity;
  /** Null means a legacy event did not record truncation evidence. */
  truncationKinds: ContextTruncationKind[] | null;
  providerCache: CacheOutcome;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  contextBuildMs: number | null;
  modelLatencyMs: number | null;
  terminalLink: TerminalLink;
}

export interface PrefixEvidenceStats {
  requests: number;
  fingerprinted: number;
  distinctFingerprints: number;
  baseline: number;
  stable: number;
  changed: number;
  unknown: number;
  comparable: number;
  /** Stable adjacent pairs / all comparable adjacent pairs. */
  stableRate: number | null;
}

export interface SessionAffinityStats {
  requests: number;
  identified: number;
  distinctSessions: number;
  baseline: number;
  stable: number;
  changed: number;
  unknown: number;
  comparable: number;
  stableRate: number | null;
}

export interface TruncationEvidenceStats {
  requests: number;
  known: number;
  unknown: number;
  truncated: number;
  /** Truncated requests / requests with explicit truncation evidence. */
  truncatedRate: number | null;
  reasonCounts: Partial<Record<ContextTruncationKind, number>>;
}

export interface ProviderCacheEvidenceStats {
  completions: number;
  known: number;
  unknown: number;
  hit: number;
  write: number;
  hitWrite: number;
  readEvidence: number;
  writeEvidence: number;
  /** Fraction of completions whose provider exposed positive cache evidence. */
  observabilityRate: number | null;
  /** Confirmed cache reads / all completions; this is not presented as a miss rate. */
  readEvidenceRate: number | null;
  /** Confirmed cache writes / all completions; this is not presented as a miss rate. */
  writeEvidenceRate: number | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface CacheTimingStats {
  total: number;
  known: number;
  unknown: number;
  totalMs: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface CacheEvidenceSummary {
  requestCount: number;
  completed: number;
  failed: number;
  cancelled: number;
  pending: number;
  orphanTerminals: number;
  prefix: PrefixEvidenceStats;
  sessionAffinity: SessionAffinityStats;
  truncation: TruncationEvidenceStats;
  provider: ProviderCacheEvidenceStats;
  contextBuild: CacheTimingStats;
  modelLatency: CacheTimingStats;
}

export interface CacheEvidenceReport {
  runId: string;
  eventCount: number;
  entries: CacheRequestEvidence[];
  lanes: Record<LaneId, CacheEvidenceSummary>;
  total: CacheEvidenceSummary;
}

interface MutableEvidence extends CacheRequestEvidence {
  prefixHash: string | null;
  sessionId: string | null;
  sortOffset: number;
}

interface PreviousPrefix {
  hash: string | null;
  model: string;
}

/**
 * Correlate model request and terminal facts into privacy-safe cache evidence.
 * New events use causation ids; schema-v1 events without them fall back to a
 * conservative lane/model FIFO association and are labelled accordingly.
 */
export function projectCacheEvidence(
  events: readonly AnyEvent[],
  runId: string,
): CacheEvidenceReport {
  const ordered = events
    .filter((event) => event.runId === runId)
    .slice()
    .sort((left, right) => left.globalOffset - right.globalOffset);
  const entries: MutableEvidence[] = [];
  const requestsById = new Map<string, MutableEvidence>();
  const previousPrefixByLane = new Map<LaneId, PreviousPrefix>();
  const previousSessionByLane = new Map<LaneId, PreviousPrefix>();
  const ordinalByLane = new Map<LaneId, number>();

  for (const event of ordered) {
    switch (event.type) {
      case "model.requested": {
        const ordinal = (ordinalByLane.get(event.laneId) ?? 0) + 1;
        ordinalByLane.set(event.laneId, ordinal);
        const prefixHash = event.payload.prefixHash ?? null;
        const prefixContinuity = continuity(
          previousPrefixByLane.get(event.laneId),
          prefixHash,
          event.payload.model,
        );
        previousPrefixByLane.set(event.laneId, {
          hash: prefixHash,
          model: event.payload.model,
        });
        const sessionId = event.payload.sessionId ?? null;
        const sessionContinuity = continuity(
          previousSessionByLane.get(event.laneId),
          sessionId,
          event.payload.model,
        );
        previousSessionByLane.set(event.laneId, {
          hash: sessionId,
          model: event.payload.model,
        });
        const entry: MutableEvidence = {
          requestEventId: event.eventId,
          terminalEventId: null,
          laneId: event.laneId,
          model: event.payload.model,
          ordinal,
          status: "pending",
          prefixContinuity,
          sessionContinuity,
          truncationKinds: event.payload.truncations === undefined
            ? null
            : event.payload.truncations.map((item) => item.kind),
          providerCache: "unknown",
          cacheReadTokens: null,
          cacheWriteTokens: null,
          contextBuildMs: event.payload.contextBuildMs ?? null,
          modelLatencyMs: null,
          terminalLink: "none",
          prefixHash,
          sessionId,
          sortOffset: event.globalOffset,
        };
        entries.push(entry);
        requestsById.set(event.eventId, entry);
        break;
      }
      case "model.completed": {
        const match = findRequest(
          entries,
          requestsById,
          event.laneId,
          event.payload.model,
          event.causationId === undefined ? [] : [event.causationId],
          "causation",
        );
        const entry = match ?? orphanEntry(event, event.payload.model, "completed");
        completeEntry(entry, event);
        if (match === undefined) entries.push(entry);
        break;
      }
      case "model.failed": {
        const match = findRequest(
          entries,
          requestsById,
          event.laneId,
          event.payload.model,
          event.causationId === undefined ? [] : [event.causationId],
          "causation",
        );
        const entry = match ?? orphanEntry(event, event.payload.model, "failed");
        settleEntry(entry, event.eventId, "failed");
        if (match === undefined) entries.push(entry);
        break;
      }
      case "model.cancelled": {
        const exactIds = [event.payload.requestId];
        if (event.causationId !== undefined && event.causationId !== event.payload.requestId) {
          exactIds.push(event.causationId);
        }
        const match = findRequest(
          entries,
          requestsById,
          event.laneId,
          null,
          exactIds,
          "request-id",
        );
        const entry = match ?? orphanEntry(event, null, "cancelled");
        settleEntry(entry, event.eventId, "cancelled");
        if (match === undefined) entries.push(entry);
        break;
      }
      default:
        break;
    }
  }

  entries.sort((left, right) => left.sortOffset - right.sortOffset);
  const laneIds = new Set(entries.map((entry) => entry.laneId));
  const lanes = Object.fromEntries([...laneIds].map((laneId) => [
    laneId,
    summarize(entries.filter((entry) => entry.laneId === laneId)),
  ]));
  return {
    runId,
    eventCount: ordered.length,
    entries: entries.map(publicEvidence),
    lanes,
    total: summarize(entries),
  };
}

function continuity(
  previous: PreviousPrefix | undefined,
  current: string | null,
  model: string,
): PrefixContinuity {
  if (current === null) return "unknown";
  if (previous === undefined || previous.model !== model) return "baseline";
  if (previous.hash === null) return "unknown";
  return previous.hash === current ? "stable" : "changed";
}

function findRequest(
  entries: readonly MutableEvidence[],
  requestsById: ReadonlyMap<string, MutableEvidence>,
  laneId: LaneId,
  model: string | null,
  exactIds: readonly string[],
  exactLink: "causation" | "request-id",
): MutableEvidence | undefined {
  for (const eventId of exactIds) {
    const exact = requestsById.get(eventId);
    if (exact?.status === "pending" && exact.laneId === laneId) {
      exact.terminalLink = exactLink;
      return exact;
    }
  }
  if (exactIds.length > 0) return undefined;
  const legacy = entries.find((entry) =>
    entry.requestEventId !== null
    && entry.status === "pending"
    && entry.laneId === laneId
    && (model === null || entry.model === model)
  );
  if (legacy !== undefined) legacy.terminalLink = "legacy-fifo";
  return legacy;
}

function orphanEntry(
  event: AnyEvent,
  model: string | null,
  status: Exclude<CacheRequestStatus, "pending">,
): MutableEvidence {
  return {
    requestEventId: null,
    terminalEventId: event.eventId,
    laneId: event.laneId,
    model,
    ordinal: null,
    status,
    prefixContinuity: "unknown",
    sessionContinuity: "unknown",
    truncationKinds: null,
    providerCache: "unknown",
    cacheReadTokens: null,
    cacheWriteTokens: null,
    contextBuildMs: null,
    modelLatencyMs: null,
    terminalLink: "orphan",
    prefixHash: null,
    sessionId: null,
    sortOffset: event.globalOffset,
  };
}

function completeEntry(
  entry: MutableEvidence,
  event: Extract<AnyEvent, { type: "model.completed" }>,
): void {
  settleEntry(entry, event.eventId, "completed");
  entry.providerCache = event.payload.cacheOutcome ?? inferCacheOutcome(event.payload.usage);
  entry.cacheReadTokens = event.payload.usage.cacheRead;
  entry.cacheWriteTokens = event.payload.usage.cacheWrite;
  entry.modelLatencyMs = event.payload.modelLatencyMs ?? null;
}

function settleEntry(
  entry: MutableEvidence,
  terminalEventId: string,
  status: Exclude<CacheRequestStatus, "pending">,
): void {
  entry.terminalEventId = terminalEventId;
  entry.status = status;
}

function publicEvidence(entry: MutableEvidence): CacheRequestEvidence {
  return {
    requestEventId: entry.requestEventId,
    terminalEventId: entry.terminalEventId,
    laneId: entry.laneId,
    model: entry.model,
    ordinal: entry.ordinal,
    status: entry.status,
    prefixContinuity: entry.prefixContinuity,
    sessionContinuity: entry.sessionContinuity,
    truncationKinds: entry.truncationKinds === null ? null : [...entry.truncationKinds],
    providerCache: entry.providerCache,
    cacheReadTokens: entry.cacheReadTokens,
    cacheWriteTokens: entry.cacheWriteTokens,
    contextBuildMs: entry.contextBuildMs,
    modelLatencyMs: entry.modelLatencyMs,
    terminalLink: entry.terminalLink,
  };
}

function summarize(entries: readonly MutableEvidence[]): CacheEvidenceSummary {
  const requests = entries.filter((entry) => entry.requestEventId !== null);
  const completions = entries.filter((entry) => entry.status === "completed");
  const prefixComparable = requests.filter((entry) =>
    entry.prefixContinuity === "stable" || entry.prefixContinuity === "changed"
  );
  const stable = count(requests, (entry) => entry.prefixContinuity === "stable");
  const comparableSessions = requests.filter((entry) =>
    entry.sessionContinuity === "stable" || entry.sessionContinuity === "changed"
  );
  const stableSessions = count(requests, (entry) => entry.sessionContinuity === "stable");
  const knownTruncations = requests.filter((entry) => entry.truncationKinds !== null);
  const providerKnown = completions.filter((entry) => entry.providerCache !== "unknown");
  const readEvidence = count(completions, (entry) =>
    entry.providerCache === "hit" || entry.providerCache === "hit-write"
  );
  const writeEvidence = count(completions, (entry) =>
    entry.providerCache === "write" || entry.providerCache === "hit-write"
  );

  return {
    requestCount: requests.length,
    completed: count(requests, (entry) => entry.status === "completed"),
    failed: count(requests, (entry) => entry.status === "failed"),
    cancelled: count(requests, (entry) => entry.status === "cancelled"),
    pending: count(requests, (entry) => entry.status === "pending"),
    orphanTerminals: count(entries, (entry) => entry.requestEventId === null),
    prefix: {
      requests: requests.length,
      fingerprinted: count(requests, (entry) => entry.prefixHash !== null),
      distinctFingerprints: new Set(requests.flatMap((entry) =>
        entry.prefixHash === null ? [] : [entry.prefixHash]
      )).size,
      baseline: count(requests, (entry) => entry.prefixContinuity === "baseline"),
      stable,
      changed: count(requests, (entry) => entry.prefixContinuity === "changed"),
      unknown: count(requests, (entry) => entry.prefixContinuity === "unknown"),
      comparable: prefixComparable.length,
      stableRate: prefixComparable.length === 0 ? null : stable / prefixComparable.length,
    },
    sessionAffinity: {
      requests: requests.length,
      identified: count(requests, (entry) => entry.sessionId !== null),
      distinctSessions: new Set(requests.flatMap((entry) =>
        entry.sessionId === null ? [] : [entry.sessionId]
      )).size,
      baseline: count(requests, (entry) => entry.sessionContinuity === "baseline"),
      stable: stableSessions,
      changed: count(requests, (entry) => entry.sessionContinuity === "changed"),
      unknown: count(requests, (entry) => entry.sessionContinuity === "unknown"),
      comparable: comparableSessions.length,
      stableRate: comparableSessions.length === 0
        ? null
        : stableSessions / comparableSessions.length,
    },
    truncation: {
      requests: requests.length,
      known: knownTruncations.length,
      unknown: requests.length - knownTruncations.length,
      truncated: count(knownTruncations, (entry) => (entry.truncationKinds?.length ?? 0) > 0),
      truncatedRate: ratio(
        count(knownTruncations, (entry) => (entry.truncationKinds?.length ?? 0) > 0),
        knownTruncations.length,
      ),
      reasonCounts: truncationReasonCounts(knownTruncations),
    },
    provider: {
      completions: completions.length,
      known: providerKnown.length,
      unknown: completions.length - providerKnown.length,
      hit: count(completions, (entry) => entry.providerCache === "hit"),
      write: count(completions, (entry) => entry.providerCache === "write"),
      hitWrite: count(completions, (entry) => entry.providerCache === "hit-write"),
      readEvidence,
      writeEvidence,
      observabilityRate: ratio(providerKnown.length, completions.length),
      readEvidenceRate: ratio(readEvidence, completions.length),
      writeEvidenceRate: ratio(writeEvidence, completions.length),
      cacheReadTokens: sumKnown(completions.map((entry) => entry.cacheReadTokens)),
      cacheWriteTokens: sumKnown(completions.map((entry) => entry.cacheWriteTokens)),
    },
    contextBuild: timingStats(requests.map((entry) => entry.contextBuildMs)),
    modelLatency: timingStats(completions.map((entry) => entry.modelLatencyMs)),
  };
}

function timingStats(values: readonly (number | null)[]): CacheTimingStats {
  const known = values.filter((value): value is number => value !== null);
  const sorted = [...known].sort((left, right) => left - right);
  return {
    total: values.length,
    known: known.length,
    unknown: values.length - known.length,
    totalMs: known.reduce((sum, value) => sum + value, 0),
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

function percentile(sorted: readonly number[], quantile: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? null;
}

function inferCacheOutcome(usage: TokenUsage): CacheOutcome {
  if (usage.cacheRead > 0 && usage.cacheWrite > 0) return "hit-write";
  if (usage.cacheRead > 0) return "hit";
  if (usage.cacheWrite > 0) return "write";
  return "unknown";
}

function truncationReasonCounts(
  entries: readonly MutableEvidence[],
): Partial<Record<ContextTruncationKind, number>> {
  const counts: Partial<Record<ContextTruncationKind, number>> = {};
  for (const entry of entries) {
    for (const kind of entry.truncationKinds ?? []) {
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
  }
  return counts;
}

function count<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  return values.reduce((total, value) => total + (predicate(value) ? 1 : 0), 0);
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function sumKnown(values: readonly (number | null)[]): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}
