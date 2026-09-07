import type { AgentTool, JsonSchema, ToolExecutionContext, ToolResult } from "../domain/ports.js";
import type { Goal } from "../domain/types.js";
import { MAX_TASK_ATTEMPTS, MAX_TASK_MODEL_TOKENS, MAX_TASK_WALL_CLOCK_MS } from "../domain/types.js";
import { annotateTool } from "../mowe/catalog.js";
import { MAX_SUBAGENT_NAME_LENGTH, normalizeSubagentName } from "./subagent-policy.js";

export interface TeamMemberRequest {
  memberId?: string;
  /** Compatibility alias for memberId. */
  branchId?: string;
  statement: string;
  successCriteria?: string[];
  hardConstraints?: string[];
  input?: string;
  maxModelTokens?: number;
  maxWallClockMs?: number;
  maxAttempts?: number;
  dependsOn?: string[];
  required?: boolean;
}

export type TeamBranchRequest = TeamMemberRequest;

interface TeamCreateOptions {
  teamId?: string;
  joinPolicy?: "all-terminal" | "deadline-best-effort";
  deadline?: string;
  peerMessaging?: "team-members" | "lead-only";
}

export type TeamCreateRequest = TeamCreateOptions & (
  | { members: TeamMemberRequest[]; branches?: never }
  | { branches: TeamBranchRequest[]; members?: never }
);

/** Internal compatibility shape; aliases and policy defaults are canonicalized. */
export interface NormalizedTeamCreateRequest extends TeamCreateOptions {
  branches: (TeamMemberRequest & { dependsOn: string[]; required: boolean })[];
  joinPolicy: "all-terminal" | "deadline-best-effort";
  peerMessaging: "team-members" | "lead-only";
}

export interface TeamCreateResult {
  teamId: string;
  /** Optional on older host controls; current coordinators return both collections. */
  members?: readonly {
    memberId: string;
    taskId: string;
    laneId: string;
    status: "queued" | "duplicate";
  }[];
  branches: readonly {
    branchId: string;
    laneId: string;
    status: "queued" | "duplicate";
  }[];
}

export interface TeamCancelRequest {
  teamId: string;
  reason?: string;
}

export interface TeamReduceRequest {
  teamId: string;
  statement?: string;
  maxModelTokens?: number;
  maxWallClockMs?: number;
}

export interface TeamPresentRequest {
  teamId: string;
  disposition: "accepted" | "rejected";
}

export interface TeamControl {
  create(
    request: TeamCreateRequest,
    context: ToolExecutionContext,
  ): Promise<TeamCreateResult>;
  status?(context: ToolExecutionContext): unknown | Promise<unknown>;
  cancel?(request: TeamCancelRequest, context: ToolExecutionContext): unknown | Promise<unknown>;
  reduce?(request: TeamReduceRequest, context: ToolExecutionContext): unknown | Promise<unknown>;
  present?(request: TeamPresentRequest, context: ToolExecutionContext): unknown | Promise<unknown>;
}

/** Main-facing read-only capability for the durable Team board projection. */
export function createTeamStatusTool(control: TeamControl): AgentTool {
  if (control === null || typeof control !== "object" || typeof control.status !== "function") {
    throw new TypeError("Team status control must provide status");
  }
  const tool: AgentTool = {
    definition: {
      name: "team_status",
      description: "Read durable Team members, outcomes, join, reduction, and Main acceptance in this Run. Join follows the declared policy automatically; it collects terminal outcomes, including partial or failed work, without proving success or completing Main's synthesis.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    async execute(arguments_, context): Promise<ToolResult> {
      try {
        exactKeys(object(arguments_, "arguments"), [], "arguments");
        return {
          content: JSON.stringify(await control.status!(context)),
          isError: false,
        };
      } catch (error: unknown) {
        return {
          content: JSON.stringify({
            error: error instanceof Error ? error.message : "Team status failed",
          }),
          isError: true,
        };
      }
    },
  };
  return annotateTool(tool, {
    effect: "read",
    deterministic: true,
    supportsBatch: false,
    concurrencySafe: true,
    scope: "run",
    inputKinds: ["json"],
    outputKinds: ["json"],
  });
}

