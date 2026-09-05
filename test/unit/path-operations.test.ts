import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDirectoryCreateTool,
  createPathCopyTool,
  createPathDeleteTool,
  createPathMoveTool,
} from "../../src/tools/index.js";
import { createWorkspaceTools } from "../../src/tools/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("workspace path operation tools", () => {
  it("is included with the explicit workspace write capability", () => {
    expect(createWorkspaceTools({ allowWrite: true, allowPathOperations: true }).map((tool) => tool.definition.name))
      .toEqual([
        "read_file", "read_many", "list_files", "grep", "find", "file_info",
        "git_status", "git_log", "git_show", "git_diff", "write_file", "edit", "apply_patch",
        "directory_create", "path_copy", "path_move", "path_delete",
      ]);
    expect(createWorkspaceTools({ allowWrite: true, allowPathOperations: false })
      .map((tool) => tool.definition.name))
      .toEqual([
        "read_file", "read_many", "list_files", "grep", "find", "file_info",
        "git_status", "git_log", "git_show", "git_diff", "write_file", "edit", "apply_patch",
      ]);
  });
  it("creates directories with optional parent creation and remains idempotent", async () => {
    const workspace = await temporaryDirectory("nausicaa-path-create-");
    const context = { runId: "run-1", workspace, operationId: "op-1" };
    const tool = createDirectoryCreateTool();

    const created = await tool.execute({ path: "one/two", parents: true }, context);
    const repeated = await tool.execute({ path: "one/two", parents: true }, context);

    expect(created).toMatchObject({ isError: false });
    expect(JSON.parse(created.content)).toMatchObject({ path: "one/two", created: true, parents: true });
    expect(JSON.parse(repeated.content)).toMatchObject({ path: "one/two", created: false });
    await expect(lstat(path.join(workspace, "one/two"))).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("requires existing parents when recursive creation is not requested", async () => {
    const workspace = await temporaryDirectory("nausicaa-path-create-parent-");
    const context = { runId: "run-1", workspace, operationId: "op-1" };
    const result = await createDirectoryCreateTool().execute({ path: "missing/child" }, context);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Parent directory does not exist");
  });

  it("rejects a symbolic-link component during recursive parent creation", async () => {
    const workspace = await temporaryDirectory("nausicaa-path-create-link-");
    const outside = await temporaryDirectory("nausicaa-path-create-outside-");
    await mkdir(path.join(workspace, "safe"));
    await symlink(outside, path.join(workspace, "safe", "pivot"), "dir");
    const result = await createDirectoryCreateTool().execute(
      { path: "safe/pivot/nested", parents: true },
      { runId: "run-1", workspace, operationId: "op-1" },
    );

    expect(result.isError).toBe(true);
    await expect(lstat(path.join(outside, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("copies and moves files with explicit overwrite behavior", async () => {
    const workspace = await temporaryDirectory("nausicaa-path-copy-move-");
    await writeFile(path.join(workspace, "source.txt"), "source", "utf8");
    const context = { runId: "run-1", workspace, operationId: "op-1" };
    const copy = createPathCopyTool();
    const move = createPathMoveTool();

    const copied = await copy.execute({ from: "source.txt", to: "copy.txt" }, context);
    const conflict = await copy.execute({ from: "source.txt", to: "copy.txt" }, context);
    const moved = await move.execute({ from: "copy.txt", to: "moved.txt" }, context);
    const replaced = await move.execute({ from: "source.txt", to: "moved.txt", overwrite: true }, context);

    expect(copied.isError).toBe(false);
    expect(JSON.parse(copied.content)).toMatchObject({ from: "source.txt", to: "copy.txt", type: "file", bytes: 6 });
    expect(conflict.isError).toBe(true);
    expect(moved.isError).toBe(false);
    expect(replaced.isError).toBe(false);
    await expect(readFile(path.join(workspace, "moved.txt"), "utf8")).resolves.toBe("source");
    await expect(readFile(path.join(workspace, "source.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically promotes a staged copy over an existing file", async () => {
    const workspace = await temporaryDirectory("nausicaa-path-copy-overwrite-");
    await writeFile(path.join(workspace, "source.txt"), "new", "utf8");
    await writeFile(path.join(workspace, "destination.txt"), "old", "utf8");
    const context = { runId: "run-1", workspace, operationId: "op-1" };

    const result = await createPathCopyTool().execute({
      from: "source.txt",
      to: "destination.txt",
      overwrite: true,
    }, context);

    expect(result.isError).toBe(false);
    await expect(readFile(path.join(workspace, "destination.txt"), "utf8")).resolves.toBe("new");
    expect((await readdir(workspace)).filter((entry) => entry.startsWith(".nausicaa-copy-")))
      .toEqual([]);
  });

  it("copies directories, rejects self-nesting, and protects symlink paths", async () => {
    const workspace = await temporaryDirectory("nausicaa-path-directory-");
    await mkdir(path.join(workspace, "tree"));
    await writeFile(path.join(workspace, "tree", "a.txt"), "a", "utf8");
    await symlink(path.join(workspace, "tree"), path.join(workspace, "alias"), "dir");
    const context = { runId: "run-1", workspace, operationId: "op-1" };
    const copy = createPathCopyTool();

    const copied = await copy.execute({ from: "tree", to: "clone" }, context);
    const nested = await copy.execute({ from: "tree", to: "tree/nested" }, context);
    const linked = await copy.execute({ from: "alias", to: "alias-copy" }, context);

    expect(copied.isError).toBe(false);
    expect(await readFile(path.join(workspace, "clone", "a.txt"), "utf8")).toBe("a");
    expect(nested.isError).toBe(true);
    expect(linked.isError).toBe(true);
  });

  it("leaves no partial destination when a recursive copy is rejected", async () => {
    const workspace = await temporaryDirectory("nausicaa-path-copy-transaction-");
    await mkdir(path.join(workspace, "tree"));
    await writeFile(path.join(workspace, "tree", "visible.txt"), "visible", "utf8");
    await symlink(
      path.join(workspace, "tree", "visible.txt"),
      path.join(workspace, "tree", "linked.txt"),
      "file",
    );
    const context = { runId: "run-1", workspace, operationId: "op-1" };

    const result = await createPathCopyTool().execute(
      { from: "tree", to: "partial-copy" },
      context,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("symbolic links");
    await expect(lstat(path.join(workspace, "partial-copy")))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(workspace)).filter((entry) => entry.startsWith(".nausicaa-copy-")))
      .toEqual([]);
  });

  it("preserves an existing destination when recursive staging fails", async () => {
    const workspace = await temporaryDirectory("nausicaa-path-copy-restore-");
    await mkdir(path.join(workspace, "tree"));
    await writeFile(path.join(workspace, "tree", "visible.txt"), "visible", "utf8");
    await symlink(
      path.join(workspace, "tree", "visible.txt"),
      path.join(workspace, "tree", "linked.txt"),
      "file",
    );
    await writeFile(path.join(workspace, "destination"), "keep", "utf8");
    const context = { runId: "run-1", workspace, operationId: "op-1" };

    const result = await createPathCopyTool().execute(
      { from: "tree", to: "destination", overwrite: true },
      context,
    );

    expect(result.isError).toBe(true);
    await expect(readFile(path.join(workspace, "destination"), "utf8")).resolves.toBe("keep");
    expect((await readdir(workspace)).filter((entry) => entry.startsWith(".nausicaa-copy-")))
      .toEqual([]);
  });

  it("cleans recursive staging when a protected descendant rejects the copy", async () => {
    const workspace = await temporaryDirectory("nausicaa-path-copy-protected-child-");
    await mkdir(path.join(workspace, "tree", "private"), { recursive: true });
    await writeFile(path.join(workspace, "tree", "visible.txt"), "visible", "utf8");
    await writeFile(path.join(workspace, "tree", "private", "secret"), "secret", "utf8");
    const context = { runId: "run-1", workspace, operationId: "op-1" };
    const policy = { protectedPaths: [path.join(workspace, "tree", "private")] };

    const result = await createPathCopyTool(policy).execute(
      { from: "tree", to: "protected-copy" },
      context,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("protected workspace path");
    await expect(lstat(path.join(workspace, "protected-copy")))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(workspace)).filter((entry) => entry.startsWith(".nausicaa-copy-")))
      .toEqual([]);
  });

  it("deletes files and requires recursive for non-empty directories", async () => {
    const workspace = await temporaryDirectory("nausicaa-path-delete-");
    await mkdir(path.join(workspace, "tree"));
    await writeFile(path.join(workspace, "tree", "a.txt"), "a", "utf8");
    await writeFile(path.join(workspace, "empty.txt"), "", "utf8");
    const context = { runId: "run-1", workspace, operationId: "op-1" };
    const tool = createPathDeleteTool();

    const nonRecursive = await tool.execute({ path: "tree" }, context);
    const file = await tool.execute({ path: "empty.txt" }, context);
    const recursive = await tool.execute({ path: "tree", recursive: true }, context);
    const repeat = await tool.execute({ path: "tree" }, context);

    expect(nonRecursive.isError).toBe(true);
    expect(file.isError).toBe(false);
    expect(recursive.isError).toBe(false);
    expect(repeat.isError).toBe(true);
    await expect(readdir(workspace)).resolves.toEqual([]);
  });

  it("refuses to move or delete hard-linked regular files", async () => {
    const workspace = await temporaryDirectory("nausicaa-path-hard-link-");
    await writeFile(path.join(workspace, "source.txt"), "shared", "utf8");
    await link(path.join(workspace, "source.txt"), path.join(workspace, "alias.txt"));
    const context = { runId: "run-1", workspace, operationId: "op-1" };

    const moved = await createPathMoveTool().execute(
      { from: "source.txt", to: "moved.txt" },
      context,
    );
    const deleted = await createPathDeleteTool().execute({ path: "source.txt" }, context);

    expect(moved.isError).toBe(true);
    expect(deleted.isError).toBe(true);
    await expect(readFile(path.join(workspace, "source.txt"), "utf8")).resolves.toBe("shared");
    await expect(readFile(path.join(workspace, "alias.txt"), "utf8")).resolves.toBe("shared");
    await expect(lstat(path.join(workspace, "moved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never mutates protected paths or the workspace root", async () => {
    const workspace = await temporaryDirectory("nausicaa-path-protected-");
    await mkdir(path.join(workspace, "state"));
    await writeFile(path.join(workspace, "state", "secret"), "secret", "utf8");
    const context = { runId: "run-1", workspace, operationId: "op-1" };
    const policy = { protectedPaths: [path.join(workspace, "state")] };

    const deleteProtected = await createPathDeleteTool(policy).execute({ path: "state/secret" }, context);
    const copyProtected = await createPathCopyTool(policy).execute({ from: "state/secret", to: "copy" }, context);
    const deleteRoot = await createPathDeleteTool().execute({ path: ".", recursive: true }, context);

    expect(deleteProtected.isError).toBe(true);
    expect(copyProtected.isError).toBe(true);
    expect(deleteRoot.isError).toBe(true);
    await expect(readFile(path.join(workspace, "state", "secret"), "utf8")).resolves.toBe("secret");
  });

  it("refuses to move a directory containing a protected descendant", async () => {
    const workspace = await temporaryDirectory("nausicaa-path-move-protected-child-");
    await mkdir(path.join(workspace, "tree", "private"), { recursive: true });
    await writeFile(path.join(workspace, "tree", "public.txt"), "public", "utf8");
    await writeFile(path.join(workspace, "tree", "private", "secret"), "secret", "utf8");
    const context = { runId: "run-1", workspace, operationId: "op-1" };
    const policy = { protectedPaths: [path.join(workspace, "tree", "private")] };

    const result = await createPathMoveTool(policy).execute(
      { from: "tree", to: "moved" },
      context,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("protected workspace path");
    await expect(readFile(path.join(workspace, "tree", "private", "secret"), "utf8"))
      .resolves.toBe("secret");
    await expect(lstat(path.join(workspace, "moved"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
