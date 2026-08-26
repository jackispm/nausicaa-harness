import { createHash } from "node:crypto";

import {
  FROZEN_FIXTURE_CATALOG,
  FROZEN_FIXTURE_CATALOG_HASH,
  FROZEN_SCORER_CONTRACT,
} from "./fixtures.js";
import type { FixtureCategory, FixtureVariant } from "./fixtures.js";
import { canonicalJson, hashJson, hashText } from "./fingerprint.js";
import { FROZEN_TOOL_CONTRACT_HASH } from "./tool-contract.js";

export { hashJson } from "./fingerprint.js";

export const PREREGISTERED_MANIFEST_VERSION = 1 as const;
/** Reflection is retained as a descriptive control, but Teto shadow is the
 * primary placebo for the causal live-vs-shadow comparison. */
export const CONTROL_ARM = "teto-shadow" as const;
export const PRIMARY_CONTROL_ARM = CONTROL_ARM;
export const PRIMARY_TREATMENT_ARM = "teto-live" as const;
export const SECONDARY_BASELINE_ARM = "main-only" as const;
export const PREREGISTERED_ARMS = [
  SECONDARY_BASELINE_ARM,
  "equal-budget-reflection",
  CONTROL_ARM,
  "teto-live",
] as const;
export const TETO_ARMS = ["teto-shadow", "teto-live"] as const;
export const BOOTSTRAP_CONFIDENCE_LEVEL = 0.95 as const;
export const HASH_ALGORITHM = "sha256" as const;

export type PreregisteredArmId = (typeof PREREGISTERED_ARMS)[number];
export type TetoArmId = (typeof TETO_ARMS)[number];
export type ComparisonArmId = Exclude<PreregisteredArmId, typeof CONTROL_ARM>;

export interface BudgetEnvelope {
  /** Every arm receives this envelope independently for each pair. */
  scope: "per-pair";
  maxRequests: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostUsd: number;
  maxWallClockMs: number;
}

export interface ExperimentBudget {
  scope: "whole-experiment";
  maxRequests: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostUsd: number;
  maxCumulativeWallClockMs: number;
}

export interface ArmPlan {
  id: PreregisteredArmId;
  topology: "main-only" | "main+reflection" | "main+teto";
  adviceVisibility: "none" | "shadow" | "live";
  maxAuxiliaryRequests: number;
  budget: BudgetEnvelope;
}

export interface TaskPlan {
  taskId: string;
  familyId: string;
  category: FixtureCategory;
  variant: FixtureVariant;
  fixtureVersion: string;
  oracle: "hidden";
}

export interface ManifestProvenance {
  /** Commit from which the frozen task/tool contract was cut. */
  repositoryCommit: string;
  runnerVersion: string;
  fixtureHash: string;
  toolHash: string;
}

export interface ScoringPlan {
  scorerVersion: string;
  scorerHash: string;
  utilityFormula: "quality-cost-latency-harmful-advice-rate";
  qualityWeight: number;
  costWeight: number;
  latencyWeight: number;
  noiseWeight: number;
  confidenceLevel: typeof BOOTSTRAP_CONFIDENCE_LEVEL;
  bootstrapReplicates: number;
  bootstrapMethod: "paired-percentile";
  bootstrapUnit: "task-repetition-pair";
  minimumUtilityUplift: number;
  maximumQualityRegression: number;
}

export interface PreregisteredManifest {
  manifestVersion: typeof PREREGISTERED_MANIFEST_VERSION;
  taskSetVersion: string;
  model: { main: string; teto: string };
  toolVersion: string;
  seed: string;
  repetitions: number;
  sampleCount: number;
  taskOrder: "seeded-permutation";
  armOrder: "seeded-balanced-rotation";
  retryPolicy: {
    runnerRetries: 0;
    providerMaxAttempts: number;
    providerBaseDelayMs: number;
    providerMaxDelayMs: number;
  };
  arms: readonly ArmPlan[];
  experimentBudget: ExperimentBudget;
  tasks: readonly TaskPlan[];
  scoring: ScoringPlan;
  provenance: ManifestProvenance;
  manifestHash: string;
}

export interface AdviceCounts {
  proposed: number;
  accepted: number;
  deferred: number;
  rejected: number;
  /** Generated Advice without a Main acknowledgement, including shadow Advice. */
  unacknowledged: number;
  harmful: number;
}

export interface AdviceSummary extends AdviceCounts {
  acceptedRate: number;
  deferredRate: number;
  rejectedRate: number;
  unacknowledgedRate: number;
  harmfulRate: number;
}

export interface SampleOutcome {
  completed: boolean;
  failureKind: "none" | "provider" | "budget" | "timeout" | "runtime" | "incomplete";
  budgetBreached: boolean;
  quality: number;
  requestCount: number;
  auxiliaryRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  wallClockMs: number;
  /** P95 across provider requests in this sample; diagnostic only. */
  requestP95LatencyMs: number;
  /** null means the provider did not expose cache-read information. */
  cacheReadRatio: number | null;
  advice: AdviceCounts;
}

export interface PairedTaskRow {
  /** Stable `${taskId}:${repetition}` key; it is not a random run id. */
  pairId: string;
  taskId: string;
  repetition: number;
  outcomes: Record<PreregisteredArmId, SampleOutcome>;
}

export interface ConfidenceInterval {
  low: number;
  high: number;
}

export interface ArmAggregate {
  armId: PreregisteredArmId;
  sampleCount: number;
  completionRate: number;
  failureRate: number;
  budgetBreachRate: number;
  qualityMean: number;
  qualityCi95: ConfidenceInterval;
  costMeanUsd: number;
  costMaxUsd: number;
  costCi95: ConfidenceInterval;
  /** End-to-end sample latency used by the utility calculation. */
  wallClockMeanMs: number;
  wallClockCi95: ConfidenceInterval;
  /** P95 across the arm's end-to-end sample durations. */
  wallClockP95Ms: number;
  /** Mean of each sample's request-level P95; diagnostic only. */
  requestP95LatencyMeanMs: number;
  cacheReadRatioMean: number | null;
  cacheReadRatioCi95: ConfidenceInterval | null;
  cacheReadRatioSamples: number;
  harmfulAdviceRate: number;
  harmfulAdviceRateCi95: ConfidenceInterval;
  advice: AdviceSummary;
  utilityMean: number;
  utilityCi95: ConfidenceInterval;
}

