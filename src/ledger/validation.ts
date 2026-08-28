import type { EventPayloadMap, EventType } from "../domain/events.js";
import {
  CONTEXT_MANIFEST_SCHEMA_VERSION,
  deriveContextCompactionAttemptId,
  deriveContextCompactionId,
  FUKAI_COMPACTION_MEDIA_TYPE,
} from "../domain/context.js";
import type {
  ContextManifest,
  ContextSourceRef,
} from "../domain/context.js";
import {
  MAX_TASK_ATTEMPTS,
  MAX_TASK_MODEL_TOKENS,
  MAX_TASK_WALL_CLOCK_MS,
} from "../domain/types.js";
import type {
  A2AMessage,
  Advice,
  ArtifactRef,
  Goal,
  NavigationDelta,
  RunPolicy,
  TaskBudget,
  TokenUsage,
} from "../domain/types.js";

type PayloadValidator = (value: unknown, path: string) => void;

function invalid(path: string, expectation: string): never {
  throw new TypeError(`${path} must be ${expectation}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(path, "an object");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string, allowEmpty = true): asserts value is string {
  if (
    typeof value !== "string"
    || value.includes("\0")
    || (!allowEmpty && value.length === 0)
  ) {
    invalid(path, allowEmpty ? "a string without NUL" : "a non-empty string without NUL");
  }
}

function optionalString(value: unknown, path: string): void {
  if (value !== undefined) {
    string(value, path);
  }
}

function oneOf<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    invalid(path, `one of ${allowed.join(", ")}`);
  }
}

function boolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    invalid(path, "a boolean");
  }
}

function finiteNumber(value: unknown, path: string, minimum = 0): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    invalid(path, `a finite number >= ${minimum}`);
  }
}

function ratio(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1) {
    invalid(path, "a finite number between zero and one");
  }
}

function integer(value: unknown, path: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    invalid(path, `a safe integer >= ${minimum}`);
  }
}

function dateTime(value: unknown, path: string): asserts value is string {
  string(value, path, false);
  if (!Number.isFinite(Date.parse(value))) {
    invalid(path, "a valid date-time");
  }
}

function stringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value)) {
    invalid(path, "an array of strings");
  }
  value.forEach((item, index) => string(item, `${path}[${index}]`));
}

function artifactRef(value: unknown, path: string): asserts value is ArtifactRef {
  const item = record(value, path);
  string(item.id, `${path}.id`, false);
  string(item.contentHash, `${path}.contentHash`, false);
  string(item.mediaType, `${path}.mediaType`, false);
  integer(item.byteLength, `${path}.byteLength`);
}

function usage(value: unknown, path: string): asserts value is TokenUsage {
  const item = record(value, path);
  integer(item.input, `${path}.input`);
  integer(item.output, `${path}.output`);
  integer(item.cacheRead, `${path}.cacheRead`);
  integer(item.cacheWrite, `${path}.cacheWrite`);
  if (item.costUsd !== undefined) {
    finiteNumber(item.costUsd, `${path}.costUsd`);
  }
}

function nullableUsage(value: unknown, path: string): void {
  if (value !== null) usage(value, path);
}

function compactionId(value: unknown, path: string): asserts value is string {
  string(value, path, false);
  if (!/^fukai-compaction:sha256:[0-9a-f]{64}$/.test(value)) {
    invalid(path, "a deterministic fukai-compaction:sha256:<digest> identity");
  }
}

function compactionAttempt(
  item: Record<string, unknown>,
  path: string,
): void {
  compactionId(item.compactionId, `${path}.compactionId`);
  integer(item.attempt, `${path}.attempt`, 1);
  string(item.attemptId, `${path}.attemptId`, false);
  if (item.attemptId !== deriveContextCompactionAttemptId(
    item.compactionId,
    item.attempt as number,
  )) {
    invalid(`${path}.attemptId`, "derived from compactionId and attempt");
  }
}

function compactionBudget(value: unknown, path: string): void {
  const item = record(value, path);
  integer(item.maxInputTokens, `${path}.maxInputTokens`, 1);
  integer(item.maxOutputTokens, `${path}.maxOutputTokens`, 1);
  integer(item.maxWallClockMs, `${path}.maxWallClockMs`, 1);
}

function goal(value: unknown, path: string): asserts value is Goal {
  const item = record(value, path);
  integer(item.version, `${path}.version`, 1);
  string(item.statement, `${path}.statement`, false);
  stringArray(item.successCriteria, `${path}.successCriteria`);
  stringArray(item.hardConstraints, `${path}.hardConstraints`);
}

function taskId(value: unknown, path: string): void {
  string(value, path, false);
  if ((value as string).length > 128) {
    invalid(path, "at most 128 characters");
  }
}

function taskBudget(value: unknown, path: string): void {
  const item = record(value, path);
  integer(item.maxModelTokens, `${path}.maxModelTokens`, 1);
  if ((item.maxModelTokens as number) > MAX_TASK_MODEL_TOKENS) {
    invalid(`${path}.maxModelTokens`, `at most ${MAX_TASK_MODEL_TOKENS}`);
  }
  integer(item.maxWallClockMs, `${path}.maxWallClockMs`, 1);
  if ((item.maxWallClockMs as number) > MAX_TASK_WALL_CLOCK_MS) {
    invalid(`${path}.maxWallClockMs`, `at most ${MAX_TASK_WALL_CLOCK_MS}`);
  }
  if (item.deadline !== undefined) {
    dateTime(item.deadline, `${path}.deadline`);
  }
  if (item.maxAttempts !== undefined) {
    integer(item.maxAttempts, `${path}.maxAttempts`, 1);
    if ((item.maxAttempts as number) > MAX_TASK_ATTEMPTS) {
      invalid(`${path}.maxAttempts`, `at most ${MAX_TASK_ATTEMPTS}`);
    }
  }
}

function artifactRefArray(value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    invalid(path, "an array of artifact refs");
  }
  value.forEach((ref, index) => artifactRef(ref, `${path}[${index}]`));
}

function runPolicy(value: unknown, path: string): asserts value is RunPolicy {
  const item = record(value, path);
  const hasActivationAllowance = Object.hasOwn(item, "maxMainStepsPerActivation");
  const hasLegacyLimit = Object.hasOwn(item, "maxMainSteps");
  if (hasActivationAllowance === hasLegacyLimit) {
    invalid(
      path,
      "an object with exactly one of maxMainStepsPerActivation or legacy maxMainSteps",
    );
  }
  if (hasActivationAllowance) {
    integer(
      item.maxMainStepsPerActivation,
      `${path}.maxMainStepsPerActivation`,
      1,
    );
  } else {
    integer(item.maxMainSteps, `${path}.maxMainSteps`, 1);
  }
  integer(item.maxModelTokens, `${path}.maxModelTokens`, 1);
  boolean(item.tetoEnabled, `${path}.tetoEnabled`);
  if (item.workerEnabled !== undefined) {
    boolean(item.workerEnabled, `${path}.workerEnabled`);
  }
  integer(item.tetoMaxOutputTokens, `${path}.tetoMaxOutputTokens`);
  finiteNumber(item.tetoTokenRatio, `${path}.tetoTokenRatio`);
  if ((item.tetoTokenRatio as number) > 1) {
    invalid(`${path}.tetoTokenRatio`, "a finite number between 0 and 1");
  }
  if (item.auxiliaryMode !== undefined) {
    oneOf(item.auxiliaryMode, `${path}.auxiliaryMode`, [
      "none",
      "teto",
      "reflection",
    ] as const);
  }
  if (item.tetoAdviceDelivery !== undefined) {
    oneOf(item.tetoAdviceDelivery, `${path}.tetoAdviceDelivery`, [
      "live",
      "shadow",
    ] as const);
  }
  if (item.fukaiCompaction !== undefined) {
    const fukai = record(item.fukaiCompaction, `${path}.fukaiCompaction`);
    boolean(fukai.enabled, `${path}.fukaiCompaction.enabled`);
    oneOf(fukai.provider, `${path}.fukaiCompaction.provider`, ["none", "pi-ai"] as const);
    integer(fukai.maxInputTokens, `${path}.fukaiCompaction.maxInputTokens`, 1);
    integer(fukai.maxOutputTokens, `${path}.fukaiCompaction.maxOutputTokens`, 1);
    integer(fukai.maxWallClockMs, `${path}.fukaiCompaction.maxWallClockMs`, 1);
    if (fukai.thresholdRatio !== undefined) {
      ratio(fukai.thresholdRatio, `${path}.fukaiCompaction.thresholdRatio`);
    }
    if (fukai.retainRatio !== undefined) {
      ratio(fukai.retainRatio, `${path}.fukaiCompaction.retainRatio`);
    }
    if (
      typeof fukai.thresholdRatio === "number"
      && typeof fukai.retainRatio === "number"
      && fukai.retainRatio >= fukai.thresholdRatio
    ) {
      invalid(
        `${path}.fukaiCompaction.retainRatio`,
        "less than fukaiCompaction.thresholdRatio",
      );
    }
    if (fukai.minimumGainTokens !== undefined) {
      integer(
        fukai.minimumGainTokens,
        `${path}.fukaiCompaction.minimumGainTokens`,
        1,
      );
    }
    if ((fukai.maxInputTokens as number) > 16 * 1024 * 1024) {
      invalid(`${path}.fukaiCompaction.maxInputTokens`, "at most 16777216");
    }
    if ((fukai.maxOutputTokens as number) > 16 * 1024 * 1024) {
      invalid(`${path}.fukaiCompaction.maxOutputTokens`, "at most 16777216");
    }
    if ((fukai.maxWallClockMs as number) > 5 * 60 * 1_000) {
      invalid(`${path}.fukaiCompaction.maxWallClockMs`, "at most 300000");
    }
  }
}

function navigationDelta(value: unknown, path: string): asserts value is NavigationDelta {
  const item = record(value, path);
  string(item.boundaryId, `${path}.boundaryId`, false);
  oneOf(item.triggerKind, `${path}.triggerKind`, [
    "normal",
    "decision",
    "goal-change",
    "repeated-failure",
    "contradiction",
  ] as const);
  string(item.activeObjective, `${path}.activeObjective`);
  string(item.actionOrDecision, `${path}.actionOrDecision`);
  string(item.expectedOutcome, `${path}.expectedOutcome`);
  string(item.outcome, `${path}.outcome`);
  oneOf(item.status, `${path}.status`, [
    "progress",
    "blocked",
    "uncertain",
    "complete",
  ] as const);
  stringArray(item.uncertainties, `${path}.uncertainties`);
  stringArray(item.openQuestions, `${path}.openQuestions`);
}

function contextTruncation(value: unknown, path: string): void {
  const item = payloadObject(value, path, ["kind", "detail"]);
  oneOf(item.kind, `${path}.kind`, [
    "input-token-budget",
    "conversation-message-limit",
    "artifact-count-limit",
    "artifact-byte-limit",
    "query-limit",
    "missing-conversation",
    "missing-artifact",
    "conversation-shape",
  ] as const);
  if (item.ref !== undefined) {
    string(item.ref, `${path}.ref`, false);
  }
  string(item.detail, `${path}.detail`, false);
}

function contextSlotManifest(value: unknown, path: string): void {
  const item = payloadObject(value, path, ["state", "itemCount", "estimatedTokens", "hash"]);
  oneOf(item.state, `${path}.state`, ["empty", "present", "bounded"] as const);
  integer(item.itemCount, `${path}.itemCount`);
  integer(item.estimatedTokens, `${path}.estimatedTokens`);
  string(item.hash, `${path}.hash`, false);
}

function contextSourceRef(value: unknown, path: string): void {
  const item = record(value, path);
  oneOf(item.kind, `${path}.kind`, ["artifact", "conversation", "event"] as const);
  if (item.kind === "event") {
    const event = payloadObject(item, path, ["kind", "eventId", "contentHash"]);
    string(event.eventId, `${path}.eventId`, false);
    string(event.contentHash, `${path}.contentHash`, false);
    return;
  }
  const artifact = payloadObject(item, path, ["kind", "ref"]);
  artifactRef(artifact.ref, `${path}.ref`);
}

function contextSourceRefs(value: unknown, path: string): asserts value is ContextSourceRef[] {
  if (!Array.isArray(value)) {
    invalid(path, "an array of context source refs");
  }
  if (value.length > 128) {
    invalid(path, "at most 128 context source refs");
  }
  const identities = new Set<string>();
  value.forEach((source, index) => {
    contextSourceRef(source, `${path}[${index}]`);
    const item = source as Record<string, unknown>;
    const identity = item.kind === "event"
      ? `event:${item.eventId}:${item.contentHash}`
      : `${item.kind as string}:${(item.ref as Record<string, unknown>).id as string}`;
    if (identities.has(identity)) {
      invalid(`${path}[${index}]`, "unique within the compaction");
    }
    identities.add(identity);
  });
}

function boundedArtifactRefs(
  value: unknown,
  path: string,
  sourceRefs: readonly ContextSourceRef[] = [],
): void {
  if (!Array.isArray(value) || value.length > 128) {
    invalid(path, "an array of at most 128 artifact refs");
  }
  const summarized = new Set(sourceRefs.flatMap((source) => (
    source.kind === "conversation"
      ? [artifactRefIdentity(source.ref)]
      : []
  )));
  const identities = new Set<string>();
  value.forEach((ref, index) => {
    artifactRef(ref, `${path}[${index}]`);
    const identity = artifactRefIdentity(ref as unknown as ArtifactRef);
    if (identities.has(identity) || summarized.has(identity)) {
      invalid(`${path}[${index}]`, "unique and outside compaction sourceRefs");
    }
    identities.add(identity);
  });
}

function artifactRefIdentity(ref: ArtifactRef): string {
  return JSON.stringify([ref.id, ref.contentHash, ref.mediaType, ref.byteLength]);
}

function compactionGeneration(value: unknown, path: string): void {
  const item = payloadObject(value, path, [
    "provider",
    "model",
    "summarizerVersion",
    "promptHash",
  ]);
  string(item.provider, `${path}.provider`, false);
  string(item.model, `${path}.model`, false);
  string(item.summarizerVersion, `${path}.summarizerVersion`, false);
  if ((item.model as string).length > 512) {
    invalid(`${path}.model`, "at most 512 characters");
  }
  if ((item.summarizerVersion as string).length > 512) {
    invalid(`${path}.summarizerVersion`, "at most 512 characters");
  }
  string(item.promptHash, `${path}.promptHash`, false);
  if ((item.provider as string).length > 512) {
    invalid(`${path}.provider`, "at most 512 characters");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(item.promptHash as string)) {
    invalid(`${path}.promptHash`, "a sha256:<lowercase digest> identity");
  }
}

function cursor(value: unknown, path: string, upperWatermark?: number): void {
  string(value, path, false);
  const match = /^offset:(\d+)$/.exec(value);
  if (match === null || !Number.isSafeInteger(Number(match[1]))) {
    invalid(path, "an offset:<integer> cursor");
  }
  if (value !== `offset:${Number(match[1])}`) {
    invalid(path, "a canonical offset:<integer> cursor without leading zeroes");
  }
  if (upperWatermark !== undefined && Number(match[1]) > upperWatermark) {
    invalid(path, "a cursor not ahead of upperWatermark");
  }
}

function contextCompactionSlotManifest(value: unknown, path: string): void {
  const item = payloadObject(value, path, [
    "state",
    "itemCount",
    "estimatedTokens",
    "hash",
    "status",
    "sourceRefs",
  ]);
  oneOf(item.state, `${path}.state`, ["empty", "present", "bounded"] as const);
  integer(item.itemCount, `${path}.itemCount`);
  integer(item.estimatedTokens, `${path}.estimatedTokens`);
  string(item.hash, `${path}.hash`, false);
  oneOf(item.status, `${path}.status`, ["none", "ready", "stale"] as const);
  contextSourceRefs(item.sourceRefs, `${path}.sourceRefs`);
  if (item.deferredConversationRefs !== undefined) {
    boundedArtifactRefs(
      item.deferredConversationRefs,
      `${path}.deferredConversationRefs`,
      item.sourceRefs as ContextSourceRef[],
    );
  }
  if (item.generation !== undefined) {
    compactionGeneration(item.generation, `${path}.generation`);
  }
  if (item.status === "none") {
    if (item.compactionId !== undefined) {
      invalid(`${path}.compactionId`, "absent when compaction status is none");
    }
    if (item.itemCount !== 0 || item.sourceRefs.length !== 0) {
      invalid(path, "an empty compaction slot when status is none");
    }
    return;
  }
  if (item.itemCount < 1 || item.sourceRefs.length < 1) {
    invalid(path, "a non-empty compaction slot with source refs");
  }
  compactionId(item.compactionId, `${path}.compactionId`);
  const summaryRef = item.summaryRef;
  artifactRef(summaryRef, `${path}.summaryRef`);
  if (summaryRef.mediaType !== FUKAI_COMPACTION_MEDIA_TYPE) {
    invalid(`${path}.summaryRef.mediaType`, FUKAI_COMPACTION_MEDIA_TYPE);
  }
  string(item.summaryHash, `${path}.summaryHash`, false);
  if (item.summaryHash !== summaryRef.contentHash) {
    invalid(`${path}.summaryHash`, "match summaryRef.contentHash");
  }
  cursor(item.cursor, `${path}.cursor`, item.upperWatermark as number | undefined);
  integer(item.upperWatermark, `${path}.upperWatermark`);
  integer(item.goalVersion, `${path}.goalVersion`, 1);
  string(item.policyVersion, `${path}.policyVersion`, false);
}

function contextManifest(value: unknown, path: string): void {
  const item = payloadObject(value, path, [
    "schemaVersion",
    "slots",
    "prefixHash",
    "dynamicHash",
    "upperWatermark",
    "policyVersion",
  ]);
  if (item.schemaVersion !== CONTEXT_MANIFEST_SCHEMA_VERSION) {
    invalid(`${path}.schemaVersion`, `the supported value ${CONTEXT_MANIFEST_SCHEMA_VERSION}`);
  }
  const slots = payloadObject(item.slots, `${path}.slots`, [
    "goal",
    "policy",
    "tools",
    "inbox",
    "compaction",
    "lane-context",
  ]);
  for (const name of ["goal", "policy", "tools", "inbox", "compaction", "lane-context"] as const) {
    if (name === "compaction") {
      contextCompactionSlotManifest(slots[name], `${path}.slots.${name}`);
    } else {
      contextSlotManifest(slots[name], `${path}.slots.${name}`);
    }
  }
  string(item.prefixHash, `${path}.prefixHash`, false);
  string(item.dynamicHash, `${path}.dynamicHash`, false);
  integer(item.upperWatermark, `${path}.upperWatermark`);
  string(item.policyVersion, `${path}.policyVersion`, false);
}

/** Public runtime guard used by replayers before consuming a manifest. */
export function validateContextManifest(value: unknown): asserts value is ContextManifest {
  contextManifest(value, "contextManifest");
}

function advice(value: unknown, path: string): asserts value is Advice {
  const item = record(value, path);
  string(item.adviceId, `${path}.adviceId`, false);
  oneOf(item.kind, `${path}.kind`, [
    "orientation",
    "intent-gap",
    "method-alternative",
  ] as const);
  string(item.claim, `${path}.claim`);
  stringArray(item.evidenceRefs, `${path}.evidenceRefs`);
  finiteNumber(item.confidence, `${path}.confidence`);
  if ((item.confidence as number) > 1) {
    invalid(`${path}.confidence`, "a finite number between 0 and 1");
  }
  oneOf(item.risk, `${path}.risk`, ["low", "medium", "high"] as const);
  string(item.suggestedAction, `${path}.suggestedAction`);
  oneOf(item.urgency, `${path}.urgency`, [
    "next-step",
    "next-turn",
    "deferred",
  ] as const);
  dateTime(item.expiresAt, `${path}.expiresAt`);
  string(item.dedupeKey, `${path}.dedupeKey`, false);
  string(item.sourceLane, `${path}.sourceLane`, false);
}

function a2aMessage(value: unknown, path: string): asserts value is A2AMessage {
  const item = record(value, path);
  for (const field of [
    "messageId",
    "runId",
    "conversationId",
    "threadId",
    "from",
    "to",
    "correlationId",
    "idempotencyKey",
  ] as const) {
    string(item[field], `${path}.${field}`, false);
  }
  optionalString(item.parentId, `${path}.parentId`);
  optionalString(item.replyTo, `${path}.replyTo`);
  optionalString(item.causationId, `${path}.causationId`);
  dateTime(item.createdAt, `${path}.createdAt`);
  if (item.expiresAt !== undefined) {
    dateTime(item.expiresAt, `${path}.expiresAt`);
  }
  oneOf(item.visibility, `${path}.visibility`, [
    "lane",
    "run",
    "user",
    "sensitive",
  ] as const);
  finiteNumber(item.priority, `${path}.priority`);
  oneOf(item.delivery, `${path}.delivery`, [
    "next-step",
    "next-turn",
    "deferred",
    "urgent",
  ] as const);

  const payload = record(item.payload, `${path}.payload`);
  oneOf(payload.type, `${path}.payload.type`, [
    "advice.propose",
    "task.request",
    "task.accept",
    "task.result",
    "task.failed",
    "question.ask",
    "question.answer",
    "message.inform",
  ] as const);
  switch (payload.type) {
    case "advice.propose":
      advice(payload.advice, `${path}.payload.advice`);
      if ((payload.advice as Advice).sourceLane !== item.from) {
        invalid(`${path}.payload.advice.sourceLane`, "equal to the message sender");
      }
      break;
    case "task.request":
      taskId(payload.taskId, `${path}.payload.taskId`);
      goal(payload.goal, `${path}.payload.goal`);
      artifactRefArray(payload.inputRefs, `${path}.payload.inputRefs`);
      taskBudget(payload.budget, `${path}.payload.budget`);
      {
        const budget = payload.budget as TaskBudget;
        const deadline = budget.deadline;
        if (deadline !== undefined) {
          const expectedDeadline = Date.parse(item.createdAt as string)
            + budget.maxWallClockMs;
          if (Date.parse(deadline) !== expectedDeadline) {
            invalid(
              `${path}.payload.budget.deadline`,
              "equal to message createdAt plus maxWallClockMs",
            );
          }
        }
      }
      break;
    case "task.accept":
      taskId(payload.taskId, `${path}.payload.taskId`);
      break;
    case "task.result":
      taskId(payload.taskId, `${path}.payload.taskId`);
      oneOf(payload.status, `${path}.payload.status`, ["completed", "partial"] as const);
      string(payload.summary, `${path}.payload.summary`, false);
      stringArray(payload.evidenceRefs, `${path}.payload.evidenceRefs`);
      artifactRefArray(payload.artifactRefs, `${path}.payload.artifactRefs`);
      stringArray(payload.openQuestions, `${path}.payload.openQuestions`);
      usage(payload.usage, `${path}.payload.usage`);
      break;
    case "task.failed":
      taskId(payload.taskId, `${path}.payload.taskId`);
      string(payload.reason, `${path}.payload.reason`, false);
      boolean(payload.retryable, `${path}.payload.retryable`);
      stringArray(payload.evidenceRefs, `${path}.payload.evidenceRefs`);
      break;
    case "question.ask":
      string(payload.question, `${path}.payload.question`, false);
      break;
    case "question.answer":
      string(payload.answer, `${path}.payload.answer`);
      break;
    case "message.inform":
      string(payload.text, `${path}.payload.text`);
      break;
  }
}

function payloadObject(
  value: unknown,
  path: string,
  fields: readonly string[],
): Record<string, unknown> {
  const item = record(value, path);
  for (const field of fields) {
    if (!Object.hasOwn(item, field)) {
      invalid(`${path}.${field}`, "present");
    }
  }
  return item;
}

const payloadValidators = {
  "run.created": (value, path) => {
    const item = payloadObject(value, path, ["goal", "workspace", "policy"]);
    goal(item.goal, `${path}.goal`);
    string(item.workspace, `${path}.workspace`, false);
    runPolicy(item.policy, `${path}.policy`);
  },
  "run.resumed": (value, path) => {
    const item = payloadObject(value, path, ["fromOffset"]);
    integer(item.fromOffset, `${path}.fromOffset`);
    if (item.reason !== undefined) {
      oneOf(item.reason, `${path}.reason`, ["new-turn"] as const);
    }
  },
  "run.completed": (value, path) => {
    const item = record(value, path);
    if (item.answerRef !== undefined) artifactRef(item.answerRef, `${path}.answerRef`);
  },
  "run.failed": (value, path) => {
    const item = payloadObject(value, path, ["error"]);
    string(item.error, `${path}.error`);
  },
  "goal.revised": (value, path) => {
    const item = payloadObject(value, path, ["goal"]);
    goal(item.goal, `${path}.goal`);
  },
  "lane.registered": (value, path) => {
    const item = payloadObject(value, path, ["kind"]);
    oneOf(item.kind, `${path}.kind`, ["main", "intent-navigator", "reflection", "worker"] as const);
  },
  "lane.status": (value, path) => {
    const item = payloadObject(value, path, ["status"]);
    oneOf(item.status, `${path}.status`, [
      "dormant",
      "ready",
      "running",
      "waiting",
      "completed",
      "failed",
      "cancelled",
    ] as const);
    optionalString(item.reason, `${path}.reason`);
  },
  "step.started": (value, path) => {
    const item = payloadObject(value, path, ["step"]);
    integer(item.step, `${path}.step`, 1);
  },
  "step.completed": (value, path) => {
    const item = payloadObject(value, path, ["step", "hasToolCalls"]);
    integer(item.step, `${path}.step`, 1);
    boolean(item.hasToolCalls, `${path}.hasToolCalls`);
    if (item.boundaryMessageIds !== undefined) {
      stringArray(item.boundaryMessageIds, `${path}.boundaryMessageIds`);
      const unique = new Set<string>();
      item.boundaryMessageIds.forEach((messageId, index) => {
        string(messageId, `${path}.boundaryMessageIds[${index}]`, false);
        if (unique.has(messageId)) {
          invalid(`${path}.boundaryMessageIds[${index}]`, "unique within the Step");
        }
        unique.add(messageId);
      });
    }
  },
  "step.failed": (value, path) => {
    const item = payloadObject(value, path, ["step", "error"]);
    integer(item.step, `${path}.step`, 1);
    string(item.error, `${path}.error`);
  },
  "input.admitted": (value, path) => {
    const item = payloadObject(value, path, [
      "inputId",
      "messageRef",
      "delivery",
      "sequence",
    ]);
    string(item.inputId, `${path}.inputId`, false);
    artifactRef(item.messageRef, `${path}.messageRef`);
    oneOf(item.delivery, `${path}.delivery`, [
      "new-turn",
      "steering",
      "follow-up",
    ] as const);
    optionalString(item.targetTurnId, `${path}.targetTurnId`);
    integer(item.sequence, `${path}.sequence`, 1);
  },
  "input.delivered": (value, path) => {
    const item = payloadObject(value, path, ["inputId", "turnId", "boundary"]);
    string(item.inputId, `${path}.inputId`, false);
    string(item.turnId, `${path}.turnId`, false);
    string(item.boundary, `${path}.boundary`, false);
  },
  "turn.started": (value, path) => {
    const item = payloadObject(value, path, ["turnId", "inputId", "ordinal"]);
    string(item.turnId, `${path}.turnId`, false);
    string(item.inputId, `${path}.inputId`, false);
    integer(item.ordinal, `${path}.ordinal`, 1);
  },
  "turn.completed": (value, path) => {
    const item = payloadObject(value, path, ["turnId"]);
    string(item.turnId, `${path}.turnId`, false);
    if (item.answerRef !== undefined) artifactRef(item.answerRef, `${path}.answerRef`);
  },
  "turn.failed": (value, path) => {
    const item = payloadObject(value, path, ["turnId", "error"]);
    string(item.turnId, `${path}.turnId`, false);
    string(item.error, `${path}.error`);
  },
  "turn.cancelled": (value, path) => {
    const item = payloadObject(value, path, ["turnId", "reason", "lastCommittedStep"]);
    string(item.turnId, `${path}.turnId`, false);
    string(item.reason, `${path}.reason`, false);
    integer(item.lastCommittedStep, `${path}.lastCommittedStep`);
  },
  "turn.waiting": (value, path) => {
    const item = payloadObject(value, path, [
      "turnId",
      "reason",
      "lastCommittedStep",
      "resumeRequires",
    ]);
    string(item.turnId, `${path}.turnId`, false);
    string(item.reason, `${path}.reason`, false);
    integer(item.lastCommittedStep, `${path}.lastCommittedStep`);
    string(item.resumeRequires, `${path}.resumeRequires`, false);
  },
  "turn.interrupted": (value, path) => {
    const item = payloadObject(value, path, [
      "turnId",
      "reason",
      "retryable",
      "lastCommittedStep",
    ]);
    string(item.turnId, `${path}.turnId`, false);
    string(item.reason, `${path}.reason`, false);
    boolean(item.retryable, `${path}.retryable`);
    integer(item.lastCommittedStep, `${path}.lastCommittedStep`);
  },
  "turn.resumed": (value, path) => {
    const item = payloadObject(value, path, ["turnId", "fromStep", "stepAllowance"]);
    string(item.turnId, `${path}.turnId`, false);
    integer(item.fromStep, `${path}.fromStep`);
    integer(item.stepAllowance, `${path}.stepAllowance`, 1);
  },
  "user.message": (value, path) => {
    const item = payloadObject(value, path, ["messageRef"]);
    artifactRef(item.messageRef, `${path}.messageRef`);
    const hasInputId = Object.hasOwn(item, "inputId");
    const hasKind = Object.hasOwn(item, "kind");
    if (hasInputId !== hasKind) {
      invalid(path, "a legacy message or a message with both inputId and kind");
    }
    if (hasInputId) {
      string(item.inputId, `${path}.inputId`, false);
      oneOf(item.kind, `${path}.kind`, ["initial", "steering"] as const);
    }
  },
  "assistant.message": (value, path) => {
    const item = payloadObject(value, path, ["messageRef"]);
    artifactRef(item.messageRef, `${path}.messageRef`);
  },
  "navigation.updated": (value, path) => {
    const item = payloadObject(value, path, ["delta"]);
    navigationDelta(item.delta, `${path}.delta`);
  },
  "model.selected": (value, path) => {
    const item = payloadObject(value, path, ["model"]);
    string(item.model, `${path}.model`, false);
    if (
      (item.model as string).length > 256
      || /[\s\u0000-\u001f\u007f]/u.test(item.model as string)
    ) {
      invalid(`${path}.model`, "at most 256 characters without spaces or control characters");
    }
    const separator = (item.model as string).indexOf(":");
    if (
      separator === 0
      || (separator >= 0 && separator === (item.model as string).length - 1)
    ) {
      invalid(`${path}.model`, "a valid provider:model or model selector");
    }
  },
  "model.requested": (value, path) => {
    const item = payloadObject(value, path, [
      "model",
      "requestHash",
      "contextWatermark",
    ]);
    string(item.model, `${path}.model`, false);
    string(item.requestHash, `${path}.requestHash`, false);
    integer(item.contextWatermark, `${path}.contextWatermark`);
    if (item.sessionId !== undefined) {
      string(item.sessionId, `${path}.sessionId`, false);
    }
    optionalString(item.prefixHash, `${path}.prefixHash`);
    if (item.dependencyRefs !== undefined) {
      stringArray(item.dependencyRefs, `${path}.dependencyRefs`);
    }
    if (item.truncations !== undefined) {
      if (!Array.isArray(item.truncations)) {
        invalid(`${path}.truncations`, "an array of context truncations");
      }
      item.truncations.forEach((truncation, index) => {
        contextTruncation(truncation, `${path}.truncations[${index}]`);
      });
    }
    if (item.contextBuildMs !== undefined) {
      finiteNumber(item.contextBuildMs, `${path}.contextBuildMs`);
    }
    if (item.estimatedInputTokens !== undefined) {
      integer(item.estimatedInputTokens, `${path}.estimatedInputTokens`);
    }
    if (item.contextManifest !== undefined) {
      contextManifest(item.contextManifest, `${path}.contextManifest`);
    }
  },
  "model.completed": (value, path) => {
    const item = payloadObject(value, path, [
      "model",
      "responseRef",
      "stopReason",
      "usage",
    ]);
    string(item.model, `${path}.model`, false);
    artifactRef(item.responseRef, `${path}.responseRef`);
    string(item.stopReason, `${path}.stopReason`);
    usage(item.usage, `${path}.usage`);
    if (item.modelLatencyMs !== undefined) {
      finiteNumber(item.modelLatencyMs, `${path}.modelLatencyMs`);
    }
    if (item.cacheOutcome !== undefined) {
      oneOf(item.cacheOutcome, `${path}.cacheOutcome`, [
        "hit",
        "write",
        "hit-write",
        "unknown",
      ] as const);
    }
  },
  "model.failed": (value, path) => {
    const item = payloadObject(value, path, ["model", "error"]);
    string(item.model, `${path}.model`, false);
    string(item.error, `${path}.error`);
    if (item.retryable !== undefined) {
      boolean(item.retryable, `${path}.retryable`);
    }
  },
  "model.cancelled": (value, path) => {
    const item = payloadObject(value, path, ["requestId", "reason"]);
    string(item.requestId, `${path}.requestId`, false);
    string(item.reason, `${path}.reason`, false);
  },
  "tool.requested": (value, path) => {
    const item = payloadObject(value, path, [
      "operationId",
      "toolCallId",
      "name",
      "argumentsRef",
    ]);
    string(item.operationId, `${path}.operationId`, false);
    string(item.toolCallId, `${path}.toolCallId`, false);
    string(item.name, `${path}.name`, false);
    artifactRef(item.argumentsRef, `${path}.argumentsRef`);
  },
  "tool.succeeded": (value, path) => {
    const item = payloadObject(value, path, [
      "operationId",
      "toolCallId",
      "name",
      "resultRef",
    ]);
    string(item.operationId, `${path}.operationId`, false);
    string(item.toolCallId, `${path}.toolCallId`, false);
    string(item.name, `${path}.name`, false);
    artifactRef(item.resultRef, `${path}.resultRef`);
  },
  "tool.failed": (value, path) => {
    const item = payloadObject(value, path, [
      "operationId",
      "toolCallId",
      "name",
      "error",
      "resultRef",
    ]);
    string(item.operationId, `${path}.operationId`, false);
    string(item.toolCallId, `${path}.toolCallId`, false);
    string(item.name, `${path}.name`, false);
    string(item.error, `${path}.error`);
    artifactRef(item.resultRef, `${path}.resultRef`);
    if (item.resolution !== undefined) {
      oneOf(item.resolution, `${path}.resolution`, ["operator"] as const);
    }
  },
  "tool.unknown": (value, path) => {
    const item = payloadObject(value, path, [
      "operationId",
      "toolCallId",
      "name",
      "reason",
    ]);
    string(item.operationId, `${path}.operationId`, false);
    string(item.toolCallId, `${path}.toolCallId`, false);
    string(item.name, `${path}.name`, false);
    string(item.reason, `${path}.reason`, false);
  },
  "message.sent": (value, path) => {
    const item = payloadObject(value, path, ["message"]);
    a2aMessage(item.message, `${path}.message`);
  },
  "message.claimed": (value, path) => {
    const item = payloadObject(value, path, ["messageId", "claimedBy"]);
    string(item.messageId, `${path}.messageId`, false);
    string(item.claimedBy, `${path}.claimedBy`, false);
  },
  "message.handled": (value, path) => {
    const item = payloadObject(value, path, ["messageId"]);
    string(item.messageId, `${path}.messageId`, false);
  },
  "teto.advice.generated": (value, path) => {
    const item = payloadObject(value, path, ["advice", "delivery"]);
    advice(item.advice, `${path}.advice`);
    oneOf(item.delivery, `${path}.delivery`, ["live", "shadow"] as const);
    if ((item.advice as Advice).sourceLane !== "teto") {
      invalid(`${path}.advice.sourceLane`, "equal to teto");
    }
  },
  "reflection.observed": (value, path) => {
    const item = payloadObject(value, path, [
      "mainCallIndex",
      "trigger",
      "action",
      "reflectionRef",
      "usage",
    ]);
    integer(item.mainCallIndex, `${path}.mainCallIndex`, 1);
    string(item.trigger, `${path}.trigger`, false);
    oneOf(item.action, `${path}.action`, ["silent", "revise"] as const);
    artifactRef(item.reflectionRef, `${path}.reflectionRef`);
    usage(item.usage, `${path}.usage`);
  },
  "reflection.delivered": (value, path) => {
    const item = payloadObject(value, path, ["mainCallIndex", "messageId"]);
    integer(item.mainCallIndex, `${path}.mainCallIndex`, 1);
    string(item.messageId, `${path}.messageId`, false);
  },
  "advice.acknowledged": (value, path) => {
    const item = payloadObject(value, path, ["adviceId", "disposition"]);
    string(item.adviceId, `${path}.adviceId`, false);
    oneOf(item.disposition, `${path}.disposition`, ["accept", "defer", "reject"] as const);
    optionalString(item.reason, `${path}.reason`);
  },
  "teto.observed": (value, path) => {
    const item = payloadObject(value, path, ["mainCallIndex", "trigger", "frameHash", "usage"]);
    integer(item.mainCallIndex, `${path}.mainCallIndex`, 1);
    string(item.trigger, `${path}.trigger`, false);
    string(item.frameHash, `${path}.frameHash`, false);
    usage(item.usage, `${path}.usage`);
  },
  "budget.charged": (value, path) => {
    const item = payloadObject(value, path, ["laneId", "usage"]);
    string(item.laneId, `${path}.laneId`, false);
    usage(item.usage, `${path}.usage`);
  },
  "checkpoint.committed": (value, path) => {
    const item = payloadObject(value, path, ["watermark", "checksum"]);
    integer(item.watermark, `${path}.watermark`);
    string(item.checksum, `${path}.checksum`, false);
  },
  "fukai.query.audit": (value, path) => {
    const item = payloadObject(value, path, [
      "queryId",
      "operation",
      "reason",
      "filterHash",
      "cursor",
      "nextCursor",
      "upperWatermark",
      "status",
      "budget",
      "usage",
      "returnedCount",
      "deniedCount",
      "evidenceRefs",
      "resultHash",
    ]);
    string(item.queryId, `${path}.queryId`, false);
    oneOf(item.operation, `${path}.operation`, ["events", "artifact"] as const);
    string(item.reason, `${path}.reason`, false);
    string(item.filterHash, `${path}.filterHash`, false);
    string(item.cursor, `${path}.cursor`, false);
    string(item.nextCursor, `${path}.nextCursor`, false);
    integer(item.upperWatermark, `${path}.upperWatermark`);
    oneOf(item.status, `${path}.status`, [
      "ok",
      "truncated",
      "denied",
      "not-found",
      "stale",
    ] as const);
    const budget = record(item.budget, `${path}.budget`);
    integer(budget.maxEvents, `${path}.budget.maxEvents`);
    integer(budget.maxBytes, `${path}.budget.maxBytes`);
    integer(budget.maxTokens, `${path}.budget.maxTokens`);
    integer(budget.maxWallClockMs, `${path}.budget.maxWallClockMs`, 1);
    const usage = record(item.usage, `${path}.usage`);
    integer(usage.events, `${path}.usage.events`);
    integer(usage.bytes, `${path}.usage.bytes`);
    integer(usage.tokens, `${path}.usage.tokens`);
    integer(item.returnedCount, `${path}.returnedCount`);
    integer(item.deniedCount, `${path}.deniedCount`);
    stringArray(item.evidenceRefs, `${path}.evidenceRefs`);
    string(item.resultHash, `${path}.resultHash`, false);
  },
  "fukai.checkpoint.committed": (value, path) => {
    const item = payloadObject(value, path, [
      "cursor",
      "upperWatermark",
      "goalVersion",
      "stateRefs",
      "stateHash",
      "policyVersion",
    ]);
    string(item.cursor, `${path}.cursor`);
    integer(item.upperWatermark, `${path}.upperWatermark`);
    integer(item.goalVersion, `${path}.goalVersion`, 1);
    if (!Array.isArray(item.stateRefs)) {
      invalid(`${path}.stateRefs`, "an array of artifact refs");
    }
    item.stateRefs.forEach((ref, index) => artifactRef(ref, `${path}.stateRefs[${index}]`));
    string(item.stateHash, `${path}.stateHash`, false);
    string(item.policyVersion, `${path}.policyVersion`, false);
  },
  "fukai.compaction.pressure": (value, path) => {
    const item = payloadObject(value, path, [
      "trigger",
      "model",
      "contextWindowTokens",
      "currentTokens",
      "thresholdTokens",
      "minimumRetainedRawTokens",
      "selectedRawTokens",
      "retainedRawTokens",
      "predictedGainTokens",
      "decision",
      "reason",
    ]);
    oneOf(item.trigger, `${path}.trigger`, ["main-pre-step"] as const);
    string(item.model, `${path}.model`, false);
    if (item.contextWindowTokens !== null) {
      integer(item.contextWindowTokens, `${path}.contextWindowTokens`, 1);
    }
    integer(item.currentTokens, `${path}.currentTokens`);
    if (item.thresholdTokens !== null) {
      integer(item.thresholdTokens, `${path}.thresholdTokens`);
    }
    if (item.minimumRetainedRawTokens !== null) {
      integer(
        item.minimumRetainedRawTokens,
        `${path}.minimumRetainedRawTokens`,
      );
    }
    integer(item.selectedRawTokens, `${path}.selectedRawTokens`);
    integer(item.retainedRawTokens, `${path}.retainedRawTokens`);
    finiteNumber(item.predictedGainTokens, `${path}.predictedGainTokens`, -Number.MAX_VALUE);
    oneOf(item.decision, `${path}.decision`, ["compact", "skip"] as const);
    oneOf(item.reason, `${path}.reason`, [
      "pressure-threshold-reached",
      "below-threshold",
      "no-compactable-prefix",
      "insufficient-predicted-gain",
      "context-window-unknown",
      "source-window-unavailable",
    ] as const);
    if ((item.decision === "compact") !== (item.reason === "pressure-threshold-reached")) {
      invalid(`${path}.decision`, "compact exactly when pressure threshold is reached");
    }
  },
  "fukai.compaction.requested": (value, path) => {
    const item = payloadObject(value, path, [
      "compactionId",
      "attemptId",
      "attempt",
      "cursor",
      "upperWatermark",
      "goalVersion",
      "policyVersion",
      "sourceRefs",
      "budget",
    ]);
    compactionAttempt(item, path);
    if (item.repairFromCompactionId !== undefined) {
      compactionId(item.repairFromCompactionId, `${path}.repairFromCompactionId`);
      if (item.repairFromCompactionId === item.compactionId) {
        invalid(`${path}.repairFromCompactionId`, "different from compactionId");
      }
    }
    integer(item.upperWatermark, `${path}.upperWatermark`);
    cursor(item.cursor, `${path}.cursor`, item.upperWatermark);
    integer(item.goalVersion, `${path}.goalVersion`, 1);
    string(item.policyVersion, `${path}.policyVersion`, false);
    contextSourceRefs(item.sourceRefs, `${path}.sourceRefs`);
    if (item.deferredConversationRefs !== undefined) {
      boundedArtifactRefs(
        item.deferredConversationRefs,
        `${path}.deferredConversationRefs`,
        item.sourceRefs,
      );
    }
    if (item.generation !== undefined) {
      compactionGeneration(item.generation, `${path}.generation`);
    }
    if (item.sourceRefs.length < 1) {
      invalid(`${path}.sourceRefs`, "at least one source ref");
    }
    compactionBudget(item.budget, `${path}.budget`);
  },
  "fukai.compaction.completed": (value, path) => {
    const item = payloadObject(value, path, [
      "compactionId",
      "attemptId",
      "attempt",
      "elapsedMs",
      "usage",
      "summaryRef",
      "summaryHash",
      "estimatedTokens",
    ]);
    compactionAttempt(item, path);
    finiteNumber(item.elapsedMs, `${path}.elapsedMs`);
    nullableUsage(item.usage, `${path}.usage`);
    artifactRef(item.summaryRef, `${path}.summaryRef`);
    if (item.summaryRef.mediaType !== FUKAI_COMPACTION_MEDIA_TYPE) {
      invalid(`${path}.summaryRef.mediaType`, FUKAI_COMPACTION_MEDIA_TYPE);
    }
    string(item.summaryHash, `${path}.summaryHash`, false);
    if (item.summaryHash !== item.summaryRef.contentHash) {
      invalid(`${path}.summaryHash`, "match summaryRef.contentHash");
    }
    integer(item.estimatedTokens, `${path}.estimatedTokens`);
    optionalString(item.generationSpecHash, `${path}.generationSpecHash`);
    if (
      item.generationSpecHash !== undefined
      && !/^sha256:[0-9a-f]{64}$/.test(item.generationSpecHash as string)
    ) {
      invalid(`${path}.generationSpecHash`, "a sha256:<lowercase digest> identity");
    }
  },
  "fukai.compaction.failed": (value, path) => {
    const item = payloadObject(value, path, [
      "compactionId",
      "attemptId",
      "attempt",
      "status",
      "elapsedMs",
      "usage",
    ]);
    compactionAttempt(item, path);
    oneOf(item.status, `${path}.status`, ["failed", "timed-out", "cancelled"] as const);
    finiteNumber(item.elapsedMs, `${path}.elapsedMs`);
    nullableUsage(item.usage, `${path}.usage`);
  },
  "fukai.compaction.committed": (value, path) => {
    const item = payloadObject(value, path, [
      "compactionId",
      "attemptId",
      "summaryRef",
      "sourceRefs",
      "cursor",
      "upperWatermark",
      "goalVersion",
      "policyVersion",
      "summaryHash",
      "estimatedTokens",
    ]);
    compactionId(item.compactionId, `${path}.compactionId`);
    if (item.attemptId !== null) {
      string(item.attemptId, `${path}.attemptId`, false);
      if (!item.attemptId.startsWith(`${item.compactionId}:attempt:`)) {
        invalid(`${path}.attemptId`, "associated with compactionId");
      }
    }
    artifactRef(item.summaryRef, `${path}.summaryRef`);
    if (item.summaryRef.mediaType !== FUKAI_COMPACTION_MEDIA_TYPE) {
      invalid(`${path}.summaryRef.mediaType`, FUKAI_COMPACTION_MEDIA_TYPE);
    }
    contextSourceRefs(item.sourceRefs, `${path}.sourceRefs`);
    if (item.deferredConversationRefs !== undefined) {
      boundedArtifactRefs(
        item.deferredConversationRefs,
        `${path}.deferredConversationRefs`,
        item.sourceRefs,
      );
    }
    if (item.generation !== undefined) {
      compactionGeneration(item.generation, `${path}.generation`);
    }
    if (item.resetFromCompactionId !== undefined) {
      compactionId(item.resetFromCompactionId, `${path}.resetFromCompactionId`);
      if (item.resetFromCompactionId === item.compactionId) {
        invalid(`${path}.resetFromCompactionId`, "different from compactionId");
      }
      if ((item.sourceRefs as ContextSourceRef[]).some((source) => (
        source.kind === "artifact"
        && source.ref.mediaType === FUKAI_COMPACTION_MEDIA_TYPE
      ))) {
        invalid(path, "a repair reset without a compaction summary base");
      }
    }
    if (item.sourceRefs.length < 1) {
      invalid(`${path}.sourceRefs`, "at least one source ref");
    }
    integer(item.upperWatermark, `${path}.upperWatermark`);
    cursor(item.cursor, `${path}.cursor`, item.upperWatermark);
    integer(item.goalVersion, `${path}.goalVersion`, 1);
    string(item.policyVersion, `${path}.policyVersion`, false);
    string(item.summaryHash, `${path}.summaryHash`, false);
    if (item.summaryHash !== item.summaryRef.contentHash) {
      invalid(`${path}.summaryHash`, "match summaryRef.contentHash");
    }
    integer(item.estimatedTokens, `${path}.estimatedTokens`);
  },
  "fukai.compaction.fallback": (value, path) => {
    const item = payloadObject(value, path, [
      "compactionId",
      "attemptId",
      "attempt",
      "reason",
      "phase",
    ]);
    compactionId(item.compactionId, `${path}.compactionId`);
    if ((item.attemptId === null) !== (item.attempt === null)) {
      invalid(path, "attemptId and attempt both null or both present");
    }
    if (item.attemptId !== null) compactionAttempt(item, path);
    oneOf(item.reason, `${path}.reason`, [
      "budget-exhausted",
      "stale",
      "verification-failed",
    ] as const);
    oneOf(item.phase, `${path}.phase`, ["preflight", "commit", "read-back"] as const);
    if (item.reason === "budget-exhausted") {
      if (item.attemptId !== null) {
        invalid(`${path}.attemptId`, "null for budget-exhausted preflight fallback");
      }
      if (item.phase !== "preflight") {
        invalid(`${path}.phase`, "preflight for budget-exhausted fallback");
      }
    }
  },
} satisfies Record<EventType, PayloadValidator>;

export const eventTypes = new Set<EventType>(
  Object.keys(payloadValidators) as EventType[],
);

export function validateEventPayload(type: EventType, value: unknown): void {
  payloadValidators[type](value, `payload(${type})`);
}

/** Envelope identity is required because run/lane are not duplicated in the payload. */
export function validateCompactionRequestEnvelope(
  type: EventType,
  value: unknown,
  runId: string,
  laneId: string,
): void {
  if (type !== "fukai.compaction.requested") return;
  const item = value as EventPayloadMap["fukai.compaction.requested"];
  const expectedId = deriveContextCompactionId({
    runId,
    laneId,
    cursor: item.cursor,
    upperWatermark: item.upperWatermark,
    goalVersion: item.goalVersion,
    policyVersion: item.policyVersion,
    sourceRefs: item.sourceRefs,
    ...(item.deferredConversationRefs === undefined
      ? {}
      : { deferredConversationRefs: item.deferredConversationRefs }),
    ...(item.repairFromCompactionId === undefined
      ? {}
      : { repairFromCompactionId: item.repairFromCompactionId }),
    ...(item.generation === undefined ? {} : { generation: item.generation }),
    budget: item.budget,
  });
  if (item.compactionId !== expectedId) {
    invalid(
      "payload(fukai.compaction.requested).compactionId",
      "derived from the run, lane, and requested compaction identity",
    );
  }
}

export function validateMessageRun(message: A2AMessage, runId: string): void {
  if (message.runId !== runId) {
    invalid("payload(message.sent).message.runId", "equal to the event runId");
  }
}
