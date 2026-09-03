import type { AgentTool, ToolResult } from "../domain/ports.js";
import {
  decodeSearchCursor,
  encodeSearchCursor,
  searchQueryFingerprint,
} from "./search-cursor.js";
import {
  boundedInteger,
  discoverSearchFiles,
  optionalString,
  requiredString,
  snapshotPolicy,
  type SearchFile,
} from "./search-files.js";
import type { WorkspacePathPolicy } from "./workspace-path.js";

const DEFAULT_LIMIT = 1_000;
const HARD_LIMIT = 5_000;
const MAX_RESULT_BYTES = 128 * 1024;

interface FindOutput {
  path: string;
  pattern: string;
  files: string[];
  count: number;
  truncated: boolean;
  nextCursor?: string;
}

interface FindCursorAnchor {
  path: string;
}

export function createFindTool(policy: WorkspacePathPolicy = {}): AgentTool {
  const pathPolicy = snapshotPolicy(policy);
  return {
    definition: {
      name: "find",
      description: "Find workspace files by glob pattern in stable pages while respecting ignore files and protected paths. A returned nextCursor continues a truncated page.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
          },
          path: { type: "string", description: "Directory to search in (default: current directory)" },
          limit: { type: "integer", minimum: 1, maximum: HARD_LIMIT },
          cursor: {
            type: "string",
            description: "Opaque nextCursor from the previous search with the same pattern and path. The limit may change.",
          },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },

    async execute(arguments_, context): Promise<ToolResult> {
      try {
        const pattern = requiredString(arguments_.pattern, "pattern");
        const requestedPath = optionalString(arguments_.path, "path") ?? ".";
        const limit = boundedInteger(arguments_.limit, "limit", DEFAULT_LIMIT, 1, HARD_LIMIT);
        const cursor = optionalString(arguments_.cursor, "cursor");
        const discovery = await discoverSearchFiles(
          context.workspace,
          requestedPath,
          pattern,
          pathPolicy,
          context.signal,
        );
        const query = searchQueryFingerprint({
          workspace: discovery.root.workspace,
          root: discovery.root.absolute,
          pattern,
        });
        const anchor = cursor === undefined
          ? undefined
          : decodeSearchCursor(cursor, "find", query, isFindCursorAnchor);
        const start = anchor === undefined ? 0 : firstPathAfter(discovery.files, anchor.path);
        const page = discovery.files.slice(start, start + limit + 1);
        const selected = page.slice(0, limit);
        return success(boundOutput(
          discovery.root.relative,
          pattern,
          selected,
          discovery.truncated,
          page.length > limit,
          query,
        ));
      } catch (error: unknown) {
        return failure(error instanceof Error ? error.message : "File search failed");
      }
    },
  };
}

export const findTool: AgentTool = createFindTool();

function boundOutput(
  searchPath: string,
  pattern: string,
  files: readonly SearchFile[],
  discoveryTruncated: boolean,
  hasMore: boolean,
  query: string,
): FindOutput {
  const paths = files.map((file) => file.path);
  let pageTruncated = hasMore;
  while (true) {
    const truncated = discoveryTruncated || pageTruncated;
    const output: FindOutput = {
      path: searchPath,
      pattern,
      files: paths,
      count: paths.length,
      truncated,
      ...(pageTruncated && paths.length > 0
        ? { nextCursor: encodeSearchCursor("find", query, { path: paths.at(-1)! }) }
        : {}),
    };
    if (Buffer.byteLength(JSON.stringify(output), "utf8") <= MAX_RESULT_BYTES || paths.length === 0) {
      return output;
    }
    paths.pop();
    pageTruncated = true;
  }
}

function firstPathAfter(files: readonly SearchFile[], anchor: string): number {
  let low = 0;
  let high = files.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (files[middle]!.path <= anchor) low = middle + 1;
    else high = middle;
  }
  return low;
}

function isFindCursorAnchor(value: unknown): value is FindCursorAnchor {
  return isRecord(value)
    && typeof value.path === "string"
    && value.path.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function success(value: FindOutput): ToolResult {
  return { content: JSON.stringify(value), isError: false };
}

function failure(message: string): ToolResult {
  return { content: JSON.stringify({ error: message }), isError: true };
}
