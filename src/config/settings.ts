import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface Settings {
  model?: string;
  tetoModel?: string;
  tetoEnabled?: boolean;
  maxSteps?: number;
  maxModelTokens?: number;
  dataDir?: string;
  allowWrite?: boolean;
}

export interface ResolvedSettings {
  model: string;
  tetoModel: string;
  tetoEnabled: boolean;
  maxSteps: number;
  maxModelTokens: number;
  dataDir: string;
  allowWrite: boolean;
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
  "dataDir",
  "allowWrite",
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
  return { ...user, ...project };
};

export const resolveSettings = (
  workspace: string,
  settings: Settings,
  overrides: Settings = {},
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedSettings => {
  const merged = { ...settings, ...overrides };
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
    dataDir: isAbsolute(dataDir) ? resolve(dataDir) : resolve(workspace, dataDir),
    allowWrite: merged.allowWrite ?? false,
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
  validateOptionalBoolean(value.allowWrite, "allowWrite", path);
  validateOptionalBoolean(value.tetoEnabled, "tetoEnabled", path);
  validateOptionalInteger(value.maxSteps, "maxSteps", path);
  validateOptionalInteger(value.maxModelTokens, "maxModelTokens", path);
  return value as Settings;
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
