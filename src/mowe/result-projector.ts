import type { ToolResult } from "../domain/ports.js";
import { stableJson } from "../ledger/hash.js";
import type { MoweArtifactStore, MoweResultProjection, ResultProjectionOptions } from "./types.js";

const DEFAULT_PREVIEW_BYTES = 4_096;
const RESULT_MEDIA_TYPE = "text/plain; charset=utf-8";
const MULTIMODAL_RESULT_MEDIA_TYPE = "application/json";

export interface SerializedToolResult {
  /** Canonical bytes retained by an artifact store or counted by Mowe. */
  bytes: Buffer;
  mediaType: string;
  multimodal: boolean;
}

/**
 * Encode a tool result for retention and accounting.
 *
 * Keep the historical raw-text representation for text-only results.  Once a
 * result carries images, the text alone is not recoverable, so the artifact
 * is a canonical JSON envelope containing the complete ToolResult payload.
 */
export function serializeToolResult(result: ToolResult): SerializedToolResult {
  if ((result.images?.length ?? 0) === 0) {
    return {
      bytes: Buffer.from(result.content, "utf8"),
      mediaType: RESULT_MEDIA_TYPE,
      multimodal: false,
    };
  }
  const payload = stableJson({
    content: result.content,
    images: result.images,
    isError: result.isError,
  });
  return {
    bytes: Buffer.from(payload, "utf8"),
    mediaType: MULTIMODAL_RESULT_MEDIA_TYPE,
    multimodal: true,
  };
}

/** Return the exact byte count used for aggregate output accounting. */
export function toolResultByteLength(result: ToolResult): number {
  return serializeToolResult(result).bytes.byteLength;
}

export async function projectResult(
  result: ToolResult,
  options: ResultProjectionOptions = {},
  artifactStore?: MoweArtifactStore,
): Promise<MoweResultProjection> {
  const contentBytes = Buffer.from(result.content, "utf8");
  const payload = serializeToolResult(result);
  const byteLength = payload.bytes.byteLength;
  const hasImages = payload.multimodal;
  const requestedMode = options.mode ?? "auto";
  const maxBytes = boundedMaxBytes(options.maxBytes);
  const mode = requestedMode === "auto"
    ? (byteLength <= maxBytes ? "inline" : "preview")
    : requestedMode;
  if (mode === "inline") {
    return {
      mode,
      content: result.content,
      byteLength,
      truncated: false,
      ...(hasImages ? { images: result.images } : {}),
    };
  }
  if (mode === "artifact" && artifactStore !== undefined) {
    const artifactRef = await artifactStore.put(payload.bytes, payload.mediaType);
    return { mode, artifactRef, byteLength, truncated: false };
  }
  const excerpt = utf8Prefix(contentBytes, maxBytes);
  // A multimodal payload can exceed the preview budget even when its text
  // does not.  In that case omit the image blocks from the bounded view while
  // retaining the complete envelope in the artifact (when available).
  const includeImages = hasImages && payload.bytes.byteLength <= maxBytes;
  const truncated = excerpt.byteLength < contentBytes.byteLength || (hasImages && !includeImages);
  if (mode === "preview" || mode === "artifact") {
    const artifactRef = artifactStore === undefined
      ? undefined
      : await artifactStore.put(payload.bytes, payload.mediaType);
    return {
      mode: "preview",
      content: `${excerpt.toString("utf8")}${truncated ? "\n[TRUNCATED]" : ""}`,
      byteLength,
      truncated,
      ...(includeImages ? { images: result.images } : {}),
      ...(artifactRef === undefined ? {} : { artifactRef }),
    };
  }
  const lines = result.content.length === 0 ? 0 : result.content.split(/\r?\n/).length;
  const summary = JSON.stringify({
    byteLength,
    lineCount: lines,
    preview: excerpt.toString("utf8"),
    truncated,
    ...(hasImages ? { imageCount: result.images?.length ?? 0 } : {}),
  });
  const artifactRef = artifactStore === undefined
    ? undefined
    : await artifactStore.put(payload.bytes, payload.mediaType);
  return {
    mode: "summary",
    content: summary,
    byteLength,
    truncated,
    ...(artifactRef === undefined ? {} : { artifactRef }),
  };
}

function boundedMaxBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PREVIEW_BYTES;
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("maxBytes must be a positive integer");
  return value;
}

function utf8Prefix(bytes: Buffer, maxBytes: number): Buffer {
  if (bytes.byteLength <= maxBytes) return bytes;
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end);
}
