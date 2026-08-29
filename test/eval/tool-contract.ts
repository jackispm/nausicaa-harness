import type { AgentTool } from "../../src/domain/index.js";
import type { ModelRequest } from "../../src/domain/index.js";
import { createAdviceResponseTool } from "../../src/runtime/index.js";
import { createWorkspaceTools } from "../../src/tools/index.js";
import { hashJson } from "./fingerprint.js";

// Keep the pre-registered evaluation surface stable while the product tool
// catalog evolves independently.
const readOnlyTools = createWorkspaceTools({ allowWrite: false, allowShell: false, includeFileInfo: false });
const writeTools = createWorkspaceTools({
  allowWrite: true,
  allowShell: false,
  includeFileInfo: false,
  allowPathOperations: false,
});
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
