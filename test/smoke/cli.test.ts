import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("built CLI", () => {
  it("starts under plain Node and prints help without model credentials", async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["dist/cli.js", "--help"],
      { env: {} },
    );

    expect(stderr).toBe("");
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("nausicaa [options] <task>");
  });

  it("reports a stable version", async () => {
    const { stdout } = await execFileAsync(process.execPath, ["dist/cli.js", "--version"]);
    expect(stdout.trim()).toBe("0.1.0");
  });
});
