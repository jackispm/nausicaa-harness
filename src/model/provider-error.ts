import type { TokenUsage } from "../domain/types.js";

export type ProviderFailureCategory =
  | "aborted"
  | "authentication"
  | "invalid-request"
  | "network"
  | "permission"
  | "provider"
  | "quota"
  | "rate-limit"
  | "server"
  | "timeout"
  | "transient";

export interface ProviderModelErrorDetails {
  category: ProviderFailureCategory;
  retryable: boolean;
  status?: number;
  retryAfterMs?: number;
  /** Provider-reported accounting only; private response text is never retained. */
  providerUsage?: TokenUsage;
}

/** A deliberately narrow error safe to persist in the Ledger. */
export class ProviderModelError extends Error {
  override readonly name = "ProviderModelError";
  readonly category: ProviderFailureCategory;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly providerUsage?: TokenUsage;

  constructor(details: ProviderModelErrorDetails) {
    const status = details.status === undefined ? "" : `, HTTP ${details.status}`;
    super(`Model provider failure (${details.category}${status})`);
    this.category = details.category;
    this.retryable = details.retryable;
    if (details.status !== undefined) this.status = details.status;
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs;
    const providerUsage = safeUsage(details.providerUsage);
    if (providerUsage !== undefined) this.providerUsage = providerUsage;
  }
}

function safeUsage(value: TokenUsage | undefined): TokenUsage | undefined {
  if (value === undefined) return undefined;
  for (const name of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (!Number.isSafeInteger(value[name]) || value[name] < 0) return undefined;
  }
  if (value.costUsd !== undefined && (!Number.isFinite(value.costUsd) || value.costUsd < 0)) {
    return undefined;
  }
  return {
    input: value.input,
    output: value.output,
    cacheRead: value.cacheRead,
    cacheWrite: value.cacheWrite,
    ...(value.costUsd === undefined ? {} : { costUsd: value.costUsd }),
  };
}
