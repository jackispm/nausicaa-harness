import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

import type {
  AgentAwarenessRelation,
  AgentAwarenessInputSource,
  AgentAwarenessQuery,
  AgentTopologyEdge,
  AgentTopologyNode,
  AgentTopologySnapshot,
} from "../runtime/agent-awareness.js";
import {
  createAgentAwarenessQuery,
  redactAgentTopologySnapshot,
  sanitizeAgentActivitySummary,
} from "../runtime/agent-awareness.js";

export type AgentTopologyFormat = "text" | "json";

/** Parse the value accepted by the future `--topology` command. */
export function parseAgentTopologyFormat(value: unknown): AgentTopologyFormat {
  if (value === undefined || value === "text") return "text";
  if (value === "json") return "json";
  throw new TypeError("topology format must be text or json");
}

/** Render the canonical snapshot as bounded, copyable terminal text. */
export function renderAgentTopologyText(snapshot: AgentTopologySnapshot): string {
  const safeSnapshot = redactAgentTopologySnapshot(snapshot);
  const nodesByKey = new Map(safeSnapshot.nodes.map((node) => [node.key, node]));
  const children = new Map<string, AgentTopologyEdge[]>();
  const hierarchical = new Set<AgentAwarenessRelation>(["parent", "child", "hosted-by"]);
  for (const edge of safeSnapshot.edges) {
    if (!hierarchical.has(edge.relation)) continue;
    const oriented = orientHierarchy(edge);
    const bucket = children.get(oriented.parent) ?? [];
    bucket.push(oriented.edge);
    children.set(oriented.parent, bucket);
  }
  for (const bucket of children.values()) bucket.sort(compareChildEdges);

  const lines: string[] = [
    `Nausicaa awareness · ${safeSnapshot.nodes.length} nodes · source ${safeSnapshot.availability} · updated ${safeSnapshot.generatedAt}`,
  ];
  const rendered = new Set<string>();
  const roots = safeSnapshot.roots.length > 0
    ? safeSnapshot.roots
    : safeSnapshot.nodes.map((node) => node.key);
  for (const root of roots) {
    if (!nodesByKey.has(root) || rendered.has(root)) continue;
    appendTree(lines, root, "", true, true, nodesByKey, children, rendered);
  }
  // A malformed/cyclic host projection must remain printable and complete.
  for (const node of safeSnapshot.nodes) {
    if (!rendered.has(node.key)) appendTree(lines, node.key, "", true, true, nodesByKey, children, rendered);
  }

  const connections = safeSnapshot.edges.filter((edge) => !hierarchical.has(edge.relation));
  if (connections.length > 0) {
    lines.push("", "connections:");
    for (const edge of connections) {
      lines.push(`  ${shortKey(edge.source)}  -- ${edge.relation} -->  ${shortKey(edge.target)}`);
    }
  }
  if (safeSnapshot.truncated) lines.push("", "[topology truncated at configured bounds]");
  return lines.join("\n");
}

/** Serialize the redaction-safe snapshot consumed by the text renderer. */
export function renderAgentTopologyJson(snapshot: AgentTopologySnapshot): string {
  return JSON.stringify(redactAgentTopologySnapshot(snapshot));
}

/** Generic renderer seam for CLI/TUI callers. */
export function renderAgentTopology(
  snapshot: AgentTopologySnapshot,
  format: AgentTopologyFormat = "text",
): string {
  return parseAgentTopologyFormat(format) === "json"
    ? renderAgentTopologyJson(snapshot)
    : renderAgentTopologyText(snapshot);
}

/** Render one point-in-time query for a CLI `--topology` invocation. */
export function renderAgentTopologyFromSource(
  source: AgentAwarenessQuery | AgentAwarenessInputSource,
  format: AgentTopologyFormat = "text",
): string {
  return createAgentTopologyPresenter(source).render(format);
}

/**
 * Small composition object for `--topology` and `/agents` callers. It keeps
 * source reads lazy and exposes no mutation method or daemon control handle.
 */
export interface AgentTopologyPresenter {
  snapshot(): AgentTopologySnapshot;
  render(format?: AgentTopologyFormat): string;
}

export function createAgentTopologyPresenter(
  source: AgentAwarenessQuery | AgentAwarenessInputSource,
): AgentTopologyPresenter {
  const query = isAwarenessQuery(source) ? source : createAgentAwarenessQuery(source);
  return Object.freeze({
    snapshot: (): AgentTopologySnapshot => query.snapshot(),
    render: (format: AgentTopologyFormat = "text"): string => renderAgentTopology(query.snapshot(), format),
  });
}

