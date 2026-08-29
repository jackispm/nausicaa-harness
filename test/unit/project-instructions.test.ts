import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadProjectInstructions,
  projectInstructionManifest,
  ProjectInstructionError,
} from "../../src/runtime/project-instructions.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

describe("project instruction loading", () => {
  it("inherits outer-to-inner and selects one same-directory file by Pi precedence", async () => {
    const root = await temporaryRoot();
    const project = path.join(root, "project");
    const workspace = path.join(project, "src");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "outer\n");
    await writeFile(path.join(project, "CLAUDE.md"), "ignored claude\n");
    await writeFile(path.join(project, "AGENTS.md"), "project\n");
    await writeFile(path.join(workspace, "AGENTS.md"), "ignored agents\n");
    await writeFile(path.join(workspace, "AGENTS.override.md"), "workspace\n");

    const loaded = await loadProjectInstructions(workspace);
    const canonicalRoot = await realpath(root);
    const local = loaded.files.filter((file) => file.path.startsWith(canonicalRoot));

    expect(local.map((file) => path.relative(canonicalRoot, file.path))).toEqual([
      "AGENTS.md",
      "project/AGENTS.md",
      "project/src/AGENTS.override.md",
    ]);
    expect(local.map((file) => file.content)).toEqual([
      "outer\n",
      "project\n",
      "workspace\n",
    ]);
    expect(loaded.sourceHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(loaded.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("canonicalizes a workspace alias but refuses instruction-file symlinks", async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, "workspace");
    const alias = path.join(root, "workspace-alias");
    const outside = path.join(root, "outside.md");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "AGENTS.md"), "real\n");
    await symlink(workspace, alias, "dir");

    const loaded = await loadProjectInstructions(alias);
    expect(loaded.files.at(-1)?.path).toBe(
      path.join(await realpath(workspace), "AGENTS.md"),
    );

    await writeFile(outside, "linked\n");
    await symlink(outside, path.join(workspace, "AGENTS.override.md"));
    await expect(loadProjectInstructions(workspace)).rejects.toBeInstanceOf(
      ProjectInstructionError,
    );
    await expect(loadProjectInstructions(workspace)).rejects.toThrow(/symbolic-link/u);
  });

  it("fails closed at per-file and aggregate byte limits", async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "AGENTS.md"), "12345");

    await expect(loadProjectInstructions(workspace, { maxFileBytes: 4 }))
      .rejects.toThrow(/file limit/u);

    await writeFile(path.join(root, "AGENTS.md"), "1234");
    await writeFile(path.join(workspace, "AGENTS.md"), "5678");
    await expect(loadProjectInstructions(workspace, { maxTotalBytes: 7 }))
      .rejects.toThrow(/total limit/u);
  });

  it("does not duplicate a nested linked worktree's logical repository scope", async () => {
    const root = await temporaryRoot();
    const main = path.join(root, "main");
    const worktree = path.join(main, "nested-worktree");
    const workspace = path.join(worktree, "src");
    const worktreeGitDir = path.join(main, ".git", "worktrees", "nested-worktree");
    await mkdir(workspace, { recursive: true });
    await mkdir(worktreeGitDir, { recursive: true });
    await writeFile(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/worktree\n");
    await writeFile(path.join(worktreeGitDir, "commondir"), "../..\n");
    await writeFile(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
    await writeFile(path.join(main, "AGENTS.md"), "main checkout copy\n");
    await writeFile(path.join(worktree, "AGENTS.md"), "linked worktree copy\n");
    await writeFile(path.join(workspace, "CLAUDE.md"), "nested rule\n");

    const loaded = await loadProjectInstructions(workspace);
    const canonicalMain = await realpath(main);
    const local = loaded.files.filter((file) => file.path.startsWith(canonicalMain));

    expect(local.map((file) => file.content)).toEqual([
      "linked worktree copy\n",
      "nested rule\n",
    ]);
  });

  it("rejects a bundle ref for an empty instruction set", () => {
    expect(() => projectInstructionManifest({
      files: [],
      totalBytes: 0,
      sourceHash: "sha256:empty-source",
      contentHash: "sha256:empty-content",
    }, {
      id: "artifact:empty",
      contentHash: "sha256:empty",
      mediaType: "application/vnd.nausicaa.project-instructions+json",
      byteLength: 0,
    })).toThrow(/must not carry/u);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "nausicaa-instructions-"));
  roots.push(root);
  return root;
}
