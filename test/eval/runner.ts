import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import type {
  AnyEvent,
  ModelPort,
  ModelRequest,
  ModelResponse,
  TokenUsage,
} from "../../src/domain/index.js";
import { createOpenRouterModelPort, RetryingModelPort } from "../../src/model/index.js";
import { projectCacheEvidence, projectRunMetrics, type CacheEvidenceReport, type RunMetrics } from "../../src/observability/index.js";
import {
  executeRun,
  type RunExecutionDeps,
  type RunExecutionRequest,
  type RunExecutionResult,
} from "../../src/runtime/index.js";
import { JsonlLedger } from "../../src/ledger/index.js";
import { boundedRedactedText } from "../../src/runtime/redaction.js";
import {
  buildPairedReport,
  evaluateReleaseDecision,
  PREREGISTERED_ARMS,
  PREREGISTERED_MANIFEST,
  type ArmPlan,
  type PairedReport,
  type PairedTaskRow,
  type PreregisteredArmId,
  type PreregisteredManifest,
  type ReleaseDecision,
  type SampleOutcome,
  validateManifest,
  validateReport,
} from "./preregistered-contract.js";
import {
  createEvaluationFixture,
  publicFixtureView,
  scoreFixture,
  traceTools,
  type EvaluationFixture,
  type PublicEvaluationFixture,
  type ToolTraceEntry,
} from "./fixtures.js";
import { hashJson } from "./fingerprint.js";
import {
  assertEvaluationToolContract,
  assertModelRequestToolContract,
  createFrozenWorkspaceFixtureV2Tools,
} from "./tool-contract.js";

export const PHASE24_EVALUATION_ENV = "NAUSICAA_PHASE24_EVAL";
export const PHASE24_EVALUATION_ID = "phase-2.4";

export interface EvaluationModelFactoryContext {
  fixture: PublicEvaluationFixture;
  arm: ArmPlan;
  manifest: PreregisteredManifest;
  live: boolean;
}

export type EvaluationModelFactory = (
  context: EvaluationModelFactoryContext,
) => ModelPort;

export interface Phase24RunnerOptions {
  manifest?: PreregisteredManifest;
  /** Real providers are never selected unless this is explicitly true. */
  live?: boolean;
  /**
   * Probe-only limit. When omitted, every task/repetition pair in the frozen
   * manifest is executed. A partial probe can never produce a release report.
   */
  maxPairs?: number;
  /**
   * Probe-only hard deadline for the whole evaluation, in milliseconds. The
   * signal is propagated to the active arm so provider requests can cancel.
   */
  deadlineMs?: number;
  /** A deterministic root is useful for tests; otherwise a temporary root is used. */
  rootDirectory?: string;
  evaluationId?: string;
  modelFactory?: EvaluationModelFactory;
  writeArtifacts?: boolean;
  /** Override the ignored evidence directory, primarily for deterministic tests. */
  artifactDirectory?: string;
  /** Only deterministic tests may inject clean provenance. */
  repositoryStateForTests?: RepositoryState;
}

export interface ArmExecutionRecord {
  pairId: string;
  taskId: string;
  repetition: number;
  armId: PreregisteredArmId;
  runId: string;
  workspace: string;
  oracleRoot: string;
  stateDir: string;
  /** Digest of the committed Ledger event chain for this arm. */
  ledgerDigest: string;
  outcome?: SampleOutcome;
  result?: Pick<RunExecutionResult, "completed" | "steps" | "finalText" | "blocker">;
  metrics?: RunMetrics;
  cacheEvidence?: CacheEvidenceReport;
  budget: BudgetSnapshot;
  treatmentFidelity: TreatmentFidelity;
  toolTrace: readonly ToolTraceEntry[];
  error?: string;
}

export interface BudgetSnapshot {
  requests: number;
  auxiliaryRequests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  wallClockMs: number;
  requestP95LatencyMs: number;
  breached: boolean;
  breachReason?: string;
}

export interface TreatmentFidelity {
  required: boolean;
  passed: boolean;
  auxiliaryCompleted: number;
  adviceGenerated: number;
  advicePublished: number;
  adviceClaimed: number;
  adviceAcknowledged: number;
  reason?: string;
}

export interface RepositoryState {
  executionCommit: string;
  clean: boolean;
  baselineIsAncestor: boolean;
}

export interface Phase24EvaluationResult {
  evaluationId: string;
  manifest: PreregisteredManifest;
  rootDirectory: string;
  artifactDirectory?: string;
  records: readonly ArmExecutionRecord[];
  rows: readonly PairedTaskRow[];
  report?: PairedReport;
  failures: readonly ArmExecutionRecord[];
  experimentBudget: ExperimentBudgetSnapshot;
  /** Remove temporary fixture and ledger state after the caller has inspected it. */
  cleanup(): Promise<void>;
}

export interface VerifiedEvaluationArtifacts {
  artifactDirectory: string;
  evidenceDigest: string;
  recordCount: number;
  sampleCount: number;
  failureCount: number;
  complete: boolean;
  incompleteReason?: string;
  releaseDecision?: ReleaseDecision;
}

export interface PairExecutionResult {
  pairId: string;
  records: readonly ArmExecutionRecord[];
  row?: PairedTaskRow;
  rootDirectory: string;
  experimentBudget: ExperimentBudgetSnapshot;
  cleanup(): Promise<void>;
}

export interface ArmExecutionOptions {
  manifest?: PreregisteredManifest;
  modelFactory?: EvaluationModelFactory;
  live?: boolean;
  rootDirectory: string;
  experimentBudget?: ExperimentBudgetMeter;
  repositoryStateForTests?: RepositoryState;
  signal?: AbortSignal;
}

export class BudgetExceededError extends Error {
  override readonly name = "BudgetExceededError";
}

export class EvaluationContractError extends Error {
  override readonly name = "EvaluationContractError";
}

export class ProviderUsageError extends Error {
  override readonly name = "ProviderUsageError";
}

/** Select the runtime topology represented by one preregistered arm. */
export function armExecutionConfig(arm: ArmPlan): {
  auxiliaryMode: "none" | "reflection" | "teto";
  adviceDelivery?: "live" | "shadow";
} {
  switch (arm.id) {
    case "main-only":
      return { auxiliaryMode: "none" };
    case "equal-budget-reflection":
      return { auxiliaryMode: "reflection" };
    case "teto-shadow":
      return { auxiliaryMode: "teto", adviceDelivery: "shadow" };
    case "teto-live":
      return { auxiliaryMode: "teto", adviceDelivery: "live" };
  }
}

