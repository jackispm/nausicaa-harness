import { describe, expect, it } from "vitest";

import {
  capabilityEntriesFromTools,
  createLaneCapabilityManifest,
  createScopedSpawnContext,
  createTetoCapabilityManifest,
  MAX_LANE_METADATA_LENGTH,
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
  it("accepts a scoped task without host limits and still validates supplied limits", () => {
    const scoped = { ...context(), budget: {} };
    expect(() => validateSpawnContext(scoped)).not.toThrow();
    expect(() => validateSpawnContext({ ...scoped, budget: { maxModelTokens: 0 } })).toThrow(/maxModelTokens/);
    expect(() => validateSpawnContext({ ...scoped, budget: { maxAttempts: "unlimited" } })).toThrow(/maxAttempts/);
  });

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

  it.each([
    ["empty", ""],
    ["whitespace", "  "],
    ["overlong", "description ".repeat(100)],
  ])("normalizes %s host descriptions in both tool entries and the lane manifest", (_label, description) => {
    const tools = [{ name: "third_party", kind: "tool" as const, description }];
    const skills = [{ name: "review", kind: "skill" as const, description }];
    const scoped = createScopedSpawnContext({
      parent: { workspaceId: "workspace", sessionId: "session", runId: "run", laneId: "main", laneKind: "main" },
      child: { workspaceId: "workspace", sessionId: "session", runId: "run", laneId: "worker", laneKind: "worker", parentLaneId: "main", ownerLaneId: "main", relation: "delegates" },
      goal: { version: 1, statement: "Inspect", successCriteria: [], hardConstraints: [] },
      inputRefs: [], budget: { maxModelTokens: 100, maxWallClockMs: 1_000 }, role: "Worker",
      tools, skills,
    });
    for (const capability of [...scoped.tools, ...scoped.skills, ...scoped.laneManifest.capabilities]) {
      expect(capability.description?.trim().length).toBeGreaterThan(0);
      expect(capability.description!.length).toBeLessThanOrEqual(MAX_LANE_METADATA_LENGTH);
    }
    expect(scoped.laneManifest.capabilities).toEqual([...scoped.tools, ...scoped.skills]);
    expect(tools[0]?.description).toBe(description);
    expect(skills[0]?.description).toBe(description);
    expect(() => validateSpawnContext(scoped)).not.toThrow();
  });

  it("bounds catalog summaries without mutating the model-facing tool definition or schema", () => {
    const definition = {
      name: "long_description",
      description: "Full tool instructions. ".repeat(100),
      parameters: { type: "object", properties: { path: { type: "string", description: "Full argument instructions. ".repeat(100) } } },
    };
    const original = structuredClone(definition);
    const capabilities = capabilityEntriesFromTools([{ definition }]);
    expect(capabilities[0]?.description).toHaveLength(MAX_LANE_METADATA_LENGTH);
    const manifest = createLaneCapabilityManifest({
      ...context().laneManifest,
      capabilities: [{ name: definition.name, kind: "tool", description: definition.description }],
    });
    expect(manifest.capabilities).toEqual(capabilities);
    expect(definition).toEqual(original);
  });

  it("still rejects overlong descriptions in untrusted or recovered contexts", () => {
    const scoped = context();
    const description = "x".repeat(MAX_LANE_METADATA_LENGTH + 1);
    expect(() => validateSpawnContext({
      ...scoped, tools: [{ ...scoped.tools[0], description }],
    })).toThrow("spawnContext.tools[0].description");
    expect(() => validateSpawnContext({
      ...scoped,
      laneManifest: { ...scoped.laneManifest, capabilities: [{ ...scoped.laneManifest.capabilities[0], description }] },
    })).toThrow("laneManifest.capabilities[0].description");
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
    expect(manifest.role).toBe("Teto, auxiliary observer for Nausicaa");
    expect(renderLaneCapabilityManifest([manifest])).toContain("A2A owns nausicaa");
    expect(renderLaneCapabilityManifest([manifest])).not.toMatch(/\bmain\b/iu);
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
