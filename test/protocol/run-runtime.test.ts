import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentTool, ModelPort, ModelResponse } from "../../src/domain/index.js";
import { JsonlLedger } from "../../src/ledger/index.js";
import { ScriptedModel, type ScriptedModelStep } from "../../src/model/index.js";
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
    const mainResponses: ScriptedModelStep[] = Array.from({ length: 5 }, (_, index) => ({
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

  it("returns Main's answer without waiting for a slow observer tail", async () => {
    const root = await temporaryRoot();
    const mainResponses: ScriptedModelStep[] = Array.from({ length: 5 }, (_, index) => ({
      ...response(`Step ${index + 1}`, 1_000, 200),
      stopReason: "toolUse",
      toolCalls: [{ id: `slow-call-${index + 1}`, name: "noop", arguments: {} }],
    }));
    mainResponses.push(response("Done", 1_000, 200));
    const slowTeto = new ScriptedModel([async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      return response('{"action":"silent"}', 20, 5);
    }]);
    const startedAt = Date.now();
    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "main-scripted",
      tetoModel: "teto-scripted",
      message: "Complete six bounded decisions",
      policy: { maxMainSteps: 6, maxModelTokens: 50_000 },
    }, {
      mainModel: new ScriptedModel(mainResponses),
      tetoModel: slowTeto,
      tools: [noopTool],
      createRunId: () => "run-slow-teto",
    });

    expect(result).toMatchObject({ completed: true, finalText: "Done" });
    expect(Date.now() - startedAt).toBeLessThan(700);
    const ledger = await JsonlLedger.open(join(result.stateDir, "ledger.jsonl"));
    const events = await ledger.read({ runId: result.runId });
    expect(events.some((event) => event.type === "teto.observed")).toBe(false);
    expect(events.some((event) =>
      event.type === "lane.status"
      && event.laneId === "teto"
      && event.payload.status === "cancelled",
    )).toBe(true);
    await ledger.close();
  });

  it("closes the Run before an observer that ignores cancellation resolves", async () => {
    const root = await temporaryRoot();
    const mainResponses: ScriptedModelStep[] = Array.from({ length: 5 }, (_, index) => ({
      ...response(`Step ${index + 1}`, 1_000, 200),
      stopReason: "toolUse",
      toolCalls: [{ id: `uncooperative-call-${index + 1}`, name: "noop", arguments: {} }],
    }));
    mainResponses.push(response("Done", 1_000, 200));
    let resolveObservation: ((value: ModelResponse) => void) | undefined;
    const uncooperativeTeto: ModelPort = {
      complete: async () => new Promise<ModelResponse>((resolve) => {
        resolveObservation = resolve;
      }),
    };

    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "main-scripted",
      tetoModel: "teto-uncooperative",
      message: "Complete six bounded decisions",
      policy: { maxMainSteps: 6, maxModelTokens: 50_000 },
    }, {
      mainModel: new ScriptedModel(mainResponses),
      tetoModel: uncooperativeTeto,
      tools: [noopTool],
      createRunId: () => "run-uncooperative-teto",
    });

    expect(result).toMatchObject({ completed: true, finalText: "Done" });
    expect(resolveObservation).toBeTypeOf("function");
    const ledger = await JsonlLedger.open(join(result.stateDir, "ledger.jsonl"));
    const before = await ledger.read({ runId: result.runId });
    expect(before.some((event) => event.type === "teto.observed")).toBe(false);
    await ledger.close();

    resolveObservation?.(response('{"action":"silent"}', 20, 5));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const reopened = await JsonlLedger.open(join(result.stateDir, "ledger.jsonl"));
    expect(await reopened.read({ runId: result.runId })).toEqual(before);
    await reopened.close();
  });

  it("delivers Teto Advice at a later Main boundary and records Main's response", async () => {
    const root = await temporaryRoot();
    const mainResponses: ScriptedModelStep[] = Array.from({ length: 5 }, (_, index) => ({
      ...response(`Step ${index + 1}`, 1_800, 200),
      stopReason: "toolUse",
      toolCalls: [{ id: `advice-call-${index + 1}`, name: "noop", arguments: {} }],
    }));
    mainResponses.push(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      return {
        ...response("Give the observer time", 1_800, 200),
        stopReason: "toolUse",
        toolCalls: [{ id: "advice-call-6", name: "noop", arguments: {} }],
      };
    });
    mainResponses.push((request) => {
      const adviceText = request.messages.find((message) =>
        message.role === "user" && message.content.includes("adviceId:"),
      )?.content;
      const adviceId = /adviceId: ([^\n]+)/.exec(adviceText ?? "")?.[1];
      if (adviceId === undefined) throw new Error("Teto Advice was not delivered");
      return {
        ...response("Accept the navigation advice", 1_800, 200),
        stopReason: "toolUse",
        toolCalls: [{
          id: "respond-to-advice",
          name: "respond_to_advice",
          arguments: {
            adviceId,
            disposition: "accept",
            reason: "It closes a missing intent check",
          },
        }],
      };
    });
    mainResponses.push(response("Done with Advice", 1_800, 200));
    const tetoAdvice = JSON.stringify({
      kind: "intent-gap",
      claim: "The installation command still needs a prerequisite check.",
      evidenceRefs: [],
      confidence: 0.9,
      risk: "medium",
      suggestedAction: "Check the package engines field before concluding.",
      urgency: "next-step",
      expiresAt: "2099-01-01T00:00:00.000Z",
      dedupeKey: "check-package-engines",
    });

    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "main-scripted",
      tetoModel: "teto-scripted",
      message: "Inspect installation prerequisites",
      policy: { maxMainSteps: 8, maxModelTokens: 50_000 },
    }, {
      mainModel: new ScriptedModel(mainResponses),
      tetoModel: new ScriptedModel([response(tetoAdvice, 150, 20)]),
      tools: [noopTool],
      createRunId: () => "run-advice-round-trip",
    });

    expect(result).toMatchObject({ completed: true, finalText: "Done with Advice" });
    const ledger = await JsonlLedger.open(join(result.stateDir, "ledger.jsonl"));
    const events = await ledger.read({ runId: result.runId });
    expect(events.filter((event) => event.type === "message.sent")).toHaveLength(1);
    expect(events.filter((event) => event.type === "message.claimed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "advice.acknowledged")).toHaveLength(1);
    expect(events.find((event) => event.type === "advice.acknowledged")?.payload)
      .toMatchObject({ disposition: "accept" });
    expect(events.filter((event) => event.type === "message.handled")).toHaveLength(1);
    await ledger.close();
  });

  it("does not let a slow observer delay Main failure handling", async () => {
    const root = await temporaryRoot();
    const mainScript: ScriptedModelStep[] = Array.from({ length: 5 }, (_, index) => ({
      ...response(`Step ${index + 1}`, 1_000, 200),
      stopReason: "toolUse",
      toolCalls: [{ id: `failure-call-${index + 1}`, name: "noop", arguments: {} }],
    }));
    mainScript.push(new Error("Main provider failed"));
    const slowTeto = new ScriptedModel([async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      return response('{"action":"silent"}', 20, 5);
    }]);
    const startedAt = Date.now();

    await expect(executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "main-scripted",
      tetoModel: "teto-scripted",
      message: "Reach a bounded failure",
      policy: { maxMainSteps: 6, maxModelTokens: 50_000 },
    }, {
      mainModel: new ScriptedModel(mainScript),
      tetoModel: slowTeto,
      tools: [noopTool],
      createRunId: () => "run-main-failure-slow-teto",
    })).rejects.toThrow("Main provider failed");

    expect(Date.now() - startedAt).toBeLessThan(700);
    const ledger = await JsonlLedger.open(join(
      root,
      "state",
      "runs",
      "run-main-failure-slow-teto",
      "ledger.jsonl",
    ));
    const events = await ledger.read({ runId: "run-main-failure-slow-teto" });
    expect(events.some((event) => event.type === "run.failed")).toBe(true);
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
