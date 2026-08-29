import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";

import { ShellOutputCapture, type ShellOutputSnapshot } from "./shell-output.js";

const EXIT_STDIO_GRACE_MS = 100;
const EXECUTION_MARKER_ENV = "NAUSICAA_SHELL_EXECUTION_MARKER";
const MARKER_CLEANUP_PASSES = 2;
const PROCESS_LIST_MAX_BYTES = 4 * 1024 * 1024;
const PROCESS_LIST_TIMEOUT_MS = 500;

interface ShellConfig {
  executable: string;
  arguments: string[];
  commandFromStdin?: true;
}

export interface ShellExecutionResult {
  stdout: ShellOutputSnapshot;
  stderr: ShellOutputSnapshot;
  exitCode: number | null;
  aborted: boolean;
  timedOut: boolean;
  spawnError?: Error;
}

/**
 * A started shell process for callers that need to observe it asynchronously.
 * Output capture and termination deliberately share the same bounded
 * primitives as the foreground Bash tool.
 */
export interface StartedShellProcess {
  readonly child: ChildProcess;
  readonly stdout: ShellOutputCapture;
  readonly stderr: ShellOutputCapture;
  readonly executionMarker: string;
  terminate(): void;
}

export async function executeShellCommand(input: {
  command: string;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ShellExecutionResult> {
  const stdout = new ShellOutputCapture();
  const stderr = new ShellOutputCapture();
  if (input.signal?.aborted) {
    return snapshotResult(stdout, stderr, null, true, false);
  }

  const shell = resolveShell();
  const executionMarker = randomUUID();
  return await new Promise((resolve) => {
    let child: ChildProcess;
    let timeoutId: NodeJS.Timeout | undefined;
    let timedOut = false;
    let aborted = false;
    let processGroupKillStarted = false;
    let settled = false;

    const finish = (exitCode: number | null, spawnError?: Error): void => {
      if (settled) return;
      settled = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      input.signal?.removeEventListener("abort", onAbort);
      resolve(snapshotResult(stdout, stderr, exitCode, aborted, timedOut, spawnError));
    };

    const terminate = (): void => {
      if (!processGroupKillStarted) {
        processGroupKillStarted = true;
        if (child.pid !== undefined) killProcessTree(child.pid);
      }
      // Marker scans may safely repeat after the root process exits. Reusing
      // its PID for a second process-group kill would risk terminating an
      // unrelated process.
      cleanupMarkedProcesses(executionMarker);
    };

    const onAbort = (): void => {
      if (timedOut) return;
      aborted = true;
      terminate();
    };

    try {
      const commandFromStdin = shell.commandFromStdin === true;
      child = spawn(
        shell.executable,
        commandFromStdin ? shell.arguments : [...shell.arguments, input.command],
        {
          cwd: input.cwd,
          detached: process.platform !== "win32",
          env: shellEnvironment(executionMarker),
          stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      if (commandFromStdin) {
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(input.command);
      }
    } catch (error: unknown) {
      finish(null, asError(error));
      return;
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: string) => stderr.append(chunk));

    if (input.timeoutMs !== undefined) {
      timeoutId = setTimeout(() => {
        if (aborted) return;
        timedOut = true;
        terminate();
      }, input.timeoutMs);
    }
    if (input.signal?.aborted) {
      onAbort();
    } else {
      input.signal?.addEventListener("abort", onAbort, { once: true });
    }

    void waitForChildProcess(child).then(
      (exitCode) => {
        // Background jobs are unsupported. Process groups handle the normal
        // case; the marker scan is a bounded, best-effort fallback for jobs
        // that changed their session before the shell exited.
        terminate();
        finish(exitCode);
      },
      (error: unknown) => {
        terminate();
        finish(null, asError(error));
      },
    );
  });
}

/**
 * Start a shell command without waiting for its exit.  The returned handle is
 * intentionally small: process jobs own lifecycle/status bookkeeping while
 * this module remains responsible for shell selection, bounded output and
 * process-tree cleanup.
 */
export function spawnShellCommand(input: {
  command: string;
  cwd: string;
}): StartedShellProcess {
  const stdout = new ShellOutputCapture();
  const stderr = new ShellOutputCapture();
  const shell = resolveShell();
  const executionMarker = randomUUID();
  const commandFromStdin = shell.commandFromStdin === true;
  let child: ChildProcess;
  try {
    child = spawn(
      shell.executable,
      commandFromStdin ? shell.arguments : [...shell.arguments, input.command],
      {
        cwd: input.cwd,
        detached: process.platform !== "win32",
        env: shellEnvironment(executionMarker),
        stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
  } catch (error: unknown) {
    throw asError(error);
  }
  if (commandFromStdin) {
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input.command);
  }
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => stdout.append(chunk));
  child.stderr?.on("data", (chunk: string) => stderr.append(chunk));

  let processGroupKillStarted = false;
  const terminate = (): void => {
    if (!processGroupKillStarted) {
      processGroupKillStarted = true;
      if (child.pid !== undefined) killProcessTree(child.pid);
    }
    // A command can deliberately detach a descendant from its process group;
    // the marker scan is the same bounded fallback used by foreground Bash.
    cleanupMarkedProcesses(executionMarker);
  };
  return { child, stdout, stderr, executionMarker, terminate };
}

function snapshotResult(
  stdout: ShellOutputCapture,
  stderr: ShellOutputCapture,
  exitCode: number | null,
  aborted: boolean,
  timedOut: boolean,
  spawnError?: Error,
): ShellExecutionResult {
  return {
    stdout: stdout.snapshot(),
    stderr: stderr.snapshot(),
    exitCode,
    aborted,
    timedOut,
    ...(spawnError === undefined ? {} : { spawnError }),
  };
}

// Adapted from pi-agent-core's NodeExecutionEnv so inherited stdio cannot keep
// the tool pending forever. Process cleanup is best-effort without an OS-level
// containment primitive such as a job object or cgroup.
function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let idleTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = false;
    let stderrEnded = false;

    const cleanup = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
    };
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };
    const maybeFinish = (): void => {
      if (exited && stdoutEnded && stderrEnded) finish(exitCode);
    };
    const armExitTimer = (): void => {
      if (idleTimer !== undefined) return;
      idleTimer = setTimeout(() => finish(exitCode), EXIT_STDIO_GRACE_MS);
    };
    const onStdoutEnd = (): void => {
      stdoutEnded = true;
      maybeFinish();
    };
    const onStderrEnd = (): void => {
      stderrEnded = true;
      maybeFinish();
    };
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null): void => {
      exited = true;
      exitCode = code;
      maybeFinish();
      if (!settled) armExitTimer();
    };
    const onClose = (code: number | null): void => finish(code);

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

