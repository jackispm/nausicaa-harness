import type { CrossRunRoster, CrossRunRosterEntry } from "../a2a/cross-run-contract.js";
import { endpointKey, normalizeEndpoint } from "../a2a/cross-run-contract.js";
import type { CrossRunEndpoint } from "../domain/types.js";
import type { LaneView, RunProjection } from "../ledger/projection.js";
import type {
  AgentAwarenessEdgeInput,
  AgentAwarenessAvailability,
  AgentAwarenessRecord,
  AgentAwarenessRelation,
  AgentAwarenessState,
  AgentTopologyProjectionInput,
} from "./agent-awareness.js";
import { sanitizeAgentActivitySummary } from "./agent-awareness.js";
import { assertSpawnContextMatchesTask } from "./lane-context.js";
import type { DaemonHostSnapshot, DaemonRunSnapshot } from "./daemon-host.js";
import type { DaemonWorkerDescriptor } from "./daemon-worker-protocol.js";
import type {
  DaemonSupervisorSnapshot,
  DaemonSupervisorWorkerSnapshot,
} from "./daemon-supervisor.js";
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
  readonly runtimeBuildId?: string;
  readonly session?: SessionSnapshot;
  /** Overrides the composition-wide scope for this Run. */
  readonly scope?: Partial<AgentAwarenessIdentityScope>;
  /** Source generation from a cursor/observer, when one exists. */
  readonly generation?: number;
  readonly generationTrusted?: boolean;
  readonly sourceValid?: boolean;
  readonly authorized?: boolean;
  readonly visible?: boolean;
  /** Host-provided, already-safe text; it is sanitized again at this boundary. */
  readonly activitySummary?: string;
  /** Host-observed live state overrides the last durable Run projection. */
  readonly state?: AgentAwarenessState | string;
  /** Freshness timestamp from the same observation used for this source. */
  readonly lastSeen?: string;
}

/** A live CLI session which has not attached a Run yet. */
export interface AgentAwarenessSessionSource {
  readonly sessionId: string;
  readonly runtimeBuildId?: string;
  readonly runId?: string;
  readonly laneId?: string;
  readonly state?: AgentAwarenessState | string;
  readonly activitySummary?: string;
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
  readonly authorized?: boolean;
  readonly visible?: boolean;
  readonly retained?: boolean;
  readonly activitySummary?: string;
  readonly lastSeen?: string;
}

/** Optional trusted lineage supplied by a host or branch manager. */
export type AgentAwarenessLineageSource = AgentAwarenessEdgeInput;

/** Admission marks stay next to the roster so an untrusted source fails closed. */
export interface AgentAwarenessRosterSource {
  readonly roster: CrossRunRoster;
  readonly authorized?: boolean;
  readonly visible?: boolean;
  readonly lastSeen?: string;
}

