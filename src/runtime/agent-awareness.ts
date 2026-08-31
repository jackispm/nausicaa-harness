import type {
  CrossRunEndpoint,
  LaneKind,
  LaneStatus,
} from "../domain/types.js";
import { endpointKey, normalizeEndpoint } from "../a2a/cross-run-contract.js";

/** Version of the user-facing Awareness projection. */
export const AGENT_AWARENESS_SNAPSHOT_VERSION = 1 as const;

/** A short observation window keeps abandoned registrations from looking live. */
export const DEFAULT_AGENT_AWARENESS_FRESHNESS_MS = 5 * 60 * 1_000;
export const DEFAULT_AGENT_AWARENESS_MAX_NODES = 512;
export const DEFAULT_AGENT_AWARENESS_MAX_EDGES = 2_048;
export const MAX_AGENT_AWARENESS_NODES = 4_096;
export const MAX_AGENT_AWARENESS_EDGES = 8_192;
export const MAX_AGENT_AWARENESS_ACTIVITY_CHARS = 160;

export type AgentAwarenessRole =
  | "main"
  | "teto"
  | "worker"
  | "reflection"
  | "auxiliary"
  | "unknown";

export type AgentAwarenessState =
  | "starting"
  | "active"
  | "waiting"
  | "idle"
  | "sleeping"
  | "offline"
  | "terminal";

export type AgentAwarenessRelation =
  | "parent"
  | "child"
  | "peer"
  | "observer"
  | "fork-of"
  | "branch-of"
  | "hosted-by";

/** The immutable, user-visible node in one topology snapshot. */
export interface AgentTopologyNode {
  readonly key: string;
  readonly endpoint: CrossRunEndpoint;
  readonly role: AgentAwarenessRole;
  readonly state: AgentAwarenessState;
  readonly activitySummary?: string;
  readonly generation?: number;
  readonly lastSeen: string;
}

/** An explicit relationship; the projection never infers one from names. */
export interface AgentTopologyEdge {
  readonly source: string;
  readonly target: string;
  readonly relation: AgentAwarenessRelation;
}

/** Canonical output consumed by all user-facing renderers. */
export interface AgentTopologySnapshot {
  readonly version: typeof AGENT_AWARENESS_SNAPSHOT_VERSION;
  readonly generatedAt: string;
  readonly nodes: readonly AgentTopologyNode[];
  readonly edges: readonly AgentTopologyEdge[];
  readonly roots: readonly string[];
  readonly truncated: boolean;
}

/** Awareness-prefixed aliases keep the public vocabulary discoverable. */
export type AgentAwarenessNode = AgentTopologyNode;
export type AgentAwarenessEdge = AgentTopologyEdge;
export type AgentAwarenessSnapshot = AgentTopologySnapshot;

/** A trusted relationship supplied by the host/A2A composition. */
export interface AgentAwarenessRelationshipInput {
  readonly relation: AgentAwarenessRelation;
  readonly endpoint: CrossRunEndpoint;
}

/**
 * Host-owned, already permission-filtered input.  This type deliberately has
 * no transcript, token, process, socket, or tool fields: projection is not a
 * second registry and cannot be used to smuggle model-provided identity in.
 */
export interface AgentAwarenessRecord {
  readonly endpoint: CrossRunEndpoint;
  readonly role?: AgentAwarenessRole | string;
  readonly laneKind?: LaneKind | string;
  readonly state?: AgentAwarenessState | string;
  readonly status?: string;
  readonly laneStatus?: LaneStatus | string;
  readonly lifecycle?: string;
  readonly active?: boolean;
  readonly activitySummary?: string;
  readonly generation?: number;
  /** Alias used by daemon/worker observers when the source calls it this. */
  readonly sourceGeneration?: number;
  readonly generationTrusted?: boolean;
  readonly sourceValid?: boolean;
  /** Optional host-side admission marks; denied records never enter output. */
  readonly authorized?: boolean;
  readonly visible?: boolean;
  readonly lastSeen?: string;
  /** A retained daemon registration with no current activation. */
  readonly retained?: boolean;
  readonly daemonReserved?: boolean;
  readonly relationships?: readonly AgentAwarenessRelationshipInput[];
  /** Convenience lineage fields; they are converted to explicit edges. */
  readonly parent?: CrossRunEndpoint;
  readonly children?: readonly CrossRunEndpoint[];
  readonly hostedBy?: CrossRunEndpoint;
  readonly observerOf?: CrossRunEndpoint;
  readonly peerOf?: readonly CrossRunEndpoint[];
  readonly forkOf?: CrossRunEndpoint;
  readonly branchOf?: CrossRunEndpoint;
}

