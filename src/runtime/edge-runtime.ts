import type { AgentTool } from "../domain/ports.js";
import type {
  EdgeProvenance,
  MoweEdgeRegistrySnapshot,
  MoweEdgeToolSnapshot,
} from "../mowe/index.js";
import type { WorkspaceEdgeToolSnapshot } from "../mowe/workspace-catalog.js";
import type { FukaiEdgeContextContribution } from "../fukai/types.js";

/** The small immutable view consumed by one Main activation. */
export interface EdgeRuntimeProjection {
  readonly generation: number;
  /** Admitted tools and selected context are exposed directly for embedders. */
  readonly tools: readonly AgentTool[];
  readonly edgeSnapshot: WorkspaceEdgeToolSnapshot;
  readonly contextContributions: readonly FukaiEdgeContextContribution[];
  readonly status: EdgeRuntimeStatusProjection;
}

export interface EdgeRuntimeStatusSource {
  readonly sourceId: string;
  readonly type: string;
  readonly health?: string;
  readonly enabled?: boolean;
  readonly toolCount: number;
  readonly contextCount: number;
  readonly diagnostics: readonly string[];
  readonly provenance: readonly EdgeProvenance[];
}

export interface EdgeRuntimeStatusProjection {
  readonly enabled: boolean;
  readonly refreshRequested: boolean;
  readonly generation: number;
  readonly toolCount: number;
  readonly contextCount: number;
  readonly diagnostics: readonly string[];
  readonly sources: readonly EdgeRuntimeStatusSource[];
}

/**
 * Host seam for a registry/composition.  `snapshot` is synchronous for TUI
 * reads; `capture` is the optional async spelling used at an activation
 * boundary.  Implementations must return an immutable snapshot and must not
 * refresh from either method.
 */
export interface EdgeTurnSnapshotProvider {
  readonly snapshot?: () => unknown;
  readonly getSnapshot?: () => unknown;
  readonly capture?: (options?: { readonly signal?: AbortSignal }) => unknown | Promise<unknown>;
  readonly status?: () => EdgeRuntimeStatusProjection;
  readonly refresh?: (signal?: AbortSignal) => Promise<unknown>;
  readonly close?: () => void | Promise<void>;
  /** Optional registry handle for explicit loading of selected summaries. */
  readonly registry?: EdgeRuntimeRegistryLike;
}

export interface EdgeRuntimeRegistryLike {
  snapshot(): unknown;
  loadContribution?: (...args: any[]) => Promise<unknown>;
  refresh?: (...args: any[]) => Promise<unknown>;
  close?: () => void | Promise<void>;
}

/** Adapt a registry/composition to the runtime seam without exposing mutability. */
export function createRegistryEdgeTurnSnapshotProvider(
  registry: EdgeRuntimeRegistryLike,
  selectContext: (summary: unknown) => boolean = (summary) => (
    isRecord(summary) && summary.disabled !== true
  ),
): EdgeTurnSnapshotProvider {
  return {
    capture: async (options) => {
      const snapshot = registry.snapshot();
      if (registry.loadContribution === undefined) return snapshot;
      const raw = asRecord(snapshot);
      const summaries = Array.isArray(raw.contextContributions)
        ? raw.contextContributions.filter(selectContext)
        : [];
      if (summaries.length === 0) return snapshot;
      const loaded = await Promise.all(summaries.map((summary) => registry.loadContribution!(
        summary,
        { ...(options ?? {}), snapshot },
      )));
      return { ...raw, contextContributions: loaded };
    },
    snapshot: () => registry.snapshot(),
    ...(registry.refresh === undefined ? {} : {
      refresh: (signal?: AbortSignal) => registry.refresh!(signal === undefined ? {} : { signal }),
    }),
    ...(registry.close === undefined ? {} : { close: () => registry.close!() }),
    registry,
  };
}

export interface EdgeRuntimeProjectionInput {
  readonly snapshot?: unknown;
  readonly enabled?: boolean;
  readonly refreshRequested?: boolean;
}

/**
 * Purely project an already-published registry snapshot.  In particular this
 * never reads or mutates an adapter/registry and only admits entries that the
 * registry has already placed in `tools` (or its immutable catalog).
 */