export interface AgentAwarenessCompositionOptions {
  /** Required for every local source; filesystem paths are deliberately not accepted as IDs. */
  readonly workspaceId?: string;
  /** Default for Runs/workers without a per-source override. */
  readonly sessionId?: string;
  /** Per-Run scopes are needed when one query spans multiple Sessions. */
  readonly runScopes?: Readonly<Record<string, AgentAwarenessIdentityScope>>;
  readonly runs?: readonly AgentAwarenessRunSource[];
  readonly sessions?: readonly AgentAwarenessSessionSource[];
  readonly host?: DaemonHostSnapshot;
  readonly hostLastSeen?: string;
  /** Optional detached-worker view from the same daemon control observation. */
  readonly supervisor?: DaemonSupervisorSnapshot;
  readonly supervisorLastSeen?: string;
  readonly workers?: readonly AgentAwarenessWorkerSource[];
  /** Already authorized, bounded A2A roster from the host. */
  readonly roster?: CrossRunRoster | AgentAwarenessRosterSource;
  readonly lineage?: readonly AgentAwarenessLineageSource[];
  readonly now?: string;
  readonly generatedAt?: string;
  readonly availability?: AgentAwarenessAvailability;
  readonly freshnessMs?: number;
  readonly maxFutureSkewMs?: number;
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
const DETACHED_WORKER_LANE = "detached-worker";
const DAEMON_RUN_ID = "daemon-host";
const DAEMON_LANE_ID = "daemon";
const RECORD_PRIORITY = {
  roster: 10,
  worker: 60,
  run: 40,
  lane: 50,
  host: 70,
  daemon: 80,
  placeholder: 1,
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

  for (const session of options.sessions ?? []) {
    if (session.runId !== undefined) continue;
    const scope = resolveScope(
      `session:${session.sessionId}`,
      options.workspaceId === undefined
        ? { sessionId: session.sessionId }
        : { workspaceId: options.workspaceId, sessionId: session.sessionId },
      options,
      runScopes,
    );
    addRecord(records, {
      endpoint: endpoint(scope, `session:${session.sessionId}`, session.laneId ?? "main"),
      role: "main",
      state: session.state ?? "idle",
      ...(session.activitySummary === undefined ? {} : { activitySummary: session.activitySummary }),
      lastSeen: session.lastSeen ?? generatedAt,
      ...(session.runtimeBuildId === undefined ? {} : { runtimeBuildId: session.runtimeBuildId }),
      authorized: true,
      visible: true,
    }, RECORD_PRIORITY.host);
  }

  for (const source of options.runs ?? []) {
    if (source.authorized === false || source.visible === false) continue;
    const runId = source.projection.run.runId;
    const scope = resolveScope(runId, source.scope, options, runScopes);
    runScopes.set(runId, scope);
    addRunSource(source, scope, generatedAt, records, edges);
  }

  for (const source of options.workers ?? []) {
    if (source.authorized === false || source.visible === false) continue;
    const runId = source.descriptor.runId;
    const scope = resolveScope(runId, source.scope, options, runScopes);
    runScopes.set(runId, scope);
    addWorkerSource(source, scope, generatedAt, records, edges);
  }

  const host = options.host ?? options.supervisor?.host;
  const daemonScope = host === undefined && options.supervisor === undefined
    ? undefined
    : resolveDaemonScope(options, runScopes);
  const daemon = daemonScope === undefined
    ? undefined
    : endpoint(daemonScope, DAEMON_RUN_ID, DAEMON_LANE_ID);
  if (daemon !== undefined) {
    addDaemonSource(
      host,
      options.supervisor,
      daemon,
      options.supervisorLastSeen ?? options.hostLastSeen ?? generatedAt,
      records,
    );
  }

  if (host !== undefined) {
    for (const run of sortedHostRuns(host.runs)) {
      const scope = resolveScope(run.runId, undefined, options, runScopes);
      runScopes.set(run.runId, scope);
      addHostRun(
        run,
        scope,
        options.hostLastSeen ?? options.supervisorLastSeen ?? generatedAt,
        daemon,
        records,
        edges,
      );
    }
  }

  if (options.supervisor !== undefined) {
    for (const worker of sortedSupervisorWorkers(options.supervisor.workers)) {
      const scope = resolveScope(worker.runId, undefined, options, runScopes);
      runScopes.set(worker.runId, scope);
      addSupervisorWorker(
        worker,
        scope,
        options.supervisorLastSeen ?? generatedAt,
        daemon,
        records,
        edges,
      );
    }
  }

  if (daemon !== undefined) {
    for (const source of options.workers ?? []) {
      if (source.authorized === false || source.visible === false) continue;
      const scope = resolveScope(source.descriptor.runId, source.scope, options, runScopes);
      addEdge({
        source: endpoint(scope, source.descriptor.runId, source.laneId ?? DEFAULT_WORKER_LANE),
        target: daemon,
        relation: "hosted-by",
        authorized: true,
        visible: true,
      }, edges);
    }
  }

  if (options.roster !== undefined) {
    const source = normalizeRosterSource(options.roster);
    if (source.authorized !== false && source.visible !== false) {
      addRoster(source.roster, source.lastSeen ?? generatedAt, records, edges);
    }
  }
  for (const lineage of options.lineage ?? []) {
    if (lineage.authorized === false || lineage.visible === false) continue;
    addEdge(lineage, edges);
  }

  const input: AgentTopologyProjectionInput = {
    generatedAt,
    now,
    availability: options.availability ?? compositionAvailability(options, records, now),
    records: Object.freeze([...records.values()]
      .sort((left, right) => compareText(endpointKey(left.record.endpoint), endpointKey(right.record.endpoint)))
      .map((candidate) => candidate.record)),
    edges: Object.freeze([...edges.values()].sort(compareEdges)),
    ...(options.freshnessMs === undefined ? {} : { freshnessMs: options.freshnessMs }),
    ...(options.maxFutureSkewMs === undefined ? {} : { maxFutureSkewMs: options.maxFutureSkewMs }),
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
  const mainState = source.state ?? stateForMain(projection, source.session?.status, mainLane?.status);
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
    ...(source.runtimeBuildId === undefined ? {} : { runtimeBuildId: source.runtimeBuildId }),
  }, RECORD_PRIORITY.run);

