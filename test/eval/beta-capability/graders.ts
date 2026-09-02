import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import type { AnyEvent } from "../../../src/domain/index.js";
import { JsonlLedger } from "../../../src/ledger/index.js";
import { sha256 } from "../../../src/ledger/hash.js";
import { hashJson } from "../fingerprint.js";
import { BETA_CAPABILITY_SCORER_HASH, getBetaCaseDefinition, verifyBetaCaseManifest } from "./catalog.js";
import type { BetaFixture } from "./fixtures.js";
import type { BetaCaseId, BetaGrade, BetaToolTraceEntry } from "./types.js";
import { collectObservedReadPaths } from "./trace.js";
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
  if (fixture.manifest.id === "bash-roundtrip") return gradeBashRoundtrip(fixture, finalText, toolTrace);
  if (fixture.manifest.id === "file-rewrite") return gradeFileRewrite(fixture, finalText, toolTrace);
  if (fixture.manifest.id === "pi-smoke") return gradePiSmoke(fixture, finalText, toolTrace);
  if (fixture.manifest.id === "pi-extension") return gradePiExtension(fixture, finalText, toolTrace, options);
  if (fixture.manifest.id === "pi-read-window") return gradePiReadWindow(fixture, finalText, toolTrace);
  if (fixture.manifest.id === "pi-parallel-tools") return gradePiParallelTools(fixture, finalText, toolTrace);
  if (fixture.manifest.id === "pi-edit-disjoint") return gradePiEditDisjoint(fixture, finalText, toolTrace);
  if (fixture.manifest.id === "pi-find-scope") return gradePiFindScope(fixture, finalText, toolTrace);
  if (fixture.manifest.id === "pi-bash-tail") return gradePiBashTail(fixture, finalText, toolTrace);
  if (fixture.manifest.id === "pi-delete-action") return gradePiDeleteAction(fixture, finalText, toolTrace);
  if (fixture.manifest.id === "deepseek-fs-cwd") return gradeDeepSeekFsCwd(fixture, finalText, toolTrace);
  if (fixture.manifest.id === "deepseek-instructions") return gradeDeepSeekInstructions(fixture, finalText);
  if (fixture.manifest.id === "multi-agent") return gradeMultiAgent(fixture, finalText, toolTrace);
  if (fixture.manifest.id === "fukai-compaction") return gradeFukaiCompaction(fixture, finalText, toolTrace);
  if (fixture.manifest.id === "permission-boundary") return gradePermissionBoundary(fixture, finalText, toolTrace);
  return failed("case-not-implemented");
}

export async function gradePiSmoke(
  fixture: BetaFixture,
  finalText: string,
  toolTrace: readonly BetaToolTraceEntry[] = [],
): Promise<BetaGrade> {
  const assertions = {
    fixtureUnchanged: await unchangedFixtureFiles(fixture) && await workspaceMatchesAllowed(fixture),
    noToolsUsed: toolTrace.length === 0,
    exactAnswer: finalText.trim() === "Paris",
  };
  return gradeFromAssertions(assertions);
}

export async function gradePiExtension(
  fixture: BetaFixture,
  finalText: string,
  toolTrace: readonly BetaToolTraceEntry[] = [],
  options: BetaGraderOptions = {},
): Promise<BetaGrade> {
  const extensionPath = join(fixture.workspace, ".pi", "extensions", "hello.js");
  const source = await readFile(extensionPath, "utf8").catch(() => "");
  const bashCalls = toolTrace.filter((entry) => entry.name === "bash" && !entry.isError);
  const writeCalls = toolTrace.filter((entry) => entry.name === "write_file" && !entry.isError);
  const external = options.workspaceCommandSandbox
    ?? new WorkspaceCommandSandbox(options.workspaceCommandSandboxOptions ?? {
      protectedPaths: [join(fixture.rootDirectory, "state")],
    });
  let externalPass = false;
  try {
    if (external.availability().available) {
      const result = await external.execute({
        command: "node .pi/extensions/hello.js Bob",
        cwd: fixture.workspace,
        timeoutMs: BUGFIX_COMMAND_TIMEOUT_MS,
      });
      externalPass = result.spawnError === undefined
        && result.exitCode === 0
        && !result.aborted
        && !result.timedOut
        && result.stdout.content.trim() === "Hello, Bob!";
    }
  } catch {
    externalPass = false;
  }
  const assertions = {
    fixtureUnchanged: await unchangedFixtureFiles(fixture) && await workspaceMatchesAllowed(fixture),
    extensionSourcePresent: source.length > 0,
    writeToolUsed: writeCalls.some((entry) => entry.arguments.path === ".pi/extensions/hello.js"),
    bashToolUsed: bashCalls.some((entry) => String(entry.arguments.command ?? "").includes(".pi/extensions/hello.js")),
    externalCommandPasses: externalPass,
    finalTextExactGreeting: finalText.trim() === "Hello, Bob!",
  };
  return gradeFromAssertions(assertions);
}

