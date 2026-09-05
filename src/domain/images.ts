import type { ImageContent } from "@earendil-works/pi-ai";

export type UserImage = ImageContent;

export const MAX_USER_IMAGES = 4;
export const MAX_USER_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_TOTAL_USER_IMAGE_BYTES = 10 * 1024 * 1024;
/** Conservative provider-input estimate used by every context builder. */
export const ESTIMATED_IMAGE_TOKENS = 1_024;
const IMAGE_BYTES_PER_ESTIMATED_TOKEN = 1_024;

const SUPPORTED_MEDIA_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function validateUserImages(value: unknown): asserts value is UserImage[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new TypeError("images must be an array");
  }
  if (value.length > MAX_USER_IMAGES) {
    throw new TypeError(`At most ${MAX_USER_IMAGES} images may be attached`);
  }

  let totalBytes = 0;
  for (const image of value) {
    if (!isPlainRecord(image) || image.type !== "image") {
      throw new TypeError("Each image must be a pi-ai ImageContent block");
    }
    if (typeof image.mimeType !== "string" || !SUPPORTED_MEDIA_TYPES.has(image.mimeType)) {
      throw new TypeError("Image mimeType must be PNG, JPEG, GIF, or WebP");
    }
    if (typeof image.data !== "string" || image.data.length === 0 || !BASE64.test(image.data)) {
      throw new TypeError("Image data must be canonical base64");
    }
    if (image.data.length > Math.ceil(MAX_USER_IMAGE_BYTES / 3) * 4) {
      throw new TypeError("Image data exceeds the per-image limit");
    }
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.byteLength > MAX_USER_IMAGE_BYTES || bytes.toString("base64") !== image.data) {
      throw new TypeError("Image data exceeds the per-image limit or is not canonical base64");
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_USER_IMAGE_BYTES) {
      throw new TypeError("Image data exceeds the total attachment limit");
    }
  }
}

export function userImageSummary(images: readonly UserImage[] | undefined): string[] {
  return (images ?? []).map((image) => image.mimeType);
}

/** Decoded payload size for a canonical image block. Validate untrusted blocks first. */
export function userImageByteLength(image: UserImage): number {
  return Buffer.from(image.data, "base64").byteLength;
}

/**
 * Conservative provider-independent estimate. Image tokenization varies by
 * model, so retain the existing 1,024-token floor and charge larger inputs by
 * their decoded size as an additional admission signal.
 */
export function estimateUserImageTokens(images: readonly UserImage[] | undefined): number {
  return (images ?? []).reduce((total, image) => (
    total + Math.max(
      ESTIMATED_IMAGE_TOKENS,
      Math.ceil(userImageByteLength(image) / IMAGE_BYTES_PER_ESTIMATED_TOKEN),
    )
  ), 0);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
