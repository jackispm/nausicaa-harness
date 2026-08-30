import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { sha256, stableJson } from "../../ledger/hash.js";

/** The on-disk filename used by the Agent Skills convention. */
export const SKILL_FILENAME = "SKILL.md";

export const DEFAULT_SKILL_MAX_FILE_BYTES = 256 * 1024;
export const DEFAULT_SKILL_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
export const DEFAULT_SKILL_MAX_FRONTMATTER_BYTES = 64 * 1024;
export const DEFAULT_SKILL_MAX_SKILLS = 128;
export const DEFAULT_SKILL_MAX_DEPTH = 8;
export const MAX_SKILL_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_SKILL_TOTAL_BYTES = 256 * 1024 * 1024;
export const MAX_SKILL_DEPTH = 64;

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const DEFAULT_ROOTS = ["."] as const;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".nausicaa",
  ".svn",
  "dist",
  "node_modules",
]);

export class SkillLoaderError extends Error {
  override readonly name: string = "SkillLoaderError";
}

export class SkillPathError extends SkillLoaderError {
  override readonly name = "SkillPathError";
}

export class SkillFrontmatterError extends SkillLoaderError {
  override readonly name = "SkillFrontmatterError";
}

export interface SkillConflict {
  readonly name: string;
  readonly paths: readonly string[];
}

export class SkillConflictError extends SkillLoaderError {
  override readonly name = "SkillConflictError";
  readonly conflicts: readonly SkillConflict[];

  constructor(conflicts: readonly SkillConflict[]) {
    const details = conflicts
      .map((conflict) => `${conflict.name}: ${conflict.paths.join(", ")}`)
      .join("; ");
    super(`Duplicate skill names discovered (${details})`);
    this.conflicts = conflicts;
  }
}

export type SkillScalar = string | number | boolean | null;
export type SkillFrontmatterValue = SkillScalar | SkillFrontmatterValue[] | {
  [key: string]: SkillFrontmatterValue;
};

export interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly [key: string]: SkillFrontmatterValue;
}

export interface ParsedSkillDocument {
  readonly frontmatter: SkillFrontmatter;
  readonly body: string;
  readonly frontmatterText: string;
}

/** Metadata returned by discovery. It deliberately contains no instructions body. */
export interface SkillSummary {
  readonly sourceType: "skill";
  readonly sourceId: string;
  readonly workspace: string;
  readonly name: string;
  readonly description: string;
  /** Canonical absolute path to the directory containing SKILL.md. */
  readonly directory: string;
  /** Canonical absolute path to SKILL.md. */
  readonly path: string;
  /** Workspace-relative path, using `/` on every platform. */
  readonly relativePath: string;
  readonly frontmatter: Readonly<SkillFrontmatter>;
  readonly frontmatterHash: string;
  readonly byteLength: number;
  readonly fileIdentity: SkillFileIdentity;
}

export interface LoadedSkill extends SkillSummary {
  /** The markdown after the closing frontmatter delimiter. */
  readonly body: string;
  /** Alias for body for callers that use the Agent Skills terminology. */
  readonly instructions: string;
  readonly bodyByteLength: number;
  readonly contentHash: string;
}

export interface SkillResource {
  readonly path: string;
  readonly relativePath: string;
  readonly content: string;
  readonly byteLength: number;
  readonly contentHash: string;
}

export interface SkillResourceLoadOptions {
  maxBytes?: number;
}

export type SkillConflictMode = "error" | "first" | "last" | "report";

export interface SkillLoaderOptions {
  /** Workspace-relative directories to scan. Defaults to the workspace itself. */
  roots?: readonly string[];
  /** Alias for roots, useful when options are shared with other edge loaders. */
  skillRoots?: readonly string[];
  maxDepth?: number;
  maxSkills?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxFrontmatterBytes?: number;
  conflictMode?: SkillConflictMode;
  /** Missing configured roots are ignored by default. */
  strictRoots?: boolean;
}

export interface SkillDiscoveryReport {
  readonly skills: readonly SkillSummary[];
  readonly conflicts: readonly SkillConflict[];
  readonly diagnostics: readonly SkillDiagnostic[];
}

export interface SkillDiagnostic {
  readonly kind: "duplicate";
  readonly message: string;
  readonly name: string;
  readonly paths: readonly string[];
}

export interface SkillLoadOptions {
  maxFileBytes?: number;
  maxBodyBytes?: number;
}

interface ResolvedLimits {
  readonly maxDepth: number;
  readonly maxSkills: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxFrontmatterBytes: number;
}

export interface SkillFileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface InternalSummary extends SkillSummary {
  readonly identity: SkillFileIdentity;
}

/**
 * Discover skill metadata without loading instruction bodies. Every returned
 * summary is immutable and can be held as a turn snapshot by the host.
 */
export async function discoverSkills(
  workspace: string,
  options: SkillLoaderOptions = {},
): Promise<SkillSummary[]> {
  const report = await discoverSkillCatalog(workspace, options);
  if (report.conflicts.length > 0 && (options.conflictMode ?? "error") === "error") {
    throw new SkillConflictError(report.conflicts);
  }
  return [...report.skills];
}

