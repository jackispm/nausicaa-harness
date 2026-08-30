import { describe, expect, it } from "vitest";

import type { AgentTool } from "../../src/domain/ports.js";
import { MoweExecutor } from "../../src/mowe/executor.js";
import { MoweCatalog } from "../../src/mowe/catalog.js";
import {
  createEdgeCapability,
  createEdgeManifest,
} from "../../src/mowe/edge-adapter.js";
import {
  MoweEdgeRegistry,
  MoweEdgeRegistryError,
} from "../../src/mowe/edge-registry.js";
import type { EdgeAdapter, EdgeManifest, EdgeSourceType } from "../../src/mowe/edge-types.js";

function tool(name: string, result = name): AgentTool {
  return {
    definition: {
      name,
      description: `fake ${name}`,
      parameters: { type: "object", additionalProperties: false },
    },
    execute: async () => ({ content: result, isError: false }),
  };
}

function manifest(sourceId: string, name: string, sourceType: EdgeSourceType = "plugin", effect: "read" | "write" = "read"): EdgeManifest {
  return createEdgeManifest({
    manifestVersion: 1,
    sourceId,
    sourceType,
    capabilityName: name,
    capabilityVersion: "1.0.0",
    schemaVersion: "2020-12",
    description: `fake ${name}`,
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object", additionalProperties: false },
    effect,
    scope: effect === "write" ? "workspace" : "run",
    cancellable: true,
    idempotent: effect === "read",
    recovery: effect === "read" ? "retry" : "none",
    adapterVersion: "1.0.0",
    adapterCompatibility: ">=1",
    provenance: {
      upstreamName: `fake-${sourceId}`,
      upstreamVersion: "1.0.0",
      license: "MIT",
      sourceUri: `fake:${sourceId}`,
    },
  });
}

function adapter(
  sourceId: string,
  names: readonly string[],
  options: { sourceType?: EdgeSourceType; fail?: boolean; effects?: Readonly<Record<string, "read" | "write">>; onRelease?: () => void } = {},
): EdgeAdapter {
  const manifests = names.map((name) => manifest(sourceId, name, options.sourceType, options.effects?.[name] ?? "read"));
  return {
    sourceId,
    sourceType: options.sourceType ?? "plugin",
    discover: async () => {
      if (options.fail) throw new Error(`fake ${sourceId} failed`);
      return manifests;
    },
    load: async (candidate) => createEdgeCapability({
      manifest: candidate,
      tool: tool(candidate.capabilityName),
    }),
    release: async () => options.onRelease?.(),
  };
}

