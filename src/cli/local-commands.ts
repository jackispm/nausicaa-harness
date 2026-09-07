import { stat, readFile } from "node:fs/promises";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { VERSION } from "../version.js";
import { executeShellCommand } from "../tools/shell-process.js";

const CHANGELOG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../CHANGELOG.md");
const MAX_UPDATE_OUTPUT_BYTES = 64 * 1024;

export interface SelfUpdateProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface SelfUpdateSpec {
  command: string;
  args: readonly string[];
}

export interface SelfUpdateOptions {
  signal?: AbortSignal;
}

export type SelfUpdateExecutor = (spec: SelfUpdateSpec, options: SelfUpdateOptions) => Promise<SelfUpdateProcessResult>;
export type SelfUpdateRunner = (options?: SelfUpdateOptions) => Promise<SelfUpdateProcessResult>;

export function nausicaaSelfUpdateSpec(platform = process.platform): SelfUpdateSpec {
  return {
    command: platform === "win32" ? "npm.cmd" : "npm",
    args: ["install", "--global", "--omit=dev", "nausicaa-harness@latest"],
  };
}

export async function updateNausicaa(
  execute: SelfUpdateExecutor = executeSelfUpdateProcess,
  options: SelfUpdateOptions = {},
): Promise<SelfUpdateProcessResult> {
  options.signal?.throwIfAborted();
  const result = await execute(nausicaaSelfUpdateSpec(), options);
  options.signal?.throwIfAborted();
  if (result.exitCode === 0 && result.signal === null) return result;
  const detail = tailText(result.stderr || result.stdout).trim();
  const status = result.signal === null
    ? `exited with code ${result.exitCode ?? "unknown"}`
    : `terminated by ${result.signal}`;
  throw new Error(`Nausicaa update ${status}${detail.length === 0 ? "" : `: ${detail}`}`);
}

export async function readPackagedChangelog(path = CHANGELOG_PATH): Promise<string> {
  try {
    const markdown = await readFile(path, "utf8");
    const firstEntry = markdown.search(/^##\s+\[/mu);
    return firstEntry === -1 ? "No changelog entries found." : markdown.slice(firstEntry).trim();
  } catch {
    return "No changelog entries found.";
  }
}

export async function formatLogLocations(dataDir: string, runId?: string): Promise<string> {
  const stateDirectory = resolve(dataDir);
  const ledgerPath = runId === undefined
    ? undefined
    : join(stateDirectory, "runs", runId, "ledger.jsonl");
  const ledgerSize = ledgerPath === undefined
    ? undefined
    : await stat(ledgerPath).then((entry) => entry.size, () => undefined);
  return [
    "Logs",
    "",
    `State directory: ${stateDirectory}`,
    ...(ledgerPath === undefined
      ? ["Current Run ledger: no Run is attached"]
      : [`Current Run ledger: ${ledgerPath}${ledgerSize === undefined ? "" : ` (${(ledgerSize / 1024).toFixed(1)} KB)`}`]),
    `Daemon socket: ${join(stateDirectory, "daemon", "control.sock")}`,
    "",
    "Nausicaa does not currently persist client or daemon stderr logs. The Run ledger is the durable diagnostic record.",
  ].join("\n");
}

export function formatSuccessfulUpdate(): string {
  return `Nausicaa was updated from v${VERSION}. Restart this process to use the installed release.`;
}

async function executeSelfUpdateProcess(
  spec: SelfUpdateSpec,
  options: SelfUpdateOptions,
): Promise<SelfUpdateProcessResult> {
  // The command/arguments are host-owned constants, never user input. Reuse
  // the shell tool's bounded output, timeout, and descendant cleanup contract.
  const result = await executeShellCommand({
    command: [spec.command, ...spec.args].join(" "),
    cwd: process.cwd(),
    timeoutMs: 5 * 60_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(process.platform !== "win32" ? {} : {
      invocation: {
        executable: win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
        arguments: ["/d", "/s", "/c"],
      },
    }),
  });
  if (result.spawnError !== undefined) throw result.spawnError;
  if (result.aborted) throw new Error("Nausicaa update cancelled");
  if (result.timedOut) throw new Error("Nausicaa update timed out after 5 minutes");
  return {
    exitCode: result.exitCode,
    signal: null,
    stdout: result.stdout.content,
    stderr: result.stderr.content,
  };
}

function tailText(value: string): string {
  return Buffer.byteLength(value, "utf8") <= MAX_UPDATE_OUTPUT_BYTES
    ? value
    : Buffer.from(value, "utf8").subarray(-MAX_UPDATE_OUTPUT_BYTES).toString("utf8");
}
