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
  mode: number;
}

interface PackResult {
  name: string;
  version: string;
  files: PackFile[];
}

const REQUIRED_PACK_FILES = [
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES",
  "dist/cli.js",
  "dist/index.js",
  "dist/index.d.ts",
  "package.json",
] as const;

const ALLOWED_PACK_PATHS = new Set<string>([
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES",
  "package.json",
]);

const ALLOWED_PACK_PREFIXES = ["dist/", "assets/"] as const;

const FORBIDDEN_PACK_PREFIXES = [
  ".env",
  ".nausicaa",
  ".local",
  ".git",
  "docs",
  "test",
  "src",
  "node_modules",
  "AGENTS.md",
  "ledger",
  "eval",
  "traces",
  "artifacts",
  "fixtures",
  "reference-repository",
  "reference-repositories",
  "reference-repo",
  "reference-repos",
  "snapshots",
  "coverage",
] as const;

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
      "/list-agents",
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
      scripts?: Record<string, string>;
      private?: boolean;
      license?: string;
      author?: string;
      repository?: { url?: string };
      homepage?: string;
      bugs?: { url?: string };
      keywords?: string[];
      bin?: Record<string, string>;
      exports?: Record<string, unknown>;
      files?: string[];
      engines?: { node?: string };
    };

    expect(packageJson.private).toBeUndefined();
    expect(packageJson.name).toBe("nausicaa-harness");
    expect(packageJson.name).toMatch(/^@[a-z0-9._-]+\/[a-z0-9._-]+$|^[a-z0-9._-]+$/u);
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.author).toBe("Dongjie Gong <jack@gieey.com>");
    expect(packageJson.repository?.url).toBe("git+https://github.com/jackispm/nausicaa-harness.git");
    expect(packageJson.homepage).toBe("https://github.com/jackispm/nausicaa-harness#readme");
    expect(packageJson.bugs?.url).toBe("https://github.com/jackispm/nausicaa-harness/issues");
    expect(packageJson.keywords).toEqual(expect.arrayContaining(["multi-lane", "multi-topology", "teto"]));
    expect(packageJson.engines?.node).toBe(">=22.19.0");
    expect(packageJson.bin?.nausicaa).toBe("dist/cli.js");
    expect(packageJson.exports?.["."]).toBeDefined();
    expect(packageJson.files).toEqual(
      expect.arrayContaining(["dist", "README.md", "THIRD_PARTY_NOTICES"]),
    );
    for (const scriptName of ["test:live", "eval:worker:live", "eval:live"]) {
      expect(packageJson.scripts?.[scriptName]).toBeDefined();
      expect(packageJson.scripts?.[scriptName]).not.toContain("--env-file");
    }

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
      for (const required of REQUIRED_PACK_FILES) {
        expect(paths).toContain(required);
      }
      const cliFile = result[0]?.files.find((file) => file.path === "dist/cli.js");
      expect(cliFile?.mode).toSatisfy((mode: unknown) =>
        typeof mode === "number" && (mode & 0o111) !== 0);
      expect(paths).not.toContain("package-lock.json");

      expect(paths.every((path) => path.length > 0 && !path.startsWith("/")))
        .toBe(true);
      expect(paths.filter((path) =>
        !ALLOWED_PACK_PATHS.has(path)
        && !ALLOWED_PACK_PREFIXES.some((prefix) => path.startsWith(prefix))))
        .toEqual([]);
      expect(paths.filter((path) => FORBIDDEN_PACK_PREFIXES.some((prefix) =>
        path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}.`))))
        .toEqual([]);
      expect(paths.some((path) =>
        (path.endsWith(".ts") && !path.endsWith(".d.ts")) || path.endsWith(".tsx")))
        .toBe(false);
    } finally {
      await rm(npmCache, { recursive: true, force: true });
    }
  });
});
