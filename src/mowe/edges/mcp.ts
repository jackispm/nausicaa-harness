import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

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

export interface McpEdgeAdapterOptions {
  /** Stable host-owned identity. It is also used in the mcp__ namespace. */
  readonly sourceId: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Inject these for offline tests or an already-managed transport. */
  readonly client?: Client;
  readonly transport?: Transport;
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
}

export interface McpEdgeAdapter extends EdgeAdapter {
  readonly sourceType: "mcp";
  health(): Promise<EdgeAdapterHealth>;
  release(context: EdgeReleaseContext): Promise<void>;
  /** Reconnect only when a transport factory (or reusable client) is available. */
  reconnect(signal?: AbortSignal): Promise<void>;
}

const SOURCE_TYPE = "mcp" as const satisfies EdgeSourceType;
const DEFAULT_MAX_TOOLS = 256;
const DEFAULT_MAX_RESULT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_SCHEMA_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_SAFE_TEXT = 4_096;
const MAX_UNSUPPORTED_BLOCKS = 16;
const MAX_CONTENT_BLOCKS = 1_024;
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
  readonly #maxTools: number;
  readonly #maxResultBytes: number;
  readonly #maxSchemaBytes: number;
  readonly #timeoutMs: number;
  #client: Client | undefined;
  #transport: Transport | undefined;
  #initialTransport: Transport | undefined;
  #connected = false;
  #closed = false;
  #connecting: Promise<void> | undefined;
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
    if (options.command === undefined
      && options.transport === undefined
      && options.transportFactory === undefined
      && options.client === undefined
      && options.clientFactory === undefined) {
      throw new TypeError("MCP adapter requires command, transport, transportFactory, or client");
    }
    this.sourceId = options.sourceId;
    this.#options = options;
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
    this.#client = options.client;
  }

  async discover(context: EdgeDiscoveryContext): Promise<readonly EdgeManifest[]> {
    this.#assertOpen();
    await this.#ensureConnected(context.signal);
    const client = this.#requireClient();
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    this.#truncatedTools = false;
    this.#warnings = [];
    do {
      const response = await client.listTools(
        cursor === undefined ? undefined : { cursor },
        requestOptions(context.signal, this.#timeoutMs),
      );
      for (const tool of response.tools ?? []) {
        if (tools.length >= this.#maxTools) {
          this.#truncatedTools = true;
          break;
        }
        if (!isUsableMcpTool(tool, this.#maxSchemaBytes)) {
          this.#warnings.push(`Ignored MCP tool with invalid or oversized schema: ${safeToolName(tool)}`);
          continue;
        }
        const remoteName = tool.name;
        if (this.#serverTools.has(remoteName) || tools.some((item) => item.name === remoteName)) {
          this.#warnings.push(`Ignored duplicate MCP tool: ${remoteName}`);
          continue;
        }
        if (tools.some((item) => capabilityName(this.sourceId, item.name) === capabilityName(this.sourceId, remoteName))) {
          this.#warnings.push(`Ignored MCP tool with colliding namespace: ${remoteName}`);
          continue;
        }
        tools.push(tool);
      }
      cursor = response.nextCursor;
    } while (cursor !== undefined && tools.length < this.#maxTools);

    if (cursor !== undefined && tools.length >= this.#maxTools) this.#truncatedTools = true;
    this.#serverTools.clear();
    this.#toolPolicies.clear();
    const manifests: EdgeManifest[] = [];
    for (const tool of tools) {
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
        this.#warnings.push(`Ignored MCP tool ${safeToolName(tool)}: ${safeError(error)}`);
      }
    }
    this.#lastError = this.#truncatedTools
      ? `MCP tool list truncated at ${this.#maxTools} tools`
      : this.#warnings[0];
    this.#checkedAt = new Date().toISOString();
    return manifests;
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
    const tool: AgentTool = {
      definition: {
        name: manifest.capabilityName,
        description: manifest.description,
        parameters: structuredClone(manifest.inputSchema),
      },
      execute: async (arguments_, context) => this.#execute(sourceTool.tool.name, arguments_, context.signal),
    };
    return createEdgeCapability({
      manifest,
      tool,
      metadata: this.#metadata(sourceTool.tool),
    });
  }

  async reconnect(signal?: AbortSignal): Promise<void> {
    this.#assertOpen();
    await this.#disconnectTransport();
    this.#connected = false;
    await this.#ensureConnected(signal);
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
      ...(this.#lastError === undefined ? {} : { message: this.#lastError, retryAfterMs: 250 }),
    };
  }

  async release(_context: EdgeReleaseContext): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#disconnectTransport();
    this.#connected = false;
    this.#serverTools.clear();
  }

  async #ensureConnected(signal?: AbortSignal): Promise<void> {
    this.#assertOpen();
    if (this.#connected) return;
    if (this.#connecting !== undefined) return this.#connecting;
    const pending = this.#connect(signal).finally(() => {
      this.#connecting = undefined;
    });
    this.#connecting = pending;
    return pending;
  }

  async #connect(signal?: AbortSignal): Promise<void> {
    const client = this.#client ?? await this.#newClient();
    const transport = await this.#newTransport();
    if (transport === undefined) {
      // A caller may supply an already-connected SDK client. This is useful for
      // embedding and avoids claiming ownership of a transport we did not make.
      if (this.#client !== undefined && client.transport !== undefined) {
        this.#client = client;
        this.#connected = true;
        return;
      }
      throw new Error("MCP adapter has no transport factory or stdio command");
    }
    this.#client = client;
    this.#transport = transport;
    client.onclose = () => {
      this.#connected = false;
      this.#transport = undefined;
      if (!this.#closed) this.#lastError = "MCP transport closed";
      this.#checkedAt = new Date().toISOString();
    };
    client.onerror = (error) => {
      this.#lastError = `MCP transport error: ${safeError(error)}`;
      this.#checkedAt = new Date().toISOString();
    };
    try {
      await client.connect(transport, requestOptions(signal, this.#timeoutMs));
      this.#connected = true;
      this.#lastError = undefined;
      this.#checkedAt = new Date().toISOString();
    } catch (error) {
      this.#connected = false;
      this.#transport = undefined;
      this.#lastError = safeError(error);
      throw error;
    }
  }

  async #newClient(): Promise<Client> {
    if (this.#options.clientFactory !== undefined) return this.#options.clientFactory();
    // A fresh client is needed when a stdio process is restarted. Client state
    // is intentionally otherwise private to this adapter.
    const { Client: SdkClient } = await import("@modelcontextprotocol/sdk/client/index.js");
    return new SdkClient({ name: "nausicaa-mowe", version: this.#options.adapterVersion ?? "0.1.0" });
  }

  async #newTransport(): Promise<Transport | undefined> {
    if (this.#initialTransport !== undefined) {
      const transport = this.#initialTransport;
      this.#initialTransport = undefined;
      return transport;
    }
    if (this.#options.transportFactory !== undefined) return this.#options.transportFactory();
    if (this.#options.command !== undefined) {
      const server: StdioServerParameters = {
        command: this.#options.command,
        args: [...(this.#options.args ?? [])],
        ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
        ...(this.#options.env === undefined ? {} : { env: { ...this.#options.env } }),
        stderr: "pipe",
      };
      return new StdioClientTransport(server);
    }
    return undefined;
  }

  async #disconnectTransport(): Promise<void> {
    const client = this.#client;
    this.#transport = undefined;
    if (client === undefined) return;
    try {
      await client.close();
    } catch (error) {
      this.#lastError = `MCP close failed: ${safeError(error)}`;
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
        sourceUri: this.#options.provenance?.sourceUri ?? `mcp://${this.sourceId}`,
      },
    };
    return createEdgeManifest(manifest);
  }

  #metadata(tool: McpTool): MoweToolMetadata {
    const policy = this.#policy(tool);
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
      timeoutMs: policy.timeoutMs ?? this.#timeoutMs,
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
    if (typeof this.#options.policy === "function") return this.#options.policy(tool) ?? {};
    return this.#options.policy?.[tool.name] ?? {};
  }

  async #execute(remoteName: string, arguments_: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    try {
      throwIfAborted(signal);
      await this.#ensureConnected(signal);
      const response = await this.#requireClient().callTool(
        { name: remoteName, arguments: arguments_ },
        undefined,
        requestOptions(signal, this.#timeoutMs),
      );
      if (!hasMcpContent(response)) {
        return {
          content: "MCP server returned a task handle; task-based execution is not supported by this edge yet",
          isError: true,
        };
      }
      return mcpResultToToolResult(response, this.#maxResultBytes);
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw signal?.reason ?? error;
      }
      return {
        content: boundedText(`MCP tool ${remoteName} failed: ${safeError(error)}`, this.#maxResultBytes),
        isError: true,
      };
    }
  }

  #requireClient(): Client {
    if (this.#client === undefined) throw new Error("MCP client is not connected");
    return this.#client;
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

function mcpResultToToolResult(response: CallToolResult, maxBytes: number): ToolResult {
  const images: UserImage[] = [];
  const text: string[] = [];
  let unsupported = 0;
  let usedBytes = 0;
  const blocks = Array.isArray(response.content) ? response.content : [];
  if (blocks.length > MAX_CONTENT_BLOCKS) unsupported += blocks.length - MAX_CONTENT_BLOCKS;
  for (const block of blocks.slice(0, MAX_CONTENT_BLOCKS)) {
    if (block.type === "text") {
      const part = boundedText(block.text, Math.max(0, maxBytes - usedBytes));
      text.push(part);
      usedBytes += Buffer.byteLength(part);
      continue;
    }
    if (block.type === "image") {
      const image = { type: "image" as const, data: block.data, mimeType: block.mimeType };
      try {
        if (images.length >= MAX_USER_IMAGES) throw new Error("too many images");
        validateUserImages([...images, image]);
        const bytes = Buffer.byteLength(image.data, "base64");
        if (usedBytes + bytes <= maxBytes) {
          images.push(image);
          usedBytes += bytes;
        } else {
          unsupported += 1;
        }
      } catch {
        unsupported += 1;
      }
      continue;
    }
    unsupported += 1;
  }
  if (response.structuredContent !== undefined) {
    const structured = boundedText(safeJson(response.structuredContent), Math.max(0, maxBytes - usedBytes));
    if (structured.length > 0) text.push(structured);
  }
  if (unsupported > 0) {
    text.push(`[MCP omitted ${Math.min(unsupported, MAX_UNSUPPORTED_BLOCKS)} unsupported or oversized content block(s)]`);
  }
  if (text.length === 0) text.push(response.isError ? "MCP tool returned an error" : "MCP tool returned no content");
  const imageBytes = images.reduce((total, image) => total + Buffer.byteLength(image.data, "base64"), 0);
  return {
    content: boundedText(text.join("\n"), Math.max(0, maxBytes - imageBytes)),
    isError: response.isError === true,
    ...(images.length === 0 ? {} : { images }),
  };
}

function hasMcpContent(
  response: Awaited<ReturnType<Client["callTool"]>>,
): response is CallToolResult {
  return "content" in response && Array.isArray(response.content);
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

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "[unserializable structured content]";
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return boundedText(message.replace(/[\r\n]+/g, " "), MAX_SAFE_TEXT);
}

function safeToolName(tool: McpTool): string {
  return typeof tool?.name === "string" ? boundedText(tool.name, 128) : "<unknown>";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function boundedPositiveInteger(value: number | undefined, fallback: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new RangeError(`${name} must be an integer between 1 and ${max}`);
  return value;
}