export function projectEdgeRegistrySnapshot(
  input: EdgeRuntimeProjectionInput | unknown,
): EdgeRuntimeProjection {
  const envelope = isRecord(input) && Object.prototype.hasOwnProperty.call(input, "snapshot")
    ? input.snapshot
    : input;
  const raw = asRecord(envelope);
  const generation = boundedGeneration(raw.generation);
  const toolEntries = readToolEntries(raw);
  const tools: AgentTool[] = [];
  const metadataByName: Record<string, Record<string, unknown>> = {};
  for (const entry of toolEntries) {
    const tool = asAgentTool(entry.tool ?? entry.agentTool ?? entry.capability?.tool)
      ?? asAgentTool(entry);
    if (tool === undefined) continue;
    tools.push(tool);
    const metadata = entry.metadata
      ?? entry.capability?.tool?.metadata
      ?? (isRecord(raw.metadataByName) ? raw.metadataByName[tool.definition.name] : undefined);
    if (isRecord(metadata)) metadataByName[tool.definition.name] = { ...metadata };
  }
  tools.sort((left, right) => compareText(left.definition.name, right.definition.name));
  const contextContributions = readContextContributions(raw)
    .sort((left, right) => compareText(left.sourceId, right.sourceId)
      || compareText(left.contributionId, right.contributionId));
  const contextSummaries = readContextSummaryRecords(raw);
  const edges = readEdges(raw)
    .sort((left, right) => compareText(String(left.sourceId ?? ""), String(right.sourceId ?? "")));
  const diagnostics = readDiagnostics(raw).sort(compareText);
  const sources = edges.map((edge) => {
    const edgeTools = tools.filter((tool) => edge.sourceId === sourceIdForTool(tool, toolEntries));
    const edgeContexts = contextSummaries.filter((item) => item.sourceId === edge.sourceId);
    return Object.freeze({
      sourceId: edge.sourceId,
      type: String(edge.kind ?? edge.type ?? "edge"),
      ...(typeof edge.health === "string" ? { health: edge.health } : {}),
      ...(typeof edge.enabled === "boolean" ? { enabled: edge.enabled } : {}),
      toolCount: edgeTools.length,
      contextCount: edgeContexts.length,
      diagnostics: Object.freeze(readDiagnosticValues(edge.diagnostics)),
      provenance: Object.freeze((edge.provenance ?? []).map((item: unknown) => structuredClone(item))),
    });
  });
  const status = Object.freeze({
    enabled: inputEnabled(input, true),
    refreshRequested: inputRefreshRequested(input, false),
    generation,
    toolCount: tools.length,
    contextCount: contextSummaries.length,
    diagnostics: Object.freeze([...diagnostics]),
    sources: Object.freeze(sources),
  });
  const edgeSnapshot = Object.freeze({
    generation,
    tools: Object.freeze(tools),
    ...(Object.keys(metadataByName).length === 0
      ? {}
      : { metadataByName: Object.freeze(metadataByName) as WorkspaceEdgeToolSnapshot["metadataByName"] }),
  }) as unknown as WorkspaceEdgeToolSnapshot;
  return Object.freeze({
    generation,
    tools: Object.freeze(tools),
    edgeSnapshot,
    contextContributions: Object.freeze(contextContributions),
    status,
  });
}

/** Capture exactly one immutable projection at an activation boundary. */
export async function captureEdgeTurnSnapshot(
  provider: EdgeTurnSnapshotProvider | undefined,
  fallback?: unknown,
  signal?: AbortSignal,
): Promise<EdgeRuntimeProjection> {
  if (provider === undefined) {
    return projectEdgeRegistrySnapshot(fallback ?? { generation: 0 });
  }
  if (signal?.aborted) throw signal.reason ?? new Error("Edge snapshot capture cancelled");
  const value = provider.capture !== undefined
    ? await provider.capture(signal === undefined ? undefined : { signal })
    : provider.snapshot !== undefined
      ? provider.snapshot()
      : provider.getSnapshot !== undefined
        ? provider.getSnapshot()
      : fallback ?? { generation: 0 };
  if (signal?.aborted === true) throw signal.reason ?? new Error("Edge snapshot capture cancelled");
  if (provider.capture === undefined && provider.registry !== undefined && isRecord(value)) {
    const summaries = Array.isArray(value.contextContributions)
      ? value.contextContributions.filter((summary: unknown) => (
        isRecord(summary) && summary.disabled !== true
      ))
      : [];
    if (summaries.length > 0 && provider.registry.loadContribution !== undefined) {
      const loaded = await Promise.all(summaries.map((summary: unknown) => (
        provider.registry!.loadContribution!(summary, signal === undefined ? {} : { signal })
      )));
      return projectEdgeRegistrySnapshot({ ...value, contextContributions: loaded });
    }
  }
  return projectEdgeRegistrySnapshot(value);
}

