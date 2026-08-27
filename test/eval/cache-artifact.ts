import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import type { AnyEvent, EventEnvelope } from "../../src/domain/events.js";
import {
  computeEventContentHash,
  validateEvent,
} from "../../src/ledger/ledger.js";
import { sha256, stableJson } from "../../src/ledger/hash.js";
import {
  projectCacheEvidence,
  type CacheEvidenceReport,
} from "../../src/observability/index.js";

export const CACHE_ARTIFACT_SCHEMA_VERSION = 2 as const;
export const CACHE_PROBE_TASK_ID = "phase-2.3-runtime-cache-probe-v2";

type CacheLedgerEvent = Extract<AnyEvent, {
  type: "model.requested" | "model.completed" | "model.failed" | "model.cancelled";
}>;

export interface CacheProbeLimits {
  maxRequests: number;
  maxOutputTokens: number;
  budgetUsd: number;
}

export interface CacheProbeProvenance {
  taskId: typeof CACHE_PROBE_TASK_ID;
  executionCommit: string;
  repositoryDirty: boolean;
  startedAt: string;
  completedAt: string;
}

export interface CacheProbeDecision {
  status: "pass" | "hold";
  eligible: boolean;
  reasons: string[];
}

export interface CacheProbeArtifact {
  schemaVersion: typeof CACHE_ARTIFACT_SCHEMA_VERSION;
  provenance: CacheProbeProvenance;
  provider: "openrouter";
  model: string;
  runId: string;
  limits: CacheProbeLimits;
  ledgerExcerpt: CacheLedgerEvent[];
  cacheEvidence: CacheEvidenceReport;
  totals: {
    spentUsd: number | null;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  releaseDecision: CacheProbeDecision;
  evidenceDigest: string;
}

export interface BuildCacheProbeArtifactOptions {
  events: readonly AnyEvent[];
  runId: string;
  model: string;
  limits: CacheProbeLimits;
  provenance: Omit<CacheProbeProvenance, "taskId">;
}

export interface CacheProbeRepositoryState {
  executionCommit: string;
  repositoryDirty: boolean;
}

export function buildCacheProbeArtifact(
  options: BuildCacheProbeArtifactOptions,
): CacheProbeArtifact {
  const ledgerExcerpt = redactCacheLedger(options.events, options.runId);
  const cacheEvidence = projectCacheEvidence(ledgerExcerpt, options.runId);
  const totals = cacheTotals(ledgerExcerpt);
  const provenance: CacheProbeProvenance = {
    taskId: CACHE_PROBE_TASK_ID,
    ...options.provenance,
  };
  const core = {
    schemaVersion: CACHE_ARTIFACT_SCHEMA_VERSION,
    provenance,
    provider: "openrouter" as const,
    model: options.model,
    runId: options.runId,
    limits: { ...options.limits },
    ledgerExcerpt,
    cacheEvidence,
    totals,
    releaseDecision: evaluateCacheProbe({
      model: options.model,
      limits: options.limits,
      provenance,
      ledgerExcerpt,
      cacheEvidence,
      totals,
    }),
  };
  return {
    ...core,
    evidenceDigest: digestCacheArtifact(core),
  };
}

export async function writeCacheProbeArtifact(
  path: string,
  artifact: CacheProbeArtifact,
): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

export async function verifyCacheProbeArtifact(
  path: string,
): Promise<CacheProbeArtifact> {
  const parsed = JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
  return verifyCacheProbeArtifactValue(parsed);
}

export function verifyCacheProbeArtifactValue(value: unknown): CacheProbeArtifact {
  const artifact = cacheArtifact(value);
  const { evidenceDigest, ...core } = artifact;
  if (digestCacheArtifact(core) !== evidenceDigest) {
    throw new Error("Cache evidence digest mismatch");
  }

  validateCacheTimeline(artifact);
  const projected = projectCacheEvidence(artifact.ledgerExcerpt, artifact.runId);
  if (stableJson(projected) !== stableJson(artifact.cacheEvidence)) {
    throw new Error("Cache evidence projection does not reconcile with the Ledger excerpt");
  }
  const totals = cacheTotals(artifact.ledgerExcerpt);
  if (stableJson(totals) !== stableJson(artifact.totals)) {
    throw new Error("Cache evidence totals do not reconcile with the Ledger excerpt");
  }
  const decision = evaluateCacheProbe({
    model: artifact.model,
    limits: artifact.limits,
    provenance: artifact.provenance,
    ledgerExcerpt: artifact.ledgerExcerpt,
    cacheEvidence: projected,
    totals,
  });
  if (stableJson(decision) !== stableJson(artifact.releaseDecision)) {
    throw new Error("Cache evidence release decision does not reconcile");
  }
  return artifact;
}

export async function inspectCacheProbeRepository(
  cwd = process.cwd(),
): Promise<CacheProbeRepositoryState> {
  const run = promisify(execFile);
  const [head, status] = await Promise.all([
    run("git", ["rev-parse", "HEAD"], { cwd: resolve(cwd) }),
    run("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: resolve(cwd),
    }),
  ]);
  return {
    executionCommit: head.stdout.trim(),
    repositoryDirty: status.stdout.trim().length > 0,
  };
}

