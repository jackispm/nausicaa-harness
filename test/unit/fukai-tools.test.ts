import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  listFilesTool,
  readFileTool,
  writeFileTool,
} from "../../src/tools/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("workspace tools", () => {
  it("reads, lists, and atomically writes bounded workspace content", async () => {
    const workspace = await temporaryDirectory("nausicaa-workspace-");
    await writeFile(path.join(workspace, "existing.txt"), "existing", "utf8");
    await mkdir(path.join(workspace, "nested"));
    const context = { runId: "run-1", workspace, operationId: "op-1" };

    const written = await writeFileTool.execute({
      path: "nested/new.txt",
      content: "new content",
    }, context);
    const read = await readFileTool.execute({ path: "nested/new.txt" }, context);
    const listed = await listFilesTool.execute({ path: ".", recursive: true }, context);

    expect(written.isError).toBe(false);
    expect(await readFile(path.join(workspace, "nested/new.txt"), "utf8")).toBe("new content");
    expect(JSON.parse(read.content)).toMatchObject({ content: "new content", truncated: false });
    expect(JSON.parse(listed.content).entries).toContainEqual({
      path: "nested/new.txt",
      type: "file",
    });
  });

  it("requires write parents to exist", async () => {
    const workspace = await temporaryDirectory("nausicaa-workspace-");
    const context = { runId: "run-1", workspace, operationId: "op-1" };

    const result = await writeFileTool.execute({
      path: "missing/new.txt",
      content: "new content",
    }, context);

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain("Parent directory does not exist");
  });

  it("rejects lexical and symlink escapes", async () => {
    const workspace = await temporaryDirectory("nausicaa-workspace-");
    const outside = await temporaryDirectory("nausicaa-outside-");
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    await symlink(outside, path.join(workspace, "escape"));
    const context = { runId: "run-1", workspace, operationId: "op-1" };

    const lexical = await readFileTool.execute({ path: "../secret.txt" }, context);
    const linked = await readFileTool.execute({ path: "escape/secret.txt" }, context);
    const writeLinked = await writeFileTool.execute({
      path: "escape/new.txt",
      content: "should not exist",
    }, context);

    expect(lexical.isError).toBe(true);
    expect(linked.isError).toBe(true);
    expect(writeLinked.isError).toBe(true);
    await expect(readFile(path.join(outside, "new.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
