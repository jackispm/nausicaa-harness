import { describe, expect, it, vi } from "vitest";

import type {
  AnyEvent,
  AppendEvent,
  EventEnvelope,
  EventType,
} from "../../src/domain/events.js";
import type { ModelPort } from "../../src/domain/ports.js";
import {
  deriveContextCompactionAttemptId,
  deriveContextCompactionId,
  FUKAI_COMPACTION_MEDIA_TYPE,
} from "../../src/domain/context.js";
import type { Goal, TokenUsage } from "../../src/domain/types.js";
import {
  ContentStoreFukaiSource,
  createFukaiCompactionCoordinator,
  createFukaiCompactionProvider,
  FukaiCore,
  FukaiContextProvider,
  fukaiCompactionInputTokenUpperBound,
  piAiFukaiCompactionGeneration,
  PiAiFukaiCompactionOutputError,
  projectFukai,
  type FukaiCompactionCommitRequest,
  type FukaiCompactionCorePort,
  type FukaiCompactionExecutionRequest,
  type FukaiCompactionProvider,
  type FukaiCompactionRequest,
  type FukaiCompactionReadRequest,
  type FukaiCompactionSelection,
  type FukaiCompactionView,
} from "../../src/fukai/index.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import {
  createRuntimeFukaiCompaction,
  recoverRunTokenUsage,
  RunTokenBudget,
  selectRuntimeFukaiCompactionSources,
} from "../../src/runtime/index.js";
import {
  ArtifactNotFoundError,
  createArtifactRef,
  MemoryContentAddressedStore,
  type ContentAddressedStore,
} from "../../src/store/index.js";

const goal: Goal = {
  version: 1,
  statement: "Inspect the workspace",
  successCriteria: ["return evidence"],
  hardConstraints: ["stay in workspace"],
};

const usage: TokenUsage = {
  input: 80,
  output: 12,
  cacheRead: 8,
  cacheWrite: 0,
  costUsd: 0.002,
};

const sourceRef = {
  kind: "artifact" as const,
  ref: {
    id: "source-1",
    contentHash: `sha256:${"a".repeat(64)}`,
    mediaType: "text/plain",
    byteLength: 12,
  },
};

const summaryRef = {
  id: "summary-1",
  contentHash: `sha256:${"b".repeat(64)}`,
  mediaType: FUKAI_COMPACTION_MEDIA_TYPE,
  byteLength: 96,
};

