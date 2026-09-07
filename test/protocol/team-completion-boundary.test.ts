import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnyEvent } from "../../src/domain/events.js";
import type { ModelPort, ModelRequest, ModelResponse } from "../../src/domain/ports.js";
import { ContentStoreFukaiSource, FukaiContextProvider } from "../../src/fukai/index.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { ScriptedModel } from "../../src/model/scripted-model.js";
import { MainLoop } from "../../src/runtime/main-loop.js";
import { executeRun } from "../../src/runtime/run-runtime.js";
import { RunTokenBudget } from "../../src/runtime/run-token-budget.js";
import { SessionController } from "../../src/runtime/session-controller.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

const temporaryDirectories: string[] = [];
const clock = { now: () => new Date("2026-09-07T08:00:00.000Z") };
const usage = { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 };
const policy = { tetoEnabled: false, workerEnabled: false, maxMainStepsPerActivation: 5, maxModelTokens: 100_000 };

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function response(content: string): ModelResponse {
  return { content, toolCalls: [], stopReason: "stop", usage };
}

function creationResponse(): ModelResponse {
  return {
    ...response("Starting evidence review"), stopReason: "toolUse",
    toolCalls: [{
      id: "create-team", name: "team_create",
      arguments: { teamId: "review", members: [{ memberId: "evidence", statement: "Inspect the evidence", maxModelTokens: 12_000, maxWallClockMs: 5_000, maxAttempts: 2 }] },
    }],
  };
}

