import type { ArtifactRef, ConversationMessage } from "../domain/types.js";
import { validateUserImages } from "../domain/images.js";
import type {
  FukaiArtifactRead,
  FukaiReadOptions,
  FukaiSource,
} from "./types.js";

export interface FukaiContentStore {
  get(ref: ArtifactRef): Promise<Uint8Array>;
}

/** Adapts an immutable content store to Fukai's bounded read contract. */
export class ContentStoreFukaiSource implements FukaiSource {
  constructor(private readonly store: FukaiContentStore) {}

  async hasArtifact(
    ref: ArtifactRef,
    options: FukaiReadOptions = {},
  ): Promise<boolean> {
    throwIfAborted(options.signal);
    const bytes = await readOptional(this.store, ref);
    throwIfAborted(options.signal);
    return bytes !== undefined;
  }

  async readConversation(
    ref: ArtifactRef,
    options: FukaiReadOptions = {},
  ): Promise<ConversationMessage | undefined> {
    throwIfAborted(options.signal);
    const bytes = await readOptional(this.store, ref);
    throwIfAborted(options.signal);
    if (bytes === undefined) {
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return undefined;
    }
    return isConversationMessage(parsed) ? parsed : undefined;
  }

  async readArtifact(
    ref: ArtifactRef,
    range: { offset: number; length: number },
    options: FukaiReadOptions = {},
  ): Promise<FukaiArtifactRead | undefined> {
    validateRange(range);
    throwIfAborted(options.signal);
    const bytes = await readOptional(this.store, ref);
    throwIfAborted(options.signal);
    if (bytes === undefined) {
      return undefined;
    }
    const start = Math.min(range.offset, bytes.byteLength);
    const end = Math.min(bytes.byteLength, start + range.length);
    const selected = bytes.subarray(start, end);
    return {
      content: decodeBoundedUtf8(selected),
      contentHash: ref.contentHash,
      byteLength: bytes.byteLength,
    };
  }
}

function decodeBoundedUtf8(bytes: Uint8Array): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let trimStart = 0; trimStart <= Math.min(3, bytes.byteLength); trimStart += 1) {
    for (let trimEnd = 0; trimEnd <= Math.min(3, bytes.byteLength - trimStart); trimEnd += 1) {
      try {
        return decoder.decode(bytes.subarray(trimStart, bytes.byteLength - trimEnd));
      } catch {
        // Byte ranges may split a code point at either edge.
      }
    }
  }
  return "";
}

async function readOptional(
  store: FukaiContentStore,
  ref: ArtifactRef,
): Promise<Uint8Array | undefined> {
  try {
    return await store.get(ref);
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "ArtifactNotFoundError") {
      return undefined;
    }
    throw error;
  }
}

function isConversationMessage(value: unknown): value is ConversationMessage {
  if (!isRecord(value) || typeof value.createdAt !== "string" || typeof value.content !== "string") {
    return false;
  }
  if (value.role === "user") {
    try {
      validateUserImages(value.images);
      return true;
    } catch {
      return false;
    }
  }
  if (value.role === "tool" && value.images !== undefined) {
    try {
      validateUserImages(value.images);
    } catch {
      return false;
    }
  } else if (value.images !== undefined) {
    return false;
  }
  if (value.role === "tool") {
    return typeof value.toolCallId === "string"
      && typeof value.toolName === "string"
      && typeof value.isError === "boolean";
  }
  if (value.role !== "assistant" || !Array.isArray(value.toolCalls)) {
    return false;
  }
  return value.toolCalls.every((call) =>
    isRecord(call)
    && typeof call.id === "string"
    && typeof call.name === "string"
    && isRecord(call.arguments),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRange(range: { offset: number; length: number }): void {
  if (!Number.isSafeInteger(range.offset) || range.offset < 0) {
    throw new RangeError("Artifact offset must be a non-negative integer");
  }
  if (!Number.isSafeInteger(range.length) || range.length < 0) {
    throw new RangeError("Artifact length must be a non-negative integer");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}