describe("FukaiCompactionCoordinator recovery", () => {
  it("persists budget admission rejection without inventing a provider attempt", async () => {
    const setup = createSetup({ tokenBudget: new RunTokenBudget(119) });

    const expected = {
      status: "skipped",
      compactionId: attemptIdentity(setup.request).compactionId,
      reason: "budget-exhausted",
    } as const;
    await expect(setup.coordinator.execute(setup.request)).resolves.toEqual(expected);
    await expect(setup.coordinator.execute(setup.request)).resolves.toEqual(expected);
    expect(setup.provider.compact).not.toHaveBeenCalled();
    expect(setup.tokenBudget.snapshot()).toMatchObject({
      usedTokens: 0,
      reservedTokens: 0,
    });
    expect(await setup.ledger.read()).toMatchObject([{
      type: "fukai.compaction.fallback",
      payload: {
        compactionId: attemptIdentity(setup.request).compactionId,
        attemptId: null,
        attempt: null,
        reason: "budget-exhausted",
        phase: "preflight",
      },
    }]);
  });

  it("persists completed before charging and commits one physical provider call", async () => {
    const setup = createSetup();

    const outcome = await setup.coordinator.execute(setup.request);

    expect(outcome).toMatchObject({ status: "committed", reused: false });
    expect(setup.provider.compact).toHaveBeenCalledTimes(1);
    expect(setup.core.commitCalls).toBe(1);
    expect((await setup.ledger.read()).map((event) => event.type)).toEqual([
      "fukai.compaction.requested",
      "fukai.compaction.completed",
      "budget.charged",
      "fukai.compaction.committed",
    ]);
    expect(setup.tokenBudget.snapshot().usedTokens).toBe(totalTokens(usage));
  });

  it("derives a new identity and executes a stale repair with unchanged sources and watermark", async () => {
    const ledger = new MemoryLedger();
    const ordinaryRequest = executionRequest();
    const staleId = attemptIdentity(ordinaryRequest).compactionId;
    const repairRequest = {
      ...ordinaryRequest,
      repairFromCompactionId: staleId,
    };
    const repairId = attemptIdentity(repairRequest).compactionId;
    const core = createRepairCore(ledger, staleId, staleId);
    const provider: FukaiCompactionProvider = {
      compact: vi.fn(async (request) => selectionFor(request.compactionId)),
    };
    const coordinator = createFukaiCompactionCoordinator({
      core,
      provider,
      ledger,
      tokenBudget: new RunTokenBudget(10_000),
    });

    expect(repairRequest.sourceRefs).toEqual(ordinaryRequest.sourceRefs);
    expect(repairRequest.upperWatermark).toBe(ordinaryRequest.upperWatermark);
    expect(repairId).not.toBe(staleId);
    await expect(coordinator.execute(repairRequest)).resolves.toMatchObject({
      status: "committed",
      compactionId: repairId,
      event: {
        payload: {
          compactionId: repairId,
          resetFromCompactionId: staleId,
        },
      },
    });
    expect(provider.compact).toHaveBeenCalledTimes(1);
    expect((await ledger.read()).find(
      (event) => event.type === "fukai.compaction.requested",
    )).toMatchObject({
      payload: {
        compactionId: repairId,
        repairFromCompactionId: staleId,
        sourceRefs: ordinaryRequest.sourceRefs,
        upperWatermark: ordinaryRequest.upperWatermark,
      },
    });
  });

  it("rejects a durable commit whose reset lineage does not match repair intent", async () => {
    const ledger = new MemoryLedger();
    const ordinaryRequest = executionRequest();
    const staleId = attemptIdentity(ordinaryRequest).compactionId;
    const request = { ...ordinaryRequest, repairFromCompactionId: staleId };
    const provider: FukaiCompactionProvider = {
      compact: vi.fn(async (providerRequest) => selectionFor(providerRequest.compactionId)),
    };
    const coordinator = createFukaiCompactionCoordinator({
      core: createRepairCore(ledger, staleId),
      provider,
      ledger,
      tokenBudget: new RunTokenBudget(10_000),
    });

    await expect(coordinator.execute(request)).resolves.toMatchObject({
      status: "skipped",
      reason: "verification-failed",
      error: expect.objectContaining({
        message: expect.stringContaining("requested repair lineage"),
      }),
    });
    expect((await ledger.read()).find(
      (event) => event.type === "fukai.compaction.fallback",
    )).toMatchObject({ payload: { phase: "read-back", reason: "verification-failed" } });
  });

  it("does not let its own lifecycle authorize an unadmitted conversation source", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    await ledger.append({
      runId: "run-unadmitted",
      laneId: "main",
      type: "run.created",
      payload: {
        goal,
        workspace: "/workspace",
        policy: {
          maxMainStepsPerActivation: 4,
          maxModelTokens: 10_000,
          tetoEnabled: false,
          tetoMaxOutputTokens: 200,
          tetoTokenRatio: 0.1,
        },
      },
      correlationId: "run:unadmitted",
      idempotencyKey: "run:created",
      visibility: "run",
    });
    const source = await store.put(JSON.stringify({
      role: "user",
      content: "never admitted to the Ledger",
      createdAt: "1970-01-01T00:00:00.000Z",
    }), "application/vnd.nausicaa.conversation-message+json");
    const request: FukaiCompactionExecutionRequest = {
      runId: "run-unadmitted",
      laneId: "main",
      goal,
      policyVersion: "policy-v1",
      cursor: "offset:4",
      // The future bound deliberately includes requested/completed/charged.
      upperWatermark: 4,
      sourceRefs: [{ kind: "conversation", ref: source }],
      budget: { maxInputTokens: 100, maxOutputTokens: 20, maxWallClockMs: 1_000 },
    };
    const provider: FukaiCompactionProvider = {
      async compact({ compactionId, sourceRefs }) {
        const summary = {
          schemaVersion: 1 as const,
          goal,
          decisions: [],
          verifiedResults: [],
          openQuestions: [],
          sourceRefs: structuredClone([...sourceRefs]),
        };
        const persisted = await store.put(
          JSON.stringify(summary),
          FUKAI_COMPACTION_MEDIA_TYPE,
        );
        return {
          capsule: {
            schemaVersion: 1 as const,
            compactionId,
            status: "ready" as const,
            summaryRef: persisted,
            sourceRefs: structuredClone([...sourceRefs]),
            summaryHash: persisted.contentHash,
            cursor: request.cursor,
            upperWatermark: request.upperWatermark,
            goalVersion: goal.version,
            policyVersion: request.policyVersion,
            estimatedTokens: 12,
          },
          summary,
          providerUsage: usage,
        };
      },
    };
    const coordinator = createFukaiCompactionCoordinator({
      core: new FukaiCore(ledger, new ContentStoreFukaiSource(store)),
      provider,
      ledger,
      tokenBudget: new RunTokenBudget(10_000),
    });

    await expect(coordinator.execute(request)).resolves.toMatchObject({
      status: "skipped",
      reason: "stale",
      error: expect.objectContaining({
        message: expect.stringContaining(`missing-source-ref:${source.id}`),
      }),
    });
    expect((await ledger.read()).some(
      (event) => event.type === "fukai.compaction.committed",
    )).toBe(false);
  });

  it("closes a dangling request without replaying provider IO, then permits an explicit retry", async () => {
    const setup = createSetup();
    await appendRequested(setup.ledger, setup.request);

    await expect(setup.coordinator.execute(setup.request)).resolves.toMatchObject({
      status: "skipped",
      reason: "provider-error",
      attemptId: attemptIdentity(setup.request).attemptId,
    });
    expect(setup.provider.compact).not.toHaveBeenCalled();
    expect((await setup.ledger.read()).map((event) => event.type)).toEqual([
      "fukai.compaction.requested",
      "fukai.compaction.failed",
    ]);

    await expect(setup.coordinator.execute(setup.request)).resolves.toMatchObject({
      status: "committed",
      reused: false,
    });
    expect(setup.provider.compact).toHaveBeenCalledTimes(1);
    const requests = (await setup.ledger.read()).filter(
      (event) => event.type === "fukai.compaction.requested",
    );
    expect(requests.map((event) => event.payload.attempt)).toEqual([1, 2]);
  });

  it("marks a legacy charge-only attempt failed without charging or calling again", async () => {
    const ledger = new MemoryLedger();
    const request = executionRequest();
    const requested = await appendRequested(ledger, request);
    await appendCharge(ledger, request, requested, usage);
    const setup = createSetup({ ledger, tokenBudget: new RunTokenBudget(10_000, totalTokens(usage)) });

    await expect(setup.coordinator.execute(request)).resolves.toMatchObject({
      status: "skipped",
      reason: "provider-error",
    });
    expect(setup.provider.compact).not.toHaveBeenCalled();
    expect((await ledger.read()).filter((event) => event.type === "budget.charged"))
      .toHaveLength(1);
    expect((await ledger.read()).find((event) => event.type === "fukai.compaction.failed"))
      .toMatchObject({ payload: { usage } });
    expect(setup.tokenBudget.snapshot().usedTokens).toBe(totalTokens(usage));
  });

  it("backfills a failed terminal charge without replaying provider IO in that recovery", async () => {
    const ledger = new MemoryLedger();
    const request = executionRequest();
    const requested = await appendRequested(ledger, request);
    await appendFailed(ledger, request, requested, usage);
    const setup = createSetup({ ledger, tokenBudget: new RunTokenBudget(10_000, totalTokens(usage)) });

    await expect(setup.coordinator.execute(request)).resolves.toMatchObject({
      status: "skipped",
      reason: "provider-error",
    });
    expect(setup.provider.compact).not.toHaveBeenCalled();
    expect((await ledger.read()).filter((event) => event.type === "budget.charged"))
      .toHaveLength(1);
    expect(setup.tokenBudget.snapshot().usedTokens).toBe(totalTokens(usage));

    await expect(setup.coordinator.execute(request)).resolves.toMatchObject({
      status: "committed",
      reused: false,
    });
    expect(setup.provider.compact).toHaveBeenCalledTimes(1);
  });

  it("recovers a completed selection, charges it once, and commits without provider IO", async () => {
    const ledger = new MemoryLedger();
    const setup = createSetup({
      ledger,
      tokenBudget: new RunTokenBudget(10_000, totalTokens(usage)),
    });
    const requested = await appendRequested(setup.ledger, setup.request);
    await appendCompleted(setup.ledger, setup.request, requested, usage);

    await expect(setup.coordinator.execute(setup.request)).resolves.toMatchObject({
      status: "committed",
      reused: true,
    });
    expect(setup.provider.compact).not.toHaveBeenCalled();
    expect(setup.core.recoveryReads).toBe(1);
    expect(setup.core.commitCalls).toBe(1);
    expect((await setup.ledger.read()).filter((event) => event.type === "budget.charged"))
      .toHaveLength(1);
    expect(setup.tokenBudget.snapshot().usedTokens).toBe(totalTokens(usage));
  });

  it("keeps an unknown-usage completed attempt charged at its reserved maximum", async () => {
    const ledger = new MemoryLedger();
    const request = executionRequest();
    const requested = await appendRequested(ledger, request);
    await appendCompleted(ledger, request, requested, null);
    const recoveredUsage = recoverRunTokenUsage(await ledger.read(), request.runId);
    const reservedMaximum = request.budget.maxInputTokens + request.budget.maxOutputTokens;
    const setup = createSetup({
      ledger,
      tokenBudget: new RunTokenBudget(10_000, totalTokens(recoveredUsage)),
    });

    await expect(setup.coordinator.execute(request)).resolves.toMatchObject({
      status: "committed",
      reused: true,
    });
    expect(setup.provider.compact).not.toHaveBeenCalled();
    expect(setup.tokenBudget.snapshot().usedTokens).toBe(reservedMaximum);
    expect((await ledger.read()).find((event) => event.type === "budget.charged"))
      .toMatchObject({
        payload: {
          usage: {
            input: request.budget.maxInputTokens,
            output: request.budget.maxOutputTokens,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      });
  });

  it("commits completed and already charged work without double charging", async () => {
    const ledger = new MemoryLedger();
    const request = executionRequest();
    const requested = await appendRequested(ledger, request);
    await appendCompleted(ledger, request, requested, usage);
    await appendCharge(ledger, request, requested, usage);
    const setup = createSetup({ ledger, tokenBudget: new RunTokenBudget(10_000, totalTokens(usage)) });

    await expect(setup.coordinator.execute(request)).resolves.toMatchObject({
      status: "committed",
      reused: true,
    });
    expect(setup.provider.compact).not.toHaveBeenCalled();
    expect((await ledger.read()).filter((event) => event.type === "budget.charged"))
      .toHaveLength(1);
    expect(setup.tokenBudget.snapshot().usedTokens).toBe(totalTokens(usage));
  });

  it("revalidates a durable fallback without starting another provider attempt", async () => {
    const ledger = new MemoryLedger();
    const request = executionRequest();
    const requested = await appendRequested(ledger, request);
    const completed = await appendCompleted(ledger, request, requested, usage);
    await appendCharge(ledger, request, requested, usage);
    await appendFallback(ledger, request, requested, completed);
    const setup = createSetup({ ledger, tokenBudget: new RunTokenBudget(10_000, totalTokens(usage)) });

    await expect(setup.coordinator.execute(request)).resolves.toMatchObject({
      status: "committed",
      reused: true,
    });
    expect(setup.provider.compact).not.toHaveBeenCalled();
    expect(setup.core.commitCalls).toBe(1);
  });

  it("retries a transient commit from the persisted result without replaying provider IO", async () => {
    const ledger = new MemoryLedger();
    const delegate = new TestCore(ledger);
    let failCommit = true;
    const core: FukaiCompactionCorePort = {
      readCompaction: delegate.readCompaction.bind(delegate),
      readCompactionSelection: delegate.readCompactionSelection.bind(delegate),
      async commitCompaction(request) {
        if (failCommit) {
          failCommit = false;
          throw new Error("transient commit failure");
        }
        return delegate.commitCompaction(request);
      },
    };
    const provider: FukaiCompactionProvider = {
      compact: vi.fn(async (request) => selectionFor(request.compactionId)),
    };
    const coordinator = createFukaiCompactionCoordinator({
      core,
      provider,
      ledger,
      tokenBudget: new RunTokenBudget(10_000),
    });
    const request = executionRequest();

    await expect(coordinator.execute(request)).resolves.toMatchObject({
      status: "skipped",
      reason: "verification-failed",
    });
    await expect(coordinator.execute(request)).resolves.toMatchObject({
      status: "committed",
      reused: true,
    });
    expect(provider.compact).toHaveBeenCalledTimes(1);
    expect((await ledger.read()).filter(
      (event) => event.type === "fukai.compaction.fallback",
    )).toHaveLength(1);
  });

  it("charges valid provider usage carried by a structured output error", async () => {
    const outputError = new PiAiFukaiCompactionOutputError("invalid private output", usage);
    const provider: FukaiCompactionProvider = {
      compact: vi.fn(async () => {
        throw outputError;
      }),
    };
    const setup = createSetup({ provider });

    await expect(setup.coordinator.execute(setup.request)).resolves.toMatchObject({
      status: "skipped",
      reason: "provider-error",
      error: outputError,
    });
    const events = await setup.ledger.read();
    expect(events.map((event) => event.type)).toEqual([
      "fukai.compaction.requested",
      "fukai.compaction.failed",
      "budget.charged",
    ]);
    expect(events.find((event) => event.type === "fukai.compaction.failed"))
      .toMatchObject({ payload: { usage } });
    expect(setup.tokenBudget.snapshot().usedTokens).toBe(totalTokens(usage));
  });

  it.each([
    {
      field: "source refs",
      mutate(selection: FukaiCompactionSelection) {
        const changed = [{
          kind: "artifact" as const,
          ref: createArtifactRef(Buffer.from("changed source"), "text/plain"),
        }];
        selection.capsule.sourceRefs = changed;
        selection.summary.sourceRefs = changed;
      },
    },
    {
      field: "deferred conversation refs",
      mutate(selection: FukaiCompactionSelection) {
        const changed = [createArtifactRef(
          Buffer.from("changed deferred source"),
          "application/vnd.nausicaa.conversation-message+json",
        )];
        selection.capsule.deferredConversationRefs = changed;
        selection.summary.deferredConversationRefs = changed;
      },
    },
    {
      field: "generation identity",
      mutate(selection: FukaiCompactionSelection) {
        const changed = piAiFukaiCompactionGeneration("other/model");
        selection.capsule.generation = changed;
        selection.summary.generation = changed;
      },
    },
  ])("rejects provider-changed $field before recording completion", async ({ mutate }) => {
    const request = providerBoundaryRequest();
    const provider: FukaiCompactionProvider = {
      compact: vi.fn(async (providerRequest) => {
        const selection = selectionMatchingRequest(providerRequest);
        mutate(selection);
        return selection;
      }),
    };
    const setup = createSetup({ provider });

    await expect(setup.coordinator.execute(request)).resolves.toMatchObject({
      status: "skipped",
      reason: "provider-error",
      error: expect.objectContaining({ message: expect.stringMatching(/changed/i) }),
    });
    const events = await setup.ledger.read();
    expect(events.map((event) => event.type)).toEqual([
      "fukai.compaction.requested",
      "fukai.compaction.failed",
      "budget.charged",
    ]);
    expect(events.some((event) => event.type === "fukai.compaction.completed")).toBe(false);
    expect(events.some((event) => event.type === "fukai.compaction.committed")).toBe(false);
    expect(events.find((event) => event.type === "fukai.compaction.failed"))
      .toMatchObject({ payload: { status: "failed", usage } });
    expect(events.find((event) => event.type === "budget.charged"))
      .toMatchObject({ payload: { usage } });
    expect(setup.tokenBudget.snapshot()).toMatchObject({
      usedTokens: totalTokens(usage),
      reservedTokens: 0,
    });
    expect(setup.core.commitCalls).toBe(0);
    expect(provider.compact).toHaveBeenCalledTimes(1);
  });

  it("accepts provider output that preserves optional request metadata", async () => {
    const request = providerBoundaryRequest();
    const provider: FukaiCompactionProvider = {
      compact: vi.fn(async (providerRequest) => selectionMatchingRequest(providerRequest)),
    };
    const setup = createSetup({ provider });

    await expect(setup.coordinator.execute(request)).resolves.toMatchObject({
      status: "committed",
      reused: false,
    });
    expect((await setup.ledger.read()).map((event) => event.type)).toEqual([
      "fukai.compaction.requested",
      "fukai.compaction.completed",
      "budget.charged",
      "fukai.compaction.committed",
    ]);
    expect(setup.core.committedSelection).toMatchObject({
      capsule: {
        deferredConversationRefs: request.deferredConversationRefs,
        generation: request.generation,
      },
      summary: {
        deferredConversationRefs: request.deferredConversationRefs,
        generation: request.generation,
      },
    });
  });

  it("canonicalizes logical identity but rejects a leading-zero cursor before provider IO", async () => {
    const request = { ...executionRequest(), cursor: "offset:01" };
    const identity = {
      runId: request.runId,
      laneId: request.laneId,
      upperWatermark: request.upperWatermark,
      goalVersion: request.goal.version,
      policyVersion: request.policyVersion,
      sourceRefs: request.sourceRefs,
      budget: request.budget,
    };
    expect(deriveContextCompactionId({ ...identity, cursor: "offset:01" }))
      .toBe(deriveContextCompactionId({ ...identity, cursor: "offset:1" }));
    const provider: FukaiCompactionProvider = {
      compact: vi.fn(async (providerRequest) => selectionMatchingRequest(providerRequest)),
    };
    const setup = createSetup({ provider });

    await expect(setup.coordinator.execute(request)).rejects.toThrow(
      /canonical offset:<integer> cursor without leading zeroes/i,
    );
    expect(provider.compact).not.toHaveBeenCalled();
    expect(setup.core.commitCalls).toBe(0);
    expect(await setup.ledger.read()).toEqual([]);
    expect(setup.tokenBudget.snapshot()).toMatchObject({
      usedTokens: 0,
      reservedTokens: 0,
    });
  });

  it("cancels a lock waiter without allowing a later execution to overlap", async () => {
    let releaseProvider!: () => void;
    let markProviderStarted!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    const provider: FukaiCompactionProvider = {
      compact: vi.fn(async (request) => {
        markProviderStarted();
        await providerGate;
        return selectionFor(request.compactionId);
      }),
    };
    const setup = createSetup({ provider });
    const first = setup.coordinator.execute(setup.request);
    await providerStarted;

    const abortController = new AbortController();
    const second = setup.coordinator.execute({
      ...setup.request,
      signal: abortController.signal,
    });
    const third = setup.coordinator.execute(setup.request);
    abortController.abort(new Error("cancel queued compaction"));

    await expect(Promise.race([
      second,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("queued cancellation did not settle")),
        100,
      )),
    ])).rejects.toThrow("cancel queued compaction");
    expect(provider.compact).toHaveBeenCalledTimes(1);

    releaseProvider();
    await expect(first).resolves.toMatchObject({ status: "committed" });
    await expect(third).resolves.toMatchObject({ status: "committed", reused: true });
    expect(provider.compact).toHaveBeenCalledTimes(1);
  });

  it("settles the reservation when persisting a successful terminal fails", async () => {
    const ledger = new FailOnceLedger("fukai.compaction.completed");
    const setup = createSetup({ ledger });

    await expect(setup.coordinator.execute(setup.request))
      .rejects.toThrow("injected fukai.compaction.completed append failure");
    expect(setup.tokenBudget.snapshot()).toMatchObject({
      usedTokens: totalTokens(usage),
      reservedTokens: 0,
    });
  });

  it("settles locally when budget persistence fails and recovers without double charging", async () => {
    const ledger = new FailOnceLedger("budget.charged");
    const setup = createSetup({ ledger });

    await expect(setup.coordinator.execute(setup.request))
      .rejects.toThrow("injected budget.charged append failure");
    expect(setup.tokenBudget.snapshot()).toMatchObject({
      usedTokens: totalTokens(usage),
      reservedTokens: 0,
    });

    await expect(setup.coordinator.execute(setup.request)).resolves.toMatchObject({
      status: "committed",
      reused: true,
    });
    expect(setup.provider.compact).toHaveBeenCalledTimes(1);
    expect((await ledger.read()).filter((event) => event.type === "budget.charged"))
      .toHaveLength(1);
    expect(setup.tokenBudget.snapshot().usedTokens).toBe(totalTokens(usage));
  });
});

