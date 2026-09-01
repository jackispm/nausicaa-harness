import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import type {
  ModelPort,
  ModelRequest,
  ModelResponse,
} from "../../src/domain/index.js";
import { persistedErrorText, redactSensitiveText } from "../../src/runtime/redaction.js";

export const BETA_PROVIDER = "openrouter" as const;
export const BETA_MODEL_ID = "tencent/hy3" as const;
export const BETA_MODEL_SELECTOR = `${BETA_PROVIDER}:${BETA_MODEL_ID}` as const;
export const BETA_MODEL_ENV = "NAUSICAA_LIVE_MODEL" as const;
export const BETA_LIVE_ENV = "NAUSICAA_LIVE_TESTS" as const;
export const BETA_BUDGET_ENV = "NAUSICAA_EVAL_BUDGET_USD" as const;
export const BETA_SOFT_BUDGET_USD = 0.85;
export const BETA_HARD_BUDGET_USD = 1;
export const BETA_MAX_REQUESTS = 5;
export const BETA_MAX_OUTPUT_TOKENS = 128;
export const BETA_TETO_OUTPUT_TOKENS = 16;
export const BETA_WALL_CLOCK_TIMEOUT_MS = 45_000;

export interface BetaSmokeConfig {
  readonly liveRequested: boolean;
  readonly apiKeyConfigured: boolean;
  readonly modelInput?: string;
  readonly model?: string;
  readonly budgetUsd?: number;
  readonly tetoEnabled: boolean;
}

export interface BetaRepositoryState {
  readonly executionCommit: string;
  readonly repositoryDirty: boolean;
}

export type BetaPreflightCode =
  | "disabled"
  | "missing-api-key"
  | "missing-model"
  | "invalid-model"
  | "missing-budget"
  | "invalid-budget"
  | "budget-too-large"
  | "dirty-worktree";

export interface BetaPreflightResult {
  readonly ok: boolean;
  readonly code?: BetaPreflightCode;
  readonly message: string;
  readonly config: BetaSmokeConfig;
  readonly repository?: BetaRepositoryState;
}

export interface BetaUsageTotals {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface BetaBudgetSnapshot {
  readonly requestCount: number;
  readonly usage: BetaUsageTotals;
  readonly costUsd: number | null;
}

export type BetaSmokeStatus = "pass" | "failed" | "skipped";

/** Finite categories used in public beta evidence; never copy provider text here. */
export type BetaFailureCategory =
  | "provider-auth-failure"
  | "model-tool-call-incompatibility"
  | "timeout"
  | "budget-guard"
  | "harness-defect"
  | "nondeterministic-quality-result";

export type BetaNextOwner =
  | "provider-owner"
  | "runtime-owner"
  | "harness-owner"
  | "release-owner"
  | "evaluation-owner";

export interface BetaSmokeEvidence {
  readonly elapsedMs: number;
  readonly failureCategory: BetaFailureCategory | null;
  readonly nextOwner: BetaNextOwner | null;
}

/**
 * This is intentionally a small public report. It contains no prompts,
 * responses, paths, provider errors, or credentials.
 */
export interface BetaSmokeArtifact {
  readonly schemaVersion: 1;
  readonly provider: typeof BETA_PROVIDER;
  readonly model: typeof BETA_MODEL_SELECTOR;
  readonly requestCount: number;
  readonly usage: BetaUsageTotals;
  readonly costUsd: number | null;
  readonly status: BetaSmokeStatus;
  readonly commit: string;
  readonly elapsedMs: number;
  readonly failureCategory: BetaFailureCategory | null;
  readonly nextOwner: BetaNextOwner | null;
}

export class BetaBudgetError extends Error {
  readonly code = "budget" as const;

  constructor(message: string) {
    super(message);
    this.name = "BetaBudgetError";
  }
}

export class BetaUsageError extends Error {
  readonly code = "usage" as const;

