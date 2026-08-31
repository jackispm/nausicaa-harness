import type { CrossRunRoster, CrossRunRosterEntry } from "../a2a/cross-run-contract.js";
import { endpointKey, normalizeEndpoint } from "../a2a/cross-run-contract.js";
import type { CrossRunEndpoint } from "../domain/types.js";
import type { RunProjection } from "../ledger/projection.js";
import type {
  AgentAwarenessEdgeInput,
  AgentAwarenessRecord,
  AgentAwarenessRelation,
  AgentTopologyProjectionInput,
} from "./agent-awareness.js";
import { sanitizeAgentActivitySummary } from "./agent-awareness.js";
import type { DaemonHostSnapshot, DaemonRunSnapshot } from "./daemon-host.js";
import type { DaemonWorkerDescriptor } from "./daemon-worker-protocol.js";
import type {
  SessionControllerStatus,
  SessionSnapshot,
} from "./session-controller.js";

/** A trusted identity scope supplied by the host, never inferred from paths. */
export interface AgentAwarenessIdentityScope {
  readonly workspaceId: string;
  readonly sessionId: string;
}

/** A projected Run and its optional local Session surface. */
export interface AgentAwarenessRunSource {
  readonly projection: RunProjection;
  readonly session?: SessionSnapshot;
  /** Overrides the composition-wide scope for this Run. */
  readonly scope?: Partial<AgentAwarenessIdentityScope>;
  /** Source generation from a cursor/observer, when one exists. */
  readonly generation?: number;
  readonly generationTrusted?: boolean;
  readonly sourceValid?: boolean;
  /** Host-provided, already-safe text; it is sanitized again at this boundary. */
  readonly activitySummary?: string;
  /** Freshness timestamp from the same observation used for this source. */
  readonly lastSeen?: string;
}

/** A worker descriptor plus the identity scope of the Run it serves. */
export interface AgentAwarenessWorkerSource {
  readonly descriptor: DaemonWorkerDescriptor;
  readonly scope?: Partial<AgentAwarenessIdentityScope>;
  /** Use this only when a Run has more than one separately visible worker. */
  readonly laneId?: string;
  readonly state?: string;
  readonly active?: boolean;
  readonly generationTrusted?: boolean;
  readonly sourceValid?: boolean;
  readonly retained?: boolean;
  readonly activitySummary?: string;
  readonly lastSeen?: string;
}

/** Optional trusted lineage supplied by a host or branch manager. */
export type AgentAwarenessLineageSource = AgentAwarenessEdgeInput;

export interface AgentAwarenessCompositionOptions {
  /** Required for every local source; filesystem paths are deliberately not accepted as IDs. */
  readonly workspaceId?: string;
  /** Default for Runs/workers without a per-source override. */
  readonly sessionId?: string;
  /** Per-Run scopes are needed when one query spans multiple Sessions. */
  readonly runScopes?: Readonly<Record<string, AgentAwarenessIdentityScope>>;
  readonly runs?: readonly AgentAwarenessRunSource[];
  readonly host?: DaemonHostSnapshot;
  readonly workers?: readonly AgentAwarenessWorkerSource[];
  /** Already authorized, bounded A2A roster from the host. */
  readonly roster?: CrossRunRoster;
  readonly lineage?: readonly AgentAwarenessLineageSource[];
  readonly now?: string;
  readonly generatedAt?: string;
  readonly freshnessMs?: number;
  readonly maxNodes?: number;
  readonly maxEdges?: number;
}

interface Candidate {
  readonly record: AgentAwarenessRecord;
  readonly priority: number;
}

interface Scope {
  readonly workspaceId: string;
  readonly sessionId: string;
}

const EPOCH = "1970-01-01T00:00:00.000Z";
const DEFAULT_WORKER_LANE = "worker";
const RECORD_PRIORITY = {
  roster: 10,
  worker: 60,
  run: 40,
  lane: 50,
  host: 70,
} as const;

/**
 * Compose host-authorized Awareness input from existing projections.
 *
 * This function is intentionally stateless: it reads no Ledger or filesystem,
 * creates no registry, and does not turn host/A2A observations into durable
 * facts. The returned input can be passed directly to `projectAgentTopology`.
 */
