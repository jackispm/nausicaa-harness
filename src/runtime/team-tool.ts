import type { AgentTool, ToolExecutionContext, ToolResult } from "../domain/ports.js";
import type { Goal } from "../domain/types.js";
import { annotateTool } from "../mowe/catalog.js";

export interface TeamBranchRequest {
  branchId?: string;
  statement: string;
  successCriteria?: string[];
  hardConstraints?: string[];
  input?: string;
  maxModelTokens?: number;
  maxWallClockMs?: number;
  maxAttempts?: number;
}

export interface TeamCreateRequest {
  teamId?: string;
  branches: TeamBranchRequest[];
}

export interface TeamCreateResult {
  teamId: string;
  branches: readonly {
    branchId: string;
    laneId: string;
    status: "queued" | "duplicate";
  }[];
}

export interface TeamControl {
  create(
    request: TeamCreateRequest,
    context: ToolExecutionContext,
  ): Promise<TeamCreateResult>;
  status?(context: ToolExecutionContext): unknown | Promise<unknown>;
}

const MAX_BRANCHES = 16;
const MAX_STRING_LENGTH = 4_096;

/** Main-facing capability for creating several independent task lanes. */
export function createTeamTool(control: TeamControl): AgentTool {
  if (control === null || typeof control !== "object" || typeof control.create !== "function") {
    throw new TypeError("Team control must provide create");
  }
  const tool: AgentTool = {
    definition: {
      name: "team_create",
      description: "Create a bounded Team of independent task lanes. Use it only for separable, nontrivial work; each branch has its own context and can independently open one Teto feedback lane. Branches return asynchronous results at later Main boundaries.",
      parameters: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Stable id for retrying or recognizing this Team" },
          branches: {
            type: "array",
            minItems: 1,
            maxItems: MAX_BRANCHES,
            items: {
              type: "object",
              properties: {
                branchId: { type: "string" },
                statement: { type: "string" },
                successCriteria: { type: "array", items: { type: "string" } },
                hardConstraints: { type: "array", items: { type: "string" } },
                input: { type: "string" },
                maxModelTokens: { type: "integer", minimum: 1 },
                maxWallClockMs: { type: "integer", minimum: 1 },
                maxAttempts: { type: "integer", minimum: 1 },
              },
              required: ["statement"],
              additionalProperties: false,
            },
          },
        },
        required: ["branches"],
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

function parseTeamRequest(arguments_: Record<string, unknown>): TeamCreateRequest {
  const teamId = optionalString(arguments_.teamId, "teamId");
  if (!Array.isArray(arguments_.branches) || arguments_.branches.length < 1 || arguments_.branches.length > MAX_BRANCHES) {
    throw new RangeError(`branches must contain between 1 and ${MAX_BRANCHES} items`);
  }
  return {
    ...(teamId === undefined ? {} : { teamId }),
    branches: arguments_.branches.map((value, index) => parseBranch(value, `branches[${index}]`)),
  };
}

function parseBranch(value: unknown, path: string): TeamBranchRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  const item = value as Record<string, unknown>;
  const statement = requiredString(item.statement, `${path}.statement`);
  const branchId = optionalString(item.branchId, `${path}.branchId`);
  return {
    ...(branchId === undefined ? {} : { branchId }),
    statement,
    successCriteria: stringArray(item.successCriteria, `${path}.successCriteria`),
    hardConstraints: stringArray(item.hardConstraints, `${path}.hardConstraints`),
    ...(item.input === undefined ? {} : { input: requiredString(item.input, `${path}.input`) }),
    ...(item.maxModelTokens === undefined ? {} : { maxModelTokens: positiveInteger(item.maxModelTokens, `${path}.maxModelTokens`) }),
    ...(item.maxWallClockMs === undefined ? {} : { maxWallClockMs: positiveInteger(item.maxWallClockMs, `${path}.maxWallClockMs`) }),
    ...(item.maxAttempts === undefined ? {} : { maxAttempts: positiveInteger(item.maxAttempts, `${path}.maxAttempts`) }),
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) throw new TypeError(`${field} must be a non-empty string`);
  if (value.length > MAX_STRING_LENGTH) throw new RangeError(`${field} exceeds ${MAX_STRING_LENGTH} characters`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field);
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new TypeError(`${field} must be an array of strings`);
  return value.map((item, index) => requiredString(item, `${field}[${index}]`));
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${field} must be a positive integer`);
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