/** Discover skills and retain duplicate-name diagnostics for a UI/host. */
export async function discoverSkillCatalog(
  workspace: string,
  options: SkillLoaderOptions = {},
): Promise<SkillDiscoveryReport> {
  const limits = resolveLimits(options);
  const root = await canonicalWorkspace(workspace);
  const roots = options.roots !== undefined && options.skillRoots !== undefined
    ? (() => { throw new SkillPathError("Specify only one of roots and skillRoots"); })()
    : options.roots ?? options.skillRoots ?? DEFAULT_ROOTS;
  const strictRoots = options.strictRoots ?? false;
  const candidates = new Map<string, InternalSummary>();
  let totalBytes = 0;

  const canonicalRoots = new Set<string>();
  for (const requested of roots) {
    if (typeof requested !== "string" || requested.length === 0 || requested.includes("\0")) {
      throw new SkillPathError("Skill root must be a non-empty path without NUL");
    }
    const directory = path.resolve(root, requested);
    assertWithin(root, directory);
    let canonical: string;
    try {
      canonical = await canonicalDirectory(root, directory);
    } catch (error: unknown) {
      if (isNotFound(error) && !strictRoots) continue;
      throw error;
    }
    if (canonicalRoots.has(canonical)) continue;
    canonicalRoots.add(canonical);
    const walked = await walkSkills(root, canonical, limits, candidates, totalBytes);
    totalBytes = walked.totalBytes;
    if (candidates.size > limits.maxSkills) {
      throw new SkillLoaderError(`Skills exceed the ${limits.maxSkills} skill limit`);
    }
  }

  const sorted = [...candidates.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath));
  const byName = new Map<string, InternalSummary[]>();
  for (const skill of sorted) {
    const list = byName.get(skill.name) ?? [];
    list.push(skill);
    byName.set(skill.name, list);
  }

  const conflicts: SkillConflict[] = [];
  for (const [name, entries] of byName) {
    if (entries.length < 2) continue;
    conflicts.push({
      name,
      paths: entries.map((entry) => entry.relativePath),
    });
  }
  conflicts.sort((left, right) => left.name.localeCompare(right.name));
  const mode = options.conflictMode ?? "error";
  let selected: InternalSummary[] = sorted;
  if (mode === "first" || mode === "last") {
    const winners = new Map<string, InternalSummary>();
    for (const skill of sorted) {
      if (mode === "first" && winners.has(skill.name)) continue;
      winners.set(skill.name, skill);
    }
    selected = [...winners.values()].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath));
  }

  const diagnostics = conflicts.map((conflict): SkillDiagnostic => ({
    kind: "duplicate",
    message: `Skill ${conflict.name} is provided by multiple paths`,
    name: conflict.name,
    paths: [...conflict.paths],
  }));
  return Object.freeze({
    skills: Object.freeze(selected.map(publicSummary)),
    conflicts: Object.freeze(conflicts.map((conflict) => Object.freeze({
      ...conflict,
      paths: Object.freeze([...conflict.paths]),
    }))),
    diagnostics: Object.freeze(diagnostics.map((diagnostic) => Object.freeze({
      ...diagnostic,
      paths: Object.freeze([...diagnostic.paths]),
    }))),
  });
}

/** Load one selected summary and its instructions body. */
export async function loadSkill(
  summary: SkillSummary,
  options: SkillLoadOptions = {},
): Promise<LoadedSkill> {
  if (!isSkillSummary(summary)) {
    throw new SkillLoaderError("A discovered SkillSummary is required");
  }
  const maxFileBytes = boundedLimit(
    options.maxFileBytes,
    DEFAULT_SKILL_MAX_FILE_BYTES,
    MAX_SKILL_FILE_BYTES,
    "maxFileBytes",
  );
  const maxBodyBytes = boundedLimit(
    options.maxBodyBytes,
    maxFileBytes,
    maxFileBytes,
    "maxBodyBytes",
  );
  const root = await canonicalWorkspace(summary.workspace);
  const candidate = path.resolve(root, summary.relativePath);
  assertWithin(root, candidate);
  const file = await readSkillFile(root, candidate, maxFileBytes, maxBodyBytes);
  if (file.identity.dev !== summary.fileIdentity.dev
    || file.identity.ino !== summary.fileIdentity.ino) {
    throw new SkillLoaderError(`Skill changed while loading: ${summary.relativePath}`);
  }
  if (file.byteLength !== summary.byteLength) {
    throw new SkillLoaderError(`Skill changed while loading: ${summary.relativePath}`);
  }
  if (file.parsed.frontmatterHash !== summary.frontmatterHash) {
    throw new SkillLoaderError(`Skill frontmatter changed while loading: ${summary.relativePath}`);
  }
  if (file.parsed.frontmatter.name !== summary.name) {
    throw new SkillLoaderError(`Skill name changed while loading: ${summary.relativePath}`);
  }
  const bodyByteLength = Buffer.byteLength(file.parsed.body, "utf8");
  const loaded: LoadedSkill = {
    ...summary,
    frontmatter: freezeFrontmatter(file.parsed.frontmatter),
    body: file.parsed.body,
    instructions: file.parsed.body,
    bodyByteLength,
    contentHash: sha256(file.document),
  };
  return Object.freeze(loaded);
}

