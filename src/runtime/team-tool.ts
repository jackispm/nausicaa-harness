import type { AgentTool, JsonSchema, ToolExecutionContext, ToolResult } from "../domain/ports.js";
import type { ArtifactRef, Goal, LaneId } from "../domain/types.js";
import type { TeamCapabilityGrant } from "../domain/team.js";
import { MAX_TASK_ATTEMPTS, MAX_TASK_MODEL_TOKENS, MAX_TASK_WALL_CLOCK_MS } from "../domain/types.js";
import { annotateTool } from "../mowe/catalog.js";
import { MAX_SUBAGENT_NAME_LENGTH, normalizeSubagentName } from "./subagent-policy.js";
import { publicAgentName, publicLaneName } from "./lane-names.js";

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
  /** Optional host-enforced narrowing of the creating lane's capabilities. */
  capabilities?: TeamCapabilityGrant;
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
    name?: string;
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
  maxAttempts?: number;
}

export interface TeamPresentRequest {
  teamId: string;
  disposition: "accepted" | "rejected";
}

export interface TeamMessageRequest {
  teamId: string;
  channelId?: string;
  threadId?: string;
  body: string;
  mentions?: LaneId[];
  artifactRefs?: ArtifactRef[];
}

export interface TeamChannelMessage {
  messageId: string;
  teamId: string;
  channelId: string;
  sequence: number;
  fromLane: LaneId;
  threadId?: string;
  body: string;
  mentions: LaneId[];
  artifactRefs: ArtifactRef[];
  cursor: string;
}

export interface TeamMessageResult extends TeamChannelMessage {
  status: "sent" | "duplicate";
}

export interface TeamHistoryRequest {
  teamId: string;
  channelId?: string;
  threadId?: string;
  after?: string;
  limit?: number;
}

