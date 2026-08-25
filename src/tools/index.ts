export { createListFilesTool, listFilesTool } from "./list-files.js";
export { createReadFileTool, readFileTool } from "./read-file.js";
export {
  type WorkspacePathPolicy,
  WorkspacePathError,
} from "./workspace-path.js";
export { createWriteFileTool, writeFileTool } from "./write-file.js";

import type { AgentTool } from "../domain/ports.js";
import { createListFilesTool } from "./list-files.js";
import { createReadFileTool } from "./read-file.js";
import type { WorkspacePathPolicy } from "./workspace-path.js";
import { createWriteFileTool } from "./write-file.js";

export interface WorkspaceToolOptions extends WorkspacePathPolicy {
  allowWrite?: boolean;
}

export function createWorkspaceTools(options: WorkspaceToolOptions = {}): AgentTool[] {
  const policy = { protectedPaths: [...(options.protectedPaths ?? [])] };
  const tools = [createReadFileTool(policy), createListFilesTool(policy)];
  if (options.allowWrite === true) {
    tools.push(createWriteFileTool(policy));
  }
  return tools;
}