export function digestCacheArtifact(
  artifact: Omit<CacheProbeArtifact, "evidenceDigest">,
): string {
  return sha256(stableJson(artifact));
}

function redactCacheLedger(
  events: readonly AnyEvent[],
  runId: string,
): CacheLedgerEvent[] {
  const selected = events
    .filter((event): event is CacheLedgerEvent => (
      event.runId === runId
      && event.laneId === "main"
      && (
        event.type === "model.requested"
        || event.type === "model.completed"
        || event.type === "model.failed"
        || event.type === "model.cancelled"
      )
    ))
    .slice()
    .sort((left, right) => left.globalOffset - right.globalOffset);
  const requestIds = new Map<string, string>();
  const prefixAliases = new Map<string, string>();
  const sessionAliases = new Map<string, string>();
  let requestOrdinal = 0;

  return selected.map((source, index) => {
    if (source.type === "model.requested") {
      requestOrdinal += 1;
      requestIds.set(source.eventId, `cache-request:${requestOrdinal}`);
    }
    const eventId = source.type === "model.requested"
      ? requestIds.get(source.eventId)!
      : `cache-terminal:${index + 1}`;
    const common = {
      eventId,
      runId,
      laneId: "main",
      globalOffset: index + 1,
      laneSeq: index + 1,
      schemaVersion: 1 as const,
      occurredAt: source.occurredAt,
      ...(source.causationId === undefined
        ? {}
        : { causationId: requestIds.get(source.causationId) ?? "cache-request:unknown" }),
      correlationId: `cache-probe:${index + 1}`,
      idempotencyKey: `cache-probe:event:${index + 1}`,
      visibility: "run" as const,
    };
    let withoutHash: Omit<CacheLedgerEvent, "contentHash">;
    switch (source.type) {
      case "model.requested":
        withoutHash = {
          ...common,
          type: source.type,
          payload: {
            model: source.payload.model,
            requestHash: "redacted",
            contextWatermark: source.payload.contextWatermark,
            ...(source.payload.sessionId === undefined
              ? {}
              : { sessionId: alias(source.payload.sessionId, sessionAliases, "session") }),
            ...(source.payload.prefixHash === undefined
              ? {}
              : { prefixHash: alias(source.payload.prefixHash, prefixAliases, "prefix") }),
            ...(source.payload.dependencyRefs === undefined ? {} : { dependencyRefs: [] }),
            ...(source.payload.truncations === undefined
              ? {}
              : {
                  truncations: source.payload.truncations.map((item) => ({
                    kind: item.kind,
                    detail: "redacted",
                  })),
                }),
            ...(source.payload.contextBuildMs === undefined
              ? {}
              : { contextBuildMs: source.payload.contextBuildMs }),
          },
        };
        break;
      case "model.completed":
        withoutHash = {
          ...common,
          type: source.type,
          payload: {
            model: source.payload.model,
            responseRef: {
              id: `cache-response:${index + 1}`,
              contentHash: sha256(`cache-response:${index + 1}`),
              mediaType: "application/vnd.nausicaa.redacted+json",
              byteLength: 0,
            },
            stopReason: source.payload.stopReason,
            usage: { ...source.payload.usage },
            ...(source.payload.modelLatencyMs === undefined
              ? {}
              : { modelLatencyMs: source.payload.modelLatencyMs }),
            ...(source.payload.cacheOutcome === undefined
              ? {}
              : { cacheOutcome: source.payload.cacheOutcome }),
          },
        };
        break;
      case "model.failed":
        withoutHash = {
          ...common,
          type: source.type,
          payload: { model: source.payload.model, error: "provider request failed" },
        };
        break;
      case "model.cancelled":
        withoutHash = {
          ...common,
          type: source.type,
          payload: {
            requestId: requestIds.get(source.payload.requestId) ?? "cache-request:unknown",
            reason: "request cancelled",
          },
        };
        break;
    }
    const event = {
      ...withoutHash,
      contentHash: computeEventContentHash(withoutHash as Omit<AnyEvent, "contentHash">),
    } as CacheLedgerEvent;
    validateEvent(event);
    return event;
  });
}

