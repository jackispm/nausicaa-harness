import type { AgentTool } from "../domain/ports.js";
import { sha256, stableJson } from "../ledger/hash.js";
import { MoweCatalog } from "./catalog.js";
import type { MoweEffect, MoweToolMetadata, MoweToolScope } from "./types.js";
import {
  assertEdgeAdapterOwnsManifest,
  createEdgeCapability,
  createEdgeCapabilitySnapshot,
  validateEdgeContextContribution,
  validateEdgeContextContributionSummary,
  MAX_EDGE_CONTEXT_CONTRIBUTIONS,
  rebindEdgeCapabilityMetadata,
  validateEdgeManifest,
} from "./edge-adapter.js";
import type {
  EdgeAdapter,
  EdgeAdapterHealth,
  EdgeCapability,
  EdgeCapabilitySnapshot,
  EdgeContextContribution,
  EdgeContextContributionSummary,
  EdgeContributionAdapter,
  EdgeHostGrant,
  EdgeManifest,
  EdgeReleaseReason,
  EdgeSourceType,
} from "./edge-types.js";

const EDGE_EFFECTS: readonly MoweEffect[] = ["read", "compute", "write", "external"];
const EDGE_SCOPES: readonly MoweToolScope[] = ["workspace", "run", "lane", "host"];
const DEFAULT_EDGE_REFRESH_TIMEOUT_MS = 60_000;
const MAX_EDGE_REFRESH_TIMEOUT_MS = 15 * 60_000;
const MAX_EDGE_MANIFESTS = 4_096;

export type MoweEdgeAdapterLike = EdgeAdapter | EdgeContributionAdapter;
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
    | "adapter-health"
    | "adapter-invalid"
    | "manifest-invalid"
    | "manifest-mismatch"
    | "tool-invalid"
    | "tool-collision"
    | "catalog-rejected"
    | "host-grant-denied"
    | "context-invalid"
    | "context-collision"
    | "context-load-failed";
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
  readonly contextContributions: readonly EdgeContextContributionSummary[];
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
  /** Discovered summaries only; bodies are loaded explicitly by selection. */
  readonly contextContributions: readonly EdgeContextContributionSummary[];
  readonly diagnostics: readonly MoweEdgeDiagnostic[];
}

export interface MoweEdgeRegistryOptions {
  readonly catalog?: MoweCatalog | readonly AgentTool[];
  readonly adapters?: readonly MoweEdgeAdapterLike[];
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
  readonly adapter: MoweEdgeAdapterLike;
  readonly sourceId: string;
  readonly sourceType: EdgeSourceType;
  enabled: boolean;
  health: MoweEdgeHealth;
  diagnostics: MoweEdgeDiagnostic[];
  manifests: EdgeManifest[];
  capabilities: EdgeCapability[];
  contextContributions: EdgeContextContributionSummary[];
  adapterHealth?: EdgeAdapterHealth | undefined;
}

interface LoadedCapability {
  readonly edge: RegisteredEdge;
  readonly capability: EdgeCapability;
  readonly fingerprint: string;
}

interface RefreshDeadline {
  readonly signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
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
  #closePromise: Promise<void> | undefined;
  #current: MoweEdgeRegistrySnapshot;
  readonly #snapshots = new WeakSet<object>();
  readonly #snapshotAdapters = new WeakMap<object, ReadonlyMap<string, EdgeContributionAdapter>>();

  constructor(options: MoweEdgeRegistryOptions = {}) {
    this.#baseCatalog = cloneCatalog(options.catalog ?? []);
    this.#workspace = options.workspace ?? ".";
    this.#hostGrants = normalizeHostGrants(options.hostGrants);
    this.#current = this.#buildSnapshot([], [], []);
    for (const adapter of options.adapters ?? []) this.register(adapter);
  }

