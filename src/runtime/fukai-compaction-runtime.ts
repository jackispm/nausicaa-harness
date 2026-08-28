import {
  FUKAI_COMPACTION_MEDIA_TYPE,
  type ContextCompactionBudget,
  type ContextSourceRef,
} from "../domain/context.js";
import type { EventPayloadMap } from "../domain/events.js";
import type { Clock, ModelPort } from "../domain/ports.js";
import {
  DEFAULT_FUKAI_COMPACTION_MINIMUM_GAIN_TOKENS,
  DEFAULT_FUKAI_COMPACTION_RETAIN_RATIO,
  DEFAULT_FUKAI_COMPACTION_THRESHOLD_RATIO,
  type Goal,
  type LaneId,
  type RunId,
  type RunPolicy,
} from "../domain/types.js";
import {
  ContentStoreFukaiSource,
  FukaiCore,
  createFukaiCompactionCoordinator,
  createFukaiCompactionProvider,
  createFukaiCompactionSourceMaterializer,
  createPiAiFukaiCompactionSummaryGenerator,
  decideFukaiCompactionPressure,
  fukaiCompactionInputTokenUpperBound,
  fukaiCompactionMaterialByteBudget,
  piAiFukaiCompactionGeneration,
  type FukaiCompactionSelection,
  type FukaiConversationRef,
} from "../fukai/index.js";
import type { Ledger } from "../ledger/index.js";
import { sha256, stableJson } from "../ledger/hash.js";
import type { ContentAddressedStore } from "../store/index.js";
import type { RunTokenBudget } from "./run-token-budget.js";

const MAX_COMPACTION_SOURCE_REFS = 128;

export interface RuntimeFukaiCompactionPrepareRequest {
  runId: RunId;
  laneId: LaneId;
  goal: Goal;
  policyVersion: string;
  upperWatermark: number;
  conversationRefs: readonly FukaiConversationRef[];
  budget: ContextCompactionBudget;
  signal?: AbortSignal;
}

export interface RuntimeFukaiCompactionSelectRequest {
  runId: RunId;
  laneId: LaneId;
  goal: Goal;
  policyVersion: string;
  upperWatermark: number;
  signal?: AbortSignal;
}

export interface RuntimeFukaiCompactionPressureRequest
  extends RuntimeFukaiCompactionSelectRequest {
  /** Main model frozen for this provider request boundary. */
  model: string;
  conversationRefs: readonly FukaiConversationRef[];
  estimatedInputTokens: number;
}

/** One activation prepares at most once; model boundaries only perform reads. */
export interface RuntimeFukaiCompaction {
  prepare(request: RuntimeFukaiCompactionPrepareRequest): Promise<void>;
  select(
    request: RuntimeFukaiCompactionSelectRequest,
  ): Promise<FukaiCompactionSelection | undefined>;
  compactIfNeeded?(
    request: RuntimeFukaiCompactionPressureRequest,
  ): Promise<FukaiCompactionSelection | undefined>;
}

export interface RuntimeFukaiCompactionFactoryContext {
  ledger: Ledger;
  store: ContentAddressedStore;
  modelPort: ModelPort;
  model: string;
  tokenBudget: RunTokenBudget;
  clock: Clock;
  policy: RunPolicy;
}

export type RuntimeFukaiCompactionFactory = (
  context: RuntimeFukaiCompactionFactoryContext,
) => RuntimeFukaiCompaction;

export interface RuntimeFukaiCompactionSourceWindow {
  /** A roll-forward base, when present, is first; new conversation refs follow in time order. */
  sourceRefs: ContextSourceRef[];
  /** Conversation refs crossed by the cursor but intentionally not summarized. */
  deferredConversationRefs: FukaiConversationRef["ref"][];
  /** Highest conversation sequence represented by this incremental capsule. */
  cursor: string;
  sourceBytes: number;
}