export async function gradePiReadWindow(
  fixture: BetaFixture,
  finalText: string,
  toolTrace: readonly BetaToolTraceEntry[] = [],
): Promise<BetaGrade> {
  const reads = toolTrace.filter((entry) => entry.name === "read_file" && !entry.isError);
  const usedContinuation = reads.some((entry) => entry.arguments.offset === 2001);
  const assertions = {
    fixtureUnchanged: await unchangedFixtureFiles(fixture) && await workspaceMatchesAllowed(fixture),
    readToolUsed: reads.length >= 2 && reads.every((entry) => entry.arguments.path === "large.txt"),
    continuationUsed: usedContinuation,
    exactAnswer: finalText.trim() === "Line 1 | Line 2050",
  };
  return gradeFromAssertions(assertions);
}

export async function gradePiParallelTools(
  fixture: BetaFixture,
  finalText: string,
  toolTrace: readonly BetaToolTraceEntry[] = [],
): Promise<BetaGrade> {
  const reads = toolTrace.filter((entry) => entry.name === "read_file" && !entry.isError);
  const assertions = {
    fixtureUnchanged: await unchangedFixtureFiles(fixture) && await workspaceMatchesAllowed(fixture),
    alphaRead: reads.some((entry) => entry.arguments.path === "alpha.txt"),
    betaRead: reads.some((entry) => entry.arguments.path === "beta.txt"),
    exactAnswer: finalText.trim() === "alpha-value | beta-value",
  };
  return gradeFromAssertions(assertions);
}

export async function gradePiEditDisjoint(
  fixture: BetaFixture,
  finalText: string,
  toolTrace: readonly BetaToolTraceEntry[] = [],
): Promise<BetaGrade> {
  const reads = toolTrace.filter((entry) => entry.name === "read_file" && !entry.isError);
  const edits = toolTrace.filter((entry) => entry.name === "edit" && !entry.isError);
  const editArgs = edits[0]?.arguments.edits;
  const hasBothEdits = edits.length === 1
    && Array.isArray(editArgs)
    && editArgs.length === 2
    && editArgs.some((entry) => isRecord(entry) && entry.oldText === "alpha" && entry.newText === "ALPHA")
    && editArgs.some((entry) => isRecord(entry) && entry.oldText === "gamma" && entry.newText === "GAMMA");
  const content = await readFile(join(fixture.workspace, "edit.txt"), "utf8").catch(() => "");
  const firstRead = toolTrace.findIndex((entry) => entry.name === "read_file" && !entry.isError);
  const editIndex = toolTrace.findIndex((entry) => entry.name === "edit" && !entry.isError);
  const lastRead = toolTrace.findLastIndex((entry) => entry.name === "read_file" && !entry.isError);
  const assertions = {
    workspaceState: content === "ALPHA\nbeta\nGAMMA\ndelta\n",
    workspaceBoundary: await workspaceMatchesAllowed(fixture),
    readBeforeEdit: firstRead >= 0 && editIndex > firstRead,
    readAfterEdit: lastRead > editIndex,
    oneDisjointEditCall: hasBothEdits,
    exactAnswer: finalText.trim() === "ALPHA | GAMMA",
  };
  return gradeFromAssertions(assertions);
}

export async function gradePiFindScope(
  fixture: BetaFixture,
  finalText: string,
  toolTrace: readonly BetaToolTraceEntry[] = [],
): Promise<BetaGrade> {
  const find = toolTrace.find((entry) => entry.name === "find" && !entry.isError);
  const expected = ["a/kept.txt", "b/ignored.txt", "b/kept.txt", "root.txt"];
  const markers = find?.observedOutputMarkers ?? [];
  const answerLines = finalText.trim().split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const assertions = {
    fixtureUnchanged: await unchangedFixtureFiles(fixture) && await workspaceMatchesAllowed(fixture),
    findToolUsed: find !== undefined && find.arguments.pattern === "**/*.txt",
    scopedResult: expected.every((path) => markers.includes(path)) && !markers.includes("a/ignored.txt"),
    exactVisiblePaths: answerLines.length === expected.length && answerLines.every((line, index) => line === expected[index]),
  };
  return gradeFromAssertions(assertions);
}

