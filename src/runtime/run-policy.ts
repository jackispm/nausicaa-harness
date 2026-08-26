import type { RunPolicy } from "../domain/types.js";
import { mainStepAllowance } from "../domain/types.js";

export const DEFAULT_RUN_POLICY: RunPolicy = {
  maxMainStepsPerActivation: 24,
  maxModelTokens: 200_000,
  tetoEnabled: true,
  tetoMaxOutputTokens: 200,
  tetoTokenRatio: 0.1,
};

export const resolveRunPolicy = (input: Partial<RunPolicy> = {}): RunPolicy => {
  const allowance = input.maxMainStepsPerActivation
    ?? input.maxMainSteps
    ?? mainStepAllowance(DEFAULT_RUN_POLICY);
  const policy: RunPolicy = {
    maxMainStepsPerActivation: allowance,
    maxModelTokens: input.maxModelTokens ?? DEFAULT_RUN_POLICY.maxModelTokens,
    tetoEnabled: input.tetoEnabled ?? DEFAULT_RUN_POLICY.tetoEnabled,
    tetoMaxOutputTokens: input.tetoMaxOutputTokens ?? DEFAULT_RUN_POLICY.tetoMaxOutputTokens,
    tetoTokenRatio: input.tetoTokenRatio ?? DEFAULT_RUN_POLICY.tetoTokenRatio,
    ...(input.auxiliaryMode === undefined ? {} : { auxiliaryMode: input.auxiliaryMode }),
    ...(input.tetoAdviceDelivery === undefined
      ? {}
      : { tetoAdviceDelivery: input.tetoAdviceDelivery }),
  };
  if (!Number.isSafeInteger(allowance) || allowance < 1) {
    throw new RangeError("maxMainStepsPerActivation must be a positive integer");
  }
  if (!Number.isSafeInteger(policy.maxModelTokens) || policy.maxModelTokens < 1) {
    throw new RangeError("maxModelTokens must be a positive integer");
  }
  if (
    !Number.isSafeInteger(policy.tetoMaxOutputTokens)
    || policy.tetoMaxOutputTokens < 1
  ) {
    throw new RangeError("tetoMaxOutputTokens must be a positive integer");
  }
  if (policy.tetoTokenRatio <= 0 || policy.tetoTokenRatio >= 1) {
    throw new RangeError("tetoTokenRatio must be between zero and one");
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
