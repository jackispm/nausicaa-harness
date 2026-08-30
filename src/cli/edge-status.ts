import type {
  EdgeSourceSettings,
  ResolvedEdgeSettings,
} from "../config/settings.js";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { EdgeRuntimeStatusProjection } from "../runtime/edge-runtime.js";
import type { EdgeProvenance } from "../mowe/edge-types.js";
import type { EdgeSkillSummary } from "./edge-selection.js";

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
  /** Metadata-only discovered Skill summaries for the read-only picker. */
  discoveredSkills?: readonly EdgeSkillSummary[];
  /** Short alias for embedders that already use a `skills` field. */
  skills?: readonly EdgeSkillSummary[];
  selectedSkillIds?: readonly string[];
  stale?: boolean;
  refreshing?: boolean;
  health?: string;
  provenance?: readonly EdgeProvenance[];
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
  const extended = status as EdgeRuntimeStatusProjection & {
    readonly discoveredSkills?: readonly EdgeSkillSummary[];
    readonly skills?: readonly EdgeSkillSummary[];
    readonly contextContributions?: readonly Record<string, unknown>[];
    readonly selectedSkillIds?: readonly string[];
    readonly stale?: boolean;
    readonly refreshing?: boolean;
    readonly health?: string;
    readonly provenance?: readonly EdgeProvenance[];
  };
  const discoveredSkills = extended.discoveredSkills
    ?? extended.skills
    ?? extended.contextContributions?.flatMap((value): EdgeSkillSummary[] => {
      if ((value.sourceType !== undefined && value.sourceType !== "skill")
        || typeof value.sourceId !== "string" || typeof value.contributionId !== "string"
        || typeof value.name !== "string") return [];
      return [{
        id: `${value.sourceId}:${value.contributionId}`,
        sourceId: value.sourceId,
        contributionId: value.contributionId,
        name: value.name,
        description: typeof value.description === "string" ? value.description : "",
        disabled: value.disabled === true,
        selected: extended.selectedSkillIds?.includes(`${value.sourceId}:${value.contributionId}`) ?? false,
        ...(typeof value.contentHash === "string" ? { contentHash: value.contentHash } : {}),
        ...(value.provenance !== undefined ? { provenance: structuredClone(value.provenance) as EdgeProvenance } : {}),
      }];
    });
  return {
    enabled: status.enabled,
    refreshRequested: status.refreshRequested,
    generation: status.generation,
    toolCount: status.toolCount,
    contextCount: status.contextCount,
    diagnostics: Object.freeze([...status.diagnostics]),
    ...(discoveredSkills === undefined ? {} : {
      discoveredSkills: Object.freeze(discoveredSkills.map((skill) => Object.freeze({
        ...skill,
        ...(skill.provenance === undefined ? {} : { provenance: freezeProvenance(skill.provenance) }),
      }))),
      skills: Object.freeze(discoveredSkills.map((skill) => Object.freeze({
        ...skill,
        ...(skill.provenance === undefined ? {} : { provenance: freezeProvenance(skill.provenance) }),
      }))),
    }),
    ...(extended.selectedSkillIds === undefined ? {} : {
      selectedSkillIds: Object.freeze([...extended.selectedSkillIds]),
    }),
    ...(extended.stale === undefined ? {} : { stale: extended.stale }),
    ...(extended.refreshing === undefined ? {} : { refreshing: extended.refreshing }),
    ...(extended.health === undefined ? {} : { health: extended.health }),
    ...(extended.provenance === undefined ? {} : {
      provenance: Object.freeze(extended.provenance.map((item) => freezeProvenance(item))),
    }),
    sources: Object.freeze(status.sources.map((source) => Object.freeze({
      sourceId: source.sourceId,
      type: source.type,
      status: source.enabled === false ? "disabled" : "configured",
      ...(source.health === undefined ? {} : { health: source.health }),
      toolCount: source.toolCount,
      contextCount: source.contextCount,
      diagnostics: Object.freeze([...source.diagnostics]),
      provenance: Object.freeze(source.provenance.map((item) => freezeProvenance(item))),
    }))),
  };
}

export function formatEdgeStatus(status: EdgeStatusProjection): string {
  const enabled = status.enabled ? "enabled" : "off";
  const refresh = status.refreshRequested ? "; refresh requested" : "";
  const lines = [
    "### Edges",
    `- **State:** ${enabled}${status.health === undefined ? "" : `; health ${safeText(status.health)}`}; generation ${status.generation}; ${status.toolCount ?? 0} tool(s); ${status.contextCount ?? 0} context contribution(s)${refresh}`,
  ];
  if (status.refreshing === true) lines.push("- **Refresh:** in progress");
  if (status.stale === true) lines.push("- **Notice:** showing a stale snapshot; refresh was cancelled or failed");
  if ((status.diagnostics?.length ?? 0) > 0) {
    lines.push(`- **Diagnostics:** ${status.diagnostics?.map(safeText).join("; ")}`);
  }
  if (status.sources.length === 0) {
    lines.push("- **Sources:** none configured");
  } else {
    lines.push(
      `- **Sources:** ${status.sources.map((source) => (
        `${safeText(source.sourceId)} (${safeText(source.type)}; ${safeText(source.health ?? source.status)}; ${source.toolCount ?? 0} tool(s); ${source.contextCount ?? 0} context${source.provenance?.[0]?.upstreamName === undefined ? "" : `; via ${safeText(source.provenance[0].upstreamName)}`})`
      )).join(", ")}`,
    );
  }
  const sourceDiagnostics = status.sources.flatMap((source) => source.diagnostics ?? []);
  if (sourceDiagnostics.length > 0) {
    lines.push(`- **Source diagnostics:** ${sourceDiagnostics.map(safeText).join("; ")}`);
  }
  const skills = status.discoveredSkills ?? status.skills ?? [];
  if (status.discoveredSkills !== undefined || status.skills !== undefined) {
    if (skills.length > 0) {
      lines.push(`- **Skills:** ${skills.map((skill) => {
        const state = skill.disabled ? "disabled" : skill.selected ? "selected for next Turn" : "available";
        return `${safeText(skill.name)} (${state})`;
      }).join(", ")}`);
    } else {
      lines.push("- **Skills:** none discovered");
    }
  }
  const provenance = [
    ...(status.provenance ?? []),
    ...status.sources.flatMap((source) => source.provenance ?? []),
  ];
  if (provenance.length > 0) {
    lines.push(`- **Provenance:** ${provenance.map((item) => safeText(item.upstreamName ?? "unknown")).join(", ")}`);
  }
  return lines.join("\n");
}

function safeText(value: string): string {
  return stripTerminalSequences(value)
    .replace(/[\u0000-\u001f\u007f]/g, "");
}

function freezeProvenance(value: EdgeProvenance): EdgeProvenance {
  return Object.freeze({
    upstreamName: value.upstreamName,
    upstreamVersion: value.upstreamVersion,
    license: value.license,
    ...(value.author === undefined ? {} : { author: value.author }),
    ...(value.sourceUri === undefined ? {} : { sourceUri: value.sourceUri }),
  });
}
