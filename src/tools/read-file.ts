import { constants } from "node:fs";

import type { AgentTool, ToolResult } from "../domain/ports.js";
import {
  assertSameFile,
  openNoFollow,
  resolveExistingWorkspacePath,
  revalidateExistingWorkspacePath,
  type WorkspacePathPolicy,
} from "./workspace-path.js";

const DEFAULT_MAX_BYTES = 50 * 1024;
const HARD_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_LINES = 2_000;
const HARD_MAX_LINES = 10_000;
const HARD_SCAN_BYTES = 16 * 1024 * 1024;

export function createReadFileTool(policy: WorkspacePathPolicy = {}): AgentTool {
  const pathPolicy = snapshotPolicy(policy);
  return {
  definition: {
    name: "read_file",
    description: "Read a line window from a UTF-8 workspace file. nextOffset always identifies the first unread complete line. When lineTruncated is true, continue that line with the returned nextLineByteOffset, or retry it with a larger maxBytes value.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path" },
        offset: { type: "integer", minimum: 1, description: "1-based starting line" },
        lineByteOffset: {
          type: "integer",
          minimum: 0,
          description: "UTF-8 byte offset within the starting line; only use a returned nextLineByteOffset value",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: HARD_MAX_LINES,
          description: `Maximum lines to return; defaults to ${DEFAULT_MAX_LINES}`,
        },
        maxBytes: { type: "integer", minimum: 1, maximum: HARD_MAX_BYTES },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },

  async execute(arguments_, context): Promise<ToolResult> {
    try {
      throwIfAborted(context.signal);
      const requestedPath = stringArgument(arguments_.path, "path");
      const offset = boundedInteger(arguments_.offset, "offset", 1, Number.MAX_SAFE_INTEGER);
      const lineByteOffset = boundedNonnegativeInteger(
        arguments_.lineByteOffset,
        "lineByteOffset",
        0,
        Number.MAX_SAFE_INTEGER,
      );
      const limit = boundedInteger(arguments_.limit, "limit", DEFAULT_MAX_LINES, HARD_MAX_LINES);
      const maxBytes = boundedInteger(arguments_.maxBytes, "maxBytes", DEFAULT_MAX_BYTES, HARD_MAX_BYTES);
      const resolved = await resolveExistingWorkspacePath(
        context.workspace,
        requestedPath,
        pathPolicy,
      );
      await revalidateExistingWorkspacePath(resolved);
      const handle = await openNoFollow(resolved.absolute, constants.O_RDONLY);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1) {
          return failure("Path is not a regular file");
        }
        assertSameFile(stat, await revalidateExistingWorkspacePath(resolved));
        const scanBytes = Math.min(stat.size, HARD_SCAN_BYTES);
        const buffer = Buffer.alloc(scanBytes);
        const { bytesRead } = await handle.read(buffer, 0, scanBytes, 0);
        throwIfAborted(context.signal);
        assertSameFile(stat, await revalidateExistingWorkspacePath(resolved));
        const scanTruncated = stat.size > bytesRead;
        const decoded = new TextDecoder().decode(buffer.subarray(0, bytesRead));
        const normalized = decoded.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
        const allLines = normalized.length === 0 ? [] : normalized.split("\n");
        const startIndex = offset - 1;
        if (scanTruncated && startIndex >= allLines.length) {
          return failure(`offset is beyond the ${formatBytes(HARD_SCAN_BYTES)} scan window`);
        }

        const requestedLines = allLines.slice(startIndex, startIndex + limit);
        const bounded = boundLines(requestedLines, maxBytes, lineByteOffset);
        const nextIndex = startIndex + bounded.consumedLines;
        const hasMore = bounded.truncated
          || nextIndex < allLines.length
          || scanTruncated;
        return success({
          path: resolved.relative,
          content: bounded.content,
          byteLength: stat.size,
          offset,
          ...(lineByteOffset === 0 ? {} : { lineByteOffset }),
          lineCount: bounded.consumedLines,
          ...(scanTruncated ? {} : { totalLines: allLines.length }),
          truncated: hasMore,
          ...(hasMore ? { nextOffset: offset + bounded.consumedLines } : {}),
          ...(bounded.nextLineByteOffset === undefined
            ? {}
            : { nextLineByteOffset: bounded.nextLineByteOffset }),
          ...(bounded.minimumMaxBytes === undefined
            ? {}
            : { minimumMaxBytes: bounded.minimumMaxBytes }),
          ...(bounded.lineTruncated ? { lineTruncated: true } : {}),
          ...(scanTruncated ? { scanTruncated: true } : {}),
        });
      } finally {
        await handle.close();
      }
    } catch (error: unknown) {
      return failure(safeMessage(error));
    }
  },
  };
}

