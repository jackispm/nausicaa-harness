import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createReadManyTool } from "../../src/tools/read-many.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("read_many", () => {
  it("reads independent windows concurrently while preserving target order", async () => {
    const workspace = await temporaryRoot();
    await writeFile(path.join(workspace, "entry.ts"), "one\ntwo\nthree\n", "utf8");
    await writeFile(path.join(workspace, "config.ts"), "alpha\nbeta\n", "utf8");
    const tool = createReadManyTool();

    const result = await tool.execute({
      targets: [
        { path: "entry.ts", offset: 2, limit: 2 },
        { path: "config.ts", limit: 1 },
      ],
    }, context(workspace));

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      count: 2,
      succeeded: 2,
      failed: 0,
      results: [
        { path: "entry.ts", ok: true, offset: 2, content: "two\nthree" },
        { path: "config.ts", ok: true, offset: 1, content: "alpha", truncated: true },
      ],
    });
  });

  it("isolates per-file failures without weakening workspace protection", async () => {
    const workspace = await temporaryRoot();
    await writeFile(path.join(workspace, "visible.txt"), "safe", "utf8");
    await writeFile(path.join(workspace, ".env"), "SECRET=value", "utf8");
    const tool = createReadManyTool();

    const result = await tool.execute({
      targets: [
        { path: "visible.txt" },
        { path: ".env" },
        { path: "missing.txt" },
      ],
    }, context(workspace));
    const output = JSON.parse(result.content);

    expect(result.isError).toBe(false);
    expect(output).toMatchObject({ count: 3, succeeded: 1, failed: 2 });
    expect(output.results[0]).toMatchObject({ path: "visible.txt", ok: true, content: "safe" });
    expect(output.results[1]).toMatchObject({ path: ".env", ok: false });
    expect(output.results[1].error).not.toContain("SECRET=value");
    expect(output.results[2]).toMatchObject({ path: "missing.txt", ok: false });
  });

  it("shares a total content budget and preserves continuation fields", async () => {
    const workspace = await temporaryRoot();
    await writeFile(path.join(workspace, "a.txt"), "abcdefghij", "utf8");
    await writeFile(path.join(workspace, "b.txt"), "klmnopqrst", "utf8");
    const tool = createReadManyTool();

    const result = await tool.execute({
      targets: [{ path: "a.txt" }, { path: "b.txt" }],
      maxTotalBytes: 8,
    }, context(workspace));
    const output = JSON.parse(result.content);

    expect(output.truncated).toBe(true);
    expect(output.results).toEqual([
      expect.objectContaining({
        path: "a.txt",
        ok: true,
        content: "abcd",
        lineTruncated: true,
        nextOffset: 1,
        nextLineByteOffset: 4,
      }),
      expect.objectContaining({
        path: "b.txt",
        ok: true,
        content: "klmn",
        lineTruncated: true,
        nextOffset: 1,
        nextLineByteOffset: 4,
      }),
    ]);
  });

  it("rejects a total content budget smaller than the target count", async () => {
    const workspace = await temporaryRoot();
    await writeFile(path.join(workspace, "a.txt"), "a", "utf8");
    await writeFile(path.join(workspace, "b.txt"), "b", "utf8");
    const result = await createReadManyTool().execute({
      targets: [{ path: "a.txt" }, { path: "b.txt" }],
      maxTotalBytes: 1,
    }, context(workspace));

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain("target count (2)");
  });

  it("rejects malformed or oversized batches before reading", async () => {
    const workspace = await temporaryRoot();
    const tool = createReadManyTool();

    await expect(tool.execute({ targets: [] }, context(workspace))).resolves.toMatchObject({
      isError: true,
    });
    await expect(tool.execute({
      targets: Array.from({ length: 17 }, (_, index) => ({ path: `${index}.txt` })),
    }, context(workspace))).resolves.toMatchObject({ isError: true });
    await expect(tool.execute({
      targets: [{ path: "file.txt", unexpected: true }],
    }, context(workspace))).resolves.toMatchObject({ isError: true });
  });
});

function context(workspace: string) {
  return { runId: "run-1", workspace, operationId: "read-many-1" };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "nausicaa-read-many-"));
  roots.push(root);
  return root;
}
