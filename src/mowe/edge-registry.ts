import type { AgentTool } from "../domain/ports.js";
import { sha256, stableJson } from "../ledger/hash.js";
import { MoweCatalog } from "./catalog.js";
import type { MoweEffect, MoweToolMetadata, MoweToolScope } from "./types.js";
import {
  assertEdgeAdapterOwnsManifest,
  createEdgeCapability,
  createEdgeCapabilitySnapshot,
  rebindEdgeCapabilityMetadata,
  validateEdgeManifest,
} from "./edge-adapter.js";
import type {
  EdgeAdapter,
  EdgeAdapterHealth,
  EdgeCapability,
  EdgeCapabilitySnapshot,
  EdgeHostGrant,
  EdgeManifest,
  EdgeReleaseReason,
  EdgeSourceType,
} from "./edge-types.js";

const EDGE_EFFECTS: readonly MoweEffect[] = ["read", "compute", "write", "external"];
const EDGE_SCOPES: readonly MoweToolScope[] = ["workspace", "run", "lane", "host"];
const DEFAULT_EDGE_REFRESH_TIMEOUT_MS = 60_000;
const MAX_EDGE_REFRESH_TIMEOUT_MS = 15 * 60_000;

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
    | "catalog-rejected"
    | "host-grant-denied";
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
  /** Explicit host-owned permissions; an omitted source is quarantined. */
  readonly hostGrants?: Readonly<Record<string, EdgeHostGrant>>;
}

export interface MoweEdgeRefreshOptions {
  readonly workspace?: string;
  readonly signal?: AbortSignal;
  /** Bound discovery/load so one unresponsive edge cannot block publication. */
  readonly timeoutMs?: number;
  /** Internal/source-scoped refresh selector used by refreshSource(). */
  readonly sourceIds?: readonly string[];
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
  readonly #hostGrants: ReadonlyMap<string, EdgeHostGrant>;
  #generation = -1;
  #closed = false;
  #revision = 0;
  #refreshQueue: Promise<MoweEdgeRegistrySnapshot> = Promise.resolve(undefined as never);
  #releaseQueue: Promise<void> = Promise.resolve();
  #current: MoweEdgeRegistrySnapshot;

  constructor(options: MoweEdgeRegistryOptions = {}) {
    this.#baseCatalog = cloneCatalog(options.catalog ?? []);
    this.#workspace = options.workspace ?? ".";
    this.#hostGrants = normalizeHostGrants(options.hostGrants);
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
    this.#revision += 1;
    return this;
  }

  registerAdapter(adapter: EdgeAdapter): this {
    return this.register(adapter);
  }

  unregister(sourceId: string): boolean {
    const target = normalizeSourceId(sourceId);
    const edge = this.#edges.get(target);
    if (edge === undefined) return false;
    this.#edges.delete(target);
    this.#revision += 1;
    this.#queueRelease(edge, "unregister");
    return true;
  }

  has(sourceId: string): boolean {
    return this.#edges.has(normalizeSourceId(sourceId));
  }

  enable(sourceId: string): this {
    const edge = this.#requireEdge(sourceId);
    this.#revision += 1;
    edge.enabled = true;
    if (edge.health === "disabled") edge.health = "registered";
    return this;
  }

