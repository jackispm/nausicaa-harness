import {
  FROZEN_WORKER_FIXTURE_CATALOG,
  FROZEN_WORKER_FIXTURE_HASH,
  type WorkerFixtureKind,
  type WorkerFixtureTaskPlan,
} from "./worker-fixtures.js";
import { hashJson } from "./fingerprint.js";

export const WORKER_EVAL_SCHEMA_VERSION = 1 as const;
export const WORKER_EVAL_ARMS = ["main-only", "main-worker"] as const;
export const WORKER_CONTROL_ARM = "main-only" as const;
export const WORKER_TREATMENT_ARM = "main-worker" as const;

export type WorkerEvalArmId = (typeof WORKER_EVAL_ARMS)[number];
export type WorkerFailureKind =
  | "none"
  | "budget"
  | "timeout"
  | "runtime"
  | "incomplete";

export interface WorkerBudgetEnvelope {
  scope: "per-arm";
  maxRequests: number;
  maxWorkerRequests: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostUsd: number;
  maxWallClockMs: number;
}

export interface WorkerArmPlan {
  id: WorkerEvalArmId;
  topology: "main" | "main+worker";
  workerEnabled: boolean;
  budget: WorkerBudgetEnvelope;
}

export interface WorkerScoringPlan {
  qualityWeight: number;
  costWeight: number;
  latencyWeight: number;
  minimumUtilityUplift: number;
  maximumQualityRegression: number;
  minimumParallelOverlapRate: number;
  requireNoGraphAnomalies: true;
  requireNoBudgetBreaches: true;
}

export interface WorkerEvalManifest {
  schemaVersion: typeof WORKER_EVAL_SCHEMA_VERSION;
  experimentId: "phase-3-worker";
  taskSetVersion: string;
  model: { main: string; worker: string };
  seed: string;
  repetitions: number;
  sampleCount: number;
  arms: readonly WorkerArmPlan[];
  tasks: readonly WorkerFixtureTaskPlan[];
  scoring: WorkerScoringPlan;
  provenance: {
    runnerVersion: string;
    fixtureHash: string;
  };
  manifestHash: string;
}

export interface WorkerConcurrencyEvidence {
  intervals: readonly WorkerRequestInterval[];
  overlapMs: number;
  overlapped: boolean;
  peakAllLanesConcurrency: number;
  peakWorkerConcurrency: number;
}

export interface WorkerRequestInterval {
  requestId: string;
  laneId: string;
  startedNs: string;
  endedNs: string;
  durationMs: number;
  terminal: "completed" | "failed";
}

export interface WorkerGraphEvidence {
  taskCount: number;
  delegated: number;
  terminal: number;
  joined: number;
  stale: number;
  partial: number;
  failed: number;
  anomalyCount: number;
  maximumFanIn: number;
}

export interface WorkerBackpressureEvidence {
  capacity: number;
  attempted: number;
  queued: number;
  rejected: number;
  maximumQueueDepth: number;
}

export interface WorkerArmOutcome {
  completed: boolean;
  failureKind: WorkerFailureKind;
  quality: number;
  budgetBreached: boolean;
  requestCount: number;
  workerRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  wallClockMs: number;
  concurrency: WorkerConcurrencyEvidence;
  graph: WorkerGraphEvidence;
  workerExpected: boolean;
  workerUsed: boolean;
}

export interface WorkerPairedRow {
  pairId: string;
  taskId: string;
  taskKind: WorkerFixtureKind;
  repetition: number;
  outcomes: Record<WorkerEvalArmId, WorkerArmOutcome>;
}

export interface WorkerArmAggregate {
  armId: WorkerEvalArmId;
  sampleCount: number;
  completionRate: number;
  qualityMean: number;
  costMeanUsd: number;
  wallClockMeanMs: number;
  budgetBreachRate: number;
  graphAnomalyRate: number;
  workerUseRate: number;
  overlapRate: number;
  peakAllLanesConcurrency: number;
  peakWorkerConcurrency: number;
  utilityMean: number;
}

