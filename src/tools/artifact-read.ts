import type { AgentTool, ToolResult } from "../domain/ports.js";
import type { ArtifactRef, RunId } from "../domain/types.js";
import { assertArtifactRef, type ContentAddressedStore } from "../store/index.js";

export const DEFAULT_ARTIFACT_READ_BYTES = 32 * 1024;
// JSON escaping can expand one source byte to six bytes (for example NUL).
// Keeping a page at 32 KiB guarantees the structured result remains below
// Main's 256 KiB context projection and cannot recursively externalize itself.
export const MAX_ARTIFACT_READ_BYTES = 32 * 1024;
export const MAX_ARTIFACT_SOURCE_BYTES = 64 * 1024 * 1024;
export const ARTIFACT_READ_TOOL_NAME = "artifact_read";
export const ARTIFACT_READ_POINTER_PREFIX = "[Full tool result stored as artifact; call artifact_read with ";

export const ARTIFACT_READ_CACHE_MAX_BYTES = MAX_ARTIFACT_SOURCE_BYTES;
export const ARTIFACT_READ_CACHE_MAX_ENTRIES = 64;
export const ARTIFACT_READ_IN_FLIGHT_MAX_BYTES = 128 * 1024 * 1024;
export const ARTIFACT_READ_IN_FLIGHT_MAX_ENTRIES = 8;

export interface RunArtifactHandle {
  runId: RunId;
  ref: ArtifactRef;
}

export type ArtifactReadStore = Pick<ContentAddressedStore, "get">;

/**
 * Run-owned capability registry for artifacts emitted by Mowe. A handle is
 * readable only after its exact ref was registered by the current Run's
 * durable execution path. The model-visible runId is therefore an identifier,
 * never the source of authority.
 */
export class RunArtifactAuthorization {
  readonly #refsByRun = new Map<string, Map<string, ArtifactRef>>();

  beginRun(runId: RunId, refs: readonly ArtifactRef[] = []): void {
    validateRunId(runId);
    const refsForRun = new Map<string, ArtifactRef>();
    for (const ref of refs) this.addToMap(refsForRun, ref);
    this.#refsByRun.set(runId, refsForRun);
  }

  authorize(runId: RunId, ref: ArtifactRef): void {
    validateRunId(runId);
    let refsForRun = this.#refsByRun.get(runId);
    if (refsForRun === undefined) {
      refsForRun = new Map<string, ArtifactRef>();
      this.#refsByRun.set(runId, refsForRun);
    }
    this.addToMap(refsForRun, ref);
  }

  has(runId: RunId, ref: ArtifactRef): boolean {
    const refsForRun = this.#refsByRun.get(runId);
    if (refsForRun === undefined) return false;
    const registered = refsForRun.get(artifactRefKey(ref));
    return registered !== undefined && sameArtifactRef(registered, ref);
  }

