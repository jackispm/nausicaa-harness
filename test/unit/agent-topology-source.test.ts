import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readWorkspaceAgentAwareness } from "../../src/cli/agent-topology-source.js";
import { renderAgentTopologyFromSource } from "../../src/cli/agent-topology.js";
import { ScriptedModel } from "../../src/model/index.js";
import { executeRun } from "../../src/runtime/index.js";
import { LocalSessionRegistry } from "../../src/runtime/local-session-registry.js";

describe("workspace Awareness source", () => {
  it("returns an empty, printable projection without creating runtime state", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nausicaa-topology-source-"));
    try {
      const source = await readWorkspaceAgentAwareness(
        join(workspace, ".nausicaa"),
        workspace,
        "2026-09-01T12:00:00.000Z",
      );
      expect(source.records).toEqual([]);
      expect(source.availability).toBe("unavailable");
      expect(renderAgentTopologyFromSource(source)).toContain("0 nodes");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("renders a local Run from the committed workspace Ledger projection", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nausicaa-topology-run-"));
    const dataDir = join(workspace, ".nausicaa");
    try {
      await executeRun({
        workspace,
        dataDir,
        model: "scripted",
        message: "Inspect the local topology",
        policy: { maxMainSteps: 1, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([{
          content: "done",
          toolCalls: [],
          stopReason: "stop",
          usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
        }]),
        createRunId: () => "local-awareness-run",
      });

      const source = await readWorkspaceAgentAwareness(dataDir, workspace);
      const output = renderAgentTopologyFromSource(source);

      expect(output).toContain("local-awareness-run/main");
      expect(output).toContain("completed: Inspect the local topology");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps every session identity when multiple sessions observe one Run", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nausicaa-topology-multi-session-"));
    const dataDir = join(workspace, ".nausicaa");
    const registries: LocalSessionRegistry[] = [];
    try {
      const run = await executeRun({
        workspace,
        dataDir,
        model: "scripted",
        message: "Seed a shared Run",
        policy: { maxMainSteps: 1, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([{
          content: "done",
          toolCalls: [],
          stopReason: "stop",
          usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
        }]),
        createRunId: () => "shared-awareness-run",
      });

      for (const [sessionId, state] of [["session-one", "active"], ["session-two", "idle"]] as const) {
        const registry = new LocalSessionRegistry({
          dataDir,
          workspace,
          sessionId,
          heartbeatMs: 60_000,
        });
        registries.push(registry);
        await registry.start({ runId: run.runId, state });
      }

      const source = await readWorkspaceAgentAwareness(dataDir, workspace);
      const runRecords = (source.records ?? []).filter((record) => (
        record.endpoint.runId === run.runId && record.endpoint.laneId === "main"
      ));
      expect(runRecords.map((record) => record.endpoint.sessionId)).toEqual([
        "session-one",
        "session-two",
      ]);
    } finally {
      await Promise.all(registries.map((registry) => registry.close()));
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("accepts one host observation without creating a second source", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nausicaa-topology-host-"));
    try {
      const source = await readWorkspaceAgentAwareness(
        join(workspace, ".nausicaa"),
        workspace,
        "2026-09-01T12:00:00.000Z",
        {
          host: {
            status: "running",
            ownerId: "private-owner",
            queuedRuns: 0,
            runningRuns: 1,
            attachedClients: 0,
            runs: [{ runId: "run-host", state: "running", pendingWakeCount: 0 }],
          },
        },
      );
      expect(source.records?.map((record) => [record.endpoint.runId, record.endpoint.laneId])).toEqual([
        ["daemon-host", "daemon"],
        ["run-host", "main"],
      ]);
      expect(JSON.stringify(source)).not.toContain("private-owner");
      expect(renderAgentTopologyFromSource(source)).toContain("source fresh");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("authoritatively refreshes the current detached Session observation", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nausicaa-topology-current-session-"));
    try {
      const source = await readWorkspaceAgentAwareness(
        join(workspace, ".nausicaa"),
        workspace,
        {
          now: "2026-09-01T12:00:00.000Z",
          currentSession: {
            sessionId: "current-session",
            state: "active",
            laneId: "main",
            lastSeen: "2026-09-01T12:00:00.000Z",
            activitySummary: "working",
          },
        },
      );
      const current = source.records?.find((record) => (
        record.endpoint.sessionId === "current-session"
      ));
      expect(current).toMatchObject({
        state: "active",
        lastSeen: "2026-09-01T12:00:00.000Z",
        activitySummary: "working",
      });
      expect(current?.endpoint.runId).toBe("session:current-session");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
