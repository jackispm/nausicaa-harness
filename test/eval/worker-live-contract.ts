import { createHash } from "node:crypto";

import type { ToolDefinition } from "../../src/domain/index.js";
import { createDelegateTaskTool } from "../../src/runtime/delegate-task-tool.js";
import { createWorkspaceTools } from "../../src/tools/index.js";
import { canonicalJson, hashJson } from "./fingerprint.js";
import {
  WORKER_LIVE_FIXTURE_CATALOG,
  WORKER_LIVE_FIXTURE_HASH,
  WORKER_LIVE_SCORER_HASH,
  type WorkerLiveFixtureKind,
  type WorkerLiveTaskPlan,
} from "./worker-live-fixtures.js";

export type { WorkerLiveTaskPlan } from "./worker-live-fixtures.js";

export const WORKER_LIVE_SCHEMA_VERSION = 1 as const;
export const WORKER_LIVE_ARMS = ["main-only", "main-worker"] as const;
export const WORKER_LIVE_CONTROL_ARM = "main-only" as const;
export const WORKER_LIVE_TREATMENT_ARM = "main-worker" as const;
export const WORKER_LIVE_MODEL = "openrouter:z-ai/glm-4.7-flash" as const;
export const WORKER_LIVE_BASELINE_COMMIT = "617a0b2f97c59da526b961542d4f3580fb4f43c8" as const;
export const WORKER_LIVE_CONFIDENCE_LEVEL = 0.95 as const;
export const WORKER_LIVE_TOOL_CONTRACT_VERSION = "worker-live-tools-v1" as const;
export const WORKER_LIVE_TOOL_MODES = ["main-only", "main-worker", "worker"] as const;

export type WorkerLiveArmId = (typeof WORKER_LIVE_ARMS)[number];
export type WorkerLiveToolMode = (typeof WORKER_LIVE_TOOL_MODES)[number];
export type WorkerLiveFailureKind =
  | "none"
  | "provider"
  | "budget"
  | "timeout"
  | "runtime"
  | "incomplete";

export interface WorkerLiveRunBudget {
  scope: "per-arm-run";
  maxRequests: number;
  maxModelTokens: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostUsd: number;
  maxWallClockMs: number;
}

export interface WorkerLiveExperimentBudget {
  scope: "whole-experiment";
  maxRequests: number;
  maxModelTokens: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostUsd: number;
  maxCumulativeWallClockMs: number;
}

export interface WorkerLiveArmPlan {
  id: WorkerLiveArmId;
  topology: "main" | "main+worker";
  workerEnabled: boolean;
  budget: WorkerLiveRunBudget;
}

export interface WorkerLiveScoringPlan {
  scorerVersion: "worker-live-hidden-scorer-v2";
  scorerHash: string;
  utilityFormula: "quality-cost-wall-clock";
  qualityWeight: number;
  costWeight: number;
  latencyWeight: number;
  confidenceLevel: typeof WORKER_LIVE_CONFIDENCE_LEVEL;
  bootstrapReplicates: number;
  bootstrapMethod: "paired-percentile";
  bootstrapUnit: "task-repetition-pair";
  minimumUtilityUplift: number;
  maximumQualityRegression: number;
  minimumDecomposableWorkerUseRate: number;
  minimumMainWorkerOverlapRate: number;
}

export interface WorkerLiveToolContract {
  version: typeof WORKER_LIVE_TOOL_CONTRACT_VERSION;
  definitions: Readonly<Record<WorkerLiveToolMode, readonly ToolDefinition[]>>;
  hashes: Readonly<Record<WorkerLiveToolMode, string>>;
}

export interface WorkerLiveManifest {
  schemaVersion: typeof WORKER_LIVE_SCHEMA_VERSION;
  experimentId: "worker-live-ab-v2";
  taskSetVersion: "worker-live-natural-v2";
  model: { main: typeof WORKER_LIVE_MODEL; worker: typeof WORKER_LIVE_MODEL };
  seed: string;
  repetitions: number;
  sampleCount: number;
  taskOrder: "seeded-permutation";
  armOrder: "seeded-balanced-rotation";
  retryPolicy: {
    runnerRetries: 0;
    providerMaxAttempts: 2;
    providerBaseDelayMs: 250;
    providerMaxDelayMs: 4_000;
  };
  execution: {
    auxiliaryMode: "none";
    maxMainStepsPerActivation: 8;
    maxOutputTokensPerRequest: 1_024;
    costEnforcement: "post-response-soft-stop";
    allowWrite: false;
    allowShell: false;
  };
  toolContract: {
    version: typeof WORKER_LIVE_TOOL_CONTRACT_VERSION;
    hashes: Readonly<Record<WorkerLiveToolMode, string>>;
  };
  arms: readonly WorkerLiveArmPlan[];
  tasks: readonly WorkerLiveTaskPlan[];
  experimentBudget: WorkerLiveExperimentBudget;
  scoring: WorkerLiveScoringPlan;
  provenance: {
    baselineCommit: typeof WORKER_LIVE_BASELINE_COMMIT;
    runnerVersion: "nausicaa-worker-live-runner-v2";
    fixtureHash: string;
    scorerHash: string;
  };
  manifestHash: string;
}

