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
}

/** A deliberately narrow error safe to persist in the Ledger. */
export class ProviderModelError extends Error {
  override readonly name = "ProviderModelError";
  readonly category: ProviderFailureCategory;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(details: ProviderModelErrorDetails) {
    const status = details.status === undefined ? "" : `, HTTP ${details.status}`;
    super(`Model provider failure (${details.category}${status})`);
    this.category = details.category;
    this.retryable = details.retryable;
    if (details.status !== undefined) this.status = details.status;
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs;
  }
}
