import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AgentTool,
  ModelPort,
  ModelResponse,
  UserImage,
} from "../../src/domain/index.js";
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
      maxOutputTokens: 8_192,
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
    expect(model.requests[0]?.maxOutputTokens).toBe(8_192);
    const ledger = await JsonlLedger.open(join(result.stateDir, "ledger.jsonl"));
    expect((await ledger.read()).at(-1)?.type).toBe("checkpoint.committed");
    await ledger.close();
  });

  it("rejects an unsafe per-call output limit", async () => {
    const root = await temporaryRoot();
    await expect(executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "Inspect the workspace",
      maxOutputTokens: 1_000_001,
    }, {
      mainModel: new ScriptedModel([response("unused")]),
    })).rejects.toThrow(/maxOutputTokens.*1.*1000000/i);

    await expect(executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "Inspect the workspace",
      policy: { tetoMaxOutputTokens: 0 },
    }, {
      mainModel: new ScriptedModel([response("unused")]),
    })).rejects.toThrow("tetoMaxOutputTokens must be a positive integer");
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
      action: "advise",
      kind: "intent-gap",
      claim: "The installation command still needs a prerequisite check.",
      risk: "medium",
      suggestedAction: "Check the package engines field before concluding.",
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

  it("records shadow Advice without exposing or delivering it to Main", async () => {
    const root = await temporaryRoot();
    const mainResponses: ScriptedModelStep[] = Array.from({ length: 5 }, (_, index) => ({
      ...response(`Step ${index + 1}`, 1_800, 200),
      stopReason: "toolUse",
      toolCalls: [{ id: `shadow-call-${index + 1}`, name: "noop", arguments: {} }],
    }));
    mainResponses.push(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      return {
        ...response("Wait for shadow observation", 1_800, 200),
        stopReason: "toolUse",
        toolCalls: [{ id: "shadow-call-6", name: "noop", arguments: {} }],
      };
    });
    mainResponses.push((request) => {
      expect(request.messages.some((message) =>
        message.role === "user" && message.content.includes("adviceId:"),
      )).toBe(false);
      return response("Done without visible Advice", 1_800, 200);
    });
    const tetoAdvice = JSON.stringify({
      action: "advise",
      kind: "orientation",
      claim: "The current method may drift from the requested scope.",
      risk: "medium",
      suggestedAction: "Reconfirm the requested scope before continuing.",
    });

    const shadowMain = new ScriptedModel(mainResponses);
    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "main-scripted",
      tetoModel: "teto-scripted",
      adviceDelivery: "shadow",
      message: "Inspect only the requested installation scope",
      policy: { maxMainSteps: 7, maxModelTokens: 50_000 },
    }, {
      mainModel: shadowMain,
      tetoModel: new ScriptedModel([response(tetoAdvice, 150, 20)]),
      tools: [noopTool],
      createRunId: () => "run-shadow-advice",
    });

    expect(result.finalText).toBe("Done without visible Advice");
    const ledger = await JsonlLedger.open(join(result.stateDir, "ledger.jsonl"));
    const events = await ledger.read({ runId: result.runId });
    expect(events.filter((event) => event.type === "teto.advice.generated"))
      .toHaveLength(1);
    expect(events.find((event) => event.type === "teto.advice.generated")?.payload)
      .toMatchObject({ delivery: "shadow" });
    expect(events.some((event) => event.type === "message.sent")).toBe(false);
    expect(events.some((event) => event.type === "message.claimed")).toBe(false);
    expect(events.some((event) => event.type === "advice.acknowledged")).toBe(false);
    expect(shadowMain.requests.every((request) =>
      request.tools.every((tool) => tool.name !== "respond_to_advice"),
    )).toBe(true);
    await ledger.close();
  });

  it("runs an equal-budget private reflection arm without Teto context or Advice", async () => {
    const root = await temporaryRoot();
    const mainResponses: ScriptedModelStep[] = Array.from({ length: 5 }, (_, index) => ({
      ...response(`Step ${index + 1}`, 1_800, 200),
      stopReason: "toolUse",
      toolCalls: [{ id: `reflection-call-${index + 1}`, name: "noop", arguments: {} }],
    }));
    mainResponses.push(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      return {
        ...response("Wait for self-reflection", 1_800, 200),
        stopReason: "toolUse",
        toolCalls: [{ id: "reflection-call-6", name: "noop", arguments: {} }],
      };
    });
    mainResponses.push((request) => {
      const reflection = request.messages.find((message) =>
        message.role === "user"
        && message.content.includes("Runtime reflection")
        && message.content.includes("broader than the requested scope"),
      );
      if (reflection === undefined) throw new Error("Self-reflection was not returned to Main");
      return response("Done after bounded self-reflection", 1_800, 200);
    });
    const mainModel = new ScriptedModel(mainResponses);
    const reflectionModel = new ScriptedModel([response(JSON.stringify({
      action: "revise",
      note: "The current method may be broader than the requested scope.",
    }), 150, 20)]);

    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "main-scripted",
      reflectionModel: "reflection-scripted",
      auxiliaryMode: "reflection",
      message: "Inspect installation prerequisites",
      policy: {
        maxMainSteps: 7,
        maxModelTokens: 50_000,
        tetoMaxOutputTokens: 200,
        tetoTokenRatio: 0.1,
      },
    }, {
      mainModel,
      reflectionModel,
      tools: [noopTool],
      createRunId: () => "run-equal-budget-reflection",
    });

    expect(result.finalText).toBe("Done after bounded self-reflection");
    expect(mainModel.callCount).toBe(7);
    expect(reflectionModel.callCount).toBe(1);
    expect(reflectionModel.requests[0]).toMatchObject({
      laneId: "reflection",
      model: "reflection-scripted",
      tools: [],
      maxOutputTokens: 200,
    });
    const reflectionInput = reflectionModel.requests[0]?.messages[0]?.content ?? "";
    expect(reflectionInput).toContain('"latestDecision"');
    expect(reflectionInput).not.toContain('"budget"');
    expect(reflectionInput).not.toContain('"previousAdviceOutcome"');
    expect(mainModel.requests.every((request) =>
      request.tools.every((tool) => tool.name !== "respond_to_advice"),
    )).toBe(true);
    expect(mainModel.requests.some((request) =>
      request.messages.some((message) => message.content.includes("broader than the requested scope")),
    )).toBe(true);

    const ledger = await JsonlLedger.open(join(result.stateDir, "ledger.jsonl"));
    const events = await ledger.read({ runId: result.runId });
    expect(events.some((event) =>
      event.type === "lane.registered"
      && event.laneId === "reflection"
      && event.payload.kind === "reflection",
    )).toBe(true);
    expect(events.filter((event) => event.type === "reflection.observed"))
      .toHaveLength(1);
    expect(events.find((event) => event.type === "reflection.observed")?.payload)
      .toMatchObject({ action: "revise", usage: { input: 150, output: 20 } });
    expect(events.filter((event) => event.type === "reflection.delivered"))
      .toHaveLength(1);
    expect(events.some((event) => event.type === "teto.observed")).toBe(false);
    expect(events.some((event) => event.type === "message.sent")).toBe(false);
    expect(events.some((event) =>
      event.type === "budget.charged" && event.laneId === "reflection",
    )).toBe(true);
    await ledger.close();
  });

  it("does not let a slow observer delay Main failure handling", async () => {
    const root = await temporaryRoot();
    let markTetoStarted: (() => void) | undefined;
    const tetoStarted = new Promise<void>((resolve) => { markTetoStarted = resolve; });
    const mainScript: ScriptedModelStep[] = Array.from({ length: 5 }, (_, index) => ({
      ...response(`Step ${index + 1}`, 1_000, 200),
      stopReason: "toolUse",
      toolCalls: [{ id: `failure-call-${index + 1}`, name: "noop", arguments: {} }],
    }));
    mainScript.push(async () => {
      await tetoStarted;
      throw new Error("Main provider failed");
    });
    const slowTeto = new ScriptedModel([async () => {
      markTetoStarted?.();
      return new Promise<ModelResponse>(() => undefined);
    }]);

    const execution = executeRun({
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
    });

    await tetoStarted;
    await expect(execution).rejects.toThrow("Main provider failed");
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
    expect(first.blocker).toBe("model-output-limit");

    const resumedModel = new ScriptedModel([response("Complete answer")]);
    const resumed = await executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      resumeRunId: first.runId,
      maxOutputTokens: 6_144,
    }, { mainModel: resumedModel });

    expect(resumed).toMatchObject({ completed: true, finalText: "Complete answer" });
    expect(resumedModel.requests[0]?.maxOutputTokens).toBe(6_144);
    expect(resumedModel.requests[0]?.messages.map((message) => message.content)).toEqual([
      "Produce a complete answer",
      "Partial answer",
      expect.stringContaining("Continue exactly where it stopped"),
    ]);
    const ledger = await JsonlLedger.open(join(resumed.stateDir, "ledger.jsonl"));
    const events = await ledger.read({ runId: resumed.runId });
    expect(events.filter((event) => event.type === "run.resumed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "user.message")).toHaveLength(1);
    await ledger.close();
  });

  it("restores all-lane usage before admitting Main on resume", async () => {
    const root = await temporaryRoot();
    const dataDir = join(root, "state");
    const first = await executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      message: "Start a bounded task",
      policy: {
        maxMainSteps: 2,
        maxModelTokens: 10_000,
        tetoEnabled: false,
      },
    }, {
      mainModel: new ScriptedModel([{
        ...response("Partial answer"),
        stopReason: "length",
      }]),
      createRunId: () => "all-lane-budget-resume",
    });
    const ledger = await JsonlLedger.open(join(first.stateDir, "ledger.jsonl"));
    await ledger.append({
      runId: first.runId,
      laneId: "worker",
      type: "budget.charged",
      payload: {
        laneId: "worker",
        usage: { input: 9_980, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      correlationId: `run:${first.runId}`,
      idempotencyKey: `${first.runId}:worker:recovered:budget`,
      visibility: "run",
    });
    await ledger.close();

    const resumedModel = new ScriptedModel([response("must not run")]);
    const resumed = await executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      resumeRunId: first.runId,
    }, { mainModel: resumedModel });

    expect(resumed).toMatchObject({
      completed: false,
      steps: 0,
      blocker: "run-budget-or-step-limit",
    });
    expect(resumedModel.callCount).toBe(0);
    expect(resumed.metrics.total.usage).toEqual({
      input: 10_000,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("returns durable progress when Teto wins a reservation race after preflight", async () => {
    const root = await temporaryRoot();
    const firstText = `First committed step ${"a".repeat(1_200)}`;
    const secondText = `Second committed step ${"b".repeat(1_200)}`;
    const toolUse = (content: string, id: string): ModelResponse => ({
      ...response(content, 1_800, 200),
      stopReason: "toolUse",
      toolCalls: [{ id, name: "noop", arguments: {} }],
    });
    const mainModel = new ScriptedModel([
      toolUse(firstText, "race-call-1"),
      toolUse(secondText, "race-call-2"),
      response("must not run"),
    ]);
    const tetoModel = new ScriptedModel([
      async () => new Promise<ModelResponse>(() => undefined),
    ]);

    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "main-scripted",
      tetoModel: "teto-scripted",
      message: "Complete three bounded tool steps",
      maxOutputTokens: 200,
      policy: {
        maxMainSteps: 3,
        maxModelTokens: 5_000,
        tetoMaxOutputTokens: 200,
        tetoTokenRatio: 0.25,
      },
    }, {
      mainModel,
      tetoModel,
      tools: [noopTool],
      createRunId: () => "main-reservation-race",
    });

    expect(result).toMatchObject({
      finalText: secondText,
      completed: false,
      steps: 2,
      usage: { input: 3_600, output: 400, cacheRead: 0, cacheWrite: 0 },
      blocker: "run-budget-or-step-limit",
    });
    expect(mainModel.callCount).toBe(2);
    expect(tetoModel.callCount).toBe(1);
    const ledger = await JsonlLedger.open(join(result.stateDir, "ledger.jsonl"));
    const events = await ledger.read({ runId: result.runId });
    expect(events.filter((event) => (
      event.type === "model.requested" && event.laneId === "main"
    ))).toHaveLength(2);
    expect(events.some((event) => event.type === "run.failed")).toBe(false);
    expect(events.some((event) => (
      event.type === "lane.status"
      && event.laneId === "main"
      && event.payload.status === "waiting"
      && event.payload.reason === "Run budget or Step limit exhausted"
    ))).toBe(true);
    expect(events.at(-1)?.type).toBe("checkpoint.committed");
    await ledger.close();
  });

  it("preserves one-shot images across recovery without writing them to the Ledger", async () => {
    const root = await temporaryRoot();
    const dataDir = join(root, "state");
    const attachedImage = image("one-shot-recovery-image");
    const firstModel = new ScriptedModel([{
      ...response("Partial image analysis"),
      stopReason: "length",
    }]);
    const first = await executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      message: "Analyze the attached image",
      images: [attachedImage],
      policy: { maxMainSteps: 2, tetoEnabled: false },
    }, {
      mainModel: firstModel,
      createRunId: () => "image-recovery-run",
    });

    expect(first).toMatchObject({ completed: false, blocker: "model-output-limit" });
    expect(firstModel.requests[0]?.messages.find((message) => message.role === "user"))
      .toMatchObject({
        content: "Analyze the attached image",
        images: [attachedImage],
      });
    expect(await readFile(join(first.stateDir, "ledger.jsonl"), "utf8"))
      .not.toContain(attachedImage.data);

    const resumedModel = new ScriptedModel([response("Complete image analysis")]);
    const resumed = await executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      resumeRunId: first.runId,
    }, { mainModel: resumedModel });

    expect(resumed).toMatchObject({ completed: true, finalText: "Complete image analysis" });
    expect(resumedModel.requests[0]?.messages.find((message) =>
      message.role === "user" && message.content === "Analyze the attached image",
    )).toMatchObject({ images: [attachedImage] });
    expect(await readFile(join(resumed.stateDir, "ledger.jsonl"), "utf8"))
      .not.toContain(attachedImage.data);
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

const image = (
  payload: string,
  mimeType: UserImage["mimeType"] = "image/png",
): UserImage => ({
  type: "image",
  data: Buffer.from(payload).toString("base64"),
  mimeType,
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "nausicaa-runtime-"));
  roots.push(root);
  return root;
};
