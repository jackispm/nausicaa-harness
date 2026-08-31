import type {
  AgentAwarenessRelation,
  AgentTopologyEdge,
  AgentTopologyNode,
  AgentTopologySnapshot,
} from "../runtime/agent-awareness.js";
import { sanitizeAgentActivitySummary } from "../runtime/agent-awareness.js";

/** Render the canonical snapshot as bounded, copyable terminal text. */
export function renderAgentTopologyText(snapshot: AgentTopologySnapshot): string {
  assertSnapshot(snapshot);
  const nodesByKey = new Map(snapshot.nodes.map((node) => [node.key, node]));
  const children = new Map<string, AgentTopologyEdge[]>();
  const hierarchical = new Set<AgentAwarenessRelation>(["parent", "child", "hosted-by"]);
  for (const edge of snapshot.edges) {
    if (!hierarchical.has(edge.relation)) continue;
    const oriented = orientHierarchy(edge);
    const bucket = children.get(oriented.parent) ?? [];
    bucket.push(oriented.edge);
    children.set(oriented.parent, bucket);
  }
  for (const bucket of children.values()) bucket.sort(compareChildEdges);

  const lines: string[] = [
    `Nausicaa awareness · ${snapshot.nodes.length} nodes · updated ${snapshot.generatedAt}`,
  ];
  const rendered = new Set<string>();
  const roots = snapshot.roots.length > 0
    ? snapshot.roots
    : snapshot.nodes.map((node) => node.key);
  for (const root of roots) {
    if (!nodesByKey.has(root) || rendered.has(root)) continue;
    appendTree(lines, root, "", true, true, nodesByKey, children, rendered);
  }
  // A malformed/cyclic host projection must remain printable and complete.
  for (const node of snapshot.nodes) {
    if (!rendered.has(node.key)) appendTree(lines, node.key, "", true, true, nodesByKey, children, rendered);
  }

  const connections = snapshot.edges.filter((edge) => !hierarchical.has(edge.relation));
  if (connections.length > 0) {
    lines.push("", "connections:");
    for (const edge of connections) {
      lines.push(`  ${shortKey(edge.source)}  -- ${edge.relation} -->  ${shortKey(edge.target)}`);
    }
  }
  if (snapshot.truncated) lines.push("", "[topology truncated at configured bounds]");
  return lines.join("\n");
}

/** Serialize the exact snapshot consumed by the text renderer. */
export function renderAgentTopologyJson(snapshot: AgentTopologySnapshot): string {
  assertSnapshot(snapshot);
  return JSON.stringify(snapshot);
}

/** Generic renderer seam for CLI/TUI callers. */
export function renderAgentTopology(
  snapshot: AgentTopologySnapshot,
  format: "text" | "json" = "text",
): string {
  return format === "json" ? renderAgentTopologyJson(snapshot) : renderAgentTopologyText(snapshot);
}

// Compatibility spellings for future `/agents` and `--topology` wiring.
export const formatAgentTopology = renderAgentTopologyText;
export const serializeAgentTopology = renderAgentTopologyJson;

function assertSnapshot(snapshot: AgentTopologySnapshot): void {
  if (snapshot === null || typeof snapshot !== "object" || snapshot.version !== 1
    || typeof snapshot.generatedAt !== "string"
    || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges)
    || !Array.isArray(snapshot.roots) || typeof snapshot.truncated !== "boolean") {
    throw new TypeError("invalid agent topology snapshot");
  }
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
  return left < right ? -1 : left > right ? 1 : 0;
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