/** Discover by name/path and load only the selected skill. */
export async function loadSkillFromWorkspace(
  workspace: string,
  reference: string,
  options: SkillLoaderOptions & SkillLoadOptions = {},
): Promise<LoadedSkill> {
  const report = await discoverSkillCatalog(workspace, options);
  if (report.conflicts.length > 0 && (options.conflictMode ?? "error") === "error") {
    throw new SkillConflictError(report.conflicts);
  }
  const normalized = reference.replaceAll(path.sep, "/");
  const selected = report.skills.find((skill) =>
    skill.name === reference || skill.relativePath === normalized || skill.path === reference);
  if (selected === undefined) {
    throw new SkillLoaderError(`Skill not found: ${reference}`);
  }
  return loadSkill(selected, options);
}

export const loadSkillByName = loadSkillFromWorkspace;

/** Load a referenced file below a selected Skill directory on demand. */
export async function loadSkillResource(
  skill: SkillSummary,
  requestedPath: string,
  options: SkillResourceLoadOptions = {},
): Promise<SkillResource> {
  if (!isSkillSummary(skill)) throw new SkillLoaderError("A discovered SkillSummary is required");
  if (typeof requestedPath !== "string" || requestedPath.length === 0 || requestedPath.includes("\0")) {
    throw new SkillPathError("Skill resource path must be a non-empty path without NUL");
  }
  if (path.isAbsolute(requestedPath)) throw new SkillPathError("Skill resource path must be relative");
  const maxBytes = boundedLimit(
    options.maxBytes,
    DEFAULT_SKILL_MAX_FILE_BYTES,
    MAX_SKILL_FILE_BYTES,
    "maxBytes",
  );
  const candidate = path.resolve(skill.directory, requestedPath);
  assertWithin(skill.directory, candidate);
  const canonical = await canonicalFile(skill.workspace, candidate);
  assertWithin(skill.directory, canonical);
  let initial: Stats;
  try {
    initial = await lstat(canonical);
  } catch (error: unknown) {
    throw new SkillPathError(`Cannot inspect Skill resource ${requestedPath}: ${errorText(error)}`);
  }
  if (initial.isSymbolicLink()) throw new SkillPathError(`Refusing symbolic-link Skill resource: ${requestedPath}`);
  if (!initial.isFile()) throw new SkillPathError(`Skill resource is not a regular file: ${requestedPath}`);
  if (!Number.isSafeInteger(initial.size) || initial.size > maxBytes) {
    throw new SkillLoaderError(`Skill resource ${requestedPath} exceeds the ${maxBytes} byte limit`);
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(canonical, constants.O_RDONLY | NO_FOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(initial, opened) || opened.size !== initial.size) {
      throw new SkillLoaderError(`Skill resource changed while opening: ${requestedPath}`);
    }
    const bytes = await readBounded(handle, maxBytes);
    const final = await lstat(canonical);
    if (final.isSymbolicLink() || !final.isFile() || !sameIdentity(opened, final) || final.size !== initial.size) {
      throw new SkillLoaderError(`Skill resource changed while reading: ${requestedPath}`);
    }
    const content = decodeUtf8(bytes, requestedPath);
    return Object.freeze({
      path: canonical,
      relativePath: path.relative(skill.directory, canonical).split(path.sep).join("/"),
      content,
      byteLength: bytes.byteLength,
      contentHash: sha256(bytes),
    });
  } catch (error: unknown) {
    if (error instanceof SkillLoaderError) throw error;
    throw new SkillLoaderError(`Cannot read Skill resource ${requestedPath}: ${errorText(error)}`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export const readSkillResource = loadSkillResource;

/** Progressive helper for loading a caller-selected set of skills. */
export async function loadSelectedSkills(
  workspace: string,
  references: readonly string[],
  options: SkillLoaderOptions & SkillLoadOptions = {},
): Promise<LoadedSkill[]> {
  const report = await discoverSkillCatalog(workspace, options);
  if (report.conflicts.length > 0 && (options.conflictMode ?? "error") === "error") {
    throw new SkillConflictError(report.conflicts);
  }
  const loaded: LoadedSkill[] = [];
  for (const reference of references) {
    const normalized = reference.replaceAll(path.sep, "/");
    const selected = report.skills.find((skill) =>
      skill.name === reference || skill.relativePath === normalized || skill.path === reference);
    if (selected === undefined) throw new SkillLoaderError(`Skill not found: ${reference}`);
    loaded.push(await loadSkill(selected, options));
  }
  return loaded;
}

export class SkillsLoader {
  readonly options: Readonly<SkillLoaderOptions>;

  constructor(options: SkillLoaderOptions = {}) {
    const snapshot: SkillLoaderOptions = { ...options };
    if (options.roots !== undefined) snapshot.roots = Object.freeze([...options.roots]);
    if (options.skillRoots !== undefined) snapshot.skillRoots = Object.freeze([...options.skillRoots]);
    this.options = Object.freeze(snapshot);
  }

  discover(workspace: string, options: SkillLoaderOptions = {}): Promise<SkillSummary[]> {
    return discoverSkills(workspace, { ...this.options, ...options });
  }

  discoverReport(workspace: string, options: SkillLoaderOptions = {}): Promise<SkillDiscoveryReport> {
    return discoverSkillCatalog(workspace, { ...this.options, ...options });
  }

  load(summary: SkillSummary, options: SkillLoadOptions = {}): Promise<LoadedSkill> {
    return loadSkill(summary, options);
  }

  loadSelected(
    workspace: string,
    references: readonly string[],
    options: SkillLoaderOptions & SkillLoadOptions = {},
  ): Promise<LoadedSkill[]> {
    return loadSelectedSkills(workspace, references, { ...this.options, ...options });
  }
}

/** Parse a complete SKILL.md document and return its validated frontmatter/body. */
export function parseSkillDocument(document: string): ParsedSkillDocument {
  if (typeof document !== "string") {
    throw new SkillFrontmatterError("SKILL.md must be UTF-8 text");
  }
  let source = document;
  if (source.startsWith("\uFEFF")) source = source.slice(1);
  if (source.includes("\0")) throw new SkillFrontmatterError("SKILL.md contains NUL");
  const lines = source.split("\n");
  const first = lines[0]?.replace(/\r$/u, "");
  if (first !== "---") {
    throw new SkillFrontmatterError("SKILL.md must start with YAML frontmatter delimiter ---");
  }
  let closing = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]?.replace(/\r$/u, "") ?? "";
    if (line === "---" || line === "...") {
      closing = index;
      break;
    }
  }
  if (closing < 0) throw new SkillFrontmatterError("SKILL.md frontmatter is not closed");
  const frontmatterText = lines.slice(1, closing).join("\n");
  const parsed = parseYamlMapping(frontmatterText);
  const name = parsed.name;
  const description = parsed.description;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new SkillFrontmatterError("SKILL.md frontmatter requires a name");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || name.length > 64) {
    throw new SkillFrontmatterError("Skill name must be lowercase alphanumeric words separated by hyphens");
  }
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new SkillFrontmatterError("SKILL.md frontmatter requires a description");
  }
  if (description.length > 1_024) {
    throw new SkillFrontmatterError("Skill description exceeds 1024 characters");
  }
  const body = lines.slice(closing + 1).join("\n");
  const frontmatter = freezeFrontmatter(parsed as SkillFrontmatter);
  return Object.freeze({ frontmatter, body, frontmatterText });
}

