import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";

import {
  createMcpEdgeAdapter,
} from "../../src/mowe/edges/mcp.js";

describe("Mowe MCP edge lifecycle", () => {
  it("rejects ownership combinations the SDK cannot close independently", () => {
    const [clientTransport] = InMemoryTransport.createLinkedPair();
    expect(() => createMcpEdgeAdapter({
      sourceId: "invalid-ownership",
      client: new Client({ name: "invalid-owner", version: "1.0.0" }),
      transport: clientTransport,
      ownsClient: true,
      ownsTransport: false,
    })).toThrow(/client ownership requires transport ownership/u);
  });

  it("projects client factory failures into unavailable health", async () => {
    const adapter = createMcpEdgeAdapter({
      sourceId: "factory-failure",
      clientFactory: () => {
        throw new Error("client factory unavailable");
      },
      transportFactory: () => InMemoryTransport.createLinkedPair()[0],
    });

    await expect(adapter.discover({ workspace: "." })).rejects.toThrow(/client factory unavailable/u);
    await expect(adapter.health()).resolves.toMatchObject({
      status: "unavailable",
      message: "client factory unavailable",
      retryAfterMs: 250,
    });
    await adapter.release({ reason: "shutdown" });
  });

  it("closes a newly created client when transport construction fails", async () => {
    const client = new Client({ name: "transport-failure-client", version: "1.0.0" });
    const closeClient = vi.spyOn(client, "close");
    const adapter = createMcpEdgeAdapter({
      sourceId: "transport-failure",
      clientFactory: () => client,
      transportFactory: () => {
        throw new Error("transport factory unavailable");
      },
    });

    await expect(adapter.discover({ workspace: "." })).rejects.toThrow(/transport factory unavailable/u);
    expect(closeClient).toHaveBeenCalledTimes(1);
    await adapter.release({ reason: "shutdown" });
  });

  it("reconnects through a fresh client after an injected transport closes", async () => {
    const fixture = await reconnectFixture();
    const adapter = createMcpEdgeAdapter({
      sourceId: "reconnect",
      clientFactory: fixture.clientFactory,
      transportFactory: fixture.transportFactory,
      provenance: { license: "MIT", author: "fixture" },
    });

    await expect(adapter.discover({ workspace: "." })).resolves.toHaveLength(1);
    expect(fixture.clientCount).toBe(1);
    await fixture.clientTransports[0]!.close();
    await expect(adapter.discover({ workspace: "." })).resolves.toHaveLength(1);
    expect(fixture.clientCount).toBe(2);
    expect(fixture.transportCount).toBe(2);

    await adapter.release({ reason: "shutdown" });
    await adapter.release({ reason: "shutdown" });
    await fixture.closeServers();
  });

  it("fails closed for manifests discovered before an unexpected transport close", async () => {
    const fixture = await reconnectFixture();
    const adapter = createMcpEdgeAdapter({
      sourceId: "stale-manifest",
      clientFactory: fixture.clientFactory,
      transportFactory: fixture.transportFactory,
      provenance: { license: "MIT", author: "fixture" },
    });

    const [manifest] = await adapter.discover({ workspace: "." });
    await fixture.clientTransports[0]!.close();
    await expect(adapter.load(manifest!, { workspace: "." })).rejects.toThrow(/not discovered/u);
    await adapter.release({ reason: "shutdown" });
    await fixture.closeServers();
  });

  it("serializes explicit reconnect and never reconnects a released adapter", async () => {
    const fixture = await reconnectFixture();
    const adapter = createMcpEdgeAdapter({
      sourceId: "reconnect",
      clientFactory: fixture.clientFactory,
      transportFactory: fixture.transportFactory,
      provenance: { license: "MIT", author: "fixture" },
    });
    await adapter.discover({ workspace: "." });
    await Promise.all([adapter.reconnect(), adapter.reconnect()]);
    expect(fixture.clientCount).toBe(3);
    await adapter.release({ reason: "shutdown" });
    await expect(adapter.reconnect()).rejects.toThrow(/closed/u);
    await fixture.closeServers();
  });

  it("does not close caller-owned injected resources by default", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "owned-server", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [tool("ping")] }));
    await server.connect(serverTransport);
    const client = new Client({ name: "owned-client", version: "1.0.0" });
    const closeClient = vi.spyOn(client, "close");
    const closeTransport = vi.spyOn(clientTransport, "close");
    const adapter = createMcpEdgeAdapter({
      sourceId: "caller-owned",
      client,
      transport: clientTransport,
      provenance: { license: "MIT", author: "fixture" },
    });
    await adapter.discover({ workspace: "." });
    await adapter.release({ reason: "shutdown" });
    expect(closeClient).not.toHaveBeenCalled();
    expect(closeTransport).not.toHaveBeenCalled();
    await server.close();
  });

  it("closes adapter-owned injected resources once", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "owned-server", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [tool("ping")] }));
    await server.connect(serverTransport);
    const client = new Client({ name: "owned-client", version: "1.0.0" });
    const closeClient = vi.spyOn(client, "close");
    const closeTransport = vi.spyOn(clientTransport, "close");
    const adapter = createMcpEdgeAdapter({
      sourceId: "adapter-owned",
      client,
      transport: clientTransport,
      ownsClient: true,
      ownsTransport: true,
      provenance: { license: "MIT", author: "fixture" },
    });
    await adapter.discover({ workspace: "." });
    await Promise.all([
      adapter.release({ reason: "shutdown" }),
      adapter.release({ reason: "shutdown" }),
    ]);
    expect(closeClient).toHaveBeenCalledTimes(1);
    // InMemoryTransport recursively closes the linked server transport, so its
    // own close spy observes both sides of that one adapter-owned close.
    expect(closeTransport).toHaveBeenCalledTimes(2);
    await server.close();
  });

  it("owns an injected transport when attaching it to an adapter-created client", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "mixed-server", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [tool("ping")] }));
    await server.connect(serverTransport);
    const client = new Client({ name: "mixed-client", version: "1.0.0" });
    const closeClient = vi.spyOn(client, "close");
    const adapter = createMcpEdgeAdapter({
      sourceId: "mixed-ownership",
      clientFactory: () => client,
      transport: clientTransport,
      provenance: { license: "MIT", author: "fixture" },
    });

    await adapter.discover({ workspace: "." });
    await adapter.release({ reason: "shutdown" });
    expect(closeClient).toHaveBeenCalledTimes(1);
    await server.close();
  });

  it("does not close a connection twice when release overlaps connect completion", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "connect-race-server", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [tool("ping")] }));
    await server.connect(serverTransport);
    const client = new Client({ name: "connect-race-client", version: "1.0.0" });
    const connect = client.connect.bind(client);
    let connectionReady!: () => void;
    const ready = new Promise<void>((resolve) => { connectionReady = resolve; });
    let resumeConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => { resumeConnect = resolve; });
    vi.spyOn(client, "connect").mockImplementation(async (transport, options) => {
      await connect(transport, options);
      connectionReady();
      await connectGate;
    });
    const closeClient = vi.spyOn(client, "close");
    const adapter = createMcpEdgeAdapter({
      sourceId: "connect-race",
      clientFactory: () => client,
      transportFactory: () => clientTransport,
      provenance: { license: "MIT", author: "fixture" },
    });

    const discovering = adapter.discover({ workspace: "." });
    await ready;
    const releasing = adapter.release({ reason: "shutdown" });
    resumeConnect();
    await expect(discovering).rejects.toThrow(/superseded/u);
    await releasing;
    expect(closeClient).toHaveBeenCalledTimes(1);
    await server.close();
  });

  it("does not resurrect when release wins a delayed connection", async () => {
    let resumeTransport!: () => void;
    const transportGate = new Promise<void>((resolve) => { resumeTransport = resolve; });
    let factoryStarted!: () => void;
    const started = new Promise<void>((resolve) => { factoryStarted = resolve; });
    const servers: Server[] = [];
    const adapter = createMcpEdgeAdapter({
      sourceId: "release-race",
      clientFactory: () => new Client({ name: "race-client", version: "1.0.0" }),
      transportFactory: async () => {
        factoryStarted();
        await transportGate;
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const server = new Server({ name: "race-server", version: "1.0.0" }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [tool("ping")] }));
        await server.connect(serverTransport);
        servers.push(server);
        return clientTransport;
      },
      provenance: { license: "MIT", author: "fixture" },
    });
    const discovering = adapter.discover({ workspace: "." });
    await started;
    const released = adapter.release({ reason: "shutdown" });
    resumeTransport();
    await expect(discovering).rejects.toThrow(/superseded/u);
    await released;
    await expect(adapter.health()).resolves.toMatchObject({ status: "closed" });
    await expect(adapter.discover({ workspace: "." })).rejects.toThrow(/closed/u);
    await Promise.all(servers.map((server) => server.close()));
  });
});

