import { stableJson } from "../ledger/hash.js";
import {
  validateEdgeContextContribution,
  validateEdgeContextContributionSummary,
} from "./edge-adapter.js";
import type {
  EdgeContextContribution,
  EdgeContextContributionSummary,
} from "./edge-types.js";

export const DEFAULT_SKILL_SELECTION_MAX_SKILLS = 16;
export const MAX_SKILL_SELECTION_MAX_SKILLS = 128;
export const DEFAULT_SKILL_SELECTION_MAX_BYTES = 256 * 1024;
export const MAX_SKILL_SELECTION_MAX_BYTES = 4 * 1024 * 1024;

export interface SkillSelectionSourceSnapshot {
  readonly generation: number;
  readonly contextContributions: readonly EdgeContextContributionSummary[];
}

export interface SkillSelectionOptions {
  /** Maximum explicitly selected Skills in one generation. */
  readonly maxSkills?: number;
  /** Maximum aggregate UTF-8 body bytes admitted for one Turn. */
  readonly maxBytes?: number;
}

export interface SkillSelectionSnapshot {
  readonly generation: number;
  readonly maxSkills: number;
  readonly maxBytes: number;
  readonly selected: readonly EdgeContextContributionSummary[];
}

export type SkillSelectionDiagnosticCode =
  | "generation-mismatch"
  | "summary-invalid"
  | "summary-not-found"
  | "summary-forged"
  | "not-a-skill"
  | "disabled"
  | "skill-limit"
  | "load-failed"
  | "load-cancelled"
  | "body-missing"
  | "byte-limit";

export interface SkillSelectionDiagnostic {
  readonly code: SkillSelectionDiagnosticCode;
  readonly severity: "warning" | "error";
  readonly generation: number;
  readonly sourceId?: string;
  readonly contributionId?: string;
  readonly message: string;
}

export interface SkillSelectionUpdate {
  readonly changed: boolean;
  readonly snapshot: SkillSelectionSnapshot;
  readonly diagnostics: readonly SkillSelectionDiagnostic[];
}

export interface SkillContributionLoadContext {
  readonly generation: number;
  /** Remaining Turn budget. Loaders should use this as their body limit. */
  readonly maxBodyBytes: number;
  readonly signal?: AbortSignal;
}

export type SkillContributionLoader = (
  summary: EdgeContextContributionSummary,
  context: SkillContributionLoadContext,
) => Promise<EdgeContextContribution>;

export interface SkillActivationOptions {
  readonly generation: number;
  readonly signal?: AbortSignal;
}

export interface SkillActivationResult {
  readonly generation: number;
  readonly selection: SkillSelectionSnapshot;
  readonly contributions: readonly EdgeContextContribution[];
  readonly totalBytes: number;
  readonly cancelled: boolean;
  readonly diagnostics: readonly SkillSelectionDiagnostic[];
}

type LoadOutcome =
  | { readonly contribution: EdgeContextContribution }
  | { readonly error: unknown; readonly cancelled: boolean };

/**
 * Generation-bound explicit Skill selection. Discovery alone never selects or
 * loads a Skill; callers must opt in with the exact summary they discovered.
 */
export class SkillSelection {
  readonly #generation: number;
  readonly #maxSkills: number;
  readonly #maxBytes: number;
  readonly #available = new Map<string, EdgeContextContributionSummary>();
  readonly #selected = new Map<string, EdgeContextContributionSummary>();
  readonly #loads = new Map<string, Promise<LoadOutcome>>();

