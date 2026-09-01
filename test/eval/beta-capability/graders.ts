import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { sha256 } from "../../../src/ledger/hash.js";
import { hashJson } from "../fingerprint.js";
import { BETA_CAPABILITY_SCORER_HASH, getBetaCaseDefinition, verifyBetaCaseManifest } from "./catalog.js";
import type { BetaFixture } from "./fixtures.js";
import type { BetaCaseId, BetaGrade, BetaToolTraceEntry } from "./types.js";
import {
  WorkspaceCommandSandbox,
  type WorkspaceCommandSandboxOptions,
} from "../../../src/tools/index.js";

const runFile = promisify(execFile);
const BUGFIX_COMMAND_TIMEOUT_MS = 10_000;

export interface BetaGraderOptions {
  readonly resumed?: boolean;
  /** Injection seam for offline contract tests; production uses the OS sandbox. */
  readonly workspaceCommandSandbox?: Pick<WorkspaceCommandSandbox, "availability" | "execute">;
  readonly workspaceCommandSandboxOptions?: WorkspaceCommandSandboxOptions;
}

export async function gradeBetaCase(
  fixture: BetaFixture,
  finalText: string,
  toolTrace: readonly BetaToolTraceEntry[],
  options: BetaGraderOptions = {},
): Promise<BetaGrade> {
  verifyBetaCaseManifest(fixture.manifest);
  if (fixture.manifest.graderHash !== BETA_CAPABILITY_SCORER_HASH) {
    return failed("scorer-hash-mismatch");
  }
  if (fixture.manifest.id === "bugfix") return gradeBugfix(fixture, toolTrace, options);
  if (fixture.manifest.id === "compatibility") return gradeCompatibility(fixture, finalText, toolTrace);
  if (fixture.manifest.id === "incident-triage") return gradeIncidentTriage(fixture, finalText, toolTrace);
  if (fixture.manifest.id === "resume") return gradeResume(fixture, finalText, toolTrace, options);
  return failed("case-not-implemented");
}

export async function gradeBugfix(
  fixture: BetaFixture,
  toolTrace: readonly BetaToolTraceEntry[] = [],
  options: BetaGraderOptions = {},
): Promise<BetaGrade> {
  const assertions: Record<string, boolean> = {};
  const failures: string[] = [];
  const definition = getBetaCaseDefinition("bugfix");
  assertions.manifestUnchanged = hashJson(fixture.manifest) === hashJson(definition.manifest);
  assertions.fixtureHashesMatch = await fixtureMetadataIntact(fixture)
    && await fileHash(fixture, "add.test.js") === fixture.initialHashes["add.test.js"];
  assertions.fixtureHash = fixture.fixtureHash === hashJson({ id: "bugfix", files: definition.files });
  assertions.initialFixtureFailed = await initialFixtureFails(fixture);
  assertions.testUnchanged = await fileHash(fixture, "add.test.js") === fixture.initialHashes["add.test.js"];
  assertions.finalTestPassed = await finalFixtureTestPasses(fixture, options);
  assertions.workspaceBoundary = await workspaceMatchesAllowed(fixture);
  assertions.readToolUsed = toolTrace.some((entry) => entry.name === "read_file" && !entry.isError);
  assertions.mutationToolUsed = toolTrace.some((entry) => ["edit", "write_file", "apply_patch"].includes(entry.name) && !entry.isError);
  assertions.sourcePathAllowed = definition.manifest.allowedModifyPaths.includes("add.js");
  for (const [code, passed] of Object.entries(assertions)) if (!passed) failures.push(code);
  return { passed: failures.length === 0, failureCodes: failures, assertions };
}

export async function gradeCompatibility(
  fixture: BetaFixture,
  finalText: string,
  toolTrace: readonly BetaToolTraceEntry[] = [],
): Promise<BetaGrade> {
  const answer = finalText.toLowerCase();
  const assertions = {
    fixtureUnchanged: await unchangedFixtureFiles(fixture) && await workspaceMatchesAllowed(fixture),
    readToolUsed: toolTrace.some((entry) => entry.name === "read_file" && !entry.isError),
    installCommand: answer.includes("npm install"),
    nodeRequirement: answer.includes("22.19"),
    testCommand: answer.includes("npm test"),
  };
  return gradeFromAssertions(assertions);
}

export async function gradeIncidentTriage(
  fixture: BetaFixture,
  finalText: string,
  toolTrace: readonly BetaToolTraceEntry[] = [],
): Promise<BetaGrade> {
  const answer = canonical(finalText);
  const observedReadPaths = traceReadPaths(toolTrace);
  const assertions = {
    fixtureUnchanged: await unchangedFixtureFiles(fixture) && await workspaceMatchesAllowed(fixture),
    reads: ["logs/gateway.log", "logs/payment.log", "config/payment.example", "runbooks/checkout.md"]
      .every((path) => observedReadPaths.has(path)),
    paymentService: answer.includes("payment"),
    timestamp: answer.includes("09:14:03"),
    timeout: answer.includes("upstream timed out") || answer.includes("gateway timeout"),
    configuration: answer.includes("payment region") || answer.includes("paymentregion"),
    action: /\brestart(?: only)?(?: the)? payment service\b/u.test(answer)
      && !answer.includes("do not restart")
      && !answer.includes("don't restart"),
    noUnsafeAction: !answer.includes("restart all services") && !answer.includes("retry captured charges"),
  };
  return gradeFromAssertions(assertions);
}

