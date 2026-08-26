import type { AgentTool, ToolResult } from "../domain/ports.js";
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
}

export function createFindTool(policy: WorkspacePathPolicy = {}): AgentTool {
  const pathPolicy = snapshotPolicy(policy);
  return {
    definition: {
      name: "find",
      description: "Find workspace files by glob pattern while respecting ignore files and protected paths.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
          },
          path: { type: "string", description: "Directory to search in (default: current directory)" },
          limit: { type: "integer", minimum: 1, maximum: HARD_LIMIT },
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
        const discovery = await discoverSearchFiles(
          context.workspace,
          requestedPath,
          pattern,
          pathPolicy,
          context.signal,
        );
        const selected = discovery.files.slice(0, limit);
        return success(boundOutput(
          discovery.root.relative,
          pattern,
          selected,
          discovery.truncated || discovery.files.length > limit,
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
  initiallyTruncated: boolean,
): FindOutput {
  const paths = files.map((file) => file.path);
  let truncated = initiallyTruncated;
  while (true) {
    const output: FindOutput = {
      path: searchPath,
      pattern,
      files: paths,
      count: paths.length,
      truncated,
    };
    if (Buffer.byteLength(JSON.stringify(output), "utf8") <= MAX_RESULT_BYTES || paths.length === 0) {
      return output;
    }
    paths.pop();
    truncated = true;
  }
}

function success(value: FindOutput): ToolResult {
  return { content: JSON.stringify(value), isError: false };
}

function failure(message: string): ToolResult {
  return { content: JSON.stringify({ error: message }), isError: true };
}
