import { appendFileSync, truncateSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileInfoTool } from "../../src/tools/file-info.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("file_info tool", () => {
  it("returns stable metadata and an optional sha256 fingerprint", async () => {
    const workspace = await temporaryDirectory();
    await writeFile(path.join(workspace, "note.txt"), "hello", "utf8");
    const tool = createFileInfoTool();
    const context = { runId: "run-1", workspace, operationId: "op-1" };

    const result = await tool.execute({ path: "note.txt", hash: true }, context);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      path: "note.txt",
      type: "file",
      byteLength: 5,
      hash: "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      executable: false,
    });
  });

  it("does not read directories as hashes and preserves workspace boundaries", async () => {
    const workspace = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    await symlink(path.join(outside, "secret.txt"), path.join(workspace, "alias.txt"));
    const tool = createFileInfoTool();
    const context = { runId: "run-1", workspace, operationId: "op-1" };

    await expect(tool.execute({ path: ".", hash: true }, context)).resolves.toMatchObject({ isError: true });
    await expect(tool.execute({ path: "alias.txt" }, context)).resolves.toMatchObject({ isError: true });
  });

  it("rejects hashes larger than the configured bound", async () => {
    const workspace = await temporaryDirectory();
    await writeFile(path.join(workspace, "large.bin"), "0123456789", "utf8");
    const tool = createFileInfoTool({ maxHashBytes: 4 });
    await expect(tool.execute({ path: "large.bin", hash: true }, {
      runId: "run-1", workspace, operationId: "op-1",
    })).resolves.toMatchObject({ isError: true });
  });

  it.each(["grow", "shrink"] as const)("rejects a file that changes size while hashing (%s)", async (change) => {
    const workspace = await temporaryDirectory();
    const file = path.join(workspace, "changing.txt");
    await writeFile(file, "hello", "utf8");
    let abortedReads = 0;
    const baseSignal = new AbortController().signal;
    const signal = new Proxy(baseSignal, {
      get(target, property) {
        if (property === "aborted") {
          abortedReads += 1;
          // The first check happens at tool entry.  The second is inside the
          // hash loop, after the file handle and expected size are captured.
          if (abortedReads === 2) {
            if (change === "grow") appendFileSync(file, "!");
            else truncateSync(file, 2);
          }
          return false;
        }
        return Reflect.get(target, property, target) as unknown;
      },
    });

    const result = await createFileInfoTool().execute(
      { path: "changing.txt", hash: true },
      { runId: "run-1", workspace, operationId: "op-1", signal },
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain("File changed while hashing");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "nausicaa-file-info-"));
  temporaryDirectories.push(directory);
  return directory;
}
