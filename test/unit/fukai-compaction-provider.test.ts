import { describe, expect, it, vi } from "vitest";

import type { AppendEvent } from "../../src/domain/events.js";
import type { Goal, RunPolicy } from "../../src/domain/types.js";
import {
  ContentStoreFukaiSource,
  createFukaiCompactionProvider,
  FukaiCompactionBudgetError,
  FukaiCompactionTimeoutError,
  FukaiCore,
} from "../../src/fukai/index.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

const goal: Goal = {
  version: 1,
  statement: "Inspect the workspace",
  successCriteria: ["Return verified evidence"],
  hardConstraints: ["Stay in the workspace"],
};

const compactionId = `fukai-compaction:sha256:${"a".repeat(64)}`;

const policy: RunPolicy = {
  maxMainSteps: 10,
  maxModelTokens: 5_000,
  tetoEnabled: false,
  tetoMaxOutputTokens: 200,
  tetoTokenRatio: 0.1,
};

describe("FukaiCompactionProviderAdapter", () => {
  it("persists a deterministic selection accepted by FukaiCore", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    const source = await store.put("verified evidence", "text/plain");
    await ledger.append(command("assistant.message", { messageRef: source }));
    const upperWatermark = await ledger.watermark();
    const sourceRefs = [{ kind: "artifact" as const, ref: source }];
    const provider = createFukaiCompactionProvider({
      store,
      generateSummary: async (request) => ({
        schemaVersion: 1,
        goal: request.goal,
        decisions: ["Use the existing package manager"],
        verifiedResults: ["The source artifact is available"],
        openQuestions: [],
        sourceRefs: [...request.sourceRefs],
      }),
    });

    const selection = await provider.compact({
      compactionId,
      runId: "run-1",
      laneId: "main",
      goal,
      policyVersion: "policy-v1",
      cursor: `offset:${upperWatermark}`,
      upperWatermark,
      sourceRefs,
      budget: {
        maxInputTokens: 1_000,
        maxOutputTokens: 1_000,
        maxWallClockMs: 1_000,
      },
    });

    expect(selection.capsule).toMatchObject({
      schemaVersion: 1,
      compactionId,
      status: "ready",
      sourceRefs,
      cursor: `offset:${upperWatermark}`,
      upperWatermark,
      goalVersion: goal.version,
      policyVersion: "policy-v1",
    });
    expect(selection.capsule.summaryHash).toBe(selection.capsule.summaryRef.contentHash);
    expect(selection.capsule.estimatedTokens).toBeGreaterThan(0);
    expect(JSON.parse(new TextDecoder().decode(await store.get(selection.capsule.summaryRef))))
      .toEqual(selection.summary);

    const core = new FukaiCore(ledger, new ContentStoreFukaiSource(store));
    await expect(core.commitCompaction({
      runId: "run-1",
      laneId: "main",
      compactionId,
      goal,
      policyVersion: "policy-v1",
      selection,
    })).resolves.toMatchObject({
      type: "fukai.compaction.committed",
      payload: { compactionId },
    });
  });

  it("rejects an exhausted input budget before invoking the generator", async () => {
    const store = new MemoryContentAddressedStore();
    const source = await store.put("source", "text/plain");
    const generateSummary = vi.fn();
    const provider = createFukaiCompactionProvider({ store, generateSummary });

    await expect(provider.compact({
      compactionId,
      runId: "run-1",
      laneId: "main",
      goal,
      policyVersion: "policy-v1",
      cursor: "offset:1",
      upperWatermark: 1,
      sourceRefs: [{ kind: "artifact", ref: source }],
      budget: { maxInputTokens: 1, maxOutputTokens: 100, maxWallClockMs: 1_000 },
    })).rejects.toBeInstanceOf(FukaiCompactionBudgetError);
    expect(generateSummary).not.toHaveBeenCalled();
  });

  it("rejects a non-deterministic compaction identity before generation", async () => {
    const store = new MemoryContentAddressedStore();
    const source = await store.put("source", "text/plain");
    const generateSummary = vi.fn();
    const provider = createFukaiCompactionProvider({ store, generateSummary });

    await expect(provider.compact({
      ...requestFor(source),
      compactionId: "random-id",
    })).rejects.toThrow(/deterministic/i);
    expect(generateSummary).not.toHaveBeenCalled();
  });

  it("does not persist a summary that exceeds the output budget", async () => {
    const delegate = new MemoryContentAddressedStore();
    const source = await delegate.put("source", "text/plain");
    const put = vi.fn(delegate.put.bind(delegate));
    const providerUsage = { input: 80, output: 12, cacheRead: 8, cacheWrite: 0 };
    const provider = createFukaiCompactionProvider({
      store: { put },
      generateSummary: (request) => ({
        summary: {
          schemaVersion: 1,
          goal: request.goal,
          decisions: ["This decision is intentionally longer than one output token"],
          verifiedResults: [],
          openQuestions: [],
          sourceRefs: [...request.sourceRefs],
        },
        providerUsage,
      }),
    });

    const result = provider.compact({
      compactionId,
      runId: "run-1",
      laneId: "main",
      goal,
      policyVersion: "policy-v1",
      cursor: "offset:1",
      upperWatermark: 1,
      sourceRefs: [{ kind: "artifact", ref: source }],
      budget: { maxInputTokens: 1_000, maxOutputTokens: 1, maxWallClockMs: 1_000 },
    });
    await expect(result).rejects.toBeInstanceOf(FukaiCompactionBudgetError);
    await expect(result).rejects.toMatchObject({ providerUsage });
    expect(put).not.toHaveBeenCalled();
  });

  it("propagates a generator failure without writing a partial summary", async () => {
    const delegate = new MemoryContentAddressedStore();
    const source = await delegate.put("source", "text/plain");
    const put = vi.fn(delegate.put.bind(delegate));
    const failure = new Error("summary provider unavailable");
    const provider = createFukaiCompactionProvider({
      store: { put },
      generateSummary: async () => {
        throw failure;
      },
    });

    await expect(provider.compact(requestFor(source))).rejects.toBe(failure);
    expect(put).not.toHaveBeenCalled();
  });

  it("enforces one wall-clock deadline and aborts a hung generator", async () => {
    const store = new MemoryContentAddressedStore();
    const source = await store.put("source", "text/plain");
    let observedSignal: AbortSignal | undefined;
    const provider = createFukaiCompactionProvider({
      store,
      generateSummary: (request) => {
        observedSignal = request.signal;
        return new Promise(() => undefined);
      },
    });

    await expect(provider.compact({
      ...requestFor(source),
      budget: { maxInputTokens: 1_000, maxOutputTokens: 1_000, maxWallClockMs: 10 },
    })).rejects.toBeInstanceOf(FukaiCompactionTimeoutError);
    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBeInstanceOf(FukaiCompactionTimeoutError);
  });

  it("propagates caller cancellation through the generator signal", async () => {
    const store = new MemoryContentAddressedStore();
    const source = await store.put("source", "text/plain");
    const controller = new AbortController();
    const cancelled = new Error("cancel compaction");
    const provider = createFukaiCompactionProvider({
      store,
      generateSummary: (request) => new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(request.signal?.reason), {
          once: true,
        });
      }),
    });
    const pending = provider.compact({ ...requestFor(source), signal: controller.signal });
    controller.abort(cancelled);

    await expect(pending).rejects.toBe(cancelled);
  });
});

function requestFor(source: Awaited<ReturnType<MemoryContentAddressedStore["put"]>>) {
  return {
    compactionId,
    runId: "run-1",
    laneId: "main",
    goal,
    policyVersion: "policy-v1",
    cursor: "offset:1",
    upperWatermark: 1,
    sourceRefs: [{ kind: "artifact" as const, ref: source }],
    budget: { maxInputTokens: 1_000, maxOutputTokens: 1_000, maxWallClockMs: 1_000 },
  };
}

function command<K extends keyof import("../../src/domain/events.js").EventPayloadMap>(
  type: K,
  payload: import("../../src/domain/events.js").EventPayloadMap[K],
): AppendEvent<K> {
  return {
    runId: "run-1",
    laneId: "main",
    type,
    payload,
    correlationId: `test:${type}`,
    idempotencyKey: `test:${type}`,
  };
}