  const taskParents = scopedTeamParents(projection, scope);
  const laneIds = Object.keys(projection.lanes).sort(compareText);
  for (const laneId of laneIds) {
    const lane = projection.lanes[laneId];
    if (lane === undefined || laneId === "main" || !hasLaneActivation(lane)) continue;
    const laneEndpoint = endpoint(scope, runId, laneId);
    // A Run-level offline/terminal observation dominates durable lane status.
    // Otherwise a closed Run with a dormant Teto or Worker lane appears live
    // even though no process can receive a message for it.
    const state = mainState === "offline" || mainState === "terminal"
      ? mainState
      : stateForLane(lane.status);
    const role = laneId === "teto" || lane.kind === "intent-navigator" || laneId.endsWith(":teto")
      ? "teto"
      : laneId === "worker" || lane.kind === "worker"
        ? "worker"
        : lane.kind === "team" || laneId.startsWith("team:")
          ? "team"
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
      ...(source.runtimeBuildId === undefined ? {} : { runtimeBuildId: source.runtimeBuildId }),
    }, RECORD_PRIORITY.lane);
    const parentLane = role === "teto" && laneId.endsWith(":teto")
      ? laneId.slice(0, -":teto".length)
      : taskParents.get(laneId) ?? "main";
    const parentEndpoint = endpoint(scope, runId, parentLane);
    addEdge({
      source: parentEndpoint,
      target: laneEndpoint,
      relation: "parent",
      authorized: true,
      visible: true,
    }, edges);
    if (role === "worker") {
      addEdge({
        source: parentEndpoint,
        target: laneEndpoint,
        relation: "delegates",
        authorized: true,
        visible: true,
      }, edges);
    }
    if (role === "teto") {
      addEdge({
        source: laneEndpoint,
        target: parentEndpoint,
        relation: "observer",
        authorized: true,
        visible: true,
      }, edges);
    }
  }
}

function scopedTeamParents(projection: RunProjection, scope: Scope): Map<string, string> {
  const parents = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const { message } of projection.inbox) {
    if (message.runId !== projection.run.runId || message.payload.type !== "task.request"
      || message.routeId !== undefined || message.sourceEndpoint !== undefined || message.targetEndpoint !== undefined
      || message.routeRelationship !== undefined || message.routeArtifacts !== undefined || message.from === message.to) continue;
    const member = /^team:[^:]+:[^:]+$/u.test(message.to);
    const reducer = /^team-reducer:[^:]+$/u.test(message.to);
    if (!member && !reducer) continue;
    const expectedTaskId = member ? message.to.slice("team:".length)
      : `team:${message.to.slice("team-reducer:".length)}:reduction`;
    const parent = projection.lanes[message.from];
    const child = projection.lanes[message.to];
    const context = message.payload.spawnContext;
    if (message.payload.taskId !== expectedTaskId || context === undefined
      || parent === undefined || child === undefined || !hasLaneActivation(parent) || !hasLaneActivation(child)
      || child.kind !== (member ? "team" : "worker")) continue;
    try {
      assertSpawnContextMatchesTask(context, {
        runId: projection.run.runId, from: message.from, to: message.to,
        goal: message.payload.goal, inputRefs: message.payload.inputRefs, budget: message.payload.budget,
      });
    } catch {
      continue;
    }
    if (context.parent.workspaceId !== scope.workspaceId || context.child.workspaceId !== scope.workspaceId
      || context.parent.sessionId !== scope.sessionId || context.child.sessionId !== scope.sessionId
      || context.child.laneKind !== child.kind || context.child.relation !== (member ? "member-of" : "delegates")) continue;
    // Conflicting historical claims cannot move a lane under an arbitrary owner.
    if (parents.has(message.to) && parents.get(message.to) !== message.from) conflicts.add(message.to);
    parents.set(message.to, message.from);
  }
  for (const laneId of conflicts) parents.delete(laneId);
  return parents;
}