export interface WorkerLiveOutcome {
  completed: boolean;
  failureKind: WorkerLiveFailureKind;
  budgetBreached: boolean;
  quality: number;
  requestCount: number;
  workerRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  wallClockMs: number;
  requestP95LatencyMs: number;
  /** null means the provider did not expose cache accounting. */
  cacheReadRatio: number | null;
  workerUsed: boolean;
  overlapMs: number;
  overlapped: boolean;
}

export interface WorkerLivePairedRow {
  pairId: string;
  taskId: string;
  taskKind: WorkerLiveFixtureKind;
  repetition: number;
  outcomes: Record<WorkerLiveArmId, WorkerLiveOutcome>;
}

export interface WorkerLiveConfidenceInterval {
  low: number;
  high: number;
}

export interface WorkerLiveArmAggregate {
  armId: WorkerLiveArmId;
  sampleCount: number;
  completionRate: number;
  budgetBreachRate: number;
  qualityMean: number;
  qualityCi95: WorkerLiveConfidenceInterval;
  costMeanUsd: number;
  costCi95: WorkerLiveConfidenceInterval;
  wallClockMeanMs: number;
  wallClockCi95: WorkerLiveConfidenceInterval;
  requestP95LatencyMeanMs: number;
  cacheReadRatioMean: number | null;
  cacheReadRatioCi95: WorkerLiveConfidenceInterval | null;
  cacheReadRatioSamples: number;
  workerUseRate: number;
  workerUseCi95: WorkerLiveConfidenceInterval;
  overlapRate: number;
  overlapCi95: WorkerLiveConfidenceInterval;
  utilityMean: number;
  utilityCi95: WorkerLiveConfidenceInterval;
}

export interface WorkerLivePairedUplift {
  armId: typeof WORKER_LIVE_TREATMENT_ARM;
  controlArmId: typeof WORKER_LIVE_CONTROL_ARM;
  pairedSamples: number;
  utilityDeltaMean: number;
  utilityDeltaCi95: WorkerLiveConfidenceInterval;
  qualityDeltaMean: number;
  qualityDeltaCi95: WorkerLiveConfidenceInterval;
  costDeltaMeanUsd: number;
  costDeltaCi95: WorkerLiveConfidenceInterval;
  wallClockDeltaMeanMs: number;
  wallClockDeltaCi95: WorkerLiveConfidenceInterval;
  cacheReadRatioDeltaMean: number | null;
  cacheReadRatioDeltaCi95: WorkerLiveConfidenceInterval | null;
  cacheReadRatioPairedSamples: number;
  workerUseDeltaMean: number;
  workerUseDeltaCi95: WorkerLiveConfidenceInterval;
  overlapDeltaMean: number;
  overlapDeltaCi95: WorkerLiveConfidenceInterval;
}

export interface WorkerLiveExperimentUsage {
  requestCount: number;
  modelTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  cumulativeWallClockMs: number;
  budgetBreached: boolean;
}

export type WorkerLiveReportProvenance = WorkerLiveManifest["provenance"] & {
  manifestHash: string;
  evaluationId: string;
  startedAt: string;
  completedAt: string;
  repositoryDirty: false;
  baselineIsAncestor: true;
  executionCommit: string;
  evidenceDigest: string;
  rowsDigest: string;
};

export interface WorkerLiveReport {
  schemaVersion: typeof WORKER_LIVE_SCHEMA_VERSION;
  manifestHash: string;
  model: WorkerLiveManifest["model"];
  rows: readonly WorkerLivePairedRow[];
  aggregates: Record<WorkerLiveArmId, WorkerLiveArmAggregate>;
  uplift: WorkerLivePairedUplift;
  experimentUsage: WorkerLiveExperimentUsage;
  provenance: WorkerLiveReportProvenance;
}

