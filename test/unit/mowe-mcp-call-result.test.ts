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
  projectMcpToolResult,
} from "../../src/mowe/edges/mcp.js";

describe("Mowe MCP edge calls and result projection", () => {
  it("maps text, image, structured, and unsupported blocks without trusting annotations", async () => {
    const fixture = await callFixture({
      result: {
        content: [
          { type: "text", text: "hello" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          { type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" },
        ],
        structuredContent: { ok: true },
      },
    });
    const adapter = createMcpEdgeAdapter({
      sourceId: "media",
      client: fixture.client,
      transport: fixture.clientTransport,
      maxResultBytes: 256,
      provenance: { license: "MIT", author: "fixture" },
    });
    const [manifest] = await adapter.discover({ workspace: "." });
    const capability = await adapter.load(manifest!, { workspace: "." });
    const result = await capability.tool.execute({}, {
      runId: "run-1",
      workspace: ".",
      operationId: "media",
    });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("hello");
    expect(result.content).toContain("unsupported");
    expect(result.content).toContain('"ok":true');
    expect(result.images).toHaveLength(1);
    await adapter.release({ reason: "shutdown" });
    await fixture.server.close();
  });

  it("returns bounded failures for oversized blocks, images, and structured output", () => {
    const response: CallToolResult = {
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
        { type: "text", text: "third" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" },
      ],
      structuredContent: { payload: "this is larger than the structured-content limit" },
    };
    const result = projectMcpToolResult(response, {
      maxBytes: 64,
      maxBlocks: 3,
      maxImageBytes: 1,
      maxStructuredBytes: 8,
    });
    expect(result.isError).toBe(true);
    expect(result.images).toBeUndefined();
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(64);
    expect(result.content).toContain("omitted");
  });

  it("maps timeout and cancellation to bounded structured ToolResult failures", async () => {
    const fixture = await callFixture({
      delayMs: 100,
      result: { content: [{ type: "text", text: "done" }] },
    });
    const adapter = createMcpEdgeAdapter({
      sourceId: "slow",
      client: fixture.client,
      transport: fixture.clientTransport,
      timeoutMs: 10,
      maxResultBytes: 48,
      provenance: { license: "MIT", author: "fixture" },
    });
    const [manifest] = await adapter.discover({ workspace: "." });
    const capability = await adapter.load(manifest!, { workspace: "." });
    const timed = await capability.tool.execute({}, {
      runId: "run-1",
      workspace: ".",
      operationId: "timeout",
    });
    expect(timed.isError).toBe(true);
    expect(timed.content).toMatch(/timed out/u);
    expect(Buffer.byteLength(timed.content, "utf8")).toBeLessThanOrEqual(48);

    const controller = new AbortController();
    const pending = capability.tool.execute({}, {
      runId: "run-1",
      workspace: ".",
      operationId: "cancel",
      signal: controller.signal,
    });
    controller.abort(new Error("caller cancelled"));
    const cancelled = await pending;
    expect(cancelled.isError).toBe(true);
    expect(cancelled.content).toMatch(/cancelled/u);
    await adapter.release({ reason: "shutdown" });
    await fixture.server.close();
  });

  it("bounds images by decoded image bytes and preserves valid media", () => {
    const result = projectMcpToolResult({
      content: [
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
    }, {
      maxBytes: 128,
      maxImageBytes: 5,
    });
    expect(result.isError).toBe(true);
    expect(result.images).toHaveLength(1);
    expect(result.content).toContain("omitted");
  });
});

interface CallFixtureOptions {
  readonly result: CallToolResult;
  readonly delayMs?: number;
}

interface CallFixture {
  readonly client: Client;
  readonly clientTransport: InMemoryTransport;
  readonly server: Server;
}

async function callFixture(options: CallFixtureOptions): Promise<CallFixture> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: "call-server", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "call", description: "Call", inputSchema: { type: "object", properties: {} } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (): Promise<CallToolResult> => {
    if (options.delayMs !== undefined) {
      await new Promise<void>((resolve) => setTimeout(resolve, options.delayMs));
    }
    return options.result;
  });
  await server.connect(serverTransport);
  return {
    client: new Client({ name: "call-client", version: "1.0.0" }),
    clientTransport,
    server,
  };
}