function hasLaneActivation(lane: LaneView): boolean {
  if (lane.activated !== undefined) return lane.activated;
  // Older host projections lack the durable marker; idle alone is not evidence.
  return lane.lastStep !== undefined || lane.status === "running";
}

function addHostRun(
  run: DaemonRunSnapshot,
  scope: Scope,
  lastSeen: string,
  daemon: CrossRunEndpoint | undefined,
  records: Map<string, Candidate>,
  edges: Map<string, AgentAwarenessEdgeInput>,
): void {
  const state = stateForHostRun(run.state);
  const main = endpoint(scope, run.runId, "main");
  addRecord(records, {
    endpoint: main,
    role: "main",
    state,
    ...(state === "sleeping" ? { retained: true } : {}),
    authorized: true,
    visible: true,
    ...(run.fencingToken === undefined ? {} : { generation: run.fencingToken }),
    lastSeen,
    activitySummary: activityForHostRun(run),
  }, RECORD_PRIORITY.host);
  if (daemon !== undefined) {
    addEdge({
      source: main,
      target: daemon,
      relation: "hosted-by",
      authorized: true,
      visible: true,
    }, edges);
  }
}

function addDaemonSource(
  host: DaemonHostSnapshot | undefined,
  supervisor: DaemonSupervisorSnapshot | undefined,
  daemon: CrossRunEndpoint,
  lastSeen: string,
  records: Map<string, Candidate>,
): void {
  const sourceState = supervisor === undefined
    ? host?.status ?? "stopped"
    : supervisor.lifecycle;
  const state = stateForDaemon(sourceState);
  addRecord(records, {
    endpoint: daemon,
    role: "daemon",
    state,
    authorized: true,
    visible: true,
    lastSeen,
    activitySummary: activityForState(state, "daemon"),
  }, RECORD_PRIORITY.daemon);
}

function addSupervisorWorker(
  worker: DaemonSupervisorWorkerSnapshot,
  scope: Scope,
  lastSeen: string,
  daemon: CrossRunEndpoint | undefined,
  records: Map<string, Candidate>,
  edges: Map<string, AgentAwarenessEdgeInput>,
): void {
  const main = endpoint(scope, worker.runId, "main");
  const workerEndpoint = endpoint(scope, worker.runId, workerLaneId(worker.workerId));
  const state = stateForSupervisorWorker(worker.state);
  addMainPlaceholder(main, lastSeen, records);
  addRecord(records, {
    endpoint: workerEndpoint,
    role: "worker",
    state,
    generation: worker.generation,
    authorized: true,
    visible: true,
    lastSeen,
    activitySummary: activityForState(state, "detached worker"),
  }, RECORD_PRIORITY.worker);
  for (const relation of ["parent", "delegates"] as const) {
    addEdge({
      source: main,
      target: workerEndpoint,
      relation,
      authorized: true,
      visible: true,
    }, edges);
  }
  if (daemon !== undefined) {
    addEdge({
      source: workerEndpoint,
      target: daemon,
      relation: "hosted-by",
      authorized: true,
      visible: true,
    }, edges);
  }
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
  addEdge({
    source: endpoint(scope, descriptor.runId, "main"),
    target: worker,
    relation: "delegates",
    authorized: true,
    visible: true,
  }, edges);
}

function addMainPlaceholder(
  main: CrossRunEndpoint,
  lastSeen: string,
  records: Map<string, Candidate>,
): void {
  addRecord(records, {
    endpoint: main,
    role: "main",
    state: "offline",
    activitySummary: "Nausicaa unavailable",
    authorized: true,
    visible: true,
    lastSeen,
  }, RECORD_PRIORITY.placeholder);
}

function workerLaneId(workerId: string): string {
  return `${DETACHED_WORKER_LANE}:${workerId}`;
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
    addEdge({
      source: current,
      target,
      relation: "routes-to",
      authorized: true,
      visible: true,
    }, edges);
    if (entry.relationship === "child") {
      addEdge({
        source: current,
        target,
        relation: "delegates",
        authorized: true,
        visible: true,
      }, edges);
    }
  }
}

