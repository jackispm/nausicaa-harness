import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnyEvent, ModelResponse } from "../../src/domain/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import { MAX_LANE_METADATA_LENGTH, validateSpawnContext } from "../../src/runtime/lane-context.js";
import { executeRun } from "../../src/runtime/run-runtime.js";
import { SessionController } from "../../src/runtime/session-controller.js";
import { createWorkspaceTools } from "../../src/tools/index.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function response(content: string): ModelResponse {
  return { content, toolCalls: [], stopReason: "stop", usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 } };
}

describe("Team admission with the production workspace catalog", () => {
  it.each(["one-shot", "session"] as const)("admits long tool descriptions through the %s host without changing tool schemas or grants", async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-team-catalog-"));
    roots.push(root);
    const events: AnyEvent[] = [];
    const originalBash = createWorkspaceTools({ allowWrite: true, allowShell: true, allowNetwork: true })
      .find((tool) => tool.definition.name === "bash")!.definition;
    expect(originalBash.description.length).toBeGreaterThan(MAX_LANE_METADATA_LENGTH);
    const mainModel = new ScriptedModel([
      {
        ...response("Create the Team"), stopReason: "toolUse",
        toolCalls: [{ id: "create-catalog-team", name: "team_create", arguments: {
          teamId: "catalog", members: [
            { memberId: "writer", statement: "Report your available tools without executing them" },
            { memberId: "inspector", statement: "Report your read-only tools without executing them", capabilities: { tools: ["read_file"], allowNestedTeam: false } },
          ],
        } }],
      },
      ...Array.from({ length: 6 }, () => response("Team admitted")),
    ]);
    const workerModel = new ScriptedModel([response("Writer ready"), response("Inspector ready")]);
    const options = {
      workspace: root, dataDir: join(root, "state"), model: "scripted-main", workerModel: "scripted-member",
      policy: { tetoEnabled: false, workerEnabled: false, maxMainStepsPerActivation: 5 },
      allowWrite: true, allowShell: true, allowNetwork: true,
    };
    const deps = { mainModel, workerModel, createRunId: () => `catalog-${mode}` };
    if (mode === "one-shot") {
      const result = await executeRun({ ...options, message: "Create a Team" }, {
        ...deps, onEvent: (event) => { events.push(event); },
      });
      expect(result.completed).toBe(true);
    } else {
      const session = await SessionController.open(options, deps);
      session.subscribe((event) => { if (event.kind === "event") events.push(event.event); });
      try {
        await session.submit({ inputId: "catalog-input", text: "Create a Team" });
        await session.waitForIdle();
        await vi.waitFor(() => expect(workerModel.callCount).toBe(2), { timeout: 4_000 });
      } finally {
        await session.close();
      }
    }

    expect(mainModel.requests[1]?.messages.find((message) => message.role === "tool" && message.toolName === "team_create"))
      .toMatchObject({ isError: false });
    const created = events.find((event) => event.type === "team.created");
    expect(created?.payload.members).toHaveLength(2);
    for (const member of created!.payload.members) {
      expect(member.task.spawnContext).toBeDefined();
      expect(() => validateSpawnContext(member.task.spawnContext)).not.toThrow();
      const context = member.task.spawnContext!;
      for (const capability of [...context.tools, ...context.laneManifest.capabilities]) {
        expect(capability.description?.trim().length).toBeGreaterThan(0);
        expect(capability.description!.length).toBeLessThanOrEqual(MAX_LANE_METADATA_LENGTH);
      }
    }
    const writer = workerModel.requests.find((request) => request.laneId === "team:catalog:writer");
    expect(writer?.tools.find((tool) => tool.name === "bash")).toEqual(originalBash);
    expect(writer?.tools.some((tool) => tool.name === "write_file")).toBe(true);
    const inspector = workerModel.requests.find((request) => request.laneId === "team:catalog:inspector");
    expect(inspector?.tools.map((tool) => tool.name)).toContain("read_file");
    expect(inspector?.tools.some((tool) => ["bash", "write_file", "team_create"].includes(tool.name))).toBe(false);
  }, 15_000);
});
