import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ArtifactRef } from "../domain/types.js";
import {
  assertRealDirectory,
  assertRegularFile,
  assertWithinRoot,
  ensureRealDirectory,
  openNoFollow,
  syncDirectory,
} from "../ledger/file-utils.js";
import {
  ArtifactIntegrityError,
  ArtifactNotFoundError,
  assertArtifactRef,
  createArtifactRef,
  type ContentAddressedStore,
  type StoreInput,
  toBytes,
  verifyArtifact,
} from "./store.js";

export class FileContentAddressedStore implements ContentAddressedStore {
  readonly #root: string;
  readonly #objects: string;

  private constructor(root: string, objects: string) {
    this.#root = root;
    this.#objects = objects;
  }

  static async open(root: string): Promise<FileContentAddressedStore> {
    const securedRoot = await ensureRealDirectory(root);
    const objects = await ensureRealDirectory(join(securedRoot.path, "objects"));
    assertWithinRoot(securedRoot.path, objects.path);
    return new FileContentAddressedStore(securedRoot.path, objects.path);
  }

  async put(
    data: StoreInput,
    mediaType?: string,
  ): Promise<ArtifactRef> {
    const bytes = toBytes(data);
    const ref = createArtifactRef(bytes, mediaType);
    const path = await this.#objectPath(ref, true);
    const objectDirectory = dirname(path);

    try {
      const existing = await this.#readObject(path);
      verifyArtifact(existing, ref);
      return ref;
    } catch (error) {
      if (error instanceof ArtifactIntegrityError) {
        await unlink(path).catch((unlinkError: unknown) => {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw unlinkError;
          }
        });
        await syncDirectory(objectDirectory);
      } else if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    const temporaryPath = join(
      objectDirectory,
      `.${ref.contentHash.slice("sha256:".length)}.${randomUUID()}.tmp`,
    );
    const handle = await openNoFollow(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      try {
        let written = 0;
        while (written < bytes.byteLength) {
          const result = await handle.write(
            bytes,
            written,
            bytes.byteLength - written,
            written,
          );
          if (result.bytesWritten === 0) {
            throw new ArtifactIntegrityError("Artifact write made no progress");
          }
          written += result.bytesWritten;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }

    try {
      await rename(temporaryPath, path);
      await syncDirectory(objectDirectory);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST"
        && (error as NodeJS.ErrnoException).code !== "EPERM"
      ) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }

      try {
        const existing = await this.#readObject(path);
        verifyArtifact(existing, ref);
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
    }
    return ref;
  }

  async get(ref: ArtifactRef): Promise<Uint8Array> {
    try {
      const path = await this.#objectPath(ref);
      const bytes = await this.#readObject(path);
      verifyArtifact(bytes, ref);
      return bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ArtifactNotFoundError(`Artifact ${ref.id} was not found`);
      }
      throw error;
    }
  }

  async has(ref: ArtifactRef): Promise<boolean> {
    try {
      const path = await this.#objectPath(ref);
      const bytes = await this.#readObject(path);
      verifyArtifact(bytes, ref);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  async #objectPath(ref: ArtifactRef, createShard = false): Promise<string> {
    assertArtifactRef(ref);
    const digest = ref.contentHash.slice("sha256:".length);
    const currentRoot = await assertRealDirectory(this.#root);
    const currentObjects = await assertRealDirectory(this.#objects);
    if (currentRoot !== this.#root || currentObjects !== this.#objects) {
      throw new ArtifactIntegrityError("Storage root identity changed");
    }

    const shardPath = join(this.#objects, digest.slice(0, 2));
    const shard = createShard
      ? (await ensureRealDirectory(shardPath)).path
      : await assertRealDirectory(shardPath);
    assertWithinRoot(this.#root, shard);
    const path = join(shard, digest.slice(2));
    assertWithinRoot(this.#root, path);
    return path;
  }

  async #readObject(path: string): Promise<Uint8Array> {
    const handle = await openNoFollow(path, constants.O_RDONLY);
    try {
      await assertRegularFile(handle, path, true);
      return new Uint8Array(await handle.readFile());
    } finally {
      await handle.close();
    }
  }
}