export interface WorkerLiveReportOptions {
  evaluationId: string;
  startedAt: string;
  completedAt: string;
  repositoryDirty: false;
  baselineIsAncestor: true;
  executionCommit: string;
  evidenceDigest: string;
}

export interface WorkerLiveDecision {
  status: "advance" | "hold";
  eligible: boolean;
  reasons: readonly string[];
  checks: {
    complete: boolean;
    perRunBudget: boolean;
    experimentBudget: boolean;
    utility: boolean;
    quality: boolean;
    decomposableWorkerUse: boolean;
    sentinelRestraint: boolean;
    overlap: boolean;
  };
}

export interface WorkerLivePairPlan {
  task: WorkerLiveTaskPlan;
  repetition: number;
}

// Build identities from production definitions without invoking their dependencies.
const mainOnlyToolDefinitions = createWorkspaceTools({
  allowWrite: false,
  allowShell: false,
  includeFileInfo: false,
  allowPathOperations: false,
}).map((tool) => structuredClone(tool.definition));
const delegateTaskDefinition = createDelegateTaskTool({
  dispatcher: {} as never,
  store: {} as never,
}).definition;
const workerLiveToolDefinitions: Record<WorkerLiveToolMode, ToolDefinition[]> = {
  "main-only": mainOnlyToolDefinitions,
  "main-worker": [
    ...mainOnlyToolDefinitions.map((definition) => structuredClone(definition)),
    structuredClone(delegateTaskDefinition),
  ],
  worker: mainOnlyToolDefinitions.map((definition) => structuredClone(definition)),
};
const workerLiveToolHashes = Object.fromEntries(WORKER_LIVE_TOOL_MODES.map((mode) => [
  mode,
  hashJson(workerLiveToolDefinitions[mode]),
])) as Record<WorkerLiveToolMode, string>;

export const WORKER_LIVE_TOOL_CONTRACT: WorkerLiveToolContract = deepFreeze({
  version: WORKER_LIVE_TOOL_CONTRACT_VERSION,
  definitions: workerLiveToolDefinitions,
  hashes: workerLiveToolHashes,
});

const runBudget: WorkerLiveRunBudget = {
  scope: "per-arm-run",
  maxRequests: 12,
  maxModelTokens: 50_000,
  maxInputTokens: 45_000,
  maxOutputTokens: 5_000,
  maxCostUsd: 0.125,
  maxWallClockMs: 90_000,
};
const repetitions = 3;
const sampleCount = WORKER_LIVE_FIXTURE_CATALOG.length * repetitions;
const armRunCount = sampleCount * WORKER_LIVE_ARMS.length;

const manifestDraft: Omit<WorkerLiveManifest, "manifestHash"> = {
  schemaVersion: WORKER_LIVE_SCHEMA_VERSION,
  experimentId: "worker-live-ab-v2",
  taskSetVersion: "worker-live-natural-v2",
  model: { main: WORKER_LIVE_MODEL, worker: WORKER_LIVE_MODEL },
  seed: "nausicaa-worker-live-ab-seed-1",
  repetitions,
  sampleCount,
  taskOrder: "seeded-permutation",
  armOrder: "seeded-balanced-rotation",
  retryPolicy: {
    runnerRetries: 0,
    providerMaxAttempts: 2,
    providerBaseDelayMs: 250,
    providerMaxDelayMs: 4_000,
  },
  execution: {
    auxiliaryMode: "none",
    maxMainStepsPerActivation: 8,
    maxOutputTokensPerRequest: 1_024,
    costEnforcement: "post-response-soft-stop",
    allowWrite: false,
    allowShell: false,
  },
  toolContract: {
    version: WORKER_LIVE_TOOL_CONTRACT_VERSION,
    hashes: structuredClone(WORKER_LIVE_TOOL_CONTRACT.hashes),
  },
  arms: [
    { id: WORKER_LIVE_CONTROL_ARM, topology: "main", workerEnabled: false, budget: { ...runBudget } },
    { id: WORKER_LIVE_TREATMENT_ARM, topology: "main+worker", workerEnabled: true, budget: { ...runBudget } },
  ],
  tasks: WORKER_LIVE_FIXTURE_CATALOG.map((fixture) => structuredClone(fixture.task)),
  experimentBudget: {
    scope: "whole-experiment",
    maxRequests: runBudget.maxRequests * armRunCount,
    maxModelTokens: runBudget.maxModelTokens * armRunCount,
    maxInputTokens: runBudget.maxInputTokens * armRunCount,
    maxOutputTokens: runBudget.maxOutputTokens * armRunCount,
    maxCostUsd: runBudget.maxCostUsd * armRunCount,
    maxCumulativeWallClockMs: runBudget.maxWallClockMs * armRunCount,
  },
  scoring: {
    scorerVersion: "worker-live-hidden-scorer-v2",
    scorerHash: WORKER_LIVE_SCORER_HASH,
    utilityFormula: "quality-cost-wall-clock",
    qualityWeight: 1,
    costWeight: 1,
    latencyWeight: 0.000_001,
    confidenceLevel: WORKER_LIVE_CONFIDENCE_LEVEL,
    bootstrapReplicates: 2_000,
    bootstrapMethod: "paired-percentile",
    bootstrapUnit: "task-repetition-pair",
    minimumUtilityUplift: 0,
    maximumQualityRegression: 0.02,
    minimumDecomposableWorkerUseRate: 0.5,
    minimumMainWorkerOverlapRate: 0.5,
  },
  provenance: {
    baselineCommit: WORKER_LIVE_BASELINE_COMMIT,
    runnerVersion: "nausicaa-worker-live-runner-v2",
    fixtureHash: WORKER_LIVE_FIXTURE_HASH,
    scorerHash: WORKER_LIVE_SCORER_HASH,
  },
};

