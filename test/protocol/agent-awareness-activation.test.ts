import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ModelResponse } from "../../src/domain/ports.js";
import type { CrossRunEndpoint } from "../../src/domain/types.js";
import { sha256, stableJson } from "../../src/ledger/hash.js";
import { JsonlLedger, projectRun } from "../../src/ledger/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import { listWorkspaceRuns, SessionController } from "../../src/runtime/session-controller.js";
import { composeAgentAwarenessProjectionInput } from "../../src/runtime/agent-awareness-composition.js";
import { projectAgentTopology, type AgentTopologySnapshot } from "../../src/runtime/agent-awareness.js";
import { projectionChecksum, recoverRun } from "../../src/runtime/recovery.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("interactive agent activation awareness", () => {
  it("shows Main alone without using optional lanes, including after resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-awareness-activation-"));
    roots.push(root);
    const dataDir = join(root, "state");
    const runId = "unused-optional-lanes";
    const teto = new ScriptedModel([]);
    const worker = new ScriptedModel([]);
    const modelSnapshots: AgentTopologySnapshot[] = [];
    const options = {
      workspace: root, dataDir, model: "scripted/main",
      tetoModel: "scripted/teto", workerModel: "scripted/worker",
      workerEnabled: true, tetoActivation: "manual" as const,
      policy: { maxMainStepsPerActivation: 2, maxModelTokens: 20_000, tetoEnabled: true },
    };

    for (const resumed of [false, true]) {
      const main = new ScriptedModel([
        (request) => {
          expect(request.tools.map((tool) => tool.name))
            .toEqual(expect.arrayContaining(["agent_awareness", "teto_start", "delegate_task", "team_create"]));
          return {
            ...response("Inspect the live agent list"),
            toolCalls: [{ id: `awareness-${resumed}`, name: "agent_awareness", arguments: {} }],
            stopReason: "toolUse",
          };
        },
        (request) => {
          const result = request.messages.findLast((message) => (
            message.role === "tool" && message.toolName === "agent_awareness"
          ));
          if (result?.role !== "tool") throw new Error("Missing awareness result");
          expect(result.isError).toBe(false);
          const output = JSON.parse(result.content) as { self: CrossRunEndpoint; snapshot: AgentTopologySnapshot };
          modelSnapshots.push(output.snapshot);
          expect(output.snapshot.nodes.map((node) => node.endpoint.laneId)).toEqual(["main"]);
          expect(output.self).toEqual(output.snapshot.nodes[0]?.endpoint);
          expect(output.self).toMatchObject({ runId, laneId: "main", sessionId: session.sessionId });
          expect(output.snapshot.edges).toEqual([]);
          return response("Only Main has been started");
        },
      ]);
      const session = await SessionController.open({
        ...options, ...(resumed ? { runId } : {}),
      }, { mainModel: main, tetoModel: teto, workerModel: worker, tools: [], createRunId: () => runId });
      try {
        await session.submit({ inputId: `check-${resumed}`, text: "List the agents without opening any" });
        await session.waitForIdle();
        expect(main.callCount).toBe(2);
        expect(session.snapshot().status).toBe("idle");
        expect(session.workerTaskSummary().total).toBe(0);
      } finally {
        await session.close();
      }

      const ledger = await JsonlLedger.open(join(dataDir, "runs", runId, "ledger.jsonl"));
      try {
        const events = await ledger.read({ runId });
        const projection = projectRun(events, runId);
        expect(projection.lanes.teto).toMatchObject({ kind: "intent-navigator", activated: false });
        expect(projection.lanes.worker).toMatchObject({ kind: "worker", activated: false });
        expect(events.some((event) => event.type === "lane.status" && event.payload.control?.action === "start")).toBe(false);
        const snapshot = projectAgentTopology(composeAgentAwarenessProjectionInput({
          workspaceId: "test-workspace", sessionId: "test-session",
          now: new Date().toISOString(), runs: [{ projection, state: "idle" }],
        }));
        expect(snapshot.nodes.map((node) => node.endpoint.laneId)).toEqual(["main"]);
        expect(snapshot.edges).toEqual([]);
      } finally {
        await ledger.close();
      }
    }
    expect(modelSnapshots).toHaveLength(2);
    expect(teto.callCount).toBe(0);
    expect(worker.callCount).toBe(0);
  });

  it("inspects, resumes, and forks checkpoints saved before activation metadata existed", async () => {
    const fixture = await legacyCheckpointFixture();
    const ledger = await JsonlLedger.open(fixture.ledgerPath);
    try {
      const before = await ledger.read({ runId: fixture.runId });
      await expect(recoverRun(ledger, fixture.runId, { mode: "inspect" }))
        .resolves.toMatchObject({ runId: fixture.runId, startStep: 2 });
      expect(await ledger.read({ runId: fixture.runId })).toEqual(before);
    } finally {
      await ledger.close();
    }
    const runs = await listWorkspaceRuns(fixture.options.dataDir, fixture.options.workspace);
    expect(runs.find((run) => run.runId === fixture.runId)?.checkpoints)
      .toContainEqual(fixture.checkpoint);

    const model = new ScriptedModel([
      (request) => {
        expect(request.messages).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "Remember the saved question" }),
          expect.objectContaining({ role: "assistant", content: "Saved answer" }),
        ]));
        return response("Resumed answer");
      },
      (request) => {
        expect(request.messages).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: "assistant", content: "Saved answer" }),
        ]));
        expect(request.messages.some((message) => message.content === "Resumed answer")).toBe(false);
        return response("Forked answer");
      },
    ]);
    const session = await SessionController.open({ ...fixture.options, runId: fixture.runId }, {
      ...fixture.auxiliaryModels, mainModel: model, tools: [],
    });
    try {
      await session.submit({ inputId: "resume-input", text: "Continue the saved conversation" });
      await session.waitForIdle();
      expect(model.callCount).toBe(1);
      expect((await session.transcript()).at(-1)?.content).toBe("Resumed answer");
      await expect(session.forkRun({ runId: "legacy-checkpoint-child", checkpoint: fixture.checkpoint }))
        .resolves.toMatchObject({
          runId: "legacy-checkpoint-child", parentRunId: fixture.runId,
          parentCheckpoint: fixture.checkpoint,
        });
      await session.submit({ inputId: "fork-input", text: "Continue from the historical checkpoint" });
      await session.waitForIdle();
      expect(model.callCount).toBe(2);
      expect((await session.transcript()).at(-1)?.content).toBe("Forked answer");
    } finally {
      await session.close();
    }
    expect(fixture.auxiliaryModels.tetoModel.callCount).toBe(0);
    expect(fixture.auxiliaryModels.workerModel.callCount).toBe(0);
  });

  it("still rejects a corrupted legacy checkpoint during inspection, recovery, and fork", async () => {
    const fixture = await legacyCheckpointFixture(true);
    const ledger = await JsonlLedger.open(fixture.ledgerPath);
    try {
      const before = await ledger.read({ runId: fixture.runId });
      for (const mode of ["inspect", "resume"] as const) {
        await expect(recoverRun(ledger, fixture.runId, { mode }))
          .rejects.toThrow("Checkpoint checksum mismatch");
      }
      expect(await ledger.read({ runId: fixture.runId })).toEqual(before);
    } finally {
      await ledger.close();
    }
    const runs = await listWorkspaceRuns(fixture.options.dataDir, fixture.options.workspace);
    expect(runs.find((run) => run.runId === fixture.runId)?.checkpoints)
      .not.toContainEqual(fixture.checkpoint);
    const model = new ScriptedModel([]);
    const session = await SessionController.open({ ...fixture.options, runId: fixture.runId }, {
      ...fixture.auxiliaryModels, mainModel: model, tools: [],
    });
    try {
      await expect(session.forkRun({ runId: "corrupted-checkpoint-child", checkpoint: fixture.checkpoint }))
        .rejects.toThrow("Parent checkpoint checksum mismatch");
      expect(model.callCount).toBe(0);
    } finally {
      await session.close();
    }
  });
});

