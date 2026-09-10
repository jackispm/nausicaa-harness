import { describe, expect, it } from "vitest";

import type { ModelResponse } from "../../src/domain/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import { TETO_FLIGHT_OBSERVATIONS } from "../fixtures/teto-flight-observations.js";
import { runTetoRestraintProbe } from "./teto-live-restraint.js";
import { TopologyLiveModel } from "./topology-live-model.js";

const response = (toolCalls: ModelResponse["toolCalls"] = []): ModelResponse => ({
  content: toolCalls.length === 0 ? "NO_UPDATE" : "",
  toolCalls, stopReason: toolCalls.length === 0 ? "stop" : "toolUse",
  usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
});

// Verify the report's grading offline; these are not provider behavior tests.
async function replay(responses: ModelResponse[]) {
  const model = new ScriptedModel(responses);
  const live = new TopologyLiveModel(model, {
    budgetUsd: 0.1, maxRequests: 10, maxOutputTokens: 1024,
    timeoutMs: 10_000, inputPrice: 0.1, outputPrice: 0.1,
  });
  const report = await runTetoRestraintProbe({
    live, modelName: "scripted", runId: "flight-report", workspace: "/workspace",
    scenario: "flight-replay", policy: {
      maxMainStepsPerActivation: 24, maxModelTokens: 100_000, tetoEnabled: true, tetoMaxOutputTokens: 1024,
    },
  });
  return { report, model };
}

describe("retrospective Teto live report", () => {
  it("grades routine silence but retains later Team advice for review", async () => {
    const { report, model } = await replay([
      response(), response(), response(),
      response([{ id: "team-advice", name: "agent_message",
        arguments: { kind: "inform", text: "Review the integration of concurrent edits to index.html." } }]),
      response(),
    ]);
    expect(model.requests).toHaveLength(5);
    expect(report.error).toBeUndefined();
    expect(Object.values(report.checks).every(Boolean)).toBe(true);
    expect(report.evidence.stages.map((stage) => stage.id)).toEqual(TETO_FLIGHT_OBSERVATIONS.map((phase) => phase.id));
    expect(report.evidence.stages[3]?.outgoingMessages).toEqual([
      expect.objectContaining({ from: "teto", to: "main", payload: {
        type: "message.inform", text: "Review the integration of concurrent edits to index.html.",
      } }),
    ]);
    expect(report.checks).not.toHaveProperty("createTeamSilent");
    expect(report.checks).not.toHaveProperty("waitForResultsSilent");
    expect(report.evidence).toMatchObject({
      ownerModelCalls: 0, systemPromptOverride: false, toolOverride: false, additionalMessageRateLimit: false,
    });
  });

  it("does not mistake a rejected progress tool call for model restraint", async () => {
    const { report } = await replay([
      response([{ id: "noisy-progress", name: "agent_message",
        arguments: { kind: "progress", text: "Acknowledged; no deviation detected." } }]),
      response(), response(), response(), response(),
    ]);
    expect(report.error).toBeUndefined();
    expect(report.checks.initialRequestObservedByRealModel).toBe(true);
    expect(report.checks.initialRequestSilent).toBe(true);
    expect(report.checks.initialRequestNoToolCalls).toBe(false);
    expect(report.checks.initialRequestNoToolFailures).toBe(false);
    expect(report.evidence.stages[0]?.outgoingMessages).toEqual([]);
    expect(report.evidence.stages[0]?.toolFailures).toHaveLength(1);
  });
});
