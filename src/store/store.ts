import type { ArtifactRef } from "../domain/types.js";
import { sha256 } from "../ledger/hash.js";

export type StoreInput = string | Uint8Array;

export interface ContentAddressedStore {
  put(data: StoreInput, mediaType?: string): Promise<ArtifactRef>;
  get(ref: ArtifactRef): Promise<Uint8Array>;
  has(ref: ArtifactRef): Promise<boolean>;
}

/** Read-only metadata exposed by stores that support explicit maintenance. */
export interface StoredArtifact {
  readonly contentHash: string;
  readonly byteLength: number;
  readonly modifiedAt: string;
}

/** Optional maintenance seam; normal runtime paths only need ContentAddressedStore. */
export interface ContentAddressedStoreMaintenance {
  listObjects(): Promise<readonly StoredArtifact[]>;
  /**
   * Delete an object only when it still matches the optional enumeration
   * snapshot. The caller must prevent concurrent CAS writes and authoritative
   * root publication for the complete destructive collection pass.
   */
  deleteObject(
    contentHash: string,
    expected?: Pick<StoredArtifact, "byteLength" | "modifiedAt">,
  ): Promise<boolean>;
}

export class StoreError extends Error {
  override readonly name: string = "StoreError";
}

export class ArtifactNotFoundError extends StoreError {
  override readonly name = "ArtifactNotFoundError";
}

export class ArtifactIntegrityError extends StoreError {
  override readonly name = "ArtifactIntegrityError";
}

export function toBytes(data: StoreInput): Uint8Array {
  return typeof data === "string"
    ? Buffer.from(data, "utf8")
    : Uint8Array.from(data);
}

export function createArtifactRef(
  bytes: Uint8Array,
  mediaType = "application/octet-stream",
): ArtifactRef {
  if (mediaType.length === 0) {
    throw new StoreError("mediaType must not be empty");
  }
  const contentHash = sha256(bytes);
  return {
    id: contentHash,
    contentHash,
    mediaType,
    byteLength: bytes.byteLength,
  };
}

export function assertArtifactRef(ref: ArtifactRef): void {
  if (ref.id !== ref.contentHash) {
    throw new ArtifactIntegrityError("Artifact id does not match contentHash");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(ref.contentHash)) {
    throw new ArtifactIntegrityError("Artifact contentHash is not a SHA-256 digest");
  }
  if (!Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0) {
    throw new ArtifactIntegrityError("Artifact byteLength is invalid");
  }
}

export function assertContentHash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new ArtifactIntegrityError("Artifact contentHash is not a SHA-256 digest");
  }
}

export function verifyArtifact(bytes: Uint8Array, ref: ArtifactRef): void {
  assertArtifactRef(ref);
  if (bytes.byteLength !== ref.byteLength) {
    throw new ArtifactIntegrityError(
      `Artifact length mismatch: expected ${ref.byteLength}, received ${bytes.byteLength}`,
    );
  }
  if (sha256(bytes) !== ref.contentHash) {
    throw new ArtifactIntegrityError("Artifact content hash mismatch");
  }
}
