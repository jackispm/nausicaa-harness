import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type {
  AgentTool,
  ArtifactRef,
  AnyEvent,
  ConversationMessage,
  ModelPort,
  ModelRequest,
  ModelResponse,
  TokenUsage,
} from "../../src/domain/index.js";
import {
  JsonlLedger,
  LedgerState,
  projectTaskGraph,
  validateEvent,
  type TaskGraphProjection,
} from "../../src/ledger/index.js";
import {
  createOpenRouterModelPort,
  RetryingModelPort,
} from "../../src/model/index.js";
import { projectRunMetrics } from "../../src/observability/index.js";
import {
  executeRun,
  type RunExecutionDeps,
  type RunExecutionRequest,
  type RunExecutionResult,
} from "../../src/runtime/index.js";
import { persistedErrorText } from "../../src/runtime/redaction.js";
import {
  FileContentAddressedStore,
  createArtifactRef,
} from "../../src/store/index.js";
import {
  WORKER_LIVE_ARMS,
  WORKER_LIVE_MANIFEST,
  WORKER_LIVE_SCHEMA_VERSION,
  WORKER_LIVE_TOOL_CONTRACT,
  buildWorkerLiveReport,
  evaluateWorkerLiveDecision,
  validateWorkerLiveManifest,
  validateWorkerLiveReport,
  workerLiveArmOrder,
  workerLivePairOrder,
  type WorkerLiveArmId,
  type WorkerLiveArmPlan,
  type WorkerLiveDecision,
  type WorkerLiveExperimentUsage,
  type WorkerLiveFailureKind,
  type WorkerLiveManifest,
  type WorkerLiveOutcome,
  type WorkerLivePairedRow,
  type WorkerLiveReport,
} from "./worker-live-contract.js";
import {
  createWorkerLiveFixture,
  type WorkerLiveFixture,
  type WorkerLiveFixtureKind,
  type WorkerLiveTaskPlan,
  type WorkerLiveToolTraceEntry,
} from "./worker-live-fixtures.js";
import { canonicalJson, hashJson } from "./fingerprint.js";
import {
  assertEvaluationToolContract,
  createFrozenWorkspaceFixtureV2Tools,
} from "./tool-contract.js";

export const WORKER_LIVE_EVALUATION_ID = "worker-live-ab-v2";
export const WORKER_LIVE_EVALUATION_ENV = "NAUSICAA_WORKER_EVAL";
export const WORKER_LIVE_BUDGET_ENV = "NAUSICAA_WORKER_EVAL_BUDGET_USD";

export interface WorkerLiveRepositoryState {
  executionCommit: string;
  clean: boolean;
  baselineIsAncestor: boolean;
}

export interface WorkerLivePublicFixture {
  task: WorkerLiveFixture["task"];
  workspace: string;
  message: string;
  goal: WorkerLiveFixture["goal"];
  fixtureHash: string;
}

export interface WorkerLiveModelFactoryContext {
  fixture: WorkerLivePublicFixture;
  arm: WorkerLiveArmPlan;
  manifest: WorkerLiveManifest;
  live: false;
}

export type WorkerLiveModelFactory = (
  context: WorkerLiveModelFactoryContext,
) => ModelPort;

export interface WorkerLiveRunnerOptions {
  live?: boolean;
  maxPairs?: number;
  deadlineMs?: number;
  rootDirectory?: string;
  artifactDirectory?: string;
  evaluationId?: string;
  writeArtifacts?: boolean;
  /** Offline tests must provide their own model; live runs reject injection. */
  modelFactory?: WorkerLiveModelFactory;
  /** Only offline tests may inject provenance. */
  repositoryStateForTests?: WorkerLiveRepositoryState;
}

export interface WorkerLiveProviderUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

export interface WorkerLiveRequestInterval {
  requestId: string;
  logicalRequestId: string;
  ordinal: number;
  attempt: number;
  laneId: "main" | "worker";
  model: string;
  sessionId: string;
  maxOutputTokens: number;
  startedNs: string;
  endedNs: string;
  durationMs: number;
  terminal: "completed" | "failed";
  usage?: WorkerLiveProviderUsage;
}