export const WORKER_LIVE_MANIFEST: WorkerLiveManifest = deepFreeze({
  ...manifestDraft,
  manifestHash: hashWorkerLiveManifest(manifestDraft),
});

export function hashWorkerLiveManifest(
  manifest: WorkerLiveManifest | Omit<WorkerLiveManifest, "manifestHash">,
): string {
  const { manifestHash: _ignored, ...identity } = manifest as WorkerLiveManifest;
  return hashJson(identity);
}

export function validateWorkerLiveManifest(
  value: unknown,
): asserts value is WorkerLiveManifest {
  if (!isRecord(value) || canonicalJson(value) !== canonicalJson(WORKER_LIVE_MANIFEST)) {
    throw new Error("Worker live manifest does not match the frozen contract");
  }
  if (value.manifestHash !== hashWorkerLiveManifest(value as unknown as WorkerLiveManifest)) {
    throw new Error("Worker live manifest hash is invalid");
  }
}

export function workerLivePairOrder(
  manifest: WorkerLiveManifest = WORKER_LIVE_MANIFEST,
): WorkerLivePairPlan[] {
  validateWorkerLiveManifest(manifest);
  const pairs = manifest.tasks.flatMap((task) => Array.from(
    { length: manifest.repetitions },
    (_, repetition) => ({ task: structuredClone(task), repetition }),
  ));
  return seededPermutation(pairs, manifest.seed);
}

export function workerLiveArmOrder(
  manifest: WorkerLiveManifest,
  pairIndex: number,
): WorkerLiveArmPlan[] {
  validateWorkerLiveManifest(manifest);
  if (!Number.isSafeInteger(pairIndex) || pairIndex < 0 || pairIndex >= manifest.sampleCount) {
    throw new RangeError("Worker live pair index is outside the manifest");
  }
  const offset = seedWord(`${manifest.seed}:arms`) % WORKER_LIVE_ARMS.length;
  const rotation = (offset + pairIndex) % WORKER_LIVE_ARMS.length;
  return [...manifest.arms.slice(rotation), ...manifest.arms.slice(0, rotation)]
    .map((arm) => structuredClone(arm));
}

export function workerLiveUtility(
  outcome: WorkerLiveOutcome,
  scoring: WorkerLiveScoringPlan,
): number {
  return outcome.quality * scoring.qualityWeight
    - outcome.costUsd * scoring.costWeight
    - outcome.wallClockMs * scoring.latencyWeight;
}

export function buildWorkerLiveReport(
  manifest: WorkerLiveManifest,
  rows: readonly WorkerLivePairedRow[],
  options: WorkerLiveReportOptions,
): WorkerLiveReport {
  validateWorkerLiveManifest(manifest);
  validateRows(manifest, rows);
  validateReportOptions(options);
  const bootstrap = { seed: manifest.seed, replicates: manifest.scoring.bootstrapReplicates };
  const aggregates = Object.fromEntries(WORKER_LIVE_ARMS.map((armId) => [
    armId,
    aggregateArm(armId, rows.map((row) => row.outcomes[armId]), manifest.scoring, bootstrap),
  ])) as Record<WorkerLiveArmId, WorkerLiveArmAggregate>;
  const uplift = pairedUplift(rows, manifest.scoring, bootstrap);
  const experimentUsage = summarizeExperimentUsage(rows, manifest.experimentBudget);
  const provenance: WorkerLiveReportProvenance = {
    ...manifest.provenance,
    manifestHash: manifest.manifestHash,
    ...options,
    rowsDigest: hashJson(rows),
  };
  return {
    schemaVersion: WORKER_LIVE_SCHEMA_VERSION,
    manifestHash: manifest.manifestHash,
    model: { ...manifest.model },
    rows: structuredClone(rows),
    aggregates,
    uplift,
    experimentUsage,
    provenance,
  };
}

