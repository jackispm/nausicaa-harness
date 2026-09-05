import type { AnyEvent } from "../domain/events.js";
import type { ArtifactRef } from "../domain/types.js";
import {
  ArtifactIntegrityError,
  assertArtifactRef,
  assertContentHash,
  type ContentAddressedStore,
  type ContentAddressedStoreMaintenance,
  type StoredArtifact,
} from "./store.js";

export const DEFAULT_ARTIFACT_GC_GRACE_MS = 60_000;
export const MAX_ARTIFACT_GC_GRACE_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_ARTIFACT_GC_DELETES = 10_000;

export interface ArtifactGcOptions {
  /** Explicit roots from a trusted Ledger projection or checkpoint. */
  readonly referenced: readonly ArtifactRef[];
  readonly now?: Date;
  /** Keep newly written objects out of a collection pass. */
  readonly graceMs?: number;
  /** Defaults to true; deletion must be an explicit operator choice. */
  readonly dryRun?: boolean;
  /** Required for deletion: the caller has paused CAS writes and root publication. */
  readonly writerQuiesced?: boolean;
  readonly maxDeletes?: number;
}

export interface ArtifactGcCandidate extends StoredArtifact {
  readonly ageMs: number;
}

export interface ArtifactGcResult {
  readonly dryRun: boolean;
  readonly scanned: number;
  readonly retained: number;
  readonly skippedYoung: number;
  readonly eligible: number;
  readonly deleted: number;
  readonly candidates: readonly ArtifactGcCandidate[];
}

export interface ReferencedArtifactCheck {
  readonly present: readonly ArtifactRef[];
  readonly missing: readonly ArtifactRef[];
  readonly invalid: readonly ArtifactRef[];
}

/**
 * Collect unreferenced CAS objects behind an explicit maintenance seam.
 *
 * The function never discovers roots from the filesystem. Callers must pass
 * refs projected from the authoritative Ledger. Destructive passes require an
 * explicit assertion that CAS writers and root publication are quiescent;
 * snapshot metadata alone cannot make a concurrent mark-and-sweep pass safe.
 */
export async function collectArtifactGarbage(
  store: ContentAddressedStoreMaintenance,
  options: ArtifactGcOptions,
): Promise<ArtifactGcResult> {
  validateGcOptions(options);
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError("now must be a valid date");
  const graceMs = options.graceMs ?? DEFAULT_ARTIFACT_GC_GRACE_MS;
  const dryRun = options.dryRun ?? true;
  const maxDeletes = options.maxDeletes ?? MAX_ARTIFACT_GC_DELETES;
  const roots = new Set<string>();
  for (const ref of options.referenced) {
    assertArtifactRef(ref);
    roots.add(ref.contentHash);
  }
  const objects = await store.listObjects();
  const candidates: ArtifactGcCandidate[] = [];
  let retained = 0;
  let skippedYoung = 0;
  for (const object of objects) {
    assertContentHash(object.contentHash);
    if (!Number.isSafeInteger(object.byteLength) || object.byteLength < 0) {
      throw new ArtifactIntegrityError(`Invalid stored artifact length: ${object.contentHash}`);
    }
    const modifiedMs = Date.parse(object.modifiedAt);
    if (!Number.isFinite(modifiedMs)) {
      throw new ArtifactIntegrityError(`Invalid stored artifact timestamp: ${object.contentHash}`);
    }
    if (roots.has(object.contentHash)) {
      retained += 1;
      continue;
    }
    const ageMs = Math.max(0, nowMs - modifiedMs);
    if (ageMs < graceMs) {
      skippedYoung += 1;
      continue;
    }
    candidates.push(Object.freeze({ ...object, ageMs }));
  }
  let deleted = 0;
  if (!dryRun) {
    for (const candidate of candidates.slice(0, maxDeletes)) {
      if (await store.deleteObject(candidate.contentHash, candidate)) deleted += 1;
    }
  }
  return Object.freeze({
    dryRun,
    scanned: objects.length,
    retained,
    skippedYoung,
    eligible: candidates.length,
    deleted,
    candidates: Object.freeze(candidates),
  });
}