  constructor(message: string) {
    super(message);
    this.name = "BetaUsageError";
  }
}

export function readBetaSmokeConfig(
  env: NodeJS.ProcessEnv = process.env,
): BetaSmokeConfig {
  const modelInput = nonBlank(env[BETA_MODEL_ENV]);
  let model: string | undefined;
  if (modelInput !== undefined) {
    try {
      model = normalizeBetaModel(modelInput);
    } catch {
      model = undefined;
    }
  }
  const budgetInput = nonBlank(env[BETA_BUDGET_ENV]);
  const parsedBudget = budgetInput === undefined ? undefined : Number(budgetInput);
  return {
    liveRequested: env[BETA_LIVE_ENV] === "1",
    apiKeyConfigured: nonBlank(env.OPENROUTER_API_KEY) !== undefined,
    ...(modelInput === undefined ? {} : { modelInput }),
    ...(model === undefined ? {} : { model }),
    ...(parsedBudget === undefined ? {} : { budgetUsd: parsedBudget }),
    // A Teto pass is an explicit optional extension; the root beta command
    // leaves it disabled so the default request cap remains predictable.
    tetoEnabled: env.NAUSICAA_LIVE_TETO === "1",
  };
}

/** Normalize the only model accepted by the beta smoke. */
export function normalizeBetaModel(value: string): typeof BETA_MODEL_SELECTOR {
  const trimmed = value.trim();
  const modelId = trimmed.startsWith(`${BETA_PROVIDER}:`)
    ? trimmed.slice(`${BETA_PROVIDER}:`.length)
    : trimmed;
  if (modelId !== BETA_MODEL_ID) {
    throw new Error(`Beta smoke model must be ${BETA_MODEL_ID}`);
  }
  return BETA_MODEL_SELECTOR;
}

export function betaSmokePreflight(
  config: BetaSmokeConfig,
  repository?: BetaRepositoryState,
): BetaPreflightResult {
  if (!config.liveRequested) {
    return { ok: false, code: "disabled", message: "Live tests are disabled", config };
  }
  if (!config.apiKeyConfigured) {
    return {
      ok: false,
      code: "missing-api-key",
      message: "OPENROUTER_API_KEY is not configured",
      config,
    };
  }
  if (config.modelInput === undefined) {
    return {
      ok: false,
      code: "missing-model",
      message: `${BETA_MODEL_ENV} must be set to ${BETA_MODEL_ID}`,
      config,
    };
  }
  if (config.model === undefined) {
    return {
      ok: false,
      code: "invalid-model",
      message: `${BETA_MODEL_ENV} must select ${BETA_MODEL_ID}`,
      config,
    };
  }
  if (config.budgetUsd === undefined) {
    return {
      ok: false,
      code: "missing-budget",
      message: `${BETA_BUDGET_ENV} must be a positive number`,
      config,
    };
  }
  if (!Number.isFinite(config.budgetUsd) || config.budgetUsd <= 0) {
    return {
      ok: false,
      code: "invalid-budget",
      message: `${BETA_BUDGET_ENV} must be a positive finite number`,
      config,
    };
  }
  if (config.budgetUsd > BETA_SOFT_BUDGET_USD || config.budgetUsd > BETA_HARD_BUDGET_USD) {
    return {
      ok: false,
      code: "budget-too-large",
      message: `${BETA_BUDGET_ENV} must not exceed $${BETA_SOFT_BUDGET_USD.toFixed(2)}`,
      config,
    };
  }
  if (repository?.repositoryDirty === true) {
    return {
      ok: false,
      code: "dirty-worktree",
      message: "OpenRouter beta smoke requires a clean worktree",
      config,
      repository,
    };
  }
  return {
    ok: true,
    message: "OpenRouter beta smoke preflight passed",
    config,
    ...(repository === undefined ? {} : { repository }),
  };
}

export async function inspectBetaRepository(
  cwd = process.cwd(),
): Promise<BetaRepositoryState> {
  const run = promisify(execFile);
  const [head, status] = await Promise.all([
    run("git", ["rev-parse", "HEAD"], { cwd: resolve(cwd) }),
    run("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: resolve(cwd),
    }),
  ]);
  return {
    executionCommit: head.stdout.trim(),
    repositoryDirty: status.stdout.trim().length > 0,
  };
}

/** Request meter used by the live adapter. It fails closed on missing usage. */
export class BetaBudgetMeter {
  private requestCountValue = 0;
  private usageValue: BetaUsageTotals = emptyUsage();
  private costValue = 0;

