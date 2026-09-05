import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import type { ModelPort } from "../../../src/domain/index.js";
import { hashJson } from "../fingerprint.js";
import { executeRun } from "../../../src/runtime/index.js";
import { createWorkspaceTools, WorkspaceCommandSandbox } from "../../../src/tools/index.js";
import {
  BETA_CAPABILITY_SCORER_HASH,
  betaCaseOrder,
  getBetaCaseDefinition,
  getBetaCaseManifest,
  verifyBetaCaseManifest,
} from "./catalog.js";
import { createBetaFixture } from "./fixtures.js";
import { gradeBetaCase } from "./graders.js";
import {
  collectObservedReadPaths,
  observedReadPathsFromToolResult,
} from "./trace.js";
import {
  BETA_CAPABILITY_SCHEMA_VERSION,
  type BetaBatchArtifact,
  type BetaCaseId,
  type BetaCaseManifest,
  type BetaCaseResult,
  type BetaModelFactory,
  type BetaToolTraceEntry,
} from "./types.js";
import {
  BETA_HARD_BUDGET_USD,
  BETA_MAX_OUTPUT_TOKENS,
  BETA_MAX_REQUESTS,
  BETA_MODEL_SELECTOR,
  BETA_SOFT_BUDGET_USD,
  BetaBudgetError,
  BetaBudgetMeter,
  CappedBetaModel,
  inspectBetaRepository,
  type BetaRepositoryState,
} from "../../live/openrouter-beta-harness.js";

export const BETA_EVAL_MODEL_ENV = "NAUSICAA_BETA_EVAL_MODEL" as const;
export const BETA_CASES_ENV = "NAUSICAA_BETA_CASES" as const;
export const BETA_EVAL_BUDGET_ENV = "NAUSICAA_EVAL_BUDGET_USD" as const;
export const BETA_EVAL_MAX_REQUESTS_ENV = "NAUSICAA_EVAL_MAX_REQUESTS" as const;
export const BETA_EVAL_DEADLINE_ENV = "NAUSICAA_EVAL_DEADLINE_MS" as const;
/** The full catalog is bounded by the global request cap; `all` selects it. */
export const BETA_CAPABILITY_MAX_CASES = BETA_MAX_REQUESTS;
export const BETA_CAPABILITY_BATCH_TIMEOUT_MS = 10 * 60 * 1_000;
export const BETA_CAPABILITY_MAX_OUTPUT_TOKENS = BETA_MAX_OUTPUT_TOKENS;

export interface BetaCapabilityConfig {
  readonly liveRequested: boolean;
  readonly apiKeyConfigured: boolean;
  readonly modelInput?: string;
  readonly model?: string;
  readonly caseInputs?: readonly string[];
  readonly cases?: readonly BetaCaseId[];
  readonly budgetUsd?: number;
  readonly maxRequests?: number;
  readonly deadlineMs?: number;
}

export type BetaCapabilityPreflightCode =
  | "disabled"
  | "missing-api-key"
  | "missing-model"
  | "invalid-model"
  | "missing-cases"
  | "invalid-cases"
  | "too-many-cases"
  | "missing-budget"
  | "invalid-budget"
  | "missing-max-requests"
  | "invalid-max-requests"
  | "missing-deadline"
  | "invalid-deadline"
  | "dirty-worktree";

export interface BetaCapabilityPreflight {
  readonly ok: boolean;
  readonly code?: BetaCapabilityPreflightCode;
  readonly message: string;
  readonly config: BetaCapabilityConfig;
  readonly repository?: BetaRepositoryState;
}

export interface BetaBatchRunOptions {
  readonly config: BetaCapabilityConfig;
  readonly repository?: BetaRepositoryState;
  readonly model?: ModelPort;
  readonly modelFactory?: BetaModelFactory;
  readonly rootDirectory?: string;
  readonly executionCommit?: string;
  readonly writeArtifact?: boolean;
  readonly artifactCwd?: string;
}

export interface BetaBatchRunResult {
  readonly preflight: BetaCapabilityPreflight;
  readonly artifact?: BetaBatchArtifact;
  readonly artifactPath?: string;
  readonly requestsMade: number;
}

