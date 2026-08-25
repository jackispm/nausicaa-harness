import { describe, expect, it } from "vitest";

import type {
  ModelPort,
  ModelRequest,
  ModelResponse,
  ObservationFrame,
} from "../../src/domain/index.js";
import {
  IntentNavigator,
  TetoOutputError,
} from "../../src/teto/index.js";

class ScriptedModel implements ModelPort {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly response: ModelResponse) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return this.response;
  }
}

const frame: ObservationFrame = {
  mission: {
    goalVersion: 1,
    goal: "Document installation",
    successCriteria: ["Give the correct command"],
    hardConstraints: ["Read only"],
  },
  mainDelta: {
    boundaryId: "b5",
    triggerKind: "normal",
    activeObjective: "Read the package metadata",
    actionOrDecision: "Open package.json",
    expectedOutcome: "Identify the package manager",
    outcome: "pnpm lockfile found",
    status: "progress",
    uncertainties: [],
    openQuestions: [],
  },
  budget: {
    maxOutputTokens: 200,
    deadline: "2026-08-25T12:05:00.000Z",
  },
  truncated: false,
};

function response(content: string): ModelResponse {
  return {
    content,
    toolCalls: [],
    stopReason: "stop",
    usage: { input: 120, output: 80, cacheRead: 50, cacheWrite: 0 },
  };
}

function navigator(model: ScriptedModel): IntentNavigator {
  return new IntentNavigator({
    modelPort: model,
    model: "scripted",
    laneId: "teto",
    clock: { now: () => new Date("2026-08-25T12:00:00.000Z") },
    createAdviceId: () => "advice-1",
  });
}

describe("IntentNavigator", () => {
  it("uses exactly one model pass with no tools and only the ObservationFrame", async () => {
    const model = new ScriptedModel(response(JSON.stringify({
      kind: "method-alternative",
      claim: "The lockfile is a stronger signal than prose.",
      evidenceRefs: ["boundary:b5"],
      confidence: 0.9,
      risk: "low",
      suggestedAction: "Use the package manager named by the lockfile.",
      urgency: "next-step",
      expiresAt: "2026-08-25T12:04:00.000Z",
      dedupeKey: "install-lockfile",
    })));

    const result = await navigator(model).observe({
      runId: "run-1",
      sessionId: "teto-session",
      frame,
    });

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]).toMatchObject({
      laneId: "teto",
      tools: [],
      maxOutputTokens: 200,
    });
    expect(model.requests[0]?.messages).toHaveLength(1);
    expect(model.requests[0]?.messages[0]?.content).toBe(JSON.stringify(frame));
    expect(result.advice).toMatchObject({
      adviceId: "advice-1",
      sourceLane: "teto",
      kind: "method-alternative",
    });
  });

  it("permits a strict silent pass without creating Advice", async () => {
    const model = new ScriptedModel(response('{"action":"silent"}'));

    const result = await navigator(model).observe({
      runId: "run-1",
      sessionId: "teto-session",
      frame,
    });

    expect(model.requests).toHaveLength(1);
    expect(result.advice).toBeUndefined();
    expect(result.usage.output).toBe(80);
  });

  it("rejects malformed, fenced, or expanded output without retrying", async () => {
    const model = new ScriptedModel(response(
      '```json\n{"action":"silent"}\n```',
    ));

    await expect(navigator(model).observe({
      runId: "run-1",
      sessionId: "teto-session",
      frame,
    })).rejects.toBeInstanceOf(TetoOutputError);
    expect(model.requests).toHaveLength(1);
  });

  it("rejects unknown fields and non-future Advice", async () => {
    const model = new ScriptedModel(response(JSON.stringify({
      kind: "orientation",
      claim: "Return to the task",
      evidenceRefs: [],
      confidence: 0.7,
      risk: "medium",
      suggestedAction: "Read package.json",
      urgency: "next-step",
      expiresAt: "2026-08-25T11:59:00.000Z",
      dedupeKey: "course",
      explanation: "not allowed",
    })));

    await expect(navigator(model).observe({
      runId: "run-1",
      sessionId: "teto-session",
      frame,
    })).rejects.toThrow(/missing or unknown fields/);
  });

  it("rejects tool calls and provider output beyond the token gate", async () => {
    const overBudget = response('{"action":"silent"}');
    overBudget.usage.output = 201;
    overBudget.toolCalls = [{ id: "call-1", name: "bash", arguments: {} }];
    const model = new ScriptedModel(overBudget);

    await expect(navigator(model).observe({
      runId: "run-1",
      sessionId: "teto-session",
      frame,
    })).rejects.toThrow(/must not request tools/);
  });
});