  constructor(
    readonly limitUsd: number,
    readonly maxRequests = BETA_MAX_REQUESTS,
    readonly maxOutputTokens = BETA_MAX_OUTPUT_TOKENS,
  ) {
    if (!Number.isFinite(limitUsd) || limitUsd <= 0 || limitUsd > BETA_HARD_BUDGET_USD) {
      throw new BetaBudgetError("Invalid beta smoke budget");
    }
    if (!Number.isInteger(maxRequests) || maxRequests <= 0 || maxRequests > BETA_MAX_REQUESTS) {
      throw new BetaBudgetError("Invalid beta smoke request limit");
    }
    if (!Number.isInteger(maxOutputTokens)
      || maxOutputTokens <= 0
      || maxOutputTokens > BETA_MAX_OUTPUT_TOKENS) {
      throw new BetaBudgetError("Invalid beta smoke output limit");
    }
  }

  beforeRequest(request: Pick<ModelRequest, "maxOutputTokens" | "signal">): void {
    if (request.signal?.aborted) {
      throw request.signal.reason instanceof Error
        ? request.signal.reason
        : new DOMException("The operation was aborted", "AbortError");
    }
    if (this.requestCountValue >= this.maxRequests) {
      throw new BetaBudgetError(`Beta smoke request limit of ${this.maxRequests} was reached`);
    }
    if (this.costValue >= this.limitUsd) {
      throw new BetaBudgetError(`Beta smoke cost limit of $${this.limitUsd} was reached`);
    }
    if (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0) {
      throw new BetaBudgetError("Beta smoke maxOutputTokens must be a positive integer");
    }
    if (request.maxOutputTokens > this.maxOutputTokens) {
      throw new BetaBudgetError(
        `Beta smoke maxOutputTokens must not exceed ${this.maxOutputTokens}`,
      );
    }
    this.requestCountValue += 1;
  }

  charge(usage: ModelResponse["usage"]): void {
    const checked = parseUsage(usage);
    if (checked.output > this.maxOutputTokens
      || this.usageValue.output + checked.output > this.maxOutputTokens * this.requestCountValue) {
      throw new BetaUsageError(
        `Provider output exceeds the beta limit of ${this.maxOutputTokens} tokens per request`,
      );
    }
    this.usageValue = {
      input: this.usageValue.input + checked.input,
      output: this.usageValue.output + checked.output,
      cacheRead: this.usageValue.cacheRead + checked.cacheRead,
      cacheWrite: this.usageValue.cacheWrite + checked.cacheWrite,
    };
    this.costValue += checked.costUsd;
    if (this.costValue > this.limitUsd) {
      throw new BetaBudgetError(
        `Beta smoke cost $${this.costValue} exceeded $${this.limitUsd}`,
      );
    }
  }

  snapshot(): BetaBudgetSnapshot {
    return {
      requestCount: this.requestCountValue,
      usage: { ...this.usageValue },
      costUsd: this.requestCountValue === 0 ? null : this.costValue,
    };
  }
}

/** A ModelPort wrapper that applies all live request, timeout, and usage caps. */
export class CappedBetaModel implements ModelPort {
  constructor(
    private readonly delegate: ModelPort,
    readonly budget: BetaBudgetMeter,
    readonly wallClockTimeoutMs = BETA_WALL_CLOCK_TIMEOUT_MS,
  ) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const maxOutputTokens = Math.min(request.maxOutputTokens, this.budget.maxOutputTokens);
    const requestWithCap = { ...request, maxOutputTokens };
    this.budget.beforeRequest(requestWithCap);

    const timeoutController = new AbortController();
    const signal = request.signal === undefined
      ? timeoutController.signal
      : AbortSignal.any([request.signal, timeoutController.signal]);
    let timeout: NodeJS.Timeout | undefined;
    try {
      const response = await Promise.race([
        this.delegate.complete({ ...requestWithCap, signal }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            timeoutController.abort(new Error("Beta smoke wall-clock timeout"));
            reject(new Error("Beta smoke wall-clock timeout"));
          }, this.wallClockTimeoutMs);
        }),
      ]);
      this.budget.charge(response.usage);
      return response;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      timeoutController.abort(new Error("Beta smoke request cleanup"));
    }
  }
}

