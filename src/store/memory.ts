import type { ArtifactRef } from "../domain/types.js";
import {
  ArtifactIntegrityError,
  ArtifactNotFoundError,
  assertArtifactRef,
  assertContentHash,
  createArtifactRef,
  type ContentAddressedStoreMaintenance,
  type ContentAddressedStore,
  type StoreInput,
  type StoredArtifact,
  toBytes,
  verifyArtifact,
} from "./store.js";

export class MemoryContentAddressedStore implements ContentAddressedStore, ContentAddressedStoreMaintenance {
  readonly #objects = new Map<string, { bytes: Uint8Array; modifiedAt: string }>();

  async put(
    data: StoreInput,
    mediaType?: string,
  ): Promise<ArtifactRef> {
    const bytes = toBytes(data);
    const ref = createArtifactRef(bytes, mediaType);
    if (!this.#objects.has(ref.contentHash)) {
      this.#objects.set(ref.contentHash, {
        bytes: Uint8Array.from(bytes),
        modifiedAt: new Date().toISOString(),
      });
    }
    return ref;
  }

  async get(ref: ArtifactRef): Promise<Uint8Array> {
    assertArtifactRef(ref);
    const stored = this.#objects.get(ref.contentHash);
    if (stored === undefined) {
      throw new ArtifactNotFoundError(`Artifact ${ref.id} was not found`);
    }
    const bytes = Uint8Array.from(stored.bytes);
    verifyArtifact(bytes, ref);
    return bytes;
  }

  async has(ref: ArtifactRef): Promise<boolean> {
    assertArtifactRef(ref);
    const stored = this.#objects.get(ref.contentHash);
    if (stored === undefined) {
      return false;
    }
    verifyArtifact(stored.bytes, ref);
    return true;
  }

  async listObjects(): Promise<readonly StoredArtifact[]> {
    return [...this.#objects.entries()]
      .map(([contentHash, value]) => Object.freeze({
        contentHash,
        byteLength: value.bytes.byteLength,
        modifiedAt: value.modifiedAt,
      }))
      .sort((left, right) => left.contentHash.localeCompare(right.contentHash));
  }

  async deleteObject(
    contentHash: string,
    expected?: Pick<StoredArtifact, "byteLength" | "modifiedAt">,
  ): Promise<boolean> {
    assertContentHash(contentHash);
    if (expected !== undefined) {
      if (expected === null || typeof expected !== "object" || Array.isArray(expected)) {
        throw new ArtifactIntegrityError("Expected artifact snapshot is invalid");
      }
      if (!Number.isSafeInteger(expected.byteLength) || expected.byteLength < 0
        || typeof expected.modifiedAt !== "string"
        || !Number.isFinite(Date.parse(expected.modifiedAt))) {
        throw new ArtifactIntegrityError("Expected artifact snapshot is invalid");
      }
    }
    const stored = this.#objects.get(contentHash);
    if (stored === undefined) return false;
    if (expected !== undefined) {
      if (
        stored.bytes.byteLength !== expected.byteLength
        || stored.modifiedAt !== expected.modifiedAt
      ) {
        return false;
      }
    }
    return this.#objects.delete(contentHash);
  }
}
