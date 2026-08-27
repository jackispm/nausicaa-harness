import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AnyEvent,
  AppendEvent,
  EventPayloadMap,
  EventType,
} from "../../src/domain/events.js";
import type {
  A2AMessage,
  Advice,
  ArtifactRef,
  Goal,
  NavigationDelta,
  RunPolicy,
  TokenUsage,
} from "../../src/domain/types.js";
import {
  computeEventContentHash,
  JsonlLedger,
  LedgerCorruptionError,
  MemoryLedger,
} from "../../src/ledger/index.js";
import { validateEventPayload } from "../../src/ledger/validation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

const artifact: ArtifactRef = {
  id: "artifact-1",
  contentHash: `sha256:${"a".repeat(64)}`,
  mediaType: "application/json",
  byteLength: 12,
};
const tokenUsage: TokenUsage = {
  input: 10,
  output: 2,
  cacheRead: 3,
  cacheWrite: 1,
  costUsd: 0.001,
};
const goal: Goal = {
  version: 1,
  statement: "Inspect the project",
  successCriteria: ["Report verified commands"],
  hardConstraints: ["Do not modify the target"],
};
const policy: RunPolicy = {
  maxMainSteps: 20,
  maxModelTokens: 20_000,
  tetoEnabled: true,
  tetoMaxOutputTokens: 200,
  tetoTokenRatio: 0.1,
};
const delta: NavigationDelta = {
  boundaryId: "boundary-1",
  triggerKind: "decision",
  activeObjective: "Find installation instructions",
  actionOrDecision: "Read package metadata",
  expectedOutcome: "Identify prerequisites",
  outcome: "Node version found",
  status: "progress",
  uncertainties: [],
  openQuestions: [],
};
const advice: Advice = {
  adviceId: "advice-1",
  kind: "intent-gap",
  claim: "A prerequisite may be missing",
  evidenceRefs: ["artifact-1"],
  confidence: 0.8,
  risk: "medium",
  suggestedAction: "Check package engines",
  urgency: "next-step",
  expiresAt: "2026-08-27T00:00:00.000Z",
  dedupeKey: "check-engines",
  sourceLane: "teto",
};
const message: A2AMessage = {
  messageId: "message-1",
  runId: "run-1",
  conversationId: "conversation-1",
  threadId: "thread-1",
  from: "teto",
  to: "main",
  createdAt: "2026-08-26T00:00:00.000Z",
  expiresAt: "2026-08-27T00:00:00.000Z",
  correlationId: "correlation-1",
  idempotencyKey: "message-1",
  visibility: "run",
  priority: 10,
  delivery: "next-step",
  payload: { type: "advice.propose", advice },
};

