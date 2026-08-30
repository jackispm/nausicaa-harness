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
import type { MoweEffect, MoweToolScope } from "../mowe/types.js";

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

/** External capability sources are declarations only; adapters own loading. */
export type EdgeSourceType = "skill" | "mcp" | "plugin";

export interface EdgeSourceSettings {
  /** Stable identity used in provenance and diagnostics. */
  sourceId: string;
  type: EdgeSourceType;
  /** Filesystem path or URI for a skill/plugin source. */
  location?: string;
  /** Executable used by an MCP stdio source. */
  command?: string;
  args?: readonly string[];
  enabled?: boolean;
}

/** Explicit host authorization for one configured edge source. */
export interface EdgeHostGrantSettings {
  sourceId: string;
  effects: readonly MoweEffect[];
  scopes: readonly MoweToolScope[];
  allowWithoutApproval?: boolean;
}

export interface EdgeSettings {
  /** Edge loading is opt-in; disabled sources never enter a Turn snapshot. */
  enabled?: boolean;
  /** Refresh at host startup; explicit refresh remains a runtime concern. */
  refreshOnStart?: boolean;
  /** Maximum time spent in one startup/explicit edge refresh. */
  refreshTimeoutMs?: number;
  sources?: readonly EdgeSourceSettings[];
  /** Declarations and grants remain separate host-owned fields. */
  grants?: readonly EdgeHostGrantSettings[];
}

export interface ResolvedEdgeSettings {
  enabled: boolean;
  refreshOnStart: boolean;
  refreshTimeoutMs: number;
  sources: readonly EdgeSourceSettings[];
  grants: readonly EdgeHostGrantSettings[];
}