export interface AgentAwarenessEdgeInput {
  readonly source: CrossRunEndpoint;
  readonly target: CrossRunEndpoint;
  readonly relation: AgentAwarenessRelation;
  readonly authorized?: boolean;
  readonly visible?: boolean;
}

/** The complete input for one point-in-time projection. */
export interface AgentTopologyProjectionInput {
  /** `records` is canonical; `agents`/`nodes` are read-only adapter aliases. */
  readonly records?: readonly AgentAwarenessRecord[];
  readonly agents?: readonly AgentAwarenessRecord[];
  readonly nodes?: readonly AgentAwarenessRecord[];
  readonly edges?: readonly AgentAwarenessEdgeInput[];
  readonly generatedAt?: string;
  /** `now` is used only for freshness; it does not become a new fact source. */
  readonly now?: string;
  readonly freshnessMs?: number;
  readonly maxNodes?: number;
  readonly maxEdges?: number;
}

export interface AgentAwarenessProjectionOptions {
  readonly freshnessMs?: number;
  readonly maxNodes?: number;
  readonly maxEdges?: number;
}

const RELATION_ORDER: readonly AgentAwarenessRelation[] = [
  "parent",
  "child",
  "hosted-by",
  "observer",
  "peer",
  "fork-of",
  "branch-of",
];
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\/)/u;
const SENSITIVE_ID = /\b(?:token|secret|password|passwd|api[-_ ]?key|authorization|cookie|bearer|pid|process\s+id)\b\s*[:=]/iu;
const STATE_VALUES = new Set<AgentAwarenessState>([
  "starting",
  "active",
  "waiting",
  "idle",
  "sleeping",
  "offline",
  "terminal",
]);

interface NormalizedRecord {
  readonly endpoint: CrossRunEndpoint;
  readonly key: string;
  readonly role: AgentAwarenessRole;
  readonly state: AgentAwarenessState;
  readonly activitySummary?: string;
  readonly generation?: number;
  readonly lastSeen: string;
  readonly lastSeenMs: number;
  readonly lastSeenPresent: boolean;
  readonly generationTrusted: boolean;
  readonly sourceValid: boolean;
  readonly retained: boolean;
  readonly canonical: string;
  readonly relations: readonly AgentTopologyEdge[];
}

interface ProjectionClock {
  readonly generatedAt: string;
  readonly nowMs: number;
  readonly freshnessMs: number;
}

/**
 * Project trusted host records into a bounded immutable topology snapshot.
 * There is intentionally no I/O here, which keeps the projection replayable
 * and lets a daemon, local CLI, or remote TUI share exactly the same result.
 */
export function projectAgentTopology(
  input: AgentTopologyProjectionInput,
  options: AgentAwarenessProjectionOptions = {},
): AgentTopologySnapshot {
  assertInput(input);
  const clock = normalizeClock(input, options);
  const limits = normalizeLimits(input, options);
  const records = selectRecords(input);
  const winners = new Map<string, NormalizedRecord>();

  for (const record of records) {
    const normalized = normalizeRecord(record, clock);
    const previous = winners.get(normalized.key);
    if (previous === undefined || compareRecordVersion(normalized, previous) > 0) {
      winners.set(normalized.key, normalized);
    }
  }

  const orderedRecords = [...winners.values()].sort(compareRecords);
  const retainedRecords = orderedRecords.slice(0, limits.maxNodes);
  const retainedKeys = new Set(retainedRecords.map((record) => record.key));
  const nodes = retainedRecords.map(toNode);

  const explicitEdges = collectEdges(input, retainedRecords);
  const edges = explicitEdges
    .filter((edge) => retainedKeys.has(edge.source) && retainedKeys.has(edge.target))
    .sort(compareEdges);
  const boundedEdges = edges.slice(0, limits.maxEdges);
  const roots = projectRoots(nodes, boundedEdges);
  const truncated = orderedRecords.length > limits.maxNodes
    || edges.length > limits.maxEdges;

  return freezeSnapshot({
    version: AGENT_AWARENESS_SNAPSHOT_VERSION,
    generatedAt: clock.generatedAt,
    nodes,
    edges: boundedEdges,
    roots,
    truncated,
  });
}

