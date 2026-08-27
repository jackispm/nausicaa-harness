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