describe("runtime Fukai compaction pressure cadence", () => {
  it("records an unknown context window without calling the provider lifecycle", async () => {
    const setup = await createPressureRuntime({
      contextWindowTokens: undefined,
      currentTokens: 4_000,
      minimumGainTokens: 10,
    });

    await expect(setup.runtime.compactIfNeeded?.(setup.request)).resolves.toBeUndefined();

    const events = await setup.ledger.read();
    expect(pressureEvent(events)?.payload).toEqual({
      trigger: "main-pre-step",
      model: "test/model",
      contextWindowTokens: null,
      currentTokens: 4_000,
      thresholdTokens: null,
      minimumRetainedRawTokens: null,
      selectedRawTokens: 0,
      retainedRawTokens: 3_000,
      predictedGainTokens: -500,
      decision: "skip",
      reason: "context-window-unknown",
    });
    expect(setup.model.callCount).toBe(0);
    expect(compactionLifecycleTypes(events)).toEqual([]);
  });

  it("records below-threshold pressure without calling the provider lifecycle", async () => {
    const setup = await createPressureRuntime({
      contextWindowTokens: 5_000,
      currentTokens: 3_999,
      minimumGainTokens: 10,
    });

    await expect(setup.runtime.compactIfNeeded?.(setup.request)).resolves.toBeUndefined();

    const events = await setup.ledger.read();
    expect(pressureEvent(events)?.payload).toEqual({
      trigger: "main-pre-step",
      model: "test/model",
      contextWindowTokens: 5_000,
      currentTokens: 3_999,
      thresholdTokens: 4_000,
      minimumRetainedRawTokens: 1_000,
      selectedRawTokens: 0,
      retainedRawTokens: 3_000,
      predictedGainTokens: -500,
      decision: "skip",
      reason: "below-threshold",
    });
    expect(setup.model.callCount).toBe(0);
    expect(compactionLifecycleTypes(events)).toEqual([]);
  });

  it("records insufficient predicted gain without calling the provider lifecycle", async () => {
    const setup = await createPressureRuntime({
      contextWindowTokens: 5_000,
      currentTokens: 4_000,
      minimumGainTokens: 1_501,
    });

    await expect(setup.runtime.compactIfNeeded?.(setup.request)).resolves.toBeUndefined();

    const events = await setup.ledger.read();
    expect(pressureEvent(events)?.payload).toEqual({
      trigger: "main-pre-step",
      model: "test/model",
      contextWindowTokens: 5_000,
      currentTokens: 4_000,
      thresholdTokens: 4_000,
      minimumRetainedRawTokens: 1_000,
      selectedRawTokens: 2_000,
      retainedRawTokens: 1_000,
      predictedGainTokens: 1_500,
      decision: "skip",
      reason: "insufficient-predicted-gain",
    });
    expect(setup.model.callCount).toBe(0);
    expect(compactionLifecycleTypes(events)).toEqual([]);
  });

  it("records a compact decision and runs one provider lifecycle", async () => {
    const setup = await createPressureRuntime({
      contextWindowTokens: 5_000,
      currentTokens: 4_000,
      minimumGainTokens: 10,
    });

    const selection = await setup.runtime.compactIfNeeded?.(setup.request);

    const events = await setup.ledger.read();
    expect(pressureEvent(events)?.payload).toEqual({
      trigger: "main-pre-step",
      model: "test/model",
      contextWindowTokens: 5_000,
      currentTokens: 4_000,
      thresholdTokens: 4_000,
      minimumRetainedRawTokens: 1_000,
      selectedRawTokens: 2_000,
      retainedRawTokens: 1_000,
      predictedGainTokens: 1_500,
      decision: "compact",
      reason: "pressure-threshold-reached",
    });
    expect(setup.model.callCount).toBe(1);
    expect(compactionLifecycleTypes(events)).toEqual([
      "fukai.compaction.requested",
      "fukai.compaction.completed",
      "fukai.compaction.committed",
    ]);
    expect(selection?.capsule).toMatchObject({
      status: "ready",
      cursor: "offset:3",
      upperWatermark: setup.request.upperWatermark,
      sourceRefs: setup.request.conversationRefs.slice(0, 3).map(({ ref }) => ({
        kind: "conversation",
        ref,
      })),
    });
  });

  it("uses the pressure-boundary model instead of the factory model", async () => {
    const factoryModel = "test/old-model";
    const requestModel = "test/new-model";
    const setup = await createPressureRuntime({
      contextWindowTokens: undefined,
      contextWindowTokensByModel: {
        [factoryModel]: 10_000,
        [requestModel]: 5_000,
      },
      currentTokens: 4_000,
      minimumGainTokens: 10,
      factoryModel,
      requestModel,
    });

    const selection = await setup.runtime.compactIfNeeded?.(setup.request);

    const events = await setup.ledger.read();
    expect(setup.capabilityQueries).toEqual([requestModel]);
    expect(pressureEvent(events)?.payload).toMatchObject({
      model: requestModel,
      contextWindowTokens: 5_000,
      decision: "compact",
      reason: "pressure-threshold-reached",
    });
    expect(setup.model.requests).toHaveLength(1);
    expect(setup.model.requests[0]?.model).toBe(requestModel);
    expect(selection?.capsule.generation).toEqual(
      piAiFukaiCompactionGeneration(requestModel),
    );
    expect(events.find((event) => event.type === "fukai.compaction.requested"))
      .toMatchObject({
        payload: {
          generation: piAiFukaiCompactionGeneration(requestModel),
        },
      });
  });
});