/** A small synchronous seam for daemon/host adapters and future Remote TUI. */
export interface AgentAwarenessQuery {
  snapshot(): AgentTopologySnapshot;
  topology(): AgentTopologySnapshot;
  listAgents(): readonly AgentTopologyNode[];
}

export type AgentAwarenessInputSource =
  | AgentTopologyProjectionInput
  | (() => AgentTopologyProjectionInput)
  | { readonly read: () => AgentTopologyProjectionInput };

/**
 * Create a read-only query without retaining state. A callback lets a host
 * provide its latest already-cropped view; no registry is created here.
 */
export function createAgentAwarenessQuery(
  source: AgentAwarenessInputSource,
  options: AgentAwarenessProjectionOptions = {},
): AgentAwarenessQuery {
  if (source === null || typeof source !== "object" && typeof source !== "function") {
    throw new TypeError("awareness source must be an input or read callback");
  }
  const read = (): AgentTopologyProjectionInput => {
    if (typeof source === "function") return source();
    if ("read" in source && typeof source.read === "function") return source.read();
    return source as AgentTopologyProjectionInput;
  };
  const snapshot = (): AgentTopologySnapshot => projectAgentTopology(read(), options);
  return Object.freeze({
    snapshot,
    topology: snapshot,
    listAgents: () => snapshot().nodes,
  });
}

/** Convenience query for callers that already have one input snapshot. */
export function listAgents(
  input: AgentTopologyProjectionInput,
  options: AgentAwarenessProjectionOptions = {},
): readonly AgentTopologyNode[] {
  return projectAgentTopology(input, options).nodes;
}

/** Remove control data, secrets, paths, tool arguments, and unbounded text. */
export function sanitizeAgentActivitySummary(value: string): string | undefined {
  if (typeof value !== "string") return undefined;
  let text = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  if (text.length === 0) return undefined;
  if (/(?:<analysis>|<thinking>|chain\s+of\s+thought|internal\s+reasoning)/iu.test(text)) {
    return "[activity omitted]";
  }
  text = text
    .replace(/\b(?:token|secret|password|passwd|api[-_ ]?key|authorization|cookie|bearer)\b\s*[:=]\s*[^\s,;]+/giu, "[redacted]")
    .replace(/\b(?:pid|process\s+id)\b\s*[:=]\s*\d+/giu, "[redacted]")
    .replace(/(?:^|\s)(?:\/(?:Users|private|tmp|var|home|root|etc|opt)\/[^\s]+|[A-Za-z]:\\[^\s]+)/gu, " [path]")
    .replace(/\b(?:read_file|write_file|edit|apply_patch|bash|shell|exec|run_command)\s*(?:\([^)]*\)|\{[^}]*\})/giu, "[tool]")
    .replace(/\s+/gu, " ")
    .trim();
  if (text.length === 0) return undefined;
  return [...text].slice(0, MAX_AGENT_AWARENESS_ACTIVITY_CHARS).join("");
}

function assertInput(input: AgentTopologyProjectionInput): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("awareness projection input must be an object");
  }
}

function selectRecords(input: AgentTopologyProjectionInput): readonly AgentAwarenessRecord[] {
  const values = [input.records, input.agents, input.nodes].filter(
    (value): value is readonly AgentAwarenessRecord[] => value !== undefined,
  );
  if (values.length === 0) return [];
  if (values.some((value) => !Array.isArray(value))) {
    throw new TypeError("awareness records must be arrays");
  }
  // Adapter aliases are merged. Duplicate endpoint keys are resolved by generation.
  return values.flat().filter((record) => {
    if (record === null || typeof record !== "object" || Array.isArray(record)) return true;
    return record.authorized !== false && record.visible !== false;
  });
}

