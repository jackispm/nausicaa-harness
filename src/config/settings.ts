import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
  DEFAULT_FUKAI_COMPACTION_MINIMUM_GAIN_TOKENS,
  DEFAULT_FUKAI_COMPACTION_RETAIN_RATIO,
  DEFAULT_FUKAI_COMPACTION_THRESHOLD_RATIO,
  DEFAULT_MAIN_OUTPUT_TOKENS,
  MAX_MAIN_OUTPUT_TOKENS,
} from "../domain/types.js";
import type { FukaiCompactionPolicy } from "../domain/types.js";

/** Provider implementations understood by the Fukai configuration seam. */
export type FukaiCompactionProviderCapability = FukaiCompactionPolicy["provider"];

/**
 * Explicit, opt-in compaction settings. These values describe a capability;
 * they do not construct a provider or trigger a model request by themselves.
 */
export interface FukaiCompactionSettings {
  enabled?: boolean;
  provider?: FukaiCompactionProviderCapability;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxWallClockMs?: number;
  thresholdRatio?: number;
  retainRatio?: number;
  minimumGainTokens?: number;
}

export interface ResolvedFukaiCompactionSettings extends FukaiCompactionPolicy {
  thresholdRatio: number;
  retainRatio: number;
  minimumGainTokens: number;
}

export const DEFAULT_FUKAI_COMPACTION_INPUT_TOKENS = 32_000;
export const DEFAULT_FUKAI_COMPACTION_OUTPUT_TOKENS = 4_096;
export const DEFAULT_FUKAI_COMPACTION_WALL_CLOCK_MS = 60_000;
export const MAX_FUKAI_COMPACTION_INPUT_TOKENS = 16 * 1024 * 1024;
export const MAX_FUKAI_COMPACTION_OUTPUT_TOKENS = 16 * 1024 * 1024;
export const MAX_FUKAI_COMPACTION_WALL_CLOCK_MS = 5 * 60 * 1_000;

export interface Settings {
  model?: string;
  tetoModel?: string;
  tetoEnabled?: boolean;
  maxSteps?: number;
  maxModelTokens?: number;
  maxOutputTokens?: number;
  dataDir?: string;
  allowShell?: boolean;
  allowWrite?: boolean;
  /** Enable network-backed Mowe tools (web_fetch and web_search). */
  allowNetwork?: boolean;
  fukaiCompaction?: FukaiCompactionSettings;
}

export interface ResolvedSettings {
  model: string;
  tetoModel: string;
  tetoEnabled: boolean;
  maxSteps: number;
  maxModelTokens: number;
  maxOutputTokens: number;
  dataDir: string;
  allowShell: boolean;
  allowWrite: boolean;
  allowNetwork: boolean;
  fukaiCompaction: ResolvedFukaiCompactionSettings;
}

export interface LoadSettingsOptions {
  userHome?: string;
  trustWorkspace?: boolean;
}

export class SettingsError extends Error {}

const allowedKeys = new Set<keyof Settings>([
  "model",
  "tetoModel",
  "tetoEnabled",
  "maxSteps",
  "maxModelTokens",
  "maxOutputTokens",
  "dataDir",
  "allowShell",
  "allowWrite",
  "allowNetwork",
  "fukaiCompaction",
]);

export const loadSettings = async (
  workspace: string,
  options: LoadSettingsOptions = {},
): Promise<Settings> => {
  const userHome = options.userHome ?? homedir();
  const user = await readSettingsFile(join(userHome, ".nausicaa", "settings.json"));
  if (options.trustWorkspace !== true) {
    return user;
  }
  const project = await readSettingsFile(join(workspace, ".nausicaa", "settings.json"));
  const merged = { ...user, ...project };
  if (user.fukaiCompaction !== undefined || project.fukaiCompaction !== undefined) {
    merged.fukaiCompaction = {
      ...user.fukaiCompaction,
      ...project.fukaiCompaction,
    };
  }
  return merged;
};