/** Content-derived identity for the immutable policy recorded at Run creation. */
export function deriveRuntimePolicyVersion(policy: RunPolicy): string {
  return sha256(stableJson(policy));
}

export function instantiateRuntimeFukaiCompaction(
  policy: RunPolicy,
  factory: RuntimeFukaiCompactionFactory,
  context: RuntimeFukaiCompactionFactoryContext,
): RuntimeFukaiCompaction | undefined {
  if (
    policy.fukaiCompaction?.enabled !== true
    || policy.fukaiCompaction.provider !== "pi-ai"
  ) {
    return undefined;
  }
  return factory(context);
}

export function runtimeFukaiCompactionBudget(
  policy: RunPolicy,
): ContextCompactionBudget {
  const compaction = policy.fukaiCompaction;
  if (compaction === undefined) {
    throw new Error("Fukai compaction policy is missing");
  }
  return {
    maxInputTokens: compaction.maxInputTokens,
    maxOutputTokens: compaction.maxOutputTokens,
    maxWallClockMs: compaction.maxWallClockMs,
  };
}

export async function prepareRuntimeFukaiCompaction(
  runtime: RuntimeFukaiCompaction,
  request: RuntimeFukaiCompactionPrepareRequest,
): Promise<void> {
  try {
    await runtime.prepare(request);
  } catch {
    throwIfCallerAborted(request.signal);
    // Main retains its bounded raw conversation if optional compaction fails.
  }
}

