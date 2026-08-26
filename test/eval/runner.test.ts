import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ModelPort, ModelRequest, ModelResponse } from "../../src/domain/index.js";
import {
  PRIMARY_TREATMENT_ARM,
  PREREGISTERED_ARMS,
  PREREGISTERED_MANIFEST,
} from "./preregistered-contract.js";
import {
  BudgetExceededError,
  EvaluationContractError,
  ExperimentBudgetMeter,
  ProviderUsageError,
  RunBudgetMeter,
  armExecutionConfig,
  balancedArmOrder,
  evaluationPairOrder,
  executeEvaluationArm,
  runEvaluationPair,
  runPhase24Evaluation,
  verifyEvidenceCheckpoint,
} from "./runner.js";
import { FROZEN_TOOL_CONTRACT } from "./tool-contract.js";

const roots: string[] = [];
const cleanRepository = {
  executionCommit: PREREGISTERED_MANIFEST.provenance.repositoryCommit,
  clean: true,
  baselineIsAncestor: true,
} as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Phase 2.4 evaluation runner", () => {
  it("maps all four treatments and balances every arm position", () => {
    expect(PREREGISTERED_MANIFEST.arms.map((arm) => armExecutionConfig(arm))).toEqual([
      { auxiliaryMode: "none" },
      { auxiliaryMode: "reflection" },
      { auxiliaryMode: "teto", adviceDelivery: "shadow" },
      { auxiliaryMode: "teto", adviceDelivery: "live" },
    ]);

    const pairOrder = evaluationPairOrder(PREREGISTERED_MANIFEST);
    expect(pairOrder).toEqual(evaluationPairOrder(PREREGISTERED_MANIFEST));
    expect(pairOrder).toHaveLength(PREREGISTERED_MANIFEST.sampleCount);
    expect(new Set(pairOrder.map(({ task, repetition }) => `${task.taskId}:${repetition}`)).size)
      .toBe(PREREGISTERED_MANIFEST.sampleCount);

    const firstCycle = Array.from({ length: PREREGISTERED_ARMS.length }, (_, index) =>
      balancedArmOrder(PREREGISTERED_MANIFEST, index).map((arm) => arm.id));
    for (const armId of PREREGISTERED_ARMS) {
      expect(firstCycle.map((order) => order.indexOf(armId)).sort()).toEqual([0, 1, 2, 3]);
    }
  });

  it("runs every category through real executeRun with legal shadow and live treatments", async () => {
    const root = await temporaryRoot();
    const pairs = await Promise.all(PREREGISTERED_MANIFEST.tasks.map((task, index) =>
      runEvaluationPair(task.taskId, 0, {
        rootDirectory: join(root, String(index)),
        writeArtifacts: false,
        repositoryStateForTests: cleanRepository,
      })));

    for (const pair of pairs) {
      expect(pair.records.map((record) => record.armId)).toEqual([...PREREGISTERED_ARMS]);
      expect(pair.row).toBeDefined();
      expect(pair.records.map((record) => ({
        armId: record.armId,
        completed: record.outcome?.completed,
        error: record.error,
        requests: record.budget.requests,
        auxiliaryRequests: record.budget.auxiliaryRequests,
        tools: record.toolTrace.map((entry) => entry.arguments.path ?? entry.name),
      }))).toEqual(PREREGISTERED_ARMS.map((armId) => ({
        armId,
        completed: true,
        error: undefined,
        requests: expect.any(Number),
        auxiliaryRequests: armId === "main-only" ? 0 : expect.any(Number),
        tools: expect.any(Array),
      })));
      expect(pair.records.every((record) => record.outcome?.quality === 1)).toBe(true);
      expect(pair.records.every((record) => record.treatmentFidelity.passed)).toBe(true);
      expect(pair.records.every((record) => record.budget.requests <= 10)).toBe(true);

      const shadow = pair.records.find((record) => record.armId === "teto-shadow")!;
      expect(shadow.treatmentFidelity.adviceGenerated).toBeGreaterThan(0);
      expect(shadow.treatmentFidelity).toMatchObject({ advicePublished: 0, adviceClaimed: 0 });
      expect(shadow.outcome?.advice.unacknowledged).toBe(shadow.outcome?.advice.proposed);

      const live = pair.records.find((record) => record.armId === "teto-live")!;
      expect(live.treatmentFidelity.adviceGenerated).toBeGreaterThan(0);
      expect(live.treatmentFidelity.advicePublished).toBeGreaterThan(0);
      expect(live.treatmentFidelity.adviceAcknowledged).toBeGreaterThan(0);
      expect(live.outcome?.advice.accepted).toBeGreaterThan(0);
    }
  }, 30_000);

  it("pins the exact model and complete arm tool matrix before a request", () => {
    const arm = PREREGISTERED_MANIFEST.arms[0]!;
    const valid = requestFor(
      PREREGISTERED_MANIFEST.model.main,
      FROZEN_TOOL_CONTRACT.modes.readOnly,
    );
    expect(() => new RunBudgetMeter(arm, PREREGISTERED_MANIFEST.model, false, false)
      .beforeRequest(valid)).not.toThrow();

    const wrongModel = { ...valid, model: "openrouter:other/model" };
    expect(() => new RunBudgetMeter(arm, PREREGISTERED_MANIFEST.model, false, false)
      .beforeRequest(wrongModel)).toThrow(EvaluationContractError);

    const wrongTools = { ...valid, tools: [] };
    expect(() => new RunBudgetMeter(arm, PREREGISTERED_MANIFEST.model, false, false)
      .beforeRequest(wrongTools)).toThrow(EvaluationContractError);
  });

  it("stops on arm, operator, cumulative time, and missing-cost breaches", () => {
    const baseArm = PREREGISTERED_MANIFEST.arms[0]!;
    const arm = { ...baseArm, budget: { ...baseArm.budget, maxRequests: 1 } };
    const request = requestFor(PREREGISTERED_MANIFEST.model.main, FROZEN_TOOL_CONTRACT.modes.readOnly);
    const armMeter = new RunBudgetMeter(arm, PREREGISTERED_MANIFEST.model, false, false);
    armMeter.beforeRequest(request);
    expect(() => armMeter.beforeRequest(request)).toThrow(BudgetExceededError);
    expect(armMeter.snapshot()).toMatchObject({ breached: true, requests: 1 });

    const totalBudget = { ...PREREGISTERED_MANIFEST.experimentBudget, maxCumulativeWallClockMs: 1 };
    const experiment = new ExperimentBudgetMeter(totalBudget, 0.001);
    experiment.chargeWallClock(2);
    expect(experiment.canStart()).toBe(false);
    expect(() => experiment.beforeRequest()).toThrow(BudgetExceededError);

    const costExperiment = new ExperimentBudgetMeter(PREREGISTERED_MANIFEST.experimentBudget, 0.20);
    const liveMeter = new RunBudgetMeter(baseArm, PREREGISTERED_MANIFEST.model, false, true, costExperiment);
    liveMeter.beforeRequest(request);
    expect(() => liveMeter.charge(request, responseWithoutCost(), 5)).toThrow(ProviderUsageError);
    expect(costExperiment.canStart()).toBe(false);
  });

  it("keeps runtime and treatment failures as auditable outcomes", async () => {
    const root = await temporaryRoot();
    const failedPair = await runEvaluationPair("goal-drift-001", 0, {
      rootDirectory: join(root, "provider-failure"),
      writeArtifacts: false,
      repositoryStateForTests: cleanRepository,
      modelFactory: () => new ThrowingModel(),
    });
    expect(failedPair.row).toBeDefined();
    expect(failedPair.records.every((record) => record.outcome?.completed === false)).toBe(true);
    expect(failedPair.records.every((record) => record.outcome?.quality === 0)).toBe(true);

    const task = PREREGISTERED_MANIFEST.tasks[0]!;
    const liveArm = PREREGISTERED_MANIFEST.arms.find((arm) => arm.id === PRIMARY_TREATMENT_ARM)!;
    const fidelityFailure = await executeEvaluationArm(task, 0, liveArm, {
      rootDirectory: join(root, "fidelity-failure"),
      modelFactory: () => new ImmediateFinalModel(),
    });
    expect(fidelityFailure.result?.completed).toBe(true);
    expect(fidelityFailure.treatmentFidelity.passed).toBe(false);
    expect(fidelityFailure.outcome).toMatchObject({
      completed: false,
      failureKind: "runtime",
      quality: 0,
    });
  });

  it("checkpoints raw evidence and detects any mutation", async () => {
    const root = await temporaryRoot();
    const artifactDirectory = join(root, "artifacts");
    const evaluation = await runPhase24Evaluation({
      rootDirectory: join(root, "runs"),
      artifactDirectory,
      evaluationId: "offline-proof",
      repositoryStateForTests: cleanRepository,
      modelFactory: () => new ImmediateFinalModel(),
    });

    expect(evaluation.records).toHaveLength(PREREGISTERED_MANIFEST.sampleCount * PREREGISTERED_ARMS.length);
    expect(evaluation.rows).toHaveLength(PREREGISTERED_MANIFEST.sampleCount);
    expect(evaluation.failures.length).toBeGreaterThan(0);
    expect(evaluation.report?.provenance).toMatchObject({
      executionCommit: cleanRepository.executionCommit,
      evidenceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });

    const raw = JSON.parse(await readFile(join(artifactDirectory, "raw", "records.json"), "utf8")) as unknown;
    expect(() => verifyEvidenceCheckpoint(raw)).not.toThrow();
    const changed = structuredClone(raw) as { records: Array<{ budget: { requests: number } }> };
    changed.records[0]!.budget.requests += 1;
    expect(() => verifyEvidenceCheckpoint(changed)).toThrow(/digest/);

    const redacted = await readFile(join(artifactDirectory, "report.json"), "utf8");
    expect(redacted).toContain(evaluation.report!.provenance.evidenceDigest);
    expect(redacted).not.toContain("Install with npm install");
  }, 30_000);
});

function requestFor(model: string, tools: readonly unknown[]): ModelRequest {
  return {
    runId: "runner-test",
    laneId: "main",
    sessionId: "runner-test:main",
    model,
    systemPrompt: "frozen",
    messages: [],
    tools: structuredClone(tools) as ModelRequest["tools"],
    maxOutputTokens: 128,
  };
}

function responseWithoutCost(): ModelResponse {
  return {
    content: "done",
    toolCalls: [],
    stopReason: "stop",
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
  };
}

class ThrowingModel implements ModelPort {
  async complete(): Promise<ModelResponse> {
    throw new Error("provider unavailable");
  }
}

class ImmediateFinalModel implements ModelPort {
  async complete(): Promise<ModelResponse> {
    return {
      content: "npm install on Node.js >=22.19",
      toolCalls: [],
      stopReason: "stop",
      usage: { input: 100, output: 12, cacheRead: 0, cacheWrite: 0, costUsd: 0.001 },
    };
  }
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nausicaa-phase24-runner-"));
  roots.push(root);
  return root;
}