/** Parse only frontmatter, useful for adapter validation and diagnostics. */
export function parseSkillFrontmatter(frontmatterText: string): SkillFrontmatter {
  if (frontmatterText.startsWith("---")) {
    return parseSkillDocument(frontmatterText).frontmatter;
  }
  const parsed = parseYamlMapping(frontmatterText);
  const name = parsed.name;
  const description = parsed.description;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new SkillFrontmatterError("Skill frontmatter requires a name");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || name.length > 64) {
    throw new SkillFrontmatterError("Skill name must be lowercase alphanumeric words separated by hyphens");
  }
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new SkillFrontmatterError("Skill frontmatter requires a description");
  }
  if (description.length > 1_024) {
    throw new SkillFrontmatterError("Skill description exceeds 1024 characters");
  }
  return freezeFrontmatter(parsed as SkillFrontmatter);
}

export const parseFrontmatter = parseSkillFrontmatter;

async function walkSkills(
  workspace: string,
  directory: string,
  limits: ResolvedLimits,
  candidates: Map<string, InternalSummary>,
  initialTotalBytes: number,
): Promise<{ totalBytes: number }> {
  let totalBytes = initialTotalBytes;
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new SkillPathError(`Skill root is not a real directory: ${directory}`);
  }
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const depth = path.relative(workspace, directory).split(path.sep).filter(Boolean).length;
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new SkillPathError(`Refusing symbolic-link skill path: ${candidate}`);
    }
    if (entry.isFile() && entry.name === SKILL_FILENAME) {
      const summary = await readSkillSummary(workspace, candidate, limits);
      totalBytes += summary.byteLength;
      if (totalBytes > limits.maxTotalBytes) {
        throw new SkillLoaderError(`Skills exceed the ${limits.maxTotalBytes} byte total limit`);
      }
      candidates.set(summary.path, summary);
      continue;
    }
    if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
    if (depth >= limits.maxDepth) continue;
    const child = await canonicalDirectory(workspace, candidate);
    const walked = await walkSkills(workspace, child, limits, candidates, totalBytes);
    totalBytes = walked.totalBytes;
    if (candidates.size > limits.maxSkills) {
      throw new SkillLoaderError(`Skills exceed the ${limits.maxSkills} skill limit`);
    }
  }
  return { totalBytes };
}

