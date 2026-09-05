import { describe, expect, it } from "vitest";

import type { AgentTool } from "../../src/domain/ports.js";
import {
  createWorkspaceMoweCatalog,
  createWorkspaceMoweCatalogSnapshot,
} from "../../src/mowe/workspace-catalog.js";

const edgeTool = (name = "edge_lookup"): AgentTool => ({
  definition: {
    name,
    description: "Read evidence from an edge source",
    parameters: { type: "object", additionalProperties: false },
  },
  execute: async () => ({ content: "edge result", isError: false }),
});

describe("workspace Mowe catalog edge seam", () => {
  it("captures edge tools and metadata in a Turn-local generation", () => {
    const snapshot = createWorkspaceMoweCatalogSnapshot({
      edgeSnapshot: {
        generation: 7,
        tools: [edgeTool()],
        metadataByName: {
          edge_lookup: {
            effect: "read",
            scope: "run",
            version: "edge-v1",
            deterministic: true,
          },
        },
      },
    });

    expect(snapshot.generation).toBe(7);
    expect(snapshot.capabilities.find((entry) => entry.name === "edge_lookup"))
      .toMatchObject({
        name: "edge_lookup",
        metadata: {
          effect: "read",
          scope: "run",
          version: "edge-v1",
          deterministic: true,
        },
      });
    expect(snapshot.catalog.get("edge_lookup")?.metadata.version).toBe("edge-v1");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.capabilities)).toBe(true);
  });

  it("keeps the first-party catalog path unchanged when no edge snapshot is supplied", () => {
    const catalog = createWorkspaceMoweCatalog({});
    expect(catalog.has("read_file")).toBe(true);
    expect(catalog.has("edge_lookup")).toBe(false);
    expect(createWorkspaceMoweCatalogSnapshot({}).generation).toBe(0);
  });

  it("copies a registry snapshot before exposing it to a catalog", () => {
    const tools = [edgeTool()];
    const snapshot = createWorkspaceMoweCatalogSnapshot({
      edgeSnapshot: { generation: 2, tools },
    });
    tools.push(edgeTool("edge_second"));

    expect(snapshot.catalog.has("edge_lookup")).toBe(true);
    expect(snapshot.catalog.has("edge_second")).toBe(false);
    expect(() => createWorkspaceMoweCatalogSnapshot({
      edgeSnapshot: { generation: -1, tools: [] },
    })).toThrow(/generation/i);
  });

  it("rejects edge names that collide with first-party tools", () => {
    expect(() => createWorkspaceMoweCatalog({
      edgeSnapshot: { generation: 1, tools: [edgeTool("read_file")] },
    })).toThrow(/duplicate tool: read_file/i);
  });
});
