import type { AgentTool, ToolResult } from "../domain/ports.js";
import { dirname, isAbsolute } from "node:path";
import { sha256, stableJson } from "../ledger/hash.js";
import {
  validateEdgeContextContribution,
  validateEdgeContextContributionSummary,
} from "../mowe/edge-adapter.js";
import type {
  EdgeContextContribution,
  EdgeContextContributionSummary,
} from "../mowe/edge-types.js";
import { annotateTool } from "../mowe/catalog.js";
import type { MoweAgentTool } from "../mowe/types.js";
import { boundedRedactedText } from "./redaction.js";

/** Catalog limits are deliberately smaller than the filesystem Skill limits. */
export const DEFAULT_RUNTIME_SKILL_CATALOG_MAX_ENTRIES = 128;
export const DEFAULT_RUNTIME_SKILL_CATALOG_MAX_DESCRIPTION_BYTES = 512;
export const DEFAULT_RUNTIME_SKILL_CATALOG_MAX_TOTAL_BYTES = 32 * 1024;
export const MAX_RUNTIME_SKILL_CATALOG_ENTRIES = 4_096;
export const MAX_RUNTIME_SKILL_CATALOG_DESCRIPTION_BYTES = 4 * 1024;
export const MAX_RUNTIME_SKILL_CATALOG_TOTAL_BYTES = 256 * 1024;
export const DEFAULT_RUNTIME_SKILL_TOOL_MAX_BODY_BYTES = 256 * 1024;
export const DEFAULT_RUNTIME_SKILL_TOOL_MAX_FILE_BYTES = 256 * 1024;
export const DEFAULT_RUNTIME_SKILL_TOOL_MAX_RESOURCE_BYTES = 256 * 1024;
export const DEFAULT_RUNTIME_SKILL_TOOL_MAX_RESOURCE_TOTAL_BYTES = 2 * 1024 * 1024;
export const DEFAULT_RUNTIME_SKILL_TOOL_MAX_RESOURCES = 1;
export const MAX_RUNTIME_SKILL_TOOL_BODY_BYTES = 64 * 1024 * 1024;
export const MAX_RUNTIME_SKILL_TOOL_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_RUNTIME_SKILL_TOOL_RESOURCE_BYTES = 64 * 1024 * 1024;
export const MAX_RUNTIME_SKILL_TOOL_RESOURCE_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_RUNTIME_SKILL_TOOL_RESOURCES = 256;

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_DIAGNOSTIC_BYTES = 512;
const MAX_ERROR_BYTES = 768;
const capturedSnapshots = new WeakMap<object, unknown>();

/** The narrow registry capability consumed by this runtime-owned tool. */
export interface RuntimeSkillRegistry {
  /** Host loader callback; bivariance keeps concrete registry snapshot types opaque. */
  loadContribution: RuntimeSkillLoader;
}

interface RuntimeSkillLoadContext {
  readonly workspace?: string;
  readonly signal?: AbortSignal;
  /** Opaque registry-owned snapshot; its concrete type stays host-specific. */
  readonly snapshot?: any;
  readonly maxFileBytes?: number;
  readonly resourcePaths?: readonly string[];
  readonly maxBodyBytes?: number;
  readonly maxResourceBytes?: number;
  readonly maxResourceTotalBytes?: number;
  readonly maxResources?: number;
}

type RuntimeSkillLoader = {
  bivarianceHack(
    summary: EdgeContextContributionSummary,
    context: RuntimeSkillLoadContext,
  ): Promise<unknown>;
}["bivarianceHack"];

export interface RuntimeSkillCatalogEntry {
  /** Registry generation captured at activation. */
  readonly generation: number;
  /** Host-only adapter identity. */
  readonly sourceId: string;
  /** Host-only contribution identity. */
  readonly contributionId: string;
  readonly name: string;
  /** Normalized model-visible description; the stored summary is unchanged. */
  readonly description: string;
  /** Host-only summary passed back to the registry loader. */
  readonly summary: EdgeContextContributionSummary;
}

export interface RuntimeSkillCatalogModelEntry {
  readonly name: string;
  readonly description: string;
}

export interface RuntimeSkillCatalogDiagnostic {
  readonly code:
    | "invalid-snapshot"
    | "loader-unavailable"
    | "invalid-summary"
    | "invalid-name"
    | "empty-description"
    | "duplicate-name"
    | "entry-limit"
    | "description-limit"
    | "catalog-limit";
  readonly name?: string;
  readonly message: string;
}