export async function gradeResume(
  fixture: BetaFixture,
  finalText: string,
  toolTrace: readonly BetaToolTraceEntry[] = [],
  options: { readonly resumed?: boolean } = {},
): Promise<BetaGrade> {
  const content = await readFile(join(fixture.workspace, "resume.txt"), "utf8").catch(() => "");
  const assertions = {
    fixtureHash: await fixtureMetadataIntact(fixture),
    sessionResumed: options.resumed === true,
    resumedFactWritten: content === "resume-ready\ncomplete\n",
    readToolUsed: toolTrace.some((entry) => entry.name === "read_file" && !entry.isError),
    mutationToolUsed: toolTrace.some((entry) => ["edit", "write_file"].includes(entry.name) && !entry.isError),
    finalTextMentionsFact: canonical(finalText).includes("resume-ready"),
  };
  return gradeFromAssertions(assertions);
}

export const gradeBugFix = gradeBugfix;

function failed(code: string): BetaGrade {
  return { passed: false, failureCodes: [code], assertions: { [code]: false } };
}

function gradeFromAssertions(assertions: Record<string, boolean>): BetaGrade {
  const failureCodes = Object.entries(assertions).filter(([, passed]) => !passed).map(([code]) => code);
  return { passed: failureCodes.length === 0, failureCodes, assertions };
}

async function fixtureHashesMatch(fixture: BetaFixture, only?: readonly string[]): Promise<boolean> {
  if (!await fixtureMetadataIntact(fixture)) return false;
  const paths = only ?? Object.keys(fixture.initialFiles);
  for (const path of paths) {
    if (await fileHash(fixture, path) !== fixture.initialHashes[path]) return false;
  }
  return true;
}

async function fixtureMetadataIntact(fixture: BetaFixture): Promise<boolean> {
  const canonical = getBetaCaseDefinition(fixture.id);
  if (fixture.fixtureHash !== hashJson({ id: fixture.id, files: canonical.files })) return false;
  for (const [path, content] of Object.entries(canonical.files)) {
    if (fixture.initialHashes[path] !== sha256(content) || fixture.initialFiles[path] !== content) return false;
  }
  return true;
}

async function unchangedFixtureFiles(fixture: BetaFixture): Promise<boolean> {
  if (!await fixtureMetadataIntact(fixture)) return false;
  return fixtureHashesMatch(fixture);
}

async function fileHash(fixture: BetaFixture, path: string): Promise<string | undefined> {
  return readFile(join(fixture.workspace, path)).then((value) => sha256(value)).catch(() => undefined);
}

async function commandStatus(cwd: string, args: string[]): Promise<number> {
  try {
    await runFile(process.execPath, args, {
      cwd,
      timeout: BUGFIX_COMMAND_TIMEOUT_MS,
      env: cleanFixtureEnvironment(),
      windowsHide: true,
    });
    return 0;
  } catch (error: unknown) {
    const exitCode = error !== null && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    return typeof exitCode === "number" ? exitCode : 1;
  }
}

async function finalFixtureTestPasses(
  fixture: BetaFixture,
  options: BetaGraderOptions,
): Promise<boolean> {
  const sandbox = options.workspaceCommandSandbox
    ?? new WorkspaceCommandSandbox(options.workspaceCommandSandboxOptions ?? {
      protectedPaths: [join(fixture.rootDirectory, "state")],
    });
  try {
    if (!sandbox.availability().available) return false;
    const result = await sandbox.execute({
      command: "node add.test.js",
      cwd: fixture.workspace,
      timeoutMs: BUGFIX_COMMAND_TIMEOUT_MS,
    });
    return result.spawnError === undefined
      && result.exitCode === 0
      && !result.aborted
      && !result.timedOut;
  } catch {
    // Sandbox unavailable, profile refusal, or execution failure is a failed
    // grade. Never fall back to an unrestricted host command.
    return false;
  }
}

function cleanFixtureEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    NODE_NO_WARNINGS: "1",
  };
}

async function initialFixtureFails(fixture: BetaFixture): Promise<boolean> {
  const scratch = await mkdtemp(join(tmpdir(), "nausicaa-beta-initial-"));
  try {
    for (const [path, content] of Object.entries(fixture.initialFiles)) {
      const destination = join(scratch, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content, "utf8");
    }
    return await commandStatus(scratch, ["add.test.js"]) !== 0;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function workspaceMatchesAllowed(fixture: BetaFixture): Promise<boolean> {
  const expected = new Set(Object.keys(fixture.initialFiles));
  const found = await listRelativeFiles(fixture.workspace).catch(() => undefined);
  if (found === undefined) return false;
  if (found.length !== expected.size || found.some((path) => !expected.has(path))) return false;
  const rootEntries = await readdir(fixture.rootDirectory);
  return rootEntries.length === 2 && rootEntries.includes("workspace") && rootEntries.includes("state");
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(relative(root, path).replaceAll("\\", "/"));
      else throw new Error("Workspace contains a non-regular entry");
    }
  };
  await visit(resolve(root));
  return output.sort();
}

function canonical(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
}

function normalizeWorkspacePath(value: unknown): string {
  if (typeof value !== "string") return "";
  const parts: string[] = [];
  for (const part of value.replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

/** Accept the equivalent bounded batch-read tool as evidence. */
function traceReadPaths(toolTrace: readonly BetaToolTraceEntry[]): Set<string> {
  const paths = new Set<string>();
  for (const entry of toolTrace) {
    if (entry.isError) continue;
    if (entry.name === "read_file") {
      const path = normalizeWorkspacePath(entry.arguments.path);
      if (path.length > 0) paths.add(path);
      continue;
    }
    if (entry.name !== "read_many" || !Array.isArray(entry.arguments.targets)) continue;
    for (const target of entry.arguments.targets) {
      if (target === null || typeof target !== "object" || Array.isArray(target)) continue;
      const path = normalizeWorkspacePath((target as Record<string, unknown>).path);
      if (path.length > 0) paths.add(path);
    }
  }
  return paths;
}
