import { constants } from "node:fs";

import type { ImageContent } from "@earendil-works/pi-ai";
import { fileTypeFromBuffer } from "file-type";

import {
  MAX_TOTAL_USER_IMAGE_BYTES,
  MAX_USER_IMAGE_BYTES,
  MAX_USER_IMAGES,
} from "../domain/images.js";
import {
  assertSameFile,
  openNoFollow,
  resolveExistingWorkspacePath,
  revalidateExistingWorkspacePath,
  type WorkspacePathPolicy,
} from "../tools/workspace-path.js";

export const MAX_INPUT_IMAGES = MAX_USER_IMAGES;
export const MAX_INPUT_IMAGE_BYTES = MAX_USER_IMAGE_BYTES;
export const MAX_TOTAL_INPUT_IMAGE_BYTES = MAX_TOTAL_USER_IMAGE_BYTES;

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export interface ProcessedImageInput {
  text: string;
  images: ImageContent[];
}

export interface ProcessImageInputOptions extends WorkspacePathPolicy {
  workspace: string;
}

export class ImageInputError extends Error {
  override readonly name = "ImageInputError";
}

/** Prime-style `@path` image loading, constrained to Nausicaa's workspace policy. */
export async function processImageInputs(
  requestedPaths: readonly string[],
  options: ProcessImageInputOptions,
): Promise<ProcessedImageInput> {
  if (requestedPaths.length > MAX_INPUT_IMAGES) {
    throw new ImageInputError(`At most ${MAX_INPUT_IMAGES} images may be attached`);
  }

  const images: ImageContent[] = [];
  const references: string[] = [];
  let totalBytes = 0;
  const policy = { protectedPaths: [...(options.protectedPaths ?? [])] };

  for (const requestedPath of requestedPaths) {
    const resolved = await resolveExistingWorkspacePath(
      options.workspace,
      normalizeUnicodeSpaces(requestedPath),
      policy,
    );
    const before = await revalidateExistingWorkspacePath(resolved);
    if (!before.isFile() || before.nlink !== 1) {
      throw new ImageInputError(`${resolved.relative} is not a regular file`);
    }
    if (before.size === 0) {
      throw new ImageInputError(`${resolved.relative} is empty`);
    }
    if (before.size > MAX_INPUT_IMAGE_BYTES) {
      throw new ImageInputError(
        `${resolved.relative} exceeds the ${formatMiB(MAX_INPUT_IMAGE_BYTES)} image limit`,
      );
    }
    if (totalBytes + before.size > MAX_TOTAL_INPUT_IMAGE_BYTES) {
      throw new ImageInputError(
        `Attached images exceed the ${formatMiB(MAX_TOTAL_INPUT_IMAGE_BYTES)} total limit`,
      );
    }

    const handle = await openNoFollow(resolved.absolute, constants.O_RDONLY);
    let bytes: Uint8Array;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1) {
        throw new ImageInputError(`${resolved.relative} is not a regular file`);
      }
      assertSameFile(before, opened);
      bytes = new Uint8Array(await handle.readFile());
      if (bytes.byteLength !== opened.size) {
        throw new ImageInputError(`${resolved.relative} changed while being read`);
      }
      assertSameFile(opened, await revalidateExistingWorkspacePath(resolved));
    } finally {
      await handle.close();
    }

    const detected = await fileTypeFromBuffer(bytes);
    if (detected === undefined || !SUPPORTED_IMAGE_TYPES.has(detected.mime)) {
      throw new ImageInputError(
        `${resolved.relative} is not a supported PNG, JPEG, GIF, or WebP image`,
      );
    }
    totalBytes += bytes.byteLength;
    images.push({
      type: "image",
      data: Buffer.from(bytes).toString("base64"),
      mimeType: detected.mime,
    });
    references.push(`<file name="${escapeAttribute(resolved.relative)}"></file>`);
  }

  return {
    text: references.join("\n"),
    images,
  };
}

function normalizeUnicodeSpaces(value: string): string {
  return value.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatMiB(bytes: number): string {
  return `${bytes / (1024 * 1024)} MiB`;
}
