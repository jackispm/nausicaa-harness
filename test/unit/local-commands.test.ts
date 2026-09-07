import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  formatLogLocations,
  nausicaaSelfUpdateSpec,
  readPackagedChangelog,
  updateNausicaa,
} from "../../src/cli/local-commands.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local interactive commands", () => {
  it("builds and executes the fixed published npm self-update", async () => {
    expect(nausicaaSelfUpdateSpec("darwin")).toEqual({
      command: "npm",
      args: ["install", "--global", "--omit=dev", "nausicaa-harness@latest"],
    });
    expect(nausicaaSelfUpdateSpec("win32").command).toBe("npm.cmd");

    const seen: Array<{ command: string; args: readonly string[] }> = [];
    await expect(updateNausicaa(async (spec) => {
      seen.push(spec);
      return { exitCode: 0, signal: null, stdout: "updated", stderr: "" };
    })).resolves.toMatchObject({ exitCode: 0 });
    expect(seen).toEqual([nausicaaSelfUpdateSpec()]);
  });

  it("does not start a cancelled update and passes cancellation to the executor", async () => {
    const controller = new AbortController();
    let calls = 0;
    const execute = async (_spec: unknown, options: { signal?: AbortSignal }) => {
      calls += 1;
      expect(options.signal).toBe(controller.signal);
      controller.abort(new Error("cancel update"));
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    };
    await expect(updateNausicaa(execute, { signal: controller.signal })).rejects.toThrow("cancel update");
    await expect(updateNausicaa(execute, { signal: controller.signal })).rejects.toThrow("cancel update");
    expect(calls).toBe(1);
  });

  it("reports update process failures with bounded command output", async () => {
    await expect(updateNausicaa(async () => ({
      exitCode: 7,
      signal: null,
      stdout: "",
      stderr: "registry unavailable",
    }))).rejects.toThrow("Nausicaa update exited with code 7: registry unavailable");
  });

  it("reads version entries and degrades cleanly when a changelog is absent", async () => {
    const root = await temporaryRoot("nausicaa-changelog-");
    const path = join(root, "CHANGELOG.md");
    await writeFile(path, "# Changelog\n\nIntro.\n\n## [1.2.3]\n\n- Fixed it.\n", "utf8");
    await expect(readPackagedChangelog(path)).resolves.toBe("## [1.2.3]\n\n- Fixed it.");
    await expect(readPackagedChangelog(join(root, "missing.md"))).resolves.toBe("No changelog entries found.");
  });

  it("reports the durable ledger and the absence of persisted process logs", async () => {
    const root = await temporaryRoot("nausicaa-logs-");
    const ledger = join(root, "runs", "run-1", "ledger.jsonl");
    await mkdir(join(root, "runs", "run-1"), { recursive: true });
    await writeFile(ledger, "{}\n", "utf8");
    const report = await formatLogLocations(root, "run-1");
    expect(report).toContain(`Current Run ledger: ${ledger}`);
    expect(report).toContain(join(root, "daemon", "control.sock"));
    expect(report).toContain("does not currently persist client or daemon stderr logs");
  });
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
