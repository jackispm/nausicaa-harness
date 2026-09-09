import type { AnyEvent } from "../domain/events.js";
import type { TokenUsage } from "../domain/types.js";
import type { LaneRunMetrics, RunMetrics } from "./run-metrics.js";

/**
 * A point-in-time, read-only view of one Run's durable event stream.
 *
 * Traces deliberately stay local in Nausicaa. The event stream is already the
 * durable diagnostic record, so this surface does not introduce a second log
 * format or an upload/credential path.
 */
export interface RunTraceSnapshot {
  runId: string;
  ledgerPath: string;
  events: readonly AnyEvent[];
  metrics: RunMetrics;
}

export interface TracePreviewOptions {
  /** Number of most recent events to include in the preview. */
  maxEvents?: number;
  /** Maximum one-line payload length per event. */
  maxPayloadChars?: number;
}

const DEFAULT_MAX_EVENTS = 16;
const MAX_MAX_EVENTS = 100;
const DEFAULT_MAX_PAYLOAD_CHARS = 240;
const MAX_MAX_PAYLOAD_CHARS = 2_000;

/** Render the compact `/traces status` view. */
export function formatTraceStatus(snapshot: RunTraceSnapshot | undefined): string {
  if (snapshot === undefined) {
    return [
      "Traces",
      "Storage: local Run Ledger (no upload or external network)",
      "Run: none attached",
      "Use /traces preview after starting or resuming a Run.",
    ].join("\n");
  }

  const { metrics } = snapshot;
  const latestOffset = snapshot.events.reduce(
    (highest, event) => Math.max(highest, event.globalOffset),
    0,
  );
  return [
    "Traces",
    "Storage: local Run Ledger (no upload or external network)",
    `Run: ${safeText(snapshot.runId)}`,
    `Ledger: ${safeText(snapshot.ledgerPath)}`,
    `Events: ${metrics.eventCount}; watermark ${latestOffset}`,
    `Duration: ${formatDuration(metrics.durationMs)}`,
    `Models: ${metrics.total.modelRequests} request(s); ${metrics.total.modelCompletions} completion(s); ${metrics.total.modelFailures} failure(s)`,
    `Tools: ${metrics.toolCalls} call(s); ${metrics.toolFailures} failure(s); ${metrics.unknownOperations} unresolved`,
    `Usage: ${formatUsage(metrics.total.usage)}`,
    `Cache reads: ${(metrics.cacheReadRatio * 100).toFixed(1)}%`,
    `Lanes: ${formatLanes(metrics.lanes)}`,
    `Fukai: ${formatFukai(metrics)}`,
    "Use /traces preview to inspect recent durable events.",
  ].join("\n");
}

/** Render the bounded `/traces preview` event and metrics view. */
export function formatTracePreview(
  snapshot: RunTraceSnapshot | undefined,
  options: TracePreviewOptions = {},
): string {
  if (snapshot === undefined) {
    return [
      "Trace Preview",
      "Local only; no upload or external network.",
      "No Run is attached, so there are no durable events to preview.",
    ].join("\n");
  }

  const maxEvents = boundedOption(
    options.maxEvents,
    DEFAULT_MAX_EVENTS,
    1,
    MAX_MAX_EVENTS,
  );
  const maxPayloadChars = boundedOption(
    options.maxPayloadChars,
    DEFAULT_MAX_PAYLOAD_CHARS,
    32,
    MAX_MAX_PAYLOAD_CHARS,
  );
  const ordered = snapshot.events
    .slice()
    .sort((left, right) => left.globalOffset - right.globalOffset);
  const start = Math.max(0, ordered.length - maxEvents);
  const shown = ordered.slice(start);
  const lines = [
    "Trace Preview",
    "Local only; no upload or external network.",
    `Run: ${safeText(snapshot.runId)}`,
    `Ledger: ${safeText(snapshot.ledgerPath)}`,
    `Events: showing ${shown.length} of ${ordered.length} (most recent)`,
    "",
    "Recent events:",
  ];
  if (shown.length === 0) {
    lines.push("  none");
  } else {
    for (const event of shown) {
      lines.push(formatEvent(event, maxPayloadChars));
    }
  }
  if (start > 0) lines.push(`  ... ${start} earlier event(s) omitted`);
  lines.push(
    "",
    "Metrics:",
    `  Models: ${snapshot.metrics.total.modelRequests} request(s); ${snapshot.metrics.total.modelCompletions} completion(s); ${snapshot.metrics.total.modelFailures} failure(s)`,
    `  Tools: ${snapshot.metrics.toolCalls} call(s); ${snapshot.metrics.toolFailures} failure(s); ${snapshot.metrics.unknownOperations} unresolved`,
    `  Usage: ${formatUsage(snapshot.metrics.total.usage)}`,
    `  Cache reads: ${(snapshot.metrics.cacheReadRatio * 100).toFixed(1)}%`,
    `  Fukai: ${formatFukai(snapshot.metrics)}`,
  );
  return lines.join("\n");
}

function formatEvent(event: AnyEvent, maxPayloadChars: number): string {
  let payload = "";
  try {
    const serialized = JSON.stringify(event.payload);
    if (serialized !== undefined) {
      payload = ` ${truncate(safeText(serialized), maxPayloadChars)}`;
    }
  } catch {
    payload = " <payload unavailable>";
  }
  const turn = event.turnId === undefined ? "" : ` turn=${safeText(event.turnId)}`;
  return `  #${event.globalOffset} ${safeText(event.occurredAt)} ${safeText(event.laneId)}${turn} ${event.type}${payload}`;
}

function formatLanes(lanes: Record<string, LaneRunMetrics>): string {
  const values = Object.values(lanes).sort((left, right) => left.laneId.localeCompare(right.laneId));
  if (values.length === 0) return "none";
  return values.map((lane) => (
    `${safeText(lane.laneId)} ${lane.modelRequests} request(s), ${lane.modelCompletions} completion(s), ${lane.usage.input + lane.usage.output} token(s)`
  )).join("; ");
}

function formatFukai(metrics: RunMetrics): string {
  const total = metrics.fukaiCompaction.total;
  return `${total.providerCalls} provider call(s); ${total.committedCompactions} committed; ${total.fallbacks.total} fallback(s)`;
}

function formatUsage(usage: TokenUsage): string {
  const cost = usage.costUsd === undefined ? "" : `; cost $${usage.costUsd.toFixed(6)}`;
  return `input ${usage.input}; output ${usage.output}; cache-read ${usage.cacheRead}; cache-write ${usage.cacheWrite}${cost}`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  return `${(Math.max(0, milliseconds) / 1_000).toFixed(1)}s`;
}

function boundedOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isSafeInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 3))}...`;
}

function safeText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