export interface WorkerEvalReport {
  schemaVersion: typeof WORKER_EVAL_SCHEMA_VERSION;
  manifestHash: string;
  rows: readonly WorkerPairedRow[];
  aggregates: Record<WorkerEvalArmId, WorkerArmAggregate>;
  uplift: {
    pairedSamples: number;
    utilityDeltaMean: number;
    qualityDeltaMean: number;
    costDeltaMeanUsd: number;
    wallClockDeltaMeanMs: number;
  };
  mechanism: {
    backpressure: WorkerBackpressureEvidence;
  };
  provenance: {
    evaluationId: string;
    executionCommit: string;
    repositoryDirty: boolean;
    evidenceDigest: string;
  };
}

export interface WorkerGateDecision {
  /** This is a deterministic mechanism gate, not evidence of product uplift. */
  status: "pass" | "hold";
  eligible: boolean;
  reasons: readonly string[];
  checks: {
    complete: boolean;
    utility: boolean;
    quality: boolean;
    budget: boolean;
    graph: boolean;
    overlap: boolean;
    serialWorker: boolean;
    sentinel: boolean;
    fanIn: boolean;
    partialFailureIsolation: boolean;
    backpressure: boolean;
  };
}

const budget: WorkerBudgetEnvelope = {
  scope: "per-arm",
  maxRequests: 8,
  maxWorkerRequests: 3,
  maxInputTokens: 30_000,
  maxOutputTokens: 2_000,
  maxCostUsd: 0.05,
  maxWallClockMs: 45_000,
};

const manifestDraft: Omit<WorkerEvalManifest, "manifestHash"> = {
  schemaVersion: WORKER_EVAL_SCHEMA_VERSION,
  experimentId: "phase-3-worker",
  taskSetVersion: "worker-workspace-v1",
  model: {
    main: "scripted/worker-eval",
    worker: "scripted/worker-eval",
  },
  seed: "nausicaa-phase-3-worker-seed-1",
  repetitions: 4,
  sampleCount: FROZEN_WORKER_FIXTURE_CATALOG.length * 4,
  arms: [
    {
      id: WORKER_CONTROL_ARM,
      topology: "main",
      workerEnabled: false,
      budget: { ...budget },
    },
    {
      id: WORKER_TREATMENT_ARM,
      topology: "main+worker",
      workerEnabled: true,
      budget: { ...budget },
    },
  ],
  tasks: FROZEN_WORKER_FIXTURE_CATALOG.map((fixture) => structuredClone(fixture.task)),
  scoring: {
    qualityWeight: 1,
    costWeight: 1,
    latencyWeight: 0.000_001,
    minimumUtilityUplift: -0.02,
    maximumQualityRegression: 0.02,
    minimumParallelOverlapRate: 0.8,
    requireNoGraphAnomalies: true,
    requireNoBudgetBreaches: true,
  },
  provenance: {
    runnerVersion: "nausicaa-worker-eval-runner-v1",
    fixtureHash: FROZEN_WORKER_FIXTURE_HASH,
  },
};

export const WORKER_EVAL_MANIFEST: WorkerEvalManifest = deepFreeze({
  ...manifestDraft,
  manifestHash: hashWorkerManifest(manifestDraft),
});

export function hashWorkerManifest(
  manifest: WorkerEvalManifest | Omit<WorkerEvalManifest, "manifestHash">,
): string {
  const { manifestHash: _ignored, ...identity } = manifest as WorkerEvalManifest;
  return hashJson(identity);
}

export function validateWorkerManifest(value: unknown): asserts value is WorkerEvalManifest {
  if (!isRecord(value) || hashJson(value) !== hashJson(WORKER_EVAL_MANIFEST)) {
    throw new Error("Worker evaluation manifest does not match the frozen contract");
  }
  if (value.manifestHash !== hashWorkerManifest(value as unknown as WorkerEvalManifest)) {
    throw new Error("Worker evaluation manifest hash is invalid");
  }
}

