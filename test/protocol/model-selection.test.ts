import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentTool, ModelResponse } from "../../src/domain/index.js";
import { JsonlLedger, projectRun } from "../../src/ledger/index.js";
import { ScriptedModel, type ScriptedModelStep } from "../../src/model/index.js";
import { SessionController } from "../../src/runtime/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => (
    rm(root, { recursive: true, force: true })
  )));
});

describe("Session Main model selection", () => {
  it("switches at the next request boundary without rewriting an in-flight request", async () => {
    const root = await temporaryRoot();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let releaseFirst: ((response: ModelResponse) => void) | undefined;
    const model = new CapabilityScriptedModel([
      async () => {
        markStarted?.();
        return new Promise<ModelResponse>((resolve) => { releaseFirst = resolve; });
      },
      response("finished"),
    ]);
    const session = await openSession(root, model, "busy-model-run", [noopTool]);

    await session.submit({ inputId: "input-1", text: "Inspect then answer" });
    await started;
    expect(model.requests[0]?.model).toBe("openrouter:initial");

    const selected = await session.selectModel("openrouter:next");
    expect(selected).toMatchObject({
      changed: true,
      previousModel: "openrouter:initial",
      model: "openrouter:next",
      activeRequestUnaffected: true,
    });
    expect(model.requests[0]?.model).toBe("openrouter:initial");

    releaseFirst?.({
      ...response("using a tool"),
      toolCalls: [{ id: "noop-1", name: "noop", arguments: {} }],
      stopReason: "toolUse",
    });
    await session.waitForIdle();

    expect(model.requests.map((request) => request.model)).toEqual([
      "openrouter:initial",
      "openrouter:next",
    ]);
    await session.close();
  });

  it("updates capabilities immediately, validates selectors, and leaves auxiliary models fixed", async () => {
    const root = await temporaryRoot();
    const model = new CapabilityScriptedModel([]);
    const session = await openSession(root, model, "capability-model-run");

    expect(session.modelCapabilities()).toEqual({ imageInput: "unsupported" });
    await expect(session.selectModel("openrouter:vision")).resolves.toMatchObject({
      changed: true,
      activeRequestUnaffected: false,
    });
    expect(session.snapshot().model).toBe("openrouter:vision");
    expect(session.modelCapabilities()).toEqual({ imageInput: "supported" });
    expect(session.tetoModel).toBe("openrouter:teto-fixed");
    expect(session.workerModel).toBe("openrouter:worker-fixed");

    await expect(session.selectModel("openrouter:bad selector"))
      .rejects.toThrow(/selector/i);
    await expect(session.selectModel(":missing-provider"))
      .rejects.toThrow(/selector/i);
    expect(session.snapshot().model).toBe("openrouter:vision");
    await session.close();
  });

  it("restores the latest Run selection after the process opens the Run again", async () => {
    const root = await temporaryRoot();
    const firstModel = new CapabilityScriptedModel([response("first")]);
    const first = await openSession(root, firstModel, "durable-model-run");
    await first.submit({ inputId: "input-1", text: "First turn" });
    await first.waitForIdle();
    await first.selectModel("openrouter:vision");
    await first.close();

    const ledgerPath = join(root, "state", "runs", "durable-model-run", "ledger.jsonl");
    const ledger = await JsonlLedger.open(ledgerPath);
    const events = await ledger.read({ runId: "durable-model-run" });
    expect(projectRun(events, "durable-model-run").lanes.main?.model)
      .toBe("openrouter:vision");
    await ledger.close();

    const restartedModel = new CapabilityScriptedModel([response("second")]);
    const restarted = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "openrouter:process-default",
      tetoModel: "openrouter:teto-fixed",
      workerModel: "openrouter:worker-fixed",
      runId: "durable-model-run",
      policy: { maxMainStepsPerActivation: 4, tetoEnabled: false },
    }, {
      mainModel: restartedModel,
      tools: [noopTool],
    });

    expect(restarted.snapshot().model).toBe("openrouter:vision");
    expect(restarted.modelCapabilities()).toEqual({ imageInput: "supported" });
    expect(restarted.tetoModel).toBe("openrouter:teto-fixed");
    expect(restarted.workerModel).toBe("openrouter:worker-fixed");
    await restarted.submit({ inputId: "input-2", text: "Second turn" });
    await restarted.waitForIdle();
    expect(restartedModel.requests[0]?.model).toBe("openrouter:vision");
    await restarted.close();
  });
});

class CapabilityScriptedModel extends ScriptedModel {
  constructor(steps: readonly ScriptedModelStep[]) {
    super(steps);
  }

  capabilities(model: string): { imageInput: boolean } {
    return { imageInput: model.endsWith(":vision") };
  }
}

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

async function openSession(
  root: string,
  model: CapabilityScriptedModel,
  runId: string,
  tools: readonly AgentTool[] = [],
): Promise<SessionController> {
  return SessionController.open({
    workspace: root,
    dataDir: join(root, "state"),
    model: "openrouter:initial",
    tetoModel: "openrouter:teto-fixed",
    workerModel: "openrouter:worker-fixed",
    policy: {
      maxMainStepsPerActivation: 4,
      maxModelTokens: 10_000,
      tetoEnabled: false,
    },
  }, {
    mainModel: model,
    tools,
    createRunId: () => runId,
  });
}

function response(content: string): ModelResponse {
  return {
    content,
    toolCalls: [],
    stopReason: "stop",
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nausicaa-model-selection-"));
  roots.push(root);
  return root;
}