export interface WorkerLiveGraphEvidence {
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

export interface WorkerLiveArmRecord {
  pairId: string;
  pairIndex: number;
  armOrderIndex: number;
  taskId: string;
  taskKind: WorkerLiveFixtureKind;
  repetition: number;
  armId: WorkerLiveArmId;
  runId: string;
  timing: { startedNs: string; endedNs: string };
  ledgerDigest: string;
  events: readonly AnyEvent[];
  taskGraph: TaskGraphProjection;
  graph: WorkerLiveGraphEvidence;
  requestIntervals: readonly WorkerLiveRequestInterval[];
  toolTrace: readonly WorkerLiveRecordedToolTraceEntry[];
  finalText: string;
  answerArtifact?: WorkerLiveAnswerArtifact;
  runResult?: Pick<RunExecutionResult, "completed" | "steps" | "blocker">;
  outcome: WorkerLiveOutcome;
  error?: string;
}

export interface WorkerLiveAnswerArtifact {
  ref: ArtifactRef;
  message: Extract<ConversationMessage, { role: "assistant" }>;
}

export interface WorkerLiveRecordedToolTraceEntry
  extends WorkerLiveToolTraceEntry {
  operationId: string;
}

export interface WorkerLiveExperimentSnapshot extends WorkerLiveExperimentUsage {
  operatorCostStopThresholdUsd: number;
  exhausted: boolean;
  breachReason?: string;
}

export interface WorkerLiveEvidenceCheckpoint {
  schemaVersion: typeof WORKER_LIVE_SCHEMA_VERSION;
  manifestHash: string;
  evaluationId: string;
  startedAt: string;
  repository: WorkerLiveRepositoryState;
  experimentUsage: WorkerLiveExperimentSnapshot;
  records: readonly WorkerLiveArmRecord[];
  evidenceDigest: string;
}

export interface WorkerLiveEvaluationResult {
  evaluationId: string;
  manifest: WorkerLiveManifest;
  rootDirectory: string;
  artifactDirectory?: string;
  records: readonly WorkerLiveArmRecord[];
  rows: readonly WorkerLivePairedRow[];
  failures: readonly WorkerLiveArmRecord[];
  evidenceDigest: string;
  experimentUsage: WorkerLiveExperimentSnapshot;
  report?: WorkerLiveReport;
  decision?: WorkerLiveDecision;
  cleanup(): Promise<void>;
}

export interface VerifiedWorkerLiveArtifacts {
  artifactDirectory: string;
  evidenceDigest: string;
  recordCount: number;
  sampleCount: number;
  failureCount: number;
  complete: boolean;
  incompleteReason?: string;
  decision?: WorkerLiveDecision;
}

export class WorkerLiveBudgetError extends Error {
  override readonly name = "WorkerLiveBudgetError";
}

export class WorkerLiveContractError extends Error {
  override readonly name = "WorkerLiveContractError";
}

export class WorkerLiveProviderUsageError extends Error {
  override readonly name = "WorkerLiveProviderUsageError";
}

/** Pure live gate, exported so preflight failures can be tested without network calls. */
export function workerLivePreflight(
  repository: WorkerLiveRepositoryState,
  environment: NodeJS.ProcessEnv = process.env,
  manifest: WorkerLiveManifest = WORKER_LIVE_MANIFEST,
): number {
  validateWorkerLiveManifest(manifest);
  if (environment[WORKER_LIVE_EVALUATION_ENV] !== "1") {
    throw new WorkerLiveContractError(
      `Live Worker evaluation requires ${WORKER_LIVE_EVALUATION_ENV}=1`,
    );
  }
  if ((environment.OPENROUTER_API_KEY ?? "").trim().length === 0) {
    throw new WorkerLiveContractError(
      "Live Worker evaluation requires OPENROUTER_API_KEY",
    );
  }
  const configuredBudget = environment[WORKER_LIVE_BUDGET_ENV];
  if (configuredBudget === undefined || configuredBudget.trim().length === 0) {
    throw new WorkerLiveContractError(
      `Live Worker evaluation requires an explicit ${WORKER_LIVE_BUDGET_ENV}`,
    );
  }
  const operatorCap = Number(configuredBudget);
  if (!Number.isFinite(operatorCap) || operatorCap <= 0) {
    throw new WorkerLiveContractError(
      `${WORKER_LIVE_BUDGET_ENV} must be a positive finite soft-stop threshold`,
    );
  }
  if (!repository.clean) {
    throw new WorkerLiveContractError(
      "Live Worker evaluation requires a clean worktree",
    );
  }
  if (!repository.baselineIsAncestor) {
    throw new WorkerLiveContractError(
      "Live Worker evaluation baseline is not an ancestor of HEAD",
    );
  }
  if (!commitHash(repository.executionCommit)) {
    throw new WorkerLiveContractError(
      "Live Worker evaluation requires a 40-character execution commit",
    );
  }
  return Math.min(operatorCap, manifest.experimentBudget.maxCostUsd);
}

export async function runWorkerLiveEvaluation(
  options: WorkerLiveRunnerOptions = {},
): Promise<WorkerLiveEvaluationResult> {
  const manifest = WORKER_LIVE_MANIFEST;
  validateWorkerLiveManifest(manifest);
  validateRunnerOptions(options, manifest);
  const live = options.live === true;
  if (live && options.modelFactory !== undefined) {
    throw new WorkerLiveContractError(
      "Live Worker evaluation cannot inject a modelFactory",
    );
  }
  if (live && options.repositoryStateForTests !== undefined) {
    throw new WorkerLiveContractError(
      "Live Worker evaluation cannot inject repository provenance",
    );
  }
  if (!live && options.modelFactory === undefined) {
    throw new WorkerLiveContractError(
      "Offline Worker evaluation requires a modelFactory",
    );
  }

  let repository = options.repositoryStateForTests
    ?? await inspectWorkerLiveRepository(manifest.provenance.baselineCommit);
  const operatorCostStopThresholdUsd = live
    ? workerLivePreflight(repository, process.env, manifest)
    : manifest.experimentBudget.maxCostUsd;
  const evaluationId = options.evaluationId ?? WORKER_LIVE_EVALUATION_ID;
  validateEvaluationId(evaluationId);
  const startedAt = new Date().toISOString();
  const rootDirectory = resolve(
    options.rootDirectory
      ?? await mkdtemp(join(tmpdir(), "nausicaa-worker-live-")),
  );
  const ownsRoot = options.rootDirectory === undefined;
  const artifactDirectory = options.writeArtifacts === false
    ? undefined
    : resolve(options.artifactDirectory ?? join(
      process.cwd(),
      ".nausicaa",
      "evals",
      "worker-live",
      evaluationId,
    ));
  const experiment = new WorkerLiveExperimentMeter(
    manifest,
    operatorCostStopThresholdUsd,
  );
  const records: WorkerLiveArmRecord[] = [];
  const pairs = workerLivePairOrder(manifest).slice(0, options.maxPairs);
  const deadline = createDeadline(options.deadlineMs);

  try {
    outer: for (let pairIndex = 0; pairIndex < pairs.length; pairIndex += 1) {
      const pair = pairs[pairIndex]!;
      for (const [armOrderIndex, arm] of workerLiveArmOrder(
        manifest,
        pairIndex,
      ).entries()) {
        if (deadline?.signal.aborted || !experiment.canStart()) break outer;
        const record = await executeWorkerLiveArm(
          pair.task,
          pair.repetition,
          arm,
          {
            manifest,
            live,
            pairIndex,
            armOrderIndex,
            rootDirectory: join(
              rootDirectory,
              "pairs",
              `${pair.task.taskId}:${pair.repetition}`,
              arm.id,
            ),
            experiment,
            ...(options.modelFactory === undefined
              ? {}
              : { modelFactory: options.modelFactory }),
            ...(deadline === undefined ? {} : { signal: deadline.signal }),
          },
        );
        records.push(record);
        if (artifactDirectory !== undefined) {
          await persistWorkerLiveArtifacts(
            artifactDirectory,
            manifest,
            evaluationId,
            startedAt,
            repository,
            operatorCostStopThresholdUsd,
            records,
          );
        }
        if (deadline?.signal.aborted) break outer;
      }
    }
  } finally {
    deadline?.dispose();
  }

  if (live) {
    const finalRepository = await inspectWorkerLiveRepository(
      manifest.provenance.baselineCommit,
    );
    workerLivePreflight(finalRepository, process.env, manifest);
    if (finalRepository.executionCommit !== repository.executionCommit) {
      throw new WorkerLiveContractError(
        "Repository HEAD changed during the live Worker evaluation",
      );
    }
    repository = finalRepository;
  }

  const finalized = await finalizeEvaluation(
    manifest,
    evaluationId,
    startedAt,
    repository,
    operatorCostStopThresholdUsd,
    records,
  );
  if (artifactDirectory !== undefined) {
    await writeWorkerLiveArtifactEnvelope(
      artifactDirectory,
      manifest,
      finalized.checkpoint,
      finalized.rows,
      finalized.report,
      finalized.decision,
    );
  }
  return {
    evaluationId,
    manifest,
    rootDirectory,
    ...(artifactDirectory === undefined ? {} : { artifactDirectory }),
    records: structuredClone(records),
    rows: finalized.rows,
    failures: records.filter((record) => !record.outcome.completed),
    evidenceDigest: finalized.checkpoint.evidenceDigest,
    experimentUsage: finalized.checkpoint.experimentUsage,
    ...(finalized.report === undefined ? {} : { report: finalized.report }),
    ...(finalized.decision === undefined
      ? {}
      : { decision: finalized.decision }),
    cleanup: async () => {
      if (ownsRoot) await rm(rootDirectory, { recursive: true, force: true });
    },
  };
}

interface ExecuteWorkerLiveArmOptions {
  manifest: WorkerLiveManifest;
  live: boolean;
  pairIndex: number;
  armOrderIndex: number;
  rootDirectory: string;
  experiment: WorkerLiveExperimentMeter;
  modelFactory?: WorkerLiveModelFactory;
  signal?: AbortSignal;
}

/** Execute one natural runtime arm; failures become evidence instead of retries. */
export async function executeWorkerLiveArm(
  task: WorkerLiveTaskPlan,
  repetition: number,
  arm: WorkerLiveArmPlan,
  options: ExecuteWorkerLiveArmOptions,
): Promise<WorkerLiveArmRecord> {
  const { manifest } = options;
  validateWorkerLiveManifest(manifest);
  const pairId = `${task.taskId}:${repetition}`;
  const runId = `worker-live-${task.taskId}-${repetition}-${arm.id}`;
  const fixture = await createWorkerLiveFixture(task, options.rootDirectory);
  const dataDir = join(options.rootDirectory, "state");
  const toolTrace: WorkerLiveRecordedToolTraceEntry[] = [];
  const workspaceTools = createFrozenWorkspaceFixtureV2Tools({
    allowWrite: manifest.execution.allowWrite,
    protectedPaths: [resolve(dataDir)],
  });
  assertEvaluationToolContract(workspaceTools, false);
  const tools = traceWorkerLiveTools(workspaceTools, toolTrace, "main");
  const workerTools = traceWorkerLiveTools(workspaceTools, toolTrace, "worker");
  const meter = new WorkerLiveArmMeter(
    manifest,
    arm,
    runId,
    options.experiment,
  );
  const startedNs = process.hrtime.bigint();
  let runResult: RunExecutionResult | undefined;
  let finalText = "";
  let error: string | undefined;

  try {
    const physicalModel = options.live
      ? createOpenRouterModelPort()
      : options.modelFactory!({
        fixture: publicFixture(fixture),
        arm: structuredClone(arm),
        manifest,
        live: false,
      });
    const meteredPhysicalAttemptModel = new MeteredPhysicalAttemptModel(
      physicalModel,
      meter,
    );
    const model = new RetryingModelPort(meteredPhysicalAttemptModel, {
      maxAttempts: manifest.retryPolicy.providerMaxAttempts,
      baseDelayMs: manifest.retryPolicy.providerBaseDelayMs,
      maxDelayMs: manifest.retryPolicy.providerMaxDelayMs,
      ...(options.live ? {} : { sleep: async () => undefined }),
    });
    const armController = new AbortController();
    const armTimeout = setTimeout(() => armController.abort(
      new WorkerLiveBudgetError(
        `Arm wall-clock budget of ${arm.budget.maxWallClockMs}ms was exceeded`,
      ),
    ), arm.budget.maxWallClockMs);
    const signal = options.signal === undefined
      ? armController.signal
      : AbortSignal.any([options.signal, armController.signal]);
    try {
      const commonRequest = {
        workspace: fixture.workspace,
        dataDir,
        model: manifest.model.main,
        workerModel: manifest.model.worker,
        workerEnabled: arm.workerEnabled,
        auxiliaryMode: manifest.execution.auxiliaryMode,
        maxOutputTokens: manifest.execution.maxOutputTokensPerRequest,
        allowWrite: manifest.execution.allowWrite,
        allowShell: manifest.execution.allowShell,
        signal,
      } satisfies RunExecutionRequest;
      const deps = {
        mainModel: model,
        workerModel: model,
        tools,
        workerTools,
        createRunId: () => runId,
      } satisfies RunExecutionDeps;
      let activation = await executeRun({
        ...commonRequest,
        message: fixture.message,
        goal: fixture.goal,
        policy: {
          maxMainStepsPerActivation:
            manifest.execution.maxMainStepsPerActivation,
          maxModelTokens: arm.budget.maxModelTokens,
          tetoEnabled: false,
          workerEnabled: arm.workerEnabled,
          auxiliaryMode: manifest.execution.auxiliaryMode,
        },
      }, deps);
      let steps = activation.steps;
      runResult = { ...activation, steps };
      while (!activation.completed && activation.blocker === "resumable-boundary") {
        if (activation.steps === 0) {
          throw new Error("Run made no progress at a resumable boundary");
        }
        activation = await executeRun({
          ...commonRequest,
          resumeRunId: runId,
        }, deps);
        steps += activation.steps;
        runResult = { ...activation, steps };
      }
      finalText = runResult.finalText;
    } finally {
      clearTimeout(armTimeout);
    }
  } catch (caught: unknown) {
    error = persistedErrorText(caught);
  }

  const endedNs = process.hrtime.bigint();
  meter.finish(Number(endedNs - startedNs) / 1_000_000);
  const stateDir = runResult?.stateDir ?? join(dataDir, "runs", runId);
  const events = await readWorkerLiveEvents(stateDir, runId);
  const answerArtifact = await readWorkerLiveAnswerArtifact(stateDir, events);
  const taskGraph = projectTaskGraph(events, runId);
  const graph = graphEvidence(taskGraph);
  const intervals = meter.intervals();
  const snapshot = meter.snapshot();
  const logicalRequests = new Set(intervals.map((interval) => (
    interval.logicalRequestId
  ))).size;
  const ledgerRequests = projectRunMetrics(events, runId).total.modelRequests;
  if (
    error === undefined
    && !snapshot.budgetBreached
    && logicalRequests !== ledgerRequests
  ) {
    error = "Physical request evidence does not match Ledger model requests";
  }
  if (error === undefined && graph.anomalyCount > 0) {
    error = "TaskGraph contains anomalies";
  }
  if (
    error === undefined
    && graph.delegated + graph.terminal + graph.stale > 0
  ) {
    error = "TaskGraph contains unjoined or stale Worker tasks";
  }
  if (error === undefined && snapshot.budgetBreached) {
    error = snapshot.breachReason ?? "Arm budget exceeded";
  }
  if (error === undefined && runResult?.completed !== true) {
    error = "Run did not complete";
  }
  const completed = error === undefined && runResult?.completed === true;
  const quality = completed ? await fixture.score(finalText, toolTrace) : 0;
  const workerUsed = legalWorkerUse(taskGraph, intervals);
  const overlapMs = intervalOverlapMs(intervals);
  const outcome: WorkerLiveOutcome = {
    completed,
    failureKind: completed
      ? "none"
      : classifyFailure(error, events, snapshot.budgetBreached, runResult),
    budgetBreached: snapshot.budgetBreached,
    quality,
    requestCount: snapshot.requestCount,
    workerRequestCount: snapshot.workerRequestCount,
    inputTokens: snapshot.inputTokens,
    outputTokens: snapshot.outputTokens,
    cacheReadTokens: snapshot.cacheReadTokens,
    cacheWriteTokens: snapshot.cacheWriteTokens,
    costUsd: snapshot.costUsd,
    wallClockMs: snapshot.wallClockMs,
    requestP95LatencyMs: requestP95(intervals),
    cacheReadRatio: cacheReadRatio(intervals),
    workerUsed,
    overlapMs,
    overlapped: overlapMs > 0,
  };

  return {
    pairId,
    pairIndex: options.pairIndex,
    armOrderIndex: options.armOrderIndex,
    taskId: task.taskId,
    taskKind: task.kind,
    repetition,
    armId: arm.id,
    runId,
    timing: { startedNs: startedNs.toString(), endedNs: endedNs.toString() },
    ledgerDigest: hashJson(events),
    events: structuredClone(events),
    taskGraph,
    graph,
    requestIntervals: intervals,
    toolTrace: structuredClone(toolTrace),
    finalText,
    ...(answerArtifact === undefined ? {} : { answerArtifact }),
    ...(runResult === undefined ? {} : {
      runResult: {
        completed: runResult.completed,
        steps: runResult.steps,
        ...(runResult.blocker === undefined
          ? {}
          : { blocker: runResult.blocker }),
      },
    }),
    outcome,
    ...(error === undefined ? {} : { error }),
  };
}

interface WorkerLiveArmBudgetSnapshot {
  requestCount: number;
  workerRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  wallClockMs: number;
  budgetBreached: boolean;
  breachReason?: string;
}

interface OpenPhysicalAttempt {
  logicalRequestId: string;
  ordinal: number;
  attempt: number;
  laneId: "main" | "worker";
  model: string;
  sessionId: string;
  maxOutputTokens: number;
}

class MeteredPhysicalAttemptModel implements ModelPort {
  constructor(
    private readonly delegate: ModelPort,
    private readonly meter: WorkerLiveArmMeter,
  ) {}

