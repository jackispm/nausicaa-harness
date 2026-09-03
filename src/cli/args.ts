import { MAX_MAIN_OUTPUT_TOKENS } from "../domain/types.js";
import type {
  EdgeSettings,
  FukaiCompactionProviderCapability,
  FukaiCompactionSettings,
} from "../config/settings.js";

export type OutputMode = "interactive" | "print" | "json";

export type UtilityCommand = AuthCommand | ConfigCommand;

export interface AuthCommand {
  readonly kind: "auth";
  readonly action: "login" | "status" | "logout";
  readonly provider: string;
  readonly json: boolean;
}

export interface ConfigCommand {
  readonly kind: "config";
  readonly action: "set-model" | "get-model" | "path";
  readonly model?: string;
  readonly json: boolean;
}

export interface CliOptions {
  help: boolean;
  version: boolean;
  /** Print the read-only agent Awareness topology and exit. */
  topology: boolean;
  daemon: boolean;
  daemonSocket?: string;
  /** Optional executable implementing the detached worker protocol. */
  daemonWorkerCommand?: string;
  /** Arguments passed verbatim to the detached worker executable. */
  daemonWorkerArgs?: string[];
  attach?: string;
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
  /** Enable configured Mowe edge sources for this invocation. */
  edgesEnabled?: boolean;
  /** Ask the host to refresh edge sources before the next Turn. */
  refreshEdges?: boolean;
  /** Explicit edge settings assembled from CLI flags. */
  edges?: EdgeSettings;
  /** Explicit Fukai compaction declaration; parsing it never runs a provider. */
  fukaiCompaction?: FukaiCompactionSettings;
  fileArgs: string[];
  message?: string;
  command?: UtilityCommand;
}

export class CliUsageError extends Error {}

const readValue = (args: string[], index: number, flag: string): string => {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new CliUsageError(`${flag} requires a value`);
  }
  return value;
};

// Worker argv is intentionally opaque: child commands commonly need values
// beginning with "-", which are options to the child rather than Nausicaa.
const readRawValue = (args: string[], index: number, flag: string): string => {
  const value = args[index + 1];
  if (value === undefined) throw new CliUsageError(`${flag} requires a value`);
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
    topology: false,
    daemon: false,
    mode: "interactive",
    modeExplicit: false,
    continue: false,
    workspace: cwd,
    fileArgs: [],
  };
  if (args[0] === "auth" || args[0] === "config") {
    return parseUtilityCommand(args, cwd);
  }
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
      case "--topology":
        options.topology = true;
        // Awareness is a read-only inspection command. Make it usable from a
        // pipe by default while still allowing an explicit --json mode.
        if (!options.modeExplicit) {
          options.mode = "print";
          options.modeExplicit = true;
        }
        break;
      case "--daemon":
        options.daemon = true;
        break;
      case "--daemon-socket":
        options.daemonSocket = readValue(args, index, argument);
        index += 1;
        break;
      case "--daemon-worker-command":
        options.daemonWorkerCommand = readValue(args, index, argument);
        index += 1;
        break;
      case "--daemon-worker-arg":
        (options.daemonWorkerArgs ??= []).push(readRawValue(args, index, argument));
        index += 1;
        break;
      case "--attach":
        options.attach = readValue(args, index, argument);
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
      case "--edges":
        options.edgesEnabled = true;
        options.edges = { ...(options.edges ?? {}), enabled: true };
        break;
      case "--no-edges":
        options.edgesEnabled = false;
        options.edges = { ...(options.edges ?? {}), enabled: false };
        break;
      case "--refresh-edges":
        options.refreshEdges = true;
        options.edges = {
          ...(options.edges ?? {}),
          enabled: true,
          refreshOnStart: true,
        };
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
  if (options.topology && options.mode === "interactive") {
    throw new CliUsageError("--topology requires --print or --json output");
  }
  if (options.topology && (options.fileArgs.length > 0 || options.message !== undefined)) {
    throw new CliUsageError("--topology cannot be combined with a task or image input");
  }
  if (options.topology && (
    options.daemon
    || options.attach !== undefined
    || options.continue
    || options.resume !== undefined
    || options.resolveOperation !== undefined
    || options.workerEnabled !== undefined
    || options.tetoEnabled !== undefined
    || options.tetoModel !== undefined
    || options.maxSteps !== undefined
    || options.maxOutputTokens !== undefined
    || options.allowWrite !== undefined
    || options.allowShell !== undefined
    || options.allowNetwork !== undefined
    || options.edges !== undefined
    || options.fukaiCompaction !== undefined
  )) {
    throw new CliUsageError(
      "--topology cannot be combined with execution, lane, permission, or edge options",
    );
  }
  if (options.daemonSocket !== undefined && !options.daemon && options.attach === undefined) {
    throw new CliUsageError("--daemon-socket requires --daemon or --attach");
  }
  if ((options.daemonWorkerCommand !== undefined || options.daemonWorkerArgs !== undefined) && !options.daemon) {
    throw new CliUsageError("--daemon-worker-command/--daemon-worker-arg require --daemon");
  }
  if (options.daemonWorkerArgs !== undefined && options.daemonWorkerCommand === undefined) {
    throw new CliUsageError("--daemon-worker-arg requires --daemon-worker-command");
  }
  if (options.attach !== undefined && (
    options.daemon
    || options.modeExplicit
    || options.continue
    || options.resume !== undefined
    || options.resolveOperation !== undefined
    || options.tetoModel !== undefined
    || options.tetoEnabled !== undefined
    || options.workerEnabled !== undefined
    || options.daemonWorkerCommand !== undefined
    || options.daemonWorkerArgs !== undefined
    || options.maxSteps !== undefined
    || options.maxOutputTokens !== undefined
    || options.allowWrite !== undefined
    || options.allowShell !== undefined
    || options.allowNetwork !== undefined
    || options.edges !== undefined
    || options.fukaiCompaction !== undefined
    || options.topology
    || options.fileArgs.length > 0
    || options.message !== undefined
  )) {
    throw new CliUsageError(
      "--attach cannot be combined with task or execution options; it only accepts workspace, data-dir, model, and daemon-socket",
    );
  }
  if (options.daemon && (
    options.modeExplicit
    || options.continue
    || options.resume !== undefined
    || options.resolveOperation !== undefined
    || options.topology
    || options.fileArgs.length > 0
    || options.message !== undefined
  )) {
    throw new CliUsageError("--daemon cannot be combined with a task, resume, or output mode");
  }
  return options;
};

