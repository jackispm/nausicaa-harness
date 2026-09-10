import { describe, expect, it } from "vitest";

import type { Goal, ModelPort, ModelRequest, ModelResponse, RunPolicy } from "../../src/domain/index.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { projectRunMetrics } from "../../src/observability/index.js";
import type { MainAfterStepContext } from "../../src/runtime/main-loop.js";
import {
  recoverReflectionSchedulerState,
  ReflectionScheduler,
} from "../../src/runtime/index.js";
import { RunTokenBudget } from "../../src/runtime/run-token-budget.js";
import { recoverRunTokenUsage } from "../../src/runtime/run-token-budget-recovery.js";
import {
  ArtifactNotFoundError,
  type ContentAddressedStore,
  MemoryContentAddressedStore,
} from "../../src/store/index.js";

const goal: Goal = {
  version: 1,
  statement: "Document installation",
  successCriteria: ["Give the correct command"],
  hardConstraints: ["Read only"],
};

const policy: RunPolicy = {
  maxMainStepsPerActivation: 8,
  maxModelTokens: 40_000,
  tetoEnabled: false,
  tetoMaxOutputTokens: 64,
  tetoTokenRatio: 0.5,
};

class TruncatedReflectionModel implements ModelPort {
  readonly requests: ModelRequest[] = [];

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    return {
      content: '{"action":"silent"}',
      toolCalls: [],
      stopReason: "length",
      usage: { input: 100, output: 64, cacheRead: 0, cacheWrite: 0 },
    };
  }
}