interface ReconnectFixture {
  readonly clientFactory: () => Promise<Client>;
  readonly transportFactory: () => Promise<InMemoryTransport>;
  readonly clientTransports: InMemoryTransport[];
  readonly closeServers: () => Promise<void>;
  readonly clientCount: number;
  readonly transportCount: number;
}

async function reconnectFixture(): Promise<ReconnectFixture> {
  const clients: Client[] = [];
  const clientTransports: InMemoryTransport[] = [];
  const servers: Server[] = [];
  let clientCount = 0;
  let transportCount = 0;
  const create = async (): Promise<InMemoryTransport> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "reconnect-server", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [tool("ping")] }));
    server.setRequestHandler(CallToolRequestSchema, async (): Promise<CallToolResult> => ({
      content: [{ type: "text", text: "pong" }],
    }));
    await server.connect(serverTransport);
    servers.push(server);
    clientTransports.push(clientTransport);
    transportCount += 1;
    return clientTransport;
  };
  const clientFactory = async (): Promise<Client> => {
    clientCount += 1;
    const client = new Client({ name: `fixture-client-${clientCount}`, version: "1.0.0" });
    clients.push(client);
    return client;
  };
  return {
    clientFactory,
    transportFactory: create,
    clientTransports,
    closeServers: async () => {
      await Promise.all(servers.map((server) => server.close()));
    },
    get clientCount() { return clientCount; },
    get transportCount() { return transportCount; },
  };
}

function tool(name: string) {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: "object" as const, properties: {} },
  };
}