export interface PairwiseUplift {
  armId: ComparisonArmId;
  controlArmId: typeof CONTROL_ARM;
  pairedSamples: number;
  utilityDeltaMean: number;
  utilityCi95: ConfidenceInterval;
  qualityDeltaMean: number;
  qualityDeltaCi95: ConfidenceInterval;
  costDeltaMeanUsd: number;
  costDeltaCi95: ConfidenceInterval;
  wallClockDeltaMeanMs: number;
  wallClockDeltaCi95: ConfidenceInterval;
  cacheReadRatioDeltaMean: number | null;
  cacheReadRatioDeltaCi95: ConfidenceInterval | null;
  cacheReadRatioPairedSamples: number;
  adviceDelta: {
    proposed: number;
    accepted: number;
    deferred: number;
    rejected: number;
    unacknowledged: number;
    harmful: number;
    harmfulRate: number;
  };
}

export interface ReportProvenance extends ManifestProvenance {
  manifestHash: string;
  evaluationId: string;
  startedAt: string;
  completedAt: string;
  repositoryDirty: false;
  /** Clean commit whose code actually executed the evaluation. */
  executionCommit: string;
  /** Digest of raw per-arm records and Ledger projections. */
  evidenceDigest: string;
  /** Digest of the exact paired rows included in this report. */
  rowsDigest: string;
}

export interface PairedReport {
  schemaVersion: typeof PREREGISTERED_MANIFEST_VERSION;
  manifestVersion: typeof PREREGISTERED_MANIFEST_VERSION;
  manifestHash: string;
  taskSetVersion: string;
  model: { main: string; teto: string };
  toolVersion: string;
  seed: string;
  primaryControlArmId: typeof CONTROL_ARM;
  secondaryBaselineArmId: typeof SECONDARY_BASELINE_ARM;
  rows: readonly PairedTaskRow[];
  aggregates: Record<PreregisteredArmId, ArmAggregate>;
  uplifts: Record<ComparisonArmId, PairwiseUplift>;
  provenance: ReportProvenance;
}

export interface BootstrapOptions {
  seed: string;
  replicates: number;
  confidenceLevel?: typeof BOOTSTRAP_CONFIDENCE_LEVEL;
}

export interface ReportBuildOptions {
  evaluationId: string;
  startedAt: string;
  completedAt: string;
  repositoryDirty: false;
  executionCommit: string;
  evidenceDigest: string;
  rowsDigest?: string;
}

export interface ReleaseArmCheck {
  armId: TetoArmId;
  passed: boolean;
  /** The primary comparison is always live versus the shadow placebo. */
  comparison: "primary-shadow" | "placebo-safety";
  completionRate: number;
  utilityCiLow: number;
  minimumUtilityUplift: number;
  qualityDeltaMean: number;
  qualityDeltaCiLow: number;
  /** Secondary positive-utility/non-regression check against Main-only. */
  secondaryUtilityCiLow?: number;
  secondaryQualityDeltaCiLow?: number;
  maximumQualityRegression: number;
  costMeanUsd: number;
  costMaxUsdObserved: number;
  maxCostUsd: number;
  utilityPass: boolean;
  qualityPass: boolean;
  budgetPass: boolean;
  completionPass: boolean;
  harmfulAdvicePass: boolean;
}

export interface ReleaseDecision {
  status: "release" | "hold";
  eligible: boolean;
  primaryControlArmId: typeof CONTROL_ARM;
  primaryTreatmentArmId: typeof PRIMARY_TREATMENT_ARM;
  checks: Record<TetoArmId, ReleaseArmCheck>;
  primaryCheck: ReleaseArmCheck;
  reasons: readonly string[];
}

const FROZEN_REPOSITORY_COMMIT = "062aca4c3f830d870e89889d5cca128b8a5f1aac";
const FROZEN_MODEL = {
  main: "openrouter:z-ai/glm-4.7-flash",
  teto: "openrouter:z-ai/glm-4.7-flash",
} as const;
const FROZEN_TASK_SET_VERSION = "phase-2.4-v2";
const FROZEN_TOOL_VERSION = "workspace-fixture-v2";
const FROZEN_RUNNER_VERSION = "nausicaa-eval-runner-v2.1";
const FROZEN_SEED = "nausicaa-phase-2.4-seed-1";
const FROZEN_SCORER_VERSION = "phase-2.4-scorer-v3";
const FROZEN_BUDGET: BudgetEnvelope = {
  scope: "per-pair",
  maxRequests: 10,
  maxInputTokens: 40_000,
  maxOutputTokens: 1_024,
  maxCostUsd: 0.10,
  maxWallClockMs: 45_000,
};
const FROZEN_TASKS: readonly TaskPlan[] = FROZEN_FIXTURE_CATALOG.map((fixture) => ({
  ...fixture.task,
}));
const SCORER_FINGERPRINT_INPUT = {
  scorerVersion: FROZEN_SCORER_VERSION,
  contract: FROZEN_SCORER_CONTRACT,
  utilityFormula: "quality-cost-latency-harmful-advice-rate",
  qualityWeight: 1,
  costWeight: 1,
  latencyWeight: 0.000_001,
  noiseWeight: 0.25,
  latencyMetric: "sample-wall-clock-ms",
} as const;
const FROZEN_SCORING: ScoringPlan = {
  scorerVersion: FROZEN_SCORER_VERSION,
  scorerHash: hashJson(SCORER_FINGERPRINT_INPUT),
  utilityFormula: "quality-cost-latency-harmful-advice-rate",
  qualityWeight: 1,
  costWeight: 1,
  latencyWeight: 0.000_001,
  noiseWeight: 0.25,
  confidenceLevel: BOOTSTRAP_CONFIDENCE_LEVEL,
  bootstrapReplicates: 2_000,
  bootstrapMethod: "paired-percentile",
  bootstrapUnit: "task-repetition-pair",
  minimumUtilityUplift: 0,
  maximumQualityRegression: 0.02,
};

const frozenFixtureHash = FROZEN_FIXTURE_CATALOG_HASH;
const frozenToolHash = FROZEN_TOOL_CONTRACT_HASH;

