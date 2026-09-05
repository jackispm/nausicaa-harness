import type { ContextSourceRef } from "../domain/context.js";
import { cloneJson, sha256, stableJson } from "../ledger/hash.js";
import { assertArtifactRef } from "../store/store.js";
import {
  FukaiCompactionBudgetError,
  FukaiCompactionProviderError,
} from "./compaction-provider.js";
import type { FukaiSource } from "./types.js";

const MAX_MATERIAL_BYTES = 64 * 1024 * 1024;
const INPUT_BYTES_PER_TOKEN = 4;

export interface FukaiCompactionSourceMaterial {
  sourceRef: Exclude<ContextSourceRef, { kind: "event" }>;
  content: string;
  mediaType: string;
  byteLength: number;
}

export interface FukaiCompactionSourceMaterializationRequest {
  sourceRefs: readonly ContextSourceRef[];
  maxBytes: number;
  signal?: AbortSignal;
}

export interface FukaiCompactionSourceMaterializer {
  materialize(
    request: FukaiCompactionSourceMaterializationRequest,
  ): Promise<readonly FukaiCompactionSourceMaterial[]>;
}

export class FukaiCompactionSourceMaterializationError
  extends FukaiCompactionProviderError {
  override readonly name = "FukaiCompactionSourceMaterializationError";
}

/** Shared raw-source ceiling used by selection and exact materialization. */
export function fukaiCompactionMaterialByteBudget(maxInputTokens: number): number {
  if (!Number.isSafeInteger(maxInputTokens) || maxInputTokens < 1) {
    throw new FukaiCompactionBudgetError(
      "Compaction maxInputTokens must be a positive integer",
    );
  }
  const bytes = maxInputTokens * INPUT_BYTES_PER_TOKEN;
  if (!Number.isSafeInteger(bytes) || bytes > MAX_MATERIAL_BYTES) {
    throw new FukaiCompactionBudgetError(
      `Compaction material budget exceeds ${MAX_MATERIAL_BYTES} bytes`,
    );
  }
  return bytes;
}

/**
 * Reads every selected CAS source in full. Compaction provenance names whole
 * refs, so this boundary fails instead of silently summarizing a truncated ref.
 */
export class FukaiSourceCompactionMaterializer
implements FukaiCompactionSourceMaterializer {
  readonly #source: Pick<FukaiSource, "readArtifact">;

  constructor(source: Pick<FukaiSource, "readArtifact">) {
    if (source === null || typeof source?.readArtifact !== "function") {
      throw new FukaiCompactionSourceMaterializationError(
        "source.readArtifact must be a function",
      );
    }
    this.#source = source;
  }

  async materialize(
    request: FukaiCompactionSourceMaterializationRequest,
  ): Promise<readonly FukaiCompactionSourceMaterial[]> {
    validateMaterializationRequest(request);
    throwIfAborted(request.signal);

    const refs = orderedArtifactSourceRefs(request.sourceRefs);
    const requestedBytes = refs.reduce((sum, sourceRef) => {
      const next = sum + sourceRef.ref.byteLength;
      if (!Number.isSafeInteger(next)) {
        throw new FukaiCompactionBudgetError(
          "Compaction source material exceeds the safe byte range",
        );
      }
      return next;
    }, 0);
    if (requestedBytes > request.maxBytes) {
      throw new FukaiCompactionBudgetError(
        `Compaction sources require ${requestedBytes} bytes; budget is ${request.maxBytes}`,
      );
    }

    const materials: FukaiCompactionSourceMaterial[] = [];
    for (const sourceRef of refs) {
      throwIfAborted(request.signal);
      const read = await raceWithSignal(
        this.#source.readArtifact(
          sourceRef.ref,
          { offset: 0, length: sourceRef.ref.byteLength },
          signalOptions(request.signal),
        ),
        request.signal,
      );
      throwIfAborted(request.signal);
      if (read === undefined) {
        throw new FukaiCompactionSourceMaterializationError(
          `Compaction source is missing: ${sourceRef.ref.id}`,
        );
      }
      const bytes = Buffer.byteLength(read.content, "utf8");
      if (
        read.contentHash !== sourceRef.ref.contentHash
        || read.byteLength !== sourceRef.ref.byteLength
        || bytes !== sourceRef.ref.byteLength
        || sha256(read.content) !== sourceRef.ref.contentHash
      ) {
        throw new FukaiCompactionSourceMaterializationError(
          `Compaction source does not match its exact ref: ${sourceRef.ref.id}`,
        );
      }
      materials.push({
        sourceRef: cloneJson(sourceRef),
        content: read.content,
        mediaType: sourceRef.ref.mediaType,
        byteLength: bytes,
      });
    }
    return materials;
  }
}

export function createFukaiCompactionSourceMaterializer(
  source: Pick<FukaiSource, "readArtifact">,
): FukaiSourceCompactionMaterializer {
  return new FukaiSourceCompactionMaterializer(source);
}

function validateMaterializationRequest(
  request: FukaiCompactionSourceMaterializationRequest,
): void {
  if (request === null || typeof request !== "object") {
    throw new FukaiCompactionSourceMaterializationError(
      "Compaction materialization request must be an object",
    );
  }
  if (!Array.isArray(request.sourceRefs) || request.sourceRefs.length === 0) {
    throw new FukaiCompactionSourceMaterializationError(
      "Compaction sourceRefs must contain at least one ref",
    );
  }
  if (
    !Number.isSafeInteger(request.maxBytes)
    || request.maxBytes < 1
    || request.maxBytes > MAX_MATERIAL_BYTES
  ) {
    throw new FukaiCompactionSourceMaterializationError(
      `Compaction maxBytes must be an integer from 1 to ${MAX_MATERIAL_BYTES}`,
    );
  }
}

function orderedArtifactSourceRefs(
  sourceRefs: readonly ContextSourceRef[],
): Array<Exclude<ContextSourceRef, { kind: "event" }>> {
  const refs: Array<Exclude<ContextSourceRef, { kind: "event" }>> = [];
  const seen = new Set<string>();
  for (const sourceRef of sourceRefs) {
    if (sourceRef === null || typeof sourceRef !== "object") {
      throw new FukaiCompactionSourceMaterializationError(
        "Compaction sourceRef must be an object",
      );
    }
    if (sourceRef.kind === "event") {
      throw new FukaiCompactionSourceMaterializationError(
        `Event source refs are not materializable yet: ${sourceRef.eventId}`,
      );
    }
    if (sourceRef.kind !== "artifact" && sourceRef.kind !== "conversation") {
      throw new FukaiCompactionSourceMaterializationError(
        "Compaction sourceRef kind is invalid",
      );
    }
    try {
      assertArtifactRef(sourceRef.ref);
    } catch (error: unknown) {
      throw new FukaiCompactionSourceMaterializationError(
        `Invalid compaction source ref: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const identity = stableJson(sourceRef);
    if (seen.has(identity)) {
      throw new FukaiCompactionSourceMaterializationError(
        "Compaction sourceRefs must be unique",
      );
    }
    seen.add(identity);
    refs.push(cloneJson(sourceRef));
  }
  return refs;
}

function signalOptions(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

async function raceWithSignal<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return pending;
  throwIfAborted(signal);
  pending.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
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