function cleanupMarkedProcesses(marker: string): void {
  if (process.platform === "win32") return;
  for (let pass = 0; pass < MARKER_CLEANUP_PASSES; pass += 1) {
    const targets = markedProcessIds(marker);
    if (targets.length === 0) return;
    for (const pid of targets.sort((left, right) => right - left)) {
      if (pid === process.pid) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The process may already have exited.
      }
    }
  }
}

function markedProcessIds(marker: string): number[] {
  if (process.platform === "linux" && existsSync("/proc")) {
    return markedLinuxProcessIds(marker);
  }
  const processLister = processListerPath();
  return processLister === undefined ? [] : markedPsProcessIds(processLister, marker);
}

function markedLinuxProcessIds(marker: string): number[] {
  const markerEntry = Buffer.from(`${EXECUTION_MARKER_ENV}=${marker}\0`, "utf8");
  try {
    return readdirSync("/proc", { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) return [];
      const pid = Number(entry.name);
      if (!Number.isSafeInteger(pid) || pid === process.pid) return [];
      try {
        const environment = readFileSync(`/proc/${entry.name}/environ`);
        return environment.includes(markerEntry) ? [pid] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function markedPsProcessIds(executable: string, marker: string): number[] {
  try {
    const result = spawnSync(executable, ["-E", "-ww", "-axo", "pid=,command="], {
      encoding: "utf8",
      env: { LC_ALL: "C" },
      timeout: PROCESS_LIST_TIMEOUT_MS,
      maxBuffer: PROCESS_LIST_MAX_BYTES,
      windowsHide: true,
    });
    if (result.status !== 0) return [];
    const markerEntry = `${EXECUTION_MARKER_ENV}=${marker}`;
    return result.stdout.split(/\r?\n/u).flatMap((line) => {
      if (!line.includes(markerEntry)) return [];
      const match = /^\s*(\d+)\s/u.exec(line);
      if (match?.[1] === undefined) return [];
      const pid = Number(match[1]);
      return Number.isSafeInteger(pid) && pid !== process.pid ? [pid] : [];
    });
  } catch {
    return [];
  }
}

function processListerPath(): string | undefined {
  for (const candidate of ["/bin/ps", "/usr/bin/ps"]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
    } catch {
      // The process may already have exited.
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process may already have exited.
    }
  }
}

function resolveShell(): ShellConfig {
  if (process.platform !== "win32") {
    const executable = existsSync("/bin/bash") ? "/bin/bash" : findOnPath("bash");
    return executable === undefined
      ? { executable: "sh", arguments: ["-c"] }
      : { executable, arguments: ["-c"] };
  }

  const candidates = [
    process.env.ProgramFiles === undefined
      ? undefined
      : `${process.env.ProgramFiles}\\Git\\bin\\bash.exe`,
    process.env["ProgramFiles(x86)"] === undefined
      ? undefined
      : `${process.env["ProgramFiles(x86)"]}\\Git\\bin\\bash.exe`,
    findOnPath("bash.exe"),
  ];
  const executable = candidates.find((candidate) => candidate !== undefined && existsSync(candidate));
  if (executable === undefined) {
    throw new Error("No Bash executable was found");
  }
  const legacyWsl = /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/i
    .test(executable.replaceAll("/", "\\"));
  return legacyWsl
    ? { executable, arguments: ["-s"], commandFromStdin: true }
    : { executable, arguments: ["-c"] };
}

function findOnPath(executable: string): string | undefined {
  try {
    const locator = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(locator, [executable], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    const match = result.status === 0 ? result.stdout.trim().split(/\r?\n/u)[0] : undefined;
    return match === undefined || (process.platform === "win32" && !existsSync(match))
      ? undefined
      : match;
  } catch {
    return undefined;
  }
}

function shellEnvironment(executionMarker: string): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL",
    "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR",
    "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT",
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = environmentValue(key);
    if (value !== undefined) environment[key] = value;
  }
  environment[EXECUTION_MARKER_ENV] = executionMarker;
  return environment;
}

function environmentValue(key: string): string | undefined {
  if (process.platform !== "win32") return process.env[key];
  const actualKey = Object.keys(process.env).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return actualKey === undefined ? undefined : process.env[actualKey];
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Shell process failed");
}
