import type { TokenUsage } from "../domain/index.js";

export interface RunTokenReservation {
  id: string;
  tokens: number;
  status: "reserved" | "settled";
}

export interface RunTokenSettlement {
  id: string;
  reservedTokens: number;
  actualTokens: number;
  overrunTokens: number;
}

export interface RunTokenBudgetOptions {
  /** Optional aggregate budget used by a child lane for admission/settlement. */
  parent?: RunTokenBudget;
  /** Stable namespace for reservations recorded in the parent budget. */
  scope?: string;
}

export interface RunTokenBudgetSnapshot {
  /** Omitted for an unbounded Run budget. */
  maxTokens?: number;
  usedTokens: number;
  reservedTokens: number;
  availableTokens: number;
  reservations: Array<{ id: string; tokens: number }>;
  settlements: RunTokenSettlement[];
}

/**
 * Single-process admission gate for all model calls in one Run. An omitted
 * maxTokens keeps accounting and idempotent settlement without imposing a
 * cumulative Run limit. Methods are synchronous so checking capacity and
 * recording a reservation is atomic.
 */
export class RunTokenBudget {
  /** Undefined means no aggregate Run token limit. */
  readonly maxTokens: number | undefined;
  private usedTokens: number;
  private reservedTokens = 0;
  private readonly reservations = new Map<string, number>();
  private readonly settlements = new Map<string, RunTokenSettlement>();
  private readonly parent: RunTokenBudget | undefined;
  private readonly parentReservationPrefix: string | undefined;

  constructor(maxTokens: number | undefined, usedTokens = 0, options: RunTokenBudgetOptions = {}) {
    if (maxTokens !== undefined) positiveInteger(maxTokens, "maxTokens");
    nonNegativeInteger(usedTokens, "usedTokens");
    if (options.parent === this) throw new TypeError("A token budget cannot parent itself");
    if (options.parent !== undefined) {
      const scope = options.scope;
      if (scope === undefined || scope.trim().length === 0 || scope.includes("\0")) {
        throw new TypeError("scoped token budgets require a non-empty scope");
      }
      this.parent = options.parent;
      this.parentReservationPrefix = `child:${scope}:`;
    }
    this.maxTokens = maxTokens;
    this.usedTokens = usedTokens;
  }

  availableTokens(): number {
    // Keep the numeric API stable for callers that size a provider request,
    // while an omitted max remains genuinely unbounded in reserve().
    if (this.maxTokens === undefined) return Number.MAX_SAFE_INTEGER;
    return Math.max(0, this.maxTokens - this.usedTokens - this.reservedTokens);
  }

  reserve(id: string, tokens: number): RunTokenReservation | undefined {
    reservationId(id);
    positiveInteger(tokens, "reservation tokens");

    const settled = this.settlements.get(id);
    if (settled !== undefined) {
      if (settled.reservedTokens !== tokens) {
        throw new Error(`Token reservation ${id} was reused with a different size`);
      }
      return { id, tokens, status: "settled" };
    }

    const existing = this.reservations.get(id);
    if (existing !== undefined) {
      if (existing !== tokens) {
        throw new Error(`Token reservation ${id} was reused with a different size`);
      }
      return { id, tokens, status: "reserved" };
    }
    if (this.maxTokens !== undefined && tokens > this.availableTokens()) return undefined;
    const parentId = this.parentReservationId(id);
    if (parentId !== undefined && this.parent?.reserve(parentId, tokens) === undefined) {
      return undefined;
    }

    this.reservations.set(id, tokens);
    this.reservedTokens = safeAdd(this.reservedTokens, tokens, "reserved token total");
    return { id, tokens, status: "reserved" };
  }

  settle(id: string, usage: TokenUsage | number): RunTokenSettlement {
    reservationId(id);
    const actualTokens = usageTokens(usage);
    const settled = this.settlements.get(id);
    if (settled !== undefined) {
      if (settled.actualTokens !== actualTokens) {
        throw new Error(`Token settlement ${id} was reused with different usage`);
      }
      return { ...settled };
    }

    const reservedTokens = this.reservations.get(id);
    if (reservedTokens === undefined) {
      throw new Error(`Unknown token reservation: ${id}`);
    }
    const parentId = this.parentReservationId(id);
    if (parentId !== undefined) this.parent?.settle(parentId, actualTokens);
    const nextUsedTokens = safeAdd(this.usedTokens, actualTokens, "used token total");
    this.reservations.delete(id);
    this.reservedTokens -= reservedTokens;
    this.usedTokens = nextUsedTokens;
    const settlement: RunTokenSettlement = {
      id,
      reservedTokens,
      actualTokens,
      overrunTokens: Math.max(0, actualTokens - reservedTokens),
    };
    this.settlements.set(id, settlement);
    return { ...settlement };
  }

  /** Reconcile a durable terminal with either a live reservation or recovered usage. */
  reconcile(
    id: string,
    usage: TokenUsage | number,
    options: { alreadyAccounted?: boolean } = {},
  ): RunTokenSettlement {
    reservationId(id);
    if (this.reservations.has(id)) return this.settle(id, usage);
    const actualTokens = usageTokens(usage);
    const settled = this.settlements.get(id);
    if (settled !== undefined) {
      if (settled.actualTokens !== actualTokens) {
        throw new Error(`Token settlement ${id} was reused with different usage`);
      }
      return { ...settled };
    }
    // A child budget is only an admission scope; the parent remains the
    // aggregate accounting authority. Reconcile its namespaced reservation
    // even when this child was reconstructed after a process restart.
    const parentId = this.parentReservationId(id);
    if (parentId !== undefined) {
      this.parent?.reconcile(parentId, actualTokens, options);
    }
    if (options.alreadyAccounted !== true) {
      this.usedTokens = safeAdd(this.usedTokens, actualTokens, "used token total");
    }
    const settlement: RunTokenSettlement = {
      id,
      reservedTokens: 0,
      actualTokens,
      overrunTokens: actualTokens,
    };
    this.settlements.set(id, settlement);
    return { ...settlement };
  }

  cancel(id: string): void {
    reservationId(id);
    const reserved = this.reservations.get(id);
    if (reserved === undefined) return;
    const parentId = this.parentReservationId(id);
    if (parentId !== undefined) this.parent?.cancel(parentId);
    this.reservations.delete(id);
    this.reservedTokens -= reserved;
  }

  snapshot(): RunTokenBudgetSnapshot {
    return {
      ...(this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens }),
      usedTokens: this.usedTokens,
      reservedTokens: this.reservedTokens,
      availableTokens: this.availableTokens(),
      reservations: [...this.reservations]
        .map(([id, tokens]) => ({ id, tokens }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      settlements: [...this.settlements.values()]
        .map((settlement) => ({ ...settlement }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
  }

  private parentReservationId(id: string): string | undefined {
    return this.parentReservationPrefix === undefined
      ? undefined
      : `${this.parentReservationPrefix}${id}`;
  }
}

function usageTokens(usage: TokenUsage | number): number {
  if (typeof usage === "number") {
    nonNegativeInteger(usage, "token usage");
    return usage;
  }
  nonNegativeInteger(usage.input, "input tokens");
  nonNegativeInteger(usage.output, "output tokens");
  nonNegativeInteger(usage.cacheRead, "cache-read tokens");
  nonNegativeInteger(usage.cacheWrite, "cache-write tokens");
  return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
    .reduce((total, value) => safeAdd(total, value, "token usage"), 0);
}

function reservationId(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new TypeError("reservation id must be a non-empty string without NUL");
  }
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function nonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${label} exceeds the safe integer range`);
  }
  return result;
}
