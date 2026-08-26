import { describe, expect, it } from "vitest";

import {
  BOOTSTRAP_CONFIDENCE_LEVEL,
  CONTROL_ARM,
  PREREGISTERED_ARMS,
  PREREGISTERED_MANIFEST,
  PREREGISTERED_MANIFEST_HASH,
  PRIMARY_TREATMENT_ARM,
  SECONDARY_BASELINE_ARM,
  buildPairedReport,
  evaluateReleaseDecision,
  hashManifest,
  netUtility,
  pairedBootstrapCi95,
  pairedUpliftBootstrapCi95,
  validateManifest,
  validateReport,
  type PairedTaskRow,
  type PreregisteredArmId,
  type PreregisteredManifest,
  type SampleOutcome,
} from "./preregistered-contract.js";

const reportOptions = {
  evaluationId: "eval-contract-fixture",
  startedAt: "2026-08-26T00:00:00.000Z",
  completedAt: "2026-08-26T00:01:00.000Z",
  repositoryDirty: false as const,
  executionCommit: "0123456789abcdef0123456789abcdef01234567",
  evidenceDigest: `sha256:${"ab".repeat(32)}`,
};

describe("preregistered Phase 2.4 contract", () => {
  it("freezes the four arms with reflection as the primary control", () => {
    validateManifest(PREREGISTERED_MANIFEST);

    expect(PREREGISTERED_MANIFEST.arms.map((arm) => arm.id)).toEqual([
      SECONDARY_BASELINE_ARM,
      CONTROL_ARM,
      "teto-shadow",
      PRIMARY_TREATMENT_ARM,
    ]);
    expect(CONTROL_ARM).toBe("equal-budget-reflection");
    expect(PREREGISTERED_MANIFEST.repetitions).toBe(3);
    expect(PREREGISTERED_MANIFEST.sampleCount).toBe(PREREGISTERED_MANIFEST.tasks.length * PREREGISTERED_MANIFEST.repetitions);
    expect(PREREGISTERED_MANIFEST).toMatchObject({
      taskOrder: "seeded-permutation",
      armOrder: "seeded-balanced-rotation",
      retryPolicy: { runnerRetries: 0 },
    });
    expect(PREREGISTERED_MANIFEST.scoring).toMatchObject({
      scorerVersion: "phase-2.4-scorer-v3",
      utilityFormula: "quality-cost-latency-harmful-advice-rate",
      confidenceLevel: BOOTSTRAP_CONFIDENCE_LEVEL,
      bootstrapMethod: "paired-percentile",
      bootstrapUnit: "task-repetition-pair",
      bootstrapReplicates: 2_000,
    });
    expect(PREREGISTERED_MANIFEST.manifestHash).toBe(hashManifest(PREREGISTERED_MANIFEST));
    expect(PREREGISTERED_MANIFEST_HASH).toBe("sha256:4c5a5dcca5094e51008677565d2a834a5b1f78c871d0d66867b5d8f442a4e914");
    expect(PREREGISTERED_MANIFEST.provenance).toMatchObject({
      repositoryCommit: "b550a1f08763d423531721b22ca153fa07640db4",
      runnerVersion: "nausicaa-eval-runner-v2",
    });
    expect(PREREGISTERED_MANIFEST.arms.every((arm) => arm.budget.scope === "per-pair")).toBe(true);
    expect(PREREGISTERED_MANIFEST.experimentBudget).toMatchObject({
      scope: "whole-experiment",
      maxRequests: 600,
      maxCostUsd: 6,
    });
    expect(Object.isFrozen(PREREGISTERED_MANIFEST)).toBe(true);
    expect(Object.isFrozen(PREREGISTERED_MANIFEST.scoring)).toBe(true);
  });

  it("builds deterministic pair-aligned quality, cost, latency, cache, and Advice summaries", () => {
    const rows = buildRows(0.04);
    const report = buildPairedReport(PREREGISTERED_MANIFEST, rows, reportOptions);
    const expectedSamples = PREREGISTERED_MANIFEST.sampleCount;

    expect(report.rows).toHaveLength(expectedSamples);
    expect(Object.keys(report.aggregates)).toEqual([...PREREGISTERED_ARMS]);
    expect(Object.keys(report.uplifts)).toEqual(PREREGISTERED_ARMS.filter((arm) => arm !== CONTROL_ARM));
    expect(report.primaryControlArmId).toBe(CONTROL_ARM);
    expect(report.aggregates[PRIMARY_TREATMENT_ARM]?.advice).toMatchObject({
      proposed: expectedSamples,
      accepted: expectedSamples,
      unacknowledged: 0,
      acceptedRate: 1,
      harmful: 0,
      harmfulRate: 0,
    });
    expect(report.aggregates["teto-shadow"]?.advice).toMatchObject({
      proposed: expectedSamples,
      accepted: 0,
      unacknowledged: expectedSamples,
      unacknowledgedRate: 1,
    });
    expect(report.aggregates[PRIMARY_TREATMENT_ARM]?.cacheReadRatioSamples).toBe(expectedSamples);
    expect(report.aggregates[PRIMARY_TREATMENT_ARM]?.wallClockMeanMs).toBeGreaterThan(0);
    expect(report.aggregates[PRIMARY_TREATMENT_ARM]?.wallClockP95Ms).toBeGreaterThanOrEqual(
      report.aggregates[PRIMARY_TREATMENT_ARM]!.wallClockMeanMs,
    );
    expect(report.aggregates[PRIMARY_TREATMENT_ARM]?.requestP95LatencyMeanMs).toBeGreaterThan(0);
    expect(report.uplifts[PRIMARY_TREATMENT_ARM]?.pairedSamples).toBe(expectedSamples);
    expect(report.uplifts[PRIMARY_TREATMENT_ARM]?.utilityDeltaMean).toBeGreaterThan(0);
    expect(report.uplifts[PRIMARY_TREATMENT_ARM]?.qualityDeltaCi95.low).toBeGreaterThan(0);
    expect(report.uplifts[PRIMARY_TREATMENT_ARM]?.costDeltaCi95.low).toBeGreaterThan(0);
    expect(report.uplifts[PRIMARY_TREATMENT_ARM]?.wallClockDeltaCi95.low).toBeGreaterThan(0);
    expect(report.uplifts[PRIMARY_TREATMENT_ARM]?.cacheReadRatioPairedSamples).toBe(expectedSamples);

    const expectedUtility = rows.reduce((sum, row) => sum + netUtility(row.outcomes[CONTROL_ARM], PREREGISTERED_MANIFEST.scoring), 0) / rows.length;
    expect(report.aggregates[CONTROL_ARM]?.utilityMean).toBeCloseTo(expectedUtility, 12);
    expect(report.provenance).toMatchObject({ ...reportOptions, manifestHash: PREREGISTERED_MANIFEST.manifestHash });
    expect(() => validateReport(PREREGISTERED_MANIFEST, JSON.parse(JSON.stringify(report)) as unknown)).not.toThrow();
  });

  it("uses deterministic paired percentile bootstrap intervals", () => {
    const rows = buildRows(0.04);
    const options = {
      seed: PREREGISTERED_MANIFEST.seed,
      replicates: 1_000,
      confidenceLevel: BOOTSTRAP_CONFIDENCE_LEVEL,
    } as const;
    const first = pairedUpliftBootstrapCi95(rows, PRIMARY_TREATMENT_ARM, PREREGISTERED_MANIFEST.scoring, options);
    const second = pairedUpliftBootstrapCi95(rows, "teto-live", PREREGISTERED_MANIFEST.scoring, options);
    expect(first).toEqual(second);
    expect(first.low).toBeGreaterThan(0);
    expect(pairedBootstrapCi95(rows, CONTROL_ARM, PREREGISTERED_MANIFEST.scoring, options).low).toBeGreaterThan(0);
  });

  it("uses end-to-end wall clock for utility and keeps request P95 diagnostic", () => {
    const baseline = makeOutcome(CONTROL_ARM, 0, 0, 0.04);
    const slowerRequest = { ...baseline, requestP95LatencyMs: baseline.requestP95LatencyMs + 10_000 };
    const slowerSample = { ...baseline, wallClockMs: baseline.wallClockMs + 10_000 };

    expect(netUtility(slowerRequest, PREREGISTERED_MANIFEST.scoring)).toBe(
      netUtility(baseline, PREREGISTERED_MANIFEST.scoring),
    );
    expect(netUtility(slowerSample, PREREGISTERED_MANIFEST.scoring)).toBeLessThan(
      netUtility(baseline, PREREGISTERED_MANIFEST.scoring),
    );
  });

  it("holds release when live Teto fails the preregistered uplift or quality gate", () => {
    const report = buildPairedReport(PREREGISTERED_MANIFEST, buildRows(-0.04), reportOptions);
    const decision = evaluateReleaseDecision(report);
    expect(decision.status).toBe("hold");
    expect(decision.eligible).toBe(false);
    expect(decision.primaryTreatmentArmId).toBe(PRIMARY_TREATMENT_ARM);
    expect(decision.primaryCheck.utilityPass).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/teto-live/);
  });

  it("releases only when live Teto clears the CI, non-regression, and budget gates", () => {
    const report = buildPairedReport(PREREGISTERED_MANIFEST, buildRows(0.04), reportOptions);
    const decision = evaluateReleaseDecision(report);
    expect(decision.status).toBe("release");
    expect(decision.eligible).toBe(true);
    expect(decision.primaryCheck).toMatchObject({
      armId: PRIMARY_TREATMENT_ARM,
      utilityPass: true,
      qualityPass: true,
      budgetPass: true,
      completionPass: true,
    });
  });

  it("rejects JSON-boundary mutations to frozen identity, pairing, summaries, and provenance", () => {
    const rows = buildRows(0.04);
    const report = buildPairedReport(PREREGISTERED_MANIFEST, rows, reportOptions);

    const changedManifest = structuredClone(PREREGISTERED_MANIFEST) as PreregisteredManifest;
    changedManifest.model.main = "openrouter:other/model";
    expect(() => validateManifest(changedManifest)).toThrow(/frozen/);

    const changedRepetitions = structuredClone(PREREGISTERED_MANIFEST) as PreregisteredManifest;
    changedRepetitions.repetitions = 2;
    changedRepetitions.sampleCount = changedRepetitions.tasks.length * changedRepetitions.repetitions;
    changedRepetitions.manifestHash = hashManifest(changedRepetitions);
    expect(() => validateManifest(changedRepetitions)).toThrow(/sample plan/);

    const changedPair = structuredClone(report);
    changedPair.rows[0]!.pairId = "not-the-pair";
    expect(() => validateReport(PREREGISTERED_MANIFEST, changedPair)).toThrow(/deterministic/);

    const changedSummary = structuredClone(report);
    changedSummary.aggregates[CONTROL_ARM]!.costMeanUsd += 0.001;
    expect(() => validateReport(PREREGISTERED_MANIFEST, changedSummary)).toThrow(/Aggregate summary/);

    const changedProvenance = structuredClone(report);
    changedProvenance.provenance.repositoryCommit = "0000000000000000000000000000000000000000";
    expect(() => validateReport(PREREGISTERED_MANIFEST, changedProvenance)).toThrow(/provenance/);

    const changedExecutionCommit = structuredClone(report);
    changedExecutionCommit.provenance.executionCommit = "not-a-commit";
    expect(() => validateReport(PREREGISTERED_MANIFEST, changedExecutionCommit)).toThrow(/provenance/);

    const changedEvidence = structuredClone(report);
    changedEvidence.provenance.evidenceDigest = "sha256:not-evidence";
    expect(() => validateReport(PREREGISTERED_MANIFEST, changedEvidence)).toThrow(/provenance/);
  });

  it("rejects incomplete, duplicate, over-budget, and invalid Advice outcomes", () => {
    const rows = buildRows(0.04);
    const duplicateRows = rows.slice(0, -1).concat(rows[0]!);
    expect(() => buildPairedReport(PREREGISTERED_MANIFEST, duplicateRows, reportOptions)).toThrow(/Duplicate paired task row/);

    const overBudget = structuredClone(rows);
    overBudget[0]!.outcomes[SECONDARY_BASELINE_ARM]!.auxiliaryRequestCount = 1;
    expect(() => buildPairedReport(PREREGISTERED_MANIFEST, overBudget, reportOptions)).toThrow(/without breach evidence/);

    const invalidAdvice = structuredClone(rows);
    invalidAdvice[0]!.outcomes[PRIMARY_TREATMENT_ARM]!.advice.harmful = 2;
    expect(() => buildPairedReport(PREREGISTERED_MANIFEST, invalidAdvice, reportOptions)).toThrow(/Advice counts/);
  });

  it("keeps an auditable over-budget outcome in the report and holds release", () => {
    const rows = buildRows(0.04);
    const outcome = rows[0]!.outcomes[PRIMARY_TREATMENT_ARM]!;
    outcome.completed = false;
    outcome.failureKind = "budget";
    outcome.budgetBreached = true;
    outcome.quality = 0;
    outcome.requestCount = PREREGISTERED_MANIFEST.arms.find((arm) => arm.id === PRIMARY_TREATMENT_ARM)!.budget.maxRequests + 1;

    const report = buildPairedReport(PREREGISTERED_MANIFEST, rows, reportOptions);
    expect(report.rows[0]!.outcomes[PRIMARY_TREATMENT_ARM]).toMatchObject({
      completed: false,
      failureKind: "budget",
      budgetBreached: true,
      quality: 0,
    });
    expect(report.aggregates[PRIMARY_TREATMENT_ARM]?.budgetBreachRate).toBeGreaterThan(0);
    expect(evaluateReleaseDecision(report)).toMatchObject({
      status: "hold",
      eligible: false,
      primaryCheck: { budgetPass: false, completionPass: false },
    });
  });

  it("accepts live Advice that is still pending acknowledgement", () => {
    const rows = buildRows(0.04);
    const advice = rows[0]!.outcomes[PRIMARY_TREATMENT_ARM]!.advice;
    advice.accepted = 0;
    advice.unacknowledged = 1;

    const report = buildPairedReport(PREREGISTERED_MANIFEST, rows, reportOptions);
    expect(report.aggregates[PRIMARY_TREATMENT_ARM]?.advice).toMatchObject({
      proposed: PREREGISTERED_MANIFEST.sampleCount,
      accepted: PREREGISTERED_MANIFEST.sampleCount - 1,
      unacknowledged: 1,
    });
    expect(() => validateReport(PREREGISTERED_MANIFEST, structuredClone(report))).not.toThrow();
  });
});