  hasAny(runId: RunId): boolean {
    return (this.#refsByRun.get(runId)?.size ?? 0) > 0;
  }

  private addToMap(target: Map<string, ArtifactRef>, ref: ArtifactRef): void {
    assertArtifactRef(ref);
    target.set(artifactRefKey(ref), structuredClone(ref));
  }
}

export interface ArtifactReadCacheOptions {
  maxBytes?: number;
  maxEntries?: number;
  maxInFlightBytes?: number;
  maxInFlightEntries?: number;
}

/**
 * Read a bounded UTF-8 window from a content-addressed artifact belonging to
 * the active Run. The model never supplies a filesystem path.
 */
export function createArtifactReadTool(
  store: ArtifactReadStore,
  authorization?: RunArtifactAuthorization,
  options: ArtifactReadCacheOptions = {},
): AgentTool {
  const cache = new Map<string, CachedArtifact>();
  const inFlight = new Map<string, Promise<Uint8Array>>();
  let cachedBytes = 0;
  let inFlightBytes = 0;
  const cacheMaxBytes = positiveLimit(
    options.maxBytes ?? ARTIFACT_READ_CACHE_MAX_BYTES,
    "cache maxBytes",
  );
  const cacheMaxEntries = positiveLimit(
    options.maxEntries ?? ARTIFACT_READ_CACHE_MAX_ENTRIES,
    "cache maxEntries",
  );
  const inFlightMaxBytes = positiveLimit(
    options.maxInFlightBytes ?? ARTIFACT_READ_IN_FLIGHT_MAX_BYTES,
    "in-flight maxBytes",
  );
  const inFlightMaxEntries = positiveLimit(
    options.maxInFlightEntries ?? ARTIFACT_READ_IN_FLIGHT_MAX_ENTRIES,
    "in-flight maxEntries",
  );

  return {
    definition: {
      name: ARTIFACT_READ_TOOL_NAME,
      description: "Read a bounded UTF-8 byte window from a Run artifact emitted by Mowe. Copy the artifact handle exactly from a tool-result pointer and continue with nextOffset. This tool never accepts filesystem paths.",
      parameters: {
        type: "object",
        properties: {
          artifact: {
            type: "object",
            properties: {
              runId: { type: "string", minLength: 1 },
              ref: {
                type: "object",
                properties: {
                  id: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
                  contentHash: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
                  mediaType: { type: "string", minLength: 1 },
                  byteLength: { type: "integer", minimum: 0, maximum: MAX_ARTIFACT_SOURCE_BYTES },
                },
                required: ["id", "contentHash", "mediaType", "byteLength"],
                additionalProperties: false,
              },
            },
            required: ["runId", "ref"],
            additionalProperties: false,
          },
          offset: {
            type: "integer",
            minimum: 0,
            maximum: MAX_ARTIFACT_SOURCE_BYTES,
            description: "UTF-8 byte offset; omit for the first window and otherwise use nextOffset exactly",
          },
          limit: {
            type: "integer",
            minimum: 4,
            maximum: MAX_ARTIFACT_READ_BYTES,
            description: `Maximum source bytes to return; defaults to ${DEFAULT_ARTIFACT_READ_BYTES}`,
          },
        },
        required: ["artifact"],
        additionalProperties: false,
      },
    },

    async execute(arguments_, context): Promise<ToolResult> {
      try {
        throwIfAborted(context.signal);
        const artifact = parseRunArtifactHandle(arguments_.artifact);
        if (artifact.runId !== context.runId) {
          throw new Error("Artifact belongs to a different Run");
        }
        if (authorization !== undefined && !authorization.has(context.runId, artifact.ref)) {
          throw new Error("Artifact is not authorized for this Run");
        }
        if (!isTextMediaType(artifact.ref.mediaType)) {
          throw new Error(`Artifact media type is not UTF-8 text: ${artifact.ref.mediaType}`);
        }
        if (artifact.ref.byteLength > MAX_ARTIFACT_SOURCE_BYTES) {
          throw new Error(`Artifact exceeds the ${MAX_ARTIFACT_SOURCE_BYTES}-byte read limit`);
        }
        const offset = boundedInteger(
          arguments_.offset,
          "offset",
          0,
          0,
          artifact.ref.byteLength,
        );
        const limit = boundedInteger(
          arguments_.limit,
          "limit",
          DEFAULT_ARTIFACT_READ_BYTES,
          4,
          MAX_ARTIFACT_READ_BYTES,
        );
        throwIfAborted(context.signal);
        const bytes = await loadArtifact(
          artifact.ref,
          context.signal,
          cache,
          inFlight,
          () => cachedBytes,
          (value) => { cachedBytes = value; },
          () => inFlightBytes,
          (value) => { inFlightBytes = value; },
          store,
          {
            cacheMaxBytes,
            cacheMaxEntries,
            inFlightMaxBytes,
            inFlightMaxEntries,
          },
        );
        throwIfAborted(context.signal);
        if (offset < bytes.byteLength && isUtf8ContinuationByte(bytes[offset]!)) {
          throw new Error("offset must be a UTF-8 boundary returned as nextOffset");
        }
        const end = utf8WindowEnd(bytes, offset, limit);
        const content = new TextDecoder("utf-8", { fatal: true })
          .decode(bytes.subarray(offset, end));
        const output = {
          // Repeat the complete capability handle on every page so a
          // compacted-away pointer cannot strand the next pagination call.
          artifact,
          artifactId: artifact.ref.id,
          mediaType: artifact.ref.mediaType,
          offset,
          returnedBytes: end - offset,
          totalBytes: artifact.ref.byteLength,
          content,
          truncated: end < artifact.ref.byteLength,
          ...(end < artifact.ref.byteLength ? { nextOffset: end } : {}),
        };
        return { content: JSON.stringify(output), isError: false };
      } catch (error: unknown) {
        if (context.signal?.aborted === true) throw abortReason(context.signal);
        return failure(error instanceof Error ? error.message : "Artifact read failed");
      }
    },
  };
}

interface CachedArtifact {
  bytes: Uint8Array;
  size: number;
}

interface ArtifactReadLimits {
  cacheMaxBytes: number;
  cacheMaxEntries: number;
  inFlightMaxBytes: number;
  inFlightMaxEntries: number;
}

async function loadArtifact(
  ref: ArtifactRef,
  signal: AbortSignal | undefined,
  cache: Map<string, CachedArtifact>,
  inFlight: Map<string, Promise<Uint8Array>>,
  readCachedBytes: () => number,
  writeCachedBytes: (value: number) => void,
  readInFlightBytes: () => number,
  writeInFlightBytes: (value: number) => void,
  store: ArtifactReadStore,
  limits: ArtifactReadLimits,
): Promise<Uint8Array> {
  const key = artifactRefKey(ref);
  const cached = cache.get(key);
  if (cached !== undefined) {
    cache.delete(key);
    cache.set(key, cached);
    return awaitWithAbort(Promise.resolve(cached.bytes), signal);
  }

  const existing = inFlight.get(key);
  if (existing !== undefined) return awaitWithAbort(existing, signal);
  if (
    inFlight.size >= limits.inFlightMaxEntries
    || readInFlightBytes() + ref.byteLength > limits.inFlightMaxBytes
  ) {
    throw new Error("Artifact reader is busy; retry this read");
  }

  inFlightBytesAdd(writeInFlightBytes, readInFlightBytes, ref.byteLength);
  const promise = Promise.resolve()
    .then(() => store.get(ref))
    .then((bytes) => {
      if (bytes.byteLength !== ref.byteLength) {
        throw new Error(
          `Artifact length mismatch: expected ${ref.byteLength}, received ${bytes.byteLength}`,
        );
      }
      const snapshot = Uint8Array.from(bytes);
      if (
        snapshot.byteLength <= limits.cacheMaxBytes
        && limits.cacheMaxEntries > 0
      ) {
        while (
          cache.size >= limits.cacheMaxEntries
          || readCachedBytes() + snapshot.byteLength > limits.cacheMaxBytes
        ) {
          const oldest = cache.entries().next().value as [string, CachedArtifact] | undefined;
          if (oldest === undefined) break;
          cache.delete(oldest[0]);
          writeCachedBytes(readCachedBytes() - oldest[1].size);
        }
        cache.set(key, { bytes: snapshot, size: snapshot.byteLength });
        writeCachedBytes(readCachedBytes() + snapshot.byteLength);
      }
      return snapshot;
    });
  inFlight.set(key, promise);
  const cleanup = (): void => {
    if (inFlight.get(key) === promise) {
      inFlight.delete(key);
      writeInFlightBytes(readInFlightBytes() - ref.byteLength);
    }
  };
  // Handle both outcomes without creating an unobserved rejecting promise.
  void promise.then(cleanup, cleanup);
  return awaitWithAbort(promise, signal);
}

function inFlightBytesAdd(
  write: (value: number) => void,
  read: () => number,
  bytes: number,
): void {
  write(read() + bytes);
}

async function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted === true) throw abortReason(signal);
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function runArtifactHandle(runId: RunId, ref: ArtifactRef): RunArtifactHandle {
  if (typeof runId !== "string" || runId.length === 0 || runId.includes("\0")) {
    throw new TypeError("runId must be a non-empty string without NUL");
  }
  assertArtifactRef(ref);
  return { runId, ref: structuredClone(ref) };
}

