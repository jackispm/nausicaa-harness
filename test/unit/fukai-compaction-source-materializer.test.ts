import { describe, expect, it, vi } from "vitest";

import type { ContextSourceRef } from "../../src/domain/context.js";
import {
  ContentStoreFukaiSource,
  createFukaiCompactionSourceMaterializer,
  FukaiCompactionBudgetError,
  FukaiCompactionSourceMaterializationError,
} from "../../src/fukai/index.js";
import {
  createArtifactRef,
  MemoryContentAddressedStore,
} from "../../src/store/index.js";

describe("FukaiSourceCompactionMaterializer", () => {
  it("materializes every exact ref in caller order", async () => {
    const store = new MemoryContentAddressedStore();
    const alpha = await store.put("alpha", "text/plain");
    const beta = await store.put("beta", "text/markdown");
    const refs: ContextSourceRef[] = [
      { kind: "conversation", ref: beta },
      { kind: "artifact", ref: alpha },
    ];
    const materializer = createFukaiCompactionSourceMaterializer(
      new ContentStoreFukaiSource(store),
    );

    const materials = await materializer.materialize({
      sourceRefs: refs,
      maxBytes: alpha.byteLength + beta.byteLength,
    });

    expect(materials.map((material) => material.sourceRef)).toEqual(refs);
    expect(materials.map((material) => material.content)).toEqual(["beta", "alpha"]);
    expect(materials.map((material) => material.byteLength)).toEqual([4, 5]);
  });

  it("rejects event refs before reading any artifact", async () => {
    const readArtifact = vi.fn();
    const materializer = createFukaiCompactionSourceMaterializer({ readArtifact });

    await expect(materializer.materialize({
      sourceRefs: [{ kind: "event", eventId: "event-1", contentHash: hashOf("event") }],
      maxBytes: 100,
    })).rejects.toThrow(/not materializable/i);
    expect(readArtifact).not.toHaveBeenCalled();
  });

  it("rejects duplicate refs before reading", async () => {
    const ref = createArtifactRef(Buffer.from("source"), "text/plain");
    const readArtifact = vi.fn();
    const materializer = createFukaiCompactionSourceMaterializer({ readArtifact });

    await expect(materializer.materialize({
      sourceRefs: [
        { kind: "artifact", ref },
        { kind: "artifact", ref },
      ],
      maxBytes: ref.byteLength * 2,
    })).rejects.toThrow(/unique/i);
    expect(readArtifact).not.toHaveBeenCalled();
  });

  it("rejects a missing source", async () => {
    const ref = createArtifactRef(Buffer.from("missing"), "text/plain");
    const materializer = createFukaiCompactionSourceMaterializer({
      readArtifact: vi.fn(async () => undefined),
    });

    await expect(materializer.materialize({
      sourceRefs: [{ kind: "artifact", ref }],
      maxBytes: ref.byteLength,
    })).rejects.toThrow(/missing/i);
  });

  it("rejects content whose bytes do not match the requested hash", async () => {
    const ref = createArtifactRef(Buffer.from("source"), "text/plain");
    const materializer = createFukaiCompactionSourceMaterializer({
      readArtifact: vi.fn(async () => ({
        content: "sourcf",
        contentHash: ref.contentHash,
        byteLength: ref.byteLength,
      })),
    });

    await expect(materializer.materialize({
      sourceRefs: [{ kind: "artifact", ref }],
      maxBytes: ref.byteLength,
    })).rejects.toThrow(/does not match/i);
  });

  it("rejects a mismatched source size", async () => {
    const ref = createArtifactRef(Buffer.from("source"), "text/plain");
    const materializer = createFukaiCompactionSourceMaterializer({
      readArtifact: vi.fn(async () => ({
        content: "source",
        contentHash: ref.contentHash,
        byteLength: ref.byteLength + 1,
      })),
    });

    await expect(materializer.materialize({
      sourceRefs: [{ kind: "artifact", ref }],
      maxBytes: ref.byteLength,
    })).rejects.toThrow(/does not match/i);
  });

  it("rejects an aggregate byte budget before reading", async () => {
    const ref = createArtifactRef(Buffer.from("source"), "text/plain");
    const readArtifact = vi.fn();
    const materializer = createFukaiCompactionSourceMaterializer({ readArtifact });

    await expect(materializer.materialize({
      sourceRefs: [{ kind: "artifact", ref }],
      maxBytes: ref.byteLength - 1,
    })).rejects.toBeInstanceOf(FukaiCompactionBudgetError);
    expect(readArtifact).not.toHaveBeenCalled();
  });

  it("rejects non-UTF-8 source bytes", async () => {
    const store = new MemoryContentAddressedStore();
    const ref = await store.put(Uint8Array.of(0xff, 0xfe, 0xfd), "application/octet-stream");
    const materializer = createFukaiCompactionSourceMaterializer(
      new ContentStoreFukaiSource(store),
    );

    await expect(materializer.materialize({
      sourceRefs: [{ kind: "artifact", ref }],
      maxBytes: ref.byteLength,
    })).rejects.toBeInstanceOf(FukaiCompactionSourceMaterializationError);
  });

  it("cancels even when the source read does not settle", async () => {
    const ref = createArtifactRef(Buffer.from("source"), "text/plain");
    const controller = new AbortController();
    const cancellation = new Error("cancel source materialization");
    let observedSignal: AbortSignal | undefined;
    const materializer = createFukaiCompactionSourceMaterializer({
      readArtifact: vi.fn((_ref, _range, options) => {
        observedSignal = options?.signal;
        return new Promise<never>(() => undefined);
      }),
    });
    const pending = materializer.materialize({
      sourceRefs: [{ kind: "artifact", ref }],
      maxBytes: ref.byteLength,
      signal: controller.signal,
    });

    controller.abort(cancellation);

    await expect(pending).rejects.toBe(cancellation);
    expect(observedSignal).toBe(controller.signal);
  });
});

function hashOf(value: string): string {
  return createArtifactRef(Buffer.from(value)).contentHash;
}