export const resolveSettings = (
  workspace: string,
  settings: Settings,
  overrides: Settings = {},
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedSettings => {
  const merged = { ...settings, ...overrides };
  const fukaiCompaction = resolveFukaiCompactionSettings(
    settings.fukaiCompaction,
    overrides.fukaiCompaction,
  );
  const model = merged.model ?? environment.NAUSICAA_MODEL;
  if (model === undefined || model.trim().length === 0) {
    throw new SettingsError(
      "No model configured. Pass --model or set NAUSICAA_MODEL.",
    );
  }

  const dataDir = merged.dataDir ?? ".nausicaa";
  return {
    model,
    tetoModel: merged.tetoModel ?? model,
    tetoEnabled: merged.tetoEnabled ?? true,
    maxSteps: boundedInteger(merged.maxSteps ?? 24, "maxSteps", 1, 1_000),
    maxModelTokens: boundedInteger(
      merged.maxModelTokens ?? 200_000,
      "maxModelTokens",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    maxOutputTokens: boundedInteger(
      merged.maxOutputTokens ?? DEFAULT_MAIN_OUTPUT_TOKENS,
      "maxOutputTokens",
      1,
      MAX_MAIN_OUTPUT_TOKENS,
    ),
    dataDir: isAbsolute(dataDir) ? resolve(dataDir) : resolve(workspace, dataDir),
    allowShell: merged.allowShell ?? false,
    allowWrite: merged.allowWrite ?? false,
    allowNetwork: merged.allowNetwork ?? false,
    fukaiCompaction,
  };
};

const readSettingsFile = async (path: string): Promise<Settings> => {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }
    throw new SettingsError(`Cannot read settings at ${path}`, { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error: unknown) {
    throw new SettingsError(`Invalid JSON in ${path}`, { cause: error });
  }
  if (!isRecord(value)) {
    throw new SettingsError(`Settings at ${path} must be a JSON object`);
  }

  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key as keyof Settings)) {
      throw new SettingsError(`Unknown setting ${key} in ${path}`);
    }
  }
  validateOptionalString(value.model, "model", path);
  validateOptionalString(value.tetoModel, "tetoModel", path);
  validateOptionalString(value.dataDir, "dataDir", path);
  validateOptionalBoolean(value.allowShell, "allowShell", path);
  validateOptionalBoolean(value.allowWrite, "allowWrite", path);
  validateOptionalBoolean(value.allowNetwork, "allowNetwork", path);
  validateOptionalBoolean(value.tetoEnabled, "tetoEnabled", path);
  validateOptionalInteger(value.maxSteps, "maxSteps", path);
  validateOptionalInteger(value.maxModelTokens, "maxModelTokens", path);
  validateOptionalInteger(value.maxOutputTokens, "maxOutputTokens", path);
  validateOptionalFukaiCompaction(value.fukaiCompaction, path);
  return value as Settings;
};

