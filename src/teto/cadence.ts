import type { MainTriggerKind, TokenUsage } from "../domain/index.js";

export interface TetoCadenceOptions {
  creditThreshold?: number;
  firstPassThreshold?: number;
  maxGap?: number;
  minGap?: number;
  rollingWindow?: number;
  maxPassesPerWindow?: number;
}

export interface TetoCadenceState {
  mainCallIndex: number;
  credit: number;
  passCalls: number[];
}

export type TetoWakeReason = "credit" | "max-gap" | "hard-trigger";
export type TetoWakeBlock = "min-gap" | "rolling-limit";

export interface TetoCadenceDecision {
  mainCallIndex: number;
  credit: number;
  shouldWake: boolean;
  hardTrigger: boolean;
  reason?: TetoWakeReason;
  blockedBy?: TetoWakeBlock;
}

const DEFAULT_CADENCE = {
  creditThreshold: 5,
  firstPassThreshold: 2,
  maxGap: 7,
  minGap: 4,
  rollingWindow: 20,
  maxPassesPerWindow: 4,
} as const;

const hardTriggers = new Set<MainTriggerKind>([
  "goal-change",
  "repeated-failure",
  "contradiction",
]);

export class TetoCadence {
  readonly options: Required<TetoCadenceOptions>;
  private mainCallIndex: number;
  private credit: number;
  private passCalls: number[];
  private pendingDecision: TetoCadenceDecision | undefined;

  constructor(
    options: TetoCadenceOptions = {},
    state: TetoCadenceState = { mainCallIndex: 0, credit: 0, passCalls: [] },
  ) {
    this.options = { ...DEFAULT_CADENCE, ...options };
    validateOptions(this.options);
    validateState(state);
    this.mainCallIndex = state.mainCallIndex;
    this.credit = Math.min(state.credit, this.options.creditThreshold);
    this.passCalls = [...state.passCalls];
    this.pendingDecision = undefined;
  }

  recordMainCall(trigger: MainTriggerKind = "normal"): TetoCadenceDecision {
    if (this.pendingDecision?.shouldWake) {
      throw new Error("Commit or skip the pending Teto wake before recording another Main call");
    }

    this.pendingDecision = undefined;
    this.mainCallIndex += 1;
    const hardTrigger = hardTriggers.has(trigger);
    const addedCredit = trigger === "decision" ? 2 : 1;
    this.credit = hardTrigger
      ? this.options.creditThreshold
      : Math.min(this.options.creditThreshold, this.credit + addedCredit);

    const previousPass = this.passCalls.at(-1);
    const callsSincePass = previousPass === undefined
      ? this.mainCallIndex
      : this.mainCallIndex - previousPass;
    const creditThreshold = previousPass === undefined
      ? this.options.firstPassThreshold
      : this.options.creditThreshold;
    const reason = hardTrigger
      ? "hard-trigger"
      : this.credit >= creditThreshold
        ? "credit"
        : callsSincePass >= this.options.maxGap
          ? "max-gap"
          : undefined;

    if (reason === undefined) {
      return {
        mainCallIndex: this.mainCallIndex,
        credit: this.credit,
        shouldWake: false,
        hardTrigger,
      };
    }

    const passesInWindow = this.passCalls.filter(
      (call) => call > this.mainCallIndex - this.options.rollingWindow,
    ).length;
    const blockedBy = previousPass !== undefined && callsSincePass < this.options.minGap
      ? "min-gap"
      : passesInWindow >= this.options.maxPassesPerWindow
        ? "rolling-limit"
        : undefined;
    const decision: TetoCadenceDecision = {
      mainCallIndex: this.mainCallIndex,
      credit: this.credit,
      shouldWake: blockedBy === undefined,
      hardTrigger,
      reason,
      ...(blockedBy === undefined ? {} : { blockedBy }),
    };

    if (decision.shouldWake) {
      this.pendingDecision = decision;
    }
    return decision;
  }

  commitPass(mainCallIndex = this.mainCallIndex): void {
    if (
      this.pendingDecision === undefined
      || !this.pendingDecision.shouldWake
      || this.pendingDecision.mainCallIndex !== mainCallIndex
    ) {
      throw new Error(`No eligible Teto wake at Main call ${mainCallIndex}`);
    }

    this.passCalls.push(mainCallIndex);
    this.credit = 0;
    this.pendingDecision = undefined;
  }

  skipPass(mainCallIndex = this.mainCallIndex): void {
    if (this.pendingDecision?.mainCallIndex !== mainCallIndex) {
      throw new Error(`No pending Teto wake at Main call ${mainCallIndex}`);
    }
    this.pendingDecision = undefined;
  }

  snapshot(): TetoCadenceState {
    return {
      mainCallIndex: this.mainCallIndex,
      credit: this.credit,
      passCalls: [...this.passCalls],
    };
  }
}

export interface TokenRatioGateState {
  mainTokens: number;
  tetoTokens: number;
  reservations: Array<{ id: string; tokens: number }>;
}

