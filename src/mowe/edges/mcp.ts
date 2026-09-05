import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { AgentTool, JsonSchema, ToolResult } from "../../domain/ports.js";
import {
  MAX_USER_IMAGES,
  validateUserImages,
  type UserImage,
} from "../../domain/images.js";
import {
  createEdgeCapability,
  createEdgeManifest,
} from "../edge-adapter.js";
import type {
  EdgeAdapter,
  EdgeAdapterHealth,
  EdgeCapability,
  EdgeDiscoveryContext,
  EdgeLoadContext,
  EdgeManifest,
  EdgeManifestInput,
  EdgeProvenance,
  EdgeRecoverySemantics,
  EdgeReleaseContext,
  EdgeSourceType,
} from "../edge-types.js";
import type { MoweEffect, MoweToolMetadata, MoweToolScope } from "../types.js";

/** MCP's annotations are hints, not an authorization mechanism. */
export interface McpToolPolicy {
  /** Host-owned effect. Defaults to external when omitted. */
  effect?: MoweEffect;
  scope?: MoweToolScope;
  requiresApproval?: boolean;
  deterministic?: boolean;
  supportsBatch?: boolean;
  concurrencySafe?: boolean;
  supportsStreaming?: boolean;
  timeoutMs?: number;
  maxConcurrency?: number;
  cancellable?: boolean;
  idempotent?: boolean;
  recovery?: EdgeRecoverySemantics;
  inputKinds?: MoweToolMetadata["inputKinds"];
  outputKinds?: MoweToolMetadata["outputKinds"];
}

export type McpToolPolicyResolver = (
  tool: McpTool,
) => McpToolPolicy | undefined;

/** Explicit, opt-in Streamable HTTP transport settings.
 *
 * The endpoint is never used as an adapter identity. A fake `transport` or
 * `transportFactory` supplied through the parent options takes precedence,
 * which keeps HTTP tests and embedders offline.
 */
export interface McpStreamableHttpOptions {
  readonly endpoint: string | URL;
  readonly headers?: Readonly<Record<string, string>>;
  readonly sessionId?: string;
  readonly requestInit?: RequestInit;
  readonly fetch?: FetchLike;
}

export interface McpEdgeAdapterOptions {
  /** Stable host-owned identity. It is also used in the mcp__ namespace. */
  readonly sourceId: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Explicit opt-in for SDK Streamable HTTP. Stdio remains the default. */
  readonly endpoint?: string | URL;
  /** Equivalent nested spelling for embedders that keep transport settings grouped. */
  readonly streamableHttp?: McpStreamableHttpOptions;
  /** Alias for streamableHttp; retained as a narrow constructor seam. */
  readonly http?: McpStreamableHttpOptions;
  /** Additional HTTP headers; session/protocol headers remain SDK-owned. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Initial MCP session header for an HTTP transport, never an edge identity. */
  readonly sessionId?: string;
  /** Injected fetch for deterministic HTTP tests; never used for stdio. */
  readonly fetch?: FetchLike;
  /** Base request options for an SDK-created HTTP transport. */
  readonly requestInit?: RequestInit;
  /** Inject these for offline tests or an already-managed transport. */
  readonly client?: Client;
  readonly transport?: Transport;
  /** Override inferred ownership for embedders that manage both resources. */
  readonly ownsClient?: boolean;
  readonly ownsTransport?: boolean;
  /** Factories make reconnect possible after a process/transport failure. */
  readonly clientFactory?: () => Client | Promise<Client>;
  readonly transportFactory?: () => Transport | Promise<Transport>;
  readonly adapterVersion?: string;
  readonly adapterCompatibility?: string;
  readonly provenance?: Partial<EdgeProvenance>;
  readonly schemaVersion?: string;
  readonly policy?: Readonly<Record<string, McpToolPolicy>> | McpToolPolicyResolver;
  readonly maxTools?: number;
  readonly maxResultBytes?: number;
  readonly maxSchemaBytes?: number;
  readonly timeoutMs?: number;
  /** Maximum content blocks retained from one MCP result. */
  readonly maxResultBlocks?: number;
  /** Maximum decoded image bytes retained from one MCP result. */
  readonly maxResultImageBytes?: number;
  /** Maximum structured-content JSON bytes considered for one result. */
  readonly maxResultStructuredBytes?: number;
}

export interface McpEdgeAdapter extends EdgeAdapter {
  readonly sourceType: "mcp";
  health(): Promise<EdgeAdapterHealth>;
  release(context: EdgeReleaseContext): Promise<void>;
  /** Reconnect only when fresh client and transport construction is available. */
  reconnect(signal?: AbortSignal): Promise<void>;
}

export interface McpResultProjectionLimits {
  readonly maxBytes: number;
  readonly maxBlocks?: number;
  readonly maxImageBytes?: number;
  readonly maxStructuredBytes?: number;
}

const SOURCE_TYPE = "mcp" as const satisfies EdgeSourceType;
const DEFAULT_MAX_TOOLS = 256;
const DEFAULT_MAX_RESULT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_SCHEMA_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_SAFE_TEXT = 4_096;
const MAX_UNSUPPORTED_BLOCKS = 16;
const MAX_CONTENT_BLOCKS = 1_024;
const MAX_RESULT_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_RESULT_STRUCTURED_BYTES = 512 * 1024;
const MAX_LIST_PAGES = 1_024;
const MAX_HEALTH_MESSAGE_BYTES = 192;
const DEFAULT_SCHEMA_VERSION = "2020-12";

/**
 * Adapt one MCP server into the host-owned Mowe edge contract.
 *
 * The SDK owns initialization and JSON-RPC framing. This class only translates
 * tool declarations/results and keeps the connection lifecycle bounded.
 */
export function createMcpEdgeAdapter(options: McpEdgeAdapterOptions): McpEdgeAdapter {
  return new McpEdgeAdapterImpl(options);
}

class McpEdgeAdapterImpl implements McpEdgeAdapter {
  readonly sourceId: string;
  readonly sourceType = SOURCE_TYPE;

