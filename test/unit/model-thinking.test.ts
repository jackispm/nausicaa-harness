import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  getSupportedThinkingLevels,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import type { ModelRequest, ThinkingLevel } from "../../src/domain/index.js";
import { PiAiModelPort, prepareModelPort } from "../../src/model/index.js";

const request: ModelRequest = {
  runId: "thinking-run",
  laneId: "main",
  sessionId: "thinking-session",
  model: "demo:reasoning",
  systemPrompt: "system",
  messages: [],
  tools: [],
  maxOutputTokens: 128,
};

describe("Pi thinking-level transport", () => {
  it("reads supported levels from Pi model metadata, including explicit unsupported mappings", () => {
    const faux = fauxProvider({
      provider: "demo",
      models: [
        { id: "reasoning", reasoning: true },
        { id: "plain", reasoning: false },
      ],
    });
    faux.getModel("reasoning")!.thinkingLevelMap = { off: null, minimal: null, xhigh: "xhigh", max: null };
    const models = createModels();
    models.setProvider(faux.provider);
    const adapter = new PiAiModelPort({ models });
    expect(adapter.capabilities("demo:reasoning").thinkingLevels)
      .toEqual(getSupportedThinkingLevels(faux.getModel("reasoning")!));
    expect(adapter.capabilities("demo:reasoning").thinkingLevels).toEqual(["low", "medium", "high", "xhigh"]);
    expect(adapter.capabilities("demo:plain").thinkingLevels).toEqual(["off"]);
  });

  it.each(["complete", "stream"] as const)("forwards every explicit strength through %s", async (method) => {
    const faux = fauxProvider({ provider: "demo", models: [{ id: "reasoning", reasoning: true }] });
    const observed: Array<SimpleStreamOptions | undefined> = [];
    const levels: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max", "off"];
    faux.setResponses([...levels, undefined].map(() => (_context, options) => {
      observed.push(options);
      return fauxAssistantMessage("done");
    }));
    const models = createModels();
    models.setProvider(faux.provider);
    const adapter = new PiAiModelPort({ models });
    for (const level of [...levels, undefined]) {
      const current = { ...request, ...(level === undefined ? {} : { thinkingLevel: level }) };
      if (method === "complete") await adapter.complete(current);
      else for await (const _event of adapter.stream(current)) { /* Consume the provider stream. */ }
    }
    expect(observed.map((options) => options?.reasoning))
      .toEqual(["minimal", "low", "medium", "high", "xhigh", "max", undefined, undefined]);
    expect(observed.every((options) => options?.maxTokens === request.maxOutputTokens)).toBe(true);
  });

  it("keeps a prepared request pinned when the caller edits its next thinking preference", async () => {
    const observed: Array<ThinkingLevel | undefined> = [];
    const preparedModel = prepareModelPort({
      complete: async (input) => {
        observed.push(input.thinkingLevel);
        return { content: "done", toolCalls: [], stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      },
    });
    const mutable: ModelRequest = { ...request, thinkingLevel: "low" };
    const call = preparedModel.prepare(mutable);
    mutable.thinkingLevel = "high";
    await call.complete();
    expect(call.request.thinkingLevel).toBe("low");
    expect(observed).toEqual(["low"]);
    expect(Object.isFrozen(call.request)).toBe(true);
  });
});