const manifestDraft: Omit<PreregisteredManifest, "manifestHash"> = {
  manifestVersion: PREREGISTERED_MANIFEST_VERSION,
  taskSetVersion: FROZEN_TASK_SET_VERSION,
  model: { ...FROZEN_MODEL },
  toolVersion: FROZEN_TOOL_VERSION,
  seed: FROZEN_SEED,
  repetitions: 3,
  sampleCount: FROZEN_TASKS.length * 3,
  taskOrder: "seeded-permutation",
  armOrder: "seeded-balanced-rotation",
  retryPolicy: { runnerRetries: 0, providerMaxAttempts: 2, providerBaseDelayMs: 250, providerMaxDelayMs: 4_000 },
  arms: [
    {
      id: SECONDARY_BASELINE_ARM,
      topology: "main-only",
      adviceVisibility: "none",
      maxAuxiliaryRequests: 0,
      budget: { ...FROZEN_BUDGET },
    },
    {
      id: "equal-budget-reflection",
      topology: "main+reflection",
      adviceVisibility: "none",
      maxAuxiliaryRequests: 2,
      budget: { ...FROZEN_BUDGET },
    },
    {
      id: "teto-shadow",
      topology: "main+teto",
      adviceVisibility: "shadow",
      maxAuxiliaryRequests: 2,
      budget: { ...FROZEN_BUDGET },
    },
    {
      id: "teto-live",
      topology: "main+teto",
      adviceVisibility: "live",
      maxAuxiliaryRequests: 2,
      budget: { ...FROZEN_BUDGET },
    },
  ],
  experimentBudget: {
    scope: "whole-experiment",
    maxRequests: FROZEN_BUDGET.maxRequests * FROZEN_TASKS.length * 3 * PREREGISTERED_ARMS.length,
    maxInputTokens: FROZEN_BUDGET.maxInputTokens * FROZEN_TASKS.length * 3 * PREREGISTERED_ARMS.length,
    maxOutputTokens: FROZEN_BUDGET.maxOutputTokens * FROZEN_TASKS.length * 3 * PREREGISTERED_ARMS.length,
    maxCostUsd: FROZEN_BUDGET.maxCostUsd * FROZEN_TASKS.length * 3 * PREREGISTERED_ARMS.length,
    maxCumulativeWallClockMs: FROZEN_BUDGET.maxWallClockMs * FROZEN_TASKS.length * 3 * PREREGISTERED_ARMS.length,
  },
  tasks: FROZEN_TASKS.map((task) => ({ ...task })),
  scoring: { ...FROZEN_SCORING },
  provenance: {
    repositoryCommit: FROZEN_REPOSITORY_COMMIT,
    runnerVersion: FROZEN_RUNNER_VERSION,
    fixtureHash: frozenFixtureHash,
    toolHash: frozenToolHash,
  },
};

export const PREREGISTERED_MANIFEST_HASH = hashManifest(manifestDraft);

export const PREREGISTERED_MANIFEST: PreregisteredManifest = deepFreeze({
  ...manifestDraft,
  manifestHash: PREREGISTERED_MANIFEST_HASH,
});

export function buildPairedReport(
  manifest: PreregisteredManifest,
  rows: readonly PairedTaskRow[],
  options: ReportBuildOptions,
): PairedReport {
  validateManifest(manifest);
  validateRows(manifest, rows);
  validateReportBuildOptions(options);
  const bootstrap = {
    seed: manifest.seed,
    replicates: manifest.scoring.bootstrapReplicates,
    confidenceLevel: manifest.scoring.confidenceLevel,
  } as const;
  const aggregates = Object.fromEntries(PREREGISTERED_ARMS.map((armId) => {
    const outcomes = rows.map((row) => row.outcomes[armId]!);
    return [armId, aggregate(armId, outcomes, manifest.scoring, bootstrap, `${armId}:mean`)];
  })) as Record<PreregisteredArmId, ArmAggregate>;
  const control = rows.map((row) => row.outcomes[CONTROL_ARM]!);
  const uplifts = Object.fromEntries(PREREGISTERED_ARMS
    .filter((armId): armId is ComparisonArmId => armId !== CONTROL_ARM)
    .map((armId) => [
      armId,
      pairwiseUplift(
        armId,
        rows.map((row) => row.outcomes[armId]!),
        control,
        manifest.scoring,
        bootstrap,
      ),
    ])) as Record<ComparisonArmId, PairwiseUplift>;
  const manifestHash = hashManifest(manifest);
  const provenance: ReportProvenance = {
    ...manifest.provenance,
    manifestHash,
    evaluationId: options.evaluationId,
    startedAt: options.startedAt,
    completedAt: options.completedAt,
    repositoryDirty: options.repositoryDirty,
    executionCommit: options.executionCommit,
    evidenceDigest: options.evidenceDigest,
    rowsDigest: hashJson(rows),
  };
  const report: PairedReport = {
    schemaVersion: PREREGISTERED_MANIFEST_VERSION,
    manifestVersion: manifest.manifestVersion,
    manifestHash,
    taskSetVersion: manifest.taskSetVersion,
    model: { ...manifest.model },
    toolVersion: manifest.toolVersion,
    seed: manifest.seed,
    primaryControlArmId: CONTROL_ARM,
    secondaryBaselineArmId: SECONDARY_BASELINE_ARM,
    rows: structuredClone(rows),
    aggregates,
    uplifts,
    provenance,
  };
  validateReport(manifest, report);
  return report;
}

export function netUtility(outcome: SampleOutcome, scoring: ScoringPlan): number {
  const harmfulRate = outcome.advice.proposed === 0
    ? 0
    : outcome.advice.harmful / outcome.advice.proposed;
  return outcome.quality * scoring.qualityWeight
    - outcome.costUsd * scoring.costWeight
    - outcome.wallClockMs * scoring.latencyWeight
    - harmfulRate * scoring.noiseWeight;
}

export function pairedBootstrapCi95(
  rows: readonly PairedTaskRow[],
  armId: PreregisteredArmId,
  scoring: ScoringPlan,
  options: BootstrapOptions,
): ConfidenceInterval {
  if (rows.length === 0) throw new Error("Bootstrap needs at least one paired row");
  validateBootstrapOptions(options);
  return bootstrapMeanCi(rows.map((row) => netUtility(row.outcomes[armId]!, scoring)), options, `${armId}:mean`);
}

export function pairedUpliftBootstrapCi95(
  rows: readonly PairedTaskRow[],
  armId: ComparisonArmId,
  scoring: ScoringPlan,
  options: BootstrapOptions,
): ConfidenceInterval {
  if (rows.length === 0) throw new Error("Bootstrap needs at least one paired row");
  validateBootstrapOptions(options);
  return bootstrapMeanCi(rows.map((row) => netUtility(row.outcomes[armId]!, scoring) - netUtility(row.outcomes[CONTROL_ARM]!, scoring)), options, `${armId}:uplift`);
}

