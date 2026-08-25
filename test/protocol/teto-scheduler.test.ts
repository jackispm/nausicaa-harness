import { describe, expect, it } from "vitest";

import { A2AInbox } from "../../src/a2a/index.js";
import type {
  A2AMessage,
  Goal,
  ModelPort,
  ModelResponse,
  RunPolicy,
  TokenUsage,
} from "../../src/domain/index.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import type { MainAfterStepContext } from "../../src/runtime/main-loop.js";
import {
  recoverTetoSchedulerState,
  TetoScheduler,
  type TetoSchedulerOptions,
} from "../../src/runtime/teto-scheduler.js";
import { IntentNavigator, ObservationFrameBuilder } from "../../src/teto/index.js";

const now = new Date("2026-08-26T00:00:00.000Z");
const clock = { now: () => new Date(now) };
const goal: Goal = {
  version: 1,
  statement: "Find and verify the repository installation command",
  successCriteria: ["Give a command verified from authoritative files"],
  hardConstraints: ["Do not modify the repository"],
};

describe("TetoScheduler", () => {
  it("enqueues synchronously and runs observations one at a time", async () => {
    let releaseFirst: ((response: ModelResponse) => void) | undefined;
    const first = new Promise<ModelResponse>((resolve) => { releaseFirst = resolve; });
    const model = new ScriptedModel([
      () => first,
      silentResponse(),
    ]);
    const { scheduler } = setup(model);

    for (let step = 1; step <= 5; step += 1) {
      scheduler.enqueue(mainStep(step));
    }
    expect(model.callCount).toBe(0);
    await waitFor(() => model.callCount === 1);

    for (let step = 6; step <= 10; step += 1) {
      scheduler.enqueue(mainStep(step));
    }
    await Promise.resolve();
    expect(model.callCount).toBe(1);

    releaseFirst?.(silentResponse());
    await scheduler.drain();
    expect(model.callCount).toBe(2);
    expect(scheduler.snapshot().cadenceState.passCalls).toEqual([5, 10]);
    const tetoInput = model.requests[0]?.messages[0]?.content ?? "";
    expect(tetoInput).not.toContain("private Main response");
    expect(tetoInput).not.toContain("private-tool");
    expect(tetoInput).not.toContain("private-boundary-index");
  });

  it("skips the model when the 10% token gate cannot reserve input and output", async () => {
    const model = new ScriptedModel([]);
    const { scheduler, ledger } = setup(model);

    for (let step = 1; step <= 5; step += 1) {
      scheduler.enqueue(mainStep(step, usage(5, 5)));
    }
    await scheduler.drain();

    expect(model.callCount).toBe(0);
    expect(scheduler.snapshot()).toMatchObject({
      cadenceState: { mainCallIndex: 5, credit: 5, passCalls: [] },
      tokenGateState: { mainTokens: 50, tetoTokens: 0 },
    });
    expect((await ledger.read()).some((event) => event.type === "teto.observed"))
      .toBe(false);
  });

  it("records a silent pass without publishing an Inbox message", async () => {
    const model = new ScriptedModel([silentResponse()]);
    const { scheduler, inbox, ledger } = setup(model);
    enqueueFive(scheduler);

    await scheduler.drain();
    const events = await ledger.read({ runId: "run-1" });

    expect(events.filter((event) => event.type === "teto.observed")).toHaveLength(1);
    expect(events.filter((event) => (
      event.type === "budget.charged" && event.laneId === "teto"
    ))).toHaveLength(1);
    expect(events.some((event) => event.type === "message.sent")).toBe(false);
    expect(inbox.snapshot().records).toEqual([]);
  });

  it("delivers only Advice and leaves disposition to respond_to_advice", async () => {
    const model = new ScriptedModel([adviceResponse()]);
    const { scheduler, inbox } = setup(model);
    await inbox.send(questionMessage());
    enqueueFive(scheduler);
    await scheduler.drain();

    const boundary = await scheduler.beforeMainStep();

    expect(boundary).toHaveLength(1);
    expect(boundary[0]?.content).toContain("adviceId: advice-1");
    expect(boundary[0]?.content).toContain(
      "claim: Installation has been found but not verified.",
    );
    expect(boundary[0]?.content).toContain("respond_to_advice");
    const records = inbox.snapshot().records;
    const advice = records.find((record) => (
      record.message.payload.type === "advice.propose"
    ));
    const question = records.find((record) => (
      record.message.payload.type === "question.ask"
    ));
    expect(advice).toMatchObject({ status: "claimed" });
    expect(advice?.acknowledgement).toBeUndefined();
    expect(question).toMatchObject({ status: "pending" });
  });

  it("isolates a failed pass, records failure, and continues later", async () => {
    const model = new ScriptedModel([
      new Error("Teto provider unavailable"),
      silentResponse(),
    ]);
    const { scheduler, ledger } = setup(model);
    for (let step = 1; step <= 10; step += 1) {
      scheduler.enqueue(mainStep(step));
    }

    await expect(scheduler.drain()).resolves.toBeUndefined();
    const events = await ledger.read({ runId: "run-1" });

    expect(model.callCount).toBe(2);
    expect(events.some((event) => (
      event.type === "lane.status"
      && event.payload.status === "failed"
      && event.payload.reason?.includes("provider unavailable")
    ))).toBe(true);
    expect(events.some((event) => (
      event.type === "teto.observed" && event.payload.mainCallIndex === 10
    ))).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "lane.status",
      payload: { status: "dormant" },
    });
  });

  it("records both usage facts even when actual usage exceeds its reservation", async () => {
    const oversizedUsage = silentResponse();
    oversizedUsage.usage = usage(900, 50);
    const model = new ScriptedModel([oversizedUsage]);
    const { scheduler, ledger } = setup(model);
    for (let step = 1; step <= 5; step += 1) {
      scheduler.enqueue(mainStep(step, usage(2_900, 100)));
    }
    await scheduler.drain();

    const events = await ledger.read({ runId: "run-1" });
    expect(events.some((event) => event.type === "teto.observed")).toBe(true);
    expect(events.some((event) => (
      event.type === "budget.charged"
      && event.laneId === "teto"
      && event.payload.usage.input === 900
    ))).toBe(true);
    expect(events.some((event) => (
      event.type === "lane.status" && event.payload.status === "failed"
    ))).toBe(true);
    expect(scheduler.snapshot().tokenGateState.tetoTokens).toBe(950);
  });

  it("combines caller cancellation with the observation timeout", async () => {
    const controller = new AbortController();
    const model = new ScriptedModel([
      () => new Promise<ModelResponse>(() => undefined),
    ]);
    const { scheduler, ledger } = setup(model, { signal: controller.signal });
    enqueueFive(scheduler);
    await waitFor(() => model.callCount === 1);

    controller.abort(new Error("run cancelled"));
    await scheduler.drain();

    const events = await ledger.read({ runId: "run-1" });
    expect(events.some((event) => (
      event.type === "lane.status"
      && event.payload.status === "cancelled"
      && event.payload.reason?.includes("run cancelled")
    ))).toBe(true);
  });

  it("does not start an observer after caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    let calls = 0;
    const model: ModelPort = {
      complete: async () => {
        calls += 1;
        return silentResponse();
      },
    };
    const { scheduler, ledger } = setup(model, { signal: controller.signal });
    enqueueFive(scheduler);

    await scheduler.drain();

    expect(calls).toBe(0);
    expect((await ledger.read({ runId: "run-1" })).some((event) => (
      event.type === "lane.status" && event.payload.status === "cancelled"
    ))).toBe(true);
  });

  it("ignores complete Main steps entirely", async () => {
    const model = new ScriptedModel([]);
    const { scheduler } = setup(model);

    scheduler.enqueue(mainStep(1, usage(10_000, 10_000), "complete"));
    await scheduler.drain();

    expect(scheduler.snapshot()).toMatchObject({
      cadenceState: { mainCallIndex: 0 },
      tokenGateState: { mainTokens: 0 },
    });
  });

  it("rebuilds cadence and four-part token usage from Ledger events", async () => {
    const ledger = new MemoryLedger({ clock });
    const inbox = new A2AInbox({ sink: ledger, clock });
    const firstModel = new ScriptedModel([silentResponse()]);
    const first = setup(firstModel, { ledger, inbox }).scheduler;
    for (let step = 1; step <= 5; step += 1) {
      const context = mainStep(step, usage(700, 100, 600, 100));
      await recordMainBoundary(ledger, context);
      first.enqueue(context);
    }
    await first.drain();

    const events = await ledger.read({ runId: "run-1" });
    const recovered = recoverTetoSchedulerState(events, { runId: "run-1" });
    expect(recovered).toMatchObject({
      cadenceState: { mainCallIndex: 5, credit: 0, passCalls: [5] },
      tokenGateState: { mainTokens: 7_500, tetoTokens: 200 },
    });

    const secondModel = new ScriptedModel([silentResponse()]);
    const recoveredInbox = A2AInbox.rehydrate(events, { sink: ledger, clock });
    const second = setup(secondModel, {
      ledger,
      inbox: recoveredInbox,
      events,
    }).scheduler;
    for (let step = 6; step <= 10; step += 1) {
      const context = mainStep(step);
      await recordMainBoundary(ledger, context);
      second.enqueue(context);
    }
    await second.drain();

    expect(secondModel.callCount).toBe(1);
    expect(second.snapshot().cadenceState.passCalls).toEqual([5, 10]);
  });
});

