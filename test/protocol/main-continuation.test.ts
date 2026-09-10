import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AnyEvent } from "../../src/domain/events.js";
import type { AgentTool, ModelResponse } from "../../src/domain/ports.js";
import { ContentStoreFukaiSource, FukaiContextProvider } from "../../src/fukai/index.js";
import { JsonlLedger, MemoryLedger } from "../../src/ledger/index.js";
import { ScriptedModel } from "../../src/model/scripted-model.js";
import { MainLoop } from "../../src/runtime/main-loop.js";
import { executeRun } from "../../src/runtime/run-runtime.js";
import { SessionController } from "../../src/runtime/session-controller.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

const roots: string[] = [];
const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 };
const policy = { tetoEnabled: false, workerEnabled: false };
const goal = { version: 1, statement: "Finish the task", successCriteria: [], hardConstraints: [] };

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("Main scheduling continuation", () => {
  it.each(["session", "one-shot"] as const)("finishes more than 24 tool rounds without user resume in %s", async (entry) => {
    const root = await workspace();
    const events: AnyEvent[] = [];
    const executed: number[] = [];
    const tool = countingTool(executed);
    const model = new ScriptedModel([
      ...Array.from({ length: 26 }, (_, index) => toolResponse(index + 1)),
      (request) => {
        expect(request.messages.filter((message) => message.role === "tool" && message.content === "step 24")).toHaveLength(1);
        expect(request.messages.some((message) => message.role === "tool" && message.content === "step 26")).toBe(true);
        return response("Finished all 26 operations");
      },
    ]);
    if (entry === "one-shot") {
      const result = await executeRun({
        workspace: root, dataDir: join(root, "state"), model: "scripted", message: goal.statement, policy,
      }, { mainModel: model, tools: [tool], onEvent: (event) => { events.push(event); } });
      expect(result).toMatchObject({ completed: true, steps: 27, usage: { input: 270, output: 54 } });
    } else {
      const session = await SessionController.open({
        workspace: root, dataDir: join(root, "state"), model: "scripted", policy,
      }, { mainModel: model, tools: [tool] });
      session.subscribe((event) => { if (event.kind === "event") events.push(event.event); });
      try {
        const admitted = await session.submit({ inputId: "long-task", text: goal.statement });
        await session.waitForIdle();
        expect(session.snapshot()).toMatchObject({ status: "idle", usage: { input: 270, output: 54 } });
        expect(session.snapshot().blocker).toBeUndefined();
        expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1);
        expect(events.find((event) => event.type === "turn.completed")?.turnId).toBe(admitted.turnId);
      } finally {
        await session.close();
      }
    }
    expect(model.callCount).toBe(27);
    expect(executed).toEqual(Array.from({ length: 26 }, (_, index) => index + 1));
    const mainEvents = events.filter((event) => event.laneId === "main");
    expect(mainEvents.filter((event) => event.type === "step.completed").map((event) => event.payload.step))
      .toEqual(Array.from({ length: 27 }, (_, index) => index + 1));
    expect(mainEvents.filter((event) => event.type === "budget.charged")).toHaveLength(27);
    expect(mainEvents.filter((event) => event.type === "tool.succeeded")).toHaveLength(26);
    expect(mainEvents.some((event) => event.type === "turn.waiting" || event.type === "turn.resumed")).toBe(false);
  }, 30_000);

  it("still writes the final answer when team_present is the last step of a slice", async () => {
    const root = await workspace();
    const events: AnyEvent[] = [];
    let joined!: () => void;
    const teamJoined = new Promise<void>((resolve) => { joined = resolve; });
    const model = new ScriptedModel([
      {
        ...response("Create the Team"), stopReason: "toolUse",
        toolCalls: [{ id: "create", name: "team_create", arguments: {
          teamId: "boundary", members: [{ memberId: "reviewer", statement: "Review the result" }],
        } }],
      },
      async () => { await teamJoined; return toolResponse(2); },
      ...Array.from({ length: 21 }, (_, index) => toolResponse(index + 3)),
      {
        ...response("Accept the review"), stopReason: "toolUse",
        toolCalls: [{ id: "present", name: "team_present", arguments: { teamId: "boundary", disposition: "accepted" } }],
      },
      (request) => {
        expect(request.messages.some((message) => message.role === "tool" && message.toolName === "team_present" && !message.isError)).toBe(true);
        return response("The Team's work is complete and accepted");
      },
    ]);
    const session = await SessionController.open({
      workspace: root, dataDir: join(root, "state"), model: "scripted", policy,
    }, {
      mainModel: model, workerModel: new ScriptedModel([response("Review complete")]),
      tools: [countingTool([])], workerTools: [],
    });
    session.subscribe((event) => {
      if (event.kind !== "event") return;
      events.push(event.event);
      if (event.event.type === "team.joined") joined();
    });
    try {
      await session.submit({ inputId: "team-task", text: "Create a Team and finish its work" });
      await session.waitForIdle();
      expect(model.callCount).toBe(25);
      expect(session.snapshot().blocker).toBeUndefined();
      const mainEvents = events.filter((event) => event.laneId === "main");
      const presented = mainEvents.find((event) => event.type === "team.presented")!;
      const step24 = mainEvents.find((event) => event.type === "step.completed" && event.payload.step === 24)!;
      const completed = mainEvents.find((event) => event.type === "turn.completed")!;
      expect(presented.globalOffset).toBeLessThan(step24.globalOffset);
      expect(completed.globalOffset).toBeGreaterThan(step24.globalOffset);
      expect(mainEvents.some((event) => event.type === "turn.waiting")).toBe(false);
      expect((await session.transcript()).at(-1)).toMatchObject({ content: "The Team's work is complete and accepted" });
    } finally {
      joined();
      await session.close();
    }
  }, 30_000);

  it("honors cancellation between slices before another model request or tool can run", async () => {
    const root = await workspace();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const controller = new AbortController();
    const executed: number[] = [];
    const model = new ScriptedModel([...Array.from({ length: 24 }, (_, index) => toolResponse(index + 1)), response("must not run")]);
    const loop = new MainLoop({
      model, contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store, eventSink: ledger, tools: [countingTool(executed)],
      afterStep: ({ step }) => { if (step === 24) setImmediate(() => controller.abort(new Error("stop between slices"))); },
    });
    await expect(loop.run({
      runId: "cancel-slice", model: "scripted", workspace: root, goal, initialMessage: goal.statement,
      policy: { ...policy, maxMainStepsPerActivation: 24, tetoMaxOutputTokens: 64 },
      continueAfterStepAllowance: true, signal: controller.signal,
    })).rejects.toThrow("stop between slices");
    expect(model.callCount).toBe(24);
    expect(executed).toHaveLength(24);
    const events = await ledger.read({ runId: "cancel-slice" });
    expect(events.filter((event) => event.type === "budget.charged")).toHaveLength(24);
    expect(events.some((event) => event.type === "run.completed")).toBe(false);
  });

  it("resumes an output limit after the first slice without repeating tools or charges", async () => {
    const root = await workspace();
    const executed: number[] = [];
    const firstModel = new ScriptedModel([
      ...Array.from({ length: 24 }, (_, index) => toolResponse(index + 1)),
      { ...response("Partial final report"), stopReason: "length" },
    ]);
    const first = await executeRun({
      workspace: root, dataDir: join(root, "state"), model: "scripted", message: goal.statement, policy,
    }, { mainModel: firstModel, tools: [countingTool(executed)] });
    expect(first).toMatchObject({ completed: false, steps: 25, blocker: "model-output-limit", usage: { input: 250, output: 50 } });
    const resumedModel = new ScriptedModel([(request) => {
      expect(request.messages.some((message) => message.content === "step 24")).toBe(true);
      expect(request.messages.some((message) => message.content === "Partial final report")).toBe(true);
      return response("Final report complete");
    }]);
    const resumed = await executeRun({
      workspace: root, dataDir: join(root, "state"), model: "scripted", resumeRunId: first.runId,
    }, { mainModel: resumedModel, tools: [countingTool(executed)] });
    expect(resumed).toMatchObject({ completed: true, steps: 1, usage });
    expect(executed).toHaveLength(24);
    const ledger = await JsonlLedger.open(join(first.stateDir, "ledger.jsonl"));
    try {
      const events = (await ledger.read({ runId: first.runId })).filter((event) => event.laneId === "main");
      expect(events.filter((event) => event.type === "budget.charged")).toHaveLength(26);
      expect(events.filter((event) => event.type === "tool.succeeded")).toHaveLength(24);
      expect(events.filter((event) => event.type === "step.completed").map((event) => event.payload.step))
        .toEqual(Array.from({ length: 26 }, (_, index) => index + 1));
      expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1);
    } finally {
      await ledger.close();
    }
  }, 30_000);

  it("does not expand a persisted explicit legacy hard step limit during resume", async () => {
    const root = await workspace();
    const executed: number[] = [];
    const model = new ScriptedModel([toolResponse(1), response("must not run")]);
    const first = await executeRun({
      workspace: root, dataDir: join(root, "state"), model: "scripted", message: goal.statement,
      policy: { ...policy, maxMainSteps: 1 },
    }, { mainModel: model, tools: [countingTool(executed)] });
    expect(first).toMatchObject({ completed: false, steps: 1 });
    const resumed = await executeRun({
      workspace: root, dataDir: join(root, "state"), model: "scripted", resumeRunId: first.runId,
    }, { mainModel: model, tools: [countingTool(executed)] });
    expect(resumed).toMatchObject({ completed: false, steps: 0, blocker: "run-budget-or-step-limit" });
    expect(model.callCount).toBe(1);
    expect(executed).toEqual([1]);
  });

  it.each(([
    ["length", "output token limit"],
    ["aborted", "provider aborted"],
    ["unknown-provider-stop", "unsupported stop reason"],
  ] as const).flatMap(([stopReason, error]) => [1, 24].map((step) => ({ stopReason, error, step }))))(
    "rejects tools and requires explicit recovery for $stopReason at step $step of a 24-step slice",
    async ({ stopReason, error, step }) => {
      const root = await workspace();
      const store = new MemoryContentAddressedStore();
      const ledger = new MemoryLedger();
      const executed: number[] = [];
      const model = new ScriptedModel([
        ...Array.from({ length: step - 1 }, (_, index) => toolResponse(index + 1)),
        { ...toolResponse(step), stopReason },
        response("Explicitly recovered"),
      ]);
      const loop = new MainLoop({
        model, contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
        conversationStore: store, eventSink: ledger, tools: [countingTool(executed)],
      });
      const input = {
        runId: `no-continue-${stopReason}-${step}`, model: "scripted", workspace: root, goal,
        policy: { ...policy, maxMainStepsPerActivation: 24, tetoMaxOutputTokens: 64 }, continueAfterStepAllowance: true,
      };
      const stopped = await loop.run({ ...input, initialMessage: goal.statement });
      expect(stopped).toMatchObject({ completed: false, stopReason, steps: step });
      expect(model.callCount).toBe(step);
      expect(executed).toEqual(Array.from({ length: step - 1 }, (_, index) => index + 1));
      const events = await ledger.read({ runId: input.runId });
      expect(events.filter((event) => event.type === "tool.failed")).toMatchObject([{
        payload: { toolCallId: `call-${step}`, error: expect.stringContaining(error) },
      }]);
      expect(events.some((event) => (event.type === "tool.admitted" || event.type === "tool.started")
        && event.payload.toolCallId === `call-${step}`)).toBe(false);

      expect(await loop.run({
        ...input, startStep: step + 1, conversationRefs: stopped.conversationRefs, upperWatermark: await ledger.watermark(),
      })).toMatchObject({ completed: true, finalText: "Explicitly recovered", steps: 1 });
      expect(model.requests.at(-1)?.messages.find((message) => message.role === "tool" && message.toolCallId === `call-${step}`))
        .toMatchObject({ isError: true, content: expect.stringContaining(error) });
      expect(executed).toHaveLength(step - 1);
    },
  );

  it.each([
    ["aborted", "model-aborted"],
    ["unknown-provider-stop", "model-response-incomplete"],
  ])("requires explicit recovery for %s without misreporting a step limit", async (stopReason, reason) => {
    const root = await workspace();
    const model = new ScriptedModel([{ ...response("Partial reply"), stopReason: stopReason! }, response("Recovered")]);
    const session = await SessionController.open({
      workspace: root, dataDir: join(root, "state"), model: "scripted", policy,
    }, { mainModel: model, tools: [] });
    try {
      await session.submit({ inputId: "provider-boundary", text: goal.statement });
      await session.waitForIdle();
      expect(model.callCount).toBe(1);
      expect(session.snapshot().blocker).toBe(reason);
      await session.resumeCurrent();
      await session.waitForIdle();
      expect(model.callCount).toBe(2);
      expect(session.snapshot().blocker).toBeUndefined();
    } finally {
      await session.close();
    }
  });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nausicaa-main-continuation-"));
  roots.push(root);
  return root;
}

function response(content: string): ModelResponse {
  return { content, toolCalls: [], stopReason: "stop", usage };
}

function toolResponse(step: number): ModelResponse {
  return { ...response(`Perform operation ${step}`), stopReason: "toolUse", toolCalls: [{ id: `call-${step}`, name: "count", arguments: { step } }] };
}

function countingTool(executed: number[]): AgentTool {
  return {
    definition: { name: "count", description: "Record one operation", parameters: { type: "object", properties: { step: { type: "integer" } }, required: ["step"] } },
    async execute(arguments_) {
      const step = arguments_.step as number;
      executed.push(step);
      return { content: `step ${step}`, isError: false };
    },
  };
}