/** Production composition for the explicit pi-ai compaction capability. */
export const createRuntimeFukaiCompaction: RuntimeFukaiCompactionFactory = (context) => {
  const source = new ContentStoreFukaiSource(context.store);
  const core = new FukaiCore(context.ledger, source, context.clock);
  const materializer = createFukaiCompactionSourceMaterializer(source);
  const coordinatorFor = (model: string) => createFukaiCompactionCoordinator({
    core,
    provider: createFukaiCompactionProvider({
      store: context.store,
      generateSummary: createPiAiFukaiCompactionSummaryGenerator({
        modelPort: context.modelPort,
        model,
        materializer,
      }),
    }),
    ledger: context.ledger,
    tokenBudget: context.tokenBudget,
    now: () => context.clock.now().getTime(),
  });
  const compactionPolicy = context.policy.fukaiCompaction;
  if (compactionPolicy === undefined) {
    throw new Error("Fukai compaction runtime requires a recorded policy");
  }
  const thresholdRatio = compactionPolicy.thresholdRatio
    ?? DEFAULT_FUKAI_COMPACTION_THRESHOLD_RATIO;
  const retainRatio = compactionPolicy.retainRatio
    ?? DEFAULT_FUKAI_COMPACTION_RETAIN_RATIO;
  const minimumGainTokens = compactionPolicy.minimumGainTokens
    ?? DEFAULT_FUKAI_COMPACTION_MINIMUM_GAIN_TOKENS;
  let prepared = false;

  const readView = (request: RuntimeFukaiCompactionSelectRequest) =>
    core.readCompaction({
      runId: request.runId,
      laneId: request.laneId,
      goalVersion: request.goal.version,
      policyVersion: request.policyVersion,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });

  const executeWindow = async (
    request: RuntimeFukaiCompactionPrepareRequest,
    previousView: Awaited<ReturnType<typeof readView>>,
    selectedWindow?: RuntimeFukaiCompactionSourceWindow,
    model = context.model,
  ): Promise<void> => {
    const previous = previousView.status === "ready"
      ? previousView.selection
      : undefined;
    const repairFromCompactionId = previousView.status === "stale"
      && previousView.compactionId !== undefined
      && previousView.event?.payload.compactionId === previousView.compactionId
      && previousView.event.payload.goalVersion === request.goal.version
      && previousView.event.payload.policyVersion === request.policyVersion
      ? previousView.compactionId
      : undefined;
    const window = selectedWindow ?? selectRuntimeFukaiCompactionSources({
      conversationRefs: request.conversationRefs,
      goal: request.goal,
      upperWatermark: request.upperWatermark,
      budget: request.budget,
      ...(previous === undefined ? {} : { previous }),
    });
    if (window === undefined) return;
    await coordinatorFor(model).execute({
      runId: request.runId,
      laneId: request.laneId,
      goal: request.goal,
      policyVersion: request.policyVersion,
      cursor: window.cursor,
      upperWatermark: request.upperWatermark,
      sourceRefs: window.sourceRefs,
      ...(repairFromCompactionId === undefined
        ? {}
        : { repairFromCompactionId }),
      ...(window.deferredConversationRefs.length === 0
        ? {}
        : { deferredConversationRefs: window.deferredConversationRefs }),
      generation: piAiFukaiCompactionGeneration(model),
      budget: { ...request.budget },
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  };

  return {
    async prepare(request) {
      if (prepared) {
        throw new Error("Fukai compaction runtime was prepared more than once");
      }
      prepared = true;
      const previousView = await readView(request);
      // Normal cadence runs at the exact Main request boundary. Preparation
      // only repairs an already-recorded capsule before a blocked activation.
      if (previousView.status === "stale") {
        await executeWindow(request, previousView);
      }
    },
    async select(request) {
      if (!prepared) return undefined;
      const view = await readView(request);
      if (
        view.status !== "ready"
        || view.selection === undefined
        || view.selection.capsule.upperWatermark > request.upperWatermark
      ) {
        return undefined;
      }
      return view.selection;
    },
    async compactIfNeeded(request) {
      if (!prepared) return undefined;
      const contextWindowTokens = readContextWindowTokens(
        context.modelPort,
        request.model,
      );
      const previousView = await readView(request);
      const previous = previousView.status === "ready"
        ? previousView.selection
        : undefined;

      const uncovered = uncoveredRuntimeConversationRefs(
        request.conversationRefs,
        previous,
      );
      const rawTokens = uncovered.reduce(
        (total, item) => safeTokenAdd(
          total,
          artifactTokenUpperBound(item.ref.byteLength),
        ),
        0,
      );
      if (contextWindowTokens === undefined) {
        await appendPressureDecision(context.ledger, context.clock, request, {
          model: request.model,
          contextWindowTokens: null,
          currentTokens: request.estimatedInputTokens,
          thresholdTokens: null,
          minimumRetainedRawTokens: null,
          selectedRawTokens: 0,
          retainedRawTokens: rawTokens,
          predictedGainTokens: -compactionPolicy.maxOutputTokens,
          decision: "skip",
          reason: "context-window-unknown",
        });
        return previous;
      }
      const decision = decideFukaiCompactionPressure({
        contextWindowTokens,
        thresholdRatio,
        retainRatio,
        minimumGainTokens,
        maxSummaryTokens: compactionPolicy.maxOutputTokens,
        currentTokens: request.estimatedInputTokens,
        conversationRefs: uncovered.map((conversationRef) => ({
          ref: conversationRef,
          groupId: conversationRef.groupId
            ?? `sequence:${conversationRef.sequence}:${conversationRef.ref.id}`,
          estimatedTokens: artifactTokenUpperBound(conversationRef.ref.byteLength),
        })),
      });
      if (decision.status === "skip") {
        await appendPressureDecision(context.ledger, context.clock, request, {
          model: request.model,
          contextWindowTokens,
          currentTokens: request.estimatedInputTokens,
          thresholdTokens: decision.thresholdTokens,
          minimumRetainedRawTokens: decision.minimumRetainedRawTokens,
          selectedRawTokens: decision.selectedRawTokens,
          retainedRawTokens: decision.retainedRawTokens,
          predictedGainTokens: decision.predictedGainTokens,
          decision: "skip",
          reason: decision.reason,
        });
        return previous;
      }

      const selectedRefs = decision.selectedRefs.map((item) => item.ref);
      const initialBudget = runtimeFukaiCompactionBudget(context.policy);
      const window = selectRuntimeFukaiCompactionSources({
        conversationRefs: selectedRefs,
        goal: request.goal,
        upperWatermark: request.upperWatermark,
        budget: initialBudget,
        ...(previous === undefined ? {} : { previous }),
      });
      if (window === undefined) {
        await appendPressureDecision(context.ledger, context.clock, request, {
          model: request.model,
          contextWindowTokens,
          currentTokens: request.estimatedInputTokens,
          thresholdTokens: decision.thresholdTokens,
          minimumRetainedRawTokens: decision.minimumRetainedRawTokens,
          selectedRawTokens: 0,
          retainedRawTokens: rawTokens,
          predictedGainTokens: -compactionPolicy.maxOutputTokens,
          decision: "skip",
          reason: "source-window-unavailable",
        });
        return previous;
      }
      const sourceTokens = artifactTokenUpperBound(window.sourceBytes);
      const maxOutputTokens = Math.min(
        compactionPolicy.maxOutputTokens,
        sourceTokens - minimumGainTokens,
      );
      if (maxOutputTokens < 1) {
        await appendPressureDecision(context.ledger, context.clock, request, {
          model: request.model,
          contextWindowTokens,
          currentTokens: request.estimatedInputTokens,
          thresholdTokens: decision.thresholdTokens,
          minimumRetainedRawTokens: decision.minimumRetainedRawTokens,
          selectedRawTokens: 0,
          retainedRawTokens: rawTokens,
          predictedGainTokens: sourceTokens - compactionPolicy.maxOutputTokens,
          decision: "skip",
          reason: "source-window-unavailable",
        });
        return previous;
      }
      await appendPressureDecision(context.ledger, context.clock, request, {
        model: request.model,
        contextWindowTokens,
        currentTokens: request.estimatedInputTokens,
        thresholdTokens: decision.thresholdTokens,
        minimumRetainedRawTokens: decision.minimumRetainedRawTokens,
        selectedRawTokens: decision.selectedRawTokens,
        retainedRawTokens: decision.retainedRawTokens,
        predictedGainTokens: decision.predictedGainTokens,
        decision: "compact",
        reason: "pressure-threshold-reached",
      });
      await executeWindow({
        ...request,
        conversationRefs: selectedRefs,
        budget: {
          maxInputTokens: compactionPolicy.maxInputTokens,
          maxOutputTokens,
          maxWallClockMs: compactionPolicy.maxWallClockMs,
        },
      }, previousView, window, request.model);
      const updated = await readView(request);
      return updated.status === "ready" ? updated.selection : previous;
    },
  };
};

export function selectRuntimeFukaiCompactionSources(request: {
  conversationRefs: readonly FukaiConversationRef[];
  goal: Goal;
  upperWatermark: number;
  budget: ContextCompactionBudget;
  previous?: FukaiCompactionSelection;
}): RuntimeFukaiCompactionSourceWindow | undefined {
  if (!Number.isSafeInteger(request.upperWatermark) || request.upperWatermark < 0) {
    throw new TypeError("Fukai compaction upperWatermark must be non-negative");
  }
  fukaiCompactionMaterialByteBudget(request.budget.maxInputTokens);
  const seen = new Set<string>();
  const ordered: FukaiConversationRef[] = [];
  for (const conversationRef of [...request.conversationRefs].sort(compareConversationRefs)) {
    if (
      !Number.isSafeInteger(conversationRef.sequence)
      || conversationRef.sequence < 1
      || conversationRef.sequence > request.upperWatermark
    ) {
      continue;
    }
    const identity = artifactIdentity(conversationRef.ref);
    if (seen.has(identity)) continue;
    seen.add(identity);
    ordered.push(structuredClone(conversationRef));
  }

  const previous = request.previous;
  const previousDirectRefs = new Set<string>();
  for (const sourceRef of previous?.capsule.sourceRefs ?? []) {
    if (sourceRef.kind === "conversation") {
      previousDirectRefs.add(artifactIdentity(sourceRef.ref));
    }
  }
  // A verified previous runtime capsule represents every sequence through its
  // cursor except the refs explicitly carried in deferredConversationRefs.
  // The exceptions remain raw; the cursor can still advance past them.
  const previousCursor = previous === undefined
    ? undefined
    : decodeCompactionCursor(previous.capsule.cursor);
  let coveredThrough = previousCursor ?? 0;

  const sourceRefs: ContextSourceRef[] = [];
  let deferredConversationRefs = uniqueArtifactRefs(
    request.previous?.capsule.deferredConversationRefs ?? [],
  );
  const previousDeferredIdentities = new Set(
    deferredConversationRefs.map(artifactIdentity),
  );
  let sourceBytes = 0;
  if (previous !== undefined) {
    const base = previous.capsule.summaryRef;
    sourceRefs.push({ kind: "artifact", ref: structuredClone(base) });
    sourceBytes = base.byteLength;
  }

  let added = 0;
  const tryAdd = (group: readonly FukaiConversationRef[]): boolean => {
    if (
      group.length === 0
      || sourceRefs.length + group.length > MAX_COMPACTION_SOURCE_REFS
    ) {
      return false;
    }
    const groupBytes = group.reduce(
      (total, item) => safeTokenAdd(total, item.ref.byteLength),
      0,
    );
    const nextBytes = sourceBytes + groupBytes;
    if (!Number.isSafeInteger(nextBytes)) return false;
    const nextSources = group.map((conversationRef) => ({
      kind: "conversation",
      ref: structuredClone(conversationRef.ref),
    } as const));
    if (fukaiCompactionInputTokenUpperBound(
      request.goal,
      [...sourceRefs, ...nextSources],
    ) > request.budget.maxInputTokens) {
      return false;
    }
    sourceRefs.push(...nextSources);
    sourceBytes = nextBytes;
    added += group.length;
    return true;
  };

  const groups = groupRuntimeConversationRefs(ordered);

  // A previous exception may fit once its raw siblings have collapsed into a
  // smaller summary base. Resolve these before admitting newer evidence.
  for (const group of groups) {
    const deferredGroup = group.filter((conversationRef) => (
      previousDeferredIdentities.has(artifactIdentity(conversationRef.ref))
    ));
    if (!tryAdd(deferredGroup)) continue;
    const resolved = new Set(deferredGroup.map((item) => artifactIdentity(item.ref)));
    deferredConversationRefs = deferredConversationRefs.filter(
      (ref) => !resolved.has(artifactIdentity(ref)),
    );
  }

  for (const group of groups) {
    const candidates = group.filter((conversationRef) => {
      const identity = artifactIdentity(conversationRef.ref);
      return conversationRef.sequence > (previousCursor ?? 0)
        && !previousDirectRefs.has(identity)
        && !previousDeferredIdentities.has(identity);
    });
    if (candidates.length === 0) continue;
    if (sourceRefs.length >= MAX_COMPACTION_SOURCE_REFS) break;
    const groupThrough = Math.max(...candidates.map((item) => item.sequence));
    if (tryAdd(candidates)) {
      coveredThrough = groupThrough;
      continue;
    }
    if (
      deferredConversationRefs.length + candidates.length
      > MAX_COMPACTION_SOURCE_REFS
    ) {
      break;
    }
    deferredConversationRefs.push(
      ...candidates.map((item) => structuredClone(item.ref)),
    );
    coveredThrough = groupThrough;
  }

  // Re-summarizing a base without new evidence wastes a provider request.
  if (added === 0) return undefined;
  return {
    sourceRefs,
    deferredConversationRefs,
    cursor: `offset:${coveredThrough}`,
    sourceBytes,
  };
}

function groupRuntimeConversationRefs(
  refs: readonly FukaiConversationRef[],
): FukaiConversationRef[][] {
  const groups: FukaiConversationRef[][] = [];
  for (const ref of refs) {
    const groupId = ref.groupId
      ?? `sequence:${ref.sequence}:${ref.ref.id}`;
    const current = groups.at(-1);
    const currentId = current?.[0]?.groupId
      ?? (current?.[0] === undefined
        ? undefined
        : `sequence:${current[0].sequence}:${current[0].ref.id}`);
    if (current !== undefined && currentId === groupId) {
      current.push(ref);
    } else {
      groups.push([ref]);
    }
  }
  return groups;
}

function compareConversationRefs(
  left: FukaiConversationRef,
  right: FukaiConversationRef,
): number {
  return left.sequence - right.sequence || left.ref.id.localeCompare(right.ref.id);
}

function decodeCompactionCursor(cursor: string): number {
  const match = /^offset:(\d+)$/.exec(cursor);
  if (match === null) return 0;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : 0;
}

function artifactIdentity(ref: FukaiConversationRef["ref"]): string {
  return JSON.stringify([
    ref.id,
    ref.contentHash,
    ref.mediaType,
    ref.byteLength,
  ]);
}

function uniqueArtifactRefs(
  refs: readonly FukaiConversationRef["ref"][],
): FukaiConversationRef["ref"][] {
  const seen = new Set<string>();
  const result: FukaiConversationRef["ref"][] = [];
  for (const ref of refs) {
    const identity = artifactIdentity(ref);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(structuredClone(ref));
  }
  return result;
}

function uncoveredRuntimeConversationRefs(
  refs: readonly FukaiConversationRef[],
  previous: FukaiCompactionSelection | undefined,
): FukaiConversationRef[] {
  if (previous === undefined) return refs.map((ref) => structuredClone(ref));
  const direct = new Set(previous.capsule.sourceRefs.flatMap((sourceRef) => (
    sourceRef.kind === "conversation"
      ? [artifactIdentity(sourceRef.ref)]
      : []
  )));
  const deferred = new Set(
    (previous.capsule.deferredConversationRefs ?? []).map(artifactIdentity),
  );
  const hasRollForwardBase = previous.capsule.sourceRefs.some((sourceRef) => (
    sourceRef.kind === "artifact"
    && sourceRef.ref.mediaType === FUKAI_COMPACTION_MEDIA_TYPE
  ));
  const through = hasRollForwardBase
    ? decodeCompactionCursor(previous.capsule.cursor)
    : undefined;
  return refs.filter((conversationRef) => {
    const identity = artifactIdentity(conversationRef.ref);
    if (deferred.has(identity)) return true;
    if (direct.has(identity)) return false;
    return through === undefined || conversationRef.sequence > through;
  }).map((ref) => structuredClone(ref));
}

function readContextWindowTokens(
  modelPort: ModelPort,
  model: string,
): number | undefined {
  try {
    const value = modelPort.capabilities?.(model)?.contextWindowTokens;
    return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function artifactTokenUpperBound(byteLength: number): number {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new TypeError("Fukai conversation byteLength must be non-negative");
  }
  return Math.max(1, Math.ceil(byteLength / 4));
}

function safeTokenAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) {
    throw new RangeError("Fukai compaction token estimate exceeds safe integer range");
  }
  return total;
}

async function appendPressureDecision(
  ledger: Ledger,
  clock: Clock,
  request: RuntimeFukaiCompactionPressureRequest,
  payload: Omit<EventPayloadMap["fukai.compaction.pressure"], "trigger">,
): Promise<void> {
  await ledger.append({
    runId: request.runId,
    laneId: request.laneId,
    type: "fukai.compaction.pressure",
    payload: {
      trigger: "main-pre-step",
      ...payload,
    },
    correlationId: `fukai:pressure:${request.runId}:${request.laneId}`,
    idempotencyKey: `${request.laneId}:fukai:pressure:${request.upperWatermark}`,
    visibility: "lane",
    occurredAt: clock.now().toISOString(),
  });
}

function throwIfCallerAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}
