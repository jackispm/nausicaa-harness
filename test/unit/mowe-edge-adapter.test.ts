import { describe, expect, it, vi } from "vitest";

import type { AgentTool } from "../../src/domain/ports.js";
import {
  assertEdgeAdapterOwnsManifest,
  createEdgeCapability,
  createEdgeCapabilitySnapshot,
  createEdgeManifest,
  EdgeAdapterError,
  EdgeContractError,
  validateEdgeManifest,
} from "../../src/mowe/edge-adapter.js";
import type {
  EdgeAdapter,
  EdgeManifest,
  EdgeManifestInput,
} from "../../src/mowe/edge-types.js";

describe("Mowe edge contract", () => {
  it("creates a canonical, deeply immutable manifest with provenance", () => {
    const input = manifestInput();
    const manifest = createEdgeManifest(input);

    expect(manifest.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.provenance)).toBe(true);
    expect(Object.isFrozen(manifest.inputSchema.properties)).toBe(true);

    input.provenance.upstreamVersion = "changed";
    (input.inputSchema.properties!.query as Record<string, unknown>).type = "number";
    expect(manifest.provenance.upstreamVersion).toBe("2026.8.1");
    expect(manifest.inputSchema.properties?.query).toEqual({ type: "string" });
  });

  it("uses canonical JSON ordering and detects persisted manifest tampering", () => {
    const first = createEdgeManifest(manifestInput());
    const reordered = manifestInput();
    reordered.inputSchema.properties = {
      limit: { type: "number" },
      query: { type: "string" },
    };
    expect(createEdgeManifest(reordered).manifestHash).toBe(first.manifestHash);
    expect(validateEdgeManifest(structuredClone(first))).toEqual(first);

    const tampered = structuredClone(first);
    (tampered as unknown as { capabilityVersion: string }).capabilityVersion = "2.0.0";
    expect(() => validateEdgeManifest(tampered)).toThrow(/does not match canonical manifest/);
  });

  it("rejects incomplete provenance and unsafe recovery declarations", () => {
    const noSource = manifestInput() as EdgeManifestInput & {
      provenance: Record<string, unknown>;
    };
    delete (noSource.provenance as { author?: string }).author;
    expect(() => createEdgeManifest(noSource as EdgeManifestInput)).toThrow(
      /must include author or sourceUri/,
    );

    expect(() => createEdgeManifest({
      ...manifestInput(),
      idempotent: false,
      recovery: "retry",
    })).toThrow(/retry requires an idempotent capability/);
  });

  it("pins tool identity, schema, metadata, and execute implementation", async () => {
    const manifest = createEdgeManifest(manifestInput());
    const original = vi.fn(async () => ({ content: "first", isError: false }));
    const tool = agentTool(original);
    const capability = createEdgeCapability({
      manifest,
      tool,
      metadata: { deterministic: true, inputKinds: ["text"], outputKinds: ["json"] },
    });

    tool.definition.name = "changed";
    tool.execute = async () => ({ content: "second", isError: false });
    await expect(capability.tool.execute({}, context())).resolves.toEqual({
      content: "first",
      isError: false,
    });
    expect(original).toHaveBeenCalledOnce();
    expect(capability.tool.definition.name).toBe("search_docs");
    expect(capability.tool.metadata).toMatchObject({
      effect: "read",
      scope: "workspace",
      version: "1.2.0",
      deterministic: true,
    });
    expect(Object.isFrozen(capability.tool.definition.parameters.properties)).toBe(true);
    expect(Object.isFrozen(capability.tool.metadata?.inputKinds)).toBe(true);
  });

  it("rejects a tool whose provider-facing contract drifts from the manifest", () => {
    const manifest = createEdgeManifest(manifestInput());
    const tool = agentTool(async () => ({ content: "", isError: false }));
    tool.definition.parameters.required = [];
    expect(() => createEdgeCapability({ manifest, tool })).toThrow(
      /tool.definition.parameters.*must equal manifest inputSchema/,
    );
  });

  it("builds sorted generation snapshots that cannot drift with later refreshes", () => {
    const zeta = capability("zeta");
    const alpha = capability("alpha");
    const snapshot = createEdgeCapabilitySnapshot({
      generation: 4,
      createdAt: "2026-08-30T12:00:00.000Z",
      capabilities: [zeta, alpha],
    });
    const refreshed = createEdgeCapabilitySnapshot({
      generation: 5,
      createdAt: "2026-08-30T12:01:00.000Z",
      capabilities: [capability("alpha", "2.0.0")],
    });

    expect(snapshot.capabilities.map(({ manifest }) => manifest.capabilityName)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(snapshot.snapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(snapshot.capabilities)).toBe(true);
    expect(snapshot.capabilities[0]?.manifest.capabilityVersion).toBe("1.2.0");
    expect(refreshed.capabilities[0]?.manifest.capabilityVersion).toBe("2.0.0");
    expect(refreshed.snapshotHash).not.toBe(snapshot.snapshotHash);
  });

  it("rejects duplicate model-visible names inside one snapshot", () => {
    expect(() => createEdgeCapabilitySnapshot({
      generation: 1,
      createdAt: "2026-08-30T12:00:00.000Z",
      capabilities: [capability("same"), capability("same")],
    })).toThrow(/duplicate capability same/);
  });

  it("rejects malformed snapshot identity without leaking Date errors", () => {
    expect(() => createEdgeCapabilitySnapshot({
      generation: 1,
      createdAt: "not-a-date",
      capabilities: [],
    })).toThrow(EdgeContractError);
  });

  it("checks adapter ownership and exposes stable structured failures", () => {
    const manifest = createEdgeManifest(manifestInput());
    const adapter: Pick<EdgeAdapter, "sourceId" | "sourceType"> = {
      sourceId: "docs-server",
      sourceType: "mcp",
    };
    expect(() => assertEdgeAdapterOwnsManifest(adapter, manifest)).not.toThrow();
    expect(() => assertEdgeAdapterOwnsManifest({ ...adapter, sourceId: "other" }, manifest))
      .toThrow(EdgeContractError);

    const failure = new EdgeAdapterError({
      code: "transport_closed",
      phase: "execute",
      sourceId: "docs-server",
      sourceType: "mcp",
      message: "server exited",
      retryable: true,
      retryAfterMs: 250,
    }).toFailure();
    expect(failure).toEqual({
      code: "transport_closed",
      phase: "execute",
      sourceId: "docs-server",
      sourceType: "mcp",
      message: "server exited",
      retryable: true,
      retryAfterMs: 250,
    });
    expect(Object.isFrozen(failure)).toBe(true);
  });
});