export function composeAgentAwarenessProjectionInput(
  options: AgentAwarenessCompositionOptions,
): AgentTopologyProjectionInput {
  assertOptions(options);
  const generatedAt = options.generatedAt ?? options.now ?? EPOCH;
  const now = options.now ?? generatedAt;
  const records = new Map<string, Candidate>();
  const edges = new Map<string, AgentAwarenessEdgeInput>();
  const runScopes = new Map<string, Scope>();

  for (const source of options.runs ?? []) {
    const runId = source.projection.run.runId;
    const scope = resolveScope(runId, source.scope, options, runScopes);
    runScopes.set(runId, scope);
    addRunSource(source, scope, generatedAt, records, edges);
  }

  for (const source of options.workers ?? []) {
    const runId = source.descriptor.runId;
    const scope = resolveScope(runId, source.scope, options, runScopes);
    runScopes.set(runId, scope);
    addWorkerSource(source, scope, generatedAt, records, edges);
  }

  if (options.host !== undefined) {
    for (const run of sortedHostRuns(options.host.runs)) {
      const scope = resolveScope(run.runId, undefined, options, runScopes);
      runScopes.set(run.runId, scope);
      addHostRun(run, scope, generatedAt, records);
    }
  }

  if (options.roster !== undefined) {
    addRoster(options.roster, generatedAt, records, edges);
  }
  for (const lineage of options.lineage ?? []) {
    if (lineage.authorized === false || lineage.visible === false) continue;
    addEdge(lineage, edges);
  }

  const input: AgentTopologyProjectionInput = {
    generatedAt,
    now,
    records: Object.freeze([...records.values()]
      .sort((left, right) => compareText(endpointKey(left.record.endpoint), endpointKey(right.record.endpoint)))
      .map((candidate) => candidate.record)),
    edges: Object.freeze([...edges.values()].sort(compareEdges)),
    ...(options.freshnessMs === undefined ? {} : { freshnessMs: options.freshnessMs }),
    ...(options.maxNodes === undefined ? {} : { maxNodes: options.maxNodes }),
    ...(options.maxEdges === undefined ? {} : { maxEdges: options.maxEdges }),
  };
  return Object.freeze(input);
}

function addRunSource(
  source: AgentAwarenessRunSource,
  scope: Scope,
  generatedAt: string,
  records: Map<string, Candidate>,
  edges: Map<string, AgentAwarenessEdgeInput>,
): void {
  const projection = source.projection;
  const runId = projection.run.runId;
  if (source.session?.runId !== undefined && source.session.runId !== runId) {
    throw new TypeError(`session runId does not match projected Run ${runId}`);
  }
  const main = endpoint(scope, runId, "main");
  const mainLane = projection.lanes.main;
  const mainState = stateForMain(projection, source.session?.status, mainLane?.status);
  addRecord(records, {
    endpoint: main,
    role: "main",
    state: mainState,
    ...summaryField(source.activitySummary ?? activityForState(mainState, "main")),
    ...(source.generation === undefined ? {} : { generation: source.generation }),
    ...(source.generationTrusted === undefined ? {} : { generationTrusted: source.generationTrusted }),
    ...(source.sourceValid === undefined ? {} : { sourceValid: source.sourceValid }),
    authorized: true,
    visible: true,
    lastSeen: source.lastSeen ?? generatedAt,
  }, RECORD_PRIORITY.run);

  const laneIds = Object.keys(projection.lanes).sort(compareText);
  for (const laneId of laneIds) {
    const lane = projection.lanes[laneId];
    if (lane === undefined || laneId === "main") continue;
    const laneEndpoint = endpoint(scope, runId, laneId);
    const state = stateForLane(lane.status);
    const role = laneId === "teto" || lane.kind === "intent-navigator"
      ? "teto"
      : laneId === "worker" || lane.kind === "worker"
        ? "worker"
      : lane.kind === "reflection"
          ? "reflection"
          : "auxiliary";
    addRecord(records, {
      endpoint: laneEndpoint,
      role,
      ...(lane.kind === undefined ? {} : { laneKind: lane.kind }),
      state,
      ...summaryField(activityForState(state, role)),
      ...(source.generation === undefined ? {} : { generation: source.generation }),
      ...(source.generationTrusted === undefined ? {} : { generationTrusted: source.generationTrusted }),
      ...(source.sourceValid === undefined ? {} : { sourceValid: source.sourceValid }),
      authorized: true,
      visible: true,
      lastSeen: source.lastSeen ?? generatedAt,
    }, RECORD_PRIORITY.lane);
    addEdge({
      source: main,
      target: laneEndpoint,
      relation: "parent",
      authorized: true,
      visible: true,
    }, edges);
    if (role === "teto") {
      addEdge({
        source: laneEndpoint,
        target: main,
        relation: "observer",
        authorized: true,
        visible: true,
      }, edges);
    }
  }
}

