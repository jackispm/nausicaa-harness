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
      description: "Read the current bounded agent topology: active lanes, their roles and states, Teto activity, and branch relationships. This is a read-only snapshot; use it when deciding whether to open Teto or create a Team.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    async execute(_arguments_, context): Promise<ToolResult> {
      try {
        const snapshot = redactAgentTopologySnapshot(await options.read(context));
        return {
          content: JSON.stringify({
            snapshot,
            guidance: {
              teto: "Teto is an optional feedback lane. Each parent lane may have at most one active Teto.",
              team: "Team branches are independent task lanes. A branch may open its own Teto when its task needs a second line of thought.",
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