export interface TokenReservation {
  id: string;
  tokens: number;
}

/** Optional Teto/Main ratio gate; an omitted ratio leaves Teto uncapped. */
export class TokenRatioGate {
  private mainTokens: number;
  private tetoTokens: number;
  private readonly reservations = new Map<string, number>();

  constructor(
    readonly ratio: number | undefined = undefined,
    state: TokenRatioGateState = {
      mainTokens: 0,
      tetoTokens: 0,
      reservations: [],
    },
  ) {
    if (ratio !== undefined && (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1)) {
      throw new RangeError("Teto token ratio must be between 0 and 1");
    }
    assertNonNegativeInteger(state.mainTokens, "mainTokens");
    assertNonNegativeInteger(state.tetoTokens, "tetoTokens");
    this.mainTokens = state.mainTokens;
    this.tetoTokens = state.tetoTokens;
    for (const reservation of state.reservations) {
      assertPositiveInteger(reservation.tokens, "reservation tokens");
      if (this.reservations.has(reservation.id)) {
        throw new Error(`Duplicate token reservation: ${reservation.id}`);
      }
      this.reservations.set(reservation.id, reservation.tokens);
    }
  }

  chargeMain(usage: TokenUsage | number): void {
    this.mainTokens = safeAdd(this.mainTokens, usageTokens(usage), "main token total");
  }

  availableTetoTokens(): number {
    if (this.ratio === undefined) return Number.MAX_SAFE_INTEGER;
    const reserved = sum(this.reservations.values());
    const maximumTetoTokens = Math.floor(
      (this.ratio * this.mainTokens) / (1 - this.ratio),
    );
    return Math.max(0, maximumTetoTokens - this.tetoTokens - reserved);
  }

  reserve(id: string, tokens: number): TokenReservation | undefined {
    assertPositiveInteger(tokens, "reservation tokens");
    const existing = this.reservations.get(id);
    if (existing !== undefined) {
      if (existing !== tokens) {
        throw new Error(`Token reservation ${id} was reused with a different size`);
      }
      return { id, tokens: existing };
    }
    if (tokens > this.availableTetoTokens()) {
      return undefined;
    }
    this.reservations.set(id, tokens);
    return { id, tokens };
  }

  settle(id: string, usage: TokenUsage | number): void {
    const reserved = this.reservations.get(id);
    if (reserved === undefined) {
      throw new Error(`Unknown token reservation: ${id}`);
    }
    const actual = usageTokens(usage);
    if (actual > reserved) {
      throw new RangeError(
        `Teto used ${actual} tokens but reservation ${id} only allowed ${reserved}`,
      );
    }
    this.reservations.delete(id);
    this.tetoTokens = safeAdd(this.tetoTokens, actual, "Teto token total");
  }

  cancel(id: string): void {
    this.reservations.delete(id);
  }

  snapshot(): TokenRatioGateState {
    return {
      mainTokens: this.mainTokens,
      tetoTokens: this.tetoTokens,
      reservations: [...this.reservations].map(([id, tokens]) => ({ id, tokens })),
    };
  }
}

function validateOptions(options: Required<TetoCadenceOptions>): void {
  assertPositiveInteger(options.creditThreshold, "creditThreshold");
  assertPositiveInteger(options.firstPassThreshold, "firstPassThreshold");
  assertPositiveInteger(options.maxGap, "maxGap");
  assertPositiveInteger(options.minGap, "minGap");
  assertPositiveInteger(options.rollingWindow, "rollingWindow");
  assertPositiveInteger(options.maxPassesPerWindow, "maxPassesPerWindow");
  if (options.minGap > options.maxGap) {
    throw new RangeError("minGap cannot exceed maxGap");
  }
  if (options.minGap > options.rollingWindow) {
    throw new RangeError("minGap cannot exceed rollingWindow");
  }
}

function validateState(state: TetoCadenceState): void {
  assertNonNegativeInteger(state.mainCallIndex, "mainCallIndex");
  assertNonNegativeInteger(state.credit, "credit");
  let previous = 0;
  for (const call of state.passCalls) {
    assertPositiveInteger(call, "pass call");
    if (call <= previous || call > state.mainCallIndex) {
      throw new Error("Teto pass calls must be ordered and within the Main call count");
    }
    previous = call;
  }
}

function usageTokens(usage: TokenUsage | number): number {
  if (typeof usage === "number") {
    assertNonNegativeInteger(usage, "token usage");
    return usage;
  }
  assertNonNegativeInteger(usage.input, "input tokens");
  assertNonNegativeInteger(usage.output, "output tokens");
  assertNonNegativeInteger(usage.cacheRead, "cache-read tokens");
  assertNonNegativeInteger(usage.cacheWrite, "cache-write tokens");
  return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
    .reduce((total, value) => safeAdd(total, value, "token usage"), 0);
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) {
    total = safeAdd(total, value, "reserved token total");
  }
  return total;
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${label} exceeds the safe integer range`);
  }
  return result;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
}
