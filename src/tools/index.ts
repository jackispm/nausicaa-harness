export { createBashTool, bashTool } from "./bash.js";
export { createEditFileTool, editFileTool } from "./edit-file.js";
export { createFindTool, findTool } from "./find.js";
export {
  createFileInfoTool,
  fileInfoTool,
  type FileInfo,
  type FileInfoToolOptions,
} from "./file-info.js";
export { createGrepTool, grepTool } from "./grep.js";
export { createListFilesTool, listFilesTool } from "./list-files.js";
export { createReadFileTool, readFileTool } from "./read-file.js";
export { createReadImageTool, readImageTool } from "./read-image.js";
export {
  createDirectoryCreateTool,
  createPathCopyTool,
  createPathDeleteTool,
  createPathMoveTool,
  directoryCreateTool,
  pathCopyTool,
  pathDeleteTool,
  pathMoveTool,
} from "./path-operations.js";
export {
  ProcessJobManager,
  FileProcessJobRegistry,
  MemoryProcessJobRegistry,
  ProcessJobRegistryError,
  createProcessJobTools,
  createProcessKillTool,
  createProcessListTool,
  createProcessOutputTool,
  createProcessStartTool,
  createProcessStatusTool,
  DEFAULT_PROCESS_JOB_MAX_JOBS,
  DEFAULT_PROCESS_JOB_MAX_OUTPUT_BYTES,
  DEFAULT_PROCESS_JOB_TIMEOUT_SECONDS,
  MAX_PROCESS_JOB_MAX_JOBS,
  MAX_PROCESS_JOB_OUTPUT_BYTES,
  MAX_PROCESS_JOB_REGISTRY_BYTES,
  MAX_PROCESS_JOB_REGISTRY_ENTRIES,
  MAX_PROCESS_JOB_TIMEOUT_SECONDS,
  PROCESS_JOB_MOWE_METADATA,
  type ProcessJobManagerOptions,
  type ProcessJobOutput,
  type ProcessJobOutputRequest,
  type ProcessJobListEntry,
  type ProcessJobRegistry,
  type ProcessJobRegistryEntry,
  type ProcessJobRegistryStatus,
  type ProcessJobSnapshot,
  type ProcessJobStartRequest,
  type ProcessJobState,
  type ProcessJobTerminationReason,
} from "./process-jobs.js";
export {
  type WorkspacePathPolicy,
  WorkspacePathError,
} from "./workspace-path.js";
export { createWriteFileTool, writeFileTool } from "./write-file.js";
export {
  createDuckDuckGoSearchTool,
  DuckDuckGoSearchProvider,
  parseDuckDuckGoResults,
  type DuckDuckGoSearchOptions,
} from "./web-search.js";
export {
  createWebFetchTool,
  createWebSearchTool,
  DEFAULT_WEB_FETCH_LIMITS,
  HttpWebFetchProvider,
  parseWebSearchQueries,
  WebToolError,
  type WebFetchBody,
  type WebFetchFunction,
  type WebFetchLimits,
  type WebFetchProvider,
  type WebFetchResult,
  type WebSearchProvider,
  type WebSearchResult,
  type WebSearchSource,
  type WebToolErrorCode,
  type WebToolOptions,
} from "./web.js";

import type { AgentTool } from "../domain/ports.js";
import { createBashTool } from "./bash.js";
import { createEditFileTool } from "./edit-file.js";
import { createFindTool } from "./find.js";
import { createFileInfoTool } from "./file-info.js";
import { createGrepTool } from "./grep.js";
import { createListFilesTool } from "./list-files.js";
import { createReadFileTool } from "./read-file.js";
import { createReadImageTool } from "./read-image.js";
import {
  createDirectoryCreateTool,
  createPathCopyTool,
  createPathDeleteTool,
  createPathMoveTool,
} from "./path-operations.js";
import {
  createProcessJobTools,
  ProcessJobManager,
} from "./process-jobs.js";
import type { WorkspacePathPolicy } from "./workspace-path.js";
import { DuckDuckGoSearchProvider } from "./web-search.js";
import {
  createWebFetchTool,
  createWebSearchTool,
  HttpWebFetchProvider,
} from "./web.js";
import { createWriteFileTool } from "./write-file.js";

export interface WorkspaceToolOptions extends WorkspacePathPolicy {
  allowShell?: boolean;
  allowWrite?: boolean;
  /** Include directory/copy/move/delete helpers with write tools. */
  allowPathOperations?: boolean;
  /** Include the default read-only file metadata capability. */
  includeFileInfo?: boolean;
  /** Enable provider-native workspace image input for the Main lane. */
  allowImages?: boolean;
  /** Enable run-scoped background shell jobs; requires allowShell as well. */
  allowProcessJobs?: boolean;
  /** Reuse a manager when several tool catalogs share one Run lifecycle. */
  processJobManager?: ProcessJobManager;
  /** Enable public web search/fetch providers for this tool surface. */
  allowNetwork?: boolean;
  /** @deprecated Use allowNetwork. Kept as a source-compatible alias. */
  allowWeb?: boolean;
  /** Inject a replacement web fetch backend. */
  webFetchProvider?: import("./web.js").WebFetchProvider;
  /** Inject a replacement web search backend. */
  webSearchProvider?: import("./web.js").WebSearchProvider;
}

export function createWorkspaceTools(options: WorkspaceToolOptions = {}): AgentTool[] {
  const policy = { protectedPaths: [...(options.protectedPaths ?? [])] };
  const tools = [
    createReadFileTool(policy),
    createListFilesTool(policy),
    createGrepTool(policy),
    createFindTool(policy),
  ];
  if (options.includeFileInfo !== false) {
    tools.push(createFileInfoTool(policy));
  }
  if (options.allowImages === true) {
    tools.push(createReadImageTool(policy));
  }
  if (options.allowNetwork === true || options.allowWeb === true) {
    const fetchProvider = options.webFetchProvider
      ?? new HttpWebFetchProvider();
    const searchProvider = options.webSearchProvider
      ?? new DuckDuckGoSearchProvider();
    tools.push(createWebFetchTool(fetchProvider), createWebSearchTool(searchProvider));
  }
  if (options.allowWrite === true) {
    tools.push(createWriteFileTool(policy), createEditFileTool(policy));
    // A write-enabled product surface includes the complete workspace
    // mutation set. Legacy/evaluation callers can explicitly narrow it with
    // allowPathOperations: false.
    if (options.allowPathOperations !== false) {
      tools.push(
        createDirectoryCreateTool(policy),
        createPathCopyTool(policy),
        createPathMoveTool(policy),
        createPathDeleteTool(policy),
      );
    }
  }
  if (options.allowShell === true) {
    tools.push(createBashTool());
    if (options.allowProcessJobs === true) {
      tools.push(...createProcessJobTools(
        options.processJobManager ?? new ProcessJobManager(policy),
      ));
    }
  }
  return tools;
}
