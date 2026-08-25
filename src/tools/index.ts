export { listFilesTool } from "./list-files.js";
export { readFileTool } from "./read-file.js";
export { WorkspacePathError } from "./workspace-path.js";
export { writeFileTool } from "./write-file.js";

import type { AgentTool } from "../domain/ports.js";
import { listFilesTool } from "./list-files.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";

export function createWorkspaceTools(): AgentTool[] {
  return [readFileTool, listFilesTool, writeFileTool];
}