export function betaSmokeArtifact(
  status: BetaSmokeStatus,
  meter: BetaBudgetMeter,
  commit: string,
  evidence: Partial<BetaSmokeEvidence> = {},
): BetaSmokeArtifact {
  const snapshot = meter.snapshot();
  return {
    schemaVersion: 1,
    provider: BETA_PROVIDER,
    model: BETA_MODEL_SELECTOR,
    requestCount: snapshot.requestCount,
    usage: snapshot.usage,
    costUsd: snapshot.costUsd,
    status,
    commit: sanitizeCommit(commit),
    elapsedMs: sanitizeElapsedMs(evidence.elapsedMs ?? 0),
    failureCategory: evidence.failureCategory ?? null,
    nextOwner: evidence.nextOwner ?? null,
  };
}

export async function writeBetaSmokeArtifact(
  artifact: BetaSmokeArtifact,
  cwd = process.cwd(),
): Promise<string> {
  const safeArtifact = verifyBetaSmokeArtifact(artifact);
  const directory = resolve(cwd, ".nausicaa", "evals");
  const filename = `openrouter-beta-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`;
  const path = join(directory, filename);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(safeArtifact, null, 2)}\n`, "utf8");
  return path;
}

export async function readBetaSmokeArtifact(
  path: string,
  cwd = process.cwd(),
): Promise<BetaSmokeArtifact> {
  if (!betaArtifactPathIsScoped(path, cwd)) {
    throw new Error("OpenRouter beta artifact path is outside .nausicaa/evals");
  }
  return verifyBetaSmokeArtifact(JSON.parse(await readFile(resolve(path), "utf8")) as unknown);
}

export function verifyBetaSmokeArtifact(value: unknown): BetaSmokeArtifact {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "schemaVersion",
      "provider",
      "model",
      "requestCount",
      "usage",
      "costUsd",
      "status",
      "commit",
      "elapsedMs",
      "failureCategory",
      "nextOwner",
    ])
    || value.schemaVersion !== 1
    || value.provider !== BETA_PROVIDER
    || value.model !== BETA_MODEL_SELECTOR
    || !isNonNegativeInteger(value.requestCount)
    || !isUsageTotals(value.usage)
    || !isNullableFiniteCost(value.costUsd)
    || !["pass", "failed", "skipped"].includes(value.status as string)
    || typeof value.commit !== "string"
    || value.commit.length === 0
    || value.commit.length > 128
    || !/^(?:[0-9a-f]+|unknown)$/u.test(value.commit)
    || !isElapsedMs(value.elapsedMs)
    || !isFailureCategory(value.failureCategory)
    || !isNextOwner(value.nextOwner)) {
    throw new Error("Malformed OpenRouter beta smoke artifact");
  }
  if (value.status === "pass" && (value.costUsd === null || value.requestCount === 0)) {
    throw new Error("A passing beta smoke artifact requires request cost");
  }
  if (value.requestCount > BETA_MAX_REQUESTS) {
    throw new Error(`Beta smoke artifact exceeds the ${BETA_MAX_REQUESTS}-request limit`);
  }
  if (value.usage.output > BETA_MAX_OUTPUT_TOKENS * value.requestCount) {
    throw new Error(
      `Beta smoke artifact exceeds the ${BETA_MAX_OUTPUT_TOKENS}-token output limit per request`,
    );
  }
  if (value.costUsd !== null && value.costUsd > BETA_HARD_BUDGET_USD) {
    throw new Error("Beta smoke artifact exceeds the hard budget");
  }
  if (value.status === "failed" && (value.failureCategory === null || value.nextOwner === null)) {
    throw new Error("A failed beta smoke artifact requires a failure category and next owner");
  }
  if (value.status !== "failed" && (value.failureCategory !== null || value.nextOwner !== null)) {
    throw new Error("Only a failed beta smoke artifact may contain failure ownership");
  }
  return value as unknown as BetaSmokeArtifact;
}

export function publicBetaSmokeSummary(artifact: BetaSmokeArtifact): string {
  const safe = verifyBetaSmokeArtifact(artifact);
  return JSON.stringify({
    model: safe.model,
    requestCount: safe.requestCount,
    usage: safe.usage,
    costUsd: safe.costUsd,
    status: safe.status,
    commit: safe.commit,
    elapsedMs: safe.elapsedMs,
    failureCategory: safe.failureCategory,
    nextOwner: safe.nextOwner,
  });
}

export function redactedBetaFailure(error: unknown): string {
  return redactSensitiveText(persistedErrorText(error, "Beta smoke failed", 512));
}

/** Map local control/protocol errors without persisting untrusted provider text. */
export function classifyBetaFailure(error: unknown): BetaSmokeEvidence {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  let failureCategory: BetaFailureCategory;
  if (error instanceof BetaBudgetError) {
    failureCategory = "budget-guard";
  } else if (message.includes("timeout") || message.includes("aborted")) {
    failureCategory = "timeout";
  } else if (/(?:401|403|unauthor|forbidden|api key|credential|quota|rate limit)/u.test(message)) {
    failureCategory = "provider-auth-failure";
  } else if (error instanceof BetaUsageError
    || /(?:model|tool|function|schema|unsupported)/u.test(message)) {
    failureCategory = "model-tool-call-incompatibility";
  } else {
    failureCategory = "harness-defect";
  }

  let nextOwner: BetaNextOwner;
  switch (failureCategory) {
    case "budget-guard":
      nextOwner = "release-owner";
      break;
    case "provider-auth-failure":
      nextOwner = "provider-owner";
      break;
    case "model-tool-call-incompatibility":
      nextOwner = "runtime-owner";
      break;
    case "timeout":
    case "harness-defect":
      nextOwner = "harness-owner";
      break;
    default:
      nextOwner = "evaluation-owner";
      break;
  }
  return { elapsedMs: 0, failureCategory, nextOwner };
}

export function betaArtifactPathIsScoped(path: string, cwd = process.cwd()): boolean {
  const root = resolve(cwd, ".nausicaa", "evals");
  const candidate = resolve(path);
  const rel = relative(root, candidate);
  return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${"/"}`);
}

