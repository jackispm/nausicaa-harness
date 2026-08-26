import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

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
    expect(stdout.trim()).toBe("0.1.0");
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

  it("prints actionable recovery metadata after a built CLI Run fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-cli-failure-"));
    try {
      const failure = await execFileAsync(builtCli, [
        "-p",
        "--main-only",
        "--model",
        "missing:model",
        "--workspace",
        root,
        "--data-dir",
        join(root, "state"),
        "fail without network access",
      ]).then(
        () => undefined,
        (error: unknown) => error as { code?: number; stderr?: string },
      );

      expect(failure?.code).toBe(1);
      expect(failure?.stderr).toContain("Run:");
      expect(failure?.stderr).toContain("State directory:");
      expect(failure?.stderr).toContain("Resume with:");
      expect(failure?.stderr).toContain("--workspace");
      expect(failure?.stderr).toContain("--data-dir");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
