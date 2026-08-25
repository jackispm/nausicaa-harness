#!/usr/bin/env node

import { resolve } from "node:path";

import { CliUsageError, parseCliArgs, usage } from "./cli/args.js";
import {
  loadSettings,
  resolveSettings,
  SettingsError,
  type Settings,
} from "./config/index.js";
import type { AnyEvent } from "./domain/events.js";
import { executeRun } from "./runtime/index.js";
import {
  persistedErrorText,
  stringifyRedactedJson,
} from "./runtime/redaction.js";
import { UnknownToolOperationError } from "./runtime/recovery.js";

const VERSION = "0.1.0";

const main = async (): Promise<number> => {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2), process.cwd());
  } catch (error: unknown) {
    if (error instanceof CliUsageError) {
      process.stderr.write(`${error.message}\n\n${usage}`);
      return 2;
    }
    throw error;
  }

  if (options.help) {
    process.stdout.write(usage);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (options.message === undefined && options.resume === undefined) {
    process.stderr.write(`A task or --resume is required.\n\n${usage}`);
    return 2;
  }

  const workspace = resolve(options.workspace);
  let resolvedDataDir = resolve(workspace, options.dataDir ?? ".nausicaa");
  let resolvedModel: string | undefined;
  let resolvedAllowWrite = false;
  let activeRunId = options.resume;
  try {
    const settings = await loadSettings(workspace);
    const overrides: Settings = {
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.tetoModel === undefined ? {} : { tetoModel: options.tetoModel }),
      ...(options.tetoEnabled === undefined ? {} : { tetoEnabled: options.tetoEnabled }),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
      ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
      ...(options.allowWrite === undefined ? {} : { allowWrite: options.allowWrite }),
    };
    const resolvedSettings = resolveSettings(workspace, settings, overrides);
    resolvedDataDir = resolvedSettings.dataDir;
    resolvedModel = resolvedSettings.model;
    resolvedAllowWrite = resolvedSettings.allowWrite;
    const controller = new AbortController();
    const abort = (): void => controller.abort(new Error("Interrupted by user"));
    process.once("SIGINT", abort);
    try {
      const result = await executeRun({
        workspace,
        dataDir: resolvedSettings.dataDir,
        model: resolvedSettings.model,
        tetoModel: resolvedSettings.tetoModel,
        ...(options.message === undefined ? {} : { message: options.message }),
        ...(options.resume === undefined ? {} : { resumeRunId: options.resume }),
        ...(options.resolveOperation === undefined
          ? {}
          : { resolveOperationId: options.resolveOperation }),
        policy: {
          maxMainSteps: resolvedSettings.maxSteps,
          maxModelTokens: resolvedSettings.maxModelTokens,
          tetoEnabled: resolvedSettings.tetoEnabled,
          tetoMaxOutputTokens: 200,
          tetoTokenRatio: 0.1,
        },
        allowWrite: resolvedSettings.allowWrite,
        signal: controller.signal,
      }, {
        onEvent: (event: AnyEvent) => {
          activeRunId ??= event.runId;
          if (options.mode === "json") writeJson(event);
        },
      });

      if (options.mode === "json") {
        writeJson({
          type: "runtime.result",
          runId: result.runId,
          completed: result.completed,
          steps: result.steps,
          usage: result.usage,
          metrics: result.metrics,
          stateDir: result.stateDir,
        });
      } else if (result.finalText.length > 0) {
        process.stdout.write(`${result.finalText}\n`);
      } else {
        process.stderr.write(
          `Run ${result.runId} stopped at a resumable boundary (${result.stateDir}).\n`,
        );
      }
      return result.completed ? 0 : 3;
    } finally {
      process.removeListener("SIGINT", abort);
    }
  } catch (error: unknown) {
    if (error instanceof UnknownToolOperationError && options.resume !== undefined) {
      const operationId = error.operationIds[0] ?? "<operation-id>";
      const resumeCommand = buildResumeCommand({
        runId: options.resume,
        workspace,
        dataDir: resolvedDataDir,
        ...(resolvedModel === undefined ? {} : { model: resolvedModel }),
        allowWrite: resolvedAllowWrite,
        operationId,
      });
      if (options.mode === "json") {
        writeJson({
          type: "runtime.recovery-required",
          runId: options.resume,
          stateDir: resolve(resolvedDataDir, "runs", options.resume),
          operationIds: error.operationIds,
          resumeCommand,
        });
      } else {
        process.stderr.write(
          `${error.message}\nState directory: ${resolve(resolvedDataDir, "runs", options.resume)}\n` +
          `Resolve and resume with:\n  ${resumeCommand}\n`,
        );
      }
      return 3;
    }
    const message = persistedErrorText(error, "Nausicaa failed");
    if (activeRunId !== undefined) {
      const stateDir = resolve(resolvedDataDir, "runs", activeRunId);
      const resumeCommand = buildResumeCommand({
        runId: activeRunId,
        workspace,
        dataDir: resolvedDataDir,
        ...(resolvedModel === undefined ? {} : { model: resolvedModel }),
        allowWrite: resolvedAllowWrite,
      });
      if (options.mode === "json") {
        writeJson({
          type: "runtime.error",
          error: message,
          runId: activeRunId,
          stateDir,
          resumeCommand,
        });
      } else {
        process.stderr.write(
          `${message}\nRun: ${activeRunId}\nState directory: ${stateDir}\n` +
          `Resume with:\n  ${resumeCommand}\n`,
        );
      }
    } else {
      process.stderr.write(`${message}\n`);
    }
    return error instanceof SettingsError ? 2 : 1;
  }
};

const writeJson = (value: unknown): void => {
  process.stdout.write(`${stringifyRedactedJson(value)}\n`);
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

interface ResumeCommandOptions {
  runId: string;
  workspace: string;
  dataDir: string;
  model?: string;
  allowWrite: boolean;
  operationId?: string;
}

const buildResumeCommand = (options: ResumeCommandOptions): string => [
  "nausicaa",
  "--workspace",
  shellQuote(options.workspace),
  "--data-dir",
  shellQuote(options.dataDir),
  ...(options.model === undefined ? [] : ["--model", shellQuote(options.model)]),
  ...(options.allowWrite ? ["--allow-write"] : []),
  "--resume",
  shellQuote(options.runId),
  ...(options.operationId === undefined
    ? []
    : ["--resolve-operation", shellQuote(options.operationId)]),
].join(" ");

process.exitCode = await main();
