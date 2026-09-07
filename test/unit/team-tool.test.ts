import { describe, expect, it, vi } from "vitest";

import type { ToolExecutionContext } from "../../src/domain/ports.js";
import { MAX_TASK_ATTEMPTS, MAX_TASK_MODEL_TOKENS, MAX_TASK_WALL_CLOCK_MS } from "../../src/domain/types.js";
import { assertSupportedSchema, validateArguments } from "../../src/mowe/admission.js";
import {
  createTeamCancelTool,
  createTeamPresentTool,
  createTeamReduceTool,
  createTeamStatusTool,
  createTeamTool,
  normalizeTeamCreateRequest,
  type TeamControl,
  type TeamCreateRequest,
} from "../../src/runtime/team-tool.js";

const context: ToolExecutionContext = {
  runId: "run-1",
  laneId: "main",
  workspace: "/workspace",
  operationId: "operation-1",
};

function setup(overrides: Partial<TeamControl> = {}) {
  const create = vi.fn(async (_request: TeamCreateRequest, _context: ToolExecutionContext) => ({
    teamId: "review",
    branches: [{ branchId: "security", laneId: "team:review:security", status: "queued" as const }],
    members: [{ memberId: "security", taskId: "review:security", laneId: "team:review:security", status: "queued" as const }],
  }));
  const control: TeamControl = { create, ...overrides };
  return { control, create, tool: createTeamTool(control) };
}