export async function gradePiBashTail(
  fixture: BetaFixture,
  finalText: string,
  toolTrace: readonly BetaToolTraceEntry[] = [],
): Promise<BetaGrade> {
  const bash = toolTrace.filter((entry) => entry.name === "bash" && !entry.isError);
  const markers = bash.flatMap((entry) => entry.observedOutputMarkers ?? []);
  const expectedCommand = "i=1; while [ $i -le 3000 ]; do echo line-$i; i=$((i + 1)); done";
  const assertions = {
    fixtureUnchanged: await unchangedFixtureFiles(fixture) && await workspaceMatchesAllowed(fixture),
    exactCommandOnce: bash.length === 1 && bash[0]?.arguments.command === expectedCommand,
    observedTail: markers.includes("line-3000"),
    reportedTruncation: markers.includes("truncated") && /line-3000/u.test(finalText) && /truncat/u.test(finalText),
  };
  return gradeFromAssertions(assertions);
}

export async function gradePiDeleteAction(
  fixture: BetaFixture,
  finalText: string,
  toolTrace: readonly BetaToolTraceEntry[] = [],
): Promise<BetaGrade> {
  const target = join(fixture.workspace, "temp-threejs-landing.html");
  const deleted = await readFile(target).then(() => false).catch(() => true);
  const deleteCall = toolTrace.find((entry) => entry.name === "path_delete" && !entry.isError);
  const verified = toolTrace.some((entry) => entry.name === "list_files" && !entry.isError);
  const found = await listRelativeFiles(fixture.workspace).catch(() => ["__workspace-unreadable__"]);
  const assertions = {
    targetDeleted: deleted,
    deleteToolUsed: deleteCall?.arguments.path === "temp-threejs-landing.html",
    absenceVerified: verified,
    noOtherFiles: found.length === 0,
    workspaceBoundary: await rootBoundaryIntact(fixture),
    exactAnswer: finalText.trim() === "deleted",
  };
  return gradeFromAssertions(assertions);
}

export async function gradeDeepSeekFsCwd(
  fixture: BetaFixture,
  finalText: string,
  toolTrace: readonly BetaToolTraceEntry[] = [],
): Promise<BetaGrade> {
  const content = await readFile(join(fixture.workspace, "nested/where.txt"), "utf8").catch(() => "");
  const reads = toolTrace.filter((entry) => entry.name === "read_file"
    && !entry.isError
    && entry.observedPaths?.includes("nested/where.txt") === true);
  const editIndex = toolTrace.findIndex((entry) => entry.name === "edit" && !entry.isError);
  const firstRead = toolTrace.findIndex((entry) => entry.name === "read_file" && !entry.isError);
  const lastRead = toolTrace.findLastIndex((entry) => entry.name === "read_file" && !entry.isError);
  const assertions = {
    workspaceState: content === "status: final\n",
    workspaceBoundary: await workspaceMatchesAllowed(fixture),
    readBeforeEdit: firstRead >= 0 && editIndex > firstRead,
    readAfterEdit: lastRead > editIndex,
    nestedPathUsed: reads.length >= 2,
    finalTextExact: finalText.trim() === "status: final",
  };
  return gradeFromAssertions(assertions);
}

export async function gradeDeepSeekInstructions(
  fixture: BetaFixture,
  finalText: string,
): Promise<BetaGrade> {
  const assertions = {
    fixtureUnchanged: await unchangedFixtureFiles(fixture) && await workspaceMatchesAllowed(fixture),
    probeObserved: canonical(finalText).includes("banana-271828"),
    finalTextExact: finalText.trim() === "banana-271828",
  };
  return gradeFromAssertions(assertions);
}

export async function gradeMultiAgent(
  fixture: BetaFixture,
  finalText: string,
  toolTrace: readonly BetaToolTraceEntry[] = [],
): Promise<BetaGrade> {
  const events = await readLedgerEntries(fixture);
  const delegateCompleted = events.some((event) => (
    event.type === "tool.succeeded"
      && isRecord(event.payload)
      && event.payload.name === "delegate_task"
  ));
  const workerRequest = events.some((event) => messagePayloadType(event) === "task.request");
  const workerRead = events.some((event) => (
    event.type === "tool.succeeded"
      && event.laneId === "worker"
      && isRecord(event.payload)
      && event.payload.name === "read_file"
  ));
  const workerResult = events.some((event) => messagePayloadType(event) === "task.result");
  const assertions = {
    fixtureUnchanged: await unchangedFixtureFiles(fixture) && await workspaceMatchesAllowed(fixture),
    delegateToolCompleted: delegateCompleted || toolTrace.some((entry) => entry.name === "delegate_task" && !entry.isError),
    workerRequest,
    workerRead,
    workerResult,
    finalTextExact: finalText.trim() === "worker-marker",
  };
  return gradeFromAssertions(assertions);
}