async function readSkillSummary(
  workspace: string,
  candidate: string,
  limits: ResolvedLimits,
): Promise<InternalSummary> {
  const file = await readSkillPrefix(workspace, candidate, limits.maxFileBytes, limits.maxFrontmatterBytes);
  const directory = path.dirname(file.path);
  const directoryName = path.basename(directory);
  if (file.parsed.frontmatter.name !== directoryName) {
    throw new SkillFrontmatterError(
      `Skill name ${file.parsed.frontmatter.name} does not match directory ${directoryName}`,
    );
  }
  return Object.freeze({
    sourceType: "skill",
    sourceId: `skill:${path.relative(workspace, file.path).split(path.sep).join("/")}`,
    workspace,
    name: file.parsed.frontmatter.name,
    description: file.parsed.frontmatter.description,
    directory,
    path: file.path,
    relativePath: path.relative(workspace, file.path).split(path.sep).join("/"),
    frontmatter: file.parsed.frontmatter,
    frontmatterHash: file.parsed.frontmatterHash,
    byteLength: file.byteLength,
    fileIdentity: file.identity,
    identity: file.identity,
  });
}

interface ReadSkillFileResult {
  readonly path: string;
  readonly document: string;
  readonly parsed: ParsedSkillDocument & { readonly frontmatterHash: string };
  readonly byteLength: number;
  readonly identity: SkillFileIdentity;
}

async function readSkillPrefix(
  workspace: string,
  candidate: string,
  maxFileBytes: number,
  maxPrefixBytes: number,
): Promise<ReadSkillFileResult> {
  assertWithin(workspace, candidate);
  const canonical = await canonicalFile(workspace, candidate);
  let initial: Stats;
  try {
    initial = await lstat(canonical);
  } catch (error: unknown) {
    throw new SkillPathError(`Cannot inspect skill ${candidate}: ${errorText(error)}`);
  }
  if (initial.isSymbolicLink()) throw new SkillPathError(`Refusing symbolic-link skill file: ${candidate}`);
  if (!initial.isFile()) throw new SkillPathError(`Skill path is not a regular file: ${candidate}`);
  if (!Number.isSafeInteger(initial.size) || initial.size > maxFileBytes) {
    throw new SkillLoaderError(`Skill ${candidate} exceeds the ${maxFileBytes} byte file limit`);
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(canonical, constants.O_RDONLY | NO_FOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(initial, opened) || opened.size !== initial.size) {
      throw new SkillLoaderError(`Skill changed while opening: ${candidate}`);
    }
    // Discovery only reads the bounded header. The body is loaded on demand.
    const bytes = await readPrefix(handle, Math.min(maxPrefixBytes, maxFileBytes));
    const prefix = decodeUtf8(bytes, candidate);
    if (findFrontmatterClosingLine(prefix) < 0) {
      throw new SkillFrontmatterError(
        `Skill frontmatter exceeds the ${maxPrefixBytes} byte prefix limit: ${candidate}`,
      );
    }
    const parsedDocument = parseSkillDocument(prefix);
    const final = await lstat(canonical);
    if (final.isSymbolicLink() || !final.isFile() || !sameIdentity(opened, final) || final.size !== initial.size) {
      throw new SkillLoaderError(`Skill changed while reading: ${candidate}`);
    }
    return {
      path: canonical,
      document: prefix,
      parsed: Object.freeze({
        ...parsedDocument,
        frontmatterHash: sha256(stableJson(parsedDocument.frontmatter)),
      }),
      byteLength: initial.size,
      identity: Object.freeze({ dev: opened.dev, ino: opened.ino }),
    };
  } catch (error: unknown) {
    if (error instanceof SkillLoaderError) throw error;
    throw new SkillLoaderError(`Cannot read skill ${candidate}: ${errorText(error)}`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readSkillFile(
  workspace: string,
  candidate: string,
  maxFileBytes: number,
  maxBodyBytes: number,
): Promise<ReadSkillFileResult> {
  assertWithin(workspace, candidate);
  const canonical = await canonicalFile(workspace, candidate);
  let initial: Stats;
  try {
    initial = await lstat(canonical);
  } catch (error: unknown) {
    throw new SkillPathError(`Cannot inspect skill ${candidate}: ${errorText(error)}`);
  }
  if (initial.isSymbolicLink()) throw new SkillPathError(`Refusing symbolic-link skill file: ${candidate}`);
  if (!initial.isFile()) throw new SkillPathError(`Skill path is not a regular file: ${candidate}`);
  if (!Number.isSafeInteger(initial.size) || initial.size > maxFileBytes) {
    throw new SkillLoaderError(`Skill ${candidate} exceeds the ${maxFileBytes} byte file limit`);
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(canonical, constants.O_RDONLY | NO_FOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(initial, opened) || opened.size !== initial.size) {
      throw new SkillLoaderError(`Skill changed while opening: ${candidate}`);
    }
    const bytes = await readBounded(handle, maxFileBytes);
    const final = await lstat(canonical);
    if (final.isSymbolicLink() || !final.isFile() || !sameIdentity(opened, final) || final.size !== initial.size) {
      throw new SkillLoaderError(`Skill changed while reading: ${candidate}`);
    }
    const document = decodeUtf8(bytes, candidate);
    const parsed = parseSkillDocument(document);
    const bodyByteLength = Buffer.byteLength(parsed.body, "utf8");
    if (bodyByteLength > maxBodyBytes) {
      throw new SkillLoaderError(`Skill ${candidate} body exceeds the ${maxBodyBytes} byte limit`);
    }
    return {
      path: canonical,
      document,
      parsed: Object.freeze({
        ...parsed,
        frontmatterHash: sha256(stableJson(parsed.frontmatter)),
      }),
      byteLength: bytes.byteLength,
      identity: Object.freeze({ dev: opened.dev, ino: opened.ino }),
    };
  } catch (error: unknown) {
    if (error instanceof SkillLoaderError) throw error;
    throw new SkillLoaderError(`Cannot read skill ${candidate}: ${errorText(error)}`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readBounded(
  handle: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
): Promise<Uint8Array> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset > maxBytes) throw new SkillLoaderError(`Skill exceeds the ${maxBytes} byte file limit`);
  return buffer.subarray(0, offset);
}

async function readPrefix(
  handle: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
): Promise<Uint8Array> {
  const buffer = Buffer.allocUnsafe(maxBytes);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  return buffer.subarray(0, offset);
}

function decodeUtf8(bytes: Uint8Array, candidate: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SkillFrontmatterError(`Skill is not valid UTF-8: ${candidate}`);
  }
}

function findFrontmatterClosingLine(document: string): number {
  const source = document.startsWith("\uFEFF") ? document.slice(1) : document;
  const lines = source.split("\n");
  if (lines[0]?.replace(/\r$/u, "") !== "---") return -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]?.replace(/\r$/u, "") ?? "";
    if (line === "---" || line === "...") return index;
  }
  return -1;
}

async function canonicalWorkspace(workspace: string): Promise<string> {
  if (typeof workspace !== "string" || workspace.length === 0 || workspace.includes("\0")) {
    throw new SkillPathError("Workspace must be a non-empty path without NUL");
  }
  let canonical: string;
  try {
    canonical = await realpath(path.resolve(workspace));
    const info = await lstat(canonical);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new SkillPathError("Workspace must resolve to a real directory");
    }
  } catch (error: unknown) {
    if (error instanceof SkillLoaderError) throw error;
    throw new SkillPathError(`Cannot resolve workspace ${workspace}: ${errorText(error)}`);
  }
  return canonical;
}

