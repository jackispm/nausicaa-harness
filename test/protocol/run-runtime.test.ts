import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentTool, ModelResponse } from "../../src/domain/index.js";
import { JsonlLedger } from "../../src/ledger/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import { executeRun } from "../../src/runtime/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

describe("executeRun", () => {
  it("composes a complete Main-only Run on the file-backed runtime", async () => {
    const root = await temporaryRoot();
    const model = new ScriptedModel([response("Grounded answer")]);
    const events: string[] = [];

    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "Inspect the workspace",
      policy: { maxMainSteps: 3, tetoEnabled: false },
    }, {
      mainModel: model,
      createRunId: () => "run-main-only",
      onEvent: (event) => events.push(event.type),
    });

    expect(result).toMatchObject({
      runId: "run-main-only",
      finalText: "Grounded answer",
      completed: true,
      steps: 1,
    });
    expect(events).toContain("run.created");
    expect(events).toContain("run.completed");
    const ledger = await JsonlLedger.open(join(result.stateDir, "ledger.jsonl"));
    expect((await ledger.read()).at(-1)?.type).toBe("checkpoint.committed");
    await ledger.close();
  });

  it("runs Teto sparsely beside Main and records a silent pass", async () => {
    const root = await temporaryRoot();
    const mainResponses: ModelResponse[] = Array.from({ length: 5 }, (_, index) => ({
      ...response(`Step ${index + 1}`, 1_800, 200),
      stopReason: "toolUse",
      toolCalls: [{ id: `call-${index + 1}`, name: "noop", arguments: {} }],
    }));
    mainResponses.push(response("Done", 1_800, 200));
    const mainModel = new ScriptedModel(mainResponses);
    const tetoModel = new ScriptedModel([response('{"action":"silent"}', 150, 20)]);

    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "main-scripted",
      tetoModel: "teto-scripted",
      message: "Complete six bounded decisions",
      policy: { maxMainSteps: 6, maxModelTokens: 50_000 },
    }, {
      mainModel,
      tetoModel,
      tools: [noopTool],
      createRunId: () => "run-with-teto",
    });

    expect(result.completed).toBe(true);
    expect(mainModel.callCount).toBe(6);
    expect(tetoModel.callCount).toBe(1);
    const ledger = await JsonlLedger.open(join(result.stateDir, "ledger.jsonl"));
    const events = await ledger.read({ runId: result.runId });
    expect(events.filter((event) => event.type === "teto.observed")).toHaveLength(1);
    expect(events.filter((event) =>
      event.type === "budget.charged" && event.laneId === "teto",
    )).toHaveLength(1);
    expect(events.some((event) => event.type === "message.sent")).toBe(false);
    await ledger.close();
  });

  it("resumes from a committed boundary without replaying the transcript", async () => {
    const root = await temporaryRoot();
    const dataDir = join(root, "state");
    const first = await executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      message: "Produce a complete answer",
      policy: { maxMainSteps: 3, tetoEnabled: false },
    }, {
      mainModel: new ScriptedModel([{
        ...response("Partial answer"),
        stopReason: "length",
      }]),
      createRunId: () => "resumable-run",
    });
    expect(first.completed).toBe(false);

    const resumedModel = new ScriptedModel([response("Complete answer")]);
    const resumed = await executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      resumeRunId: first.runId,
    }, { mainModel: resumedModel });

    expect(resumed).toMatchObject({ completed: true, finalText: "Complete answer" });
    expect(resumedModel.requests[0]?.messages.map((message) => message.content)).toEqual([
      "Produce a complete answer",
      "Partial answer",
    ]);
    const ledger = await JsonlLedger.open(join(resumed.stateDir, "ledger.jsonl"));
    const events = await ledger.read({ runId: resumed.runId });
    expect(events.filter((event) => event.type === "run.resumed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "user.message")).toHaveLength(1);
    await ledger.close();
  });

  it("does not let an observer failure undo a committed event", async () => {
    const root = await temporaryRoot();
    let observations = 0;

    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "Complete the task",
      policy: { maxMainSteps: 1, tetoEnabled: false },
    }, {
      mainModel: new ScriptedModel([response("Done")]),
      createRunId: () => "observer-failure-run",
      onEvent: async () => {
        observations += 1;
        throw new Error("observer failed");
      },
    });

    expect(result.completed).toBe(true);
    expect(observations).toBeGreaterThan(0);
    const ledger = await JsonlLedger.open(join(result.stateDir, "ledger.jsonl"));
    const events = await ledger.read({ runId: result.runId });
    expect(events.some((event) => event.type === "run.completed")).toBe(true);
    await ledger.close();
  });

  it("closes the Ledger when the content Store cannot be opened", async () => {
    const root = await temporaryRoot();
    const stateDir = join(root, "state", "runs", "store-open-failure");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "store"), "not a directory", "utf8");

    await expect(executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "Complete the task",
      policy: { maxMainSteps: 1, tetoEnabled: false },
    }, {
      mainModel: new ScriptedModel([response("unused")]),
      createRunId: () => "store-open-failure",
    })).rejects.toThrow();

    const ledger = await JsonlLedger.open(join(stateDir, "ledger.jsonl"));
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

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "nausicaa-runtime-"));
  roots.push(root);
  return root;
};
