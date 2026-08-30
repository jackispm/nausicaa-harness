import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentTool } from "../../src/domain/ports.js";
import { MoweExecutor } from "../../src/mowe/index.js";
import { createWorkspaceMoweCatalogSnapshot } from "../../src/mowe/workspace-catalog.js";
import { ScriptedModel } from "../../src/model/index.js";
import { executeRun } from "../../src/runtime/index.js";

const roots: string[] = [];

/** Offline fixture used by integration tests and future adapter sessions. */
const fixtureTool: AgentTool = {
  definition: {
    name: "fixture_edge_read",
    description: "Return deterministic fixture evidence",
    parameters: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    },
  },
  execute: async (args) => ({
    content: `fixture:${String(args.key)}`,
    isError: false,
  }),
};

describe("edge integration fixture", () => {
  it("executes a captured edge tool through the same Mowe boundary as first-party tools", async () => {
    const captured = createWorkspaceMoweCatalogSnapshot({
      edgeSnapshot: {
        generation: 3,
        tools: [fixtureTool],
        metadataByName: {
          fixture_edge_read: {
            effect: "read",
            scope: "run",
            deterministic: true,
          },
        },
      },
    });
    const result = await new MoweExecutor({ catalog: captured.catalog }).execute({
      runId: "fixture-run",
      laneId: "main",
      workspace: "/tmp/nausicaa-edge-fixture",
      calls: [{
        id: "fixture-call",
        name: "fixture_edge_read",
        arguments: { key: "provenance" },
      }],
      allowedEffects: ["read"],
      allowedScopes: ["run"],
    });

    expect(captured.generation).toBe(3);
    expect(result.status).toBe("succeeded");
    expect(result.results[0]?.result.content).toBe("fixture:provenance");
  });

  it("keeps the captured edge visible to Main without giving Worker a new tool surface", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-edge-e2e-"));
    roots.push(root);
    const model = new ScriptedModel([(request) => {
      expect(request.tools?.map((tool) => tool.name)).toContain("fixture_edge_read");
      return {
        content: "main completed",
        toolCalls: [],
        stopReason: "stop",
        usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 },
      };
    }]);
    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "Use the captured edge",
      policy: { maxMainStepsPerActivation: 1, tetoEnabled: false, workerEnabled: true },
      workerEnabled: true,
      edgeSnapshot: {
        generation: 3,
        tools: [fixtureTool],
        metadataByName: {
          fixture_edge_read: { effect: "read", scope: "run", deterministic: true },
        },
      },
    }, { mainModel: model, createRunId: () => "edge-main-worker" });

    expect(result.completed).toBe(true);
    expect(model.callCount).toBe(1);
  });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