export interface RuntimeSkillCatalog {
  readonly generation: number;
  /** Complete host entries. Never pass these objects directly to a model. */
  readonly entries: readonly RuntimeSkillCatalogEntry[];
  /** The only catalog projection intended for model context. */
  readonly modelEntries: readonly RuntimeSkillCatalogModelEntry[];
  readonly diagnostics: readonly RuntimeSkillCatalogDiagnostic[];
  readonly complete: boolean;
  readonly byteLength: number;
  readonly estimatedTokens: number;
  readonly hash: string;
}

export interface RuntimeSkillCatalogCaptureOptions {
  /** One immutable registry snapshot captured at the activation boundary. */
  readonly snapshot: unknown;
  /** The same registry instance that owns `snapshot`. */
  readonly registry: RuntimeSkillRegistry;
  readonly maxEntries?: number;
  readonly maxDescriptionBytes?: number;
  readonly maxTotalBytes?: number;
}

/** A complete catalog and its matching runtime-owned tool. */
export interface RuntimeSkillCapability {
  readonly catalog: RuntimeSkillCatalog;
  readonly tool: MoweAgentTool;
}

/**
 * Capture one immutable, model-facing Skill catalog from a registry snapshot.
 * No Skill body is read here. A missing loader seam or an invalid/budget
 * violating snapshot fails closed by returning `complete: false`.
 */
export function captureRuntimeSkillCatalog(
  options: RuntimeSkillCatalogCaptureOptions,
): RuntimeSkillCatalog {
  const maxEntries = boundedLimit(
    options.maxEntries,
    DEFAULT_RUNTIME_SKILL_CATALOG_MAX_ENTRIES,
    MAX_RUNTIME_SKILL_CATALOG_ENTRIES,
    "maxEntries",
  );
  const maxDescriptionBytes = boundedLimit(
    options.maxDescriptionBytes,
    DEFAULT_RUNTIME_SKILL_CATALOG_MAX_DESCRIPTION_BYTES,
    MAX_RUNTIME_SKILL_CATALOG_DESCRIPTION_BYTES,
    "maxDescriptionBytes",
  );
  const maxTotalBytes = boundedLimit(
    options.maxTotalBytes,
    DEFAULT_RUNTIME_SKILL_CATALOG_MAX_TOTAL_BYTES,
    MAX_RUNTIME_SKILL_CATALOG_TOTAL_BYTES,
    "maxTotalBytes",
  );

  let snapshot: Record<string, unknown>;
  try {
    snapshot = asRecord(options.snapshot);
  } catch (error: unknown) {
    return freezeCatalog(0, [], [{
      code: "invalid-snapshot",
      message: boundedDiagnostic(error, "Skill catalog snapshot must be an object"),
    }], false);
  }
  const generation = boundedGeneration(snapshot.generation);
  const diagnostics: RuntimeSkillCatalogDiagnostic[] = [];
  const complete = Number.isSafeInteger(snapshot.generation)
    && Number(snapshot.generation) >= 0
    && typeof options.registry?.loadContribution === "function"
    && Array.isArray(snapshot.contextContributions);
  if (!Number.isSafeInteger(snapshot.generation) || Number(snapshot.generation) < 0) {
    diagnostics.push({ code: "invalid-snapshot", message: "Skill catalog snapshot generation is invalid" });
  }
  if (typeof options.registry?.loadContribution !== "function") {
    diagnostics.push({ code: "loader-unavailable", message: "Skill catalog loader is unavailable" });
  }
  if (!Array.isArray(snapshot.contextContributions)) {
    diagnostics.push({ code: "invalid-snapshot", message: "Skill catalog snapshot has no context contributions" });
  }
  if (!complete) return freezeCatalog(generation, [], diagnostics, false);

  const candidates: RuntimeSkillCatalogEntry[] = [];
  for (const raw of snapshot.contextContributions as readonly unknown[]) {
    let summary: EdgeContextContributionSummary;
    try {
      summary = validateEdgeContextContributionSummary(raw);
    } catch (error: unknown) {
      diagnostics.push({
        code: "invalid-summary",
        message: boundedDiagnostic(error, "Invalid Skill catalog summary"),
      });
      continue;
    }
    if (summary.sourceType !== "skill" || summary.disabled === true) continue;
    if (!SKILL_NAME.test(summary.name) || summary.name.length > 64) {
      diagnostics.push({
        code: "invalid-name",
        name: summary.name,
        message: "Skill name is not model-invocable",
      });
      continue;
    }
    const description = normalizeDescription(summary.description);
    if (description.length === 0) {
      diagnostics.push({ code: "empty-description", name: summary.name, message: "Skill description is empty" });
      continue;
    }
    if (Buffer.byteLength(description, "utf8") > maxDescriptionBytes) {
      diagnostics.push({
        code: "description-limit",
        name: summary.name,
        message: `Skill description exceeds ${maxDescriptionBytes} bytes`,
      });
      continue;
    }
    candidates.push(Object.freeze({
      generation,
      sourceId: summary.sourceId,
      contributionId: summary.contributionId,
      name: summary.name,
      description,
      summary,
    }));
  }

  candidates.sort(compareEntries);
  const byName = new Map<string, RuntimeSkillCatalogEntry[]>();
  for (const candidate of candidates) {
    const values = byName.get(candidate.name) ?? [];
    values.push(candidate);
    byName.set(candidate.name, values);
  }
  const entries: RuntimeSkillCatalogEntry[] = [];
  for (const [name, values] of byName) {
    if (values.length > 1) {
      diagnostics.push({
        code: "duplicate-name",
        name,
        message: `Skill name ${name} is ambiguous and was omitted from the model catalog`,
      });
      continue;
    }
    const entry = values[0];
    if (entry !== undefined) entries.push(entry);
  }
  entries.sort(compareEntries);
  if (entries.length > maxEntries) {
    diagnostics.push({
      code: "entry-limit",
      message: `Skill catalog exceeds the ${maxEntries} entry limit`,
    });
    return freezeCatalog(generation, [], diagnostics, false);
  }
  const modelEntries = entries.map(({ name, description }) => Object.freeze({ name, description }));
  const byteLength = Buffer.byteLength(renderModelEntries(generation, modelEntries), "utf8");
  if (byteLength > maxTotalBytes) {
    diagnostics.push({
      code: "catalog-limit",
      message: `Skill catalog exceeds the ${maxTotalBytes} byte limit`,
    });
    return freezeCatalog(generation, [], diagnostics, false);
  }
  const catalog = freezeCatalog(generation, entries, diagnostics, true, modelEntries, byteLength);
  capturedSnapshots.set(catalog, options.snapshot);
  return catalog;
}

