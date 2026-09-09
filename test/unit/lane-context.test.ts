import { describe, expect, it } from "vitest";

import {
  createScopedSpawnContext,
  createTetoCapabilityManifest,
  renderLaneCapabilityManifest,
  validateSpawnContext,
} from "../../src/runtime/lane-context.js";

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

describe("Teto capability guidance", () => {
  it.each([false, true])("describes lifecycle controls without changing recommended=%s metadata", (recommended) => {
    const manifest = createTetoCapabilityManifest({
      workspaceId: "workspace",
      sessionId: "session",
      runId: "run",
      state: "dormant",
      recommended,
    });
    const lifecycle = manifest.capabilities.find((capability) => capability.kind === "lifecycle");
    expect(lifecycle?.name).toBe(recommended ? "recommended-for-this-run" : "optional-for-this-run");
    expect(lifecycle?.description).toContain("teto_stop to close this observer");
    expect(lifecycle?.description).toContain("teto_start to reopen it");
    expect(renderLaneCapabilityManifest([manifest])).toContain(lifecycle!.description);
    expect(manifest.role).toBe("Main-owned observer lane");
    expect(manifest.state).toBe("dormant");
    expect(manifest.targets).toEqual([{
      laneId: "main",
      relation: "owns",
      actions: ["message.inform", "question.ask", "question.answer"],
    }]);
    expect(manifest.capabilities.map((capability) => capability.kind)).toEqual(["observation", "a2a", "lifecycle"]);
  });

  it("preserves the identity and lifecycle of an existing Team-owned observer", () => {
    const manifest = createTetoCapabilityManifest({
      workspaceId: "workspace",
      sessionId: "session",
      runId: "run",
      mainLaneId: "team:review:a",
      tetoLaneId: "team:review:a:teto",
      state: "running",
    });
    expect(manifest.lane).toMatchObject({
      laneId: "team:review:a:teto",
      parentLaneId: "team:review:a",
      ownerLaneId: "team:review:a",
      relation: "observes",
    });
    expect(manifest.state).toBe("running");
    expect(manifest.targets?.[0]?.laneId).toBe("team:review:a");
    expect(manifest.capabilities.find((capability) => capability.kind === "lifecycle")?.name).toBe("optional-for-this-run");
  });
});