describe("Team tool creation contract", () => {
  it("canonicalizes members and legacy branches to the same bounded request", async () => {
    const { tool, create } = setup();
    const common = { statement: "Inspect auth", successCriteria: ["Report evidence"], maxModelTokens: 1_000 };
    const canonical = { teamId: "review", members: [{ memberId: "Security", ...common }] };
    const legacy = { teamId: "review", branches: [{ branchId: "security", ...common }] };

    const first = await tool.execute(canonical, context);
    const second = await tool.execute(legacy, context);
    expect(first.isError).toBe(false);
    expect(second).toEqual(first);
    expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
    expect(create).toHaveBeenCalledWith({
      teamId: "review",
      branches: [{
        memberId: "security",
        branchId: "security",
        ...common,
        hardConstraints: [],
        dependsOn: [],
        required: true,
      }],
      joinPolicy: "all-terminal",
      peerMessaging: "team-members",
    }, context);
    expect(JSON.parse(first.content).members[0]).toEqual({
      memberId: "security", taskId: "review:security", laneId: "team:review:security", status: "queued",
    });
  });

  it("preserves older host controls returning only compatibility identities", async () => {
    const legacyResult = { teamId: "review", branches: [{ branchId: "security", laneId: "team:review:security", status: "duplicate" as const }] };
    const { tool } = setup({ create: async () => legacyResult });
    expect(JSON.parse((await tool.execute({ branches: [{ statement: "Inspect auth" }] }, context)).content))
      .toEqual(legacyResult);
  });

  it("normalizes deadlines and dependency ids without mutating the caller's request", () => {
    const request = {
      members: [
        { memberId: "Source Review", statement: "Review source", required: false },
        { statement: "Inspect review findings", dependsOn: ["Source Review"] },
      ],
      joinPolicy: "deadline-best-effort",
      deadline: "2026-09-07T12:30:00+08:00",
      peerMessaging: "lead-only",
    };
    const copy = structuredClone(request);
    const normalized = normalizeTeamCreateRequest(request);
    expect(normalized).toMatchObject({
      deadline: "2026-09-07T04:30:00.000Z",
      joinPolicy: "deadline-best-effort",
      peerMessaging: "lead-only",
      branches: [
        { memberId: "source-review", branchId: "source-review", dependsOn: [], required: false },
        { statement: "Inspect review findings", dependsOn: ["source-review"], required: true },
      ],
    });
    expect(normalized.branches[1]).not.toHaveProperty("memberId");
    expect(normalizeTeamCreateRequest(normalized)).toEqual(normalized);
    expect(request).toEqual(copy);
  });

  it("publishes only schemas supported by local argument admission", () => {
    const { tool } = setup();
    expect(() => assertSupportedSchema(tool.definition.parameters)).not.toThrow();
    expect(tool.definition.parameters.properties).toHaveProperty("members");
    expect(tool.definition.parameters.properties?.branches).toMatchObject({ deprecated: true });
    expect(validateArguments(tool, { members: [{ statement: "Inspect auth" }] }).ok).toBe(true);
    expect(validateArguments(tool, { branches: [{ statement: "Inspect auth" }] }).ok).toBe(true);
    expect(validateArguments(tool, { members: [{ statement: "Inspect auth", tools: ["bash"] }] }).ok).toBe(false);
    expect(validateArguments(tool, { members: [{ statement: "Inspect auth", maxAttempts: MAX_TASK_ATTEMPTS + 1 }] }).ok).toBe(false);
    expect(tool.definition.description).toMatch(/Main remains Team Lead/);
    expect(tool.definition.description).toMatch(/partial.*not success/);
  });

  it.each([
    { statement: "Inspect auth", workspace: "/private" },
    { statement: "Inspect auth", maxAttempts: MAX_TASK_ATTEMPTS + 1 },
    { statement: "Inspect auth", dependsOn: ["missing"] },
  ])("strictly validates compact legacy member arguments before host side effects: %j", async (branch) => {
    const { tool, create } = setup();
    const request = { branches: [branch] };
    expect(validateArguments(tool, request).ok).toBe(true);
    expect((await tool.execute(request, context)).isError).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["missing collection", {}, "exactly one"],
    ["ambiguous collection", { members: [{ statement: "A" }], branches: [{ statement: "B" }] }, "exactly one"],
    ["empty collection", { members: [] }, "between 1 and 16"],
    ["oversized collection", { members: Array.from({ length: 17 }, () => ({ statement: "A" })) }, "between 1 and 16"],
    ["unknown root field", { members: [{ statement: "A" }], from: "main" }, "from"],
    ["unknown member field", { members: [{ statement: "A", workspace: "/private" }] }, "workspace"],
    ["nested task shorthand", { members: [{ task: { statement: "A" } }] }, "task"],
    ["conflicting aliases", { members: [{ memberId: "a", branchId: "b", statement: "A" }] }, "same member"],
    ["normalized id collision", { members: [{ memberId: "Source Review", statement: "A" }, { memberId: "source-review", statement: "B" }] }, "Duplicate Team member"],
    ["unknown dependency", { members: [{ memberId: "a", statement: "A", dependsOn: ["missing"] }] }, "Unknown dependency"],
    ["self dependency", { members: [{ memberId: "a", statement: "A", dependsOn: ["a"] }] }, "itself"],
    ["dependency cycle", { members: [{ memberId: "a", statement: "A", dependsOn: ["b"] }, { memberId: "b", statement: "B", dependsOn: ["a"] }] }, "cycle"],
    ["duplicate dependency", { members: [{ memberId: "a", statement: "A" }, { statement: "B", dependsOn: ["a", "A"] }] }, "duplicate members"],
    ["unnamed dependency target", { members: [{ statement: "A" }, { memberId: "b", statement: "B", dependsOn: ["a"] }] }, "explicit ids"],
    ["nonboolean required", { members: [{ statement: "A", required: "true" }] }, "boolean"],
    ["invalid join policy", { members: [{ statement: "A" }], joinPolicy: "any-success" }, "joinPolicy"],
    ["null join policy", { members: [{ statement: "A" }], joinPolicy: null }, "joinPolicy"],
    ["invalid messaging policy", { members: [{ statement: "A" }], peerMessaging: "everyone" }, "peerMessaging"],
    ["missing deadline", { members: [{ statement: "A" }], joinPolicy: "deadline-best-effort" }, "requires an absolute deadline"],
    ["relative deadline", { members: [{ statement: "A" }], deadline: "in 1 minute" }, "absolute ISO"],
    ["timezone-free deadline", { members: [{ statement: "A" }], deadline: "2026-09-07T12:00:00" }, "timezone"],
    ["invalid calendar date", { members: [{ statement: "A" }], deadline: "2026-02-30T12:00:00Z" }, "calendar date"],
    ["empty statement", { members: [{ statement: " " }] }, "non-empty"],
    ["oversized statement", { members: [{ statement: "a".repeat(4_097) }] }, "4096"],
    ["oversized criteria", { members: [{ statement: "A", successCriteria: Array.from({ length: 65 }, () => "x") }] }, "64 items"],
    ["oversized member id", { members: [{ memberId: "a".repeat(65), statement: "A" }] }, "64 characters"],
    ["reserved member id", { members: [{ memberId: "broadcast", statement: "A" }] }, "reserved"],
    ["invalid budget", { members: [{ statement: "A", maxModelTokens: 0 }] }, "positive integer"],
    ["fractional budget", { members: [{ statement: "A", maxWallClockMs: 1.5 }] }, "positive integer"],
    ["oversized token budget", { members: [{ statement: "A", maxModelTokens: MAX_TASK_MODEL_TOKENS + 1 }] }, "maxModelTokens"],
    ["oversized time budget", { members: [{ statement: "A", maxWallClockMs: MAX_TASK_WALL_CLOCK_MS + 1 }] }, "maxWallClockMs"],
    ["oversized attempt budget", { members: [{ statement: "A", maxAttempts: MAX_TASK_ATTEMPTS + 1 }] }, "maxAttempts"],
  ])("rejects %s before host side effects", async (_name, request, expected) => {
    const { tool, create } = setup();
    const result = await tool.execute(request as Record<string, unknown>, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain(expected);
    expect(create).not.toHaveBeenCalled();
    expect(() => normalizeTeamCreateRequest(request)).toThrow(expected);
  });
});

describe("Team lifecycle tools", () => {
  it("preserves host method binding and authenticated context for cancellation", async () => {
    const { control } = setup();
    control.cancel = async function (request, executionContext) {
      expect(this).toBe(control);
      expect(executionContext).toBe(context);
      expect(request).toEqual({ teamId: "review", reason: "No longer needed" });
      return { teamId: request.teamId, status: "cancelled" };
    };
    const tool = createTeamCancelTool(control);
    expect(validateArguments(tool, { teamId: "review", reason: "No longer needed" }).ok).toBe(true);
    const result = await tool.execute({ teamId: "review", reason: "No longer needed" }, context);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({ teamId: "review", status: "cancelled" });
  });

  it("surfaces host ownership and lifecycle failures without claiming success", async () => {
    const { control } = setup({
      cancel: async (_request, executionContext) => {
        if (executionContext.runId !== "run-1") throw new Error("Team capability is bound to another Run");
        throw new Error("Team does not exist");
      },
      reduce: async () => { throw new Error("Team has not joined"); },
      present: async () => { throw new Error("Reducer is still running"); },
    });
    const cancelled = await createTeamCancelTool(control).execute({ teamId: "review" }, { ...context, runId: "run-2" });
    expect(cancelled.isError).toBe(true);
    expect(cancelled.content).toContain("another Run");
    const unknown = await createTeamCancelTool(control).execute({ teamId: "unknown" }, context);
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain("does not exist");
    const reduced = await createTeamReduceTool(control).execute({ teamId: "review" }, context);
    expect(reduced.isError).toBe(true);
    expect(reduced.content).toContain("not joined");
    const presented = await createTeamPresentTool(control).execute({ teamId: "review", disposition: "accepted" }, context);
    expect(presented.isError).toBe(true);
    expect(presented.content).toContain("still running");
  });

  it("admits optional reduction and explicit Main decisions using supported schemas", async () => {
    const reduce = vi.fn(async () => ({ status: "queued" }));
    const present = vi.fn(async () => ({ disposition: "rejected" }));
    const { control } = setup({ reduce, present });
    const reduceTool = createTeamReduceTool(control);
    const presentTool = createTeamPresentTool(control);
    const request = { teamId: "review", statement: "Resolve conflicting findings", maxModelTokens: 2_000, maxWallClockMs: 10_000 };
    expect(() => assertSupportedSchema(reduceTool.definition.parameters)).not.toThrow();
    expect(() => assertSupportedSchema(presentTool.definition.parameters)).not.toThrow();
    expect(validateArguments(reduceTool, request).ok).toBe(true);
    expect(validateArguments(presentTool, { teamId: "review", disposition: "rejected" }).ok).toBe(true);
    expect((await reduceTool.execute(request, context)).isError).toBe(false);
    expect(reduce).toHaveBeenCalledWith(request, context);
    expect((await presentTool.execute({ teamId: "review", disposition: "rejected" }, context)).isError).toBe(false);
    expect(present).toHaveBeenCalledWith({ teamId: "review", disposition: "rejected" }, context);
  });

  it("rejects spoofed identities and malformed lifecycle arguments before dispatch", async () => {
    const cancel = vi.fn();
    const reduce = vi.fn();
    const present = vi.fn();
    const { control } = setup({ cancel, reduce, present });
    expect((await createTeamCancelTool(control).execute({ teamId: "review", from: "main" }, context)).isError).toBe(true);
    expect((await createTeamCancelTool(control).execute({ teamId: "review", reason: "\0" }, context)).isError).toBe(true);
    expect((await createTeamReduceTool(control).execute({ teamId: "review", maxModelTokens: MAX_TASK_MODEL_TOKENS + 1 }, context)).isError).toBe(true);
    expect((await createTeamPresentTool(control).execute({ teamId: "review", disposition: "completed" }, context)).isError).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    expect(reduce).not.toHaveBeenCalled();
    expect(present).not.toHaveBeenCalled();
  });

  it("requires each lifecycle capability to be supplied by the host", () => {
    const { control } = setup();
    expect(() => createTeamCancelTool(control)).toThrow("provide cancel");
    expect(() => createTeamReduceTool(control)).toThrow("provide reduce");
    expect(() => createTeamPresentTool(control)).toThrow("provide present");
    expect(() => createTeamStatusTool(control)).toThrow("provide status");
  });

  it("returns board facts without allowing status calls to carry commands", async () => {
    const status = vi.fn(async () => [{ teamId: "review", join: "joined", reduction: "not-started", presentation: "pending" }]);
    const { control } = setup({ status });
    const tool = createTeamStatusTool(control);
    expect(() => assertSupportedSchema(tool.definition.parameters)).not.toThrow();
    expect((await tool.execute({}, context)).isError).toBe(false);
    expect(status).toHaveBeenCalledWith(context);
    expect(tool.definition.description).toMatch(/without proving success/);
    expect((await tool.execute({ disposition: "accepted" }, context)).isError).toBe(true);
    expect(status).toHaveBeenCalledTimes(1);
  });
});