function addHostRun(
  run: DaemonRunSnapshot,
  scope: Scope,
  generatedAt: string,
  records: Map<string, Candidate>,
): void {
  const state = stateForHostRun(run.state);
  addRecord(records, {
    endpoint: endpoint(scope, run.runId, "main"),
    role: "main",
    state,
    ...(state === "sleeping" ? { retained: true } : {}),
    authorized: true,
    visible: true,
    ...(run.fencingToken === undefined ? {} : { generation: run.fencingToken }),
    lastSeen: generatedAt,
    activitySummary: activityForHostRun(run),
  }, RECORD_PRIORITY.host);
}

function addWorkerSource(
  source: AgentAwarenessWorkerSource,
  scope: Scope,
  generatedAt: string,
  records: Map<string, Candidate>,
  edges: Map<string, AgentAwarenessEdgeInput>,
): void {
  const descriptor = source.descriptor;
  const laneId = source.laneId ?? DEFAULT_WORKER_LANE;
  const worker = endpoint(scope, descriptor.runId, laneId);
  const state = source.state
    ?? (source.active === true ? "active" : source.active === false ? "idle" : undefined);
  addRecord(records, {
    endpoint: worker,
    role: "worker",
    ...(state === undefined ? {} : { state, ...summaryField(activityForState(state, "worker")) }),
    ...(source.activitySummary === undefined ? {} : summaryField(source.activitySummary)),
    generation: descriptor.fencingToken,
    ...(source.generationTrusted === undefined ? {} : { generationTrusted: source.generationTrusted }),
    ...(source.sourceValid === undefined ? {} : { sourceValid: source.sourceValid }),
    ...(source.retained === undefined ? {} : { retained: source.retained }),
    authorized: true,
    visible: true,
    lastSeen: source.lastSeen ?? descriptor.publishedAt ?? generatedAt,
  }, RECORD_PRIORITY.worker);
  addEdge({
    source: endpoint(scope, descriptor.runId, "main"),
    target: worker,
    relation: "parent",
    authorized: true,
    visible: true,
  }, edges);
}

function addRoster(
  roster: CrossRunRoster,
  generatedAt: string,
  records: Map<string, Candidate>,
  edges: Map<string, AgentAwarenessEdgeInput>,
): void {
  const current = normalizeEndpoint(roster.current, "roster.current");
  addRecord(records, {
    endpoint: current,
    role: roleForLane(current.laneId),
    state: "active",
    activitySummary: activityForState("active", roleForLane(current.laneId)),
    authorized: true,
    visible: true,
    lastSeen: generatedAt,
  }, RECORD_PRIORITY.roster);
  const entries = [...roster.entries].sort((left, right) => (
    compareText(endpointKey(left.endpoint), endpointKey(right.endpoint))
      || compareText(left.relationship, right.relationship)
  ));
  for (const entry of entries) {
    const target = normalizeEndpoint(entry.endpoint, "roster.entries[].endpoint");
    const state = stateForRosterEntry(entry);
    const role = roleForLane(target.laneId);
    addRecord(records, {
      endpoint: target,
      role,
      state,
      activitySummary: activityForState(state, role),
      authorized: true,
      visible: true,
      lastSeen: generatedAt,
    }, RECORD_PRIORITY.roster);
    addEdge({
      source: current,
      target,
      relation: rosterRelation(entry),
      authorized: true,
      visible: true,
    }, edges);
  }
}

