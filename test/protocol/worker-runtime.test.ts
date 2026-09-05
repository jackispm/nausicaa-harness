import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentTool, ModelRequest, ModelResponse } from "../../src/domain/index.js";
import { JsonlLedger, projectTaskGraph } from "../../src/ledger/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import { executeRun } from "../../src/runtime/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("executeRun Worker lane", () => {
  it("delegates bounded work and returns its result at a later Main boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-worker-runtime-"));
    roots.push(root);
    const mainStep = (
      request: ModelRequest,
      callIndex: number,
    ): ModelResponse => {
      const workerNotice = request.messages.some((message) => (
        message.role === "user" && message.content.includes("Worker task task-1 completed")
      ));
      if (workerNotice) {
        return response("Worker result incorporated");
      }
      if (callIndex === 0) {
        return {
          ...response("Queueing a bounded inspection", 30, 8),
          stopReason: "toolUse",
          toolCalls: [{
            id: "delegate-1",
            name: "delegate_task",
            arguments: {
              taskId: "task-1",
              statement: "Inspect the package metadata",
              successCriteria: ["Return the package name"],
              maxModelTokens: 200,
              maxWallClockMs: 5_000,
            },
          }],
        };
      }
      return {
        ...response("Give the worker one more boundary", 30, 8),
        stopReason: "toolUse",
        toolCalls: [{ id: `noop-${callIndex}`, name: "noop", arguments: {} }],
      };
    };
    const mainModel = new ScriptedModel(Array.from({ length: 4 }, () => mainStep));
    const workerModel = new ScriptedModel([
      response("package name: nausicaa", 20, 6),
    ]);

    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted/main",
      workerModel: "scripted/worker",
      workerEnabled: true,
      message: "Inspect the package metadata",
      policy: {
        maxMainSteps: 4,
        maxModelTokens: 50_000,
        tetoEnabled: false,
      },
    }, {
      mainModel,
      workerModel,
      tools: [noopTool],
      createRunId: () => "worker-runtime-run",
    });

    expect(result).toMatchObject({
      completed: true,
      finalText: "Worker result incorporated",
    });
    expect(mainModel.callCount).toBeGreaterThanOrEqual(2);
    expect(workerModel.callCount).toBe(1);
    expect(workerModel.requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "read_file",
      "read_many",
      "list_files",
      "grep",
      "find",
      "file_info",
      "git_status",
      "git_log",
      "git_show",
      "git_diff",
      "read_image",
    ]);

    const ledger = await JsonlLedger.open(join(result.stateDir, "ledger.jsonl"));
    const events = await ledger.read({ runId: result.runId });
    expect(events.some((event) => (
      event.type === "lane.registered"
      && event.laneId === "worker"
      && event.payload.kind === "worker"
    ))).toBe(true);
    expect(events.some((event) => (
      event.type === "message.sent"
      && event.payload.message.payload.type === "task.request"
    ))).toBe(true);
    expect(events.some((event) => (
      event.type === "message.sent"
      && event.payload.message.payload.type === "task.result"
      && event.payload.message.payload.taskId === "task-1"
    ))).toBe(true);
    expect(events.some((event) => event.type === "message.handled")).toBe(true);
    expect(projectTaskGraph(events, result.runId)).toMatchObject({
      anomalies: [],
      tasks: [{
        taskId: "task-1",
        state: {
          kind: "joined",
          terminal: { type: "task.result" },
        },
      }],
    });
    await ledger.close();
  });

  it("fans out three tasks while Main continues and joins every terminal at later boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-worker-fanout-"));
    roots.push(root);
    const runId = "worker-fanout-run";
    const ledgerPath = join(root, "state", "runs", runId, "ledger.jsonl");
    const terminalIds = [
      `${runId}:worker:task:task-alpha:result`,
      `${runId}:worker:task:task-beta:failed`,
      `${runId}:worker:task:task-gamma:result`,
    ];
    const observedTerminalIds = new Set<string>();
    let markAllTerminalsSent: (() => void) | undefined;
    const allTerminalsSent = new Promise<void>((resolve) => {
      markAllTerminalsSent = resolve;
    });
    let releaseFirstWorker: (() => void) | undefined;
    const firstWorkerRelease = new Promise<void>((resolve) => {
      releaseFirstWorker = resolve;
    });
    let markFirstWorkerStarted: (() => void) | undefined;
    const firstWorkerStarted = new Promise<void>((resolve) => {
      markFirstWorkerStarted = resolve;
    });
    let activeWorkers = 0;
    let maxActiveWorkers = 0;
    let completedWorkerCalls = 0;
    let mainWorkerOverlapObserved = false;
    const workerOrder: string[] = [];

    const beginWorker = (taskId: string): void => {
      workerOrder.push(taskId);
      activeWorkers += 1;
      maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
    };
    const endWorker = (): void => {
      completedWorkerCalls += 1;
      activeWorkers -= 1;
    };
    const workerStep = async (
      request: ModelRequest,
      callIndex: number,
    ): Promise<ModelResponse> => {
      const taskId = request.sessionId.slice(request.sessionId.lastIndexOf(":") + 1);
      beginWorker(taskId);
      try {
        if (callIndex === 0) {
          markFirstWorkerStarted?.();
          await firstWorkerRelease;
        }
        if (taskId === "task-beta") throw new Error("beta evidence unavailable");
        return response(`${taskId} evidence`, 12 + callIndex, 3 + callIndex);
      } finally {
        endWorker();
      }
    };
    const workerModel = new ScriptedModel([workerStep, workerStep, workerStep]);

    const mainStep = async (
      request: ModelRequest,
      callIndex: number,
    ): Promise<ModelResponse> => {
      const context = request.messages.map((message) => message.content).join("\n");
      const hasAllTerminals = [
        "Worker task task-alpha completed",
        "Worker task task-beta failed",
        "Worker task task-gamma completed",
      ].every((notice) => context.includes(notice));
      if (hasAllTerminals) return response("All Worker terminals incorporated");

      if (callIndex === 0) {
        return {
          ...response("Delegating three independent evidence shards", 30, 8),
          stopReason: "toolUse",
          toolCalls: ["alpha", "beta", "gamma"].map((name) => ({
            id: `delegate-${name}`,
            name: "delegate_task",
            arguments: {
              taskId: `task-${name}`,
              statement: `Inspect ${name} evidence`,
              successCriteria: [`Return ${name} evidence`],
              maxModelTokens: 200,
              maxWallClockMs: 5_000,
            },
          })),
        };
      }

      if (callIndex === 1) {
        await firstWorkerStarted;
        mainWorkerOverlapObserved = activeWorkers === 1 && completedWorkerCalls === 0;
        releaseFirstWorker?.();
        await allTerminalsSent;
      }
      return {
        ...response("Main continues while bounded Worker tasks finish", 30, 8),
        stopReason: "toolUse",
        toolCalls: [{ id: `noop-${callIndex}`, name: "noop", arguments: {} }],
      };
    };
    const mainModel = new ScriptedModel(Array.from({ length: 8 }, () => mainStep));

    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted/main",
      workerModel: "scripted/worker",
      workerEnabled: true,
      message: "Inspect three independent evidence shards",
      policy: {
        maxMainSteps: 8,
        maxModelTokens: 50_000,
        tetoEnabled: false,
      },
    }, {
      mainModel,
      workerModel,
      tools: [noopTool],
      createRunId: () => runId,
      onEvent: (event) => {
        if (
          event.type !== "message.sent"
          || !terminalIds.includes(event.payload.message.messageId)
          || !["task.result", "task.failed"].includes(event.payload.message.payload.type)
        ) {
          return;
        }
        observedTerminalIds.add(event.payload.message.messageId);
        if (observedTerminalIds.size === terminalIds.length) markAllTerminalsSent?.();
      },
    });

    expect(result).toMatchObject({
      completed: true,
      finalText: "All Worker terminals incorporated",
    });
    expect(mainWorkerOverlapObserved).toBe(true);
    expect(mainModel.requests[1]?.messages.some((message) => (
      message.content.includes("Worker task")
    ))).toBe(false);
    expect([...workerOrder].sort()).toEqual(["task-alpha", "task-beta", "task-gamma"]);
    expect(maxActiveWorkers).toBe(1);
    expect(workerModel.callCount).toBe(3);

    const ledger = await JsonlLedger.open(ledgerPath);
    const events = await ledger.read({ runId });
    const graph = projectTaskGraph(events, runId);
    expect(graph.anomalies).toEqual([]);
    expect(graph.tasks.map((task) => ({
      taskId: task.taskId,
      state: task.state.kind,
      terminal: task.state.kind === "joined" ? task.state.terminal.type : undefined,
      joinStep: task.state.kind === "joined" ? task.state.join.step : undefined,
    })).sort((left, right) => left.taskId.localeCompare(right.taskId))).toEqual([
      { taskId: "task-alpha", state: "joined", terminal: "task.result", joinStep: expect.any(Number) },
      { taskId: "task-beta", state: "joined", terminal: "task.failed", joinStep: expect.any(Number) },
      { taskId: "task-gamma", state: "joined", terminal: "task.result", joinStep: expect.any(Number) },
    ]);
    expect(graph.tasks.every((task) => (
      task.state.kind === "joined" && task.state.join.step > 1
    ))).toBe(true);
    const joinedTerminalIds = events.flatMap((event) => (
      event.type === "step.completed" ? event.payload.boundaryMessageIds ?? [] : []
    )).filter((messageId) => terminalIds.includes(messageId));
    expect(joinedTerminalIds.sort()).toEqual([...terminalIds].sort());
    await ledger.close();
  });
});

const noopTool: AgentTool = {
  definition: {
    name: "noop",
    description: "Return a deterministic result",
    parameters: { type: "object", additionalProperties: false },
  },
  async execute() {
    return { content: "ok", isError: false };
  },
};

const response = (content: string, input = 20, output = 5): ModelResponse => ({
  content,
  toolCalls: [],
  stopReason: "stop",
  usage: { input, output, cacheRead: 0, cacheWrite: 0 },
});
