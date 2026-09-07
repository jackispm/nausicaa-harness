import { projectRun } from "../ledger/projection.js";
import type { AnyEvent } from "../domain/events.js";
import type { RunId } from "../domain/types.js";
import {
  composeAgentAwarenessProjectionInput,
} from "./agent-awareness-composition.js";
import { projectAgentTopology, type AgentTopologySnapshot } from "./agent-awareness.js";

/**
 * Build the lane-visible Awareness view from the same durable events that
 * renderers use. It intentionally exposes no artifacts, messages, or tool
 * results beyond role/state/activity metadata.
 */
export function projectRunAwareness(
  events: readonly AnyEvent[],
  runId: RunId,
  now: string,
  sessionId = "local-session",
  workspaceId = "local-workspace",
): AgentTopologySnapshot {
  const projection = projectRun(events, runId);
  const input = composeAgentAwarenessProjectionInput({
    workspaceId,
    sessionId,
    now,
    generatedAt: now,
    runs: [{
      projection,
      generationTrusted: true,
      sourceValid: true,
      lastSeen: now,
    }],
  });
  return projectAgentTopology(input);
}
