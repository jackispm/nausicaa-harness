import type { RunProjection } from "../ledger/projection.js";
import { projectRun } from "../ledger/projection.js";
import {
  FileDaemonRunEventSource,
} from "../runtime/daemon-observer.js";
import {
  listWorkspaceRuns,
  type WorkspaceRunSummary,
} from "../runtime/session-controller.js";
import {
  composeAgentAwarenessProjectionInput,
  type AgentAwarenessSessionSource,
  type AgentAwarenessRunSource,
  type AgentAwarenessCompositionOptions,
} from "../runtime/agent-awareness-composition.js";
import { readLocalSessionRegistry } from "../runtime/local-session-registry.js";
import type { AgentTopologyProjectionInput } from "../runtime/agent-awareness.js";
import type { DaemonHostSnapshot } from "../runtime/daemon-host.js";
import type { DaemonSupervisorSnapshot } from "../runtime/daemon-supervisor.js";

const LOCAL_WORKSPACE_ID = "local-workspace";
const LOCAL_SESSION_ID = "local-session";

/** Optional host-owned observations to append to the Ledger projection. */
export interface WorkspaceAgentAwarenessOptions {
  readonly now?: string;
  /** Host-owned observation for the Session rendering this view. */
  readonly currentSession?: AgentAwarenessSessionSource;
  readonly host?: DaemonHostSnapshot;
  readonly hostLastSeen?: string;
  readonly supervisor?: DaemonSupervisorSnapshot;
  readonly supervisorLastSeen?: string;
  readonly workers?: AgentAwarenessCompositionOptions["workers"];
  readonly roster?: AgentAwarenessCompositionOptions["roster"];
  readonly availability?: AgentAwarenessCompositionOptions["availability"];
  readonly freshnessMs?: number;
  readonly maxFutureSkewMs?: number;
}

/**
 * Build the read-only Awareness source used by `--topology`.
 *
 * Discovery first uses the same workspace/Run boundary as resume selection,
 * then reads committed event tails without acquiring a Ledger writer lock.
 * Damaged Runs are already excluded by `listWorkspaceRuns`; a concurrent
 * rotation can still race the tail read, so that one Run is skipped rather
 * than weakening the projection boundary for the rest of the topology.
 */
