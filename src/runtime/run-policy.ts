import type { FukaiCompactionPolicy, RunPolicy } from "../domain/types.js";
import {
  DEFAULT_MAIN_REQUEST_TIMEOUT_MS,
  DEFAULT_FUKAI_COMPACTION_MINIMUM_GAIN_TOKENS,
  DEFAULT_FUKAI_COMPACTION_RETAIN_RATIO,
  DEFAULT_FUKAI_COMPACTION_THRESHOLD_RATIO,
  MAX_MAIN_REQUEST_TIMEOUT_MS,
  mainStepAllowance,
} from "../domain/types.js";

const MAX_FUKAI_COMPACTION_INPUT_TOKENS = 16 * 1024 * 1024;
const MAX_FUKAI_COMPACTION_OUTPUT_TOKENS = 16 * 1024 * 1024;
const MAX_FUKAI_COMPACTION_WALL_CLOCK_MS = 5 * 60 * 1_000;

export const DEFAULT_RUN_POLICY: RunPolicy = {
  maxMainStepsPerActivation: 24,
  mainRequestTimeoutMs: DEFAULT_MAIN_REQUEST_TIMEOUT_MS,
  tetoEnabled: true,
  tetoMaxOutputTokens: 64,
  // New lanes expose Teto as a capability; the owning model opens it when
  // the task warrants a second line of thought.
  tetoActivation: "manual",
  workerEnabled: false,
};

export const resolveRunPolicy = (input: Partial<RunPolicy> = {}): RunPolicy => {
  const allowance = input.maxMainStepsPerActivation
    ?? input.maxMainSteps
    ?? mainStepAllowance(DEFAULT_RUN_POLICY);
  const defaultTetoActivation = input.tetoActivation
    ?? (input.maxMainSteps !== undefined || input.auxiliaryMode === "teto"
      ? "automatic"
      : DEFAULT_RUN_POLICY.tetoActivation);
  const policy = {
    maxMainStepsPerActivation: allowance,
    ...(input.maxModelTokens === undefined
      ? {}
      : { maxModelTokens: input.maxModelTokens }),
    mainRequestTimeoutMs: input.mainRequestTimeoutMs
      ?? DEFAULT_MAIN_REQUEST_TIMEOUT_MS,
    tetoEnabled: input.tetoEnabled ?? DEFAULT_RUN_POLICY.tetoEnabled,
    tetoMaxOutputTokens: input.tetoMaxOutputTokens ?? DEFAULT_RUN_POLICY.tetoMaxOutputTokens,
    ...(input.tetoTokenRatio === undefined
      ? {}
      : { tetoTokenRatio: input.tetoTokenRatio }),
    tetoActivation: defaultTetoActivation,
    workerEnabled: input.workerEnabled ?? DEFAULT_RUN_POLICY.workerEnabled ?? false,
    ...(input.auxiliaryMode === undefined ? {} : { auxiliaryMode: input.auxiliaryMode }),
    ...(input.tetoAdviceDelivery === undefined
      ? {}
      : { tetoAdviceDelivery: input.tetoAdviceDelivery }),
    ...(input.fukaiCompaction === undefined
      ? {}
      : { fukaiCompaction: normalizeFukaiCompactionPolicy(input.fukaiCompaction) }),
  } as RunPolicy;
  if (!Number.isSafeInteger(allowance) || allowance < 1) {
    throw new RangeError("maxMainStepsPerActivation must be a positive integer");
  }
  if (
    policy.maxModelTokens !== undefined
    && (!Number.isSafeInteger(policy.maxModelTokens) || policy.maxModelTokens < 1)
  ) {
    throw new RangeError("maxModelTokens must be a positive integer");
  }
  if (
    !Number.isSafeInteger(policy.mainRequestTimeoutMs)
    || policy.mainRequestTimeoutMs! < 1
    || policy.mainRequestTimeoutMs! > MAX_MAIN_REQUEST_TIMEOUT_MS
  ) {
    throw new RangeError(
      `mainRequestTimeoutMs must be an integer between 1 and ${MAX_MAIN_REQUEST_TIMEOUT_MS}`,
    );
  }
  if (
    !Number.isSafeInteger(policy.tetoMaxOutputTokens)
    || policy.tetoMaxOutputTokens < 1
  ) {
    throw new RangeError("tetoMaxOutputTokens must be a positive integer");
  }
  if (typeof policy.workerEnabled !== "boolean") {
    throw new TypeError("workerEnabled must be a boolean");
  }
  if (
    policy.tetoTokenRatio !== undefined
    && (policy.tetoTokenRatio <= 0 || policy.tetoTokenRatio >= 1)
  ) {
    throw new RangeError("tetoTokenRatio must be between zero and one");
  }
  if (policy.tetoActivation !== undefined
    && policy.tetoActivation !== "automatic"
    && policy.tetoActivation !== "manual") {
    throw new RangeError("tetoActivation must be automatic or manual");
  }
  if (
    policy.auxiliaryMode !== undefined
    && policy.auxiliaryMode !== "none"
    && policy.auxiliaryMode !== "teto"
    && policy.auxiliaryMode !== "reflection"
  ) {
    throw new RangeError("auxiliaryMode must be none, teto, or reflection");
  }
  if (
    policy.tetoAdviceDelivery !== undefined
    && policy.tetoAdviceDelivery !== "live"
    && policy.tetoAdviceDelivery !== "shadow"
  ) {
    throw new RangeError("tetoAdviceDelivery must be live or shadow");
  }
  return policy;
};