function addRecord(
  records: Map<string, Candidate>,
  record: AgentAwarenessRecord,
  priority: number,
): void {
  const endpointValue = normalizeEndpoint(record.endpoint, "awareness.record.endpoint");
  const normalized: AgentAwarenessRecord = {
    ...record,
    endpoint: endpointValue,
    ...(record.activitySummary === undefined
      ? {}
      : summaryField(record.activitySummary)),
  };
  const key = endpointKey(endpointValue);
  const current = records.get(key);
  if (current === undefined) {
    records.set(key, { record: normalized, priority });
    return;
  }
  const winner = candidateWins(
    { record: normalized, priority },
    current,
  ) ? normalized : current.record;
  const loser = winner === normalized ? current.record : normalized;
  records.set(key, {
    priority: Math.max(priority, current.priority),
    record: {
      ...loser,
      ...winner,
      endpoint: endpointValue,
      ...(winner.activitySummary === undefined && loser.activitySummary !== undefined
        ? { activitySummary: loser.activitySummary }
        : {}),
      ...(winner.generation === undefined && loser.generation !== undefined
        ? { generation: loser.generation }
        : {}),
      ...(winner.generationTrusted === undefined && loser.generationTrusted !== undefined
        ? { generationTrusted: loser.generationTrusted }
        : {}),
      ...(winner.sourceValid === undefined && loser.sourceValid !== undefined
        ? { sourceValid: loser.sourceValid }
        : {}),
    },
  });
}

function candidateWins(left: Candidate, right: Candidate): boolean {
  const leftGeneration = left.record.generation;
  const rightGeneration = right.record.generation;
  // A trusted newer generation must not be replaced by a more authoritative
  // but older source (for example, a delayed Host snapshot). When only one
  // source carries a generation, retain that fencing evidence.
  if (leftGeneration !== undefined || rightGeneration !== undefined) {
    if (leftGeneration === undefined) return false;
    if (rightGeneration === undefined) return true;
    if (leftGeneration !== rightGeneration) return leftGeneration > rightGeneration;
  }
  if (left.priority !== right.priority) return left.priority > right.priority;
  return stableRecord(left.record) > stableRecord(right.record);
}

function addEdge(
  edge: AgentAwarenessEdgeInput,
  edges: Map<string, AgentAwarenessEdgeInput>,
): void {
  const source = normalizeEndpoint(edge.source, "awareness.edge.source");
  const target = normalizeEndpoint(edge.target, "awareness.edge.target");
  if (endpointKey(source) === endpointKey(target)) return;
  const normalized: AgentAwarenessEdgeInput = {
    ...edge,
    source,
    target,
    authorized: edge.authorized !== false,
    visible: edge.visible !== false,
  };
  const key = `${endpointKey(source)}\0${endpointKey(target)}\0${edge.relation}`;
  edges.set(key, normalized);
}

function resolveScope(
  runId: string,
  override: Partial<AgentAwarenessIdentityScope> | undefined,
  options: AgentAwarenessCompositionOptions,
  known: ReadonlyMap<string, Scope>,
): Scope {
  const mapped = options.runScopes?.[runId];
  const prior = known.get(runId);
  const workspaceId = override?.workspaceId ?? mapped?.workspaceId ?? prior?.workspaceId ?? options.workspaceId;
  const sessionId = override?.sessionId ?? mapped?.sessionId ?? prior?.sessionId ?? options.sessionId;
  if (typeof workspaceId !== "string" || workspaceId.trim().length === 0 || workspaceId.includes("\0")) {
    throw new TypeError(`workspaceId is required for Run ${runId}`);
  }
  if (typeof sessionId !== "string" || sessionId.trim().length === 0 || sessionId.includes("\0")) {
    throw new TypeError(`sessionId is required for Run ${runId}`);
  }
  return { workspaceId, sessionId };
}

