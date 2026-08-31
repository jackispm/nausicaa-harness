import { describe, expect, it } from "vitest";

import type { CrossRunRoster } from "../../src/a2a/cross-run-contract.js";
import { projectAgentTopology } from "../../src/runtime/agent-awareness.js";
import {
  composeAgentAwarenessProjectionInput,
  type AgentAwarenessCompositionOptions,
} from "../../src/runtime/agent-awareness-composition.js";
import type { DaemonWorkerDescriptor } from "../../src/runtime/daemon-worker-protocol.js";
import type { SessionSnapshot } from "../../src/runtime/session-controller.js";
import type { RunProjection } from "../../src/ledger/projection.js";

const now = "2026-09-01T12:00:00.000Z";

function projection(
  runId: string,
  lanes: RunProjection["lanes"],
  status: RunProjection["run"]["status"] = "running",
): RunProjection {
  return {
    run: { runId, status, lastOffset: 4 },
    goal: undefined,
    lanes,
    inbox: [],
    inputs: [],
    turns: Object.create(null) as RunProjection["turns"],
    unknownOperations: [],
    budget: {
      charged: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      byLane: Object.create(null) as RunProjection["budget"]["byLane"],
    },
    conversation: [],
  };
}

function lane(
  laneId: string,
  status: "dormant" | "ready" | "running" | "waiting" | "completed" | "failed" | "cancelled",
  kind: "main" | "intent-navigator" | "reflection" | "worker" = "main",
): RunProjection["lanes"][string] {
  return { laneId, status, kind, lastSeq: 1 };
}

