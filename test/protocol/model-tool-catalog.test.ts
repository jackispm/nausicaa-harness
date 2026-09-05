import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ModelResponse } from "../../src/domain/index.js";
import { ScriptedModel, type ScriptedModelStep } from "../../src/model/index.js";
import { executeRun, SessionController } from "../../src/runtime/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("default model-aware tool catalog", () => {
  it("does not advertise read_image to a known text-only Main model", async () => {
    const root = await temporaryRoot();
    const model = new CapabilityModel([response("done")], false);

    await expect(executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted:text",
      message: "Inspect the workspace",
      policy: { maxMainSteps: 1, maxModelTokens: 10_000, tetoEnabled: false },
    }, {
      mainModel: model,
      createRunId: () => "text-only-catalog",
    })).resolves.toMatchObject({ completed: true });

    expect(model.requests[0]?.tools.map((tool) => tool.name)).not.toContain("read_image");
  });

  it("rebuilds the default catalog when a Session changes models", async () => {
    const root = await temporaryRoot();
    const model = new SelectorCapabilityModel([
      response("text model complete"),
      response("vision model complete"),
    ]);
    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted:text",
      policy: {
        maxMainStepsPerActivation: 1,
        maxModelTokens: 10_000,
        tetoEnabled: false,
      },
    }, {
      mainModel: model,
      createRunId: () => "dynamic-catalog",
    });

    await session.submit({ inputId: "first", text: "Use the text model" });
    await session.waitForIdle();
    await session.selectModel("scripted:vision");
    await session.submit({ inputId: "second", text: "Use the vision model" });
    await session.waitForIdle();
    await session.close();

    expect(model.requests).toHaveLength(2);
    expect(model.requests[0]?.tools.map((tool) => tool.name)).not.toContain("read_image");
    expect(model.requests[1]?.tools.map((tool) => tool.name)).toContain("read_image");
  });
});

class CapabilityModel extends ScriptedModel {
  constructor(steps: readonly ScriptedModelStep[], private readonly imageInput: boolean) {
    super(steps);
  }

  capabilities(): { imageInput: boolean } {
    return { imageInput: this.imageInput };
  }
}

class SelectorCapabilityModel extends ScriptedModel {
  capabilities(selector: string): { imageInput: boolean } {
    return { imageInput: selector.endsWith(":vision") };
  }
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
  const root = await mkdtemp(join(tmpdir(), "nausicaa-model-tool-catalog-"));
  roots.push(root);
  return root;
}
