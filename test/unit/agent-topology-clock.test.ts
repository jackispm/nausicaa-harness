import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readWorkspaceAgentAwareness } from "../../src/cli/agent-topology-source.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { projectAgentTopology } from "../../src/runtime/agent-awareness.js";
import { FileDaemonRunEventSource } from "../../src/runtime/daemon-observer.js";
import * as sessionRegistry from "../../src/runtime/local-session-registry.js";
import { resolveRunPolicy } from "../../src/runtime/run-policy.js";
import * as sessions from "../../src/runtime/session-controller.js";

const startedAt = "2026-09-07T13:46:06.086Z";
const observedAt = "2026-09-07T13:46:06.258Z";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(startedAt));
  vi.spyOn(sessions, "listWorkspaceRuns").mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("workspace Awareness observation time", () => {
  it.each(["string", "options"] as const)("evaluates real registry heartbeats at the explicit %s replay time", async (format) => {
    const workspace = await mkdtemp(join(tmpdir(), "nausicaa-topology-replay-clock-"));
    const dataDir = join(workspace, ".state");
    const registry = new sessionRegistry.LocalSessionRegistry({
      workspace, dataDir, sessionId: "replay-session", heartbeatMs: 60_000,
    });
    try {
      await registry.start({ state: "idle" });
      vi.setSystemTime(new Date("2026-09-07T14:00:00.000Z"));
      const liveSource = await readWorkspaceAgentAwareness(dataDir, workspace);
      expect(projectAgentTopology(liveSource).nodes[0]?.state).toBe("offline");

      const replaySource = await readWorkspaceAgentAwareness(
        dataDir, workspace, format === "string" ? startedAt : { now: startedAt },
      );
      expect(projectAgentTopology(replaySource).nodes[0]).toMatchObject({
        state: "idle", lastSeen: startedAt,
      });
    } finally {
      await registry.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps heartbeats updated during discovery live without allowing future skew", async () => {
    vi.spyOn(sessionRegistry, "readLocalSessionRegistry").mockImplementation(async () => {
      vi.setSystemTime(new Date(observedAt));
      return [{ ...presence("other-session", observedAt), runtimeBuildId: "bbbbbbbbbbbb" }];
    });

    const source = await readWorkspaceAgentAwareness("/state", "/workspace", {
      currentSession: {
        sessionId: "own-session", laneId: "main", state: "active", lastSeen: startedAt,
        runtimeBuildId: "aaaaaaaaaaaa",
      },
    });
    const snapshot = projectAgentTopology(source);

    expect(source.now).toBe(observedAt);
    expect(source.generatedAt).toBe(observedAt);
    expect(source.maxFutureSkewMs ?? 0).toBe(0);
    expect(snapshot.nodes.map((node) => [node.endpoint.sessionId, node.state])).toEqual([
      ["other-session", "idle"],
      ["own-session", "active"],
    ]);
    expect(snapshot.nodes.map((node) => node.runtimeBuildId)).toEqual(["bbbbbbbbbbbb", "aaaaaaaaaaaa"]);
    expect(source.records?.find((record) => record.endpoint.sessionId === "other-session")?.lastSeen)
      .toBe(observedAt);
  });

  it.each(["string", "options"] as const)("preserves an explicit %s replay cutoff", async (format) => {
    vi.setSystemTime(new Date(observedAt));
    vi.spyOn(sessionRegistry, "readLocalSessionRegistry").mockResolvedValue([
      presence("after-cutoff", observedAt),
    ]);

    const source = await readWorkspaceAgentAwareness(
      "/state", "/workspace", format === "string" ? startedAt : { now: startedAt },
    );

    expect(source.now).toBe(startedAt);
    expect(projectAgentTopology(source).nodes[0]?.state).toBe("offline");
  });

  it("does not revive stale or genuinely future presence records", async () => {
    const staleAt = "2026-09-07T13:40:00.000Z";
    const futureAt = "2026-09-07T13:47:00.000Z";
    vi.spyOn(sessionRegistry, "readLocalSessionRegistry").mockResolvedValue([
      { ...presence("stale-session", staleAt), live: false, state: "offline" },
      presence("future-session", futureAt),
    ]);

    const source = await readWorkspaceAgentAwareness("/state", "/workspace");
    const snapshot = projectAgentTopology(source);

    expect(snapshot.nodes).toHaveLength(2);
    expect(snapshot.nodes.every((node) => node.state === "offline")).toBe(true);
    expect(snapshot.nodes.find((node) => node.endpoint.sessionId === "stale-session")?.lastSeen)
      .toBe(staleAt);
    expect(snapshot.nodes.find((node) => node.endpoint.sessionId === "future-session")?.lastSeen)
      .toBe(futureAt);
  });

  it("lets an observation age out during a slow read instead of refreshing its heartbeat", async () => {
    vi.spyOn(sessionRegistry, "readLocalSessionRegistry").mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-09-07T13:52:06.086Z"));
      return [presence("aged-out-session", startedAt)];
    });

    const source = await readWorkspaceAgentAwareness("/state", "/workspace");

    expect(source.now).toBe("2026-09-07T13:52:06.086Z");
    expect(projectAgentTopology(source).nodes[0]).toMatchObject({ state: "offline", lastSeen: startedAt });
  });

  it("preserves the observing process build identity on a Run and its activated lanes", async () => {
    const runId = "observed-run";
    const ledger = new MemoryLedger();
    await ledger.append({
      runId, laneId: "main", type: "run.created",
      payload: { workspace: "/workspace", policy: resolveRunPolicy({ tetoEnabled: true }) },
      correlationId: "test", idempotencyKey: "created",
    });
    await ledger.append({
      runId, laneId: "main", type: "lane.registered", payload: { kind: "main" },
      correlationId: "test", idempotencyKey: "main",
    });
    await ledger.append({
      runId, laneId: "teto", type: "lane.registered", payload: { kind: "intent-navigator" },
      correlationId: "test", idempotencyKey: "teto",
    });
    await ledger.append({
      runId, laneId: "teto", type: "step.started", payload: { step: 1 },
      correlationId: "test", idempotencyKey: "teto-step",
    });
    const events = await ledger.read({ runId });
    await ledger.close();
    vi.mocked(sessions.listWorkspaceRuns).mockResolvedValue([{
      runId, goal: "Inspect topology", status: "active", createdAt: startedAt, updatedAt: startedAt,
    }]);
    vi.spyOn(sessionRegistry, "readLocalSessionRegistry").mockResolvedValue([{
      ...presence("observing-session", startedAt), runId, runtimeBuildId: "cccccccccccc",
    }]);
    vi.spyOn(FileDaemonRunEventSource.prototype, "read").mockResolvedValue({
      runId, events, firstOffset: 1, watermark: events.length, generation: 0,
    });

    const source = await readWorkspaceAgentAwareness("/state", "/workspace");

    expect(projectAgentTopology(source).nodes.map((node) => [node.endpoint.laneId, node.runtimeBuildId]))
      .toEqual([["main", "cccccccccccc"], ["teto", "cccccccccccc"]]);
  });
});

function presence(sessionId: string, lastSeen: string): sessionRegistry.LocalSessionObservation {
  return {
    version: 1, sessionId, workspace: "/workspace", laneId: "main",
    state: "idle", startedAt, lastSeen, live: true,
  };
}
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