export function validateWorkerLiveReport(
  manifest: WorkerLiveManifest,
  value: unknown,
): asserts value is WorkerLiveReport {
  validateWorkerLiveManifest(manifest);
  if (!isRecord(value) || value.schemaVersion !== WORKER_LIVE_SCHEMA_VERSION) {
    throw new Error("Worker live report is malformed");
  }
  const report = value as unknown as WorkerLiveReport;
  if (
    report.manifestHash !== manifest.manifestHash
    || canonicalJson(report.model) !== canonicalJson(manifest.model)
    || !Array.isArray(report.rows)
  ) {
    throw new Error("Worker live report identity does not match its manifest");
  }
  validateRows(manifest, report.rows);
  validateReportProvenance(report.provenance, manifest, report.rows);
  const rebuilt = buildWorkerLiveReport(manifest, report.rows, {
    evaluationId: report.provenance.evaluationId,
    startedAt: report.provenance.startedAt,
    completedAt: report.provenance.completedAt,
    repositoryDirty: report.provenance.repositoryDirty,
    baselineIsAncestor: report.provenance.baselineIsAncestor,
    executionCommit: report.provenance.executionCommit,
    evidenceDigest: report.provenance.evidenceDigest,
  });
  if (hashJson(rebuilt) !== hashJson(report)) {
    throw new Error("Worker live report summaries do not match paired evidence");
  }
}

export function evaluateWorkerLiveDecision(
  manifest: WorkerLiveManifest,
  report: WorkerLiveReport,
): WorkerLiveDecision {
  validateWorkerLiveReport(manifest, report);
  const treatment = report.aggregates[WORKER_LIVE_TREATMENT_ARM];
  const decomposable = report.rows.filter((row) => row.taskKind === "decomposable");
  const sentinels = report.rows.filter((row) => row.taskKind === "sentinel");
  const workerRows = decomposable.filter((row) => (
    row.outcomes[WORKER_LIVE_TREATMENT_ARM].workerUsed
  ));
  const workerUseRate = ratio(workerRows.length, decomposable.length);
  const overlapRate = ratio(workerRows.filter((row) => (
    row.outcomes[WORKER_LIVE_TREATMENT_ARM].overlapped
  )).length, workerRows.length);
  const checks = {
    complete: report.rows.length === manifest.sampleCount
      && WORKER_LIVE_ARMS.every((armId) => report.aggregates[armId].completionRate === 1),
    perRunBudget: WORKER_LIVE_ARMS.every((armId) => (
      report.aggregates[armId].budgetBreachRate === 0
    )),
    experimentBudget: !report.experimentUsage.budgetBreached,
    utility: report.uplift.utilityDeltaCi95.low > manifest.scoring.minimumUtilityUplift,
    quality: report.uplift.qualityDeltaCi95.low >= -manifest.scoring.maximumQualityRegression,
    decomposableWorkerUse: workerUseRate >= manifest.scoring.minimumDecomposableWorkerUseRate,
    sentinelRestraint: sentinels.length > 0 && sentinels.every((row) => (
      !row.outcomes[WORKER_LIVE_TREATMENT_ARM].workerUsed
    )),
    overlap: workerRows.length > 0
      && overlapRate >= manifest.scoring.minimumMainWorkerOverlapRate,
  };
  const reasons = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => `Worker live A/B check failed: ${name}`);
  return {
    status: reasons.length === 0 ? "advance" : "hold",
    eligible: reasons.length === 0,
    reasons,
    checks,
  };
}

