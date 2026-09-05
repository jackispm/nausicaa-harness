import { spawn } from "node:child_process";

import { rgPath } from "@vscode/ripgrep";

const DEFAULT_TIMEOUT_MS = 30_000;
const FORCE_KILL_DELAY_MS = 3_000;
const MAX_STDERR_BYTES = 16 * 1024;

export interface RipgrepExecution {
  stdout: Buffer;
  stderr: string;
  exitCode: number | null;
  outputTruncated: boolean;
}

export function executeRipgrep(
  arguments_: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
  maxStdoutBytes: number,
): Promise<RipgrepExecution> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }

    const child = spawn(rgPath, [...arguments_], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (forceKillTimeout !== undefined) clearTimeout(forceKillTimeout);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const stop = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      if (forceKillTimeout === undefined) {
        forceKillTimeout = setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_DELAY_MS);
        forceKillTimeout.unref();
      }
    };
    const onAbort = (): void => stop();

    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (outputTruncated) return;
      const remaining = maxStdoutBytes - stdoutBytes;
      if (remaining <= 0) {
        outputTruncated = true;
        stop();
        return;
      }
      const accepted = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
      stdout.push(accepted);
      stdoutBytes += accepted.byteLength;
      if (accepted.byteLength !== chunk.byteLength) {
        outputTruncated = true;
        stop();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = MAX_STDERR_BYTES - stderrBytes;
      if (remaining <= 0) return;
      const accepted = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
      stderr.push(accepted);
      stderrBytes += accepted.byteLength;
    });
    child.on("error", (error) => {
      settle(() => reject(new Error(`Failed to start ripgrep: ${error.message}`)));
    });
    child.on("close", (exitCode) => {
      settle(() => {
        if (signal?.aborted) {
          reject(abortError(signal));
          return;
        }
        if (timedOut) {
          reject(new Error(`ripgrep timed out after ${DEFAULT_TIMEOUT_MS}ms`));
          return;
        }
        resolve({
          stdout: Buffer.concat(stdout, stdoutBytes),
          stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"),
          exitCode,
          outputTruncated,
        });
      });
    });
    timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, DEFAULT_TIMEOUT_MS);
    timeout.unref();
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}