/** Resolve only an exact name from a captured catalog. */
export function resolveRuntimeSkillEntry(
  catalog: RuntimeSkillCatalog,
  name: unknown,
): RuntimeSkillCatalogEntry | undefined {
  if (typeof name !== "string") return undefined;
  return catalog.entries.find((entry) => entry.name === name);
}

/**
 * Render the bounded model projection. Markup escaping is applied only here;
 * the validated summary held by the host remains byte-for-byte unchanged.
 */
export function renderRuntimeSkillCatalog(catalog: RuntimeSkillCatalog): string {
  if (!catalog.complete || catalog.modelEntries.length === 0) return "";
  return renderModelEntries(catalog.generation, catalog.modelEntries);
}

function renderModelEntries(
  generation: number,
  entries: readonly RuntimeSkillCatalogModelEntry[],
): string {
  return [
    "Available Skills (metadata only). When a request matches a listed Skill, call `skill` with its exact name to load the instructions.",
    `<available_skills generation="${generation}">`,
    ...entries.map((entry) => [
      "  <skill>",
      `    <name>${escapeCatalogText(entry.name)}</name>`,
      `    <description>${escapeCatalogText(entry.description)}</description>`,
      "  </skill>",
    ].join("\n")),
    "</available_skills>",
  ].join("\n\n");
}

/**
 * Create the runtime-owned `skill` tool. The caller should only expose the
 * returned tool when `catalog.complete` and `catalog.entries.length > 0`.
 */