const MAX_MEMBERS = 16;
const MAX_STRING_LENGTH = 4_096;
const MAX_CRITERIA = 64;
const MAX_TEAM_ID_LENGTH = 96;

const boundedText = { type: "string", minLength: 1, maxLength: MAX_STRING_LENGTH };
const teamIdSchema = { type: "string", minLength: 1, maxLength: MAX_TEAM_ID_LENGTH };
const memberIdSchema = { type: "string", minLength: 1, maxLength: MAX_SUBAGENT_NAME_LENGTH };
const modelTokenSchema = { type: "integer", minimum: 1, maximum: MAX_TASK_MODEL_TOKENS };
const wallClockSchema = { type: "integer", minimum: 1, maximum: MAX_TASK_WALL_CLOCK_MS };

function memberSchema(): Record<string, unknown> {
  return {
    type: "array",
    minItems: 1,
    maxItems: MAX_MEMBERS,
    items: {
      type: "object",
      properties: {
        memberId: { ...memberIdSchema, description: "Stable member id; required when another member depends on this task" },
        branchId: { ...memberIdSchema, deprecated: true, description: "Compatibility alias for memberId" },
        statement: { ...boundedText, description: "This member's objective" },
        successCriteria: { type: "array", maxItems: MAX_CRITERIA, items: boundedText },
        hardConstraints: { type: "array", maxItems: MAX_CRITERIA, items: boundedText },
        input: boundedText,
        maxModelTokens: modelTokenSchema,
        maxWallClockMs: wallClockSchema,
        maxAttempts: { type: "integer", minimum: 1, maximum: MAX_TASK_ATTEMPTS },
        dependsOn: { type: "array", maxItems: MAX_MEMBERS - 1, items: memberIdSchema, description: "Member ids whose tasks must succeed before this task can start" },
        required: { type: "boolean", default: true, description: "Whether this member is required at the Team join boundary" },
      },
      required: ["statement"],
      additionalProperties: false,
    },
  };
}

/** Main-facing capability for creating several independent task lanes. */
export function createTeamTool(control: TeamControl): AgentTool {
  if (control === null || typeof control !== "object" || typeof control.create !== "function") {
    throw new TypeError("Team control must provide create");
  }
  const tool: AgentTool = {
    definition: {
      name: "team_create",
      description: "Create a bounded Team of independent Teammate lanes with tasks and optional dependencies. Supply members; branches is a compatibility alias, and exactly one is required. Results and join notifications arrive asynchronously at Main boundaries. Main remains Team Lead and synthesizes the results; partial or failed outcomes are not success.",
      parameters: {
        type: "object",
        properties: {
          teamId: { ...teamIdSchema, description: "Stable id for retrying or recognizing this Team" },
          members: memberSchema(),
          branches: {
            type: "array",
            minItems: 1,
            maxItems: MAX_MEMBERS,
            items: { type: "object" },
            deprecated: true,
            description: "Legacy members alias with identical fields and validation; never supply both",
          },
          joinPolicy: { type: "string", enum: ["all-terminal", "deadline-best-effort"], default: "all-terminal" },
          deadline: { ...boundedText, description: "Absolute ISO timestamp with timezone; required for deadline-best-effort" },
          peerMessaging: { type: "string", enum: ["team-members", "lead-only"], default: "team-members" },
        },
        additionalProperties: false,
      },
    },
    async execute(arguments_, context): Promise<ToolResult> {
      try {
        const request = parseTeamRequest(arguments_);
        return {
          content: JSON.stringify(await control.create(request, context)),
          isError: false,
        };
      } catch (error: unknown) {
        return {
          content: JSON.stringify({ error: error instanceof Error ? error.message : "Team creation failed" }),
          isError: true,
        };
      }
    },
  };
  return annotateTool(tool, {
    effect: "external",
    deterministic: false,
    supportsBatch: false,
    concurrencySafe: false,
    scope: "run",
    inputKinds: ["json", "text", "artifact"],
    outputKinds: ["json"],
  });
}

