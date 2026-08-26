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
    usage: { input: 120, output: 40, cacheRead: 50, cacheWrite: 0 },
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
      action: "advise",
      kind: "method-alternative",
      claim: "The lockfile is a stronger signal than prose.",
      risk: "low",
      suggestedAction: "Use the package manager named by the lockfile.",
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
      maxOutputTokens: 64,
    });
    expect(model.requests[0]?.messages).toHaveLength(1);
    expect(model.requests[0]?.messages[0]?.content).toBe(JSON.stringify(frame));
    expect(result.advice).toMatchObject({
      adviceId: "advice-1",
      sourceLane: "teto",
      kind: "method-alternative",
      confidence: 0.7,
      evidenceRefs: ["b5"],
      urgency: "next-turn",
      expiresAt: "2026-08-25T12:10:00.000Z",
      dedupeKey: expect.stringMatching(/^[0-9a-f]{24}$/),
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
    expect(result.usage.output).toBe(40);
  });

  it("accepts one fenced object but rejects malformed or expanded output", async () => {
    const model = new ScriptedModel(response(
      '```json\n{"action":"silent"}\n```',
    ));

    await expect(navigator(model).observe({
      runId: "run-1",
      sessionId: "teto-session",
      frame,
    })).resolves.satisfy((result: { advice?: unknown }) => result.advice === undefined);
    expect(model.requests).toHaveLength(1);

    const wrapped = new ScriptedModel(response(
      "I checked the boundary.\n{\"action\":\"silent\"}\nDone.",
    ));
    await expect(navigator(wrapped).observe({
      runId: "run-1",
      sessionId: "teto-session",
      frame,
    })).resolves.satisfy((result: { advice?: unknown }) => result.advice === undefined);

    const malformed = new ScriptedModel(response("not JSON"));
    await expect(navigator(malformed).observe({
      runId: "run-1",
      sessionId: "teto-session",
      frame,
    })).rejects.toBeInstanceOf(TetoOutputError);

    const expanded = new ScriptedModel(response(
      '{"action":"silent"}\n{"action":"silent"}',
    ));
    await expect(navigator(expanded).observe({
      runId: "run-1",
      sessionId: "teto-session",
      frame,
    })).rejects.toBeInstanceOf(TetoOutputError);
  });

  it("rejects unknown fields instead of accepting model-owned metadata", async () => {
    const model = new ScriptedModel(response(JSON.stringify({
      action: "advise",
      kind: "orientation",
      claim: "Return to the task",
      risk: "medium",
      suggestedAction: "Read package.json",
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
    overBudget.usage.output = 65;
    overBudget.toolCalls = [{ id: "call-1", name: "bash", arguments: {} }];
    const model = new ScriptedModel(overBudget);

    await expect(navigator(model).observe({
      runId: "run-1",
      sessionId: "teto-session",
      frame,
    })).rejects.toThrow(/must not request tools/);
  });
});
