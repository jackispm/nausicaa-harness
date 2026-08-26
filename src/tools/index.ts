export { createBashTool, bashTool } from "./bash.js";
export { createEditFileTool, editFileTool } from "./edit-file.js";
export { createFindTool, findTool } from "./find.js";
export { createGrepTool, grepTool } from "./grep.js";
export { createListFilesTool, listFilesTool } from "./list-files.js";
export { createReadFileTool, readFileTool } from "./read-file.js";
export {
  type WorkspacePathPolicy,
  WorkspacePathError,
} from "./workspace-path.js";
export { createWriteFileTool, writeFileTool } from "./write-file.js";

import type { AgentTool } from "../domain/ports.js";
import { createBashTool } from "./bash.js";
import { createEditFileTool } from "./edit-file.js";
import { createFindTool } from "./find.js";
import { createGrepTool } from "./grep.js";
import { createListFilesTool } from "./list-files.js";
import { createReadFileTool } from "./read-file.js";
import type { WorkspacePathPolicy } from "./workspace-path.js";
import { createWriteFileTool } from "./write-file.js";

export interface WorkspaceToolOptions extends WorkspacePathPolicy {
  allowShell?: boolean;
  allowWrite?: boolean;
}

export function createWorkspaceTools(options: WorkspaceToolOptions = {}): AgentTool[] {
  const policy = { protectedPaths: [...(options.protectedPaths ?? [])] };
  const tools = [
    createReadFileTool(policy),
    createListFilesTool(policy),
    createGrepTool(policy),
    createFindTool(policy),
  ];
  if (options.allowWrite === true) {
    tools.push(createWriteFileTool(policy), createEditFileTool(policy));
  }
  if (options.allowShell === true) {
    tools.push(createBashTool());
  }
  return tools;
}
