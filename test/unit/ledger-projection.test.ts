import { describe, expect, it } from "vitest";

import type { AppendEvent, EventType } from "../../src/domain/events.js";
import type { A2AMessage, ArtifactRef, Goal, RunPolicy } from "../../src/domain/types.js";
import {
  legacyTurnIdForRun,
  MemoryLedger,
  projectRun,
} from "../../src/ledger/index.js";

const goal: Goal = {
  version: 1,
  statement: "Install the project",
  successCriteria: ["document verified commands"],
  hardConstraints: ["do not modify the target"],
};

const policy: RunPolicy = {
  maxMainSteps: 20,
  maxModelTokens: 10_000,
  tetoEnabled: true,
  tetoMaxOutputTokens: 200,
  tetoTokenRatio: 0.1,
};

function artifact(id: string): ArtifactRef {
  return {
    id,
    contentHash: `sha256:${id.padEnd(64, "0")}`,
    mediaType: "text/plain",
    byteLength: id.length,
  };
}

function command<K extends EventType>(
  type: K,
  payload: AppendEvent<K>["payload"],
  laneId = "main",
): AppendEvent<K> {
  return {
    runId: "run-1",
    laneId,
    type,
    payload,
    correlationId: "correlation-1",
    idempotencyKey: `${type}-${laneId}-${JSON.stringify(payload)}`,
  };
}