function boundLines(
  lines: readonly string[],
  maxBytes: number,
  lineByteOffset: number,
): {
  content: string;
  consumedLines: number;
  truncated: boolean;
  lineTruncated: boolean;
  nextLineByteOffset?: number;
  minimumMaxBytes?: number;
} {
  if (lines.length === 0) {
    if (lineByteOffset !== 0) {
      throw new RangeError("lineByteOffset requires an existing starting line");
    }
    return { content: "", consumedLines: 0, truncated: false, lineTruncated: false };
  }

  const output: string[] = [];
  let bytes = 0;
  let consumedLines = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const sourceLine = lines[index] ?? "";
    const line = index === 0
      ? utf8SuffixAt(sourceLine, lineByteOffset)
      : sourceLine;
    const separatorBytes = output.length === 0 ? 0 : 1;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (bytes + separatorBytes + lineBytes <= maxBytes) {
      output.push(line);
      bytes += separatorBytes + lineBytes;
      consumedLines += 1;
      continue;
    }
    if (output.length === 0) {
      const prefix = utf8Prefix(line, maxBytes);
      const prefixBytes = Buffer.byteLength(prefix, "utf8");
      const minimumMaxBytes = prefixBytes === 0 && line.length > 0
        ? Buffer.byteLength([...line][0] ?? "", "utf8")
        : undefined;
      return {
        content: prefix,
        // A prefix is only a preview: the line remains unread until it can be
        // returned whole, so nextOffset must continue to point at this line.
        consumedLines: 0,
        truncated: true,
        lineTruncated: true,
        nextLineByteOffset: lineByteOffset + prefixBytes,
        ...(minimumMaxBytes === undefined ? {} : { minimumMaxBytes }),
      };
    }
    return {
      content: output.join("\n"),
      consumedLines,
      truncated: true,
      lineTruncated: false,
    };
  }
  return {
    content: output.join("\n"),
    consumedLines,
    truncated: false,
    lineTruncated: false,
  };
}

function utf8SuffixAt(value: string, byteOffset: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (byteOffset > bytes.length) {
    throw new RangeError(`lineByteOffset exceeds the starting line's ${bytes.length} UTF-8 bytes`);
  }
  if (byteOffset < bytes.length && (bytes[byteOffset]! & 0xc0) === 0x80) {
    throw new RangeError("lineByteOffset must be on a UTF-8 character boundary");
  }
  return bytes.subarray(byteOffset).toString("utf8");
}

function utf8Prefix(value: string, maxBytes: number): string {
  const output: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    output.push(character);
    bytes += characterBytes;
  }
  return output.join("");
}

function formatBytes(bytes: number): string {
  return `${Math.floor(bytes / (1024 * 1024))}MB`;
}

export const readFileTool: AgentTool = createReadFileTool();

function snapshotPolicy(policy: WorkspacePathPolicy): WorkspacePathPolicy {
  return { protectedPaths: [...(policy.protectedPaths ?? [])] };
}

function stringArgument(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  name: string,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value as number;
}

function boundedNonnegativeInteger(
  value: unknown,
  name: string,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new TypeError(`${name} must be an integer between 0 and ${maximum}`);
  }
  return value as number;
}

function success(value: unknown): ToolResult {
  return { content: JSON.stringify(value), isError: false };
}

function failure(message: string): ToolResult {
  return { content: JSON.stringify({ error: message }), isError: true };
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "File read failed";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted", "AbortError");
  }
}
