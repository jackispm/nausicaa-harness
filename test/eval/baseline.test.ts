import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentTool, ModelResponse } from "../../src/domain/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import { executeRun } from "../../src/runtime/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("deterministic harness evaluation", () => {
  it("keeps Main answer stable while Teto stays sparse and bounded", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-eval-"));
    roots.push(root);
    const answer: ModelResponse = {
      content: "The package requires Node 22 and npm install.",
      toolCalls: [],
      stopReason: "stop",
      usage: { input: 1_800, output: 200, cacheRead: 200, cacheWrite: 40 },
    };
    const mainScript = (): ModelResponse[] => [
      ...Array.from({ length: 5 }, (_, index) => ({
        content: `Evidence step ${index + 1}`,
        toolCalls: [{ id: `call-${index + 1}`, name: "noop", arguments: {} }],
        stopReason: "toolUse",
        usage: { input: 1_800, output: 200, cacheRead: 200, cacheWrite: 40 },
      })),
      answer,
    ];
    const mainOnly = await executeRun({
      workspace: root,
      dataDir: join(root, "main-only"),
      model: "scripted",
      message: "Inspect installation prerequisites",
      policy: { maxMainSteps: 6, tetoEnabled: false, maxModelTokens: 50_000 },
    }, {
      mainModel: new ScriptedModel(mainScript()),
      tools: [noopTool],
      createRunId: () => "eval-main-only",
    });
    const withTeto = await executeRun({
      workspace: root,
      dataDir: join(root, "with-teto"),
      model: "scripted",
      tetoModel: "scripted-teto",
      message: "Inspect installation prerequisites",
      policy: { maxMainSteps: 6, maxModelTokens: 50_000 },
    }, {
      mainModel: new ScriptedModel(mainScript()),
      tetoModel: new ScriptedModel([{
        ...answer,
        content: '{"action":"silent"}',
        usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0 },
      }]),
      tools: [noopTool],
      createRunId: () => "eval-with-teto",
    });

    expect(withTeto.finalText).toBe(mainOnly.finalText);
    expect(withTeto.metrics.total.tetoPasses).toBe(1);
    expect(withTeto.metrics.total.usage.input).toBeGreaterThanOrEqual(mainOnly.metrics.total.usage.input);
    expect(withTeto.metrics.total.usage.input).toBeLessThan(mainOnly.metrics.total.usage.input * 2);
  });
});

const noopTool: AgentTool = {
  definition: {
    name: "noop",
    description: "Return a deterministic result",
    parameters: { type: "object", additionalProperties: false },
  },
  async execute() {
    return { content: "ok", isError: false };
  },
};
