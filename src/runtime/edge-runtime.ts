import type { AgentTool } from "../domain/ports.js";
import { resolveMetadata } from "../mowe/catalog.js";
import { ARTIFACT_READ_TOOL_NAME } from "../tools/artifact-read.js";
import type {
  EdgeProvenance,
  MoweEdgeRegistrySnapshot,
  MoweEdgeToolSnapshot,
} from "../mowe/index.js";
import type { MoweAgentTool, ResolvedMoweToolMetadata } from "../mowe/types.js";
import {
  materializeWorkspaceEdgeTools,
  type WorkspaceEdgeToolSnapshot,
} from "../mowe/workspace-catalog.js";
import type { FukaiEdgeContextContribution } from "../fukai/types.js";

const MAX_SELECTED_EDGE_CONTEXT_ITEMS = 16;
const MAX_EDGE_CONTEXT_LOAD_CONCURRENCY = 4;
const MAX_EDGE_CONTEXT_BODY_BYTES = 64 * 1024;
const MAX_EDGE_CONTEXT_DESCRIPTION_BYTES = 4 * 1024;
const MAX_EDGE_CONTEXT_TOTAL_BYTES = 256 * 1024;

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
  selectContext: (summary: unknown) => boolean = () => false,
): EdgeTurnSnapshotProvider {
  return {
    capture: async (options) => {
      const snapshot = registry.snapshot();
      if (registry.loadContribution === undefined) return snapshot;
      const raw = asRecord(snapshot);
      const summaries = Array.isArray(raw.contextContributions)
        ? raw.contextContributions
          .filter(selectContext)
          .sort(compareContextSummaries)
          .slice(0, MAX_SELECTED_EDGE_CONTEXT_ITEMS)
        : [];
      if (summaries.length === 0) return snapshot;
      const outcomes = await loadSelectedContextContributions(
        registry,
        summaries,
        snapshot,
        options?.signal,
      );
      const diagnostics = outcomes.flatMap((outcome) => {
        if (!("error" in outcome)) return [];
        const summary = isRecord(outcome.summary) ? outcome.summary : {};
        return [{
          code: "context-load-failed",
          severity: "error",
          ...(typeof summary.sourceId === "string" ? { sourceId: summary.sourceId } : {}),
          message: `Context contribution load failed${
            typeof summary.name === "string" ? ` for ${summary.name}` : ""
          }: ${errorMessage(outcome.error)}`,
        }];
      });
      return {
        ...raw,
        contextContributions: outcomes.flatMap((outcome) => (
          "loaded" in outcome ? [outcome.loaded] : []
        )),
        ...(diagnostics.length === 0
          ? {}
          : {
              diagnostics: [
                ...(Array.isArray(raw.diagnostics) ? raw.diagnostics : []),
                ...diagnostics,
              ],
            }),
      };
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

export interface EdgeRuntimeCapabilities {
  readonly allowWrite: boolean;
  readonly allowShell: boolean;
  readonly allowNetwork: boolean;
}

/** Apply the current Turn boundary after host grants have admitted an edge tool. */
export function materializePermittedEdgeTools(
  snapshot: WorkspaceEdgeToolSnapshot | undefined,
  capabilities: EdgeRuntimeCapabilities,
): readonly AgentTool[] {
  return Object.freeze(materializeWorkspaceEdgeTools(snapshot).filter((tool) => {
    const metadata = resolveMetadata(
      (tool as MoweAgentTool).metadata,
      tool.definition.name.trim(),
    );
    return edgeToolPermitted(metadata, capabilities);
  }));
}

/**
 * Append edge tools without allowing an edge declaration to shadow a host
 * tool already admitted for the same Turn. Host tools retain deterministic
 * precedence; duplicate edge names are ignored before Mowe registration.
 */
export function appendPermittedEdgeTools(
  baseTools: readonly AgentTool[],
  snapshot: WorkspaceEdgeToolSnapshot | undefined,
  capabilities: EdgeRuntimeCapabilities,
): readonly AgentTool[] {
  const names = new Set(baseTools.map((tool) => tool.definition.name.trim()));
  const appended = materializePermittedEdgeTools(snapshot, capabilities).filter((tool) => {
    const name = tool.definition.name.trim();
    // MainLoop owns this run-authorized reader even though it is injected
    // after the ordinary first-party tool assembly.
    if (name === ARTIFACT_READ_TOOL_NAME) return false;
    if (names.has(name)) return false;
    names.add(name);
    return true;
  });
  return Object.freeze([...baseTools, ...appended]);
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

function edgeToolPermitted(
  metadata: ResolvedMoweToolMetadata,
  capabilities: EdgeRuntimeCapabilities,
): boolean {
  const fullAccess = capabilities.allowWrite
    && capabilities.allowShell
    && capabilities.allowNetwork;
  if (metadata.scope === "host" && !fullAccess) return false;
  if (metadata.effect === "write") return capabilities.allowWrite;
  if (metadata.effect === "external") return fullAccess;
  return true;
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

async function loadSelectedContextContributions(
  registry: EdgeRuntimeRegistryLike,
  summaries: readonly unknown[],
  snapshot: unknown,
  signal: AbortSignal | undefined,
): Promise<ContextLoadOutcome[]> {
  const outcomes: ContextLoadOutcome[] = [];
  let totalBytes = 0;
  for (let offset = 0; offset < summaries.length; offset += MAX_EDGE_CONTEXT_LOAD_CONCURRENCY) {
    throwIfContextLoadAborted(signal);
    const batch = summaries.slice(offset, offset + MAX_EDGE_CONTEXT_LOAD_CONCURRENCY);
    const loaded = await Promise.all(batch.map(async (summary): Promise<ContextLoadOutcome> => {
      try {
        const contribution = await registry.loadContribution!(
          summary,
          { ...(signal === undefined ? {} : { signal }), snapshot },
        );
        throwIfContextLoadAborted(signal);
        return {
          summary,
          loaded: contribution,
          byteLength: contextContributionByteLength(contribution),
        };
      } catch (error) {
        if (signal?.aborted === true) throw signal.reason ?? error;
        return { summary, error };
      }
    }));
    for (const outcome of loaded) {
      if ("error" in outcome) {
        outcomes.push(outcome);
        continue;
      }
      if (totalBytes + outcome.byteLength > MAX_EDGE_CONTEXT_TOTAL_BYTES) {
        outcomes.push({
          summary: outcome.summary,
          error: new RangeError(
            `Selected context exceeds the ${MAX_EDGE_CONTEXT_TOTAL_BYTES} byte total limit`,
          ),
        });
        continue;
      }
      totalBytes += outcome.byteLength;
      outcomes.push(outcome);
    }
  }
  return outcomes;
}

type ContextLoadOutcome = {
  readonly summary: unknown;
  readonly error: unknown;
} | {
  readonly summary: unknown;
  readonly loaded: unknown;
  readonly byteLength: number;
};

function contextContributionByteLength(value: unknown): number {
  if (!isRecord(value) || typeof value.body !== "string") {
    throw new TypeError("Loaded context contribution must include a string body");
  }
  if (typeof value.description !== "string") {
    throw new TypeError("Loaded context contribution must include a string description");
  }
  const bodyBytes = Buffer.byteLength(value.body, "utf8");
  const descriptionBytes = Buffer.byteLength(value.description, "utf8");
  if (descriptionBytes > MAX_EDGE_CONTEXT_DESCRIPTION_BYTES) {
    throw new RangeError(
      `Loaded context description exceeds the ${MAX_EDGE_CONTEXT_DESCRIPTION_BYTES} byte limit`,
    );
  }
  if (bodyBytes > MAX_EDGE_CONTEXT_BODY_BYTES) {
    throw new RangeError(
      `Loaded context body exceeds the ${MAX_EDGE_CONTEXT_BODY_BYTES} byte limit`,
    );
  }
  const byteLength = bodyBytes + descriptionBytes;
  if (byteLength > MAX_EDGE_CONTEXT_TOTAL_BYTES) {
    throw new RangeError(
      `Loaded context exceeds the ${MAX_EDGE_CONTEXT_TOTAL_BYTES} byte total limit`,
    );
  }
  return byteLength;
}

function compareContextSummaries(left: unknown, right: unknown): number {
  return compareText(contextSummaryField(left, "sourceId"), contextSummaryField(right, "sourceId"))
    || compareText(
      contextSummaryField(left, "contributionId"),
      contextSummaryField(right, "contributionId"),
    )
    || compareText(contextSummaryField(left, "name"), contextSummaryField(right, "name"))
    || compareText(contextSummaryField(left, "contentHash"), contextSummaryField(right, "contentHash"));
}

function contextSummaryField(value: unknown, field: string): string {
  return isRecord(value) && typeof value[field] === "string" ? value[field] : "";
}

function throwIfContextLoadAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason ?? new Error("Edge context load cancelled");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type { MoweEdgeRegistrySnapshot, MoweEdgeToolSnapshot };