export const DEFAULT_EDGE_REFRESH_TIMEOUT_MS = 60_000;
export const MAX_EDGE_REFRESH_TIMEOUT_MS = 15 * 60_000;
export const MAX_EDGE_SOURCES = 128;
export const MAX_EDGE_GRANTS = 128;
export const MAX_EDGE_ARGS = 64;
export const MAX_EDGE_STRING_BYTES = 4 * 1024;
export const MAX_EDGE_ID_BYTES = 256;

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
  edges?: EdgeSettings;
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
  edges: ResolvedEdgeSettings;
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
  "edges",
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
  if (user.edges !== undefined || project.edges !== undefined) {
    merged.edges = {
      ...user.edges,
      ...project.edges,
      ...(user.edges?.sources !== undefined && project.edges?.sources === undefined
        ? { sources: user.edges.sources }
        : {}),
      ...(user.edges?.grants !== undefined && project.edges?.grants === undefined
        ? { grants: user.edges.grants }
        : {}),
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
  const edges = resolveEdgeSettings(settings.edges, overrides.edges);
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
    // Match the mature coding-agent baseline: edits inside the workspace are
    // available by default, while unsandboxed shell and network stay off.
    allowWrite: merged.allowWrite ?? true,
    allowNetwork: merged.allowNetwork ?? false,
    edges,
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
  validateOptionalEdges(value.edges, path);
  validateOptionalBoolean(value.tetoEnabled, "tetoEnabled", path);
  validateOptionalInteger(value.maxSteps, "maxSteps", path);
  validateOptionalInteger(value.maxModelTokens, "maxModelTokens", path);
  validateOptionalInteger(value.maxOutputTokens, "maxOutputTokens", path);
  validateOptionalFukaiCompaction(value.fukaiCompaction, path);
  return value as Settings;
};

export const resolveEdgeSettings = (
  settings: EdgeSettings | undefined,
  overrides: EdgeSettings | undefined,
): ResolvedEdgeSettings => {
  if (settings !== undefined) validateOptionalEdges(settings, "settings");
  if (overrides !== undefined) validateOptionalEdges(overrides, "overrides");
  const merged = { ...settings, ...overrides };
  const refreshTimeoutMs = boundedInteger(
    merged.refreshTimeoutMs ?? DEFAULT_EDGE_REFRESH_TIMEOUT_MS,
    "edges.refreshTimeoutMs",
    1,
    MAX_EDGE_REFRESH_TIMEOUT_MS,
  );
  const sources = [...(merged.sources ?? [])].map((source) => ({
    ...source,
    ...(source.args === undefined ? {} : { args: Object.freeze([...source.args]) }),
  }));
  return {
    enabled: merged.enabled ?? false,
    refreshOnStart: merged.refreshOnStart ?? false,
    refreshTimeoutMs,
    sources: Object.freeze(sources.map((source) => Object.freeze(source))),
    grants: Object.freeze((merged.grants ?? []).map((grant) => Object.freeze({
      ...grant,
      effects: Object.freeze([...grant.effects]),
      scopes: Object.freeze([...grant.scopes]),
    }))),
  };
};

const validateOptionalEdges = (value: unknown, path: string): void => {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new SettingsError(`edges in ${path} must be a JSON object`);
  }
  const allowed = new Set(["enabled", "refreshOnStart", "refreshTimeoutMs", "sources", "grants"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new SettingsError(`Unknown setting edges.${key} in ${path}`);
    }
  }
  validateOptionalBoolean(value.enabled, "edges.enabled", path);
  validateOptionalBoolean(value.refreshOnStart, "edges.refreshOnStart", path);
  validateOptionalInteger(value.refreshTimeoutMs, "edges.refreshTimeoutMs", path);
  if (typeof value.refreshTimeoutMs === "number"
    && (value.refreshTimeoutMs < 1 || value.refreshTimeoutMs > MAX_EDGE_REFRESH_TIMEOUT_MS)) {
    throw new SettingsError(`edges.refreshTimeoutMs in ${path} must be between 1 and ${MAX_EDGE_REFRESH_TIMEOUT_MS}`);
  }
  if (value.sources === undefined) {
    validateOptionalEdgeGrants(value.grants, path);
    return;
  }
  if (!Array.isArray(value.sources)) {
    throw new SettingsError(`edges.sources in ${path} must be an array`);
  }
  if (value.sources.length > MAX_EDGE_SOURCES) {
    throw new SettingsError(`edges.sources in ${path} exceeds ${MAX_EDGE_SOURCES} entries`);
  }
  const seen = new Set<string>();
  for (const [index, candidate] of value.sources.entries()) {
    const sourcePath = `edges.sources[${index}] in ${path}`;
    if (!isRecord(candidate)) {
      throw new SettingsError(`${sourcePath} must be a JSON object`);
    }
    const sourceAllowed = new Set([
      "sourceId",
      "type",
      "location",
      "command",
      "args",
      "enabled",
    ]);
    for (const key of Object.keys(candidate)) {
      if (!sourceAllowed.has(key)) {
        throw new SettingsError(`Unknown setting ${sourcePath}.${key}`);
      }
    }
    validateOptionalString(candidate.sourceId, `${sourcePath}.sourceId`, path);
    validateOptionalString(candidate.type, `${sourcePath}.type`, path);
    if (candidate.sourceId === undefined || typeof candidate.sourceId !== "string") {
      throw new SettingsError(`${sourcePath}.sourceId is required`);
    }
    validateEdgeId(candidate.sourceId, `${sourcePath}.sourceId`, path);
    if (seen.has(candidate.sourceId)) {
      throw new SettingsError(`Duplicate edge sourceId ${candidate.sourceId} in ${path}`);
    }
    seen.add(candidate.sourceId);
    if (candidate.type !== "skill" && candidate.type !== "mcp" && candidate.type !== "plugin") {
      throw new SettingsError(`${sourcePath}.type must be skill, mcp, or plugin`);
    }
    validateOptionalString(candidate.location, `${sourcePath}.location`, path);
    validateOptionalString(candidate.command, `${sourcePath}.command`, path);
    const location = typeof candidate.location === "string" ? candidate.location : undefined;
    const command = typeof candidate.command === "string" ? candidate.command : undefined;
    if (candidate.type === "mcp" && (command === undefined || command.trim() === "")) {
      throw new SettingsError(`${sourcePath}.command is required for mcp sources`);
    }
    if (candidate.type === "mcp" && location !== undefined) {
      throw new SettingsError(`${sourcePath}.location is not allowed for mcp sources`);
    }
    if ((candidate.type === "skill" || candidate.type === "plugin")
      && (location === undefined || location.trim() === "")) {
      throw new SettingsError(`${sourcePath}.location is required for ${candidate.type} sources`);
    }
    if ((candidate.type === "skill" || candidate.type === "plugin")
      && (command !== undefined || candidate.args !== undefined)) {
      throw new SettingsError(`${sourcePath}.command/args are only allowed for mcp sources`);
    }
    if (location !== undefined) validateEdgeString(location, `${sourcePath}.location`, path, MAX_EDGE_STRING_BYTES);
    if (command !== undefined) validateEdgeString(command, `${sourcePath}.command`, path, MAX_EDGE_STRING_BYTES);
    validateOptionalBoolean(candidate.enabled, `${sourcePath}.enabled`, path);
    if (candidate.args !== undefined) {
      if (!Array.isArray(candidate.args) || candidate.args.some((arg) => typeof arg !== "string")) {
        throw new SettingsError(`${sourcePath}.args must be an array of strings`);
      }
      if (candidate.args.length > MAX_EDGE_ARGS) {
        throw new SettingsError(`${sourcePath}.args exceeds ${MAX_EDGE_ARGS} entries`);
      }
      for (const [argIndex, arg] of candidate.args.entries()) {
        validateEdgeString(arg, `${sourcePath}.args[${argIndex}]`, path, MAX_EDGE_STRING_BYTES);
      }
    }
  }
  validateOptionalEdgeGrants(value.grants, path);
};

