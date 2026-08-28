import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AnyEvent,
  ModelPort,
  ModelRequest,
  ModelResponse,
} from "../../src/domain/index.js";
import { stableJson } from "../../src/ledger/hash.js";
import {
  SessionController,
  type SessionRuntimeEvent,
} from "../../src/runtime/index.js";

const roots: string[] = [];
const LONG_HISTORY = "historical evidence ".repeat(500);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

describe("Fukai compaction offline benefit gate", () => {
  it("reduces the admitted Main context without changing Main request count", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nausicaa-fukai-gate-"));
    roots.push(workspace);
    const [control, treatment] = await Promise.all([
      runArm(workspace, false),
      runArm(workspace, true),
    ]);

    expect(control.mainRequests).toBe(4);
    expect(treatment.mainRequests).toBe(control.mainRequests);
    expect(control.compactionRequests).toBe(0);
    expect(control.events.some((event) => event.type === "fukai.compaction.pressure"))
      .toBe(false);
    expect(treatment.compactionRequests).toBe(1);

    const treatmentPressures = treatment.events.filter((event): event is Extract<
      AnyEvent,
      { type: "fukai.compaction.pressure" }
    > => event.type === "fukai.compaction.pressure");
    const compactDecision = treatment.events.find((event): event is Extract<
      AnyEvent,
      { type: "fukai.compaction.pressure" }
    > => event.type === "fukai.compaction.pressure" && event.payload.decision === "compact");
    const completed = treatment.events.find((event): event is Extract<
      AnyEvent,
      { type: "fukai.compaction.completed" }
    > => event.type === "fukai.compaction.completed");
    expect(compactDecision).toBeDefined();
    expect(
      completed,
      treatment.events.map((event) => event.type).join(","),
    ).toBeDefined();

    const treatmentMainRequests = treatment.events.filter((event): event is Extract<
      AnyEvent,
      { type: "model.requested" }
    > => event.type === "model.requested" && event.laneId === "main");
    const controlMainRequests = control.events.filter((event): event is Extract<
      AnyEvent,
      { type: "model.requested" }
    > => event.type === "model.requested" && event.laneId === "main");
    const triggerIndex = treatmentPressures.indexOf(compactDecision!);
    const compactedRequest = treatmentMainRequests[triggerIndex];
    expect(compactedRequest?.payload.contextManifest?.slots.compaction.status).toBe("ready");

    const beforeTokens = compactDecision!.payload.currentTokens;
    const afterTokens = compactedRequest!.payload.estimatedInputTokens!;
    const controlTokens = controlMainRequests[triggerIndex]!.payload.estimatedInputTokens!;
    const actualSummaryTokens = completed!.payload.estimatedTokens;
    const actualNetGain = compactDecision!.payload.selectedRawTokens - actualSummaryTokens;
    const summaryUsage = completed!.payload.usage!;
    const summaryCostTokens = summaryUsage.input
      + summaryUsage.output
      + summaryUsage.cacheRead
      + summaryUsage.cacheWrite;
    const tokenDeltas = controlMainRequests.slice(triggerIndex).map((event, index) => (
      event.payload.estimatedInputTokens!
      - treatmentMainRequests[triggerIndex + index]!.payload.estimatedInputTokens!
    ));
    const byteDeltas = control.mainRequestBytes.slice(triggerIndex).map((bytes, index) => (
      bytes - treatment.mainRequestBytes[triggerIndex + index]!
    ));
    expect(beforeTokens).toBe(controlTokens);
    expect(afterTokens).toBeLessThan(beforeTokens);
    expect(actualNetGain).toBeGreaterThan(0);
    expect(actualNetGain).toBeGreaterThanOrEqual(
      compactDecision!.payload.predictedGainTokens,
    );
    expect(tokenDeltas.every((delta) => delta > 0)).toBe(true);
    expect(byteDeltas.every((delta) => delta > 0)).toBe(true);
    expect(tokenDeltas.reduce((total, delta) => total + delta, 0))
      .toBeGreaterThan(summaryCostTokens);
    expect(byteDeltas.reduce((total, delta) => total + delta, 0)).toBeGreaterThan(0);
    expect(control.finalText).toBe("done");
    expect(treatment.finalText).toBe(control.finalText);
    const readySelections = treatmentMainRequests.slice(triggerIndex).map(
      (event) => event.payload.contextManifest?.slots.compaction,
    );
    expect(readySelections.every((selection) => selection?.status === "ready")).toBe(true);
    expect(new Set(readySelections.map((selection) => selection?.compactionId)).size).toBe(1);
    expect(treatment.events.filter((event) => event.type === "fukai.compaction.failed"))
      .toHaveLength(0);
    expect(treatment.events.filter((event) => event.type === "fukai.compaction.fallback"))
      .toHaveLength(0);
  });
});