  capabilities(model: string) {
    return this.delegate.capabilities?.(model) ?? { imageInput: false };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const attempt = this.meter.identify(request);
    const startedNs = process.hrtime.bigint();
    let usage: WorkerLiveProviderUsage | undefined;
    let providerCompleted = false;
    try {
      this.meter.admit(request);
      const response = await this.delegate.complete(request);
      usage = providerUsage(response.usage);
      this.meter.charge(usage);
      providerCompleted = true;
      return response;
    } finally {
      const endedNs = process.hrtime.bigint();
      this.meter.record({
        requestId: `${attempt.logicalRequestId}:attempt:${attempt.attempt}`,
        ...attempt,
        startedNs: startedNs.toString(),
        endedNs: endedNs.toString(),
        durationMs: Number(endedNs - startedNs) / 1_000_000,
        terminal: providerCompleted ? "completed" : "failed",
        ...(usage === undefined ? {} : { usage }),
      });
    }
  }
}

class WorkerLiveArmMeter {
  private readonly intervalRecords: WorkerLiveRequestInterval[] = [];
  private readonly logicalRequests = new WeakMap<object, {
    id: string;
    nextAttempt: number;
  }>();
  private nextLogicalOrdinal = 0;
  private nextPhysicalOrdinal = 0;
  private requestCount = 0;
  private workerRequestCount = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private costUsd = 0;
  private wallClockMs = 0;
  private breachReason: string | undefined;

  constructor(
    private readonly manifest: WorkerLiveManifest,
    private readonly arm: WorkerLiveArmPlan,
    private readonly runId: string,
    private readonly experiment: WorkerLiveExperimentMeter,
  ) {}

  identify(request: ModelRequest): OpenPhysicalAttempt {
    if (request.laneId !== "main" && request.laneId !== "worker") {
      throw new WorkerLiveContractError(
        `Unexpected evaluation lane ${request.laneId}`,
      );
    }
    let logical = this.logicalRequests.get(request);
    if (logical === undefined) {
      this.nextLogicalOrdinal += 1;
      logical = {
        id: `${this.runId}:${request.laneId}:logical:${this.nextLogicalOrdinal}`,
        nextAttempt: 1,
      };
      this.logicalRequests.set(request, logical);
    }
    const attempt = logical.nextAttempt;
    logical.nextAttempt += 1;
    this.nextPhysicalOrdinal += 1;
    return {
      logicalRequestId: logical.id,
      ordinal: this.nextPhysicalOrdinal,
      attempt,
      laneId: request.laneId,
      model: request.model,
      sessionId: request.sessionId,
      maxOutputTokens: request.maxOutputTokens,
    };
  }

  admit(request: ModelRequest): void {
    this.validateRequest(request);
    this.requestCount += 1;
    if (request.laneId === "worker") this.workerRequestCount += 1;
    let reason: string | undefined;
    if (this.requestCount > this.arm.budget.maxRequests) {
      reason = `Arm request budget of ${this.arm.budget.maxRequests} was exceeded`;
      this.breachReason ??= reason;
    }
    try {
      this.experiment.beforeRequest();
    } catch (error: unknown) {
      reason ??= persistedErrorText(error);
    }
    if (reason !== undefined) this.breachReason ??= reason;
    if (reason !== undefined) throw new WorkerLiveBudgetError(reason);
  }

  charge(usage: WorkerLiveProviderUsage): void {
    this.inputTokens += usage.input;
    this.outputTokens += usage.output;
    this.cacheReadTokens += usage.cacheRead;
    this.cacheWriteTokens += usage.cacheWrite;
    this.costUsd += usage.costUsd;
    let reason = this.perRunBreachReason();
    if (reason !== undefined) this.breachReason ??= reason;
    try {
      this.experiment.charge(usage);
    } catch (error: unknown) {
      reason ??= persistedErrorText(error);
    }
    if (reason !== undefined) this.breachReason ??= reason;
    if (reason !== undefined) throw new WorkerLiveBudgetError(reason);
  }

  finish(wallClockMs: number): void {
    this.wallClockMs = Math.max(0, wallClockMs);
    if (this.wallClockMs > this.arm.budget.maxWallClockMs) {
      this.breachReason ??=
        `Arm wall-clock budget of ${this.arm.budget.maxWallClockMs}ms was exceeded`;
    }
    this.experiment.chargeWallClock(this.wallClockMs);
  }

  record(interval: WorkerLiveRequestInterval): void {
    this.intervalRecords.push(structuredClone(interval));
  }

  intervals(): WorkerLiveRequestInterval[] {
    return [...this.intervalRecords]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((interval) => structuredClone(interval));
  }

  snapshot(): WorkerLiveArmBudgetSnapshot {
    const reason = this.perRunBreachReason();
    return {
      requestCount: this.requestCount,
      workerRequestCount: this.workerRequestCount,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      costUsd: this.costUsd,
      wallClockMs: this.wallClockMs,
      budgetBreached: reason !== undefined,
      ...(this.breachReason === undefined
        ? {}
        : { breachReason: this.breachReason }),
    };
  }

  private validateRequest(request: ModelRequest): void {
    if (request.runId !== this.runId) {
      throw new WorkerLiveContractError("Worker evaluation run id changed");
    }
    const expectedModel = request.laneId === "worker"
      ? this.manifest.model.worker
      : this.manifest.model.main;
    if (request.model !== expectedModel) {
      throw new WorkerLiveContractError(
        `Model ${request.model} does not match frozen pin ${expectedModel}`,
      );
    }
    if (
      !Number.isSafeInteger(request.maxOutputTokens)
      || request.maxOutputTokens < 1
      || request.maxOutputTokens > this.manifest.execution.maxOutputTokensPerRequest
    ) {
      throw new WorkerLiveContractError(
        `Requested output tokens ${request.maxOutputTokens} violate frozen per-request limit ${this.manifest.execution.maxOutputTokensPerRequest}`,
      );
    }
    assertWorkerLiveRequestTools(request, this.arm, this.manifest);
  }

  private perRunBreachReason(): string | undefined {
    const modelTokens = this.inputTokens
      + this.outputTokens
      + this.cacheReadTokens
      + this.cacheWriteTokens;
    if (this.requestCount > this.arm.budget.maxRequests) {
      return `Arm request budget of ${this.arm.budget.maxRequests} was exceeded`;
    }
    if (modelTokens > this.arm.budget.maxModelTokens) {
      return `Arm model token budget of ${this.arm.budget.maxModelTokens} was exceeded`;
    }
    if (this.inputTokens > this.arm.budget.maxInputTokens) {
      return `Arm input token budget of ${this.arm.budget.maxInputTokens} was exceeded`;
    }
    if (this.outputTokens > this.arm.budget.maxOutputTokens) {
      return `Arm output token budget of ${this.arm.budget.maxOutputTokens} was exceeded`;
    }
    if (this.costUsd > this.arm.budget.maxCostUsd) {
      return `Arm cost budget of $${this.arm.budget.maxCostUsd} was exceeded`;
    }
    if (this.wallClockMs > this.arm.budget.maxWallClockMs) {
      return `Arm wall-clock budget of ${this.arm.budget.maxWallClockMs}ms was exceeded`;
    }
    return undefined;
  }
}

class WorkerLiveExperimentMeter {
  private requestCount = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private costUsd = 0;
  private cumulativeWallClockMs = 0;
  private breachReason: string | undefined;

  constructor(
    private readonly manifest: WorkerLiveManifest,
    private readonly operatorCostStopThresholdUsd: number,
  ) {}

  canStart(): boolean {
    const budget = this.manifest.experimentBudget;
    return this.breachReason === undefined
      && this.requestCount < budget.maxRequests
      && this.modelTokens() < budget.maxModelTokens
      && this.inputTokens < budget.maxInputTokens
      && this.outputTokens < budget.maxOutputTokens
      && this.costUsd < Math.min(
        budget.maxCostUsd,
        this.operatorCostStopThresholdUsd,
      )
      && this.cumulativeWallClockMs < budget.maxCumulativeWallClockMs;
  }