const validateOptionalEdgeGrants = (value: unknown, path: string): void => {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new SettingsError(`edges.grants in ${path} must be an array`);
  }
  if (value.length > MAX_EDGE_GRANTS) {
    throw new SettingsError(`edges.grants in ${path} exceeds ${MAX_EDGE_GRANTS} entries`);
  }
  const seen = new Set<string>();
  const effects = new Set<MoweEffect>(["read", "compute", "write", "external"]);
  const scopes = new Set<MoweToolScope>(["workspace", "run", "lane", "host"]);
  for (const [index, candidate] of value.entries()) {
    const grantPath = `edges.grants[${index}] in ${path}`;
    if (!isRecord(candidate)) throw new SettingsError(`${grantPath} must be a JSON object`);
    const allowed = new Set(["sourceId", "effects", "scopes", "allowWithoutApproval"]);
    for (const key of Object.keys(candidate)) {
      if (!allowed.has(key)) throw new SettingsError(`Unknown setting ${grantPath}.${key}`);
    }
    if (typeof candidate.sourceId !== "string") {
      throw new SettingsError(`${grantPath}.sourceId is required`);
    }
    validateEdgeId(candidate.sourceId, `${grantPath}.sourceId`, path);
    if (seen.has(candidate.sourceId)) throw new SettingsError(`Duplicate edge grant sourceId ${candidate.sourceId} in ${path}`);
    seen.add(candidate.sourceId);
    validateGrantValues(candidate.effects, effects, `${grantPath}.effects`);
    validateGrantValues(candidate.scopes, scopes, `${grantPath}.scopes`);
    validateOptionalBoolean(candidate.allowWithoutApproval, `${grantPath}.allowWithoutApproval`, path);
  }
};

const validateGrantValues = <T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  name: string,
): void => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8
    || value.some((item) => typeof item !== "string" || !allowed.has(item as T))) {
    throw new SettingsError(`${name} must be a non-empty list of supported values`);
  }
  if (new Set(value).size !== value.length) throw new SettingsError(`${name} must not contain duplicates`);
};

const validateEdgeString = (value: string, name: string, path: string, maxBytes: number): void => {
  if (value.trim().length === 0) throw new SettingsError(`${name} in ${path} must not be blank`);
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new SettingsError(`${name} in ${path} must not contain control characters`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new SettingsError(`${name} in ${path} exceeds ${maxBytes} UTF-8 bytes`);
  }
};

const validateEdgeId = (value: string, name: string, path: string): void => {
  validateEdgeString(value, name, path, MAX_EDGE_ID_BYTES);
  if (/\s/u.test(value)) {
    throw new SettingsError(`${name} in ${path} must not contain whitespace`);
  }
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