  register(adapter: MoweEdgeAdapterLike): this {
    if (this.#closed) throw new MoweEdgeRegistryError("Edge registry is closed");
    const sourceId = normalizeSourceId(adapter.sourceId);
    if (!isSourceType(adapter.sourceType)) {
      throw new MoweEdgeRegistryError("Edge adapter sourceType must be skill, mcp, or plugin");
    }
    if (!isSupportedAdapter(adapter)) {
      throw new MoweEdgeRegistryError(
        "Edge adapter must expose discover/load or discoverContributions/loadContribution",
      );
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
      contextContributions: [],
    });
    this.#revision += 1;
    return this;
  }

  registerAdapter(adapter: MoweEdgeAdapterLike): this {
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
      .sort((left, right) => compareText(left.sourceId, right.sourceId))
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

  /**
   * Explicitly load one selected context contribution. Discovery and snapshot
   * publication never read contribution bodies, preserving progressive loading.
   */
  async loadContribution(
    summary: EdgeContextContributionSummary,
    context: {
      readonly workspace?: string;
      readonly signal?: AbortSignal;
      /** Optional Turn snapshot so a refresh cannot invalidate selection. */
      readonly snapshot?: MoweEdgeRegistrySnapshot;
      /** Optional bounded Skill resource selection forwarded to adapters. */
      readonly resourcePaths?: readonly string[];
      readonly maxBodyBytes?: number;
      readonly maxResourceBytes?: number;
      readonly maxResourceTotalBytes?: number;
      readonly maxResources?: number;
    } = {},
  ): Promise<EdgeContextContribution> {
    if (this.#closed) throw new MoweEdgeRegistryError("Edge registry is closed");
    const validated = validateEdgeContextContributionSummary(summary);
    const sourceId = normalizeSourceId(validated.sourceId);
    const captured = context.snapshot ?? this.#current;
    if (!this.#snapshots.has(captured)) {
      throw new MoweEdgeRegistryError("Context contribution snapshot does not belong to this registry");
    }
    const adapter = this.#snapshotAdapters.get(captured)?.get(sourceId);
    if (adapter === undefined) {
      throw new MoweEdgeRegistryError(`Unknown context contribution sourceId: ${validated.sourceId}`);
    }
    if (validated.sourceType !== adapter.sourceType) {
      throw new MoweEdgeRegistryError("Context contribution sourceType does not match its adapter");
    }
    const current = captured.contextContributions.find((candidate) => (
      candidate.sourceId === validated.sourceId
      && candidate.sourceType === validated.sourceType
      && candidate.contributionId === validated.contributionId
      && candidate.name === validated.name
      && candidate.contentHash === validated.contentHash
      && stableJson(candidate) === stableJson(validated)
    ));
    if (current === undefined) {
      throw new MoweEdgeRegistryError("Context contribution is not present in the active snapshot");
    }
    if (validated.disabled) {
      throw new MoweEdgeRegistryError("Disabled context contributions cannot be loaded");
    }
    const signal = context.signal ?? new AbortController().signal;
    const loaded = await awaitWithSignal(
      adapter.loadContribution(
        validated,
        {
          ...edgeContext(context.workspace ?? this.#workspace, signal),
          ...(context.resourcePaths === undefined ? {} : { resourcePaths: context.resourcePaths }),
          ...(context.maxBodyBytes === undefined ? {} : { maxBodyBytes: context.maxBodyBytes }),
          ...(context.maxResourceBytes === undefined ? {} : { maxResourceBytes: context.maxResourceBytes }),
          ...(context.maxResourceTotalBytes === undefined
            ? {}
            : { maxResourceTotalBytes: context.maxResourceTotalBytes }),
          ...(context.maxResources === undefined ? {} : { maxResources: context.maxResources }),
        },
      ),
      signal,
    );
    const contribution = validateEdgeContextContribution(loaded);
    assertContextIdentity(current, contribution);
    // Skills may carry bounded, adapter-owned resource results as a
    // non-enumerable extension. Preserve that extension across the shared
    // contribution validator without widening the model-facing contract or
    // allowing it to participate in identity hashing.
    const resources = isRecord(loaded)
      ? Object.getOwnPropertyDescriptor(loaded, "resources")
      : undefined;
    if (resources !== undefined && !resources.enumerable && Array.isArray(resources.value)) {
      const enriched = { ...contribution };
      Object.defineProperty(enriched, "resources", {
        configurable: false,
        enumerable: false,
        value: Object.freeze([...resources.value]),
        writable: false,
      });
      return Object.freeze(enriched) as EdgeContextContribution;
    }
    return contribution;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#revision += 1;
    this.#closePromise = (async () => {
      // Let an in-flight refresh finish its adapter call before shutdown. Its
      // commit guard observes #closed/#revision and cannot publish stale state.
      await this.#refreshQueue.catch(() => this.#current);
      for (const edge of this.#edges.values()) this.#queueRelease(edge, "shutdown");
      await this.#releaseQueue;
      for (const edge of this.#edges.values()) {
        edge.enabled = false;
        if (edge.health !== "failed") edge.health = "closed";
        edge.contextContributions = [];
      }
      const edges = [...this.#edges.values()].map((edge) => this.#edgeSnapshot(edge, []));
      this.#current = this.#buildSnapshot(edges, [], edges.flatMap((edge) => edge.diagnostics));
    })();
    return this.#closePromise;
  }

  async #performRefresh(options: MoweEdgeRefreshOptions): Promise<MoweEdgeRegistrySnapshot> {
    if (this.#closed) return this.#current;
    const workspace = options.workspace ?? this.#workspace;
    const revision = this.#revision;
    const timeoutMs = normalizeRefreshTimeout(options.timeoutMs);
    const signal = options.signal;
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
            contextContributions: [] as EdgeContextContributionSummary[],
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
            contextContributions: [...edge.contextContributions],
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
      if (selected || !edge.enabled || edge.health === "failed" || edge.health === "closed") continue;
      for (const capability of edge.capabilities) {
        loaded.push({ edge, capability, fingerprint: capabilityFingerprint(capability) });
      }
    }
    let cancelled = signal?.aborted === true;
    // Each selected adapter gets its own deadline. A stalled source is marked
    // failed and removed from the candidate generation while independent
    // sources are still allowed to publish their completed capabilities.
    await Promise.all(workingEdges.map(async (edge) => {
      const selected = requested === undefined || requested.has(edge.sourceId);
      if (!selected || !edge.enabled || cancelled) return;
      const deadline = createRefreshController(signal, timeoutMs);
      const edgeSignal = deadline.signal;
      const edgeLoaded: LoadedCapability[] = [];
      let completed = false;
      try {
        if (edgeSignal.aborted) return;
        if (edge.adapter.refresh !== undefined) {
          await awaitWithSignal(
            edge.adapter.refresh.call(edge.adapter, edgeContext(workspace, edgeSignal)),
            edgeSignal,
          );
        }
        if (isToolAdapter(edge.adapter)) {
          const manifests = await awaitWithSignal(
            edge.adapter.discover(edgeContext(workspace, edgeSignal)),
            edgeSignal,
          );
          if (!Array.isArray(manifests)) throw new MoweEdgeRegistryError("Edge discover() must return an array");
          if (manifests.length > MAX_EDGE_MANIFESTS) {
            edge.diagnostics.push(diagnostic(
              "manifest-invalid",
              "error",
              edge.sourceId,
              `Edge discover() returned more than ${MAX_EDGE_MANIFESTS} manifests`,
            ));
          } else for (const candidate of [...manifests].sort(compareManifest)) {
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
                edge.adapter.load(manifest, edgeContext(workspace, edgeSignal)),
                edgeSignal,
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
              edgeLoaded.push({ edge, capability, fingerprint });
            } catch (error) {
              if (signal?.aborted === true) throw error;
              if (deadline.timedOut()) throw error;
              edge.diagnostics.push(diagnostic(
                "adapter-failed",
                "error",
                edge.sourceId,
                `Edge capability load failed: ${errorMessage(error)}`,
                manifest.capabilityName,
              ));
            }
          }
        }
        if (isContributionAdapter(edge.adapter)) {
          const summaries = await awaitWithSignal(
            edge.adapter.discoverContributions(edgeContext(workspace, edgeSignal)),
            edgeSignal,
          );
          if (!Array.isArray(summaries)) {
            throw new MoweEdgeRegistryError("Edge discoverContributions() must return an array");
          }
          if (summaries.length > MAX_EDGE_CONTEXT_CONTRIBUTIONS) {
            edge.diagnostics.push(diagnostic(
              "context-invalid",
              "error",
              edge.sourceId,
              `Context contributions exceed the ${MAX_EDGE_CONTEXT_CONTRIBUTIONS} item limit`,
            ));
          }
          const seenContributionIds = new Set<string>();
          for (const candidate of [...summaries]
            .sort(compareContextContributions)
            .slice(0, MAX_EDGE_CONTEXT_CONTRIBUTIONS)) {
            try {
              const summary = validateEdgeContextContributionSummary(candidate);
              if (summary.sourceId !== edge.sourceId || summary.sourceType !== edge.sourceType) {
                throw new MoweEdgeRegistryError(
                  `Context contribution belongs to ${summary.sourceType}:${summary.sourceId}`,
                );
              }
              if (seenContributionIds.has(summary.contributionId)) {
                edge.diagnostics.push(diagnostic(
                  "context-collision",
                  "error",
                  edge.sourceId,
                  `Context contribution id collides within source: ${summary.contributionId}`,
                  summary.name,
                ));
                continue;
              }
              seenContributionIds.add(summary.contributionId);
              edge.contextContributions.push(summary);
            } catch (error) {
              edge.diagnostics.push(diagnostic(
                "context-invalid",
                "error",
                edge.sourceId,
                errorMessage(error),
                contextName(candidate),
              ));
            }
          }
        }
        if (edge.adapter.health === undefined) {
          delete edge.adapterHealth;
        } else {
          edge.adapterHealth = await awaitWithSignal(edge.adapter.health(), edgeSignal);
        }
        if (
          edge.adapterHealth?.message !== undefined
          && edge.adapterHealth.status !== "healthy"
        ) {
          // Adapter health is otherwise only available through the mutable
          // health() API. Copy the bounded reason into this immutable
          // generation so status/TUI projections do not show a bare
          // degraded/failed state with no explanation.
          edge.diagnostics.push(diagnostic(
            "adapter-health",
            edge.adapterHealth.status === "degraded" ? "warning" : "error",
            edge.sourceId,
            edge.adapterHealth.message,
          ));
        }
        edge.health = healthFrom(edge, edge.adapterHealth);
        if (edge.adapterHealth?.status === "unavailable" || edge.adapterHealth?.status === "closed") {
          // A health probe that says the source cannot serve calls invalidates
          // every candidate discovered in this generation.
          edge.manifests = [];
          edge.capabilities = [];
          edge.contextContributions = [];
          edgeLoaded.length = 0;
        }
        completed = true;
      } catch (error) {
        if (signal?.aborted === true) {
          cancelled = true;
          return;
        }
        // A source that fails after partial discovery must not leave those
        // candidates available to a later source-scoped refresh.
        edge.manifests = [];
        edge.capabilities = [];
        edge.contextContributions = [];
        if (deadline.timedOut()) {
          edge.health = "failed";
          edge.diagnostics = [diagnostic(
            "adapter-failed",
            "error",
            edge.sourceId,
            `Edge discovery timed out after ${timeoutMs}ms`,
          )];
          return;
        }
        edge.health = "failed";
        edge.diagnostics.push(diagnostic(
          "adapter-failed",
          "error",
          edge.sourceId,
          `Edge discovery failed: ${errorMessage(error)}`,
        ));
      } finally {
        if (completed) loaded.push(...edgeLoaded);
        deadline.dispose();
      }
    }));

    if (cancelled || signal?.aborted === true) return this.#current;
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

    const edgeSnapshots = workingEdges.map((edge) => this.#edgeSnapshot(
      edge,
      selected.filter((tool) => tool.sourceId === edge.sourceId),
    ));
    if (this.#closed || revision !== this.#revision) return this.#current;
    for (const edge of edges) {
      if (this.#edges.get(edge.sourceId) !== edge) return this.#current;
    }
    const snapshot = this.#buildSnapshot(
      edgeSnapshots,
      selected,
      edgeSnapshots.flatMap((edge) => edge.diagnostics),
    );
    if (signal !== undefined && signal.aborted || this.#closed || revision !== this.#revision) {
      return this.#current;
    }
    for (const edge of workingEdges) {
      const current = this.#edges.get(edge.sourceId);
      if (current === undefined) continue;
      current.health = edge.health;
      current.diagnostics = [...edge.diagnostics];
      current.manifests = [...edge.manifests];
      current.capabilities = [...edge.capabilities];
      current.contextContributions = [...edge.contextContributions];
      if (edge.adapterHealth === undefined) delete current.adapterHealth;
      else current.adapterHealth = edge.adapterHealth;
    }
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
      contextContributions: [...edge.contextContributions],
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
        contextContributions: [...edge.contextContributions].sort(compareContextContributions),
      }))
      .sort((left, right) => compareText(left.sourceId, right.sourceId));
    const stableTools = acceptedTools.sort(compareToolSnapshots);
    const stableDiagnostics = catalogDiagnostics.sort(compareDiagnostics);
    const stableContextContributions = stableEdges
      .flatMap((edge) => edge.contextContributions)
      .sort(compareContextContributions);
    const hash = sha256(stableJson({
      edges: stableEdges.map((edge) => ({
        sourceId: edge.sourceId,
        kind: edge.kind,
        enabled: edge.enabled,
        health: edge.health,
        manifests: edge.manifests,
        tools: edge.tools.map((tool) => ({ name: tool.name, metadata: tool.metadata })),
        contextContributions: edge.contextContributions.map((contribution) => ({
          kind: contribution.kind,
          sourceId: contribution.sourceId,
          contributionId: contribution.contributionId,
          sourceType: contribution.sourceType,
          name: contribution.name,
          description: contribution.description,
          disabled: contribution.disabled,
          contentHash: contribution.contentHash ?? null,
          provenance: contribution.provenance ?? null,
        })),
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
    const snapshot = freeze({
      generation,
      hash,
      digest: hash,
      snapshotHash: capabilitySnapshot.snapshotHash,
      capabilitySnapshot,
      catalog: immutableCatalog(catalog),
      edges: stableEdges,
      tools: stableTools,
      capabilities: capabilitySnapshot.capabilities,
      contextContributions: stableContextContributions,
      diagnostics: stableDiagnostics,
    });
    const adapters = new Map<string, EdgeContributionAdapter>();
    for (const edge of stableEdges) {
      if (edge.contextContributions.length === 0) continue;
      const registered = this.#edges.get(edge.sourceId);
      if (registered !== undefined && isContributionAdapter(registered.adapter)) {
        adapters.set(edge.sourceId, registered.adapter);
      }
    }
    this.#snapshots.add(snapshot);
    this.#snapshotAdapters.set(snapshot, adapters);
    return snapshot;
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
  if (health?.status === "closed") return "closed";
  if (health?.status === "unavailable") return "failed";
  if (edge.diagnostics.length > 0) return "degraded";
  if (health?.status === "degraded") return "degraded";
  return "healthy";
}

function compareManifest(left: EdgeManifest, right: EdgeManifest): number {
  return compareText(manifestValue(left, "capabilityName"), manifestValue(right, "capabilityName"))
    || compareText(manifestValue(left, "capabilityVersion"), manifestValue(right, "capabilityVersion"))
    || compareText(manifestValue(left, "manifestHash"), manifestValue(right, "manifestHash"));
}

function manifestValue(value: unknown, key: "capabilityName" | "capabilityVersion" | "manifestHash"): string {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : "";
}

function compareLoaded(left: LoadedCapability, right: LoadedCapability): number {
  return compareText(left.capability.manifest.capabilityName, right.capability.manifest.capabilityName)
    || compareText(left.edge.sourceId, right.edge.sourceId)
    || compareText(left.fingerprint, right.fingerprint);
}

function capabilityFingerprint(capability: EdgeCapability): string {
  return sha256(stableJson({
    manifest: capability.manifest,
    definition: capability.tool.definition,
    metadata: capability.tool.metadata,
  }));
}

function compareToolSnapshots(left: MoweEdgeToolSnapshot, right: MoweEdgeToolSnapshot): number {
  return compareText(left.name, right.name) || compareText(left.sourceId, right.sourceId);
}

function compareDiagnostics(left: MoweEdgeDiagnostic, right: MoweEdgeDiagnostic): number {
  return compareText(left.sourceId ?? "", right.sourceId ?? "")
    || compareText(left.toolName ?? "", right.toolName ?? "")
    || compareText(left.code, right.code)
    || compareText(left.message, right.message);
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

function isToolAdapter(adapter: MoweEdgeAdapterLike): adapter is EdgeAdapter {
  return typeof (adapter as Partial<EdgeAdapter>).discover === "function"
    && typeof (adapter as Partial<EdgeAdapter>).load === "function";
}

function isContributionAdapter(adapter: MoweEdgeAdapterLike): adapter is EdgeContributionAdapter {
  return typeof (adapter as Partial<EdgeContributionAdapter>).discoverContributions === "function"
    && typeof (adapter as Partial<EdgeContributionAdapter>).loadContribution === "function";
}

function isSupportedAdapter(adapter: MoweEdgeAdapterLike): boolean {
  return isToolAdapter(adapter) || isContributionAdapter(adapter);
}

function compareContextContributions(
  left: unknown,
  right: unknown,
): number {
  return compareText(contextValue(left, "sourceId"), contextValue(right, "sourceId"))
    || compareText(contextValue(left, "contributionId"), contextValue(right, "contributionId"))
    || compareText(contextValue(left, "name"), contextValue(right, "name"))
    || compareText(contextValue(left, "contentHash"), contextValue(right, "contentHash"));
}

function contextName(value: unknown): string | undefined {
  return isRecord(value) && typeof value.name === "string" ? value.name : undefined;
}

function contextValue(value: unknown, key: "sourceId" | "contributionId" | "name" | "contentHash"): string {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : "";
}

function assertContextIdentity(
  summary: EdgeContextContributionSummary,
  loaded: EdgeContextContribution,
): void {
  if (loaded.kind !== "context"
    || loaded.sourceId !== summary.sourceId
    || loaded.sourceType !== summary.sourceType
    || loaded.contributionId !== summary.contributionId
    || loaded.name !== summary.name
    || loaded.description !== summary.description
    || loaded.disabled !== summary.disabled
    || stableJson(loaded.provenance ?? null) !== stableJson(summary.provenance ?? null)
    || (summary.contentHash !== undefined && loaded.contentHash !== summary.contentHash)) {
    throw new MoweEdgeRegistryError("Loaded context contribution does not match discovered summary");
  }
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
): RefreshDeadline {
  const bounded = normalizeRefreshTimeout(timeoutMs);
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = (): void => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted === true) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Edge refresh timed out after ${bounded}ms`));
  }, bounded);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

function normalizeRefreshTimeout(timeoutMs: number | undefined): number {
  const bounded = timeoutMs ?? DEFAULT_EDGE_REFRESH_TIMEOUT_MS;
  if (!Number.isSafeInteger(bounded) || bounded < 1 || bounded > MAX_EDGE_REFRESH_TIMEOUT_MS) {
    throw new MoweEdgeRegistryError(
      `Edge refresh timeoutMs must be an integer between 1 and ${MAX_EDGE_REFRESH_TIMEOUT_MS}`,
    );
  }
  return bounded;
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
