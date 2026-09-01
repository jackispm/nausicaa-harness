import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentTool, ModelResponse } from "../../src/domain/index.js";
import { JsonlLedger, projectRun } from "../../src/ledger/index.js";
import {
  ScriptedModel,
  UNCONFIGURED_MODEL_SELECTOR,
  type ModelCatalogEntry,
  type ScriptedModelStep,
} from "../../src/model/index.js";
import { SessionController } from "../../src/runtime/index.js";
import { FileContentAddressedStore } from "../../src/store/index.js";

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

  it("rejects unknown or contradictory local catalog choices before writing model.selected", async () => {
    const root = await temporaryRoot();
    const model = new CatalogCapabilityModel([response("attached")]);
    const modelCatalog: readonly ModelCatalogEntry[] = [
      catalogEntry("openrouter:vision", { imageInput: true }),
      catalogEntry("openrouter:contradictory", { imageInput: false }),
    ];
    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "openrouter:initial",
      policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
    }, {
      mainModel: model,
      modelCatalog,
      createRunId: () => "catalog-preflight-run",
    });
    const selectedEvents: string[] = [];
    session.subscribe((runtimeEvent) => {
      if (runtimeEvent.kind === "event" && runtimeEvent.event.type === "model.selected") {
        selectedEvents.push(runtimeEvent.event.payload.model);
      }
    });
    await session.submit({ inputId: "attach", text: "Attach the Run" });
    await session.waitForIdle();

    await expect(session.selectModel("openrouter:unknown"))
      .rejects.toThrow(/unknown local model/i);
    await expect(session.selectModel("openrouter:contradictory"))
      .rejects.toThrow(/capability metadata/i);
    expect(session.snapshot().model).toBe("openrouter:initial");

    expect(selectedEvents).toEqual([]);

    await expect(session.selectModel("openrouter:vision")).resolves.toMatchObject({
      changed: true,
      model: "openrouter:vision",
    });
    expect(selectedEvents).toEqual(["openrouter:vision"]);
    await session.close();

    const ledgerPath = join(root, "state", "runs", "catalog-preflight-run", "ledger.jsonl");
    const ledger = await JsonlLedger.open(ledgerPath);
    expect((await ledger.read()).filter((event) => event.type === "model.selected"))
      .toHaveLength(1);
    await ledger.close();
  });

  it("does not accept an unchanged current model that is absent from the local catalog", async () => {
    const root = await temporaryRoot();
    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "openrouter:stale",
      policy: { maxMainStepsPerActivation: 1, tetoEnabled: false },
    }, {
      mainModel: new ScriptedModel([]),
      modelCatalog: [catalogEntry("openrouter:known", { imageInput: false })],
    });

    await expect(session.selectModel("openrouter:stale"))
      .rejects.toThrow(/unknown local model/i);
    expect(session.snapshot().model).toBe("openrouter:stale");
    await session.close();
  });

  it("replaces only unconfigured onboarding auxiliary selectors on first selection", async () => {
    const root = await temporaryRoot();
    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: UNCONFIGURED_MODEL_SELECTOR,
      policy: { maxMainStepsPerActivation: 2, tetoEnabled: true },
    }, {
      mainModel: new ScriptedModel([]),
      modelCatalog: [catalogEntry("openrouter:vision", { imageInput: true })],
    });

    await expect(session.selectModel("openrouter:vision")).resolves.toMatchObject({
      changed: true,
      model: "openrouter:vision",
    });
    expect(session.tetoModel).toBe("openrouter:vision");
    expect(session.workerModel).toBe("openrouter:vision");
    await session.close();
  });

  it("keeps explicitly configured auxiliary selectors fixed during onboarding selection", async () => {
    const root = await temporaryRoot();
    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: UNCONFIGURED_MODEL_SELECTOR,
      tetoModel: "openrouter:fixed-teto",
      workerModel: "openrouter:fixed-worker",
      policy: { maxMainStepsPerActivation: 1, tetoEnabled: true },
    }, {
      mainModel: new ScriptedModel([]),
      modelCatalog: [catalogEntry("openrouter:vision", { imageInput: true })],
    });

    await session.selectModel("openrouter:vision");
    expect(session.tetoModel).toBe("openrouter:fixed-teto");
    expect(session.workerModel).toBe("openrouter:fixed-worker");
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

  it("degrades historical images for text-only models and restores them after switching back", async () => {
    const root = await temporaryRoot();
    const image = { type: "image" as const, mimeType: "image/png" as const, data: "AQID" };
    const model = new CapabilityScriptedModel([
      response("vision turn complete"),
      response("text turn complete"),
      response("vision restored"),
    ]);
    const session = await openSession(
      root,
      model,
      "model-image-switch",
      [],
      "openrouter:vision",
    );

    await session.submit({ inputId: "vision-input", text: "Inspect this", images: [image] });
    await session.waitForIdle();
    await session.selectModel("openrouter:text");
    await session.submit({ inputId: "text-input", text: "Summarize without vision" });
    await session.waitForIdle();
    await session.selectModel("openrouter:vision");
    await session.submit({ inputId: "vision-again", text: "Revisit the original image" });
    await session.waitForIdle();
    await session.close();

    expect(model.requests.map((request) => request.model)).toEqual([
      "openrouter:vision",
      "openrouter:text",
      "openrouter:vision",
    ]);
    expect(requestImages(model.requests[0]?.messages ?? [])).toEqual([image]);
    expect(requestImages(model.requests[1]?.messages ?? [])).toEqual([]);
    expect(model.requests[1]?.messages.some((message) => (
      message.content.includes("selected model does not support image input")
    ))).toBe(true);
    expect(requestImages(model.requests[2]?.messages ?? [])).toEqual([image]);

    const runState = join(root, "state", "runs", "model-image-switch");
    const ledger = await JsonlLedger.open(join(runState, "ledger.jsonl"));
    const events = await ledger.read({ runId: "model-image-switch" });
    const firstUser = events.find((event) => event.type === "user.message");
    expect(firstUser?.type).toBe("user.message");
    const store = await FileContentAddressedStore.open(join(runState, "store"));
    const durable = JSON.parse(new TextDecoder().decode(
      await store.get(firstUser!.payload.messageRef),
    )) as { images?: unknown[] };
    expect(durable.images).toEqual([image]);
    await ledger.close();
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

class CatalogCapabilityModel extends ScriptedModel {
  capabilities(model: string): {
    imageInput: boolean;
    contextWindowTokens: number;
  } {
    return {
      imageInput: model.endsWith(":vision") || model.endsWith(":contradictory"),
      contextWindowTokens: 64_000,
    };
  }
}

function catalogEntry(
  selector: string,
  capabilities: { imageInput: boolean },
): ModelCatalogEntry {
  const separator = selector.indexOf(":");
  return {
    selector,
    provider: selector.slice(0, separator),
    id: selector.slice(separator + 1),
    name: selector,
    contextWindowTokens: 64_000,
    maxOutputTokens: 4_096,
    imageInput: capabilities.imageInput,
    toolUse: "unknown",
    reasoning: false,
    authStatus: "unverified",
  };
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
  initialModel = "openrouter:initial",
): Promise<SessionController> {
  return SessionController.open({
    workspace: root,
    dataDir: join(root, "state"),
    model: initialModel,
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

function requestImages(messages: readonly import("../../src/domain/index.js").ConversationMessage[]) {
  return messages.flatMap((message) => (
    message.role === "user" || message.role === "tool" ? message.images ?? [] : []
  ));
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