/** Verify every Ledger-derived root and report missing/corrupt objects. */
export async function checkReferencedArtifacts(
  store: ContentAddressedStore,
  referenced: readonly ArtifactRef[],
): Promise<ReferencedArtifactCheck> {
  if (!Array.isArray(referenced)) throw new TypeError("referenced must be an array");
  const present: ArtifactRef[] = [];
  const missing: ArtifactRef[] = [];
  const invalid: ArtifactRef[] = [];
  const seen = new Set<string>();
  for (const ref of referenced) {
    try {
      assertArtifactRef(ref);
    } catch {
      invalid.push(ref);
      continue;
    }
    if (seen.has(ref.contentHash)) continue;
    seen.add(ref.contentHash);
    try {
      if (await store.has(ref)) present.push(structuredClone(ref));
      else missing.push(structuredClone(ref));
    } catch {
      invalid.push(structuredClone(ref));
    }
  }
  return Object.freeze({
    present: Object.freeze(present),
    missing: Object.freeze(missing),
    invalid: Object.freeze(invalid),
  });
}

/**
 * Conservatively extract ArtifactRefs from trusted, validated Ledger events.
 * A malformed ref-shaped value fails closed instead of allowing GC to delete
 * an object whose provenance cannot be interpreted.
 */
export function artifactRefsFromEvents(events: readonly AnyEvent[]): readonly ArtifactRef[] {
  if (!Array.isArray(events)) throw new TypeError("events must be an array");
  const refs: ArtifactRef[] = [];
  const seen = new Set<string>();
  const visited = new Set<object>();
  let nodes = 0;
  const visit = (value: unknown, path: string): void => {
    nodes += 1;
    if (nodes > 100_000) throw new ArtifactIntegrityError("Ledger artifact reference scan exceeded its node limit");
    if (value === null || typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);
    if (looksLikeArtifactRef(value)) {
      try {
        assertArtifactRef(value as ArtifactRef);
      } catch (error: unknown) {
        throw new ArtifactIntegrityError(
          `Invalid artifact reference at ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const ref = value as ArtifactRef;
      if (!seen.has(ref.contentHash)) {
        seen.add(ref.contentHash);
        refs.push(structuredClone(ref));
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
  };
  events.forEach((event, index) => visit(event, `events[${index}]`));
  return Object.freeze(refs);
}

function looksLikeArtifactRef(value: object): boolean {
  const candidate = value as Partial<ArtifactRef>;
  return "id" in candidate
    && "contentHash" in candidate
    && "mediaType" in candidate
    && "byteLength" in candidate;
}

function validateGcOptions(options: ArtifactGcOptions): void {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("GC options must be an object");
  }
  if (!Array.isArray(options.referenced)) throw new TypeError("referenced must be an array");
  if (options.graceMs !== undefined && (
    !Number.isSafeInteger(options.graceMs)
    || options.graceMs < 0
    || options.graceMs > MAX_ARTIFACT_GC_GRACE_MS
  )) throw new RangeError("graceMs is outside its supported range");
  if (options.dryRun !== undefined && typeof options.dryRun !== "boolean") {
    throw new TypeError("dryRun must be a boolean");
  }
  if (options.writerQuiesced !== undefined && typeof options.writerQuiesced !== "boolean") {
    throw new TypeError("writerQuiesced must be a boolean");
  }
  if (options.dryRun === false && options.writerQuiesced !== true) {
    throw new TypeError("destructive GC requires writerQuiesced: true");
  }
  if (options.maxDeletes !== undefined && (
    !Number.isSafeInteger(options.maxDeletes)
    || options.maxDeletes < 1
    || options.maxDeletes > MAX_ARTIFACT_GC_DELETES
  )) throw new RangeError("maxDeletes is outside its supported range");
}
