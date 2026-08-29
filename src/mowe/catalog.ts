import type { AgentTool, ToolDefinition } from "../domain/ports.js";
import type {
  MoweCapability,
  MoweDataKind,
  MoweAgentTool,
  MoweToolDefinition,
  MoweToolEntry,
  MoweToolMetadata,
  MoweToolScope,
  ResolvedMoweToolMetadata,
} from "./types.js";

const DEFAULT_VERSION = "1";
const DEFAULT_SCOPE: MoweToolScope = "run";
const DATA_KINDS: readonly MoweDataKind[] = ["text", "json", "image", "binary", "artifact"];
const EFFECTS: readonly MoweToolMetadata["effect"][] = ["read", "compute", "write", "external"];
const SCOPES: readonly MoweToolScope[] = ["workspace", "run", "lane", "host"];

/**
 * Metadata for the first-party tool surface.  The map describes capabilities
 * that already exist in `src/tools` and runtime tool adapters; it does not add
 * model-visible tools by itself.  Callers can pass extra AgentTools and their
 * metadata without changing the AgentTool contract.
 */
export const FIRST_PARTY_MOWE_METADATA: Readonly<Record<string, MoweToolMetadata>> = Object.freeze({
  read_file: Object.freeze({
    effect: "read",
    deterministic: true,
    supportsBatch: true,
    concurrencySafe: true,
    scope: "workspace",
    inputKinds: ["text"] as const,
    outputKinds: ["json", "text"] as const,
  }),
  list_files: Object.freeze({
    effect: "read",
    deterministic: true,
    supportsBatch: true,
    concurrencySafe: true,
    scope: "workspace",
    inputKinds: ["text"] as const,
    outputKinds: ["json", "text"] as const,
  }),
  grep: Object.freeze({
    effect: "read",
    deterministic: true,
    supportsBatch: true,
    concurrencySafe: true,
    scope: "workspace",
    inputKinds: ["text"] as const,
    outputKinds: ["json", "text"] as const,
  }),
  find: Object.freeze({
    effect: "read",
    deterministic: true,
    supportsBatch: true,
    concurrencySafe: true,
    scope: "workspace",
    inputKinds: ["text"] as const,
    outputKinds: ["json", "text"] as const,
  }),
  file_info: Object.freeze({
    effect: "read",
    deterministic: true,
    supportsBatch: true,
    concurrencySafe: true,
    scope: "workspace",
    inputKinds: ["text"] as const,
    outputKinds: ["json", "text"] as const,
  }),
  read_image: Object.freeze({
    effect: "read",
    deterministic: true,
    supportsBatch: true,
    concurrencySafe: true,
    scope: "workspace",
    inputKinds: ["text"] as const,
    outputKinds: ["image", "json"] as const,
  }),
  web_fetch: Object.freeze({
    effect: "external",
    deterministic: false,
    supportsBatch: false,
    concurrencySafe: true,
    scope: "run",
    inputKinds: ["text"] as const,
    outputKinds: ["json", "text", "artifact"] as const,
  }),
  web_search: Object.freeze({
    effect: "external",
    deterministic: false,
    supportsBatch: true,
    concurrencySafe: true,
    scope: "run",
    inputKinds: ["text"] as const,
    outputKinds: ["json", "text"] as const,
  }),
  write_file: Object.freeze({
    effect: "write",
    deterministic: false,
    supportsBatch: false,
    concurrencySafe: false,
    scope: "workspace",
    inputKinds: ["text"] as const,
    outputKinds: ["json", "text"] as const,
  }),
  edit: Object.freeze({
    effect: "write",
    deterministic: false,
    supportsBatch: false,
    concurrencySafe: false,
    scope: "workspace",
    inputKinds: ["text"] as const,
    outputKinds: ["json", "text"] as const,
  }),
  directory_create: Object.freeze({
    effect: "write",
    deterministic: false,
    supportsBatch: false,
    concurrencySafe: false,
    scope: "workspace",
    inputKinds: ["text"] as const,
    outputKinds: ["json", "text"] as const,
  }),
  path_copy: Object.freeze({
    effect: "write",
    deterministic: false,
    supportsBatch: false,
    concurrencySafe: false,
    scope: "workspace",
    inputKinds: ["text"] as const,
    outputKinds: ["json", "text"] as const,
  }),
  path_move: Object.freeze({
    effect: "write",
    deterministic: false,
    supportsBatch: false,
    concurrencySafe: false,
    scope: "workspace",
    inputKinds: ["text"] as const,
    outputKinds: ["json", "text"] as const,
  }),
  path_delete: Object.freeze({
    effect: "write",
    deterministic: false,
    supportsBatch: false,
    concurrencySafe: false,
    scope: "workspace",
    inputKinds: ["text"] as const,
    outputKinds: ["json", "text"] as const,
  }),
  bash: Object.freeze({
    effect: "external",
    deterministic: false,
    supportsBatch: false,
    concurrencySafe: false,
    scope: "workspace",
    inputKinds: ["text"] as const,
    outputKinds: ["json", "text", "artifact"] as const,
  }),
  delegate_task: Object.freeze({
    effect: "external",
    deterministic: false,
    supportsBatch: true,
    concurrencySafe: true,
    scope: "run",
    inputKinds: ["text", "artifact"] as const,
    outputKinds: ["json", "artifact"] as const,
  }),
  respond_to_advice: Object.freeze({
    // Acknowledging advice appends a durable Inbox event; treat it as a
    // write-side effect so callers cannot admit it through read-only lanes.
    effect: "write",
    deterministic: false,
    supportsBatch: false,
    concurrencySafe: false,
    scope: "run",
    inputKinds: ["text"] as const,
    outputKinds: ["json"] as const,
  }),
  process_start: Object.freeze({
    effect: "external",
    deterministic: false,
    supportsBatch: false,
    concurrencySafe: false,
    scope: "run",
    inputKinds: ["text"] as const,
    outputKinds: ["json", "text"] as const,
  }),
  process_status: Object.freeze({
    effect: "read",
    deterministic: false,
    supportsBatch: true,
    concurrencySafe: true,
    scope: "run",
    inputKinds: ["text"] as const,
    outputKinds: ["json"] as const,
  }),
  process_output: Object.freeze({
    effect: "read",
    deterministic: false,
    supportsBatch: true,
    concurrencySafe: true,
    scope: "run",
    inputKinds: ["text"] as const,
    outputKinds: ["json", "text"] as const,
  }),
  process_kill: Object.freeze({
    effect: "external",
    deterministic: false,
    supportsBatch: false,
    concurrencySafe: false,
    scope: "run",
    inputKinds: ["text"] as const,
    outputKinds: ["json"] as const,
  }),
  process_list: Object.freeze({
    effect: "read",
    deterministic: false,
    supportsBatch: false,
    concurrencySafe: true,
    scope: "run",
    inputKinds: ["text"] as const,
    outputKinds: ["json"] as const,
  }),
});