export function workerUtility(outcome: WorkerArmOutcome, scoring: WorkerScoringPlan): number {
  return outcome.quality * scoring.qualityWeight
    - outcome.costUsd * scoring.costWeight
    - outcome.wallClockMs * scoring.latencyWeight;
}

export function buildWorkerReport(
  manifest: WorkerEvalManifest,
  rows: readonly WorkerPairedRow[],
  mechanism: WorkerEvalReport["mechanism"],
  provenance: WorkerEvalReport["provenance"],
): WorkerEvalReport {
  validateWorkerManifest(manifest);
  validateRows(manifest, rows);
  validateProvenance(provenance);
  const aggregates = Object.fromEntries(WORKER_EVAL_ARMS.map((armId) => [
    armId,
    aggregateArm(armId, rows.map((row) => row.outcomes[armId]), manifest.scoring),
  ])) as Record<WorkerEvalArmId, WorkerArmAggregate>;
  const deltas = rows.map((row) => ({
    treatment: row.outcomes[WORKER_TREATMENT_ARM],
    control: row.outcomes[WORKER_CONTROL_ARM],
  }));
  return {
    schemaVersion: WORKER_EVAL_SCHEMA_VERSION,
    manifestHash: manifest.manifestHash,
    rows: structuredClone(rows),
    aggregates,
    uplift: {
      pairedSamples: rows.length,
      utilityDeltaMean: mean(deltas.map(({ treatment, control }) => (
        workerUtility(treatment, manifest.scoring) - workerUtility(control, manifest.scoring)
      ))),
      qualityDeltaMean: mean(deltas.map(({ treatment, control }) => treatment.quality - control.quality)),
      costDeltaMeanUsd: mean(deltas.map(({ treatment, control }) => treatment.costUsd - control.costUsd)),
      wallClockDeltaMeanMs: mean(deltas.map(({ treatment, control }) => treatment.wallClockMs - control.wallClockMs)),
    },
    mechanism: structuredClone(mechanism),
    provenance: structuredClone(provenance),
  };
}

export function evaluateWorkerGate(
  manifest: WorkerEvalManifest,
  report: WorkerEvalReport,
): WorkerGateDecision {
  validateWorkerReport(manifest, report);
  const treatment = report.aggregates[WORKER_TREATMENT_ARM];
  const parallelRows = report.rows.filter((row) => row.taskKind === "parallel");
  const sentinelRows = report.rows.filter((row) => row.taskKind === "sentinel");
  const checks = {
    complete: report.rows.length === manifest.sampleCount
      && treatment.completionRate === 1,
    utility: report.uplift.utilityDeltaMean >= manifest.scoring.minimumUtilityUplift,
    quality: report.uplift.qualityDeltaMean >= -manifest.scoring.maximumQualityRegression,
    budget: report.rows.every((row) => WORKER_EVAL_ARMS.every((armId) => (
      !row.outcomes[armId].budgetBreached
    ))),
    graph: treatment.graphAnomalyRate === 0,
    overlap: parallelRows.length > 0
      && ratio(parallelRows.filter((row) => row.outcomes[WORKER_TREATMENT_ARM].concurrency.overlapped).length, parallelRows.length)
        >= manifest.scoring.minimumParallelOverlapRate,
    serialWorker: treatment.peakWorkerConcurrency <= 1,
    sentinel: sentinelRows.every((row) => !row.outcomes[WORKER_TREATMENT_ARM].workerUsed),
    fanIn: parallelRows.every((row) => {
      const task = manifest.tasks.find((candidate) => candidate.taskId === row.taskId)!;
      const outcome = row.outcomes[WORKER_TREATMENT_ARM];
      return outcome.graph.taskCount === task.expectedDelegations
        && outcome.graph.joined === task.expectedDelegations
        && outcome.graph.maximumFanIn >= Math.min(2, task.expectedDelegations)
        && outcome.graph.stale === 0;
    }),
    partialFailureIsolation: parallelRows.every((row) => {
      const task = manifest.tasks.find((candidate) => candidate.taskId === row.taskId)!;
      const outcome = row.outcomes[WORKER_TREATMENT_ARM];
      return outcome.completed
        && outcome.graph.partial === task.expectedPartialResults
        && outcome.graph.failed === task.expectedFailures;
    }),
    backpressure: report.mechanism.backpressure.queued === report.mechanism.backpressure.capacity
      && report.mechanism.backpressure.rejected
        === report.mechanism.backpressure.attempted - report.mechanism.backpressure.capacity
      && report.mechanism.backpressure.maximumQueueDepth
        === report.mechanism.backpressure.capacity,
  };
  const reasons = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => `Worker evaluation check failed: ${name}`);
  return {
    status: reasons.length === 0 ? "pass" : "hold",
    eligible: reasons.length === 0,
    reasons,
    checks,
  };
}

