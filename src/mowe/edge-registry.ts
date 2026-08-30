import type { AgentTool } from "../domain/ports.js";
import { sha256, stableJson } from "../ledger/hash.js";
import { MoweCatalog } from "./catalog.js";
import type { MoweToolMetadata } from "./types.js";
import {
  assertEdgeAdapterOwnsManifest,
  createEdgeCapability,
  createEdgeCapabilitySnapshot,
  validateEdgeManifest,
} from "./edge-adapter.js";
import type {
  EdgeAdapter,
  EdgeAdapterHealth,
  EdgeCapability,
  EdgeCapabilitySnapshot,
  EdgeManifest,
  EdgeSourceType,
} from "./edge-types.js";

export type MoweEdgeAdapterLike = EdgeAdapter;
export type MoweEdgeKind = EdgeSourceType;

export type MoweEdgeHealth =
  | "registered"
  | "discovering"
  | "healthy"
  | "degraded"
  | "failed"
  | "disabled"
  | "closed";

export type MoweEdgeDiagnosticSeverity = "warning" | "error";

export interface MoweEdgeDiagnostic {
  readonly code:
    | "adapter-failed"
    | "adapter-invalid"
    | "manifest-invalid"
    | "manifest-mismatch"
    | "tool-invalid"
    | "tool-collision"
    | "catalog-rejected";
  readonly severity: MoweEdgeDiagnosticSeverity;
  readonly sourceId?: string;
  readonly toolName?: string;
  readonly message: string;
}

export interface MoweEdgeToolSnapshot {
  readonly name: string;
  readonly sourceId: string;
  readonly kind: EdgeSourceType;
  readonly version: string;
  readonly manifestHash: string;
  readonly capability: EdgeCapability;
  readonly tool: AgentTool;
  readonly metadata: MoweToolMetadata;
}

export interface MoweEdgeHealthSnapshot {
  readonly sourceId: string;
  readonly kind: EdgeSourceType;
  readonly enabled: boolean;
  readonly health: MoweEdgeHealth;
  readonly version?: string;
  readonly manifestHash?: string;
  readonly message?: string;
  readonly retryAfterMs?: number;
  readonly diagnostics: readonly MoweEdgeDiagnostic[];
}

export interface MoweEdgeSnapshot {
  readonly sourceId: string;
  readonly kind: EdgeSourceType;
  readonly enabled: boolean;
  readonly health: MoweEdgeHealth;
  readonly manifests: readonly EdgeManifest[];
  readonly provenance: readonly EdgeManifest["provenance"][];
  readonly tools: readonly MoweEdgeToolSnapshot[];
  readonly diagnostics: readonly MoweEdgeDiagnostic[];
}

/** A frozen catalog and edge diagnostics captured at one Turn boundary. */
export interface MoweEdgeRegistrySnapshot {
  readonly generation: number;
  readonly hash: string;
  readonly digest: string;
  readonly snapshotHash: string;
  readonly capabilitySnapshot: EdgeCapabilitySnapshot;
  readonly catalog: MoweCatalog;
  readonly edges: readonly MoweEdgeSnapshot[];
  readonly tools: readonly MoweEdgeToolSnapshot[];
  readonly capabilities: readonly EdgeCapability[];
  readonly diagnostics: readonly MoweEdgeDiagnostic[];
}

export interface MoweEdgeRegistryOptions {
  readonly catalog?: MoweCatalog | readonly AgentTool[];
  readonly adapters?: readonly EdgeAdapter[];
  readonly workspace?: string;
}

export interface MoweEdgeRefreshOptions {
  readonly workspace?: string;
  readonly signal?: AbortSignal;
}

interface RegisteredEdge {
  readonly adapter: EdgeAdapter;
  readonly sourceId: string;
  readonly sourceType: EdgeSourceType;
  enabled: boolean;
  health: MoweEdgeHealth;
  diagnostics: MoweEdgeDiagnostic[];
  manifests: EdgeManifest[];
  capabilities: EdgeCapability[];
  adapterHealth?: EdgeAdapterHealth | undefined;
}

interface LoadedCapability {
  readonly edge: RegisteredEdge;
  readonly capability: EdgeCapability;
  readonly fingerprint: string;
}

export class MoweEdgeRegistryError extends Error {
  override readonly name = "MoweEdgeRegistryError";
}

/**
 * Host-owned registry for edge adapters. Adapter declarations are loaded into
 * a fresh MoweCatalog and published as one immutable generation.
 */
