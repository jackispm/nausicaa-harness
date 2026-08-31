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
} from "../runtime/agent-awareness-composition.js";
import type { AgentTopologyProjectionInput } from "../runtime/agent-awareness.js";

const LOCAL_WORKSPACE_ID = "local-workspace";
const LOCAL_SESSION_ID = "local-session";

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
  now = new Date().toISOString(),
): Promise<AgentTopologyProjectionInput> {
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
    now,
    generatedAt: now,
  });
}

function summaryActivity(summary: WorkspaceRunSummary): string {
  return `${summary.status}: ${summary.goal}`;
}