async function canonicalDirectory(workspace: string, directory: string): Promise<string> {
  assertWithin(workspace, directory);
  const info = await lstat(directory);
  if (info.isSymbolicLink()) throw new SkillPathError(`Refusing symbolic-link skill directory: ${directory}`);
  if (!info.isDirectory()) throw new SkillPathError(`Skill root is not a directory: ${directory}`);
  const canonical = await realpath(directory);
  if (canonical !== directory) throw new SkillPathError(`Skill directory is not canonical: ${directory}`);
  return canonical;
}

async function canonicalFile(workspace: string, candidate: string): Promise<string> {
  assertWithin(workspace, candidate);
  const relative = path.relative(workspace, candidate);
  let current = workspace;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current).catch((error: unknown) => {
      throw new SkillPathError(`Cannot inspect skill path ${current}: ${errorText(error)}`);
    });
    if (info.isSymbolicLink()) throw new SkillPathError(`Refusing symbolic-link skill path: ${current}`);
  }
  const canonical = await realpath(candidate);
  if (canonical !== candidate) throw new SkillPathError(`Skill path is not canonical: ${candidate}`);
  return canonical;
}

function assertWithin(workspace: string, candidate: string): void {
  const relative = path.relative(workspace, candidate);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new SkillPathError(`Skill path escapes workspace: ${candidate}`);
  }
}

function resolveLimits(options: SkillLoaderOptions): ResolvedLimits {
  const maxFileBytes = boundedLimit(options.maxFileBytes, DEFAULT_SKILL_MAX_FILE_BYTES, MAX_SKILL_FILE_BYTES, "maxFileBytes");
  const maxFrontmatterBytes = boundedLimit(
    options.maxFrontmatterBytes,
    Math.min(DEFAULT_SKILL_MAX_FRONTMATTER_BYTES, maxFileBytes),
    maxFileBytes,
    "maxFrontmatterBytes",
  );
  return {
    maxDepth: boundedLimit(options.maxDepth, DEFAULT_SKILL_MAX_DEPTH, MAX_SKILL_DEPTH, "maxDepth"),
    maxSkills: boundedLimit(options.maxSkills, DEFAULT_SKILL_MAX_SKILLS, MAX_SKILL_FILE_BYTES, "maxSkills"),
    maxFileBytes,
    maxTotalBytes: boundedLimit(options.maxTotalBytes, DEFAULT_SKILL_MAX_TOTAL_BYTES, MAX_SKILL_TOTAL_BYTES, "maxTotalBytes"),
    maxFrontmatterBytes,
  };
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new SkillLoaderError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return resolved;
}

