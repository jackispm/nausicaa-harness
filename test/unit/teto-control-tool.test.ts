import { describe, expect, it, vi } from "vitest";

import type { ToolExecutionContext } from "../../src/domain/ports.js";
import { capabilityEntriesFromTools, createLaneCapabilityManifest } from "../../src/runtime/lane-context.js";
import { createTetoControlTools } from "../../src/runtime/teto-control-tool.js";

const context: ToolExecutionContext = {
  runId: "run",
  laneId: "main",
  workspace: "/workspace",
  operationId: "teto-control-operation",
};

function control() {
  return {
    start: vi.fn(async () => ({ active: true, changed: false, laneId: "teto" })),
    stop: vi.fn(async () => ({ active: false, changed: true, laneId: "teto" })),
    status: vi.fn(() => ({ active: true, available: true, laneId: "teto" })),
  };
}

describe("Teto control tools", () => {
  it("encourages early independent observation and lets simple tasks weigh the overhead", () => {
    const tools = createTetoControlTools(control());
    const description = tools[0]!.definition.description;
    expect(description).toContain("Open Teto early for complex analysis, debugging, planning, or review");
    expect(description).toContain("observes public events and offers a second perspective, not task execution");
    expect(description).toContain("An active lane is reused; keep working while it observes");
    expect(description).toContain("For simple tasks, weigh the overhead");
    expect(() => createLaneCapabilityManifest({
      schemaVersion: 1,
      lane: { workspaceId: "workspace", sessionId: "session", runId: "run", laneId: "main", laneKind: "main" },
      role: "Main",
      state: "ready",
      capabilities: capabilityEntriesFromTools(tools),
    })).not.toThrow();
  });

  it("preserves the tool schema and lane-scoped authority metadata", () => {
    const tools = createTetoControlTools(control());
    expect(tools.map((tool) => tool.definition.name)).toEqual(["teto_start", "teto_stop", "teto_status"]);
    expect(tools[0]!.definition.parameters).toEqual({
      type: "object",
      properties: { reason: { type: "string", description: "Why a second thinking line is useful" } },
      additionalProperties: false,
    });
    for (const tool of tools.slice(0, 2)) {
      expect(tool).toMatchObject({ metadata: {
        effect: "external", deterministic: false, supportsBatch: false, concurrencySafe: false,
        scope: "lane", inputKinds: ["json"], outputKinds: ["json"],
      } });
    }
    expect(tools[2]).toMatchObject({ metadata: {
      effect: "read", deterministic: false, supportsBatch: false, concurrencySafe: true,
      scope: "lane", inputKinds: ["json"], outputKinds: ["json"],
    } });
  });

  it("only invokes explicit lifecycle calls and preserves their host results", async () => {
    const host = control();
    const tools = createTetoControlTools(host);
    expect(host.start).not.toHaveBeenCalled();
    expect(host.stop).not.toHaveBeenCalled();
    expect(host.status).not.toHaveBeenCalled();

    const status = await tools[2]!.execute({}, context);
    expect(JSON.parse(status.content)).toEqual({ active: true, available: true, laneId: "teto" });
    expect(host.start).not.toHaveBeenCalled();

    const started = await tools[0]!.execute({ reason: "Review uncertain assumptions" }, context);
    expect(host.start).toHaveBeenCalledExactlyOnceWith(context);
    expect(started.isError).toBe(false);
    expect(JSON.parse(started.content)).toEqual({ active: true, changed: false, laneId: "teto" });

    const stopped = await tools[1]!.execute({}, context);
    expect(host.stop).toHaveBeenCalledExactlyOnceWith(context);
    expect(stopped.isError).toBe(false);
    expect(JSON.parse(stopped.content)).toEqual({ active: false, changed: true, laneId: "teto" });
    expect(host.status).toHaveBeenCalledExactlyOnceWith(context);
  });
});