export async function readWorkspaceAgentAwareness(
  dataDir: string,
  workspace: string,
  nowOrOptions: string | WorkspaceAgentAwarenessOptions = new Date().toISOString(),
  maybeOptions: WorkspaceAgentAwarenessOptions = {},
): Promise<AgentTopologyProjectionInput> {
  const now = typeof nowOrOptions === "string"
    ? nowOrOptions
    : nowOrOptions.now ?? new Date().toISOString();
  const options = typeof nowOrOptions === "string" ? maybeOptions : nowOrOptions;
  const summaries = await listWorkspaceRuns(dataDir, workspace);
  const sessions = await readLocalSessionRegistry(dataDir, workspace);
  // The local registry is intentionally advisory. The Session that is
  // rendering this view has a stronger in-process snapshot, so merge that one
  // observation before projecting stale heartbeats. This prevents the current
  // TUI from presenting itself as offline after a slow filesystem read or a
  // heartbeat race.
  const sessionSources = new Map<string, AgentAwarenessSessionSource>();
  for (const session of sessions) {
    sessionSources.set(session.sessionId, {
      sessionId: session.sessionId,
      ...(session.runId === undefined ? {} : { runId: session.runId }),
      laneId: session.laneId,
      state: session.state,
      lastSeen: session.lastSeen,
      ...(session.activitySummary === undefined ? {} : { activitySummary: session.activitySummary }),
    });
  }
  if (options.currentSession !== undefined) {
    const current = options.currentSession;
    const previous = sessionSources.get(current.sessionId);
    const previousWithoutRun = previous === undefined ? undefined : withoutRunId(previous);
    sessionSources.set(current.sessionId, {
      ...(current.runId === undefined
        ? previousWithoutRun ?? { sessionId: current.sessionId, laneId: "main" }
        : previous ?? { sessionId: current.sessionId, laneId: "main" }),
      ...current,
      lastSeen: current.lastSeen ?? now,
    });
  }
  const sessionsForProjection = [...sessionSources.values()];
  const sessionsByRun = new Map<string, AgentAwarenessSessionSource[]>();
  for (const session of sessionsForProjection) {
    if (session.runId === undefined) continue;
    const bucket = sessionsByRun.get(session.runId) ?? [];
    bucket.push(session);
    sessionsByRun.set(session.runId, bucket);
  }
  const source = new FileDaemonRunEventSource({ dataDir });
  const runs: AgentAwarenessRunSource[] = [];
  for (const summary of summaries) {
    try {
      const snapshot = await source.read(summary.runId);
      const runSessions = sessionsByRun.get(summary.runId) ?? [];
      // A Run can be observed by more than one local session (for example,
      // one interactive TUI and one daemon/read-only attachment). Preserve
      // every session identity instead of collapsing the Run to the newest
      // heartbeat; endpoint identity is what lets A2A address the right one.
      // A durable Run without a current session is history, not a live agent.
      // Keep one offline record for diagnostic text output, but never invent a
      // fresh session identity from the configured local scope.
      if (runSessions.length === 0) {
        runs.push({
          projection: projectRun(snapshot.events, summary.runId),
          scope: { workspaceId: LOCAL_WORKSPACE_ID, sessionId: LOCAL_SESSION_ID },
          state: "offline" as const,
          ...(snapshot.generation === undefined ? {} : { generation: snapshot.generation }),
          generationTrusted: true,
          sourceValid: true,
          activitySummary: observedActivitySummary(undefined, summary),
          lastSeen: summary.updatedAt,
        });
      } else {
        for (const session of runSessions) {
          runs.push({
            projection: projectRun(snapshot.events, summary.runId),
            scope: { workspaceId: LOCAL_WORKSPACE_ID, sessionId: session.sessionId },
            ...(session.state === undefined ? {} : { state: session.state }),
            ...(snapshot.generation === undefined ? {} : { generation: snapshot.generation }),
            generationTrusted: true,
            sourceValid: true,
            activitySummary: observedActivitySummary(session, summary),
            lastSeen: session.lastSeen ?? summary.updatedAt,
          });
        }
      }
    } catch {
      // A Run can be rotated between discovery and the observer read. Keep
      // topology output bounded and fail closed for that individual source.
    }
  }
  return composeAgentAwarenessProjectionInput({
    workspaceId: LOCAL_WORKSPACE_ID,
    sessionId: LOCAL_SESSION_ID,
    sessions: sessionsForProjection
      .filter((session) => session.runId === undefined)
      .map(withoutRunId),
    runs,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.hostLastSeen === undefined ? {} : { hostLastSeen: options.hostLastSeen }),
    ...(options.supervisor === undefined ? {} : { supervisor: options.supervisor }),
    ...(options.supervisorLastSeen === undefined ? {} : { supervisorLastSeen: options.supervisorLastSeen }),
    ...(options.workers === undefined ? {} : { workers: options.workers }),
    ...(options.roster === undefined ? {} : { roster: options.roster }),
    ...(options.availability === undefined ? {} : { availability: options.availability }),
    ...(options.freshnessMs === undefined ? {} : { freshnessMs: options.freshnessMs }),
    ...(options.maxFutureSkewMs === undefined ? {} : { maxFutureSkewMs: options.maxFutureSkewMs }),
    now,
    generatedAt: now,
  });
}

function withoutRunId(source: AgentAwarenessSessionSource): AgentAwarenessSessionSource {
  return {
    sessionId: source.sessionId,
    ...(source.laneId === undefined ? {} : { laneId: source.laneId }),
    ...(source.state === undefined ? {} : { state: source.state }),
    ...(source.lastSeen === undefined ? {} : { lastSeen: source.lastSeen }),
    ...(source.activitySummary === undefined ? {} : { activitySummary: source.activitySummary }),
  };
}

function summaryActivity(summary: WorkspaceRunSummary): string {
  return `${summary.status}: ${summary.goal}`;
}

function observedActivitySummary(
  session: AgentAwarenessSessionSource | undefined,
  summary: WorkspaceRunSummary,
): string {
  const runSummary = summaryActivity(summary);
  if (session?.activitySummary === undefined || session.activitySummary.trim().length === 0) {
    return runSummary;
  }
  // Presence gives the live state; the durable Run summary supplies the task
  // objective. Keep both so another lane can tell "idle" from "idle on X".
  if (session.activitySummary.includes(summary.goal)) return session.activitySummary;
  return `${session.activitySummary} · ${runSummary}`;
}