function alias(
  value: string,
  aliases: Map<string, string>,
  prefix: string,
): string {
  const existing = aliases.get(value);
  if (existing !== undefined) return existing;
  const created = `${prefix}:${aliases.size + 1}`;
  aliases.set(value, created);
  return created;
}

function cacheTotals(events: readonly CacheLedgerEvent[]): CacheProbeArtifact["totals"] {
  const completions = events.filter((event): event is EventEnvelope<"model.completed"> => (
    event.type === "model.completed"
  ));
  const costs = completions.map((event) => event.payload.usage.costUsd);
  return {
    spentUsd: costs.every((cost) => cost !== undefined)
      ? costs.reduce<number>((sum, cost) => sum + cost!, 0)
      : null,
    cacheReadTokens: completions.reduce(
      (sum, event) => sum + event.payload.usage.cacheRead,
      0,
    ),
    cacheWriteTokens: completions.reduce(
      (sum, event) => sum + event.payload.usage.cacheWrite,
      0,
    ),
  };
}

function evaluateCacheProbe(input: {
  model: string;
  limits: CacheProbeLimits;
  provenance: CacheProbeProvenance;
  ledgerExcerpt: readonly CacheLedgerEvent[];
  cacheEvidence: CacheEvidenceReport;
  totals: CacheProbeArtifact["totals"];
}): CacheProbeDecision {
  const reasons: string[] = [];
  const entries = input.cacheEvidence.entries.filter((entry) => entry.requestEventId !== null);
  if (input.provenance.repositoryDirty) reasons.push("repository was dirty");
  if (input.limits.maxRequests !== 2 || entries.length !== input.limits.maxRequests) {
    reasons.push("probe did not record exactly two requests");
  }
  if (
    input.cacheEvidence.total.completed !== input.limits.maxRequests
    || input.cacheEvidence.total.failed !== 0
    || input.cacheEvidence.total.cancelled !== 0
    || input.cacheEvidence.total.pending !== 0
    || input.cacheEvidence.total.orphanTerminals !== 0
  ) {
    reasons.push("probe requests did not all complete cleanly");
  }
  if (entries.some((entry) => entry.laneId !== "main" || entry.model !== input.model)) {
    reasons.push("probe did not use one Main model");
  }
  if (
    entries[0]?.prefixContinuity !== "baseline"
    || entries[1]?.prefixContinuity !== "stable"
  ) {
    reasons.push("runtime prefix continuity was not stable");
  }
  if (
    entries[0]?.sessionContinuity !== "baseline"
    || entries[1]?.sessionContinuity !== "stable"
  ) {
    reasons.push("runtime session affinity was not stable");
  }
  if ((entries[1]?.cacheReadTokens ?? 0) <= 0) {
    reasons.push("second runtime request had no provider cache-read evidence");
  }
  if (input.totals.spentUsd === null) {
    reasons.push("provider did not report request cost");
  } else if (input.totals.spentUsd > input.limits.budgetUsd) {
    reasons.push("probe exceeded its cost budget");
  }
  const eligible = reasons.length === 0;
  return { status: eligible ? "pass" : "hold", eligible, reasons };
}