export function pairedWorkerLiveBootstrapCi95(
  values: readonly number[],
  options: { seed: string; replicates: number; stream: string },
): WorkerLiveConfidenceInterval {
  if (
    values.length === 0
    || values.some((value) => !Number.isFinite(value))
    || !Number.isSafeInteger(options.replicates)
    || options.replicates < 100
  ) {
    throw new Error("Worker live bootstrap input is invalid");
  }
  const random = seededRandom(`${options.seed}:${options.stream}`);
  const samples = Array.from({ length: options.replicates }, () => {
    let sum = 0;
    for (let index = 0; index < values.length; index += 1) {
      sum += values[Math.floor(random() * values.length)]!;
    }
    return sum / values.length;
  }).sort((left, right) => left - right);
  const alpha = (1 - WORKER_LIVE_CONFIDENCE_LEVEL) / 2;
  return { low: quantile(samples, alpha), high: quantile(samples, 1 - alpha) };
}

function aggregateArm(
  armId: WorkerLiveArmId,
  outcomes: readonly WorkerLiveOutcome[],
  scoring: WorkerLiveScoringPlan,
  bootstrap: { seed: string; replicates: number },
): WorkerLiveArmAggregate {
  const ci = (values: readonly number[], stream: string): WorkerLiveConfidenceInterval => (
    pairedWorkerLiveBootstrapCi95(values, { ...bootstrap, stream: `${armId}:${stream}` })
  );
  const cache = outcomes.map((outcome) => outcome.cacheReadRatio)
    .filter((value): value is number => value !== null);
  const workerUse = outcomes.map((outcome) => outcome.workerUsed ? 1 : 0);
  const overlap = outcomes.map((outcome) => outcome.overlapped ? 1 : 0);
  const utility = outcomes.map((outcome) => workerLiveUtility(outcome, scoring));
  return {
    armId,
    sampleCount: outcomes.length,
    completionRate: mean(outcomes.map((outcome) => outcome.completed ? 1 : 0)),
    budgetBreachRate: mean(outcomes.map((outcome) => outcome.budgetBreached ? 1 : 0)),
    qualityMean: mean(outcomes.map((outcome) => outcome.quality)),
    qualityCi95: ci(outcomes.map((outcome) => outcome.quality), "quality"),
    costMeanUsd: mean(outcomes.map((outcome) => outcome.costUsd)),
    costCi95: ci(outcomes.map((outcome) => outcome.costUsd), "cost"),
    wallClockMeanMs: mean(outcomes.map((outcome) => outcome.wallClockMs)),
    wallClockCi95: ci(outcomes.map((outcome) => outcome.wallClockMs), "wall-clock"),
    requestP95LatencyMeanMs: mean(outcomes.map((outcome) => outcome.requestP95LatencyMs)),
    cacheReadRatioMean: cache.length === 0 ? null : mean(cache),
    cacheReadRatioCi95: cache.length === 0 ? null : ci(cache, "cache"),
    cacheReadRatioSamples: cache.length,
    workerUseRate: mean(workerUse),
    workerUseCi95: ci(workerUse, "worker-use"),
    overlapRate: mean(overlap),
    overlapCi95: ci(overlap, "overlap"),
    utilityMean: mean(utility),
    utilityCi95: ci(utility, "utility"),
  };
}

function pairedUplift(
  rows: readonly WorkerLivePairedRow[],
  scoring: WorkerLiveScoringPlan,
  bootstrap: { seed: string; replicates: number },
): WorkerLivePairedUplift {
  const pairs = rows.map((row) => ({
    control: row.outcomes[WORKER_LIVE_CONTROL_ARM],
    treatment: row.outcomes[WORKER_LIVE_TREATMENT_ARM],
  }));
  const delta = (read: (outcome: WorkerLiveOutcome) => number): number[] => pairs.map((pair) => (
    read(pair.treatment) - read(pair.control)
  ));
  const nullableCache = pairs.flatMap((pair) => (
    pair.control.cacheReadRatio === null || pair.treatment.cacheReadRatio === null
      ? []
      : [pair.treatment.cacheReadRatio - pair.control.cacheReadRatio]
  ));
  const ci = (values: readonly number[], stream: string): WorkerLiveConfidenceInterval => (
    pairedWorkerLiveBootstrapCi95(values, { ...bootstrap, stream: `uplift:${stream}` })
  );
  const utility = pairs.map((pair) => (
    workerLiveUtility(pair.treatment, scoring) - workerLiveUtility(pair.control, scoring)
  ));
  const quality = delta((outcome) => outcome.quality);
  const cost = delta((outcome) => outcome.costUsd);
  const wallClock = delta((outcome) => outcome.wallClockMs);
  const workerUse = delta((outcome) => outcome.workerUsed ? 1 : 0);
  const overlap = delta((outcome) => outcome.overlapped ? 1 : 0);
  return {
    armId: WORKER_LIVE_TREATMENT_ARM,
    controlArmId: WORKER_LIVE_CONTROL_ARM,
    pairedSamples: rows.length,
    utilityDeltaMean: mean(utility),
    utilityDeltaCi95: ci(utility, "utility"),
    qualityDeltaMean: mean(quality),
    qualityDeltaCi95: ci(quality, "quality"),
    costDeltaMeanUsd: mean(cost),
    costDeltaCi95: ci(cost, "cost"),
    wallClockDeltaMeanMs: mean(wallClock),
    wallClockDeltaCi95: ci(wallClock, "wall-clock"),
    cacheReadRatioDeltaMean: nullableCache.length === 0 ? null : mean(nullableCache),
    cacheReadRatioDeltaCi95: nullableCache.length === 0 ? null : ci(nullableCache, "cache"),
    cacheReadRatioPairedSamples: nullableCache.length,
    workerUseDeltaMean: mean(workerUse),
    workerUseDeltaCi95: ci(workerUse, "worker-use"),
    overlapDeltaMean: mean(overlap),
    overlapDeltaCi95: ci(overlap, "overlap"),
  };
}

