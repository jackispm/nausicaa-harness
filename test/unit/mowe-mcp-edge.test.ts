import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import {
  createMcpEdgeAdapter,
} from "../../src/mowe/edges/mcp.js";

describe("Mowe MCP edge", () => {
  it("discovers a paginated MCP tool under a stable namespace", async () => {
    const fixture = await mcpFixture();
    const adapter = createMcpEdgeAdapter({
      sourceId: "docs-server",
      client: fixture.client,
      transport: fixture.clientTransport,
      provenance: { license: "MIT", author: "fixture" },
    });

    const manifests = await adapter.discover({ workspace: "." });
    expect(manifests).toHaveLength(1);
    expect(manifests[0]).toMatchObject({
      sourceId: "docs-server",
      sourceType: "mcp",
      capabilityName: "mcp__docs-server__search_docs",
      effect: "external",
      scope: "run",
    });
    const capability = await adapter.load(manifests[0]!, { workspace: "." });
    expect(capability.tool.metadata).toMatchObject({
      effect: "external",
      requiresApproval: true,
    });
    await adapter.release({ reason: "shutdown" });
    await fixture.server.close();
  });

  it("uses only host policy, never MCP annotations, for admission metadata", async () => {
    const fixture = await mcpFixture({ annotations: { readOnlyHint: true, idempotentHint: true } });
    const adapter = createMcpEdgeAdapter({
      sourceId: "trusted",
      client: fixture.client,
      transport: fixture.clientTransport,
      provenance: { license: "MIT", author: "fixture" },
      policy: {
        search_docs: {
          effect: "read",
          scope: "workspace",
          requiresApproval: false,
          deterministic: true,
          idempotent: true,
          recovery: "retry",
        },
      },
    });
    const [manifest] = await adapter.discover({ workspace: "." });
    const capability = await adapter.load(manifest!, { workspace: "." });
    expect(manifest).toMatchObject({ effect: "read", scope: "workspace", recovery: "retry" });
    expect(capability.tool.metadata).toMatchObject({ effect: "read", requiresApproval: false });
    await adapter.release({ reason: "shutdown" });
    await fixture.server.close();
  });

  it("maps text, images, structured output, and bounded unsupported blocks", async () => {
    const fixture = await mcpFixture({ result: {
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" },
      ],
      structuredContent: { ok: true },
    } });
    const adapter = createMcpEdgeAdapter({
      sourceId: "media",
      client: fixture.client,
      transport: fixture.clientTransport,
      maxResultBytes: 256,
      provenance: { license: "MIT", author: "fixture" },
    });
    const [manifest] = await adapter.discover({ workspace: "." });
    const capability = await adapter.load(manifest!, { workspace: "." });
    const result = await capability.tool.execute({ query: "x" }, {
      runId: "run-1",
      workspace: ".",
      operationId: "op-1",
    });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("hello");
    expect(result.content).toContain("unsupported");
    expect(result.images).toHaveLength(1);
    await adapter.release({ reason: "shutdown" });
    await fixture.server.close();
  });

  it("bounds tool discovery and reports degraded health", async () => {
    const fixture = await mcpFixture({ extraTool: true });
    const adapter = createMcpEdgeAdapter({
      sourceId: "bounded",
      client: fixture.client,
      transport: fixture.clientTransport,
      maxTools: 1,
      provenance: { license: "MIT", author: "fixture" },
    });
    await adapter.discover({ workspace: "." });
    await expect(adapter.health()).resolves.toMatchObject({ status: "degraded" });
    await adapter.release({ reason: "shutdown" });
    await fixture.server.close();
  });
});

interface FixtureOptions {
  annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean };
  result?: CallToolResult;
  extraTool?: boolean;
}

async function mcpFixture(options: FixtureOptions = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: "fixture-server", version: "1.0.0" }, { capabilities: { tools: {} } });
  const tools = [
    {
      name: "search_docs",
      description: "Search docs",
      inputSchema: {
        type: "object" as const,
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: options.annotations,
    },
    ...(options.extraTool ? [{
      name: "extra",
      description: "Extra",
      inputSchema: { type: "object" as const, properties: {} },
    }] : []),
  ];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }): Promise<CallToolResult> => {
    if (params.name === "extra") return { content: [{ type: "text", text: "extra" }] };
    return options.result ?? { content: [{ type: "text", text: `query=${String(params.arguments?.query)}` }] };
  });
  await server.connect(serverTransport);
  const client = new Client({ name: "fixture-client", version: "1.0.0" });
  return { client, clientTransport, server };
}