export function validateWorkerReport(
  manifest: WorkerEvalManifest,
  value: unknown,
): asserts value is WorkerEvalReport {
  validateWorkerManifest(manifest);
  if (!isRecord(value) || value.schemaVersion !== WORKER_EVAL_SCHEMA_VERSION) {
    throw new Error("Worker evaluation report is malformed");
  }
  if (value.manifestHash !== manifest.manifestHash || !Array.isArray(value.rows)) {
    throw new Error("Worker evaluation report identity is invalid");
  }
  if (
    !isRecord(value.mechanism)
    || !isRecord(value.mechanism.backpressure)
  ) {
    throw new Error("Worker mechanism evidence is malformed");
  }
  validateBackpressure(value.mechanism.backpressure as unknown as WorkerBackpressureEvidence);
  validateRows(manifest, value.rows as WorkerPairedRow[]);
  if (!isRecord(value.provenance)) throw new Error("Worker report provenance is malformed");
  validateProvenance(value.provenance as unknown as WorkerEvalReport["provenance"]);
  const rebuilt = buildWorkerReport(
    manifest,
    value.rows as WorkerPairedRow[],
    value.mechanism as WorkerEvalReport["mechanism"],
    value.provenance as unknown as WorkerEvalReport["provenance"],
  );
  if (hashJson(rebuilt) !== hashJson(value)) {
    throw new Error("Worker evaluation report summaries do not match paired rows");
  }
}

function aggregateArm(
  armId: WorkerEvalArmId,
  outcomes: readonly WorkerArmOutcome[],
  scoring: WorkerScoringPlan,
): WorkerArmAggregate {
  return {
    armId,
    sampleCount: outcomes.length,
    completionRate: ratio(outcomes.filter((outcome) => outcome.completed).length, outcomes.length),
    qualityMean: mean(outcomes.map((outcome) => outcome.quality)),
    costMeanUsd: mean(outcomes.map((outcome) => outcome.costUsd)),
    wallClockMeanMs: mean(outcomes.map((outcome) => outcome.wallClockMs)),
    budgetBreachRate: ratio(outcomes.filter((outcome) => outcome.budgetBreached).length, outcomes.length),
    graphAnomalyRate: ratio(outcomes.filter((outcome) => outcome.graph.anomalyCount > 0).length, outcomes.length),
    workerUseRate: ratio(outcomes.filter((outcome) => outcome.workerUsed).length, outcomes.length),
    overlapRate: ratio(outcomes.filter((outcome) => outcome.concurrency.overlapped).length, outcomes.length),
    peakAllLanesConcurrency: Math.max(0, ...outcomes.map((outcome) => outcome.concurrency.peakAllLanesConcurrency)),
    peakWorkerConcurrency: Math.max(0, ...outcomes.map((outcome) => outcome.concurrency.peakWorkerConcurrency)),
    utilityMean: mean(outcomes.map((outcome) => workerUtility(outcome, scoring))),
  };
}

