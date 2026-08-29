import type { AgentTool } from "../domain/ports.js";
import {
  createWorkspaceTools,
  type WorkspaceToolOptions,
} from "../tools/index.js";
import { MoweCatalog } from "./catalog.js";
import type { MoweToolMetadata } from "./types.js";

/**
 * Options for the first-party workspace catalog.  `additionalTools` is the
 * narrow adapter seam for runtime capabilities such as delegation or advice;
 * it never bypasses Mowe registration, schema admission, or effect filtering.
 */
export interface WorkspaceMoweCatalogOptions extends WorkspaceToolOptions {
  additionalTools?: readonly AgentTool[];
  metadataByName?: Readonly<Record<string, MoweToolMetadata>>;
}

/**
 * Build the complete Nausicaa workspace tool surface for Mowe.
 *
 * The factory intentionally delegates implementation and path security to the
 * existing workspace tools.  Mowe supplies the common catalog and execution
 * boundary, so callers do not have to maintain a second list of first-party
 * tools when adding optional write, shell, or lane capabilities.
 */
export function createWorkspaceMoweCatalog(
  options: WorkspaceMoweCatalogOptions = {},
): MoweCatalog {
  const {
    additionalTools = [],
    metadataByName = {},
    ...workspaceOptions
  } = options;
  const catalog = new MoweCatalog(createWorkspaceTools(workspaceOptions));
  return catalog.registerMany(additionalTools, metadataByName);
}