function endpoint(scope: Scope, runId: string, laneId: string): CrossRunEndpoint {
  return {
    workspaceId: scope.workspaceId,
    sessionId: scope.sessionId,
    runId,
    laneId,
  };
}

function stateForMain(
  projection: RunProjection,
  sessionStatus: SessionControllerStatus | undefined,
  laneStatus: string | undefined,
): string {
  if (projection.run.status === "completed" || projection.run.status === "failed") return "terminal";
  if (sessionStatus === "closed" || sessionStatus === "detached") return "offline";
  if (sessionStatus === "cancelling") return "waiting";
  if (laneStatus !== undefined) return stateForLane(laneStatus);
  if (projection.run.status === "running" || sessionStatus === "running") return "active";
  return projection.run.status === "not-started" ? "starting" : "idle";
}

function stateForLane(status: string): string {
  switch (status) {
    case "running": return "active";
    case "waiting": return "waiting";
    case "completed":
    case "failed":
    case "cancelled": return "terminal";
    case "ready":
    case "dormant":
    default: return "idle";
  }
}

function stateForHostRun(state: DaemonRunSnapshot["state"]): string {
  switch (state) {
    case "running": return "active";
    case "queued": return "starting";
    case "held": return "sleeping";
    case "failed": return "terminal";
  }
}

function stateForRosterEntry(entry: CrossRunRosterEntry): string {
  if (!entry.reachable || entry.status === "inactive") return "offline";
  return entry.status === "busy" ? "active" : "idle";
}

function rosterRelation(entry: CrossRunRosterEntry): AgentAwarenessRelation {
  switch (entry.relationship) {
    case "parent": return "child";
    case "child": return "parent";
    case "sibling": return "peer";
    case "direct": return "peer";
  }
}

function roleForLane(laneId: string): string {
  switch (laneId.toLowerCase()) {
    case "main": return "main";
    case "teto": return "teto";
    case "worker": return "worker";
    case "reflection": return "reflection";
    default: return "auxiliary";
  }
}

function activityForState(state: string, role: string): string {
  switch (state) {
    case "active": return `${role} working`;
    case "starting": return `${role} starting`;
    case "waiting": return `${role} waiting for input`;
    case "sleeping": return `${role} sleeping until wake`;
    case "offline": return `${role} offline`;
    case "terminal": return `${role} finished`;
    case "idle":
    default: return `${role} idle`;
  }
}

function activityForHostRun(run: DaemonRunSnapshot): string {
  if (run.state === "queued") return "main queued for wake";
  if (run.state === "held") return "main held by daemon";
  if (run.state === "failed") return "main daemon run failed";
  if (run.pendingWakeCount > 0) return "main working with queued wake";
  return "main working";
}

function safeSummary(value: string): string | undefined {
  return sanitizeAgentActivitySummary(value);
}

function summaryField(value: string): { readonly activitySummary?: string } {
  const summary = safeSummary(value);
  return summary === undefined ? {} : { activitySummary: summary };
}

function sortedHostRuns(runs: readonly DaemonRunSnapshot[]): readonly DaemonRunSnapshot[] {
  return [...runs].sort((left, right) => compareText(left.runId, right.runId));
}

function compareEdges(left: AgentAwarenessEdgeInput, right: AgentAwarenessEdgeInput): number {
  return compareText(endpointKey(left.source), endpointKey(right.source))
    || compareText(endpointKey(left.target), endpointKey(right.target))
    || compareText(left.relation, right.relation);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableRecord(record: AgentAwarenessRecord): string {
  return JSON.stringify(record);
}

function assertOptions(options: AgentAwarenessCompositionOptions): void {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("awareness composition options must be an object");
  }
  if (options.runs !== undefined && !Array.isArray(options.runs)) {
    throw new TypeError("awareness composition runs must be an array");
  }
  if (options.workers !== undefined && !Array.isArray(options.workers)) {
    throw new TypeError("awareness composition workers must be an array");
  }
  if (options.lineage !== undefined && !Array.isArray(options.lineage)) {
    throw new TypeError("awareness composition lineage must be an array");
  }
}