function summarizeExperimentUsage(
  rows: readonly WorkerLivePairedRow[],
  budget: WorkerLiveExperimentBudget,
): WorkerLiveExperimentUsage {
  const outcomes = rows.flatMap((row) => WORKER_LIVE_ARMS.map((arm) => row.outcomes[arm]));
  const summary = outcomes.reduce((total, outcome) => ({
    requestCount: total.requestCount + outcome.requestCount,
    modelTokens: total.modelTokens
      + outcome.inputTokens
      + outcome.outputTokens
      + outcome.cacheReadTokens
      + outcome.cacheWriteTokens,
    inputTokens: total.inputTokens + outcome.inputTokens,
    outputTokens: total.outputTokens + outcome.outputTokens,
    cacheReadTokens: total.cacheReadTokens + outcome.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + outcome.cacheWriteTokens,
    costUsd: total.costUsd + outcome.costUsd,
    cumulativeWallClockMs: total.cumulativeWallClockMs + outcome.wallClockMs,
  }), {
    requestCount: 0,
    modelTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    cumulativeWallClockMs: 0,
  });
  return {
    ...summary,
    budgetBreached: summary.requestCount > budget.maxRequests
      || summary.modelTokens > budget.maxModelTokens
      || summary.inputTokens > budget.maxInputTokens
      || summary.outputTokens > budget.maxOutputTokens
      || summary.costUsd > budget.maxCostUsd
      || summary.cumulativeWallClockMs > budget.maxCumulativeWallClockMs,
  };
}

function validateRows(manifest: WorkerLiveManifest, rows: readonly WorkerLivePairedRow[]): void {
  if (!Array.isArray(rows) || rows.length !== manifest.sampleCount) {
    throw new Error("Worker live report must contain every task/repetition pair");
  }
  const taskById = new Map(manifest.tasks.map((task) => [task.taskId, task]));
  const seen = new Set<string>();
  for (const row of rows) {
    const task = taskById.get(row.taskId);
    const pairId = `${row.taskId}:${row.repetition}`;
    if (
      task === undefined
      || row.pairId !== pairId
      || row.taskKind !== task.kind
      || !Number.isSafeInteger(row.repetition)
      || row.repetition < 0
      || row.repetition >= manifest.repetitions
      || seen.has(pairId)
      || !isRecord(row.outcomes)
      || !sameSet(Object.keys(row.outcomes), WORKER_LIVE_ARMS)
    ) {
      throw new Error("Worker live paired row identity is invalid or duplicated");
    }
    seen.add(pairId);
    for (const arm of manifest.arms) validateOutcome(row.outcomes[arm.id], arm);
  }
}