function publicSummary(summary: InternalSummary): SkillSummary {
  const { identity: _identity, ...publicValue } = summary;
  return Object.freeze({
    ...publicValue,
    frontmatter: freezeFrontmatter(summary.frontmatter),
  });
}

function isSkillSummary(value: SkillSummary): value is SkillSummary {
  return value !== null
    && typeof value === "object"
    && value.sourceType === "skill"
    && typeof value.workspace === "string"
    && typeof value.path === "string"
    && typeof value.relativePath === "string"
    && typeof value.name === "string"
    && typeof value.frontmatterHash === "string"
    && value.fileIdentity !== null
    && typeof value.fileIdentity === "object"
    && Number.isSafeInteger(value.fileIdentity.dev)
    && Number.isSafeInteger(value.fileIdentity.ino);
}

function freezeFrontmatter(value: SkillFrontmatter): Readonly<SkillFrontmatter> {
  return deepFreeze(value) as Readonly<SkillFrontmatter>;
}

function deepFreeze(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function parseYamlMapping(source: string): Record<string, SkillFrontmatterValue> {
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  const significant = lines
    .map((raw, line) => ({ raw, line: line + 1 }))
    .filter(({ raw }) => raw.trim().length > 0 && !raw.trimStart().startsWith("#"));
  if (significant.some(({ raw }) => raw.includes("\t"))) {
    throw new SkillFrontmatterError("Tabs are not allowed in Skill frontmatter indentation");
  }
  if (significant.length === 0) throw new SkillFrontmatterError("Skill frontmatter is empty");
  const parsed = parseYamlObject(lines, 0, 0).value;
  if (!isFrontmatterRecord(parsed)) throw new SkillFrontmatterError("Skill frontmatter must be a mapping");
  return parsed;
}

interface ParsedYamlBlock {
  readonly value: SkillFrontmatterValue;
  readonly next: number;
}

function parseYamlObject(lines: readonly string[], start: number, indent: number): ParsedYamlBlock {
  const result: Record<string, SkillFrontmatterValue> = {};
  let index = skipYamlLines(lines, start);
  while (index < lines.length) {
    const raw = lines[index] ?? "";
    if (raw.trim().length === 0 || raw.trimStart().startsWith("#")) {
      index += 1;
      continue;
    }
    const currentIndent = countIndent(raw);
    if (currentIndent < indent) break;
    if (currentIndent > indent) {
      throw yamlError(index, "Unexpected indentation");
    }
    const text = raw.slice(indent);
    if (text.startsWith("- ") || text === "-") {
      return parseYamlArray(lines, index, indent);
    }
    const separator = findMappingSeparator(text);
    if (separator < 0) throw yamlError(index, "Expected a key: value mapping");
    const key = text.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(key)) throw yamlError(index, `Invalid key ${key}`);
    if (Object.hasOwn(result, key)) throw yamlError(index, `Duplicate key ${key}`);
    let rest = stripYamlComment(text.slice(separator + 1).trim());
    index += 1;
    if (rest === "|" || rest === ">" || rest === "|-" || rest === "|+" || rest === ">-" || rest === ">+") {
      const block = parseYamlBlockScalar(lines, index, indent, rest);
      result[key] = block.value;
      index = block.next;
      continue;
    }
    if (rest.length === 0) {
      const next = nextYamlLine(lines, index);
      if (next !== undefined && countIndent(lines[next] ?? "") > indent) {
        const childIndent = countIndent(lines[next] ?? "");
        const child = parseYamlObject(lines, next, childIndent);
        result[key] = child.value;
        index = child.next;
      } else {
        result[key] = null;
      }
      continue;
    }
    result[key] = parseYamlScalar(rest, index);
  }
  return { value: result, next: index };
}

function parseYamlArray(lines: readonly string[], start: number, indent: number): ParsedYamlBlock {
  const result: SkillFrontmatterValue[] = [];
  let index = start;
  while (index < lines.length) {
    const raw = lines[index] ?? "";
    if (raw.trim().length === 0 || raw.trimStart().startsWith("#")) {
      index += 1;
      continue;
    }
    const currentIndent = countIndent(raw);
    if (currentIndent < indent) break;
    if (currentIndent !== indent) throw yamlError(index, "Unexpected indentation in sequence");
    const text = raw.slice(indent);
    if (!(text === "-" || text.startsWith("- "))) break;
    const rest = stripYamlComment(text.slice(1).trim());
    index += 1;
    if (rest.length === 0) {
      const next = nextYamlLine(lines, index);
      if (next !== undefined && countIndent(lines[next] ?? "") > indent) {
        const child = parseYamlObject(lines, next, countIndent(lines[next] ?? ""));
        result.push(child.value);
        index = child.next;
      } else result.push(null);
    } else {
      result.push(parseYamlScalar(rest, index));
    }
  }
  return { value: result, next: index };
}