export function edgeStatusFromProvider(
  provider: EdgeTurnSnapshotProvider | undefined,
  fallback?: EdgeRuntimeStatusProjection,
): EdgeRuntimeStatusProjection {
  if (provider?.status !== undefined) return structuredClone(provider.status());
  if (fallback !== undefined) return structuredClone(fallback);
  if (provider?.snapshot !== undefined) return projectEdgeRegistrySnapshot(provider.snapshot()).status;
  if (provider?.getSnapshot !== undefined) return projectEdgeRegistrySnapshot(provider.getSnapshot()).status;
  return projectEdgeRegistrySnapshot({ generation: 0 }).status;
}

function asRecord(value: unknown): Record<string, any> {
  if (!isRecord(value)) throw new TypeError("Edge snapshot must be an object");
  return value;
}

function asAgentTool(value: unknown): AgentTool | undefined {
  if (!isRecord(value) || !isRecord(value.definition)) return undefined;
  if (typeof value.definition.name !== "string" || typeof value.execute !== "function") {
    return undefined;
  }
  return value as AgentTool;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedGeneration(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function inputEnabled(input: EdgeRuntimeProjectionInput | unknown, fallback: boolean): boolean {
  return isRecord(input) && typeof input.enabled === "boolean" ? input.enabled : fallback;
}

function inputRefreshRequested(input: EdgeRuntimeProjectionInput | unknown, fallback: boolean): boolean {
  return isRecord(input) && typeof input.refreshRequested === "boolean"
    ? input.refreshRequested
    : fallback;
}

function readToolEntries(snapshot: Record<string, any>): Record<string, any>[] {
  if (Array.isArray(snapshot.tools)) return snapshot.tools.map((item) => isRecord(item) ? item : {});
  if (Array.isArray(snapshot.capabilities)) return snapshot.capabilities.map((item) => isRecord(item) ? item : {});
  const catalog = snapshot.catalog;
  if (catalog !== undefined && typeof catalog.entries === "function") {
    const entries = catalog.entries();
    return Array.isArray(entries) ? entries.map((item: unknown) => isRecord(item) ? item : {}) : [];
  }
  return [];
}

function sourceIdForTool(tool: AgentTool, entries: readonly Record<string, any>[]): string | undefined {
  const entry = entries.find((candidate) => candidate.tool === tool || candidate.agentTool === tool);
  return typeof entry?.sourceId === "string" ? entry.sourceId : undefined;
}

function readContextContributions(snapshot: Record<string, any>): FukaiEdgeContextContribution[] {
  const raw = Array.isArray(snapshot.contextContributions)
    ? snapshot.contextContributions
    : Array.isArray(snapshot.context) ? snapshot.context : [];
  return raw.flatMap((value: unknown) => {
    if (!isRecord(value) || value.kind === "tool" || value.disabled === true) return [];
    if (typeof value.sourceId !== "string" || typeof value.contributionId !== "string") return [];
    if (typeof value.name !== "string" || typeof value.description !== "string") return [];
    if (typeof value.body !== "string") return [];
    return [{
      sourceId: value.sourceId,
      contributionId: value.contributionId,
      sourceType: value.sourceType === "plugin" ? "plugin" : "skill",
      name: value.name,
      description: value.description,
      body: value.body,
      ...(typeof value.contentHash === "string" ? { contentHash: value.contentHash } : {}),
      ...(Number.isSafeInteger(value.precedence) ? { precedence: Number(value.precedence) } : {}),
      ...(value.provenance === undefined ? {} : { provenance: structuredClone(value.provenance) }),
    } satisfies FukaiEdgeContextContribution];
  });
}

function readContextSummaryRecords(snapshot: Record<string, any>): Record<string, any>[] {
  const raw = Array.isArray(snapshot.contextContributions)
    ? snapshot.contextContributions
    : Array.isArray(snapshot.context) ? snapshot.context : [];
  return raw.filter((value: unknown): value is Record<string, any> => (
    isRecord(value)
    && value.kind !== "tool"
    && value.disabled !== true
    && typeof value.sourceId === "string"
    && typeof value.contributionId === "string"
  ));
}

function readEdges(snapshot: Record<string, any>): Record<string, any>[] {
  return Array.isArray(snapshot.edges)
    ? snapshot.edges.filter(isRecord)
    : [];
}

function readDiagnostics(snapshot: Record<string, any>): string[] {
  return readDiagnosticValues(snapshot.diagnostics);
}

function readDiagnosticValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item: unknown) => typeof item === "string"
      ? item
      : isRecord(item) && typeof item.message === "string" ? item.message : String(item))
    : [];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type { MoweEdgeRegistrySnapshot, MoweEdgeToolSnapshot };