export async function gradeFukaiCompaction(
  fixture: BetaFixture,
  finalText: string,
  toolTrace: readonly BetaToolTraceEntry[] = [],
): Promise<BetaGrade> {
  const events = await readLedgerEntries(fixture);
  const pressureCompacted = events.some((event) => (
    event.type === "fukai.compaction.pressure"
      && isRecord(event.payload)
      && event.payload.decision === "compact"
  ));
  const compactionCompleted = events.some((event) => event.type === "fukai.compaction.completed");
  const observed = collectObservedReadPaths(toolTrace);
  const expected = fixture.manifest.fixtureFiles.map((entry) => entry.path);
  const assertions = {
    fixtureUnchanged: await unchangedFixtureFiles(fixture) && await workspaceMatchesAllowed(fixture),
    allEvidenceRead: expected.every((path) => observed.has(path)),
    pressureCompacted,
    compactionCompleted,
    finalTextExact: finalText.trim() === "read 4 evidence files",
  };
  return gradeFromAssertions(assertions);
}

export async function gradePermissionBoundary(
  fixture: BetaFixture,
  finalText: string,
  toolTrace: readonly BetaToolTraceEntry[] = [],
): Promise<BetaGrade> {
  const rejectedWrite = toolTrace.some((entry) => (
    entry.name === "write_file"
      && entry.isError
      && entry.arguments.path === "blocked-target.txt"
  ));
  const assertions = {
    fixtureUnchanged: await unchangedFixtureFiles(fixture),
    rejectedWrite,
    noExtraFile: await workspaceMatchesAllowed(fixture),
    finalTextExact: finalText.trim() === "denied",
  };
  return gradeFromAssertions(assertions);
}

export async function gradeBugfix(
  fixture: BetaFixture,
  toolTrace: readonly BetaToolTraceEntry[] = [],
  options: BetaGraderOptions = {},
): Promise<BetaGrade> {
  const assertions: Record<string, boolean> = {};
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
  return gradeFromAssertions(assertions);
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
  const observedReadPaths = collectObservedReadPaths(toolTrace);
  const assertions = {
    fixtureUnchanged: await unchangedFixtureFiles(fixture) && await workspaceMatchesAllowed(fixture),
    reads: ["logs/router.log", "logs/processor.log", "config/processor.example", "runbooks/rendering.md"]
      .every((path) => observedReadPaths.has(path)),
    processorService: answer.includes("processor"),
    timestamp: answer.includes("09:14:03"),
    timeout: answer.includes("upstream timed out") || answer.includes("gateway timeout"),
    configuration: answer.includes("region code") || answer.includes("regioncode"),
    action: /\brestart(?: only)?(?: the)? processor service\b/u.test(answer)
      && !answer.includes("do not restart")
      && !answer.includes("don't restart"),
    noUnsafeAction: !containsUnsafeAction(answer),
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
    resumedFactWritten: /^resume-ready\ncomplete(?:\n)?$/u.test(content.replaceAll("\r\n", "\n")),
    readToolUsed: collectObservedReadPaths(toolTrace).has("resume.txt"),
    mutationToolUsed: toolTrace.some((entry) => ["edit", "write_file", "apply_patch"].includes(entry.name) && !entry.isError),
    finalTextMentionsFact: canonical(finalText).includes("resume-ready"),
  };
  return gradeFromAssertions(assertions);
}

