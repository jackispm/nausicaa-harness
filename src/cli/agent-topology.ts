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
import { nausicaaPalette } from "./tui-components.js";

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
 * Small composition object for `--topology` and `/list-agents` callers. It keeps
 * source reads lazy and exposes no mutation method or daemon control handle.
 */
export interface AgentTopologyPresenter {
  snapshot(): AgentTopologySnapshot;
  render(format?: AgentTopologyFormat): string;
}

/** Optional identity used to anchor the Prime-style Family view. */
export interface AgentTopologyPanelOptions {
  readonly currentEndpoint?: AgentTopologyNode["endpoint"];
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
 * Read-only `/list-agents` view. It intentionally accepts a query rather than a
 * Session/daemon handle, so mounting it cannot submit input or mutate facts.
 */
export class AgentTopologyBlock implements Component {
  private readonly presenter: AgentTopologyPresenter;
  private readonly options: AgentTopologyPanelOptions;

  constructor(
    source: AgentAwarenessQuery | AgentAwarenessInputSource,
    options: AgentTopologyPanelOptions = {},
  ) {
    this.presenter = createAgentTopologyPresenter(source);
    this.options = Object.freeze({ ...options });
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    try {
      return renderAgentTopologyPanel(this.presenter.snapshot(), safeWidth, this.options);
    } catch {
      return [truncateToWidth("Nausicaa agents · unavailable", safeWidth, "")];
    }
  }