export function createTeamCancelTool(control: TeamControl): AgentTool {
  if (control === null || typeof control !== "object" || typeof control.cancel !== "function") {
    throw new TypeError("Team cancel control must provide cancel");
  }
  return createTeamCommand(
    "team_cancel",
    "Cancel a Team's unfinished work and persist cancellation. Completed outcomes remain available; late member results cannot reopen cancelled work. Main still owns the final response.",
    { teamId: teamIdSchema, reason: boundedText },
    ["teamId"],
    (arguments_, context) => {
      exactKeys(arguments_, ["teamId", "reason"], "arguments");
      const reason = optionalString(arguments_.reason, "reason");
      return control.cancel!({
        teamId: normalizeTeamId(arguments_.teamId),
        ...(reason === undefined ? {} : { reason }),
      }, context);
    },
  );
}

export function createTeamReduceTool(control: TeamControl): AgentTool {
  if (control === null || typeof control !== "object" || typeof control.reduce !== "function") {
    throw new TypeError("Team reduce control must provide reduce");
  }
  return createTeamCommand(
    "team_reduce",
    "Explicitly schedule an optional, bounded read-only Reducer lane after the Team joins. Use it when synthesis benefits from another lane; Main is the default synthesizer and must accept or reject the reduction before presenting the final answer.",
    { teamId: teamIdSchema, statement: boundedText, maxModelTokens: modelTokenSchema, maxWallClockMs: wallClockSchema },
    ["teamId"],
    (arguments_, context) => {
      exactKeys(arguments_, ["teamId", "statement", "maxModelTokens", "maxWallClockMs"], "arguments");
      const statement = optionalString(arguments_.statement, "statement");
      return control.reduce!({
        teamId: normalizeTeamId(arguments_.teamId),
        ...(statement === undefined ? {} : { statement }),
        ...(arguments_.maxModelTokens === undefined ? {} : { maxModelTokens: positiveInteger(arguments_.maxModelTokens, "maxModelTokens", MAX_TASK_MODEL_TOKENS) }),
        ...(arguments_.maxWallClockMs === undefined ? {} : { maxWallClockMs: positiveInteger(arguments_.maxWallClockMs, "maxWallClockMs", MAX_TASK_WALL_CLOCK_MS) }),
      }, context);
    },
  );
}

export function createTeamPresentTool(control: TeamControl): AgentTool {
  if (control === null || typeof control !== "object" || typeof control.present !== "function") {
    throw new TypeError("Team presentation control must provide present");
  }
  return createTeamCommand(
    "team_present",
    "Record Main's acceptance or rejection of joined Team results after any requested reduction has settled. This records the Lead's decision; Main still writes the user-facing synthesis, and acceptance does not turn partial or failed tasks into successful ones.",
    { teamId: teamIdSchema, disposition: { type: "string", enum: ["accepted", "rejected"] } },
    ["teamId", "disposition"],
    (arguments_, context) => {
      exactKeys(arguments_, ["teamId", "disposition"], "arguments");
      return control.present!({
        teamId: normalizeTeamId(arguments_.teamId),
        disposition: oneOf(arguments_.disposition, ["accepted", "rejected"], "disposition"),
      }, context);
    },
  );
}

function createTeamCommand(
  name: string,
  description: string,
  properties: NonNullable<JsonSchema["properties"]>,
  required: string[],
  invoke: (arguments_: Record<string, unknown>, context: ToolExecutionContext) => unknown | Promise<unknown>,
): AgentTool {
  return annotateTool({
    definition: {
      name,
      description,
      parameters: { type: "object", properties, required, additionalProperties: false },
    },
    async execute(arguments_, context): Promise<ToolResult> {
      try {
        return { content: JSON.stringify(await invoke(object(arguments_, "arguments"), context)), isError: false };
      } catch (error: unknown) {
        return {
          content: JSON.stringify({ error: error instanceof Error ? error.message : `${name} failed` }),
          isError: true,
        };
      }
    },
  }, {
    effect: "external",
    deterministic: false,
    supportsBatch: false,
    concurrencySafe: false,
    scope: "run",
    inputKinds: ["json"],
    outputKinds: ["json"],
  });
}