const validPayloads = {
  "run.created": { goal, workspace: "/workspace", policy },
  "run.resumed": { fromOffset: 4, reason: "new-turn" },
  "run.completed": { answerRef: artifact },
  "run.failed": { error: "model failed" },
  "goal.revised": { goal: { ...goal, version: 2 } },
  "lane.registered": { kind: "main" },
  "lane.status": { status: "running", reason: "scheduled" },
  "step.started": { step: 1 },
  "step.completed": { step: 1, hasToolCalls: false },
  "step.failed": { step: 1, error: "interrupted" },
  "input.admitted": {
    inputId: "input-1",
    messageRef: artifact,
    delivery: "steering",
    targetTurnId: "turn-1",
    sequence: 1,
  },
  "input.delivered": { inputId: "input-1", turnId: "turn-1", boundary: "safe-step" },
  "turn.started": { turnId: "turn-1", inputId: "input-1", ordinal: 1 },
  "turn.completed": { turnId: "turn-1", answerRef: artifact },
  "turn.failed": { turnId: "turn-1", error: "provider failed" },
  "turn.cancelled": { turnId: "turn-1", reason: "user", lastCommittedStep: 1 },
  "turn.waiting": {
    turnId: "turn-1",
    reason: "step-allowance-exhausted",
    lastCommittedStep: 1,
    resumeRequires: "explicit-resume",
  },
  "turn.interrupted": {
    turnId: "turn-1",
    reason: "process-interrupted",
    retryable: true,
    lastCommittedStep: 1,
  },
  "turn.resumed": { turnId: "turn-1", fromStep: 1, stepAllowance: 20 },
  "user.message": { inputId: "input-1", messageRef: artifact, kind: "initial" },
  "assistant.message": { messageRef: artifact },
  "navigation.updated": { delta },
  "model.requested": {
    model: "model-1",
    requestHash: "request-hash",
    contextWatermark: 3,
    sessionId: "run-1:main",
    prefixHash: "prefix-hash",
    dependencyRefs: ["artifact-1"],
    truncations: [{
      kind: "input-token-budget",
      ref: "artifact-1",
      detail: "Conversation content was bounded",
    }],
    contextBuildMs: 1.5,
  },
  "model.completed": {
    model: "model-1",
    responseRef: artifact,
    stopReason: "stop",
    usage: tokenUsage,
    modelLatencyMs: 2.5,
    cacheOutcome: "hit-write",
  },
  "model.failed": { model: "model-1", error: "provider failed" },
  "model.cancelled": { requestId: "event-model-requested", reason: "user" },
  "tool.requested": {
    operationId: "operation-1",
    toolCallId: "call-1",
    name: "read",
    argumentsRef: artifact,
  },
  "tool.succeeded": {
    operationId: "operation-1",
    toolCallId: "call-1",
    name: "read",
    resultRef: artifact,
  },
  "tool.failed": {
    operationId: "operation-1",
    toolCallId: "call-1",
    name: "read",
    error: "not found",
    resultRef: artifact,
    resolution: "operator",
  },
  "tool.unknown": {
    operationId: "operation-1",
    toolCallId: "call-1",
    name: "write",
    reason: "process-interrupted",
  },
  "message.sent": { message },
  "message.claimed": { messageId: "message-1", claimedBy: "main" },
  "message.handled": { messageId: "message-1" },
  "teto.advice.generated": { advice, delivery: "shadow" },
  "advice.acknowledged": {
    adviceId: "advice-1",
    disposition: "accept",
    reason: "useful",
  },
  "teto.observed": {
    mainCallIndex: 5,
    trigger: "cadence",
    frameHash: "frame-hash",
    usage: tokenUsage,
  },
  "budget.charged": { laneId: "main", usage: tokenUsage },
  "checkpoint.committed": { watermark: 4, checksum: "checkpoint-hash" },
  "reflection.observed": {
    mainCallIndex: 5,
    trigger: "cadence",
    action: "silent",
    reflectionRef: artifact,
    usage: tokenUsage,
  },
  "reflection.delivered": { mainCallIndex: 5, messageId: "reflection-5" },
  "fukai.query.audit": {
    queryId: "query-1",
    operation: "events",
    reason: "inspect recent decisions",
    filterHash: "sha256:filter",
    cursor: "offset:0",
    nextCursor: "offset:4",
    upperWatermark: 4,
    status: "ok",
    budget: { maxEvents: 10, maxBytes: 10_000, maxTokens: 2_000, maxWallClockMs: 1_000 },
    usage: { events: 1, bytes: 100, tokens: 25 },
    returnedCount: 1,
    deniedCount: 0,
    evidenceRefs: ["event-1"],
    resultHash: "sha256:result",
  },
  "fukai.checkpoint.committed": {
    cursor: "offset:4",
    upperWatermark: 4,
    goalVersion: 1,
    stateRefs: [artifact],
    stateHash: "sha256:state",
    policyVersion: "policy-v1",
  },
} satisfies EventPayloadMap;