function completionModels(events: readonly AnyEvent[]) {
  const main = new ScriptedModel([
    creationResponse(),
    response("Premature answer before the evidence is ready"),
    (request: ModelRequest) => {
      const text = request.messages.map((message) => message.content).join("\n");
      expect(text).toContain("Delayed member evidence: checked authentication");
      expect(text).toContain("Team review joined");
      expect(events.some((event) => event.type === "run.completed" || event.type === "turn.completed")).toBe(false);
      return {
        ...response("Accepting the reviewed evidence"), stopReason: "toolUse",
        toolCalls: [{ id: "accept-team", name: "team_present", arguments: { teamId: "review", disposition: "accepted" } }],
      };
    },
    response("Final answer grounded in the Team evidence"),
  ]);
  const memberRequests: ModelRequest[] = [];
  const worker: ModelPort = {
    async complete(request) {
      memberRequests.push(request);
      expect(request.messages.map((message) => message.content).join("\n")).not.toContain("PRIVATE-MAIN-CONTEXT");
      await delay(650);
      expect(events.some((event) => event.type === "run.completed" || event.type === "turn.completed")).toBe(false);
      return response("Delayed member evidence: checked authentication");
    },
  };
  return { main, worker, memberRequests };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "nausicaa-team-completion-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("Team completion boundaries", () => {
  it("one-shot waits beyond the former grace window and finishes only after Main consumes the joined evidence", async () => {
    const root = await temporaryDirectory();
    const events: AnyEvent[] = [];
    const models = completionModels(events);
    const started = Date.now();
    const result = await executeRun({
      workspace: root, dataDir: join(root, "state"), model: "scripted-main", workerModel: "scripted-member",
      message: "PRIVATE-MAIN-CONTEXT: coordinate this review", policy,
    }, {
      mainModel: models.main, workerModel: models.worker, tools: [], workerTools: [], clock,
      createRunId: () => "one-shot-team-completion", onEvent: (event) => { events.push(event); },
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
    expect(result).toMatchObject({ completed: true, finalText: "Final answer grounded in the Team evidence", steps: 4 });
    expect(models.main.requests).toHaveLength(4);
    expect(models.memberRequests).toHaveLength(1);
    assertCompletionOrder(events, "run.completed");
  }, 15_000);

  it("interactive Main consumes Team results before completing its current turn", async () => {
    const root = await temporaryDirectory();
    const events: AnyEvent[] = [];
    const models = completionModels(events);
    const session = await SessionController.open({
      workspace: root, dataDir: join(root, "state"), model: "scripted-main", workerModel: "scripted-member", policy,
    }, {
      mainModel: models.main, workerModel: models.worker, tools: [], workerTools: [], clock,
      createRunId: () => "interactive-team-completion",
    });
    session.subscribe((event) => { if (event.kind === "event") events.push(event.event); });
    try {
      await session.submit({ inputId: "review-input", text: "PRIVATE-MAIN-CONTEXT: coordinate this review" });
      await session.waitForIdle();
      expect(models.main.requests).toHaveLength(4);
      expect(models.memberRequests).toHaveLength(1);
      assertCompletionOrder(events, "turn.completed");
      expect(events.some((event) => event.type === "run.completed")).toBe(false);
    } finally {
      await session.close();
    }
  }, 15_000);

  it("leaves one-shot incomplete when Team consumption would exceed the original Main step allowance", async () => {
    const root = await temporaryDirectory();
    const events: AnyEvent[] = [];
    const main = new ScriptedModel([creationResponse(), response("Unverified early answer")]);
    const worker = new ScriptedModel([async () => { await delay(50); return response("Evidence after Main's final allowed step"); }]);
    const result = await executeRun({
      workspace: root, dataDir: join(root, "state"), model: "scripted-main", message: "Review evidence",
      policy: { ...policy, maxMainStepsPerActivation: 2 },
    }, {
      mainModel: main, workerModel: worker, tools: [], workerTools: [], clock,
      createRunId: () => "step-limited-team-completion", onEvent: (event) => { events.push(event); },
    });
    expect(result).toMatchObject({ completed: false, steps: 2, blocker: "resumable-boundary" });
    expect(main.requests).toHaveLength(2);
    expect(events.some((event) => event.type === "team.joined")).toBe(true);
    expect(events.some((event) => event.type === "run.completed")).toBe(false);
    expect(events.filter((event) => event.type === "model.requested" && event.laneId === "main")).toHaveLength(2);
    expect(events.filter((event) => event.type === "budget.charged" && event.laneId === "main")).toHaveLength(2);
  }, 15_000);

  it("a completion hook cannot extend the configured model step or token allowance", async () => {
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger({ clock });
    const model = new ScriptedModel([response("First unfinished proposal"), response("Second unfinished proposal")]);
    const beforeCompletion = vi.fn(async () => true);
    const tokenBudget = new RunTokenBudget(10_000);
    const loop = new MainLoop({
      model, contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store, eventSink: ledger, tools: [], clock, runTokenBudget: tokenBudget,
      includeProjectInstructions: false, beforeCompletion,
    });
    const result = await loop.run({
      runId: "bounded-completion-hook", model: "scripted-main", workspace: process.cwd(), initialMessage: "Review evidence",
      goal: { version: 1, statement: "Review evidence", successCriteria: [], hardConstraints: [] },
      policy: { ...policy, maxMainStepsPerActivation: 2, maxModelTokens: 10_000, tetoMaxOutputTokens: 64 },
      includeProjectInstructions: false,
    });
    expect(result).toMatchObject({ completed: false, steps: 2 });
    expect(beforeCompletion).toHaveBeenCalledTimes(2);
    expect(model.requests).toHaveLength(2);
    expect(tokenBudget.snapshot()).toMatchObject({ usedTokens: 28, reservedTokens: 0 });
    expect((await ledger.read({ runId: "bounded-completion-hook" })).some((event) => event.type === "run.completed")).toBe(false);
  });
});

function assertCompletionOrder(events: readonly AnyEvent[], terminalType: "run.completed" | "turn.completed"): void {
  const joined = events.find((event) => event.type === "team.joined")!;
  const presented = events.find((event) => event.type === "team.presented")!;
  const completed = events.filter((event) => event.type === terminalType);
  expect(joined).toBeDefined();
  expect(presented).toBeDefined();
  expect(completed).toHaveLength(1);
  expect(presented.globalOffset).toBeGreaterThan(joined.globalOffset);
  expect(completed[0]!.globalOffset).toBeGreaterThan(presented.globalOffset);
  const notice = events.find((event) => event.type === "message.sent" && event.payload.message.payload.type === "message.inform" && event.payload.message.payload.text.includes("Team review joined"));
  expect(notice?.type).toBe("message.sent");
  if (notice?.type !== "message.sent") throw new Error("No durable Team join notification");
  const consumed = events.find((event) => event.type === "step.completed" && event.laneId === "main" && event.payload.boundaryMessageIds?.includes(notice.payload.message.messageId));
  expect(consumed).toBeDefined();
  expect(completed[0]!.globalOffset).toBeGreaterThan(consumed!.globalOffset);
}