  constructor(
    source: SkillSelectionSourceSnapshot,
    options: SkillSelectionOptions = {},
  ) {
    this.#generation = requiredGeneration(source.generation);
    this.#maxSkills = boundedInteger(
      options.maxSkills,
      DEFAULT_SKILL_SELECTION_MAX_SKILLS,
      MAX_SKILL_SELECTION_MAX_SKILLS,
      "maxSkills",
    );
    this.#maxBytes = boundedInteger(
      options.maxBytes,
      DEFAULT_SKILL_SELECTION_MAX_BYTES,
      MAX_SKILL_SELECTION_MAX_BYTES,
      "maxBytes",
    );
    if (!Array.isArray(source.contextContributions)) {
      throw new TypeError("contextContributions must be an array");
    }
    for (const candidate of source.contextContributions) {
      const summary = validateEdgeContextContributionSummary(candidate);
      if (summary.sourceType !== "skill") continue;
      const key = skillSelectionKey(summary.sourceId, summary.contributionId);
      if (this.#available.has(key)) {
        throw new TypeError(
          `Duplicate Skill contribution ${summary.sourceId}:${summary.contributionId}`,
        );
      }
      this.#available.set(key, summary);
    }
  }

  get generation(): number {
    return this.#generation;
  }

  snapshot(): SkillSelectionSnapshot {
    return freeze({
      generation: this.#generation,
      maxSkills: this.#maxSkills,
      maxBytes: this.#maxBytes,
      selected: [...this.#selected.values()].sort(compareSummaries),
    });
  }

  select(
    generation: number,
    candidate: EdgeContextContributionSummary,
  ): SkillSelectionUpdate {
    const generationDiagnostic = this.#generationDiagnostic(generation);
    if (generationDiagnostic !== undefined) return this.#update(false, [generationDiagnostic]);

    let summary: EdgeContextContributionSummary;
    try {
      summary = validateEdgeContextContributionSummary(candidate);
    } catch (error) {
      return this.#update(false, [diagnostic(
        "summary-invalid",
        "error",
        this.#generation,
        `Skill summary is invalid: ${errorMessage(error)}`,
      )]);
    }
    if (summary.sourceType !== "skill") {
      return this.#update(false, [diagnostic(
        "not-a-skill",
        "error",
        this.#generation,
        "Only Skill context contributions can be selected",
        summary,
      )]);
    }
    const key = skillSelectionKey(summary.sourceId, summary.contributionId);
    const available = this.#available.get(key);
    if (available === undefined) {
      return this.#update(false, [diagnostic(
        "summary-not-found",
        "error",
        this.#generation,
        "Skill summary is not present in this generation",
        summary,
      )]);
    }
    if (stableJson(available) !== stableJson(summary)) {
      return this.#update(false, [diagnostic(
        "summary-forged",
        "error",
        this.#generation,
        "Skill summary does not match the discovered generation",
        summary,
      )]);
    }
    if (available.disabled) {
      return this.#update(false, [diagnostic(
        "disabled",
        "warning",
        this.#generation,
        "Skill disables model invocation and cannot be selected",
        available,
      )]);
    }
    if (this.#selected.has(key)) return this.#update(false, []);
    if (this.#selected.size >= this.#maxSkills) {
      return this.#update(false, [diagnostic(
        "skill-limit",
        "error",
        this.#generation,
        `Skill selection exceeds the ${this.#maxSkills} item limit`,
        available,
      )]);
    }
    this.#selected.set(key, available);
    return this.#update(true, []);
  }

  deselect(generation: number, sourceId: string, contributionId: string): SkillSelectionUpdate {
    const generationDiagnostic = this.#generationDiagnostic(generation);
    if (generationDiagnostic !== undefined) return this.#update(false, [generationDiagnostic]);
    if (!isIdentity(sourceId) || !isIdentity(contributionId)) {
      return this.#update(false, [diagnostic(
        "summary-invalid",
        "error",
        this.#generation,
        "Skill sourceId and contributionId must be non-empty identity strings",
      )]);
    }
    const changed = this.#selected.delete(skillSelectionKey(sourceId, contributionId));
    return this.#update(changed, []);
  }

  clear(generation: number): SkillSelectionUpdate {
    const generationDiagnostic = this.#generationDiagnostic(generation);
    if (generationDiagnostic !== undefined) return this.#update(false, [generationDiagnostic]);
    const changed = this.#selected.size > 0;
    this.#selected.clear();
    return this.#update(changed, []);
  }

  async activate(
    loader: SkillContributionLoader,
    options: SkillActivationOptions,
  ): Promise<SkillActivationResult> {
    const selection = this.snapshot();
    const signal = options.signal;
    const generationDiagnostic = this.#generationDiagnostic(options.generation);
    if (generationDiagnostic !== undefined) {
      return activationResult(selection, [], 0, false, [generationDiagnostic]);
    }
    if (isAborted(signal)) {
      return activationResult(selection, [], 0, true, [this.#cancelledDiagnostic(
        undefined,
        signal?.reason,
      )]);
    }

    const contributions: EdgeContextContribution[] = [];
    const diagnostics: SkillSelectionDiagnostic[] = [];
    let totalBytes = 0;
    let cancelled = false;
    for (const summary of selection.selected) {
      if (isAborted(signal)) {
        cancelled = true;
        diagnostics.push(this.#cancelledDiagnostic(summary, signal?.reason));
        break;
      }
      const remainingBytes = this.#maxBytes - totalBytes;
      if (remainingBytes === 0) {
        diagnostics.push(diagnostic(
          "byte-limit",
          "error",
          this.#generation,
          `Skill body exceeds the ${this.#maxBytes} byte Turn limit`,
          summary,
        ));
        continue;
      }
      let outcome: LoadOutcome;
      try {
        outcome = await awaitWithSignal(
          this.#loadOnce(summary, loader, remainingBytes, signal),
          signal,
        );
      } catch (error) {
        cancelled = true;
        diagnostics.push(this.#cancelledDiagnostic(summary, error));
        break;
      }
      if ("error" in outcome) {
        const wasCancelled = outcome.cancelled || isAborted(signal);
        diagnostics.push(wasCancelled
          ? this.#cancelledDiagnostic(summary, outcome.error)
          : diagnostic(
              "load-failed",
              "error",
              this.#generation,
              `Skill load failed: ${errorMessage(outcome.error)}`,
              summary,
            ));
        if (isAborted(signal)) {
          cancelled = true;
          break;
        }
        continue;
      }
      const body = outcome.contribution.body;
      if (body === undefined) {
        diagnostics.push(diagnostic(
          "body-missing",
          "error",
          this.#generation,
          "Selected Skill did not return an instruction body",
          summary,
        ));
        continue;
      }
      const bodyBytes = Buffer.byteLength(body, "utf8");
      if (bodyBytes > remainingBytes) {
        diagnostics.push(diagnostic(
          "byte-limit",
          "error",
          this.#generation,
          `Skill body exceeds the ${this.#maxBytes} byte Turn limit`,
          summary,
        ));
        continue;
      }
      totalBytes += bodyBytes;
      contributions.push(outcome.contribution);
    }
    return activationResult(selection, contributions, totalBytes, cancelled, diagnostics);
  }

  #generationDiagnostic(generation: number): SkillSelectionDiagnostic | undefined {
    if (Number.isSafeInteger(generation) && generation === this.#generation) return undefined;
    return diagnostic(
      "generation-mismatch",
      "error",
      this.#generation,
      `Skill selection belongs to generation ${this.#generation}, not ${String(generation)}`,
    );
  }

  #update(
    changed: boolean,
    diagnostics: readonly SkillSelectionDiagnostic[],
  ): SkillSelectionUpdate {
    return freeze({ changed, snapshot: this.snapshot(), diagnostics: [...diagnostics] });
  }

  #cancelledDiagnostic(
    summary: EdgeContextContributionSummary | undefined,
    reason: unknown,
  ): SkillSelectionDiagnostic {
    return diagnostic(
      "load-cancelled",
      "warning",
      this.#generation,
      `Skill activation was cancelled: ${errorMessage(reason ?? "cancelled")}`,
      summary,
    );
  }

  #loadOnce(
    summary: EdgeContextContributionSummary,
    loader: SkillContributionLoader,
    maxBodyBytes: number,
    signal: AbortSignal | undefined,
  ): Promise<LoadOutcome> {
    const key = skillSelectionKey(summary.sourceId, summary.contributionId);
    const existing = this.#loads.get(key);
    if (existing !== undefined) return existing;
    const pending = (async (): Promise<LoadOutcome> => {
      try {
        const loaded = await loader(summary, {
          generation: this.#generation,
          maxBodyBytes,
          ...(signal === undefined ? {} : { signal }),
        });
        const contribution = validateEdgeContextContribution(loaded);
        assertLoadedIdentity(summary, contribution);
        return freeze({ contribution });
      } catch (error) {
        return freeze({ error, cancelled: signal?.aborted === true });
      }
    })();
    this.#loads.set(key, pending);
    return pending;
  }
}

