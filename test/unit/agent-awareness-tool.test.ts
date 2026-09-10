import { describe, expect, it, vi } from "vitest";

import { endpointKey } from "../../src/a2a/cross-run-contract.js";
import type { ToolExecutionContext } from "../../src/domain/ports.js";
import type { CrossRunEndpoint } from "../../src/domain/types.js";
import { createAgentAwarenessTool } from "../../src/runtime/agent-awareness-tool.js";
import { projectAgentTopology } from "../../src/runtime/agent-awareness.js";

const now = "2026-09-05T12:00:00.000Z";

function endpoint(runId: string, laneId: string) {
  return {
    workspaceId: "workspace",
    sessionId: "session-a",
    runId,
    laneId,
  };
}

describe("agent awareness tool", () => {
  it("returns live lanes with bounded task summaries instead of history rows", async () => {
    const current = endpoint("current", "main");
    const finished = endpoint("finished", "worker");
    const abandoned = endpoint("abandoned", "main");
    const snapshot = projectAgentTopology({
      now,
      records: [
        { endpoint: current, state: "running", lastSeen: now, activitySummary: "coordinating the request" },
        { endpoint: finished, state: "terminal", lastSeen: now, activitySummary: "finished" },
        { endpoint: abandoned, state: "offline", lastSeen: now, activitySummary: "stale" },
      ],
      edges: [{ source: current, target: finished, relation: "parent" }],
    });
    const tool = createAgentAwarenessTool({ read: () => snapshot });
    const context = {
      runId: "current",
      workspace: "/workspace",
      operationId: "awareness-test",
    } as ToolExecutionContext;

    const result = await tool.execute({}, context);
    const output = JSON.parse(result.content) as {
      self: CrossRunEndpoint | null;
      snapshot: typeof snapshot;
      guidance: { liveOnly: string; taskSummary: string; team: string };
    };

    expect(result.isError).toBe(false);
    expect(output.self).toBeNull();
    expect(output.snapshot.nodes.map((node) => node.endpoint.runId)).toEqual(["current"]);
    expect(output.snapshot.edges).toEqual([]);
    expect(output.snapshot.nodes[0]?.activitySummary).toBe("coordinating the request");
    expect(output.guidance.liveOnly).toMatch(/terminal/iu);
    expect(output.guidance.taskSummary).toMatch(/activitySummary/iu);
    expect(output.guidance.team).toMatch(/creat\w*.*Team Lead/iu);
    expect(output.guidance.team).toContain("Run forks are not Team members");
  });

  it("keeps host-bound self explicit when only another session is discovered", async () => {
    const self = endpoint("my-run", "main");
    const expectedSelf = { ...self, laneId: "nausicaa" };
    const otherMain = { ...endpoint("other-run", "main"), sessionId: "other-session" };
    const otherTeto = { ...otherMain, laneId: "teto" };
    const snapshot = projectAgentTopology({
      now,
      records: [otherMain, otherTeto].map((target) => ({
        endpoint: target, state: "idle", lastSeen: now,
      })),
      edges: [{ source: otherMain, target: otherTeto, relation: "parent" }],
    });
    const tool = createAgentAwarenessTool({ self, read: () => snapshot });
    self.sessionId = "changed-after-tool-creation";
    const result = await tool.execute({}, {
      runId: "my-run", laneId: "main", workspace: "/workspace", operationId: "inspect",
    });
    const output = JSON.parse(result.content) as {
      self: CrossRunEndpoint;
      snapshot: typeof snapshot;
      guidance: { identity: string; discovery: string; messaging: string };
    };

    expect(result.isError).toBe(false);
    expect(output.self).toEqual(expectedSelf);
    expect(output.snapshot.nodes.map((node) => node.endpoint)).toEqual([
      { ...otherMain, laneId: "nausicaa" }, otherTeto,
    ]);
    expect(output.guidance.identity).toContain("even if absent from the snapshot");
    expect(output.guidance.discovery).toContain("its Nausicaa and Teto are not your own lanes");
    expect(output.guidance.discovery).toContain("Missing nodes do not prove an agent does not exist");
    expect(output.guidance.messaging).toContain("Visibility does not grant permission");
    expect(output.guidance.messaging).toContain("your own Run only");
    expect(output.guidance.messaging).toContain("{relationship:'direct',id:'session-id'}");
    expect(output.guidance.messaging).toContain("not automatically direct message targets");
  });

  it("returns matching self, graph addresses, and readable names while preserving the host snapshot", async () => {
    const self = endpoint("my-run", "main");
    const worker = endpoint("my-run", "worker");
    const secondWorker = endpoint("my-run", "team:research:worker-2");
    const reviewer = endpoint("my-run", "team:research:reviewer");
    const snapshot = projectAgentTopology({
      now,
      records: [self, worker, secondWorker, reviewer].map((endpoint) => ({
        endpoint, state: "running", lastSeen: now,
        activitySummary: "Review main.ts on the main branch",
      })),
      edges: [worker, secondWorker, reviewer].map((target) => ({
        source: self, target, relation: "parent",
      })),
    });
    const original = structuredClone(snapshot);
    const tool = createAgentAwarenessTool({ self, read: () => snapshot });
    const result = await tool.execute({}, {
      runId: self.runId, laneId: "main", workspace: "/workspace", operationId: "inspect",
    });
    const output = JSON.parse(result.content) as {
      self: CrossRunEndpoint;
      snapshot: Omit<typeof snapshot, "nodes"> & {
        nodes: (typeof snapshot.nodes[number] & { name: string })[];
      };
    };

    expect(result.isError).toBe(false);
    expect(output.self).toEqual({ ...self, laneId: "nausicaa" });
    const selfKey = endpointKey(output.self);
    const root = output.snapshot.nodes.find((node) => node.key === selfKey);
    expect(root).toMatchObject({ endpoint: output.self, name: "Nausicaa", role: "nausicaa" });
    expect(output.snapshot.roots).toEqual([selfKey]);
    expect(output.snapshot.edges).toHaveLength(3);
    const keys = new Set(output.snapshot.nodes.map((node) => node.key));
    for (const edge of output.snapshot.edges) {
      expect(edge.source).toBe(selfKey);
      expect(keys.has(edge.target)).toBe(true);
    }
    expect([...keys]).not.toContain(endpointKey(self));
    expect(output.snapshot.nodes.map((node) => [node.endpoint.laneId, node.name])).toEqual(expect.arrayContaining([
      ["worker", "worker 1"],
      ["team:research:worker-2", "worker 2"],
      ["team:research:reviewer", "reviewer"],
    ]));
    expect(output.snapshot.nodes.every((node) => node.activitySummary === "Review main.ts on the main branch")).toBe(true);
    expect(snapshot).toEqual(original);
    expect(self.laneId).toBe("main");
  });

  it.each([
    { runId: "another-run", laneId: "main" },
    { runId: "my-run", laneId: "teto" },
    { runId: "my-run", laneId: "nausicaa" },
  ])("rejects use by a different bound caller: $runId/$laneId", async (caller) => {
    const read = vi.fn(() => projectAgentTopology({ now, records: [] }));
    const tool = createAgentAwarenessTool({ self: endpoint("my-run", "main"), read });
    const result = await tool.execute({}, {
      ...caller, workspace: "/workspace", operationId: "inspect",
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      error: "Agent awareness capability is bound to another Run or lane",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("validates complete self endpoints and redacts private labels", async () => {
    const read = () => projectAgentTopology({ now, records: [] });
    expect(() => createAgentAwarenessTool({
      self: { ...endpoint("my-run", "main"), sessionId: "" }, read,
    })).toThrow();
    const tool = createAgentAwarenessTool({
      self: { ...endpoint("my-run", "main"), workspaceId: "/Users/private/project" }, read,
    });
    const result = await tool.execute({}, {
      runId: "my-run", laneId: "main", workspace: "/workspace", operationId: "inspect",
    });
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("/Users/private/project");
    expect(JSON.parse(result.content).self).toEqual({
      ...endpoint("my-run", "nausicaa"), workspaceId: "[path]",
    });
  });
});
