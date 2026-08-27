import { describe, expect, it } from "vitest";

import {
  WORKER_LIVE_ARMS,
  WORKER_LIVE_BASELINE_COMMIT,
  WORKER_LIVE_CONTROL_ARM,
  WORKER_LIVE_MANIFEST,
  WORKER_LIVE_MODEL,
  WORKER_LIVE_TOOL_CONTRACT,
  WORKER_LIVE_TOOL_CONTRACT_VERSION,
  WORKER_LIVE_TOOL_MODES,
  WORKER_LIVE_TREATMENT_ARM,
  buildWorkerLiveReport,
  evaluateWorkerLiveDecision,
  hashWorkerLiveManifest,
  pairedWorkerLiveBootstrapCi95,
  validateWorkerLiveManifest,
  validateWorkerLiveReport,
  workerLiveArmOrder,
  workerLivePairOrder,
  type WorkerLiveArmId,
  type WorkerLiveManifest,
  type WorkerLiveOutcome,
  type WorkerLivePairedRow,
  type WorkerLiveReportOptions,
} from "./worker-live-contract.js";
import { hashJson } from "./fingerprint.js";

const reportOptions: WorkerLiveReportOptions = {
  evaluationId: "worker-live-contract-test",
  startedAt: "2026-08-27T00:00:00.000Z",
  completedAt: "2026-08-27T00:10:00.000Z",
  repositoryDirty: false,
  baselineIsAncestor: true,
  executionCommit: "0123456789abcdef0123456789abcdef01234567",
  evidenceDigest: `sha256:${"ab".repeat(32)}`,
};