  disable(sourceId: string): this {
    const edge = this.#requireEdge(sourceId);
    this.#revision += 1;
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
    return this.refresh({ ...options, sourceIds: [target] });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#revision += 1;
    // Let an in-flight refresh finish its adapter call before shutdown. Its
    // commit guard observes #closed/#revision and cannot publish stale state.
    await this.#refreshQueue.catch(() => this.#current);
    for (const edge of this.#edges.values()) this.#queueRelease(edge, "shutdown");
    await this.#releaseQueue;
    for (const edge of this.#edges.values()) {
      edge.enabled = false;
      if (edge.health !== "failed") edge.health = "closed";
    }
    const edges = [...this.#edges.values()].map((edge) => this.#edgeSnapshot(edge, []));
    this.#current = this.#buildSnapshot(edges, [], edges.flatMap((edge) => edge.diagnostics));
  }

  async #performRefresh(options: MoweEdgeRefreshOptions): Promise<MoweEdgeRegistrySnapshot> {
    if (this.#closed) return this.#current;
    const workspace = options.workspace ?? this.#workspace;
    const revision = this.#revision;
    const controller = createRefreshController(options.signal, options.timeoutMs);
    const signal = controller.signal;
    const requested = options.sourceIds === undefined
      ? undefined
      : new Set(options.sourceIds.map(normalizeSourceId));
    const edges = [...this.#edges.values()].sort((left, right) => compareText(left.sourceId, right.sourceId));
    // Work on detached state.  Public mutations can happen while an adapter is
    // awaiting I/O; the revision/identity check below then discards this build.
    const workingEdges = edges.map((edge) => {
      const selected = requested === undefined || requested.has(edge.sourceId);
      return selected
        ? {
            adapter: edge.adapter,
            sourceId: edge.sourceId,
            sourceType: edge.sourceType,
            enabled: edge.enabled,
            health: edge.enabled ? "discovering" as const : "disabled" as const,
            diagnostics: [] as MoweEdgeDiagnostic[],
            manifests: [] as EdgeManifest[],
            capabilities: [] as EdgeCapability[],
          }
        : {
            adapter: edge.adapter,
            sourceId: edge.sourceId,
            sourceType: edge.sourceType,
            enabled: edge.enabled,
            health: edge.health,
            diagnostics: [...edge.diagnostics],
            manifests: [...edge.manifests],
            capabilities: [...edge.capabilities],
            ...(edge.adapterHealth === undefined ? {} : { adapterHealth: edge.adapterHealth }),
          };
    });
    const loaded: LoadedCapability[] = [];
    // A source-scoped refresh must keep capabilities from the other edges in
    // the candidate generation. They are copied from the last committed state
    // and participate in the same deterministic collision pass as refreshed
    // capabilities.
    for (const edge of workingEdges) {
      const selected = requested === undefined || requested.has(edge.sourceId);
      if (selected) continue;
      for (const capability of edge.capabilities) {
        loaded.push({ edge, capability, fingerprint: capabilityFingerprint(capability) });
      }
    }
    try {
      for (const edge of workingEdges) {
        if (signal.aborted) return this.#current;
        const selected = requested === undefined || requested.has(edge.sourceId);
        if (!selected || !edge.enabled) continue;
        try {
          if (edge.adapter.refresh !== undefined) {
            await awaitWithSignal(
              edge.adapter.refresh.call(edge.adapter, edgeContext(workspace, signal)),
              signal,
            );
          }
          const manifests = await awaitWithSignal(
            edge.adapter.discover(edgeContext(workspace, signal)),
            signal,
          );
          if (!Array.isArray(manifests)) throw new MoweEdgeRegistryError("Edge discover() must return an array");
          for (const candidate of [...manifests].sort(compareManifest)) {
            let manifest: EdgeManifest;
            try {
              manifest = validateEdgeManifest(candidate);
              // Use the identity captured at registration, not mutable adapter
              // fields, as the ownership boundary.
              assertEdgeAdapterOwnsManifest(
                { sourceId: edge.sourceId, sourceType: edge.sourceType },
                manifest,
              );
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
              const loadedResult = await awaitWithSignal(
                edge.adapter.load(manifest, edgeContext(workspace, signal)),
                signal,
              );
              if (loadedResult.manifest.manifestHash !== manifest.manifestHash) {
                throw new MoweEdgeRegistryError("Loaded capability manifest does not match discovered manifest");
              }
              const rawCapability = createEdgeCapability({ manifest, tool: loadedResult.tool });
              const capability = applyHostGrant(
                rawCapability,
                this.#hostGrants.get(edge.sourceId),
                edge,
              );
              if (capability === undefined) continue;
              const fingerprint = capabilityFingerprint(capability);
              edge.capabilities.push(capability);
              loaded.push({ edge, capability, fingerprint });
            } catch (error) {
              if (signal.aborted) return this.#current;
              edge.diagnostics.push(diagnostic(
                "adapter-failed",
                "error",
                edge.sourceId,
                `Edge capability load failed: ${errorMessage(error)}`,
                manifest.capabilityName,
              ));
            }
          }
          if (edge.adapter.health === undefined) {
            delete edge.adapterHealth;
          } else {
            edge.adapterHealth = await awaitWithSignal(edge.adapter.health(), signal);
          }
          edge.health = healthFrom(edge, edge.adapterHealth);
        } catch (error) {
          if (signal.aborted) return this.#current;
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
        if (signal.aborted) return this.#current;
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

      const edgeSnapshots = workingEdges.map((edge) => this.#edgeSnapshot(
        edge,
        selected.filter((tool) => tool.sourceId === edge.sourceId),
      ));
      if (signal.aborted || this.#closed || revision !== this.#revision) return this.#current;
      for (const edge of edges) {
        if (this.#edges.get(edge.sourceId) !== edge) return this.#current;
      }
      const snapshot = this.#buildSnapshot(
        edgeSnapshots,
        selected,
        edgeSnapshots.flatMap((edge) => edge.diagnostics),
      );
      if (signal.aborted || this.#closed || revision !== this.#revision) return this.#current;
      for (const edge of workingEdges) {
        const current = this.#edges.get(edge.sourceId);
        if (current === undefined) continue;
        current.health = edge.health;
        current.diagnostics = [...edge.diagnostics];
        current.manifests = [...edge.manifests];
        current.capabilities = [...edge.capabilities];
        if (edge.adapterHealth === undefined) delete current.adapterHealth;
        else current.adapterHealth = edge.adapterHealth;
      }
      this.#current = snapshot;
      return snapshot;
    } finally {
      controller.dispose();
    }
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

  #queueRelease(edge: RegisteredEdge, reason: EdgeReleaseReason): void {
    const refreshBarrier = this.#refreshQueue;
    this.#releaseQueue = this.#releaseQueue.then(async () => {
      await refreshBarrier.catch(() => this.#current);
      const release = edge.adapter.release;
      if (release === undefined) return;
      try {
        await release.call(edge.adapter, { reason });
      } catch (error) {
        edge.health = "failed";
        edge.diagnostics.push(diagnostic(
          "adapter-failed",
          "error",
          edge.sourceId,
          `Edge release failed: ${errorMessage(error)}`,
        ));
      }
    }).catch(() => undefined);
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
    diagnostics: [...edge.diagnostics],
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

function capabilityFingerprint(capability: EdgeCapability): string {
  return sha256(stableJson({
    manifest: capability.manifest,
    definition: capability.tool.definition,
    metadata: capability.tool.metadata,
  }));
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

function normalizeHostGrants(
  input: Readonly<Record<string, EdgeHostGrant>> | undefined,
): ReadonlyMap<string, EdgeHostGrant> {
  if (input === undefined) return new Map();
  if (!isRecord(input)) throw new MoweEdgeRegistryError("hostGrants must be an object");
  const grants = new Map<string, EdgeHostGrant>();
  for (const [rawSourceId, candidate] of Object.entries(input)) {
    const sourceId = normalizeSourceId(rawSourceId);
    if (!isRecord(candidate)) {
      throw new MoweEdgeRegistryError(`Host grant for ${sourceId} must be an object`);
    }
    const effects = normalizeGrantValues(candidate.effects, EDGE_EFFECTS, `${sourceId}.effects`);
    const scopes = normalizeGrantValues(candidate.scopes, EDGE_SCOPES, `${sourceId}.scopes`);
    if (candidate.allowWithoutApproval !== undefined
      && typeof candidate.allowWithoutApproval !== "boolean") {
      throw new MoweEdgeRegistryError(`${sourceId}.allowWithoutApproval must be a boolean`);
    }
    grants.set(sourceId, freeze({
      effects,
      scopes,
      ...(candidate.allowWithoutApproval === undefined
        ? {}
        : { allowWithoutApproval: candidate.allowWithoutApproval }),
    }));
  }
  return grants;
}

function normalizeGrantValues<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): readonly T[] {
  if (!Array.isArray(value) || value.length === 0
    || value.some((item) => typeof item !== "string" || !allowed.includes(item as T))) {
    throw new MoweEdgeRegistryError(`${path} must be a non-empty array of supported values`);
  }
  if (new Set(value).size !== value.length) {
    throw new MoweEdgeRegistryError(`${path} must not contain duplicates`);
  }
  return Object.freeze([...value] as T[]);
}

function applyHostGrant(
  capability: EdgeCapability,
  grant: EdgeHostGrant | undefined,
  edge: RegisteredEdge,
): EdgeCapability | undefined {
  const metadata = capability.tool.metadata ?? {};
  if (grant === undefined) {
    edge.diagnostics.push(diagnostic(
      "host-grant-denied",
      "warning",
      edge.sourceId,
      "No host grant is configured; capability is quarantined behind explicit approval",
      capability.manifest.capabilityName,
    ));
    return rebindEdgeCapabilityMetadata(capability, {
      ...metadata,
      effect: "external",
      scope: "host",
      requiresApproval: true,
      deterministic: false,
      supportsBatch: false,
      concurrencySafe: false,
      supportsStreaming: false,
      maxConcurrency: 1,
    });
  }
  if (!grant.effects.includes(capability.manifest.effect)
    || !grant.scopes.includes(capability.manifest.scope)) {
    edge.diagnostics.push(diagnostic(
      "host-grant-denied",
      "error",
      edge.sourceId,
      `Host grant does not permit ${capability.manifest.effect}/${capability.manifest.scope}`,
      capability.manifest.capabilityName,
    ));
    return undefined;
  }
  return rebindEdgeCapabilityMetadata(capability, {
    ...metadata,
    effect: capability.manifest.effect,
    scope: capability.manifest.scope,
    requiresApproval: grant.allowWithoutApproval === true
      ? (metadata.requiresApproval ?? false)
      : true,
  });
}

function createRefreshController(
  parentSignal: AbortSignal | undefined,
  timeoutMs = DEFAULT_EDGE_REFRESH_TIMEOUT_MS,
): { signal: AbortSignal; dispose(): void } {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_EDGE_REFRESH_TIMEOUT_MS) {
    throw new MoweEdgeRegistryError(
      `Edge refresh timeoutMs must be an integer between 1 and ${MAX_EDGE_REFRESH_TIMEOUT_MS}`,
    );
  }
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted === true) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Edge refresh timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timeout.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

function awaitWithSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Edge refresh cancelled");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
