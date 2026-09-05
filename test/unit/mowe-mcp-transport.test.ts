import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type JSONRPCMessage,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { createMcpEdgeAdapter } from "../../src/mowe/edges/mcp.js";

describe("Mowe MCP transport compatibility", () => {
  it("keeps an explicitly configured HTTP endpoint offline when transport is injected", async () => {
    const fixture = await inMemoryFixture();
    let fetchCalls = 0;
    const endpoint = "https://user-facing.example.test/mcp?access_token=endpoint-secret";
    const adapter = createMcpEdgeAdapter({
      sourceId: "http-injected",
      endpoint,
      client: fixture.client,
      transport: fixture.clientTransport,
      sessionId: "session-secret",
      headers: { Authorization: "Bearer header-secret" },
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("the injected transport must be used");
      },
      provenance: { license: "MIT", author: "fixture" },
    });

    const [manifest] = await adapter.discover({ workspace: "." });
    expect(manifest?.capabilityName).toBe("mcp__http-injected__ping");
    expect(manifest?.provenance.sourceUri).not.toContain(endpoint);
    expect(manifest?.provenance.sourceUri).not.toContain("endpoint-secret");
    expect(fetchCalls).toBe(0);

    const health = await adapter.health();
    expect(JSON.stringify(health)).not.toContain(endpoint);
    expect(JSON.stringify(health)).not.toContain("session-secret");
    expect(JSON.stringify(health)).not.toContain("header-secret");
    await adapter.release({ reason: "shutdown" });
    await fixture.server.close();
  });

  it("uses the official Streamable HTTP transport lazily with isolated session headers", async () => {
    const requests: Array<{ method: string; headers: Headers; body: JSONRPCMessage | undefined }> = [];
    const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as JSONRPCMessage : undefined;
      const headers = new Headers(init?.headers);
      requests.push({ method: init?.method ?? "GET", headers, body });
      if (init?.method === "GET") return new Response(null, { status: 405 });
      if (body !== undefined && !Array.isArray(body) && "method" in body) {
        if (body.method === "initialize") {
          return jsonResponse({
            jsonrpc: "2.0",
            id: requestId(body),
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "http-server", version: "1.0.0" },
            },
          }, "server-session");
        }
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (body.method === "tools/list") {
          return jsonResponse({
            jsonrpc: "2.0",
            id: requestId(body),
            result: {
              tools: [{
                name: "ping",
                description: "Ping",
                inputSchema: { type: "object", properties: {} },
              }],
            },
          }, "server-session");
        }
      }
      return new Response("unexpected request", { status: 400 });
    };

    const endpoint = "https://mcp.example.test/v1?token=endpoint-secret";
    const adapter = createMcpEdgeAdapter({
      sourceId: "http-sdk",
      endpoint,
      headers: {
        Authorization: "Bearer header-secret",
        "mcp-session-id": "forged-session",
        "mcp-protocol-version": "forged-protocol",
      },
      requestInit: { headers: { "x-client": "fixture" } },
      fetch,
      provenance: { license: "MIT", author: "fixture" },
    });

    // Construction is lazy: no request is made until discovery needs the client.
    expect(requests).toHaveLength(0);
    const [manifest] = await adapter.discover({ workspace: "." });
    expect(manifest?.capabilityName).toBe("mcp__http-sdk__ping");
    expect(requests.length).toBeGreaterThanOrEqual(3);
    const initialize = requests.find((request) => request.body !== undefined
      && !Array.isArray(request.body)
      && "method" in request.body
      && request.body.method === "initialize");
    const list = requests.find((request) => request.body !== undefined
      && !Array.isArray(request.body)
      && "method" in request.body
      && request.body.method === "tools/list");
    expect(initialize?.headers.get("authorization")).toBe("Bearer header-secret");
    expect(initialize?.headers.get("mcp-session-id")).toBeNull();
    expect(initialize?.headers.get("mcp-protocol-version")).toBeNull();
    expect(list?.headers.get("mcp-session-id")).toBe("server-session");
    expect(list?.headers.get("mcp-protocol-version")).toBe("2025-03-26");
    expect(list?.headers.get("x-client")).toBe("fixture");
    expect(manifest?.provenance.sourceUri).not.toContain(endpoint);

    await adapter.release({ reason: "shutdown" });
  });

  it("selects namespace collision winners independently of server order", async () => {
    const first = await pagedCollisionFixture(["spaced", " spaced "]);
    const second = await pagedCollisionFixture([" spaced ", "spaced"]);
    const adapterA = createMcpEdgeAdapter({
      sourceId: "collision-a",
      client: first.client,
      transport: first.clientTransport,
      provenance: { license: "MIT" },
    });
    const adapterB = createMcpEdgeAdapter({
      sourceId: "collision-b",
      client: second.client,
      transport: second.clientTransport,
      provenance: { license: "MIT" },
    });

    const [manifestA] = await adapterA.discover({ workspace: "." });
    const [manifestB] = await adapterB.discover({ workspace: "." });
    expect(manifestA?.description).toBe(manifestB?.description);

    await adapterA.release({ reason: "shutdown" });
    await adapterB.release({ reason: "shutdown" });
    await first.server.close();
    await second.server.close();
  });
});

async function inMemoryFixture() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: "fixture-server", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object", properties: {} } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (): Promise<CallToolResult> => ({
    content: [{ type: "text", text: "pong" }],
  }));
  await server.connect(serverTransport);
  return {
    client: new Client({ name: "fixture-client", version: "1.0.0" }),
    clientTransport,
    server,
  };
}

async function pagedCollisionFixture(names: readonly string[]) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: "collision-server", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: names.map((name) => ({
      name,
      description: `winner:${name.trim()}`,
      inputSchema: { type: "object" as const, properties: {} },
    })),
  }));
  await server.connect(serverTransport);
  return {
    client: new Client({ name: "collision-client", version: "1.0.0" }),
    clientTransport,
    server,
  };
}

function jsonResponse(message: unknown, sessionId: string): Response {
  return new Response(JSON.stringify(message), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "mcp-session-id": sessionId,
    },
  });
}

function requestId(message: JSONRPCMessage): string | number {
  if ("id" in message && (typeof message.id === "string" || typeof message.id === "number")) {
    return message.id;
  }
  return 0;
}