export function createRuntimeSkillTool(
  catalog: RuntimeSkillCatalog,
  registry: RuntimeSkillRegistry,
  options: RuntimeSkillToolOptions = {},
): MoweAgentTool {
  if (!catalog.complete || catalog.entries.length === 0) {
    throw new Error("Cannot create Skill tool without a complete non-empty catalog");
  }
  if (typeof registry?.loadContribution !== "function") {
    throw new TypeError("Skill registry must expose loadContribution");
  }
  const workspace = options.workspace;
  if (workspace !== undefined
    && (workspace.length === 0 || workspace.includes("\0") || !isAbsolute(workspace))) {
    throw new Error("Skill workspace must be a non-empty absolute path without NUL");
  }
  const configuredMaxBodyBytes = boundedLimit(
    options.maxBodyBytes,
    DEFAULT_RUNTIME_SKILL_TOOL_MAX_BODY_BYTES,
    MAX_RUNTIME_SKILL_TOOL_BODY_BYTES,
    "maxBodyBytes",
  );
  const maxFileBytes = boundedLimit(
    options.maxFileBytes,
    DEFAULT_RUNTIME_SKILL_TOOL_MAX_FILE_BYTES,
    MAX_RUNTIME_SKILL_TOOL_FILE_BYTES,
    "maxFileBytes",
  );
  const maxBodyBytes = Math.min(maxFileBytes, configuredMaxBodyBytes);
  const maxResourceBytes = boundedLimit(
    options.maxResourceBytes,
    DEFAULT_RUNTIME_SKILL_TOOL_MAX_RESOURCE_BYTES,
    MAX_RUNTIME_SKILL_TOOL_RESOURCE_BYTES,
    "maxResourceBytes",
  );
  const maxResourceTotalBytes = boundedLimit(
    options.maxResourceTotalBytes,
    DEFAULT_RUNTIME_SKILL_TOOL_MAX_RESOURCE_TOTAL_BYTES,
    MAX_RUNTIME_SKILL_TOOL_RESOURCE_TOTAL_BYTES,
    "maxResourceTotalBytes",
  );
  const maxResources = boundedLimit(
    options.maxResources,
    DEFAULT_RUNTIME_SKILL_TOOL_MAX_RESOURCES,
    MAX_RUNTIME_SKILL_TOOL_RESOURCES,
    "maxResources",
  );
  const catalogSnapshot = capturedSnapshots.get(catalog);
  if (catalogSnapshot === undefined) {
    throw new Error("Skill tool requires the catalog's captured registry snapshot");
  }
  if (options.snapshot !== undefined && options.snapshot !== catalogSnapshot) {
    throw new Error("Skill tool snapshot does not match the catalog snapshot");
  }
  const capturedSnapshot = catalogSnapshot;
  const tool: AgentTool = {
    definition: {
      name: "skill",
      description: "Load the full instructions for an available Skill, or read one text resource referenced by that Skill. Use an exact name from the current Skill catalog. Omit resourcePath to load instructions; resourcePath is relative to the Skill directory. Resolve script and asset paths against the returned skillLocation.baseDirectory.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Exact Skill name from the current available-Skills catalog." },
          resourcePath: { type: "string", description: "Optional UTF-8 text resource path relative to the selected Skill directory." },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    async execute(arguments_, context): Promise<ToolResult> {
      try {
        throwIfAborted(context.signal);
        const name = requiredName(arguments_.name);
        const resourcePath = optionalResourcePath(arguments_.resourcePath);
        if (workspace !== undefined && context.workspace !== workspace) {
          throw new Error("Skill workspace does not match the captured runtime workspace");
        }
        const entry = resolveRuntimeSkillEntry(catalog, name);
        if (entry === undefined) throw new Error(`Skill ${name} is unknown or unavailable`);
        const loaded = await awaitWithSignal(registry.loadContribution(entry.summary, {
          ...(workspace === undefined ? { workspace: context.workspace } : { workspace }),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          snapshot: capturedSnapshot,
          maxFileBytes,
          ...(resourcePath === undefined ? {} : { resourcePaths: [resourcePath] }),
          maxBodyBytes,
          maxResourceBytes,
          maxResourceTotalBytes,
          maxResources,
        }), context.signal);
        throwIfAborted(context.signal);
        const contribution = validateLoadedContribution(loaded);
        if (contribution.sourceType !== "skill"
          || contribution.disabled
          || contribution.name !== entry.name
          || contribution.sourceId !== entry.sourceId
          || contribution.contributionId !== entry.contributionId) {
          throw new Error(`Skill ${name} is no longer model-invocable`);
        }
        const contentHash = contribution.contentHash ?? sha256(contribution.body ?? "");
        const skillLocation = readSkillLocation(loaded);
        if (resourcePath === undefined) {
          if (typeof contribution.body !== "string") throw new Error(`Skill ${name} returned no instruction body`);
          const bodyBytes = Buffer.byteLength(contribution.body, "utf8");
          if (bodyBytes > maxBodyBytes) {
            throw new Error(`Skill ${name} exceeds its instruction byte budget`);
          }
          return success({
            kind: "skill_instructions",
            name,
            generation: catalog.generation,
            contentHash,
            instructions: contribution.body,
            ...(skillLocation === undefined
              ? {}
              : { skillLocation }),
          });
        }
        const resources = readResources(contribution).map((candidate) => ({
          ...candidate,
          relativePath: optionalResourcePath(candidate.relativePath)!,
        }));
        if (resources.length > maxResources) {
          throw new Error(`Skill ${name} returned too many resources`);
        }
        const resourcePaths = new Set<string>();
        let resourceTotalBytes = 0;
        for (const candidate of resources) {
          if (resourcePaths.has(candidate.relativePath)) {
            throw new Error(`Skill ${name} returned duplicate resource paths`);
          }
          resourcePaths.add(candidate.relativePath);
          const bytes = Buffer.byteLength(candidate.content, "utf8");
          if (bytes > maxResourceBytes) {
            throw new Error(`Skill resource ${candidate.relativePath} exceeds its byte budget`);
          }
          resourceTotalBytes += bytes;
          if (resourceTotalBytes > maxResourceTotalBytes) {
            throw new Error(`Skill ${name} resources exceed their total byte budget`);
          }
        }
        const resource = resources.find((candidate) => candidate.relativePath === resourcePath);
        if (resource === undefined) throw new Error(`Skill resource ${resourcePath} was not returned`);
        const resourceBytes = Buffer.byteLength(resource.content, "utf8");
        if (resourceBytes > maxResourceBytes || resourceBytes > maxResourceTotalBytes) {
          throw new Error(`Skill resource ${resourcePath} exceeds its byte budget`);
        }
        return success({
          kind: "skill_resource",
          name,
          generation: catalog.generation,
          resourcePath: resource.relativePath,
          contentHash: sha256(resource.content),
          content: resource.content,
          ...(skillLocation === undefined
            ? {}
            : { skillLocation }),
        });
      } catch (error: unknown) {
        return failure(error);
      }
    },
  };
  return annotateTool(tool, {
    effect: "read",
    version: "1",
    deterministic: true,
    supportsBatch: false,
    concurrencySafe: true,
    scope: "workspace",
    inputKinds: ["text"],
    outputKinds: ["json", "text"],
  });
}

