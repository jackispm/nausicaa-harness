import type { EventPayloadMap, EventType } from "../domain/events.js";
import {
  envelopeToA2AMessage,
  normalizeEnvelope,
  normalizeReceipt,
} from "../a2a/cross-run-contract.js";
import {
  CONTEXT_MANIFEST_SCHEMA_VERSION,
  deriveContextCompactionAttemptId,
  deriveContextCompactionId,
  FUKAI_COMPACTION_MEDIA_TYPE,
  PROJECT_INSTRUCTIONS_MEDIA_TYPE,
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
import { sha256, stableJson } from "./hash.js";
import type {
  A2AMessage,
  Advice,
  ArtifactRef,
  Goal,
  ThreadGoal,
  NavigationDelta,
  RunPolicy,
  TaskBudget,
  TokenUsage,
  Visibility,
} from "../domain/types.js";
import {
  validateLaneCapabilityManifest,
  validateSpawnContext,
} from "../runtime/lane-context.js";
import type { TeamCapabilityGrant, TeamDefinition, TeamMemberDefinition } from "../domain/team.js";

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

function sourceArtifactRef(value: unknown, path: string): asserts value is ArtifactRef {
  artifactRef(value, path);
  if (!/^sha256:[0-9a-f]{64}$/.test(value.contentHash)) {
    invalid(`${path}.contentHash`, "a SHA-256 digest");
  }
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

function threadGoal(value: unknown, path: string): asserts value is ThreadGoal {
  const item = record(value, path);
  string(item.goalId, `${path}.goalId`, false);
  integer(item.revision, `${path}.revision`, 1);
  string(item.objective, `${path}.objective`, false);
  oneOf(item.status, `${path}.status`, [
    "active", "paused", "blocked", "usageLimited", "budgetLimited", "complete",
  ] as const);
  if (item.tokenBudget !== undefined) integer(item.tokenBudget, `${path}.tokenBudget`, 1);
  integer(item.tokensUsed, `${path}.tokensUsed`);
  integer(item.timeUsedSeconds, `${path}.timeUsedSeconds`);
  integer(item.continuationsUsed, `${path}.continuationsUsed`);
  dateTime(item.createdAt, `${path}.createdAt`);
  dateTime(item.updatedAt, `${path}.updatedAt`);
  if (item.blockedReason !== undefined) {
    if (item.status !== "blocked") invalid(`${path}.blockedReason`, "omitted unless status is blocked");
    string(item.blockedReason, `${path}.blockedReason`, false);
  }
}

function taskId(value: unknown, path: string): void {
  string(value, path, false);
  if ((value as string).length > 128) {
    invalid(path, "at most 128 characters");
  }
}

function taskBudget(value: unknown, path: string): void {
  const item = record(value, path);
  if (item.maxModelTokens !== undefined) {
    integer(item.maxModelTokens, `${path}.maxModelTokens`, 1);
    if ((item.maxModelTokens as number) > MAX_TASK_MODEL_TOKENS) {
      invalid(`${path}.maxModelTokens`, `at most ${MAX_TASK_MODEL_TOKENS}`);
    }
  }
  if (item.maxWallClockMs !== undefined) {
    integer(item.maxWallClockMs, `${path}.maxWallClockMs`, 1);
    if ((item.maxWallClockMs as number) > MAX_TASK_WALL_CLOCK_MS) {
      invalid(`${path}.maxWallClockMs`, `at most ${MAX_TASK_WALL_CLOCK_MS}`);
    }
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

function teamId(value: unknown, path: string): asserts value is string {
  string(value, path, false);
  if (!/^[A-Za-z0-9._-]{1,96}$/.test(value)) {
    invalid(path, "1 to 96 letters, digits, dots, underscores, or hyphens");
  }
}

function teamMember(value: unknown, path: string): asserts value is TeamMemberDefinition {
  const member = payloadObject(value, path, ["memberId", "laneId", "task", "dependsOn", "required"]);
  exactKeys(member, ["memberId", "laneId", "task", "dependsOn", "required", "capabilities"], path);
  teamId(member.memberId, `${path}.memberId`);
  string(member.laneId, `${path}.laneId`, false);
  if ((member.laneId as string).length > 256) invalid(`${path}.laneId`, "at most 256 characters");
  boolean(member.required, `${path}.required`);
  if (member.capabilities !== undefined) teamCapabilityGrant(member.capabilities, `${path}.capabilities`);
  if (!Array.isArray(member.dependsOn) || member.dependsOn.length > 16) {
    invalid(`${path}.dependsOn`, "an array of at most 16 member IDs");
  }
  const dependencies = new Set<string>();
  member.dependsOn.forEach((dependency, index) => {
    teamId(dependency, `${path}.dependsOn[${index}]`);
    if (dependency === member.memberId || dependencies.has(dependency)) {
      invalid(`${path}.dependsOn[${index}]`, "a distinct other member ID");
    }
    dependencies.add(dependency);
  });
  const task = payloadObject(member.task, `${path}.task`, ["type", "taskId", "goal", "inputRefs", "budget"]);
  exactKeys(task, ["type", "taskId", "goal", "inputRefs", "budget", "spawnContext"], `${path}.task`);
  oneOf(task.type, `${path}.task.type`, ["task.request"] as const);
  taskId(task.taskId, `${path}.task.taskId`);
  goal(task.goal, `${path}.task.goal`);
  boundedArtifactRefs(task.inputRefs, `${path}.task.inputRefs`);
  taskBudget(task.budget, `${path}.task.budget`);
  if (task.spawnContext !== undefined) {
    validateSpawnContext(task.spawnContext);
    if (task.spawnContext.child.laneId !== member.laneId) {
      invalid(`${path}.task.spawnContext.child.laneId`, "equal to the member laneId");
    }
  }
}

function teamCapabilityGrant(value: unknown, path: string): asserts value is TeamCapabilityGrant {
  const grant = payloadObject(value, path, ["tools", "allowNestedTeam"]);
  exactKeys(grant, ["tools", "allowNestedTeam"], path);
  if (grant.tools !== undefined) {
    if (!Array.isArray(grant.tools) || grant.tools.length > 64) invalid(`${path}.tools`, "an array of at most 64 tool names");
    const names = new Set<string>();
    grant.tools.forEach((tool, index) => {
      string(tool, `${path}.tools[${index}]`, false);
      if (!/^[a-z][a-z0-9_:-]{0,127}$/u.test(tool as string)) invalid(`${path}.tools[${index}]`, "a valid tool name");
      if (names.has(tool as string)) invalid(`${path}.tools[${index}]`, "a unique tool name");
      names.add(tool as string);
    });
  }
  if (grant.allowNestedTeam !== undefined) boolean(grant.allowNestedTeam, `${path}.allowNestedTeam`);
}

function teamDefinition(value: unknown, path: string): asserts value is TeamDefinition {
  const item = payloadObject(value, path, [
    "teamId", "leadLaneId", "joinPolicy", "peerMessaging", "fingerprint", "members",
  ]);
  exactKeys(item, ["teamId", "leadLaneId", "joinPolicy", "peerMessaging", "deadline", "fingerprint", "members"], path);
  teamId(item.teamId, `${path}.teamId`);
  string(item.leadLaneId, `${path}.leadLaneId`, false);
  oneOf(item.joinPolicy, `${path}.joinPolicy`, ["all-terminal", "deadline-best-effort"] as const);
  oneOf(item.peerMessaging, `${path}.peerMessaging`, ["team-members", "lead-only"] as const);
  if (item.deadline !== undefined) dateTime(item.deadline, `${path}.deadline`);
  if (item.joinPolicy === "deadline-best-effort" && item.deadline === undefined) {
    invalid(`${path}.deadline`, "a deadline for deadline-best-effort joins");
  }
  string(item.fingerprint, `${path}.fingerprint`, false);
  if ((item.fingerprint as string).length > 256) invalid(`${path}.fingerprint`, "at most 256 characters");
  if (!Array.isArray(item.members) || item.members.length === 0 || item.members.length > 16) {
    invalid(`${path}.members`, "an array of 1 to 16 members");
  }
  const members = new Map<string, TeamMemberDefinition>();
  const taskIds = new Set<string>();
  item.members.forEach((member, index) => {
    teamMember(member, `${path}.members[${index}]`);
    if (members.has(member.memberId) || taskIds.has(member.task.taskId)) {
      invalid(`${path}.members[${index}]`, "a unique member and task identity");
    }
    if (member.laneId !== `team:${item.teamId as string}:${member.memberId}` || member.laneId === item.leadLaneId) {
      invalid(`${path}.members[${index}].laneId`, "the host-issued team:<teamId>:<memberId> lane");
    }
    members.set(member.memberId, member);
    taskIds.add(member.task.taskId);
  });
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (memberId: string): void => {
    if (visiting.has(memberId)) invalid(`${path}.members`, "an acyclic dependency graph");
    if (visited.has(memberId)) return;
    const member = members.get(memberId);
    if (member === undefined) invalid(`${path}.members`, "dependencies naming existing members");
    visiting.add(memberId);
    member.dependsOn.forEach(visit);
    visiting.delete(memberId);
    visited.add(memberId);
  };
  for (const memberId of members.keys()) visit(memberId);
}

function teamOutcome(item: Record<string, unknown>, path: string): void {
  oneOf(item.outcome, `${path}.outcome`, ["succeeded", "partial", "failed", "cancelled", "abandoned"] as const);
  if (item.result !== undefined) {
    const result = payloadObject(item.result, `${path}.result`, [
      "type", "taskId", "status", "summary", "evidenceRefs", "artifactRefs", "openQuestions", "usage",
    ]);
    oneOf(result.type, `${path}.result.type`, ["task.result"] as const);
    taskId(result.taskId, `${path}.result.taskId`);
    oneOf(result.status, `${path}.result.status`, ["completed", "partial"] as const);
    string(result.summary, `${path}.result.summary`, false);
    stringArray(result.evidenceRefs, `${path}.result.evidenceRefs`);
    boundedArtifactRefs(result.artifactRefs, `${path}.result.artifactRefs`);
    stringArray(result.openQuestions, `${path}.result.openQuestions`);
    usage(result.usage, `${path}.result.usage`);
    if (item.taskId !== undefined && result.taskId !== item.taskId) {
      invalid(`${path}.result.taskId`, "equal to the settled taskId");
    }
    const expected = result.status === "partial" ? "partial" : "succeeded";
    if (item.outcome !== expected || item.failure !== undefined) {
      invalid(path, "a consistent result outcome without a failure");
    }
  }
  if (item.failure !== undefined) {
    const failure = payloadObject(item.failure, `${path}.failure`, ["type", "taskId", "reason", "retryable", "evidenceRefs"]);
    oneOf(failure.type, `${path}.failure.type`, ["task.failed"] as const);
    taskId(failure.taskId, `${path}.failure.taskId`);
    string(failure.reason, `${path}.failure.reason`, false);
    boolean(failure.retryable, `${path}.failure.retryable`);
    stringArray(failure.evidenceRefs, `${path}.failure.evidenceRefs`);
    if (item.taskId !== undefined && failure.taskId !== item.taskId) {
      invalid(`${path}.failure.taskId`, "equal to the settled taskId");
    }
    if (item.outcome === "succeeded" || item.outcome === "partial") {
      invalid(path, "a failure without a successful or partial result");
    }
  }
}

function taskRequestPayload(value: unknown, path: string): void {
  const task = payloadObject(value, path, ["type", "taskId", "goal", "inputRefs", "budget"]);
  exactKeys(task, ["type", "taskId", "goal", "inputRefs", "budget", "spawnContext"], path);
  oneOf(task.type, `${path}.type`, ["task.request"] as const);
  taskId(task.taskId, `${path}.taskId`);
  goal(task.goal, `${path}.goal`);
  boundedArtifactRefs(task.inputRefs, `${path}.inputRefs`);
  taskBudget(task.budget, `${path}.budget`);
  if (task.spawnContext !== undefined) validateSpawnContext(task.spawnContext);
}

function teamRunReport(value: unknown, path: string): void {
  const item = payloadObject(value, path, [
    "teamId", "taskId", "laneId", "assignmentVersion", "kind", "summary",
    "artifactRefs", "openQuestions",
  ]);
  exactKeys(item, [
    "teamId", "taskId", "laneId", "assignmentVersion", "kind", "summary",
    "artifactRefs", "openQuestions", "result", "failure",
  ], path);
  teamId(item.teamId, `${path}.teamId`);
  taskId(item.taskId, `${path}.taskId`);
  string(item.laneId, `${path}.laneId`, false);
  integer(item.assignmentVersion, `${path}.assignmentVersion`, 1);
  oneOf(item.kind, `${path}.kind`, ["checkpoint", "ready-for-review", "blocked", "failed"] as const);
  string(item.summary, `${path}.summary`, false);
  boundedArtifactRefs(item.artifactRefs, `${path}.artifactRefs`);
  stringArray(item.openQuestions, `${path}.openQuestions`);
  if (item.result !== undefined) {
    teamOutcome({ taskId: item.taskId, outcome: (item.result as Record<string, unknown>).status === "partial" ? "partial" : "succeeded", result: item.result }, `${path}.result`);
  }
  if (item.failure !== undefined) {
    teamOutcome({ taskId: item.taskId, outcome: "failed", failure: item.failure }, `${path}.failure`);
  }
  if (item.result !== undefined && item.failure !== undefined) invalid(path, "at most one of result or failure");
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
  if (item.maxModelTokens !== undefined) {
    integer(item.maxModelTokens, `${path}.maxModelTokens`, 1);
  }
  if (item.mainRequestTimeoutMs !== undefined) {
    integer(item.mainRequestTimeoutMs, `${path}.mainRequestTimeoutMs`, 1);
    if ((item.mainRequestTimeoutMs as number) > 60 * 60 * 1_000) {
      invalid(`${path}.mainRequestTimeoutMs`, "at most 3600000");
    }
  }
  boolean(item.tetoEnabled, `${path}.tetoEnabled`);
  if (item.workerEnabled !== undefined) {
    boolean(item.workerEnabled, `${path}.workerEnabled`);
  }
  integer(item.tetoMaxOutputTokens, `${path}.tetoMaxOutputTokens`, 1);
  if (item.tetoTokenRatio !== undefined) {
    ratio(item.tetoTokenRatio, `${path}.tetoTokenRatio`);
  }
  if (item.tetoActivation !== undefined) {
    oneOf(item.tetoActivation, `${path}.tetoActivation`, ["automatic", "manual"] as const);
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
    if (fukai.enabled === true && fukai.provider === "none") {
      invalid(`${path}.fukaiCompaction.provider`, "pi-ai when Fukai compaction is enabled");
    }
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
    "image-budget",
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

function contextProjectInstructionsManifest(value: unknown, path: string): void {
  const item = payloadObject(value, path, [
    "schemaVersion",
    "state",
    "itemCount",
    "totalBytes",
    "sourceHash",
    "contentHash",
    "sources",
  ]);
  if (item.schemaVersion !== 1) {
    invalid(`${path}.schemaVersion`, "the supported value 1");
  }
  oneOf(item.state, `${path}.state`, ["empty", "present"] as const);
  integer(item.itemCount, `${path}.itemCount`);
  integer(item.totalBytes, `${path}.totalBytes`);
  for (const field of ["sourceHash", "contentHash"] as const) {
    string(item[field], `${path}.${field}`, false);
    if (!/^sha256:[0-9a-f]{64}$/.test(item[field] as string)) {
      invalid(`${path}.${field}`, "a sha256:<lowercase digest> identity");
    }
  }
  if (!Array.isArray(item.sources)) {
    invalid(`${path}.sources`, "an array");
  }
  const sources = item.sources.map((value, index) => {
    const source = payloadObject(value, `${path}.sources[${index}]`, [
      "pathHash",
      "contentHash",
      "byteLength",
    ]);
    for (const field of ["pathHash", "contentHash"] as const) {
      string(source[field], `${path}.sources[${index}].${field}`, false);
      if (!/^sha256:[0-9a-f]{64}$/.test(source[field] as string)) {
        invalid(
          `${path}.sources[${index}].${field}`,
          "a sha256:<lowercase digest> identity",
        );
      }
    }
    integer(source.byteLength, `${path}.sources[${index}].byteLength`);
    return {
      pathHash: source.pathHash as string,
      contentHash: source.contentHash as string,
      byteLength: source.byteLength as number,
    };
  });
  if (item.itemCount !== sources.length) {
    invalid(`${path}.itemCount`, "equal to the source count");
  }
  if (item.totalBytes !== sources.reduce((sum, source) => sum + source.byteLength, 0)) {
    invalid(`${path}.totalBytes`, "equal to the source byte total");
  }
  if (item.sourceHash !== sha256(stableJson(sources.map((source) => source.pathHash)))) {
    invalid(`${path}.sourceHash`, "match the ordered source identities");
  }
  if (item.contentHash !== sha256(stableJson(sources.map((source) => ({
    contentHash: source.contentHash,
    byteLength: source.byteLength,
  }))))) {
    invalid(`${path}.contentHash`, "match the ordered content identities");
  }
  if (item.state === "empty") {
    if (sources.length !== 0 || item.bundleRef !== undefined) {
      invalid(path, "empty without sources or a bundle ref");
    }
    return;
  }
  if (sources.length === 0 || item.bundleRef === undefined) {
    invalid(path, "present with sources and a bundle ref");
  }
  artifactRef(item.bundleRef, `${path}.bundleRef`);
  if ((item.bundleRef as ArtifactRef).mediaType !== PROJECT_INSTRUCTIONS_MEDIA_TYPE) {
    invalid(`${path}.bundleRef.mediaType`, PROJECT_INSTRUCTIONS_MEDIA_TYPE);
  }
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
  if (item.projectInstructions !== undefined) {
    contextProjectInstructionsManifest(
      item.projectInstructions,
      `${path}.projectInstructions`,
    );
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
  const crossRunFields = [
    "routeId",
    "routeRelationship",
    "routeArtifacts",
    "sourceEndpoint",
    "targetEndpoint",
  ] as const;
  // Treat explicitly supplied `undefined` optionals like absent legacy fields.
  // A partially populated route (at least one defined field) still must carry
  // the complete trusted metadata set below.
  const hasCrossRunMetadata = crossRunFields.some((field) => item[field] !== undefined);
  if (hasCrossRunMetadata) {
    // Cross-Run routes carry their own stable topology and causal identity.
    // Legacy parent/reply fields are ambiguous here and must not be allowed
    // to smuggle a second route relationship into the trusted envelope.
    if (item.parentId !== undefined || item.replyTo !== undefined) {
      invalid(`${path}.parentId`, "absent for a cross-Run message");
    }
    for (const field of crossRunFields) {
      if (item[field] === undefined) {
        invalid(`${path}.${field}`, "present with the complete cross-Run route metadata");
      }
    }
    crossRunEndpoint(item.sourceEndpoint, `${path}.sourceEndpoint`);
    crossRunEndpoint(item.targetEndpoint, `${path}.targetEndpoint`);
    if (item.routeArtifacts !== undefined) {
      crossRunArtifactDeliveries(
        item.routeArtifacts,
        `${path}.routeArtifacts`,
        item.targetEndpoint as Record<string, unknown>,
      );
    }
  }
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
      if (payload.spawnContext !== undefined) {
        try {
          validateSpawnContext(payload.spawnContext);
        } catch (error: unknown) {
          invalid(
            `${path}.payload.spawnContext`,
            error instanceof Error ? error.message : "a valid SpawnContext",
          );
        }
      }
      {
        const budget = payload.budget as TaskBudget;
        const deadline = budget.deadline;
        if (deadline !== undefined && budget.maxWallClockMs !== undefined) {
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
  if (hasCrossRunMetadata) {
    if (item.delivery !== "next-step") {
      invalid(`${path}.delivery`, "next-step for a cross-Run message");
    }
    let envelope: ReturnType<typeof normalizeEnvelope>;
    try {
      envelope = normalizeEnvelope({
        protocolVersion: 1,
        messageId: item.messageId,
        routeId: item.routeId,
        source: item.sourceEndpoint,
        target: item.targetEndpoint,
        relationship: item.routeRelationship,
        conversationId: item.conversationId,
        threadId: item.threadId,
        correlationId: item.correlationId,
        idempotencyKey: item.idempotencyKey,
        createdAt: item.createdAt,
        ...(item.expiresAt === undefined ? {} : { expiresAt: item.expiresAt }),
        ...(item.causationId === undefined ? {} : { causationId: item.causationId }),
        visibility: item.visibility,
        priority: item.priority,
        payload: item.payload,
        artifacts: item.routeArtifacts,
      });
    } catch (error: unknown) {
      invalid(
        path,
        error instanceof Error ? `a valid cross-Run envelope (${error.message})` : "a valid cross-Run envelope",
      );
    }
    const expected = envelopeToA2AMessage(envelope);
    for (const field of [
      "messageId",
      "runId",
      "conversationId",
      "threadId",
      "from",
      "to",
      "createdAt",
      "correlationId",
      "idempotencyKey",
      "visibility",
      "priority",
      "delivery",
      "payload",
      "routeId",
      "routeRelationship",
      "routeArtifacts",
      "sourceEndpoint",
      "targetEndpoint",
    ] as const) {
      if (stableJson(item[field]) !== stableJson(expected[field])) {
        invalid(`${path}.${field}`, "match its trusted cross-Run envelope");
      }
    }
    if ((item.expiresAt ?? undefined) !== (expected.expiresAt ?? undefined)) {
      invalid(`${path}.expiresAt`, "match its trusted cross-Run envelope");
    }
    if ((item.causationId ?? undefined) !== (expected.causationId ?? undefined)) {
      invalid(`${path}.causationId`, "match its trusted cross-Run envelope");
    }
  }
}

function crossRunEndpoint(value: unknown, path: string): void {
  const item = record(value, path);
  const keys = ["workspaceId", "sessionId", "runId", "laneId"];
  for (const key of keys) string(item[key], `${path}.${key}`, false);
  for (const key of Object.keys(item)) if (!keys.includes(key)) invalid(`${path}.${key}`, "a known endpoint field");
}

function crossRunArtifactDeliveries(value: unknown, path: string, target: Record<string, unknown>): void {
  if (!Array.isArray(value)) invalid(path, "an array");
  value.forEach((candidate, index) => {
    const item = payloadObject(candidate, `${path}[${index}]`, ["sourceRef", "targetRef", "visibility", "targetWorkspaceId"]);
    exactKeys(item, ["sourceRef", "targetRef", "visibility", "targetWorkspaceId"], `${path}[${index}]`);
    artifactRef(item.sourceRef, `${path}[${index}].sourceRef`);
    artifactRef(item.targetRef, `${path}[${index}].targetRef`);
    if (stableJson(item.sourceRef) !== stableJson(item.targetRef)) invalid(`${path}[${index}]`, "matching source and target ArtifactRefs");
    oneOf(item.visibility, `${path}[${index}].visibility`, ["lane", "run", "user", "sensitive"] as const);
    string(item.targetWorkspaceId, `${path}[${index}].targetWorkspaceId`, false);
    if (item.targetWorkspaceId !== target.workspaceId) invalid(`${path}[${index}].targetWorkspaceId`, "equal to target workspaceId");
  });
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

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) invalid(`${path}.${key}`, "a known field");
  }
}

const payloadValidators = {
  "run.created": (value, path) => {
    const item = payloadObject(value, path, ["workspace", "policy"]);
    if (item.goal !== undefined) goal(item.goal, `${path}.goal`);
    string(item.workspace, `${path}.workspace`, false);
    runPolicy(item.policy, `${path}.policy`);
    if (item.mainModel !== undefined) {
      string(item.mainModel, `${path}.mainModel`, false);
      if (
        (item.mainModel as string).length > 256
        || /[\s\u0000-\u001f\u007f]/u.test(item.mainModel as string)
      ) {
        invalid(`${path}.mainModel`, "at most 256 characters without spaces or control characters");
      }
      const separator = (item.mainModel as string).indexOf(":");
      if (
        separator === 0
        || (separator >= 0 && separator === (item.mainModel as string).length - 1)
      ) {
        invalid(`${path}.mainModel`, "a valid provider:model or model selector");
      }
    }
  },
  "run.forked": (value, path) => {
    const item = payloadObject(value, path, ["parentRunId", "parentCheckpoint"]);
    string(item.parentRunId, `${path}.parentRunId`, false);
    const checkpoint = payloadObject(
      item.parentCheckpoint,
      `${path}.parentCheckpoint`,
      ["watermark", "checksum"],
    );
    integer(checkpoint.watermark, `${path}.parentCheckpoint.watermark`, 1);
    string(checkpoint.checksum, `${path}.parentCheckpoint.checksum`, false);
    if (!/^sha256:[0-9a-f]{64}$/.test(checkpoint.checksum as string)) {
      invalid(`${path}.parentCheckpoint.checksum`, "a SHA-256 digest");
    }
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
  "thread.goal.changed": (value, path) => {
    const item = payloadObject(value, path, ["operation", "goal"]);
    oneOf(item.operation, `${path}.operation`, [
      "create", "edit", "progress", "pause", "resume", "complete", "blocked", "usageLimited", "budgetLimited",
    ] as const);
    const operation = item.operation as
      | "create"
      | "edit"
      | "progress"
      | "pause"
      | "resume"
      | "complete"
      | "blocked"
      | "usageLimited"
      | "budgetLimited";
    threadGoal(item.goal, `${path}.goal`);
    if (item.expectedRevision !== undefined) integer(item.expectedRevision, `${path}.expectedRevision`, 1);
    const status = (item.goal as unknown as ThreadGoal).status;
    const expectedStatus = {
      pause: "paused",
      resume: "active",
      complete: "complete",
      blocked: "blocked",
      usageLimited: "usageLimited",
      budgetLimited: "budgetLimited",
    } as const;
    if (operation in expectedStatus && status !== expectedStatus[operation as keyof typeof expectedStatus]) {
      invalid(`${path}.goal.status`, `the status implied by operation ${operation}`);
    }
    if (operation === "create" && status !== "active") {
      invalid(`${path}.goal.status`, "active for a create operation");
    }
  },
  "thread.goal.cleared": (value, path) => {
    const item = payloadObject(value, path, ["goalId", "revision"]);
    string(item.goalId, `${path}.goalId`, false);
    integer(item.revision, `${path}.revision`, 1);
  },
  "todo.updated": (value, path) => {
    const item = payloadObject(value, path, ["revision", "items"]);
    integer(item.revision, `${path}.revision`, 1);
    if (!Array.isArray(item.items)) invalid(`${path}.items`, "an array");
    const ids = new Set<string>();
    item.items.forEach((candidate, index) => {
      const todo = payloadObject(candidate, `${path}.items[${index}]`, ["id", "content", "status"]);
      string(todo.id, `${path}.items[${index}].id`, false);
      string(todo.content, `${path}.items[${index}].content`, false);
      oneOf(todo.status, `${path}.items[${index}].status`, [
        "pending",
        "in_progress",
        "completed",
        "cancelled",
      ] as const);
      if (ids.has(todo.id as string)) invalid(`${path}.items[${index}].id`, "unique within items");
      ids.add(todo.id as string);
    });
    if (item.source !== undefined) {
      oneOf(item.source, `${path}.source`, ["model", "operator"] as const);
    }
  },
  "lane.registered": (value, path) => {
    const item = payloadObject(value, path, ["kind"]);
    oneOf(item.kind, `${path}.kind`, ["main", "intent-navigator", "reflection", "worker", "team"] as const);
    optionalString(item.teamFingerprint, `${path}.teamFingerprint`);
  },
  "lane.capability.published": (value, path) => {
    const item = payloadObject(value, path, ["manifest"]);
    try {
      validateLaneCapabilityManifest(item.manifest);
    } catch (error: unknown) {
      invalid(
        `${path}.manifest`,
        error instanceof Error ? error.message : "a valid lane capability manifest",
      );
    }
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
    if (item.control !== undefined) {
      const control = payloadObject(item.control, `${path}.control`, ["action", "requestedBy"]);
      oneOf(control.action, `${path}.control.action`, ["start", "stop"] as const);
      string(control.requestedBy, `${path}.control.requestedBy`, false);
    }
  },
  "team.created": teamDefinition,
  "team.member.settled": (value, path) => {
    const item = payloadObject(value, path, ["teamId", "memberId", "taskId", "outcome"]);
    exactKeys(item, ["teamId", "memberId", "taskId", "outcome", "requestMessageId", "result", "failure", "reason", "claimId", "attempt"], path);
    teamId(item.teamId, `${path}.teamId`);
    teamId(item.memberId, `${path}.memberId`);
    taskId(item.taskId, `${path}.taskId`);
    for (const field of ["requestMessageId", "reason", "claimId"] as const) {
      if (item[field] !== undefined) string(item[field], `${path}.${field}`, false);
    }
    if ((item.claimId === undefined) !== (item.attempt === undefined)) {
      invalid(path, "claimId and attempt both present or both omitted");
    }
    if (item.attempt !== undefined) integer(item.attempt, `${path}.attempt`, 1);
    teamOutcome(item, path);
  },
  "team.joined": (value, path) => {
    const item = payloadObject(value, path, ["teamId", "reason", "memberOutcomes"]);
    exactKeys(item, ["teamId", "reason", "memberOutcomes"], path);
    teamId(item.teamId, `${path}.teamId`);
    oneOf(item.reason, `${path}.reason`, ["all-terminal", "deadline-best-effort"] as const);
    if (!Array.isArray(item.memberOutcomes) || item.memberOutcomes.length > 16) {
      invalid(`${path}.memberOutcomes`, "an array of at most 16 member outcomes");
    }
    const ids = new Set<string>();
    const tasks = new Set<string>();
    item.memberOutcomes.forEach((value, index) => {
      const memberPath = `${path}.memberOutcomes[${index}]`;
      const member = payloadObject(value, memberPath, ["memberId", "taskId", "outcome"]);
      exactKeys(member, ["memberId", "taskId", "outcome"], memberPath);
      teamId(member.memberId, `${memberPath}.memberId`);
      taskId(member.taskId, `${memberPath}.taskId`);
      teamOutcome(member, memberPath);
      if (ids.has(member.memberId as string) || tasks.has(member.taskId as string)) {
        invalid(memberPath, "a unique member and task identity");
      }
      ids.add(member.memberId as string);
      tasks.add(member.taskId as string);
    });
  },
  "team.cancel.requested": (value, path) => {
    const item = payloadObject(value, path, ["teamId", "reason", "requestedBy"]);
    exactKeys(item, ["teamId", "reason", "requestedBy"], path);
    teamId(item.teamId, `${path}.teamId`);
    string(item.reason, `${path}.reason`, false);
    string(item.requestedBy, `${path}.requestedBy`, false);
  },
  "team.cancelled": (value, path) => {
    const item = payloadObject(value, path, ["teamId", "reason"]);
    exactKeys(item, ["teamId", "reason"], path);
    teamId(item.teamId, `${path}.teamId`);
    string(item.reason, `${path}.reason`, false);
  },
  "team.reduction.requested": (value, path) => {
    const item = payloadObject(value, path, ["teamId", "reducer"]);
    exactKeys(item, ["teamId", "reducer"], path);
    teamId(item.teamId, `${path}.teamId`);
    teamMember(item.reducer, `${path}.reducer`);
    if (item.reducer.laneId !== `team-reducer:${item.teamId}`
      && item.reducer.laneId !== `team:${item.teamId}:${item.reducer.memberId}`) {
      invalid(`${path}.reducer.laneId`, "a host-issued Team reducer lane");
    }
  },
  "team.reduced": (value, path) => {
    const item = payloadObject(value, path, ["teamId", "outcome"]);
    exactKeys(item, ["teamId", "outcome", "result", "failure"], path);
    teamId(item.teamId, `${path}.teamId`);
    teamOutcome(item, path);
  },
  "team.presented": (value, path) => {
    const item = payloadObject(value, path, ["teamId", "disposition"]);
    exactKeys(item, ["teamId", "disposition", "summaryRef"], path);
    teamId(item.teamId, `${path}.teamId`);
    oneOf(item.disposition, `${path}.disposition`, ["accepted", "rejected"] as const);
    if (item.summaryRef !== undefined) artifactRef(item.summaryRef, `${path}.summaryRef`);
  },
  "team.task.assigned": (value, path) => {
    const item = payloadObject(value, path, [
      "teamId", "taskId", "memberId", "laneId", "assignmentVersion", "task", "assignedBy",
      "operationId",
    ]);
    exactKeys(item, [
      "teamId", "taskId", "memberId", "laneId", "assignmentVersion", "task", "assignedBy",
      "operationId",
    ], path);
    teamId(item.teamId, `${path}.teamId`);
    taskId(item.taskId, `${path}.taskId`);
    teamId(item.memberId, `${path}.memberId`);
    string(item.laneId, `${path}.laneId`, false);
    integer(item.assignmentVersion, `${path}.assignmentVersion`, 1);
    taskRequestPayload(item.task, `${path}.task`);
    if ((item.task as Record<string, unknown>).taskId !== item.taskId) {
      invalid(`${path}.task.taskId`, "equal to taskId");
    }
    string(item.assignedBy, `${path}.assignedBy`, false);
    string(item.operationId, `${path}.operationId`, false);
  },
  "team.run.reported": (value, path) => {
    const item = payloadObject(value, path, [
      "teamId", "taskId", "laneId", "assignmentVersion", "kind", "summary",
      "artifactRefs", "openQuestions", "reportId", "runId",
    ]);
    exactKeys(item, [
      "teamId", "taskId", "laneId", "assignmentVersion", "kind", "summary",
      "artifactRefs", "openQuestions", "result", "failure", "reportId", "runId",
    ], path);
    teamRunReport({
      teamId: item.teamId, taskId: item.taskId, laneId: item.laneId,
      assignmentVersion: item.assignmentVersion, kind: item.kind, summary: item.summary,
      artifactRefs: item.artifactRefs, openQuestions: item.openQuestions,
      ...(item.result === undefined ? {} : { result: item.result }),
      ...(item.failure === undefined ? {} : { failure: item.failure }),
    }, path);
    string(item.reportId, `${path}.reportId`, false);
    string(item.runId, `${path}.runId`, false);
  },
  "team.message.sent": (value, path) => {
    const item = payloadObject(value, path, [
      "teamId", "channelId", "sequence", "fromLane", "threadId", "body",
      "mentions", "artifactRefs", "operationId",
    ]);
    teamId(item.teamId, `${path}.teamId`);
    string(item.channelId, `${path}.channelId`, false);
    integer(item.sequence, `${path}.sequence`, 1);
    string(item.fromLane, `${path}.fromLane`, false);
    if (item.threadId !== undefined) string(item.threadId, `${path}.threadId`, false);
    string(item.body, `${path}.body`, false);
    if ((item.body as string).length > 8_192) invalid(`${path}.body`, "at most 8192 characters");
    if (!Array.isArray(item.mentions) || item.mentions.length > 16) {
      invalid(`${path}.mentions`, "an array of at most 16 lane ids");
    }
    const mentions = new Set<string>();
    for (const [index, mention] of (item.mentions as unknown[]).entries()) {
      string(mention, `${path}.mentions[${index}]`, false);
      if (mentions.has(mention as string)) invalid(`${path}.mentions[${index}]`, "unique mentions");
      mentions.add(mention as string);
    }
    if (!Array.isArray(item.artifactRefs) || item.artifactRefs.length > 32) {
      invalid(`${path}.artifactRefs`, "an array of at most 32 artifact refs");
    }
    for (const [index, ref] of (item.artifactRefs as unknown[]).entries()) {
      artifactRef(ref, `${path}.artifactRefs[${index}]`);
    }
    string(item.operationId, `${path}.operationId`, false);
  },
  "team.closed": (value, path) => {
    const item = payloadObject(value, path, ["teamId", "reason", "closedBy"]);
    exactKeys(item, ["teamId", "reason", "closedBy"], path);
    teamId(item.teamId, `${path}.teamId`);
    string(item.reason, `${path}.reason`, false);
    string(item.closedBy, `${path}.closedBy`, false);
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
    if (item.boundaryMessages !== undefined) {
      if (!Array.isArray(item.boundaryMessages) || item.boundaryMessages.length > 256) {
        invalid(`${path}.boundaryMessages`, "an array of at most 256 boundary messages");
      }
      const consumed = new Set(item.boundaryMessageIds as string[] | undefined);
      const unique = new Set<string>();
      item.boundaryMessages.forEach((value, index) => {
        const messagePath = `${path}.boundaryMessages[${index}]`;
        const message = payloadObject(value, messagePath, ["messageId", "messageRef"]);
        exactKeys(message, ["messageId", "messageRef"], messagePath);
        string(message.messageId, `${messagePath}.messageId`, false);
        artifactRef(message.messageRef, `${messagePath}.messageRef`);
        if (!consumed.has(message.messageId)) invalid(`${messagePath}.messageId`, "included in boundaryMessageIds");
        if (unique.has(message.messageId)) invalid(`${messagePath}.messageId`, "unique within the Step");
        unique.add(message.messageId);
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
  "input.replaced": (value, path) => {
    const item = payloadObject(value, path, [
      "inputId",
      "expectedRevision",
      "expectedMessageRef",
      "revision",
      "messageRef",
      "delivery",
      "sequence",
    ]);
    string(item.inputId, `${path}.inputId`, false);
    integer(item.expectedRevision, `${path}.expectedRevision`, 1);
    artifactRef(item.expectedMessageRef, `${path}.expectedMessageRef`);
    integer(item.revision, `${path}.revision`, 2);
    artifactRef(item.messageRef, `${path}.messageRef`);
    oneOf(item.delivery, `${path}.delivery`, ["steering", "follow-up"] as const);
    optionalString(item.targetTurnId, `${path}.targetTurnId`);
    integer(item.sequence, `${path}.sequence`, 1);
  },
  "input.withdrawn": (value, path) => {
    const item = payloadObject(value, path, [
      "inputId",
      "expectedRevision",
      "expectedMessageRef",
    ]);
    string(item.inputId, `${path}.inputId`, false);
    integer(item.expectedRevision, `${path}.expectedRevision`, 1);
    artifactRef(item.expectedMessageRef, `${path}.expectedMessageRef`);
  },
  "input.delivered": (value, path) => {
    const item = payloadObject(value, path, ["inputId", "turnId", "boundary"]);
    string(item.inputId, `${path}.inputId`, false);
    string(item.turnId, `${path}.turnId`, false);
    string(item.boundary, `${path}.boundary`, false);
    if ((item.expectedRevision === undefined) !== (item.expectedMessageRef === undefined)) {
      invalid(path, "both expectedRevision and expectedMessageRef, or neither");
    }
    if (item.expectedRevision !== undefined) {
      integer(item.expectedRevision, `${path}.expectedRevision`, 1);
      artifactRef(item.expectedMessageRef, `${path}.expectedMessageRef`);
    }
  },
  "turn.started": (value, path) => {
    const item = payloadObject(value, path, ["turnId", "inputId", "ordinal"]);
    string(item.turnId, `${path}.turnId`, false);
    string(item.inputId, `${path}.inputId`, false);
    integer(item.ordinal, `${path}.ordinal`, 1);
    if (item.boundary !== undefined) {
      const boundary = payloadObject(
        item.boundary,
        `${path}.boundary`,
        ["collaborationMode", "capabilities"],
      );
      oneOf(
        boundary.collaborationMode,
        `${path}.boundary.collaborationMode`,
        ["default", "plan"] as const,
      );
      const capabilities = payloadObject(
        boundary.capabilities,
        `${path}.boundary.capabilities`,
        ["allowWrite", "allowShell", "allowNetwork"],
      );
      boolean(capabilities.allowWrite, `${path}.boundary.capabilities.allowWrite`);
      boolean(capabilities.allowShell, `${path}.boundary.capabilities.allowShell`);
      boolean(capabilities.allowNetwork, `${path}.boundary.capabilities.allowNetwork`);
    }
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
    optionalString(item.sourceEventId, `${path}.sourceEventId`);
    optionalString(item.sourceLane, `${path}.sourceLane`);
    const hasInputId = Object.hasOwn(item, "inputId");
    const hasKind = Object.hasOwn(item, "kind");
    if (hasInputId !== hasKind) {
      invalid(path, "a legacy message or a message with both inputId and kind");
    }
    if (hasInputId) {
      string(item.inputId, `${path}.inputId`, false);
      oneOf(item.kind, `${path}.kind`, ["initial", "steering", "continuation"] as const);
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
    if (item.thinkingLevel !== undefined) {
      oneOf(item.thinkingLevel, `${path}.thinkingLevel`, ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
    }
  },
  "thinking.selected": (value, path) => {
    const item = payloadObject(value, path, ["level"]);
    if (item.level !== null) {
      oneOf(item.level, `${path}.level`, ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
    }
  },
  "model.requested": (value, path) => {
    const item = payloadObject(value, path, [
      "model",
      "requestHash",
      "contextWatermark",
    ]);
    string(item.model, `${path}.model`, false);
    if (item.thinkingLevel !== undefined) {
      oneOf(item.thinkingLevel, `${path}.thinkingLevel`, ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
    }
    string(item.requestHash, `${path}.requestHash`, false);
    integer(item.contextWatermark, `${path}.contextWatermark`);
    if (item.deadlineMs !== undefined) {
      integer(item.deadlineMs, `${path}.deadlineMs`, 1);
      if ((item.deadlineMs as number) > 60 * 60 * 1_000) {
        invalid(`${path}.deadlineMs`, "at most 3600000");
      }
    }
    if (item.deadlineAt !== undefined) {
      dateTime(item.deadlineAt, `${path}.deadlineAt`);
    }
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
  "model.retrying": (value, path) => {
    const item = payloadObject(value, path, [
      "requestId",
      "model",
      "attempt",
      "maxAttempts",
      "delayMs",
      "category",
      "error",
    ]);
    string(item.requestId, `${path}.requestId`, false);
    string(item.model, `${path}.model`, false);
    integer(item.attempt, `${path}.attempt`, 1);
    integer(item.maxAttempts, `${path}.maxAttempts`, 1);
    if ((item.maxAttempts as number) > 10) {
      invalid(`${path}.maxAttempts`, "at most 10");
    }
    if ((item.attempt as number) >= (item.maxAttempts as number)) {
      invalid(`${path}.attempt`, "less than maxAttempts for a pending retry");
    }
    finiteNumber(item.delayMs, `${path}.delayMs`);
    if ((item.delayMs as number) > 60_000) {
      invalid(`${path}.delayMs`, "at most 60000");
    }
    oneOf(item.category, `${path}.category`, [
      "network",
      "rate-limit",
      "server",
      "timeout",
      "transient",
    ] as const);
    string(item.error, `${path}.error`, false);
    if ((item.error as string).length > 512) {
      invalid(`${path}.error`, "at most 512 characters");
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
  "tool.admitted": (value, path) => {
    const item = payloadObject(value, path, [
      "operationId",
      "toolCallId",
      "name",
      "argumentsHash",
    ]);
    string(item.operationId, `${path}.operationId`, false);
    string(item.toolCallId, `${path}.toolCallId`, false);
    string(item.name, `${path}.name`, false);
    string(item.argumentsHash, `${path}.argumentsHash`, false);
    if (!/^sha256:[0-9a-f]{64}$/.test(item.argumentsHash as string)) {
      invalid(`${path}.argumentsHash`, "a SHA-256 digest");
    }
  },
  "tool.started": (value, path) => {
    const item = payloadObject(value, path, [
      "operationId",
      "toolCallId",
      "name",
      "argumentsHash",
    ]);
    string(item.operationId, `${path}.operationId`, false);
    string(item.toolCallId, `${path}.toolCallId`, false);
    string(item.name, `${path}.name`, false);
    string(item.argumentsHash, `${path}.argumentsHash`, false);
    if (!/^sha256:[0-9a-f]{64}$/.test(item.argumentsHash as string)) {
      invalid(`${path}.argumentsHash`, "a SHA-256 digest");
    }
  },
  "approval.requested": (value, path) => {
    const item = payloadObject(value, path, [
      "operationId",
      "toolCallId",
      "name",
      "argumentsHash",
    ]);
    string(item.operationId, `${path}.operationId`, false);
    string(item.toolCallId, `${path}.toolCallId`, false);
    string(item.name, `${path}.name`, false);
    string(item.argumentsHash, `${path}.argumentsHash`, false);
    if (!/^sha256:[0-9a-f]{64}$/.test(item.argumentsHash as string)) {
      invalid(`${path}.argumentsHash`, "a SHA-256 digest");
    }
  },
  "approval.decided": (value, path) => {
    const item = payloadObject(value, path, [
      "operationId",
      "toolCallId",
      "name",
      "decision",
    ]);
    string(item.operationId, `${path}.operationId`, false);
    string(item.toolCallId, `${path}.toolCallId`, false);
    string(item.name, `${path}.name`, false);
    oneOf(item.decision, `${path}.decision`, ["approved", "denied", "cancelled"] as const);
    optionalString(item.reason, `${path}.reason`);
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
    if (item.contextRef !== undefined) artifactRef(item.contextRef, `${path}.contextRef`);
    if (item.sourceArtifactRef !== undefined) sourceArtifactRef(item.sourceArtifactRef, `${path}.sourceArtifactRef`);
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
    if (item.contextRef !== undefined) artifactRef(item.contextRef, `${path}.contextRef`);
    if (item.sourceArtifactRef !== undefined) sourceArtifactRef(item.sourceArtifactRef, `${path}.sourceArtifactRef`);
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
  "a2a.outbox.pending": (value, path) => {
    const item = payloadObject(value, path, ["envelope", "recordedAt"]);
    exactKeys(item, ["envelope", "recordedAt"], path);
    try {
      normalizeEnvelope(item.envelope);
    } catch (error: unknown) {
      invalid(`${path}.envelope`, error instanceof Error ? error.message : "a valid cross-Run envelope");
    }
    dateTime(item.recordedAt, `${path}.recordedAt`);
  },
  "a2a.outbox.attempted": (value, path) => {
    const item = payloadObject(value, path, ["routeId", "messageId", "attemptId", "attemptedAt"]);
    exactKeys(item, ["routeId", "messageId", "attemptId", "attemptedAt"], path);
    string(item.routeId, `${path}.routeId`, false);
    string(item.messageId, `${path}.messageId`, false);
    string(item.attemptId, `${path}.attemptId`, false);
    dateTime(item.attemptedAt, `${path}.attemptedAt`);
  },
  "a2a.outbox.receipt": (value, path) => {
    const item = payloadObject(value, path, ["receipt"]);
    exactKeys(item, ["receipt"], path);
    try {
      normalizeReceipt(item.receipt);
    } catch (error: unknown) {
      invalid(`${path}.receipt`, error instanceof Error ? error.message : "a valid cross-Run receipt");
    }
  },
  "message.claimed": (value, path) => {
    const item = payloadObject(value, path, ["messageId", "claimedBy"]);
    string(item.messageId, `${path}.messageId`, false);
    string(item.claimedBy, `${path}.claimedBy`, false);
  },
  "message.reclaimed": (value, path) => {
    const item = payloadObject(value, path, [
      "messageId", "reclaimedBy", "previousClaimId", "previousClaimedBy",
      "previousClaimedAt", "previousAttempt", "reason",
    ]);
    exactKeys(item, [
      "messageId", "reclaimedBy", "previousClaimId", "previousClaimedBy",
      "previousClaimedAt", "previousAttempt", "reason",
    ], path);
    string(item.messageId, `${path}.messageId`, false);
    string(item.reclaimedBy, `${path}.reclaimedBy`, false);
    string(item.previousClaimId, `${path}.previousClaimId`, false);
    string(item.previousClaimedBy, `${path}.previousClaimedBy`, false);
    dateTime(item.previousClaimedAt, `${path}.previousClaimedAt`);
    integer(item.previousAttempt, `${path}.previousAttempt`, 1);
    string(item.reason, `${path}.reason`, false);
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
} satisfies Record<EventType, PayloadValidator> & Record<"team.task.assigned" | "team.run.reported", PayloadValidator>;

export const eventTypes = new Set<string>(
  Object.keys(payloadValidators),
);

export function validateEventPayload(type: EventType | "team.task.assigned" | "team.run.reported", value: unknown): void {
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

export interface CrossRunEventMetadata {
  readonly occurredAt?: string | undefined;
  readonly turnId?: string | undefined;
  readonly causationId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly visibility?: Visibility | undefined;
}

/** Bind cross-Run facts/messages to the complete Ledger event identity. */
export function validateCrossRunEventEnvelope(
  type: EventType,
  value: unknown,
  runId: string,
  laneId: string,
  occurredAt: string,
  metadata?: CrossRunEventMetadata,
): void {
  if (type === "a2a.outbox.pending") {
    const item = value as NonNullable<EventPayloadMap[typeof type]>;
    const envelope = normalizeEnvelope(item.envelope);
    if (envelope.source.runId !== runId || envelope.source.laneId !== laneId) {
      invalid(
        `payload(${type}).envelope.source`,
        "bound to the event runId and laneId",
      );
    }
    if (item.recordedAt !== occurredAt) {
      invalid(`payload(${type}).recordedAt`, "equal to event occurredAt");
    }
    if (metadata !== undefined) {
      crossRunMetadata(metadata, {
        correlationId: envelope.correlationId,
        idempotencyKey: `a2a:outbox:${sha256(`outbox.pending\u0000${envelope.routeId}`)}`,
        visibility: envelope.visibility,
        causationId: envelope.causationId,
      }, type);
    }
    return;
  }
  if (type === "a2a.outbox.attempted") {
    const item = value as NonNullable<EventPayloadMap[typeof type]>;
    if (item.attemptedAt !== occurredAt) {
      invalid(`payload(${type}).attemptedAt`, "equal to event occurredAt");
    }
    if (metadata !== undefined) {
      crossRunMetadata(metadata, {
        correlationId: `a2a:${sha256(item.routeId)}`,
        idempotencyKey: `a2a:outbox:${sha256(`outbox.attempted\u0000${item.routeId}\u0000${item.attemptId}`)}`,
        visibility: "run",
        causationId: item.messageId,
      }, type);
    }
    return;
  }
  if (type === "a2a.outbox.receipt") {
    const item = value as NonNullable<EventPayloadMap[typeof type]>;
    const receipt = normalizeReceipt(item.receipt);
    if (receipt.source.runId !== runId || receipt.source.laneId !== laneId) {
      invalid(
        `payload(${type}).receipt.source`,
        "bound to the event runId and laneId",
      );
    }
    if (receipt.recordedAt !== occurredAt) {
      invalid(`payload(${type}).receipt.recordedAt`, "equal to event occurredAt");
    }
    if (metadata !== undefined) {
      crossRunMetadata(metadata, {
        correlationId: `a2a:${sha256(receipt.routeId)}`,
        idempotencyKey: `a2a:outbox:${sha256(`outbox.receipt\u0000${receipt.routeId}\u0000${receipt.status}`)}`,
        visibility: "run",
        causationId: receipt.attemptId ?? receipt.messageId,
      }, type);
    }
    return;
  }
  if (type === "message.sent") {
    const item = value as NonNullable<EventPayloadMap[typeof type]>;
    const message = item.message;
    const hasCrossRunMetadata = [
      "routeId",
      "routeRelationship",
      "routeArtifacts",
      "sourceEndpoint",
      "targetEndpoint",
    ].some((field) => (
      (message as unknown as Record<string, unknown>)[field] !== undefined
    ));
    if (!hasCrossRunMetadata) return;
    const envelope = normalizeEnvelope({
      protocolVersion: 1,
      messageId: message.messageId,
      routeId: message.routeId,
      source: message.sourceEndpoint,
      target: message.targetEndpoint,
      relationship: message.routeRelationship,
      conversationId: message.conversationId,
      threadId: message.threadId,
      correlationId: message.correlationId,
      idempotencyKey: message.idempotencyKey,
      createdAt: message.createdAt,
      ...(message.expiresAt === undefined ? {} : { expiresAt: message.expiresAt }),
      ...(message.causationId === undefined ? {} : { causationId: message.causationId }),
      visibility: message.visibility,
      priority: message.priority,
      payload: message.payload,
      artifacts: message.routeArtifacts,
    });
    if (envelope.target.runId !== runId || envelope.source.laneId !== laneId) {
      invalid(`payload(${type}).message`, "bound to the event target run and source lane");
    }
    if (metadata !== undefined) {
      crossRunMetadata(metadata, {
        correlationId: message.correlationId,
        idempotencyKey: message.routeId === undefined
          ? `a2a:send:${message.idempotencyKey}`
          : `a2a:send:${message.routeId}:${message.idempotencyKey}`,
        visibility: message.visibility,
        causationId: message.causationId,
        occurredAt: message.createdAt,
      }, type);
    }
  }
}

function crossRunMetadata(
  actual: CrossRunEventMetadata,
  expected: {
    readonly correlationId: string;
    readonly idempotencyKey: string;
    readonly visibility: Visibility;
    readonly causationId?: string | undefined;
    readonly occurredAt?: string | undefined;
  },
  type: EventType,
): void {
  if (actual.turnId !== undefined) {
    invalid(`event(${type}).turnId`, "absent for a cross-Run fact");
  }
  if (actual.correlationId !== expected.correlationId) {
    invalid(`event(${type}).correlationId`, "match its cross-Run provenance");
  }
  if (actual.idempotencyKey !== expected.idempotencyKey) {
    invalid(`event(${type}).idempotencyKey`, "match its cross-Run provenance");
  }
  if (actual.visibility !== expected.visibility) {
    invalid(`event(${type}).visibility`, "match its cross-Run provenance");
  }
  if ((actual.causationId ?? undefined) !== (expected.causationId ?? undefined)) {
    invalid(`event(${type}).causationId`, "match its cross-Run provenance");
  }
  if (expected.occurredAt !== undefined && actual.occurredAt !== expected.occurredAt) {
    invalid(`event(${type}).occurredAt`, "match its cross-Run provenance");
  }
}

export function validateMessageRun(message: A2AMessage, runId: string): void {
  if (message.runId !== runId) {
    invalid("payload(message.sent).message.runId", "equal to the event runId");
  }
}
