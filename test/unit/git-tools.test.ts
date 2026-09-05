import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  createGitDiffTool,
  createGitLogTool,
  createGitShowTool,
  createGitStatusTool,
  createGitTools,
} from "../../src/tools/git.js";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("Mowe read-only Git tools", () => {
  it("exposes the four fixed, read-only repository operations", () => {
    expect(createGitTools().map((tool) => tool.definition.name)).toEqual([
      "git_status",
      "git_log",
      "git_show",
      "git_diff",
    ]);
    for (const tool of createGitTools()) {
      expect(tool.definition.parameters.additionalProperties).toBe(false);
    }
  });

  it("returns status while filtering protected workspace paths", async () => {
    const workspace = await repository();
    await writeFile(path.join(workspace, "visible.txt"), "changed\n", "utf8");
    await writeFile(path.join(workspace, ".env"), "SECRET=changed\n", "utf8");
    const result = await createGitStatusTool().execute({}, context(workspace));

    expect(result.isError).toBe(false);
    const value = JSON.parse(result.content) as {
      branch?: string;
      entries: Array<{ status: string; path: string }>;
      output: string;
      omittedProtectedPaths: number;
    };
    expect(value.branch).toContain("master");
    expect(value.entries).toContainEqual({ status: " M", path: "visible.txt" });
    expect(value.entries.some((entry) => entry.path === ".env")).toBe(false);
    expect(value.omittedProtectedPaths).toBeGreaterThan(0);
    expect(value.output).not.toContain("SECRET");
  });

  it("reads log, show, and working-tree diff without shell access", async () => {
    const workspace = await repository();
    await writeFile(path.join(workspace, "visible.txt"), "second\n", "utf8");
    await git(workspace, ["add", "visible.txt"]);
    await git(workspace, ["-c", "user.name=Nausicaa", "-c", "user.email=nausicaa@example.test", "commit", "-qm", "second change"]);
    await writeFile(path.join(workspace, "visible.txt"), "working tree\n", "utf8");

    const log = await createGitLogTool().execute({ maxCount: 2 }, context(workspace));
    const show = await createGitShowTool().execute({ revision: "HEAD" }, context(workspace));
    const diff = await createGitDiffTool().execute({}, context(workspace));

    expect(log.isError).toBe(false);
    expect(JSON.parse(log.content)).toMatchObject({ maxCount: 2 });
    expect(JSON.parse(log.content).output).toContain("second change");
    expect(show.isError).toBe(false);
    expect(JSON.parse(show.content).output).toContain("second");
    expect(diff.isError).toBe(false);
    expect(JSON.parse(diff.content).output).toContain("working tree");
  });

  it("supports staged and commit-to-commit comparisons", async () => {
    const workspace = await repository();
    const first = await git(workspace, ["rev-parse", "HEAD"]);
    await writeFile(path.join(workspace, "visible.txt"), "staged\n", "utf8");
    await git(workspace, ["add", "visible.txt"]);

    const staged = await createGitDiffTool().execute({ staged: true, statOnly: true }, context(workspace));
    expect(staged.isError).toBe(false);
    expect(JSON.parse(staged.content)).toMatchObject({ statOnly: true, pathsShown: 1 });
    expect(JSON.parse(staged.content).output).toContain("visible.txt");

    await git(workspace, ["-c", "user.name=Nausicaa", "-c", "user.email=nausicaa@example.test", "commit", "-qm", "staged change"]);
    const second = (await git(workspace, ["rev-parse", "HEAD"])).trim();
    const between = await createGitDiffTool().execute({ from: first.trim(), to: second, statOnly: true }, context(workspace));
    expect(between.isError).toBe(false);
    expect(JSON.parse(between.content).output).toContain("visible.txt");
  });

  it("rejects revision and path option injection", async () => {
    const workspace = await repository();
    const log = await createGitLogTool().execute({ revision: "--help" }, context(workspace));
    const range = await createGitLogTool().execute({ revision: "HEAD~1..HEAD" }, context(workspace));
    const pathOption = await createGitDiffTool().execute({ paths: ["--output=escape"] }, context(workspace));
    const outside = await createGitDiffTool().execute({ paths: ["../outside"] }, context(workspace));

    expect(log.isError).toBe(true);
    expect(range.isError).toBe(true);
    expect(pathOption.isError).toBe(true);
    expect(outside.isError).toBe(true);
  });

  it("requires the supplied workspace to be the repository root", async () => {
    const workspace = await repository();
    const nested = path.join(workspace, "nested");
    await writeFile(path.join(workspace, "nested-marker"), "x", "utf8");
    await execFile("mkdir", [nested]);

    const result = await createGitStatusTool().execute({}, context(nested));
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toMatch(/repository root/i);
  });

  it("does not execute repository-configured external diff helpers", async () => {
    if (process.platform === "win32") return;
    const workspace = await repository();
    const marker = path.join(workspace, "helper-ran");
    const helper = path.join(workspace, "external-diff.sh");
    await writeFile(helper, `#!/bin/sh\nprintf ran > ${shellQuote(marker)}\nexit 1\n`, "utf8");
    await chmod(helper, 0o755);
    await git(workspace, ["config", "diff.external", helper]);
    await writeFile(path.join(workspace, "visible.txt"), "changed\n", "utf8");

    const result = await createGitDiffTool().execute({}, context(workspace));
    expect(result.isError).toBe(false);
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(result.content).output).toContain("visible.txt");
  });

  it("does not execute clean filters from per-worktree Git config", async () => {
    if (process.platform === "win32") return;
    const workspace = await repository();
    const marker = path.join(workspace, "filter-ran");
    const helper = path.join(workspace, "clean-filter.sh");
    await writeFile(helper, [
      "#!/bin/sh",
      `printf ran > ${shellQuote(marker)}`,
      "cat",
    ].join("\n"), "utf8");
    await chmod(helper, 0o755);
    await git(workspace, ["config", "extensions.worktreeConfig", "true"]);
    await git(workspace, ["config", "--worktree", "filter.evil.clean", helper]);
    await writeFile(path.join(workspace, ".gitattributes"), "visible.txt filter=evil\n", "utf8");
    await writeFile(path.join(workspace, "visible.txt"), "changed\n", "utf8");

    const result = await createGitDiffTool().execute({}, context(workspace));

    expect(result.isError).toBe(false);
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(result.content).output).toContain("visible.txt");
  });

  it("does not resolve the default Git executable from the workspace", async () => {
    if (process.platform === "win32") return;
    const workspace = await repository();
    const marker = path.join(workspace, "workspace-git-ran");
    const fakeGit = path.join(workspace, "git");
    await writeFile(fakeGit, [
      "#!/bin/sh",
      `printf ran > ${shellQuote(marker)}`,
      "exit 1",
    ].join("\n"), "utf8");
    await chmod(fakeGit, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = [
      ".",
      workspace,
      originalPath ?? "/usr/bin:/bin",
    ].join(path.delimiter);
    try {
      const result = await createGitStatusTool().execute({}, context(workspace));
      expect(result.isError).toBe(false);
      await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it("bounds large patches and reports truncation metadata", async () => {
    const workspace = await repository();
    await writeFile(path.join(workspace, "visible.txt"), `${"changed line\n".repeat(10_000)}`, "utf8");

    const result = await createGitDiffTool().execute({}, context(workspace));
    expect(result.isError).toBe(false);
    const value = JSON.parse(result.content) as {
      output: string;
      truncated: boolean;
      truncation: { outputBytes: number; outputLines: number };
    };
    expect(value.truncated).toBe(true);
    expect(value.truncation.outputBytes).toBeLessThanOrEqual(50 * 1024);
    expect(value.truncation.outputLines).toBeLessThanOrEqual(2_000);
  });

  it("cancels a running Git subprocess", async () => {
    if (process.platform === "win32") return;
    const workspace = await repository();
    const fakeGit = path.join(workspace, "fake-git.sh");
    await writeFile(fakeGit, [
      "#!/bin/sh",
      "case \"$*\" in",
      "  *\"rev-parse --show-toplevel\"*) printf '%s\\n' \"$PWD\" ;;",
      "  *\"config --includes\"*) exit 1 ;;",
      "  *) sleep 5 ;;",
      "esac",
    ].join("\n"), "utf8");
    await chmod(fakeGit, 0o755);
    const controller = new AbortController();
    const resultPromise = createGitStatusTool({ gitBinary: fakeGit }).execute({}, {
      ...context(workspace),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);

    const result = await resultPromise;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({ aborted: true, timedOut: false });
  });

  it("honors cancellation before spawning Git", async () => {
    const workspace = await repository();
    const controller = new AbortController();
    controller.abort(new Error("cancelled by test"));
    const result = await createGitStatusTool().execute({}, {
      ...context(workspace),
      signal: controller.signal,
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain("cancelled");
  });
});

function context(workspace: string) {
  return { runId: "run-1", workspace, operationId: "operation-1" };
}

async function repository(): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "nausicaa-git-tool-"));
  temporaryDirectories.push(workspace);
  await git(workspace, ["init", "-q", "-b", "master"]);
  await writeFile(path.join(workspace, "visible.txt"), "initial\n", "utf8");
  await git(workspace, ["add", "visible.txt"]);
  await git(workspace, ["-c", "user.name=Nausicaa", "-c", "user.email=nausicaa@example.test", "commit", "-qm", "initial change"]);
  return workspace;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFile("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    maxBuffer: 2 * 1024 * 1024,
  });
  return result.stdout;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
