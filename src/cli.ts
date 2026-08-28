#!/usr/bin/env node

import { resolve } from "node:path";

import { CliUsageError, parseCliArgs, usage } from "./cli/args.js";
import { processImageInputs } from "./cli/image-input.js";
import { runInteractive } from "./cli/interactive.js";
import {
  loadSettings,
  resolveSettings,
  SettingsError,
  type Settings,
} from "./config/index.js";
import type { AnyEvent } from "./domain/events.js";
import { DEFAULT_MAIN_OUTPUT_TOKENS } from "./domain/types.js";
import {
  executeRun,
  findLatestRunId,
  SessionController,
} from "./runtime/index.js";
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
  if (
    !options.modeExplicit
    && (!process.stdin.isTTY || !process.stdout.isTTY)
  ) {
    process.stderr.write(
      `Interactive mode requires a TTY. Use -p/--print or --json for non-TTY output.\n\n${usage}`,
    );
    return 2;
  }

  const workspace = resolve(options.workspace);
  let resolvedDataDir = resolve(workspace, options.dataDir ?? ".nausicaa");
  let resolvedModel: string | undefined;
  let resolvedMaxOutputTokens = DEFAULT_MAIN_OUTPUT_TOKENS;
  let resolvedAllowWrite = false;
  let resolvedAllowShell = false;
  let activeRunId = options.resume;
  try {
    const settings = await loadSettings(workspace);
    const overrides: Settings = {
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.tetoModel === undefined ? {} : { tetoModel: options.tetoModel }),
      ...(options.tetoEnabled === undefined ? {} : { tetoEnabled: options.tetoEnabled }),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
      ...(options.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: options.maxOutputTokens }),
      ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
      ...(options.allowWrite === undefined ? {} : { allowWrite: options.allowWrite }),
      ...(options.allowShell === undefined ? {} : { allowShell: options.allowShell }),
      ...(options.fukaiCompaction === undefined
        ? {}
        : { fukaiCompaction: options.fukaiCompaction }),
    };
    const resolvedSettings = resolveSettings(workspace, settings, overrides);
    // Keep resume semantics explicit: when neither the settings file nor the
    // CLI mentions Fukai, omit the field so a persisted Run policy wins.
    const fukaiCompaction = settings.fukaiCompaction === undefined
      && options.fukaiCompaction === undefined
      ? undefined
      : resolvedSettings.fukaiCompaction;
    resolvedDataDir = resolvedSettings.dataDir;
    resolvedModel = resolvedSettings.model;
    resolvedMaxOutputTokens = resolvedSettings.maxOutputTokens;
    resolvedAllowWrite = resolvedSettings.allowWrite;
    resolvedAllowShell = resolvedSettings.allowShell;
    const processedImages = await processImageInputs(options.fileArgs, {
      workspace,
      protectedPaths: [resolvedSettings.dataDir],
    });
    const initialMessage = combineInitialMessage(processedImages.text, options.message);
    if (options.mode === "interactive") {
      const selectedRunId = options.continue
        ? await findLatestRunId(resolvedSettings.dataDir, workspace)
        : options.resume;
      const session = await SessionController.open({
        workspace,
        dataDir: resolvedSettings.dataDir,
        model: resolvedSettings.model,
        tetoModel: resolvedSettings.tetoModel,
        ...(fukaiCompaction === undefined ? {} : { fukaiCompaction }),
        ...(options.workerEnabled === undefined
          ? {}
          : { workerEnabled: options.workerEnabled }),
        maxOutputTokens: resolvedSettings.maxOutputTokens,
        policy: {
          maxMainStepsPerActivation: resolvedSettings.maxSteps,
          maxModelTokens: resolvedSettings.maxModelTokens,
          tetoEnabled: resolvedSettings.tetoEnabled,
          tetoMaxOutputTokens: 64,
          tetoTokenRatio: 0.1,
        },
        allowWrite: resolvedSettings.allowWrite,
        allowShell: resolvedSettings.allowShell,
        ...(selectedRunId === undefined ? {} : { runId: selectedRunId }),
      });
      if (options.resolveOperation !== undefined) {
        await session.resolveOperation(options.resolveOperation);
      }
      return await runInteractive({
        session,
        ...(initialMessage === undefined ? {} : { initialMessage }),
        ...(processedImages.images.length === 0
          ? {}
          : { initialImages: processedImages.images }),
        ...(
          initialMessage === undefined
          && (options.resume !== undefined || (options.continue && selectedRunId !== undefined))
            ? { resumeOnStart: true }
            : {}
        ),
      });
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort(new Error("Interrupted by user"));
    process.once("SIGINT", abort);
    try {
      const result = await executeRun({
        workspace,
        dataDir: resolvedSettings.dataDir,
        model: resolvedSettings.model,
        tetoModel: resolvedSettings.tetoModel,
        ...(fukaiCompaction === undefined ? {} : { fukaiCompaction }),
        ...(options.workerEnabled === undefined
          ? {}
          : { workerEnabled: options.workerEnabled }),
        maxOutputTokens: resolvedSettings.maxOutputTokens,
        ...(initialMessage === undefined ? {} : { message: initialMessage }),
        ...(processedImages.images.length === 0
          ? {}
          : { images: processedImages.images }),
        ...(options.resume === undefined ? {} : { resumeRunId: options.resume }),
        ...(options.resolveOperation === undefined
          ? {}
          : { resolveOperationId: options.resolveOperation }),
        policy: {
          maxMainSteps: resolvedSettings.maxSteps,
          maxModelTokens: resolvedSettings.maxModelTokens,
          tetoEnabled: resolvedSettings.tetoEnabled,
          tetoMaxOutputTokens: 64,
          tetoTokenRatio: 0.1,
        },
        allowWrite: resolvedSettings.allowWrite,
        allowShell: resolvedSettings.allowShell,
        signal: controller.signal,
      }, {
        onEvent: (event: AnyEvent) => {
          activeRunId ??= event.runId;
          if (options.mode === "json") writeJson({ kind: "event", event });
        },
      });

      if (options.mode === "json") {
        writeJson({
          kind: "result",
          result: {
            runId: result.runId,
            completed: result.completed,
            steps: result.steps,
            usage: result.usage,
            metrics: result.metrics,
            stateDir: result.stateDir,
            ...(result.blocker === undefined ? {} : { blocker: result.blocker }),
          },
        });
      } else {
        if (result.finalText.length > 0) {
          process.stdout.write(`${result.finalText}\n`);
        }
        if (!result.completed) {
          process.stderr.write(result.blocker === "model-output-limit"
            ? `Run ${result.runId} reached the model output limit; the partial answer is preserved. Resume with --resume ${shellQuote(result.runId)}.\n`
            : `Run ${result.runId} stopped at a resumable boundary (${result.stateDir}).\n`);
        }
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
        maxOutputTokens: resolvedMaxOutputTokens,
        allowWrite: resolvedAllowWrite,
        allowShell: resolvedAllowShell,
        operationId,
      });
      if (options.mode === "json") {
        writeJson({
          kind: "error",
          error: {
            type: "runtime.recovery-required",
            runId: options.resume,
            stateDir: resolve(resolvedDataDir, "runs", options.resume),
            operationIds: error.operationIds,
            resumeCommand,
          },
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
        maxOutputTokens: resolvedMaxOutputTokens,
        allowWrite: resolvedAllowWrite,
        allowShell: resolvedAllowShell,
      });
      if (options.mode === "json") {
        writeJson({
          kind: "error",
          error: {
            type: "runtime.error",
            message,
            runId: activeRunId,
            stateDir,
            resumeCommand,
          },
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

const combineInitialMessage = (
  fileText: string,
  message: string | undefined,
): string | undefined => {
  const parts = [fileText, message?.trim() ?? ""].filter((part) => part.length > 0);
  return parts.length === 0 ? undefined : parts.join("\n");
};

interface ResumeCommandOptions {
  runId: string;
  workspace: string;
  dataDir: string;
  model?: string;
  maxOutputTokens: number;
  allowWrite: boolean;
  allowShell: boolean;
  operationId?: string;
}

const buildResumeCommand = (options: ResumeCommandOptions): string => [
  "nausicaa",
  "--workspace",
  shellQuote(options.workspace),
  "--data-dir",
  shellQuote(options.dataDir),
  ...(options.model === undefined ? [] : ["--model", shellQuote(options.model)]),
  "--max-output-tokens",
  String(options.maxOutputTokens),
  ...(options.allowWrite ? ["--allow-write"] : []),
  ...(options.allowShell ? ["--allow-shell"] : []),
  "--resume",
  shellQuote(options.runId),
  ...(options.operationId === undefined
    ? []
    : ["--resolve-operation", shellQuote(options.operationId)]),
].join(" ");

process.exitCode = await main();