function session(runId: string, status: SessionSnapshot["status"] = "running"): SessionSnapshot {
  return {
    workspace: "/private/should-never-be-an-endpoint",
    runId,
    status,
    model: "model:test",
    tetoEnabled: true,
    workerEnabled: true,
    permissionProfile: "workspace",
    collaborationMode: "default",
    allowWrite: true,
    allowShell: false,
    allowNetwork: false,
    workspaceBashAvailability: { available: false, reason: "test" },
    pendingInputs: 0,
    lastCommittedStep: 1,
    mainContextTokens: null,
    mainContextWindowTokens: null,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function descriptor(runId: string, fencingToken: number, publishedAt = now): DaemonWorkerDescriptor {
  return {
    version: 1,
    runId,
    workerId: `worker-${fencingToken}`,
    leasePath: "/private/lease/never-print",
    fencingToken,
    instanceToken: `instance-${fencingToken}`,
    publishedAt,
  };
}

describe("agent awareness runtime composition", () => {
  it("combines Runs, lanes, Host, Worker, roster and lineage into one projection input", () => {
    const roster: CrossRunRoster = {
      current: { workspaceId: "repo", sessionId: "session-a", runId: "run-a", laneId: "main" },
      entries: [
        {
          endpoint: { workspaceId: "repo", sessionId: "session-c", runId: "run-c", laneId: "worker" },
          relationship: "child",
          status: "busy",
          reachable: true,
        },
        {
          endpoint: { workspaceId: "repo", sessionId: "session-b", runId: "run-b", laneId: "main" },
          relationship: "sibling",
          status: "busy",
          reachable: true,
        },
      ],
    };
    const options: AgentAwarenessCompositionOptions = {
      workspaceId: "repo",
      sessionId: "session-a",
      now,
      runs: [
        {
          projection: projection("run-a", {
            main: lane("main", "running"),
            teto: lane("teto", "waiting", "intent-navigator"),
            worker: lane("worker", "running", "worker"),
          }),
          session: session("run-a"),
          generation: 3,
          activitySummary: "analyzing secret=never-expose /private/project",
        },
        {
          projection: projection("run-b", { main: lane("main", "waiting") }),
          scope: { sessionId: "session-b" },
          session: session("run-b", "idle"),
        },
      ],
      host: {
        status: "running",
        ownerId: "daemon-owner",
        queuedRuns: 1,
        runningRuns: 0,
        attachedClients: 1,
        runs: [{ runId: "run-b", state: "queued", pendingWakeCount: 1 }],
      },
      workers: [{
        descriptor: descriptor("run-a", 7),
        laneId: "worker-process",
        active: true,
      }],
      roster,
      lineage: [{
        source: { workspaceId: "repo", sessionId: "session-c", runId: "run-c", laneId: "worker" },
        target: { workspaceId: "repo", sessionId: "session-a", runId: "run-a", laneId: "main" },
        relation: "fork-of",
      }],
    };

    const input = composeAgentAwarenessProjectionInput(options);
    const snapshot = projectAgentTopology(input);
    expect(snapshot.nodes.map((node) => [node.endpoint.runId, node.endpoint.laneId, node.role, node.state])).toEqual([
      ["run-a", "main", "main", "active"],
      ["run-a", "teto", "teto", "waiting"],
      ["run-a", "worker", "worker", "active"],
      ["run-a", "worker-process", "worker", "active"],
      ["run-b", "main", "main", "starting"],
      ["run-c", "worker", "worker", "active"],
    ]);
    expect(snapshot.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: "observer" }),
      expect.objectContaining({ relation: "peer" }),
      expect.objectContaining({ relation: "fork-of" }),
    ]));
    expect(snapshot.nodes.find((node) => node.endpoint.runId === "run-a" && node.endpoint.laneId === "main")?.activitySummary)
      .toBe("analyzing [redacted] [path]");
    expect(JSON.stringify(snapshot)).not.toContain("private/should-never");
    expect(JSON.stringify(snapshot)).not.toContain("lease");
    expect(input.records?.every((record) => record.authorized === true && record.visible === true)).toBe(true);
  });

  it("keeps the newest worker generation and marks stale or held sources safely", () => {
    const input = composeAgentAwarenessProjectionInput({
      workspaceId: "repo",
      sessionId: "session-a",
      now,
      freshnessMs: 5 * 60_000,
      host: {
        status: "running",
        ownerId: "daemon-owner",
        queuedRuns: 0,
        runningRuns: 0,
        attachedClients: 0,
        runs: [{ runId: "held", state: "held", pendingWakeCount: 0, fencingToken: 2 }],
      },
      workers: [
        { descriptor: descriptor("stale", 1, "2026-09-01T11:00:00.000Z") },
        { descriptor: descriptor("same", 1), activitySummary: "old" },
        { descriptor: descriptor("same", 2), activitySummary: "new" },
      ],
    });
    const snapshot = projectAgentTopology(input);
    expect(snapshot.nodes.find((node) => node.endpoint.runId === "stale")?.state).toBe("offline");
    expect(snapshot.nodes.find((node) => node.endpoint.runId === "held")?.state).toBe("sleeping");
    expect(snapshot.nodes.find((node) => node.endpoint.runId === "same")?.generation).toBe(2);
    expect(snapshot.nodes.find((node) => node.endpoint.runId === "same")?.activitySummary).toBe("new");
  });

  it("requires an explicit non-path scope and ignores sensitive source metadata", () => {
    expect(() => composeAgentAwarenessProjectionInput({
      sessionId: "session-a",
      runs: [{ projection: projection("run-a", { main: lane("main", "running") }) }],
    })).toThrow(/workspaceId is required/u);
    expect(() => composeAgentAwarenessProjectionInput({
      workspaceId: "repo",
      sessionId: "session-a",
      runs: [{ projection: projection("run-a", { main: lane("main", "running") }), session: session("other") }],
    })).toThrow(/does not match/u);
  });

  it("is deterministic when source arrays arrive in a different order", () => {
    const base: AgentAwarenessCompositionOptions = {
      workspaceId: "repo",
      sessionId: "session-a",
      now,
      runs: [
        { projection: projection("b", { main: lane("main", "waiting") }) },
        { projection: projection("a", { main: lane("main", "running") }) },
      ],
      workers: [{ descriptor: descriptor("a", 1) }],
      lineage: [{
        source: { workspaceId: "repo", sessionId: "session-a", runId: "a", laneId: "main" },
        target: { workspaceId: "repo", sessionId: "session-a", runId: "b", laneId: "main" },
        relation: "peer",
      }],
    };
    const reverse: AgentAwarenessCompositionOptions = {
      ...base,
      runs: [...base.runs!].reverse(),
      workers: [...base.workers!].reverse(),
      lineage: [...base.lineage!].reverse(),
    };
    expect(composeAgentAwarenessProjectionInput(base)).toEqual(composeAgentAwarenessProjectionInput(reverse));
  });
});