describe("ReflectionScheduler", () => {
  it("records an explicit bounded failure when the provider truncates JSON", async () => {
    const ledger = new MemoryLedger();
    const model = new TruncatedReflectionModel();
    const runTokenBudget = new RunTokenBudget(10_000);
    const scheduler = new ReflectionScheduler({
      eventSink: ledger,
      modelPort: model,
      store: new MemoryContentAddressedStore(),
      runId: "run-1",
      goal,
      model: "reflection-model",
      policy,
      runTokenBudget,
    });

    scheduler.enqueue(mainStep(1));
    scheduler.enqueue(mainStep(2));
    await scheduler.drain();

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]).toMatchObject({ maxOutputTokens: 64, tools: [] });
    const events = await ledger.read({ runId: "run-1" });
    const failureReasons = events.flatMap((event) => (
      event.type === "lane.status" && event.payload.status === "failed"
        ? [event.payload.reason]
        : []
    ));
    expect(failureReasons).toHaveLength(1);
    expect(failureReasons[0]).toContain(
      "Reflection output was truncated at the 64-token limit",
    );
    expect(runTokenBudget.snapshot()).toMatchObject({
      usedTokens: 164,
      reservedTokens: 0,
      settlements: [{
        id: "run-1:lane:reflection:model:2",
        actualTokens: 164,
      }],
    });
    expect(scheduler.snapshot().tokenGateState).toMatchObject({
      tetoTokens: 164,
      reservations: [],
    });
    expect(events.filter((event) => (
      event.type === "budget.charged" && event.laneId === "reflection"
    ))).toHaveLength(1);
    expect(recoverRunTokenUsage(events, "run-1")).toEqual({
      input: 100,
      output: 64,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(recoverReflectionSchedulerState(events, { runId: "run-1" }))
      .toMatchObject({ tokenGateState: { tetoTokens: 164 } });
    expect(projectRunMetrics(events, "run-1").lanes.reflection).toMatchObject({
      usage: { input: 100, output: 64, cacheRead: 0, cacheWrite: 0 },
      chargedUsage: { input: 100, output: 64, cacheRead: 0, cacheWrite: 0 },
    });
    await scheduler.stop();
  });

  it("silently skips when the shared Run budget is exhausted", async () => {
    const ledger = new MemoryLedger();
    const model = new CountingReflectionModel();
    const runTokenBudget = new RunTokenBudget(100, 100);
    const scheduler = reflectionScheduler(ledger, model, runTokenBudget);

    scheduler.enqueue(mainStep(1));
    scheduler.enqueue(mainStep(2));
    await scheduler.drain();

    expect(model.calls).toBe(0);
    expect(runTokenBudget.snapshot()).toMatchObject({
      usedTokens: 100,
      reservedTokens: 0,
      reservations: [],
      settlements: [],
    });
    expect((await ledger.read({ runId: "run-1" })).some((event) => (
      event.type === "lane.status" && event.payload.status === "failed"
    ))).toBe(false);
    expect(scheduler.snapshot()).toMatchObject({
      cadenceState: { mainCallIndex: 2, passCalls: [] },
      tokenGateState: { tetoTokens: 0, reservations: [] },
    });
  });

  it.each(["silent", "revise"])("rejects provider-aborted %s output without losing its usage", async (action) => {
    const ledger = new MemoryLedger();
    const usage = { input: 100, output: 10, cacheRead: 20, cacheWrite: 0 };
    let calls = 0;
    const modelPort: ModelPort = {
      complete: async () => {
        calls += 1;
        return {
          content: JSON.stringify(action === "silent" ? { action } : {
            action, note: "Check the package entry point",
          }),
          toolCalls: [],
          stopReason: "aborted",
          usage,
        };
      },
    };
    const runTokenBudget = new RunTokenBudget(10_000);
    const controller = new AbortController();
    const scheduler = reflectionScheduler(ledger, modelPort, runTokenBudget, controller.signal);
    try {
      scheduler.enqueue(mainStep(1));
      scheduler.enqueue(mainStep(2));
      await scheduler.drain();

      expect(calls).toBe(1);
      expect(controller.signal.aborted).toBe(false);
      await expect(scheduler.beforeMainStep()).resolves.toEqual([]);
      const events = await ledger.read({ runId: "run-1" });
      expect(events.filter((event) => event.type === "reflection.observed"
        || event.type === "reflection.delivered")).toEqual([]);
      expect(events.filter((event) => event.type === "lane.status"
        && event.payload.status === "failed")).toMatchObject([{
          payload: { reason: "Reflection response was aborted by the provider" },
        }]);
      expect(events.filter((event) => event.type === "budget.charged"
        && event.laneId === "reflection")).toHaveLength(1);
      expect(runTokenBudget.snapshot()).toMatchObject({
        usedTokens: 130,
        reservedTokens: 0,
        settlements: [{ id: "run-1:lane:reflection:model:2", actualTokens: 130 }],
      });
      expect(scheduler.snapshot().tokenGateState).toMatchObject({
        tetoTokens: 130, reservations: [],
      });
      expect(recoverRunTokenUsage(events, "run-1")).toEqual(usage);
      expect(recoverReflectionSchedulerState(events, { runId: "run-1" }))
        .toMatchObject({ tokenGateState: { tetoTokens: 130 } });
    } finally {
      await scheduler.stop();
    }
  });

  it("releases the shared reservation when the provider fails", async () => {
    const ledger = new MemoryLedger();
    const model: ModelPort = {
      complete: async () => { throw new Error("reflection provider unavailable"); },
    };
    const runTokenBudget = new RunTokenBudget(10_000);
    const scheduler = reflectionScheduler(ledger, model, runTokenBudget);

    scheduler.enqueue(mainStep(1));
    scheduler.enqueue(mainStep(2));
    await expect(scheduler.drain()).resolves.toBeUndefined();

    expect(runTokenBudget.snapshot()).toMatchObject({
      usedTokens: 0,
      reservedTokens: 0,
      reservations: [],
      settlements: [],
    });
  });

  it("releases the shared reservation when an active reflection is cancelled", async () => {
    const ledger = new MemoryLedger();
    const controller = new AbortController();
    const model = new PendingReflectionModel();
    const runTokenBudget = new RunTokenBudget(10_000);
    const scheduler = reflectionScheduler(
      ledger,
      model,
      runTokenBudget,
      controller.signal,
    );

    scheduler.enqueue(mainStep(1));
    scheduler.enqueue(mainStep(2));
    await waitFor(() => model.calls === 1);
    controller.abort(new Error("run cancelled"));
    await scheduler.drain();

    expect(runTokenBudget.snapshot()).toMatchObject({
      usedTokens: 0,
      reservedTokens: 0,
      reservations: [],
      settlements: [],
    });
  });

  it("persists usage before a downstream reflection-store failure", async () => {
    const ledger = new MemoryLedger();
    const backingStore = new MemoryContentAddressedStore();
    const failingStore: ContentAddressedStore = {
      put: async () => { throw new Error("reflection store unavailable"); },
      get: (ref) => backingStore.get(ref),
      has: (ref) => backingStore.has(ref),
    };
    const runTokenBudget = new RunTokenBudget(10_000);
    const scheduler = new ReflectionScheduler({
      eventSink: ledger,
      modelPort: new CountingReflectionModel(),
      store: failingStore,
      runId: "run-1",
      goal,
      model: "reflection-model",
      policy,
      runTokenBudget,
    });

    scheduler.enqueue(mainStep(1));
    scheduler.enqueue(mainStep(2));
    await expect(scheduler.drain()).resolves.toBeUndefined();
    const events = await ledger.read({ runId: "run-1" });

    expect(events.filter((event) => (
      event.type === "budget.charged" && event.laneId === "reflection"
    ))).toHaveLength(1);
    expect(events.some((event) => event.type === "reflection.observed")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "lane.status",
      payload: {
        status: "failed",
        reason: expect.stringContaining("reflection store unavailable"),
      },
    });
    expect(recoverRunTokenUsage(events, "run-1")).toEqual({
      input: 100,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(recoverReflectionSchedulerState(events, { runId: "run-1" }))
      .toMatchObject({ tokenGateState: { tetoTokens: 110 } });
    expect(runTokenBudget.snapshot()).toMatchObject({
      usedTokens: 110,
      reservedTokens: 0,
      settlements: [{
        id: "run-1:lane:reflection:model:2",
        actualTokens: 110,
      }],
    });
  });

  it("retains a revise note when delivery persistence fails", async () => {
    const ledger = new FailingReflectionDeliveryLedger();
    const scheduler = new ReflectionScheduler({
      eventSink: ledger,
      modelPort: new RevisionReflectionModel(),
      store: new MemoryContentAddressedStore(),
      runId: "run-1",
      goal,
      model: "reflection-model",
      policy,
    });

    scheduler.enqueue(mainStep(1));
    scheduler.enqueue(mainStep(2));
    await scheduler.drain();
    await expect(scheduler.beforeMainStep()).resolves.toEqual([]);
    await expect(scheduler.beforeMainStep()).resolves.toEqual([{
      kind: "reflection",
      source: "nausicaa-reflection",
      content: "Check the package entry point",
      messageId: "run-1:reflection:2",
    }]);
    expect((await ledger.read({ runId: "run-1" })).filter((event) => (
      event.type === "reflection.delivered"
    ))).toHaveLength(1);
    await scheduler.stop();
  });

  it("skips a permanently missing artifact so later reflections remain deliverable", async () => {
    const ledger = new MemoryLedger();
    const backingStore = new MemoryContentAddressedStore();
    const validRef = await backingStore.put(
      JSON.stringify({ action: "revise", note: "Deliver the later observation" }),
      "application/vnd.nausicaa.reflection+json",
    );
    let reads = 0;
    const store: ContentAddressedStore = {
      put: (data, mediaType) => backingStore.put(data, mediaType),
      has: (ref) => backingStore.has(ref),
      get: async (ref) => {
        reads += 1;
        if (reads === 1) throw new ArtifactNotFoundError("reflection artifact disappeared");
        return backingStore.get(validRef);
      },
    };

    const model = new RevisionReflectionModel();
    const scheduler = new ReflectionScheduler({
      eventSink: ledger,
      modelPort: model,
      store,
      runId: "run-1",
      goal,
      model: "reflection-model",
      policy,
    });

    scheduler.enqueue(mainStep(1));
    scheduler.enqueue(mainStep(2));
    const hardStep = mainStep(3);
    scheduler.enqueue({
      ...hardStep,
      delta: { ...hardStep.delta, triggerKind: "goal-change" },
    });
    for (let step = 4; step <= 6; step += 1) scheduler.enqueue(mainStep(step));
    await scheduler.drain();
    await expect(scheduler.beforeMainStep()).resolves.toEqual([]);
    await expect(scheduler.beforeMainStep()).resolves.toEqual([{
      kind: "reflection",
      source: "nausicaa-reflection",
      content: "Deliver the later observation",
      messageId: "run-1:reflection:6",
    }]);
    const events = await ledger.read({ runId: "run-1" });
    expect(events.some((event) => event.type === "lane.status" && event.payload.status === "failed"))
      .toBe(true);

    await scheduler.stop();
  });
});

class CountingReflectionModel implements ModelPort {
  calls = 0;

  async complete(): Promise<ModelResponse> {
    this.calls += 1;
    return reflectionResponse();
  }
}

class PendingReflectionModel implements ModelPort {
  calls = 0;

  async complete(): Promise<ModelResponse> {
    this.calls += 1;
    return new Promise<ModelResponse>(() => undefined);
  }
}

class RevisionReflectionModel implements ModelPort {
  async complete(): Promise<ModelResponse> {
    return {
      content: '{"action":"revise","note":"Check the package entry point"}',
      toolCalls: [],
      stopReason: "stop",
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
    };
  }
}

class FailingReflectionDeliveryLedger extends MemoryLedger {
  private failed = false;

  override async append<K extends import("../../src/domain/index.js").EventType>(
    input: import("../../src/domain/index.js").AppendEvent<K>,
  ) {
    if (!this.failed && input.type === "reflection.delivered") {
      this.failed = true;
      throw new Error("reflection delivery persistence unavailable");
    }
    return super.append(input);
  }
}

function reflectionScheduler(
  ledger: MemoryLedger,
  modelPort: ModelPort,
  runTokenBudget: RunTokenBudget,
  signal?: AbortSignal,
): ReflectionScheduler {
  return new ReflectionScheduler({
    eventSink: ledger,
    modelPort,
    store: new MemoryContentAddressedStore(),
    runId: "run-1",
    goal,
    model: "reflection-model",
    policy,
    runTokenBudget,
    ...(signal === undefined ? {} : { signal }),
  });
}

function reflectionResponse(): ModelResponse {
  return {
    content: '{"action":"silent"}',
    toolCalls: [],
    stopReason: "stop",
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
  };
}

function mainStep(step: number): MainAfterStepContext {
  return {
    runId: "run-1",
    laneId: "main",
    step,
    goal,
    responseText: "Inspecting",
    toolCalls: [],
    toolResults: [],
    delta: {
      boundaryId: `boundary-${step}`,
      triggerKind: "normal",
      activeObjective: goal.statement,
      actionOrDecision: "Inspect package metadata",
      expectedOutcome: "Find the install command",
      outcome: "Still inspecting",
      status: "progress",
      uncertainties: [],
      openQuestions: [],
    },
    usage: { input: 5_000, output: 10, cacheRead: 0, cacheWrite: 0 },
    boundaryMessageIds: [],
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not reached");
}