function normalizeClock(
  input: AgentTopologyProjectionInput,
  options: AgentAwarenessProjectionOptions,
): ProjectionClock {
  const generatedAt = canonicalTimestamp(input.generatedAt ?? input.now ?? "1970-01-01T00:00:00.000Z", "generatedAt");
  const now = canonicalTimestamp(input.now ?? generatedAt, "now");
  const freshnessMs = normalizeBound(
    options.freshnessMs ?? input.freshnessMs ?? DEFAULT_AGENT_AWARENESS_FRESHNESS_MS,
    "freshnessMs",
    1,
    24 * 60 * 60 * 1_000,
  );
  return { generatedAt, nowMs: Date.parse(now), freshnessMs };
}

function normalizeLimits(
  input: AgentTopologyProjectionInput,
  options: AgentAwarenessProjectionOptions,
): { readonly maxNodes: number; readonly maxEdges: number } {
  return {
    maxNodes: normalizeBound(
      options.maxNodes ?? input.maxNodes ?? DEFAULT_AGENT_AWARENESS_MAX_NODES,
      "maxNodes",
      0,
      MAX_AGENT_AWARENESS_NODES,
    ),
    maxEdges: normalizeBound(
      options.maxEdges ?? input.maxEdges ?? DEFAULT_AGENT_AWARENESS_MAX_EDGES,
      "maxEdges",
      0,
      MAX_AGENT_AWARENESS_EDGES,
    ),
  };
}

function normalizeBound(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function normalizeRecord(record: AgentAwarenessRecord, clock: ProjectionClock): NormalizedRecord {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("awareness record must be an object");
  }
  const endpoint = normalizeAwarenessEndpoint(record.endpoint, "record.endpoint");
  const key = endpointKey(endpoint);
  const generation = normalizeGeneration(record.generation ?? record.sourceGeneration);
  const lastSeenPresent = record.lastSeen !== undefined;
  const lastSeen = canonicalTimestamp(record.lastSeen ?? clock.generatedAt, "record.lastSeen");
  const lastSeenMs = Date.parse(lastSeen);
  const generationTrusted = record.generationTrusted !== false;
  const sourceValid = record.sourceValid !== false;
  const retained = record.retained === true || record.daemonReserved === true;
  const sourceState = mapState(record.state ?? record.status ?? record.laneStatus ?? record.lifecycle, record.active);
  const state = applyFreshness(
    sourceState,
    lastSeenMs,
    clock,
    generationTrusted,
    sourceValid,
    retained,
    lastSeenPresent,
  );
  const activitySummary = sanitizeAgentActivitySummary(record.activitySummary ?? "");
  const relations = collectRecordRelations(record, key);
  const canonical = JSON.stringify({
    key,
    role: mapRole(record.role, record.laneKind, endpoint.laneId),
    state,
    activitySummary: activitySummary ?? "",
    generation: generation ?? null,
    lastSeen,
    generationTrusted,
    sourceValid,
    retained,
    relations,
  });
  return {
    endpoint: Object.freeze({ ...endpoint }),
    key,
    role: mapRole(record.role, record.laneKind, endpoint.laneId),
    state,
    ...(activitySummary === undefined ? {} : { activitySummary }),
    ...(generation === undefined ? {} : { generation }),
    lastSeen,
    lastSeenMs,
    lastSeenPresent,
    generationTrusted,
    sourceValid,
    retained,
    canonical,
    relations,
  };
}

function normalizeGeneration(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("record generation must be a non-negative integer");
  return value;
}

function canonicalTimestamp(value: string, path: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new TypeError(`${path} must be a timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${path} must be a valid timestamp`);
  return new Date(parsed).toISOString();
}

function normalizeAwarenessEndpoint(value: unknown, path: string): CrossRunEndpoint {
  const endpoint = normalizeEndpoint(value, path);
  for (const [field, segment] of Object.entries(endpoint)) {
    if (ABSOLUTE_PATH.test(segment) || SENSITIVE_ID.test(segment)) {
      throw new TypeError(`${path}.${field} must be a public endpoint label`);
    }
  }
  return endpoint;
}