const invalidPayloads = {
  "run.created": { goal, workspace: "/workspace" },
  "run.resumed": { fromOffset: -1 },
  "run.completed": { answerRef: null },
  "run.failed": {},
  "goal.revised": { goal: { ...goal, version: 0 } },
  "lane.registered": { kind: "unknown" },
  "lane.status": { status: "unknown" },
  "step.started": { step: 0 },
  "step.completed": { step: 1, hasToolCalls: "no" },
  "step.failed": { step: 1 },
  "input.admitted": {
    inputId: "input-1",
    messageRef: artifact,
    delivery: "urgent",
    sequence: 1,
  },
  "input.delivered": { inputId: "input-1", turnId: "turn-1", boundary: "" },
  "turn.started": { turnId: "turn-1", inputId: "input-1", ordinal: 0 },
  "turn.completed": { turnId: "", answerRef: artifact },
  "turn.failed": { turnId: "turn-1" },
  "turn.cancelled": { turnId: "turn-1", reason: "user", lastCommittedStep: -1 },
  "turn.waiting": {
    turnId: "turn-1",
    reason: "waiting",
    lastCommittedStep: 0,
  },
  "turn.interrupted": {
    turnId: "turn-1",
    reason: "interrupted",
    retryable: "yes",
    lastCommittedStep: 0,
  },
  "turn.resumed": { turnId: "turn-1", fromStep: 0, stepAllowance: 0 },
  "user.message": { inputId: "input-1", messageRef: artifact },
  "assistant.message": { messageRef: null },
  "navigation.updated": { delta: { ...delta, triggerKind: "wander" } },
  "model.requested": { model: "model-1", requestHash: "hash", contextWatermark: -1 },
  "model.completed": {
    model: "model-1",
    responseRef: artifact,
    stopReason: "stop",
    usage: { ...tokenUsage, output: -1 },
  },
  "model.failed": { model: "", error: "failed" },
  "model.cancelled": { requestId: "", reason: "user" },
  "tool.requested": { operationId: "op", toolCallId: "call", name: "read" },
  "tool.succeeded": {
    operationId: "",
    toolCallId: "call",
    name: "read",
    resultRef: artifact,
  },
  "tool.failed": {
    operationId: "op",
    toolCallId: "call",
    name: "read",
    error: "failed",
    resultRef: null,
  },
  "tool.unknown": {
    operationId: "op",
    toolCallId: "call",
    name: "",
    reason: "unknown",
  },
  "message.sent": { message: { ...message, priority: -1 } },
  "message.claimed": { messageId: "", claimedBy: "main" },
  "message.handled": { messageId: null },
  "teto.advice.generated": {
    advice: { ...advice, sourceLane: "worker" },
    delivery: "hidden",
  },
  "advice.acknowledged": { adviceId: "advice-1", disposition: "ignore" },
  "teto.observed": {
    mainCallIndex: 0,
    trigger: "cadence",
    frameHash: "hash",
    usage: tokenUsage,
  },
  "budget.charged": {
    laneId: "main",
    usage: { ...tokenUsage, costUsd: Number.NaN },
  },
  "checkpoint.committed": { watermark: -1, checksum: "hash" },
  "reflection.observed": {
    mainCallIndex: 0,
    trigger: "cadence",
    action: "silent",
    reflectionRef: artifact,
    usage: tokenUsage,
  },
  "reflection.delivered": { mainCallIndex: 0, messageId: "" },
  "fukai.query.audit": {
    queryId: "query-1",
    operation: "goal",
    reason: "inspect",
    filterHash: "hash",
    cursor: "offset:0",
    nextCursor: "offset:1",
    upperWatermark: 1,
    status: "ok",
    budget: { maxEvents: 1, maxBytes: 1, maxTokens: 1, maxWallClockMs: 1 },
    usage: { events: 1, bytes: 1, tokens: 1 },
    returnedCount: 1,
    deniedCount: 0,
    evidenceRefs: [],
    resultHash: "hash",
  },
  "fukai.checkpoint.committed": {
    cursor: "offset:1",
    upperWatermark: 1,
    goalVersion: 0,
    stateRefs: [artifact],
    stateHash: "hash",
    policyVersion: "policy",
  },
} satisfies Record<EventType, unknown>;

