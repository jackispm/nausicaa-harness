import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { RUNTIME_BUILD_ID } from "../../src/runtime/build-identity.js";

const runFile = promisify(execFile);
const script = fileURLToPath(new URL("../../scripts/write-build-identity.mjs", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nausicaa-build-identity-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "dist", "runtime"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", version: "1.0.0" }));
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  await writeFile(join(root, "dist", "cli.js"), "export const version = 1;\n");
  await writeFile(join(root, "dist", "runtime", "build-identity.js"), "export const RUNTIME_BUILD_ID = undefined;\n");
  return root;
}

async function buildFixture(root: string): Promise<string> {
  const { stdout } = await runFile(process.execPath, [script, root]);
  expect(stdout).toMatch(/^Runtime build: [a-f0-9]{12}\n$/u);
  return stdout.trim().slice("Runtime build: ".length);
}

describe("process-loaded build identity", () => {
  it("leaves source-mode identity unknown", () => {
    expect(RUNTIME_BUILD_ID).toBeUndefined();
  });

  it("hashes emitted code deterministically without hashing the generated identity itself", async () => {
    const root = await fixture();
    const first = await buildFixture(root);
    const second = await buildFixture(root);
    expect(second).toBe(first);
    const identity = await readFile(join(root, "dist", "runtime", "build-identity.js"), "utf8");
    expect(identity).toContain(`export const RUNTIME_BUILD_ID = ${JSON.stringify(first)};`);
    if (process.platform !== "win32") {
      expect((await stat(join(root, "dist", "cli.js"))).mode & 0o777).toBe(0o755);
    }

    await writeFile(join(root, "dist", "cli.js"), "export const version = 2;\n");
    expect(await buildFixture(root)).not.toBe(first);
  });

  it("includes dependency and package metadata in the artifact identity", async () => {
    const root = await fixture();
    const first = await buildFixture(root);
    await writeFile(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, revision: 2 }));
    const dependencyUpdate = await buildFixture(root);
    expect(dependencyUpdate).not.toBe(first);

    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", version: "1.1.0" }));
    expect(await buildFixture(root)).not.toBe(dependencyUpdate);
  });

  it("keeps already loaded code identity fixed after another artifact replaces the disk files", async () => {
    const root = await fixture();
    const first = await buildFixture(root);
    const probe = `
      import { execFileSync } from "node:child_process";
      import { writeFile } from "node:fs/promises";
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      const [root, script] = process.argv.slice(1);
      const url = pathToFileURL(join(root, "dist", "runtime", "build-identity.js")).href;
      const loaded = await import(url);
      await writeFile(join(root, "dist", "cli.js"), "export const version = 2;\\n");
      execFileSync(process.execPath, [script, root]);
      const importedAgain = await import(url);
      const replacement = await import(url + "?new-artifact");
      process.stdout.write(JSON.stringify({
        original: loaded.RUNTIME_BUILD_ID,
        importedAgain: importedAgain.RUNTIME_BUILD_ID,
        replacement: replacement.RUNTIME_BUILD_ID,
      }));
    `;
    const { stdout } = await runFile(process.execPath, ["--input-type=module", "--eval", probe, root, script]);
    const result: { original: string; importedAgain: string; replacement: string } = JSON.parse(stdout);
    expect(result.original).toBe(first);
    expect(result.importedAgain).toBe(first);
    expect(result.replacement).toMatch(/^[a-f0-9]{12}$/u);
    expect(result.replacement).not.toBe(first);
    expect(await buildFixture(root)).toBe(result.replacement);
  });
});