  beforeRequest(): void {
    this.requestCount += 1;
    const reason = this.currentBreachReason();
    if (reason !== undefined) {
      this.breachReason ??= reason;
      throw new WorkerLiveBudgetError(reason);
    }
  }

  charge(usage: WorkerLiveProviderUsage): void {
    this.inputTokens += usage.input;
    this.outputTokens += usage.output;
    this.cacheReadTokens += usage.cacheRead;
    this.cacheWriteTokens += usage.cacheWrite;
    this.costUsd += usage.costUsd;
    const reason = this.currentBreachReason();
    if (reason !== undefined) {
      this.breachReason ??= reason;
      throw new WorkerLiveBudgetError(reason);
    }
  }

  chargeWallClock(wallClockMs: number): void {
    this.cumulativeWallClockMs += Math.max(0, wallClockMs);
    const reason = this.currentBreachReason();
    if (reason !== undefined) this.breachReason ??= reason;
  }

  private modelTokens(): number {
    return this.inputTokens
      + this.outputTokens
      + this.cacheReadTokens
      + this.cacheWriteTokens;
  }

  private currentBreachReason(): string | undefined {
    const budget = this.manifest.experimentBudget;
    if (this.requestCount > budget.maxRequests) {
      return "Whole-experiment request budget exceeded";
    }
    if (this.modelTokens() > budget.maxModelTokens) {
      return "Whole-experiment model token budget exceeded";
    }
    if (this.inputTokens > budget.maxInputTokens) {
      return "Whole-experiment input token budget exceeded";
    }
    if (this.outputTokens > budget.maxOutputTokens) {
      return "Whole-experiment output token budget exceeded";
    }
    if (this.costUsd > Math.min(
      budget.maxCostUsd,
      this.operatorCostStopThresholdUsd,
    )) {
      return "Whole-experiment cost soft-stop threshold exceeded";
    }
    if (this.cumulativeWallClockMs > budget.maxCumulativeWallClockMs) {
      return "Whole-experiment wall-clock budget exceeded";
    }
    return undefined;
  }
}

interface FinalizedWorkerLiveEvaluation {
  checkpoint: WorkerLiveEvidenceCheckpoint;
  rows: WorkerLivePairedRow[];
  report?: WorkerLiveReport;
  decision?: WorkerLiveDecision;
}

async function finalizeEvaluation(
  manifest: WorkerLiveManifest,
  evaluationId: string,
  startedAt: string,
  repository: WorkerLiveRepositoryState,
  operatorCostStopThresholdUsd: number,
  records: readonly WorkerLiveArmRecord[],
): Promise<FinalizedWorkerLiveEvaluation> {
  const experimentUsage = summarizeExperimentUsage(
    records,
    manifest,
    operatorCostStopThresholdUsd,
  );
  const checkpoint = buildWorkerLiveCheckpoint(
    manifest,
    evaluationId,
    startedAt,
    repository,
    experimentUsage,
    records,
  );
  const rows = workerLivePairRows(records, manifest);
  const complete = rows.length === manifest.sampleCount
    && records.length === manifest.sampleCount * WORKER_LIVE_ARMS.length;
  if (!complete || !repository.clean || !repository.baselineIsAncestor) {
    return { checkpoint, rows };
  }
  const completedAt = new Date().toISOString();
  const report = buildWorkerLiveReport(manifest, rows, {
    evaluationId,
    startedAt,
    completedAt,
    repositoryDirty: false,
    baselineIsAncestor: true,
    executionCommit: repository.executionCommit,
    evidenceDigest: checkpoint.evidenceDigest,
  });
  const decision = evaluateWorkerLiveDecision(manifest, report);
  return { checkpoint, rows, report, decision };
}

function buildWorkerLiveCheckpoint(
  manifest: WorkerLiveManifest,
  evaluationId: string,
  startedAt: string,
  repository: WorkerLiveRepositoryState,
  experimentUsage: WorkerLiveExperimentSnapshot,
  records: readonly WorkerLiveArmRecord[],
): WorkerLiveEvidenceCheckpoint {
  const evidence = {
    schemaVersion: WORKER_LIVE_SCHEMA_VERSION,
    manifestHash: manifest.manifestHash,
    evaluationId,
    startedAt,
    repository: structuredClone(repository),
    experimentUsage: structuredClone(experimentUsage),
    records: structuredClone(records),
  };
  return {
    ...evidence,
    evidenceDigest: hashJson(evidence),
  };
}

function summarizeExperimentUsage(
  records: readonly WorkerLiveArmRecord[],
  manifest: WorkerLiveManifest,
  operatorCostStopThresholdUsd: number,
): WorkerLiveExperimentSnapshot {
  const usage = records.reduce((total, record) => ({
    requestCount: total.requestCount + record.outcome.requestCount,
    modelTokens: total.modelTokens
      + record.outcome.inputTokens
      + record.outcome.outputTokens
      + record.outcome.cacheReadTokens
      + record.outcome.cacheWriteTokens,
    inputTokens: total.inputTokens + record.outcome.inputTokens,
    outputTokens: total.outputTokens + record.outcome.outputTokens,
    cacheReadTokens: total.cacheReadTokens + record.outcome.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + record.outcome.cacheWriteTokens,
    costUsd: total.costUsd + record.outcome.costUsd,
    cumulativeWallClockMs: total.cumulativeWallClockMs + record.outcome.wallClockMs,
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
  const budget = manifest.experimentBudget;
  const breached = usage.requestCount > budget.maxRequests
    || usage.modelTokens > budget.maxModelTokens
    || usage.inputTokens > budget.maxInputTokens
    || usage.outputTokens > budget.maxOutputTokens
    || usage.costUsd > Math.min(
      budget.maxCostUsd,
      operatorCostStopThresholdUsd,
    )
    || usage.cumulativeWallClockMs > budget.maxCumulativeWallClockMs;
  return {
    ...usage,
    operatorCostStopThresholdUsd,
    exhausted: !breached && (
      usage.requestCount >= budget.maxRequests
      || usage.modelTokens >= budget.maxModelTokens
      || usage.inputTokens >= budget.maxInputTokens
      || usage.outputTokens >= budget.maxOutputTokens
      || usage.costUsd >= Math.min(
        budget.maxCostUsd,
        operatorCostStopThresholdUsd,
      )
      || usage.cumulativeWallClockMs >= budget.maxCumulativeWallClockMs
    ),
    budgetBreached: breached,
    ...(breached ? { breachReason: "Whole-experiment budget exceeded" } : {}),
  };
}

function workerLivePairRows(
  records: readonly WorkerLiveArmRecord[],
  manifest: WorkerLiveManifest,
): WorkerLivePairedRow[] {
  const expectedPairs = workerLivePairOrder(manifest);
  const groups = new Map<string, WorkerLiveArmRecord[]>();
  for (const record of records) {
    const pair = groups.get(record.pairId) ?? [];
    if (pair.some((candidate) => candidate.armId === record.armId)) {
      throw new WorkerLiveContractError(
        `Duplicate Worker live arm record ${record.pairId}/${record.armId}`,
      );
    }
    pair.push(record);
    groups.set(record.pairId, pair);
  }
  const rows: WorkerLivePairedRow[] = [];
  for (const [pairIndex, pair] of expectedPairs.entries()) {
    const pairId = `${pair.task.taskId}:${pair.repetition}`;
    const group = groups.get(pairId);
    if (group === undefined || group.length !== WORKER_LIVE_ARMS.length) continue;
    if (group.some((record) => record.pairIndex !== pairIndex)) {
      throw new WorkerLiveContractError(`Worker live pair index changed for ${pairId}`);
    }
    const outcomes = Object.fromEntries(group.map((record) => [record.armId, record.outcome])) as Record<WorkerLiveArmId, WorkerLiveOutcome>;
    if (WORKER_LIVE_ARMS.some((armId) => outcomes[armId] === undefined)) continue;
    rows.push({
      pairId,
      taskId: pair.task.taskId,
      taskKind: pair.task.kind,
      repetition: pair.repetition,
      outcomes,
    });
  }
  return rows.sort((left, right) => left.pairId.localeCompare(right.pairId));
}

async function persistWorkerLiveArtifacts(
  artifactDirectory: string,
  manifest: WorkerLiveManifest,
  evaluationId: string,
  startedAt: string,
  repository: WorkerLiveRepositoryState,
  operatorCostStopThresholdUsd: number,
  records: readonly WorkerLiveArmRecord[],
): Promise<void> {
  const checkpoint = buildWorkerLiveCheckpoint(
    manifest,
    evaluationId,
    startedAt,
    repository,
    summarizeExperimentUsage(
      records,
      manifest,
      operatorCostStopThresholdUsd,
    ),
    records,
  );
  const reportPath = join(artifactDirectory, "report.json");
  // A partial probe is deliberately represented by raw evidence only.
  await unlink(reportPath).catch((error: unknown) => {
    if (!isNotFound(error)) throw error;
  });
  await atomicWriteJson(join(artifactDirectory, "raw", "records.json"), checkpoint);
}

async function writeWorkerLiveArtifactEnvelope(
  artifactDirectory: string,
  manifest: WorkerLiveManifest,
  checkpoint: WorkerLiveEvidenceCheckpoint,
  rows: readonly WorkerLivePairedRow[],
  report: WorkerLiveReport | undefined,
  decision: WorkerLiveDecision | undefined,
): Promise<void> {
  if (report === undefined || decision === undefined) {
    await unlink(join(artifactDirectory, "report.json")).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
    await atomicWriteJson(join(artifactDirectory, "raw", "records.json"), checkpoint);
    return;
  }
  if (rows.length !== manifest.sampleCount) {
    throw new WorkerLiveContractError("Cannot persist a report for partial evidence");
  }
  await atomicWriteJson(join(artifactDirectory, "raw", "records.json"), checkpoint);
  await atomicWriteJson(join(artifactDirectory, "report.json"), {
    evidenceDigest: checkpoint.evidenceDigest,
    report,
    decision,
  });
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
  }
}

function isNotFound(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

function graphEvidence(projection: TaskGraphProjection): WorkerLiveGraphEvidence {
  let delegated = 0;
  let terminal = 0;
  let joined = 0;
  let stale = 0;
  let partial = 0;
  let failed = 0;
  const joins = new Map<string, number>();
  for (const task of projection.tasks) {
    switch (task.state.kind) {
      case "delegated":
        delegated += 1;
        break;
      case "terminal":
        terminal += 1;
        break;
      case "joined":
        joined += 1;
        joins.set(
          task.state.join.eventId,
          (joins.get(task.state.join.eventId) ?? 0) + 1,
        );
        break;
      case "stale":
        stale += 1;
        break;
    }
    const terminalView = task.state.kind === "terminal"
      || task.state.kind === "joined"
      ? task.state.terminal
      : task.state.kind === "stale"
        ? task.state.terminal
        : undefined;
    if (terminalView?.payload.type === "task.failed") failed += 1;
    if (
      terminalView?.payload.type === "task.result"
      && terminalView.payload.status === "partial"
    ) partial += 1;
  }
  return {
    taskCount: projection.tasks.length,
    delegated,
    terminal,
    joined,
    stale,
    partial,
    failed,
    anomalyCount: projection.anomalies.length,
    maximumFanIn: Math.max(0, ...joins.values()),
  };
}

function intervalOverlapMs(
  intervals: readonly WorkerLiveRequestInterval[],
): number {
  const main = intervals.filter((interval) => interval.laneId === "main");
  const worker = intervals.filter((interval) => interval.laneId === "worker");
  let overlapNs = 0n;
  for (const left of main) {
    for (const right of worker) {
      const start = maxBigInt(BigInt(left.startedNs), BigInt(right.startedNs));
      const end = minBigInt(BigInt(left.endedNs), BigInt(right.endedNs));
      if (end > start) overlapNs += end - start;
    }
  }
  return Number(overlapNs) / 1_000_000;
}

function requestP95(intervals: readonly WorkerLiveRequestInterval[]): number {
  const durations = intervals.map((interval) => interval.durationMs)
    .sort((left, right) => left - right);
  if (durations.length === 0) return 0;
  return durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)]!;
}

function cacheReadRatio(
  intervals: readonly WorkerLiveRequestInterval[],
): number | null {
  const usage = intervals.flatMap((interval) => (
    interval.usage === undefined ? [] : [interval.usage]
  ));
  if (usage.length === 0) return null;
  const input = usage.reduce((sum, value) => sum + value.input, 0);
  const cacheRead = usage.reduce((sum, value) => sum + value.cacheRead, 0);
  const cacheWrite = usage.reduce((sum, value) => sum + value.cacheWrite, 0);
  const denominator = input + cacheRead + cacheWrite;
  return denominator === 0 ? 0 : cacheRead / denominator;
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function classifyFailure(
  error: string | undefined,
  events: readonly AnyEvent[],
  budgetBreached: boolean,
  runResult: Pick<RunExecutionResult, "completed"> | undefined,
): WorkerLiveFailureKind {
  const normalizedError = error?.toLowerCase();
  if (budgetBreached) {
    return normalizedError?.includes("wall-clock")
      ? "timeout"
      : "budget";
  }
  if (normalizedError?.includes("timeout")
    || normalizedError?.includes("aborted")
    || normalizedError?.includes("deadline")) {
    return "timeout";
  }
  if (normalizedError?.includes("budget")
    || normalizedError?.includes("cost soft-stop threshold")) return "budget";
  if (events.some((event) => event.type === "model.failed")) return "provider";
  if (runResult !== undefined && !runResult.completed) return "incomplete";
  if (normalizedError?.includes("provider")
    || normalizedError?.includes("model")) return "provider";
  return "runtime";
}

async function inspectWorkerLiveRepository(
  baselineCommit: string,
): Promise<WorkerLiveRepositoryState> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const cwd = resolve(process.cwd());
  const status = await run(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd },
  );
  const head = await run("git", ["rev-parse", "HEAD"], { cwd });
  const ancestor = await run(
    "git",
    ["merge-base", "--is-ancestor", baselineCommit, "HEAD"],
    { cwd,
  }).then(() => true, () => false);
  return {
    executionCommit: head.stdout.trim(),
    clean: status.stdout.trim().length === 0,
    baselineIsAncestor: ancestor,
  };
}

function createDeadline(deadlineMs: number | undefined): {
  signal: AbortSignal;
  dispose(): void;
} | undefined {
  if (deadlineMs === undefined) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(
    new WorkerLiveBudgetError(
      `Worker live evaluation deadline of ${deadlineMs}ms was exceeded`,
    ),
  ), deadlineMs);
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

function validateRunnerOptions(
  options: WorkerLiveRunnerOptions,
  manifest: WorkerLiveManifest,
): void {
  if (options.maxPairs !== undefined && (
    !Number.isSafeInteger(options.maxPairs)
    || options.maxPairs < 1
    || options.maxPairs > manifest.sampleCount
  )) {
    throw new RangeError(
      `maxPairs must be an integer between 1 and ${manifest.sampleCount}`,
    );
  }
  if (options.deadlineMs !== undefined && (
    !Number.isFinite(options.deadlineMs)
    || options.deadlineMs <= 0
  )) {
    throw new RangeError("deadlineMs must be a positive finite number");
  }
  if (options.evaluationId !== undefined) {
    validateEvaluationId(options.evaluationId);
  }
}

function validateEvaluationId(evaluationId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(evaluationId)) {
    throw new WorkerLiveContractError(
      "evaluationId must be 1-80 path-safe characters",
    );
  }
}

function commitHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

/** Verify raw evidence independently, then rebuild any complete report. */
export async function verifyWorkerLiveArtifacts(
  artifactDirectory: string,
): Promise<VerifiedWorkerLiveArtifacts> {
  const manifest = WORKER_LIVE_MANIFEST;
  validateWorkerLiveManifest(manifest);
  const directory = resolve(artifactDirectory);
  const checkpointValue = await readJsonArtifact(
    join(directory, "raw", "records.json"),
  );
  const checkpoint = validateWorkerLiveCheckpoint(checkpointValue, manifest);
  const scoringRoot = await mkdtemp(join(tmpdir(), "nausicaa-worker-live-verify-"));
  let records: WorkerLiveArmRecord[];
  try {
    records = [];
    for (const [index, value] of checkpoint.records.entries()) {
      records.push(await validateWorkerLiveArmRecord(
        value,
        index,
        manifest,
        scoringRoot,
      ));
    }
  } finally {
    await rm(scoringRoot, { recursive: true, force: true });
  }
  const rebuiltUsage = summarizeExperimentUsage(
    records,
    manifest,
    checkpoint.experimentUsage.operatorCostStopThresholdUsd,
  );
  if (hashJson(rebuiltUsage) !== hashJson(checkpoint.experimentUsage)) {
    throw new WorkerLiveContractError(
      "Worker live experiment usage does not match raw arm evidence",
    );
  }
  const rebuiltCheckpoint = buildWorkerLiveCheckpoint(
    manifest,
    checkpoint.evaluationId,
    checkpoint.startedAt,
    checkpoint.repository,
    rebuiltUsage,
    records,
  );
  if (rebuiltCheckpoint.evidenceDigest !== checkpoint.evidenceDigest) {
    throw new WorkerLiveContractError(
      "Worker live evidence digest does not match rebuilt records",
    );
  }

  const rows = workerLivePairRows(records, manifest);
  const failures = records.filter((record) => !record.outcome.completed);
  const envelopeValue = await readOptionalJsonArtifact(join(directory, "report.json"));
  if (envelopeValue === undefined) {
    if (
      rows.length === manifest.sampleCount
      && records.length === manifest.sampleCount * WORKER_LIVE_ARMS.length
      && checkpoint.repository.clean
      && checkpoint.repository.baselineIsAncestor
    ) {
      throw new WorkerLiveContractError(
        "Complete Worker live evidence is missing its report",
      );
    }
    return {
      artifactDirectory: directory,
      evidenceDigest: checkpoint.evidenceDigest,
      recordCount: records.length,
      sampleCount: rows.length,
      failureCount: failures.length,
      complete: false,
      incompleteReason: incompleteReason(checkpoint, rows.length, manifest),
    };
  }
  if (!isRecord(envelopeValue)
    || !isRecord(envelopeValue.report)
    || !isRecord(envelopeValue.decision)
    || envelopeValue.evidenceDigest !== checkpoint.evidenceDigest) {
    throw new WorkerLiveContractError("Worker live report envelope is malformed");
  }
  if (!checkpoint.repository.clean || !checkpoint.repository.baselineIsAncestor) {
    throw new WorkerLiveContractError(
      "Worker live report cannot use dirty or non-ancestor provenance",
    );
  }
  if (
    rows.length !== manifest.sampleCount
    || records.length !== manifest.sampleCount * WORKER_LIVE_ARMS.length
  ) {
    throw new WorkerLiveContractError(
      "Partial Worker live evidence cannot contain a report or decision",
    );
  }
  const persistedReport = envelopeValue.report as unknown as WorkerLiveReport;
  validateWorkerLiveReport(manifest, persistedReport);
  if (
    persistedReport.provenance.evidenceDigest !== checkpoint.evidenceDigest
    || persistedReport.provenance.evaluationId !== checkpoint.evaluationId
    || persistedReport.provenance.startedAt !== checkpoint.startedAt
    || persistedReport.provenance.executionCommit
      !== checkpoint.repository.executionCommit
    || hashJson(persistedReport.rows) !== hashJson(rows)
  ) {
    throw new WorkerLiveContractError(
      "Worker live report provenance does not match raw evidence",
    );
  }
  const rebuiltReport = buildWorkerLiveReport(manifest, rows, {
    evaluationId: checkpoint.evaluationId,
    startedAt: checkpoint.startedAt,
    completedAt: persistedReport.provenance.completedAt,
    repositoryDirty: false,
    baselineIsAncestor: true,
    executionCommit: checkpoint.repository.executionCommit,
    evidenceDigest: checkpoint.evidenceDigest,
  });
  if (hashJson(rebuiltReport) !== hashJson(persistedReport)) {
    throw new WorkerLiveContractError(
      "Worker live report does not match independently rebuilt evidence",
    );
  }
  const decision = evaluateWorkerLiveDecision(manifest, rebuiltReport);
  if (hashJson(decision) !== hashJson(envelopeValue.decision)) {
    throw new WorkerLiveContractError(
      "Worker live decision does not match the rebuilt report",
    );
  }
  return {
    artifactDirectory: directory,
    evidenceDigest: checkpoint.evidenceDigest,
    recordCount: records.length,
    sampleCount: rows.length,
    failureCount: failures.length,
    complete: true,
    decision,
  };
}

