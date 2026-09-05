import { stat } from "node:fs/promises";

import type { AgentTool, ToolResult } from "../domain/ports.js";
import type { ShellOutputSink } from "./shell-output.js";
import { executeShellCommand, type ShellExecutionResult } from "./shell-process.js";
import { diagnosePermissionFailure } from "./permission-diagnostics.js";

export type { ShellOutputSink } from "./shell-output.js";

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1_000;

export interface BashCommandExecutionInput {
  command: string;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Optional host-owned observers for complete, sanitized output streams. */
  outputSink?: ShellOutputSink;
}

/** Narrow execution seam for an OS sandbox or another host-owned backend. */
export type BashCommandExecutor = (
  input: BashCommandExecutionInput,
) => Promise<ShellExecutionResult>;

export interface BashToolOptions {
  /** Defaults to the existing unrestricted host-shell executor. */
  commandExecutor?: BashCommandExecutor;
  /** Optional host-owned observers for complete, sanitized output streams. */
  outputSink?: ShellOutputSink;
}

export function createBashTool(options: BashToolOptions = {}): AgentTool {
  const commandExecutor = options.commandExecutor ?? executeShellCommand;
  return {
    definition: {
      name: "bash",
      description: [
        "Execute a Bash command with the working directory fixed to the current workspace.",
        "The command is interpreted by Bash, including variables, pipes, redirects, and command substitution.",
        "This privileged tool follows the active host permission profile; an interactive TUI can request a wider boundary when execution is denied.",
        "Stdout and stderr retain only their bounded tails.",
        "Workspace sandbox mode protects Git metadata; use the read-only git_* tools for inspection and full-access for repository writes.",
        "Background jobs are unsupported; where OS-level process containment is unavailable, cleanup is best-effort.",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Bash source to execute" },
          timeout: {
            type: "number",
            exclusiveMinimum: 0,
            maximum: MAX_TIMEOUT_SECONDS,
            description: "Optional timeout in seconds; there is no default timeout",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },

    async execute(arguments_, context): Promise<ToolResult> {
      try {
        const command = requiredCommand(arguments_.command);
        const timeout = optionalTimeout(arguments_.timeout);
        if (context.signal?.aborted) {
          return failure({
            error: "Command aborted",
            exitCode: null,
            aborted: true,
            timedOut: false,
            ...emptyOutput(),
          });
        }
        const workspaceStat = await stat(context.workspace);
        if (!workspaceStat.isDirectory()) {
          return failure({ error: "Workspace is not a directory" });
        }

        const execution = await commandExecutor({
          command,
          cwd: context.workspace,
          ...(timeout === undefined ? {} : { timeoutMs: timeout * 1_000 }),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          ...(options.outputSink === undefined ? {} : { outputSink: options.outputSink }),
        });
        return formatResult(execution, timeout, command);
      } catch (error: unknown) {
        const diagnostic = diagnosePermissionFailure({ error });
        return failure({
          error: safeMessage(error),
          ...(diagnostic === undefined ? {} : { diagnostic }),
        });
      }
    },
  };
}

export const bashTool: AgentTool = createBashTool();

function formatResult(
  execution: ShellExecutionResult,
  timeout: number | undefined,
  command: string,
): ToolResult {
  const diagnostic = diagnosePermissionFailure({
    command,
    error: execution.spawnError,
    stderr: execution.stderr.content,
  });
  const output = {
    stdout: execution.stdout.content,
    stderr: execution.stderr.content,
    exitCode: execution.exitCode,
    aborted: execution.aborted,
    timedOut: execution.timedOut,
    ...(diagnostic === undefined ? {} : { diagnostic }),
    truncated: execution.stdout.truncated || execution.stderr.truncated,
    ...(execution.stdout.outputSinkError === undefined && execution.stderr.outputSinkError === undefined
      ? {}
      : {
          outputSinkError: execution.stdout.outputSinkError ?? execution.stderr.outputSinkError,
        }),
    truncation: {
      stdout: truncationMetadata(execution.stdout),
      stderr: truncationMetadata(execution.stderr),
    },
  };

  if (execution.spawnError !== undefined) {
    return failure({ ...output, error: execution.spawnError.message });
  }
  if (execution.aborted) {
    return failure({ ...output, error: "Command aborted" });
  }
  if (execution.timedOut) {
    return failure({ ...output, error: `Command timed out after ${timeout} seconds` });
  }
  if (execution.exitCode !== 0) {
    return failure({ ...output, error: `Command exited with code ${execution.exitCode}` });
  }
  return success(output);
}

function truncationMetadata(snapshot: ShellExecutionResult["stdout"]): {
  truncated: boolean;
  truncatedBy: "bytes" | "lines" | null;
  totalBytes: number;
  totalLines: number;
  outputBytes: number;
  outputLines: number;
} {
  return {
    truncated: snapshot.truncated,
    truncatedBy: snapshot.truncatedBy,
    totalBytes: snapshot.totalBytes,
    totalLines: snapshot.totalLines,
    outputBytes: snapshot.outputBytes,
    outputLines: snapshot.outputLines,
  };
}

function emptyOutput(): object {
  const stream = {
    truncated: false,
    truncatedBy: null,
    totalBytes: 0,
    totalLines: 0,
    outputBytes: 0,
    outputLines: 0,
  };
  return {
    stdout: "",
    stderr: "",
    truncated: false,
    truncation: { stdout: stream, stderr: stream },
  };
}

function requiredCommand(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("command must be a non-empty string");
  }
  return value;
}

function optionalTimeout(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError("timeout must be a finite number greater than zero");
  }
  if (value > MAX_TIMEOUT_SECONDS) {
    throw new TypeError(`timeout must not exceed ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return value;
}

function success(value: unknown): ToolResult {
  return { content: JSON.stringify(value), isError: false };
}

function failure(value: unknown): ToolResult {
  return { content: JSON.stringify(value), isError: true };
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Command execution failed";
}
