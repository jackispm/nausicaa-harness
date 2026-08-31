import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

interface PackFile {
  path: string;
}

interface PackResult {
  name: string;
  version: string;
  files: PackFile[];
}

describe("npm package surface", () => {
  it("keeps documented beta commands aligned with built CLI help", async () => {
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    const { stdout: help } = await execFileAsync(
      fileURLToPath(new URL("../../dist/cli.js", import.meta.url)),
      ["--help"],
      { env: { PATH: process.env.PATH } },
    );
    for (const command of [
      "--print",
      "--json",
      "--worker",
      "--daemon",
      "--daemon-worker-command",
      "--attach",
      "--topology",
    ]) {
      expect(readme).toContain(command);
      expect(help).toContain(command);
    }
    for (const command of [
      "/agents",
      "/permissions",
      "/plan",
      "/skills",
      "/edges",
    ]) {
      expect(readme).toContain(command);
    }
  });

  it("contains the built bin and excludes local state and private material", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as {
      name: string;
      version: string;
      private?: boolean;
      bin?: Record<string, string>;
      exports?: Record<string, unknown>;
      files?: string[];
    };

    expect(packageJson.private).toBe(true);
    expect(packageJson.bin?.nausicaa).toBe("dist/cli.js");
    expect(packageJson.exports?.["."]).toBeDefined();
    expect(packageJson.files).toEqual(
      expect.arrayContaining(["dist", "README.md", "THIRD_PARTY_NOTICES"]),
    );

    const npmCache = await mkdtemp(join(tmpdir(), "nausicaa-npm-cache-"));
    try {
      const { stdout } = await execFileAsync(
        "npm",
        ["pack", "--dry-run", "--json", "--ignore-scripts"],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            npm_config_cache: npmCache,
            npm_config_update_notifier: "false",
          },
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      const result = JSON.parse(stdout) as PackResult[];
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe(packageJson.name);
      expect(result[0]?.version).toBe(packageJson.version);

      const paths = (result[0]?.files ?? []).map((file) => file.path);
      expect(paths).toContain("dist/cli.js");
      expect(paths).toContain("README.md");
      expect(paths).toContain("THIRD_PARTY_NOTICES");
      expect(paths).not.toContain("package-lock.json");

      const forbidden = [
        ".env",
        ".env.",
        ".nausicaa/",
        ".local/",
        ".git/",
        "docs/",
        "test/",
        "node_modules/",
        "AGENTS.md",
      ];
      expect(paths.filter((path) => forbidden.some((prefix) => path === prefix || path.startsWith(prefix))))
        .toEqual([]);
    } finally {
      await rm(npmCache, { recursive: true, force: true });
    }
  });
});
