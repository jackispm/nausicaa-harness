import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ToolResult } from "../../src/domain/ports.js";
import { MoweCatalog, MoweExecutor } from "../../src/mowe/index.js";
import {
  createArtifactRef,
  FileContentAddressedStore,
  MemoryContentAddressedStore,
} from "../../src/store/index.js";
import {
  createArtifactReadTool,
  MAX_ARTIFACT_READ_BYTES,
  RunArtifactAuthorization,
  runArtifactHandle,
} from "../../src/tools/artifact-read.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("artifact_read", () => {
  it("paginates on UTF-8 boundaries and accepts each exact nextOffset", async () => {
    const store = new MemoryContentAddressedStore();
    const source = "ab你c🙂终";
    const ref = await store.put(source, "text/plain; charset=utf-8");
    const tool = createArtifactReadTool(store);
    const artifact = runArtifactHandle("run-unicode", ref);
    const pages: ArtifactReadOutput[] = [];
    let offset = 0;

    for (;;) {
      const result = await tool.execute(
        { artifact, offset, limit: 4 },
        context("run-unicode"),
      );
      expect(result.isError).toBe(false);
      const page = parseOutput(result);
      pages.push(page);
      expect(page.artifact).toEqual(artifact);
      if (!page.truncated) break;
      expect(page.nextOffset).toBe(page.offset + page.returnedBytes);
      offset = page.nextOffset!;
    }

    expect(pages.map((page) => page.content)).toEqual(["ab", "你c", "🙂", "终"]);
    expect(pages.map((page) => page.nextOffset)).toEqual([2, 6, 10, undefined]);
    expect(pages.map((page) => page.content).join("")).toBe(source);
    expect(pages.at(-1)?.totalBytes).toBe(Buffer.byteLength(source, "utf8"));

    const invalidOffset = await tool.execute(
      { artifact, offset: 3, limit: 4 },
      context("run-unicode"),
    );
    expect(invalidOffset.isError).toBe(true);
    expect(parseError(invalidOffset)).toContain("UTF-8 boundary");
  });

  it("rejects a cross-Run handle before reading the Store", async () => {
    const bytes = Buffer.from("private Run data", "utf8");
    const ref = createArtifactRef(bytes, "text/plain");
    let getCalls = 0;
    const tool = createArtifactReadTool({
      async get() {
        getCalls += 1;
        return bytes;
      },
    });

    const result = await tool.execute(
      { artifact: runArtifactHandle("run-a", ref) },
      context("run-b"),
    );

    expect(result.isError).toBe(true);
    expect(parseError(result)).toContain("different Run");
    expect(getCalls).toBe(0);
  });

  it("rejects an unregistered ref even when the Store can read it", async () => {
    const store = new MemoryContentAddressedStore();
    const authorized = await store.put("authorized", "text/plain");
    const readableButUnregistered = await store.put("not authorized", "text/plain");
    const authorization = new RunArtifactAuthorization();
    authorization.beginRun("run-authorized", [authorized]);
    let getCalls = 0;
    const guardedStore = {
      async get(ref: Parameters<MemoryContentAddressedStore["get"]>[0]) {
        getCalls += 1;
        return store.get(ref);
      },
    };
    const tool = createArtifactReadTool(guardedStore, authorization);

    const denied = await tool.execute(
      { artifact: runArtifactHandle("run-authorized", readableButUnregistered) },
      context("run-authorized"),
    );

    expect(denied.isError).toBe(true);
    expect(parseError(denied)).toContain("not authorized");
    expect(getCalls).toBe(0);

    const allowed = await tool.execute(
      { artifact: runArtifactHandle("run-authorized", authorized) },
      context("run-authorized"),
    );
    expect(allowed.isError).toBe(false);
    expect(parseOutput(allowed).content).toBe("authorized");
    expect(getCalls).toBe(1);

    const crossRun = await tool.execute(
      { artifact: runArtifactHandle("other-run", authorized) },
      context("run-authorized"),
    );
    expect(crossRun.isError).toBe(true);
    expect(parseError(crossRun)).toContain("different Run");
    expect(getCalls).toBe(1);
  });

  it("single-flights concurrent pages and reuses the bounded cache", async () => {
    const source = "concurrent artifact contents";
    const ref = createArtifactRef(Buffer.from(source, "utf8"), "text/plain");
    const gate = deferred<Uint8Array>();
    let getCalls = 0;
    const tool = createArtifactReadTool({
      async get() {
        getCalls += 1;
        return gate.promise;
      },
    });
    const artifact = runArtifactHandle("run-cache", ref);
    const first = tool.execute({ artifact, limit: 8 }, context("run-cache"));
    const second = tool.execute({ artifact, offset: 8, limit: 8 }, context("run-cache"));
    await Promise.resolve();
    expect(getCalls).toBe(1);
    gate.resolve(Uint8Array.from(Buffer.from(source, "utf8")));
    await expect(first).resolves.toMatchObject({ isError: false });
    await expect(second).resolves.toMatchObject({ isError: false });
    await expect(tool.execute({ artifact, limit: 8 }, context("run-cache")))
      .resolves.toMatchObject({ isError: false });
    expect(getCalls).toBe(1);
  });

  it("does not poison the cache after a failed load", async () => {
    const ref = createArtifactRef(Buffer.from("retryable", "utf8"), "text/plain");
    let getCalls = 0;
    const tool = createArtifactReadTool({
      async get() {
        getCalls += 1;
        if (getCalls === 1) throw new Error("transient store failure");
        return Uint8Array.from(Buffer.from("retryable", "utf8"));
      },
    });
    const artifact = runArtifactHandle("run-retry", ref);
    await expect(tool.execute({ artifact }, context("run-retry")))
      .resolves.toMatchObject({ isError: true });
    await expect(tool.execute({ artifact }, context("run-retry")))
      .resolves.toMatchObject({ isError: false });
    expect(getCalls).toBe(2);
  });

  it("reads an existing handle after reopening FileContentAddressedStore", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-artifact-read-"));
    temporaryDirectories.push(root);
    const original = await FileContentAddressedStore.open(root);
    const ref = await original.put("重启后仍可读", "text/plain; charset=utf-8");

    const reopened = await FileContentAddressedStore.open(root);
    const result = await createArtifactReadTool(reopened).execute(
      { artifact: runArtifactHandle("run-reopened", ref), limit: 64 },
      context("run-reopened"),
    );

    expect(result.isError).toBe(false);
    expect(parseOutput(result)).toMatchObject({
      artifactId: ref.id,
      content: "重启后仍可读",
      offset: 0,
      returnedBytes: ref.byteLength,
      totalBytes: ref.byteLength,
      truncated: false,
    });
  });

  it("evicts the least-recently-used source when cache entry bounds are reached", async () => {
    const sourceStore = new MemoryContentAddressedStore();
    const refs = await Promise.all([
      sourceStore.put("first", "text/plain"),
      sourceStore.put("second", "text/plain"),
    ]);
    const reads = new Map<string, number>();
    const tool = createArtifactReadTool({
      async get(ref) {
        reads.set(ref.id, (reads.get(ref.id) ?? 0) + 1);
        return sourceStore.get(ref);
      },
    }, undefined, { maxEntries: 1, maxBytes: 128 });

    await expect(tool.execute({ artifact: runArtifactHandle("run-lru", refs[0]!) }, context("run-lru")))
      .resolves.toMatchObject({ isError: false });
    await expect(tool.execute({ artifact: runArtifactHandle("run-lru", refs[1]!) }, context("run-lru")))
      .resolves.toMatchObject({ isError: false });
    await expect(tool.execute({ artifact: runArtifactHandle("run-lru", refs[0]!) }, context("run-lru")))
      .resolves.toMatchObject({ isError: false });

    expect(reads.get(refs[0]!.id)).toBe(2);
    expect(reads.get(refs[1]!.id)).toBe(1);
  });

  it("lets a caller abort its read without cancelling another waiter", async () => {
    const source = "abortable artifact";
    const ref = createArtifactRef(Buffer.from(source, "utf8"), "text/plain");
    let release: ((bytes: Uint8Array) => void) | undefined;
    const pending = new Promise<Uint8Array>((resolve) => { release = resolve; });
    const tool = createArtifactReadTool({ async get() { return pending; } });
    const artifact = runArtifactHandle("run-abort", ref);
    const controller = new AbortController();
    const aborted = tool.execute(
      { artifact },
      { ...context("run-abort"), signal: controller.signal },
    );
    const survivor = tool.execute({ artifact }, context("run-abort"));
    await Promise.resolve();
    controller.abort(new Error("caller cancelled"));
    await expect(aborted).rejects.toThrow("caller cancelled");
    release?.(Uint8Array.from(Buffer.from(source, "utf8")));
    await expect(survivor).resolves.toMatchObject({ isError: false });
  });

  it("keeps the worst-case escaped page below Main's projection boundary", async () => {
    const store = new MemoryContentAddressedStore();
    const ref = await store.put("\0".repeat(MAX_ARTIFACT_READ_BYTES), "text/plain");
    const tool = createArtifactReadTool(store);
    const result = await tool.execute({
      artifact: runArtifactHandle("run-escaped-page", ref),
      limit: MAX_ARTIFACT_READ_BYTES,
    }, context("run-escaped-page"));

    expect(result.isError).toBe(false);
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThan(256 * 1024);
    const overLimit = await tool.execute({
      artifact: runArtifactHandle("run-escaped-page", ref),
      limit: MAX_ARTIFACT_READ_BYTES + 1,
    }, context("run-escaped-page"));
    expect(overLimit.isError).toBe(true);
    expect(parseError(overLimit)).toContain(`between 4 and ${MAX_ARTIFACT_READ_BYTES}`);
  });

  it("keeps path arguments out of Mowe admission and verifies stored integrity", async () => {
    const store = new MemoryContentAddressedStore();
    const ref = await store.put("verified", "text/plain");
    const tool = createArtifactReadTool(store);
    const executor = new MoweExecutor({ catalog: [tool] });
    const rejected = await executor.execute({
      runId: "run-schema",
      laneId: "main",
      workspace: "/tmp",
      calls: [{
        id: "path-attempt",
        name: "artifact_read",
        arguments: {
          artifact: runArtifactHandle("run-schema", ref),
          path: "/tmp/object",
        },
      }],
    });

    expect(rejected.results[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("arguments.path is not allowed"),
    });
    expect(new MoweCatalog([tool]).get("artifact_read")?.metadata).toMatchObject({
      effect: "read",
      deterministic: true,
      supportsBatch: true,
      concurrencySafe: true,
      scope: "run",
      inputKinds: ["artifact"],
    });

    const integrityFailure = await tool.execute({
      artifact: runArtifactHandle("run-schema", {
        ...ref,
        byteLength: ref.byteLength + 1,
      }),
    }, context("run-schema"));
    expect(integrityFailure.isError).toBe(true);
    expect(parseError(integrityFailure)).toContain("length mismatch");
  });
});

interface ArtifactReadOutput {
  artifact: {
    runId: string;
    ref: {
      id: string;
      contentHash: string;
      mediaType: string;
      byteLength: number;
    };
  };
  artifactId: string;
  mediaType: string;
  offset: number;
  returnedBytes: number;
  totalBytes: number;
  content: string;
  truncated: boolean;
  nextOffset?: number;
}

function context(runId: string) {
  return {
    runId,
    workspace: "/tmp",
    operationId: "op:artifact-read-test",
  };
}

function parseOutput(result: ToolResult): ArtifactReadOutput {
  return JSON.parse(result.content) as ArtifactReadOutput;
}

function parseError(result: ToolResult): string {
  return (JSON.parse(result.content) as { error: string }).error;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}
