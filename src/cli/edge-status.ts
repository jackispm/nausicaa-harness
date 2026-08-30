import type {
  EdgeSourceSettings,
  ResolvedEdgeSettings,
} from "../config/settings.js";
import type { EdgeRuntimeStatusProjection } from "../runtime/edge-runtime.js";
import type { EdgeProvenance } from "../mowe/edge-types.js";

export type EdgeSourceStatus = "disabled" | "configured";

export interface EdgeStatusSource {
  sourceId: string;
  type: EdgeSourceSettings["type"] | string;
  status: EdgeSourceStatus;
  health?: string;
  toolCount?: number;
  contextCount?: number;
  diagnostics?: readonly string[];
  provenance?: readonly EdgeProvenance[];
}

/** Read-only status projection for CLI/TUI surfaces. */
export interface EdgeStatusProjection {
  enabled: boolean;
  refreshRequested: boolean;
  generation: number;
  sources: readonly EdgeStatusSource[];
  toolCount?: number;
  contextCount?: number;
  diagnostics?: readonly string[];
}

/**
 * Project configuration without touching an adapter or starting a process.
 * Runtime registry health can replace this projection after discovery; a
 * config-only projection deliberately reports generation zero.
 */
export function projectConfiguredEdgeStatus(
  settings: ResolvedEdgeSettings,
): EdgeStatusProjection {
  const enabled = settings.enabled;
  return {
    enabled,
    refreshRequested: settings.refreshOnStart,
    generation: 0,
    toolCount: 0,
    contextCount: 0,
    diagnostics: [],
    sources: Object.freeze(settings.sources.map((source) => Object.freeze({
      sourceId: source.sourceId,
      type: source.type,
      status: enabled && source.enabled !== false ? "configured" : "disabled",
    }))),
  };
}

/** Convert a cached runtime status to the synchronous CLI/TUI projection. */
export function projectRuntimeEdgeStatus(
  status: EdgeRuntimeStatusProjection,
): EdgeStatusProjection {
  return {
    enabled: status.enabled,
    refreshRequested: status.refreshRequested,
    generation: status.generation,
    toolCount: status.toolCount,
    contextCount: status.contextCount,
    diagnostics: Object.freeze([...status.diagnostics]),
    sources: Object.freeze(status.sources.map((source) => Object.freeze({
      sourceId: source.sourceId,
      type: source.type,
      status: source.enabled === false ? "disabled" : "configured",
      ...(source.health === undefined ? {} : { health: source.health }),
      toolCount: source.toolCount,
      contextCount: source.contextCount,
      diagnostics: Object.freeze([...source.diagnostics]),
      provenance: Object.freeze(source.provenance.map((item) => structuredClone(item))),
    }))),
  };
}

export function formatEdgeStatus(status: EdgeStatusProjection): string {
  const enabled = status.enabled ? "enabled" : "off";
  const refresh = status.refreshRequested ? "; refresh requested" : "";
  const lines = [
    "### Edges",
    `- **State:** ${enabled}; generation ${status.generation}; ${status.toolCount ?? 0} tool(s); ${status.contextCount ?? 0} context contribution(s)${refresh}`,
  ];
  if ((status.diagnostics?.length ?? 0) > 0) {
    lines.push(`- **Diagnostics:** ${status.diagnostics?.join("; ")}`);
  }
  if (status.sources.length === 0) {
    lines.push("- **Sources:** none configured");
  } else {
    lines.push(
      `- **Sources:** ${status.sources.map((source) => (
        `${source.sourceId} (${source.type}; ${source.health ?? source.status}; ${source.toolCount ?? 0} tool(s); ${source.contextCount ?? 0} context)`
      )).join(", ")}`,
    );
  }
  return lines.join("\n");
}