describe("Mowe edge registry", () => {
  it("rejects duplicate source registration before any adapter I/O", () => {
    const first = adapter("alpha", ["alpha_tool"]);
    const registry = new MoweEdgeRegistry({ adapters: [first] });
    expect(() => registry.register(adapter("alpha", ["other"])))
      .toThrow(MoweEdgeRegistryError);
    expect(registry.health("alpha")).toMatchObject({ health: "registered", enabled: true });
  });

  it("publishes atomic generations while stale snapshots remain stable", async () => {
    let current = ["old_tool"];
    const edge: EdgeAdapter = {
      sourceId: "changing",
      sourceType: "plugin",
      discover: async () => current.map((name) => manifest("changing", name)),
      load: async (candidate) => createEdgeCapability({ manifest: candidate, tool: tool(candidate.capabilityName) }),
    };
    const registry = new MoweEdgeRegistry({ adapters: [edge] });
    const first = await registry.refresh();
    expect(first.generation).toBe(1);
    expect(first.catalog.has("old_tool")).toBe(true);

    current = ["new_tool"];
    const second = await registry.refresh();
    expect(second.generation).toBe(2);
    expect(second.catalog.has("new_tool")).toBe(true);
    expect(second.catalog.has("old_tool")).toBe(false);
    expect(first.catalog.has("old_tool")).toBe(true);
    expect(first.catalog.has("new_tool")).toBe(false);
    expect(first.hash).not.toBe(second.hash);
    expect(() => first.catalog.register(tool("mutation"))).toThrow(/immutable/u);
  });

  it("isolates a failed edge and retains unrelated tools", async () => {
    const registry = new MoweEdgeRegistry({
      adapters: [
        adapter("broken", ["never_loaded"], { fail: true }),
        adapter("good", ["good_tool"]),
      ],
    });
    const snapshot = await registry.refresh();
    expect(snapshot.catalog.has("good_tool")).toBe(true);
    expect(snapshot.catalog.has("never_loaded")).toBe(false);
    expect(registry.health("broken")).toMatchObject({ health: "failed", enabled: true });
    expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: "broken", code: "adapter-failed" }),
    ]));
  });

  it("skips one malformed manifest without dropping valid capabilities from that edge", async () => {
    const valid = manifest("mixed", "valid_tool");
    const registry = new MoweEdgeRegistry({ adapters: [{
      sourceId: "mixed",
      sourceType: "plugin",
      discover: async () => [null as unknown as EdgeManifest, valid],
      load: async (candidate) => createEdgeCapability({ manifest: candidate, tool: tool(candidate.capabilityName) }),
    }] });
    const snapshot = await registry.refresh();
    expect(snapshot.catalog.has("valid_tool")).toBe(true);
    expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: "mixed", code: "manifest-invalid" }),
    ]));
  });

  it("chooses a deterministic winner for edge collisions and records provenance", async () => {
    const registry = new MoweEdgeRegistry({
      adapters: [
        adapter("zeta", ["shared"]),
        adapter("alpha", ["shared"]),
      ],
    });
    const snapshot = await registry.refresh();
    expect(await snapshot.catalog.get("shared")!.tool.execute({}, {
      runId: "run-1",
      workspace: ".",
      operationId: "op-1",
    })).toMatchObject({ content: "shared" });
    expect(snapshot.tools).toHaveLength(1);
    expect(snapshot.tools[0]).toMatchObject({ name: "shared", sourceId: "alpha" });
    expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: "zeta", code: "tool-collision", toolName: "shared" }),
    ]));
  });

  it("applies enable/disable only at the next refresh", async () => {
    const registry = new MoweEdgeRegistry({ adapters: [adapter("toggle", ["toggle_tool"])] });
    const enabled = await registry.refresh();
    expect(enabled.catalog.has("toggle_tool")).toBe(true);

    registry.disable("toggle");
    expect(registry.snapshot().catalog.has("toggle_tool")).toBe(true);
    const disabled = await registry.refresh();
    expect(disabled.catalog.has("toggle_tool")).toBe(false);
    expect(registry.health("toggle")).toMatchObject({ health: "disabled", enabled: false });

    registry.enable("toggle");
    const reenabled = await registry.refresh();
    expect(reenabled.catalog.has("toggle_tool")).toBe(true);
  });

  it("closes all adapters independently and prevents future registration", async () => {
    const closed: string[] = [];
    const registry = new MoweEdgeRegistry({ adapters: [
      adapter("one", ["one_tool"], { onRelease: () => closed.push("one") }),
      adapter("two", ["two_tool"], { onRelease: () => closed.push("two") }),
    ] });
    const active = await registry.refresh();
    await registry.close();
    expect(closed.sort()).toEqual(["one", "two"]);
    expect(registry.snapshot().catalog.has("one_tool")).toBe(false);
    expect(registry.health()).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: "one", health: "closed" }),
      expect.objectContaining({ sourceId: "two", health: "closed" }),
    ]));
    expect(active.catalog.has("one_tool")).toBe(true);
    expect(() => registry.register(adapter("later", ["later_tool"]))).toThrow(/closed/u);
  });

  it("keeps edge metadata inside Mowe admission", async () => {
    const registry = new MoweEdgeRegistry({ adapters: [adapter("writer", ["edge_write"], {
      effects: { edge_write: "write" },
    })] });
    const snapshot = await registry.refresh();
    const executor = new MoweExecutor({ catalog: snapshot.catalog });
    const result = await executor.execute({
      runId: "run-1",
      laneId: "main",
      workspace: ".",
      allowedEffects: ["read"],
      calls: [{ id: "call-1", name: "edge_write", arguments: {} }],
    });
    expect(result.results[0]).toMatchObject({ status: "failed", result: { isError: true } });
    expect(result.results[0]?.error).toMatch(/effect/u);
  });

  it("quarantines an edge that has no explicit host grant", async () => {
    const registry = new MoweEdgeRegistry({ adapters: [adapter("untrusted", ["untrusted_tool"])] });
    const snapshot = await registry.refresh();
    expect(snapshot.catalog.get("untrusted_tool")?.metadata).toMatchObject({
      effect: "external",
      scope: "host",
      requiresApproval: true,
      deterministic: false,
      supportsBatch: false,
      concurrencySafe: false,
    });
    expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "host-grant-denied", sourceId: "untrusted", severity: "warning" }),
    ]));
  });

  it("admits only effects and scopes covered by a host grant", async () => {
    const registry = new MoweEdgeRegistry({
      adapters: [adapter("writer", ["edge_write"], { effects: { edge_write: "write" } })],
      hostGrants: { writer: { effects: ["write"], scopes: ["workspace"] } },
    });
    const snapshot = await registry.refresh();
    expect(snapshot.catalog.get("edge_write")?.metadata).toMatchObject({
      effect: "write",
      scope: "workspace",
      requiresApproval: true,
    });

    const denied = new MoweEdgeRegistry({
      adapters: [adapter("writer", ["edge_write"], { effects: { edge_write: "write" } })],
      hostGrants: { writer: { effects: ["read"], scopes: ["run"] } },
    });
    const deniedSnapshot = await denied.refresh();
    expect(deniedSnapshot.catalog.has("edge_write")).toBe(false);
    expect(deniedSnapshot.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "host-grant-denied", sourceId: "writer", severity: "error" }),
    ]));
  });

  it("keeps unrelated capabilities during a source-scoped refresh", async () => {
    let names = ["first"];
    const first = adapter("first-edge", names);
    const second = adapter("second-edge", ["second"]);
    const registry = new MoweEdgeRegistry({ adapters: [
      { ...first, discover: async () => names.map((name) => manifest("first-edge", name)) },
      second,
    ] });
    await registry.refresh();
    names = ["updated"];
    const refreshed = await registry.refreshSource("first-edge");
    expect(refreshed.catalog.has("updated")).toBe(true);
    expect(refreshed.catalog.has("first")).toBe(false);
    expect(refreshed.catalog.has("second")).toBe(true);
  });

  it("does not depend on object key order when computing a generation hash", async () => {
    const firstManifest = manifest("same", "same_tool");
    const secondManifest = createEdgeManifest({
      manifestVersion: 1,
      sourceId: "same",
      sourceType: "plugin",
      capabilityName: "same_tool",
      capabilityVersion: "1.0.0",
      schemaVersion: "2020-12",
      description: "fake same_tool",
      outputSchema: { additionalProperties: false, type: "object" },
      inputSchema: { additionalProperties: false, type: "object" },
      effect: "read",
      scope: "run",
      cancellable: true,
      idempotent: true,
      recovery: "retry",
      adapterVersion: "1.0.0",
      adapterCompatibility: ">=1",
      provenance: {
        sourceUri: "fake:same",
        license: "MIT",
        upstreamVersion: "1.0.0",
        upstreamName: "fake-same",
      },
    });
    const make = (candidate: EdgeManifest) => ({
      sourceId: "same",
      sourceType: "plugin" as const,
      discover: async () => [candidate],
      load: async (loaded: EdgeManifest) => createEdgeCapability({ manifest: loaded, tool: tool(loaded.capabilityName) }),
    });
    const left = new MoweEdgeRegistry({ adapters: [make(firstManifest)] });
    const right = new MoweEdgeRegistry({ adapters: [make(secondManifest)] });
    expect((await left.refresh()).hash).toBe((await right.refresh()).hash);
  });
});