export class MoweCatalogError extends Error {
  override readonly name = "MoweCatalogError";
}

/** In-process registry. Mowe deliberately keeps registration boring and static. */
export class MoweCatalog {
  readonly #entries = new Map<string, MoweToolEntry>();

  constructor(tools: readonly AgentTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: AgentTool, metadata: MoweToolMetadata = {}): this {
    const name = normalizeToolName(tool.definition.name);
    if (name.length === 0) throw new MoweCatalogError("Tool names must not be empty");
    if (this.#entries.has(name)) throw new MoweCatalogError(`Duplicate tool: ${name}`);
    // Keep the provider-visible definition aligned with the catalog key. This
    // prevents a legacy tool with surrounding whitespace from being advertised
    // under one name and dispatched under another.
    const normalizedTool = tool.definition.name === name
      ? tool
      : {
          ...tool,
          definition: { ...tool.definition, name },
        };
    const embedded = (normalizedTool as MoweAgentTool).metadata;
    const firstParty = FIRST_PARTY_MOWE_METADATA[name];
    const merged = { ...firstParty, ...embedded, ...metadata };
    this.#entries.set(name, Object.freeze({
      tool: normalizedTool,
      metadata: resolveMetadata(merged, name),
    }));
    return this;
  }

  /** Register a collection while retaining the same duplicate-name checks. */
  registerMany(
    tools: readonly AgentTool[],
    metadataByName: Readonly<Record<string, MoweToolMetadata>> = {},
  ): this {
    for (const tool of tools) {
      const name = normalizeToolName(tool.definition.name);
      this.register(tool, metadataByName[name] ?? metadataByName[tool.definition.name] ?? {});
    }
    return this;
  }

  unregister(name: string): boolean {
    return this.#entries.delete(normalizeToolName(name));
  }

  get(name: string): MoweToolEntry | undefined {
    return this.#entries.get(normalizeToolName(name));
  }

  has(name: string): boolean {
    return this.#entries.has(normalizeToolName(name));
  }

  entries(): MoweToolEntry[] {
    return [...this.#entries.values()];
  }

  /**
   * Return model-facing definitions without leaking host-only Mowe metadata.
   * AgentTool definitions are already the provider-compatible shape.
   */
  modelDefinitions(): ToolDefinition[] {
    return this.entries().map(({ tool }) => cloneToolDefinition(tool.definition));
  }

  /** A stable capability inventory for TUI/help, routing, and diagnostics. */
  capabilities(): MoweCapability[] {
    return this.entries()
      .map(({ tool, metadata }) => ({
        name: tool.definition.name,
        description: tool.definition.description,
        metadata,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  definitions(): MoweToolDefinition[] {
    return this.entries().map(({ tool, metadata }) => ({
      ...cloneToolDefinition(tool.definition),
      metadata,
    }));
  }
}

/**
 * Attach host-only Mowe metadata without changing the provider-facing schema.
 * The returned object remains a normal AgentTool and can be passed anywhere
 * that accepts the existing interface.
 */
export function annotateTool(tool: AgentTool, metadata: MoweToolMetadata): MoweAgentTool {
  if (normalizeToolName(tool.definition.name).length === 0) {
    throw new MoweCatalogError("Tool names must not be empty");
  }
  return Object.freeze({ ...tool, metadata: Object.freeze({ ...metadata }) });
}

function normalizeToolName(value: string): string {
  return value.trim();
}

export function resolveMetadata(
  metadata: MoweToolMetadata = {},
  toolName?: string,
): ResolvedMoweToolMetadata {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new MoweCatalogError("metadata must be an object");
  }
  validateMetadataScalar(metadata);
  if (metadata.maxConcurrency !== undefined
    && (!Number.isSafeInteger(metadata.maxConcurrency)
      || metadata.maxConcurrency < 1
      || metadata.maxConcurrency > 64)) {
    throw new MoweCatalogError("maxConcurrency must be an integer between 1 and 64");
  }
  if (metadata.timeoutMs !== undefined
    && (!Number.isFinite(metadata.timeoutMs) || metadata.timeoutMs <= 0)) {
    throw new MoweCatalogError("timeoutMs must be a finite number greater than zero");
  }
  if (metadata.version !== undefined && metadata.version.trim().length === 0) {
    throw new MoweCatalogError("version must not be empty");
  }
  const defaults = defaultMetadata(toolName);
  const effect = metadata.effect ?? defaults.effect;
  if (!EFFECTS.includes(effect)) {
    throw new MoweCatalogError("effect must be read, compute, write, or external");
  }
  if (metadata.scope !== undefined && !SCOPES.includes(metadata.scope)) {
    throw new MoweCatalogError("scope must be workspace, run, lane, or host");
  }
  const inputKinds = normalizeKinds(metadata.inputKinds ?? defaults.inputKinds, "inputKinds");
  const outputKinds = normalizeKinds(metadata.outputKinds ?? defaults.outputKinds, "outputKinds");
  return Object.freeze({
    effect,
    version: metadata.version ?? DEFAULT_VERSION,
    deterministic: metadata.deterministic ?? isReadOnlyEffect(effect),
    supportsBatch: metadata.supportsBatch ?? isReadOnlyEffect(effect),
    concurrencySafe: metadata.concurrencySafe ?? (metadata.deterministic ?? isReadOnlyEffect(effect)),
    supportsStreaming: metadata.supportsStreaming ?? false,
    ...(metadata.timeoutMs === undefined ? {} : { timeoutMs: metadata.timeoutMs }),
    requiresApproval: metadata.requiresApproval ?? false,
    scope: metadata.scope ?? scopeForEffect(effect),
    inputKinds,
    outputKinds,
    ...(metadata.maxConcurrency === undefined ? {} : { maxConcurrency: metadata.maxConcurrency }),
  });
}

function validateMetadataScalar(metadata: MoweToolMetadata): void {
  if (metadata.effect !== undefined && typeof metadata.effect !== "string") {
    throw new MoweCatalogError("effect must be a string");
  }
  if (metadata.scope !== undefined && typeof metadata.scope !== "string") {
    throw new MoweCatalogError("scope must be a string");
  }
  if (metadata.version !== undefined
    && (typeof metadata.version !== "string" || metadata.version.trim().length === 0)) {
    throw new MoweCatalogError("version must be a non-empty string");
  }
  for (const field of ["deterministic", "supportsBatch", "concurrencySafe", "supportsStreaming", "requiresApproval"] as const) {
    if (metadata[field] !== undefined && typeof metadata[field] !== "boolean") {
      throw new MoweCatalogError(`${field} must be a boolean`);
    }
  }
}

function isReadOnlyEffect(effect: ResolvedMoweToolMetadata["effect"]): boolean {
  return effect === "read" || effect === "compute";
}

function defaultMetadata(toolName: string | undefined): {
  effect: ResolvedMoweToolMetadata["effect"];
  deterministic: boolean;
  supportsBatch: boolean;
  concurrencySafe: boolean;
  inputKinds: readonly MoweDataKind[];
  outputKinds: readonly MoweDataKind[];
} {
  if (toolName === "write_file" || toolName === "edit"
    || toolName === "directory_create" || toolName === "path_copy"
    || toolName === "path_move" || toolName === "path_delete") {
    return {
      effect: "write",
      deterministic: false,
      supportsBatch: false,
      concurrencySafe: false,
      inputKinds: ["text"],
      outputKinds: ["json", "text"],
    };
  }
  if (toolName === "bash" || toolName === "delegate_task") {
    return {
      effect: "external",
      deterministic: false,
      supportsBatch: false,
      concurrencySafe: false,
      inputKinds: ["text"],
      outputKinds: ["json", "text", "artifact"],
    };
  }
  if (toolName === "respond_to_advice") {
    return {
      effect: "write",
      deterministic: false,
      supportsBatch: false,
      concurrencySafe: false,
      inputKinds: ["text"],
      outputKinds: ["json"],
    };
  }
  // Preserve the original AgentTool compatibility contract: a caller-supplied
  // tool without Mowe metadata remains a normal deterministic capability.
  // Hosts that need a stricter effect boundary can register explicit metadata.
  return {
    effect: "read",
    deterministic: true,
    supportsBatch: true,
    concurrencySafe: true,
    inputKinds: ["json"],
    outputKinds: ["json", "text"],
  };
}

function scopeForEffect(effect: ResolvedMoweToolMetadata["effect"]): MoweToolScope {
  return effect === "read" || effect === "write" ? "workspace" : DEFAULT_SCOPE;
}

function normalizeKinds(
  kinds: readonly MoweDataKind[] | undefined,
  field: string,
): readonly MoweDataKind[] {
  if (kinds === undefined) return ["json"];
  const normalized = [...new Set(kinds)];
  if (normalized.some((kind) => !DATA_KINDS.includes(kind))) {
    throw new MoweCatalogError(`${field} contains an unsupported data kind`);
  }
  return Object.freeze(normalized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function toolDefinition(entry: MoweToolEntry): MoweToolDefinition {
  return { ...cloneToolDefinition(entry.tool.definition), metadata: entry.metadata };
}

/** Return an isolated provider-facing schema snapshot, including nested nodes. */
function cloneToolDefinition(definition: ToolDefinition): ToolDefinition {
  return {
    ...definition,
    parameters: structuredClone(definition.parameters),
  };
}

export function asCatalog(input: MoweCatalog | readonly AgentTool[]): MoweCatalog {
  return input instanceof MoweCatalog ? input : new MoweCatalog(input);
}

export type { ToolDefinition };