describe("event payload validation", () => {
  it("accepts a complete payload for every event type", () => {
    for (const type of Object.keys(validPayloads) as EventType[]) {
      expect(() => validateEventPayload(type, validPayloads[type])).not.toThrow();
    }
    expect(() => validateEventPayload("lane.registered", { kind: "reflection" })).not.toThrow();
    expect(() => validateEventPayload("lane.registered", { kind: "worker" })).not.toThrow();
    expect(() => validateEventPayload("message.sent", {
      message: {
        ...message,
        messageId: "task-request-message",
        from: "main",
        to: "worker-1",
        payload: {
          type: "task.request",
          taskId: "task-1",
          goal,
          inputRefs: [artifact],
          budget: { maxModelTokens: 1_000, maxWallClockMs: 30_000 },
        },
      },
    })).not.toThrow();
    expect(() => validateEventPayload("teto.advice.generated", {
      advice,
      delivery: "live",
    })).not.toThrow();
    expect(() => validateEventPayload("reflection.observed", {
      mainCallIndex: 2,
      trigger: "repeated-failure",
      action: "revise",
      reflectionRef: artifact,
      usage: tokenUsage,
    })).not.toThrow();
  });

  it("rejects malformed core data for every event type", () => {
    for (const type of Object.keys(invalidPayloads) as EventType[]) {
      expect(
        () => validateEventPayload(type, invalidPayloads[type]),
        type,
      ).toThrow();
    }
  });

  it("rejects malformed payloads before append", async () => {
    const ledger = new MemoryLedger();
    const command = {
      runId: "run-1",
      laneId: "main",
      type: "budget.charged",
      payload: {
        laneId: "main",
        usage: { input: 1, output: -1, cacheRead: 0, cacheWrite: 0 },
      },
      correlationId: "correlation-1",
      idempotencyKey: "invalid-budget",
    } as unknown as AppendEvent<"budget.charged">;

    await expect(ledger.append(command)).rejects.toBeInstanceOf(LedgerCorruptionError);
    await expect(ledger.watermark()).resolves.toBe(0);
  });

  it("rejects malformed optional telemetry fields", () => {
    expect(() => validateEventPayload("model.requested", {
      ...validPayloads["model.requested"],
      sessionId: "",
    })).toThrow(/sessionId/);
    expect(() => validateEventPayload("model.requested", {
      ...validPayloads["model.requested"],
      truncations: [{ kind: "unknown-limit", detail: "bounded" }],
    })).toThrow(/truncations\[0\]\.kind/);
    expect(() => validateEventPayload("model.requested", {
      ...validPayloads["model.requested"],
      truncations: [{ kind: "input-token-budget", detail: "" }],
    })).toThrow(/truncations\[0\]\.detail/);
    expect(() => validateEventPayload("model.requested", {
      ...validPayloads["model.requested"],
      contextBuildMs: -1,
    })).toThrow(/contextBuildMs/);
    expect(() => validateEventPayload("model.completed", {
      ...validPayloads["model.completed"],
      cacheOutcome: "miss",
    })).toThrow(/cacheOutcome/);
  });

  it("accepts exactly one current or legacy Main step policy field", () => {
    const { maxMainSteps: _maxMainSteps, ...withoutStepLimit } = policy;
    expect(() => validateEventPayload("run.created", {
      goal,
      workspace: "/workspace",
      policy: { ...withoutStepLimit, maxMainStepsPerActivation: 8 },
    })).not.toThrow();
    expect(() => validateEventPayload("run.created", {
      goal,
      workspace: "/workspace",
      policy: { ...policy, maxMainStepsPerActivation: 8 },
    })).toThrow(/exactly one/);
    expect(() => validateEventPayload("run.created", {
      goal,
      workspace: "/workspace",
      policy: withoutStepLimit,
    })).toThrow(/exactly one/);
    expect(() => validateEventPayload("run.created", {
      goal,
      workspace: "/workspace",
      policy: {
        ...withoutStepLimit,
        maxMainStepsPerActivation: 8,
        auxiliaryMode: "reflection",
        tetoAdviceDelivery: "shadow",
      },
    })).not.toThrow();
    expect(() => validateEventPayload("run.created", {
      goal,
      workspace: "/workspace",
      policy: {
        ...withoutStepLimit,
        maxMainStepsPerActivation: 8,
        auxiliaryMode: "worker",
      },
    })).toThrow(/auxiliaryMode/);
    expect(() => validateEventPayload("run.created", {
      goal,
      workspace: "/workspace",
      policy: {
        ...withoutStepLimit,
        maxMainStepsPerActivation: 8,
        tetoAdviceDelivery: "hidden",
      },
    })).toThrow(/tetoAdviceDelivery/);
  });

  it("accepts legacy user messages without Turn metadata", () => {
    expect(() => validateEventPayload("user.message", { messageRef: artifact })).not.toThrow();
  });

  it("rejects a malformed payload with a valid content hash during replay", async () => {
    const memory = new MemoryLedger({ createEventId: () => "event-1" });
    await memory.append({
      runId: "run-1",
      laneId: "main",
      type: "lane.status",
      payload: { status: "running" },
      correlationId: "correlation-1",
      idempotencyKey: "lane-status",
      occurredAt: "2026-08-26T00:00:00.000Z",
    });
    const event = (await memory.read())[0]!;
    const { contentHash: _contentHash, ...content } = event;
    const malformedContent = { ...content, payload: { status: "teleporting" } };
    const malformed = {
      ...malformedContent,
      contentHash: computeEventContentHash(malformedContent as Omit<AnyEvent, "contentHash">),
    };

    const directory = await mkdtemp(join(tmpdir(), "nausicaa-validation-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "events.jsonl");
    await writeFile(path, `${JSON.stringify(malformed)}\n`);

    await expect(JsonlLedger.open(path)).rejects.toThrow(/payload\(lane.status\).status/);
  });

  it("requires an A2A message to belong to the event run", async () => {
    const ledger = new MemoryLedger();
    await expect(ledger.append({
      runId: "other-run",
      laneId: "teto",
      type: "message.sent",
      payload: { message },
      correlationId: "correlation-1",
      idempotencyKey: "wrong-run-message",
    })).rejects.toThrow(/equal to the event runId/);
  });

  it("requires matching envelope and payload Turn identifiers", async () => {
    const ledger = new MemoryLedger();
    await expect(ledger.append({
      runId: "run-1",
      laneId: "main",
      type: "turn.started",
      payload: { turnId: "turn-1", inputId: "input-1", ordinal: 1 },
      correlationId: "correlation-1",
      idempotencyKey: "turn-started",
    })).rejects.toThrow(/requires an event turnId/);
    await expect(ledger.append({
      runId: "run-1",
      turnId: "turn-2",
      laneId: "main",
      type: "turn.started",
      payload: { turnId: "turn-1", inputId: "input-1", ordinal: 1 },
      correlationId: "correlation-1",
      idempotencyKey: "turn-started-mismatch",
    })).rejects.toThrow(/must equal the event turnId/);
  });

  it("allows run-scoped model cancellation and preserves interactive Turn identity", async () => {
    const ledger = new MemoryLedger();

    const runScoped = await ledger.append({
      runId: "run-1",
      laneId: "main",
      type: "model.cancelled",
      payload: { requestId: "request-1", reason: "timeout" },
      correlationId: "correlation-1",
      idempotencyKey: "run-model-cancelled",
    });
    expect(runScoped.type).toBe("model.cancelled");
    expect(runScoped.turnId).toBeUndefined();

    const interactive = await ledger.append({
      runId: "run-1",
      turnId: "turn-1",
      laneId: "main",
      type: "model.cancelled",
      payload: { requestId: "request-2", reason: "user" },
      correlationId: "correlation-1",
      idempotencyKey: "turn-model-cancelled",
    });
    expect(interactive.type).toBe("model.cancelled");
    expect(interactive.turnId).toBe("turn-1");
  });
});
