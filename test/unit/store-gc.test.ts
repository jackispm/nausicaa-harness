import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AnyEvent } from "../../src/domain/events.js";
import {
  artifactRefsFromEvents,
  checkReferencedArtifacts,
  collectArtifactGarbage,
  FileContentAddressedStore,
  MemoryContentAddressedStore,
} from "../../src/store/index.js";

describe("content-addressed store maintenance", () => {
  it("keeps explicit roots and only deletes aged objects after dry-run review", async () => {
    const store = new MemoryContentAddressedStore();
    const keep = await store.put("keep", "text/plain");
    const old = await store.put("old", "text/plain");
    const young = await store.put("young", "text/plain");
    const now = new Date(Date.now() + 120_000);

    await expect(collectArtifactGarbage(store, {
      referenced: [keep],
      now,
      graceMs: 60_000,
    })).resolves.toMatchObject({
      dryRun: true,
      scanned: 3,
      retained: 1,
      skippedYoung: 0,
      eligible: 2,
      deleted: 0,
    });

    const collected = await collectArtifactGarbage(store, {
      referenced: [keep, young],
      now,
      graceMs: 60_000,
      dryRun: false,
      writerQuiesced: true,
    });
    expect(collected).toMatchObject({
      retained: 2,
      eligible: 1,
      deleted: 1,
    });
    await expect(store.has(keep)).resolves.toBe(true);
    await expect(store.has(young)).resolves.toBe(true);
    await expect(store.has(old)).resolves.toBe(false);
  });

  it("requires an explicit writer quiescence assertion before deletion", async () => {
    const store = new MemoryContentAddressedStore();
    await store.put("unreferenced", "text/plain");
    await expect(collectArtifactGarbage(store, {
      referenced: [],
      now: new Date(Date.now() + 120_000),
      graceMs: 60_000,
      dryRun: false,
    })).rejects.toThrow(/writerQuiesced/u);
  });

  it("enumerates and removes verified file objects without exposing paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-store-gc-"));
    try {
      const store = await FileContentAddressedStore.open(root);
      const keep = await store.put("keep", "text/plain");
      const remove = await store.put("remove", "text/plain");
      const objects = await store.listObjects();
      expect(objects.map((item) => item.contentHash)).toEqual([
        keep.contentHash,
        remove.contentHash,
      ].sort());
      expect(await store.deleteObject(remove.contentHash)).toBe(true);
      expect(await store.deleteObject(remove.contentHash)).toBe(false);
      await expect(store.has(keep)).resolves.toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not delete a file that changed after enumeration", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-store-gc-race-"));
    try {
      const store = await FileContentAddressedStore.open(root);
      const ref = await store.put("keep me", "text/plain");
      const [snapshot] = await store.listObjects();
      expect(snapshot).toBeDefined();
      const objectPath = join(root, "objects", ref.contentHash.slice("sha256:".length, "sha256:".length + 2), ref.contentHash.slice("sha256:".length + 2));
      await writeFile(objectPath, "keep me", "utf8");
      await utimes(objectPath, new Date(Date.now() + 2_000), new Date(Date.now() + 2_000));

      await expect(store.deleteObject(ref.contentHash, snapshot)).resolves.toBe(false);
      await expect(store.has(ref)).resolves.toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on an unexpected root-level object entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-store-gc-entry-"));
    try {
      const store = await FileContentAddressedStore.open(root);
      await writeFile(join(root, "objects", "orphan"), "unexpected", "utf8");
      await expect(store.listObjects()).rejects.toThrow(/object shard entry/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("extracts conservative Ledger roots and reports missing artifacts", async () => {
    const store = new MemoryContentAddressedStore();
    const present = await store.put("present", "text/plain");
    const missing = await store.put("missing", "text/plain");
    await store.deleteObject(missing.contentHash);
    const events = [{
      payload: {
        first: present,
        nested: [{ ref: present }, { ref: missing }],
      },
    }] as unknown as AnyEvent[];

    const refs = artifactRefsFromEvents(events);
    expect(refs.map((ref) => ref.contentHash)).toEqual([
      present.contentHash,
      missing.contentHash,
    ]);
    await expect(checkReferencedArtifacts(store, refs)).resolves.toMatchObject({
      present: [present],
      missing: [missing],
      invalid: [],
    });
  });

  it("fails closed on a malformed artifact-shaped Ledger value", () => {
    const malformed = [{
      payload: {
        ref: {
          id: "sha256:bad",
          contentHash: "sha256:bad",
          mediaType: "text/plain",
          byteLength: 3,
        },
      },
    }] as unknown as AnyEvent[];
    expect(() => artifactRefsFromEvents(malformed)).toThrow(/artifact reference/u);
  });
});
