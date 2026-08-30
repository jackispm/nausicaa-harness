import type {
  EdgeSourceSettings,
  ResolvedEdgeSettings,
} from "../config/settings.js";

export type EdgeSourceStatus = "disabled" | "configured";

export interface EdgeStatusSource {
  sourceId: string;
  type: EdgeSourceSettings["type"];
  status: EdgeSourceStatus;
}

/** Read-only status projection for CLI/TUI surfaces. */
export interface EdgeStatusProjection {
  enabled: boolean;
  refreshRequested: boolean;
  generation: number;
  sources: readonly EdgeStatusSource[];
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
    sources: Object.freeze(settings.sources.map((source) => Object.freeze({
      sourceId: source.sourceId,
      type: source.type,
      status: enabled && source.enabled !== false ? "configured" : "disabled",
    }))),
  };
}

export function formatEdgeStatus(status: EdgeStatusProjection): string {
  const enabled = status.enabled ? "enabled" : "off";
  const refresh = status.refreshRequested ? "; refresh requested" : "";
  const lines = [
    "### Edges",
    `- **State:** ${enabled}; generation ${status.generation}${refresh}`,
  ];
  if (status.sources.length === 0) {
    lines.push("- **Sources:** none configured");
  } else {
    lines.push(
      `- **Sources:** ${status.sources.map((source) => (
        `${source.sourceId} (${source.type}; ${source.status})`
      )).join(", ")}`,
    );
  }
  return lines.join("\n");
}