/** Shared tool/direct-runtime validation, performed before admission side effects. */
export function normalizeTeamCreateRequest(value: unknown): NormalizedTeamCreateRequest {
  const arguments_ = object(value, "arguments");
  exactKeys(arguments_, ["teamId", "members", "branches", "joinPolicy", "deadline", "peerMessaging"], "arguments");
  const hasMembers = Object.hasOwn(arguments_, "members");
  const hasBranches = Object.hasOwn(arguments_, "branches");
  if (hasMembers === hasBranches) throw new TypeError("Supply exactly one of members or branches");
  const field = hasMembers ? "members" : "branches";
  const members = arguments_[field];
  if (!Array.isArray(members) || members.length < 1 || members.length > MAX_MEMBERS) {
    throw new RangeError(`${field} must contain between 1 and ${MAX_MEMBERS} items`);
  }
  const branches = Array.from(members, (member, index) => parseMember(member, `${field}[${index}]`));
  validateDependencies(branches);
  const teamId = arguments_.teamId === undefined ? undefined : normalizeTeamId(arguments_.teamId);
  const joinPolicy = oneOf(arguments_.joinPolicy === undefined ? "all-terminal" : arguments_.joinPolicy, ["all-terminal", "deadline-best-effort"], "joinPolicy");
  const peerMessaging = oneOf(arguments_.peerMessaging === undefined ? "team-members" : arguments_.peerMessaging, ["team-members", "lead-only"], "peerMessaging");
  const deadline = arguments_.deadline === undefined ? undefined : isoDeadline(arguments_.deadline);
  if (joinPolicy === "deadline-best-effort" && deadline === undefined) {
    throw new TypeError("deadline-best-effort requires an absolute deadline");
  }
  return {
    ...(teamId === undefined ? {} : { teamId }),
    branches,
    joinPolicy,
    peerMessaging,
    ...(deadline === undefined ? {} : { deadline }),
  };
}

export const parseTeamRequest = normalizeTeamCreateRequest;

function parseMember(value: unknown, path: string): NormalizedTeamCreateRequest["branches"][number] {
  const item = object(value, path);
  exactKeys(item, ["memberId", "branchId", "statement", "successCriteria", "hardConstraints", "input", "maxModelTokens", "maxWallClockMs", "maxAttempts", "dependsOn", "required"], path);
  const statement = requiredString(item.statement, `${path}.statement`);
  const memberId = item.memberId === undefined ? undefined : memberIdentity(item.memberId, `${path}.memberId`);
  const legacyId = item.branchId === undefined ? undefined : memberIdentity(item.branchId, `${path}.branchId`);
  if (memberId !== undefined && legacyId !== undefined && memberId !== legacyId) {
    throw new TypeError(`${path}.memberId and branchId must identify the same member`);
  }
  const branchId = memberId ?? legacyId;
  if (item.required !== undefined && typeof item.required !== "boolean") throw new TypeError(`${path}.required must be a boolean`);
  const dependsOn = stringArray(item.dependsOn, `${path}.dependsOn`, MAX_MEMBERS - 1)
    .map((dependency, index) => memberIdentity(dependency, `${path}.dependsOn[${index}]`));
  if (new Set(dependsOn).size !== dependsOn.length) throw new TypeError(`${path}.dependsOn contains duplicate members`);
  return {
    ...(branchId === undefined ? {} : { memberId: branchId, branchId }),
    statement,
    successCriteria: stringArray(item.successCriteria, `${path}.successCriteria`),
    hardConstraints: stringArray(item.hardConstraints, `${path}.hardConstraints`),
    ...(item.input === undefined ? {} : { input: requiredString(item.input, `${path}.input`) }),
    ...(item.maxModelTokens === undefined ? {} : { maxModelTokens: positiveInteger(item.maxModelTokens, `${path}.maxModelTokens`, MAX_TASK_MODEL_TOKENS) }),
    ...(item.maxWallClockMs === undefined ? {} : { maxWallClockMs: positiveInteger(item.maxWallClockMs, `${path}.maxWallClockMs`, MAX_TASK_WALL_CLOCK_MS) }),
    ...(item.maxAttempts === undefined ? {} : { maxAttempts: positiveInteger(item.maxAttempts, `${path}.maxAttempts`, MAX_TASK_ATTEMPTS) }),
    dependsOn,
    required: item.required ?? true,
  };
}

