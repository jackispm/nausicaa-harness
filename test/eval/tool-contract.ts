import type { AgentTool, ToolDefinition, ToolResult } from "../../src/domain/index.js";
import type { ModelRequest } from "../../src/domain/index.js";
import { createAdviceResponseTool } from "../../src/runtime/index.js";
import { createGrepTool, createWorkspaceTools } from "../../src/tools/index.js";
import { hashJson } from "./fingerprint.js";

// Keep the pre-registered evaluation surface stable while the product tool
// catalog evolves independently.
const FROZEN_READ_TOOL_NAMES = ["read_file", "list_files", "grep", "find"] as const;
const FROZEN_WRITE_TOOL_NAMES = [...FROZEN_READ_TOOL_NAMES, "write_file", "edit"] as const;
const readOnlyTools = createFrozenWorkspaceFixtureV2Tools({ allowWrite: false });
const writeTools = createFrozenWorkspaceFixtureV2Tools({ allowWrite: true });
const adviceDefinition = createAdviceResponseTool({} as never).definition;

export const FROZEN_TOOL_CONTRACT = deepFreeze({
  version: "workspace-fixture-v2",
  modes: {
    readOnly: readOnlyTools.map((tool) => structuredClone(tool.definition)),
    write: writeTools.map((tool) => structuredClone(tool.definition)),
    readOnlyWithAdvice: [...readOnlyTools.map((tool) => structuredClone(tool.definition)), structuredClone(adviceDefinition)],
    writeWithAdvice: [...writeTools.map((tool) => structuredClone(tool.definition)), structuredClone(adviceDefinition)],
    auxiliary: [],
  },
  policy: {
    allowShell: false,
    stateDirectoryProtected: true,
    workspaceBoundaryRequired: true,
    symbolicLinkTraversal: false,
  },
  outputLimits: {
    readFileHardBytes: 256 * 1024,
    readFileHardLines: 10_000,
    listFilesHardEntries: 1_000,
    writeFileHardBytes: 1_024 * 1_024,
    editFileHardBytes: 1_024 * 1_024,
    mainToolResultHardBytes: 256 * 1024,
  },
} as const);

export const FROZEN_TOOL_CONTRACT_HASH = hashJson(FROZEN_TOOL_CONTRACT);

export function createFrozenWorkspaceFixtureV2Tools(options: {
  allowWrite: boolean;
  protectedPaths?: readonly string[];
}): AgentTool[] {
  const policy = { protectedPaths: [...(options.protectedPaths ?? [])] };
  const productTools = createWorkspaceTools({
    allowWrite: options.allowWrite,
    allowShell: false,
    includeFileInfo: false,
    includeGit: false,
    allowPathOperations: false,
    ...policy,
  });
  const toolsByName = new Map(productTools.map((tool) => [tool.definition.name, tool]));
  toolsByName.set("grep", createGrepTool(policy, { pagination: "legacy" }));
  const names = options.allowWrite ? FROZEN_WRITE_TOOL_NAMES : FROZEN_READ_TOOL_NAMES;
  return names.map((name) => {
    const tool = toolsByName.get(name);
    if (tool === undefined) throw new Error(`Frozen evaluation tool ${name} is unavailable`);
    const definition = normalizeFrozenToolDefinition(tool.definition);
    return {
      definition,
      execute: async (arguments_, context): Promise<ToolResult> => {
        if ((name === "grep" || name === "find") && "cursor" in arguments_) {
          return {
            content: JSON.stringify({ error: "cursor is not part of workspace-fixture-v2" }),
            isError: true,
          };
        }
        const result = await tool.execute(arguments_, context);
        return name === "grep" || name === "find"
          ? stripSearchCursor(result)
          : result;
      },
    };
  });
}

