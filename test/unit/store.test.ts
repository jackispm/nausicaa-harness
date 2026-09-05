import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { ArtifactRef } from "../../src/domain/types.js";
import {
  ArtifactIntegrityError,
  ArtifactNotFoundError,
  type ContentAddressedStore,
  FileContentAddressedStore,
  MemoryContentAddressedStore,
} from "../../src/store/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, {
      recursive: true,
      force: true,
    })),
  );
});

async function storeImplementations(): Promise<Array<{
  name: string;
  store: ContentAddressedStore;
}>> {
  const directory = await mkdtemp(join(tmpdir(), "nausicaa-store-unit-"));
  temporaryDirectories.push(directory);
  return [
    { name: "memory", store: new MemoryContentAddressedStore() },
    { name: "file", store: await FileContentAddressedStore.open(directory) },
  ];
}

describe("ContentAddressedStore conformance", () => {
  it("round-trips immutable bytes with a verified reference", async () => {
    for (const { store } of await storeImplementations()) {
      const source = Uint8Array.from([0, 1, 2, 255]);
      const ref = await store.put(source, "application/test");
      source[0] = 99;

      expect(ref).toEqual({
        id: "sha256:3d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e56",
        contentHash: "sha256:3d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e56",
        mediaType: "application/test",
        byteLength: 4,
      });
      expect(await store.has(ref)).toBe(true);
      expect(Array.from(await store.get(ref))).toEqual([0, 1, 2, 255]);
    }
  });

  it("deduplicates equal content while preserving caller metadata", async () => {
    for (const { store } of await storeImplementations()) {
      const first = await store.put("same content", "text/plain");
      const second = await store.put("same content", "text/markdown");

      expect(second.id).toBe(first.id);
      expect(second.mediaType).toBe("text/markdown");
      expect(Buffer.from(await store.get(second)).toString("utf8")).toBe("same content");
    }
  });

  it("distinguishes missing artifacts from invalid references", async () => {
    for (const { store } of await storeImplementations()) {
      const present = await store.put("present", "text/plain");
      const missing: ArtifactRef = {
        ...present,
        id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      };
      await expect(store.get(missing)).rejects.toBeInstanceOf(ArtifactNotFoundError);
      await expect(store.has(missing)).resolves.toBe(false);

      const invalid = { ...present, byteLength: present.byteLength + 1 };
      await expect(store.get(invalid)).rejects.toBeInstanceOf(ArtifactIntegrityError);
      await expect(store.has(invalid)).rejects.toBeInstanceOf(ArtifactIntegrityError);
    }
  });
});
