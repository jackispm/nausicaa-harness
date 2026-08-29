import { constants } from "node:fs";

import type { ImageContent } from "@earendil-works/pi-ai";
import { fileTypeFromBuffer } from "file-type";

import type { AgentTool, ToolResult } from "../domain/ports.js";
import {
  MAX_USER_IMAGE_BYTES,
} from "../domain/images.js";
import {
  assertSameFile,
  openNoFollow,
  resolveExistingWorkspacePath,
  revalidateExistingWorkspacePath,
  type WorkspacePathPolicy,
} from "./workspace-path.js";

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/**
 * Read one workspace image as a provider-native image block.
 *
 * The bytes stay bounded and are validated by magic bytes instead of trusting
 * the filename.  The existing no-follow workspace path checks are repeated
 * around the read so a path swap cannot turn this into an arbitrary file
 * reader.
 */
export function createReadImageTool(policy: WorkspacePathPolicy = {}): AgentTool {
  const pathPolicy = snapshotPolicy(policy);
  return {
    definition: {
      name: "read_image",
      description: "Read a PNG, JPEG, GIF, or WebP workspace image and return it as a vision input for the model.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative image path" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },

    async execute(arguments_, context): Promise<ToolResult> {
      try {
        throwIfAborted(context.signal);
        const requestedPath = stringArgument(arguments_.path, "path");
        const resolved = await resolveExistingWorkspacePath(
          context.workspace,
          requestedPath,
          pathPolicy,
        );
        const before = await revalidateExistingWorkspacePath(resolved);
        assertImageFile(before, resolved.relative);

        const handle = await openNoFollow(resolved.absolute, constants.O_RDONLY);
        let bytes: Uint8Array;
        try {
          const opened = await handle.stat();
          assertImageFile(opened, resolved.relative);
          assertSameFile(before, opened);
          bytes = new Uint8Array(await handle.readFile());
          if (bytes.byteLength !== opened.size) {
            throw new Error("Image changed while being read");
          }
          assertSameFile(opened, await revalidateExistingWorkspacePath(resolved));
        } finally {
          await handle.close();
        }

        throwIfAborted(context.signal);
        const detected = await fileTypeFromBuffer(bytes);
        if (detected === undefined || !SUPPORTED_IMAGE_TYPES.has(detected.mime)) {
          throw new Error("File is not a supported PNG, JPEG, GIF, or WebP image");
        }
        const image: ImageContent = {
          type: "image",
          data: Buffer.from(bytes).toString("base64"),
          mimeType: detected.mime,
        };
        return {
          content: JSON.stringify({
            path: resolved.relative,
            mimeType: detected.mime,
            byteLength: bytes.byteLength,
          }),
          isError: false,
          images: [image],
        };
      } catch (error: unknown) {
        return {
          content: JSON.stringify({ error: safeMessage(error) }),
          isError: true,
        };
      }
    },
  };
}

export const readImageTool: AgentTool = createReadImageTool();

function snapshotPolicy(policy: WorkspacePathPolicy): WorkspacePathPolicy {
  return { protectedPaths: [...(policy.protectedPaths ?? [])] };
}

function assertImageFile(
  stats: { isFile(): boolean; nlink: number; size: number },
  relativePath: string,
): void {
  if (!stats.isFile() || stats.nlink !== 1) {
    throw new Error(`${relativePath} is not a private regular file`);
  }
  if (stats.size === 0) {
    throw new Error(`${relativePath} is empty`);
  }
  if (stats.size > MAX_USER_IMAGE_BYTES) {
    throw new Error(`${relativePath} exceeds the ${MAX_USER_IMAGE_BYTES}-byte image limit`);
  }
}

function stringArgument(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Image read failed";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}
