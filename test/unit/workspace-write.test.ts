import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as workspacePath from "../../src/tools/workspace-path.js";
import { writeResolvedWorkspaceFile } from "../../src/tools/workspace-write.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function existingTarget() {
  const workspace = await mkdtemp(path.join(tmpdir(), "nausicaa-write-cancel-"));
  temporaryDirectories.push(workspace);
  await writeFile(path.join(workspace, "target.txt"), "original");
  return workspacePath.resolveWorkspaceWritePath(workspace, "target.txt");
}

describe("workspace write commit boundary", () => {
  it("preserves the original file when cancelled during final path validation", async () => {
    const resolved = await existingTarget();
    const controller = new AbortController();
    const reason = new Error("Cancelled during final validation");
    const revalidate = workspacePath.revalidateWorkspaceWritePath;
    vi.spyOn(workspacePath, "revalidateWorkspaceWritePath").mockImplementationOnce(async (target) => {
      await revalidate(target);
      controller.abort(reason);
    });

    await expect(writeResolvedWorkspaceFile(resolved, Buffer.from("replacement"), controller.signal))
      .rejects.toBe(reason);
    await expect(readFile(resolved.absolute, "utf8")).resolves.toBe("original");
    await expect(readdir(resolved.workspace)).resolves.toEqual(["target.txt"]);
  });

  it("reports the committed write when cancellation arrives after rename", async () => {
    const resolved = await existingTarget();
    const controller = new AbortController();
    const revalidate = workspacePath.revalidateWorkspaceWritePath;
    vi.spyOn(workspacePath, "revalidateWorkspaceWritePath")
      .mockImplementationOnce(revalidate)
      .mockImplementationOnce(async (target) => {
        await revalidate(target);
        controller.abort(new Error("Cancelled after commit"));
      });

    await expect(writeResolvedWorkspaceFile(resolved, Buffer.from("replacement"), controller.signal))
      .resolves.toEqual({ path: "target.txt", byteLength: 11, atomic: true });
    expect(controller.signal.aborted).toBe(true);
    await expect(readFile(resolved.absolute, "utf8")).resolves.toBe("replacement");
    await expect(readdir(resolved.workspace)).resolves.toEqual(["target.txt"]);
  });
});