/** Validate and clone the durable Fukai policy at a runtime boundary. */
export const normalizeFukaiCompactionPolicy = (
  value: FukaiCompactionPolicy,
): FukaiCompactionPolicy => {
  if (value === null || typeof value !== "object") {
    throw new TypeError("fukaiCompaction must be an object");
  }
  if (typeof value.enabled !== "boolean") {
    throw new TypeError("fukaiCompaction.enabled must be a boolean");
  }
  if (value.provider !== "none" && value.provider !== "pi-ai") {
    throw new TypeError("fukaiCompaction.provider must be none or pi-ai");
  }
  if (value.enabled && value.provider === "none") {
    throw new TypeError("enabled Fukai compaction requires the pi-ai provider");
  }
  for (const [name, candidate, maximum] of [
    ["maxInputTokens", value.maxInputTokens, MAX_FUKAI_COMPACTION_INPUT_TOKENS],
    ["maxOutputTokens", value.maxOutputTokens, MAX_FUKAI_COMPACTION_OUTPUT_TOKENS],
    ["maxWallClockMs", value.maxWallClockMs, MAX_FUKAI_COMPACTION_WALL_CLOCK_MS],
  ] as const) {
    if (!Number.isSafeInteger(candidate) || candidate < 1) {
      throw new TypeError(`fukaiCompaction.${name} must be a positive integer`);
    }
    if (candidate > maximum) {
      throw new RangeError(`fukaiCompaction.${name} must be at most ${maximum}`);
    }
  }
  const thresholdRatio = value.thresholdRatio
    ?? DEFAULT_FUKAI_COMPACTION_THRESHOLD_RATIO;
  const retainRatio = value.retainRatio ?? DEFAULT_FUKAI_COMPACTION_RETAIN_RATIO;
  for (const [name, candidate] of [
    ["thresholdRatio", thresholdRatio],
    ["retainRatio", retainRatio],
  ] as const) {
    if (!Number.isFinite(candidate) || candidate <= 0 || candidate >= 1) {
      throw new RangeError(`fukaiCompaction.${name} must be between zero and one`);
    }
  }
  if (retainRatio >= thresholdRatio) {
    throw new RangeError("fukaiCompaction.retainRatio must be less than thresholdRatio");
  }
  const minimumGainTokens = value.minimumGainTokens
    ?? DEFAULT_FUKAI_COMPACTION_MINIMUM_GAIN_TOKENS;
  if (!Number.isSafeInteger(minimumGainTokens) || minimumGainTokens < 1) {
    throw new TypeError("fukaiCompaction.minimumGainTokens must be a positive integer");
  }
  if (minimumGainTokens > MAX_FUKAI_COMPACTION_INPUT_TOKENS) {
    throw new RangeError(
      `fukaiCompaction.minimumGainTokens must be at most ${MAX_FUKAI_COMPACTION_INPUT_TOKENS}`,
    );
  }
  return {
    ...structuredClone(value),
    thresholdRatio,
    retainRatio,
    minimumGainTokens,
  };
};