function validateWorkerLiveCheckpoint(
  value: unknown,
  manifest: WorkerLiveManifest,
): WorkerLiveEvidenceCheckpoint {
  if (!isRecord(value)
    || value.schemaVersion !== WORKER_LIVE_SCHEMA_VERSION
    || value.manifestHash !== manifest.manifestHash
    || typeof value.evaluationId !== "string"
    || typeof value.startedAt !== "string"
    || !isRecord(value.repository)
    || !isRecord(value.experimentUsage)
    || !Array.isArray(value.records)
    || typeof value.evidenceDigest !== "string") {
    throw new WorkerLiveContractError("Worker live evidence checkpoint is malformed");
  }
  validateEvaluationId(value.evaluationId);
  if (!Number.isFinite(Date.parse(value.startedAt))) {
    throw new WorkerLiveContractError("Worker live checkpoint start time is invalid");
  }
  const repository = value.repository;
  if (!commitHash(repository.executionCommit)
    || typeof repository.clean !== "boolean"
    || typeof repository.baselineIsAncestor !== "boolean") {
    throw new WorkerLiveContractError("Worker live repository provenance is malformed");
  }
  const usage = value.experimentUsage;
  if (!finitePositive(usage.operatorCostStopThresholdUsd)
    || usage.operatorCostStopThresholdUsd > manifest.experimentBudget.maxCostUsd) {
    throw new WorkerLiveContractError(
      "Worker live operator cost soft-stop threshold is invalid",
    );
  }
  const { evidenceDigest, ...evidence } = value;
  if (hashJson(evidence) !== evidenceDigest) {
    throw new WorkerLiveContractError(
      "Worker live evidence digest does not match its checkpoint",
    );
  }
  return value as unknown as WorkerLiveEvidenceCheckpoint;
}

async function validateWorkerLiveArmRecord(
  value: unknown,
  recordIndex: number,
  manifest: WorkerLiveManifest,
  scoringRoot: string,
): Promise<WorkerLiveArmRecord> {
  if (!isRecord(value)) {
    throw new WorkerLiveContractError("Worker live arm record is malformed");
  }
  const expected = expectedArmAt(manifest, recordIndex);
  if (expected === undefined) {
    throw new WorkerLiveContractError("Worker live evidence has too many arm records");
  }
  const pairId = `${expected.task.taskId}:${expected.repetition}`;
  if (value.pairId !== pairId
    || value.pairIndex !== expected.pairIndex
    || value.armOrderIndex !== expected.armOrderIndex
    || value.taskId !== expected.task.taskId
    || value.taskKind !== expected.task.kind
    || value.repetition !== expected.repetition
    || value.armId !== expected.arm.id
    || value.runId !== `worker-live-${expected.task.taskId}-${expected.repetition}-${expected.arm.id}`
    || !isRecord(value.timing)
    || !Array.isArray(value.events)
    || !Array.isArray(value.requestIntervals)
    || !Array.isArray(value.toolTrace)
    || !isRecord(value.taskGraph)
    || !isRecord(value.graph)
    || !isRecord(value.outcome)
    || typeof value.finalText !== "string"
    || typeof value.ledgerDigest !== "string"
    || (value.answerArtifact !== undefined && !isRecord(value.answerArtifact))
    || (value.error !== undefined && typeof value.error !== "string")) {
    throw new WorkerLiveContractError(
      `Worker live arm record ${recordIndex} has invalid identity or shape`,
    );
  }
  const startedNs = bigintText(value.timing.startedNs, "timing.startedNs");
  const endedNs = bigintText(value.timing.endedNs, "timing.endedNs");
  if (endedNs < startedNs) {
    throw new WorkerLiveContractError("Worker live arm timing runs backwards");
  }

  const events = value.events as unknown[];
  for (const event of events) validateEvent(event);
  const typedEvents = events as AnyEvent[];
  if (typedEvents.some((event) => event.runId !== value.runId)) {
    throw new WorkerLiveContractError("Worker live Ledger contains another run");
  }
  new LedgerState(structuredClone(typedEvents));
  if (value.ledgerDigest !== hashJson(typedEvents)) {
    throw new WorkerLiveContractError("Worker live Ledger digest is invalid");
  }
  const taskGraph = projectTaskGraph(typedEvents, value.runId as string);
  if (hashJson(taskGraph) !== hashJson(value.taskGraph)) {
    throw new WorkerLiveContractError("Worker live TaskGraph projection was tampered");
  }
  const graph = graphEvidence(taskGraph);
  if (hashJson(graph) !== hashJson(value.graph)) {
    throw new WorkerLiveContractError("Worker live TaskGraph evidence was tampered");
  }

  const intervals = validateRequestIntervals(
    value.requestIntervals,
    value.runId as string,
    expected.arm,
    manifest,
  );
  const logicalRequestCount = new Set(intervals.map((interval) => (
    interval.logicalRequestId
  ))).size;
  const metrics = projectRunMetrics(typedEvents, value.runId as string);
  if (logicalRequestCount !== metrics.total.modelRequests) {
    throw new WorkerLiveContractError(
      "Worker live physical intervals do not match Ledger logical requests",
    );
  }
  validateIntervalsAgainstLedger(
    intervals,
    typedEvents,
    startedNs,
    endedNs,
    manifest,
  );
  const toolTrace = validateToolTrace(value.toolTrace);
  validateToolTraceAgainstLedger(toolTrace, typedEvents);
  const runResult = validateRunResult(value.runResult);
  validateRunResultAgainstLedger(runResult, typedEvents);
  const answerArtifact = validateAnswerArtifact(
    value.answerArtifact,
    typedEvents,
    runResult,
    value.finalText as string,
  );
  const wallClockMs = Number(endedNs - startedNs) / 1_000_000;
  const usage = sumIntervalUsage(intervals);
  const budgetBreached = perRunBudgetBreached(
    usage,
    intervals.length,
    wallClockMs,
    expected.arm,
  );
  const structuralFailure = graph.anomalyCount > 0
    || graph.delegated + graph.terminal + graph.stale > 0;
  if ((structuralFailure || runResult?.completed !== true || budgetBreached)
    && value.error === undefined) {
    throw new WorkerLiveContractError(
      "Worker live failed arm is missing its failure evidence",
    );
  }
  const completed = value.error === undefined && runResult?.completed === true;
  const fixture = await createWorkerLiveFixture(
    expected.task,
    join(scoringRoot, `${recordIndex}`),
  );
  const quality = completed
    ? await fixture.score(value.finalText as string, toolTrace)
    : 0;
  const overlapMs = intervalOverlapMs(intervals);
  const expectedOutcome: WorkerLiveOutcome = {
    completed,
    failureKind: completed
      ? "none"
      : classifyFailure(
        value.error as string | undefined,
        typedEvents,
        budgetBreached,
        runResult,
      ),
    budgetBreached,
    quality,
    requestCount: intervals.length,
    workerRequestCount: intervals.filter((interval) => (
      interval.laneId === "worker"
    )).length,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    costUsd: usage.costUsd,
    wallClockMs,
    requestP95LatencyMs: requestP95(intervals),
    cacheReadRatio: cacheReadRatio(intervals),
    workerUsed: legalWorkerUse(taskGraph, intervals),
    overlapMs,
    overlapped: overlapMs > 0,
  };
  if (hashJson(expectedOutcome) !== hashJson(value.outcome)) {
    throw new WorkerLiveContractError(
      "Worker live outcome does not match raw Ledger and interval evidence",
    );
  }
  if (completed) validateCompletedUsage(metrics, usage);
  if (runResult?.completed === true && answerArtifact === undefined) {
    throw new WorkerLiveContractError(
      "Completed Worker live Run is missing answer artifact evidence",
    );
  }
  return value as unknown as WorkerLiveArmRecord;
}