function validateRows(manifest: WorkerEvalManifest, rows: readonly WorkerPairedRow[]): void {
  const taskById = new Map(manifest.tasks.map((task) => [task.taskId, task]));
  const seen = new Set<string>();
  for (const row of rows) {
    const task = taskById.get(row.taskId);
    if (
      task === undefined
      || row.pairId !== `${row.taskId}:${row.repetition}`
      || row.taskKind !== task.kind
      || !Number.isSafeInteger(row.repetition)
      || row.repetition < 0
      || row.repetition >= manifest.repetitions
    ) {
      throw new Error("Worker paired row identity is invalid");
    }
    if (seen.has(row.pairId)) throw new Error("Duplicate Worker paired row");
    seen.add(row.pairId);
    for (const armId of WORKER_EVAL_ARMS) validateOutcome(row.outcomes[armId], manifest.arms.find((arm) => arm.id === armId)!);
  }
}

function validateOutcome(outcome: WorkerArmOutcome, arm: WorkerArmPlan): void {
  if (!isRecord(outcome)) throw new Error("Worker outcome is malformed");
  if (outcome.completed !== (outcome.failureKind === "none")) {
    throw new Error("Worker outcome completion is inconsistent");
  }
  for (const value of [outcome.quality, outcome.costUsd, outcome.wallClockMs]) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Worker outcome metric is invalid");
  }
  if (outcome.quality > 1) throw new Error("Worker quality is outside [0, 1]");
  for (const value of [outcome.requestCount, outcome.workerRequestCount, outcome.inputTokens, outcome.outputTokens]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Worker outcome count is invalid");
  }
  const exceeded = outcome.requestCount > arm.budget.maxRequests
    || outcome.workerRequestCount > arm.budget.maxWorkerRequests
    || outcome.inputTokens > arm.budget.maxInputTokens
    || outcome.outputTokens > arm.budget.maxOutputTokens
    || outcome.costUsd > arm.budget.maxCostUsd
    || outcome.wallClockMs > arm.budget.maxWallClockMs;
  if (exceeded !== outcome.budgetBreached) throw new Error("Worker budget evidence is inconsistent");
  if (!arm.workerEnabled && (outcome.workerUsed || outcome.workerRequestCount !== 0)) {
    throw new Error("Main-only outcome contains Worker activity");
  }
  validateConcurrency(outcome.concurrency);
  validateGraph(outcome.graph);
}

function validateConcurrency(evidence: WorkerConcurrencyEvidence): void {
  if (
    !Number.isFinite(evidence.overlapMs)
    || evidence.overlapMs < 0
    || !Number.isSafeInteger(evidence.peakAllLanesConcurrency)
    || !Number.isSafeInteger(evidence.peakWorkerConcurrency)
    || evidence.peakAllLanesConcurrency < 0
    || evidence.peakWorkerConcurrency < 0
    || evidence.overlapped !== (evidence.overlapMs > 0)
  ) {
    throw new Error("Worker concurrency evidence is invalid");
  }
  for (const interval of evidence.intervals) {
    const start = BigInt(interval.startedNs);
    const end = BigInt(interval.endedNs);
    if (end < start || interval.durationMs < 0 || !Number.isFinite(interval.durationMs)) {
      throw new Error("Worker request interval is invalid");
    }
  }
}

function validateGraph(graph: WorkerGraphEvidence): void {
  for (const value of Object.values(graph)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Worker graph evidence is invalid");
  }
  if (graph.joined + graph.stale + graph.terminal + graph.delegated !== graph.taskCount) {
    throw new Error("Worker graph state counts are inconsistent");
  }
}

function validateBackpressure(evidence: WorkerBackpressureEvidence): void {
  for (const value of Object.values(evidence)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Worker backpressure evidence is invalid");
    }
  }
  if (evidence.queued + evidence.rejected !== evidence.attempted) {
    throw new Error("Worker backpressure counts are inconsistent");
  }
}

function validateProvenance(provenance: WorkerEvalReport["provenance"]): void {
  if (
    typeof provenance.evaluationId !== "string"
    || provenance.evaluationId.length === 0
    || !/^[0-9a-f]{40}$/.test(provenance.executionCommit)
    || typeof provenance.repositoryDirty !== "boolean"
    || !/^sha256:[0-9a-f]{64}$/.test(provenance.evidenceDigest)
  ) {
    throw new Error("Worker report provenance is invalid");
  }
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
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