const resolveFukaiCompactionSettings = (
  settings: FukaiCompactionSettings | undefined,
  overrides: FukaiCompactionSettings | undefined,
): ResolvedFukaiCompactionSettings => {
  const merged = { ...settings, ...overrides };
  const enabled = merged.enabled ?? false;
  const provider = merged.provider ?? (enabled ? "pi-ai" : "none");
  if (enabled && provider === "none") {
    throw new SettingsError(
      "fukaiCompaction.enabled requires fukaiCompaction.provider to be pi-ai",
    );
  }
  const thresholdRatio = boundedRatio(
    merged.thresholdRatio ?? DEFAULT_FUKAI_COMPACTION_THRESHOLD_RATIO,
    "fukaiCompaction.thresholdRatio",
  );
  const retainRatio = boundedRatio(
    merged.retainRatio ?? DEFAULT_FUKAI_COMPACTION_RETAIN_RATIO,
    "fukaiCompaction.retainRatio",
  );
  if (retainRatio >= thresholdRatio) {
    throw new SettingsError(
      "fukaiCompaction.retainRatio must be less than thresholdRatio",
    );
  }
  return {
    enabled,
    provider,
    maxInputTokens: boundedInteger(
      merged.maxInputTokens ?? DEFAULT_FUKAI_COMPACTION_INPUT_TOKENS,
      "fukaiCompaction.maxInputTokens",
      1,
      MAX_FUKAI_COMPACTION_INPUT_TOKENS,
    ),
    maxOutputTokens: boundedInteger(
      merged.maxOutputTokens ?? DEFAULT_FUKAI_COMPACTION_OUTPUT_TOKENS,
      "fukaiCompaction.maxOutputTokens",
      1,
      MAX_FUKAI_COMPACTION_OUTPUT_TOKENS,
    ),
    maxWallClockMs: boundedInteger(
      merged.maxWallClockMs ?? DEFAULT_FUKAI_COMPACTION_WALL_CLOCK_MS,
      "fukaiCompaction.maxWallClockMs",
      1,
      MAX_FUKAI_COMPACTION_WALL_CLOCK_MS,
    ),
    thresholdRatio,
    retainRatio,
    minimumGainTokens: boundedInteger(
      merged.minimumGainTokens ?? DEFAULT_FUKAI_COMPACTION_MINIMUM_GAIN_TOKENS,
      "fukaiCompaction.minimumGainTokens",
      1,
      MAX_FUKAI_COMPACTION_INPUT_TOKENS,
    ),
  };
};

const validateOptionalFukaiCompaction = (
  value: unknown,
  path: string,
): void => {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    throw new SettingsError(`fukaiCompaction in ${path} must be a JSON object`);
  }
  const allowed = new Set([
    "enabled",
    "provider",
    "maxInputTokens",
    "maxOutputTokens",
    "maxWallClockMs",
    "thresholdRatio",
    "retainRatio",
    "minimumGainTokens",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new SettingsError(`Unknown setting fukaiCompaction.${key} in ${path}`);
    }
  }
  validateOptionalBoolean(value.enabled, "fukaiCompaction.enabled", path);
  validateOptionalFukaiProvider(value.provider, path);
  validateOptionalInteger(value.maxInputTokens, "fukaiCompaction.maxInputTokens", path);
  validateOptionalInteger(value.maxOutputTokens, "fukaiCompaction.maxOutputTokens", path);
  validateOptionalInteger(value.maxWallClockMs, "fukaiCompaction.maxWallClockMs", path);
  validateOptionalRatio(value.thresholdRatio, "fukaiCompaction.thresholdRatio", path);
  validateOptionalRatio(value.retainRatio, "fukaiCompaction.retainRatio", path);
  validateOptionalInteger(
    value.minimumGainTokens,
    "fukaiCompaction.minimumGainTokens",
    path,
  );
};

const validateOptionalFukaiProvider = (value: unknown, path: string): void => {
  if (value !== undefined && value !== "none" && value !== "pi-ai") {
    throw new SettingsError(
      `fukaiCompaction.provider in ${path} must be none or pi-ai`,
    );
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

const validateOptionalString = (
  value: unknown,
  name: string,
  path: string,
): void => {
  if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
    throw new SettingsError(`${name} in ${path} must be a non-empty string`);
  }
};

const validateOptionalBoolean = (
  value: unknown,
  name: string,
  path: string,
): void => {
  if (value !== undefined && typeof value !== "boolean") {
    throw new SettingsError(`${name} in ${path} must be a boolean`);
  }
};

const validateOptionalInteger = (
  value: unknown,
  name: string,
  path: string,
): void => {
  if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 1)) {
    throw new SettingsError(`${name} in ${path} must be a positive integer`);
  }
};

const validateOptionalRatio = (
  value: unknown,
  name: string,
  path: string,
): void => {
  if (
    value !== undefined
    && (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1)
  ) {
    throw new SettingsError(`${name} in ${path} must be between zero and one`);
  }
};

const boundedInteger = (
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SettingsError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
};

const boundedRatio = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new SettingsError(`${name} must be between zero and one`);
  }
  return value;
};