interface ArmResult {
  mainRequests: number;
  compactionRequests: number;
  mainRequestBytes: number[];
  finalText: string;
  events: AnyEvent[];
}

async function runArm(workspace: string, enabled: boolean): Promise<ArmResult> {
  const model = new GateModel();
  const observed: SessionRuntimeEvent[] = [];
  const session = await SessionController.open({
    workspace,
    dataDir: join(workspace, enabled ? "treatment-state" : "control-state"),
    model: "gate-model",
    ...(enabled
      ? {
          fukaiCompaction: {
            enabled: true,
            provider: "pi-ai" as const,
            maxInputTokens: 20_000,
            maxOutputTokens: 1_000,
            maxWallClockMs: 5_000,
            thresholdRatio: 0.8,
            retainRatio: 0.16,
            minimumGainTokens: 1,
          },
        }
      : {}),
    policy: {
      maxMainStepsPerActivation: 1,
      maxModelTokens: 200_000,
      tetoEnabled: false,
    },
  }, {
    mainModel: model,
    clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    createRunId: () => `fukai-gate-arm-${enabled ? "a" : "b"}`,
  });
  session.subscribe((event) => observed.push(event));

  for (const [index, text] of [
    "Collect evidence",
    "Continue",
    "Checkpoint",
    "Conclude",
  ].entries()) {
    await session.submit({ inputId: `input-${index + 1}`, text });
    await session.waitForIdle();
  }
  await session.close();

  return {
    mainRequests: model.mainRequests,
    compactionRequests: model.compactionRequests,
    mainRequestBytes: model.mainRequestBytes,
    finalText: model.finalText,
    events: observed.flatMap((event) => event.kind === "event" ? [event.event] : []),
  };
}

class GateModel implements ModelPort {
  mainRequests = 0;
  compactionRequests = 0;
  mainRequestBytes: number[] = [];
  finalText = "";

  capabilities() {
    return { imageInput: false, contextWindowTokens: 2_000 } as const;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.sessionId.startsWith("fukai-compaction:")) {
      this.compactionRequests += 1;
      const content = JSON.stringify({
        decisions: ["Preserve only verified historical evidence"],
        verifiedResults: ["The earlier collection step completed"],
        openQuestions: [],
      });
      const inputTokens = Math.ceil(Buffer.byteLength(
        `${request.systemPrompt}\n${request.messages[0]?.content ?? ""}`,
        "utf8",
      ) / 4);
      return response(
        content,
        inputTokens,
        Math.ceil(Buffer.byteLength(content, "utf8") / 4),
      );
    }
    this.mainRequests += 1;
    this.mainRequestBytes.push(Buffer.byteLength(stableJson({
      systemPrompt: request.systemPrompt,
      messages: request.messages,
      tools: request.tools,
    }), "utf8"));
    const content = this.mainRequests <= 2
      ? LONG_HISTORY
      : this.mainRequests === 3
        ? "checkpoint preserved"
        : request.messages.some((message) => (
            this.compactionRequests > 0
              ? message.content.includes("Historical compaction capsule")
              : message.content.includes(LONG_HISTORY)
          ))
          ? "done"
          : "context-lost";
    this.finalText = content;
    return response(content, 10, 5);
  }
}

function response(content: string, input = 10, output = 5): ModelResponse {
  return {
    content,
    toolCalls: [],
    stopReason: "stop",
    usage: { input, output, cacheRead: 0, cacheWrite: 0 },
  };
}
