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
      arguments: { teamId: "review", members: [{ memberId: "evidence", statement: "Inspect the evidence" }] },
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
      expect(events.some((event) => event.type === "run.completed")).toBe(false);
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
      expect(events.some((event) => event.type === "run.completed")).toBe(false);
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
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

  it("interactive Main can finish while Team work continues and resumes after a member report", async () => {
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
      // The interactive Turn is complete while the member remains live. Its
      // durable report later schedules a fresh Main continuation.
      expect(models.main.requests).toHaveLength(2);
      expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
      await delay(800);
      await session.waitForIdle();
      expect(models.main.requests).toHaveLength(4);
      expect(models.memberRequests).toHaveLength(1);
      expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(2);
      expect(events.some((event) => event.type === "team.joined")).toBe(true);
      expect(events.some((event) => event.type === "team.presented")).toBe(true);
      expect(events.some((event) => event.type === "run.completed")).toBe(false);
    } finally {
      await session.close();
    }
  }, 15_000);

  it("does not wake a cancelled Main Turn when a fenced member settles late", async () => {
    const root = await temporaryDirectory();
    let markWorkerStarted: (() => void) | undefined;
    const workerStarted = new Promise<void>((resolve) => { markWorkerStarted = resolve; });
    let releaseWorker: ((value: ModelResponse) => void) | undefined;
    const worker: ModelPort = {
      async complete() {
        markWorkerStarted?.();
        return new Promise<ModelResponse>((resolve) => { releaseWorker = resolve; });
      },
    };
    const main = new ScriptedModel([
      creationResponse(),
      response("The Team is still working"),
      response("A cancelled Team must not restart this Turn"),
    ]);
    const events: AnyEvent[] = [];
    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted-main",
      workerModel: "scripted-member",
      policy,
    }, {
      mainModel: main,
      workerModel: worker,
      tools: [],
      workerTools: [],
      clock,
      createRunId: () => "cancelled-team-wake",
    });
    session.subscribe((event) => { if (event.kind === "event") events.push(event.event); });
    try {
      await session.submit({ inputId: "cancelled-team-input", text: "Start a Team" });
      await workerStarted;
      await session.waitForIdle();
      expect(main.requests).toHaveLength(2);

      await session.cancel("stop the Team");
      // Resolve a provider that ignored the cancellation signal. The branch
      // is fenced, so its late result must not schedule a fresh Main Turn.
      releaseWorker?.(response("late result after cancellation"));
      await delay(100);
      await session.waitForIdle();

      expect(main.requests).toHaveLength(2);
      expect(events.some((event) => event.type === "team.cancelled")).toBe(true);
      expect(events.filter((event) => event.type === "input.admitted" && event.payload.inputId.startsWith("team-report-"))).toHaveLength(0);
    } finally {
      await session.close();
    }
  }, 15_000);

  it("coalesces ten staggered member reports across an idle lead, a busy continuation, and completion cleanup", async () => {
    const root = await temporaryDirectory();
    const events: AnyEvent[] = [];
    const memberIds = Array.from({ length: 10 }, (_, index) => `worker-${index + 1}`);
    const memberGates = new Map(memberIds.map((memberId) => [memberId, deferred<ModelResponse>()]));
    const memberReports = new Map(memberIds.map((memberId) => [memberId, deferred<void>()]));
    const allMembersStarted = deferred<void>();
    const firstContinuationStarted = deferred<void>();
    const finishBusyRequest = deferred<void>();
    const startedMembers = new Set<string>();
    const mainRequests: ModelRequest[] = [];
    let completedMainTurns = 0;
    let lastReportSawMainRunning = false;
    const worker: ModelPort = {
      async complete(request) {
        const memberId = request.laneId.split(":").at(-1)!;
        const gate = memberGates.get(memberId);
        if (gate === undefined) throw new Error(`Unexpected member lane ${request.laneId}`);
        startedMembers.add(memberId);
        if (startedMembers.size === memberIds.length) allMembersStarted.resolve();
        return gate.promise;
      },
    };
    const main: ModelPort = {
      async complete(request) {
        mainRequests.push(request);
        if (mainRequests.length === 1) {
          return {
            ...response("Start ten independent inspections"),
            stopReason: "toolUse",
            toolCalls: [{
              id: "create-ten-members",
              name: "team_create",
              arguments: {
                teamId: "staggered",
                members: memberIds.map((memberId) => ({ memberId, statement: `Inspect ${memberId}` })),
              },
            }],
          };
        }
        if (mainRequests.length === 2) return response("Lead work complete; members continue asynchronously");
        if (mainRequests.length === 3) {
          firstContinuationStarted.resolve();
          await finishBusyRequest.promise;
        }
        return response("Reviewed the available member reports");
      },
    };
    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted-main",
      workerModel: "scripted-member",
      policy: { tetoEnabled: false, workerEnabled: false, maxMainStepsPerActivation: 5 },
    }, {
      mainModel: main,
      workerModel: worker,
      tools: [],
      workerTools: [],
      clock,
      createRunId: () => "staggered-team-wake",
      async commitExecutionLease(operation) {
        const result = await operation();
        const event = result as AnyEvent;
        if (event.type === "turn.completed" && event.laneId === "main") {
          completedMainTurns += 1;
          if (completedMainTurns === 2) {
            // The completion is durable, but its caller still owns Main's
            // execution slot. Deliver the last report inside this window.
            memberGates.get("worker-10")!.resolve(response("Evidence from worker-10"));
            await memberReports.get("worker-10")!.promise;
          }
        }
        return result;
      },
    });
    session.subscribe((event) => {
      if (event.kind !== "event") return;
      events.push(event.event);
      if (event.event.type === "message.sent" && event.event.payload.message.payload.type === "task.result") {
        const memberId = event.event.payload.message.from.split(":").at(-1)!;
        if (memberId === "worker-10") lastReportSawMainRunning = session.snapshot().status === "running";
        memberReports.get(memberId)?.resolve();
      }
    });
    try {
      await session.submit({ inputId: "staggered-input", text: "Coordinate ten independent inspections" });
      await allMembersStarted.promise;
      await session.waitForIdle();
      expect(mainRequests).toHaveLength(2);
      expect(session.snapshot().status).toBe("idle");

      for (const memberId of ["worker-1", "worker-2", "worker-3"]) {
        memberGates.get(memberId)!.resolve(response(`Evidence from ${memberId}`));
      }
      await firstContinuationStarted.promise;
      for (const memberId of ["worker-8", "worker-5", "worker-9", "worker-4", "worker-7", "worker-6"]) {
        memberGates.get(memberId)!.resolve(response(`Evidence from ${memberId}`));
        await memberReports.get(memberId)!.promise;
      }
      expect(session.snapshot().status).toBe("running");
      finishBusyRequest.resolve();
      await session.waitForIdle();

      const results = events.filter((event) => event.type === "message.sent" && event.payload.message.payload.type === "task.result");
      expect(results).toHaveLength(10);
      const committedMessageIds = events.flatMap((event) => event.type === "step.completed" && event.laneId === "main"
        ? event.payload.boundaryMessageIds ?? [] : []);
      for (const event of results) {
        if (event.type !== "message.sent") throw new Error("Expected a result message");
        expect(committedMessageIds.filter((messageId) => messageId === event.payload.message.messageId)).toHaveLength(1);
      }
      expect(lastReportSawMainRunning).toBe(true);
      expect(events.filter((event) => event.type === "team.member.settled" && event.payload.outcome === "succeeded")).toHaveLength(10);
      expect(events.filter((event) => event.type === "input.admitted" && event.payload.inputId.startsWith("team-report-"))).toHaveLength(2);
      expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(3);
      expect(events.some((event) => event.type === "turn.failed" || event.type === "turn.waiting")).toBe(false);
      expect(session.snapshot().status).toBe("idle");
      const settledRequests = mainRequests.length;
      await delay(50);
      await session.waitForIdle();
      expect(mainRequests).toHaveLength(settledRequests);
    } finally {
      finishBusyRequest.resolve();
      for (const gate of memberGates.values()) gate.resolve(response("test cleanup"));
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
