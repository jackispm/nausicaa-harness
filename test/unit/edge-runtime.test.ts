import { describe, expect, it } from "vitest";

import type { AgentTool } from "../../src/domain/ports.js";
import {
  appendPermittedEdgeTools,
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
    }, (summary) => (summary as { contributionId?: string }).contributionId === "skill-a");
    const projection = await captureEdgeTurnSnapshot(provider);
    expect(captures).toBe(1);
    expect(projection.generation).toBe(4);
    expect(projection.tools).toEqual([tool]);
    expect(projection.contextContributions[0]?.body).toContain("untrusted");
    expect(Object.isFrozen(projection)).toBe(true);
    const second = await captureEdgeTurnSnapshot(provider);
    expect(second.generation).toBe(4);
  });

  it("does not load Skill bodies without an explicit host selector", async () => {
    let loads = 0;
    const provider = createRegistryEdgeTurnSnapshotProvider({
      snapshot: () => ({
        generation: 7,
        contextContributions: [{
          sourceId: "skills",
          contributionId: "unselected",
          sourceType: "skill",
          name: "unselected",
          description: "unselected",
          disabled: false,
        }],
      }),
      loadContribution: async (summary: Record<string, unknown>) => {
        loads += 1;
        return { ...summary, body: "must not load" };
      },
    });

    const projection = await captureEdgeTurnSnapshot(provider);
    expect(loads).toBe(0);
    expect(projection.contextContributions).toEqual([]);
    expect(projection.status.contextCount).toBe(1);
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
    expect(projection.status.contextCount).toBe(1);
  });

  it("loads summaries when a configured composition exposes its registry", async () => {
    let loaded = 0;
    const projection = await captureEdgeTurnSnapshot(createRegistryEdgeTurnSnapshotProvider({
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
      loadContribution: async (summary: Record<string, unknown>) => {
        loaded += 1;
        return { ...summary, body: "loaded body" };
      },
    }, (summary) => (summary as { contributionId?: string }).contributionId === "selected"));
    expect(loaded).toBe(1);
    expect(projection.contextContributions[0]?.body).toBe("loaded body");
  });

  it("isolates a selected Skill load failure without hiding valid context", async () => {
    const summaries = ["broken", "valid"].map((contributionId) => ({
      sourceId: "skills",
      contributionId,
      sourceType: "skill",
      name: contributionId,
      description: contributionId,
      disabled: false,
    }));
    const projection = await captureEdgeTurnSnapshot(createRegistryEdgeTurnSnapshotProvider({
      snapshot: () => ({ generation: 6, contextContributions: summaries }),
      loadContribution: async (summary: Record<string, unknown>) => {
        if (summary.contributionId === "broken") throw new Error("body changed while loading");
        return { ...summary, body: "valid body" };
      },
    }, () => true));

    expect(projection.contextContributions).toEqual([
      expect.objectContaining({ contributionId: "valid", body: "valid body" }),
    ]);
    expect(projection.status.diagnostics).toEqual([
      expect.stringMatching(/broken.*changed while loading/iu),
    ]);
  });

  it("bounds selected Skill loads deterministically with fixed concurrency", async () => {
    const summaries = Array.from({ length: 20 }, (_, index) => {
      const contributionId = `skill-${String(19 - index).padStart(2, "0")}`;
      return {
        sourceId: "skills",
        contributionId,
        sourceType: "skill",
        name: contributionId,
        description: contributionId,
        disabled: false,
      };
    });
    let loads = 0;
    let active = 0;
    let peak = 0;
    const projection = await captureEdgeTurnSnapshot(createRegistryEdgeTurnSnapshotProvider({
      snapshot: () => ({ generation: 8, contextContributions: summaries }),
      loadContribution: async (summary: Record<string, unknown>) => {
        loads += 1;
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return { ...summary, body: "bounded body" };
      },
    }, () => true));

    expect(loads).toBe(16);
    expect(peak).toBe(4);
    expect(projection.contextContributions.map((item) => item.contributionId)).toEqual(
      Array.from({ length: 16 }, (_, index) => `skill-${String(index).padStart(2, "0")}`),
    );
  });

  it("isolates oversized Skill bodies and enforces the aggregate context budget", async () => {
    const summaries = ["oversized", "oversized-description", "a", "b", "c", "d", "e"]
      .map((contributionId) => ({
      sourceId: "skills",
      contributionId,
      sourceType: "skill",
      name: contributionId,
      description: contributionId,
      disabled: false,
      }));
    const projection = await captureEdgeTurnSnapshot(createRegistryEdgeTurnSnapshotProvider({
      snapshot: () => ({ generation: 9, contextContributions: summaries }),
      loadContribution: async (summary: Record<string, unknown>) => ({
        ...summary,
        description: summary.contributionId === "oversized-description"
          ? "d".repeat(4 * 1024 + 1)
          : summary.description,
        body: summary.contributionId === "oversized"
          ? "x".repeat(64 * 1024 + 1)
          : "x".repeat(60 * 1024),
      }),
    }, () => true));

    expect(projection.contextContributions.map((item) => item.contributionId)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(projection.status.diagnostics).toEqual(expect.arrayContaining([
      expect.stringMatching(/oversized.*body exceeds/iu),
      expect.stringMatching(/oversized-description.*description exceeds/iu),
      expect.stringMatching(/e.*total limit/iu),
    ]));
  });

  it("keeps host tools ahead of colliding edge names", () => {
    const hostTool = { ...tool, definition: { ...tool.definition, name: "read_file" } };
    const edgeTool = { ...tool, definition: { ...tool.definition, name: "read_file" } };
    const merged = appendPermittedEdgeTools(
      [hostTool],
      {
        generation: 1,
        tools: [edgeTool],
        metadataByName: { read_file: { effect: "read", scope: "run" } },
      },
      { allowWrite: false, allowShell: false, allowNetwork: false },
    );
    expect(merged).toEqual([hostTool]);
  });

  it("normalizes edge names before applying host collision and reserved-name checks", () => {
    const hostTool = { ...tool, definition: { ...tool.definition, name: "read_file" } };
    const edgeTool = { ...tool, definition: { ...tool.definition, name: " read_file " } };
    const reservedTool = { ...tool, definition: { ...tool.definition, name: " artifact_read " } };
    const merged = appendPermittedEdgeTools(
      [hostTool],
      {
        generation: 1,
        tools: [edgeTool, reservedTool],
        metadataByName: { " read_file ": { effect: "read", scope: "run" } },
      },
      { allowWrite: true, allowShell: true, allowNetwork: true },
    );
    expect(merged).toEqual([hostTool]);
  });

  it("keeps the run-authorized artifact reader name reserved for Main", () => {
    const edgeArtifactReader = { ...tool, definition: { ...tool.definition, name: "artifact_read" } };
    const merged = appendPermittedEdgeTools(
      [],
      {
        generation: 1,
        tools: [edgeArtifactReader],
        metadataByName: { artifact_read: { effect: "read", scope: "run" } },
      },
      { allowWrite: true, allowShell: true, allowNetwork: true },
    );
    expect(merged).toEqual([]);
  });
});