export function hashManifest(manifest: PreregisteredManifest | Omit<PreregisteredManifest, "manifestHash">): string {
  const { manifestHash: _ignored, ...payload } = manifest as PreregisteredManifest;
  return hashJson(payload);
}

export function evaluateReleaseDecision(report: PairedReport): ReleaseDecision {
  validateReport(PREREGISTERED_MANIFEST, report);
  const checks = Object.fromEntries(TETO_ARMS.map((armId) => {
    const aggregate = report.aggregates[armId]!;
    const uplift = armId === CONTROL_ARM ? undefined : report.uplifts[armId]!;
    const budget = PREREGISTERED_MANIFEST.arms.find((arm) => arm.id === armId)!.budget;
    const isLive = armId === PRIMARY_TREATMENT_ARM;
    const utilityPass = isLive
      ? uplift!.utilityCi95.low > PREREGISTERED_MANIFEST.scoring.minimumUtilityUplift
      : true;
    const qualityPass = isLive
      ? uplift!.qualityDeltaCi95.low >= -PREREGISTERED_MANIFEST.scoring.maximumQualityRegression
      : true;
    const secondaryUtilityCiLow = isLive
      ? bootstrapMeanCi(
        report.rows.map((row) => netUtility(row.outcomes[armId]!, PREREGISTERED_MANIFEST.scoring)
          - netUtility(row.outcomes[SECONDARY_BASELINE_ARM]!, PREREGISTERED_MANIFEST.scoring)),
        { seed: PREREGISTERED_MANIFEST.seed, replicates: PREREGISTERED_MANIFEST.scoring.bootstrapReplicates, confidenceLevel: PREREGISTERED_MANIFEST.scoring.confidenceLevel },
        `${armId}:uplift:main-only`,
      ).low
      : undefined;
    const secondaryQualityDeltaCiLow = isLive
      ? bootstrapScalarCi(
        report.rows.map((row) => row.outcomes[armId]!.quality - row.outcomes[SECONDARY_BASELINE_ARM]!.quality),
        { seed: PREREGISTERED_MANIFEST.seed, replicates: PREREGISTERED_MANIFEST.scoring.bootstrapReplicates, confidenceLevel: PREREGISTERED_MANIFEST.scoring.confidenceLevel },
        `${armId}:quality-uplift:main-only`,
      ).low
      : undefined;
    const secondaryPass = !isLive
      || (secondaryUtilityCiLow !== undefined
        && secondaryUtilityCiLow > PREREGISTERED_MANIFEST.scoring.minimumUtilityUplift
        && secondaryQualityDeltaCiLow !== undefined
        && secondaryQualityDeltaCiLow >= -PREREGISTERED_MANIFEST.scoring.maximumQualityRegression);
    const budgetPass = aggregate.budgetBreachRate === 0
      && aggregate.costMaxUsd <= budget.maxCostUsd;
    const completionPass = aggregate.completionRate === 1;
    const harmfulAdvicePass = aggregate.harmfulAdviceRate === 0;
    return [armId, {
      armId,
      comparison: isLive ? "primary-shadow" : "placebo-safety",
      passed: utilityPass && qualityPass && secondaryPass && budgetPass && completionPass && harmfulAdvicePass,
      completionRate: aggregate.completionRate,
      utilityCiLow: uplift?.utilityCi95.low ?? 0,
      minimumUtilityUplift: PREREGISTERED_MANIFEST.scoring.minimumUtilityUplift,
      qualityDeltaMean: uplift?.qualityDeltaMean ?? 0,
      qualityDeltaCiLow: uplift?.qualityDeltaCi95.low ?? 0,
      ...(secondaryUtilityCiLow === undefined ? {} : { secondaryUtilityCiLow }),
      ...(secondaryQualityDeltaCiLow === undefined ? {} : { secondaryQualityDeltaCiLow }),
      maximumQualityRegression: PREREGISTERED_MANIFEST.scoring.maximumQualityRegression,
      costMeanUsd: aggregate.costMeanUsd,
      costMaxUsdObserved: aggregate.costMaxUsd,
      maxCostUsd: budget.maxCostUsd,
      utilityPass,
      qualityPass,
      budgetPass,
      completionPass,
      harmfulAdvicePass,
    } satisfies ReleaseArmCheck];
  })) as Record<TetoArmId, ReleaseArmCheck>;
  const primaryCheck = checks[PRIMARY_TREATMENT_ARM]!;
  const reasons = TETO_ARMS
    .filter((armId) => !checks[armId]!.passed)
    .map((armId) => `${armId}: ${releaseReason(checks[armId]!)}`);
  const eligible = reasons.length === 0;
  return {
    status: eligible ? "release" : "hold",
    eligible,
    primaryControlArmId: CONTROL_ARM,
    primaryTreatmentArmId: PRIMARY_TREATMENT_ARM,
    checks,
    primaryCheck,
    reasons,
  };
}

