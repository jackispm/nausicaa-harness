export interface FukaiCompactionConversationRef<TRef = unknown> {
  ref: TRef;
  groupId: string;
  estimatedTokens: number;
}

export interface FukaiCompactionPressureInput<TRef = unknown> {
  contextWindowTokens: number;
  thresholdRatio: number;
  retainRatio: number;
  minimumGainTokens: number;
  maxSummaryTokens: number;
  currentTokens: number;
  /** Oldest-first conversation refs. A group must occupy one contiguous range. */
  conversationRefs: readonly FukaiCompactionConversationRef<TRef>[];
}

export type FukaiCompactionPressureReason =
  | "pressure-threshold-reached"
  | "below-threshold"
  | "no-compactable-prefix"
  | "insufficient-predicted-gain";

export interface FukaiCompactionPressureMetrics<TRef = unknown> {
  thresholdTokens: number;
  minimumRetainedRawTokens: number;
  retainedRawTokens: number;
  selectedRawTokens: number;
  predictedGainTokens: number;
  selectedGroupIds: string[];
  selectedRefs: FukaiCompactionConversationRef<TRef>[];
}

export type FukaiCompactionPressureDecision<TRef = unknown> =
  | (FukaiCompactionPressureMetrics<TRef> & {
      status: "compact";
      reason: "pressure-threshold-reached";
    })
  | (FukaiCompactionPressureMetrics<TRef> & {
      status: "skip";
      reason: Exclude<
        FukaiCompactionPressureReason,
        "pressure-threshold-reached"
      >;
    });

interface ConversationGroup<TRef> {
  groupId: string;
  estimatedTokens: number;
  refs: FukaiCompactionConversationRef<TRef>[];
}

/**
 * Makes a deterministic pressure decision without reading context or invoking
 * a compaction provider. Whole oldest groups are selected while preserving the
 * configured newest raw-token floor.
 */
export function decideFukaiCompactionPressure<TRef>(
  input: FukaiCompactionPressureInput<TRef>,
): FukaiCompactionPressureDecision<TRef> {
  validateInput(input);

  const thresholdTokens = Math.floor(
    input.contextWindowTokens * input.thresholdRatio,
  );
  const minimumRetainedRawTokens = Math.floor(
    input.contextWindowTokens * input.retainRatio,
  );
  const groups = groupConversationRefs(input.conversationRefs);
  const totalRawTokens = sumGroupTokens(groups);

  if (input.currentTokens < thresholdTokens) {
    return {
      status: "skip",
      reason: "below-threshold",
      thresholdTokens,
      minimumRetainedRawTokens,
      retainedRawTokens: totalRawTokens,
      selectedRawTokens: 0,
      predictedGainTokens: -input.maxSummaryTokens,
      selectedGroupIds: [],
      selectedRefs: [],
    };
  }

  const selectedGroups: ConversationGroup<TRef>[] = [];
  let selectedRawTokens = 0;
  // The newest group is always live raw context, even when the floored token
  // target is zero. Iterating in order also makes selection a strict prefix.
  for (const group of groups.slice(0, -1)) {
    const nextSelectedRawTokens = safeAdd(
      selectedRawTokens,
      group.estimatedTokens,
      "selected raw token total",
    );
    if (totalRawTokens - nextSelectedRawTokens < minimumRetainedRawTokens) {
      break;
    }
    selectedGroups.push(group);
    selectedRawTokens = nextSelectedRawTokens;
  }

  const selectedRefs = selectedGroups.flatMap((group) => group.refs);
  const metrics: FukaiCompactionPressureMetrics<TRef> = {
    thresholdTokens,
    minimumRetainedRawTokens,
    retainedRawTokens: totalRawTokens - selectedRawTokens,
    selectedRawTokens,
    predictedGainTokens: selectedRawTokens - input.maxSummaryTokens,
    selectedGroupIds: selectedGroups.map((group) => group.groupId),
    selectedRefs,
  };

  if (selectedGroups.length === 0) {
    return {
      status: "skip",
      reason: "no-compactable-prefix",
      ...metrics,
    };
  }
  if (metrics.predictedGainTokens < input.minimumGainTokens) {
    return {
      status: "skip",
      reason: "insufficient-predicted-gain",
      ...metrics,
    };
  }
  return {
    status: "compact",
    reason: "pressure-threshold-reached",
    ...metrics,
  };
}

function validateInput<TRef>(input: FukaiCompactionPressureInput<TRef>): void {
  if (input === null || typeof input !== "object") {
    throw new TypeError("compaction pressure input must be an object");
  }
  positiveSafeInteger(input.contextWindowTokens, "contextWindowTokens");
  ratio(input.thresholdRatio, "thresholdRatio");
  ratio(input.retainRatio, "retainRatio");
  if (input.retainRatio >= input.thresholdRatio) {
    throw new RangeError("retainRatio must be less than thresholdRatio");
  }
  nonNegativeSafeInteger(input.minimumGainTokens, "minimumGainTokens");
  nonNegativeSafeInteger(input.maxSummaryTokens, "maxSummaryTokens");
  nonNegativeSafeInteger(input.currentTokens, "currentTokens");
  if (!Array.isArray(input.conversationRefs)) {
    throw new TypeError("conversationRefs must be an array");
  }
}

function groupConversationRefs<TRef>(
  refs: readonly FukaiCompactionConversationRef<TRef>[],
): ConversationGroup<TRef>[] {
  const groups: ConversationGroup<TRef>[] = [];
  const closedGroupIds = new Set<string>();

  for (const conversationRef of refs) {
    if (conversationRef === null || typeof conversationRef !== "object") {
      throw new TypeError("each conversation ref must be an object");
    }
    if (
      typeof conversationRef.groupId !== "string"
      || conversationRef.groupId.trim().length === 0
      || conversationRef.groupId.includes("\0")
    ) {
      throw new TypeError("conversation groupId must be non-empty and contain no NUL");
    }
    nonNegativeSafeInteger(
      conversationRef.estimatedTokens,
      "conversation estimatedTokens",
    );

    const current = groups.at(-1);
    if (current?.groupId === conversationRef.groupId) {
      current.estimatedTokens = safeAdd(
        current.estimatedTokens,
        conversationRef.estimatedTokens,
        `conversation group ${conversationRef.groupId} token total`,
      );
      current.refs.push(conversationRef);
      continue;
    }
    if (closedGroupIds.has(conversationRef.groupId)) {
      throw new TypeError(
        `conversation group ${conversationRef.groupId} must be contiguous`,
      );
    }
    if (current !== undefined) closedGroupIds.add(current.groupId);
    groups.push({
      groupId: conversationRef.groupId,
      estimatedTokens: conversationRef.estimatedTokens,
      refs: [conversationRef],
    });
  }
  return groups;
}

function sumGroupTokens<TRef>(groups: readonly ConversationGroup<TRef>[]): number {
  return groups.reduce(
    (total, group) => safeAdd(total, group.estimatedTokens, "raw token total"),
    0,
  );
}

function positiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function nonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function ratio(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new RangeError(`${label} must be greater than 0 and less than 1`);
  }
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${label} exceeds the safe integer range`);
  }
  return result;
}
