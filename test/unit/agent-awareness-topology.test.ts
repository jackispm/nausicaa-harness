import { describe, expect, it } from "vitest";

import { endpointKey } from "../../src/a2a/cross-run-contract.js";
import {
  createAgentAwarenessQuery,
  projectAgentTopology,
  sanitizeAgentActivitySummary,
  type AgentAwarenessRecord,
} from "../../src/runtime/agent-awareness.js";
import {
  renderAgentTopologyJson,
  renderAgentTopologyText,
} from "../../src/cli/agent-topology.js";

const now = "2026-09-01T12:00:00.000Z";
const endpoint = (runId: string, laneId: string, workspaceId = "repo", sessionId = "session-a") => ({
  workspaceId,
  sessionId,
  runId,
  laneId,
});

describe("agent awareness topology", () => {
  it("projects multi-run lanes, maps Teto/Worker, and renders one snapshot", () => {
    const main = endpoint("run-7", "main");
    const teto = endpoint("run-7", "teto");
    const worker = endpoint("run-8", "worker");
    const snapshot = projectAgentTopology({
      now,
      generatedAt: now,
      records: [
        {
          endpoint: worker,
          role: "worker",
          state: "running",
          generation: 3,
          lastSeen: now,
          activitySummary: "reviewing daemon lifecycle",
          forkOf: main,
        },
        {
          endpoint: teto,
          laneKind: "intent-navigator",
          state: "waiting",
          generation: 2,
          lastSeen: now,
          activitySummary: "observing mission alignment",
          observerOf: main,
        },
        {
          endpoint: main,
          laneKind: "main",
          state: "running",
          generation: 1,
          lastSeen: now,
          activitySummary: "analyzing A2A composition",
          children: [worker],
        },
      ],
    });

    expect(snapshot.nodes.map((node) => [node.endpoint.runId, node.role, node.state])).toEqual([
      ["run-7", "main", "active"],
      ["run-7", "teto", "waiting"],
      ["run-8", "worker", "active"],
    ]);
    expect(snapshot.edges).toEqual([
      { source: endpointKey(main), target: endpointKey(worker), relation: "parent" },
      { source: endpointKey(teto), target: endpointKey(main), relation: "observer" },
      { source: endpointKey(worker), target: endpointKey(main), relation: "fork-of" },
    ]);
    expect(snapshot.roots).toEqual([endpointKey(main), endpointKey(teto)]);
    expect(renderAgentTopologyText(snapshot)).toContain("connections:");
    expect(renderAgentTopologyText(snapshot)).toContain("fork-of");
    expect(renderAgentTopologyText(snapshot)).toContain("└─");
    expect(JSON.parse(renderAgentTopologyJson(snapshot))).toEqual(snapshot);
    expect(renderAgentTopologyText(snapshot)).toBe(renderAgentTopologyText(snapshot));
    expect(Object.isFrozen(snapshot.edges[0])).toBe(true);
  });

  it("rejects stale and untrusted active claims, retaining daemon reservations as sleeping", () => {
    const snapshot = projectAgentTopology({
      now,
      records: [
        { endpoint: endpoint("old", "main"), state: "running", lastSeen: "2026-09-01T11:00:00Z" },
        { endpoint: endpoint("reserved", "worker"), state: "running", retained: true, lastSeen: "2026-09-01T11:00:00Z" },
        { endpoint: endpoint("untrusted", "main"), state: "running", generationTrusted: false, lastSeen: now },
        { endpoint: endpoint("ended", "main"), state: "completed", lastSeen: now },
        { endpoint: endpoint("missing-seen", "main"), state: "running" },
        { endpoint: endpoint("future", "main"), state: "running", lastSeen: "2026-09-01T12:01:00Z" },
      ],
    });
    expect(snapshot.nodes.map((node) => node.state)).toEqual(["terminal", "offline", "offline", "offline", "sleeping", "offline"]);
    expect(snapshot.nodes.find((node) => node.endpoint.runId === "old")?.state).toBe("offline");
    expect(snapshot.nodes.find((node) => node.endpoint.runId === "reserved")?.state).toBe("sleeping");
  });

  it("does not project unauthorized records or edges", () => {
    const visible = endpoint("visible", "main");
    const hidden = endpoint("hidden", "worker");
    const snapshot = projectAgentTopology({
      now,
      records: [
        { endpoint: visible, state: "idle", lastSeen: now },
        { endpoint: hidden, state: "active", lastSeen: now, authorized: false },
      ],
      edges: [{ source: visible, target: hidden, relation: "peer", authorized: false }],
    });
    expect(snapshot.nodes.map((node) => node.endpoint.runId)).toEqual(["visible"]);
    expect(snapshot.edges).toEqual([]);
  });

  it("rejects endpoint labels that would expose paths or credentials", () => {
    expect(() => projectAgentTopology({ now, records: [{
      endpoint: endpoint("run", "main", "/Users/private"),
      state: "idle",
      lastSeen: now,
    }] })).toThrow(/public endpoint label/i);
  });

  it("keeps the newest generation, stable ordering, and explicit branch edges", () => {
    const target = endpoint("same", "main");
    const branch = endpoint("branch", "main");
    const snapshot = projectAgentTopology({
      now,
      records: [
        { endpoint: target, state: "waiting", generation: 1, lastSeen: now, activitySummary: "old" },
        { endpoint: target, state: "running", generation: 2, lastSeen: now, activitySummary: "new" },
        { endpoint: branch, state: "idle", generation: 1, lastSeen: now, branchOf: target },
      ],
    });
    expect(snapshot.nodes).toHaveLength(2);
    expect(snapshot.nodes.find((node) => node.endpoint.runId === "same")?.state).toBe("active");
    expect(snapshot.nodes.find((node) => node.endpoint.runId === "same")?.activitySummary).toBe("new");
    expect(snapshot.edges).toEqual([{ source: endpointKey(branch), target: endpointKey(target), relation: "branch-of" }]);
    expect(projectAgentTopology({ now, records: [
      { endpoint: branch, state: "idle", lastSeen: now },
      { endpoint: target, state: "running", lastSeen: now },
    ] })).toEqual(projectAgentTopology({ now, records: [
      { endpoint: target, state: "running", lastSeen: now },
      { endpoint: branch, state: "idle", lastSeen: now },
    ] }));
  });

  it("bounds nodes and edges without exposing omitted records", () => {
    const records: AgentAwarenessRecord[] = Array.from({ length: 4 }, (_, index) => ({
      endpoint: endpoint(`run-${index}`, "main"),
      state: "idle",
      lastSeen: now,
      activitySummary: `private secret=do-not-print /Users/gongdongjie/private-${index}`,
    }));
    records.push({ endpoint: endpoint("private", "worker"), state: "active", authorized: false, lastSeen: now });
    const snapshot = projectAgentTopology({ now, records, maxNodes: 2, maxEdges: 0 });
    expect(snapshot.nodes).toHaveLength(2);
    expect(snapshot.truncated).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("do-not-print");
    expect(JSON.stringify(snapshot)).not.toContain("/Users/");
    expect(snapshot.nodes.some((node) => node.endpoint.runId === "private")).toBe(false);
  });

  it("sanitizes bounded summaries and exposes a refreshable query seam", () => {
    expect(sanitizeAgentActivitySummary("token=abc pid:42 /tmp/private"))
      .toBe("[redacted] [redacted] [path]");
    expect(sanitizeAgentActivitySummary("<analysis>internal reasoning</analysis>")).toBe("[activity omitted]");
    let current: AgentAwarenessRecord[] = [{ endpoint: endpoint("run", "main"), state: "idle", lastSeen: now }];
    const query = createAgentAwarenessQuery(() => ({ now, records: current }));
    expect(query.listAgents()).toHaveLength(1);
    current = [...current, { endpoint: endpoint("run", "teto"), laneKind: "intent-navigator", state: "waiting", lastSeen: now }];
    expect(query.topology().nodes).toHaveLength(2);
  });
});