function validateDependencies(members: NormalizedTeamCreateRequest["branches"]): void {
  const named = new Map<string, NormalizedTeamCreateRequest["branches"][number]>();
  for (const member of members) {
    if (member.branchId === undefined) continue;
    if (named.has(member.branchId)) throw new TypeError(`Duplicate Team member: ${member.branchId}`);
    named.set(member.branchId, member);
  }
  for (const member of members) {
    for (const dependency of member.dependsOn) {
      if (!named.has(dependency)) throw new TypeError(`Unknown dependency ${dependency}; referenced members require explicit ids`);
      if (dependency === member.branchId) throw new TypeError(`Team member ${dependency} cannot depend on itself`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (memberId: string): void => {
    if (visiting.has(memberId)) throw new TypeError(`Team dependency cycle at ${memberId}`);
    if (visited.has(memberId)) return;
    visiting.add(memberId);
    for (const dependency of named.get(memberId)!.dependsOn) visit(dependency);
    visiting.delete(memberId);
    visited.add(memberId);
  };
  for (const memberId of named.keys()) visit(memberId);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${field}.${key} is not supported`);
  }
}

function normalizeTeamId(value: unknown): string {
  const id = requiredString(value, "teamId");
  if (id.length > MAX_TEAM_ID_LENGTH) throw new RangeError(`teamId exceeds ${MAX_TEAM_ID_LENGTH} characters`);
  return id.trim().replace(/[^A-Za-z0-9._-]+/gu, "-");
}

function memberIdentity(value: unknown, field: string): string {
  const id = requiredString(value, field);
  if (id.length > MAX_SUBAGENT_NAME_LENGTH) throw new RangeError(`${field} exceeds ${MAX_SUBAGENT_NAME_LENGTH} characters`);
  return normalizeSubagentName(id);
}

function oneOf<T extends string>(value: unknown, options: readonly T[], field: string): T {
  if (typeof value !== "string" || !options.includes(value as T)) throw new TypeError(`${field} must be one of ${options.join(", ")}`);
  return value as T;
}

function isoDeadline(value: unknown): string {
  const deadline = requiredString(value, "deadline");
  const timestamp = Date.parse(deadline);
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(deadline)
    || !Number.isFinite(timestamp)) throw new TypeError("deadline must be an absolute ISO timestamp with timezone");
  const date = deadline.slice(0, 10);
  if (new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) throw new TypeError("deadline must contain a valid calendar date");
  return new Date(timestamp).toISOString();
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) throw new TypeError(`${field} must be a non-empty string`);
  if (value.length > MAX_STRING_LENGTH) throw new RangeError(`${field} exceeds ${MAX_STRING_LENGTH} characters`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field);
}

function stringArray(value: unknown, field: string, maxItems = MAX_CRITERIA): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new TypeError(`${field} must be an array of strings`);
  if (value.length > maxItems) throw new RangeError(`${field} exceeds ${maxItems} items`);
  return Array.from(value, (item, index) => requiredString(item, `${field}[${index}]`));
}

function positiveInteger(value: unknown, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${field} must be a positive integer`);
  if ((value as number) > maximum) throw new RangeError(`${field} exceeds ${maximum}`);
  return value as number;
}

/** Shared helper for branch implementations and tests. */
export function teamGoal(branch: TeamBranchRequest): Goal {
  return {
    version: 1,
    statement: branch.statement,
    successCriteria: [...(branch.successCriteria ?? [])],
    hardConstraints: [...(branch.hardConstraints ?? [])],
  };
}
