import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, readdir, rename, unlink } from "node:fs/promises";
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
  assertContentHash,
  createArtifactRef,
  type ContentAddressedStoreMaintenance,
  type ContentAddressedStore,
  type StoreInput,
  type StoredArtifact,
  toBytes,
  verifyArtifact,
} from "./store.js";

export class FileContentAddressedStore implements ContentAddressedStore, ContentAddressedStoreMaintenance {
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

  /** Enumerate verified objects without exposing storage paths. */
  async listObjects(): Promise<readonly StoredArtifact[]> {
    const root = await assertRealDirectory(this.#objects);
    if (root !== this.#objects) throw new ArtifactIntegrityError("Storage object root identity changed");
    const shards = await readdir(this.#objects, { withFileTypes: true });
    const objects: StoredArtifact[] = [];
    for (const shardEntry of shards) {
      if (shardEntry.isSymbolicLink()) {
        throw new ArtifactIntegrityError(`Refusing symbolic-link object shard: ${shardEntry.name}`);
      }
      if (!shardEntry.isDirectory()) {
        throw new ArtifactIntegrityError(`Unexpected object shard entry: ${shardEntry.name}`);
      }
      if (!/^[0-9a-f]{2}$/.test(shardEntry.name)) {
        throw new ArtifactIntegrityError(`Unexpected object shard: ${shardEntry.name}`);
      }
      const shardPath = join(this.#objects, shardEntry.name);
      const shard = await assertRealDirectory(shardPath);
      assertWithinRoot(this.#root, shard);
      const entries = await readdir(shard, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          throw new ArtifactIntegrityError(`Refusing symbolic-link object: ${entry.name}`);
        }
        if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) continue;
        if (!entry.isFile() || !/^[0-9a-f]{62}$/.test(entry.name)) {
          throw new ArtifactIntegrityError(`Unexpected object entry: ${entry.name}`);
        }
        const contentHash = `sha256:${shardEntry.name}${entry.name}`;
        const path = join(shard, entry.name);
        const handle = await openNoFollow(path, constants.O_RDONLY);
        try {
          await assertRegularFile(handle, path, true);
          const bytes = new Uint8Array(await handle.readFile());
          verifyArtifact(bytes, {
            id: contentHash,
            contentHash,
            mediaType: "application/octet-stream",
            byteLength: bytes.byteLength,
          });
          const info = await handle.stat();
          objects.push(Object.freeze({
            contentHash,
            byteLength: bytes.byteLength,
            modifiedAt: new Date(info.mtimeMs).toISOString(),
          }));
        } finally {
          await handle.close();
        }
      }
    }
    return objects.sort((left, right) => left.contentHash.localeCompare(right.contentHash));
  }

  /** Delete one verified object by digest; callers must provide retention roots. */
  async deleteObject(
    contentHash: string,
    expected?: Pick<StoredArtifact, "byteLength" | "modifiedAt">,
  ): Promise<boolean> {
    assertContentHash(contentHash);
    validateExpectedSnapshot(expected);
    const digest = contentHash.slice("sha256:".length);
    const currentRoot = await assertRealDirectory(this.#root);
    const currentObjects = await assertRealDirectory(this.#objects);
    if (currentRoot !== this.#root || currentObjects !== this.#objects) {
      throw new ArtifactIntegrityError("Storage root identity changed");
    }
    const shardPath = join(this.#objects, digest.slice(0, 2));
    let shard: string;
    try {
      shard = await assertRealDirectory(shardPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    assertWithinRoot(this.#root, shard);
    const path = join(shard, digest.slice(2));
    try {
      // Keep the verified descriptor open through unlink. Destructive GC is
      // only valid while writers are quiesced, but the inode check also avoids
      // deleting a pathname that changed during ordinary preflight work.
      const handle = await openNoFollow(path, constants.O_RDONLY);
      try {
        await assertRegularFile(handle, path, true);
        const info = await handle.stat();
        if (expected !== undefined && (
          info.size !== expected.byteLength
          || Math.trunc(info.mtimeMs) !== Date.parse(expected.modifiedAt)
        )) {
          return false;
        }
        const bytes = new Uint8Array(await handle.readFile());
        try {
          verifyArtifact(bytes, {
            id: contentHash,
            contentHash,
            mediaType: "application/octet-stream",
            byteLength: bytes.byteLength,
          });
        } catch (error: unknown) {
          if (error instanceof ArtifactIntegrityError) return false;
          throw error;
        }
        const [current, pathInfo] = await Promise.all([handle.stat(), lstat(path)]);
        if (
          current.nlink !== 1
          || current.size !== info.size
          || Math.trunc(current.mtimeMs) !== Math.trunc(info.mtimeMs)
          || pathInfo.dev !== current.dev
          || pathInfo.ino !== current.ino
        ) {
          return false;
        }
        await unlink(path);
      } finally {
        await handle.close();
      }
      await syncDirectory(shard);
      return true;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
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

function validateExpectedSnapshot(
  expected: Pick<StoredArtifact, "byteLength" | "modifiedAt"> | undefined,
): void {
  if (expected === undefined) return;
  if (expected === null || typeof expected !== "object" || Array.isArray(expected)) {
    throw new ArtifactIntegrityError("Expected artifact snapshot is invalid");
  }
  if (!Number.isSafeInteger(expected.byteLength) || expected.byteLength < 0) {
    throw new ArtifactIntegrityError("Expected artifact length is invalid");
  }
  if (typeof expected.modifiedAt !== "string" || !Number.isFinite(Date.parse(expected.modifiedAt))) {
    throw new ArtifactIntegrityError("Expected artifact timestamp is invalid");
  }
}