function validateCacheTimeline(artifact: CacheProbeArtifact): void {
  const startedAt = Date.parse(artifact.provenance.startedAt);
  const completedAt = Date.parse(artifact.provenance.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
    throw new Error("Cache evidence provenance timestamps are invalid");
  }
  const ids = new Set<string>();
  let previousOffset = 0;
  for (const event of artifact.ledgerExcerpt) {
    validateEvent(event);
    if (ids.has(event.eventId) || event.globalOffset <= previousOffset) {
      throw new Error("Cache evidence Ledger excerpt is not strictly ordered and unique");
    }
    if (
      event.runId !== artifact.runId
      || event.laneId !== "main"
      || (event.type !== "model.requested"
        && event.type !== "model.completed"
        && event.type !== "model.failed"
        && event.type !== "model.cancelled")
    ) {
      throw new Error("Cache evidence Ledger excerpt crossed its Main Run boundary");
    }
    const occurredAt = Date.parse(event.occurredAt);
    if (occurredAt < startedAt || occurredAt > completedAt) {
      throw new Error("Cache evidence request timestamp is outside the probe interval");
    }
    ids.add(event.eventId);
    previousOffset = event.globalOffset;
  }
}

function cacheArtifact(value: unknown): CacheProbeArtifact {
  const item = object(value, "cache artifact");
  if (item.schemaVersion !== CACHE_ARTIFACT_SCHEMA_VERSION) {
    throw new Error("Unsupported cache artifact schemaVersion");
  }
  if (item.provider !== "openrouter") throw new Error("Invalid cache artifact provider");
  nonEmpty(item.model, "model");
  nonEmpty(item.runId, "runId");
  if (typeof item.evidenceDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(item.evidenceDigest)) {
    throw new Error("Invalid cache artifact evidenceDigest");
  }
  const provenance = object(item.provenance, "provenance");
  if (provenance.taskId !== CACHE_PROBE_TASK_ID) throw new Error("Invalid cache probe taskId");
  if (
    typeof provenance.executionCommit !== "string"
    || !/^[0-9a-f]{40}$/.test(provenance.executionCommit)
    || typeof provenance.repositoryDirty !== "boolean"
  ) {
    throw new Error("Invalid cache artifact repository provenance");
  }
  nonEmpty(provenance.startedAt, "provenance.startedAt");
  nonEmpty(provenance.completedAt, "provenance.completedAt");
  const limits = object(item.limits, "limits");
  positiveInteger(limits.maxRequests, "limits.maxRequests");
  positiveInteger(limits.maxOutputTokens, "limits.maxOutputTokens");
  positiveNumber(limits.budgetUsd, "limits.budgetUsd");
  if (!Array.isArray(item.ledgerExcerpt)) throw new Error("ledgerExcerpt must be an array");
  object(item.cacheEvidence, "cacheEvidence");
  const totals = object(item.totals, "totals");
  if (totals.spentUsd !== null) nonNegativeNumber(totals.spentUsd, "totals.spentUsd");
  nonNegativeInteger(totals.cacheReadTokens, "totals.cacheReadTokens");
  nonNegativeInteger(totals.cacheWriteTokens, "totals.cacheWriteTokens");
  const decision = object(item.releaseDecision, "releaseDecision");
  if (decision.status !== "pass" && decision.status !== "hold") {
    throw new Error("Invalid cache releaseDecision status");
  }
  if (typeof decision.eligible !== "boolean" || !Array.isArray(decision.reasons)) {
    throw new Error("Invalid cache releaseDecision");
  }
  decision.reasons.forEach((reason, index) => nonEmpty(reason, `releaseDecision.reasons[${index}]`));
  return item as unknown as CacheProbeArtifact;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function positiveInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function nonNegativeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function positiveNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
}

function nonNegativeNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
}