export function createSkillSelection(
  source: SkillSelectionSourceSnapshot,
  options: SkillSelectionOptions = {},
): SkillSelection {
  return new SkillSelection(source, options);
}

/** Collision-free stable key for a host source and its contribution identity. */
export function skillSelectionKey(sourceId: string, contributionId: string): string {
  if (typeof sourceId !== "string" || sourceId.length === 0) {
    throw new TypeError("sourceId must be a non-empty string");
  }
  if (typeof contributionId !== "string" || contributionId.length === 0) {
    throw new TypeError("contributionId must be a non-empty string");
  }
  return `${sourceId.length}:${sourceId}${contributionId.length}:${contributionId}`;
}

function isIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function assertLoadedIdentity(
  summary: EdgeContextContributionSummary,
  loaded: EdgeContextContribution,
): void {
  if (loaded.kind !== summary.kind
    || loaded.sourceId !== summary.sourceId
    || loaded.sourceType !== summary.sourceType
    || loaded.contributionId !== summary.contributionId
    || loaded.name !== summary.name
    || loaded.description !== summary.description
    || loaded.disabled !== summary.disabled
    || loaded.userInvocable !== summary.userInvocable
    || stableJson(loaded.provenance ?? null) !== stableJson(summary.provenance ?? null)
    || (summary.contentHash !== undefined && loaded.contentHash !== summary.contentHash)) {
    throw new TypeError("Loaded Skill does not match its selected summary");
  }
}