function parseYamlBlockScalar(
  lines: readonly string[],
  start: number,
  parentIndent: number,
  marker: string,
): ParsedYamlBlock {
  const content: string[] = [];
  let index = start;
  let blockIndent: number | undefined;
  while (index < lines.length) {
    const raw = lines[index] ?? "";
    if (raw.trim().length === 0) {
      content.push("");
      index += 1;
      continue;
    }
    const currentIndent = countIndent(raw);
    if (currentIndent <= parentIndent) break;
    blockIndent ??= currentIndent;
    content.push(raw.slice(Math.min(blockIndent, raw.length)));
    index += 1;
  }
  const folded = marker.startsWith(">");
  let value = folded ? foldBlock(content) : content.join("\n");
  if (!marker.endsWith("-")) value += "\n";
  return { value, next: index };
}

function foldBlock(lines: readonly string[]): string {
  let result = "";
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index] ?? "";
    const next = lines[index + 1] ?? "";
    result += current;
    if (index + 1 < lines.length) result += current.length === 0 || next.length === 0 ? "\n" : " ";
  }
  return result;
}

function parseYamlScalar(value: string, line: number): SkillFrontmatterValue {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === "null" || trimmed === "Null" || trimmed === "NULL" || trimmed === "~") return null;
  if (/^(?:true|false)$/iu.test(trimmed)) return trimmed.toLowerCase() === "true";
  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(trimmed)) {
    const number = Number(trimmed);
    if (Number.isFinite(number)) return number;
  }
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return parseInlineYaml(trimmed, line);
    } catch (error: unknown) {
      if (error instanceof SkillFrontmatterError) throw error;
      throw yamlError(line - 1, "Invalid inline value");
    }
  }
  if (trimmed.startsWith("\"") || trimmed.startsWith("'")) return parseQuoted(trimmed, line);
  if (trimmed.endsWith(":") || trimmed.includes("\n")) throw yamlError(line - 1, "Invalid scalar value");
  return trimmed;
}

function parseInlineYaml(value: string, line: number): SkillFrontmatterValue {
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return splitInline(inner).map((item) => parseYamlScalar(item, line));
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    const inner = value.slice(1, -1).trim();
    const object: Record<string, SkillFrontmatterValue> = {};
    if (inner.length === 0) return object;
    for (const item of splitInline(inner)) {
      const separator = findMappingSeparator(item);
      if (separator < 0) throw yamlError(line - 1, "Invalid inline mapping");
      const key = item.slice(0, separator).trim();
      if (Object.hasOwn(object, key)) throw yamlError(line - 1, `Duplicate key ${key}`);
      object[key] = parseYamlScalar(item.slice(separator + 1).trim(), line);
    }
    return object;
  }
  throw yamlError(line - 1, "Invalid inline value");
}

function parseQuoted(value: string, line: number): string {
  const quote = value[0];
  if (value.length < 2 || value[value.length - 1] !== quote) throw yamlError(line - 1, "Unterminated quoted value");
  const inner = value.slice(1, -1);
  if (quote === "'") return inner.replaceAll("''", "'");
  try {
    return JSON.parse(value) as string;
  } catch {
    throw yamlError(line - 1, "Invalid double-quoted value");
  }
}

function splitInline(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  let quote = "";
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    if (quote.length > 0) {
      if (current === quote && value[index - 1] !== "\\") quote = "";
      continue;
    }
    if (current === "\"" || current === "'") {
      quote = current;
    } else if (current === "[" || current === "{") {
      depth += 1;
    } else if (current === "]" || current === "}") {
      depth -= 1;
    } else if (current === "," && depth === 0) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(value.slice(start).trim());
  return result;
}

function findMappingSeparator(value: string): number {
  let quote = "";
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    if (quote.length > 0) {
      if (current === quote && value[index - 1] !== "\\") quote = "";
      continue;
    }
    if (current === "\"" || current === "'") quote = current;
    else if (current === "[" || current === "{") depth += 1;
    else if (current === "]" || current === "}") depth -= 1;
    else if (current === ":" && depth === 0) return index;
  }
  return -1;
}

function stripYamlComment(value: string): string {
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    if (quote.length > 0) {
      if (current === quote && value[index - 1] !== "\\") quote = "";
    } else if (current === "\"" || current === "'") {
      quote = current;
    } else if (current === "#" && (index === 0 || /\s/u.test(value[index - 1] ?? ""))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value;
}

function countIndent(line: string): number {
  return line.length - line.trimStart().length;
}

function skipYamlLines(lines: readonly string[], start: number): number {
  let index = start;
  while (index < lines.length && ((lines[index] ?? "").trim().length === 0 || (lines[index] ?? "").trimStart().startsWith("#"))) {
    index += 1;
  }
  return index;
}

function nextYamlLine(lines: readonly string[], start: number): number | undefined {
  const index = skipYamlLines(lines, start);
  return index >= lines.length ? undefined : index;
}

function yamlError(line: number, message: string): SkillFrontmatterError {
  return new SkillFrontmatterError(`Skill frontmatter line ${line + 1}: ${message}`);
}

function isFrontmatterRecord(value: SkillFrontmatterValue): value is Record<string, SkillFrontmatterValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameIdentity(left: Pick<Stats, "dev" | "ino">, right: Pick<Stats, "dev" | "ino">): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