function setup(
  model: ModelPort,
  overrides: Partial<TetoSchedulerOptions> & {
    ledger?: MemoryLedger;
    inbox?: A2AInbox;
  } = {},
): { scheduler: TetoScheduler; ledger: MemoryLedger; inbox: A2AInbox } {
  const ledger = overrides.ledger ?? new MemoryLedger({ clock });
  const inbox = overrides.inbox ?? new A2AInbox({ sink: ledger, clock });
  let id = 0;
  const scheduler = new TetoScheduler({
    eventSink: ledger,
    inbox,
    navigator: new IntentNavigator({
      modelPort: model,
      model: "teto-model",
      clock,
      createAdviceId: () => "advice-1",
    }),
    frameBuilder: new ObservationFrameBuilder(),
    runId: "run-1",
    goal,
    model: "teto-model",
    policy: policy(),
    clock,
    createId: () => `id-${++id}`,
    ...withoutHarnessOverrides(overrides),
  });
  return { scheduler, ledger, inbox };
}

function withoutHarnessOverrides(
  overrides: Partial<TetoSchedulerOptions> & {
    ledger?: MemoryLedger;
    inbox?: A2AInbox;
  },
): Partial<TetoSchedulerOptions> {
  const { ledger: _ledger, inbox: _inbox, ...schedulerOptions } = overrides;
  return schedulerOptions;
}