describe("runtime Fukai stale repair", () => {
  it("automatically repairs a missing same-scope summary without changing source position", async () => {
    const ledger = new MemoryLedger();
    const backingStore = new MemoryContentAddressedStore();
    const unavailable = new Set<string>();
    const store: ContentAddressedStore = {
      put: (data, mediaType) => backingStore.put(data, mediaType),
      async get(ref) {
        if (unavailable.has(ref.contentHash)) {
          throw new ArtifactNotFoundError(`Artifact ${ref.id} was not found`);
        }
        return backingStore.get(ref);
      },
      has: async (ref) => !unavailable.has(ref.contentHash) && backingStore.has(ref),
    };
    const runId = "run-runtime-repair";
    await ledger.append({
      runId,
      laneId: "main",
      type: "run.created",
      payload: {
        goal,
        workspace: "/workspace",
        policy: {
          maxMainStepsPerActivation: 4,
          maxModelTokens: 10_000,
          tetoEnabled: false,
          tetoMaxOutputTokens: 200,
          tetoTokenRatio: 0.1,
        },
      },
      correlationId: "runtime-repair",
      idempotencyKey: "runtime-repair:created",
      visibility: "run",
    });
    const messageRef = await store.put(JSON.stringify({
      role: "user",
      content: "evidence retained at the same position",
      createdAt: "1970-01-01T00:00:00.000Z",
    }), "application/vnd.nausicaa.conversation-message+json");
    const messageEvent = await ledger.append({
      runId,
      laneId: "main",
      type: "user.message",
      payload: { messageRef },
      correlationId: "runtime-repair",
      idempotencyKey: "runtime-repair:message",
      visibility: "lane",
    });
    const upperWatermark = messageEvent.globalOffset;
    const sourceRefs = [{ kind: "conversation" as const, ref: messageRef }];
    const generation = piAiFukaiCompactionGeneration("test/model");
    const budget = {
      maxInputTokens: 2_000,
      maxOutputTokens: 500,
      maxWallClockMs: 1_000,
    };
    const staleId = deriveContextCompactionId({
      runId,
      laneId: "main",
      cursor: `offset:${messageEvent.globalOffset}`,
      upperWatermark,
      goalVersion: goal.version,
      policyVersion: "policy-v1",
      sourceRefs,
      generation,
      budget,
    });
    const staleSummary = {
      schemaVersion: 1 as const,
      goal,
      decisions: ["Original summary"],
      verifiedResults: [],
      openQuestions: [],
      sourceRefs,
      generation,
    };
    const staleSummaryRef = await store.put(
      JSON.stringify(staleSummary),
      FUKAI_COMPACTION_MEDIA_TYPE,
    );
    const core = new FukaiCore(ledger, new ContentStoreFukaiSource(store));
    await core.commitCompaction({
      runId,
      laneId: "main",
      compactionId: staleId,
      goal,
      policyVersion: "policy-v1",
      selection: {
        capsule: {
          schemaVersion: 1,
          compactionId: staleId,
          status: "ready",
          summaryRef: staleSummaryRef,
          sourceRefs,
          generation,
          summaryHash: staleSummaryRef.contentHash,
          cursor: `offset:${messageEvent.globalOffset}`,
          upperWatermark,
          goalVersion: goal.version,
          policyVersion: "policy-v1",
          estimatedTokens: 20,
        },
        summary: staleSummary,
      },
    });
    unavailable.add(staleSummaryRef.contentHash);

    const model = new ScriptedModel([{
      content: JSON.stringify({
        decisions: ["Repaired summary"],
        verifiedResults: ["The original evidence remains available"],
        openQuestions: [],
      }),
      toolCalls: [],
      stopReason: "stop",
      usage: { input: 40, output: 20, cacheRead: 0, cacheWrite: 0 },
    }]);
    const runtime = createRuntimeFukaiCompaction({
      ledger,
      store,
      modelPort: model,
      model: "test/model",
      tokenBudget: new RunTokenBudget(10_000),
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      policy: {
        maxMainStepsPerActivation: 1,
        maxModelTokens: 10_000,
        tetoEnabled: false,
        tetoMaxOutputTokens: 64,
        tetoTokenRatio: 0.1,
        fukaiCompaction: {
          enabled: true,
          provider: "pi-ai",
          ...budget,
        },
      },
    });
    await runtime.prepare({
      runId,
      laneId: "main",
      goal,
      policyVersion: "policy-v1",
      upperWatermark,
      conversationRefs: [{ sequence: messageEvent.globalOffset, ref: messageRef }],
      budget,
    });

    const repaired = await runtime.select({
      runId,
      laneId: "main",
      goal,
      policyVersion: "policy-v1",
      upperWatermark,
    });
    const repairId = deriveContextCompactionId({
      runId,
      laneId: "main",
      cursor: `offset:${messageEvent.globalOffset}`,
      upperWatermark,
      goalVersion: goal.version,
      policyVersion: "policy-v1",
      sourceRefs,
      repairFromCompactionId: staleId,
      generation,
      budget,
    });
    expect(repairId).not.toBe(staleId);
    expect(repaired?.capsule).toMatchObject({
      compactionId: repairId,
      sourceRefs,
      cursor: `offset:${messageEvent.globalOffset}`,
      upperWatermark,
    });
    expect(model.callCount).toBe(1);
    expect((await ledger.read()).find(
      (event) => event.type === "fukai.compaction.requested",
    )).toMatchObject({
      payload: {
        compactionId: repairId,
        repairFromCompactionId: staleId,
        sourceRefs,
        upperWatermark,
      },
    });
    expect((await ledger.read()).filter(
      (event) => event.type === "fukai.compaction.committed",
    ).at(-1)).toMatchObject({
      payload: {
        compactionId: repairId,
        resetFromCompactionId: staleId,
      },
    });
  });
});