async function legacyCheckpointFixture(corrupt = false) {
  const root = await mkdtemp(join(tmpdir(), "nausicaa-legacy-activation-checkpoint-"));
  roots.push(root);
  const runId = "legacy-activation-checkpoint";
  const options = {
    workspace: root, dataDir: join(root, "state"), model: "scripted/main",
    tetoModel: "scripted/teto", workerModel: "scripted/worker",
    workerEnabled: true, tetoActivation: "manual" as const,
    policy: { maxMainStepsPerActivation: 2, maxModelTokens: 20_000, tetoEnabled: true },
  };
  const auxiliaryModels = { tetoModel: new ScriptedModel([]), workerModel: new ScriptedModel([]) };
  const original = await SessionController.open(options, {
    ...auxiliaryModels, mainModel: new ScriptedModel([response("Saved answer")]),
    tools: [], createRunId: () => runId,
  });
  try {
    await original.submit({ inputId: "saved-input", text: "Remember the saved question" });
    await original.waitForIdle();
  } finally {
    await original.close();
  }
  const ledgerPath = join(options.dataDir, "runs", runId, "ledger.jsonl");
  const ledger = await JsonlLedger.open(ledgerPath);
  try {
    const events = await ledger.read({ runId });
    const projection = projectRun(events, runId);
    expect(projection.lanes.main?.activated).toBe(true);
    expect(projection.lanes.teto?.activated).toBe(false);
    expect(projection.lanes.worker?.activated).toBe(false);
    // Reconstruct the pre-change serialization independently of the checkpoint writer.
    const legacy = {
      ...projection,
      lanes: Object.fromEntries(Object.entries(projection.lanes).map(([laneId, lane]) => {
        const { activated: _activation, ...savedLane } = lane;
        return [laneId, savedLane];
      })),
    };
    const checksum = sha256(stableJson(legacy));
    expect(sha256(stableJson(projection))).not.toBe(checksum);
    expect(projectionChecksum(events, runId)).toBe(checksum);
    const checkpoint = {
      watermark: events.at(-1)!.globalOffset,
      checksum: corrupt ? `sha256:${"0".repeat(64)}` : checksum,
    };
    await ledger.append({
      runId, laneId: "main", type: "checkpoint.committed", payload: checkpoint,
      correlationId: "legacy-checkpoint", idempotencyKey: "legacy-checkpoint", visibility: "run",
    });
    return { runId, options, auxiliaryModels, ledgerPath, checkpoint };
  } finally {
    await ledger.close();
  }
}

function response(content: string): ModelResponse {
  return {
    content, toolCalls: [], stopReason: "stop",
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
  };
}
