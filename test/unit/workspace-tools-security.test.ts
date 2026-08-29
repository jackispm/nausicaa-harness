import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createListFilesTool,
  createReadFileTool,
  createProcessJobTools,
  createWorkspaceTools,
  createWriteFileTool,
  listFilesTool,
  readFileTool,
  writeFileTool,
} from "../../src/tools/index.js";
import {
  resolveExistingWorkspacePath,
  resolveWorkspaceWritePath,
  revalidateExistingWorkspacePath,
  revalidateWorkspaceParent,
} from "../../src/tools/workspace-path.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("workspace tool path security", () => {
  it("keeps writes and shell disabled by default and enables them independently", () => {
    expect(createWorkspaceTools().map((tool) => tool.definition.name)).toEqual([
      "read_file",
      "read_many",
      "list_files",
      "grep",
      "find",
      "file_info",
      "git_status",
      "git_log",
      "git_show",
      "git_diff",
    ]);
    expect(createWorkspaceTools({ allowWrite: true }).map((tool) => tool.definition.name))
      .toEqual([
        "read_file", "read_many", "list_files", "grep", "find", "file_info",
        "git_status", "git_log", "git_show", "git_diff", "write_file", "edit",
        "directory_create", "path_copy", "path_move", "path_delete",
      ]);
    expect(createWorkspaceTools({ allowShell: true }).map((tool) => tool.definition.name))
      .toEqual([
        "read_file", "read_many", "list_files", "grep", "find", "file_info",
        "git_status", "git_log", "git_show", "git_diff", "bash",
      ]);
    expect(createWorkspaceTools({ allowShell: true, allowWrite: true, allowPathOperations: true })
      .map((tool) => tool.definition.name))
      .toEqual([
        "read_file",
        "read_many",
        "list_files",
        "grep",
        "find",
        "file_info",
        "git_status",
        "git_log",
        "git_show",
        "git_diff",
        "write_file",
        "edit",
        "directory_create",
        "path_copy",
        "path_move",
        "path_delete",
        "bash",
      ]);
    expect(createWorkspaceTools({ allowProcessJobs: true })
      .map((tool) => tool.definition.name))
      .toEqual([
        "read_file", "read_many", "list_files", "grep", "find", "file_info",
        "git_status", "git_log", "git_show", "git_diff",
      ]);
    expect(createWorkspaceTools({ allowShell: true, allowProcessJobs: true })
      .map((tool) => tool.definition.name))
      .toEqual([
        "read_file",
        "read_many",
        "list_files",
        "grep",
        "find",
        "file_info",
        "git_status",
        "git_log",
        "git_show",
        "git_diff",
        "bash",
        "process_start",
        "process_status",
        "process_output",
        "process_kill",
        "process_list",
      ]);
    expect(createProcessJobTools).toBeTypeOf("function");
  });

  it("paginates large directory listings with a stable continuation offset", async () => {
    const workspace = await temporaryDirectory("nausicaa-workspace-list-page-");
    for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
      await writeFile(path.join(workspace, name), name, "utf8");
    }
    const context = { runId: "run-1", workspace, operationId: "operation-1" };
    const tool = createListFilesTool();

    const first = await tool.execute({ path: ".", maxEntries: 2 }, context);
    expect(first.isError).toBe(false);
    expect(JSON.parse(first.content)).toMatchObject({
      offset: 0,
      entries: [
        { path: "a.txt", type: "file" },
        { path: "b.txt", type: "file" },
      ],
      truncated: true,
      nextOffset: 2,
    });

    const second = await tool.execute({
      path: ".",
      offset: JSON.parse(first.content).nextOffset,
      maxEntries: 2,
    }, context);
    expect(second.isError).toBe(false);
    expect(JSON.parse(second.content)).toMatchObject({
      offset: 2,
      entries: [
        { path: "c.txt", type: "file" },
        { path: "d.txt", type: "file" },
      ],
      truncated: false,
    });
    expect(JSON.parse(second.content)).not.toHaveProperty("nextOffset");
  });

  it("denies sensitive files and hides protected entries from root listings", async () => {
    const workspace = await temporaryDirectory("nausicaa-workspace-protected-");
    await mkdir(path.join(workspace, ".ssh"));
    await mkdir(path.join(workspace, ".nausicaa"));
    await writeFile(path.join(workspace, ".env"), "SECRET=one");
    await writeFile(path.join(workspace, ".env.local"), "SECRET=two");
    await writeFile(path.join(workspace, ".env.example"), "PUBLIC_SETTING=example");
    await writeFile(path.join(workspace, ".ssh", "id_rsa"), "private key");
    await writeFile(path.join(workspace, ".nausicaa", "events.jsonl"), "runtime state");
    await writeFile(path.join(workspace, "visible.txt"), "safe");
    const context = { runId: "run-1", workspace, operationId: "operation-1" };

    for (const protectedPath of [".env", ".env.local", ".ssh/id_rsa", ".nausicaa/events.jsonl"]) {
      await expect(readFileTool.execute({ path: protectedPath }, context))
        .resolves.toMatchObject({ isError: true });
      await expect(writeFileTool.execute({ path: protectedPath, content: "must not write" }, context))
        .resolves.toMatchObject({ isError: true });
    }

    const listing = await listFilesTool.execute({ path: ".", recursive: true }, context);
    expect(listing.isError).toBe(false);
    const entries = JSON.parse(listing.content).entries as Array<{ path: string; type: string }>;
    expect(entries).toContainEqual({ path: "visible.txt", type: "file" });
    expect(entries).toContainEqual({ path: ".env.example", type: "file" });
    expect(entries.some(({ path: entryPath }) =>
      entryPath === ".env"
      || entryPath === ".env.local"
      || entryPath === ".ssh"
      || entryPath.startsWith(".ssh/")
      || entryPath === ".nausicaa"
      || entryPath.startsWith(".nausicaa/"),
    )).toBe(false);
    await expect(readFileTool.execute({ path: ".env.example" }, context))
      .resolves.toMatchObject({ isError: false });
  });

  it("blocks a custom runtime state directory through protectedPaths", async () => {
    const workspace = await temporaryDirectory("nausicaa-workspace-state-");
    const stateDir = path.join(workspace, "runtime-state");
    await mkdir(stateDir);
    await writeFile(path.join(stateDir, "session.json"), "private state");
    await writeFile(path.join(workspace, "visible.txt"), "safe");
    const context = { runId: "run-1", workspace, operationId: "operation-1" };
    const read = createReadFileTool({ protectedPaths: [stateDir] });
    const write = createWriteFileTool({ protectedPaths: [stateDir] });
    const list = createListFilesTool({ protectedPaths: [stateDir] });

    await expect(read.execute({ path: "runtime-state/session.json" }, context))
      .resolves.toMatchObject({ isError: true });
    await expect(write.execute({ path: "runtime-state/new.json", content: "must not write" }, context))
      .resolves.toMatchObject({ isError: true });

    const listing = await list.execute({ path: ".", recursive: true }, context);
    expect(listing.isError).toBe(false);
    const entries = JSON.parse(listing.content).entries as Array<{ path: string; type: string }>;
    expect(entries).toContainEqual({ path: "visible.txt", type: "file" });
    expect(entries.some(({ path: entryPath }) =>
      entryPath === "runtime-state" || entryPath.startsWith("runtime-state/"),
    )).toBe(false);
  });

  it("refuses internal directory and file symlinks without traversing them", async () => {
    const workspace = await temporaryDirectory("nausicaa-workspace-secure-");
    const realDirectory = path.join(workspace, "real");
    await mkdir(realDirectory);
    await writeFile(path.join(realDirectory, "secret.txt"), "internal secret");
    await symlink(realDirectory, path.join(workspace, "directory-alias"), "dir");
    await symlink(
      path.join(realDirectory, "secret.txt"),
      path.join(workspace, "file-alias.txt"),
    );
    const context = { runId: "run-1", workspace, operationId: "operation-1" };

    const readDirectoryAlias = await readFileTool.execute(
      { path: "directory-alias/secret.txt" },
      context,
    );
    const readFileAlias = await readFileTool.execute({ path: "file-alias.txt" }, context);
    const listAlias = await listFilesTool.execute({ path: "directory-alias" }, context);
    const writeAlias = await writeFileTool.execute({
      path: "directory-alias/new.txt",
      content: "must not be written",
    }, context);

    expect(readDirectoryAlias.isError).toBe(true);
    expect(readFileAlias.isError).toBe(true);
    expect(listAlias.isError).toBe(true);
    expect(writeAlias.isError).toBe(true);
    await expect(readFile(path.join(realDirectory, "new.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const rootListing = await listFilesTool.execute({ path: ".", recursive: true }, context);
    const entries = JSON.parse(rootListing.content).entries as Array<{
      path: string;
      type: string;
    }>;
    expect(entries).toContainEqual({ path: "directory-alias", type: "symlink" });
    expect(entries).not.toContainEqual({
      path: "directory-alias/secret.txt",
      type: "file",
    });
  });

  it("never reads or replaces a final symlink", async () => {
    const workspace = await temporaryDirectory("nausicaa-workspace-secure-");
    const outside = await temporaryDirectory("nausicaa-workspace-outside-");
    const outsideFile = path.join(outside, "outside.txt");
    await writeFile(outsideFile, "do not expose or replace");
    await symlink(outsideFile, path.join(workspace, "target.txt"));
    const context = { runId: "run-1", workspace, operationId: "operation-1" };

    const read = await readFileTool.execute({ path: "target.txt" }, context);
    const write = await writeFileTool.execute({
      path: "target.txt",
      content: "replacement",
    }, context);

    expect(read.isError).toBe(true);
    expect(write.isError).toBe(true);
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("do not expose or replace");
    expect((await readdir(workspace)).filter((name) => name.startsWith(".nausicaa-")))
      .toEqual([]);
  });

  it("rejects a symbolic-link workspace root", async () => {
    const parent = await temporaryDirectory("nausicaa-workspace-secure-");
    const workspace = path.join(parent, "real");
    const alias = path.join(parent, "alias");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "file.txt"), "content");
    await symlink(workspace, alias, "dir");
    const context = { runId: "run-1", workspace: alias, operationId: "operation-1" };

    await expect(readFileTool.execute({ path: "file.txt" }, context)).resolves.toMatchObject({
      isError: true,
    });
    await expect(listFilesTool.execute({ path: "." }, context)).resolves.toMatchObject({
      isError: true,
    });
    await expect(writeFileTool.execute({ path: "new.txt", content: "new" }, context))
      .resolves.toMatchObject({ isError: true });
  });

  it("detects parent and final-component swaps during revalidation", async () => {
    const workspace = await temporaryDirectory("nausicaa-workspace-secure-");
    const outside = await temporaryDirectory("nausicaa-workspace-outside-");
    const nested = path.join(workspace, "nested");
    await mkdir(nested);
    await writeFile(path.join(workspace, "read.txt"), "inside");
    await writeFile(path.join(outside, "read.txt"), "outside");

    const writeResolution = await resolveWorkspaceWritePath(workspace, "nested/new.txt");
    await rm(nested, { recursive: true });
    await symlink(outside, nested, "dir");
    await expect(revalidateWorkspaceParent(writeResolution)).rejects.toThrow(/symbolic-link/i);

    const readResolution = await resolveExistingWorkspacePath(workspace, "read.txt");
    await unlink(path.join(workspace, "read.txt"));
    await symlink(path.join(outside, "read.txt"), path.join(workspace, "read.txt"));
    await expect(revalidateExistingWorkspacePath(readResolution))
      .rejects.toThrow(/symbolic-link/i);
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