export interface RuntimeSkillToolOptions {
  /** Snapshot captured with the catalog; forwarded unchanged to the registry. */
  readonly snapshot?: unknown;
  readonly workspace?: string;
  readonly maxFileBytes?: number;
  readonly maxBodyBytes?: number;
  readonly maxResourceBytes?: number;
  readonly maxResourceTotalBytes?: number;
  readonly maxResources?: number;
}

/** Capture catalog and tool atomically. Returns undefined when prerequisites fail. */
export function createRuntimeSkillCapability(
  options: RuntimeSkillCatalogCaptureOptions & RuntimeSkillToolOptions,
): RuntimeSkillCapability | undefined {
  const catalog = captureRuntimeSkillCatalog(options);
  if (!catalog.complete || catalog.entries.length === 0) return undefined;
  const tool = createRuntimeSkillTool(catalog, options.registry, {
    snapshot: options.snapshot,
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    ...(options.maxResourceBytes === undefined ? {} : { maxResourceBytes: options.maxResourceBytes }),
    ...(options.maxResourceTotalBytes === undefined ? {} : { maxResourceTotalBytes: options.maxResourceTotalBytes }),
    ...(options.maxResources === undefined ? {} : { maxResources: options.maxResources }),
  });
  return Object.freeze({ catalog, tool });
}

function freezeCatalog(
  generation: number,
  entries: readonly RuntimeSkillCatalogEntry[],
  diagnostics: readonly RuntimeSkillCatalogDiagnostic[],
  complete: boolean,
  modelEntries: readonly RuntimeSkillCatalogModelEntry[] = [],
  byteLength = 0,
): RuntimeSkillCatalog {
  const frozenEntries = Object.freeze([...entries]);
  const frozenModelEntries = Object.freeze([...modelEntries]);
  const frozenDiagnostics = Object.freeze(diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })));
  return Object.freeze({
    generation,
    entries: frozenEntries,
    modelEntries: frozenModelEntries,
    diagnostics: frozenDiagnostics,
    complete,
    byteLength,
    estimatedTokens: Math.ceil(byteLength / 4),
    hash: sha256(stableJson({ generation, entries: frozenModelEntries })),
  });
}

