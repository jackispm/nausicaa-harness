import { MAX_MAIN_OUTPUT_TOKENS } from "../domain/types.js";

export type OutputMode = "interactive" | "print" | "json";

export interface CliOptions {
  help: boolean;
  version: boolean;
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

export const parseCliArgs = (args: string[], cwd: string): CliOptions => {
  const options: CliOptions = {
    help: false,
    version: false,
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
      case "--allow-write":
        options.allowWrite = true;
        break;
      case "--allow-shell":
        options.allowShell = true;
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
  return options;
};

export const usage = `Nausicaa 0.1

Usage:
  nausicaa [options] [@image ...] [message]

Options:
  -p, --print             Run once and print the final answer
  --json                  Emit NDJSON events and results
  --mode <interactive|print|json>
                          Select the output mode
  --model <provider:id>   Main model, for example openrouter:openai/gpt-5-mini
  --teto-model <value>    Optional model override for the Teto lane
  --resume <run-id>       Resume an interrupted Run
  --continue              Resume the latest Run for this workspace
  --resolve-operation <id> Resolve one unknown tool operation as failed (requires --resume)
  --main-only             Disable the Teto lane for this run
  --worker                Enable the bounded Worker sub-agent lane
  --allow-write           Allow workspace file writes for this run
  --allow-shell           Explicit high privilege: shell may read/write outside the workspace
  --workspace <path>      Bound tools to this workspace
  --data-dir <path>       Runtime state directory (default: .nausicaa)
  --max-steps <number>    Maximum Main model steps (default: 24)
  --max-output-tokens <number>
                          Maximum output tokens per Main call (default: 4096)
  -h, --help              Show help
  -v, --version           Show version
`;