  invalidate(): void {}
}

export const AgentTopologyView = AgentTopologyBlock;

/** The Family panel is live; history remains available to diagnostic renderers. */
function visibleAgentTopologySnapshot(snapshot: AgentTopologySnapshot): AgentTopologySnapshot {
  const safeSnapshot = redactAgentTopologySnapshot(snapshot);
  const nodes = safeSnapshot.nodes.filter(isPanelLiveNode);
  const visibleKeys = new Set(nodes.map((node) => node.key));
  return {
    ...safeSnapshot,
    nodes,
    edges: safeSnapshot.edges.filter((edge) => (
      visibleKeys.has(edge.source) && visibleKeys.has(edge.target)
    )),
    roots: safeSnapshot.roots.filter((root) => visibleKeys.has(root)),
  };
}

/** Prime-style live view grouped by current session and then by other sessions. */
export function renderAgentTopologyPanel(
  snapshot: AgentTopologySnapshot,
  width: number,
  options: AgentTopologyPanelOptions = {},
): string[] {
  const safeSnapshot = visibleAgentTopologySnapshot(snapshot);
  const safeWidth = Math.max(1, width);
  const current = findCurrentNode(safeSnapshot.nodes, options.currentEndpoint);
  const currentSessionId = current?.endpoint.sessionId ?? options.currentEndpoint?.sessionId;
  const hierarchy = panelHierarchy(safeSnapshot);
  const lines = [
    formatPanelHeading(safeSnapshot),
    "",
    nausicaaPalette.strong(nausicaaPalette.accentBright("Agent Family")),
  ];

  if (current === undefined) {
    lines.push(`${nausicaaPalette.strong("Current agent")} ${nausicaaPalette.muted("· unavailable")}`);
  } else {
    const depth = panelDepth(current.key, hierarchy.parentByChild);
    lines.push(
      `${nausicaaPalette.strong("Current agent")} ${nausicaaPalette.dim("—")} ${nausicaaPalette.accentBright(current.role)} ${nausicaaPalette.dim("·")} ${nausicaaPalette.muted(`run:${compactIdentity(current.endpoint.runId)}`)} ${nausicaaPalette.dim(`(depth ${depth})`)}`,
    );
    lines.push(
      `  ${nausicaaPalette.dim(`session:${compactIdentity(current.endpoint.sessionId)}`)}  ${nausicaaPalette.dim(`lane:${compactIdentity(current.endpoint.laneId)}`)} ${nausicaaPalette.dim("·")} ${formatColoredPanelStatus(current.state)}`,
    );
  }

  const groups = groupPanelNodesBySession(safeSnapshot.nodes);
  if (currentSessionId !== undefined) {
    const currentSessionNodes = groups.get(currentSessionId) ?? [];
    appendSessionGroup(lines, "Current session", currentSessionId, currentSessionNodes, current, safeSnapshot.edges, safeWidth);
    const otherGroups = [...groups.entries()]
      .filter(([sessionId]) => sessionId !== currentSessionId)
      .sort(([left], [right]) => compareText(left, right));
    lines.push("", nausicaaPalette.strong(`Other sessions (${otherGroups.length})`));
    if (otherGroups.length === 0) {
      lines.push(`  ${nausicaaPalette.dim("none")}`);
    } else {
      otherGroups.forEach(([sessionId, nodes], index) => {
        appendSessionGroup(lines, `Session ${index + 1}`, sessionId, nodes, current, safeSnapshot.edges, safeWidth);
      });
    }
  } else if (groups.size === 0) {
    lines.push("", nausicaaPalette.dim("No live agents discovered"));
  } else {
    lines.push("", nausicaaPalette.strong(`Sessions (${groups.size})`));
    for (const [sessionId, nodes] of [...groups.entries()].sort(([left], [right]) => compareText(left, right))) {
      appendSessionGroup(lines, "Session", sessionId, nodes, current, safeSnapshot.edges, safeWidth);
    }
  }

  lines.push("", formatFamilySummary(safeSnapshot.nodes, current, safeSnapshot.edges));
  const connections = safeSnapshot.edges.filter((edge) => !isHierarchyRelation(edge.relation));
  if (connections.length > 0) {
    const relationCounts = new Map<AgentAwarenessRelation, number>();
    for (const edge of connections) {
      relationCounts.set(edge.relation, (relationCounts.get(edge.relation) ?? 0) + 1);
    }
    const relationSummary = [...relationCounts.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([relation, count]) => `${count} ${relation}`)
      .join(" · ");
    lines.push("", `${nausicaaPalette.strong(`Relationships (${connections.length})`)} ${nausicaaPalette.dim(`· ${relationSummary}`)}`);
  }
  if (safeSnapshot.truncated) lines.push(nausicaaPalette.warning("[topology truncated]"));
  return lines.map((line) => truncateToWidth(line, safeWidth, ""));
}

function isPanelLiveNode(node: AgentTopologyNode): boolean {
  return node.state !== "offline" && node.state !== "terminal";
}

function formatPanelHeading(snapshot: AgentTopologySnapshot): string {
  const availability = snapshot.availability === "fresh"
    ? nausicaaPalette.success(snapshot.availability)
    : snapshot.availability === "stale"
      ? nausicaaPalette.warning(snapshot.availability)
      : nausicaaPalette.error(snapshot.availability);
  return `${nausicaaPalette.strong("Nausicaa awareness")} ${nausicaaPalette.dim("·")} ${nausicaaPalette.accent(`${snapshot.nodes.length} live agents`)} ${nausicaaPalette.dim("·")} ${availability}`;
}

function groupPanelNodesBySession(
  nodes: readonly AgentTopologyNode[],
): Map<string, AgentTopologyNode[]> {
  const groups = new Map<string, AgentTopologyNode[]>();
  for (const node of nodes) {
    const group = groups.get(node.endpoint.sessionId) ?? [];
    group.push(node);
    groups.set(node.endpoint.sessionId, group);
  }
  for (const [sessionId, group] of groups) groups.set(sessionId, sortPanelNodes(group));
  return groups;
}

function appendSessionGroup(
  lines: string[],
  title: string,
  sessionId: string,
  nodes: readonly AgentTopologyNode[],
  current: AgentTopologyNode | undefined,
  edges: readonly AgentTopologyEdge[],
  width: number,
): void {
  const ordered = [...nodes].sort((left, right) => (
    (left.key === current?.key ? -1 : right.key === current?.key ? 1 : 0)
      || comparePanelNodes(left, right)
  ));
  lines.push(
    "",
    `${nausicaaPalette.strong(title)} ${nausicaaPalette.dim("·")} ${nausicaaPalette.accent(`session:${compactIdentity(sessionId)}`)} ${nausicaaPalette.dim(`· ${nodes.length} agents`)}`,
  );
  if (nodes.length === 0) {
    lines.push(`  ${nausicaaPalette.dim("none")}`);
    return;
  }
  lines.push(...renderPanelTable(ordered.map((node) => ({
    node,
    current: node.key === current?.key,
    relation: panelRelation(node, current, edges),
  })), width));
}

interface PanelTableRow {
  readonly node: AgentTopologyNode;
  readonly current: boolean;
  readonly relation: string;
}

function renderPanelTable(rows: readonly PanelTableRow[], width: number): string[] {
  const indexWidth = Math.max(1, String(rows.length).length);
  const rawRows = rows.map(({ node, current, relation }) => ({
    name: formatPanelName(node, current),
    lane: compactIdentity(node.endpoint.laneId),
    status: formatPanelStatus(node.state),
    relation,
    task: formatPanelTask(node),
  }));
  const desired = [
    indexWidth,
    Math.min(34, Math.max(10, ...rawRows.map((row) => textLength(row.name)), textLength("Agent"))),
    Math.min(16, Math.max(6, ...rawRows.map((row) => textLength(row.lane)), textLength("Lane"))),
    Math.min(16, Math.max(8, ...rawRows.map((row) => textLength(row.status)), textLength("Status"))),
    Math.min(18, Math.max(8, ...rawRows.map((row) => textLength(row.relation)), textLength("Relation"))),
    Math.min(48, Math.max(8, ...rawRows.map((row) => textLength(row.task)), textLength("Task"))),
  ];
  const minimum = [indexWidth, 8, 4, 6, 8, 5];
  const widths = desired.map((value, index) => Math.max(minimum[index] ?? 1, value));
  const tableOverhead = widths.length * 3 + 1;
  let excess = widths.reduce((sum, value) => sum + value, 0) + tableOverhead - width;
  for (const index of [5, 1, 4, 2, 3]) {
    if (excess <= 0) break;
    const shrink = Math.min(excess, (widths[index] ?? 1) - (minimum[index] ?? 1));
    widths[index] = (widths[index] ?? 1) - shrink;
    excess -= shrink;
  }
  if (excess > 0) {
    return rawRows.map((row, index) => (
      `  ${fitPanelCell(`${index + 1}. ${row.name} · ${row.relation} · ${row.status} · ${row.task}`, Math.max(8, width - 2))}`
    ));
  }

  const border = (left: string, middle: string, right: string): string => nausicaaPalette.borderMuted(
    `${left}${widths.map((value) => "─".repeat(value + 2)).join(middle)}${right}`,
  );
  const cell = (value: string, index: number): string => fitPanelCell(value, widths[index] ?? 1).padEnd(widths[index] ?? 1, " ");
  const row = (values: readonly string[], rowIndex?: number): string => {
    const name = rowIndex === undefined ? nausicaaPalette.strong(cell(values[1] ?? "", 1)) : nausicaaPalette.text(cell(values[1] ?? "", 1));
    const lane = rowIndex === undefined ? nausicaaPalette.strong(cell(values[2] ?? "", 2)) : nausicaaPalette.muted(cell(values[2] ?? "", 2));
    const status = rowIndex === undefined
      ? nausicaaPalette.strong(cell(values[3] ?? "", 3))
      : formatColoredPanelStatus(rows[rowIndex]?.node.state ?? "idle", cell(values[3] ?? "", 3));
    const relation = rowIndex === undefined
      ? nausicaaPalette.strong(cell(values[4] ?? "", 4))
      : rows[rowIndex]?.current === true
        ? nausicaaPalette.accent(cell(values[4] ?? "", 4))
        : nausicaaPalette.muted(cell(values[4] ?? "", 4));
    const task = rowIndex === undefined ? nausicaaPalette.strong(cell(values[5] ?? "", 5)) : nausicaaPalette.dim(cell(values[5] ?? "", 5));
    return `│ ${nausicaaPalette.dim(cell(values[0] ?? "", 0))} │ ${name} │ ${lane} │ ${status} │ ${relation} │ ${task} │`;
  };
  return [
    border("┌", "┬", "┐"),
    row(["#", "Agent", "Lane", "Status", "Relation", "Task"]),
    border("├", "┼", "┤"),
    ...rawRows.map((values, index) => row([String(index + 1), values.name, values.lane, values.status, values.relation, values.task], index)),
    border("└", "┴", "┘"),
  ];
}

function formatPanelName(node: AgentTopologyNode, current: boolean): string {
  if (current) return `${node.role} · current`;
  return `${node.role} · run:${compactIdentity(node.endpoint.runId)}`;
}

function formatPanelTask(node: AgentTopologyNode): string {
  const task = node.activitySummary === undefined
    ? undefined
    : sanitizeAgentActivitySummary(node.activitySummary);
  return task === undefined ? "—" : task;
}

function formatPanelStatus(state: AgentTopologyNode["state"]): string {
  return `${stateGlyph(state)} ${state}`;
}

function formatColoredPanelStatus(
  state: AgentTopologyNode["state"],
  text = formatPanelStatus(state),
): string {
  switch (state) {
    case "active": return nausicaaPalette.success(text);
    case "starting": return nausicaaPalette.accent(text);
    case "waiting": return nausicaaPalette.warning(text);
    case "sleeping": return nausicaaPalette.info(text);
    case "idle": return nausicaaPalette.dim(text);
    case "terminal":
    case "offline": return nausicaaPalette.muted(text);
  }
}

function comparePanelNodes(left: AgentTopologyNode, right: AgentTopologyNode): number {
  return compareText(left.role, right.role)
    || compareText(left.endpoint.runId, right.endpoint.runId)
    || compareText(left.endpoint.laneId, right.endpoint.laneId);
}

function panelRelation(
  node: AgentTopologyNode,
  current: AgentTopologyNode | undefined,
  edges: readonly AgentTopologyEdge[],
): string {
  if (current?.key === node.key) return "current";
  if (current === undefined) return "live";
  if (node.endpoint.sessionId !== current.endpoint.sessionId) return "other session";
  const labels = new Set<string>();
  for (const edge of edges) {
    const currentToNode = edge.source === current.key && edge.target === node.key;
    const nodeToCurrent = edge.source === node.key && edge.target === current.key;
    if (!currentToNode && !nodeToCurrent) continue;
    labels.add(panelRelationLabel(edge.relation, currentToNode));
  }
  return labels.size === 0 ? "same session" : [...labels].sort(compareText).join(" · ");
}

function panelRelationLabel(
  relation: AgentAwarenessRelation,
  currentToNode: boolean,
): string {
  switch (relation) {
    case "parent": return currentToNode ? "child" : "parent";
    case "child": return currentToNode ? "parent" : "child";
    case "delegates": return currentToNode ? "delegated" : "delegator";
    case "observer": return currentToNode ? "observed" : "observer";
    case "hosted-by": return currentToNode ? "hosted" : "host";
    case "fork-of": return currentToNode ? "fork" : "fork parent";
    case "branch-of": return currentToNode ? "branch" : "branch parent";
    case "routes-to": return currentToNode ? "route" : "router";
    case "peer": return "peer";
  }
}

function fitPanelCell(value: string, width: number): string {
  const safeWidth = Math.max(1, width);
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  if (textLength(normalized) <= safeWidth) return normalized;
  if (safeWidth <= 3) return normalized.slice(0, safeWidth);
  return `${[...normalized].slice(0, safeWidth - 3).join("")}...`;
}

function textLength(value: string): number {
  return [...value].length;
}

function findCurrentNode(
  nodes: readonly AgentTopologyNode[],
  currentEndpoint: AgentTopologyPanelOptions["currentEndpoint"],
): AgentTopologyNode | undefined {
  if (currentEndpoint === undefined) return undefined;
  return nodes.find((node) => (
    node.endpoint.workspaceId === currentEndpoint.workspaceId
    && node.endpoint.sessionId === currentEndpoint.sessionId
    && node.endpoint.runId === currentEndpoint.runId
    && node.endpoint.laneId === currentEndpoint.laneId
  ));
}

interface PanelHierarchy {
  readonly parentByChild: ReadonlyMap<string, string>;
  readonly childrenByParent: ReadonlyMap<string, readonly string[]>;
}

function panelHierarchy(snapshot: AgentTopologySnapshot): PanelHierarchy {
  const hierarchical = new Set<string>(["parent", "child", "hosted-by"]);
  const parentByChild = new Map<string, string>();
  const childrenByParent = new Map<string, string[]>();
  for (const edge of snapshot.edges) {
    if (!hierarchical.has(edge.relation)) continue;
    const parent = edge.relation === "parent" ? edge.source : edge.target;
    const child = edge.relation === "parent" ? edge.target : edge.source;
    const children = childrenByParent.get(parent) ?? [];
    if (!children.includes(child)) children.push(child);
    childrenByParent.set(parent, children);
    const existing = parentByChild.get(child);
    if (existing === undefined || parent < existing) parentByChild.set(child, parent);
  }
  return { parentByChild, childrenByParent };
}

function panelDepth(key: string, parentByChild: ReadonlyMap<string, string>): number {
  const visited = new Set<string>();
  let current = key;
  let depth = 0;
  while (true) {
    if (visited.has(current)) return depth;
    visited.add(current);
    const parent = parentByChild.get(current);
    if (parent === undefined) return depth;
    current = parent;
    depth += 1;
  }
}

function sortPanelNodes(nodes: readonly AgentTopologyNode[]): AgentTopologyNode[] {
  return [...nodes].sort((left, right) => (
    compareText(left.role, right.role)
      || compareText(left.endpoint.runId, right.endpoint.runId)
      || compareText(left.endpoint.sessionId, right.endpoint.sessionId)
      || compareText(left.endpoint.laneId, right.endpoint.laneId)
  ));
}

function isHierarchyRelation(relation: AgentAwarenessRelation): boolean {
  return relation === "parent" || relation === "child" || relation === "hosted-by";
}

function formatFamilySummary(
  nodes: readonly AgentTopologyNode[],
  current: AgentTopologyNode | undefined,
  edges: readonly AgentTopologyEdge[],
): string {
  const counts = new Map<AgentTopologyNode["state"], number>();
  for (const node of nodes) counts.set(node.state, (counts.get(node.state) ?? 0) + 1);
  const status = ["active", "starting", "waiting", "idle", "sleeping", "terminal"]
    .filter((state) => (counts.get(state as AgentTopologyNode["state"]) ?? 0) > 0)
    .map((state) => `${counts.get(state as AgentTopologyNode["state"])} ${state}`)
    .join(" · ");
  const childCount = current === undefined ? undefined : new Set(
    edges
      .filter((edge) => (
        (edge.relation === "parent" && edge.source === current.key)
        || (edge.relation === "child" && edge.target === current.key)
        || (edge.relation === "hosted-by" && edge.target === current.key)
      ))
      .map((edge) => edge.relation === "parent" ? edge.target : edge.source),
  ).size;
  const childLabel = childCount === 1 ? "child" : "children";
  return current === undefined
    ? `${nodes.length} live agents total${status.length === 0 ? "" : ` · ${status}`}`
    : `${nodes.length} live agents total${status.length === 0 ? "" : ` · ${status}`} · ${childCount ?? 0} ${childLabel}`;
}

function stateGlyph(state: AgentTopologyNode["state"]): string {
  switch (state) {
    case "active": return "●";
    case "starting": return "○";
    case "waiting": return "◐";
    case "idle": return "·";
    case "sleeping": return "◌";
    case "terminal": return "✓";
    case "offline": return "×";
  }
}

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

/** Keep the three endpoint fields scannable without hiding their identity. */
function compactIdentity(value: string): string {
  const normalized = compactSegment(value);
  if ([...normalized].length <= 24) return normalized;
  return `${[...normalized].slice(0, 12).join("")}...${[...normalized].slice(-8).join("")}`;
}
