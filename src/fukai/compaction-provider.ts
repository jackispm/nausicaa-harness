import {
  FUKAI_COMPACTION_MEDIA_TYPE,
  type ContextCompactionSummary,
  type ContextSourceRef,
} from "../domain/context.js";
import type { Goal, ArtifactRef, TokenUsage } from "../domain/types.js";
import { cloneJson, sha256, stableJson } from "../ledger/hash.js";
import { assertArtifactRef, type ContentAddressedStore } from "../store/store.js";
import type {
  FukaiCompactionProvider,
  FukaiCompactionRequest,
  FukaiCompactionSelection,
} from "./types.js";

const MAX_SOURCE_REFS = 128;
const MAX_IDENTITY_LENGTH = 512;
const MAX_SUMMARY_BYTES = 4 * 1024 * 1024;
const MAX_SUMMARY_ITEMS = 128;
const MAX_SUMMARY_TEXT_LENGTH = 8 * 1024;
const MAX_INPUT_TOKENS = 16 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 16 * 1024 * 1024;
const MAX_WALL_CLOCK_MS = 5 * 60 * 1_000;
const COMPACTION_ID_PATTERN = /^fukai-compaction:sha256:[0-9a-f]{64}$/;

/**
 * A deliberately small generation boundary. The adapter does not choose a
 * model or invoke one itself; callers opt in with a generator (for example a
 * pi-ai-backed summarizer) and receive a durable, content-addressed result.
 */
export interface FukaiCompactionSummaryGeneration {
  summary: ContextCompactionSummary;
  /** Transient provider usage; never serialized into the summary artifact. */
  providerUsage?: TokenUsage;
}

export type FukaiCompactionSummaryGenerator = (
  request: FukaiCompactionRequest,
) => ContextCompactionSummary
  | FukaiCompactionSummaryGeneration
  | Promise<ContextCompactionSummary | FukaiCompactionSummaryGeneration>;

export interface FukaiCompactionProviderOptions {
  store: Pick<ContentAddressedStore, "put">;
  generateSummary: FukaiCompactionSummaryGenerator;
  /** Optional tighter ceiling for this provider instance. */
  maxSummaryBytes?: number;
}

export class FukaiCompactionProviderError extends Error {
  override readonly name: string = "FukaiCompactionProviderError";
  readonly providerUsage: TokenUsage | undefined;

  constructor(message: string, providerUsage?: TokenUsage, options?: ErrorOptions) {
    super(message, options);
    this.providerUsage = providerUsage === undefined
      ? undefined
      : cloneJson(providerUsage);
  }
}

export class FukaiCompactionBudgetError extends FukaiCompactionProviderError {
  override readonly name = "FukaiCompactionBudgetError";
}

export class FukaiCompactionTimeoutError extends FukaiCompactionProviderError {
  override readonly name = "FukaiCompactionTimeoutError";
}

/**
 * Adapts a summary generator to the Fukai compaction contract.
 *
 * This provider is opt-in and side-effect free with respect to the Ledger: it
 * only writes the immutable summary object to the supplied Store. The caller
 * must explicitly pass the returned selection to FukaiCore.commitCompaction.
 */
export class FukaiCompactionProviderAdapter implements FukaiCompactionProvider {
  readonly #store: Pick<ContentAddressedStore, "put">;
  readonly #generateSummary: FukaiCompactionSummaryGenerator;
  readonly #maxSummaryBytes: number;