function mapRole(role: string | undefined, laneKind: string | undefined, laneId: string): AgentAwarenessRole {
  const laneValue = laneId.toLowerCase();
  const candidates = [role, laneKind, laneId]
    .filter((value): value is string => value !== undefined)
    .map((value) => value.toLowerCase());
  if (laneValue === "teto" || candidates.includes("teto")) {
    return "teto";
  }
  const value = (role ?? laneKind ?? laneId).toLowerCase();
  if (value === "main") return "main";
  if (value === "worker") return "worker";
  if (value === "reflection") return "reflection";
  if (value === "auxiliary" || value === "explorer" || value === "critic") return "auxiliary";
  if (value === "unknown" || value.length === 0) return "unknown";
  return "auxiliary";
}

function mapState(value: string | undefined, active: boolean | undefined): AgentAwarenessState {
  const normalized = value?.toLowerCase();
  if (normalized !== undefined && STATE_VALUES.has(normalized as AgentAwarenessState)) {
    return normalized as AgentAwarenessState;
  }
  switch (normalized) {
    case "busy":
    case "running":
      return "active";
    case "ready":
    case "dormant":
    case "idle":
      return "idle";
    case "draining":
    case "waiting":
    case "held":
      return "waiting";
    case "queued":
    case "accepted":
    case "admitted":
      return "starting";
    case "stopped":
    case "failed":
    case "inactive":
    case "disconnected":
      return "offline";
    case "completed":
    case "cancelled":
      return "terminal";
    case "starting":
      return "starting";
    default:
      return active === true ? "active" : "idle";
  }
}

function applyFreshness(
  sourceState: AgentAwarenessState,
  lastSeenMs: number,
  clock: ProjectionClock,
  generationTrusted: boolean,
  sourceValid: boolean,
  retained: boolean,
  lastSeenPresent: boolean,
): AgentAwarenessState {
  if (sourceState === "terminal") return "terminal";
  if (sourceState === "offline") return "offline";
  if (sourceState === "sleeping") return "sleeping";
  const stale = !lastSeenPresent
    || !Number.isFinite(lastSeenMs)
    || lastSeenMs > clock.nowMs
    || clock.nowMs - lastSeenMs > clock.freshnessMs;
  if (!generationTrusted || !sourceValid || stale) return retained ? "sleeping" : "offline";
  return sourceState;
}

function compareRecordVersion(left: NormalizedRecord, right: NormalizedRecord): number {
  const leftGeneration = left.generation ?? -1;
  const rightGeneration = right.generation ?? -1;
  if (leftGeneration !== rightGeneration) return leftGeneration - rightGeneration;
  const leftTrust = left.generationTrusted && left.sourceValid ? 1 : 0;
  const rightTrust = right.generationTrusted && right.sourceValid ? 1 : 0;
  if (leftTrust !== rightTrust) return leftTrust - rightTrust;
  if (left.lastSeenMs !== right.lastSeenMs) return left.lastSeenMs - right.lastSeenMs;
  return left.canonical < right.canonical ? -1 : left.canonical > right.canonical ? 1 : 0;
}

function compareRecords(left: NormalizedRecord, right: NormalizedRecord): number {
  return compareText(left.endpoint.workspaceId, right.endpoint.workspaceId)
    || compareText(left.endpoint.sessionId, right.endpoint.sessionId)
    || compareText(left.endpoint.runId, right.endpoint.runId)
    || compareText(left.endpoint.laneId, right.endpoint.laneId)
    || compareText(left.key, right.key);
}

function collectRecordRelations(record: AgentAwarenessRecord, source: string): readonly AgentTopologyEdge[] {
  const edges: AgentTopologyEdge[] = [];
  const add = (target: CrossRunEndpoint, relation: AgentAwarenessRelation): void => {
    const normalized = normalizeAwarenessEndpoint(target, "record.relationship.endpoint");
    const targetKey = endpointKey(normalized);
    if (targetKey !== source) edges.push({ source, target: targetKey, relation });
  };
  for (const relationship of record.relationships ?? []) {
    if (relationship === null || typeof relationship !== "object") throw new TypeError("record relationship must be an object");
    add(relationship.endpoint, relationship.relation);
  }
  if (record.parent !== undefined) add(record.parent, "child");
  for (const child of record.children ?? []) add(child, "parent");
  if (record.hostedBy !== undefined) add(record.hostedBy, "hosted-by");
  if (record.observerOf !== undefined) add(record.observerOf, "observer");
  for (const peer of record.peerOf ?? []) add(peer, "peer");
  if (record.forkOf !== undefined) add(record.forkOf, "fork-of");
  if (record.branchOf !== undefined) add(record.branchOf, "branch-of");
  return [...uniqueEdges(edges)].sort(compareEdges);
}

