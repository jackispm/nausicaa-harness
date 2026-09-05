import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  executeShellCommand,
  type ShellCommandInvocation,
  type ShellExecutionResult,
} from "../../src/tools/shell-process.js";
import {
  buildBubblewrapWorkspaceArguments,
  buildSeatbeltWorkspaceProfile,
  WorkspaceCommandSandbox,
  WorkspaceCommandSandboxUnavailableError,
} from "../../src/tools/workspace-command-sandbox.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("workspace command sandbox", () => {
  it("builds a Seatbelt profile with workspace-only writes and no network", () => {
    const profile = buildSeatbeltWorkspaceProfile({
      workspace: "/work/repo",
      scratch: "/private/tmp/run",
      protectedTargets: [
        { path: "/work/repo/.git", kind: "directory", access: "read-only" },
        { path: "/work/repo/.env", kind: "file", access: "unreadable" },
      ],
    });

    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain("(deny signal)");
    expect(profile).toContain("(allow signal (target same-sandbox))");
    expect(profile).toContain("(deny process-info*)");
    expect(profile).toContain("(allow process-info* (target same-sandbox))");
    expect(profile).toContain("(deny mach-lookup)");
    expect(profile).toContain("(deny appleevent-send)");
    expect(profile).toContain('(deny process-exec (literal "/usr/bin/osascript"))');
    expect(profile).toContain('(deny process-exec (literal "/usr/bin/open"))');
    expect(profile).toContain('(deny process-exec (literal "/usr/bin/automator"))');
    expect(profile).toContain('(deny process-exec (literal "/usr/bin/shortcuts"))');
    expect(profile).toContain('(subpath "/work/repo")');
    expect(profile).toContain('(subpath "/private/tmp/run")');
    expect(profile).toContain('(deny file-write* (literal "/work/repo/.git")');
    expect(profile).toContain('(deny file-read* file-write* (literal "/work/repo/.env")');
  });

  it("escapes paths embedded in Seatbelt policy strings", () => {
    const profile = buildSeatbeltWorkspaceProfile({
      workspace: '/work/a"b',
      scratch: "/tmp/a\\b",
    });

    expect(profile).toContain('/work/a\\"b');
    expect(profile).toContain('/tmp/a\\\\b');
  });

  it("builds a bubblewrap profile with read-only host, isolated network, and protected metadata", () => {
    const args = buildBubblewrapWorkspaceArguments({
      workspace: "/work/repo",
      protectedTargets: [
        { path: "/work/repo/.git", kind: "directory", access: "read-only" },
        { path: "/work/repo/.env", kind: "file", access: "unreadable" },
        { path: "/work/repo/.nausicaa", kind: "directory", access: "unreadable" },
      ],
    });

    expect(args).toEqual(expect.arrayContaining([
      "--ro-bind", "/", "/",
      "--unshare-pid",
      "--unshare-net",
      "--tmpfs", "/run",
      "--bind", "/work/repo", "/work/repo",
      "--ro-bind", "/work/repo/.git", "/work/repo/.git",
      "--ro-bind", "/dev/null", "/work/repo/.env",
      "--tmpfs", "/work/repo/.nausicaa",
      "--remount-ro", "/work/repo/.nausicaa",
    ]));
  });

  it("fails closed on unsupported platforms without invoking a command", async () => {
    const execute = vi.fn();
    const sandbox = new WorkspaceCommandSandbox({
      platform: "aix",
      execute,
    });

    expect(sandbox.availability()).toEqual({
      available: false,
      reason: "Workspace Bash has no OS sandbox backend for aix",
    });
    await expect(sandbox.execute({ command: "touch escaped", cwd: "/" }))
      .rejects.toBeInstanceOf(WorkspaceCommandSandboxUnavailableError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("caches functional probes and executes through the exact Seatbelt argv", async () => {
    const workspace = await temporaryDirectory();
    await mkdir(path.join(workspace, ".git"));
    await mkdir(path.join(workspace, ".git", "hooks"));
    await writeFile(path.join(workspace, ".git", "config"), "token", "utf8");
    await writeFile(path.join(workspace, ".env"), "secret", "utf8");
    await mkdir(path.join(workspace, "packages", "api"), { recursive: true });
    await writeFile(path.join(workspace, "packages", "api", ".env.production"), "secret", "utf8");
    const canonical = await realpath(workspace);
    const probe = vi.fn((invocation: ShellCommandInvocation) => {
      const profile = invocation.arguments[1];
      expect(profile).toContain("(deny signal)");
      expect(profile).toContain("(deny mach-lookup)");
      expect(profile).toContain('(deny process-exec (literal "/usr/bin/osascript"))');
      expect(profile).toContain("(deny file-write*)");
      expect(profile).toContain("(deny network*)");
      return true;
    });
    let scratch: string | undefined;
    const execute = vi.fn(async (input: Parameters<typeof executeShellCommand>[0]) => {
      scratch = input.env?.TMPDIR;
      expect(input.command).toBe("npm test");
      expect(input.cwd).toBe(canonical);
      expect(input.invocation?.executable).toBe("/usr/bin/true");
      expect(input.invocation?.arguments.slice(-3)).toEqual(["--", "/bin/bash", "-c"]);
      const profile = input.invocation?.arguments[1];
      expect(profile).toContain(path.join(canonical, ".git"));
      expect(profile).toContain(path.join(canonical, ".git", "config"));
      expect(profile).toContain(path.join(canonical, ".git", "hooks"));
      expect(profile).toContain(path.join(canonical, ".env"));
      expect(profile).toContain(path.join(canonical, "packages", "api", ".env.production"));
      expect(profile).toContain(path.join(homedir(), ".config", "gh"));
      expect(profile).toContain(path.join(homedir(), ".docker"));
      expect(input.env).toMatchObject({
        GIT_OPTIONAL_LOCKS: "0",
        TMPDIR: expect.stringContaining("nausicaa-sandbox-"),
      });
      return successfulExecution("ok");
    });
    const sandbox = new WorkspaceCommandSandbox({
      platform: "darwin",
      seatbeltExecutable: "/usr/bin/true",
      probe,
      execute,
    });

    expect(sandbox.availability()).toEqual({ available: true, backend: "macos-seatbelt" });
    expect(sandbox.availability()).toEqual({ available: true, backend: "macos-seatbelt" });
    const result = await sandbox.execute({ command: "npm test", cwd: workspace });

    expect(result.stdout.content).toBe("ok");
    expect(probe).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(scratch).toBeDefined();
    await expect(readFile(scratch!, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats runner profile refusal as unavailable rather than a command failure", async () => {
    const workspace = await temporaryDirectory();
    const sandbox = new WorkspaceCommandSandbox({
      platform: "darwin",
      seatbeltExecutable: "/usr/bin/true",
      probe: () => true,
      execute: async () => failedExecution("sandbox-exec: sandbox_apply: Operation not permitted"),
    });

    await expect(sandbox.execute({ command: "printf never", cwd: workspace }))
      .rejects.toThrow(/refused its confinement profile/i);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "nausicaa-workspace-sandbox-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function successfulExecution(stdout: string): ShellExecutionResult {
  return execution(stdout, "", 0);
}

function failedExecution(stderr: string): ShellExecutionResult {
  return execution("", stderr, 71);
}

function execution(stdout: string, stderr: string, exitCode: number): ShellExecutionResult {
  const snapshot = (content: string) => ({
    content,
    truncated: false,
    truncatedBy: null,
    totalBytes: Buffer.byteLength(content, "utf8"),
    totalLines: content.length === 0 ? 0 : 1,
    outputBytes: Buffer.byteLength(content, "utf8"),
    outputLines: content.length === 0 ? 0 : 1,
  }) as const;
  return {
    stdout: snapshot(stdout),
    stderr: snapshot(stderr),
    exitCode,
    aborted: false,
    timedOut: false,
  };
}