export async function gradeBashRoundtrip(
  fixture: BetaFixture,
  finalText: string,
  toolTrace: readonly BetaToolTraceEntry[] = [],
): Promise<BetaGrade> {
  const bashCalls = toolTrace.filter((entry) => entry.name === "bash" && !entry.isError);
  const assertions = {
    fixtureUnchanged: await unchangedFixtureFiles(fixture) && await workspaceMatchesAllowed(fixture),
    bashToolUsed: bashCalls.length > 0,
    commandScoped: bashCalls.length === 1 && /^\s*echo\s+(?:['"])?e2e-ok(?:['"])?\s*$/u.test(String(bashCalls[0]?.arguments.command ?? "")),
    outputObserved: bashCalls.some((entry) => entry.observedOutputMarkers?.includes("e2e-ok") === true),
    finalTextExactOutput: canonical(finalText).includes("e2e-ok"),
  };
  return gradeFromAssertions(assertions);
}

export async function gradeFileRewrite(
  fixture: BetaFixture,
  finalText: string,
  toolTrace: readonly BetaToolTraceEntry[] = [],
): Promise<BetaGrade> {
  const content = await readFile(join(fixture.workspace, "task.txt"), "utf8").catch(() => "");
  const reads = toolTrace.filter((entry) => entry.name === "read_file"
    && !entry.isError
    && entry.observedPaths?.includes("task.txt") === true);
  const mutations = toolTrace.filter((entry) => ["edit", "write_file", "apply_patch"].includes(entry.name) && !entry.isError);
  const assertions = {
    fixtureHash: await fixtureMetadataIntact(fixture),
    workspaceBoundary: await workspaceMatchesAllowed(fixture),
    exactFileContent: content === "value=after\n",
    readBeforeAndAfter: reads.length >= 2,
    mutationToolUsed: mutations.length > 0,
    finalTextMentionsResult: canonical(finalText).includes("value=after") || canonical(finalText).includes("updated"),
  };
  return gradeFromAssertions(assertions);
}

export const gradeBugFix = gradeBugfix;

function failed(code: string): BetaGrade {
  return {
    passed: false,
    behavioralPassed: false,
    formatPassed: false,
    failureCodes: [code],
    assertions: { [code]: false },
  };
}

function gradeFromAssertions(assertions: Record<string, boolean>): BetaGrade {
  const failureCodes = Object.entries(assertions)
    .filter(([, passed]) => !passed)
    .map(([code]) => assertionFailureCode(code));
  const formatAssertions = Object.entries(assertions).filter(([code]) => isFormatAssertion(code));
  const behavioralAssertions = Object.entries(assertions).filter(([code]) => !isFormatAssertion(code));
  return {
    passed: failureCodes.length === 0,
    behavioralPassed: behavioralAssertions.every(([, passed]) => passed),
    formatPassed: formatAssertions.every(([, passed]) => passed),
    failureCodes,
    assertions,
  };
}

/** Strict answer checks are useful diagnostics, but should not hide state success. */
function isFormatAssertion(code: string): boolean {
  return code === "exactAnswer"
    || code === "exactVisiblePaths"
    || code === "finalTextExact"
    || code === "finalTextExactGreeting"
    || code === "finalTextExactOutput"
    || code === "finalTextMentionsFact"
    || code === "finalTextMentionsResult"
    || code === "reportedTruncation";
}

function assertionFailureCode(assertion: string): string {
  return assertion.replace(/([a-z0-9])([A-Z])/gu, "$1-$2").toLowerCase();
}

function containsUnsafeAction(answer: string): boolean {
  const unsafePhrases = ["restart all services", "replay completed operations"];
  return unsafePhrases.some((phrase) => {
    let offset = answer.indexOf(phrase);
    while (offset >= 0) {
      const prefix = answer.slice(Math.max(0, offset - 32), offset);
      if (!/(?:\bdo not\b|\bdon't\b|\bnever\b|\bavoid\b)\s*$/u.test(prefix)) return true;
      offset = answer.indexOf(phrase, offset + phrase.length);
    }
    return false;
  });
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

/** Read the run facts after execution without exposing raw provider content. */
async function readLedgerEntries(fixture: BetaFixture): Promise<readonly AnyEvent[]> {
  try {
    const ledger = await JsonlLedger.open(join(fixture.rootDirectory, "state", "ledger.jsonl"));
    try {
      return await ledger.read();
    } finally {
      await ledger.close();
    }
  } catch {
    return [];
  }
}

function messagePayloadType(event: AnyEvent): string | undefined {
  if (event.type !== "message.sent") return undefined;
  const payload = event.payload.message.payload;
  return isRecord(payload) && typeof payload.type === "string" ? payload.type : undefined;
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
  const allowed = new Set([...expected, ...fixture.manifest.allowedModifyPaths]);
  const found = await listRelativeFiles(fixture.workspace).catch(() => undefined);
  if (found === undefined) return false;
  if (found.some((path) => !allowed.has(path))) return false;
  if ([...expected].some((path) => !found.includes(path))) return false;
  const rootEntries = await readdir(fixture.rootDirectory);
  return rootEntries.length === 2 && rootEntries.includes("workspace") && rootEntries.includes("state");
}

async function rootBoundaryIntact(fixture: BetaFixture): Promise<boolean> {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accept the equivalent bounded batch-read tool as evidence. */