function compareEntries(left: RuntimeSkillCatalogEntry, right: RuntimeSkillCatalogEntry): number {
  return compareText(left.name, right.name)
    || compareText(left.sourceId, right.sourceId)
    || compareText(left.contributionId, right.contributionId);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeDescription(value: string): string {
  return value
    .replaceAll(/[\u0000-\u001f\u007f]/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function escapeCatalogText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new RangeError(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return resolved;
}

function boundedGeneration(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Skill catalog snapshot must be an object");
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredName(value: unknown): string {
  if (typeof value !== "string" || !SKILL_NAME.test(value) || value.length > 64) {
    throw new TypeError("name must be an exact model-invocable Skill name");
  }
  return value;
}

function optionalResourcePath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("resourcePath must be a non-empty relative path without NUL or control characters");
  }
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/u.test(value)) {
    throw new TypeError("resourcePath must be relative");
  }
  const segments = value.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new TypeError("resourcePath must not contain traversal segments");
  }
  const normalized = segments.filter((segment) => segment.length > 0 && segment !== ".").join("/");
  if (normalized.length === 0) throw new TypeError("resourcePath must identify a file");
  return normalized;
}

function readResources(
  contribution: EdgeContextContribution,
): readonly { readonly relativePath: string; readonly content: string; readonly contentHash?: string }[] {
  const resources = (contribution as EdgeContextContribution & { readonly resources?: unknown }).resources;
  if (!Array.isArray(resources)) return [];
  return resources.flatMap((resource: unknown) => {
    if (resource === null || typeof resource !== "object") return [];
    const candidate = resource as { relativePath?: unknown; content?: unknown; contentHash?: unknown };
    return typeof candidate.relativePath === "string" && typeof candidate.content === "string"
      ? [{
          relativePath: candidate.relativePath,
          content: candidate.content,
          ...(typeof candidate.contentHash === "string" ? { contentHash: candidate.contentHash } : {}),
        }]
      : [];
  });
}

function validateLoadedContribution(value: unknown): EdgeContextContribution {
  const resources = value !== null && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, "resources")
    : undefined;
  const contribution = validateEdgeContextContribution(value);
  if (resources !== undefined && !resources.enumerable && Array.isArray(resources.value)) {
    const enriched = { ...contribution };
    Object.defineProperty(enriched, "resources", {
      configurable: false,
      enumerable: false,
      value: Object.freeze([...resources.value]),
      writable: false,
    });
    return Object.freeze(enriched) as EdgeContextContribution;
  }
  return contribution;
}

function readSkillLocation(value: unknown):
  { readonly filePath: string; readonly baseDirectory: string } | undefined {
  if (!isRecord(value)) return undefined;
  // Only the adapter's host-owned extension may supply reference locations.
  const descriptor = Object.getOwnPropertyDescriptor(value, "skillLocation");
  if (descriptor === undefined || descriptor.enumerable || !isRecord(descriptor.value)) return undefined;
  const { filePath, baseDirectory } = descriptor.value;
  if (typeof filePath !== "string" || typeof baseDirectory !== "string"
    || !isAbsolute(filePath) || !isAbsolute(baseDirectory)
    || /[\u0000-\u001f\u007f]/u.test(filePath + baseDirectory)
    || dirname(filePath) !== baseDirectory) return undefined;
  return Object.freeze({ filePath, baseDirectory });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason ?? new Error("Skill load cancelled");
}

async function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) throw signal.reason ?? new Error("Skill load cancelled");
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("Skill load cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function success(value: unknown): ToolResult {
  return { content: JSON.stringify(value), isError: false };
}

function failure(error: unknown): ToolResult {
  return {
    content: JSON.stringify({ error: safeErrorText(errorMessage(error)) }),
    isError: true,
  };
}

function boundedDiagnostic(error: unknown, fallback: string): string {
  return boundedRedactedText(errorMessage(error, fallback), MAX_DIAGNOSTIC_BYTES);
}

function errorMessage(error: unknown, fallback = "Skill load failed"): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function safeErrorText(value: string): string {
  const withoutPaths = value.replaceAll(
    /(?:^|(?<=[\s(:=]))(?:\/(?:[^\s"'<>])+|[A-Za-z]:[\\/](?:[^\s"'<>])+)/gu,
    (match) => match.startsWith("/") || /^[A-Za-z]:/u.test(match) ? "[PATH]" : `${match[0]}[PATH]`,
  );
  return boundedRedactedText(withoutPaths, MAX_ERROR_BYTES);
}