function parseUtilityCommand(args: string[], cwd: string): CliOptions {
  const kind = args[0];
  if (kind !== "auth" && kind !== "config") {
    throw new CliUsageError("Unknown utility command");
  }
  const rest = args.slice(1);
  const json = rest.includes("--json");
  const positional = rest.filter((argument) => argument !== "--json");
  if (positional.some((argument) => argument.startsWith("-"))) {
    throw new CliUsageError("Unsupported utility command option; use --json only");
  }

  let command: UtilityCommand;
  if (kind === "auth") {
    const action = positional[0];
    if (action !== "login" && action !== "status" && action !== "logout") {
      throw new CliUsageError("Usage: nausicaa auth <login|status|logout> [provider]");
    }
    const provider = positional[1] ?? "openrouter";
    if (positional.length > 2) {
      throw new CliUsageError("Usage: nausicaa auth <login|status|logout> [provider]");
    }
    command = { kind, action, provider, json };
  } else {
    const action = positional[0];
    if (action !== "set-model" && action !== "get-model" && action !== "path") {
      throw new CliUsageError("Usage: nausicaa config <set-model|get-model|path> [value]");
    }
    const model = positional[1];
    if (action === "set-model" && model === undefined) {
      throw new CliUsageError("Usage: nausicaa config set-model <provider:model>");
    }
    if (positional.length > (action === "set-model" ? 2 : 1)) {
      throw new CliUsageError(`Usage: nausicaa config ${action}${action === "set-model" ? " <provider:model>" : ""}`);
    }
    command = {
      kind,
      action,
      ...(model === undefined ? {} : { model }),
      json,
    };
  }
  return {
    help: false,
    version: false,
    topology: false,
    daemon: false,
    mode: json ? "json" : "print",
    modeExplicit: true,
    continue: false,
    workspace: cwd,
    fileArgs: [],
    command,
  };
}

export const usage = `Nausicaa 0.1

Usage:
  nausicaa [options] [@image ...] [message]
  nausicaa --daemon [options]
  nausicaa --attach <run-id> [options]
  nausicaa auth <login|status|logout> [provider]
  nausicaa config <set-model|get-model|path> [value]

Options:
  -p, --print             Run once and print the final answer; reads bounded non-TTY stdin
                          when no positional task is supplied
  --json                  Emit NDJSON events and results; uses the same stdin task rule
  --topology              Print the read-only agent Awareness topology and exit
  --daemon                Run the long-lived daemon control host
  --daemon-socket <path>  Unix JSONL control socket (default: <data-dir>/daemon/control.sock)
  --daemon-worker-command <path>
                          Opt into detached workers using an external worker protocol command
  --daemon-worker-arg <value>
                          Pass one argument to the detached worker command (repeatable)
  --attach <run-id>       Attach a read-only TUI to a daemon-owned Run
  --mode <interactive|print|json>
                          Select the output mode
  --model <provider:id>   Main model, for example openrouter:openai/gpt-5-mini
                          Or set NAUSICAA_MODEL; provider auth is not pre-verified
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
  --edges                 Enable configured Skills/MCP/plugin edge sources
  --no-edges              Disable all configured edge sources for this run
  --refresh-edges         Refresh edge sources before starting the host/Turn
  --workspace <path>      Bound tools to this workspace
  --data-dir <path>       Runtime state directory (default: .nausicaa)
  --max-steps <number>    Maximum Main model steps (default: 24)
  --max-output-tokens <number>
                          Maximum output tokens per Main call (default: 4096)
  -h, --help              Show help
  -v, --version           Show version

Commands:
  auth login [provider]   Save a provider credential through a hidden TTY prompt
  auth status [provider]  Show credential presence (never verifies over the network)
  auth logout [provider]  Remove a saved credential; environment credentials remain
  config set-model <id>   Save the user-level default model selector
  config get-model        Print the saved user-level default model
  config path             Print the user-level settings path
  Add --json to status/get-model/path for machine-readable output.

Environment:
  NAUSICAA_MODEL          Fallback model selector when settings/CLI omit model
  OPENROUTER_API_KEY      Ambient credential (a saved credential from auth login wins)
`;