export async function writeBetaCapabilityArtifact(
  artifact: BetaBatchArtifact,
  cwd = process.cwd(),
): Promise<string> {
  const safe = verifyBetaCapabilityArtifact(artifact);
  const directory = resolve(cwd, ".nausicaa", "evals");
  const filename = `beta-capability-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`;
  const path = join(directory, filename);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(safe, null, 2)}\n`, "utf8");
  return path;
}

export async function readBetaCapabilityArtifact(
  path: string,
  cwd = process.cwd(),
): Promise<BetaBatchArtifact> {
  const root = resolve(cwd, ".nausicaa", "evals");
  const candidate = resolve(path);
  const rel = relative(root, candidate);
  if (rel.length === 0 || rel === ".." || rel.startsWith(`..${"/"}`)) {
    throw new Error("Beta capability artifact is outside .nausicaa/evals");
  }
  return verifyBetaCapabilityArtifact(JSON.parse(await readFile(candidate, "utf8")) as unknown);
}

export function verifyBetaCapabilityArtifact(value: unknown): BetaBatchArtifact {
  if (!isRecord(value)
    || !hasExactKeys(value, ["schemaVersion", "suite", "model", "executionCommit", "manifestHash", "scorerHash", "startedAt", "elapsedMs", "budget", "cases"])) {
    throw new Error("Malformed beta capability artifact");
  }
  const budget = value.budget;
  if (value.schemaVersion !== BETA_CAPABILITY_SCHEMA_VERSION
    || value.suite !== "beta-capability-minieval"
    || value.model !== BETA_MODEL_SELECTOR
    || !isSafeCommit(value.executionCommit)
    || !isHash(value.manifestHash)
    || value.scorerHash !== BETA_CAPABILITY_SCORER_HASH
    || !isSafeTimestamp(value.startedAt)
    || !isSafeInteger(value.elapsedMs)
    || !isRecord(budget)
    || !hasExactKeys(budget, ["limitUsd", "maxRequests", "requestCount", "costUsd", "usage"])
    || !isSafeFinite(budget.limitUsd)
    || budget.limitUsd > BETA_SOFT_BUDGET_USD
    || budget.limitUsd > BETA_HARD_BUDGET_USD
    || !isSafeInteger(budget.maxRequests)
    || budget.maxRequests > BETA_MAX_REQUESTS
    || !isSafeInteger(budget.requestCount)
    || budget.requestCount > budget.maxRequests
    || (budget.costUsd !== null && !isSafeFinite(budget.costUsd))
    || (budget.costUsd !== null && budget.costUsd > BETA_HARD_BUDGET_USD)
    || !isUsage(budget.usage)
    || !Array.isArray(value.cases)
    || value.cases.length < 1
    || value.cases.length > BETA_CAPABILITY_MAX_CASES
    || value.cases.some((entry) => !isCaseResult(entry))) {
    throw new Error("Malformed beta capability artifact");
  }
  const cases = value.cases as readonly Record<string, unknown>[];
  const ids = cases.map((entry) => entry.id as BetaCaseId);
  if (new Set(ids).size !== ids.length || ids.some((id) => !getBetaCaseManifest(id).enabledTonight)) {
    throw new Error("Beta capability artifact contains duplicate or disabled cases");
  }
  if (value.manifestHash !== hashJson(ids.map((id) => getBetaCaseManifest(id)))) {
    throw new Error("Beta capability artifact manifest hash mismatch");
  }
  if (JSON.stringify(value).match(/(?:sk-or-v1|Bearer\s|\/Users\/|\/private\/|["']prompt["']\s*:|["']workspace["']\s*:|raw provider)/iu)) {
    throw new Error("Beta capability artifact contains disallowed sensitive material");
  }
  if (budget.requestCount === 0 && budget.costUsd !== null) {
    throw new Error("A zero-request beta artifact cannot report cost");
  }
  const selectedCeiling = betaCapabilityRequestCeiling(ids);
  if (budget.maxRequests > selectedCeiling) {
    throw new Error("Beta capability artifact exceeds the selected manifest request ceiling");
  }
  const budgetUsage = budget.usage as Record<string, unknown>;
  if ((budgetUsage.output as number) > BETA_MAX_OUTPUT_TOKENS * budget.requestCount) {
    throw new Error("Beta capability artifact exceeds the output token limit");
  }
  return value as unknown as BetaBatchArtifact;
}

export function publicBetaCapabilitySummary(artifact: BetaBatchArtifact): string {
  const safe = verifyBetaCapabilityArtifact(artifact);
  return JSON.stringify({
    suite: safe.suite,
    model: safe.model,
    executionCommit: safe.executionCommit,
    manifestHash: safe.manifestHash,
    scorerHash: safe.scorerHash,
    budget: safe.budget,
    cases: safe.cases.map((entry) => ({
      id: entry.id,
      status: entry.status,
      capabilityScore: entry.capabilityScore,
      behavioralPassed: entry.grade?.behavioralPassed ?? null,
      formatPassed: entry.grade?.formatPassed ?? null,
      completed: entry.completed,
      requestCount: entry.requestCount,
      costUsd: entry.costUsd,
      wallClockMs: entry.wallClockMs,
      tools: entry.tools,
      mutationTools: entry.mutationTools,
      readPaths: entry.readPaths,
      failureCode: entry.failureCode,
    })),
  });
}

export function readBetaCapabilityConfig(env: NodeJS.ProcessEnv = process.env): BetaCapabilityConfig {
  const modelInput = nonBlank(env[BETA_EVAL_MODEL_ENV]);
  // The beta lane has one approved model. Keep the raw input for diagnostics,
  // but only expose a usable selector for the exact canonical spelling.
  const model = modelInput === BETA_MODEL_SELECTOR ? BETA_MODEL_SELECTOR : undefined;
  const caseInput = nonBlank(env[BETA_CASES_ENV]);
  let cases: readonly BetaCaseId[] | undefined;
  const caseInputs = caseInput?.split(",").map((value) => value.trim()) ?? [];
  if (caseInput === "all") {
    cases = betaCaseOrder().filter((id) => getBetaCaseManifest(id).enabledTonight);
  } else if (caseInput !== undefined && caseInputs.every((value) => value.length > 0)) {
    const known = new Set(betaCaseOrder());
    if (caseInputs.every((value): value is BetaCaseId => known.has(value as BetaCaseId))) {
      cases = caseInputs as BetaCaseId[];
    }
  }
  const budget = parseNumber(env[BETA_EVAL_BUDGET_ENV]);
  const maxRequests = parseNumber(env[BETA_EVAL_MAX_REQUESTS_ENV]);
  const deadlineMs = parseNumber(env[BETA_EVAL_DEADLINE_ENV]) ?? BETA_CAPABILITY_BATCH_TIMEOUT_MS;
  return {
    liveRequested: env.NAUSICAA_LIVE_TESTS === "1",
    apiKeyConfigured: nonBlank(env.OPENROUTER_API_KEY) !== undefined,
    ...(modelInput === undefined ? {} : { modelInput }),
    ...(model === undefined ? {} : { model }),
    ...(caseInput === undefined ? {} : { caseInputs }),
    ...(cases === undefined ? {} : { cases }),
    ...(budget === undefined ? {} : { budgetUsd: budget }),
    ...(maxRequests === undefined ? {} : { maxRequests }),
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  };
}

export function betaCapabilityPreflight(
  config: BetaCapabilityConfig,
  repository?: BetaRepositoryState,
): BetaCapabilityPreflight {
  if (!config.liveRequested) return rejected("disabled", "Live tests are disabled", config);
  if (!config.apiKeyConfigured) return rejected("missing-api-key", "OPENROUTER_API_KEY is not configured", config);
  if (config.modelInput === undefined) return rejected("missing-model", `${BETA_EVAL_MODEL_ENV} is required`, config);
  if (config.modelInput !== BETA_MODEL_SELECTOR || config.model !== BETA_MODEL_SELECTOR) {
    return rejected("invalid-model", `${BETA_EVAL_MODEL_ENV} must be exactly ${BETA_MODEL_SELECTOR}`, config);
  }
  if (config.caseInputs === undefined) return rejected("missing-cases", `${BETA_CASES_ENV} must select one or more cases, or all`, config);
  if (config.cases === undefined || config.cases.length === 0) return rejected("invalid-cases", `${BETA_CASES_ENV} contains an unknown or empty case`, config);
  if (config.cases.length > BETA_CAPABILITY_MAX_CASES) return rejected("too-many-cases", `${BETA_CASES_ENV} exceeds the catalog bound`, config);
  if (new Set(config.cases).size !== config.cases.length || config.cases.some((id) => !getBetaCaseManifest(id).enabledTonight)) {
    return rejected("invalid-cases", `${BETA_CASES_ENV} contains a duplicate or tonight-disabled case`, config);
  }
  if (config.budgetUsd === undefined) return rejected("missing-budget", `${BETA_EVAL_BUDGET_ENV} is required`, config);
  if (!Number.isFinite(config.budgetUsd) || config.budgetUsd <= 0 || config.budgetUsd > BETA_SOFT_BUDGET_USD || config.budgetUsd > BETA_HARD_BUDGET_USD) {
    return rejected("invalid-budget", `${BETA_EVAL_BUDGET_ENV} must be positive and no greater than $${BETA_SOFT_BUDGET_USD.toFixed(2)}`, config);
  }
  if (config.maxRequests === undefined) return rejected("missing-max-requests", `${BETA_EVAL_MAX_REQUESTS_ENV} is required`, config);
  if (!Number.isSafeInteger(config.maxRequests) || config.maxRequests <= 0 || config.maxRequests > BETA_MAX_REQUESTS) return rejected("invalid-max-requests", `${BETA_EVAL_MAX_REQUESTS_ENV} must be a positive integer no greater than ${BETA_MAX_REQUESTS}`, config);
  const requestCeiling = betaCapabilityRequestCeiling(config.cases);
  if (config.maxRequests > requestCeiling) {
    return rejected("invalid-max-requests", `${BETA_EVAL_MAX_REQUESTS_ENV} must not exceed the selected manifest ceiling of ${requestCeiling}`, config);
  }
  if (config.deadlineMs === undefined) return rejected("missing-deadline", `${BETA_EVAL_DEADLINE_ENV} is required`, config);
  if (!Number.isSafeInteger(config.deadlineMs) || config.deadlineMs <= 0 || config.deadlineMs > BETA_CAPABILITY_BATCH_TIMEOUT_MS) return rejected("invalid-deadline", `${BETA_EVAL_DEADLINE_ENV} must be a positive integer no greater than ${BETA_CAPABILITY_BATCH_TIMEOUT_MS}`, config);
  if (repository?.repositoryDirty === true) return { ok: false, code: "dirty-worktree", message: "Beta capability eval requires a clean worktree", config, repository };
  return { ok: true, message: "Beta capability eval preflight passed", config, ...(repository === undefined ? {} : { repository }) };
}

export async function runBetaCapabilityBatch(options: BetaBatchRunOptions): Promise<BetaBatchRunResult> {
  const repository = options.repository ?? await inspectBetaRepository();
  const preflight = await betaCapabilityPreflight(options.config, repository);
  if (!preflight.ok) return { preflight, requestsMade: 0 };
  const selected = betaCaseOrder().filter((id) => preflight.config.cases?.includes(id));
  const executionCommit = options.executionCommit ?? repository.executionCommit;
  const manifests = selected.map((id) => getBetaCaseManifest(id));
  manifests.forEach(verifyBetaCaseManifest);
  const meter = new BetaBudgetMeter(
    preflight.config.budgetUsd!,
    preflight.config.maxRequests!,
    BETA_CAPABILITY_MAX_OUTPUT_TOKENS,
  );
  const root = options.rootDirectory ?? await mkdtemp(join(tmpdir(), "nausicaa-beta-capability-"));
  const startedAt = Date.now();
  const batchController = new AbortController();
  const deadline = setTimeout(() => batchController.abort(new Error("Beta capability batch deadline")), preflight.config.deadlineMs);
  const results: BetaCaseResult[] = [];
  let haltReason: "uncertain-cost" | "budget" | "deadline" | undefined;
  try {
    for (const id of selected) {
      const current = meter.snapshot();
      if (haltReason !== undefined || batchController.signal.aborted || current.requestCount >= meter.maxRequests || (current.costUsd !== null && current.costUsd >= meter.limitUsd)) {
        results.push(notRunBudget(id, preflight.config.model!, executionCommit, hashJson(getBetaCaseManifest(id)), haltReason ?? (batchController.signal.aborted ? "deadline" : "budget")));
        haltReason ??= batchController.signal.aborted ? "deadline" : "budget";
        continue;
      }
      const manifest = getBetaCaseManifest(id);
      const caseRoot = join(root, id);
      await mkdir(caseRoot, { recursive: true });
      const fixture = await createBetaFixture(id, caseRoot);
      const trace: BetaToolTraceEntry[] = [];
      const tools = createTracingTools(fixture, trace);
      const model = options.modelFactory?.({ caseId: id, manifest, live: options.model === undefined }) ?? options.model;
      if (model === undefined) throw new Error("Beta capability runner requires a model port");
      const capped = new CappedBetaModel(
        model,
        meter,
        manifest.limits.timeoutMs,
        id === "fukai-compaction" ? 16_384 : undefined,
      );
      const caseSignal = AbortSignal.any([batchController.signal, AbortSignal.timeout(manifest.limits.timeoutMs)]);
      const caseStarted = Date.now();
      const caseBefore = meter.snapshot();
      let runId = "beta-capability-failed";
      try {
        const execution = id === "resume"
          ? await runResumeCase({ fixture, caseRoot, model: capped, tools, modelName: preflight.config.model!, manifest, signal: caseSignal, trace })
          : await executeRun({
              workspace: fixture.workspace,
              dataDir: join(caseRoot, "state"),
              model: preflight.config.model!,
              message: fixture.message,
              goal: fixture.goal,
              allowWrite: true,
              allowShell: manifest.allowedCapabilities.includes("bash"),
              ...(id === "multi-agent" ? { workerEnabled: true } : {}),
              ...(id === "fukai-compaction"
                ? {
                    fukaiCompaction: {
                      enabled: true,
                      provider: "pi-ai" as const,
                      maxInputTokens: 8_000,
                      maxOutputTokens: 512,
                      maxWallClockMs: 120_000,
                      thresholdRatio: 0.4,
                      retainRatio: 0.12,
                      minimumGainTokens: 1,
                    },
                  }
                : {}),
              auxiliaryMode: "none",
              policy: { maxMainStepsPerActivation: manifest.limits.maxMainSteps, maxModelTokens: 20_000, tetoEnabled: false },
              maxOutputTokens: Math.min(
                manifest.limits.maxOutputTokens,
                id === "fukai-compaction" ? 1_024 : BETA_CAPABILITY_MAX_OUTPUT_TOKENS,
              ),
              signal: caseSignal,
            }, { mainModel: capped, tools, createRunId: () => `${id}-run`, onEvent: () => undefined });
        runId = execution.runId;
        const resumed = id === "resume" ? await ledgerHasResume(execution.stateDir) : false;
        const grade = await gradeBetaCase(fixture, execution.finalText, trace, { resumed });
        const afterExecution = meter.snapshot();
        const uncertainCost = afterExecution.requestCount > 0 && afterExecution.costUsd === null;
        results.push(caseResult(
          id,
          uncertainCost || !grade.passed ? "fail" : "pass",
          grade,
          execution,
          meter,
          caseBefore,
          trace,
          executionCommit,
          fixture,
          Date.now() - caseStarted,
          uncertainCost ? "uncertain-cost" : undefined,
        ));
        if (uncertainCost) haltReason = "uncertain-cost";
      } catch (error: unknown) {
        const snapshot = meter.snapshot();
        const budgetError = error instanceof BetaBudgetError;
        const executionFailureCode = error instanceof BetaCaseExecutionError
          ? error.failureCode
          : "runner-error";
        const delta = usageDelta(caseBefore.usage, snapshot.usage);
        const requestDelta = deltaRequests(caseBefore, snapshot);
        const uncertainCost = requestDelta > 0 && snapshot.costUsd === null;
        results.push({
          id, status: "fail", capabilityScore: manifest.capabilityScore, grade: null, runId,
          completed: false, steps: 0, requestCount: snapshot.requestCount - caseBefore.requestCount, usage: delta,
          costUsd: snapshot.costUsd === null || caseBefore.costUsd === null ? snapshot.costUsd : snapshot.costUsd - caseBefore.costUsd, wallClockMs: Date.now() - caseStarted, tools: unique(trace.map((entry) => entry.name)),
    mutationTools: unique(trace.filter((entry) => !entry.isError && ["edit", "write_file", "apply_patch", "directory_create", "path_copy", "path_move", "path_delete"].includes(entry.name)).map((entry) => entry.name)),
          readPaths: safeReadPaths(fixture, trace),
          executionCommit, fixtureHash: fixture.fixtureHash, manifestHash: fixture.manifestHash,
          scorerHash: fixture.manifest.graderHash, failureCode: uncertainCost ? "uncertain-cost" : budgetError ? "budget" : executionFailureCode,
        });
        if (requestDelta > 0 || (snapshot.requestCount > 0 && snapshot.costUsd === null)) {
          haltReason = snapshot.costUsd === null ? "uncertain-cost" : (budgetError ? "budget" : "uncertain-cost");
        }
      }
    }
    const snapshot = meter.snapshot();
    const artifact: BetaBatchArtifact = {
      schemaVersion: BETA_CAPABILITY_SCHEMA_VERSION,
      suite: "beta-capability-minieval",
      model: preflight.config.model!,
      executionCommit,
      manifestHash: hashJson(manifests),
      scorerHash: BETA_CAPABILITY_SCORER_HASH,
      startedAt: new Date(startedAt).toISOString(),
      elapsedMs: Date.now() - startedAt,
      budget: { limitUsd: meter.limitUsd, maxRequests: meter.maxRequests, requestCount: snapshot.requestCount, costUsd: snapshot.costUsd, usage: snapshot.usage },
      cases: results,
    };
    const artifactPath = options.writeArtifact === true
      ? await writeBetaCapabilityArtifact(artifact, options.artifactCwd)
      : undefined;
    return { preflight, artifact, requestsMade: snapshot.requestCount, ...(artifactPath === undefined ? {} : { artifactPath }) };
  } finally {
    clearTimeout(deadline);
    if (options.rootDirectory === undefined) await rm(root, { recursive: true, force: true });
  }
}

export const runBetaCapabilityEvaluation = runBetaCapabilityBatch;
export const betaCapabilitySuitePreflight = betaCapabilityPreflight;

async function runResumeCase(options: {
  fixture: Awaited<ReturnType<typeof createBetaFixture>>;
  caseRoot: string;
  model: ModelPort;
  tools: ReturnType<typeof createTracingTools>;
  modelName: string;
  manifest: BetaCaseManifest;
  signal: AbortSignal;
  trace: BetaToolTraceEntry[];
}): Promise<Awaited<ReturnType<typeof executeRun>>> {
  const first = await executeRun({
    workspace: options.fixture.workspace,
    dataDir: join(options.caseRoot, "state"),
    model: options.modelName,
    // The host owns the pause: maxMainStepsPerActivation=1 guarantees a
    // resumable boundary after the first tool step. Do not ask the model to
    // stop itself, otherwise this eval measures instruction-following rather
    // than durable Run recovery.
    message: "Begin this task by using write_file to write exactly 'resume-ready\\n' to resume.txt. The host will pause this activation after the first step; do not assume the task is complete.",
    goal: options.fixture.goal,
    allowWrite: true,
    allowShell: false,
    auxiliaryMode: "none",
    policy: { maxMainStepsPerActivation: 1, maxModelTokens: 20_000, tetoEnabled: false },
    maxOutputTokens: Math.min(options.manifest.limits.maxOutputTokens, BETA_CAPABILITY_MAX_OUTPUT_TOKENS),
    signal: options.signal,
  }, { mainModel: options.model, tools: options.tools, createRunId: () => "resume-run", onEvent: () => undefined });
  if (first.completed || first.blocker !== "resumable-boundary") {
    throw new BetaCaseExecutionError("resume-boundary-not-reached");
  }
  if (!options.trace.some((entry) => entry.name === "write_file" && !entry.isError)) {
    throw new BetaCaseExecutionError("resume-write-not-observed");
  }
  let latest = first;
  let totalSteps = first.steps;
  let totalUsage = first.usage;
  const maxResumeActivations = Math.max(1, options.manifest.limits.requestBudgetHint - 1);
  for (let activation = 0; activation < maxResumeActivations; activation += 1) {
    if (latest.completed) break;
    const resumed = await executeRun({
      workspace: options.fixture.workspace,
      dataDir: join(options.caseRoot, "state"),
      model: options.modelName,
      resumeRunId: first.runId,
      message: "Continue this same Run. Read resume.txt and inspect its current state. If it is still pending, perform the next required edit; once it contains exactly resume-ready followed by complete on the next line, report the final state with no further tools. Do not change any other file.",
      goal: options.fixture.goal,
      allowWrite: true,
      allowShell: false,
      auxiliaryMode: "none",
      maxOutputTokens: Math.min(options.manifest.limits.maxOutputTokens, BETA_CAPABILITY_MAX_OUTPUT_TOKENS),
      signal: options.signal,
    }, { mainModel: options.model, tools: options.tools, createRunId: () => first.runId, onEvent: () => undefined });
    if (resumed.runId !== first.runId) throw new BetaCaseExecutionError("resume-run-id-changed");
    latest = resumed;
    totalSteps += resumed.steps;
    totalUsage = addUsage(totalUsage, resumed.usage);
  }
  if (!latest.completed) throw new BetaCaseExecutionError("resume-not-completed");
  return { ...latest, steps: totalSteps, usage: totalUsage };
}

function addUsage(left: Awaited<ReturnType<typeof executeRun>>["usage"], right: Awaited<ReturnType<typeof executeRun>>["usage"]): Awaited<ReturnType<typeof executeRun>>["usage"] {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
  };
}

async function ledgerHasResume(stateDir: string): Promise<boolean> {
  const source = await readFile(join(stateDir, "ledger.jsonl"), "utf8");
  return source.split("\n").some((line) => {
    if (line.trim().length === 0) return false;
    try {
      const value = JSON.parse(line) as { type?: unknown };
      return value.type === "run.resumed";
    } catch {
      return false;
    }
  });
}

function createTracingTools(fixture: { workspace: string; rootDirectory: string; manifest: BetaCaseManifest }, trace: BetaToolTraceEntry[]) {
  const shellRequested = fixture.manifest.allowedCapabilities.includes("bash");
  const shellSandbox = shellRequested
    ? new WorkspaceCommandSandbox({ protectedPaths: [join(fixture.rootDirectory, "state")] })
    : undefined;
  const shellAvailable = shellSandbox?.availability().available === true;
  const pathOperationsRequested = fixture.manifest.allowedCapabilities.some((name) => (
    ["directory_create", "path_copy", "path_move", "path_delete"].includes(name)
  ));
  return createWorkspaceTools({
    allowWrite: true,
    allowPathOperations: pathOperationsRequested,
    allowShell: shellAvailable,
    ...(shellAvailable ? { bashCommandExecutor: shellSandbox.execute } : {}),
    protectedPaths: [join(fixture.rootDirectory, "state")],
  })
    .filter((tool) => fixture.manifest.allowedCapabilities.includes(tool.definition.name))
    .map((tool) => ({
    definition: tool.definition,
    async execute(arguments_: Record<string, unknown>, context: Parameters<typeof tool.execute>[1]) {
      if (["edit", "write_file", "apply_patch", "directory_create", "path_copy", "path_move", "path_delete"].includes(tool.definition.name)
        && (!mutationArgumentsAllowed(tool.definition.name, arguments_, fixture.manifest.allowedModifyPaths))) {
        const result = { content: JSON.stringify({ error: "Mutation path is not allowed for this case" }), isError: true } as const;
        trace.push({ laneId: "main", name: tool.definition.name, arguments: structuredClone(arguments_), isError: true });
        return result;
      }
      const result = await tool.execute(arguments_, context);
      const observedPaths = observedReadPathsFromToolResult(
        tool.definition.name,
        result.content,
        result.isError,
        new Set(fixture.manifest.fixtureFiles.map((entry) => entry.path)),
      );
      const observedOutputMarkers = safeObservedOutputMarkers(
        tool.definition.name,
        result.content,
        result.isError,
        fixture.manifest.fixtureFiles.map((entry) => entry.path),
      );
      trace.push({
        laneId: "main",
        name: tool.definition.name,
        arguments: structuredClone(arguments_),
        isError: result.isError,
        ...(observedPaths.length === 0 ? {} : { observedPaths }),
        ...(observedOutputMarkers.length === 0 ? {} : { observedOutputMarkers }),
      });
      return result;
    },
  }));
}

function safeObservedOutputMarkers(
  toolName: string,
  content: string,
  isError: boolean,
  allowedPaths: readonly string[],
): string[] {
  if (isError) return [];
  const markers: string[] = [];
  let payload: unknown;
  try {
    payload = JSON.parse(content) as unknown;
  } catch {
    payload = undefined;
  }
  if (toolName === "bash" && isRecord(payload)) {
    const stdout = typeof payload.stdout === "string" ? payload.stdout : "";
    if (stdout.includes("e2e-ok")) markers.push("e2e-ok");
    if (stdout.includes("line-3000")) markers.push("line-3000");
    if (payload.truncated === true) markers.push("truncated");
  }
  if (toolName === "find" && isRecord(payload) && Array.isArray(payload.files)) {
    for (const path of payload.files) {
      if (typeof path === "string" && allowedPaths.includes(path)) markers.push(path);
    }
  }
  return [...new Set(markers)];
}

function caseResult(id: BetaCaseId, status: "pass" | "fail", grade: Awaited<ReturnType<typeof gradeBetaCase>>, execution: Awaited<ReturnType<typeof executeRun>>, meter: BetaBudgetMeter, before: ReturnType<BetaBudgetMeter["snapshot"]>, trace: readonly BetaToolTraceEntry[], commit: string, fixture: Awaited<ReturnType<typeof createBetaFixture>>, wallClockMs: number, failureCodeOverride?: string): BetaCaseResult {
  const snapshot = meter.snapshot();
  return {
    id, status, capabilityScore: fixture.manifest.capabilityScore, grade, runId: execution.runId, completed: execution.completed,
    steps: execution.steps, requestCount: snapshot.requestCount - before.requestCount, usage: usageDelta(before.usage, snapshot.usage), costUsd: snapshot.costUsd === null || before.costUsd === null ? snapshot.costUsd : snapshot.costUsd - before.costUsd,
    wallClockMs, tools: unique(trace.map((entry) => entry.name)), mutationTools: unique(trace.filter((entry) => !entry.isError && ["edit", "write_file", "apply_patch", "directory_create", "path_copy", "path_move", "path_delete"].includes(entry.name)).map((entry) => entry.name)),
    readPaths: safeReadPaths(fixture, trace),
    executionCommit: commit, fixtureHash: fixture.fixtureHash, manifestHash: fixture.manifestHash, scorerHash: fixture.manifest.graderHash, failureCode: failureCodeOverride ?? (grade.passed ? null : grade.failureCodes[0] ?? "grader-failed"),
  };
}

function notRunBudget(id: BetaCaseId, _model: string, commit: string, manifestHash: string, reason: "uncertain-cost" | "budget" | "deadline" = "budget"): BetaCaseResult {
  const manifest = getBetaCaseManifest(id);
  return { id, status: "not-run-budget", capabilityScore: manifest.capabilityScore, grade: null, runId: null, completed: false, steps: 0, requestCount: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: null, wallClockMs: 0, tools: [], mutationTools: [], readPaths: [], executionCommit: commit, fixtureHash: hashJson({ id, files: getBetaCaseDefinition(id).files }), manifestHash: hashJson(manifest), scorerHash: manifest.graderHash, failureCode: reason };
}

function rejected(code: BetaCapabilityPreflightCode, message: string, config: BetaCapabilityConfig): BetaCapabilityPreflight { return { ok: false, code, message, config }; }
function parseNumber(value: string | undefined): number | undefined { if (value === undefined || value.trim() === "") return undefined; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : Number.NaN; }
function nonBlank(value: string | undefined): string | undefined { const trimmed = value?.trim(); return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed; }
function unique(values: readonly string[]): string[] { return [...new Set(values)]; }
function deltaRequests(before: ReturnType<BetaBudgetMeter["snapshot"]>, after: ReturnType<BetaBudgetMeter["snapshot"]>): number {
  return after.requestCount - before.requestCount;
}

/** Sum immutable manifest hints, then apply the global beta request ceiling. */
export function betaCapabilityRequestCeiling(ids: readonly BetaCaseId[]): number {
  const total = ids.reduce((sum, id) => sum + getBetaCaseManifest(id).limits.requestBudgetHint, 0);
  return Math.min(BETA_MAX_REQUESTS, total);
}

function safeReadPaths(
  fixture: { manifest: BetaCaseManifest },
  trace: readonly BetaToolTraceEntry[],
): string[] {
  const allowed = new Set(fixture.manifest.fixtureFiles.map((entry) => entry.path));
  return unique([...collectObservedReadPaths(trace)].filter((path) => allowed.has(path)));
}

class BetaCaseExecutionError extends Error {
  constructor(readonly failureCode: string) {
    super(failureCode);
    this.name = "BetaCaseExecutionError";
  }
}

function mutationArgumentsAllowed(name: string, arguments_: Record<string, unknown>, allowedPaths: readonly string[]): boolean {
  if (name === "apply_patch") {
    if (typeof arguments_.patch !== "string") return false;
    const paths = [...arguments_.patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu)].map((match) => match[1] ?? "");
    return paths.length > 0 && paths.every((path) => allowedPaths.includes(path));
  }
  if (name === "path_move" || name === "path_copy") {
    return typeof arguments_.from === "string" && typeof arguments_.to === "string"
      && allowedPaths.includes(arguments_.from) && allowedPaths.includes(arguments_.to);
  }
  return typeof arguments_.path === "string" && allowedPaths.includes(arguments_.path);
}
function usageDelta(before: BetaCaseResult["usage"], after: BetaCaseResult["usage"]): BetaCaseResult["usage"] {
  return { input: after.input - before.input, output: after.output - before.output, cacheRead: after.cacheRead - before.cacheRead, cacheWrite: after.cacheWrite - before.cacheWrite };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function isSafeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}
function isSafeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function isSafeCommit(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^(?:[0-9a-f]+|unknown)$/u.test(value);
}
function isHash(value: unknown): value is string { return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value); }
function isSafeTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24 || !value.endsWith("Z")) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
function isUsage(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["input", "output", "cacheRead", "cacheWrite"])
    && isSafeFinite(value.input) && isSafeFinite(value.output) && isSafeFinite(value.cacheRead) && isSafeFinite(value.cacheWrite);
}
function isCaseResult(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "status", "capabilityScore", "grade", "runId", "completed", "steps", "requestCount", "usage", "costUsd", "wallClockMs", "tools", "mutationTools", "readPaths", "executionCommit", "fixtureHash", "manifestHash", "scorerHash", "failureCode"])) return false;
  const id = value.id as BetaCaseId;
  const manifest = typeof value.id === "string" && betaCaseOrder().includes(id) ? getBetaCaseManifest(id) : undefined;
  const toolsValid = (list: unknown): list is readonly string[] => Array.isArray(list)
    && list.length <= 64
    && list.every((entry) => typeof entry === "string" && /^[a-z][a-z0-9_-]{0,63}$/u.test(entry));
  const pathsValid = (list: unknown): list is readonly string[] => Array.isArray(list)
    && list.length <= 256
    && list.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 256 && /^[A-Za-z0-9._/-]+$/u.test(entry) && !entry.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(entry));
  return manifest !== undefined
    && ["pass", "fail", "not-run-budget", "not-selected"].includes(value.status as string)
    && value.capabilityScore === manifest.capabilityScore
    && (value.grade === null || isGrade(value.grade))
    && (value.runId === null || (typeof value.runId === "string" && value.runId.length > 0 && value.runId.length <= 128 && /^[A-Za-z0-9._:-]+$/u.test(value.runId)))
    && typeof value.completed === "boolean"
    && isSafeInteger(value.steps) && isSafeInteger(value.requestCount)
    && value.requestCount <= BETA_MAX_REQUESTS && value.requestCount <= manifest.limits.requestBudgetHint
    && isUsage(value.usage)
    && (value.costUsd === null || (isSafeFinite(value.costUsd) && value.costUsd <= BETA_HARD_BUDGET_USD))
    && (value.requestCount === 0 ? value.costUsd === null : true)
    && isSafeInteger(value.wallClockMs)
    && toolsValid(value.tools) && toolsValid(value.mutationTools) && pathsValid(value.readPaths)
    && (value.mutationTools as readonly string[]).every((name) => (value.tools as readonly string[]).includes(name))
    && (value.readPaths as readonly string[]).every((path) => manifest.fixtureFiles.some((entry) => entry.path === path))
    && isSafeCommit(value.executionCommit) && isHash(value.fixtureHash)
    && value.fixtureHash === hashJson({ id, files: getBetaCaseDefinition(id).files })
    && isHash(value.manifestHash) && value.manifestHash === hashJson(manifest)
    && value.scorerHash === BETA_CAPABILITY_SCORER_HASH
    && (value.failureCode === null || (typeof value.failureCode === "string" && /^[a-z][a-z0-9_-]{0,127}$/u.test(value.failureCode)))
    && (value.status === "pass" ? value.grade !== null : value.status === "fail" ? (value.grade === null || isGrade(value.grade)) : value.grade === null);
}

function isGrade(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, ["passed", "behavioralPassed", "formatPassed", "failureCodes", "assertions"])) return false;
  if (typeof value.passed !== "boolean" || typeof value.behavioralPassed !== "boolean" || typeof value.formatPassed !== "boolean"
    || !Array.isArray(value.failureCodes) || value.failureCodes.length > 64) return false;
  if (!value.failureCodes.every((entry) => typeof entry === "string" && /^[a-z][a-z0-9_-]{0,127}$/u.test(entry))) return false;
  if (!isRecord(value.assertions)) return false;
  const assertionKeys = Object.keys(value.assertions);
  const assertions = value.assertions as Record<string, unknown>;
  return assertionKeys.length <= 128
    && assertionKeys.every((key) => /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(key) && typeof assertions[key] === "boolean")
    && value.passed === (value.failureCodes.length === 0)
    && value.behavioralPassed === Object.entries(assertions)
      .filter(([key]) => !isFormatAssertionKey(key))
      .every(([, passed]) => passed)
    && value.formatPassed === Object.entries(assertions)
      .filter(([key]) => isFormatAssertionKey(key))
      .every(([, passed]) => passed);
}

function isFormatAssertionKey(key: string): boolean {
  return key === "exactAnswer"
    || key === "exactVisiblePaths"
    || key === "finalTextExact"
    || key === "finalTextExactGreeting"
    || key === "finalTextExactOutput"
    || key === "finalTextMentionsFact"
    || key === "finalTextMentionsResult"
    || key === "reportedTruncation";
}
