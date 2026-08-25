import type { ArtifactRef } from "../domain/types.js";
import {
  ArtifactNotFoundError,
  assertArtifactRef,
  createArtifactRef,
  type ContentAddressedStore,
  type StoreInput,
  toBytes,
  verifyArtifact,
} from "./store.js";

export class MemoryContentAddressedStore implements ContentAddressedStore {
  readonly #objects = new Map<string, Uint8Array>();

  async put(
    data: StoreInput,
    mediaType?: string,
  ): Promise<ArtifactRef> {
    const bytes = toBytes(data);
    const ref = createArtifactRef(bytes, mediaType);
    if (!this.#objects.has(ref.contentHash)) {
      this.#objects.set(ref.contentHash, Uint8Array.from(bytes));
    }
    return ref;
  }

  async get(ref: ArtifactRef): Promise<Uint8Array> {
    assertArtifactRef(ref);
    const stored = this.#objects.get(ref.contentHash);
    if (stored === undefined) {
      throw new ArtifactNotFoundError(`Artifact ${ref.id} was not found`);
    }
    const bytes = Uint8Array.from(stored);
    verifyArtifact(bytes, ref);
    return bytes;
  }

  async has(ref: ArtifactRef): Promise<boolean> {
    assertArtifactRef(ref);
    const stored = this.#objects.get(ref.contentHash);
    if (stored === undefined) {
      return false;
    }
    verifyArtifact(stored, ref);
    return true;
  }
}