function artifactRefKey(ref: ArtifactRef): string {
  assertArtifactRef(ref);
  return JSON.stringify([ref.id, ref.contentHash, ref.mediaType, ref.byteLength]);
}

function sameArtifactRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return left.id === right.id
    && left.contentHash === right.contentHash
    && left.mediaType === right.mediaType
    && left.byteLength === right.byteLength;
}

function validateRunId(runId: RunId): void {
  if (typeof runId !== "string" || runId.length === 0 || runId.includes("\0")) {
    throw new TypeError("runId must be a non-empty string without NUL");
  }
}

function positiveLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value;
}

/** Model-visible suffix used whenever Mowe externalizes a complete result. */
export function artifactReadPointer(runId: RunId, ref: ArtifactRef): string {
  const arguments_ = JSON.stringify({ artifact: runArtifactHandle(runId, ref) });
  return `${ARTIFACT_READ_POINTER_PREFIX}${arguments_} and optional offset/limit. ${ref.byteLength} bytes]`;
}

function parseRunArtifactHandle(value: unknown): RunArtifactHandle {
  if (!isPlainRecord(value)) throw new TypeError("artifact must be an object");
  assertExactKeys(value, ["runId", "ref"], "artifact");
  if (typeof value.runId !== "string" || value.runId.length === 0 || value.runId.includes("\0")) {
    throw new TypeError("artifact.runId must be a non-empty string without NUL");
  }
  if (!isPlainRecord(value.ref)) throw new TypeError("artifact.ref must be an object");
  assertExactKeys(value.ref, ["id", "contentHash", "mediaType", "byteLength"], "artifact.ref");
  const ref = value.ref as unknown as ArtifactRef;
  assertArtifactRef(ref);
  if (typeof ref.mediaType !== "string" || ref.mediaType.length === 0 || ref.mediaType.includes("\0")) {
    throw new TypeError("artifact.ref.mediaType must be a non-empty string without NUL");
  }
  return { runId: value.runId, ref: structuredClone(ref) };
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const allowed = new Set(expected);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new TypeError(`${path}.${unknown} is not allowed`);
  const missing = expected.find((key) => !(key in value));
  if (missing !== undefined) throw new TypeError(`${path}.${missing} is required`);
}

function isTextMediaType(mediaType: string): boolean {
  const essence = mediaType.split(";", 1)[0]!.trim().toLocaleLowerCase();
  return essence.startsWith("text/")
    || essence === "application/json"
    || essence.endsWith("+json");
}

function utf8WindowEnd(bytes: Uint8Array, offset: number, limit: number): number {
  let end = Math.min(bytes.byteLength, offset + limit);
  if (end === bytes.byteLength) return end;
  // `end` is an exclusive boundary. If the byte at that boundary is a UTF-8
  // continuation, the window split a code point; walk back to its lead byte
  // and leave the complete code point for the next page.
  while (end > offset && isUtf8ContinuationByte(bytes[end]!)) end -= 1;
  if (end > offset) return end;

  // limit is at least four bytes, so this is reachable only for malformed
  // UTF-8. Let the fatal decoder below report the invalid sequence.
  return Math.min(bytes.byteLength, offset + limit);
}

function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function boundedInteger(
  value: unknown,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || (selected as number) < minimum || (selected as number) > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return selected as number;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function failure(message: string): ToolResult {
  return { content: JSON.stringify({ error: message }), isError: true };
}