describe("real-model Worker A/B preregistration", () => {
  it("freezes identity, equal arm budgets, whole-experiment budget, and provenance", () => {
    validateWorkerLiveManifest(WORKER_LIVE_MANIFEST);

    expect(WORKER_LIVE_MANIFEST.model).toEqual({
      main: WORKER_LIVE_MODEL,
      worker: WORKER_LIVE_MODEL,
    });
    expect(WORKER_LIVE_MODEL).toBe("openrouter:z-ai/glm-4.7-flash");
    expect(WORKER_LIVE_MANIFEST.arms.map((arm) => arm.id)).toEqual([
      WORKER_LIVE_CONTROL_ARM,
      WORKER_LIVE_TREATMENT_ARM,
    ]);
    expect(WORKER_LIVE_MANIFEST.arms[0]?.budget)
      .toEqual(WORKER_LIVE_MANIFEST.arms[1]?.budget);
    expect(WORKER_LIVE_MANIFEST.arms.every((arm) => arm.budget.scope === "per-arm-run"))
      .toBe(true);
    expect(WORKER_LIVE_MANIFEST.experimentBudget).toMatchObject({
      scope: "whole-experiment",
      maxRequests: 288,
      maxCostUsd: 3,
    });
    expect(WORKER_LIVE_MANIFEST.retryPolicy).toEqual({
      runnerRetries: 0,
      providerMaxAttempts: 2,
      providerBaseDelayMs: 250,
      providerMaxDelayMs: 4_000,
    });
    expect(WORKER_LIVE_MANIFEST.execution).toEqual({
      auxiliaryMode: "none",
      maxMainStepsPerActivation: 8,
      maxOutputTokensPerRequest: 1_024,
      costEnforcement: "post-response-soft-stop",
      allowWrite: false,
      allowShell: false,
    });
    expect(WORKER_LIVE_MANIFEST.toolContract).toEqual({
      version: WORKER_LIVE_TOOL_CONTRACT_VERSION,
      hashes: WORKER_LIVE_TOOL_CONTRACT.hashes,
    });
    expect(WORKER_LIVE_TOOL_CONTRACT_VERSION).toBe("worker-live-tools-v1");
    expect(Object.fromEntries(WORKER_LIVE_TOOL_MODES.map((mode) => [
      mode,
      WORKER_LIVE_TOOL_CONTRACT.definitions[mode].map((definition) => definition.name),
    ]))).toEqual({
      "main-only": ["read_file", "list_files", "grep", "find"],
      "main-worker": ["read_file", "list_files", "grep", "find", "delegate_task"],
      worker: [],
    });
    for (const mode of WORKER_LIVE_TOOL_MODES) {
      expect(WORKER_LIVE_TOOL_CONTRACT.hashes[mode])
        .toBe(hashJson(WORKER_LIVE_TOOL_CONTRACT.definitions[mode]));
    }
    expect(WORKER_LIVE_TOOL_CONTRACT.hashes).toEqual({
      "main-only": "sha256:a795d65bd6082de91edf860bbabacdd96d9709874f6d01fd8873de8efd9851de",
      "main-worker": "sha256:6c880607fa5a282f10313dd57f0111c1646bf3806b7070e50e1b617d21a37f68",
      worker: "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    });
    expect(WORKER_LIVE_MANIFEST.provenance).toMatchObject({
      baselineCommit: WORKER_LIVE_BASELINE_COMMIT,
      runnerVersion: "nausicaa-worker-live-runner-v1",
    });
    expect(WORKER_LIVE_BASELINE_COMMIT)
      .toBe("617a0b2f97c59da526b961542d4f3580fb4f43c8");
    expect(WORKER_LIVE_MANIFEST.manifestHash)
      .toBe(hashWorkerLiveManifest(WORKER_LIVE_MANIFEST));
    expect(WORKER_LIVE_MANIFEST.manifestHash)
      .toBe("sha256:e0b138553f48a4b31d81b67be24a1e639158c8a0d2760421df24dc7381b3394d");
    expect(Object.isFrozen(WORKER_LIVE_MANIFEST)).toBe(true);
    expect(Object.isFrozen(WORKER_LIVE_MANIFEST.arms[0]?.budget)).toBe(true);
    expect(Object.isFrozen(WORKER_LIVE_MANIFEST.execution)).toBe(true);
    expect(Object.isFrozen(WORKER_LIVE_MANIFEST.toolContract)).toBe(true);
    expect(Object.isFrozen(WORKER_LIVE_MANIFEST.toolContract.hashes)).toBe(true);
    expect(Object.isFrozen(WORKER_LIVE_TOOL_CONTRACT)).toBe(true);
    expect(Object.isFrozen(WORKER_LIVE_TOOL_CONTRACT.definitions["main-worker"]))
      .toBe(true);
  });

  it("uses a deterministic seeded task order and balanced arm rotation", () => {
    const first = workerLivePairOrder();
    const second = workerLivePairOrder();
    expect(first).toEqual(second);
    expect(first).toHaveLength(WORKER_LIVE_MANIFEST.sampleCount);
    expect(new Set(first.map(({ task, repetition }) => `${task.taskId}:${repetition}`)).size)
      .toBe(WORKER_LIVE_MANIFEST.sampleCount);

    const firstArmCounts = new Map<WorkerLiveArmId, number>(WORKER_LIVE_ARMS.map((arm) => [arm, 0]));
    for (let index = 0; index < WORKER_LIVE_MANIFEST.sampleCount; index += 1) {
      const order = workerLiveArmOrder(WORKER_LIVE_MANIFEST, index);
      expect(new Set(order.map((arm) => arm.id))).toEqual(new Set(WORKER_LIVE_ARMS));
      firstArmCounts.set(order[0]!.id, firstArmCounts.get(order[0]!.id)! + 1);
    }
    expect(firstArmCounts.get(WORKER_LIVE_CONTROL_ARM))
      .toBe(firstArmCounts.get(WORKER_LIVE_TREATMENT_ARM));
  });

  it("builds all preregistered metric fields and deterministic paired intervals", () => {
    const rows = buildRows();
    const report = buildWorkerLiveReport(WORKER_LIVE_MANIFEST, rows, reportOptions);
    const repeated = buildWorkerLiveReport(WORKER_LIVE_MANIFEST, rows, reportOptions);

    expect(report).toEqual(repeated);
    expect(report.aggregates[WORKER_LIVE_TREATMENT_ARM]).toMatchObject({
      sampleCount: WORKER_LIVE_MANIFEST.sampleCount,
      completionRate: 1,
      qualityMean: expect.any(Number),
      costMeanUsd: expect.any(Number),
      wallClockMeanMs: expect.any(Number),
      requestP95LatencyMeanMs: expect.any(Number),
      cacheReadRatioMean: expect.any(Number),
      workerUseRate: 0.75,
      overlapRate: 0.75,
      utilityCi95: { low: expect.any(Number), high: expect.any(Number) },
    });
    expect(report.uplift).toMatchObject({
      pairedSamples: WORKER_LIVE_MANIFEST.sampleCount,
      utilityDeltaCi95: { low: expect.any(Number), high: expect.any(Number) },
      qualityDeltaCi95: { low: expect.any(Number), high: expect.any(Number) },
      costDeltaCi95: { low: expect.any(Number), high: expect.any(Number) },
      wallClockDeltaCi95: { low: expect.any(Number), high: expect.any(Number) },
      cacheReadRatioDeltaCi95: { low: expect.any(Number), high: expect.any(Number) },
      workerUseDeltaCi95: { low: expect.any(Number), high: expect.any(Number) },
      overlapDeltaCi95: { low: expect.any(Number), high: expect.any(Number) },
    });
    expect(report.experimentUsage).toMatchObject({
      budgetBreached: false,
      cacheReadTokens: 4_800,
      cacheWriteTokens: 0,
    });
    expect(report.provenance).toMatchObject({
      ...reportOptions,
      baselineCommit: WORKER_LIVE_BASELINE_COMMIT,
      manifestHash: WORKER_LIVE_MANIFEST.manifestHash,
    });
    expect(() => validateWorkerLiveReport(
      WORKER_LIVE_MANIFEST,
      JSON.parse(JSON.stringify(report)) as unknown,
    )).not.toThrow();

    const values = rows.map((_, index) => index % 3 - 1);
    const options = { seed: WORKER_LIVE_MANIFEST.seed, replicates: 1_000, stream: "test" };
    expect(pairedWorkerLiveBootstrapCi95(values, options))
      .toEqual(pairedWorkerLiveBootstrapCi95(values, options));
  });

  it("advances only after CI, quality, budget, Worker-use, restraint, and overlap gates pass", () => {
    const report = buildWorkerLiveReport(WORKER_LIVE_MANIFEST, buildRows(), reportOptions);
    expect(evaluateWorkerLiveDecision(WORKER_LIVE_MANIFEST, report)).toMatchObject({
      status: "advance",
      eligible: true,
      checks: {
        complete: true,
        perRunBudget: true,
        experimentBudget: true,
        utility: true,
        quality: true,
        decomposableWorkerUse: true,
        sentinelRestraint: true,
        overlap: true,
      },
    });

    const noWorker = buildRows();
    for (const row of noWorker) {
      const outcome = row.outcomes[WORKER_LIVE_TREATMENT_ARM];
      outcome.workerUsed = false;
      outcome.workerRequestCount = 0;
      outcome.overlapMs = 0;
      outcome.overlapped = false;
    }
    const hold = evaluateWorkerLiveDecision(
      WORKER_LIVE_MANIFEST,
      buildWorkerLiveReport(WORKER_LIVE_MANIFEST, noWorker, reportOptions),
    );
    expect(hold).toMatchObject({
      status: "hold",
      eligible: false,
      checks: { decomposableWorkerUse: false, overlap: false },
    });

    const zeroUplift = buildRows();
    for (const row of zeroUplift) {
      const control = row.outcomes[WORKER_LIVE_CONTROL_ARM];
      const treatment = row.outcomes[WORKER_LIVE_TREATMENT_ARM];
      treatment.quality = control.quality;
      treatment.costUsd = control.costUsd;
      treatment.wallClockMs = control.wallClockMs;
    }
    expect(evaluateWorkerLiveDecision(
      WORKER_LIVE_MANIFEST,
      buildWorkerLiveReport(WORKER_LIVE_MANIFEST, zeroUplift, reportOptions),
    )).toMatchObject({ status: "hold", checks: { utility: false } });
  });

  it("charges cache-read and cache-write tokens against the per-Run model budget", () => {
    const rows = buildRows();
    const outcome = rows[0]!.outcomes[WORKER_LIVE_TREATMENT_ARM];
    outcome.completed = false;
    outcome.failureKind = "budget";
    outcome.budgetBreached = true;
    outcome.quality = 0;
    outcome.inputTokens = 0;
    outcome.outputTokens = 0;
    outcome.cacheReadTokens = 50_001;
    outcome.cacheWriteTokens = 0;
    outcome.cacheReadRatio = 1;

    const report = buildWorkerLiveReport(WORKER_LIVE_MANIFEST, rows, reportOptions);
    expect(report.experimentUsage.modelTokens).toBeGreaterThan(
      report.experimentUsage.inputTokens + report.experimentUsage.outputTokens,
    );
    expect(evaluateWorkerLiveDecision(WORKER_LIVE_MANIFEST, report)).toMatchObject({
      status: "hold",
      checks: { perRunBudget: false, complete: false },
    });
  });

  it("keeps failed unjoined Worker attempts as evidence without counting valid Worker use", () => {
    const rows = buildRows();
    const treatment = rows[0]!.outcomes[WORKER_LIVE_TREATMENT_ARM];
    treatment.completed = false;
    treatment.failureKind = "runtime";
    treatment.quality = 0;
    treatment.workerUsed = false;
    treatment.workerRequestCount = 1;
    treatment.overlapMs = 0;
    treatment.overlapped = false;

    expect(() => buildWorkerLiveReport(
      WORKER_LIVE_MANIFEST,
      rows,
      reportOptions,
    )).not.toThrow();

    treatment.workerUsed = true;
    treatment.workerRequestCount = 0;
    expect(() => buildWorkerLiveReport(
      WORKER_LIVE_MANIFEST,
      rows,
      reportOptions,
    )).toThrow(/mechanism evidence/u);

    const control = rows[0]!.outcomes[WORKER_LIVE_CONTROL_ARM];
    control.workerRequestCount = 1;
    expect(() => buildWorkerLiveReport(
      WORKER_LIVE_MANIFEST,
      rows,
      reportOptions,
    )).toThrow(/mechanism evidence/u);
  });

  it("rejects manifest, summary, pairing, and provenance mutations", () => {
    const changedManifest = structuredClone(WORKER_LIVE_MANIFEST) as WorkerLiveManifest;
    changedManifest.model.worker = "openrouter:other/model" as typeof WORKER_LIVE_MODEL;
    changedManifest.manifestHash = hashWorkerLiveManifest(changedManifest);
    expect(() => validateWorkerLiveManifest(changedManifest)).toThrow(/frozen/);

    const changedExecution = structuredClone(WORKER_LIVE_MANIFEST) as WorkerLiveManifest;
    changedExecution.execution.allowWrite = true as false;
    changedExecution.manifestHash = hashWorkerLiveManifest(changedExecution);
    expect(() => validateWorkerLiveManifest(changedExecution)).toThrow(/frozen/);

    const changedToolContract = structuredClone(WORKER_LIVE_MANIFEST) as WorkerLiveManifest;
    Object.assign(changedToolContract.toolContract.hashes, {
      "main-worker": `sha256:${"00".repeat(32)}`,
    });
    changedToolContract.manifestHash = hashWorkerLiveManifest(changedToolContract);
    expect(() => validateWorkerLiveManifest(changedToolContract)).toThrow(/frozen/);

    const report = buildWorkerLiveReport(WORKER_LIVE_MANIFEST, buildRows(), reportOptions);
    const changedSummary = structuredClone(report);
    changedSummary.aggregates[WORKER_LIVE_TREATMENT_ARM].qualityMean -= 0.1;
    expect(() => validateWorkerLiveReport(WORKER_LIVE_MANIFEST, changedSummary))
      .toThrow(/summaries/);

    const changedPair = structuredClone(report);
    changedPair.rows[0]!.pairId = "wrong-pair";
    expect(() => validateWorkerLiveReport(WORKER_LIVE_MANIFEST, changedPair))
      .toThrow(/paired row/);

    const changedProvenance = structuredClone(report);
    changedProvenance.provenance.baselineCommit = "0".repeat(40) as typeof WORKER_LIVE_BASELINE_COMMIT;
    expect(() => validateWorkerLiveReport(WORKER_LIVE_MANIFEST, changedProvenance))
      .toThrow(/provenance/);
  });
});

function buildRows(): WorkerLivePairedRow[] {
  return WORKER_LIVE_MANIFEST.tasks.flatMap((task) => Array.from(
    { length: WORKER_LIVE_MANIFEST.repetitions },
    (_, repetition) => ({
      pairId: `${task.taskId}:${repetition}`,
      taskId: task.taskId,
      taskKind: task.kind,
      repetition,
      outcomes: {
        [WORKER_LIVE_CONTROL_ARM]: outcome(WORKER_LIVE_CONTROL_ARM, task.kind),
        [WORKER_LIVE_TREATMENT_ARM]: outcome(WORKER_LIVE_TREATMENT_ARM, task.kind),
      },
    }),
  ));
}

function outcome(armId: WorkerLiveArmId, kind: "decomposable" | "sentinel"): WorkerLiveOutcome {
  const treatment = armId === WORKER_LIVE_TREATMENT_ARM;
  const workerUsed = treatment && kind === "decomposable";
  return {
    completed: true,
    failureKind: "none",
    budgetBreached: false,
    quality: treatment ? 0.92 : 0.82,
    requestCount: treatment ? 5 : 4,
    workerRequestCount: workerUsed ? 1 : 0,
    inputTokens: treatment ? 1_200 : 900,
    outputTokens: treatment ? 140 : 120,
    cacheReadTokens: treatment ? 300 : 100,
    cacheWriteTokens: 0,
    costUsd: treatment ? 0.04 : 0.03,
    wallClockMs: treatment ? 1_800 : 3_000,
    requestP95LatencyMs: treatment ? 900 : 1_200,
    cacheReadRatio: treatment ? 0.2 : 0.1,
    workerUsed,
    overlapMs: workerUsed ? 500 : 0,
    overlapped: workerUsed,
  };
}
