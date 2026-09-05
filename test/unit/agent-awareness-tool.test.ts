import { describe, expect, it } from "vitest";

import type { ToolExecutionContext } from "../../src/domain/ports.js";
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
      snapshot: typeof snapshot;
      guidance: { liveOnly: string; taskSummary: string };
    };

    expect(result.isError).toBe(false);
    expect(output.snapshot.nodes.map((node) => node.endpoint.runId)).toEqual(["current"]);
    expect(output.snapshot.edges).toEqual([]);
    expect(output.snapshot.nodes[0]?.activitySummary).toBe("coordinating the request");
    expect(output.guidance.liveOnly).toMatch(/terminal/iu);
    expect(output.guidance.taskSummary).toMatch(/activitySummary/iu);
  });
});
