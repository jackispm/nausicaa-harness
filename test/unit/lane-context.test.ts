import { describe, expect, it } from "vitest";

import { createScopedSpawnContext, validateSpawnContext } from "../../src/runtime/lane-context.js";

function context() {
  return createScopedSpawnContext({
    parent: { workspaceId: "workspace", sessionId: "session", runId: "run", laneId: "main", laneKind: "main" },
    child: { workspaceId: "workspace", sessionId: "session", runId: "run", laneId: "team:review:a", laneKind: "team", parentLaneId: "main", ownerLaneId: "main", relation: "member-of" },
    goal: { version: 1, statement: "Review evidence", successCriteria: [], hardConstraints: [] },
    inputRefs: [], budget: { maxModelTokens: 100, maxWallClockMs: 1_000 },
    role: "Team member", tools: [{ name: "agent_message", kind: "tool" }],
  });
}

describe("scoped lane context validation", () => {
  it("accepts omitted optional metadata and deadline fields", () => {
    const scoped = context();
    expect(scoped.tools[0]).not.toHaveProperty("description");
    expect(scoped.laneManifest.targets).toBeUndefined();
    expect(scoped.budget.deadline).toBeUndefined();
    expect(() => validateSpawnContext(scoped)).not.toThrow();
  });

  it("still rejects missing required metadata and unknown fields", () => {
    const scoped = context();
    const { name: _name, ...missingName } = scoped.tools[0]!;
    expect(() => validateSpawnContext({ ...scoped, tools: [missingName] })).toThrow("name is required");
    expect(() => validateSpawnContext({ ...scoped, privateHistory: [] })).toThrow("privateHistory is not allowed");
  });
});
