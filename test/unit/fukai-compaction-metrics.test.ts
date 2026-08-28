import { describe, expect, it, vi } from "vitest";

import type { AppendEvent } from "../../src/domain/events.js";
import type { ContextManifest } from "../../src/domain/context.js";
import type { Goal, TokenUsage } from "../../src/domain/types.js";
import {
  deriveContextCompactionAttemptId,
  deriveContextCompactionId,
} from "../../src/domain/context.js";
import {
  createMeteredFukaiCompactionProvider,
  projectFukaiCompactionMetrics,
} from "../../src/observability/index.js";
import {
  FukaiCompactionTimeoutError,
} from "../../src/fukai/index.js";
import type {
  FukaiCompactionProvider,
  FukaiCompactionRequest,
  FukaiCompactionSelection,
} from "../../src/fukai/index.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

const goal: Goal = {
  version: 1,
  statement: "Inspect the workspace",
  successCriteria: ["return evidence"],
  hardConstraints: ["stay in workspace"],
};

const budget = {
  maxInputTokens: 100,
  maxOutputTokens: 50,
  maxWallClockMs: 1_000,
};

describe("Fukai compaction observability", () => {
  it("counts durable budget admission fallback without a provider call", async () => {
    const ledger = new MemoryLedger();
    const compactionId = `fukai-compaction:sha256:${"a".repeat(64)}`;
    await ledger.append(command("fukai.compaction.fallback", {
      compactionId,
      attemptId: null,
      attempt: null,
      reason: "budget-exhausted",
      phase: "preflight",
    }, "main", "run-1"));

    const metrics = projectFukaiCompactionMetrics(await ledger.read(), "run-1");

    expect(metrics.total).toMatchObject({
      providerCalls: 0,
      budget: { calls: 0 },
      usage: { knownCalls: 0, unknownCalls: 0 },
      fallbacks: {
        total: 1,
        budgetExhausted: 1,
        stale: 0,
        verificationFailed: 0,
        preflight: 1,
        commit: 0,
        readBack: 0,
      },
    });
    expect(metrics.lanes.main).toMatchObject({
      providerCalls: 0,
      fallbacks: { total: 1, budgetExhausted: 1, preflight: 1 },
    });
  });

  it("records one physical provider call with optional usage and bounded timing", async () => {
    const now = vi
      .fn<() => number>()
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(37);
    const usage: TokenUsage = {
      input: 80,
      output: 14,
      cacheRead: 20,
      cacheWrite: 0,
      costUsd: 0.002,
    };
    const selection = selectionFor(14, 96);
    const provider: FukaiCompactionProvider = {
      compact: vi.fn(async () => selection),
    };
    const metered = createMeteredFukaiCompactionProvider({
      provider,
      now,
      attemptIdForRequest: () => "attempt-1",
      usageFromSelection: () => usage,
    });

    await expect(metered.compact(requestFor("run-1", "main"))).resolves.toBe(selection);
    expect(provider.compact).toHaveBeenCalledTimes(1);
    expect(metered.snapshot()).toEqual([{
      attemptId: "attempt-1",
      runId: "run-1",
      laneId: "main",
      status: "completed",
      budget,
      elapsedMs: 27,
      usage,
      estimatedOutputTokens: 14,
      summaryBytes: 96,
    }]);
  });

  it("requires an attributed attempt identity before provider IO", async () => {
    const provider: FukaiCompactionProvider = {
      compact: vi.fn(async () => selectionFor(1, 1)),
    };
    const metered = createMeteredFukaiCompactionProvider({
      provider,
      attemptIdForRequest: () => "",
    });

    await expect(metered.compact(requestFor("run-1", "main")))
      .rejects.toThrow("attempt ID must be non-empty");
    expect(provider.compact).not.toHaveBeenCalled();
    expect(metered.snapshot()).toEqual([]);
  });

  it("classifies timeout and cancellation without leaking error text", async () => {
    const now = vi.fn<() => number>().mockReturnValue(0);
    const timeout = new FukaiCompactionTimeoutError("private provider detail");
    const controller = new AbortController();
    let rejectProvider: ((error: unknown) => void) | undefined;
    const provider: FukaiCompactionProvider = {
      compact: vi.fn()
        .mockRejectedValueOnce(timeout)
        .mockImplementationOnce(() => new Promise((_resolve, reject) => {
          rejectProvider = reject;
        })),
    };
    const metered = createMeteredFukaiCompactionProvider({
      provider,
      now,
      attemptIdForRequest: (request) => `attempt-${request.laneId}`,
    });

    await expect(metered.compact(requestFor("run-1", "main"))).rejects.toBe(timeout);
    const pending = metered.compact({
      ...requestFor("run-1", "teto"),
      signal: controller.signal,
    });
    controller.abort(new Error("private cancellation detail"));
    rejectProvider?.(controller.signal.reason);
    await expect(pending).rejects.toThrow("private cancellation detail");

    expect(metered.snapshot().map(({ attemptId, laneId, status, elapsedMs }) => ({
      attemptId,
      laneId,
      status,
      elapsedMs,
    }))).toEqual([
      { attemptId: "attempt-main", laneId: "main", status: "timed-out", elapsedMs: 0 },
      { attemptId: "attempt-teto", laneId: "teto", status: "cancelled", elapsedMs: 0 },
    ]);
    expect(JSON.stringify(metered.snapshot())).not.toContain("private provider detail");
  });

  it("replays durable attempts, commits, fallbacks, and context without double counting", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const summary = await store.put("summary", "application/vnd.nausicaa.fukai-compaction+json");
    const sourceRefs = [{ kind: "artifact" as const, ref: summary }];
    const mainCompactionId = deriveContextCompactionId({
      runId: "run-1",
      laneId: "main",
      cursor: "offset:2",
      upperWatermark: 2,
      goalVersion: 1,
      policyVersion: "policy-v1",
      sourceRefs,
      budget,
    });
    const mainAttemptId = deriveContextCompactionAttemptId(mainCompactionId, 1);
    await ledger.append(command("fukai.compaction.requested", {
      compactionId: mainCompactionId,
      attemptId: mainAttemptId,
      attempt: 1,
      cursor: "offset:2",
      upperWatermark: 2,
      goalVersion: 1,
      policyVersion: "policy-v1",
      sourceRefs,
      budget,
    }, "main", "run-1"));
    const mainUsage = { input: 40, output: 8, cacheRead: 5, cacheWrite: 0 };
    await ledger.append(command("fukai.compaction.completed", {
      compactionId: mainCompactionId,
      attemptId: mainAttemptId,
      attempt: 1,
      elapsedMs: 20,
      usage: mainUsage,
      summaryRef: summary,
      summaryHash: summary.contentHash,
      estimatedTokens: 8,
    }, "main", "run-1"));
    await ledger.append(command("fukai.compaction.committed", {
      compactionId: mainCompactionId,
      attemptId: mainAttemptId,
      summaryRef: summary,
      sourceRefs,
      cursor: "offset:2",
      upperWatermark: 2,
      goalVersion: 1,
      policyVersion: "policy-v1",
      summaryHash: summary.contentHash,
      estimatedTokens: 8,
    }, "main", "run-1"));
    await ledger.append(command("fukai.compaction.fallback", {
      compactionId: mainCompactionId,
      attemptId: mainAttemptId,
      attempt: 1,
      reason: "verification-failed",
      phase: "commit",
    }, "main", "run-1"));

    const failedBudget = { maxInputTokens: 10, maxOutputTokens: 20, maxWallClockMs: 30 };
    const failedCompactionId = deriveContextCompactionId({
      runId: "run-1",
      laneId: "teto",
      cursor: "offset:2",
      upperWatermark: 2,
      goalVersion: 1,
      policyVersion: "policy-v1",
      sourceRefs,
      budget: failedBudget,
    });
    const failedAttemptId = deriveContextCompactionAttemptId(failedCompactionId, 1);
    await ledger.append(command("fukai.compaction.requested", {
      compactionId: failedCompactionId,
      attemptId: failedAttemptId,
      attempt: 1,
      cursor: "offset:2",
      upperWatermark: 2,
      goalVersion: 1,
      policyVersion: "policy-v1",
      sourceRefs,
      budget: failedBudget,
    }, "teto", "run-1"));
    await ledger.append(command("fukai.compaction.failed", {
      compactionId: failedCompactionId,
      attemptId: failedAttemptId,
      attempt: 1,
      status: "failed",
      elapsedMs: 30,
      usage: null,
    }, "teto", "run-1"));
    await ledger.append(command("fukai.compaction.fallback", {
      compactionId: failedCompactionId,
      attemptId: failedAttemptId,
      attempt: 1,
      reason: "stale",
      phase: "read-back",
    }, "teto", "run-1"));

    const otherCompactionId = deriveContextCompactionId({
      runId: "run-2",
      laneId: "main",
      cursor: "offset:2",
      upperWatermark: 2,
      goalVersion: 1,
      policyVersion: "policy-v1",
      sourceRefs,
      budget,
    });
    const otherAttemptId = deriveContextCompactionAttemptId(otherCompactionId, 1);
    await ledger.append(command("fukai.compaction.requested", {
      compactionId: otherCompactionId,
      attemptId: otherAttemptId,
      attempt: 1,
      cursor: "offset:2",
      upperWatermark: 2,
      goalVersion: 1,
      policyVersion: "policy-v1",
      sourceRefs,
      budget,
    }, "main", "run-2"));
    await ledger.append({ ...command("model.requested", {
      model: "main-model",
      requestHash: "request-ready",
      contextWatermark: 3,
      contextManifest: manifestFor("ready", 12, mainCompactionId),
    }, "main", "run-1"), idempotencyKey: "test:model.requested:ready" });
    await ledger.append({ ...command("model.requested", {
      model: "main-model",
      requestHash: "request-stale",
      contextWatermark: 4,
      contextManifest: manifestFor("stale", 12, mainCompactionId),
    }, "main", "run-1"), idempotencyKey: "test:model.requested:stale" });
    await ledger.append({ ...command("model.requested", {
      model: "legacy-model",
      requestHash: "request-legacy",
      contextWatermark: 5,
    }, "teto", "run-1"), idempotencyKey: "test:model.requested:legacy" });

    const observedSelection = selectionFor(999, 999);
    const metered = createMeteredFukaiCompactionProvider({
      provider: { compact: vi.fn(async () => observedSelection) },
      now: () => 999,
      attemptIdForRequest: () => mainAttemptId,
      usageFromSelection: () => ({
        input: 999,
        output: 999,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    });
    await metered.compact({
      ...requestFor("run-1", "main"),
      compactionId: mainCompactionId,
    });
    const observations = metered.snapshot();

    const events = await ledger.read();
    const metrics = projectFukaiCompactionMetrics(
      [...events, ...events],
      "run-1",
      observations,
    );
    expect(metrics.eventCount).toBe(10);
    expect(metrics.observationCount).toBe(0);
    expect(metrics.total).toMatchObject({
      providerCalls: 2,
      providerStatus: { completed: 1, failed: 1, timedOut: 0, cancelled: 0 },
      providerLatency: { count: 2, totalMs: 50, p50Ms: 20, p95Ms: 30 },
      budget: {
        calls: 2,
        allocatedInputTokens: 110,
        allocatedOutputTokens: 70,
        allocatedWallClockMs: 1_030,
      },
      usage: {
        knownCalls: 1,
        unknownCalls: 1,
        total: { input: 40, output: 8, cacheRead: 5, cacheWrite: 0 },
      },
      context: {
        knownRequests: 2,
        unknownRequests: 1,
        emptySelections: 0,
        readySelections: 1,
        staleFallbacks: 1,
        injectedSummaryTokens: 12,
      },
      fallbacks: {
        total: 2,
        budgetExhausted: 0,
        stale: 1,
        verificationFailed: 1,
        preflight: 0,
        commit: 1,
        readBack: 1,
      },
      selectedOutputTokens: 8,
      selectedSummaryBytes: summary.byteLength,
      committedCompactions: 1,
      committedOutputTokens: 8,
      committedSummaryBytes: summary.byteLength,
    });
    expect(metrics.lanes.main).toMatchObject({
      providerCalls: 1,
      committedCompactions: 1,
      committedOutputTokens: 8,
      fallbacks: { total: 1, verificationFailed: 1, commit: 1 },
      context: { readySelections: 1, staleFallbacks: 1, injectedSummaryTokens: 12 },
    });
    expect(metrics.lanes.teto).toMatchObject({
      providerCalls: 1,
      committedCompactions: 0,
      providerStatus: { failed: 1 },
      fallbacks: { total: 1, stale: 1, readBack: 1 },
      context: { knownRequests: 0, unknownRequests: 1 },
    });
  });
});

function manifestFor(
  status: "ready" | "stale",
  estimatedTokens: number,
  compactionId: string,
): ContextManifest {
  const slot = (hash: string) => ({
    state: "present" as const,
    itemCount: 1,
    estimatedTokens: 1,
    hash,
  });
  const summaryRef = {
    id: "summary",
    contentHash: "sha256:summary",
    mediaType: "application/vnd.nausicaa.fukai-compaction+json",
    byteLength: 12,
  };
  return {
    schemaVersion: 1,
    slots: {
      goal: slot("goal"),
      policy: slot("policy"),
      tools: slot("tools"),
      inbox: slot("inbox"),
      compaction: {
        state: status === "ready" ? "present" : "bounded",
        itemCount: 1,
        estimatedTokens,
        hash: `compaction-${status}`,
        status,
        compactionId,
        summaryRef,
        sourceRefs: [{ kind: "artifact", ref: summaryRef }],
        summaryHash: summaryRef.contentHash,
        cursor: "offset:2",
        upperWatermark: 2,
        goalVersion: 1,
        policyVersion: "policy-v1",
      },
      "lane-context": slot("lane-context"),
    },
    prefixHash: "prefix",
    dynamicHash: `dynamic-${status}`,
    upperWatermark: 2,
    policyVersion: "policy-v1",
  };
}

function requestFor(runId: string, laneId: string): FukaiCompactionRequest {
  const compactionId = `fukai-compaction:sha256:${"0".repeat(64)}`;
  return {
    runId,
    laneId,
    compactionId,
    goal,
    policyVersion: "policy-v1",
    cursor: "offset:2",
    upperWatermark: 2,
    sourceRefs: [],
    budget,
  };
}

function selectionFor(
  estimatedTokens: number,
  byteLength: number,
): FukaiCompactionSelection {
  const compactionId = `fukai-compaction:sha256:${"0".repeat(64)}`;
  return {
    capsule: {
      schemaVersion: 1,
      compactionId,
      status: "ready",
      summaryRef: {
        id: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        contentHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        mediaType: "application/vnd.nausicaa.fukai-compaction+json",
        byteLength,
      },
      sourceRefs: [],
      summaryHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      cursor: "offset:2",
      upperWatermark: 2,
      goalVersion: 1,
      policyVersion: "policy-v1",
      estimatedTokens,
    },
    summary: {
      schemaVersion: 1,
      goal,
      decisions: ["Keep evidence bounded"],
      verifiedResults: [],
      openQuestions: [],
      sourceRefs: [],
    },
  };
}

function command<K extends keyof import("../../src/domain/events.js").EventPayloadMap>(
  type: K,
  payload: import("../../src/domain/events.js").EventPayloadMap[K],
  laneId: string,
  runId: string,
): AppendEvent<K> {
  return {
    runId,
    laneId,
    type,
    payload,
    correlationId: `test:${type}:${runId}`,
    idempotencyKey: `test:${type}:${runId}:${laneId}`,
  };
}