function activationResult(
  selection: SkillSelectionSnapshot,
  contributions: readonly EdgeContextContribution[],
  totalBytes: number,
  cancelled: boolean,
  diagnostics: readonly SkillSelectionDiagnostic[],
): SkillActivationResult {
  return freeze({
    generation: selection.generation,
    selection,
    contributions: [...contributions],
    totalBytes,
    cancelled,
    diagnostics: [...diagnostics],
  });
}

function diagnostic(
  code: SkillSelectionDiagnosticCode,
  severity: SkillSelectionDiagnostic["severity"],
  generation: number,
  message: string,
  summary?: Pick<EdgeContextContributionSummary, "sourceId" | "contributionId">,
): SkillSelectionDiagnostic {
  return freeze({
    code,
    severity,
    generation,
    ...(summary === undefined ? {} : {
      sourceId: summary.sourceId,
      contributionId: summary.contributionId,
    }),
    message,
  });
}

function compareSummaries(
  left: EdgeContextContributionSummary,
  right: EdgeContextContributionSummary,
): number {
  return compareText(left.sourceId, right.sourceId)
    || compareText(left.contributionId, right.contributionId)
    || compareText(left.name, right.name)
    || compareText(left.contentHash ?? "", right.contentHash ?? "");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
  minimum = 1,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return resolved;
}

function requiredGeneration(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new RangeError("generation must be a non-negative safe integer");
  }
  return Number(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function awaitWithSignal<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return pending;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Skill activation cancelled"));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new Error("Skill activation cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function freeze<T>(value: T): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  if (Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return Object.freeze(value);
}
