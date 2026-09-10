import { describe, expect, it, vi } from "vitest";

import type { ToolExecutionContext } from "../../src/domain/ports.js";
import type { TaskRequest } from "../../src/domain/types.js";
import { MAX_TASK_ATTEMPTS, MAX_TASK_MODEL_TOKENS, MAX_TASK_WALL_CLOCK_MS } from "../../src/domain/types.js";
import { assertSupportedSchema, validateArguments } from "../../src/mowe/admission.js";
import type { TeamBoard } from "../../src/runtime/team-board.js";
import {
  createTeamCancelTool,
  createTeamAssignTool,
  createTeamCloseTool,
  createTeamHistoryTool,
  createTeamMessageTool,
  createTeamPresentTool,
  createTeamReduceTool,
  createTeamStatusTool,
  createTeamTool,
  createTaskWaitTool,
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

function statusBoard(): TeamBoard {
  const goal = { version: 1, statement: "Inspect auth", successCriteria: ["Report evidence"], hardConstraints: [] };
  const budget = { maxModelTokens: 30_000, maxWallClockMs: 120_000, maxAttempts: 6, deadline: "2026-09-07T12:00:00Z" };
  const parent = { workspaceId: "workspace", sessionId: "session", runId: "run-1", laneId: "main", laneKind: "main" as const };
  const child = { ...parent, laneId: "team:review:security", laneKind: "team" as const };
  const tools = [{ kind: "tool" as const, name: "read_file", description: "spawn-only-marker".repeat(2_000) }];
  const task: TaskRequest = {
    type: "task.request", taskId: "review:security", goal, inputRefs: [], budget,
    spawnContext: {
      schemaVersion: 1, parent, child, goal, inputRefs: [], projectInstructionRefs: [], parentSummaryRefs: [],
      tools, skills: [], laneManifest: { schemaVersion: 1, lane: child, role: "security", state: "running", capabilities: tools }, budget,
    },
  };
  const definition = { memberId: "security", laneId: child.laneId, task, dependsOn: [], required: true };
  const member: TeamBoard["members"][number] = {
    teamId: "review", memberId: "security", branchId: "security", laneId: child.laneId, taskId: task.taskId,
    requestMessageId: "request-security", coordinator: "main", goal, inputRefs: [], budget, dependsOn: [], required: true,
    registered: true, laneStatus: "running", execution: "running", status: "running", terminal: false,
    attempt: 1, lease: { claimId: "claim-security", claimedBy: child.laneId, claimedAt: "2026-09-07T11:59:00Z", attempt: 1 },
    acceptedMessageId: "accept-security", lastOffset: 42, anomalies: [],
  };
  return {
    runId: "run-1", teamId: "review", leadLaneId: "main", coordinator: "main",
    definition: { teamId: "review", leadLaneId: "main", joinPolicy: "all-terminal", peerMessaging: "team-members",
      deadline: budget.deadline, fingerprint: "fingerprint-review", members: [definition] },
    joinPolicy: "all-terminal", status: "running", joinReady: false, joinSatisfied: false, joinState: "waiting",
    cancellationRequested: false, lifecycleState: "open", reductionState: "not-started", presentationState: "pending",
    members: [member], branches: [member], anomalies: [], lastOffset: 42,
  };
}

describe("Team tool creation contract", () => {
  it("keeps public channel, history, and close operations small and bounded", async () => {
    const message = vi.fn(async () => ({
      status: "sent" as const, messageId: "event-1", teamId: "review", channelId: "general",
      sequence: 1, fromLane: "main", body: "hello", mentions: [], artifactRefs: [], cursor: "tc1-cursor",
    }));
    const history = vi.fn(async () => ({ teamId: "review", channelId: "general", messages: [], hasMore: false }));
    const close = vi.fn(async () => ({ teamId: "review", status: "closed" as const }));
    const control: TeamControl = { create: vi.fn(async () => ({ teamId: "review", branches: [] })), message, history, close };
    const messageTool = createTeamMessageTool(control);
    const historyTool = createTeamHistoryTool(control);
    const closeTool = createTeamCloseTool(control);
    expect((await messageTool.execute({ teamId: "review", body: "hello", mentions: ["security"] }, context)).isError).toBe(false);
    expect(message).toHaveBeenCalledWith(expect.objectContaining({ teamId: "review", body: "hello", mentions: ["security"] }), context);
    expect((await historyTool.execute({ teamId: "review", limit: 64 }, context)).isError).toBe(false);
    expect((await closeTool.execute({ teamId: "review", reason: "done" }, context)).isError).toBe(false);
    expect(() => messageTool.definition.parameters?.properties?.body).not.toBeUndefined();
  });

  it("preserves lead aliases and full lane addresses in group mentions", async () => {
    const message = vi.fn(async () => ({
      status: "sent" as const, messageId: "group-mention", teamId: "review", channelId: "general",
      sequence: 1, fromLane: "main", body: "Review this", mentions: [], artifactRefs: [], cursor: "tc1-cursor",
    }));
    const tool = createTeamMessageTool({ create: vi.fn(), message });
    for (const address of ["nausicaa", "main", "security", "team:review:security"]) {
      const args = { teamId: "review", body: "Review this", mentions: [` ${address} `] };
      expect(validateArguments(tool, args).ok).toBe(true);
      expect((await tool.execute(args, context)).isError).toBe(false);
      expect(message).toHaveBeenLastCalledWith(expect.objectContaining({ mentions: [address] }), context);
    }
    for (const mentions of [[" "], ["x".repeat(513)], ["security", " security "]]) {
      expect((await tool.execute({ teamId: "review", body: "Review this", mentions }, context)).isError).toBe(true);
    }
    expect(message).toHaveBeenCalledTimes(4);
  });

  it("exposes member admission and assignment without model-owned budgets", async () => {
    const assign = vi.fn(async () => ({ teamId: "review", taskId: "review:security:task-1", memberId: "security", laneId: "team:review:security", assignmentVersion: 1, status: "queued" as const }));
    const wait = vi.fn(async () => ({ teamId: "review", taskId: "review:security:task-1", status: "waiting", waiting: true }));
    const control: TeamControl = { create: vi.fn(async () => ({ teamId: "review", branches: [] })), assign, wait };
    const assignTool = createTeamAssignTool(control);
    const waitTool = createTaskWaitTool(control);
    expect(validateArguments(assignTool, { teamId: "review", memberId: "security", statement: "Continue review" }).ok).toBe(true);
    expect(validateArguments(assignTool, { teamId: "review", memberId: "security", statement: "Continue review", maxModelTokens: 1 }).ok).toBe(false);
    expect((await assignTool.execute({ teamId: "review", memberId: "security", statement: "Continue review" }, context)).isError).toBe(false);
    expect((await waitTool.execute({ teamId: "review", taskId: "review:security:task-1" }, context)).isError).toBe(false);
    expect(assign).toHaveBeenCalledWith({ teamId: "review", memberId: "security", statement: "Continue review" }, context);
    const capabilities = { tools: ["read_file"], allowNestedTeam: false };
    expect((await assignTool.execute({ teamId: "review", memberId: "reviewer", statement: "Review the completed files", input: "Read index.html", capabilities }, context)).isError).toBe(false);
    expect(assign).toHaveBeenLastCalledWith({ teamId: "review", memberId: "reviewer", statement: "Review the completed files", input: "Read index.html", capabilities }, context);
    expect(validateArguments(assignTool, { teamId: "review", memberId: "reviewer", statement: "Review", dependsOn: ["security"] }).ok).toBe(false);
  });

  it.each(["members", "branches"])("rejects dependency scheduling through the %s model contract", async (field) => {
    const { tool, create } = setup();
    const request = { [field]: [
      { memberId: "builder", statement: "Build the page" },
      { memberId: "reviewer", statement: "Review the page", dependsOn: ["builder"] },
    ] };
    const result = await tool.execute(request, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("team_assign after its inputs are ready");
    expect(create).not.toHaveBeenCalled();
    if (field === "members") expect(validateArguments(tool, request).ok).toBe(false);
  });

  it("canonicalizes members and legacy branches to the same bounded request", async () => {
    const { tool, create } = setup();
    const common = { statement: "Inspect auth" };
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
        successCriteria: [],
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
    expect(tool.definition.description).toMatch(/You own synthesis and acceptance/);
    expect(tool.definition.description).toMatch(/partial.*not success/);
  });

  it("accepts an explicit capability narrowing grant", () => {
    const normalized = normalizeTeamCreateRequest({
      members: [{
        memberId: "reviewer",
        statement: "Review the change",
        capabilities: { tools: ["read_file"], allowNestedTeam: false },
      }],
    });
    expect(normalized.branches[0]?.capabilities).toEqual({
      tools: ["read_file"], allowNestedTeam: false,
    });
    expect(() => normalizeTeamCreateRequest({
      members: [{ memberId: "reviewer", statement: "Review", capabilities: { tools: ["bad tool"] } }],
    })).toThrow(/tool name/);
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
    ["nonboolean required", { members: [{ statement: "A", required: "true" }] }, "boolean"],
    ["invalid join policy", { members: [{ statement: "A" }], joinPolicy: "any-success" }, "joinPolicy"],
    ["null join policy", { members: [{ statement: "A" }], joinPolicy: null }, "joinPolicy"],
    ["invalid messaging policy", { members: [{ statement: "A" }], peerMessaging: "everyone" }, "peerMessaging"],
    ["empty statement", { members: [{ statement: " " }] }, "non-empty"],
    ["oversized statement", { members: [{ statement: "a".repeat(4_097) }] }, "4096"],
    ["oversized member id", { members: [{ memberId: "a".repeat(65), statement: "A" }] }, "64 characters"],
    ["reserved member id", { members: [{ memberId: "broadcast", statement: "A" }] }, "reserved"],
    ["reserved root role", { members: [{ memberId: "Nausicaa", statement: "A" }] }, "reserved"],
    ["reserved legacy root role", { members: [{ memberId: "main", statement: "A" }] }, "reserved"],
    ["reserved observer role", { members: [{ memberId: "teto", statement: "A" }] }, "reserved"],
    ["removed success criteria", { members: [{ statement: "A", successCriteria: ["Report evidence"] }] }, "not supported"],
    ["removed model token budget", { members: [{ statement: "A", maxModelTokens: 1_000 }] }, "not supported"],
    ["removed wall clock budget", { members: [{ statement: "A", maxWallClockMs: 1_000 }] }, "not supported"],
    ["removed attempt budget", { members: [{ statement: "A", maxAttempts: 1 }] }, "not supported"],
    ["removed Team deadline", { members: [{ statement: "A" }], deadline: "2026-09-07T12:00:00Z" }, "not supported"],
    ["removed join policy", { members: [{ statement: "A" }], joinPolicy: "all-terminal" }, "not supported"],
  ])("rejects %s before host side effects", async (_name, request, expected) => {
    const { tool, create } = setup();
    const result = await tool.execute(request as Record<string, unknown>, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain(expected);
    expect(create).not.toHaveBeenCalled();
    if (expected !== "not supported") expect(() => normalizeTeamCreateRequest(request)).toThrow(expected);
  });

  it.each([
    [{ members: [{ memberId: "a", statement: "A", dependsOn: ["missing"] }] }, "Unknown dependency"],
    [{ members: [{ memberId: "a", statement: "A", dependsOn: ["a"] }] }, "itself"],
    [{ members: [{ memberId: "a", statement: "A", dependsOn: ["b"] }, { memberId: "b", statement: "B", dependsOn: ["a"] }] }, "cycle"],
    [{ members: [{ memberId: "a", statement: "A" }, { statement: "B", dependsOn: ["a", "A"] }] }, "duplicate members"],
    [{ members: [{ statement: "A" }, { memberId: "b", statement: "B", dependsOn: ["a"] }] }, "explicit ids"],
  ])("still validates dependency facts supplied by legacy host callers", (request, expected) => {
    expect(() => normalizeTeamCreateRequest(request)).toThrow(expected as string);
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
    const request = { teamId: "review", statement: "Resolve conflicting findings" };
    expect(() => assertSupportedSchema(reduceTool.definition.parameters)).not.toThrow();
    expect(() => assertSupportedSchema(presentTool.definition.parameters)).not.toThrow();
    expect(validateArguments(reduceTool, request).ok).toBe(true);
    expect(validateArguments(presentTool, { teamId: "review", disposition: "rejected" }).ok).toBe(true);
    expect((await reduceTool.execute(request, context)).isError).toBe(false);
    expect(reduce).toHaveBeenCalledWith(request, context);
    expect((await presentTool.execute({ teamId: "review", disposition: "rejected" }, context)).isError).toBe(false);
    expect(present).toHaveBeenCalledWith({ teamId: "review", disposition: "rejected" }, context);
  });

  it("rejects removed reducer budget controls before dispatch", async () => {
    const reduce = vi.fn();
    const { control } = setup({ reduce });
    const tool = createTeamReduceTool(control);
    expect(validateArguments(tool, { teamId: "review", maxAttempts: 1 }).ok).toBe(false);
    expect((await tool.execute({ teamId: "review", maxAttempts: 1 }, context)).isError).toBe(true);
    expect(reduce).not.toHaveBeenCalled();
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
    const legacy = [{ teamId: "review", join: "joined", reduction: "not-started", presentation: "pending" }];
    const status = vi.fn(async () => legacy);
    const { control } = setup({ status });
    const tool = createTeamStatusTool(control);
    expect(() => assertSupportedSchema(tool.definition.parameters)).not.toThrow();
    const result = await tool.execute({}, context);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual(legacy);
    expect(status).toHaveBeenCalledWith(context);
    expect(tool.definition.description).toMatch(/without proving success/);
    expect((await tool.execute({ disposition: "accepted" }, context)).isError).toBe(true);
    expect(status).toHaveBeenCalledTimes(1);
  });

  it.each(["envelope", "array"] as const)("projects a compact status from a host %s without changing its board", async (shape) => {
    const board = statusBoard();
    board.reducer = { ...board.definition!.members[0]!, memberId: "reducer", laneId: "team:review:reducer",
      task: { ...board.definition!.members[0]!.task, taskId: "review:reducer" } };
    board.reductionState = "running";
    const original = structuredClone(board);
    const payload = shape === "envelope" ? { teams: [board] } : [board];
    const { control } = setup();
    control.status = async function (executionContext) {
      expect(this).toBe(control);
      expect(executionContext).toBe(context);
      return payload;
    };

    const response = await createTeamStatusTool(control).execute({}, context);
    expect(response.isError).toBe(false);
    expect(response.content.includes("spawn-only-marker")).toBe(false);
    expect(Buffer.byteLength(response.content)).toBeLessThan(2_000);
    const parsed = JSON.parse(response.content);
    const status = shape === "envelope" ? parsed.teams[0] : parsed[0];
    expect(status).toMatchObject({
      runId: "run-1", teamId: "review", leadLaneId: "nausicaa", leadName: "Nausicaa", joinPolicy: "all-terminal",
      deadline: board.definition!.deadline, peerMessaging: "team-members",
      status: "running", joinReady: false, joinSatisfied: false, joinState: "waiting",
      cancellationRequested: false, reductionState: "running", presentationState: "pending", lastOffset: 42,
      members: [{ memberId: "security", name: "security", laneId: "team:review:security", taskId: "review:security",
        statement: "Inspect auth", status: "running", execution: "running", laneStatus: "running", terminal: false,
        registered: true, attempt: 1, required: true, anomalies: [] }],
      reducer: { memberId: "reducer", name: "reducer", laneId: "team:review:reducer", taskId: "review:reducer", statement: "Inspect auth" },
    });
    for (const field of ["definition", "branches"]) expect(status).not.toHaveProperty(field);
    for (const field of ["branchId", "lease", "requestMessageId", "acceptedMessageId", "dependsOn"]) {
      expect(status.members[0]).not.toHaveProperty(field);
    }
    expect(status.reducer).not.toHaveProperty("task");
    expect(board).toEqual(original);
  });

  it.each(["joined", "deadline-settled", "cancelled"] as const)("retains result evidence, failures and lead decisions for %s Teams", async (joinState) => {
    const board = statusBoard();
    const result = {
      type: "task.result" as const, taskId: "review:security", status: "partial" as const, summary: "Auth reviewed; policy remains unresolved",
      evidenceRefs: ["sha256:evidence"], artifactRefs: [{ id: "report", contentHash: "sha256:report", mediaType: "text/plain", byteLength: 10 }],
      openQuestions: ["Confirm the access policy"], usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
    };
    const failure = { type: "task.failed" as const, taskId: "review:policy", reason: "Policy input missing", retryable: false, evidenceRefs: ["sha256:missing"] };
    board.members = [
      { ...board.members[0]!, laneStatus: "completed", execution: "terminal", status: "partial", outcome: "partial", terminal: true, result },
      { ...board.members[0]!, memberId: "policy", branchId: "policy", laneId: "team:review:policy", taskId: "review:policy",
        dependsOn: ["security"], required: false, laneStatus: "failed", execution: "terminal", status: "failed", outcome: "failed", terminal: true,
        failure, reason: "Policy input missing", anomalies: ["Policy evidence unavailable"] },
    ];
    board.branches = board.members;
    board.joinPolicy = joinState === "deadline-settled" ? "deadline-best-effort" : "all-terminal";
    board.joinState = joinState;
    board.joinReady = joinState !== "cancelled";
    board.joinSatisfied = joinState !== "cancelled";
    board.cancellationRequested = joinState === "cancelled";
    board.status = joinState === "cancelled" ? "cancelled" : "failed";
    board.reductionState = "failed";
    board.reduction = { outcome: "failed", failure: { ...failure, taskId: "review:reducer" } };
    board.presentationState = "rejected";
    board.anomalies = ["Some required evidence is unavailable"];
    const { control } = setup({ status: async () => ({ teams: [board] }) });

    const response = await createTeamStatusTool(control).execute({}, context);
    expect(response.isError).toBe(false);
    const status = JSON.parse(response.content).teams[0];
    expect(status).toMatchObject({
      status: board.status, joinPolicy: board.joinPolicy, joinState, joinReady: board.joinReady, joinSatisfied: board.joinSatisfied,
      cancellationRequested: board.cancellationRequested, reductionState: "failed", reduction: board.reduction,
      presentationState: "rejected", anomalies: board.anomalies,
    });
    expect(status.members[0].result).toEqual(result);
    expect(status.members[0]).toMatchObject({ status: "partial", outcome: "partial", terminal: true });
    expect(status.members[1]).toMatchObject({
      status: "failed", outcome: "failed", failure, reason: "Policy input missing", required: false,
      anomalies: ["Policy evidence unavailable"],
    });
  });

  it("projects older branch-only boards to canonical member identities", async () => {
    const legacy = { teamId: "legacy", coordinator: "main", status: "queued", branches: [
      { branchId: "reader", laneId: "team:legacy:reader", taskId: "legacy:reader", status: "queued", terminal: false },
    ] };
    const { control } = setup({ status: async () => ({ teams: [legacy] }) });
    const response = await createTeamStatusTool(control).execute({}, context);
    expect(response.isError).toBe(false);
    const status = JSON.parse(response.content).teams[0];
    expect(status).toMatchObject({ teamId: "legacy", leadLaneId: "nausicaa", leadName: "Nausicaa", status: "queued", members: [
      { memberId: "reader", name: "reader", laneId: "team:legacy:reader", taskId: "legacy:reader", status: "queued", terminal: false },
    ] });
    expect(status).not.toHaveProperty("branches");
    expect(legacy).not.toHaveProperty("members");
  });
});