/** Compatibility spellings for existing embedders and future command wiring. */
export const formatAgentTopology = renderAgentTopologyText;
export const serializeAgentTopology = renderAgentTopologyJson;

/**
 * Read-only `/agents` view.  It intentionally accepts a query rather than a
 * Session/daemon handle, so mounting it cannot submit input or mutate facts.
 */
export class AgentTopologyBlock implements Component {
  private readonly presenter: AgentTopologyPresenter;

  constructor(source: AgentAwarenessQuery | AgentAwarenessInputSource) {
    this.presenter = createAgentTopologyPresenter(source);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    try {
      return this.presenter.render("text")
        .split("\n")
        .map((line) => truncateToWidth(line, safeWidth, ""));
    } catch {
      return [truncateToWidth("Nausicaa agents · unavailable", safeWidth, "")];
    }
  }

  invalidate(): void {}
}

export const AgentTopologyView = AgentTopologyBlock;

function isAwarenessQuery(
  source: AgentAwarenessQuery | AgentAwarenessInputSource,
): source is AgentAwarenessQuery {
  return typeof source === "object"
    && source !== null
    && typeof (source as AgentAwarenessQuery).snapshot === "function";
}

function orientHierarchy(edge: AgentTopologyEdge): { readonly parent: string; readonly edge: AgentTopologyEdge } {
  if (edge.relation === "parent") return { parent: edge.source, edge };
  return {
    parent: edge.target,
    edge: edge.relation === "child"
      ? { source: edge.target, target: edge.source, relation: "parent" }
      : { source: edge.target, target: edge.source, relation: "parent" },
  };
}

function compareChildEdges(left: AgentTopologyEdge, right: AgentTopologyEdge): number {
  return compareText(left.target, right.target) || compareText(left.source, right.source);
}

function compareText(left: string, right: string): number {
  return compareCodeUnits(left, right);
}

function compareCodeUnits(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftCode = left.charCodeAt(index);
    const rightCode = right.charCodeAt(index);
    if (leftCode !== rightCode) return leftCode < rightCode ? -1 : 1;
  }
  return left.length - right.length;
}

function appendTree(
  lines: string[],
  key: string,
  prefix: string,
  isLast: boolean,
  isRoot: boolean,
  nodesByKey: ReadonlyMap<string, AgentTopologyNode>,
  children: ReadonlyMap<string, readonly AgentTopologyEdge[]>,
  rendered: Set<string>,
): void {
  const node = nodesByKey.get(key);
  if (node === undefined || rendered.has(key)) return;
  rendered.add(key);
  const branch = isRoot ? "" : (isLast ? "└─ " : "├─ ");
  lines.push(`${prefix}${branch}${formatNode(node)}`);
  const descendants = children.get(key) ?? [];
  const nextPrefix = isRoot ? "" : `${prefix}${isLast ? "   " : "│  "}`;
  descendants.forEach((edge, index) => {
    appendTree(lines, edge.target, nextPrefix, index === descendants.length - 1, false, nodesByKey, children, rendered);
  });
}

function formatNode(node: AgentTopologyNode): string {
  const safeSummary = node.activitySummary === undefined
    ? undefined
    : sanitizeAgentActivitySummary(node.activitySummary);
  const summary = safeSummary === undefined ? "" : `  ${safeSummary}`;
  return `${shortKey(node.key)}  [${node.state}]  <${node.role}>${summary}`;
}

function shortKey(key: string): string {
  // endpointKey is a stable JSON tuple; decode only for a human-friendly label.
  try {
    const value: unknown = JSON.parse(key);
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      return value.map((item) => compactSegment(item)).join("/");
    }
  } catch {
    // Keep the already bounded canonical key if an embedder supplies another form.
  }
  return compactSegment(key);
}

function compactSegment(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/(?:^|\s)(?:\/(?:Users|private|tmp|var|home|root|etc|opt)\/[^\s]+|[A-Za-z]:\\[^\s]+)/gu, " [path]")
    .replace(/\b(?:token|secret|password|passwd|api[-_ ]?key|authorization|cookie|bearer)\b\s*[:=]\s*[^\s,;]+/giu, "[redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length <= 80) return normalized;
  return `${[...normalized].slice(0, 77).join("")}...`;
}
