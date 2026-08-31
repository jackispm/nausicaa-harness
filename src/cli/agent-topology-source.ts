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
  type AgentAwarenessRunSource,
  type AgentAwarenessCompositionOptions,
} from "../runtime/agent-awareness-composition.js";
import type { AgentTopologyProjectionInput } from "../runtime/agent-awareness.js";
import type { DaemonHostSnapshot } from "../runtime/daemon-host.js";
import type { DaemonSupervisorSnapshot } from "../runtime/daemon-supervisor.js";

const LOCAL_WORKSPACE_ID = "local-workspace";
const LOCAL_SESSION_ID = "local-session";

/** Optional host-owned observations to append to the Ledger projection. */
export interface WorkspaceAgentAwarenessOptions {
  readonly now?: string;
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
  const source = new FileDaemonRunEventSource({ dataDir });
  const runs: AgentAwarenessRunSource[] = [];
  for (const summary of summaries) {
    try {
      const snapshot = await source.read(summary.runId);
      runs.push({
        projection: projectRun(snapshot.events, summary.runId),
        scope: {
          workspaceId: LOCAL_WORKSPACE_ID,
          sessionId: LOCAL_SESSION_ID,
        },
        ...(snapshot.generation === undefined ? {} : { generation: snapshot.generation }),
        generationTrusted: true,
        sourceValid: true,
        activitySummary: summaryActivity(summary),
        lastSeen: summary.updatedAt,
      });
    } catch {
      // A Run can be rotated between discovery and the observer read. Keep
      // topology output bounded and fail closed for that individual source.
    }
  }
  return composeAgentAwarenessProjectionInput({
    workspaceId: LOCAL_WORKSPACE_ID,
    sessionId: LOCAL_SESSION_ID,
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

function summaryActivity(summary: WorkspaceRunSummary): string {
  return `${summary.status}: ${summary.goal}`;
}
