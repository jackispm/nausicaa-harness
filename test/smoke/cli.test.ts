import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { VERSION } from "../../src/version.js";

const execFileAsync = promisify(execFile);
const builtCli = join(process.cwd(), "dist", "cli.js");

describe("built CLI", () => {
  it("starts through its executable bin and prints help without model credentials", async () => {
    const { stdout, stderr } = await execFileAsync(
      builtCli,
      ["--help"],
      { env: { PATH: process.env.PATH } },
    );

    expect(stderr).toBe("");
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("nausicaa [options] [@image ...] [message]");
  });

  it("reports a stable version", async () => {
    const { stdout } = await execFileAsync(builtCli, ["--version"]);
    expect(stdout.trim()).toBe(VERSION);
  });

  it.each([
    ["print", ["--topology", "--print"]],
    ["json", ["--topology", "--json"]],
  ] as const)("supports non-TTY %s output without starting a model", async (mode, args) => {
    const root = await mkdtemp(join(tmpdir(), `nausicaa-cli-${mode}-`));
    try {
      const { stdout, stderr } = await execFileAsync(
        builtCli,
        ["--workspace", root, "--data-dir", join(root, "state"), ...args],
        { env: { PATH: process.env.PATH } },
      );

      expect(stderr).toBe("");
      if (mode === "json") {
        expect(JSON.parse(stdout)).toMatchObject({ version: 1, nodes: [], edges: [] });
      } else {
        expect(stdout).toContain("Nausicaa awareness");
        expect(stdout).toContain("0 nodes");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("executes a minimal Run through the built runtime artifact", async () => {
    const script = `
      import { mkdtemp, rm } from "node:fs/promises";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { ScriptedModel } from "./dist/model/index.js";
      import { executeRun } from "./dist/runtime/index.js";
      const root = await mkdtemp(join(tmpdir(), "nausicaa-built-smoke-"));
      try {
        const result = await executeRun({
          workspace: root,
          dataDir: join(root, "state"),
          model: "scripted",
          message: "Say done",
          policy: { maxMainSteps: 1, tetoEnabled: false },
        }, {
          mainModel: new ScriptedModel([{
            content: "done",
            toolCalls: [],
            stopReason: "stop",
            usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
          }]),
          createRunId: () => "built-smoke-run",
        });
        if (!result.completed || result.finalText !== "done") process.exit(1);
        process.stdout.write(JSON.stringify({ completed: result.completed, runId: result.runId }));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    `;
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: process.cwd(), env: { PATH: process.env.PATH } },
    );
    expect(JSON.parse(stdout)).toEqual({ completed: true, runId: "built-smoke-run" });
  });

  it("fails closed on an unknown model before starting a built CLI Run", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "nausicaa-cli-failure-")));
    try {
      const failure = await runBuiltCli([
        "-p",
        "--main-only",
        "--model",
        "missing:model",
        "--workspace",
        root,
        "--data-dir",
        join(root, "state"),
        "fail without network access",
      ], "", { HOME: root, PATH: process.env.PATH ?? "" });

      expect(failure.code).toBe(2);
      expect(failure.stderr).toContain("Model is not present in the local catalog");
      expect(failure.stderr).toContain("No provider request or edge refresh was started");
      expect(failure.stderr).not.toContain("Run:");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts one non-interactive task source and rejects conflicts or empty stdin", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "nausicaa-cli-stdin-")));
    const baseArgs = [
      "--print",
      "--main-only",
      "--model",
      "missing:model",
      "--workspace",
      root,
    ];
    const env = { HOME: root, PATH: process.env.PATH ?? "" };
    try {
      const stdinOnly = await runBuiltCli(
        [...baseArgs, "--data-dir", join(root, "stdin-state")],
        "task from stdin\n",
        env,
      );
      expect(stdinOnly.code).toBe(2);
      expect(stdinOnly.stderr).toContain("Model is not present in the local catalog");
      expect(stdinOnly.stderr).not.toContain("requires a task");

      const positionalOnly = await runBuiltCli(
        [...baseArgs, "--data-dir", join(root, "positional-state"), "positional task"],
        "",
        env,
      );
      expect(positionalOnly.code).toBe(2);
      expect(positionalOnly.stderr).toContain("Model is not present in the local catalog");

      const continued = await runBuiltCli(
        [
          ...baseArgs,
          "--continue",
          "--data-dir",
          join(root, "positional-state"),
        ],
        "",
        env,
      );
      expect(continued.code).toBe(2);
      expect(continued.stderr).toContain("Model is not present in the local catalog");
      expect(continued.stderr).not.toContain("Credential not detected");

      const continuedWithTask = await runBuiltCli(
        [
          ...baseArgs,
          "--continue",
          "--data-dir",
          join(root, "continued-task-state"),
          "new task",
        ],
        "",
        env,
      );
      expect(continuedWithTask.code).toBe(2);
      expect(continuedWithTask.stderr).toContain("Model is not present in the local catalog");

      const conflict = await runBuiltCli(
        [...baseArgs, "--data-dir", join(root, "conflict-state"), "positional task"],
        "task from stdin\n",
        env,
      );
      expect(conflict).toMatchObject({
        code: 2,
        stdout: "",
      });
      expect(conflict.stderr).toContain("both positionally and on stdin");

      const empty = await runBuiltCli(
        ["--print", "--workspace", root, "--data-dir", join(root, "empty-state")],
        " \n\t",
        env,
      );
      expect(empty).toMatchObject({ code: 2, stdout: "" });
      expect(empty.stderr).toContain("requires a task on stdin");
      expect(empty.stderr).not.toContain("No model configured");

      const jsonEmpty = await runBuiltCli(
        ["--json", "--workspace", root, "--data-dir", join(root, "json-empty-state")],
        "",
        env,
      );
      expect(jsonEmpty).toMatchObject({ code: 2, stderr: "" });
      expect(JSON.parse(jsonEmpty.stdout)).toMatchObject({
        kind: "error",
        error: { type: "input.task-missing" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports missing model or credential without starting a provider request", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "nausicaa-cli-setup-")));
    const env = { HOME: root, PATH: process.env.PATH ?? "" };
    try {
      const missingModel = await runBuiltCli([
        "--print",
        "--workspace",
        root,
        "--data-dir",
        join(root, "missing-model-state"),
        "task",
      ], "", env);
      expect(missingModel.code).toBe(2);
      expect(missingModel.stderr).toContain("No model configured");
      expect(missingModel.stderr).toContain("Next step (non-interactive)");

      const missingCredential = await runBuiltCli([
        "--json",
        "--main-only",
        "--model",
        "openrouter:openai/gpt-5-mini",
        "--workspace",
        root,
        "--data-dir",
        join(root, "missing-credential-state"),
        "task",
      ], "", env);
      expect(missingCredential).toMatchObject({ code: 2, stderr: "" });
      expect(JSON.parse(missingCredential.stdout)).toMatchObject({
        kind: "error",
        error: {
          type: "configuration.credential-missing",
          source: "OPENROUTER_API_KEY",
          authStatus: "unverified",
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not start configured edge refresh when local model preflight fails", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "nausicaa-cli-preflight-edge-")));
    const marker = join(root, "edge-started");
    const command = join(root, "edge-command.mjs");
    const homeSettings = join(root, ".nausicaa", "settings.json");
    try {
      await mkdir(join(root, ".nausicaa"), { recursive: true });
      await writeFile(
        command,
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "started");\n`,
      );
      await writeFile(homeSettings, JSON.stringify({
        model: "missing:model",
        edges: {
          enabled: true,
          refreshOnStart: true,
          sources: [{
            sourceId: "side-effect",
            type: "mcp",
            command: process.execPath,
            args: [command],
          }],
        },
      }));
      const result = await runBuiltCli(
        ["--print", "--workspace", root, "--data-dir", join(root, "state"), "task"],
        "",
        { HOME: root, PATH: process.env.PATH ?? "" },
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("No provider request or edge refresh was started");
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });

      const continued = await runBuiltCli(
        ["--print", "--continue", "--workspace", root, "--data-dir", join(root, "continue-state"), "task"],
        "",
        { HOME: root, PATH: process.env.PATH ?? "" },
      );
      expect(continued.code).toBe(2);
      expect(continued.stderr).toContain("No provider request or edge refresh was started");
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });

      await writeFile(homeSettings, JSON.stringify({
        model: "openrouter:openai/gpt-5-mini",
        edges: {
          enabled: true,
          refreshOnStart: true,
          sources: [{
            sourceId: "side-effect",
            type: "mcp",
            command: process.execPath,
            args: [command],
          }],
        },
      }));
      const missingCredential = await runBuiltCli(
        ["--print", "--workspace", root, "--data-dir", join(root, "credential-state"), "task"],
        "",
        { HOME: root, PATH: process.env.PATH ?? "" },
      );
      expect(missingCredential.code).toBe(2);
      expect(missingCredential.stderr).toContain("Credential not detected: OPENROUTER_API_KEY");
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers and reports damaged Runs before exposing the daemon socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-cli-daemon-"));
    const stateDir = join(root, "state");
    try {
      await mkdir(join(stateDir, "runs", "damaged"), { recursive: true });
      await writeFile(join(stateDir, "runs", "damaged", "ledger.jsonl"), "not-json\n");
      const failure = await execFileAsync(builtCli, [
        "--daemon",
        "--workspace",
        root,
        "--data-dir",
        stateDir,
        "--daemon-socket",
        "/dev/null",
      ], {
        cwd: process.cwd(),
        env: { ...process.env, NAUSICAA_MODEL: "scripted" },
      }).then(
        () => undefined,
        (error: unknown) => error as { code?: number; stderr?: string },
      );
      expect(failure?.code).toBe(1);
      expect(failure?.stderr).toContain("skipped Run damaged during recovery");
      expect(failure?.stderr).toContain("control path exists and is not a Unix socket");
      const stderr = failure?.stderr ?? "";
      expect(stderr.indexOf("skipped Run damaged during recovery"))
        .toBeLessThan(stderr.indexOf("control path exists and is not a Unix socket"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a stop response before the built daemon exits and removes its socket", async () => {
    // Darwin limits sockaddr_un paths to 104 bytes; keep this real-socket
    // smoke path short even when tmpdir() expands under /var/folders.
    const root = await mkdtemp("/tmp/nausicaa-daemon-stop-");
    const stateDir = join(root, "state");
    const socketPath = join(root, "control.sock");
    const child = spawn(process.execPath, [
      builtCli,
      "--daemon",
      "--workspace",
      root,
      "--data-dir",
      stateDir,
      "--daemon-socket",
      socketPath,
    ], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, NAUSICAA_MODEL: "scripted" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    try {
      await waitForOutput(child.stdout, child, "Nausicaa daemon listening", 5_000)
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "daemon failed to start";
          throw new Error(`${message}: ${stderr || "no stderr"}`);
        });
      expect((await stat(socketPath)).isSocket()).toBe(true);

      const response = await sendControlStop(socketPath);
      expect(response).toMatchObject({
        version: 1,
        kind: "response",
        id: "smoke-stop",
        ok: true,
        result: { status: "stopped" },
      });
      await expect(waitForExit(child, 5_000)).resolves.toEqual({ code: 0, signal: null });
      expect(stderr).toBe("");
      await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await waitForExit(child, 2_000).catch(async () => {
        child.kill("SIGKILL");
        await waitForExit(child, 2_000).catch(() => undefined);
      });
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function waitForOutput(
  stream: Readable,
  child: ChildProcess,
  needle: string,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => finish(new Error(`timed out waiting for ${needle}`)), timeoutMs);
    const onData = (chunk: string | Buffer): void => {
      output += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (output.includes(needle)) finish();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`daemon exited before listening (${code ?? signal ?? "unknown"})`));
    };
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      stream.off("data", onData);
      child.off("exit", onExit);
      if (error === undefined) resolve();
      else reject(error);
    };
    stream.setEncoding("utf8");
    stream.on("data", onData);
    child.once("exit", onExit);
  });
}

async function runBuiltCli(
  args: readonly string[],
  input: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [builtCli, ...args], {
    cwd: process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(input);
  const { code } = await waitForExit(child, 5_000);
  return { code, stdout, stderr };
}

async function sendControlStop(socketPath: string): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("timed out waiting for stop response")), 3_000);
    const finish = (error?: Error, response?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error !== undefined) reject(error);
      else if (response !== undefined) resolve(response);
      else reject(new Error("stop response was missing"));
    };
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ version: 1, id: "smoke-stop", method: "stop" })}\n`);
    });
    socket.on("data", (chunk: string | Buffer) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(undefined, JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
      } catch (error: unknown) {
        finish(error instanceof Error ? error : new Error("invalid stop response"));
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      if (!settled) finish(new Error("control socket closed before stop response"));
    });
  });
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("timed out waiting for daemon exit"));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once("exit", onExit);
  });
}
