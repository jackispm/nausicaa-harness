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
  try {
    const settings = await loadSettings(workspace);
    const overrides: Settings = {
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.tetoModel === undefined ? {} : { tetoModel: options.tetoModel }),
      ...(options.tetoEnabled === undefined ? {} : { tetoEnabled: options.tetoEnabled }),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
      ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    };
    const resolvedSettings = resolveSettings(workspace, settings, overrides);
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
        policy: {
          maxMainSteps: resolvedSettings.maxSteps,
          maxModelTokens: resolvedSettings.maxModelTokens,
          tetoEnabled: resolvedSettings.tetoEnabled,
          tetoMaxOutputTokens: 200,
          tetoTokenRatio: 0.1,
        },
        signal: controller.signal,
      }, {
        ...(options.mode === "json"
          ? { onEvent: (event: AnyEvent) => writeJson(event) }
          : {}),
      });

      if (options.mode === "json") {
        writeJson({
          type: "runtime.result",
          runId: result.runId,
          completed: result.completed,
          steps: result.steps,
          usage: result.usage,
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
    const message = error instanceof Error ? error.message : "Nausicaa failed";
    process.stderr.write(`${redact(message)}\n`);
    return error instanceof SettingsError ? 2 : 1;
  }
};

const writeJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const redact = (message: string): string => message
  .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
  .replace(/\b(?:sk|sk-or-v1)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]");

process.exitCode = await main();