describe("runtime Fukai compaction source windows", () => {
  it("quarantines a committed capsule with a non-canonical cursor", () => {
    const source = createArtifactRef(Buffer.from("source"), "text/plain");
    const summary = createArtifactRef(
      Buffer.from("summary"),
      FUKAI_COMPACTION_MEDIA_TYPE,
    );
    const event = {
      eventId: "event-non-canonical-cursor",
      runId: "run-cursor",
      laneId: "main",
      globalOffset: 1,
      laneSeq: 1,
      type: "fukai.compaction.committed",
      schemaVersion: 1,
      occurredAt: "2026-01-01T00:00:00.000Z",
      correlationId: "test:non-canonical-cursor",
      idempotencyKey: "test:non-canonical-cursor",
      visibility: "lane",
      contentHash: `sha256:${"f".repeat(64)}`,
      payload: {
        compactionId: `fukai-compaction:sha256:${"d".repeat(64)}`,
        attemptId: null,
        summaryRef: summary,
        sourceRefs: [{ kind: "artifact", ref: source }],
        cursor: "offset:01",
        upperWatermark: 1,
        goalVersion: 1,
        policyVersion: "policy-v1",
        summaryHash: summary.contentHash,
        estimatedTokens: 10,
      },
    } as const satisfies EventEnvelope<"fukai.compaction.committed">;

    const projection = projectFukai([event], "run-cursor", "main");

    expect(projection.latestCompaction).toBeUndefined();
    expect(projection.invalidCompactions).toEqual([{
      compaction: event,
      reasons: expect.arrayContaining(["cursor-invalid"]),
    }]);
  });

  it("rolls more than 128 chronological refs forward without repeating the oldest batch", () => {
    const refs = Array.from({ length: 260 }, (_, index) => conversationRef(index + 1)).reverse();
    const budget = { maxInputTokens: 100_000, maxOutputTokens: 100, maxWallClockMs: 1_000 };

    const first = selectRuntimeFukaiCompactionSources({
      conversationRefs: refs,
      goal,
      upperWatermark: 260,
      budget,
    });
    expect(first?.sourceRefs).toHaveLength(128);
    expect(first?.cursor).toBe("offset:128");

    const base = previousSelection(first!);
    const second = selectRuntimeFukaiCompactionSources({
      conversationRefs: refs,
      goal,
      upperWatermark: 260,
      budget,
      previous: base,
    });
    expect(second?.sourceRefs).toHaveLength(128);
    expect(second?.sourceRefs[0]).toEqual({ kind: "artifact", ref: base.capsule.summaryRef });
    expect(second?.cursor).toBe("offset:255");
    const firstIds = new Set(first?.sourceRefs.map(sourceId));
    expect(second?.sourceRefs.slice(1).every((source) => !firstIds.has(sourceId(source))))
      .toBe(true);
  });

  it("stops before fixed metadata and worst-case JSON bytes exceed the input budget", () => {
    const refs = [conversationRef(1, "12345678"), conversationRef(2, "abcdefgh")];
    const firstSource = { kind: "conversation" as const, ref: refs[0]!.ref };
    const maxInputTokens = fukaiCompactionInputTokenUpperBound(goal, [firstSource]);

    const window = selectRuntimeFukaiCompactionSources({
      conversationRefs: refs,
      goal,
      upperWatermark: 2,
      budget: { maxInputTokens, maxOutputTokens: 10, maxWallClockMs: 1_000 },
    });

    expect(window).toMatchObject({
      cursor: "offset:2",
      sourceBytes: 8,
      deferredConversationRefs: [refs[1]!.ref],
    });
    expect(window?.sourceRefs).toHaveLength(1);
  });

  it("defers an oversized oldest message while advancing over later compactable messages", () => {
    const oversized = conversationRef(1, "x".repeat(16_000));
    const second = conversationRef(2, "small second message");
    const third = conversationRef(3, "small third message");
    const compactableSources = [second, third].map(({ ref }) => ({
      kind: "conversation" as const,
      ref,
    }));
    const maxInputTokens = fukaiCompactionInputTokenUpperBound(goal, compactableSources);

    const window = selectRuntimeFukaiCompactionSources({
      conversationRefs: [oversized, second, third],
      goal,
      upperWatermark: 3,
      budget: { maxInputTokens, maxOutputTokens: 100, maxWallClockMs: 1_000 },
    });

    expect(window).toEqual({
      sourceRefs: compactableSources,
      deferredConversationRefs: [oversized.ref],
      cursor: "offset:3",
      sourceBytes: second.ref.byteLength + third.ref.byteLength,
    });
  });

  it("rolls a previous deferred ref into the next capsule when its budget later fits", () => {
    const oldDeferred = conversationRef(1, "x".repeat(16_000));
    const initial = conversationRef(2, "initial compactable message");
    const initialSource = { kind: "conversation" as const, ref: initial.ref };
    const first = selectRuntimeFukaiCompactionSources({
      conversationRefs: [oldDeferred, initial],
      goal,
      upperWatermark: 2,
      budget: {
        maxInputTokens: fukaiCompactionInputTokenUpperBound(goal, [initialSource]),
        maxOutputTokens: 100,
        maxWallClockMs: 1_000,
      },
    });
    expect(first?.deferredConversationRefs).toEqual([oldDeferred.ref]);

    const previous = previousSelection(first!);
    previous.capsule.deferredConversationRefs = [oldDeferred.ref];
    previous.summary.deferredConversationRefs = [oldDeferred.ref];
    const next = conversationRef(3, "new evidence");
    const sources = [
      { kind: "artifact" as const, ref: previous.capsule.summaryRef },
      { kind: "conversation" as const, ref: oldDeferred.ref },
      { kind: "conversation" as const, ref: next.ref },
    ];

    expect(selectRuntimeFukaiCompactionSources({
      conversationRefs: [oldDeferred, initial, next],
      goal,
      upperWatermark: 3,
      budget: {
        maxInputTokens: fukaiCompactionInputTokenUpperBound(goal, sources),
        maxOutputTokens: 100,
        maxWallClockMs: 1_000,
      },
      previous,
    })).toEqual({
      sourceRefs: sources,
      deferredConversationRefs: [],
      cursor: "offset:3",
      sourceBytes: sources.reduce((sum, source) => sum + source.ref.byteLength, 0),
    });
  });

  it("keeps an oversized previous deferred ref without blocking newer evidence", () => {
    const oldDeferred = conversationRef(1, "x".repeat(16_000));
    const initial = conversationRef(2, "initial compactable message");
    const initialSource = { kind: "conversation" as const, ref: initial.ref };
    const first = selectRuntimeFukaiCompactionSources({
      conversationRefs: [oldDeferred, initial],
      goal,
      upperWatermark: 2,
      budget: {
        maxInputTokens: fukaiCompactionInputTokenUpperBound(goal, [initialSource]),
        maxOutputTokens: 100,
        maxWallClockMs: 1_000,
      },
    });
    const previous = previousSelection(first!);
    previous.capsule.deferredConversationRefs = [oldDeferred.ref];
    previous.summary.deferredConversationRefs = [oldDeferred.ref];
    const next = conversationRef(3, "new evidence");
    const sources = [
      { kind: "artifact" as const, ref: previous.capsule.summaryRef },
      { kind: "conversation" as const, ref: next.ref },
    ];

    expect(selectRuntimeFukaiCompactionSources({
      conversationRefs: [oldDeferred, initial, next],
      goal,
      upperWatermark: 3,
      budget: {
        maxInputTokens: fukaiCompactionInputTokenUpperBound(goal, sources),
        maxOutputTokens: 100,
        maxWallClockMs: 1_000,
      },
      previous,
    })).toEqual({
      sourceRefs: sources,
      deferredConversationRefs: [oldDeferred.ref],
      cursor: "offset:3",
      sourceBytes: sources.reduce((sum, source) => sum + source.ref.byteLength, 0),
    });
  });

  it("preserves a previous deferred ref when the current conversation window omits it", () => {
    const oldDeferred = conversationRef(1, "x".repeat(16_000));
    const initial = conversationRef(2, "initial compactable message");
    const initialSource = { kind: "conversation" as const, ref: initial.ref };
    const first = selectRuntimeFukaiCompactionSources({
      conversationRefs: [oldDeferred, initial],
      goal,
      upperWatermark: 2,
      budget: {
        maxInputTokens: fukaiCompactionInputTokenUpperBound(goal, [initialSource]),
        maxOutputTokens: 100,
        maxWallClockMs: 1_000,
      },
    });
    const previous = previousSelection(first!);
    previous.capsule.deferredConversationRefs = [oldDeferred.ref];
    previous.summary.deferredConversationRefs = [oldDeferred.ref];
    const next = conversationRef(3, "new evidence");
    const sources = [
      { kind: "artifact" as const, ref: previous.capsule.summaryRef },
      { kind: "conversation" as const, ref: next.ref },
    ];

    expect(selectRuntimeFukaiCompactionSources({
      conversationRefs: [next],
      goal,
      upperWatermark: 3,
      budget: {
        maxInputTokens: fukaiCompactionInputTokenUpperBound(goal, sources),
        maxOutputTokens: 100,
        maxWallClockMs: 1_000,
      },
      previous,
    })).toEqual({
      sourceRefs: sources,
      deferredConversationRefs: [oldDeferred.ref],
      cursor: "offset:3",
      sourceBytes: sources.reduce((sum, source) => sum + source.ref.byteLength, 0),
    });
  });

  it("does not select a control-character source one token below its proven bound", () => {
    const ref = conversationRef(1, "\u0001".repeat(64));
    const source = { kind: "conversation" as const, ref: ref.ref };
    const upperBound = fukaiCompactionInputTokenUpperBound(goal, [source]);

    expect(ref.ref.byteLength).toBeLessThan((upperBound - 1) * 4);
    expect(selectRuntimeFukaiCompactionSources({
      conversationRefs: [ref],
      goal,
      upperWatermark: 1,
      budget: {
        maxInputTokens: upperBound - 1,
        maxOutputTokens: 10,
        maxWallClockMs: 1_000,
      },
    })).toBeUndefined();
    expect(selectRuntimeFukaiCompactionSources({
      conversationRefs: [ref],
      goal,
      upperWatermark: 1,
      budget: { maxInputTokens: upperBound, maxOutputTokens: 10, maxWallClockMs: 1_000 },
    })?.sourceRefs).toEqual([source]);
  });

  it("binds compaction identity to ordered source refs", () => {
    const [first, second] = [conversationRef(1), conversationRef(2)]
      .map(({ ref }) => ({ kind: "conversation" as const, ref }));
    const identity = {
      runId: "run-order",
      laneId: "main",
      cursor: "offset:2",
      upperWatermark: 2,
      goalVersion: 1,
      policyVersion: "policy-v1",
      budget: { maxInputTokens: 100, maxOutputTokens: 10, maxWallClockMs: 1_000 },
    };

    expect(deriveContextCompactionId({ ...identity, sourceRefs: [first!, second!] }))
      .not.toBe(deriveContextCompactionId({ ...identity, sourceRefs: [second!, first!] }));
  });
});