function enqueueFive(scheduler: TetoScheduler): void {
  for (let step = 1; step <= 5; step += 1) {
    scheduler.enqueue(mainStep(step));
  }
}

function mainStep(
  step: number,
  stepUsage = usage(1_300, 200),
  status: MainAfterStepContext["delta"]["status"] = "progress",
): MainAfterStepContext {
  return {
    runId: "run-1",
    laneId: "main",
    step,
    goal,
    responseText: "private Main response",
    toolCalls: [{ id: `tool-${step}`, name: "private-tool", arguments: {} }],
    toolResults: [],
    delta: {
      boundaryId: `run-1:main:step:${step}`,
      triggerKind: "normal",
      activeObjective: "Verify installation",
      actionOrDecision: "Read authoritative package metadata",
      expectedOutcome: "A verified installation command",
      outcome: "Still working",
      status,
      uncertainties: ["Whether the README command is current"],
      openQuestions: ["Has it been tested in a clean directory?"],
    },
    usage: stepUsage,
    boundaryMessageIds: ["private-boundary-index"],
  };
}

function policy(): RunPolicy {
  return {
    maxMainSteps: 20,
    maxModelTokens: 100_000,
    tetoEnabled: true,
    tetoMaxOutputTokens: 200,
    tetoTokenRatio: 0.1,
  };
}

function usage(
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
): TokenUsage {
  return { input, output, cacheRead, cacheWrite };
}

function silentResponse(): ModelResponse {
  return {
    content: '{"action":"silent"}',
    toolCalls: [],
    stopReason: "stop",
    usage: usage(150, 50),
  };
}

function adviceResponse(): ModelResponse {
  return {
    content: JSON.stringify({
      kind: "intent-gap",
      claim: "Installation has been found but not verified.",
      evidenceRefs: ["boundary:5"],
      confidence: 0.9,
      risk: "medium",
      suggestedAction: "Run the command in a clean temporary directory.",
      urgency: "next-step",
      expiresAt: "2026-08-26T00:10:00.000Z",
      dedupeKey: "verify-install",
    }),
    toolCalls: [],
    stopReason: "stop",
    usage: usage(150, 50),
  };
}

function questionMessage(): A2AMessage {
  return {
    messageId: "question-1",
    runId: "run-1",
    conversationId: "run-1",
    threadId: "run-1:main",
    from: "worker",
    to: "main",
    createdAt: now.toISOString(),
    expiresAt: "2026-08-26T00:10:00.000Z",
    correlationId: "run-1",
    idempotencyKey: "question-1",
    visibility: "run",
    priority: 10,
    delivery: "next-step",
    payload: { type: "question.ask", question: "Which package manager is required?" },
  };
}

async function recordMainBoundary(
  ledger: MemoryLedger,
  context: MainAfterStepContext,
): Promise<void> {
  await ledger.append({
    runId: context.runId,
    laneId: context.laneId,
    type: "model.completed",
    payload: {
      model: "main-model",
      responseRef: {
        id: `response-${context.step}`,
        contentHash: `sha256:${String(context.step).padStart(64, "0")}`,
        mediaType: "text/plain",
        byteLength: 1,
      },
      stopReason: "toolUse",
      usage: context.usage,
    },
    correlationId: context.runId,
    idempotencyKey: `main:${context.step}:model`,
  });
  await ledger.append({
    runId: context.runId,
    laneId: context.laneId,
    type: "navigation.updated",
    payload: { delta: context.delta },
    correlationId: context.runId,
    idempotencyKey: `main:${context.step}:navigation`,
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not reached");
}