export class MoweEdgeRegistry {
  readonly #baseCatalog: MoweCatalog;
  readonly #edges = new Map<string, RegisteredEdge>();
  readonly #workspace: string;
  #generation = -1;
  #closed = false;
  #refreshQueue: Promise<MoweEdgeRegistrySnapshot> = Promise.resolve(undefined as never);
  #current: MoweEdgeRegistrySnapshot;

  constructor(options: MoweEdgeRegistryOptions = {}) {
    this.#baseCatalog = cloneCatalog(options.catalog ?? []);
    this.#workspace = options.workspace ?? ".";
    this.#current = this.#buildSnapshot([], [], []);
    for (const adapter of options.adapters ?? []) this.register(adapter);
  }

  register(adapter: EdgeAdapter): this {
    if (this.#closed) throw new MoweEdgeRegistryError("Edge registry is closed");
    const sourceId = normalizeSourceId(adapter.sourceId);
    if (!isSourceType(adapter.sourceType)) {
      throw new MoweEdgeRegistryError("Edge adapter sourceType must be skill, mcp, or plugin");
    }
    if (typeof adapter.discover !== "function" || typeof adapter.load !== "function") {
      throw new MoweEdgeRegistryError("Edge adapter must expose discover() and load()");
    }
    if (this.#edges.has(sourceId)) {
      throw new MoweEdgeRegistryError(`Duplicate edge sourceId: ${sourceId}`);
    }
    this.#edges.set(sourceId, {
      adapter,
      sourceId,
      sourceType: adapter.sourceType,
      enabled: true,
      health: "registered",
      diagnostics: [],
      manifests: [],
      capabilities: [],
    });
    return this;
  }

  registerAdapter(adapter: EdgeAdapter): this {
    return this.register(adapter);
  }

  unregister(sourceId: string): boolean {
    return this.#edges.delete(normalizeSourceId(sourceId));
  }

  has(sourceId: string): boolean {
    return this.#edges.has(normalizeSourceId(sourceId));
  }

  enable(sourceId: string): this {
    const edge = this.#requireEdge(sourceId);
    edge.enabled = true;
    if (edge.health === "disabled") edge.health = "registered";
    return this;
  }

  disable(sourceId: string): this {
    const edge = this.#requireEdge(sourceId);
    edge.enabled = false;
    edge.health = "disabled";
    return this;
  }

  isEnabled(sourceId: string): boolean {
    return this.#requireEdge(sourceId).enabled;
  }

  snapshot(): MoweEdgeRegistrySnapshot {
    return this.#current;
  }

  getSnapshot(): MoweEdgeRegistrySnapshot {
    return this.snapshot();
  }

  get activeSnapshot(): MoweEdgeRegistrySnapshot {
    return this.snapshot();
  }

  get catalog(): MoweCatalog {
    return this.#current.catalog;
  }

  getCatalog(): MoweCatalog {
    return this.catalog;
  }

  catalogFor(snapshot: MoweEdgeRegistrySnapshot = this.#current): MoweCatalog {
    return snapshot.catalog;
  }

  setEnabled(sourceId: string, enabled: boolean): this {
    return enabled ? this.enable(sourceId) : this.disable(sourceId);
  }

  health(sourceId?: string): readonly MoweEdgeHealthSnapshot[] | MoweEdgeHealthSnapshot {
    const values = [...this.#edges.values()]
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
      .map((edge) => healthSnapshot(edge));
    if (sourceId !== undefined) {
      const found = values.find((item) => item.sourceId === normalizeSourceId(sourceId));
      if (found === undefined) throw new MoweEdgeRegistryError(`Unknown edge sourceId: ${sourceId}`);
      return found;
    }
    return values;
  }

  diagnostics(): readonly MoweEdgeDiagnostic[] {
    return this.#current.diagnostics;
  }

  refresh(options: MoweEdgeRefreshOptions = {}): Promise<MoweEdgeRegistrySnapshot> {
    const next = this.#refreshQueue.then(() => this.#performRefresh(options));
    this.#refreshQueue = next.catch(() => this.#current);
    return next;
  }

  discover(options: MoweEdgeRefreshOptions = {}): Promise<MoweEdgeRegistrySnapshot> {
    return this.refresh(options);
  }

  async refreshSource(sourceId: string, options: MoweEdgeRefreshOptions = {}): Promise<MoweEdgeRegistrySnapshot> {
    const target = normalizeSourceId(sourceId);
    if (!this.#edges.has(target)) throw new MoweEdgeRegistryError(`Unknown edge sourceId: ${sourceId}`);
    return this.refresh(options);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all([...this.#edges.values()].map(async (edge) => {
      const release = edge.adapter.release;
      if (release === undefined) {
        edge.health = "closed";
        edge.enabled = false;
        return;
      }
      try {
        await release.call(edge.adapter, { reason: "shutdown" });
        edge.health = "closed";
        edge.enabled = false;
      } catch (error) {
        edge.health = "failed";
        edge.enabled = false;
        edge.diagnostics = [diagnostic(
          "adapter-failed",
          "error",
          edge.sourceId,
          `Edge release failed: ${errorMessage(error)}`,
        )];
      }
    }));
    const edges = [...this.#edges.values()].map((edge) => this.#edgeSnapshot(edge, []));
    this.#current = this.#buildSnapshot(edges, [], edges.flatMap((edge) => edge.diagnostics));
  }

  async #performRefresh(options: MoweEdgeRefreshOptions): Promise<MoweEdgeRegistrySnapshot> {
    if (this.#closed) return this.#current;
    const workspace = options.workspace ?? this.#workspace;
    const edges = [...this.#edges.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    const loaded: LoadedCapability[] = [];

    for (const edge of edges) {
      edge.diagnostics = [];
      edge.manifests = [];
      edge.capabilities = [];
      if (!edge.enabled) {
        edge.health = "disabled";
        continue;
      }
      edge.health = "discovering";
      try {
        const manifests = await edge.adapter.discover(edgeContext(workspace, options.signal));
        if (!Array.isArray(manifests)) throw new MoweEdgeRegistryError("Edge discover() must return an array");
        const sortedManifests = [...manifests].sort(compareManifest);
        for (const candidate of sortedManifests) {
          let manifest: EdgeManifest;
          try {
            manifest = validateEdgeManifest(candidate);
            assertEdgeAdapterOwnsManifest(edge.adapter, manifest);
          } catch (error) {
            edge.diagnostics.push(diagnostic(
              "manifest-invalid",
              "error",
              edge.sourceId,
              errorMessage(error),
              isRecord(candidate) && typeof candidate.capabilityName === "string" ? candidate.capabilityName : undefined,
            ));
            continue;
          }
          edge.manifests.push(manifest);
          try {
            const loadedResult = await edge.adapter.load(manifest, edgeContext(workspace, options.signal));
            if (loadedResult.manifest.manifestHash !== manifest.manifestHash) {
              throw new MoweEdgeRegistryError("Loaded capability manifest does not match discovered manifest");
            }
            const capability = createEdgeCapability({
              manifest,
              tool: loadedResult.tool,
            });
            const fingerprint = sha256(stableJson({
              manifest: capability.manifest,
              definition: capability.tool.definition,
              metadata: capability.tool.metadata,
            }));
            const loadedEntry = { edge, capability, fingerprint };
            edge.capabilities.push(capability);
            loaded.push(loadedEntry);
          } catch (error) {
            edge.diagnostics.push(diagnostic(
              "adapter-failed",
              "error",
              edge.sourceId,
              `Edge capability load failed: ${errorMessage(error)}`,
              manifest.capabilityName,
            ));
          }
        }
        edge.adapterHealth = edge.adapter.health === undefined ? undefined : await edge.adapter.health();
        edge.health = healthFrom(edge, edge.adapterHealth);
      } catch (error) {
        edge.health = "failed";
        edge.diagnostics.push(diagnostic(
          "adapter-failed",
          "error",
          edge.sourceId,
          `Edge discovery failed: ${errorMessage(error)}`,
        ));
      }
    }

    const selected: MoweEdgeToolSnapshot[] = [];
    const occupied = new Set(this.#baseCatalog.entries().map((entry) => entry.tool.definition.name));
    loaded.sort(compareLoaded);
    for (const item of loaded) {
      const name = item.capability.manifest.capabilityName;
      if (occupied.has(name)) {
        item.edge.diagnostics.push(diagnostic(
          "tool-collision",
          "error",
          item.edge.sourceId,
          `Tool name collides with an existing catalog entry: ${name}`,
          name,
        ));
        if (item.edge.health === "healthy") item.edge.health = "degraded";
        continue;
      }
      occupied.add(name);
      selected.push({
        name,
        sourceId: item.edge.sourceId,
        kind: item.capability.manifest.sourceType,
        version: item.capability.manifest.capabilityVersion,
        manifestHash: item.capability.manifest.manifestHash,
        capability: item.capability,
        tool: item.capability.tool,
        metadata: item.capability.tool.metadata ?? {},
      });
    }

    const edgeSnapshots = edges.map((edge) => this.#edgeSnapshot(
      edge,
      selected.filter((tool) => tool.sourceId === edge.sourceId),
    ));
    if (this.#closed) return this.#current;
    const snapshot = this.#buildSnapshot(edgeSnapshots, selected, edgeSnapshots.flatMap((edge) => edge.diagnostics));
    this.#current = snapshot;
    return snapshot;
  }

  #edgeSnapshot(edge: RegisteredEdge, tools: readonly MoweEdgeToolSnapshot[]): MoweEdgeSnapshot {
    const manifests = [...edge.manifests];
    return {
      sourceId: edge.sourceId,
      kind: edge.sourceType,
      enabled: edge.enabled,
      health: edge.health,
      manifests,
      provenance: manifests.map((manifest) => manifest.provenance),
      tools: [...tools.filter((tool) => tool.sourceId === edge.sourceId)],
      diagnostics: [...edge.diagnostics],
    };
  }

  #buildSnapshot(
    edges: readonly MoweEdgeSnapshot[],
    tools: readonly MoweEdgeToolSnapshot[],
    diagnostics: readonly MoweEdgeDiagnostic[],
  ): MoweEdgeRegistrySnapshot {
    const catalog = cloneCatalog(this.#baseCatalog);
    const catalogDiagnostics = [...diagnostics];
    const acceptedTools: MoweEdgeToolSnapshot[] = [];
    for (const entry of tools) {
      try {
        catalog.register(entry.tool, entry.metadata);
        acceptedTools.push(entry);
      } catch (error) {
        const item = diagnostic(
          "catalog-rejected",
          "error",
          entry.sourceId,
          `Tool ${entry.name} was rejected by Mowe catalog: ${errorMessage(error)}`,
          entry.name,
        );
        catalogDiagnostics.push(item);
      }
    }
    const acceptedNames = new Set(acceptedTools.map((tool) => `${tool.sourceId}\u0000${tool.name}`));
    const stableEdges = [...edges]
      .map((edge) => ({
        ...edge,
        tools: edge.tools.filter((tool) => acceptedNames.has(`${tool.sourceId}\u0000${tool.name}`)),
      }))
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    const stableTools = acceptedTools.sort(compareToolSnapshots);
    const stableDiagnostics = catalogDiagnostics.sort(compareDiagnostics);
    const hash = sha256(stableJson({
      edges: stableEdges.map((edge) => ({
        sourceId: edge.sourceId,
        kind: edge.kind,
        enabled: edge.enabled,
        health: edge.health,
        manifests: edge.manifests,
        tools: edge.tools.map((tool) => ({ name: tool.name, metadata: tool.metadata })),
      })),
      tools: stableTools.map((tool) => ({
        name: tool.name,
        sourceId: tool.sourceId,
        kind: tool.kind,
        version: tool.version,
        manifestHash: tool.manifestHash,
        definition: tool.tool.definition,
        metadata: tool.metadata,
      })),
      diagnostics: stableDiagnostics,
    }));
    const generation = this.#generation + 1;
    const capabilitySnapshot = createEdgeCapabilitySnapshot({
      generation,
      createdAt: new Date().toISOString(),
      capabilities: stableTools.map((tool) => tool.capability),
    });
    this.#generation = generation;
    return freeze({
      generation,
      hash,
      digest: hash,
      snapshotHash: capabilitySnapshot.snapshotHash,
      capabilitySnapshot,
      catalog: immutableCatalog(catalog),
      edges: stableEdges,
      tools: stableTools,
      capabilities: capabilitySnapshot.capabilities,
      diagnostics: stableDiagnostics,
    });
  }

  #requireEdge(sourceId: string): RegisteredEdge {
    const edge = this.#edges.get(normalizeSourceId(sourceId));
    if (edge === undefined) throw new MoweEdgeRegistryError(`Unknown edge sourceId: ${sourceId}`);
    return edge;
  }
}

export const EdgeRegistry = MoweEdgeRegistry;

function cloneCatalog(input: MoweCatalog | readonly AgentTool[]): MoweCatalog {
  const source = input instanceof MoweCatalog
    ? input.entries()
    : input.map((tool) => ({ tool, metadata: {} }));
  const catalog = new MoweCatalog();
  for (const entry of source) catalog.register(pinTool(entry.tool), entry.metadata);
  return catalog;
}

function pinTool(tool: AgentTool): AgentTool {
  const definition = {
    ...tool.definition,
    parameters: structuredClone(tool.definition.parameters),
  };
  return Object.freeze({
    definition: freeze(definition),
    execute: tool.execute.bind(tool),
  });
}

function immutableCatalog(catalog: MoweCatalog): MoweCatalog {
  const mutators = new Set(["register", "registerMany", "unregister"]);
  return new Proxy(catalog, {
    get(target, property) {
      if (typeof property === "string" && mutators.has(property)) {
        return (): never => {
          throw new MoweEdgeRegistryError("Edge snapshot catalog is immutable");
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function healthSnapshot(edge: RegisteredEdge): MoweEdgeHealthSnapshot {
  const version = edge.manifests[0]?.capabilityVersion;
  const manifestHash = edge.manifests[0]?.manifestHash;
    return freeze({
      sourceId: edge.sourceId,
      kind: edge.sourceType,
      enabled: edge.enabled,
      health: edge.health,
      ...(version === undefined ? {} : { version }),
      ...(manifestHash === undefined ? {} : { manifestHash }),
      ...(edge.adapterHealth?.message === undefined ? {} : { message: edge.adapterHealth.message }),
      ...(edge.adapterHealth?.retryAfterMs === undefined ? {} : { retryAfterMs: edge.adapterHealth.retryAfterMs }),
      diagnostics: edge.diagnostics,
    });
}

function healthFrom(edge: RegisteredEdge, health: EdgeAdapterHealth | undefined): MoweEdgeHealth {
  if (edge.diagnostics.length > 0) return "degraded";
  if (health?.status === "closed") return "closed";
  if (health?.status === "unavailable") return "failed";
  if (health?.status === "degraded") return "degraded";
  return "healthy";
}

function compareManifest(left: EdgeManifest, right: EdgeManifest): number {
  return manifestValue(left, "capabilityName").localeCompare(manifestValue(right, "capabilityName"))
    || manifestValue(left, "capabilityVersion").localeCompare(manifestValue(right, "capabilityVersion"))
    || manifestValue(left, "manifestHash").localeCompare(manifestValue(right, "manifestHash"));
}

function manifestValue(value: unknown, key: "capabilityName" | "capabilityVersion" | "manifestHash"): string {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : "";
}

function compareLoaded(left: LoadedCapability, right: LoadedCapability): number {
  return left.capability.manifest.capabilityName.localeCompare(right.capability.manifest.capabilityName)
    || left.edge.sourceId.localeCompare(right.edge.sourceId)
    || left.fingerprint.localeCompare(right.fingerprint);
}

function compareToolSnapshots(left: MoweEdgeToolSnapshot, right: MoweEdgeToolSnapshot): number {
  return left.name.localeCompare(right.name) || left.sourceId.localeCompare(right.sourceId);
}

function compareDiagnostics(left: MoweEdgeDiagnostic, right: MoweEdgeDiagnostic): number {
  return (left.sourceId ?? "").localeCompare(right.sourceId ?? "")
    || (left.toolName ?? "").localeCompare(right.toolName ?? "")
    || left.code.localeCompare(right.code)
    || left.message.localeCompare(right.message);
}

function diagnostic(
  code: MoweEdgeDiagnostic["code"],
  severity: MoweEdgeDiagnosticSeverity,
  sourceId: string,
  message: string,
  toolName?: string,
): MoweEdgeDiagnostic {
  return freeze({ code, severity, sourceId, ...(toolName === undefined ? {} : { toolName }), message });
}

function isSourceType(value: unknown): value is EdgeSourceType {
  return value === "skill" || value === "mcp" || value === "plugin";
}

function normalizeSourceId(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim() || /\s/u.test(value)) {
    throw new MoweEdgeRegistryError("Edge sourceId must be a non-empty token");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function edgeContext(workspace: string, signal: AbortSignal | undefined): { workspace: string; signal?: AbortSignal } {
  return signal === undefined ? { workspace } : { workspace, signal };
}

function freeze<T>(value: T): T {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  if (Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return Object.freeze(value);
}