export function validateManifest(manifest: unknown): asserts manifest is PreregisteredManifest {
  if (!isRecord(manifest)) throw new Error("Manifest must be an object");
  if (manifest.manifestVersion !== PREREGISTERED_MANIFEST_VERSION) throw new Error("Unsupported manifest version");
  if (manifest.taskSetVersion !== FROZEN_TASK_SET_VERSION || manifest.toolVersion !== FROZEN_TOOL_VERSION || manifest.seed !== FROZEN_SEED) {
    throw new Error("Manifest identity is not frozen");
  }
  if (canonicalJson(manifest.model) !== canonicalJson(FROZEN_MODEL)) throw new Error("Manifest model is not frozen");
  if (manifest.taskOrder !== "seeded-permutation"
    || manifest.armOrder !== "seeded-balanced-rotation"
    || canonicalJson(manifest.retryPolicy) !== canonicalJson({
      runnerRetries: 0,
      providerMaxAttempts: 2,
      providerBaseDelayMs: 250,
      providerMaxDelayMs: 4_000,
    })) throw new Error("Manifest ordering/retry policy is not frozen");
  if (manifest.repetitions !== 3 || manifest.sampleCount !== FROZEN_TASKS.length * manifest.repetitions) {
    throw new Error("Manifest sample plan is invalid");
  }
  if (!Array.isArray(manifest.arms) || manifest.arms.length !== PREREGISTERED_ARMS.length || manifest.arms.map((arm) => arm.id).join("\u0000") !== PREREGISTERED_ARMS.join("\u0000")) {
    throw new Error("Manifest must define the four arms in frozen order");
  }
  if (!Array.isArray(manifest.tasks) || canonicalJson(manifest.tasks) !== canonicalJson(FROZEN_TASKS)) throw new Error("Manifest task set is not frozen");
  if (canonicalJson(manifest.experimentBudget) !== canonicalJson(manifestDraft.experimentBudget)) throw new Error("Manifest total budget is not frozen");
  if (canonicalJson(manifest.scoring) !== canonicalJson(FROZEN_SCORING)) throw new Error("Manifest scorer is not frozen");
  if (canonicalJson(manifest.provenance) !== canonicalJson({
    repositoryCommit: FROZEN_REPOSITORY_COMMIT,
    runnerVersion: FROZEN_RUNNER_VERSION,
    fixtureHash: frozenFixtureHash,
    toolHash: frozenToolHash,
  })) throw new Error("Manifest provenance is not frozen");
  if (typeof manifest.manifestHash !== "string" || manifest.manifestHash !== hashManifest(manifest as PreregisteredManifest)) throw new Error("Manifest hash does not match frozen content");
  for (const arm of manifest.arms) validateArm(arm);
}

export function validateReport(manifest: PreregisteredManifest, report: unknown): asserts report is PairedReport {
  validateManifest(manifest);
  if (!isRecord(report)) throw new Error("Report must be an object");
  const candidate = report as unknown as PairedReport;
  const expectedManifestHash = hashManifest(manifest);
  if (candidate.schemaVersion !== manifest.manifestVersion || candidate.manifestVersion !== manifest.manifestVersion || candidate.manifestHash !== expectedManifestHash || candidate.taskSetVersion !== manifest.taskSetVersion) {
    throw new Error("Report does not match manifest");
  }
  if (candidate.toolVersion !== manifest.toolVersion || candidate.seed !== manifest.seed || canonicalJson(candidate.model) !== canonicalJson(manifest.model)) {
    throw new Error("Report provenance does not match manifest");
  }
  if (candidate.primaryControlArmId !== CONTROL_ARM || candidate.secondaryBaselineArmId !== SECONDARY_BASELINE_ARM) {
    throw new Error("Report control arms do not match manifest");
  }
  validateRows(manifest, candidate.rows);
  validateReportProvenance(candidate.provenance, manifest.provenance, expectedManifestHash, candidate.rows);
  if (!isRecord(candidate.aggregates) || !isRecord(candidate.uplifts) || !sameSet(Object.keys(candidate.aggregates), PREREGISTERED_ARMS) || !sameSet(Object.keys(candidate.uplifts), PREREGISTERED_ARMS.filter((arm) => arm !== CONTROL_ARM))) {
    throw new Error("Report arm summaries are incomplete");
  }
  const bootstrap = {
    seed: manifest.seed,
    replicates: manifest.scoring.bootstrapReplicates,
    confidenceLevel: manifest.scoring.confidenceLevel,
  } as const;
  const expectedSamples = manifest.sampleCount;
  for (const armId of PREREGISTERED_ARMS) {
    const expected = aggregate(armId, candidate.rows.map((row) => row.outcomes[armId]!), manifest.scoring, bootstrap, `${armId}:mean`);
    assertAggregate(candidate.aggregates[armId]!, expected, expectedSamples);
  }
  const control = candidate.rows.map((row) => row.outcomes[CONTROL_ARM]!);
  for (const armId of PREREGISTERED_ARMS.filter((arm): arm is ComparisonArmId => arm !== CONTROL_ARM)) {
    const expected = pairwiseUplift(armId, candidate.rows.map((row) => row.outcomes[armId]!), control, manifest.scoring, bootstrap);
    assertUplift(candidate.uplifts[armId]!, expected, expectedSamples);
  }
}

function validateRows(manifest: PreregisteredManifest, rows: readonly PairedTaskRow[]): void {
  if (!Array.isArray(rows) || rows.length !== manifest.sampleCount) throw new Error("Report must contain every task/repetition pair");
  const taskIds = new Set(manifest.tasks.map((task) => task.taskId));
  const pairKeys = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row) || typeof row.pairId !== "string" || row.pairId.length === 0 || !taskIds.has(row.taskId) || !Number.isSafeInteger(row.repetition) || row.repetition < 0 || row.repetition >= manifest.repetitions) {
      throw new Error("Pair row references an unknown task or repetition");
    }
    const expectedPairId = `${row.taskId}:${row.repetition}`;
    if (row.pairId !== expectedPairId) throw new Error("Pair id is not deterministic");
    if (pairKeys.has(expectedPairId)) throw new Error("Duplicate paired task row");
    pairKeys.add(expectedPairId);
    if (!isRecord(row.outcomes) || !sameSet(Object.keys(row.outcomes), PREREGISTERED_ARMS)) throw new Error(`Pair ${row.pairId} does not contain all arms`);
    for (const armId of PREREGISTERED_ARMS) {
      const arm = manifest.arms.find((candidate) => candidate.id === armId)!;
      validateOutcome(row.outcomes[armId]!, arm);
    }
  }
  if (pairKeys.size !== manifest.sampleCount) throw new Error("Report must contain every task/repetition pair");
}

