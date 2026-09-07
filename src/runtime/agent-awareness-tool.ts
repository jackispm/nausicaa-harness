import type { AgentTool, ToolExecutionContext, ToolResult } from "../domain/ports.js";
import {
  redactAgentTopologySnapshot,
  type AgentTopologySnapshot,
} from "./agent-awareness.js";
import { annotateTool } from "../mowe/catalog.js";

export interface AgentAwarenessToolOptions {
  /** Host-owned read; the tool never retains a registry or transcript. */
  read: (context: ToolExecutionContext) => AgentTopologySnapshot | Promise<AgentTopologySnapshot>;
}

/** Reusable type for a host-provided, permission-filtered Awareness reader. */
export type AgentAwarenessReader = AgentAwarenessToolOptions["read"];

/**
 * Exposes the same bounded topology projection used by the UI to a lane.
 * Awareness is deliberately a normal read tool: Main decides when the
 * observation is worth paying for, and the returned snapshot is not fed into
 * any hidden scheduler state.
 */
export function createAgentAwarenessTool(options: AgentAwarenessToolOptions): AgentTool {
  if (typeof options.read !== "function") throw new TypeError("awareness read must be a function");
  const tool: AgentTool = {
    definition: {
      name: "agent_awareness",
      description: "Read the current bounded agent topology: active lanes, roles, states, Teto activity, and Run lineage. This is a read-only snapshot; use it when deciding whether to open Teto or create a Team.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    async execute(_arguments_, context): Promise<ToolResult> {
      try {
        const snapshot = liveAgentTopologySnapshot(
          redactAgentTopologySnapshot(await options.read(context)),
        );
        return {
          content: JSON.stringify({
            snapshot,
            guidance: {
              liveOnly: "The snapshot excludes offline and terminal lanes. Group nodes by endpoint.sessionId to distinguish sessions.",
              taskSummary: "Use node.activitySummary as the bounded host-provided task/status summary; it is not a private transcript.",
              teto: "Teto is an optional feedback lane. Each parent lane may have at most one active Teto.",
              team: "Team members are independent task lanes; Main is the Team Lead and default synthesizer. A member may open its own Teto. Historical Run forks are not Team members.",
            },
          }),
          isError: false,
        };
      } catch (error: unknown) {
        return {
          content: JSON.stringify({
            error: error instanceof Error ? error.message : "Agent awareness is unavailable",
          }),
          isError: true,
        };
      }
    },
  };
  return annotateTool(tool, {
    effect: "read",
    deterministic: false,
    supportsBatch: false,
    concurrencySafe: true,
    scope: "run",
    inputKinds: ["json"],
    outputKinds: ["json", "text"],
  });
}

function liveAgentTopologySnapshot(snapshot: AgentTopologySnapshot): AgentTopologySnapshot {
  const nodes = snapshot.nodes.filter((node) => node.state !== "offline" && node.state !== "terminal");
  const keys = new Set(nodes.map((node) => node.key));
  return {
    ...snapshot,
    nodes,
    edges: snapshot.edges.filter((edge) => keys.has(edge.source) && keys.has(edge.target)),
    roots: snapshot.roots.filter((root) => keys.has(root)),
  };
}