  readonly #options: McpEdgeAdapterOptions;
  readonly #httpOptions: McpStreamableHttpOptions | undefined;
  readonly #diagnosticRedactions: readonly string[];
  readonly #maxTools: number;
  readonly #maxResultBytes: number;
  readonly #maxSchemaBytes: number;
  readonly #timeoutMs: number;
  readonly #maxResultBlocks: number;
  readonly #maxResultImageBytes: number;
  readonly #maxResultStructuredBytes: number;
  #client: Client | undefined;
  #transport: Transport | undefined;
  #initialTransport: Transport | undefined;
  #ownsClient = false;
  #ownsTransport = false;
  #connected = false;
  #closed = false;
  #connecting: Promise<void> | undefined;
  #releasePromise: Promise<void> | undefined;
  #reconnectQueue: Promise<void> = Promise.resolve();
  #lifecycleEpoch = 0;
  #serverTools = new Map<string, McpToolRecord>();
  #toolPolicies = new Map<string, McpToolPolicy>();
  #warnings: string[] = [];
  #truncatedTools = false;
  #lastError: string | undefined;
  #checkedAt = new Date(0).toISOString();

  constructor(options: McpEdgeAdapterOptions) {
    if (typeof options.sourceId !== "string" || options.sourceId.trim().length === 0) {
      throw new TypeError("MCP sourceId must be a non-empty string");
    }
    const httpOptions = normalizeHttpOptions(options);
    if (options.command !== undefined && httpOptions !== undefined) {
      throw new TypeError("MCP stdio command and Streamable HTTP endpoint are mutually exclusive");
    }
    if (options.command === undefined
      && options.transport === undefined
      && options.transportFactory === undefined
      && options.client === undefined
      && options.clientFactory === undefined
      && httpOptions === undefined) {
      throw new TypeError("MCP adapter requires command, endpoint, transport, transportFactory, or client");
    }
    assertOptionalBoolean(options.ownsClient, "ownsClient");
    assertOptionalBoolean(options.ownsTransport, "ownsTransport");
    if (options.ownsClient === true && options.ownsTransport === false) {
      assertCompatibleOwnership(options.ownsClient, options.ownsTransport);
    }
    this.sourceId = options.sourceId;
    this.#options = snapshotOptions(options);
    this.#httpOptions = httpOptions === undefined ? undefined : snapshotHttpOptions(httpOptions);
    this.#diagnosticRedactions = collectDiagnosticRedactions(this.#httpOptions);
    this.#initialTransport = options.transport;
    this.#maxTools = boundedPositiveInteger(options.maxTools, DEFAULT_MAX_TOOLS, 1_024, "maxTools");
    this.#maxResultBytes = boundedPositiveInteger(
      options.maxResultBytes,
      DEFAULT_MAX_RESULT_BYTES,
      64 * 1024 * 1024,
      "maxResultBytes",
    );
    this.#maxSchemaBytes = boundedPositiveInteger(
      options.maxSchemaBytes,
      DEFAULT_MAX_SCHEMA_BYTES,
      8 * 1024 * 1024,
      "maxSchemaBytes",
    );
    this.#timeoutMs = boundedPositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 60 * 60 * 1000, "timeoutMs");
    this.#maxResultBlocks = boundedPositiveInteger(
      options.maxResultBlocks,
      MAX_CONTENT_BLOCKS,
      MAX_CONTENT_BLOCKS,
      "maxResultBlocks",
    );
    this.#maxResultImageBytes = boundedPositiveInteger(
      options.maxResultImageBytes,
      Math.min(DEFAULT_MAX_RESULT_BYTES, MAX_RESULT_IMAGE_BYTES),
      MAX_RESULT_IMAGE_BYTES,
      "maxResultImageBytes",
    );
    this.#maxResultStructuredBytes = boundedPositiveInteger(
      options.maxResultStructuredBytes,
      Math.min(DEFAULT_MAX_RESULT_BYTES, MAX_RESULT_STRUCTURED_BYTES),
      MAX_RESULT_STRUCTURED_BYTES,
      "maxResultStructuredBytes",
    );
    this.#client = options.client;
  }

  async discover(context: EdgeDiscoveryContext): Promise<readonly EdgeManifest[]> {
    this.#assertOpen();
    throwIfAborted(context.signal);
    await this.#ensureConnected(context.signal);
    const client = this.#requireClient();
    let cursor: string | undefined;
    const visitedCursors = new Set<string>();
    const remoteNames = new Map<string, McpTool>();
    const selectedTools = new Map<string, McpTool>();
    let pages = 0;
    this.#truncatedTools = false;
    this.#warnings = [];
    do {
      throwIfAborted(context.signal);
      if (cursor !== undefined) {
        if (visitedCursors.has(cursor)) {
          this.#truncatedTools = true;
          this.#warnings.push(`Stopped MCP tool pagination at repeated cursor: ${safeCursor(cursor)}`);
          break;
        }
        visitedCursors.add(cursor);
      }
      pages += 1;
      if (pages > MAX_LIST_PAGES) {
        this.#truncatedTools = true;
        this.#warnings.push(`Stopped MCP tool pagination at ${MAX_LIST_PAGES} pages`);
        break;
      }
      let response: Awaited<ReturnType<Client["listTools"]>>;
      try {
        response = await client.listTools(
          cursor === undefined ? undefined : { cursor },
          requestOptions(context.signal, this.#timeoutMs),
        );
      } catch (error) {
        this.#lastError = context.signal?.aborted || isAbortError(error)
          ? "MCP tool discovery was cancelled"
          : isTimeoutError(error)
            ? "MCP tool discovery timed out"
            : `MCP tool discovery failed: ${this.#safeError(error)}`;
        this.#checkedAt = new Date().toISOString();
        throw error;
      }
      for (const tool of response.tools ?? []) {
        if (!isUsableMcpTool(tool, this.#maxSchemaBytes)) {
          this.#warnings.push(`Ignored MCP tool with invalid or oversized schema: ${safeToolName(tool)}`);
          continue;
        }
        const remoteName = tool.name;
        const duplicate = remoteNames.get(remoteName);
        if (duplicate !== undefined) {
          if (compareMcpTools(tool, duplicate) < 0) {
            remoteNames.set(remoteName, tool);
            const projectedName = capabilityName(this.sourceId, remoteName);
            const selected = selectedTools.get(projectedName);
            if (selected === undefined || compareMcpTools(tool, selected) < 0) {
              selectedTools.set(projectedName, tool);
            }
          }
          this.#warnings.push(`Ignored duplicate MCP tool: ${safeDiagnosticValue(remoteName)}`);
          continue;
        }
        const projectedName = capabilityName(this.sourceId, remoteName);
    const collision = selectedTools.get(projectedName);
    if (collision !== undefined) {
      if (compareMcpTools(tool, collision) < 0) selectedTools.set(projectedName, tool);
          this.#warnings.push(
            `Ignored MCP tool with colliding namespace: ${safeDiagnosticValue(remoteName)} -> ${projectedName}`,
          );
          continue;
        }
        if (selectedTools.size >= this.#maxTools) {
          this.#truncatedTools = true;
          break;
        }
        remoteNames.set(remoteName, tool);
        selectedTools.set(projectedName, tool);
      }
      cursor = response.nextCursor;
    } while (cursor !== undefined && selectedTools.size < this.#maxTools);

    if (cursor !== undefined && selectedTools.size >= this.#maxTools) this.#truncatedTools = true;
    this.#serverTools.clear();
    this.#toolPolicies.clear();
    const manifests: EdgeManifest[] = [];
    for (const tool of [...selectedTools.values()].sort((left, right) => compareMcpTools(left, right))) {
      try {
        const policy = this.#resolvePolicy(tool);
        const manifest = this.#manifest(tool, policy);
        manifests.push(manifest);
        this.#serverTools.set(tool.name, {
          tool,
          capabilityName: manifest.capabilityName,
          manifestHash: manifest.manifestHash,
        });
        this.#toolPolicies.set(tool.name, policy);
      } catch (error) {
        this.#warnings.push(`Ignored MCP tool ${safeToolName(tool)}: ${this.#safeError(error)}`);
      }
    }
    this.#warnings = this.#warnings
      .map((warning) => redactDiagnosticText(warning, this.#diagnosticRedactions))
      .sort(compareText);
    this.#lastError = this.#warnings[0]
      ?? (this.#truncatedTools ? `MCP tool list truncated at ${this.#maxTools} tools` : undefined);
    this.#checkedAt = new Date().toISOString();
    manifests.sort((left, right) => compareText(left.capabilityName, right.capabilityName));
    return Object.freeze(manifests);
  }

  async load(manifest: EdgeManifest, _context: EdgeLoadContext): Promise<EdgeCapability> {
    this.#assertOpen();
    const sourceTool = [...this.#serverTools.values()]
      .find((candidate) => candidate.capabilityName === manifest.capabilityName);
    if (sourceTool === undefined) throw new Error(`MCP tool is not discovered: ${manifest.capabilityName}`);
    if (manifest.sourceId !== this.sourceId || manifest.sourceType !== SOURCE_TYPE) {
      throw new Error(`MCP manifest does not belong to ${this.sourceId}`);
    }
    if (sourceTool.manifestHash !== manifest.manifestHash) {
      throw new Error(`MCP manifest changed after discovery: ${manifest.capabilityName}`);
    }
    const metadata = this.#metadata(sourceTool.tool);
    const tool: AgentTool = {
      definition: {
        name: manifest.capabilityName,
        description: manifest.description,
        parameters: structuredClone(manifest.inputSchema),
      },
      execute: async (arguments_, context) => this.#execute(
        sourceTool.tool.name,
        arguments_,
        context.signal,
        metadata.timeoutMs,
      ),
    };
    return createEdgeCapability({
      manifest,
      tool,
      metadata,
    });
  }

  async reconnect(signal?: AbortSignal): Promise<void> {
    this.#assertOpen();
    throwIfAborted(signal);
    if (!this.#canCreateFreshClient() || !this.#canCreateFreshTransport()) {
      throw new Error("MCP reconnect requires fresh client and transport factories (or a stdio command)");
    }
    const pending = this.#reconnectQueue.then(async () => {
      this.#assertOpen();
      throwIfAborted(signal);
      this.#lifecycleEpoch += 1;
      const connection = this.#connecting;
      await this.#disconnectConnection();
      await connection?.catch(() => undefined);
      this.#serverTools.clear();
      this.#toolPolicies.clear();
      this.#assertOpen();
      await this.#ensureConnected(signal);
    });
    this.#reconnectQueue = pending.catch(() => undefined);
    return pending;
  }

  async health(): Promise<EdgeAdapterHealth> {
    const status = this.#closed
      ? "closed"
      : this.#connected
        ? (this.#lastError === undefined ? "healthy" : "degraded")
        : "unavailable";
    return {
      sourceId: this.sourceId,
      sourceType: SOURCE_TYPE,
      status,
      checkedAt: this.#checkedAt,
      ...(this.#lastError === undefined
        ? {}
        : { message: boundedText(this.#lastError, MAX_HEALTH_MESSAGE_BYTES), retryAfterMs: 250 }),
    };
  }

  release(_context: EdgeReleaseContext): Promise<void> {
    if (this.#releasePromise !== undefined) return this.#releasePromise;
    this.#closed = true;
    this.#lifecycleEpoch += 1;
    const connection = this.#connecting;
    const pending = (async () => {
      await this.#disconnectConnection();
      await connection?.catch(() => undefined);
      await this.#disconnectConnection();
      this.#connected = false;
      this.#serverTools.clear();
      this.#toolPolicies.clear();
    })();
    this.#releasePromise = pending;
    return pending;
  }

  async #ensureConnected(signal?: AbortSignal): Promise<void> {
    this.#assertOpen();
    throwIfAborted(signal);
    if (this.#connected) return;
    if (this.#connecting !== undefined) return this.#connecting;
    const pending = this.#connect(signal).finally(() => {
      this.#connecting = undefined;
    });
    this.#connecting = pending;
    return pending;
  }

  async #connect(signal?: AbortSignal): Promise<void> {
    const epoch = this.#lifecycleEpoch;
    throwIfAborted(signal);
    let client: Client | undefined;
    let transportResult: { transport: Transport | undefined; owns: boolean } | undefined;
    let ownsClient = false;
    let ownsTransport = false;
    let claimedConnection = false;
    try {
      client = this.#client ?? await this.#newClient();
      const injectedClient = this.#options.client !== undefined && client === this.#options.client;
      ownsClient = this.#options.ownsClient ?? !injectedClient;
      this.#assertConnectionCurrent(epoch, signal);
      transportResult = await this.#newTransport();
      ownsTransport = this.#options.ownsTransport
        ?? (transportResult.owns || !injectedClient);
      assertCompatibleOwnership(ownsClient, ownsTransport);
      this.#assertConnectionCurrent(epoch, signal);
      const transport = transportResult.transport;
      if (transport === undefined) {
        // A supplied, already-connected client remains caller-owned.
        const hasCallerConnection = !("transport" in client) || client.transport !== undefined;
        if (this.#client !== undefined && hasCallerConnection) {
          this.#client = client;
          ownsClient = this.#options.ownsClient ?? false;
          ownsTransport = this.#options.ownsTransport ?? ownsClient;
          assertCompatibleOwnership(ownsClient, ownsTransport);
          this.#ownsClient = ownsClient;
          this.#ownsTransport = ownsTransport;
          this.#connected = true;
          return;
        }
        throw new Error("MCP adapter has no transport factory or stdio command");
      }
      // The SDK client assumes ownership of the attached transport. Preserve
      // caller ownership only when the caller also supplied the client.
      this.#client = client;
      this.#transport = transport;
      this.#ownsClient = ownsClient;
      this.#ownsTransport = ownsTransport;
      claimedConnection = true;
      client.onclose = () => {
        if (this.#client !== client) return;
        this.#connected = false;
        this.#transport = undefined;
        this.#ownsClient = false;
        this.#ownsTransport = false;
        this.#serverTools.clear();
        this.#toolPolicies.clear();
        this.#lifecycleEpoch += 1;
        // A closed SDK client cannot be connected again. Clear it even when
        // the caller supplied the client so a later discover cannot
        // accidentally treat the stale transport as a live connection.
        this.#client = undefined;
        if (!this.#closed) this.#lastError = "MCP transport closed";
        this.#checkedAt = new Date().toISOString();
      };
      client.onerror = (error) => {
        if (this.#client !== client || this.#closed) return;
        this.#lastError = `MCP transport error: ${this.#safeError(error)}`;
        this.#checkedAt = new Date().toISOString();
      };
      await client.connect(transport, requestOptions(signal, this.#timeoutMs));
      this.#assertConnectionCurrent(epoch, signal);
      this.#connected = true;
      this.#lastError = undefined;
      this.#checkedAt = new Date().toISOString();
    } catch (error) {
      this.#connected = false;
      this.#lastError = this.#safeError(error);
      this.#checkedAt = new Date().toISOString();
      const ownsClaimedConnection = claimedConnection
        && ((client !== undefined && this.#client === client)
          || this.#transport === transportResult?.transport);
      if (client !== undefined && this.#client === client) this.#client = undefined;
      if (this.#transport === transportResult?.transport) this.#transport = undefined;
      if (ownsClaimedConnection) {
        this.#ownsClient = false;
        this.#ownsTransport = false;
      }
      if (client !== undefined
        && transportResult?.transport !== undefined
        && (!claimedConnection || ownsClaimedConnection)) {
        await this.#closeResources(
          client,
          transportResult.transport,
          ownsClient,
          ownsTransport,
        ).catch(() => undefined);
      }
      if (client !== undefined
        && transportResult?.transport === undefined
        && ownsClient
        && (!claimedConnection || ownsClaimedConnection)) {
        await client.close().catch(() => undefined);
      }
      throw error;
    }
  }

  async #newClient(): Promise<Client> {
    if (this.#options.clientFactory !== undefined) return this.#options.clientFactory();
    if (this.#options.client !== undefined) {
      throw new Error("MCP reconnect requires a clientFactory after an injected client is closed");
    }
    // A fresh client is needed when a stdio process is restarted. Client state
    // is intentionally otherwise private to this adapter.
    const { Client: SdkClient } = await import("@modelcontextprotocol/sdk/client/index.js");
    return new SdkClient({ name: "nausicaa-mowe", version: this.#options.adapterVersion ?? "0.1.0" });
  }

  async #newTransport(): Promise<{ transport: Transport | undefined; owns: boolean }> {
    if (this.#initialTransport !== undefined) {
      const transport = this.#initialTransport;
      this.#initialTransport = undefined;
      return { transport, owns: false };
    }
    if (this.#options.transportFactory !== undefined) {
      return { transport: await this.#options.transportFactory(), owns: true };
    }
    if (this.#httpOptions !== undefined) {
      const http = this.#httpOptions;
      const endpoint = typeof http.endpoint === "string" ? new URL(http.endpoint) : new URL(http.endpoint.toString());
      const requestInit = sanitizeRequestInit(http.requestInit, http.headers);
      return {
        // SDK 1.30.0's StreamableHTTP transport exposes an optional sessionId
        // while its Transport interface marks it as required under
        // exactOptionalPropertyTypes. The runtime contract is compatible.
        transport: new StreamableHTTPClientTransport(endpoint, {
          ...(requestInit === undefined ? {} : { requestInit }),
          ...(http.fetch === undefined ? {} : { fetch: http.fetch }),
          ...(http.sessionId === undefined ? {} : { sessionId: http.sessionId }),
        }) as unknown as Transport,
        owns: true,
      };
    }
    if (this.#options.command !== undefined) {
      const server: StdioServerParameters = {
        command: this.#options.command,
        args: [...(this.#options.args ?? [])],
        ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
        ...(this.#options.env === undefined ? {} : { env: { ...this.#options.env } }),
        stderr: "pipe",
      };
      return { transport: new StdioClientTransport(server), owns: true };
    }
    return { transport: undefined, owns: false };
  }

  async #disconnectConnection(): Promise<void> {
    const client = this.#client;
    const transport = this.#transport;
    const ownsClient = this.#ownsClient;
    const ownsTransport = this.#ownsTransport;
    this.#client = undefined;
    this.#transport = undefined;
    this.#connected = false;
    this.#ownsClient = false;
    this.#ownsTransport = false;
    if (client === undefined && transport === undefined) return;
    try {
      // Client.close() also closes its transport. If either side was injected,
      // avoid taking ownership of the caller's resource implicitly.
      if (client !== undefined && transport !== undefined) {
        await this.#closeResources(client, transport, ownsClient, ownsTransport);
      } else if (client !== undefined && ownsClient) await client.close();
      else if (transport !== undefined && ownsTransport) await transport.close();
    } catch (error) {
      this.#lastError = `MCP close failed: ${this.#safeError(error)}`;
    }
  }

  async #closeResources(
    client: Client,
    transport: Transport,
    ownsClient: boolean,
    ownsTransport: boolean,
  ): Promise<void> {
    if (ownsClient && ownsTransport) {
      const attached = client.transport === transport;
      let closeError: unknown;
      try {
        await client.close();
      } catch (error) {
        closeError = error;
      }
      // Client.close() normally closes its attached transport. If it failed,
      // make a best-effort direct close so a broken client cannot leak it.
      if (!attached || closeError !== undefined) {
        try {
          await transport.close();
        } catch (error) {
          closeError ??= error;
        }
      }
      if (closeError !== undefined) throw closeError;
      return;
    }
    if (ownsTransport) await transport.close();
  }

  #canCreateFreshClient(): boolean {
    return this.#options.clientFactory !== undefined || this.#options.client === undefined;
  }

  #canCreateFreshTransport(): boolean {
    // An injected one-shot transport is deliberately not replaced by an
    // endpoint-created network transport during reconnect. Embedders that
    // want replacement must provide an explicit factory.
    if (this.#options.transport !== undefined && this.#options.transportFactory === undefined) return false;
    return this.#options.transportFactory !== undefined
      || this.#options.command !== undefined
      || this.#httpOptions !== undefined;
  }

  #assertConnectionCurrent(epoch: number, signal?: AbortSignal): void {
    throwIfAborted(signal);
    if (this.#closed || epoch !== this.#lifecycleEpoch) {
      throw new Error(`MCP edge ${this.sourceId} connection was superseded`);
    }
  }

  #manifest(tool: McpTool, policy: McpToolPolicy): EdgeManifest {
    const serverVersion = this.#client?.getServerVersion()?.version ?? "unknown";
    const inputSchema = schemaForManifest(tool.inputSchema, this.#maxSchemaBytes);
    const outputSchema = tool.outputSchema === undefined
      ? { type: "object" as const, properties: {} }
      : schemaForManifest(tool.outputSchema, this.#maxSchemaBytes);
    const manifest: EdgeManifestInput = {
      manifestVersion: 1,
      sourceId: this.sourceId,
      sourceType: SOURCE_TYPE,
      capabilityName: capabilityName(this.sourceId, tool.name),
      capabilityVersion: serverVersion,
      schemaVersion: this.#options.schemaVersion ?? DEFAULT_SCHEMA_VERSION,
      description: tool.description ?? `MCP tool ${tool.name}`,
      inputSchema,
      outputSchema,
      effect: policy.effect ?? "external",
      scope: policy.scope ?? "run",
      cancellable: policy.cancellable ?? true,
      idempotent: policy.idempotent ?? false,
      recovery: policy.recovery ?? "none",
      adapterVersion: this.#options.adapterVersion ?? "0.1.0",
      adapterCompatibility: this.#options.adapterCompatibility ?? ">=2025-03-26",
      provenance: {
        upstreamName: this.#options.provenance?.upstreamName ?? this.sourceId,
        upstreamVersion: this.#options.provenance?.upstreamVersion ?? serverVersion,
        license: this.#options.provenance?.license ?? "UNKNOWN",
        ...(this.#options.provenance?.author === undefined ? {} : { author: this.#options.provenance.author }),
        sourceUri: safeProvenanceUri(
          this.#options.provenance?.sourceUri ?? `mcp://${this.sourceId}`,
          this.#httpOptions?.endpoint,
        ),
      },
    };
    return createEdgeManifest(manifest);
  }

  #metadata(tool: McpTool): MoweToolMetadata {
    const policy = this.#policy(tool);
    const timeoutMs = policy.timeoutMs === undefined
      ? this.#timeoutMs
      : boundedPositiveInteger(policy.timeoutMs, this.#timeoutMs, 60 * 60 * 1000, "policy.timeoutMs");
    // No MCP annotation is consulted here. Missing/untrusted host policy is
    // deliberately treated as an external, approval-gated operation.
    return {
      effect: policy.effect ?? "external",
      scope: policy.scope ?? "run",
      requiresApproval: policy.requiresApproval ?? true,
      deterministic: policy.deterministic ?? false,
      supportsBatch: policy.supportsBatch ?? false,
      concurrencySafe: policy.concurrencySafe ?? false,
      supportsStreaming: policy.supportsStreaming ?? false,
      timeoutMs,
      ...(policy.maxConcurrency === undefined ? {} : { maxConcurrency: policy.maxConcurrency }),
      inputKinds: policy.inputKinds ?? ["json"],
      outputKinds: policy.outputKinds ?? ["json", "text", "image"],
      version: this.#client?.getServerVersion()?.version ?? "unknown",
    };
  }

  #policy(tool: McpTool): McpToolPolicy {
    return this.#toolPolicies.get(tool.name) ?? this.#resolvePolicy(tool);
  }

  #resolvePolicy(tool: McpTool): McpToolPolicy {
    if (typeof this.#options.policy === "function") return snapshotPolicy(this.#options.policy(tool));
    return snapshotPolicy(this.#options.policy?.[tool.name]);
  }

  async #execute(
    remoteName: string,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = this.#timeoutMs,
  ): Promise<ToolResult> {
    try {
      throwIfAborted(signal);
      if (!isRecord(arguments_)) throw new TypeError("MCP tool arguments must be an object");
      await this.#ensureConnected(signal);
      const response = await this.#requireClient().callTool(
        { name: remoteName, arguments: arguments_ },
        undefined,
        requestOptions(signal, timeoutMs),
      );
      if (!hasMcpContent(response)) {
        return {
          content: boundedText(
            "MCP server returned a task handle; task-based execution is not supported by this edge yet",
            this.#maxResultBytes,
          ),
          isError: true,
        };
      }
      const result = projectMcpToolResult(response, {
        maxBytes: this.#maxResultBytes,
        maxBlocks: this.#maxResultBlocks,
        maxImageBytes: this.#maxResultImageBytes,
        maxStructuredBytes: this.#maxResultStructuredBytes,
      });
      if (result.isError && !response.isError) {
        this.#lastError = `MCP tool ${safeName(remoteName)} returned content outside adapter limits`;
        this.#checkedAt = new Date().toISOString();
      }
      return result;
    } catch (error) {
      const cancelled = signal?.aborted || isAbortError(error);
      const message = cancelled
        ? `MCP tool ${safeName(remoteName)} was cancelled`
        : isTimeoutError(error)
          ? `MCP tool ${safeName(remoteName)} timed out`
          : `MCP tool ${safeName(remoteName)} failed: ${this.#safeError(error)}`;
      this.#lastError = message;
      this.#checkedAt = new Date().toISOString();
      return {
        content: boundedText(message, this.#maxResultBytes),
        isError: true,
      };
    }
  }

  #requireClient(): Client {
    if (this.#client === undefined) throw new Error("MCP client is not connected");
    return this.#client;
  }

  #safeError(error: unknown): string {
    return safeError(error, this.#diagnosticRedactions);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error(`MCP edge ${this.sourceId} is closed`);
  }
}

interface McpToolRecord {
  readonly tool: McpTool;
  readonly capabilityName: string;
  readonly manifestHash: string;
}

function capabilityName(sourceId: string, remoteName: string): string {
  return `mcp__${namespacePart(sourceId)}__${namespacePart(remoteName)}`;
}

function namespacePart(value: string): string {
  const trimmed = value.trim();
  if (/^[A-Za-z0-9_-]+$/.test(trimmed) && trimmed.length <= 64) return trimmed;
  const readable = trimmed.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return `${readable.length === 0 ? "tool" : readable}_${stableTextHash(trimmed)}`;
}

function isUsableMcpTool(tool: McpTool, maxSchemaBytes: number): boolean {
  if (typeof tool?.name !== "string"
    || tool.name.trim().length === 0
    || typeof tool.inputSchema !== "object"
    || tool.inputSchema === null
    || tool.inputSchema.type !== "object"
    || schemaBytes(tool.inputSchema) > maxSchemaBytes
    || (tool.outputSchema !== undefined && schemaBytes(tool.outputSchema) > maxSchemaBytes)) {
    return false;
  }
  try {
    structuredClone(tool.inputSchema);
    if (tool.outputSchema !== undefined) structuredClone(tool.outputSchema);
    return true;
  } catch {
    return false;
  }
}

function schemaForManifest(value: { type: "object"; [key: string]: unknown }, maxBytes: number): JsonSchema {
  if (schemaBytes(value) > maxBytes) throw new Error("MCP schema exceeds adapter limit");
  return structuredClone(value) as JsonSchema;
}

function schemaBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function projectMcpToolResult(
  response: CallToolResult,
  limits: McpResultProjectionLimits,
): ToolResult {
  const maxBytes = boundedPositiveInteger(limits.maxBytes, DEFAULT_MAX_RESULT_BYTES, 64 * 1024 * 1024, "maxBytes");
  const maxBlocks = boundedPositiveInteger(limits.maxBlocks, MAX_CONTENT_BLOCKS, MAX_CONTENT_BLOCKS, "maxBlocks");
  const maxImageBytes = boundedPositiveInteger(
    limits.maxImageBytes,
    Math.min(maxBytes, MAX_RESULT_IMAGE_BYTES),
    MAX_RESULT_IMAGE_BYTES,
    "maxImageBytes",
  );
  const maxStructuredBytes = boundedPositiveInteger(
    limits.maxStructuredBytes,
    Math.min(maxBytes, MAX_RESULT_STRUCTURED_BYTES),
    MAX_RESULT_STRUCTURED_BYTES,
    "maxStructuredBytes",
  );
  const images: UserImage[] = [];
  const text: string[] = [];
  let unsupported = 0;
  let usedBytes = 0;
  let imageBytes = 0;
  let exceededLimit = false;
  const blocks = Array.isArray(response.content) ? response.content : [];
  if (!Array.isArray(response.content)) exceededLimit = true;
  if (blocks.length > maxBlocks) {
    unsupported += blocks.length - maxBlocks;
    exceededLimit = true;
  }
  for (const block of blocks.slice(0, maxBlocks)) {
    if (isTextBlock(block)) {
      const remaining = Math.max(0, maxBytes - usedBytes);
      const part = boundedText(block.text, remaining);
      if (Buffer.byteLength(block.text, "utf8") > remaining) exceededLimit = true;
      if (part.length > 0) text.push(part);
      usedBytes += Buffer.byteLength(part);
      continue;
    }
    if (isImageBlock(block)) {
      const image = { type: "image" as const, data: block.data, mimeType: block.mimeType };
      if (images.length >= MAX_USER_IMAGES) {
        unsupported += 1;
        exceededLimit = true;
        continue;
      }
      try {
        validateUserImages([...images, image]);
        const decodedBytes = Buffer.byteLength(image.data, "base64");
        const outputBytes = Buffer.byteLength(image.data, "utf8");
        if (imageBytes + decodedBytes <= maxImageBytes && usedBytes + outputBytes <= maxBytes) {
          images.push(image);
          usedBytes += outputBytes;
          imageBytes += decodedBytes;
        } else {
          unsupported += 1;
          exceededLimit = true;
        }
      } catch {
        unsupported += 1;
        exceededLimit = true;
      }
      continue;
    }
    const rawBlock: unknown = block;
    if (isRecord(rawBlock) && (rawBlock.type === "text" || rawBlock.type === "image")) {
      exceededLimit = true;
    }
    unsupported += 1;
  }
  if (response.structuredContent !== undefined) {
    const serialized = safeJson(response.structuredContent);
    const structuredBytes = Buffer.byteLength(serialized);
    if (structuredBytes > maxStructuredBytes) {
      exceededLimit = true;
      unsupported += 1;
    } else {
      const remaining = Math.max(0, maxBytes - usedBytes);
      const structured = boundedText(serialized, remaining);
      if (structuredBytes > remaining) exceededLimit = true;
      if (structured.length > 0) {
        text.push(structured);
        usedBytes += Buffer.byteLength(structured);
      }
    }
  }
  if (unsupported > 0) {
    text.push(`[MCP omitted ${Math.min(unsupported, MAX_UNSUPPORTED_BLOCKS)} unsupported or oversized content block(s)]`);
  }
  if (text.length === 0) text.push(response.isError ? "MCP tool returned an error" : "MCP tool returned no content");
  const outputImageBytes = images.reduce((total, image) => total + Buffer.byteLength(image.data, "utf8"), 0);
  const contentBudget = Math.max(0, maxBytes - outputImageBytes);
  const joined = text.join("\n");
  const content = boundedText(joined, contentBudget);
  if (Buffer.byteLength(joined) > contentBudget) {
    exceededLimit = true;
  }
  return {
    content,
    isError: response.isError === true || exceededLimit,
    ...(images.length === 0 ? {} : { images }),
  };
}

function hasMcpContent(
  response: Awaited<ReturnType<Client["callTool"]>>,
): response is CallToolResult {
  return "content" in response && Array.isArray(response.content);
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isImageBlock(value: unknown): value is { type: "image"; data: string; mimeType: string } {
  return isRecord(value)
    && value.type === "image"
    && typeof value.data === "string"
    && typeof value.mimeType === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestOptions(signal: AbortSignal | undefined, timeout: number): {
  signal?: AbortSignal;
  timeout: number;
  maxTotalTimeout: number;
} {
  return {
    timeout,
    maxTotalTimeout: timeout,
    ...(signal === undefined ? {} : { signal }),
  };
}

function boundedText(value: string, maxBytes: number): string {
  const safe = typeof value === "string" ? value : String(value);
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(safe) <= maxBytes) return safe;
  const marker = "\n[truncated]";
  const markerBytes = Buffer.byteLength(marker);
  if (maxBytes <= markerBytes) return utf8Prefix(marker, maxBytes);
  return `${utf8Prefix(safe, maxBytes - markerBytes)}${marker}`;
}

function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maxBytes) return value;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = Math.min(bytes.byteLength, maxBytes);
  while (end > 0) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

function stableTextHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const byte of Buffer.from(value)) {
    first = Math.imul(first ^ byte, 0x01000193) >>> 0;
    second = Math.imul(second ^ byte, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}

function isTimeoutError(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === -32001;
}

function normalizeHttpOptions(options: McpEdgeAdapterOptions): McpStreamableHttpOptions | undefined {
  if (options.streamableHttp !== undefined && options.http !== undefined) {
    throw new TypeError("MCP streamableHttp and http options are aliases; provide only one");
  }
  const nested = options.streamableHttp ?? options.http;
  if (options.endpoint !== undefined && nested !== undefined) {
    throw new TypeError("MCP endpoint cannot be combined with nested HTTP options");
  }
  const endpoint = options.endpoint ?? nested?.endpoint;
  const hasTopLevelHttpOptions = options.headers !== undefined
    || options.sessionId !== undefined
    || options.fetch !== undefined
    || options.requestInit !== undefined;
  if (endpoint === undefined) {
    if (hasTopLevelHttpOptions) {
      throw new TypeError("MCP HTTP headers, sessionId, fetch, and requestInit require an endpoint");
    }
    return undefined;
  }
  const normalizedEndpoint = normalizeEndpoint(endpoint);
  return {
    endpoint: normalizedEndpoint,
    ...(options.headers !== undefined
      ? { headers: options.headers }
      : nested?.headers === undefined ? {} : { headers: nested.headers }),
    ...(options.sessionId !== undefined
      ? { sessionId: options.sessionId }
      : nested?.sessionId === undefined ? {} : { sessionId: nested.sessionId }),
    ...(options.requestInit !== undefined
      ? { requestInit: options.requestInit }
      : nested?.requestInit === undefined ? {} : { requestInit: nested.requestInit }),
    ...(options.fetch !== undefined
      ? { fetch: options.fetch }
      : nested?.fetch === undefined ? {} : { fetch: nested.fetch }),
  };
}

function normalizeEndpoint(value: string | URL): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value instanceof URL ? value.toString() : value);
  } catch {
    throw new TypeError("MCP endpoint must be a valid URL");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new TypeError("MCP endpoint must use http or https");
  }
  if (endpoint.username.length > 0 || endpoint.password.length > 0) {
    throw new TypeError("MCP endpoint must not contain embedded credentials");
  }
  return endpoint;
}

function snapshotHttpOptions(options: McpStreamableHttpOptions): McpStreamableHttpOptions {
  const headers = options.headers === undefined
    ? undefined
    : Object.freeze({ ...options.headers });
  const requestInit = options.requestInit === undefined
    ? undefined
    : snapshotRequestInit(options.requestInit);
  return Object.freeze({
    endpoint: new URL(options.endpoint.toString()),
    ...(headers === undefined ? {} : { headers }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(requestInit === undefined ? {} : { requestInit }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

function snapshotRequestInit(requestInit: RequestInit): RequestInit {
  const headers = normalizeHeaders(requestInit.headers);
  return Object.freeze({
    ...requestInit,
    ...(Object.keys(headers).length === 0 ? {} : { headers: Object.freeze(headers) }),
  });
}

function sanitizeRequestInit(
  requestInit: RequestInit | undefined,
  extraHeaders: Readonly<Record<string, string>> | undefined,
): RequestInit | undefined {
  if (requestInit === undefined && extraHeaders === undefined) return undefined;
  const headers = normalizeHeaders(requestInit?.headers);
  for (const [name, value] of Object.entries(extraHeaders ?? {})) headers[name] = value;
  // Protocol/session identity is owned by the SDK. A caller-provided protocol
  // header must not override the negotiated value, and an explicit sessionId
  // is passed via the SDK option instead of being mixed with user headers.
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (lower === "mcp-protocol-version" || lower === "mcp-session-id") {
      delete headers[name];
    }
  }
  return {
    ...requestInit,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  };
}

type HeadersInput = NonNullable<RequestInit["headers"]>;

function normalizeHeaders(headers: HeadersInput | undefined): Record<string, string> {
  if (headers === undefined) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    const normalized: Record<string, string> = {};
    for (const [name, value] of headers) normalized[name] = value;
    return normalized;
  }
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") normalized[name] = value;
  }
  return normalized;
}

function collectDiagnosticRedactions(options: McpStreamableHttpOptions | undefined): readonly string[] {
  if (options === undefined) return Object.freeze([]);
  const endpoint = new URL(options.endpoint.toString());
  const values = new Set<string>();
  const add = (value: string | undefined) => {
    if (value !== undefined && value.length > 0) values.add(value);
  };
  add(endpoint.toString());
  add(endpoint.origin);
  add(endpoint.host);
  add(endpoint.hostname);
  add(endpoint.pathname);
  add(endpoint.search);
  for (const [name, value] of endpoint.searchParams) {
    add(name);
    add(value);
  }
  add(endpoint.username);
  add(endpoint.password);
  add(options.sessionId);
  for (const value of Object.values(options.headers ?? {})) add(value);
  for (const value of Object.values(normalizeHeaders(options.requestInit?.headers))) add(value);
  return Object.freeze([...values].sort((left, right) => right.length - left.length));
}

function safeProvenanceUri(value: string, endpoint: string | URL | undefined): string {
  const sourceUri = String(value);
  if (endpoint !== undefined) {
    const redacted = new URL(endpoint.toString());
    const source = tryParseUrl(sourceUri);
    if (source !== undefined && source.host === redacted.host) return `mcp://${redacted.hostname}`;
    if (sourceUri === redacted.toString() || sourceUri === redacted.origin) return `mcp://${redacted.hostname}`;
  }
  const parsed = tryParseUrl(sourceUri);
  if (parsed === undefined) return sourceUri;
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function tryParseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "[unserializable structured content]";
  }
}

function safeError(error: unknown, redactions: readonly string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return boundedText(redactDiagnosticText(message, redactions).replace(/[\r\n]+/g, " "), MAX_SAFE_TEXT);
}

function redactDiagnosticText(message: string, redactions: readonly string[]): string {
  let redacted = message;
  for (const secret of redactions) {
    if (secret.length > 0) redacted = redacted.replaceAll(secret, "<redacted>");
  }
  return redacted;
}

function safeToolName(tool: McpTool): string {
  return typeof tool?.name === "string" ? safeDiagnosticValue(tool.name) : "<unknown>";
}

function safeName(value: string): string {
  return safeDiagnosticValue(value);
}

function safeCursor(value: string): string {
  return safeDiagnosticValue(value);
}

function safeDiagnosticValue(value: string): string {
  return boundedText(value.replace(/[\u0000-\u001f\u007f]+/gu, " "), 128)
    .replace(/[\u0000-\u001f\u007f]+/gu, " ");
}

function compareText(left: string, right: string): number {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function compareMcpTools(left: McpTool, right: McpTool): number {
  const nameOrder = compareText(left.name, right.name);
  if (nameOrder !== 0) return nameOrder;
  // Duplicate remote names are malformed MCP input. Keep the winner stable
  // even when a server happens to reorder equivalent declarations.
  return compareText(safeJson(left), safeJson(right));
}

function snapshotOptions(options: McpEdgeAdapterOptions): McpEdgeAdapterOptions {
  const policy = typeof options.policy === "function" || options.policy === undefined
    ? options.policy
    : Object.freeze(Object.fromEntries(Object.entries(options.policy).map(([name, value]) => [
        name,
        snapshotPolicy(value),
      ])));
  return Object.freeze({
    ...options,
    ...(options.args === undefined ? {} : { args: Object.freeze([...options.args]) }),
    ...(options.env === undefined ? {} : { env: Object.freeze({ ...options.env }) }),
    ...(options.provenance === undefined
      ? {}
      : { provenance: Object.freeze({ ...options.provenance }) }),
    ...(policy === undefined ? {} : { policy }),
  });
}

function snapshotPolicy(policy: McpToolPolicy | undefined): McpToolPolicy {
  if (policy === undefined) return Object.freeze({});
  const cloned = structuredClone(policy);
  return Object.freeze({
    ...cloned,
    ...(cloned.inputKinds === undefined ? {} : { inputKinds: Object.freeze([...cloned.inputKinds]) }),
    ...(cloned.outputKinds === undefined ? {} : { outputKinds: Object.freeze([...cloned.outputKinds]) }),
  });
}

function assertCompatibleOwnership(ownsClient: boolean, ownsTransport: boolean): void {
  if (ownsClient && !ownsTransport) {
    throw new TypeError("MCP client ownership requires transport ownership because the SDK closes them together");
  }
}

function assertOptionalBoolean(value: boolean | undefined, name: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new TypeError(`${name} must be a boolean`);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function boundedPositiveInteger(value: number | undefined, fallback: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new RangeError(`${name} must be an integer between 1 and ${max}`);
  return value;
}
