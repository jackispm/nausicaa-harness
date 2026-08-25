import type { EventPayloadMap, EventType } from "../domain/events.js";
import type {
  A2AMessage,
  Advice,
  ArtifactRef,
  Goal,
  NavigationDelta,
  RunPolicy,
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

function goal(value: unknown, path: string): asserts value is Goal {
  const item = record(value, path);
  integer(item.version, `${path}.version`, 1);
  string(item.statement, `${path}.statement`, false);
  stringArray(item.successCriteria, `${path}.successCriteria`);
  stringArray(item.hardConstraints, `${path}.hardConstraints`);
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
  integer(item.tetoMaxOutputTokens, `${path}.tetoMaxOutputTokens`);
  finiteNumber(item.tetoTokenRatio, `${path}.tetoTokenRatio`);
  if ((item.tetoTokenRatio as number) > 1) {
    invalid(`${path}.tetoTokenRatio`, "a finite number between 0 and 1");
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
    oneOf(item.kind, `${path}.kind`, ["main", "intent-navigator"] as const);
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
  "model.requested": (value, path) => {
    const item = payloadObject(value, path, [
      "model",
      "requestHash",
      "contextWatermark",
    ]);
    string(item.model, `${path}.model`, false);
    string(item.requestHash, `${path}.requestHash`, false);
    integer(item.contextWatermark, `${path}.contextWatermark`);
    optionalString(item.prefixHash, `${path}.prefixHash`);
    if (item.dependencyRefs !== undefined) {
      stringArray(item.dependencyRefs, `${path}.dependencyRefs`);
    }
    if (item.contextBuildMs !== undefined) {
      finiteNumber(item.contextBuildMs, `${path}.contextBuildMs`);
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
} satisfies Record<EventType, PayloadValidator>;

export const eventTypes = new Set<EventType>(
  Object.keys(payloadValidators) as EventType[],
);

export function validateEventPayload(type: EventType, value: unknown): void {
  payloadValidators[type](value, `payload(${type})`);
}

export function validateMessageRun(message: A2AMessage, runId: string): void {
  if (message.runId !== runId) {
    invalid("payload(message.sent).message.runId", "equal to the event runId");
  }
}