function buildRows(liveQualityDelta: number): PairedTaskRow[] {
  return PREREGISTERED_MANIFEST.tasks.flatMap((task, taskIndex) =>
    Array.from({ length: PREREGISTERED_MANIFEST.repetitions }, (_, repetition) => {
      const outcomes = Object.fromEntries(PREREGISTERED_ARMS.map((armId) => [
        armId,
        makeOutcome(armId, taskIndex, repetition, liveQualityDelta),
      ])) as Record<PreregisteredArmId, SampleOutcome>;
      return {
        pairId: `${task.taskId}:${repetition}`,
        taskId: task.taskId,
        repetition,
        outcomes,
      };
    }),
  );
}

function makeOutcome(armId: PreregisteredArmId, taskIndex: number, repetition: number, liveQualityDelta: number): SampleOutcome {
  const isLive = armId === PRIMARY_TREATMENT_ARM;
  const isTeto = armId === "teto-shadow" || isLive;
  const isReflection = armId === CONTROL_ARM;
  const armIndex = PREREGISTERED_ARMS.indexOf(armId);
  return {
    completed: true,
    failureKind: "none",
    budgetBreached: false,
    quality: Math.max(0, Math.min(1, 0.65 + taskIndex * 0.01 + repetition * 0.005 + (isReflection ? 0.01 : 0) + (isLive ? liveQualityDelta : isTeto ? 0.02 : 0))),
    requestCount: isTeto || isReflection ? 3 : 2,
    auxiliaryRequestCount: isTeto || isReflection ? 1 : 0,
    inputTokens: 900 + armIndex * 25,
    outputTokens: 120 + armIndex * 10,
    costUsd: 0.01 + armIndex * 0.001,
    wallClockMs: 500 + taskIndex * 20 + repetition * 5 + armIndex * 20,
    requestP95LatencyMs: 450 + armIndex * 10,
    cacheReadRatio: 0.4 + repetition * 0.02,
    advice: {
      proposed: isTeto ? 1 : 0,
      accepted: isLive ? 1 : 0,
      deferred: 0,
      rejected: 0,
      unacknowledged: armId === "teto-shadow" ? 1 : 0,
      harmful: 0,
    },
  };
}
