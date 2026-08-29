import { MAX_MAIN_OUTPUT_TOKENS } from "../domain/types.js";
import type {
  FukaiCompactionProviderCapability,
  FukaiCompactionSettings,
} from "../config/settings.js";

export type OutputMode = "interactive" | "print" | "json";

export interface CliOptions {
  help: boolean;
  version: boolean;
  daemon: boolean;
  daemonSocket?: string;
  mode: OutputMode;
  modeExplicit: boolean;
  continue: boolean;
  model?: string;
  tetoModel?: string;
  resume?: string;
  resolveOperation?: string;
  tetoEnabled?: boolean;
  workerEnabled?: boolean;
  workspace: string;
  dataDir?: string;
  maxSteps?: number;
  maxOutputTokens?: number;
  allowShell?: boolean;
  allowWrite?: boolean;
  /** Explicitly enable network-backed workspace tools. */
  allowNetwork?: boolean;
  /** Explicit Fukai compaction declaration; parsing it never runs a provider. */
  fukaiCompaction?: FukaiCompactionSettings;
  fileArgs: string[];
  message?: string;
}

export class CliUsageError extends Error {}

const readValue = (args: string[], index: number, flag: string): string => {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new CliUsageError(`${flag} requires a value`);
  }
  return value;
};

const readPositiveInteger = (
  args: string[],
  index: number,
  flag: string,
): number => {
  const value = Number(readValue(args, index, flag));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CliUsageError(`${flag} must be a positive integer`);
  }
  return value;
};

const readFukaiProvider = (
  args: string[],
  index: number,
  flag: string,
): FukaiCompactionProviderCapability => {
  const value = readValue(args, index, flag);
  if (value !== "none" && value !== "pi-ai") {
    throw new CliUsageError(`${flag} must be none or pi-ai`);
  }
  return value;
};

export const parseCliArgs = (args: string[], cwd: string): CliOptions => {
  const options: CliOptions = {
    help: false,
    version: false,
    daemon: false,
    mode: "interactive",
    modeExplicit: false,
    continue: false,
    workspace: cwd,
    fileArgs: [],
  };
  const messageParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "-v":
      case "--version":
        options.version = true;
        break;
      case "-p":
      case "--print":
        options.mode = "print";
        options.modeExplicit = true;
        break;
      case "--json":
        options.mode = "json";
        options.modeExplicit = true;
        break;
      case "--daemon":
        options.daemon = true;
        break;
      case "--daemon-socket":
        options.daemonSocket = readValue(args, index, argument);
        index += 1;
        break;
      case "--mode": {
        const mode = readValue(args, index, argument);
        if (mode !== "interactive" && mode !== "print" && mode !== "json") {
          throw new CliUsageError(`unsupported mode: ${mode}`);
        }
        options.mode = mode;
        options.modeExplicit = true;
        index += 1;
        break;
      }
      case "--model":
        options.model = readValue(args, index, argument);
        index += 1;
        break;
      case "--teto-model":
        options.tetoModel = readValue(args, index, argument);
        index += 1;
        break;
      case "--resume":
        options.resume = readValue(args, index, argument);
        index += 1;
        break;
      case "--continue":
        options.continue = true;
        break;
      case "--resolve-operation":
        options.resolveOperation = readValue(args, index, argument);
        index += 1;
        break;
      case "--main-only":
        options.tetoEnabled = false;
        break;
      case "--worker":
        options.workerEnabled = true;
        break;
      case "--fukai-compaction":
        options.fukaiCompaction = {
          ...(options.fukaiCompaction ?? {}),
          enabled: true,
        };
        break;
      case "--no-fukai-compaction":
        options.fukaiCompaction = {
          ...(options.fukaiCompaction ?? {}),
          enabled: false,
        };
        break;
      case "--fukai-provider":
        options.fukaiCompaction = {
          ...(options.fukaiCompaction ?? {}),
          provider: readFukaiProvider(args, index, argument),
        };
        index += 1;
        break;
      case "--fukai-max-input-tokens":
        options.fukaiCompaction = {
          ...(options.fukaiCompaction ?? {}),
          maxInputTokens: readPositiveInteger(args, index, argument),
        };
        index += 1;
        break;
      case "--fukai-max-output-tokens":
        options.fukaiCompaction = {
          ...(options.fukaiCompaction ?? {}),
          maxOutputTokens: readPositiveInteger(args, index, argument),
        };
        index += 1;
        break;
      case "--fukai-max-wall-clock-ms":
        options.fukaiCompaction = {
          ...(options.fukaiCompaction ?? {}),
          maxWallClockMs: readPositiveInteger(args, index, argument),
        };
        index += 1;
        break;
      case "--allow-write":
        options.allowWrite = true;
        break;
      case "--allow-shell":
        options.allowShell = true;
        break;
      case "--allow-network":
        options.allowNetwork = true;
        break;
      case "--workspace":
        options.workspace = readValue(args, index, argument);
        index += 1;
        break;
      case "--data-dir":
        options.dataDir = readValue(args, index, argument);
        index += 1;
        break;
      case "--max-steps": {
        const value = Number.parseInt(readValue(args, index, argument), 10);
        if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
          throw new CliUsageError("--max-steps must be an integer from 1 to 1000");
        }
        options.maxSteps = value;
        index += 1;
        break;
      }
      case "--max-output-tokens": {
        const value = Number(readValue(args, index, argument));
        if (!Number.isSafeInteger(value) || value < 1 || value > MAX_MAIN_OUTPUT_TOKENS) {
          throw new CliUsageError(
            `--max-output-tokens must be an integer from 1 to ${MAX_MAIN_OUTPUT_TOKENS}`,
          );
        }
        options.maxOutputTokens = value;
        index += 1;
        break;
      }
      case "--":
        messageParts.push(...args.slice(index + 1));
        index = args.length;
        break;
      default:
        if (argument?.startsWith("-")) {
          throw new CliUsageError(`unknown option: ${argument}`);
        }
        if (argument?.startsWith("@")) {
          if (argument.length === 1) {
            throw new CliUsageError("@ requires a workspace-relative image path");
          }
          options.fileArgs.push(argument.slice(1));
          break;
        }
        if (argument !== undefined) {
          messageParts.push(argument);
        }
    }
  }

  const message = messageParts.join(" ").trim();
  if (message.length > 0) {
    options.message = message;
  }
  if (options.resolveOperation !== undefined && options.resume === undefined) {
    throw new CliUsageError("--resolve-operation requires --resume");
  }
  if (options.resume !== undefined && options.continue) {
    throw new CliUsageError("--resume and --continue are mutually exclusive");
  }
  if (options.daemonSocket !== undefined && !options.daemon) {
    throw new CliUsageError("--daemon-socket requires --daemon");
  }
  if (options.daemon && (
    options.modeExplicit
    || options.continue
    || options.resume !== undefined
    || options.resolveOperation !== undefined
    || options.fileArgs.length > 0
    || options.message !== undefined
  )) {
    throw new CliUsageError("--daemon cannot be combined with a task, resume, or output mode");
  }
  return options;
};