function validateRequestIntervals(
  values: readonly unknown[],
  runId: string,
  arm: WorkerLiveArmPlan,
  manifest: WorkerLiveManifest,
): WorkerLiveRequestInterval[] {
  const intervals: WorkerLiveRequestInterval[] = [];
  const attempts = new Map<string, number[]>();
  for (const [index, value] of values.entries()) {
    if (!isRecord(value)
      || typeof value.requestId !== "string"
      || typeof value.logicalRequestId !== "string"
      || value.ordinal !== index + 1
      || !Number.isSafeInteger(value.attempt)
      || (value.attempt as number) < 1
      || (value.laneId !== "main" && value.laneId !== "worker")
      || value.model !== (value.laneId === "worker"
        ? manifest.model.worker
        : manifest.model.main)
      || typeof value.sessionId !== "string"
      || value.sessionId.length === 0
      || !Number.isSafeInteger(value.maxOutputTokens)
      || (value.maxOutputTokens as number) < 1
      || (value.maxOutputTokens as number)
        > manifest.execution.maxOutputTokensPerRequest
      || typeof value.durationMs !== "number"
      || !Number.isFinite(value.durationMs)
      || value.durationMs < 0
      || (value.terminal !== "completed" && value.terminal !== "failed")) {
      throw new WorkerLiveContractError("Worker live request interval is malformed");
    }
    const startedNs = bigintText(value.startedNs, "interval.startedNs");
    const endedNs = bigintText(value.endedNs, "interval.endedNs");
    if (endedNs < startedNs
      || value.durationMs !== Number(endedNs - startedNs) / 1_000_000
      || !value.logicalRequestId.startsWith(`${runId}:${value.laneId}:logical:`)
      || value.requestId
        !== `${value.logicalRequestId}:attempt:${value.attempt}`) {
      throw new WorkerLiveContractError(
        "Worker live request interval identity or duration is inconsistent",
      );
    }
    if (!arm.workerEnabled && value.laneId === "worker") {
      throw new WorkerLiveContractError("Control arm contains a Worker request");
    }
    if (value.usage !== undefined) validateProviderUsage(value.usage);
    const interval = value as unknown as WorkerLiveRequestInterval;
    intervals.push(structuredClone(interval));
    const seen = attempts.get(interval.logicalRequestId) ?? [];
    seen.push(interval.attempt);
    attempts.set(interval.logicalRequestId, seen);
  }
  for (const seen of attempts.values()) {
    const ordered = [...seen].sort((left, right) => left - right);
    if (ordered.length > manifest.retryPolicy.providerMaxAttempts
      || ordered.some((attempt, index) => attempt !== index + 1)) {
      throw new WorkerLiveContractError(
        "Worker live retry attempts violate the frozen policy",
      );
    }
  }
  for (const logicalRequestId of attempts.keys()) {
    const group = intervals.filter((interval) => (
      interval.logicalRequestId === logicalRequestId
    ));
    const first = group[0]!;
    if (group.some((interval) => (
      interval.laneId !== first.laneId
      || interval.model !== first.model
      || interval.sessionId !== first.sessionId
      || interval.maxOutputTokens !== first.maxOutputTokens
    ))) {
      throw new WorkerLiveContractError(
        "Worker live retry attempts changed logical request identity",
      );
    }
    if (group.slice(0, -1).some((interval) => interval.terminal !== "failed")) {
      throw new WorkerLiveContractError(
        "Worker live retry continued after a completed physical attempt",
      );
    }
    for (const interval of group) {
      if (interval.terminal === "completed" && interval.usage === undefined) {
        throw new WorkerLiveContractError(
          "Worker live interval terminal does not match provider usage",
        );
      }
    }
  }
  return intervals;
}

function validateIntervalsAgainstLedger(
  intervals: readonly WorkerLiveRequestInterval[],
  events: readonly AnyEvent[],
  armStartedNs: bigint,
  armEndedNs: bigint,
  manifest: WorkerLiveManifest,
): void {
  for (const interval of intervals) {
    if (
      BigInt(interval.startedNs) < armStartedNs
      || BigInt(interval.endedNs) > armEndedNs
    ) {
      throw new WorkerLiveContractError(
        "Worker live request interval is outside its arm timing",
      );
    }
  }
  const requested = events.filter((event): event is Extract<
    AnyEvent,
    { type: "model.requested" }
  > => event.type === "model.requested");
  for (const laneId of ["main", "worker"] as const) {
    const laneEvents = requested.filter((event) => event.laneId === laneId)
      .sort((left, right) => left.globalOffset - right.globalOffset);
    const laneGroups = logicalIntervalGroups(intervals)
      .filter((group) => group[0]!.laneId === laneId)
      .sort((left, right) => left[0]!.ordinal - right[0]!.ordinal);
    if (laneGroups.length !== laneEvents.length) {
      throw new WorkerLiveContractError(
        `Worker live ${laneId} intervals do not match Ledger requests`,
      );
    }
    for (const [index, event] of laneEvents.entries()) {
      const group = laneGroups[index]!;
      const first = group[0]!;
      const last = group.at(-1)!;
      const terminalEvidence = ledgerRequestTerminal(event, events);
      if (first.model !== event.payload.model
        || first.sessionId !== event.payload.sessionId
        || first.model !== (laneId === "worker"
          ? manifest.model.worker
          : manifest.model.main)
        || terminalEvidence.terminal !== last.terminal
        || (terminalEvidence.usage !== undefined
          && hashJson(terminalEvidence.usage) !== hashJson(last.usage))) {
        throw new WorkerLiveContractError(
          "Worker live interval model/session/terminal does not match Ledger",
        );
      }
    }
  }
}

function legalWorkerUse(
  taskGraph: TaskGraphProjection,
  intervals: readonly WorkerLiveRequestInterval[],
): boolean {
  const completedWorkerSessions = new Set(logicalIntervalGroups(intervals)
    .filter((group) => (
      group[0]!.laneId === "worker"
      && group.at(-1)!.terminal === "completed"
    ))
    .map((group) => group[0]!.sessionId));
  return taskGraph.tasks.some((task) => (
    task.state.kind === "joined"
    && task.state.terminal.payload.type === "task.result"
    && task.state.terminal.payload.status === "completed"
    && [...completedWorkerSessions].some((sessionId) => (
      sessionId.endsWith(`:task:${task.taskId}`)
    ))
  ));
}

function logicalIntervalGroups(
  intervals: readonly WorkerLiveRequestInterval[],
): WorkerLiveRequestInterval[][] {
  const groups = new Map<string, WorkerLiveRequestInterval[]>();
  for (const interval of intervals) {
    const group = groups.get(interval.logicalRequestId) ?? [];
    group.push(interval);
    groups.set(interval.logicalRequestId, group);
  }
  return [...groups.values()].map((group) => (
    group.sort((left, right) => left.attempt - right.attempt)
  ));
}

function ledgerRequestTerminal(
  request: Extract<AnyEvent, { type: "model.requested" }>,
  events: readonly AnyEvent[],
): {
  terminal: WorkerLiveRequestInterval["terminal"];
  usage?: WorkerLiveProviderUsage;
} {
  const prefix = request.idempotencyKey.slice(
    0,
    -":model:requested".length,
  );
  const completed = events.find((event): event is Extract<
    AnyEvent,
    { type: "model.completed" }
  > => (
    event.type === "model.completed"
    && event.laneId === request.laneId
    && event.idempotencyKey === `${prefix}:model:completed`
  ));
  const failed = events.some((event) => (
    event.type === "model.failed"
    && event.laneId === request.laneId
    && event.idempotencyKey === `${prefix}:model:failed`
  ));
  if ((completed !== undefined) === failed) {
    throw new WorkerLiveContractError(
      "Worker live Ledger request has missing or conflicting terminal evidence",
    );
  }
  if (completed === undefined) return { terminal: "failed" };
  const usage = providerUsage(completed.payload.usage);
  const budget = events.find((event): event is Extract<
    AnyEvent,
    { type: "budget.charged" }
  > => event.type === "budget.charged"
    && event.laneId === request.laneId
    && event.idempotencyKey === `${prefix}:budget`);
  if (budget === undefined || hashJson(providerUsage(budget.payload.usage)) !== hashJson(usage)) {
    throw new WorkerLiveContractError(
      "Worker live Ledger completion is missing its matching budget charge",
    );
  }
  return { terminal: "completed", usage };
}

function validateProviderUsage(value: unknown): asserts value is WorkerLiveProviderUsage {
  if (!isRecord(value)) {
    throw new WorkerLiveContractError("Worker live provider usage is malformed");
  }
  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) {
      throw new WorkerLiveContractError(
        `Worker live provider ${field} usage is invalid`,
      );
    }
  }
  if (!finiteNonNegative(value.costUsd)) {
    throw new WorkerLiveContractError("Worker live provider cost is invalid");
  }
}

function validateToolTrace(
  values: readonly unknown[],
): WorkerLiveRecordedToolTraceEntry[] {
  const allowed = new Set(WORKER_LIVE_TOOL_CONTRACT.definitions["worker"]
    .map((tool) => tool.name));
  return values.map((value) => {
    if (!isRecord(value)
      || typeof value.operationId !== "string"
      || value.operationId.length === 0
      || (value.laneId !== "main" && value.laneId !== "worker")
      || typeof value.name !== "string"
      || !allowed.has(value.name)
      || !isRecord(value.arguments)
      || typeof value.isError !== "boolean") {
      throw new WorkerLiveContractError("Worker live tool trace is malformed");
    }
    return structuredClone(value as unknown as WorkerLiveRecordedToolTraceEntry);
  });
}

function validateToolTraceAgainstLedger(
  trace: readonly WorkerLiveRecordedToolTraceEntry[],
  events: readonly AnyEvent[],
): void {
  const requested = events.filter((event): event is Extract<
    AnyEvent,
    { type: "tool.requested" }
  > => event.type === "tool.requested" && event.payload.name !== "delegate_task");
  const terminalByOperation = new Map(events.flatMap((event) => (
    (event.type === "tool.succeeded" || event.type === "tool.failed")
      ? [[event.payload.operationId, event.type] as const]
      : []
  )));
  const requestedByOperation = new Map(requested.map((event) => [
    event.payload.operationId,
    event,
  ]));
  const tracedOperations = new Set<string>();
  for (const entry of trace) {
    if (tracedOperations.has(entry.operationId)) {
      throw new WorkerLiveContractError("Worker live tool trace is duplicated");
    }
    tracedOperations.add(entry.operationId);
    const event = requestedByOperation.get(entry.operationId);
    const argumentsJson = canonicalJson(entry.arguments);
    if (event === undefined
      || event.payload.name !== entry.name
      || event.payload.argumentsRef.mediaType
        !== "application/vnd.nausicaa.tool-arguments+json"
      || event.payload.argumentsRef.id !== hashJson(entry.arguments)
      || event.payload.argumentsRef.contentHash !== hashJson(entry.arguments)
      || event.payload.argumentsRef.byteLength
        !== Buffer.byteLength(argumentsJson, "utf8")
      || entry.isError
        !== (terminalByOperation.get(entry.operationId) === "tool.failed")) {
      throw new WorkerLiveContractError(
        "Worker live tool trace arguments do not match Ledger artifact refs",
      );
    }
  }
  for (const event of requested) {
    if (
      terminalByOperation.get(event.payload.operationId) === "tool.succeeded"
      && !tracedOperations.has(event.payload.operationId)
    ) {
      throw new WorkerLiveContractError(
        "Worker live successful tool request is missing its trace",
      );
    }
  }
}

