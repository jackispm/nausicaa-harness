export type OutputMode = "print" | "json";

export interface CliOptions {
  help: boolean;
  version: boolean;
  mode: OutputMode;
  model?: string;
  tetoModel?: string;
  resume?: string;
  tetoEnabled?: boolean;
  workspace: string;
  dataDir?: string;
  maxSteps?: number;
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
    mode: "print",
    workspace: cwd,
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
        break;
      case "--json":
        options.mode = "json";
        break;
      case "--mode": {
        const mode = readValue(args, index, argument);
        if (mode !== "print" && mode !== "json") {
          throw new CliUsageError(`unsupported mode: ${mode}`);
        }
        options.mode = mode;
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
      case "--main-only":
        options.tetoEnabled = false;
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
      case "--":
        messageParts.push(...args.slice(index + 1));
        index = args.length;
        break;
      default:
        if (argument?.startsWith("-")) {
          throw new CliUsageError(`unknown option: ${argument}`);
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
  return options;
};

export const usage = `Nausicaa 0.1

Usage:
  nausicaa [options] <task>

Options:
  -p, --print             Run once and print the final answer
  --mode <print|json>     Select human or NDJSON output
  --model <provider:id>   Main model, for example openrouter:openai/gpt-5-mini
  --teto-model <value>    Optional model override for the Teto lane
  --resume <run-id>       Resume an interrupted Run
  --main-only             Disable the Teto lane for this run
  --workspace <path>      Bound tools to this workspace
  --data-dir <path>       Runtime state directory (default: .nausicaa)
  --max-steps <number>    Maximum Main model steps (default: 24)
  -h, --help              Show help
  -v, --version           Show version
`;