  constructor(options: FukaiCompactionProviderOptions) {
    if (typeof options.generateSummary !== "function") {
      throw new FukaiCompactionProviderError("generateSummary must be a function");
    }
    if (options.store === null || typeof options.store?.put !== "function") {
      throw new FukaiCompactionProviderError("store.put must be a function");
    }
    this.#maxSummaryBytes = validateMaximum(
      options.maxSummaryBytes ?? MAX_SUMMARY_BYTES,
      1,
      MAX_SUMMARY_BYTES,
      "maxSummaryBytes",
    );
    this.#store = options.store;
    this.#generateSummary = options.generateSummary;
  }

  async compact(request: FukaiCompactionRequest): Promise<FukaiCompactionSelection> {
    validateRequest(request);
    throwIfAborted(request.signal);

    const inputTokens = estimateTokens({
      compactionId: request.compactionId,
      runId: request.runId,
      laneId: request.laneId,
      goal: request.goal,
      policyVersion: request.policyVersion,
      cursor: request.cursor,
      upperWatermark: request.upperWatermark,
      sourceRefs: request.sourceRefs,
      deferredConversationRefs: request.deferredConversationRefs ?? [],
      generation: request.generation,
    });
    if (inputTokens > request.budget.maxInputTokens) {
      throw new FukaiCompactionBudgetError(
        `Compaction input requires about ${inputTokens} tokens; budget is ${request.budget.maxInputTokens}`,
      );
    }

    const deadline = createDeadline(request.signal, request.budget.maxWallClockMs);
    try {
      const boundedRequest: FukaiCompactionRequest = {
        compactionId: request.compactionId,
        runId: request.runId,
        laneId: request.laneId,
        goal: cloneJson(request.goal),
        policyVersion: request.policyVersion,
        cursor: canonicalCursor(request.cursor),
        upperWatermark: request.upperWatermark,
        sourceRefs: orderedSourceRefs(request.sourceRefs),
        ...(request.deferredConversationRefs === undefined
          ? {}
          : { deferredConversationRefs: request.deferredConversationRefs.map(cloneJson) }),
        ...(request.generation === undefined
          ? {}
          : { generation: cloneJson(request.generation) }),
        budget: cloneJson(request.budget),
        signal: deadline.signal,
      };
      const generated = await raceWithSignal(
        Promise.resolve().then(() => this.#generateSummary(boundedRequest)),
        deadline.signal,
      );
      const generation = normalizeGeneration(generated);
      try {
        throwIfAborted(request.signal);
        ensureDeadline(deadline);

        const normalizedSummary = validateAndNormalizeSummary(
          generation.summary,
          request.goal,
          request.sourceRefs,
          request.deferredConversationRefs,
          request.generation,
        );
        const serialized = stableJson(normalizedSummary);
        const byteLength = Buffer.byteLength(serialized, "utf8");
        const estimatedTokens = estimateTokens(serialized);
        if (byteLength > this.#maxSummaryBytes) {
          throw new FukaiCompactionBudgetError(
            `Compaction summary is ${byteLength} bytes; budget is ${this.#maxSummaryBytes}`,
          );
        }
        if (estimatedTokens > request.budget.maxOutputTokens) {
          throw new FukaiCompactionBudgetError(
            `Compaction summary requires about ${estimatedTokens} output tokens; budget is ${request.budget.maxOutputTokens}`,
          );
        }

        const summaryRef = await raceWithSignal(
          this.#store.put(serialized, FUKAI_COMPACTION_MEDIA_TYPE),
          deadline.signal,
        );
        throwIfAborted(request.signal);
        ensureDeadline(deadline);
        assertStoredSummaryRef(summaryRef, serialized, this.#maxSummaryBytes);

        return {
          capsule: {
            schemaVersion: 1,
            compactionId: request.compactionId,
            status: "ready",
            summaryRef: cloneJson(summaryRef),
            sourceRefs: orderedSourceRefs(request.sourceRefs),
            ...(request.deferredConversationRefs === undefined
              ? {}
              : { deferredConversationRefs: request.deferredConversationRefs.map(cloneJson) }),
            ...(request.generation === undefined
              ? {}
              : { generation: cloneJson(request.generation) }),
            summaryHash: summaryRef.contentHash,
            cursor: canonicalCursor(request.cursor),
            upperWatermark: request.upperWatermark,
            goalVersion: request.goal.version,
            policyVersion: request.policyVersion,
            estimatedTokens,
          },
          summary: normalizedSummary,
          ...(generation.providerUsage === undefined
            ? {}
            : { providerUsage: cloneJson(generation.providerUsage) }),
        };
      } catch (error: unknown) {
        throw attachProviderUsage(error, generation.providerUsage);
      }
    } finally {
      deadline.dispose();
    }
  }
}

function normalizeGeneration(
  generated: ContextCompactionSummary | FukaiCompactionSummaryGeneration,
): FukaiCompactionSummaryGeneration {
  if (
    generated !== null
    && typeof generated === "object"
    && "summary" in generated
  ) {
    const generation = generated as FukaiCompactionSummaryGeneration;
    if (generation.providerUsage !== undefined) {
      validateProviderUsage(generation.providerUsage);
    }
    return generation;
  }
  return { summary: generated as ContextCompactionSummary };
}

function validateProviderUsage(usage: TokenUsage): void {
  if (usage === null || typeof usage !== "object") {
    throw new FukaiCompactionProviderError("providerUsage must be an object");
  }
  for (const name of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (!Number.isFinite(usage[name]) || usage[name] < 0) {
      throw new FukaiCompactionProviderError(`providerUsage.${name} must be non-negative`);
    }
  }
  if (usage.costUsd !== undefined && (!Number.isFinite(usage.costUsd) || usage.costUsd < 0)) {
    throw new FukaiCompactionProviderError("providerUsage.costUsd must be non-negative");
  }
}

function attachProviderUsage(error: unknown, usage: TokenUsage | undefined): unknown {
  if (usage === undefined) return error;
  if (error instanceof FukaiCompactionProviderError && error.providerUsage !== undefined) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const options = { cause: error };
  if (error instanceof FukaiCompactionBudgetError) {
    return new FukaiCompactionBudgetError(message, usage, options);
  }
  if (error instanceof FukaiCompactionTimeoutError) {
    return new FukaiCompactionTimeoutError(message, usage, options);
  }
  return new FukaiCompactionProviderError(message, usage, options);
}

/** Short factory for call sites that prefer dependency injection by value. */
export function createFukaiCompactionProvider(
  options: FukaiCompactionProviderOptions,
): FukaiCompactionProviderAdapter {
  return new FukaiCompactionProviderAdapter(options);
}

function validateRequest(request: FukaiCompactionRequest): void {
  if (request === null || typeof request !== "object") {
    throw new FukaiCompactionProviderError("Compaction request must be an object");
  }
  validateIdentity(request.runId, "runId");
  validateIdentity(request.laneId, "laneId");
  validateCompactionId(request.compactionId);
  validateIdentity(request.policyVersion, "policyVersion");
  validateGoal(request.goal);
  if (!Number.isSafeInteger(request.upperWatermark) || request.upperWatermark < 0) {
    throw new FukaiCompactionProviderError("upperWatermark must be a non-negative integer");
  }
  const cursor = parseCursor(request.cursor);
  if (cursor > request.upperWatermark) {
    throw new FukaiCompactionProviderError("cursor cannot exceed upperWatermark");
  }
  validateSourceRefs(request.sourceRefs);
  validateDeferredConversationRefs(
    request.deferredConversationRefs,
    request.sourceRefs,
  );
  validateGeneration(request.generation);
  if (request.budget === null || typeof request.budget !== "object") {
    throw new FukaiCompactionProviderError("Compaction budget must be an object");
  }
  const { maxInputTokens, maxOutputTokens, maxWallClockMs } = request.budget;
  validateMaximum(maxInputTokens, 1, MAX_INPUT_TOKENS, "maxInputTokens");
  validateMaximum(maxOutputTokens, 1, MAX_OUTPUT_TOKENS, "maxOutputTokens");
  validateMaximum(maxWallClockMs, 1, MAX_WALL_CLOCK_MS, "maxWallClockMs");
}

function validateGoal(goal: Goal): void {
  if (goal === null || typeof goal !== "object") {
    throw new FukaiCompactionProviderError("goal must be an object");
  }
  if (!Number.isSafeInteger(goal.version) || goal.version < 1) {
    throw new FukaiCompactionProviderError("goal.version must be positive");
  }
  validateText(goal.statement, "goal.statement");
  validateTextArray(goal.successCriteria, "goal.successCriteria");
  validateTextArray(goal.hardConstraints, "goal.hardConstraints");
}

function validateSourceRefs(sourceRefs: readonly ContextSourceRef[]): void {
  if (!Array.isArray(sourceRefs) || sourceRefs.length === 0) {
    throw new FukaiCompactionProviderError("sourceRefs must contain at least one ref");
  }
  if (sourceRefs.length > MAX_SOURCE_REFS) {
    throw new FukaiCompactionProviderError(`sourceRefs exceeds ${MAX_SOURCE_REFS}`);
  }
  const seen = new Set<string>();
  for (const source of sourceRefs) {
    if (source === null || typeof source !== "object" || Array.isArray(source)) {
      throw new FukaiCompactionProviderError("sourceRef must be an object");
    }
    if (source.kind === "event") {
      validateIdentity(source.eventId, "source eventId");
      validateIdentity(source.contentHash, "source contentHash");
    } else if (source.kind === "artifact" || source.kind === "conversation") {
      try {
        assertArtifactRef(source.ref);
      } catch (error: unknown) {
        throw new FukaiCompactionProviderError(
          `Invalid source artifact: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      throw new FukaiCompactionProviderError("sourceRef kind is invalid");
    }
    const identity = stableJson(source);
    if (seen.has(identity)) {
      throw new FukaiCompactionProviderError("sourceRefs must be unique");
    }
    seen.add(identity);
  }
}

function validateDeferredConversationRefs(
  deferred: readonly ArtifactRef[] | undefined,
  sourceRefs: readonly ContextSourceRef[],
): void {
  if (deferred === undefined) return;
  if (!Array.isArray(deferred) || deferred.length > MAX_SOURCE_REFS) {
    throw new FukaiCompactionProviderError(
      `deferredConversationRefs must contain at most ${MAX_SOURCE_REFS} refs`,
    );
  }
  const summarized = new Set(sourceRefs.flatMap((source) => (
    source.kind === "conversation" ? [stableJson(source.ref)] : []
  )));
  const seen = new Set<string>();
  for (const ref of deferred) {
    try {
      assertArtifactRef(ref);
    } catch (error: unknown) {
      throw new FukaiCompactionProviderError(
        `Invalid deferred conversation ref: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const identity = stableJson(ref);
    if (seen.has(identity) || summarized.has(identity)) {
      throw new FukaiCompactionProviderError(
        "deferredConversationRefs must be unique and outside sourceRefs",
      );
    }
    seen.add(identity);
  }
}

function validateGeneration(
  generation: FukaiCompactionRequest["generation"],
): void {
  if (generation === undefined) return;
  validateIdentity(generation.provider, "generation.provider");
  validateIdentity(generation.model, "generation.model");
  validateIdentity(generation.summarizerVersion, "generation.summarizerVersion");
  validateIdentity(generation.promptHash, "generation.promptHash");
}

function validateAndNormalizeSummary(
  summary: ContextCompactionSummary,
  goal: Goal,
  sourceRefs: readonly ContextSourceRef[],
  deferredConversationRefs: readonly ArtifactRef[] | undefined,
  generation: FukaiCompactionRequest["generation"],
): ContextCompactionSummary {
  if (summary === null || typeof summary !== "object" || summary.schemaVersion !== 1) {
    throw new FukaiCompactionProviderError("Summary schemaVersion must be 1");
  }
  validateGoal(summary.goal);
  if (stableJson(summary.goal) !== stableJson(goal)) {
    throw new FukaiCompactionProviderError("Summary goal does not match request goal");
  }
  for (const name of ["decisions", "verifiedResults", "openQuestions"] as const) {
    validateTextArray(summary[name], `summary.${name}`);
  }
  validateSourceRefs(summary.sourceRefs);
  if (stableJson(orderedSourceRefs(summary.sourceRefs)) !== stableJson(orderedSourceRefs(sourceRefs))) {
    throw new FukaiCompactionProviderError("Summary sourceRefs do not match request sourceRefs");
  }
  if (
    summary.deferredConversationRefs !== undefined
    && stableJson(summary.deferredConversationRefs)
      !== stableJson(deferredConversationRefs ?? [])
  ) {
    throw new FukaiCompactionProviderError(
      "Summary deferredConversationRefs do not match the trusted request",
    );
  }
  if (
    summary.generation !== undefined
    && stableJson(summary.generation) !== stableJson(generation ?? null)
  ) {
    throw new FukaiCompactionProviderError(
      "Summary generation does not match the trusted request",
    );
  }
  return {
    schemaVersion: 1,
    goal: cloneJson(goal),
    decisions: [...summary.decisions],
    verifiedResults: [...summary.verifiedResults],
    openQuestions: [...summary.openQuestions],
    sourceRefs: orderedSourceRefs(sourceRefs),
    ...(deferredConversationRefs === undefined
      ? {}
      : { deferredConversationRefs: deferredConversationRefs.map(cloneJson) }),
    ...(generation === undefined ? {} : { generation: cloneJson(generation) }),
  };
}

function validateTextArray(value: readonly string[], field: string): void {
  if (!Array.isArray(value) || value.length > MAX_SUMMARY_ITEMS) {
    throw new FukaiCompactionProviderError(`${field} must contain at most ${MAX_SUMMARY_ITEMS} strings`);
  }
  value.forEach((item, index) => validateText(item, `${field}[${index}]`));
}

function validateText(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SUMMARY_TEXT_LENGTH || value.includes("\0")) {
    throw new FukaiCompactionProviderError(`${field} must be a bounded non-empty string`);
  }
}

function validateIdentity(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_IDENTITY_LENGTH || value.includes("\0")) {
    throw new FukaiCompactionProviderError(`${field} must be a bounded non-empty string`);
  }
}

function validateCompactionId(value: string): void {
  validateIdentity(value, "compactionId");
  if (!COMPACTION_ID_PATTERN.test(value)) {
    throw new FukaiCompactionProviderError(
      "compactionId must be a deterministic fukai-compaction:sha256:<digest> identity",
    );
  }
}

function validateMaximum(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new FukaiCompactionProviderError(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function parseCursor(cursor: string): number {
  if (typeof cursor !== "string") {
    throw new FukaiCompactionProviderError("cursor must use offset:<integer> format");
  }
  const match = /^offset:(\d+)$/.exec(cursor);
  if (match === null) {
    throw new FukaiCompactionProviderError("cursor must use offset:<integer> format");
  }
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value)) {
    throw new FukaiCompactionProviderError("cursor offset is invalid");
  }
  return value;
}

function canonicalCursor(cursor: string): string {
  return `offset:${parseCursor(cursor)}`;
}

function orderedSourceRefs(sourceRefs: readonly ContextSourceRef[]): ContextSourceRef[] {
  return sourceRefs.map((source) => cloneJson(source));
}

function assertStoredSummaryRef(
  summaryRef: ArtifactRef,
  serialized: string,
  maxBytes: number,
): void {
  try {
    assertArtifactRef(summaryRef);
  } catch (error: unknown) {
    throw new FukaiCompactionProviderError(
      `Store returned an invalid summary ref: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (summaryRef.mediaType !== FUKAI_COMPACTION_MEDIA_TYPE) {
    throw new FukaiCompactionProviderError("Store returned an invalid summary media type");
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > maxBytes || summaryRef.byteLength !== bytes || summaryRef.contentHash !== sha256(serialized)) {
    throw new FukaiCompactionProviderError("Store returned a summary ref that does not match the summary");
  }
}

interface Deadline {
  signal: AbortSignal;
  deadlineAt: number;
  dispose(): void;
}

function createDeadline(parent: AbortSignal | undefined, milliseconds: number): Deadline {
  const controller = new AbortController();
  const timeoutReason = new FukaiCompactionTimeoutError("Fukai compaction wall-clock budget exceeded");
  const deadlineAt = Date.now() + milliseconds;
  const timer = setTimeout(() => controller.abort(timeoutReason), milliseconds);
  const signal = parent === undefined
    ? controller.signal
    : AbortSignal.any([parent, controller.signal]);
  return {
    signal,
    deadlineAt,
    dispose: () => clearTimeout(timer),
  };
}

function ensureDeadline(deadline: Deadline): void {
  if (Date.now() >= deadline.deadlineAt) {
    throw new FukaiCompactionTimeoutError("Fukai compaction wall-clock budget exceeded");
  }
}

async function raceWithSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  pending.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function estimateTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(stableJson(value), "utf8") / 4);
}