describe("Fukai compaction generation provenance", () => {
  it("survives provider persistence, Core commit/read, and context manifest assembly", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    await ledger.append({
      runId: "run-provenance",
      laneId: "main",
      type: "run.created",
      payload: {
        goal,
        workspace: "/workspace",
        policy: {
          maxMainStepsPerActivation: 4,
          maxModelTokens: 10_000,
          tetoEnabled: false,
          tetoMaxOutputTokens: 200,
          tetoTokenRatio: 0.1,
        },
      },
      correlationId: "run:provenance",
      idempotencyKey: "run:provenance:created",
      visibility: "run",
    });
    const source = await store.put("verified source", "text/plain");
    await ledger.append({
      runId: "run-provenance",
      laneId: "main",
      type: "assistant.message",
      payload: { messageRef: source },
      correlationId: "run:provenance",
      idempotencyKey: "run:provenance:source",
      visibility: "lane",
    });
    const upperWatermark = await ledger.watermark();
    const sourceRefs = [{ kind: "artifact" as const, ref: source }];
    const generation = piAiFukaiCompactionGeneration("openrouter:test/model");
    const budget = {
      maxInputTokens: 1_000,
      maxOutputTokens: 1_000,
      maxWallClockMs: 1_000,
    };
    const compactionId = deriveContextCompactionId({
      runId: "run-provenance",
      laneId: "main",
      cursor: `offset:${upperWatermark}`,
      upperWatermark,
      goalVersion: goal.version,
      policyVersion: "policy-v1",
      sourceRefs,
      generation,
      budget,
    });
    const provider = createFukaiCompactionProvider({
      store,
      generateSummary: (request) => ({
        schemaVersion: 1,
        goal: request.goal,
        decisions: ["Retain the auditable generator identity"],
        verifiedResults: [],
        openQuestions: [],
        sourceRefs: [...request.sourceRefs],
        generation,
      }),
    });
    const selection = await provider.compact({
      compactionId,
      runId: "run-provenance",
      laneId: "main",
      goal,
      policyVersion: "policy-v1",
      cursor: `offset:${upperWatermark}`,
      upperWatermark,
      sourceRefs,
      generation,
      budget,
    });
    const core = new FukaiCore(ledger, new ContentStoreFukaiSource(store));
    const committed = await core.commitCompaction({
      runId: "run-provenance",
      laneId: "main",
      compactionId,
      goal,
      policyVersion: "policy-v1",
      selection,
    });
    const read = await core.readCompaction({
      runId: "run-provenance",
      laneId: "main",
      goalVersion: goal.version,
      policyVersion: "policy-v1",
    });

    expect(selection.capsule).toMatchObject({ generation });
    expect(committed.payload).toMatchObject({ generation });
    expect(read).toMatchObject({
      status: "ready",
      selection: { capsule: { generation } },
    });
    if (read.selection === undefined) {
      throw new Error("Committed compaction selection was not readable");
    }

    const context = await new FukaiContextProvider(
      new ContentStoreFukaiSource(store),
    ).build({
      runId: "run-provenance",
      laneId: "main",
      laneKind: "main",
      goal,
      systemPrompt: "Main",
      conversationRefs: [],
      artifactSelections: [],
      tools: [],
      upperWatermark: await ledger.watermark(),
      policyVersion: "policy-v1",
      compaction: read.selection,
      budget: {
        maxInputTokens: 2_000,
        maxConversationMessages: 0,
        maxArtifacts: 0,
        maxArtifactBytes: 0,
        maxQueries: 0,
      },
    });

    expect(context.manifest.slots.compaction).toMatchObject({ generation });
  });
});

class FailOnceLedger extends MemoryLedger {
  #type: EventType | undefined;

  constructor(type: EventType) {
    super();
    this.#type = type;
  }

  override async append<K extends EventType>(
    event: AppendEvent<K>,
  ): Promise<EventEnvelope<K>> {
    if (event.type === this.#type) {
      this.#type = undefined;
      throw new Error(`injected ${event.type} append failure`);
    }
    return super.append(event);
  }
}

class TestCore implements FukaiCompactionCorePort {
  readonly ledger: MemoryLedger;
  readonly summary = {
    schemaVersion: 1 as const,
    goal,
    decisions: ["Keep recovery deterministic"],
    verifiedResults: ["Provider output was persisted"],
    openQuestions: [],
    sourceRefs: [sourceRef],
  };
  commitCalls = 0;
  recoveryReads = 0;
  committed: EventEnvelope<"fukai.compaction.committed"> | undefined;
  committedSelection: FukaiCompactionSelection | undefined;

  constructor(ledger: MemoryLedger) {
    this.ledger = ledger;
  }

  async readCompaction(_request: FukaiCompactionReadRequest): Promise<FukaiCompactionView> {
    if (this.committed === undefined || this.committedSelection === undefined) {
      return { status: "not-found", reasons: [], dependenciesVerified: true };
    }
    return {
      status: "ready",
      reasons: [],
      dependenciesVerified: true,
      compactionId: this.committed.payload.compactionId,
      selection: this.committedSelection,
      event: this.committed,
    };
  }

  async readCompactionSelection(
    capsule: FukaiCompactionSelection["capsule"],
  ): Promise<FukaiCompactionSelection> {
    this.recoveryReads += 1;
    return {
      capsule: structuredClone(capsule),
      summary: {
        ...structuredClone(this.summary),
        sourceRefs: structuredClone(capsule.sourceRefs),
        ...(capsule.deferredConversationRefs === undefined
          ? {}
          : {
              deferredConversationRefs: structuredClone(
                capsule.deferredConversationRefs,
              ),
            }),
        ...(capsule.generation === undefined
          ? {}
          : { generation: structuredClone(capsule.generation) }),
      },
    };
  }