export interface TeamHistoryResult {
  teamId: string;
  channelId: string;
  messages: TeamChannelMessage[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface TeamCloseRequest {
  teamId: string;
  reason?: string;
}

export interface TeamAssignRequest {
  teamId: string;
  memberId: string;
  statement: string;
  input?: string;
  /** Optional capability narrowing when admitting a new member. */
  capabilities?: TeamCapabilityGrant;
}

export interface TeamAssignResult {
  teamId: string;
  taskId: string;
  memberId: string;
  laneId: string;
  assignmentVersion: number;
  status: "queued" | "duplicate";
}

export interface TeamWaitRequest {
  teamId: string;
  taskId: string;
}

export interface TeamControl {
  create(
    request: TeamCreateRequest,
    context: ToolExecutionContext,
  ): Promise<TeamCreateResult>;
  status?(context: ToolExecutionContext): unknown | Promise<unknown>;
  message?(request: TeamMessageRequest, context: ToolExecutionContext): TeamMessageResult | Promise<TeamMessageResult>;
  history?(request: TeamHistoryRequest, context: ToolExecutionContext): TeamHistoryResult | Promise<TeamHistoryResult>;
  close?(request: TeamCloseRequest, context: ToolExecutionContext): unknown | Promise<unknown>;
  assign?(request: TeamAssignRequest, context: ToolExecutionContext): TeamAssignResult | Promise<TeamAssignResult>;
  wait?(request: TeamWaitRequest, context: ToolExecutionContext): unknown | Promise<unknown>;
  cancel?(request: TeamCancelRequest, context: ToolExecutionContext): unknown | Promise<unknown>;
  reduce?(request: TeamReduceRequest, context: ToolExecutionContext): unknown | Promise<unknown>;
  present?(request: TeamPresentRequest, context: ToolExecutionContext): unknown | Promise<unknown>;
}

/** Assign ready work to a new or existing member in the same Team. */
export function createTeamAssignTool(control: TeamControl): AgentTool {
  if (control === null || typeof control !== "object" || typeof control.assign !== "function") {
    throw new TypeError("Team assign control must provide assign");
  }
  return createTeamCommand(
    "team_assign",
    "Assign ready work within an existing Team. A new memberId joins the Team; an existing member keeps its identity and authorized tools. Provide the objective in statement and relevant prior results or file paths in input. Add a reviewer after the work is ready; return fixes to the responsible member and request another review when useful. Reports arrive in the shared task thread. Use task_wait when you have no other work, or end your turn for automatic continuation.",
    {
      teamId: teamIdSchema,
      memberId: memberIdSchema,
      statement: { ...boundedText, description: "Ready-to-start objective for this assignment" },
      input: { ...boundedText, description: "Concise handoff: existing results, relevant file paths, and decisions the member needs" },
      capabilities: { ...capabilityGrantSchema, description: "Optional tool narrowing for a new member; existing member permissions cannot be expanded here" },
    },
    ["teamId", "memberId", "statement"],
    (arguments_, context) => {
      exactKeys(arguments_, ["teamId", "memberId", "statement", "input", "capabilities"], "arguments");
      const input = optionalString(arguments_.input, "input");
      const capabilities = parseCapabilityGrant(arguments_.capabilities, "capabilities");
      return control.assign!({
        teamId: normalizeTeamId(arguments_.teamId),
        memberId: memberIdentity(arguments_.memberId, "memberId"),
        statement: boundedBody(arguments_.statement),
        ...(input === undefined ? {} : { input }),
        ...(capabilities === undefined ? {} : { capabilities }),
      }, context);
    },
  );
}

/** Wait for a Task result without spending model calls on status polling. */
export function createTaskWaitTool(control: Pick<TeamControl, "wait">): AgentTool {
  if (control === null || typeof control !== "object" || typeof control.wait !== "function") {
    throw new TypeError("Task wait control must provide wait");
  }
  return annotateTool(createTeamCommand(
    "task_wait",
    "Wait for one Team task to finish and return its durable report. The runtime waits without polling the model. Use this when you have no other ready work; use team_status for an immediate snapshot. You can also end your current turn and let arriving reports resume coordination. Waiting does not copy the member's full transcript.",
    { teamId: teamIdSchema, taskId: { type: "string", minLength: 1, maxLength: 128 } },
    ["teamId", "taskId"],
    (arguments_, context) => {
      exactKeys(arguments_, ["teamId", "taskId"], "arguments");
      return control.wait!({ teamId: normalizeTeamId(arguments_.teamId), taskId: requiredString(arguments_.taskId, "taskId") }, context);
    },
  ), { effect: "read", deterministic: true, supportsBatch: false, concurrencySafe: true, scope: "run", inputKinds: ["json"], outputKinds: ["json"] });
}

/** Main-facing read-only capability for the durable Team board projection. */
export function createTeamStatusTool(control: Pick<TeamControl, "status">): AgentTool {
  if (control === null || typeof control !== "object" || typeof control.status !== "function") {
    throw new TypeError("Team status control must provide status");
  }
  const tool: AgentTool = {
    definition: {
      name: "team_status",
      description: "Read a compact snapshot of the Teams you belong to or manage: member names, outcomes, join, reduction, and Lead acceptance. Use returned laneId values for A2A; names may repeat across Teams. Join collects terminal outcomes, including partial or failed work, without proving success or completing the Lead's synthesis. Use task_wait to await a result.",
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
          content: JSON.stringify(modelTeamStatus(await control.status!(context))),
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

/** Main-facing append-only Team channel message capability. */
export function createTeamMessageTool(control: TeamControl): AgentTool {
  if (control === null || typeof control !== "object" || typeof control.message !== "function") {
    throw new TypeError("Team message control must provide message");
  }
  return createTeamCommand(
    "team_message",
    "Post one public message to a Team channel or task thread. Messages are durable and visible to authorized members, but ordinary messages do not wake every member. Use agent_message for private A2A.",
    {
      teamId: teamIdSchema,
      channelId: { type: "string", minLength: 1, maxLength: 96, default: "general" },
      threadId: { type: "string", minLength: 1, maxLength: 160 },
      body: { type: "string", minLength: 1, maxLength: 8_192 },
      mentions: { type: "array", maxItems: MAX_MEMBERS, items: memberIdSchema },
      artifactRefs: { type: "array", maxItems: 32, items: { type: "object" } },
    },
    ["teamId", "body"],
    (arguments_, context) => {
      exactKeys(arguments_, ["teamId", "channelId", "threadId", "body", "mentions", "artifactRefs"], "arguments");
      const mentions = stringArray(arguments_.mentions, "mentions", MAX_MEMBERS).map((value, index) => memberIdentity(value, `mentions[${index}]`));
      if (new Set(mentions).size !== mentions.length) throw new TypeError("mentions must contain unique member ids");
      const artifactRefs = parseArtifactRefs(arguments_.artifactRefs);
      return control.message!({
        teamId: normalizeTeamId(arguments_.teamId),
        ...(arguments_.channelId === undefined ? {} : { channelId: requiredString(arguments_.channelId, "channelId") }),
        ...(arguments_.threadId === undefined ? {} : { threadId: requiredString(arguments_.threadId, "threadId") }),
        body: boundedBody(arguments_.body),
        ...(mentions.length === 0 ? {} : { mentions }),
        ...(artifactRefs.length === 0 ? {} : { artifactRefs }),
      }, context);
    },
  );
}

/** Main-facing bounded Team channel history capability. */
export function createTeamHistoryTool(control: TeamControl): AgentTool {
  if (control === null || typeof control !== "object" || typeof control.history !== "function") {
    throw new TypeError("Team history control must provide history");
  }
  return createTeamCommand(
    "team_history",
    "Read a bounded page of Team channel history by an opaque cursor. Reading history does not mark unread events consumed; use the returned nextCursor for the next page.",
    {
      teamId: teamIdSchema,
      channelId: { type: "string", minLength: 1, maxLength: 96, default: "general" },
      threadId: { type: "string", minLength: 1, maxLength: 160 },
      after: { type: "string", minLength: 1, maxLength: 256 },
      limit: { type: "integer", minimum: 1, maximum: 64, default: 32 },
    },
    ["teamId"],
    (arguments_, context) => {
      exactKeys(arguments_, ["teamId", "channelId", "threadId", "after", "limit"], "arguments");
      const limit = arguments_.limit === undefined ? undefined : positiveInteger(arguments_.limit, "limit", 64);
      return control.history!({
        teamId: normalizeTeamId(arguments_.teamId),
        ...(arguments_.channelId === undefined ? {} : { channelId: requiredString(arguments_.channelId, "channelId") }),
        ...(arguments_.threadId === undefined ? {} : { threadId: requiredString(arguments_.threadId, "threadId") }),
        ...(arguments_.after === undefined ? {} : { after: requiredString(arguments_.after, "after") }),
        ...(limit === undefined ? {} : { limit }),
      }, context);
    },
  );
}

/** Explicitly close a resident Team; cancellation remains a separate operation. */
export function createTeamCloseTool(control: TeamControl): AgentTool {
  if (control === null || typeof control !== "object" || typeof control.close !== "function") {
    throw new TypeError("Team close control must provide close");
  }
  return createTeamCommand(
    "team_close",
    "Close a Team explicitly. New assignments and wakeups are fenced; settled reports remain available for inspection.",
    { teamId: teamIdSchema, reason: boundedText },
    ["teamId"],
    (arguments_, context) => {
      exactKeys(arguments_, ["teamId", "reason"], "arguments");
      const reason = optionalString(arguments_.reason, "reason");
      return control.close!({ teamId: normalizeTeamId(arguments_.teamId), ...(reason === undefined ? {} : { reason }) }, context);
    },
  );
}

// Keep the host board intact; model status excludes admission context and compatibility duplicates.
function modelTeamStatus(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(modelTeamBoard);
  if (isStatusRecord(value) && Array.isArray(value.teams)) {
    return { ...value, teams: value.teams.map(modelTeamBoard) };
  }
  return value;
}

function modelTeamBoard(value: unknown): unknown {
  if (!isStatusRecord(value) || typeof value.teamId !== "string") return value;
  const members = Array.isArray(value.members) ? value.members
    : Array.isArray(value.branches) ? value.branches : undefined;
  // Older hosts may expose an opaque status payload instead of Team boards.
  if (members === undefined) return value;
  const definition = isStatusRecord(value.definition) ? value.definition : undefined;
  const leadLaneId = value.leadLaneId ?? value.coordinator;
  return {
    ...statusFields(value, [
    "runId", "teamId", "status", "joinPolicy", "joinReady", "joinSatisfied", "joinState",
      "cancellationRequested", "lifecycleState", "closedReason", "reductionState", "reduction", "presentationState", "anomalies", "lastOffset",
    ]),
    leadLaneId: typeof leadLaneId === "string" ? publicLaneName(leadLaneId) : leadLaneId,
    ...(typeof leadLaneId === "string" ? { leadName: publicAgentName(leadLaneId) } : {}),
    ...(definition === undefined ? {} : statusFields(definition, ["deadline", "peerMessaging"])),
    members: members.map(modelTeamMember),
    ...(Array.isArray(value.tasks) ? { tasks: value.tasks.map(modelTeamTask) } : {}),
    ...(value.reducer === undefined ? {} : { reducer: modelTeamReducer(value.reducer) }),
  };
}

function modelTeamTask(value: unknown): unknown {
  if (!isStatusRecord(value)) return value;
  const report = isStatusRecord(value.latestReport) ? value.latestReport : undefined;
  return {
    ...statusFields(value, ["taskId", "memberId", "laneId", "assignmentVersion", "statement", "status", "assignedAt"]),
    ...(report === undefined ? {} : { latestReport: statusFields(report, ["reportId", "runId", "kind", "summary", "artifactRefs", "openQuestions", "result", "failure"]) }),
  };
}

function modelTeamMember(value: unknown): unknown {
  if (!isStatusRecord(value)) return value;
  const goal = isStatusRecord(value.goal) ? value.goal : undefined;
  const report = isStatusRecord(value.latestReport) ? value.latestReport : undefined;
  return {
    ...statusFields(value, [
      "laneId", "taskId", "registered", "status", "laneStatus", "execution", "terminal", "outcome",
      "required", "attempt", "result", "failure", "reason", "anomalies", "lastOffset",
    ]),
    memberId: value.memberId ?? value.branchId,
    ...(typeof value.laneId === "string" ? { name: publicAgentName(value.laneId) } : {}),
    ...(goal === undefined ? {} : { statement: goal.statement }),
    ...(report === undefined ? {} : { latestReport: statusFields(report, ["reportId", "runId", "kind", "summary", "artifactRefs", "openQuestions"]) }),
  };
}

function modelTeamReducer(value: unknown): unknown {
  if (!isStatusRecord(value)) return value;
  const task = isStatusRecord(value.task) ? value.task : undefined;
  const goal = task !== undefined && isStatusRecord(task.goal) ? task.goal : undefined;
  return {
    ...statusFields(value, ["memberId", "laneId", "required"]),
    ...(typeof value.laneId === "string" ? { name: publicAgentName(value.laneId) } : {}),
    ...(task === undefined ? {} : { taskId: task.taskId }),
    ...(goal === undefined ? {} : { statement: goal.statement }),
  };
}

function statusFields(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
}

function isStatusRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const MAX_MEMBERS = 16;
const MAX_STRING_LENGTH = 4_096;
const MAX_CRITERIA = 64;
const MAX_TEAM_ID_LENGTH = 96;

const boundedText = { type: "string", minLength: 1, maxLength: MAX_STRING_LENGTH };
const teamIdSchema = { type: "string", minLength: 1, maxLength: MAX_TEAM_ID_LENGTH };
const memberIdSchema = { type: "string", minLength: 1, maxLength: MAX_SUBAGENT_NAME_LENGTH };
const capabilityGrantSchema = {
  type: "object",
  properties: {
    tools: {
      type: "array",
      maxItems: 64,
      items: { type: "string", minLength: 1, maxLength: 128 },
      description: "Optional allowlist narrowing the tools inherited from the Team Lead; omitted inherits the host-authorized catalog",
    },
    allowNestedTeam: {
      type: "boolean",
      description: "Whether this member may create a nested Team; omitted inherits the Team Lead's permission",
    },
  },
  additionalProperties: false,
};

function memberSchema(): Record<string, unknown> {
  return {
    type: "array",
    minItems: 1,
    maxItems: MAX_MEMBERS,
    items: {
      type: "object",
      properties: {
        memberId: { ...memberIdSchema, description: "Member name and stable ID chosen by you, e.g. researcher or reviewer. Defaults to worker-1, worker-2, etc. Names are unique within this Team; runtime role names are reserved." },
        branchId: { ...memberIdSchema, deprecated: true, description: "Compatibility alias for memberId" },
        statement: { ...boundedText, description: "Ready-to-start objective; add later work with team_assign once its inputs exist" },
        input: { ...boundedText, description: "Concise handoff: relevant context, existing results, file paths, and decisions" },
        required: { type: "boolean", default: true, description: "Whether this member is required at the Team join boundary" },
        capabilities: capabilityGrantSchema,
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
      description: "Create a Team with members whose work can start now. Members have independent contexts and run in parallel; give each a clear statement and concise input. For example, create a developer first; once its file exists, add a reviewer using team_assign in this same Team. Reuse members for further work. Members inherit your authorized tools unless capabilities narrows them. Final reports enter the shared Team channel; team_message is group chat and agent_message is private A2A. You own synthesis and acceptance; partial or failed outcomes are not success. When no other work is ready, task_wait awaits a report, or end your turn for automatic continuation.",
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
    "Cancel a Team's unfinished work and persist cancellation. Completed outcomes remain available; late member results cannot reopen cancelled work. You remain responsible for the final response as Team Lead.",
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
    "Explicitly schedule an optional, bounded read-only Reducer lane after the Team joins. Use it when synthesis benefits from another lane; you are the default synthesizer as Team Lead and must accept or reject the reduction before presenting the final answer.",
    { teamId: teamIdSchema, statement: boundedText },
    ["teamId"],
    (arguments_, context) => {
      exactKeys(arguments_, ["teamId", "statement"], "arguments");
      const statement = optionalString(arguments_.statement, "statement");
      return control.reduce!({
        teamId: normalizeTeamId(arguments_.teamId),
        ...(statement === undefined ? {} : { statement }),
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
    "Record your acceptance or rejection of joined Team results after any requested reduction has settled. This records your decision as Team Lead; you still write the final synthesis, and acceptance does not turn partial or failed tasks into successful ones.",
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

/** Parse only the compact, model-facing Team creation contract. Host code may
 * still use normalizeTeamCreateRequest for recovered or explicitly controlled
 * internal requests, but model calls cannot choose task budgets or deadlines.
 */
export function parseTeamRequest(value: unknown): NormalizedTeamCreateRequest {
  const arguments_ = object(value, "arguments");
  exactKeys(arguments_, ["teamId", "members", "branches", "peerMessaging"], "arguments");
  const hasMembers = Object.hasOwn(arguments_, "members");
  const hasBranches = Object.hasOwn(arguments_, "branches");
  if (hasMembers === hasBranches) throw new TypeError("Supply exactly one of members or branches");
  const collectionField = hasMembers ? "members" : "branches";
  const collection = arguments_[collectionField];
  if (!Array.isArray(collection)) throw new TypeError(`${collectionField} must be an array`);
  for (const [index, member] of collection.entries()) {
    const item = object(member, `${collectionField}[${index}]`);
    if (Object.hasOwn(item, "dependsOn")) {
      throw new TypeError("dependsOn is no longer supported; assign this work with team_assign after its inputs are ready");
    }
    exactKeys(item, ["memberId", "branchId", "statement", "input", "required", "capabilities"], `${collectionField}[${index}]`);
  }
  return normalizeTeamCreateRequest(arguments_);
}

function parseMember(value: unknown, path: string): NormalizedTeamCreateRequest["branches"][number] {
  const item = object(value, path);
  exactKeys(item, ["memberId", "branchId", "statement", "successCriteria", "hardConstraints", "input", "maxModelTokens", "maxWallClockMs", "maxAttempts", "dependsOn", "required", "capabilities"], path);
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
  const capabilities = parseCapabilityGrant(item.capabilities, `${path}.capabilities`);
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
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}

function parseCapabilityGrant(value: unknown, path: string): TeamCapabilityGrant | undefined {
  if (value === undefined) return undefined;
  const item = object(value, path);
  exactKeys(item, ["tools", "allowNestedTeam"], path);
  const tools = item.tools === undefined ? undefined : stringArray(item.tools, `${path}.tools`, 64)
    .map((tool, index) => {
      const name = tool.trim();
      if (!/^[a-z][a-z0-9_:-]{0,127}$/u.test(name)) throw new TypeError(`${path}.tools[${index}] must be a tool name`);
      return name;
    });
  if (tools !== undefined && new Set(tools).size !== tools.length) throw new TypeError(`${path}.tools must contain unique names`);
  if (item.allowNestedTeam !== undefined && typeof item.allowNestedTeam !== "boolean") {
    throw new TypeError(`${path}.allowNestedTeam must be a boolean`);
  }
  if (tools === undefined && item.allowNestedTeam === undefined) return {};
  return {
    ...(tools === undefined ? {} : { tools }),
    ...(item.allowNestedTeam === undefined ? {} : { allowNestedTeam: item.allowNestedTeam }),
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
  const normalized = normalizeSubagentName(id);
  if (normalized === "main" || normalized === "nausicaa" || normalized === "teto") {
    throw new TypeError(`${field} is reserved for a runtime role`);
  }
  return normalized;
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

function boundedBody(value: unknown): string {
  const body = requiredString(value, "body");
  if (body.length > 8_192) throw new RangeError("body exceeds 8192 characters");
  return body;
}

function parseArtifactRefs(value: unknown): ArtifactRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new TypeError("artifactRefs must contain at most 32 refs");
  return value.map((candidate, index) => {
    const item = object(candidate, `artifactRefs[${index}]`);
    exactKeys(item, ["id", "contentHash", "mediaType", "byteLength"], `artifactRefs[${index}]`);
    const id = requiredString(item.id, `artifactRefs[${index}].id`);
    const contentHash = requiredString(item.contentHash, `artifactRefs[${index}].contentHash`);
    const mediaType = requiredString(item.mediaType, `artifactRefs[${index}].mediaType`);
    if (!Number.isSafeInteger(item.byteLength) || (item.byteLength as number) < 0) {
      throw new TypeError(`artifactRefs[${index}].byteLength must be a non-negative integer`);
    }
    return { id, contentHash, mediaType, byteLength: item.byteLength as number };
  });
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