/** Run every frozen task/repetition/arm pair and build a report only from real records. */
export async function runPhase24Evaluation(
  options: Phase24RunnerOptions = {},
): Promise<Phase24EvaluationResult> {
  const manifest = options.manifest ?? PREREGISTERED_MANIFEST;
  validateManifest(manifest);
  validateProbeOptions(options, manifest.sampleCount);
  const live = options.live === true;
  const startedAt = new Date().toISOString();
  const repository = live
    ? await inspectRepository(manifest.provenance.repositoryCommit)
    : options.repositoryStateForTests ?? await inspectRepository(manifest.provenance.repositoryCommit);
  const operatorCostCap = live ? livePreflight(manifest, repository) : manifest.experimentBudget.maxCostUsd;
  const evaluationId = options.evaluationId ?? PHASE24_EVALUATION_ID;
  validateEvaluationId(evaluationId);
  const rootDirectory = resolve(options.rootDirectory ?? await mkdtemp(join(tmpdir(), "nausicaa-phase24-")));
  const ownsRoot = options.rootDirectory === undefined;
  const experimentBudget = new ExperimentBudgetMeter(manifest.experimentBudget, operatorCostCap);
  const records: ArmExecutionRecord[] = [];
  const pairs = evaluationPairOrder(manifest).slice(0, options.maxPairs);
  const deadline = createProbeDeadline(options.deadlineMs);
  try {
    for (let pairIndex = 0; pairIndex < pairs.length; pairIndex += 1) {
      if (deadline?.signal.aborted) break;
      const pair = pairs[pairIndex]!;
      const pairId = `${pair.task.taskId}:${pair.repetition}`;
      for (const arm of balancedArmOrder(manifest, pairIndex)) {
        if (deadline?.signal.aborted) break;
        if (!experimentBudget.canStart()) {
          records.push(skippedRecord(pairId, pair.task.taskId, pair.repetition, arm.id, rootDirectory, "whole-experiment budget exhausted before arm start"));
          continue;
        }
        records.push(await executeEvaluationArm(pair.task, pair.repetition, arm, {
          manifest,
          ...(options.modelFactory === undefined ? {} : { modelFactory: options.modelFactory }),
          live,
          rootDirectory: join(rootDirectory, "pairs", pairId, arm.id),
          experimentBudget,
          repositoryStateForTests: repository,
          ...(deadline === undefined ? {} : { signal: deadline.signal }),
        }));
      }
    }
  } finally {
    deadline?.dispose();
  }

  const rows = pairRows(records);
  const failures = records.filter((record) => record.outcome?.completed !== true);
  let report: PairedReport | undefined;
  const experimentBudgetSnapshot = experimentBudget.snapshot();
  const evidenceCheckpoint = buildEvidenceCheckpoint(records, experimentBudgetSnapshot);
  const evidenceDigest = evidenceCheckpoint.evidenceDigest;
  if (rows.length === manifest.sampleCount && repository.clean && repository.baselineIsAncestor) {
    const completedAt = new Date().toISOString();
    report = buildPairedReport(manifest, rows, {
      evaluationId,
      startedAt,
      completedAt,
      repositoryDirty: false,
      executionCommit: repository.executionCommit,
      evidenceDigest,
    });
  }
  let artifactDirectory: string | undefined;
  if (options.writeArtifacts !== false) {
    artifactDirectory = resolve(options.artifactDirectory
      ?? join(process.cwd(), ".nausicaa", "evals", "phase-2.4", evaluationId));
    await writeEvaluationArtifacts(
      artifactDirectory,
      manifest,
      records,
      rows,
      report,
      evidenceCheckpoint,
    );
  }
  return {
    evaluationId,
    manifest,
    rootDirectory,
    ...(artifactDirectory === undefined ? {} : { artifactDirectory }),
    records,
    rows,
    ...(report === undefined ? {} : { report }),
    failures,
    experimentBudget: experimentBudgetSnapshot,
    cleanup: async () => {
      if (ownsRoot) await rm(rootDirectory, { recursive: true, force: true });
    },
  };
}

/** Execute exactly one paired task. This is the useful unit for offline tests. */
export async function runEvaluationPair(
  taskId: string,
  repetition = 0,
  options: Omit<Phase24RunnerOptions, "evaluationId"> = {},
): Promise<PairExecutionResult> {
  const manifest = options.manifest ?? PREREGISTERED_MANIFEST;
  validateManifest(manifest);
  const live = options.live === true;
  const repository = live
    ? await inspectRepository(manifest.provenance.repositoryCommit)
    : options.repositoryStateForTests ?? await inspectRepository(manifest.provenance.repositoryCommit);
  const operatorCostCap = live ? livePreflight(manifest, repository) : manifest.experimentBudget.maxCostUsd;
  const task = manifest.tasks.find((candidate) => candidate.taskId === taskId);
  if (task === undefined) throw new Error(`Unknown preregistered task ${taskId}`);
  if (!Number.isSafeInteger(repetition) || repetition < 0 || repetition >= manifest.repetitions) {
    throw new RangeError(`Repetition must be between 0 and ${manifest.repetitions - 1}`);
  }
  const rootDirectory = resolve(options.rootDirectory ?? await mkdtemp(join(tmpdir(), "nausicaa-phase24-pair-")));
  const ownsRoot = options.rootDirectory === undefined;
  const pairId = `${task.taskId}:${repetition}`;
  const experimentBudget = new ExperimentBudgetMeter(manifest.experimentBudget, operatorCostCap);
  const records: ArmExecutionRecord[] = [];
  for (const arm of manifest.arms) {
    records.push(await executeEvaluationArm(task, repetition, arm, {
      manifest,
      ...(options.modelFactory === undefined ? {} : { modelFactory: options.modelFactory }),
      live,
      rootDirectory: join(rootDirectory, "pairs", pairId, arm.id),
      experimentBudget,
      repositoryStateForTests: repository,
    }));
  }
  const rows = pairRows(records);
  const experimentBudgetSnapshot = experimentBudget.snapshot();
  return {
    pairId,
    records,
    ...(rows.length === 1 ? { row: rows[0] } : {}),
    rootDirectory,
    experimentBudget: experimentBudgetSnapshot,
    cleanup: async () => {
      if (ownsRoot) await rm(rootDirectory, { recursive: true, force: true });
    },
  };
}