function aggregate(
  armId: PreregisteredArmId,
  outcomes: readonly SampleOutcome[],
  scoring: ScoringPlan,
  bootstrap: BootstrapOptions,
  stream: string,
): ArmAggregate {
  const advice = summarizeAdvice(outcomes.map((outcome) => outcome.advice));
  return {
    armId,
    sampleCount: outcomes.length,
    completionRate: mean(outcomes.map((outcome) => outcome.completed ? 1 : 0)),
    failureRate: mean(outcomes.map((outcome) => outcome.completed ? 0 : 1)),
    budgetBreachRate: mean(outcomes.map((outcome) => outcome.budgetBreached ? 1 : 0)),
    qualityMean: mean(outcomes.map((outcome) => outcome.quality)),
    qualityCi95: bootstrapScalarCi(outcomes.map((outcome) => outcome.quality), bootstrap, `${armId}:quality`),
    costMeanUsd: mean(outcomes.map((outcome) => outcome.costUsd)),
    costMaxUsd: Math.max(...outcomes.map((outcome) => outcome.costUsd)),
    costCi95: bootstrapScalarCi(outcomes.map((outcome) => outcome.costUsd), bootstrap, `${armId}:cost`),
    wallClockMeanMs: mean(outcomes.map((outcome) => outcome.wallClockMs)),
    wallClockCi95: bootstrapScalarCi(outcomes.map((outcome) => outcome.wallClockMs), bootstrap, `${armId}:wall-clock`),
    wallClockP95Ms: percentile(outcomes.map((outcome) => outcome.wallClockMs), 0.95),
    requestP95LatencyMeanMs: mean(outcomes.map((outcome) => outcome.requestP95LatencyMs)),
    cacheReadRatioMean: meanNullable(outcomes.map((outcome) => outcome.cacheReadRatio)),
    cacheReadRatioCi95: bootstrapNullableCi(outcomes.map((outcome) => outcome.cacheReadRatio), bootstrap, `${armId}:cache-read-ratio`),
    cacheReadRatioSamples: outcomes.filter((outcome) => outcome.cacheReadRatio !== null).length,
    harmfulAdviceRate: advice.harmfulRate,
    harmfulAdviceRateCi95: bootstrapScalarCi(outcomes.map((outcome) => outcome.advice.proposed === 0 ? 0 : outcome.advice.harmful / outcome.advice.proposed), bootstrap, `${armId}:harmful-advice-rate`),
    advice,
    utilityMean: mean(outcomes.map((outcome) => netUtility(outcome, scoring))),
    utilityCi95: bootstrapMeanCi(outcomes.map((outcome) => netUtility(outcome, scoring)), bootstrap, stream),
  };
}

function pairwiseUplift(
  armId: ComparisonArmId,
  outcomes: readonly SampleOutcome[],
  control: readonly SampleOutcome[],
  scoring: ScoringPlan,
  bootstrap: BootstrapOptions,
): PairwiseUplift {
  const utilityDeltas = outcomes.map((outcome, index) => netUtility(outcome, scoring) - netUtility(control[index]!, scoring));
  const advice = summarizeAdvice(outcomes.map((outcome) => outcome.advice));
  const controlAdvice = summarizeAdvice(control.map((outcome) => outcome.advice));
  return {
    armId,
    controlArmId: CONTROL_ARM,
    pairedSamples: outcomes.length,
    utilityDeltaMean: mean(utilityDeltas),
    utilityCi95: bootstrapMeanCi(utilityDeltas, bootstrap, `${armId}:uplift`),
    qualityDeltaMean: mean(outcomes.map((outcome, index) => outcome.quality - control[index]!.quality)),
    qualityDeltaCi95: bootstrapScalarCi(outcomes.map((outcome, index) => outcome.quality - control[index]!.quality), bootstrap, `${armId}:quality-uplift`),
    costDeltaMeanUsd: mean(outcomes.map((outcome, index) => outcome.costUsd - control[index]!.costUsd)),
    costDeltaCi95: bootstrapScalarCi(outcomes.map((outcome, index) => outcome.costUsd - control[index]!.costUsd), bootstrap, `${armId}:cost-uplift`),
    wallClockDeltaMeanMs: mean(outcomes.map((outcome, index) => outcome.wallClockMs - control[index]!.wallClockMs)),
    wallClockDeltaCi95: bootstrapScalarCi(outcomes.map((outcome, index) => outcome.wallClockMs - control[index]!.wallClockMs), bootstrap, `${armId}:wall-clock-uplift`),
    cacheReadRatioDeltaMean: meanNullable(outcomes.map((outcome, index) => outcome.cacheReadRatio === null || control[index]!.cacheReadRatio === null ? null : outcome.cacheReadRatio - control[index]!.cacheReadRatio)),
    cacheReadRatioDeltaCi95: bootstrapNullableCi(outcomes.map((outcome, index) => outcome.cacheReadRatio === null || control[index]!.cacheReadRatio === null ? null : outcome.cacheReadRatio - control[index]!.cacheReadRatio), bootstrap, `${armId}:cache-read-ratio-uplift`),
    cacheReadRatioPairedSamples: outcomes.filter((outcome, index) => outcome.cacheReadRatio !== null && control[index]!.cacheReadRatio !== null).length,
    adviceDelta: {
      proposed: advice.proposed - controlAdvice.proposed,
      accepted: advice.accepted - controlAdvice.accepted,
      deferred: advice.deferred - controlAdvice.deferred,
      rejected: advice.rejected - controlAdvice.rejected,
      unacknowledged: advice.unacknowledged - controlAdvice.unacknowledged,
      harmful: advice.harmful - controlAdvice.harmful,
      harmfulRate: advice.harmfulRate - controlAdvice.harmfulRate,
    },
  };
}

function validateArm(arm: ArmPlan): void {
  const expected = {
    "main-only": { topology: "main-only", adviceVisibility: "none", maxAuxiliaryRequests: 0 },
    "equal-budget-reflection": { topology: "main+reflection", adviceVisibility: "none", maxAuxiliaryRequests: 2 },
    "teto-shadow": { topology: "main+teto", adviceVisibility: "shadow", maxAuxiliaryRequests: 2 },
    "teto-live": { topology: "main+teto", adviceVisibility: "live", maxAuxiliaryRequests: 2 },
  }[arm.id];
  if (expected === undefined || canonicalJson({ topology: arm.topology, adviceVisibility: arm.adviceVisibility, maxAuxiliaryRequests: arm.maxAuxiliaryRequests }) !== canonicalJson(expected)) {
    throw new Error(`Arm ${String(arm.id)} does not match frozen topology`);
  }
  if (canonicalJson(arm.budget) !== canonicalJson(FROZEN_BUDGET)) throw new Error("Arm budget does not match frozen envelope");
}

