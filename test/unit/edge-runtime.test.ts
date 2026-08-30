import { describe, expect, it } from "vitest";

import type { AgentTool } from "../../src/domain/ports.js";
import {
  captureEdgeTurnSnapshot,
  createRegistryEdgeTurnSnapshotProvider,
  projectEdgeRegistrySnapshot,
} from "../../src/runtime/edge-runtime.js";

const tool: AgentTool = {
  definition: {
    name: "edge_read",
    description: "read",
    parameters: { type: "object", additionalProperties: false },
  },
  execute: async () => ({ content: "ok", isError: false }),
};

describe("edge runtime projection", () => {
  it("projects admitted tools and selected Skill context without mutating a registry", async () => {
    let captures = 0;
    const provider = createRegistryEdgeTurnSnapshotProvider({
      snapshot: () => ({
        generation: 4,
        tools: [{ sourceId: "mcp-a", tool, metadata: { effect: "read", scope: "run" } }],
        contextContributions: [{
          sourceId: "skills-a",
          contributionId: "skill-a",
          sourceType: "skill",
          name: "review",
          description: "Review changes",
          disabled: false,
          contentHash: "sha256:unused",
        }],
        edges: [{ sourceId: "mcp-a", kind: "mcp", health: "healthy", tools: [] }],
      }),
      loadContribution: async (summary) => {
        captures += 1;
        return { ...summary as object, body: "untrusted guidance" };
      },
    });
    const projection = await captureEdgeTurnSnapshot(provider);
    expect(captures).toBe(1);
    expect(projection.generation).toBe(4);
    expect(projection.tools).toEqual([tool]);
    expect(projection.contextContributions[0]?.body).toContain("untrusted");
    expect(Object.isFrozen(projection)).toBe(true);
    const second = await captureEdgeTurnSnapshot(provider);
    expect(second.generation).toBe(4);
  });

  it("omits disabled or malformed context and never creates fake tools", () => {
    const projection = projectEdgeRegistrySnapshot({
      generation: 2,
      contextContributions: [
        { sourceId: "s", contributionId: "disabled", sourceType: "skill", name: "x", description: "x", disabled: true, body: "no" },
        { sourceId: "s", contributionId: "summary", sourceType: "skill", name: "x", description: "x", disabled: false },
      ],
    });
    expect(projection.tools).toHaveLength(0);
    expect(projection.contextContributions).toHaveLength(0);
  });

  it("loads summaries when a configured composition exposes its registry", async () => {
    let loaded = 0;
    const projection = await captureEdgeTurnSnapshot({
      snapshot: () => ({
        generation: 5,
        contextContributions: [{
          sourceId: "skills",
          contributionId: "selected",
          sourceType: "skill",
          name: "selected",
          description: "selected",
          disabled: false,
        }],
      }),
      registry: {
        snapshot: () => undefined,
        loadContribution: async (summary: Record<string, unknown>) => {
          loaded += 1;
          return { ...summary, body: "loaded body" };
        },
      },
    });
    expect(loaded).toBe(1);
    expect(projection.contextContributions[0]?.body).toBe("loaded body");
  });
});