export function assertEvaluationToolContract(
  tools: readonly AgentTool[],
  allowWrite: boolean,
): void {
  const actual = tools.map((tool) => tool.definition);
  const expected = allowWrite
    ? FROZEN_TOOL_CONTRACT.modes.write
    : FROZEN_TOOL_CONTRACT.modes.readOnly;
  if (hashJson(actual) !== hashJson(expected)) {
    throw new Error("Evaluation tools do not match the frozen tool contract");
  }
  if (tools.some((tool) => tool.definition.name === "bash")) {
    throw new Error("Phase 2.4 evaluation must not expose shell execution");
  }
}

export function assertModelRequestToolContract(
  request: ModelRequest,
  allowWrite: boolean,
  adviceToolVisible: boolean,
): void {
  const expected = request.laneId === "main"
    ? allowWrite
      ? adviceToolVisible ? FROZEN_TOOL_CONTRACT.modes.writeWithAdvice : FROZEN_TOOL_CONTRACT.modes.write
      : adviceToolVisible ? FROZEN_TOOL_CONTRACT.modes.readOnlyWithAdvice : FROZEN_TOOL_CONTRACT.modes.readOnly
    : FROZEN_TOOL_CONTRACT.modes.auxiliary;
  if (hashJson(request.tools) !== hashJson(expected)) {
    throw new Error("Model request tools do not match the frozen arm tool contract");
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

export function normalizeFrozenToolDefinition(source: ToolDefinition): ToolDefinition {
  const definition = structuredClone(source);
  if (definition.name === "read_many") {
    definition.description = "Read up to 16 independent workspace file windows in one bounded batch. Results preserve target order and isolate per-file failures. Continue truncated files with their returned nextOffset/nextLineByteOffset values.";
    const targets = definition.parameters.properties?.targets;
    if (targets !== null && typeof targets === "object") {
      (targets as Record<string, unknown>).description = "Independent file windows to read; use this for entry points, definitions, call sites, configuration, types, and tests discovered together";
    }
  } else if (definition.name === "list_files") {
    definition.description = "List workspace files in stable order without following directory symlinks. Use offset and nextOffset to continue a large listing.";
  } else if (definition.name === "grep") {
    definition.description = "Search workspace file contents for a pattern and return bounded structured matches.";
    delete definition.parameters.properties?.cursor;
  } else if (definition.name === "find") {
    definition.description = "Find workspace files by glob pattern while respecting ignore files and protected paths.";
    delete definition.parameters.properties?.cursor;
  } else if (definition.name === "delegate_task") {
    definition.description = "Queue an independent, bounded read-only Worker task. The Worker can independently use bounded read-only workspace tools and returns its result asynchronously at a later Main step or turn; continue other work after queueing. Batch independent tasks when useful. Do not use for trivial, tightly coupled, mutating, shell, or immediate-result work.";
    const properties = definition.parameters.properties;
    if (properties !== undefined) {
      properties.successCriteria = {
        type: "array",
        items: { type: "string" },
        description: "Optional observable completion criteria",
      };
      properties.hardConstraints = {
        type: "array",
        items: { type: "string" },
        description: "Optional constraints, such as read-only or path limits",
      };
      properties.maxModelTokens = {
        type: "integer",
        minimum: 1,
        description: "Optional model-token budget (default 2000)",
      };
      properties.maxWallClockMs = {
        type: "integer",
        minimum: 1,
        description: "Optional wall-clock budget in milliseconds (default 30000)",
      };
      properties.maxAttempts = {
        type: "integer",
        minimum: 1,
        maximum: 8,
        description: "Optional provider-attempt budget (default 2)",
      };
      definition.parameters.required = ["statement"];
    }
  }
  return definition;
}

function stripSearchCursor(result: ToolResult): ToolResult {
  let value: unknown;
  try {
    value = JSON.parse(result.content) as unknown;
  } catch {
    return result;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return result;
  const output = { ...(value as Record<string, unknown>) };
  delete output.nextCursor;
  return { ...result, content: JSON.stringify(output) };
}