  async commitCompaction(
    request: FukaiCompactionCommitRequest,
  ): Promise<EventEnvelope<"fukai.compaction.committed">> {
    this.commitCalls += 1;
    const { capsule } = request.selection;
    this.committedSelection = structuredClone(request.selection);
    this.committed = await this.ledger.append({
      runId: request.runId,
      laneId: request.laneId,
      type: "fukai.compaction.committed",
      payload: {
        compactionId: request.compactionId,
        attemptId: request.attemptId ?? null,
        summaryRef: structuredClone(capsule.summaryRef),
        sourceRefs: structuredClone(capsule.sourceRefs),
        cursor: capsule.cursor,
        upperWatermark: capsule.upperWatermark,
        goalVersion: capsule.goalVersion,
        policyVersion: capsule.policyVersion,
        summaryHash: capsule.summaryHash,
        estimatedTokens: capsule.estimatedTokens,
      },
      ...(request.causationId === undefined ? {} : { causationId: request.causationId }),
      correlationId: `test:commit:${request.compactionId}`,
      idempotencyKey: `test:commit:${request.compactionId}`,
      visibility: "lane",
    });
    return this.committed;
  }
}

function createRepairCore(
  ledger: MemoryLedger,
  staleCompactionId: string,
  committedResetFromCompactionId?: string,
): FukaiCompactionCorePort {
  let committed: EventEnvelope<"fukai.compaction.committed"> | undefined;
  let committedSelection: FukaiCompactionSelection | undefined;
  return {
    async readCompaction() {
      if (committed === undefined || committedSelection === undefined) {
        return {
          status: "stale",
          reasons: ["summary-invalid:missing"],
          dependenciesVerified: true,
          compactionId: staleCompactionId,
        };
      }
      return {
        status: "ready",
        reasons: [],
        dependenciesVerified: true,
        compactionId: committed.payload.compactionId,
        selection: committedSelection,
        event: committed,
      };
    },
    async readCompactionSelection(capsule) {
      const selection = selectionFor(capsule.compactionId);
      selection.capsule = structuredClone(capsule);
      selection.summary.sourceRefs = structuredClone(capsule.sourceRefs);
      return selection;
    },
    async commitCompaction(request) {
      const { capsule } = request.selection;
      committedSelection = structuredClone(request.selection);
      committed = await ledger.append({
        runId: request.runId,
        laneId: request.laneId,
        type: "fukai.compaction.committed",
        payload: {
          compactionId: request.compactionId,
          attemptId: request.attemptId ?? null,
          summaryRef: structuredClone(capsule.summaryRef),
          sourceRefs: structuredClone(capsule.sourceRefs),
          ...(committedResetFromCompactionId === undefined
            ? {}
            : { resetFromCompactionId: committedResetFromCompactionId }),
          cursor: capsule.cursor,
          upperWatermark: capsule.upperWatermark,
          goalVersion: capsule.goalVersion,
          policyVersion: capsule.policyVersion,
          summaryHash: capsule.summaryHash,
          estimatedTokens: capsule.estimatedTokens,
        },
        ...(request.causationId === undefined ? {} : { causationId: request.causationId }),
        correlationId: `test:repair:${request.compactionId}`,
        idempotencyKey: `test:repair:${request.compactionId}`,
        visibility: "lane",
      });
      return committed;
    },
  };
}

function createSetup(overrides: {
  ledger?: MemoryLedger;
  tokenBudget?: RunTokenBudget;
  provider?: FukaiCompactionProvider;
} = {}) {
  const ledger = overrides.ledger ?? new MemoryLedger();
  const request = executionRequest();
  const core = new TestCore(ledger);
  const provider = overrides.provider ?? {
    compact: vi.fn(async (providerRequest) => selectionFor(providerRequest.compactionId)),
  };
  const tokenBudget = overrides.tokenBudget ?? new RunTokenBudget(10_000);
  const coordinator = createFukaiCompactionCoordinator({
    core,
    provider,
    ledger,
    tokenBudget,
    now: () => 100,
  });
  return { coordinator, core, ledger, provider, request, tokenBudget };
}

function executionRequest(): FukaiCompactionExecutionRequest {
  return {
    runId: "run-1",
    laneId: "main",
    goal,
    policyVersion: "policy-v1",
    cursor: "offset:4",
    upperWatermark: 4,
    sourceRefs: [sourceRef],
    budget: { maxInputTokens: 100, maxOutputTokens: 20, maxWallClockMs: 1_000 },
  };
}

function providerBoundaryRequest(): FukaiCompactionExecutionRequest {
  return {
    ...executionRequest(),
    deferredConversationRefs: [createArtifactRef(
      Buffer.from("expected deferred source"),
      "application/vnd.nausicaa.conversation-message+json",
    )],
    generation: piAiFukaiCompactionGeneration("test/model"),
  };
}

function selectionMatchingRequest(
  request: FukaiCompactionRequest,
): FukaiCompactionSelection {
  const selection = selectionFor(request.compactionId);
  selection.capsule.sourceRefs = structuredClone([...request.sourceRefs]);
  selection.summary.sourceRefs = structuredClone([...request.sourceRefs]);
  if (request.deferredConversationRefs !== undefined) {
    selection.capsule.deferredConversationRefs = structuredClone([
      ...request.deferredConversationRefs,
    ]);
    selection.summary.deferredConversationRefs = structuredClone([
      ...request.deferredConversationRefs,
    ]);
  }
  if (request.generation !== undefined) {
    selection.capsule.generation = structuredClone(request.generation);
    selection.summary.generation = structuredClone(request.generation);
  }
  return selection;
}

function selectionFor(compactionId: string): FukaiCompactionSelection {
  return {
    capsule: {
      schemaVersion: 1,
      compactionId,
      status: "ready",
      summaryRef,
      sourceRefs: [sourceRef],
      summaryHash: summaryRef.contentHash,
      cursor: "offset:4",
      upperWatermark: 4,
      goalVersion: 1,
      policyVersion: "policy-v1",
      estimatedTokens: 12,
    },
    summary: {
      schemaVersion: 1,
      goal,
      decisions: ["Keep recovery deterministic"],
      verifiedResults: ["Provider output was persisted"],
      openQuestions: [],
      sourceRefs: [sourceRef],
    },
    providerUsage: usage,
  };
}

function attemptIdentity(request: FukaiCompactionExecutionRequest) {
  const compactionId = deriveContextCompactionId({
    runId: request.runId,
    laneId: request.laneId,
    cursor: request.cursor,
    upperWatermark: request.upperWatermark,
    goalVersion: request.goal.version,
    policyVersion: request.policyVersion,
    sourceRefs: request.sourceRefs,
    ...(request.deferredConversationRefs === undefined
      ? {}
      : { deferredConversationRefs: request.deferredConversationRefs }),
    ...(request.repairFromCompactionId === undefined
      ? {}
      : { repairFromCompactionId: request.repairFromCompactionId }),
    ...(request.generation === undefined ? {} : { generation: request.generation }),
    budget: request.budget,
  });
  return {
    compactionId,
    attempt: 1,
    attemptId: deriveContextCompactionAttemptId(compactionId, 1),
  };
}

async function appendRequested(
  ledger: MemoryLedger,
  request: FukaiCompactionExecutionRequest,
) {
  const identity = attemptIdentity(request);
  return ledger.append({
    runId: request.runId,
    laneId: request.laneId,
    type: "fukai.compaction.requested",
    payload: {
      ...identity,
      cursor: request.cursor,
      upperWatermark: request.upperWatermark,
      goalVersion: request.goal.version,
      policyVersion: request.policyVersion,
      sourceRefs: structuredClone([...request.sourceRefs]),
      ...(request.deferredConversationRefs === undefined
        ? {}
        : { deferredConversationRefs: structuredClone([...request.deferredConversationRefs]) }),
      ...(request.repairFromCompactionId === undefined
        ? {}
        : { repairFromCompactionId: request.repairFromCompactionId }),
      ...(request.generation === undefined
        ? {}
        : { generation: structuredClone(request.generation) }),
      budget: { ...request.budget },
    },
    correlationId: correlation(identity.compactionId),
    idempotencyKey: lifecycleKey(identity.compactionId, "attempt:1:requested"),
    visibility: "lane",
  });
}

