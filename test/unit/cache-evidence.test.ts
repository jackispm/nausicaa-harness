import { describe, expect, it } from "vitest";

import type {
  AnyEvent,
  AppendEvent,
  EventEnvelope,
  EventType,
} from "../../src/domain/events.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { projectCacheEvidence } from "../../src/observability/index.js";

describe("projectCacheEvidence", () => {
  it("explains prefix continuity and provider evidence without exposing fingerprints", async () => {
    const ledger = new MemoryLedger();
    const first = await append(ledger, "model.requested", {
      model: "model-a",
      requestHash: "PRIVATE_REQUEST_HASH",
      contextWatermark: 1,
      sessionId: "PRIVATE_SESSION_A",
      prefixHash: "PRIVATE_PREFIX_A",
      dependencyRefs: ["PRIVATE_DEPENDENCY"],
      truncations: [],
      contextBuildMs: 5,
    });
    await append(ledger, "model.completed", {
      model: "model-a",
      responseRef: ref("PRIVATE_RESPONSE"),
      stopReason: "stop",
      usage: usage(40, 0),
      modelLatencyMs: 11,
      cacheOutcome: "hit",
    }, "main", first.eventId);

    await append(ledger, "model.requested", {
      model: "model-a",
      requestHash: "request-2",
      contextWatermark: 2,
      sessionId: "PRIVATE_SESSION_A",
      prefixHash: "PRIVATE_PREFIX_A",
      truncations: [{
        kind: "input-token-budget",
        ref: "PRIVATE_TRUNCATION_REF",
        detail: "PRIVATE_TRUNCATION_DETAIL",
      }],
      contextBuildMs: 7,
    });
    await append(ledger, "model.completed", {
      model: "model-a",
      responseRef: ref("response-2"),
      stopReason: "stop",
      usage: usage(0, 10),
    });

    const third = await append(ledger, "model.requested", {
      model: "model-a",
      requestHash: "request-3",
      contextWatermark: 3,
      sessionId: "PRIVATE_SESSION_B",
      prefixHash: "PRIVATE_PREFIX_B",
    });
    await append(ledger, "model.failed", {
      model: "model-a",
      error: "provider unavailable",
    }, "main", third.eventId);

    const fourth = await append(ledger, "model.requested", {
      model: "model-a",
      requestHash: "request-4",
      contextWatermark: 4,
    });
    await append(ledger, "model.cancelled", {
      requestId: fourth.eventId,
      reason: "operator",
    });

    await append(ledger, "model.requested", {
      model: "model-a",
      requestHash: "request-5",
      contextWatermark: 5,
      sessionId: "PRIVATE_SESSION_B",
      prefixHash: "PRIVATE_PREFIX_B",
      truncations: [{
        kind: "artifact-byte-limit",
        detail: "PRIVATE_ARTIFACT_TRUNCATION_DETAIL",
      }],
      contextBuildMs: 2,
    });
    await append(ledger, "model.completed", {
      model: "model-teto",
      responseRef: ref("orphan-response"),
      stopReason: "stop",
      usage: usage(0, 0),
    }, "teto");

    const events = await ledger.read();
    const otherRun = {
      ...events[0]!,
      eventId: "other-run-event",
      runId: "run-2",
      globalOffset: 100,
    } as AnyEvent;
    const report = projectCacheEvidence([otherRun, ...events].reverse(), "run-1");

    expect(report).toMatchObject({
      runId: "run-1",
      eventCount: 10,
      total: {
        requestCount: 5,
        completed: 2,
        failed: 1,
        cancelled: 1,
        pending: 1,
        orphanTerminals: 1,
        prefix: {
          requests: 5,
          fingerprinted: 4,
          distinctFingerprints: 2,
          baseline: 1,
          stable: 1,
          changed: 1,
          unknown: 2,
          comparable: 2,
          stableRate: 0.5,
        },
        sessionAffinity: {
          requests: 5,
          identified: 4,
          distinctSessions: 2,
          baseline: 1,
          stable: 1,
          changed: 1,
          unknown: 2,
          comparable: 2,
          stableRate: 0.5,
        },
        truncation: {
          requests: 5,
          known: 3,
          unknown: 2,
          truncated: 2,
          truncatedRate: 2 / 3,
          reasonCounts: {
            "input-token-budget": 1,
            "artifact-byte-limit": 1,
          },
        },
        provider: {
          completions: 3,
          known: 2,
          unknown: 1,
          hit: 1,
          write: 1,
          hitWrite: 0,
          readEvidence: 1,
          writeEvidence: 1,
          observabilityRate: 2 / 3,
          readEvidenceRate: 1 / 3,
          writeEvidenceRate: 1 / 3,
          cacheReadTokens: 40,
          cacheWriteTokens: 10,
        },
        contextBuild: {
          total: 5,
          known: 3,
          unknown: 2,
          totalMs: 14,
          p50Ms: 5,
          p95Ms: 7,
        },
        modelLatency: {
          total: 3,
          known: 1,
          unknown: 2,
          totalMs: 11,
          p50Ms: 11,
          p95Ms: 11,
        },
      },
    });
    expect(report.entries.map((entry) => ({
      ordinal: entry.ordinal,
      prefix: entry.prefixContinuity,
      session: entry.sessionContinuity,
      truncations: entry.truncationKinds,
      cache: entry.providerCache,
      status: entry.status,
      link: entry.terminalLink,
    }))).toEqual([
      { ordinal: 1, prefix: "baseline", session: "baseline", truncations: [], cache: "hit", status: "completed", link: "causation" },
      { ordinal: 2, prefix: "stable", session: "stable", truncations: ["input-token-budget"], cache: "write", status: "completed", link: "legacy-fifo" },
      { ordinal: 3, prefix: "changed", session: "changed", truncations: null, cache: "unknown", status: "failed", link: "causation" },
      { ordinal: 4, prefix: "unknown", session: "unknown", truncations: null, cache: "unknown", status: "cancelled", link: "request-id" },
      { ordinal: 5, prefix: "unknown", session: "unknown", truncations: ["artifact-byte-limit"], cache: "unknown", status: "pending", link: "none" },
      { ordinal: null, prefix: "unknown", session: "unknown", truncations: null, cache: "unknown", status: "completed", link: "orphan" },
    ]);
    expect(report.lanes.teto).toMatchObject({
      requestCount: 0,
      orphanTerminals: 1,
      provider: { completions: 1, known: 0, unknown: 1 },
    });

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("PRIVATE_PREFIX");
    expect(serialized).not.toContain("PRIVATE_REQUEST_HASH");
    expect(serialized).not.toContain("PRIVATE_DEPENDENCY");
    expect(serialized).not.toContain("PRIVATE_RESPONSE");
    expect(serialized).not.toContain("PRIVATE_SESSION");
    expect(serialized).not.toContain("PRIVATE_TRUNCATION");
    expect(serialized).not.toContain("PRIVATE_ARTIFACT_TRUNCATION_DETAIL");
  });

  it("does not hide an invalid explicit causation id behind legacy FIFO", async () => {
    const ledger = new MemoryLedger();
    await append(ledger, "model.requested", {
      model: "model-a",
      requestHash: "request",
      contextWatermark: 1,
      sessionId: "session-a",
      prefixHash: "prefix-a",
      truncations: [],
    });
    await append(ledger, "model.completed", {
      model: "model-a",
      responseRef: ref("response"),
      stopReason: "stop",
      usage: usage(5, 0),
      cacheOutcome: "hit",
    }, "main", "missing-request-event");

    const report = projectCacheEvidence(await ledger.read(), "run-1");

    expect(report.entries.map((entry) => ({
      status: entry.status,
      link: entry.terminalLink,
      requestEventId: entry.requestEventId,
    }))).toEqual([
      expect.objectContaining({ status: "pending", link: "none" }),
      { status: "completed", link: "orphan", requestEventId: null },
    ]);
    expect(report.total).toMatchObject({
      requestCount: 1,
      completed: 0,
      pending: 1,
      orphanTerminals: 1,
      provider: { completions: 1, hit: 1 },
    });
  });

  it("starts a new continuity baseline when the Main model changes", async () => {
    const ledger = new MemoryLedger();
    await append(ledger, "model.requested", {
      model: "model-a",
      requestHash: "request-a",
      contextWatermark: 1,
      sessionId: "shared-session",
      prefixHash: "shared-prefix",
      truncations: [],
    });
    await append(ledger, "model.requested", {
      model: "model-b",
      requestHash: "request-b-1",
      contextWatermark: 2,
      sessionId: "shared-session",
      prefixHash: "shared-prefix",
      truncations: [],
    });
    await append(ledger, "model.requested", {
      model: "model-b",
      requestHash: "request-b-2",
      contextWatermark: 3,
      sessionId: "shared-session",
      prefixHash: "shared-prefix",
      truncations: [],
    });

    const report = projectCacheEvidence(await ledger.read(), "run-1");
    expect(report.entries.map((entry) => ({
      model: entry.model,
      prefix: entry.prefixContinuity,
      session: entry.sessionContinuity,
    }))).toEqual([
      { model: "model-a", prefix: "baseline", session: "baseline" },
      { model: "model-b", prefix: "baseline", session: "baseline" },
      { model: "model-b", prefix: "stable", session: "stable" },
    ]);
  });

  it("keeps legacy zero counters and missing prefix data unknown", async () => {
    const ledger = new MemoryLedger();
    await append(ledger, "model.requested", {
      model: "legacy-model",
      requestHash: "legacy-request",
      contextWatermark: 1,
    });
    await append(ledger, "model.completed", {
      model: "legacy-model",
      responseRef: ref("legacy-response"),
      stopReason: "stop",
      usage: usage(0, 0),
    });

    const report = projectCacheEvidence(await ledger.read(), "run-1");

    expect(report.entries[0]).toMatchObject({
      prefixContinuity: "unknown",
      sessionContinuity: "unknown",
      truncationKinds: null,
      providerCache: "unknown",
      terminalLink: "legacy-fifo",
      contextBuildMs: null,
      modelLatencyMs: null,
    });
    expect(report.total.prefix.stableRate).toBeNull();
    expect(report.total.provider).toMatchObject({
      completions: 1,
      known: 0,
      unknown: 1,
      observabilityRate: 0,
      readEvidenceRate: 0,
      writeEvidenceRate: 0,
    });
  });

  it("returns null rates when a Run has no cache samples", () => {
    const report = projectCacheEvidence([], "missing-run");

    expect(report.entries).toEqual([]);
    expect(report.lanes).toEqual({});
    expect(report.total.prefix.stableRate).toBeNull();
    expect(report.total.provider.observabilityRate).toBeNull();
    expect(report.total.contextBuild.p95Ms).toBeNull();
  });
});

let sequence = 0;

async function append<K extends EventType>(
  ledger: MemoryLedger,
  type: K,
  payload: AppendEvent<K>["payload"],
  laneId = "main",
  causationId?: string,
): Promise<EventEnvelope<K>> {
  sequence += 1;
  return ledger.append({
    runId: "run-1",
    turnId: "turn-1",
    laneId,
    type,
    payload,
    ...(causationId === undefined ? {} : { causationId }),
    correlationId: "run-1",
    idempotencyKey: `${type}:${sequence}`,
    occurredAt: new Date(sequence * 10).toISOString(),
  });
}

function usage(cacheRead: number, cacheWrite: number) {
  return {
    input: 100,
    output: 20,
    cacheRead,
    cacheWrite,
  };
}

function ref(id: string) {
  return {
    id,
    contentHash: `sha256:${"a".repeat(64)}`,
    mediaType: "application/json",
    byteLength: id.length,
  };
}