function validateRunResult(
  value: unknown,
): Pick<RunExecutionResult, "completed" | "steps" | "blocker"> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)
    || typeof value.completed !== "boolean"
    || !Number.isSafeInteger(value.steps)
    || (value.steps as number) < 0
    || (value.blocker !== undefined
      && value.blocker !== "model-output-limit"
      && value.blocker !== "run-budget-or-step-limit"
      && value.blocker !== "resumable-boundary")) {
    throw new WorkerLiveContractError("Worker live Run result is malformed");
  }
  return value as unknown as Pick<
    RunExecutionResult,
    "completed" | "steps" | "blocker"
  >;
}

function validateRunResultAgainstLedger(
  result: Pick<RunExecutionResult, "completed" | "steps" | "blocker"> | undefined,
  events: readonly AnyEvent[],
): void {
  if (result === undefined) return;
  const completedSteps = events.filter((event) => (
    event.type === "step.completed" && event.laneId === "main"
  )).length;
  const hasRunCompleted = events.some((event) => event.type === "run.completed");
  if (result.steps !== completedSteps
    || result.completed !== hasRunCompleted
    || (result.completed && result.blocker !== undefined)
    || (!result.completed && result.blocker === undefined)) {
    throw new WorkerLiveContractError(
      "Worker live Run result does not match committed Ledger boundaries",
    );
  }
}

function isAssistantMessage(
  value: unknown,
): value is Extract<ConversationMessage, { role: "assistant" }> {
  return isRecord(value)
    && value.role === "assistant"
    && typeof value.content === "string"
    && Array.isArray(value.toolCalls)
    && typeof value.createdAt === "string";
}

function validateAnswerArtifact(
  value: unknown,
  events: readonly AnyEvent[],
  runResult: Pick<RunExecutionResult, "completed"> | undefined,
  finalText: string,
): WorkerLiveAnswerArtifact | undefined {
  const completed = events.findLast((event): event is Extract<
    AnyEvent,
    { type: "run.completed" }
  > => event.type === "run.completed");
  if (value === undefined) {
    if (completed !== undefined || runResult?.completed === true) {
      throw new WorkerLiveContractError(
        "Ledger-completed Worker live Run lacks answer artifact evidence",
      );
    }
    return undefined;
  }
  if (!isRecord(value)
    || !isRecord(value.ref)
    || !isAssistantMessage(value.message)) {
    throw new WorkerLiveContractError("Worker live answer artifact evidence is malformed");
  }
  const ref = value.ref as unknown as ArtifactRef;
  if (completed?.payload.answerRef === undefined
    || hashJson(ref) !== hashJson(completed.payload.answerRef)
    || value.message.content !== finalText
    || value.message.toolCalls.length !== 0) {
    throw new WorkerLiveContractError(
      "Worker live final text is not bound to run.completed answerRef",
    );
  }
  const encoded = new TextEncoder().encode(JSON.stringify(value.message));
  if (hashJson(createArtifactRef(encoded, ref.mediaType)) !== hashJson(ref)) {
    throw new WorkerLiveContractError(
      "Worker live answer artifact content hash is invalid",
    );
  }
  return value as unknown as WorkerLiveAnswerArtifact;
}

function sumIntervalUsage(
  intervals: readonly WorkerLiveRequestInterval[],
): WorkerLiveProviderUsage {
  return intervals.reduce((total, interval) => {
    if (interval.usage === undefined) return total;
    return {
      input: total.input + interval.usage.input,
      output: total.output + interval.usage.output,
      cacheRead: total.cacheRead + interval.usage.cacheRead,
      cacheWrite: total.cacheWrite + interval.usage.cacheWrite,
      costUsd: total.costUsd + interval.usage.costUsd,
    };
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 });
}

function perRunBudgetBreached(
  usage: WorkerLiveProviderUsage,
  requestCount: number,
  wallClockMs: number,
  arm: WorkerLiveArmPlan,
): boolean {
  return requestCount > arm.budget.maxRequests
    || usage.input + usage.output + usage.cacheRead + usage.cacheWrite
      > arm.budget.maxModelTokens
    || usage.input > arm.budget.maxInputTokens
    || usage.output > arm.budget.maxOutputTokens
    || usage.costUsd > arm.budget.maxCostUsd
    || wallClockMs > arm.budget.maxWallClockMs;
}

function validateCompletedUsage(
  metrics: ReturnType<typeof projectRunMetrics>,
  usage: WorkerLiveProviderUsage,
): void {
  const charged = metrics.total.chargedUsage;
  const expected = {
    input: charged.input,
    output: charged.output,
    cacheRead: charged.cacheRead,
    cacheWrite: charged.cacheWrite,
    costUsd: charged.costUsd ?? 0,
  };
  if (hashJson(usage) !== hashJson(expected)) {
    throw new WorkerLiveContractError(
      "Worker live successful provider usage does not match Ledger charges",
    );
  }
}

function expectedArmAt(
  manifest: WorkerLiveManifest,
  recordIndex: number,
): {
  pairIndex: number;
  armOrderIndex: number;
  task: WorkerLiveTaskPlan;
  repetition: number;
  arm: WorkerLiveArmPlan;
} | undefined {
  const pairs = workerLivePairOrder(manifest);
  let index = 0;
  for (const [pairIndex, pair] of pairs.entries()) {
    for (const [armOrderIndex, arm] of workerLiveArmOrder(
      manifest,
      pairIndex,
    ).entries()) {
      if (index === recordIndex) {
        return {
          pairIndex,
          armOrderIndex,
          task: pair.task,
          repetition: pair.repetition,
          arm,
        };
      }
      index += 1;
    }
  }
  return undefined;
}

function incompleteReason(
  checkpoint: WorkerLiveEvidenceCheckpoint,
  sampleCount: number,
  manifest: WorkerLiveManifest,
): string {
  if (!checkpoint.repository.clean) return "Repository worktree was not clean";
  if (!checkpoint.repository.baselineIsAncestor) {
    return "Frozen baseline was not an ancestor of the execution commit";
  }
  if (checkpoint.experimentUsage.breachReason !== undefined) {
    return checkpoint.experimentUsage.breachReason;
  }
  if (checkpoint.experimentUsage.exhausted) {
    return "Whole-experiment budget was exhausted";
  }
  return `Only ${sampleCount} of ${manifest.sampleCount} paired samples are complete`;
}

async function readJsonArtifact(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error: unknown) {
    throw new WorkerLiveContractError(
      `Cannot read Worker live artifact ${path}: ${persistedErrorText(error)}`,
    );
  }
}

async function readOptionalJsonArtifact(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error: unknown) {
    if (isNotFound(error)) return undefined;
    throw new WorkerLiveContractError(
      `Cannot read Worker live artifact ${path}: ${persistedErrorText(error)}`,
    );
  }
}

function bigintText(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/u.test(value)) {
    throw new WorkerLiveContractError(`${field} must be an unsigned integer string`);
  }
  return BigInt(value);
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerUsage(usage: TokenUsage): WorkerLiveProviderUsage {
  for (const [name, value] of [
    ["input", usage.input],
    ["output", usage.output],
    ["cacheRead", usage.cacheRead],
    ["cacheWrite", usage.cacheWrite],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new WorkerLiveProviderUsageError(
        `Provider ${name} usage must be a non-negative safe integer`,
      );
    }
  }
  if (
    usage.costUsd === undefined
    || !Number.isFinite(usage.costUsd)
    || usage.costUsd < 0
  ) {
    throw new WorkerLiveProviderUsageError(
      "Provider costUsd must be finite and non-negative",
    );
  }
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    costUsd: usage.costUsd,
  };
}

function assertWorkerLiveRequestTools(
  request: ModelRequest,
  arm: WorkerLiveArmPlan,
  manifest: WorkerLiveManifest,
): void {
  const mode = request.laneId === "worker"
    ? "worker"
    : arm.workerEnabled
      ? "main-worker"
      : "main-only";
  if (
    WORKER_LIVE_TOOL_CONTRACT.hashes[mode]
      !== manifest.toolContract.hashes[mode]
    || hashJson(request.tools) !== manifest.toolContract.hashes[mode]
  ) {
    throw new WorkerLiveContractError(
      `Model tools do not match the frozen ${mode} contract`,
    );
  }
}

function publicFixture(fixture: WorkerLiveFixture): WorkerLivePublicFixture {
  return {
    task: structuredClone(fixture.task),
    workspace: fixture.workspace,
    message: fixture.message,
    goal: structuredClone(fixture.goal),
    fixtureHash: fixture.fixtureHash,
  };
}

function traceWorkerLiveTools(
  tools: readonly AgentTool[],
  trace: WorkerLiveRecordedToolTraceEntry[],
  laneId: "main" | "worker",
): AgentTool[] {
  return tools.map((tool) => ({
    definition: structuredClone(tool.definition),
    async execute(arguments_, context) {
      try {
        const result = await tool.execute(arguments_, context);
        trace.push({
          operationId: context.operationId,
          laneId,
          name: tool.definition.name,
          arguments: structuredClone(arguments_),
          isError: result.isError,
        });
        return result;
      } catch (error: unknown) {
        trace.push({
          operationId: context.operationId,
          laneId,
          name: tool.definition.name,
          arguments: structuredClone(arguments_),
          isError: true,
        });
        throw error;
      }
    },
  }));
}

async function readWorkerLiveEvents(
  stateDir: string,
  runId: string,
): Promise<AnyEvent[]> {
  try {
    const ledger = await JsonlLedger.open(join(stateDir, "ledger.jsonl"));
    try {
      return await ledger.read({ runId });
    } finally {
      await ledger.close();
    }
  } catch (error: unknown) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function readWorkerLiveAnswerArtifact(
  stateDir: string,
  events: readonly AnyEvent[],
): Promise<WorkerLiveAnswerArtifact | undefined> {
  const completed = events.findLast((event): event is Extract<
    AnyEvent,
    { type: "run.completed" }
  > => event.type === "run.completed" && event.payload.answerRef !== undefined);
  const ref = completed?.payload.answerRef;
  if (ref === undefined) return undefined;
  const store = await FileContentAddressedStore.open(join(stateDir, "store"));
  const bytes = await store.get(ref);
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isAssistantMessage(value)) {
    throw new WorkerLiveContractError(
      "Completed Worker live answer artifact is not an assistant message",
    );
  }
  return { ref: structuredClone(ref), message: structuredClone(value) };
}