describe("projectRun", () => {
  it("deterministically rebuilds run, goal, lanes, inbox, budget, and conversation", async () => {
    const ledger = new MemoryLedger();
    const message: A2AMessage = {
      messageId: "message-1",
      runId: "run-1",
      conversationId: "conversation-1",
      threadId: "thread-1",
      from: "teto",
      to: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
      correlationId: "correlation-1",
      idempotencyKey: "advice-message-1",
      visibility: "run",
      priority: 1,
      delivery: "next-step",
      payload: {
        type: "advice.propose",
        advice: {
          adviceId: "advice-1",
          kind: "intent-gap",
          claim: "The README may omit a system prerequisite",
          evidenceRefs: [],
          confidence: 0.8,
          risk: "medium",
          suggestedAction: "Check the package engines field",
          urgency: "next-step",
          expiresAt: "2026-01-02T00:00:00.000Z",
          dedupeKey: "engines-prerequisite",
          sourceLane: "teto",
        },
      },
    };

    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    await ledger.append(command("lane.registered", { kind: "main" }));
    await ledger.append(command("lane.status", { status: "running" }));
    await ledger.append(command("lane.registered", { kind: "intent-navigator" }, "teto"));
    await ledger.append(command("user.message", { messageRef: artifact("user") }));
    await ledger.append(command("assistant.message", { messageRef: artifact("assistant") }));
    await ledger.append(command("tool.succeeded", {
      operationId: "operation-1",
      toolCallId: "tool-call-1",
      name: "read",
      resultRef: artifact("tool"),
    }));
    await ledger.append(command("message.sent", { message }, "teto"));
    await ledger.append(command("message.claimed", {
      messageId: "message-1",
      claimedBy: "main",
    }));
    await ledger.append(command("advice.acknowledged", {
      adviceId: "advice-1",
      disposition: "accept",
      reason: "Relevant to installation",
    }));
    await ledger.append(command("message.handled", { messageId: "message-1" }));
    await ledger.append(command("budget.charged", {
      laneId: "main",
      usage: { input: 100, output: 20, cacheRead: 40, cacheWrite: 10, costUsd: 0.01 },
    }));
    await ledger.append(command("budget.charged", {
      laneId: "teto",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    }, "teto"));
    await ledger.append(command("goal.revised", {
      goal: { ...goal, version: 2, hardConstraints: [...goal.hardConstraints, "stay offline"] },
    }));
    await ledger.append(command("checkpoint.committed", {
      watermark: 13,
      checksum: "checkpoint-checksum",
    }));
    await ledger.append(command("run.completed", { answerRef: artifact("answer") }));

    const events = await ledger.read();
    const projection = projectRun(events, "run-1");

    expect(projection.run).toMatchObject({
      status: "completed",
      workspace: "/workspace",
      policy,
      answerRef: artifact("answer"),
      checkpoint: { watermark: 13, checksum: "checkpoint-checksum" },
    });
    expect(projection.goal).toMatchObject({ version: 2 });
    expect(projection.lanes.main).toMatchObject({
      kind: "main",
      status: "running",
    });
    expect(projection.lanes.teto).toMatchObject({
      kind: "intent-navigator",
      status: "ready",
    });
    expect(projection.conversation.map((item) => item.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(projection.conversation.map((item) => item.artifact.id)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(projection.conversation.every((item) => (
      item.turnId === legacyTurnIdForRun("run-1")
    ))).toBe(true);
    expect(projection.turns[legacyTurnIdForRun("run-1")]).toMatchObject({
      status: "completed",
      legacy: true,
      answerRef: artifact("answer"),
    });
    expect(projection.activeTurnId).toBeUndefined();
    expect(projection.inbox).toHaveLength(1);
    expect(projection.inbox[0]).toMatchObject({
      status: "handled",
      claimedBy: "main",
      adviceDisposition: "accept",
      adviceReason: "Relevant to installation",
    });
    expect(projection.budget).toEqual({
      maxModelTokens: 10_000,
      charged: { input: 110, output: 25, cacheRead: 40, cacheWrite: 10, costUsd: 0.01 },
      byLane: {
        main: { input: 100, output: 20, cacheRead: 40, cacheWrite: 10, costUsd: 0.01 },
        teto: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      },
    });
    expect(projectRun(events.slice().reverse(), "run-1")).toEqual(projection);
  });

  it("returns an explicit empty view for an unknown run", () => {
    const projection = projectRun([], "missing-run");
    expect(projection).toMatchObject({
      run: { runId: "missing-run", status: "not-started", lastOffset: 0 },
      goal: undefined,
      inbox: [],
      budget: {
        charged: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      conversation: [],
      inputs: [],
      unknownOperations: [],
    });
    expect(Object.keys(projection.lanes)).toEqual([]);
    expect(Object.keys(projection.budget.byLane)).toEqual([]);
  });

  it("attributes an unfinished legacy one-shot execution to a stable active Turn", async () => {
    const ledger = new MemoryLedger();
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    await ledger.append(command("user.message", { messageRef: artifact("legacy-input") }));
    await ledger.append(command("step.started", { step: 1 }));

    const projection = projectRun(await ledger.read(), "run-1");
    const legacyTurnId = legacyTurnIdForRun("run-1");
    expect(projection.activeTurnId).toBe(legacyTurnId);
    expect(projection.turns[legacyTurnId]).toMatchObject({
      turnId: legacyTurnId,
      status: "active",
      legacy: true,
      lastCommittedStep: 0,
    });
  });

  it("rebuilds pending input, Turn lifecycle, and unresolved operation state", async () => {
    const ledger = new MemoryLedger();
    await ledger.append(command("run.created", { goal, workspace: "/workspace", policy }));
    await ledger.append(command("input.admitted", {
      inputId: "input-1",
      messageRef: artifact("input-1"),
      delivery: "new-turn",
      sequence: 1,
    }));
    await ledger.append({
      ...command("turn.started", { turnId: "turn-1", inputId: "input-1", ordinal: 1 }),
      turnId: "turn-1",
    });
    await ledger.append({
      ...command("input.delivered", {
        inputId: "input-1",
        turnId: "turn-1",
        boundary: "turn-start",
      }),
      turnId: "turn-1",
    });
    await ledger.append({
      ...command("user.message", {
        inputId: "input-1",
        messageRef: artifact("input-1"),
        kind: "initial",
      }),
      turnId: "turn-1",
    });
    await ledger.append({
      ...command("step.completed", { step: 3, hasToolCalls: true }),
      turnId: "turn-1",
    });
    await ledger.append({
      ...command("tool.unknown", {
        operationId: "operation-1",
        toolCallId: "call-1",
        name: "write",
        reason: "process-interrupted",
      }),
      turnId: "turn-1",
    });
    await ledger.append({
      ...command("turn.waiting", {
        turnId: "turn-1",
        reason: "operation-unknown",
        lastCommittedStep: 3,
        resumeRequires: "operation-resolution",
      }),
      turnId: "turn-1",
    });
    await ledger.append(command("input.admitted", {
      inputId: "input-2",
      messageRef: artifact("input-2"),
      delivery: "follow-up",
      sequence: 2,
    }));

    const blocked = projectRun(await ledger.read(), "run-1");
    expect(blocked.activeTurnId).toBeUndefined();
    expect(blocked.inputs).toMatchObject([
      { inputId: "input-1", status: "delivered", turnId: "turn-1", sequence: 1 },
      { inputId: "input-2", status: "pending", sequence: 2 },
    ]);
    expect(blocked.turns["turn-1"]).toMatchObject({
      status: "waiting",
      lastCommittedStep: 3,
      resumeRequires: "operation-resolution",
    });
    expect(blocked.unknownOperations).toMatchObject([{
      operationId: "operation-1",
      turnId: "turn-1",
    }]);

    await ledger.append({
      ...command("tool.failed", {
        operationId: "operation-1",
        toolCallId: "call-1",
        name: "write",
        error: "operator marked the outcome failed",
        resultRef: artifact("operation-failed"),
        resolution: "operator",
      }),
      turnId: "turn-1",
    });
    await ledger.append({
      ...command("turn.resumed", { turnId: "turn-1", fromStep: 3, stepAllowance: 8 }),
      turnId: "turn-1",
    });
    await ledger.append({
      ...command("turn.completed", { turnId: "turn-1", answerRef: artifact("answer-1") }),
      turnId: "turn-1",
    });

    const completed = projectRun(await ledger.read(), "run-1");
    expect(completed.activeTurnId).toBeUndefined();
    expect(completed.unknownOperations).toEqual([]);
    expect(completed.turns["turn-1"]).toMatchObject({
      status: "completed",
      lastCommittedStep: 3,
      stepAllowance: 8,
      answerRef: artifact("answer-1"),
    });
  });

  it("treats lane identifiers as data instead of object prototypes", async () => {
    const ledger = new MemoryLedger();
    await ledger.append({
      runId: "prototype-run",
      laneId: "__proto__",
      type: "lane.registered",
      payload: { kind: "main" },
      correlationId: "correlation",
      idempotencyKey: "lane",
    });
    await ledger.append({
      runId: "prototype-run",
      laneId: "__proto__",
      type: "budget.charged",
      payload: {
        laneId: "__proto__",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
      correlationId: "correlation",
      idempotencyKey: "budget",
    });

    const projection = projectRun(await ledger.read(), "prototype-run");
    expect(Object.hasOwn(projection.lanes, "__proto__")).toBe(true);
    expect(projection.lanes["__proto__"]?.kind).toBe("main");
    expect(Object.hasOwn(projection.budget.byLane, "__proto__")).toBe(true);
    expect(({} as { kind?: string }).kind).toBeUndefined();
  });
});
