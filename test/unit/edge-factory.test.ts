import { describe, expect, it, vi } from "vitest";

import type { AgentTool } from "../../src/domain/ports.js";
import {
  createEdgeCapability,
  createEdgeManifest,
} from "../../src/mowe/edge-adapter.js";
import type { EdgeAdapter, EdgeManifest } from "../../src/mowe/edge-types.js";
import {
  createConfiguredEdgeComposition,
  type EdgeAdapterConstructor,
} from "../../src/config/edge-factory.js";
import type { EdgeSettings } from "../../src/config/settings.js";

function tool(name: string): AgentTool {
  return {
    definition: {
      name,
      description: `factory ${name}`,
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    execute: async () => ({ content: name, isError: false }),
  };
}

function makeAdapter(sourceId: string, sourceType: "mcp" | "skill", name: string, release = vi.fn()): EdgeAdapter {
  const manifest = createEdgeManifest({
    manifestVersion: 1,
    sourceId,
    sourceType,
    capabilityName: name,
    capabilityVersion: "1",
    schemaVersion: "2020-12",
    description: `factory ${name}`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object", properties: {}, additionalProperties: false },
    effect: "read",
    scope: "workspace",
    cancellable: true,
    idempotent: true,
    recovery: "retry",
    adapterVersion: "1",
    adapterCompatibility: ">=1",
    provenance: {
      upstreamName: sourceId,
      upstreamVersion: "1",
      license: "MIT",
      sourceUri: `fake:${sourceId}`,
    },
  });
  return {
    sourceId,
    sourceType,
    discover: async () => [manifest],
    load: async (candidate: EdgeManifest) => createEdgeCapability({ manifest: candidate, tool: tool(name) }),
    release: async () => release(),
  };
}

describe("configured edge factory", () => {
  it("keeps defaults inert and does not invoke constructors", async () => {
    const constructor = vi.fn<EdgeAdapterConstructor>();
    const composition = await createConfiguredEdgeComposition({
      workspace: "/workspace",
      settings: {},
      constructors: { mcp: constructor },
    });
    expect(constructor).not.toHaveBeenCalled();
    expect(composition.sourcePlan).toEqual([]);
    expect(composition.snapshot().tools).toEqual([]);
    await composition.close();
  });

  it("starts configured authorized sources by default and preserves per-source opt-outs", async () => {
    const release = vi.fn();
    const constructor = vi.fn(async (source) => makeAdapter(source.sourceId, "mcp", "factory_tool", release));
    const settings: EdgeSettings = {
      sources: [
        { sourceId: "docs", type: "mcp", command: "fake", enabled: true },
        { sourceId: "off", type: "mcp", command: "fake", enabled: false },
      ],
      grants: [{ sourceId: "docs", effects: ["read"], scopes: ["workspace"], allowWithoutApproval: true }],
    };
    const composition = await createConfiguredEdgeComposition({
      workspace: "/workspace",
      settings,
      constructors: { mcp: constructor },
    });
    expect(constructor).toHaveBeenCalledOnce();
    expect(composition.sourcePlan).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: "docs", status: "constructed" }),
      expect.objectContaining({ sourceId: "off", status: "disabled" }),
    ]));
    expect(composition.snapshot().catalog.has("factory_tool")).toBe(true);
    expect(composition.snapshot().tools[0]?.metadata).toMatchObject({ effect: "read", scope: "workspace" });
    await composition.close();
    await composition.close();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "no grant", grants: [] },
    { name: "a different source grant", grants: [{ sourceId: "other", effects: ["read"] as const, scopes: ["workspace"] as const }] },
  ])("does not start MCP transports with $name", async ({ grants }) => {
    const constructor = vi.fn<EdgeAdapterConstructor>();
    const composition = await createConfiguredEdgeComposition({
      workspace: "/workspace",
      settings: {
        sources: [
          { sourceId: "stdio", type: "mcp", command: "fake" },
          { sourceId: "remote", type: "mcp", endpoint: "https://example.test/mcp" },
        ],
        grants,
      },
      constructors: { mcp: constructor },
    });
    expect(constructor).not.toHaveBeenCalled();
    expect(composition.sourcePlan).toEqual([
      expect.objectContaining({ sourceId: "remote", status: "rejected" }),
      expect.objectContaining({ sourceId: "stdio", status: "rejected" }),
    ]);
    expect(composition.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: "stdio", code: "missing-host-grant" }),
      expect.objectContaining({ sourceId: "remote", code: "missing-host-grant" }),
    ]));
    await composition.refresh();
    expect(constructor).not.toHaveBeenCalled();
    expect(composition.snapshot().tools).toEqual([]);
    await composition.close();
  });

  it("keeps the explicit global opt-out effective even for an authorized source", async () => {
    const constructor = vi.fn<EdgeAdapterConstructor>();
    const composition = await createConfiguredEdgeComposition({
      workspace: "/workspace",
      settings: {
        enabled: false,
        sources: [{ sourceId: "docs", type: "mcp", command: "fake" }],
        grants: [{ sourceId: "docs", effects: ["read"], scopes: ["workspace"] }],
      },
      constructors: { mcp: constructor },
    });
    expect(constructor).not.toHaveBeenCalled();
    expect(composition.sourcePlan).toEqual([
      expect.objectContaining({ sourceId: "docs", status: "disabled" }),
    ]);
    await composition.close();
  });

  it("keeps startup discovery explicitly suppressible for configured authorized sources", async () => {
    const discover = vi.fn(async () => []);
    const composition = await createConfiguredEdgeComposition({
      workspace: "/workspace",
      settings: {
        refreshOnStart: false,
        sources: [{ sourceId: "docs", type: "mcp", command: "fake" }],
        grants: [{ sourceId: "docs", effects: ["read"], scopes: ["workspace"] }],
      },
      constructors: {
        mcp: (source) => ({ ...makeAdapter(source.sourceId, "mcp", "factory_tool"), discover }),
      },
    });
    expect(discover).not.toHaveBeenCalled();
    await composition.refresh();
    expect(discover).toHaveBeenCalledOnce();
    await composition.close();
  });

  it("preserves approval requirements and refuses capabilities outside their grant", async () => {
    const composition = await createConfiguredEdgeComposition({
      workspace: "/workspace",
      settings: {
        sources: [
          { sourceId: "docs", type: "mcp", command: "fake" },
          { sourceId: "restricted", type: "mcp", command: "fake" },
        ],
        grants: [
          { sourceId: "docs", effects: ["read"], scopes: ["workspace"] },
          { sourceId: "restricted", effects: ["compute"], scopes: ["workspace"] },
        ],
      },
      constructors: { mcp: (source) => makeAdapter(source.sourceId, "mcp", `${source.sourceId}_tool`) },
    });
    expect(composition.snapshot().tools).toHaveLength(1);
    expect(composition.snapshot().tools[0]).toMatchObject({
      name: "docs_tool",
      metadata: { effect: "read", scope: "workspace", requiresApproval: true },
    });
    expect(composition.snapshot().catalog.has("restricted_tool")).toBe(false);
    await composition.close();
  });

  it("rejects plugins, records missing constructors, and redacts constructor failures", async () => {
    const failing = vi.fn(async () => { throw new Error("secret command and token"); });
    const composition = await createConfiguredEdgeComposition({
      workspace: "/workspace",
      settings: {
        enabled: true,
        sources: [
          { sourceId: "plugin", type: "plugin", location: "./plugin" },
          { sourceId: "skill", type: "skill", location: "./skills" },
          { sourceId: "broken", type: "mcp", command: "secret-command" },
        ],
        grants: [{ sourceId: "broken", effects: ["read"], scopes: ["workspace"] }],
      },
      constructors: { mcp: failing },
    });
    expect(composition.snapshot().tools).toEqual([]);
    expect(composition.sourcePlan).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: "plugin", status: "rejected" }),
      expect.objectContaining({ sourceId: "skill", status: "planned" }),
      expect.objectContaining({ sourceId: "broken", status: "failed" }),
    ]));
    expect(composition.diagnostics.some((item) => item.message.includes("secret"))).toBe(false);
    await composition.close();
  });

  it("reports grants without a matching source deterministically", async () => {
    const composition = await createConfiguredEdgeComposition({
      workspace: "/workspace",
      settings: {
        enabled: false,
        grants: [{ sourceId: "orphan", effects: ["external"], scopes: ["host"] }],
      },
    });
    expect(composition.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "orphan-grant", sourceId: "orphan" }),
    ]));
    await composition.close();
  });
});
