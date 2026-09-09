import type { AgentTool, ToolExecutionContext, ToolResult } from "../domain/ports.js";
import { annotateTool } from "../mowe/catalog.js";

export interface TetoControl {
  start(context: ToolExecutionContext): Promise<TetoControlResult>;
  stop(context: ToolExecutionContext): Promise<TetoControlResult>;
  status(context: ToolExecutionContext): TetoControlStatus | Promise<TetoControlStatus>;
}

export interface TetoControlResult {
  active: boolean;
  changed: boolean;
  laneId?: string;
  reason?: string;
}

export interface TetoControlStatus {
  active: boolean;
  available: boolean;
  laneId?: string;
  reason?: string;
}

/** A normal lane capability for opening or closing its one feedback lane. */
export function createTetoControlTools(control: TetoControl): readonly AgentTool[] {
  if (control === null || typeof control !== "object") {
    throw new TypeError("Teto control must be an object");
  }
  const start: AgentTool = {
    definition: {
      name: "teto_start",
      description: "Start or restart your Teto observer. Reuses an active lane; the reason explains why to enable observation.",
      parameters: {
        type: "object",
        properties: { reason: { type: "string", description: "Why a second thinking line is useful" } },
        additionalProperties: false,
      },
    },
    async execute(_arguments_, context): Promise<ToolResult> {
      return controlResult(await control.start(context));
    },
  };
  const stop: AgentTool = {
    definition: {
      name: "teto_stop",
      description: "Stop this lane's active Teto feedback lane. The lane can be opened again later and keeps its durable transcript.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    async execute(_arguments_, context): Promise<ToolResult> {
      return controlResult(await control.stop(context));
    },
  };
  const status: AgentTool = {
    definition: {
      name: "teto_status",
      description: "Read whether this lane has an available or active Teto feedback lane.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    async execute(_arguments_, context): Promise<ToolResult> {
      return controlResult(await control.status(context));
    },
  };
  return [
    annotateTool(start, { effect: "external", deterministic: false, supportsBatch: false, concurrencySafe: false, scope: "lane", inputKinds: ["json"], outputKinds: ["json"] }),
    annotateTool(stop, { effect: "external", deterministic: false, supportsBatch: false, concurrencySafe: false, scope: "lane", inputKinds: ["json"], outputKinds: ["json"] }),
    annotateTool(status, { effect: "read", deterministic: false, supportsBatch: false, concurrencySafe: true, scope: "lane", inputKinds: ["json"], outputKinds: ["json"] }),
  ];
}

function controlResult(result: TetoControlResult | TetoControlStatus): ToolResult {
  return { content: JSON.stringify(result), isError: false };
}