export const usage = `Nausicaa 0.1

Usage:
  nausicaa [options] [@image ...] [message]
  nausicaa --daemon [options]

Options:
  -p, --print             Run once and print the final answer
  --json                  Emit NDJSON events and results
  --daemon                Run the long-lived daemon control host
  --daemon-socket <path>  Unix JSONL control socket (default: <data-dir>/daemon/control.sock)
  --mode <interactive|print|json>
                          Select the output mode
  --model <provider:id>   Main model, for example openrouter:openai/gpt-5-mini
  --teto-model <value>    Optional model override for the Teto lane
  --resume <run-id>       Resume an interrupted Run
  --continue              Resume the latest Run for this workspace
  --resolve-operation <id> Resolve one unknown tool operation as failed (requires --resume)
  --main-only             Disable the Teto lane for this run
  --worker                Enable the bounded Worker sub-agent lane
  --fukai-compaction      Enable activation-scoped Fukai compaction (defaults to pi-ai)
  --no-fukai-compaction   Disable Fukai compaction for this run
  --fukai-provider <none|pi-ai>
                          Select the Fukai provider capability; does not invoke it
  --fukai-max-input-tokens <number>
                          Fukai compaction input budget
  --fukai-max-output-tokens <number>
                          Fukai compaction output budget
  --fukai-max-wall-clock-ms <number>
                          Fukai compaction wall-clock budget
  --allow-write           Override settings to allow workspace writes (default)
  --allow-shell           Explicit high privilege: shell may read/write outside the workspace
  --allow-network         Allow public web fetch/search tools for this run
  --workspace <path>      Bound tools to this workspace
  --data-dir <path>       Runtime state directory (default: .nausicaa)
  --max-steps <number>    Maximum Main model steps (default: 24)
  --max-output-tokens <number>
                          Maximum output tokens per Main call (default: 4096)
  -h, --help              Show help
  -v, --version           Show version
`;