function collectEdges(
  input: AgentTopologyProjectionInput,
  records: readonly NormalizedRecord[],
): readonly AgentTopologyEdge[] {
  const edges: AgentTopologyEdge[] = [];
  for (const record of records) edges.push(...record.relations);
  for (const edge of input.edges ?? []) {
    if (edge === null || typeof edge !== "object") throw new TypeError("awareness edge must be an object");
    if (edge.authorized === false || edge.visible === false) continue;
    const source = endpointKey(normalizeAwarenessEndpoint(edge.source, "edge.source"));
    const target = endpointKey(normalizeAwarenessEndpoint(edge.target, "edge.target"));
    if (source !== target) edges.push({ source, target, relation: edge.relation });
  }
  return [...uniqueEdges(edges)].sort(compareEdges);
}

function uniqueEdges(edges: readonly AgentTopologyEdge[]): readonly AgentTopologyEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    if (!RELATION_ORDER.includes(edge.relation)) throw new TypeError(`unsupported awareness relation: ${edge.relation}`);
    const identity = `${edge.source}\0${edge.target}\0${edge.relation}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function compareEdges(left: AgentTopologyEdge, right: AgentTopologyEdge): number {
  return RELATION_ORDER.indexOf(left.relation) - RELATION_ORDER.indexOf(right.relation)
    || compareText(left.source, right.source)
    || compareText(left.target, right.target)
    || 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toNode(record: NormalizedRecord): AgentTopologyNode {
  return Object.freeze({
    key: record.key,
    endpoint: record.endpoint,
    role: record.role,
    state: record.state,
    ...(record.activitySummary === undefined ? {} : { activitySummary: record.activitySummary }),
    ...(record.generation === undefined ? {} : { generation: record.generation }),
    lastSeen: record.lastSeen,
  });
}

function projectRoots(nodes: readonly AgentTopologyNode[], edges: readonly AgentTopologyEdge[]): readonly string[] {
  const keys = new Set(nodes.map((node) => node.key));
  const parentOf = new Map<string, string>();
  for (const edge of edges) {
    let parent: string | undefined;
    let child: string | undefined;
    if (edge.relation === "parent") {
      parent = edge.source;
      child = edge.target;
    } else if (edge.relation === "child" || edge.relation === "hosted-by") {
      parent = edge.target;
      child = edge.source;
    }
    if (parent === undefined || child === undefined || !keys.has(parent) || !keys.has(child)) continue;
    const previous = parentOf.get(child);
    if (previous === undefined || parent < previous) parentOf.set(child, parent);
  }
  const roots = new Set<string>(nodes.filter((node) => !parentOf.has(node.key)).map((node) => node.key));
  for (const node of nodes) {
    if (roots.has(node.key)) continue;
    const seen = new Set<string>();
    let current = node.key;
    while (parentOf.has(current) && !seen.has(current)) {
      seen.add(current);
      current = parentOf.get(current)!;
    }
    if (seen.has(current)) roots.add([...seen].sort()[0]!);
  }
  return [...roots].sort(compareText);
}

function freezeSnapshot(snapshot: AgentTopologySnapshot): AgentTopologySnapshot {
  const nodes = Object.freeze(snapshot.nodes.map((node) => Object.freeze({
    ...node,
    endpoint: Object.freeze({ ...node.endpoint }),
  })));
  const edges = Object.freeze(snapshot.edges.map((edge) => Object.freeze({ ...edge })));
  snapshot = { ...snapshot, nodes, edges };
  Object.freeze(snapshot.roots);
  return Object.freeze(snapshot);
}

export type { CrossRunEndpoint } from "../domain/types.js";
