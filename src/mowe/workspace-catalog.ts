import type { AgentTool } from "../domain/ports.js";
import {
  createWorkspaceTools,
  type WorkspaceToolOptions,
} from "../tools/index.js";
import { annotateTool, MoweCatalog } from "./catalog.js";
import type { MoweCapability, MoweToolMetadata } from "./types.js";

/**
 * Turn-local edge tools supplied by an adapter registry. The adapter owns
 * lifecycle and health; this seam only captures the tool set used by Mowe.
 */
export interface WorkspaceEdgeToolSnapshot {
  generation: number;
  /** Direct AgentTool list used by the local adapter facade. */
  tools?: readonly AgentTool[];
  /** Registry-friendly entry shape for adapters that carry metadata per tool. */
  capabilities?: readonly WorkspaceEdgeCapability[];
  /** Alias accepted from registries that call their immutable entries `entries`. */
  entries?: readonly WorkspaceEdgeCapability[];
  metadataByName?: Readonly<Record<string, MoweToolMetadata>>;
}

export interface WorkspaceEdgeCapability {
  tool?: AgentTool;
  agentTool?: AgentTool;
  metadata?: MoweToolMetadata;
}

/** Copy the registry view so later refreshes cannot mutate an active Turn. */
export function freezeWorkspaceEdgeToolSnapshot(
  snapshot: WorkspaceEdgeToolSnapshot,
): WorkspaceEdgeToolSnapshot {
  if (!Number.isSafeInteger(snapshot.generation) || snapshot.generation < 0) {
    throw new RangeError("edge snapshot generation must be a non-negative safe integer");
  }
  const capabilities = [
    ...(snapshot.capabilities ?? []),
  ].map((entry) => Object.freeze({
    ...(entry.tool === undefined ? {} : { tool: entry.tool }),
    ...(entry.agentTool === undefined ? {} : { agentTool: entry.agentTool }),
    ...(entry.metadata === undefined ? {} : { metadata: Object.freeze({ ...entry.metadata }) }),
  }));
  const entries = [
    ...(snapshot.entries ?? []),
  ].map((entry) => Object.freeze({
    ...(entry.tool === undefined ? {} : { tool: entry.tool }),
    ...(entry.agentTool === undefined ? {} : { agentTool: entry.agentTool }),
    ...(entry.metadata === undefined ? {} : { metadata: Object.freeze({ ...entry.metadata }) }),
  }));
  return Object.freeze({
    generation: snapshot.generation,
    ...(snapshot.tools === undefined ? {} : { tools: Object.freeze([...snapshot.tools]) }),
    ...(capabilities.length === 0 ? {} : { capabilities: Object.freeze(capabilities) }),
    ...(entries.length === 0 ? {} : { entries: Object.freeze(entries) }),
    ...(snapshot.metadataByName === undefined
      ? {}
      : { metadataByName: Object.freeze({ ...snapshot.metadataByName }) }),
  });
}

export interface WorkspaceMoweCatalogSnapshot {
  /** Registry generation captured when this catalog was built. */
  readonly generation: number;
  /** Catalog used by Main for this Turn; do not mutate after construction. */
  readonly catalog: MoweCatalog;
  readonly capabilities: readonly MoweCapability[];
}

/** Attach registry metadata before passing edge tools to MainLoop/Mowe. */
export function materializeWorkspaceEdgeTools(
  snapshot: WorkspaceEdgeToolSnapshot | undefined,
): readonly AgentTool[] {
  if (snapshot === undefined) return [];
  const directTools = snapshot.tools ?? [];
  const capabilityTools = [
    ...(snapshot.capabilities ?? []),
    ...(snapshot.entries ?? []),
  ].flatMap((entry) => {
    const tool = entry.tool ?? entry.agentTool;
    return tool === undefined ? [] : [{ tool, metadata: entry.metadata }];
  });
  return Object.freeze([
    ...directTools.map((tool) => ({ tool, metadata: undefined })),
    ...capabilityTools,
  ].map(({ tool, metadata }) => {
    const resolvedMetadata = metadata ?? snapshot.metadataByName?.[tool.definition.name];
    return resolvedMetadata === undefined ? tool : annotateTool(tool, resolvedMetadata);
  }));
}

/**
 * Options for the first-party workspace catalog.  `additionalTools` is the
 * narrow adapter seam for runtime capabilities such as delegation or advice;
 * it never bypasses Mowe registration, schema admission, or effect filtering.
 */
export interface WorkspaceMoweCatalogOptions extends WorkspaceToolOptions {
  additionalTools?: readonly AgentTool[];
  metadataByName?: Readonly<Record<string, MoweToolMetadata>>;
  edgeSnapshot?: WorkspaceEdgeToolSnapshot;
}

/**
 * Build the complete Nausicaa workspace tool surface for Mowe.
 *
 * The factory intentionally delegates implementation and path security to the
 * existing workspace tools.  Mowe supplies the common catalog and execution
 * boundary, so callers do not have to maintain a second list of first-party
 * tools when adding optional write, shell, or lane capabilities.
 */
export function createWorkspaceMoweCatalog(
  options: WorkspaceMoweCatalogOptions = {},
): MoweCatalog {
  const {
    additionalTools = [],
    metadataByName = {},
    edgeSnapshot,
    ...workspaceOptions
  } = options;
  const catalog = new MoweCatalog(createWorkspaceTools(workspaceOptions));
  const edgeMetadata = edgeSnapshot?.metadataByName ?? {};
  catalog.registerMany(additionalTools, metadataByName);
  catalog.registerMany(materializeWorkspaceEdgeTools(edgeSnapshot), edgeMetadata);
  return catalog;
}

/** Build a stable catalog view for one Turn without refreshing adapters. */
export function createWorkspaceMoweCatalogSnapshot(
  options: WorkspaceMoweCatalogOptions = {},
): WorkspaceMoweCatalogSnapshot {
  const edgeSnapshot = options.edgeSnapshot === undefined
    ? undefined
    : freezeWorkspaceEdgeToolSnapshot(options.edgeSnapshot);
  const catalog = edgeSnapshot === undefined
    ? createWorkspaceMoweCatalog(options)
    : createWorkspaceMoweCatalog({ ...options, edgeSnapshot });
  return Object.freeze({
    generation: edgeSnapshot?.generation ?? 0,
    catalog,
    capabilities: Object.freeze(catalog.capabilities()),
  });
}