function parseUsage(value: ModelResponse["usage"]): BetaUsageTotals & { costUsd: number } {
  if (!isRecord(value)) throw new BetaUsageError("Provider usage is missing");
  return {
    input: finiteNonNegative(value.input, "input"),
    output: finiteNonNegative(value.output, "output"),
    cacheRead: finiteNonNegative(value.cacheRead, "cacheRead"),
    cacheWrite: finiteNonNegative(value.cacheWrite, "cacheWrite"),
    costUsd: finiteNonNegative(value.costUsd, "costUsd"),
  };
}

function finiteNonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new BetaUsageError(`Provider usage ${label} is not a finite non-negative number`);
  }
  return value;
}

function emptyUsage(): BetaUsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function isUsageTotals(value: unknown): value is BetaUsageTotals {
  return isRecord(value)
    && hasExactKeys(value, ["input", "output", "cacheRead", "cacheWrite"])
    && finiteOrFalse(value.input)
    && finiteOrFalse(value.output)
    && finiteOrFalse(value.cacheRead)
    && finiteOrFalse(value.cacheWrite);
}

function isNullableFiniteCost(value: unknown): value is number | null {
  return value === null || finiteOrFalse(value);
}

function finiteOrFalse(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function sanitizeCommit(value: string): string {
  const commit = value.trim();
  return /^[0-9a-f]+$/u.test(commit) ? commit : "unknown";
}

function sanitizeElapsedMs(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isElapsedMs(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
}

function isFailureCategory(value: unknown): value is BetaFailureCategory | null {
  return value === null || [
    "provider-auth-failure",
    "model-tool-call-incompatibility",
    "timeout",
    "budget-guard",
    "harness-defect",
    "nondeterministic-quality-result",
  ].includes(value as BetaFailureCategory);
}

function isNextOwner(value: unknown): value is BetaNextOwner | null {
  return value === null || [
    "provider-owner",
    "runtime-owner",
    "harness-owner",
    "release-owner",
    "evaluation-owner",
  ].includes(value as BetaNextOwner);
}