function validateOutcome(outcome: SampleOutcome, arm: ArmPlan): void {
  if (!isRecord(outcome)) throw new Error("Outcome must be an object");
  const failureKinds = ["none", "provider", "budget", "timeout", "runtime", "incomplete"];
  if (typeof outcome.completed !== "boolean" || typeof outcome.budgetBreached !== "boolean" || !failureKinds.includes(outcome.failureKind)) throw new Error("Outcome status is invalid");
  if ((outcome.completed && outcome.failureKind !== "none") || (!outcome.completed && outcome.failureKind === "none") || (!outcome.completed && outcome.quality !== 0)) throw new Error("Outcome completion and failure status are inconsistent");
  for (const value of [outcome.quality, outcome.costUsd, outcome.wallClockMs, outcome.requestP95LatencyMs]) {
    if (!finiteNonNegative(value)) throw new Error("Outcome contains an invalid non-negative metric");
  }
  if (outcome.quality > 1 || (outcome.cacheReadRatio !== null && (!finiteNonNegative(outcome.cacheReadRatio) || outcome.cacheReadRatio > 1))) throw new Error("Outcome ratio is outside [0, 1]");
  for (const value of [outcome.requestCount, outcome.auxiliaryRequestCount, outcome.inputTokens, outcome.outputTokens]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Outcome count is not a safe integer");
  }
  if (outcome.auxiliaryRequestCount > outcome.requestCount) throw new Error("Outcome request counts are inconsistent");
  const exceeded = outcome.requestCount > arm.budget.maxRequests || outcome.auxiliaryRequestCount > arm.maxAuxiliaryRequests || outcome.inputTokens > arm.budget.maxInputTokens || outcome.outputTokens > arm.budget.maxOutputTokens || outcome.costUsd > arm.budget.maxCostUsd || outcome.wallClockMs > arm.budget.maxWallClockMs;
  if (exceeded && !outcome.budgetBreached) throw new Error("Outcome exceeds the arm budget without breach evidence");
  if (outcome.budgetBreached && outcome.failureKind !== "budget" && outcome.failureKind !== "timeout") throw new Error("Budget breach must have a budget or timeout failure kind");
  const advice = outcome.advice;
  if (!isRecord(advice) || [advice.proposed, advice.accepted, advice.deferred, advice.rejected, advice.unacknowledged, advice.harmful].some((value) => !Number.isSafeInteger(value) || value < 0) || advice.accepted + advice.deferred + advice.rejected + advice.unacknowledged !== advice.proposed || advice.harmful > advice.proposed) throw new Error("Advice counts are inconsistent");
  const dispositions = advice.accepted + advice.deferred + advice.rejected;
  if (arm.adviceVisibility === "none" && [advice.proposed, dispositions, advice.unacknowledged, advice.harmful].some((value) => value !== 0)) throw new Error("Non-Teto arms cannot report Advice");
  if (arm.adviceVisibility === "shadow" && (dispositions !== 0 || advice.unacknowledged !== advice.proposed)) throw new Error("Shadow Advice cannot be acknowledged by Main");
}

function validateBootstrapOptions(options: BootstrapOptions): void {
  if (typeof options.seed !== "string" || options.seed.length === 0 || !Number.isSafeInteger(options.replicates) || options.replicates < 100 || options.confidenceLevel !== undefined && options.confidenceLevel !== BOOTSTRAP_CONFIDENCE_LEVEL) {
    throw new Error("Invalid paired bootstrap options");
  }
}

function validateReportBuildOptions(options: ReportBuildOptions): void {
  const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
  if (!isRecord(options) || typeof options.evaluationId !== "string" || options.evaluationId.trim().length === 0 || typeof options.startedAt !== "string" || typeof options.completedAt !== "string" || !isoTimestamp.test(options.startedAt) || !isoTimestamp.test(options.completedAt) || options.repositoryDirty !== false || !/^[0-9a-f]{40}$/.test(options.executionCommit) || !/^sha256:[0-9a-f]{64}$/.test(options.evidenceDigest)) {
    throw new Error("Invalid evaluation provenance");
  }
  const started = Date.parse(options.startedAt);
  const completed = Date.parse(options.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) throw new Error("Evaluation timestamps are invalid");
}

function validateReportProvenance(actual: ReportProvenance, manifest: ManifestProvenance, manifestHash: string, rows: readonly PairedTaskRow[]): void {
  if (!isRecord(actual) || canonicalJson({ repositoryCommit: actual.repositoryCommit, runnerVersion: actual.runnerVersion, fixtureHash: actual.fixtureHash, toolHash: actual.toolHash }) !== canonicalJson(manifest) || actual.manifestHash !== manifestHash || actual.repositoryDirty !== false || typeof actual.evaluationId !== "string" || actual.evaluationId.length === 0 || actual.rowsDigest !== hashJson(rows)) {
    throw new Error("Report provenance hash does not match manifest");
  }
  validateReportBuildOptions(actual);
}

function bootstrapMeanCi(values: readonly number[], options: BootstrapOptions, stream: string): ConfidenceInterval {
  validateBootstrapOptions(options);
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) throw new Error("Bootstrap values must be finite and non-empty");
  const random = seededRandom(`${options.seed}:${stream}`);
  const samples = new Array<number>(options.replicates);
  for (let replicate = 0; replicate < options.replicates; replicate += 1) {
    let sum = 0;
    for (let index = 0; index < values.length; index += 1) sum += values[Math.floor(random() * values.length)]!;
    samples[replicate] = sum / values.length;
  }
  samples.sort((left, right) => left - right);
  const alpha = (1 - (options.confidenceLevel ?? BOOTSTRAP_CONFIDENCE_LEVEL)) / 2;
  return { low: quantile(samples, alpha), high: quantile(samples, 1 - alpha) };
}

function bootstrapScalarCi(values: readonly number[], options: BootstrapOptions, stream: string): ConfidenceInterval {
  return bootstrapMeanCi(values, options, stream);
}

function bootstrapNullableCi(values: readonly (number | null)[], options: BootstrapOptions, stream: string): ConfidenceInterval | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : bootstrapScalarCi(known, options, stream);
}

function summarizeAdvice(values: readonly AdviceCounts[]): AdviceSummary {
  const total = values.reduce((sum, advice) => ({
    proposed: sum.proposed + advice.proposed,
    accepted: sum.accepted + advice.accepted,
    deferred: sum.deferred + advice.deferred,
    rejected: sum.rejected + advice.rejected,
    unacknowledged: sum.unacknowledged + advice.unacknowledged,
    harmful: sum.harmful + advice.harmful,
  }), { proposed: 0, accepted: 0, deferred: 0, rejected: 0, unacknowledged: 0, harmful: 0 });
  const rate = (value: number): number => total.proposed === 0 ? 0 : value / total.proposed;
  return {
    ...total,
    acceptedRate: rate(total.accepted),
    deferredRate: rate(total.deferred),
    rejectedRate: rate(total.rejected),
    unacknowledgedRate: rate(total.unacknowledged),
    harmfulRate: rate(total.harmful),
  };
}