function validateOutcome(outcome: WorkerLiveOutcome, arm: WorkerLiveArmPlan): void {
  if (!isRecord(outcome)) throw new Error("Worker live outcome is malformed");
  if (
    typeof outcome.completed !== "boolean"
    || typeof outcome.budgetBreached !== "boolean"
    || !["none", "provider", "budget", "timeout", "runtime", "incomplete"].includes(outcome.failureKind)
    || outcome.completed !== (outcome.failureKind === "none")
  ) {
    throw new Error("Worker live outcome status is inconsistent");
  }
  for (const value of [
    outcome.quality,
    outcome.costUsd,
    outcome.wallClockMs,
    outcome.requestP95LatencyMs,
    outcome.overlapMs,
  ]) {
    if (!finiteNonNegative(value)) throw new Error("Worker live outcome metric is invalid");
  }
  if (
    outcome.quality > 1
    || (outcome.cacheReadRatio !== null
      && (!finiteNonNegative(outcome.cacheReadRatio) || outcome.cacheReadRatio > 1))
  ) {
    throw new Error("Worker live outcome ratio is outside [0, 1]");
  }
  for (const value of [
    outcome.requestCount,
    outcome.workerRequestCount,
    outcome.inputTokens,
    outcome.outputTokens,
    outcome.cacheReadTokens,
    outcome.cacheWriteTokens,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Worker live outcome count is invalid");
    }
  }
  const exceeded = outcome.requestCount > arm.budget.maxRequests
    || outcome.inputTokens
      + outcome.outputTokens
      + outcome.cacheReadTokens
      + outcome.cacheWriteTokens > arm.budget.maxModelTokens
    || outcome.inputTokens > arm.budget.maxInputTokens
    || outcome.outputTokens > arm.budget.maxOutputTokens
    || outcome.costUsd > arm.budget.maxCostUsd
    || outcome.wallClockMs > arm.budget.maxWallClockMs;
  if (outcome.budgetBreached !== exceeded) {
    throw new Error("Worker live budget evidence is inconsistent");
  }
  if (outcome.workerRequestCount > outcome.requestCount) {
    throw new Error("Worker live request counts are inconsistent");
  }
  const cacheDenominator = outcome.inputTokens
    + outcome.cacheReadTokens
    + outcome.cacheWriteTokens;
  if (
    outcome.cacheReadRatio !== null
    && Math.abs(
      outcome.cacheReadRatio
      - (cacheDenominator === 0 ? 0 : outcome.cacheReadTokens / cacheDenominator)
    ) > 1e-12
  ) {
    throw new Error("Worker live cache ratio does not match raw cache tokens");
  }
  if (
    outcome.overlapped !== (outcome.overlapMs > 0)
    || (outcome.workerUsed && outcome.workerRequestCount === 0)
    || (outcome.overlapped && outcome.workerRequestCount === 0)
    || (!arm.workerEnabled && (
      outcome.workerUsed
      || outcome.workerRequestCount !== 0
      || outcome.overlapped
    ))
  ) {
    throw new Error("Worker live mechanism evidence is inconsistent");
  }
}

function validateReportOptions(options: WorkerLiveReportOptions): void {
  if (
    !isRecord(options)
    || typeof options.evaluationId !== "string"
    || options.evaluationId.trim().length === 0
    || options.repositoryDirty !== false
    || options.baselineIsAncestor !== true
    || !commitHash(options.executionCommit)
    || !digest(options.evidenceDigest)
    || !validTimeline(options.startedAt, options.completedAt)
  ) {
    throw new Error("Worker live report provenance is invalid");
  }
}

function validateReportProvenance(
  provenance: WorkerLiveReportProvenance,
  manifest: WorkerLiveManifest,
  rows: readonly WorkerLivePairedRow[],
): void {
  if (
    !isRecord(provenance)
    || canonicalJson({
      baselineCommit: provenance.baselineCommit,
      runnerVersion: provenance.runnerVersion,
      fixtureHash: provenance.fixtureHash,
      scorerHash: provenance.scorerHash,
    }) !== canonicalJson(manifest.provenance)
    || provenance.manifestHash !== manifest.manifestHash
    || provenance.rowsDigest !== hashJson(rows)
  ) {
    throw new Error("Worker live report provenance does not match the manifest");
  }
  validateReportOptions(provenance);
}

function seededPermutation<T>(values: readonly T[], seed: string): T[] {
  const result = [...values];
  const random = seededRandom(`${seed}:pairs`);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const replacement = Math.floor(random() * (index + 1));
    [result[index], result[replacement]] = [result[replacement]!, result[index]!];
  }
  return result;
}

function seededRandom(seed: string): () => number {
  let state = seedWord(seed) || 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function seedWord(seed: string): number {
  return Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16);
}

function validTimeline(startedAt: string, completedAt: string): boolean {
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  return Number.isFinite(started) && Number.isFinite(completed) && completed >= started;
}

function quantile(values: readonly number[], probability: number): number {
  const index = (values.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return values[lower]!;
  return values[lower]! + (values[upper]! - values[lower]!) * (index - lower);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error("Worker live mean requires values");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function commitHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value as never));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
