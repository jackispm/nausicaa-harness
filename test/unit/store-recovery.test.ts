import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { FileContentAddressedStore } from "../../src/store/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, {
      recursive: true,
      force: true,
    })),
  );
});

describe("FileContentAddressedStore recovery", () => {
  it("ignores an orphaned torn temporary object", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-store-recovery-"));
    temporaryDirectories.push(root);
    const digest = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    const objectDirectory = join(root, "objects", digest.slice(0, 2));
    await mkdir(objectDirectory, { recursive: true });
    await writeFile(join(objectDirectory, `.${digest}.crashed.tmp`), "he");

    const store = await FileContentAddressedStore.open(root);
    const ref = await store.put("hello", "text/plain");

    expect(ref.contentHash).toBe(`sha256:${digest}`);
    expect(Buffer.from(await store.get(ref)).toString("utf8")).toBe("hello");
    const finalPath = join(objectDirectory, digest.slice(2));
    expect(await readFile(finalPath, "utf8")).toBe("hello");
    expect(await readdir(objectDirectory)).toContain(`.${digest}.crashed.tmp`);
  });

  it("repairs a corrupt legacy final object with the addressed content", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-store-recovery-"));
    temporaryDirectories.push(root);
    const digest = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    const objectDirectory = join(root, "objects", digest.slice(0, 2));
    const finalPath = join(objectDirectory, digest.slice(2));
    await mkdir(objectDirectory, { recursive: true });
    await writeFile(finalPath, "he");

    const store = await FileContentAddressedStore.open(root);
    const ref = await store.put("hello", "text/plain");

    expect(Buffer.from(await store.get(ref)).toString("utf8")).toBe("hello");
    expect(await readFile(finalPath, "utf8")).toBe("hello");
  });

  it("rejects a symbolic-link storage root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nausicaa-store-symlink-"));
    temporaryDirectories.push(directory);
    const realRoot = join(directory, "real");
    const linkedRoot = join(directory, "linked");
    await mkdir(realRoot);
    await symlink(realRoot, linkedRoot, "dir");

    await expect(FileContentAddressedStore.open(linkedRoot))
      .rejects.toThrow(/symbolic-link/i);
  });

  it("never writes through a symbolic-link shard", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-store-symlink-"));
    temporaryDirectories.push(root);
    const outside = join(root, "outside");
    await mkdir(outside);
    const store = await FileContentAddressedStore.open(join(root, "store"));
    await symlink(outside, join(root, "store", "objects", "2c"), "dir");

    await expect(store.put("hello", "text/plain")).rejects.toThrow(/symbolic-link/i);
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("never follows a symbolic-link final object", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-store-symlink-"));
    temporaryDirectories.push(root);
    const storeRoot = join(root, "store");
    const store = await FileContentAddressedStore.open(storeRoot);
    const digest = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    const shard = join(storeRoot, "objects", digest.slice(0, 2));
    const outside = join(root, "outside.txt");
    await mkdir(shard);
    await writeFile(outside, "do-not-overwrite");
    await symlink(outside, join(shard, digest.slice(2)));

    await expect(store.put("hello", "text/plain")).rejects.toThrow();
    await expect(readFile(outside, "utf8")).resolves.toBe("do-not-overwrite");
  });
});