function assertAggregate(actual: ArmAggregate, expected: ArmAggregate, expectedSamples: number): void {
  if (!isRecord(actual) || actual.armId !== expected.armId || actual.sampleCount !== expectedSamples || actual.cacheReadRatioSamples !== expected.cacheReadRatioSamples || !sameAggregateNumbers(actual, expected) || canonicalJson(actual.advice) !== canonicalJson(expected.advice)) throw new Error(`Aggregate summary mismatch for ${expected.armId}`);
}

function assertUplift(actual: PairwiseUplift, expected: PairwiseUplift, expectedSamples: number): void {
  if (!isRecord(actual) || actual.armId !== expected.armId || actual.controlArmId !== CONTROL_ARM || actual.pairedSamples !== expectedSamples || actual.cacheReadRatioPairedSamples !== expected.cacheReadRatioPairedSamples || !sameUpliftNumbers(actual, expected) || canonicalJson(actual.adviceDelta) !== canonicalJson(expected.adviceDelta)) throw new Error(`Uplift summary mismatch for ${expected.armId}`);
}

function sameAggregateNumbers(left: ArmAggregate, right: ArmAggregate): boolean {
  const leftValues = [left.completionRate, left.failureRate, left.budgetBreachRate, left.qualityMean, left.qualityCi95.low, left.qualityCi95.high, left.costMeanUsd, left.costMaxUsd, left.costCi95.low, left.costCi95.high, left.wallClockMeanMs, left.wallClockCi95.low, left.wallClockCi95.high, left.wallClockP95Ms, left.requestP95LatencyMeanMs, left.cacheReadRatioMean, left.cacheReadRatioCi95?.low ?? null, left.cacheReadRatioCi95?.high ?? null, left.harmfulAdviceRate, left.harmfulAdviceRateCi95.low, left.harmfulAdviceRateCi95.high, left.utilityMean, left.utilityCi95.low, left.utilityCi95.high];
  const rightValues = [right.completionRate, right.failureRate, right.budgetBreachRate, right.qualityMean, right.qualityCi95.low, right.qualityCi95.high, right.costMeanUsd, right.costMaxUsd, right.costCi95.low, right.costCi95.high, right.wallClockMeanMs, right.wallClockCi95.low, right.wallClockCi95.high, right.wallClockP95Ms, right.requestP95LatencyMeanMs, right.cacheReadRatioMean, right.cacheReadRatioCi95?.low ?? null, right.cacheReadRatioCi95?.high ?? null, right.harmfulAdviceRate, right.harmfulAdviceRateCi95.low, right.harmfulAdviceRateCi95.high, right.utilityMean, right.utilityCi95.low, right.utilityCi95.high];
  return leftValues.every((value, index) => close(value, rightValues[index]!));
}

function sameUpliftNumbers(left: PairwiseUplift, right: PairwiseUplift): boolean {
  const leftValues = [left.utilityDeltaMean, left.utilityCi95.low, left.utilityCi95.high, left.qualityDeltaMean, left.qualityDeltaCi95.low, left.qualityDeltaCi95.high, left.costDeltaMeanUsd, left.costDeltaCi95.low, left.costDeltaCi95.high, left.wallClockDeltaMeanMs, left.wallClockDeltaCi95.low, left.wallClockDeltaCi95.high, left.cacheReadRatioDeltaMean, left.cacheReadRatioDeltaCi95?.low ?? null, left.cacheReadRatioDeltaCi95?.high ?? null];
  const rightValues = [right.utilityDeltaMean, right.utilityCi95.low, right.utilityCi95.high, right.qualityDeltaMean, right.qualityDeltaCi95.low, right.qualityDeltaCi95.high, right.costDeltaMeanUsd, right.costDeltaCi95.low, right.costDeltaCi95.high, right.wallClockDeltaMeanMs, right.wallClockDeltaCi95.low, right.wallClockDeltaCi95.high, right.cacheReadRatioDeltaMean, right.cacheReadRatioDeltaCi95?.low ?? null, right.cacheReadRatioDeltaCi95?.high ?? null];
  return leftValues.every((value, index) => close(value, rightValues[index]!));
}

function close(left: number | null, right: number | null): boolean {
  return left === null || right === null ? left === right : Math.abs(left - right) <= 1e-12;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error("Mean needs at least one value");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function meanNullable(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : mean(known);
}

function quantile(values: readonly number[], probability: number): number {
  const index = (values.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return values[lower]!;
  return values[lower]! + (values[upper]! - values[lower]!) * (index - lower);
}

function percentile(values: readonly number[], probability: number): number {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new Error("Percentile values must be finite and non-empty");
  }
  return quantile([...values].sort((left, right) => left - right), probability);
}

function seededRandom(seed: string): () => number {
  let state = Number.parseInt(createHash(HASH_ALGORITHM).update(seed).digest("hex").slice(0, 8), 16) || 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === right.length && right.every((value) => left.includes(value));
}

function releaseReason(check: ReleaseArmCheck): string {
  const failed: string[] = [];
  if (!check.utilityPass) failed.push(`utility CI low ${check.utilityCiLow} does not exceed ${check.minimumUtilityUplift}`);
  if (!check.qualityPass) failed.push(`quality delta ${check.qualityDeltaMean} regresses beyond ${check.maximumQualityRegression}`);
  if (check.secondaryUtilityCiLow !== undefined && check.secondaryUtilityCiLow <= check.minimumUtilityUplift) {
    failed.push(`Main-only utility CI low ${check.secondaryUtilityCiLow} does not exceed ${check.minimumUtilityUplift}`);
  }
  if (check.secondaryQualityDeltaCiLow !== undefined && check.secondaryQualityDeltaCiLow < -check.maximumQualityRegression) {
    failed.push(`Main-only quality delta CI low ${check.secondaryQualityDeltaCiLow} regresses beyond ${check.maximumQualityRegression}`);
  }
  if (!check.budgetPass) failed.push(`observed max cost ${check.costMaxUsdObserved} exceeds ${check.maxCostUsd}`);
  if (!check.completionPass) failed.push(`completion rate ${check.completionRate} is below 1`);
  if (!check.harmfulAdvicePass) failed.push("harmful Advice rate is not zero");
  return `${check.armId}: ${failed.join("; ")}`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