/** Execute one arm while preserving a complete failure record. */
export async function executeEvaluationArm(
  task: PreregisteredManifest["tasks"][number],
  repetition: number,
  arm: ArmPlan,
  options: ArmExecutionOptions,
): Promise<ArmExecutionRecord> {
  const manifest = options.manifest ?? PREREGISTERED_MANIFEST;
  validateManifest(manifest);
  const live = options.live === true;
  if (!manifest.tasks.some((candidate) => candidate.taskId === task.taskId) || !manifest.arms.some((candidate) => candidate.id === arm.id)) {
    throw new Error("Arm execution must use the frozen task and arm set");
  }
  if (live) {
    if (options.modelFactory !== undefined) {
      throw new EvaluationContractError("Live Phase 2.4 evaluation cannot inject a modelFactory");
    }
    const repository = await inspectRepository(manifest.provenance.repositoryCommit);
    livePreflight(manifest, repository);
  }
  const pairId = `${task.taskId}:${repetition}`;
  const runId = `phase24-${task.taskId}-${repetition}-${arm.id}`;
  const fixture = await createEvaluationFixture(task, options.rootDirectory);
  const dataDir = join(options.rootDirectory, "state");
  const meter = new RunBudgetMeter(arm, manifest.model, fixture.allowWrite, live, options.experimentBudget);
  const model = options.modelFactory?.({
    fixture: publicFixtureView(fixture),
    arm,
    manifest,
    live,
  }) ?? (live
    ? createOpenRouterModelPort()
    : new ScenarioModel(publicFixtureView(fixture), arm));
  const budgetedModel = new BudgetedModel(model, meter);
  // Keep retries outside the budget decorator so every physical provider
  // attempt is admitted, metered, and included in the frozen request cap.
  const wrappedModel = live
    ? new RetryingModelPort(budgetedModel, {
      maxAttempts: manifest.retryPolicy.providerMaxAttempts,
      baseDelayMs: manifest.retryPolicy.providerBaseDelayMs,
      maxDelayMs: manifest.retryPolicy.providerMaxDelayMs,
    })
    : budgetedModel;
  const config = armExecutionConfig(arm);
  const started = performance.now();
  let runResult: RunExecutionResult | undefined;
  let error: string | undefined;
  const toolTrace: ToolTraceEntry[] = [];
  const workspaceTools = createFrozenWorkspaceFixtureV2Tools({
    allowWrite: fixture.allowWrite,
    protectedPaths: [resolve(dataDir)],
  });
  assertEvaluationToolContract(workspaceTools, fixture.allowWrite);
  const tools = traceTools(workspaceTools, toolTrace);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new BudgetExceededError(
      `Arm wall-clock budget of ${arm.budget.maxWallClockMs}ms was exceeded`,
    )), arm.budget.maxWallClockMs);
    const signal = options.signal === undefined
      ? controller.signal
      : AbortSignal.any([options.signal, controller.signal]);
    try {
      const commonRequest = {
        workspace: fixture.workspace,
        dataDir,
        model: manifest.model.main,
        tetoModel: manifest.model.teto,
        reflectionModel: manifest.model.main,
        auxiliaryMode: config.auxiliaryMode,
        ...(config.adviceDelivery === undefined ? {} : { adviceDelivery: config.adviceDelivery }),
        // Avoid confounding quality with an artificial 128-token Main ceiling.
        maxOutputTokens: 512,
        allowWrite: fixture.allowWrite,
        allowShell: false,
        signal,
      } satisfies RunExecutionRequest;
      const initialRequest = {
        ...commonRequest,
        message: fixture.message,
        goal: fixture.goal,
        policy: {
          maxMainStepsPerActivation: 8,
          maxModelTokens: arm.budget.maxInputTokens + arm.budget.maxOutputTokens,
          tetoEnabled: config.auxiliaryMode === "teto",
          // Phase 2.4 evaluates the frozen workspace-tool contract. Keep the
          // production Worker capability out of this arm so the request
          // surface remains comparable across treatments.
          workerEnabled: false,
          // Keep the evaluation aligned with the production Teto budget. The
          // parser tolerates provider wrappers without spending extra tokens.
          tetoMaxOutputTokens: 64,
          tetoTokenRatio: 0.1,
          auxiliaryMode: config.auxiliaryMode === "teto"
            ? "teto"
            : config.auxiliaryMode === "reflection"
              ? "reflection"
              : "none",
          ...(config.adviceDelivery === undefined ? {} : { tetoAdviceDelivery: config.adviceDelivery }),
        },
      } satisfies RunExecutionRequest;
      const runDeps = {
        mainModel: wrappedModel,
        tetoModel: wrappedModel,
        reflectionModel: wrappedModel,
        tools,
        createRunId: () => runId,
      } satisfies RunExecutionDeps;

      let activation = await executeRun(initialRequest, runDeps);
      let steps = activation.steps;
      runResult = { ...activation, steps };
      while (!activation.completed && activation.blocker === "resumable-boundary") {
        if (activation.steps === 0) {
          throw new Error("Run made no progress at a resumable boundary");
        }
        activation = await executeRun({
          ...commonRequest,
          resumeRunId: runId,
        }, runDeps);
        steps += activation.steps;
        runResult = { ...activation, steps };
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (caught: unknown) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  meter.finish(performance.now() - started);

  const runStateDir = runResult?.stateDir ?? join(dataDir, "runs", runId);
  const events = await readRunEvents(runStateDir, runId);
  const ledgerDigest = hashJson(events);
  const metrics = projectRunMetrics(events, runId);
  const cacheEvidence = projectCacheEvidence(events, runId);
  const snapshot = meter.snapshot();
  const advice = adviceCounts(events, fixture, toolTrace);
  if (error === undefined && snapshot.breached) error = snapshot.breachReason;
  if (error === undefined && runResult?.completed !== true) error = "Run did not complete";
  const treatmentFidelity = evaluateTreatmentFidelity(arm, events);
  if (error === undefined && !treatmentFidelity.passed) error = treatmentFidelity.reason;
  const outcome = await outcomeFromRun(
    fixture,
    runResult,
    metrics,
    cacheEvidence,
    snapshot,
    advice,
    toolTrace,
    error,
  );
  return {
    pairId,
    taskId: task.taskId,
    repetition,
    armId: arm.id,
    runId,
    workspace: fixture.workspace,
    oracleRoot: fixture.oracleRoot,
    stateDir: runStateDir,
    ledgerDigest,
    outcome,
    ...(runResult === undefined ? {} : {
      result: {
        completed: runResult.completed,
        steps: runResult.steps,
        finalText: runResult.finalText,
        ...(runResult.blocker === undefined ? {} : { blocker: runResult.blocker }),
      },
    }),
    metrics,
    cacheEvidence,
    budget: snapshot,
    treatmentFidelity,
    toolTrace: structuredClone(toolTrace),
    ...(error === undefined ? {} : { error }),
  };
}

function skippedRecord(
  pairId: string,
  taskId: string,
  repetition: number,
  armId: PreregisteredArmId,
  rootDirectory: string,
  reason: string,
): ArmExecutionRecord {
  return {
    pairId,
    taskId,
    repetition,
    armId,
    runId: `phase24-${taskId}-${repetition}-${armId}`,
    workspace: join(rootDirectory, "skipped", pairId, armId, "workspace"),
    oracleRoot: join(rootDirectory, "skipped", pairId, armId, "oracle"),
    stateDir: join(rootDirectory, "skipped", pairId, armId, "state"),
    ledgerDigest: hashJson([]),
    budget: {
      requests: 0,
      auxiliaryRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      wallClockMs: 0,
      requestP95LatencyMs: 0,
      breached: true,
      breachReason: reason,
    },
    treatmentFidelity: {
      required: armId !== "main-only",
      passed: false,
      auxiliaryCompleted: 0,
      adviceGenerated: 0,
      advicePublished: 0,
      adviceClaimed: 0,
      adviceAcknowledged: 0,
      reason,
    },
    toolTrace: [],
    outcome: {
      completed: false,
      failureKind: "budget",
      budgetBreached: true,
      quality: 0,
      requestCount: 0,
      auxiliaryRequestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      wallClockMs: 0,
      requestP95LatencyMs: 0,
      cacheReadRatio: null,
      advice: { proposed: 0, accepted: 0, deferred: 0, rejected: 0, unacknowledged: 0, harmful: 0 },
    },
    error: reason,
  };
}

function pairRows(records: readonly ArmExecutionRecord[]): PairedTaskRow[] {
  const grouped = new Map<string, ArmExecutionRecord[]>();
  for (const record of records) {
    const list = grouped.get(record.pairId) ?? [];
    list.push(record);
    grouped.set(record.pairId, list);
  }
  const rows: PairedTaskRow[] = [];
  for (const [pairId, group] of grouped) {
    if (group.length !== PREREGISTERED_ARMS.length || group.some((record) => record.outcome === undefined)) continue;
    const [taskId, repetitionText] = pairId.split(":");
    const repetition = Number(repetitionText);
    const outcomes = Object.fromEntries(group.map((record) => [record.armId, record.outcome])) as PairedTaskRow["outcomes"];
    rows.push({ pairId, taskId: taskId!, repetition, outcomes });
  }
  return rows.sort((left, right) => left.pairId.localeCompare(right.pairId));
}

async function outcomeFromRun(
  fixture: EvaluationFixture,
  runResult: RunExecutionResult | undefined,
  metrics: RunMetrics,
  cacheEvidence: CacheEvidenceReport,
  budget: BudgetSnapshot,
  advice: AdviceCountsWithPending,
  toolTrace: readonly ToolTraceEntry[],
  error: string | undefined,
): Promise<SampleOutcome> {
  const completed = error === undefined && runResult?.completed === true;
  const quality = completed && runResult !== undefined
    ? await scoreFixture(fixture, runResult.finalText, toolTrace)
    : 0;
  const cacheReadRatio = cacheEvidence.total.provider.readEvidenceRate;
  return {
    completed,
    failureKind: completed ? "none" : classifyFailure(error, budget),
    budgetBreached: budget.breached,
    quality,
    requestCount: budget.requests,
    auxiliaryRequestCount: budget.auxiliaryRequests,
    inputTokens: budget.inputTokens,
    outputTokens: budget.outputTokens,
    costUsd: budget.costUsd,
    wallClockMs: budget.wallClockMs,
    requestP95LatencyMs: Math.max(metrics.total.modelLatency.p95Ms, budget.requestP95LatencyMs),
    cacheReadRatio,
    advice: {
      proposed: advice.proposed,
      accepted: advice.accepted,
      deferred: advice.deferred,
      rejected: advice.rejected,
      unacknowledged: advice.pending,
      harmful: advice.harmful,
    },
  };
}

function classifyFailure(error: string | undefined, budget: BudgetSnapshot): SampleOutcome["failureKind"] {
  if (budget.breached) return budget.breachReason?.includes("wall-clock") ? "timeout" : "budget";
  if (
    error?.toLowerCase().includes("timeout")
    || error?.toLowerCase().includes("aborted")
    || error?.toLowerCase().includes("deadline")
  ) return "timeout";
  if (error?.toLowerCase().includes("provider") || error?.toLowerCase().includes("model")) return "provider";
  if (error === "Run did not complete") return "incomplete";
  return "runtime";
}

interface AdviceCountsWithPending {
  proposed: number;
  accepted: number;
  deferred: number;
  rejected: number;
  harmful: number;
  pending: number;
}

function adviceCounts(
  events: readonly AnyEvent[],
  fixture: EvaluationFixture,
  toolTrace: readonly ToolTraceEntry[],
): AdviceCountsWithPending {
  const generated = events.filter((event): event is Extract<AnyEvent, { type: "teto.advice.generated" }> => event.type === "teto.advice.generated");
  const acknowledged = new Set<string>();
  let accepted = 0;
  let deferred = 0;
  let rejected = 0;
  let harmful = 0;
  for (const event of generated) {
    const assessment = fixture.oracle.classifyAdvice({
      kind: event.payload.advice.kind,
      claim: event.payload.advice.claim,
      suggestedAction: event.payload.advice.suggestedAction,
      toolTrace,
    });
    if (assessment === "harmful") harmful += 1;
  }
  for (const event of events) {
    if (event.type !== "advice.acknowledged" || acknowledged.has(event.payload.adviceId)) continue;
    acknowledged.add(event.payload.adviceId);
    if (event.payload.disposition === "accept") accepted += 1;
    if (event.payload.disposition === "defer") deferred += 1;
    if (event.payload.disposition === "reject") rejected += 1;
  }
  return {
    proposed: generated.length,
    accepted,
    deferred,
    rejected,
    harmful,
    pending: Math.max(0, generated.length - acknowledged.size),
  };
}

function evaluateTreatmentFidelity(
  arm: ArmPlan,
  events: readonly AnyEvent[],
): TreatmentFidelity {
  const auxiliaryLane = arm.topology === "main+reflection" ? "reflection" : arm.topology === "main+teto" ? "teto" : undefined;
  const auxiliaryCompleted = auxiliaryLane === undefined ? 0 : events.filter((event) =>
    (auxiliaryLane === "teto" && event.type === "teto.observed")
    || (auxiliaryLane === "reflection" && event.type === "reflection.observed")
  ).length;
  const generated = events.filter((event) => event.type === "teto.advice.generated");
  const published = events.filter((event) => event.type === "message.sent" && event.payload.message.payload.type === "advice.propose");
  const claimed = events.filter((event) => event.type === "message.claimed");
  const acknowledged = events.filter((event) => event.type === "advice.acknowledged");
  const required = auxiliaryLane !== undefined;
  // A sidecar is intentionally sparse: cadence/token gates may leave a short
  // successful Main run with no eligible wake, and the terminal complete
  // boundary is never scheduled for observation. Absence of an observation is
  // therefore not a treatment failure. Only an explicit auxiliary failure is
  // authoritative here; publication and delivery contracts below remain
  // strict when an observation did produce Advice.
  const auxiliaryFailure = auxiliaryLane === undefined
    ? undefined
    : events.find((event) => (
      event.laneId === auxiliaryLane
      && event.type === "lane.status"
      && event.payload.status === "failed"
    ));
  let passed = auxiliaryFailure === undefined;
  let reason: string | undefined = auxiliaryFailure?.type === "lane.status"
    ? `${arm.id} auxiliary failed: ${auxiliaryFailure.payload.reason ?? "unknown failure"}`
    : undefined;
  if (arm.id === "teto-shadow" && (published.length > 0 || claimed.length > 0)) {
    passed = false;
    reason = "Teto shadow Advice was published or claimed";
  }
  if (arm.id === "teto-live" && generated.length > 0 && published.length === 0) {
    passed = false;
    reason = "Teto live Advice was generated without publication";
  }
  if (arm.id === "equal-budget-reflection" && events.some((event) => event.type === "reflection.observed" && event.payload.action === "revise") && !events.some((event) => event.type === "reflection.delivered")) {
    passed = false;
    reason = "Reflection revise was not delivered";
  }
  return {
    required,
    passed,
    auxiliaryCompleted,
    adviceGenerated: generated.length,
    advicePublished: published.length,
    adviceClaimed: claimed.length,
    adviceAcknowledged: acknowledged.length,
    ...(reason === undefined ? {} : { reason }),
  };
}

async function readRunEvents(stateDir: string, runId: string): Promise<AnyEvent[]> {
  try {
    const ledger = await JsonlLedger.open(join(stateDir, "ledger.jsonl"));
    try {
      return await ledger.read({ runId });
    } finally {
      await ledger.close();
    }
  } catch {
    return [];
  }
}

async function writeEvaluationArtifacts(
  artifactDirectory: string,
  manifest: PreregisteredManifest,
  records: readonly ArmExecutionRecord[],
  rows: readonly PairedTaskRow[],
  report: PairedReport | undefined,
  checkpoint: EvidenceCheckpoint,
): Promise<void> {
  await import("node:fs/promises").then(({ mkdir }) => mkdir(join(artifactDirectory, "raw"), { recursive: true }));
  const rebuilt = buildEvidenceCheckpoint(records, checkpoint.experimentBudget);
  if (rebuilt.evidenceDigest !== checkpoint.evidenceDigest) throw new Error("Raw evidence digest changed before checkpoint");
  await writeFile(join(artifactDirectory, "raw", "records.json"), JSON.stringify(checkpoint, null, 2) + "\n", "utf8");
  const redacted = {
    schemaVersion: manifest.manifestVersion,
    manifestHash: manifest.manifestHash,
    taskSetVersion: manifest.taskSetVersion,
    model: manifest.model,
    toolVersion: manifest.toolVersion,
    seed: manifest.seed,
    evidenceDigest: checkpoint.evidenceDigest,
    experimentBudget: {
      operatorCostCapUsd: checkpoint.experimentBudget.operatorCostCapUsd,
      requests: checkpoint.experimentBudget.requests,
      inputTokens: checkpoint.experimentBudget.inputTokens,
      outputTokens: checkpoint.experimentBudget.outputTokens,
      costUsd: checkpoint.experimentBudget.costUsd,
      cumulativeWallClockMs: checkpoint.experimentBudget.cumulativeWallClockMs,
      canStart: checkpoint.experimentBudget.canStart,
      breached: checkpoint.experimentBudget.breached,
      ...(checkpoint.experimentBudget.invalidReason === undefined ? {} : { invalidReason: checkpoint.experimentBudget.invalidReason }),
      ...(checkpoint.experimentBudget.breachReason === undefined ? {} : { breachReason: checkpoint.experimentBudget.breachReason }),
    },
    sampleCount: rows.length,
    failures: records.filter((record) => record.error !== undefined).map((record) => ({
      pairId: record.pairId,
      armId: record.armId,
      failureKind: record.outcome?.failureKind ?? "runtime",
    })),
    ...(report === undefined ? {} : {
      report,
      releaseDecision: evaluateReleaseDecision(report),
    }),
  };
  await writeFile(join(artifactDirectory, "report.json"), JSON.stringify(redacted, null, 2) + "\n", "utf8");
}

/** Verify persisted Phase 2.4 evidence without trusting the producing process. */
export async function verifyEvaluationArtifacts(
  artifactDirectory: string,
  manifest: PreregisteredManifest = PREREGISTERED_MANIFEST,
): Promise<VerifiedEvaluationArtifacts> {
  validateManifest(manifest);
  const resolvedDirectory = resolve(artifactDirectory);
  const checkpoint = await readJson(join(resolvedDirectory, "raw", "records.json"));
  verifyEvidenceCheckpoint(checkpoint);
  const envelope = await readJson(join(resolvedDirectory, "report.json"));
  if (!isRecord(envelope)) throw new Error("Evaluation report envelope is malformed");

  const identity = {
    schemaVersion: envelope.schemaVersion,
    manifestHash: envelope.manifestHash,
    taskSetVersion: envelope.taskSetVersion,
    model: envelope.model,
    toolVersion: envelope.toolVersion,
    seed: envelope.seed,
  };
  const expectedIdentity = {
    schemaVersion: manifest.manifestVersion,
    manifestHash: manifest.manifestHash,
    taskSetVersion: manifest.taskSetVersion,
    model: manifest.model,
    toolVersion: manifest.toolVersion,
    seed: manifest.seed,
  };
  if (hashJson(identity) !== hashJson(expectedIdentity)) {
    throw new Error("Evaluation report does not match the preregistered manifest");
  }
  if (envelope.evidenceDigest !== checkpoint.evidenceDigest) {
    throw new Error("Evaluation report does not match the raw evidence digest");
  }
  if (hashJson(envelope.experimentBudget) !== hashJson(checkpoint.experimentBudget)) {
    throw new Error("Evaluation report budget does not match the raw evidence checkpoint");
  }
  if (!Number.isSafeInteger(envelope.sampleCount)
    || (envelope.sampleCount as number) < 0
    || (envelope.sampleCount as number) > manifest.sampleCount) {
    throw new Error("Evaluation report sample count is invalid");
  }
  if (!Array.isArray(envelope.failures)) {
    throw new Error("Evaluation report failure summary is malformed");
  }
  const sampleCount = envelope.sampleCount as number;
  const projected = projectArtifactEvidence(checkpoint.records, manifest);
  if (projected.rows.length !== sampleCount) {
    throw new Error("Evaluation report sample count does not match its raw records");
  }
  if (hashJson(envelope.failures) !== hashJson(projected.failures)) {
    throw new Error("Evaluation report failure summary does not match its raw records");
  }

  let releaseDecision: ReleaseDecision | undefined;
  if (envelope.report !== undefined) {
    validateReport(manifest, envelope.report);
    const report = envelope.report as PairedReport;
    if (sampleCount !== manifest.sampleCount
      || report.provenance.evidenceDigest !== checkpoint.evidenceDigest
      || hashJson(report.rows) !== hashJson(projected.rows)) {
      throw new Error("Complete evaluation report is inconsistent with its checkpoint");
    }
    releaseDecision = evaluateReleaseDecision(report);
    if (hashJson(envelope.releaseDecision) !== hashJson(releaseDecision)) {
      throw new Error("Persisted release decision does not match the preregistered report");
    }
  } else if (envelope.releaseDecision !== undefined) {
    throw new Error("Partial evaluation cannot contain a release decision");
  }

  return {
    artifactDirectory: resolvedDirectory,
    evidenceDigest: checkpoint.evidenceDigest,
    recordCount: checkpoint.records.length,
    sampleCount,
    failureCount: envelope.failures.length,
    complete: envelope.report !== undefined,
    ...(envelope.report !== undefined ? {} : {
      incompleteReason: checkpoint.experimentBudget.invalidReason
        ?? checkpoint.experimentBudget.breachReason
        ?? `Only ${sampleCount} of ${manifest.sampleCount} paired samples are complete`,
    }),
    ...(releaseDecision === undefined ? {} : { releaseDecision }),
  };
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read evaluation artifact ${path}: ${reason}`);
  }
}

function projectArtifactEvidence(
  records: readonly unknown[],
  manifest: PreregisteredManifest,
): {
  rows: PairedTaskRow[];
  failures: Array<{ pairId: string; armId: PreregisteredArmId; failureKind: string }>;
} {
  const taskIds = new Set(manifest.tasks.map((task) => task.taskId));
  const arms = new Set<PreregisteredArmId>(PREREGISTERED_ARMS);
  const seen = new Set<string>();
  const grouped = new Map<string, {
    taskId: string;
    repetition: number;
    outcomes: Partial<Record<PreregisteredArmId, SampleOutcome>>;
  }>();
  const failures: Array<{ pairId: string; armId: PreregisteredArmId; failureKind: string }> = [];

  for (const record of records) {
    if (!isRecord(record)
      || typeof record.pairId !== "string"
      || typeof record.taskId !== "string"
      || !taskIds.has(record.taskId)
      || !Number.isSafeInteger(record.repetition)
      || !arms.has(record.armId as PreregisteredArmId)) {
      throw new Error("Raw evidence contains a malformed arm record");
    }
    const armId = record.armId as PreregisteredArmId;
    const repetition = record.repetition as number;
    if (repetition < 0 || repetition >= manifest.repetitions
      || record.pairId !== `${record.taskId}:${repetition}`) {
      throw new Error("Raw evidence arm record has invalid pair identity");
    }
    const recordKey = `${record.pairId}\u0000${armId}`;
    if (seen.has(recordKey)) throw new Error("Raw evidence contains a duplicate arm record");
    seen.add(recordKey);
    const group = grouped.get(record.pairId) ?? {
      taskId: record.taskId,
      repetition,
      outcomes: {},
    };
    if (group.taskId !== record.taskId || group.repetition !== repetition) {
      throw new Error("Raw evidence pair identity is inconsistent");
    }
    if (isRecord(record.outcome)) {
      group.outcomes[armId] = record.outcome as unknown as SampleOutcome;
    }
    grouped.set(record.pairId, group);
    if (typeof record.error === "string") {
      const failureKind = isRecord(record.outcome) && typeof record.outcome.failureKind === "string"
        ? record.outcome.failureKind
        : "runtime";
      failures.push({ pairId: record.pairId, armId, failureKind });
    }
  }

  const rows = [...grouped.entries()].flatMap(([pairId, group]) =>
    PREREGISTERED_ARMS.every((armId) => group.outcomes[armId] !== undefined)
      ? [{
          pairId,
          taskId: group.taskId,
          repetition: group.repetition,
          outcomes: group.outcomes as Record<PreregisteredArmId, SampleOutcome>,
        }]
      : []
  ).sort((left, right) => left.pairId.localeCompare(right.pairId));
  return { rows, failures };
}

/** Meter shared limits for every model call in one arm and the experiment. */
export class RunBudgetMeter {
  private readonly startedAt = performance.now();
  private readonly latencies: number[] = [];
  private finishedWallClockMs = 0;
  private snapshotValue: BudgetSnapshot = {
    requests: 0,
    auxiliaryRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    wallClockMs: 0,
    requestP95LatencyMs: 0,
    breached: false,
  };

  constructor(
    private readonly arm: ArmPlan,
    private readonly models: { main: string; teto: string },
    private readonly allowWrite: boolean,
    private readonly requireCost: boolean,
    private readonly experiment?: ExperimentBudgetMeter,
  ) {}

  beforeRequest(request: ModelRequest): void {
    this.assertNotBreached();
    const expectedModel = request.laneId === "teto" ? this.models.teto : this.models.main;
    if (request.model !== expectedModel) {
      this.contractFailure(`Model ${request.model} does not match frozen pin ${expectedModel}`);
    }
    try {
      assertModelRequestToolContract(request, this.allowWrite, this.arm.adviceVisibility === "live");
    } catch (error: unknown) {
      this.contractFailure(error instanceof Error ? error.message : String(error));
    }
    if (this.snapshotValue.requests >= this.arm.budget.maxRequests) {
      this.breach(`Arm request budget of ${this.arm.budget.maxRequests} was exceeded`);
    }
    if (request.maxOutputTokens > this.arm.budget.maxOutputTokens) {
      this.breach(`Requested output tokens ${request.maxOutputTokens} exceed arm limit ${this.arm.budget.maxOutputTokens}`);
    }
    if (request.laneId !== "main" && this.snapshotValue.auxiliaryRequests >= this.arm.maxAuxiliaryRequests) {
      this.breach(`Auxiliary request budget of ${this.arm.maxAuxiliaryRequests} was exceeded`);
    }
    try {
      this.experiment?.beforeRequest();
    } catch (error: unknown) {
      this.breach(error instanceof Error ? error.message : "Whole-experiment budget exceeded");
    }
    this.snapshotValue.requests += 1;
    if (request.laneId !== "main") this.snapshotValue.auxiliaryRequests += 1;
  }

  charge(request: ModelRequest, response: ModelResponse, latencyMs: number): void {
    this.assertNotBreached();
    const usage = response.usage;
    this.snapshotValue.inputTokens += usage.input;
    this.snapshotValue.outputTokens += usage.output;
    this.latencies.push(latencyMs);
    if (this.requireCost && (usage.costUsd === undefined || !Number.isFinite(usage.costUsd) || usage.costUsd < 0)) {
      const reason = "Live provider did not report a finite non-negative cost";
      this.experiment?.invalidate(reason);
      throw new ProviderUsageError(reason);
    }
    this.snapshotValue.costUsd += usage.costUsd ?? 0;
    if (this.snapshotValue.inputTokens > this.arm.budget.maxInputTokens) {
      this.breach(`Input token budget of ${this.arm.budget.maxInputTokens} was exceeded`);
    }
    if (this.snapshotValue.outputTokens > this.arm.budget.maxOutputTokens) {
      this.breach(`Output token budget of ${this.arm.budget.maxOutputTokens} was exceeded`);
    }
    if (this.snapshotValue.costUsd > this.arm.budget.maxCostUsd) {
      this.breach(`Cost budget of $${this.arm.budget.maxCostUsd} was exceeded`);
    }
    try {
      this.experiment?.charge(usage);
    } catch (error: unknown) {
      this.breach(error instanceof Error ? error.message : "Whole-experiment budget exceeded");
    }
  }

  finish(elapsedMs = performance.now() - this.startedAt): void {
    this.finishedWallClockMs = Math.max(0, elapsedMs);
    this.snapshotValue.wallClockMs = this.finishedWallClockMs;
    if (this.finishedWallClockMs > this.arm.budget.maxWallClockMs) {
      this.snapshotValue.breached = true;
      this.snapshotValue.breachReason = `Arm wall-clock budget of ${this.arm.budget.maxWallClockMs}ms was exceeded`;
    }
    this.experiment?.chargeWallClock(this.finishedWallClockMs);
    this.syncExperimentBreach();
  }

  snapshot(): BudgetSnapshot {
    this.syncExperimentBreach();
    const sorted = [...this.latencies].sort((left, right) => left - right);
    const index = sorted.length === 0 ? 0 : Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
    return {
      ...this.snapshotValue,
      wallClockMs: this.finishedWallClockMs,
      requestP95LatencyMs: sorted[index] ?? 0,
    };
  }

  private assertNotBreached(): void {
    if (this.snapshotValue.breached) throw new BudgetExceededError(this.snapshotValue.breachReason ?? "Budget exceeded");
  }

  private breach(reason: string): never {
    this.snapshotValue.breached = true;
    this.snapshotValue.breachReason = reason;
    throw new BudgetExceededError(reason);
  }

  private contractFailure(reason: string): never {
    this.experiment?.invalidate(reason);
    throw new EvaluationContractError(reason);
  }

  private syncExperimentBreach(): void {
    const snapshot = this.experiment?.snapshot();
    if (snapshot?.breached === true && !this.snapshotValue.breached) {
      this.snapshotValue.breached = true;
      this.snapshotValue.breachReason = snapshot.breachReason ?? "Whole-experiment budget exceeded";
    }
  }
}

export class ExperimentBudgetMeter {
  private requests = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private costUsd = 0;
  private cumulativeWallClockMs = 0;
  private invalidReason: string | undefined;
  private breachReason: string | undefined;

  constructor(
    private readonly budget: PreregisteredManifest["experimentBudget"],
    private readonly operatorCostCap = budget.maxCostUsd,
  ) {}

  canStart(): boolean {
    return this.invalidReason === undefined
      && this.requests < this.budget.maxRequests
      && this.inputTokens < this.budget.maxInputTokens
      && this.outputTokens < this.budget.maxOutputTokens
      && this.costUsd < Math.min(this.budget.maxCostUsd, this.operatorCostCap)
      && this.cumulativeWallClockMs < this.budget.maxCumulativeWallClockMs;
  }

  beforeRequest(): void {
    if (!this.canStart()) {
      const reason = this.invalidReason ?? this.breachReason ?? "Whole-experiment budget exhausted before request";
      this.breachReason ??= reason;
      throw new BudgetExceededError(reason);
    }
    this.requests += 1;
  }

  charge(usage: TokenUsage): void {
    this.inputTokens += usage.input;
    this.outputTokens += usage.output;
    this.costUsd += usage.costUsd ?? 0;
    if (this.requests > this.budget.maxRequests || this.inputTokens > this.budget.maxInputTokens || this.outputTokens > this.budget.maxOutputTokens || this.costUsd > Math.min(this.budget.maxCostUsd, this.operatorCostCap)) {
      this.breachReason ??= "Whole-experiment budget exceeded";
      throw new BudgetExceededError("Whole-experiment budget exceeded");
    }
  }

  chargeWallClock(elapsedMs: number): void {
    this.cumulativeWallClockMs += Math.max(0, elapsedMs);
    if (this.cumulativeWallClockMs > this.budget.maxCumulativeWallClockMs) {
      this.breachReason ??= "Whole-experiment wall-clock budget exceeded";
    }
  }

  invalidate(reason: string): void {
    this.invalidReason ??= reason;
  }

  snapshot(): ExperimentBudgetSnapshot {
    return {
      operatorCostCapUsd: this.operatorCostCap,
      requests: this.requests,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.costUsd,
      cumulativeWallClockMs: this.cumulativeWallClockMs,
      canStart: this.canStart(),
      breached: this.breachReason !== undefined,
      ...(this.invalidReason === undefined ? {} : { invalidReason: this.invalidReason }),
      ...(this.breachReason === undefined ? {} : { breachReason: this.breachReason }),
    };
  }
}

export interface ExperimentBudgetSnapshot {
  operatorCostCapUsd: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  cumulativeWallClockMs: number;
  canStart: boolean;
  breached: boolean;
  invalidReason?: string;
  breachReason?: string;
}

export class BudgetedModel implements ModelPort {
  constructor(
    private readonly delegate: ModelPort,
    private readonly meter: RunBudgetMeter,
  ) {}

  capabilities(model: string) {
    return this.delegate.capabilities?.(model) ?? { imageInput: false };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.meter.beforeRequest(request);
    const startedAt = performance.now();
    const response = await this.delegate.complete(request);
    this.meter.charge(request, response, performance.now() - startedAt);
    return response;
  }
}

/** Deterministic model used by offline tests; it never reads the hidden oracle. */
export class ScenarioModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  private readonly mainCallsByRun = new Map<string, number>();
  private acknowledged = new Set<string>();
  constructor(
    private readonly fixture: PublicEvaluationFixture,
    private readonly arm: ArmPlan,
  ) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    await delay(request.laneId === "teto" ? 12 : 4);
    this.requests.push(structuredClone(request));
    if (request.laneId === "teto") return this.tetoResponse();
    if (request.laneId === "reflection") return this.reflectionResponse();
    const call = (this.mainCallsByRun.get(request.runId) ?? 0) + 1;
    this.mainCallsByRun.set(request.runId, call);
    const adviceId = findAdviceId(request.messages);
    if (adviceId !== undefined && !this.acknowledged.has(adviceId) && this.arm.id === "teto-live") {
      this.acknowledged.add(adviceId);
      return response({
        content: "",
        toolCalls: [{ id: `advice-${call}`, name: "respond_to_advice", arguments: {
          adviceId,
          disposition: "accept",
          reason: "The bounded suggestion is consistent with the task evidence.",
        } }],
        stopReason: "toolUse",
        usage: mainUsage(call),
      });
    }
    const nextRead = plannedReads(this.fixture.task)
      .find((path) => !hasReadRequest(request.messages, path));
    if (nextRead !== undefined) {
      return response({
        content: "",
        toolCalls: [{ id: `read-${call}`, name: "read_file", arguments: { path: nextRead } }],
        stopReason: "toolUse",
        usage: mainUsage(call),
      });
    }
    if (this.fixture.task.category === "coding" && !request.messages.some((message) => message.role === "tool" && message.toolName === "write_file" && !message.isError)) {
      return response({
        content: "",
        toolCalls: [{ id: `write-${call}`, name: "write_file", arguments: {
          path: "src/slug.ts",
          content: "export function slugify(input: string): string {\n  return input.trim().toLowerCase().replaceAll(/\\s+/g, \"-\");\n}\n",
        } }],
        stopReason: "toolUse",
        usage: mainUsage(call),
      });
    }
    return response({
      content: finalAnswer(this.fixture.task.taskId),
      toolCalls: [],
      stopReason: "stop",
      usage: mainUsage(call),
    });
  }

  private tetoResponse(): ModelResponse {
    const intervention = this.fixture.task.variant === "intervention";
    const kind = this.fixture.task.category === "intent-gap"
      ? "intent-gap"
      : this.fixture.task.category === "method-alternative"
        ? "method-alternative"
        : "orientation";
    return response({
      content: JSON.stringify(intervention
        ? {
            action: "advise",
            kind,
            claim: this.fixture.task.category === "intent-gap"
              ? "The target runtime is still unspecified; preserve that decision for Main."
              : this.fixture.task.category === "method-alternative"
                ? "A repository-owned aggregate command is the smallest complete method."
                : this.fixture.task.category === "coding"
                  ? "Keep the implementation scoped to the requested helper."
                  : this.fixture.task.category === "recovery"
                    ? "The missing optional input is recoverable; continue without repairing it."
                    : "Keep the answer within the requested local setup scope.",
            suggestedAction: this.fixture.task.category === "intent-gap"
              ? "Ask which runtime target the adapter must support."
              : this.fixture.task.category === "method-alternative"
                ? "Use the documented repository-owned aggregate command."
                : this.fixture.task.category === "coding"
                  ? "Change only the requested helper and leave unrelated code intact."
                  : this.fixture.task.category === "recovery"
                    ? "Treat the optional input as missing but non-blocking."
                    : "Return only the requested local setup facts.",
            risk: "low",
          }
        : { action: "silent" }),
      toolCalls: [],
      stopReason: "stop",
      usage: { input: 180, output: 42, cacheRead: 60, cacheWrite: 0, costUsd: 0.002 },
    });
  }

  private reflectionResponse(): ModelResponse {
    return response({
      content: JSON.stringify({ action: "silent" }),
      toolCalls: [],
      stopReason: "stop",
      usage: { input: 180, output: 8, cacheRead: 60, cacheWrite: 0, costUsd: 0.001 },
    });
  }
}

function response(value: ModelResponse): ModelResponse {
  return structuredClone(value);
}

function mainUsage(call: number): TokenUsage {
  return {
    input: 4_500,
    output: 56,
    cacheRead: call === 1 ? 0 : 220,
    cacheWrite: call === 1 ? 220 : 0,
    costUsd: 0.004,
  };
}

function findAdviceId(messages: readonly ModelRequest["messages"][number][]): string | undefined {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const match = /adviceId:\s*([^\n]+)/.exec(message.content);
    if (match?.[1] !== undefined) return match[1].trim();
  }
  return undefined;
}

function hasReadRequest(
  messages: readonly ModelRequest["messages"][number][],
  path: string,
): boolean {
  return messages.some((message) => message.role === "assistant" && message.toolCalls.some((call) =>
    call.name === "read_file" && call.arguments.path === path
  ));
}

function finalAnswer(taskId: string): string {
  switch (taskId) {
    case "goal-drift-intervention-001":
      return "Install with npm install on Node.js >=22.19.";
    case "goal-drift-sentinel-001":
      return "Install with npm install on Node.js >=22.19. Production releases use npm run deploy:private.";
    case "intent-gap-intervention-001":
      return "The missing intent is the target runtime: clarify whether this is for the browser, Node.js, or edge before implementation.";
    case "intent-gap-sentinel-001":
      return "Implement the Node.js adapter using process signals and the server transport.";
    case "method-alternative-intervention-001":
      return "Use the documented bounded command npm run check.";
    case "method-alternative-sentinel-001":
      return "Run npm run typecheck, npm run test:unit, npm run test:eval, then npm run smoke.";
    case "coding-intervention-001":
    case "coding-sentinel-001":
      return "Implemented the requested slug helper in src/slug.ts.";
    case "recovery-intervention-001":
      return "The optional annotations.json input is missing, but the daily summary remains usable because the required base.json is ready.";
    case "recovery-sentinel-001":
      return "The daily summary is usable: required base.json is ready and optional annotations.json is present.";
  }
  throw new Error(`No scripted final answer for ${taskId}`);
}

function plannedReads(task: PublicEvaluationFixture["task"]): readonly string[] {
  switch (task.taskId) {
    case "goal-drift-intervention-001":
      return ["ops/DEPLOYMENT.md", "package.json", "config/runtime.txt", "CONTRIBUTING.md"];
    case "goal-drift-sentinel-001":
      return ["package.json", "config/runtime.txt", "CONTRIBUTING.md", "ops/DEPLOYMENT.md"];
    case "intent-gap-intervention-001":
      return ["targets/browser.md", "targets/node.md", "targets/edge.md", "docs/adapter-contract.md"];
    case "intent-gap-sentinel-001":
      return ["docs/adapter-contract.md", "targets/node.md", "src/adapter.ts"];
    case "method-alternative-intervention-001":
      return ["ci/types.yml", "ci/tests.yml", "package.json", "docs/verification.md"];
    case "method-alternative-sentinel-001":
      return ["package.json", "docs/verification.md"];
    case "coding-intervention-001":
      return ["NOTES.md", "SPEC.md", "src/slug.ts", "test-cases.json", "src/text.ts"];
    case "coding-sentinel-001":
      return ["SPEC.md", "src/slug.ts", "test-cases.json", "src/text.ts"];
    case "recovery-intervention-001":
      return ["reports/annotations.json", "reports/manifest.json", "reports/base.json", "reports/rendering.md"];
    case "recovery-sentinel-001":
      return ["reports/manifest.json", "reports/base.json", "reports/annotations.json", "reports/rendering.md"];
  }
  throw new Error(`No scripted read plan for ${task.taskId}`);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

interface ProbeDeadline {
  signal: AbortSignal;
  dispose(): void;
}

function validateProbeOptions(
  options: Pick<Phase24RunnerOptions, "maxPairs" | "deadlineMs">,
  sampleCount: number,
): void {
  if (options.maxPairs !== undefined && (
    !Number.isSafeInteger(options.maxPairs)
    || options.maxPairs < 1
    || options.maxPairs > sampleCount
  )) {
    throw new RangeError(`maxPairs must be an integer between 1 and ${sampleCount}`);
  }
  if (options.deadlineMs !== undefined && (
    !Number.isFinite(options.deadlineMs)
    || options.deadlineMs <= 0
  )) {
    throw new RangeError("deadlineMs must be a positive finite number");
  }
}

function validateEvaluationId(evaluationId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(evaluationId)) {
    throw new Error("evaluationId must be 1-80 path-safe characters");
  }
}

function createProbeDeadline(deadlineMs: number | undefined): ProbeDeadline | undefined {
  if (deadlineMs === undefined) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new BudgetExceededError(
    `Evaluation hard deadline of ${deadlineMs}ms was exceeded`,
  )), deadlineMs);
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

function seededPermutation<T>(values: readonly T[], seed: string): T[] {
  const output = [...values];
  let state = hashSeed(seed);
  for (let index = output.length - 1; index > 0; index -= 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const swap = state % (index + 1);
    const current = output[index]!;
    output[index] = output[swap]!;
    output[swap] = current;
  }
  return output;
}

function hashSeed(seed: string): number {
  let hash = 2_166_136_261;
  for (const character of seed) hash = Math.imul(hash ^ character.codePointAt(0)!, 16_777_619);
  return hash >>> 0;
}

async function inspectRepository(baselineCommit: string): Promise<RepositoryState> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const status = await run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: resolve(process.cwd()) });
  const head = (await run("git", ["rev-parse", "HEAD"], { cwd: resolve(process.cwd()) })).stdout.trim();
  const ancestor = await run("git", ["merge-base", "--is-ancestor", baselineCommit, "HEAD"], { cwd: resolve(process.cwd()) }).then(() => true, () => false);
  return { executionCommit: head, clean: status.stdout.trim().length === 0, baselineIsAncestor: ancestor };
}

function livePreflight(manifest: PreregisteredManifest, repository: RepositoryState): number {
  if (process.env[PHASE24_EVALUATION_ENV] !== "1") throw new Error(`Live Phase 2.4 evaluation requires ${PHASE24_EVALUATION_ENV}=1`);
  if (process.env.OPENROUTER_API_KEY === undefined || process.env.OPENROUTER_API_KEY.trim().length === 0) throw new Error("Live Phase 2.4 evaluation requires OPENROUTER_API_KEY");
  if (!repository.clean || !repository.baselineIsAncestor || !/^[0-9a-f]{40}$/.test(repository.executionCommit)) throw new Error("Live Phase 2.4 evaluation requires clean provenance based on the preregistered commit");
  const operatorCap = Number(process.env.NAUSICAA_EVAL_BUDGET_USD ?? "0.20");
  if (!Number.isFinite(operatorCap) || operatorCap <= 0) throw new Error("NAUSICAA_EVAL_BUDGET_USD must be a positive finite cap");
  return Math.min(operatorCap, manifest.experimentBudget.maxCostUsd);
}

interface EvaluationPair {
  task: PreregisteredManifest["tasks"][number];
  repetition: number;
}

export function evaluationPairOrder(manifest: PreregisteredManifest): EvaluationPair[] {
  const pairs = manifest.tasks.flatMap((task) => Array.from({ length: manifest.repetitions }, (_, repetition) => ({ task, repetition })));
  return seededPermutation(pairs, manifest.seed);
}

export function balancedArmOrder(manifest: PreregisteredManifest, pairIndex: number): ArmPlan[] {
  const arms = [...manifest.arms];
  const offset = pairIndex % arms.length;
  return [...arms.slice(offset), ...arms.slice(0, offset)];
}

export interface EvidenceCheckpoint {
  evidenceDigest: string;
  experimentBudget: ExperimentBudgetSnapshot;
  records: readonly unknown[];
}

export function buildEvidenceCheckpoint(
  records: readonly ArmExecutionRecord[],
  experimentBudget: ExperimentBudgetSnapshot,
): EvidenceCheckpoint {
  const evidence = evidencePayload(records);
  const budget = structuredClone(experimentBudget);
  return {
    evidenceDigest: hashJson({ experimentBudget: budget, records: evidence }),
    experimentBudget: budget,
    records: evidence,
  };
}

export function verifyEvidenceCheckpoint(value: unknown): asserts value is EvidenceCheckpoint {
  if (!isRecord(value) || typeof value.evidenceDigest !== "string" || !isExperimentBudgetSnapshot(value.experimentBudget) || !Array.isArray(value.records)) {
    throw new Error("Raw evidence checkpoint is malformed");
  }
  if (hashJson({ experimentBudget: value.experimentBudget, records: value.records }) !== value.evidenceDigest) {
    throw new Error("Raw evidence digest does not match its records");
  }
}

function evidencePayload(records: readonly ArmExecutionRecord[]): unknown[] {
  return records.map((record) => ({
    pairId: record.pairId,
    taskId: record.taskId,
    repetition: record.repetition,
    armId: record.armId,
    runId: record.runId,
    ledgerDigest: record.ledgerDigest,
    budget: record.budget,
    treatmentFidelity: record.treatmentFidelity,
    toolTrace: record.toolTrace,
    ...(record.outcome === undefined ? {} : { outcome: record.outcome }),
    ...(record.result === undefined ? {} : { result: record.result }),
    ...(record.metrics === undefined ? {} : { metrics: record.metrics }),
    ...(record.cacheEvidence === undefined ? {} : { cacheEvidence: record.cacheEvidence }),
    ...(record.error === undefined ? {} : { error: boundedRedactedText(record.error, 1_024) }),
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExperimentBudgetSnapshot(value: unknown): value is ExperimentBudgetSnapshot {
  if (!isRecord(value)) return false;
  return [
    value.operatorCostCapUsd,
    value.requests,
    value.inputTokens,
    value.outputTokens,
    value.costUsd,
    value.cumulativeWallClockMs,
  ].every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0)
    && typeof value.canStart === "boolean"
    && typeof value.breached === "boolean"
    && (value.invalidReason === undefined || typeof value.invalidReason === "string");
}