function normalizeRosterSource(
  roster: CrossRunRoster | AgentAwarenessRosterSource,
): AgentAwarenessRosterSource {
  if ("roster" in roster) return roster;
  return { roster };
}

function resolveDaemonScope(
  options: AgentAwarenessCompositionOptions,
  known: ReadonlyMap<string, Scope>,
): Scope {
  const first = known.values().next().value as Scope | undefined;
  if (first !== undefined) {
    const workspaceId = options.workspaceId ?? first.workspaceId;
    const sessionId = options.sessionId ?? first.sessionId;
    if (
      typeof workspaceId === "string"
      && typeof sessionId === "string"
      && workspaceId.trim().length > 0
      && sessionId.trim().length > 0
    ) {
      return { workspaceId, sessionId };
    }
  }
  return resolveScope(DAEMON_RUN_ID, undefined, options, known);
}

function compositionAvailability(
  options: AgentAwarenessCompositionOptions,
  records: ReadonlyMap<string, Candidate>,
  now: string,
): AgentAwarenessAvailability {
  if (records.size === 0) return "unavailable";
  const freshnessMs = options.freshnessMs ?? 5 * 60_000;
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return "stale";
  let observed = false;
  let fresh = false;
  for (const candidate of records.values()) {
    const seen = candidate.record.lastSeen;
    if (seen === undefined) continue;
    observed = true;
    const seenMs = Date.parse(seen);
    if (Number.isFinite(seenMs) && seenMs <= nowMs && nowMs - seenMs <= freshnessMs) {
      fresh = true;
      break;
    }
  }
  return observed && fresh ? "fresh" : "stale";
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
  // A prior observation's code identity cannot identify the winning process.
  const { runtimeBuildId: _loserBuildId, ...loserFields } = loser;
  records.set(key, {
    priority: Math.max(priority, current.priority),
    record: {
      ...loserFields,
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
    default: return "offline";
  }
}

function stateForDaemon(state: string): string {
  switch (state) {
    case "running":
    case "ready": return "active";
    case "starting": return "starting";
    case "stopping":
    case "draining": return "waiting";
    case "failed":
    case "stopped": return "offline";
    default: return "offline";
  }
}

function stateForSupervisorWorker(state: DaemonSupervisorWorkerSnapshot["state"]): string {
  switch (state) {
    case "starting": return "starting";
    case "ready":
    case "running": return "active";
    case "draining": return "waiting";
    case "completed": return "terminal";
    case "failed":
    case "crashed":
    case "ready-timeout":
    case "lease-lost":
    case "uncertain":
    case "closed": return "offline";
    default: return "offline";
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
    case "team": return "team";
    case "reflection": return "reflection";
    default: return "auxiliary";
  }
}

function activityForState(state: string, role: string): string {
  const name = role === "main" ? "Nausicaa" : role;
  switch (state) {
    case "active": return `${name} working`;
    case "starting": return `${name} starting`;
    case "waiting": return `${name} waiting for input`;
    case "sleeping": return `${name} sleeping until wake`;
    case "offline": return `${name} offline`;
    case "terminal": return `${name} finished`;
    case "idle":
    default: return `${name} idle`;
  }
}

function activityForHostRun(run: DaemonRunSnapshot): string {
  if (run.state === "queued") return "Nausicaa queued for wake";
  if (run.state === "held") return "Nausicaa held by daemon";
  if (run.state === "failed") return "Nausicaa daemon run failed";
  if (run.pendingWakeCount > 0) return "Nausicaa working with queued wake";
  return "Nausicaa working";
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

function sortedSupervisorWorkers(
  workers: readonly DaemonSupervisorWorkerSnapshot[],
): readonly DaemonSupervisorWorkerSnapshot[] {
  return [...workers].sort((left, right) => (
    compareText(left.runId, right.runId)
      || compareText(left.workerId, right.workerId)
      || left.generation - right.generation
  ));
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
  return JSON.stringify(sortRecordValue(record));
}

function sortRecordValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortRecordValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, item]) => [key, sortRecordValue(item)]),
    );
  }
  return value;
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