function manifestInput(
  name = "search_docs",
  capabilityVersion = "1.2.0",
): MutableManifestInput {
  return {
    manifestVersion: 1,
    sourceId: "docs-server",
    sourceType: "mcp",
    capabilityName: name,
    capabilityVersion,
    schemaVersion: "2020-12",
    description: `Search with ${name}`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { matches: { type: "array" } },
      required: ["matches"],
      additionalProperties: false,
    },
    effect: "read",
    scope: "workspace",
    cancellable: true,
    idempotent: true,
    recovery: "retry",
    adapterVersion: "0.1.0",
    adapterCompatibility: ">=2025-06-18",
    provenance: {
      upstreamName: "@example/docs-server",
      upstreamVersion: "2026.8.1",
      license: "MIT",
      author: "Example",
    },
  };
}

type MutableManifestInput = EdgeManifestInput & {
  provenance: {
    upstreamName: string;
    upstreamVersion: string;
    license: string;
    author?: string;
    sourceUri?: string;
  };
};

function agentTool(execute: AgentTool["execute"], name = "search_docs"): AgentTool {
  return {
    definition: {
      name,
      description: `Search with ${name}`,
      parameters: structuredClone(manifestInput(name).inputSchema),
    },
    execute,
  };
}

function capability(name: string, version = "1.2.0") {
  const manifest: EdgeManifest = createEdgeManifest(manifestInput(name, version));
  return createEdgeCapability({
    manifest,
    tool: agentTool(async () => ({ content: name, isError: false }), name),
  });
}

function context() {
  return {
    runId: "run-1",
    workspace: "/workspace",
    operationId: "operation-1",
  };
}
