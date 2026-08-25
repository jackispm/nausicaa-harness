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
  "run.resumed": { fromOffset: 4 },
  "run.completed": { answerRef: artifact },
  "run.failed": { error: "model failed" },
  "goal.revised": { goal: { ...goal, version: 2 } },
  "lane.registered": { kind: "main" },
  "lane.status": { status: "running", reason: "scheduled" },
  "step.started": { step: 1 },
  "step.completed": { step: 1, hasToolCalls: false },
  "step.failed": { step: 1, error: "interrupted" },
  "user.message": { messageRef: artifact },
  "assistant.message": { messageRef: artifact },
  "navigation.updated": { delta },
  "model.requested": {
    model: "model-1",
    requestHash: "request-hash",
    contextWatermark: 3,
  },
  "model.completed": {
    model: "model-1",
    responseRef: artifact,
    stopReason: "stop",
    usage: tokenUsage,
  },
  "model.failed": { model: "model-1", error: "provider failed" },
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
  },
  "message.sent": { message },
  "message.claimed": { messageId: "message-1", claimedBy: "main" },
  "message.handled": { messageId: "message-1" },
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
} satisfies EventPayloadMap;

const invalidPayloads = {
  "run.created": { goal, workspace: "/workspace" },
  "run.resumed": { fromOffset: -1 },
  "run.completed": { answerRef: null },
  "run.failed": {},
  "goal.revised": { goal: { ...goal, version: 0 } },
  "lane.registered": { kind: "worker" },
  "lane.status": { status: "unknown" },
  "step.started": { step: 0 },
  "step.completed": { step: 1, hasToolCalls: "no" },
  "step.failed": { step: 1 },
  "user.message": { messageRef: { ...artifact, byteLength: -1 } },
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
  "message.sent": { message: { ...message, priority: -1 } },
  "message.claimed": { messageId: "", claimedBy: "main" },
  "message.handled": { messageId: null },
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
} satisfies Record<EventType, unknown>;

describe("event payload validation", () => {
  it("accepts a complete payload for every event type", () => {
    for (const type of Object.keys(validPayloads) as EventType[]) {
      expect(() => validateEventPayload(type, validPayloads[type])).not.toThrow();
    }
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
});
