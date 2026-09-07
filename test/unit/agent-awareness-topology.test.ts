import { describe, expect, it } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import {
  CROSS_RUN_MAX_FUTURE_SKEW_MS,
  endpointKey,
} from "../../src/a2a/cross-run-contract.js";
import {
  createAgentAwarenessQuery,
  projectAgentTopology,
  redactAgentTopologySnapshot,
  sanitizeAgentActivitySummary,
  type AgentAwarenessRecord,
} from "../../src/runtime/agent-awareness.js";
import {
  AgentTopologyBlock,
  createAgentTopologyPresenter,
  parseAgentTopologyFormat,
  renderAgentTopologyFromSource,
  renderAgentTopologyJson,
  renderAgentTopologyPanel,
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
  it.each([512, 1_024])("keeps live agents visible when historical Runs fill a %i node budget", (maxNodes) => {
    const current = endpoint("current", "main", "repo", "session-current");
    const snapshot = projectAgentTopology({
      now,
      maxNodes,
      records: [
        ...Array.from({ length: 600 }, (_, index) => ({
          endpoint: endpoint(`archived-${String(index).padStart(3, "0")}`, "main", "repo", "local-session"),
          state: "offline", lastSeen: now,
        })),
        { endpoint: current, state: "active", lastSeen: now },
      ],
    });
    expect(snapshot.nodes).toHaveLength(Math.min(601, maxNodes));
    expect(snapshot.truncated).toBe(maxNodes < 601);
    expect(snapshot.nodes.find((node) => node.key === endpointKey(current))?.state).toBe("active");
    const panel = stripTerminalSequences(renderAgentTopologyPanel(snapshot, 160, { currentEndpoint: current }).join("\n"));
    expect(panel).toContain("1 live agents");
    expect(panel).toContain("run:current");
    expect(renderAgentTopologyText(snapshot)).toContain("offline");
  });

  it("reserves a small node budget for live nodes before retaining diagnostic history", () => {
    const historical = { endpoint: endpoint("a-history", "main"), state: "terminal", lastSeen: now };
    const live = { endpoint: endpoint("z-live", "main"), state: "idle", lastSeen: now };
    const bounded = projectAgentTopology({ now, records: [historical, live], maxNodes: 1 });
    expect(bounded.nodes.map((node) => node.endpoint.runId)).toEqual(["z-live"]);
    expect(bounded.truncated).toBe(true);

    const diagnostic = projectAgentTopology({ now, records: [historical, live], maxNodes: 2 });
    expect(diagnostic.nodes.map((node) => node.endpoint.runId)).toEqual(["a-history", "z-live"]);
    expect(diagnostic.truncated).toBe(false);
    expect(JSON.parse(renderAgentTopologyJson(diagnostic)).nodes).toHaveLength(2);
  });

  it("preserves host build identity through projection, redaction and JSON without guessing unknown builds", () => {
    const snapshot = projectAgentTopology({
      now,
      records: [
        { endpoint: endpoint("known", "main"), state: "idle", lastSeen: now, runtimeBuildId: "123456abcdef" },
        { endpoint: endpoint("unknown", "main"), state: "idle", lastSeen: now },
        { endpoint: endpoint("invalid", "main"), state: "idle", lastSeen: now, runtimeBuildId: "secret=private" },
      ],
    });
    for (const result of [snapshot, redactAgentTopologySnapshot(snapshot), JSON.parse(renderAgentTopologyJson(snapshot)) as typeof snapshot]) {
      expect(result.nodes.find((node) => node.endpoint.runId === "known")?.runtimeBuildId).toBe("123456abcdef");
      expect(result.nodes.find((node) => node.endpoint.runId === "unknown")).not.toHaveProperty("runtimeBuildId");
      expect(result.nodes.find((node) => node.endpoint.runId === "invalid")).not.toHaveProperty("runtimeBuildId");
      expect(JSON.stringify(result)).not.toContain("secret=private");
    }
    const hostile = { ...snapshot, nodes: [{ ...snapshot.nodes[0]!, runtimeBuildId: "/Users/private" }] };
    expect(renderAgentTopologyJson(hostile)).not.toContain("/Users/private");
  });

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

  it("keeps the default future-heartbeat policy strict but allows explicit bounded skew", () => {
    const record = { endpoint: endpoint("future-skew", "main"), state: "running", lastSeen: "2026-09-01T12:00:30Z" };
    expect(projectAgentTopology({ now, records: [record] }).nodes[0]?.state).toBe("offline");
    expect(projectAgentTopology({ now, maxFutureSkewMs: 60_000, records: [record] }).nodes[0]?.state)
      .toBe("active");
    expect(projectAgentTopology({ now, maxFutureSkewMs: 60_000, records: [{
      ...record,
      lastSeen: "2026-09-01T12:01:01Z",
    }] }).nodes[0]?.state).toBe("offline");
    expect(() => projectAgentTopology({ now, maxFutureSkewMs: CROSS_RUN_MAX_FUTURE_SKEW_MS + 1, records: [record] }))
      .toThrow(/maxFutureSkewMs/u);
  });

  it("filters relationship-derived edges by visibility and keeps missing heartbeats offline", () => {
    const main = endpoint("main-edge", "main");
    const child = endpoint("child-edge", "worker");
    const snapshot = projectAgentTopology({ now, records: [
      {
        endpoint: main,
        state: "idle",
        lastSeen: now,
        relationships: [{ endpoint: child, relation: "parent", visible: false }],
        children: [child],
      },
      { endpoint: child, state: "running" },
    ] });
    expect(snapshot.edges).toEqual([{ source: endpointKey(main), target: endpointKey(child), relation: "parent" }]);
    expect(snapshot.nodes.find((node) => node.endpoint.runId === "child-edge")?.lastSeen)
      .toBe("1970-01-01T00:00:00.000Z");
    expect(snapshot.nodes.find((node) => node.endpoint.runId === "child-edge")?.state).toBe("offline");
  });

  it("uses UTF-16 code-unit ordering and redacts hostile snapshots before JSON", () => {
    const records = ["\uE000", "\u{1F600}", "a", "A"].map((runId) => ({
      endpoint: endpoint(runId, "main"),
      state: "idle",
      lastSeen: now,
    }));
    const snapshot = projectAgentTopology({ now, records });
    expect(snapshot.nodes.map((node) => node.endpoint.runId)).toEqual(["A", "a", "\u{1F600}", "\uE000"]);

    const hostile = {
      ...snapshot,
      nodes: [{
        ...snapshot.nodes[0]!,
        endpoint: endpoint("/Users/private", "token=should-not-print"),
        key: "[\"/Users/private\",\"session\",\"run\",\"token=should-not-print\"]",
        activitySummary: "secret=value /Users/private",
      }],
      edges: [],
      roots: [],
    } as typeof snapshot;
    const redacted = JSON.parse(renderAgentTopologyJson(hostile)) as Record<string, unknown>;
    expect(JSON.stringify(redacted)).not.toContain("/Users/private");
    expect(JSON.stringify(redacted)).not.toContain("should-not-print");
    expect(redactAgentTopologySnapshot(hostile).nodes[0]?.endpoint.runId).toBe("[path]");
    expect(redactAgentTopologySnapshot(hostile).nodes[0]?.endpoint.laneId).toBe("[redacted]");
    expect(parseAgentTopologyFormat(undefined)).toBe("text");
    expect(parseAgentTopologyFormat("json")).toBe("json");
    expect(() => parseAgentTopologyFormat("yaml")).toThrow(/text or json/u);
  });

  it("provides a read-only CLI source and TUI component seam", () => {
    const source = { now, records: [{ endpoint: endpoint("source", "main"), state: "idle", lastSeen: now }] };
    expect(renderAgentTopologyFromSource(source, "json")).toContain("source");
    expect(createAgentTopologyPresenter(source).render("text")).toContain("source");
    const block = new AgentTopologyBlock(source);
    expect(block.render(120).join("\n")).toContain("source");
  });

  it("renders a Prime-style Agent Family around the current endpoint", () => {
    const current = endpoint("family-current", "main");
    const teto = endpoint("family-current", "teto");
    const sibling = endpoint("family-sibling", "main");
    const otherChild = endpoint("family-other", "worker");
    const otherSessionMain = endpoint("other-session", "main", "repo", "session-b");
    const finished = endpoint("finished-session", "main", "repo", "session-b");
    const snapshot = projectAgentTopology({
      now,
      records: [
        { endpoint: current, state: "running", lastSeen: now, activitySummary: "coordinating the current request", children: [teto] },
        { endpoint: teto, state: "idle", lastSeen: now },
        { endpoint: sibling, state: "offline", lastSeen: now },
        { endpoint: endpoint("family-other", "main"), state: "idle", lastSeen: now, children: [otherChild] },
        { endpoint: otherChild, state: "waiting", lastSeen: now, activitySummary: "reviewing the branch design" },
        { endpoint: otherSessionMain, state: "active", lastSeen: now, activitySummary: "checking another session" },
        { endpoint: finished, state: "terminal", lastSeen: now, activitySummary: "finished task" },
      ],
    });

    const coloredLines = renderAgentTopologyPanel(snapshot, 160, { currentEndpoint: current });
    const output = stripTerminalSequences(coloredLines.join("\n"));
    expect(coloredLines.some((line) => line.includes("\u001b["))).toBe(true);
    expect(coloredLines.every((line) => visibleWidth(stripTerminalSequences(line)) <= 160)).toBe(true);
    expect(output).toContain("Agent Family");
    expect(output).toContain("Current agent — main");
    expect(output).toContain("Current session");
    expect(output).toContain("Other sessions (1)");
    expect(output).toContain("session:session-b");
    expect(output).toContain("reviewing the branch design");
    expect(output).toContain("┌");
    expect(output).toContain("│ # │ Agent");
    expect(output).not.toContain("offline");
    expect(output).not.toContain("terminal");
    expect(output).toContain("run:family-current");
    expect(output).toContain("teto · run:family-current");
    expect(output).toContain("5 live agents");
    expect(renderAgentTopologyText(snapshot)).toContain("offline");
    expect(renderAgentTopologyText(snapshot)).toContain("terminal");
    expect(renderAgentTopologyJson(snapshot)).toContain("family-sibling");
  });

  it("shows snapshot time and distinct session builds while leaving unknown sessions explicit", () => {
    const current = endpoint("current-build", "main");
    const snapshot = projectAgentTopology({
      now,
      generatedAt: now,
      records: [
        { endpoint: current, state: "idle", lastSeen: now, runtimeBuildId: "aaaaaaaaaaaa" },
        { endpoint: endpoint("other-build", "main", "repo", "session-b"), state: "idle", lastSeen: now, runtimeBuildId: "bbbbbbbbbbbb" },
        { endpoint: endpoint("unknown-build", "main", "repo", "session-c"), state: "idle", lastSeen: now },
      ],
    });
    for (const width of [40, 80, 160]) {
      const lines = renderAgentTopologyPanel(snapshot, width, { currentEndpoint: current });
      const output = stripTerminalSequences(lines.join("\n"));
      expect(output).toContain(`Snapshot: ${now}`);
      expect(output).toContain("Build: aaaaaaaaaaaa");
      expect(output).toContain("Build: bbbbbbbbbbbb (different)");
      expect(output).toContain("Build: unknown");
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    expect(renderAgentTopologyText(snapshot)).toContain("session:session-b · Build: bbbbbbbbbbbb");
  });
});
