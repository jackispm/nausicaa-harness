import { describe, expect, it } from "vitest";

import type { Goal, ModelPort, ModelRequest, ModelResponse, RunPolicy } from "../../src/domain/index.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import type { MainAfterStepContext } from "../../src/runtime/main-loop.js";
import { ReflectionScheduler } from "../../src/runtime/index.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

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
    const scheduler = new ReflectionScheduler({
      eventSink: ledger,
      modelPort: model,
      store: new MemoryContentAddressedStore(),
      runId: "run-1",
      goal,
      model: "reflection-model",
      policy,
    });

    scheduler.enqueue(mainStep(1));
    scheduler.enqueue(mainStep(2));
    await scheduler.drain();

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]).toMatchObject({ maxOutputTokens: 64, tools: [] });
    const failureReasons = (await ledger.read({ runId: "run-1" })).flatMap((event) => (
      event.type === "lane.status" && event.payload.status === "failed"
        ? [event.payload.reason]
        : []
    ));
    expect(failureReasons).toHaveLength(1);
    expect(failureReasons[0]).toContain(
      "Reflection output was truncated at the 64-token limit",
    );
    await scheduler.stop();
  });
});

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
