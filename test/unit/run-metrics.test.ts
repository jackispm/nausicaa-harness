import { describe, expect, it } from "vitest";

import type {
  AnyEvent,
  AppendEvent,
  EventType,
} from "../../src/domain/events.js";
import type { TokenUsage } from "../../src/domain/types.js";
import {
  deriveContextCompactionAttemptId,
  deriveContextCompactionId,
  FUKAI_COMPACTION_MEDIA_TYPE,
} from "../../src/domain/context.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import {
  projectRunMetrics,
  type FukaiCompactionProviderObservation,
} from "../../src/observability/index.js";

const mainUsage: TokenUsage = {
  input: 100,
  output: 20,
  cacheRead: 80,
  cacheWrite: 10,
  costUsd: 0.01,
};
const tetoUsage: TokenUsage = {
  input: 20,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: 0.002,
};

describe("projectRunMetrics", () => {
  it("derives cost, cache, lane, Advice, tool, and latency metrics from facts", async () => {
    const ledger = new MemoryLedger();
    await append(ledger, "run.created", {
      goal: { version: 1, statement: "Inspect", successCriteria: [], hardConstraints: [] },
      workspace: "/workspace",
      policy: {
        maxMainSteps: 20,
        maxModelTokens: 20_000,
        tetoEnabled: true,
        tetoMaxOutputTokens: 200,
        tetoTokenRatio: 0.1,
      },
    }, "main", "2026-01-01T00:00:00.000Z");
    await append(ledger, "model.requested", {
      model: "scripted",
      requestHash: "request-1",
      contextWatermark: 1,
      prefixHash: "prefix-1",
      dependencyRefs: ["artifact-1"],
      contextBuildMs: 7,
    }, "main", "2026-01-01T00:00:00.100Z");
    await append(ledger, "model.requested", {
      model: "scripted",
      requestHash: "request-2",
      contextWatermark: 2,
      prefixHash: "prefix-1",
    }, "main", "2026-01-01T00:00:00.150Z");
    await append(ledger, "model.completed", {
      model: "scripted",
      responseRef: ref("answer"),
      stopReason: "toolUse",
      usage: mainUsage,
      modelLatencyMs: 13,
      cacheOutcome: "hit-write",
    }, "main", "2026-01-01T00:00:00.300Z");
    await append(ledger, "budget.charged", {
      laneId: "main",
      usage: mainUsage,
    }, "main", "2026-01-01T00:00:00.301Z");
    await append(ledger, "tool.requested", {
      operationId: "op-complete",
      toolCallId: "call-1",
      name: "read_file",
      argumentsRef: ref("args"),
    }, "main", "2026-01-01T00:00:00.400Z");
    await append(ledger, "tool.succeeded", {
      operationId: "op-complete",
      toolCallId: "call-1",
      name: "read_file",
      resultRef: ref("result"),
    }, "main", "2026-01-01T00:00:00.500Z");
    await append(ledger, "tool.requested", {
      operationId: "op-unknown",
      toolCallId: "call-2",
      name: "write_file",
      argumentsRef: ref("args-2"),
    }, "main", "2026-01-01T00:00:00.600Z");
    await append(ledger, "teto.observed", {
      mainCallIndex: 5,
      trigger: "credit",
      frameHash: "frame",
      usage: tetoUsage,
    }, "teto", "2026-01-01T00:00:00.700Z");
    await append(ledger, "budget.charged", {
      laneId: "teto",
      usage: tetoUsage,
    }, "teto", "2026-01-01T00:00:00.701Z");
    await append(ledger, "message.sent", {
      message: adviceMessage(),
    }, "teto", "2026-01-01T00:00:00.800Z");
    await append(ledger, "advice.acknowledged", {
      adviceId: "advice-1",
      disposition: "accept",
    }, "main", "2026-01-01T00:00:00.900Z");
    await append(ledger, "checkpoint.committed", {
      watermark: 11,
      checksum: "sha256:checkpoint",
    }, "main", "2026-01-01T00:00:01.000Z");

    const metrics = projectRunMetrics(await ledger.read(), "run-1");

    expect(metrics).toMatchObject({
      eventCount: 13,
      durationMs: 1_000,
      toolCalls: 2,
      toolFailures: 0,
      checkpoints: 1,
      unknownOperations: 1,
      cacheReadRatio: 80 / 210,
      fukaiCompaction: {
        runId: "run-1",
        eventCount: 13,
        observationCount: 0,
        total: {
          providerCalls: 0,
          committedCompactions: 0,
          context: { knownRequests: 0, unknownRequests: 2 },
        },
      },
    });
    expect(metrics.advice).toEqual({
      total: 1,
      accept: 1,
      defer: 0,
      reject: 0,
      pending: 0,
    });
    expect(metrics.total.usage).toEqual({
      input: 120,
      output: 25,
      cacheRead: 80,
      cacheWrite: 10,
      costUsd: 0.012,
    });
    expect(metrics.total.modelLatency).toEqual({
      count: 1,
      totalMs: 13,
      p50Ms: 13,
      p95Ms: 13,
    });
    expect(metrics.lanes.main).toMatchObject({
      modelRequests: 2,
      modelCompletions: 1,
      modelFailures: 0,
      contextBuild: { count: 1, totalMs: 7 },
      cache: {
        total: 1,
        hitWrite: 1,
        hitRate: 1,
        writeRate: 1,
        prefixSamples: 2,
        uniquePrefixes: 1,
        prefixChanges: 0,
        stablePrefixRate: 1,
      },
    });
    expect(metrics.lanes.teto).toMatchObject({ tetoPasses: 1, usage: tetoUsage });
  });

  it("is order independent and ignores other Runs", async () => {
    const ledger = new MemoryLedger();
    await append(ledger, "budget.charged", {
      laneId: "main",
      usage: mainUsage,
    }, "main", "2026-01-01T00:00:00.000Z");
    const events = await ledger.read();
    const other = { ...events[0]!, eventId: "other", runId: "run-2", globalOffset: 2 };

    expect(projectRunMetrics([other, ...events].reverse(), "run-1").total.usage).toEqual(mainUsage);
  });

  it("includes charged-only lane usage when another lane has model completions", async () => {
    const ledger = new MemoryLedger();
    await append(ledger, "model.completed", {
      model: "main-model",
      responseRef: ref("main-answer"),
      stopReason: "stop",
      usage: mainUsage,
    }, "main", "2026-01-01T00:00:00.000Z");
    await append(ledger, "budget.charged", {
      laneId: "main",
      usage: mainUsage,
    }, "main", "2026-01-01T00:00:00.001Z");
    await append(ledger, "budget.charged", {
      laneId: "reflection",
      usage: tetoUsage,
    }, "reflection", "2026-01-01T00:00:00.002Z");

    const metrics = projectRunMetrics(await ledger.read(), "run-1");

    expect(metrics.lanes.reflection).toMatchObject({
      modelCompletions: 0,
      usage: tetoUsage,
      chargedUsage: tetoUsage,
      modelUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(metrics.total.usage).toEqual({
      input: 120,
      output: 25,
      cacheRead: 80,
      cacheWrite: 10,
      costUsd: 0.012,
    });
    expect(metrics.total.modelUsage).toEqual(mainUsage);
    expect(metrics.total.chargedUsage).toEqual({
      input: 120,
      output: 25,
      cacheRead: 80,
      cacheWrite: 10,
      costUsd: 0.012,
    });
  });

  it("includes charged-only usage beside a successful call in the same lane", async () => {
    const ledger = new MemoryLedger();
    await append(ledger, "model.completed", {
      model: "main-model",
      responseRef: ref("main-answer"),
      stopReason: "stop",
      usage: mainUsage,
    }, "main", "2026-01-01T00:00:00.000Z");
    await append(ledger, "budget.charged", {
      laneId: "main",
      usage: mainUsage,
    }, "main", "2026-01-01T00:00:00.001Z");
    await append(ledger, "budget.charged", {
      laneId: "main",
      usage: tetoUsage,
    }, "main", "2026-01-01T00:00:00.002Z");

    expect(projectRunMetrics(await ledger.read(), "run-1").lanes.main?.usage)
      .toEqual({
        input: 120,
        output: 25,
        cacheRead: 80,
        cacheWrite: 10,
        costUsd: 0.012,
      });
  });

  it("reports prefix churn separately from provider cache outcomes", async () => {
    const ledger = new MemoryLedger();
    await append(ledger, "model.requested", {
      model: "scripted",
      requestHash: "request-1",
      contextWatermark: 1,
      prefixHash: "prefix-a",
    }, "main", "2026-01-01T00:00:00.000Z");
    await append(ledger, "model.requested", {
      model: "scripted",
      requestHash: "request-2",
      contextWatermark: 2,
      prefixHash: "prefix-b",
    }, "main", "2026-01-01T00:00:00.100Z");
    await append(ledger, "model.requested", {
      model: "scripted",
      requestHash: "request-3",
      contextWatermark: 3,
      prefixHash: "prefix-b",
    }, "main", "2026-01-01T00:00:00.200Z");

    expect(projectRunMetrics(await ledger.read(), "run-1").lanes.main?.cache).toMatchObject({
      total: 0,
      prefixSamples: 3,
      uniquePrefixes: 2,
      prefixChanges: 1,
      stablePrefixRate: 0.5,
    });
  });

  it("does not count normal Main and Teto prefix differences as churn", async () => {
    const ledger = new MemoryLedger();
    await append(ledger, "model.requested", {
      model: "main-model",
      requestHash: "main-1",
      contextWatermark: 1,
      prefixHash: "main-prefix",
    }, "main", "2026-01-01T00:00:00.000Z");
    await append(ledger, "model.requested", {
      model: "teto-model",
      requestHash: "teto-1",
      contextWatermark: 2,
      prefixHash: "teto-prefix",
    }, "teto", "2026-01-01T00:00:00.100Z");
    await append(ledger, "model.requested", {
      model: "main-model",
      requestHash: "main-2",
      contextWatermark: 3,
      prefixHash: "main-prefix",
    }, "main", "2026-01-01T00:00:00.200Z");

    expect(projectRunMetrics(await ledger.read(), "run-1").total.cache).toMatchObject({
      prefixSamples: 3,
      uniquePrefixes: 2,
      prefixChanges: 0,
      stablePrefixRate: 1,
    });
  });

  it("includes optional metered Fukai observations without changing Ledger projection", async () => {
    const ledger = new MemoryLedger();
    await append(ledger, "run.created", {
      goal: { version: 1, statement: "Inspect", successCriteria: [], hardConstraints: [] },
      workspace: "/workspace",
      policy: {
        maxMainSteps: 20,
        maxModelTokens: 20_000,
        tetoEnabled: true,
        tetoMaxOutputTokens: 200,
        tetoTokenRatio: 0.1,
      },
    }, "main", "2026-01-01T00:00:00.000Z");
    const observation: FukaiCompactionProviderObservation = {
      attemptId: "fukai-attempt-1",
      runId: "run-1",
      laneId: "main",
      status: "completed",
      budget: { maxInputTokens: 100, maxOutputTokens: 50, maxWallClockMs: 1_000 },
      elapsedMs: 12,
      estimatedOutputTokens: 7,
      summaryBytes: 32,
    };

    const metrics = projectRunMetrics(await ledger.read(), "run-1", [observation]);

    expect(metrics.fukaiCompaction.observationCount).toBe(1);
    expect(metrics.fukaiCompaction.total).toMatchObject({
      providerCalls: 1,
      providerStatus: { completed: 1 },
      usage: { knownCalls: 0, unknownCalls: 1 },
      selectedOutputTokens: 7,
      selectedSummaryBytes: 32,
    });
  });

  it("includes durable Fukai provider metrics without transient observations", async () => {
    const ledger = new MemoryLedger();
    const sourceRef = ref("source");
    const summaryRef = {
      ...ref("summary"),
      mediaType: FUKAI_COMPACTION_MEDIA_TYPE,
    };
    const compactionBudget = {
      maxInputTokens: 100,
      maxOutputTokens: 50,
      maxWallClockMs: 1_000,
    };
    const sourceRefs = [{ kind: "artifact" as const, ref: sourceRef }];
    const compactionId = deriveContextCompactionId({
      runId: "run-1",
      laneId: "main",
      cursor: "offset:1",
      upperWatermark: 1,
      goalVersion: 1,
      policyVersion: "policy-v1",
      sourceRefs,
      budget: compactionBudget,
    });
    const attemptId = deriveContextCompactionAttemptId(compactionId, 1);
    await append(ledger, "fukai.compaction.requested", {
      compactionId,
      attemptId,
      attempt: 1,
      cursor: "offset:1",
      upperWatermark: 1,
      goalVersion: 1,
      policyVersion: "policy-v1",
      sourceRefs,
      budget: compactionBudget,
    }, "main", "2026-01-01T00:00:00.000Z");
    await append(ledger, "fukai.compaction.completed", {
      compactionId,
      attemptId,
      attempt: 1,
      elapsedMs: 18,
      usage: tetoUsage,
      summaryRef,
      summaryHash: summaryRef.contentHash,
      estimatedTokens: 5,
    }, "main", "2026-01-01T00:00:00.018Z");
    await append(ledger, "fukai.compaction.committed", {
      compactionId,
      attemptId,
      summaryRef,
      sourceRefs,
      cursor: "offset:1",
      upperWatermark: 1,
      goalVersion: 1,
      policyVersion: "policy-v1",
      summaryHash: summaryRef.contentHash,
      estimatedTokens: 5,
    }, "main", "2026-01-01T00:00:00.020Z");

    expect(projectRunMetrics(await ledger.read(), "run-1").fukaiCompaction.total)
      .toMatchObject({
        providerCalls: 1,
        providerStatus: { completed: 1, failed: 0, timedOut: 0, cancelled: 0 },
        providerLatency: { count: 1, totalMs: 18, p50Ms: 18, p95Ms: 18 },
        usage: { knownCalls: 1, unknownCalls: 0, total: tetoUsage },
        committedCompactions: 1,
        committedOutputTokens: 5,
      });
  });
});

async function append<K extends EventType>(
  ledger: MemoryLedger,
  type: K,
  payload: AppendEvent<K>["payload"],
  laneId: string,
  occurredAt: string,
): Promise<void> {
  await ledger.append({
    runId: "run-1",
    laneId,
    type,
    payload,
    correlationId: "run-1",
    idempotencyKey: `${type}:${occurredAt}`,
    occurredAt,
  });
}

function ref(id: string) {
  return {
    id,
    contentHash: `sha256:${id.padEnd(64, "0")}`,
    mediaType: "application/json",
    byteLength: id.length,
  };
}

function adviceMessage() {
  return {
    messageId: "message-1",
    runId: "run-1",
    conversationId: "run-1",
    threadId: "run-1:main",
    from: "teto",
    to: "main",
    createdAt: "2026-01-01T00:00:00.800Z",
    expiresAt: "2026-01-01T01:00:00.000Z",
    correlationId: "run-1",
    idempotencyKey: "advice-1",
    visibility: "run" as const,
    priority: 1,
    delivery: "next-step" as const,
    payload: {
      type: "advice.propose" as const,
      advice: {
        adviceId: "advice-1",
        kind: "orientation" as const,
        claim: "Stay aligned",
        evidenceRefs: [],
        confidence: 0.8,
        risk: "low" as const,
        suggestedAction: "Continue",
        urgency: "next-step" as const,
        expiresAt: "2026-01-01T01:00:00.000Z",
        dedupeKey: "stay-aligned",
        sourceLane: "teto",
      },
    },
  };
}
