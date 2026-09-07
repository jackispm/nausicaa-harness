import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const RELEASE_VERSION = "0.1.1";
const PLACEHOLDER = "__NAUSICAA_DEFAULT_VERSION__";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function renderReleaseInstaller(extension: "sh" | "ps1"): Promise<string> {
  const workflow = await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
  const command = workflow.split("\n").find((line) =>
    line.trim().startsWith("sed ") && line.includes(` install.${extension} > release/install.${extension}`));
  const expression = command?.trim().match(/^sed "([^"]+)" /u)?.[1];
  expect(expression).toBeDefined();
  const { stdout } = await execFileAsync("sed", [
    expression!.replaceAll("${version}", RELEASE_VERSION),
    fileURLToPath(new URL(`../../install.${extension}`, import.meta.url)),
  ]);
  return stdout;
}

async function runShellInstaller(script: string, override?: string): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "nausicaa-installer-test-"));
  roots.push(root);
  const bin = join(root, "bin");
  const log = join(root, "npm.log");
  await mkdir(bin);
  await writeFile(join(bin, "node"), "#!/bin/sh\nprintf 'v22.19.0\\n'\n", { mode: 0o755 });
  await writeFile(join(bin, "npm"), [
    "#!/bin/sh",
    'printf \'%s\\n\' "$*" >> "$NAUSICAA_INSTALL_TEST_LOG"',
    'if [ "$1" = view ]; then printf \'9.9.9\\n\'; fi',
    "",
  ].join("\n"), { mode: 0o755 });
  await execFileAsync("/bin/sh", ["-c", script], {
    env: {
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      NAUSICAA_INSTALL_TEST_LOG: log,
      ...(override === undefined ? {} : { NAUSICAA_VERSION: override }),
    },
  });
  return (await readFile(log, "utf8")).trim().split("\n");
}

describe.skipIf(process.platform === "win32")("release installers", () => {
  it("pins the generated shell installer without querying npm latest", async () => {
    const script = await renderReleaseInstaller("sh");
    expect(script).toContain(`default_version="${RELEASE_VERSION}"`);
    expect(await runShellInstaller(script)).toEqual([
      `install --global --omit=dev --registry https://registry.npmjs.org nausicaa-harness@${RELEASE_VERSION}`,
    ]);
  });

  it("preserves an explicit version override in the generated shell installer", async () => {
    expect(await runShellInstaller(await renderReleaseInstaller("sh"), "0.2.0")).toEqual([
      "install --global --omit=dev --registry https://registry.npmjs.org nausicaa-harness@0.2.0",
    ]);
  });

  it("queries npm latest when running the unrendered source installer", async () => {
    const script = await readFile(new URL("../../install.sh", import.meta.url), "utf8");
    expect(await runShellInstaller(script)).toEqual([
      "view nausicaa-harness version --registry https://registry.npmjs.org",
      "install --global --omit=dev --registry https://registry.npmjs.org nausicaa-harness@9.9.9",
    ]);
  });

  it("pins PowerShell's default while retaining the unrendered-placeholder comparison", async () => {
    const script = await renderReleaseInstaller("ps1");
    expect(script).toContain(`$defaultVersion = "${RELEASE_VERSION}"`);
    expect(script).toContain(`$defaultVersion -ne "${PLACEHOLDER}"`);
    expect(script.split(PLACEHOLDER)).toHaveLength(2);
  });
});