async function appendCompleted(
  ledger: MemoryLedger,
  request: FukaiCompactionExecutionRequest,
  requested: EventEnvelope<"fukai.compaction.requested">,
  providerUsage: TokenUsage | null,
) {
  const { compactionId, attemptId, attempt } = requested.payload;
  return ledger.append({
    runId: request.runId,
    laneId: request.laneId,
    type: "fukai.compaction.completed",
    payload: {
      compactionId,
      attemptId,
      attempt,
      elapsedMs: 25,
      usage: providerUsage,
      summaryRef,
      summaryHash: summaryRef.contentHash,
      estimatedTokens: 12,
    },
    causationId: requested.eventId,
    correlationId: requested.correlationId,
    idempotencyKey: lifecycleKey(compactionId, "attempt:1:terminal"),
    visibility: "lane",
  });
}

async function appendCharge(
  ledger: MemoryLedger,
  request: FukaiCompactionExecutionRequest,
  requested: EventEnvelope<"fukai.compaction.requested">,
  providerUsage: TokenUsage,
) {
  return ledger.append({
    runId: request.runId,
    laneId: request.laneId,
    type: "budget.charged",
    payload: { laneId: request.laneId, usage: providerUsage },
    causationId: requested.eventId,
    correlationId: requested.correlationId,
    idempotencyKey: lifecycleKey(requested.payload.compactionId, "attempt:1:budget"),
    visibility: "lane",
  });
}

async function appendFailed(
  ledger: MemoryLedger,
  request: FukaiCompactionExecutionRequest,
  requested: EventEnvelope<"fukai.compaction.requested">,
  providerUsage: TokenUsage | null,
) {
  const { compactionId, attemptId, attempt } = requested.payload;
  return ledger.append({
    runId: request.runId,
    laneId: request.laneId,
    type: "fukai.compaction.failed",
    payload: {
      compactionId,
      attemptId,
      attempt,
      status: "failed",
      elapsedMs: 25,
      usage: providerUsage,
    },
    causationId: requested.eventId,
    correlationId: requested.correlationId,
    idempotencyKey: lifecycleKey(compactionId, "attempt:1:terminal"),
    visibility: "lane",
  });
}

async function appendFallback(
  ledger: MemoryLedger,
  request: FukaiCompactionExecutionRequest,
  requested: EventEnvelope<"fukai.compaction.requested">,
  completed: EventEnvelope<"fukai.compaction.completed">,
) {
  return ledger.append({
    runId: request.runId,
    laneId: request.laneId,
    type: "fukai.compaction.fallback",
    payload: {
      compactionId: requested.payload.compactionId,
      attemptId: requested.payload.attemptId,
      attempt: requested.payload.attempt,
      reason: "verification-failed",
      phase: "commit",
    },
    causationId: completed.eventId,
    correlationId: requested.correlationId,
    idempotencyKey: lifecycleKey(
      requested.payload.compactionId,
      "fallback:commit:verification-failed:1",
    ),
    visibility: "lane",
  });
}

function correlation(compactionId: string): string {
  return `fukai:compaction:run-1:main:${compactionId}`;
}

function lifecycleKey(compactionId: string, suffix: string): string {
  return `fukai:compaction:main:${compactionId}:${suffix}`;
}

function totalTokens(value: TokenUsage): number {
  return value.input + value.output + value.cacheRead + value.cacheWrite;
}

async function createPressureRuntime(options: {
  contextWindowTokens: number | undefined;
  contextWindowTokensByModel?: Readonly<Record<string, number | undefined>>;
  currentTokens: number;
  minimumGainTokens: number;
  factoryModel?: string;
  requestModel?: string;
}) {
  const ledger = new MemoryLedger();
  const store = new MemoryContentAddressedStore();
  const conversationRefs = [];
  const sourceSpecs = [
    { groupId: "old", bytes: 2_000, fill: "a" },
    { groupId: "old", bytes: 2_000, fill: "b" },
    { groupId: "middle", bytes: 4_000, fill: "c" },
    { groupId: "latest", bytes: 4_000, fill: "d" },
  ];
  for (const [index, source] of sourceSpecs.entries()) {
    const ref = await store.put(
      pressureConversationContent(source.fill, source.bytes),
      "application/vnd.nausicaa.conversation-message+json",
    );
    const event = await ledger.append({
      runId: "run-pressure",
      laneId: "main",
      type: "user.message",
      payload: { messageRef: ref },
      correlationId: "test:pressure",
      idempotencyKey: `test:pressure:message:${index}`,
      visibility: "lane",
    });
    conversationRefs.push({
      sequence: event.globalOffset,
      groupId: source.groupId,
      ref,
    });
  }

  const model = new ScriptedModel([{
    content: JSON.stringify({
      decisions: ["Retain verified history"],
      verifiedResults: [],
      openQuestions: [],
    }),
    toolCalls: [],
    stopReason: "stop",
    usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 },
  }]);
  const capabilityQueries: string[] = [];
  const modelPort: ModelPort = options.contextWindowTokensByModel !== undefined
    ? {
        capabilities: (modelName) => {
          capabilityQueries.push(modelName);
          const contextWindowTokens = options.contextWindowTokensByModel?.[modelName];
          return contextWindowTokens === undefined
            ? { imageInput: false }
            : { imageInput: false, contextWindowTokens };
        },
        complete: (request) => model.complete(request),
      }
    : options.contextWindowTokens === undefined
    ? model
    : {
        capabilities: () => ({
          imageInput: false,
          contextWindowTokens: options.contextWindowTokens!,
        }),
        complete: (request) => model.complete(request),
      };
  const budget = {
    maxInputTokens: 20_000,
    maxOutputTokens: 500,
    maxWallClockMs: 1_000,
  };
  const runtime = createRuntimeFukaiCompaction({
    ledger,
    store,
    modelPort,
    model: options.factoryModel ?? "test/model",
    tokenBudget: new RunTokenBudget(50_000),
    clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    policy: {
      maxMainStepsPerActivation: 1,
      maxModelTokens: 50_000,
      tetoEnabled: false,
      tetoMaxOutputTokens: 64,
      tetoTokenRatio: 0.1,
      fukaiCompaction: {
        enabled: true,
        provider: "pi-ai",
        thresholdRatio: 0.8,
        retainRatio: 0.2,
        minimumGainTokens: options.minimumGainTokens,
        ...budget,
      },
    },
  });
  const request = {
    runId: "run-pressure",
    laneId: "main",
    goal,
    model: options.requestModel ?? options.factoryModel ?? "test/model",
    policyVersion: "policy-pressure-v1",
    upperWatermark: conversationRefs.at(-1)?.sequence ?? 0,
    conversationRefs,
    estimatedInputTokens: options.currentTokens,
  } as const;
  await runtime.prepare({
    ...request,
    budget,
  });
  return { capabilityQueries, ledger, model, request, runtime };
}

function pressureConversationContent(fill: string, byteLength: number): string {
  const empty = JSON.stringify({
    role: "user",
    content: "",
    createdAt: "1970-01-01T00:00:00.000Z",
  });
  return JSON.stringify({
    role: "user",
    content: fill.repeat(byteLength - Buffer.byteLength(empty, "utf8")),
    createdAt: "1970-01-01T00:00:00.000Z",
  });
}

function pressureEvent(
  events: readonly AnyEvent[],
): EventEnvelope<"fukai.compaction.pressure"> | undefined {
  return events.find((event): event is EventEnvelope<"fukai.compaction.pressure"> => (
    event.type === "fukai.compaction.pressure"
  ));
}

function compactionLifecycleTypes(events: readonly AnyEvent[]): EventType[] {
  const lifecycleTypes = new Set<EventType>([
    "fukai.compaction.requested",
    "fukai.compaction.completed",
    "fukai.compaction.failed",
    "fukai.compaction.committed",
    "fukai.compaction.fallback",
  ]);
  return events
    .map((event) => event.type)
    .filter((type) => lifecycleTypes.has(type));
}

function conversationRef(sequence: number, content = `message-${sequence}`) {
  return {
    sequence,
    ref: createArtifactRef(Buffer.from(content), "application/json"),
  };
}

function previousSelection(
  window: NonNullable<ReturnType<typeof selectRuntimeFukaiCompactionSources>>,
): FukaiCompactionSelection {
  const ref = createArtifactRef(
    Buffer.from(JSON.stringify({ summary: "previous" })),
    FUKAI_COMPACTION_MEDIA_TYPE,
  );
  return {
    capsule: {
      schemaVersion: 1,
      compactionId: `fukai-compaction:sha256:${"e".repeat(64)}`,
      status: "ready",
      summaryRef: ref,
      sourceRefs: structuredClone(window.sourceRefs),
      summaryHash: ref.contentHash,
      cursor: window.cursor,
      upperWatermark: 260,
      goalVersion: 1,
      policyVersion: "policy-v1",
      estimatedTokens: 10,
    },
    summary: {
      schemaVersion: 1,
      goal,
      decisions: [],
      verifiedResults: [],
      openQuestions: [],
      sourceRefs: structuredClone(window.sourceRefs),
    },
  };
}

function sourceId(source: { kind: string; ref?: { id: string } }): string {
  return source.ref?.id ?? source.kind;
}
