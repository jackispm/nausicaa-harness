import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  type ListToolsResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import {
  createMcpEdgeAdapter,
  type McpToolPolicy,
} from "../../src/mowe/edges/mcp.js";

describe("Mowe MCP edge discovery", () => {
  it("collects paginated tools in deterministic capability order", async () => {
    const fixture = await discoveryFixture(({ cursor }) => cursor === undefined
      ? { tools: [tool("zeta")], nextCursor: "page-2" }
      : { tools: [tool("alpha")] });
    const adapter = adapterFor(fixture, { sourceId: "docs-server" });

    const manifests = await adapter.discover({ workspace: "." });
    expect(manifests.map((manifest) => manifest.capabilityName)).toEqual([
      "mcp__docs-server__alpha",
      "mcp__docs-server__zeta",
    ]);
    expect(fixture.cursors).toEqual([undefined, "page-2"]);
    expect(Object.isFrozen(manifests)).toBe(true);
    await adapter.release({ reason: "shutdown" });
    await fixture.server.close();
  });

  it("stops cyclic cursors with a bounded degraded diagnostic", async () => {
    const fixture = await discoveryFixture(({ cursor }) => cursor === undefined
      ? { tools: [tool("alpha")], nextCursor: "next" }
      : { tools: [tool("beta")], nextCursor: "next" });
    const adapter = adapterFor(fixture, { sourceId: "paged", maxTools: 10 });

    await expect(adapter.discover({ workspace: "." })).resolves.toHaveLength(2);
    expect(fixture.cursors).toEqual([undefined, "next"]);
    await expect(adapter.health()).resolves.toMatchObject({
      status: "degraded",
      message: expect.stringMatching(/repeated cursor/u),
      retryAfterMs: 250,
    });
    await adapter.release({ reason: "shutdown" });
    await fixture.server.close();
  });

  it("reports duplicate and namespace collisions deterministically", async () => {
    const fixture = await discoveryFixture(() => ({
      tools: [tool("same"), tool("same"), tool(" spaced "), tool("spaced")],
    }));
    const adapter = adapterFor(fixture, { sourceId: "collision" });

    const manifests = await adapter.discover({ workspace: "." });
    expect(manifests.map((manifest) => manifest.capabilityName)).toEqual([
      "mcp__collision__same",
      "mcp__collision__spaced",
    ]);
    await expect(adapter.health()).resolves.toMatchObject({ status: "degraded" });
    await adapter.release({ reason: "shutdown" });
    await fixture.server.close();
  });

  it("bounds and sanitizes remote names in health diagnostics", async () => {
    const remoteName = `unsafe\n${"x".repeat(1_024)}`;
    const fixture = await discoveryFixture(() => ({ tools: [tool(remoteName), tool(remoteName)] }));
    const adapter = adapterFor(fixture, { sourceId: "bounded-diagnostic" });

    await adapter.discover({ workspace: "." });
    const health = await adapter.health();
    expect(health.status).toBe("degraded");
    expect(health.message).not.toMatch(/[\r\n]/u);
    expect(Buffer.byteLength(health.message ?? "", "utf8")).toBeLessThanOrEqual(192);
    await adapter.release({ reason: "shutdown" });
    await fixture.server.close();
  });

  it("never converts MCP readOnlyHint into host authority", async () => {
    const hinted = tool("read_hint", { readOnlyHint: true, idempotentHint: true });
    const fixture = await discoveryFixture(() => ({ tools: [hinted] }));
    const adapter = adapterFor(fixture, { sourceId: "untrusted" });

    const [manifest] = await adapter.discover({ workspace: "." });
    const capability = await adapter.load(manifest!, { workspace: "." });
    expect(manifest).toMatchObject({ effect: "external", scope: "run", idempotent: false });
    expect(capability.tool.metadata).toMatchObject({
      effect: "external",
      scope: "run",
      requiresApproval: true,
      deterministic: false,
    });
    await adapter.release({ reason: "shutdown" });
    await fixture.server.close();
  });

  it("uses an explicit host policy independently of MCP annotations", async () => {
    const fixture = await discoveryFixture(() => ({ tools: [tool("search")] }));
    const adapter = adapterFor(fixture, {
      sourceId: "host-policy",
      policy: {
        search: {
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

  it("snapshots policy resolver output at discovery", async () => {
    const fixture = await discoveryFixture(() => ({ tools: [tool("search")] }));
    const resolvedPolicy: McpToolPolicy = {
      effect: "read",
      scope: "workspace",
      requiresApproval: false,
      deterministic: true,
    };
    const adapter = adapterFor(fixture, {
      sourceId: "policy-snapshot",
      policy: () => resolvedPolicy,
    });

    const [manifest] = await adapter.discover({ workspace: "." });
    resolvedPolicy.effect = "write";
    resolvedPolicy.scope = "host";
    resolvedPolicy.requiresApproval = true;
    const capability = await adapter.load(manifest!, { workspace: "." });
    expect(capability.tool.metadata).toMatchObject({
      effect: "read",
      scope: "workspace",
      requiresApproval: false,
    });
    await adapter.release({ reason: "shutdown" });
    await fixture.server.close();
  });

  it("rejects an unbounded host policy timeout while loading", async () => {
    const fixture = await discoveryFixture(() => ({ tools: [tool("search")] }));
    const adapter = adapterFor(fixture, {
      sourceId: "invalid-policy-timeout",
      policy: { search: { timeoutMs: Number.POSITIVE_INFINITY } },
    });

    const [manifest] = await adapter.discover({ workspace: "." });
    await expect(adapter.load(manifest!, { workspace: "." })).rejects.toThrow(/policy\.timeoutMs/u);
    await adapter.release({ reason: "shutdown" });
    await fixture.server.close();
  });

  it("propagates cancellation during tools/list and degrades only that source", async () => {
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    let serverCancelled = false;
    const fixture = await discoveryFixture(async (_params, signal) => {
      requestStarted();
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => {
          serverCancelled = true;
          reject(signal.reason);
        }, { once: true });
      });
      return { tools: [] };
    });
    const adapter = adapterFor(fixture, { sourceId: "cancelled", timeoutMs: 1_000 });
    const healthyFixture = await discoveryFixture(() => ({ tools: [tool("healthy")] }));
    const healthy = adapterFor(healthyFixture, { sourceId: "healthy" });
    const controller = new AbortController();
    const pending = adapter.discover({ workspace: ".", signal: controller.signal });
    await started;
    controller.abort(new Error("stop list"));

    await expect(pending).rejects.toThrow();
    await expect(healthy.discover({ workspace: "." })).resolves.toHaveLength(1);
    await expect(adapter.health()).resolves.toMatchObject({ status: "degraded" });
    await eventually(() => expect(serverCancelled).toBe(true));
    await adapter.release({ reason: "shutdown" });
    await healthy.release({ reason: "shutdown" });
    await fixture.server.close();
    await healthyFixture.server.close();
  });

  it("rejects a pre-aborted discovery before constructing SDK resources", async () => {
    let clients = 0;
    let transports = 0;
    const adapter = createMcpEdgeAdapter({
      sourceId: "pre-aborted",
      clientFactory: () => {
        clients += 1;
        return new Client({ name: "unused", version: "1.0.0" });
      },
      transportFactory: () => {
        transports += 1;
        return InMemoryTransport.createLinkedPair()[0];
      },
      provenance: { license: "MIT", author: "fixture" },
    });
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    await expect(adapter.discover({ workspace: ".", signal: controller.signal })).rejects.toThrow(/cancelled/u);
    expect(clients).toBe(0);
    expect(transports).toBe(0);
    await adapter.release({ reason: "shutdown" });
  });
});

interface DiscoveryFixture {
  readonly client: Client;
  readonly clientTransport: InMemoryTransport;
  readonly server: Server;
  readonly cursors: (string | undefined)[];
}

async function discoveryFixture(
  list: (
    params: { cursor?: string },
    signal: AbortSignal,
  ) => ListToolsResult | Promise<ListToolsResult>,
): Promise<DiscoveryFixture> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: "discovery-server", version: "1.0.0" }, { capabilities: { tools: {} } });
  const cursors: (string | undefined)[] = [];
  server.setRequestHandler(ListToolsRequestSchema, async ({ params }, extra): Promise<ListToolsResult> => {
    cursors.push(params?.cursor);
    return list(params?.cursor === undefined ? {} : { cursor: params.cursor }, extra.signal);
  });
  await server.connect(serverTransport);
  return {
    client: new Client({ name: "discovery-client", version: "1.0.0" }),
    clientTransport,
    server,
    cursors,
  };
}

function adapterFor(
  fixture: DiscoveryFixture,
  options: Omit<Parameters<typeof createMcpEdgeAdapter>[0], "client" | "transport" | "provenance">,
) {
  return createMcpEdgeAdapter({
    ...options,
    client: fixture.client,
    transport: fixture.clientTransport,
    provenance: { license: "MIT", author: "fixture" },
  });
}

function tool(name: string, annotations?: Tool["annotations"]): Tool {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: "object", properties: {} },
    ...(annotations === undefined ? {} : { annotations }),
  };
}

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }
  throw last;
}
