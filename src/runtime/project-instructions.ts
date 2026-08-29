import { constants } from "node:fs";
import type { Stats } from "node:fs";
import {
  lstat,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import path from "node:path";

import type {
  ContextProjectInstructionsManifest,
  ContextProjectInstructionSource,
} from "../domain/context.js";
import { PROJECT_INSTRUCTIONS_MEDIA_TYPE } from "../domain/context.js";
import type { ArtifactRef } from "../domain/types.js";
import { sha256, stableJson } from "../ledger/hash.js";

export const PROJECT_INSTRUCTION_FILENAMES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "CLAUDE.md",
] as const;

export const MAX_PROJECT_INSTRUCTION_FILE_BYTES = 64 * 1024;
export const MAX_PROJECT_INSTRUCTION_TOTAL_BYTES = 256 * 1024;
export const MAX_PROJECT_INSTRUCTION_FILES = 64;

export class ProjectInstructionError extends Error {
  override readonly name = "ProjectInstructionError";
}

export interface ProjectInstructionFile {
  path: string;
  content: string;
  byteLength: number;
  pathHash: string;
  contentHash: string;
}

export interface ProjectInstructionSet {
  files: ProjectInstructionFile[];
  totalBytes: number;
  sourceHash: string;
  contentHash: string;
}

export interface ProjectInstructionLoadOptions {
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
}

interface ProjectInstructionBundle {
  schemaVersion: 1;
  files: Array<{
    path: string;
    content: string;
    byteLength: number;
    contentHash: string;
  }>;
}

const noFollow = constants.O_NOFOLLOW ?? 0;

/**
 * Load one instruction file per ancestor, ordered from the filesystem root
 * toward the workspace. Same-directory precedence matches Pi coding-agent.
 */
export async function loadProjectInstructions(
  workspace: string,
  options: ProjectInstructionLoadOptions = {},
): Promise<ProjectInstructionSet> {
  const limits = resolveLimits(options);
  const root = await canonicalWorkspace(workspace);
  const shadowedContextFile = await findShadowedContextFile(root);
  const files: ProjectInstructionFile[] = [];
  let totalBytes = 0;

  for (const directory of ancestorDirectories(root)) {
    const selected = await loadFromDirectory(directory, limits.maxFileBytes);
    if (selected === undefined) continue;
    if (shadowedContextFile !== undefined && selected.path === shadowedContextFile) {
      continue;
    }
    if (files.length >= limits.maxFiles) {
      throw new ProjectInstructionError(
        `Project instructions exceed the ${limits.maxFiles} file limit`,
      );
    }
    if (totalBytes + selected.byteLength > limits.maxTotalBytes) {
      throw new ProjectInstructionError(
        `Project instructions exceed the ${limits.maxTotalBytes} byte total limit`,
      );
    }
    files.push(selected);
    totalBytes += selected.byteLength;
  }

  const sources = files.map(projectInstructionSource);
  return {
    files,
    totalBytes,
    sourceHash: projectInstructionSourceHash(sources),
    contentHash: projectInstructionContentHash(sources),
  };
}

/** Stable Store body used to reconstruct the trusted request prefix. */
export function serializeProjectInstructionBundle(
  instructions: ProjectInstructionSet,
): string {
  const bundle: ProjectInstructionBundle = {
    schemaVersion: 1,
    files: instructions.files.map((file) => ({
      path: file.path,
      content: file.content,
      byteLength: file.byteLength,
      contentHash: file.contentHash,
    })),
  };
  return stableJson(bundle);
}

/** Redacted Ledger projection: source/content hashes plus a Store reference. */
export function projectInstructionManifest(
  instructions: ProjectInstructionSet,
  bundleRef?: ArtifactRef,
): ContextProjectInstructionsManifest {
  if (instructions.files.length > 0 && bundleRef === undefined) {
    throw new ProjectInstructionError(
      "Non-empty project instructions require a durable bundle reference",
    );
  }
  if (instructions.files.length === 0 && bundleRef !== undefined) {
    throw new ProjectInstructionError(
      "Empty project instructions must not carry a bundle reference",
    );
  }
  if (
    bundleRef !== undefined
    && bundleRef.mediaType !== PROJECT_INSTRUCTIONS_MEDIA_TYPE
  ) {
    throw new ProjectInstructionError("Project instruction bundle media type is invalid");
  }
  return {
    schemaVersion: 1,
    state: instructions.files.length === 0 ? "empty" : "present",
    itemCount: instructions.files.length,
    totalBytes: instructions.totalBytes,
    sourceHash: instructions.sourceHash,
    contentHash: instructions.contentHash,
    sources: instructions.files.map(projectInstructionSource),
    ...(bundleRef === undefined ? {} : { bundleRef: structuredClone(bundleRef) }),
  };
}

export function projectInstructionSourceHash(
  sources: readonly ContextProjectInstructionSource[],
): string {
  return sha256(stableJson(sources.map((source) => source.pathHash)));
}

export function projectInstructionContentHash(
  sources: readonly ContextProjectInstructionSource[],
): string {
  return sha256(stableJson(sources.map((source) => ({
    contentHash: source.contentHash,
    byteLength: source.byteLength,
  }))));
}

function projectInstructionSource(
  file: ProjectInstructionFile,
): ContextProjectInstructionSource {
  return {
    pathHash: file.pathHash,
    contentHash: file.contentHash,
    byteLength: file.byteLength,
  };
}

async function loadFromDirectory(
  directory: string,
  maxFileBytes: number,
): Promise<ProjectInstructionFile | undefined> {
  for (const filename of PROJECT_INSTRUCTION_FILENAMES) {
    const candidate = path.join(directory, filename);
    let initial: Stats;
    try {
      initial = await lstat(candidate);
    } catch (error: unknown) {
      if (isNotFound(error)) continue;
      throw new ProjectInstructionError(
        `Cannot inspect project instruction ${candidate}: ${errorText(error)}`,
      );
    }
    if (initial.isSymbolicLink()) {
      throw new ProjectInstructionError(
        `Refusing symbolic-link project instruction: ${candidate}`,
      );
    }
    if (!initial.isFile()) continue;
    return readInstructionFile(candidate, initial, maxFileBytes);
  }
  return undefined;
}

async function readInstructionFile(
  candidate: string,
  initial: Stats,
  maxFileBytes: number,
): Promise<ProjectInstructionFile> {
  if (!Number.isSafeInteger(initial.size) || initial.size > maxFileBytes) {
    throw new ProjectInstructionError(
      `Project instruction ${candidate} exceeds the ${maxFileBytes} byte file limit`,
    );
  }

  let handle;
  try {
    handle = await open(candidate, constants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(initial, opened)) {
      throw new ProjectInstructionError(
        `Project instruction changed while opening: ${candidate}`,
      );
    }
    const canonical = await realpath(candidate);
    if (canonical !== candidate) {
      throw new ProjectInstructionError(
        `Project instruction is not a canonical path: ${candidate}`,
      );
    }
    const bytes = await readBounded(handle, maxFileBytes);
    const final = await lstat(candidate);
    if (final.isSymbolicLink() || !final.isFile() || !sameFile(opened, final)) {
      throw new ProjectInstructionError(
        `Project instruction changed while reading: ${candidate}`,
      );
    }
    const content = decodeMarkdown(bytes, candidate);
    const contentBytes = Buffer.byteLength(content, "utf8");
    return {
      path: canonical,
      content,
      byteLength: contentBytes,
      pathHash: sha256(canonical),
      contentHash: sha256(content),
    };
  } catch (error: unknown) {
    if (error instanceof ProjectInstructionError) throw error;
    throw new ProjectInstructionError(
      `Cannot read project instruction ${candidate}: ${errorText(error)}`,
    );
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
    const read = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
    if (read.bytesRead === 0) break;
    offset += read.bytesRead;
  }
  if (offset > maxBytes) {
    throw new ProjectInstructionError(
      `Project instruction exceeds the ${maxBytes} byte file limit`,
    );
  }
  return buffer.subarray(0, offset);
}

function decodeMarkdown(bytes: Uint8Array, candidate: string): string {
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProjectInstructionError(
      `Project instruction is not valid UTF-8: ${candidate}`,
    );
  }
  if (content.startsWith("\uFEFF")) content = content.slice(1);
  if (content.includes("\0")) {
    throw new ProjectInstructionError(
      `Project instruction contains NUL: ${candidate}`,
    );
  }
  return content;
}

async function canonicalWorkspace(workspace: string): Promise<string> {
  if (workspace.length === 0 || workspace.includes("\0")) {
    throw new ProjectInstructionError("Workspace must be a non-empty path without NUL");
  }
  let canonical: string;
  try {
    canonical = await realpath(path.resolve(workspace));
    const info = await lstat(canonical);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new ProjectInstructionError("Workspace must resolve to a real directory");
    }
  } catch (error: unknown) {
    if (error instanceof ProjectInstructionError) throw error;
    throw new ProjectInstructionError(
      `Cannot resolve workspace ${workspace}: ${errorText(error)}`,
    );
  }
  return canonical;
}

function ancestorDirectories(workspace: string): string[] {
  const directories: string[] = [];
  let current = workspace;
  while (true) {
    directories.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) return directories;
    current = parent;
  }
}

/**
 * A linked worktree nested below its main checkout shadows the main checkout's
 * context file at the same logical repository scope. Loading both would apply
 * one repository rule twice. This is the narrow worktree exception used by Pi.
 */
async function findShadowedContextFile(workspace: string): Promise<string | undefined> {
  const gitPaths = await findGitPaths(workspace);
  if (gitPaths === undefined) return undefined;
  const worktreeRoot = await canonicalPath(gitPaths.repoDir);
  const commonGitDir = await canonicalPath(gitPaths.commonGitDir);
  const mainRepoRoot = path.dirname(commonGitDir);
  if (!isDescendant(worktreeRoot, mainRepoRoot)) return undefined;
  const mainGitDir = await canonicalPath(path.join(mainRepoRoot, ".git"));
  if (mainGitDir !== commonGitDir) return undefined;
  const filename = await selectedInstructionFilename(worktreeRoot);
  return filename === undefined ? undefined : path.join(mainRepoRoot, filename);
}

interface GitPaths {
  repoDir: string;
  commonGitDir: string;
}

async function findGitPaths(workspace: string): Promise<GitPaths | undefined> {
  let directory = workspace;
  while (true) {
    const gitPath = path.join(directory, ".git");
    const info = await lstat(gitPath).catch((error: unknown) => {
      if (isNotFound(error)) return undefined;
      throw error;
    });
    if (info?.isFile()) {
      const source = (await readFile(gitPath, "utf8")).trim();
      if (source.startsWith("gitdir: ")) {
        const gitDir = path.resolve(directory, source.slice(8).trim());
        const commonDirSource = await readFile(path.join(gitDir, "commondir"), "utf8")
          .catch((error: unknown) => {
            if (isNotFound(error)) return undefined;
            throw error;
          });
        return {
          repoDir: directory,
          commonGitDir: commonDirSource === undefined
            ? gitDir
            : path.resolve(gitDir, commonDirSource.trim()),
        };
      }
    } else if (info?.isDirectory()) {
      return { repoDir: directory, commonGitDir: gitPath };
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

async function selectedInstructionFilename(directory: string): Promise<string | undefined> {
  for (const filename of PROJECT_INSTRUCTION_FILENAMES) {
    const info = await lstat(path.join(directory, filename)).catch((error: unknown) => {
      if (isNotFound(error)) return undefined;
      throw error;
    });
    if (info?.isFile() && !info.isSymbolicLink()) return filename;
  }
  return undefined;
}

async function canonicalPath(candidate: string): Promise<string> {
  return realpath(candidate).catch(() => path.resolve(candidate));
}

function isDescendant(candidate: string, ancestor: string): boolean {
  const relative = path.relative(ancestor, candidate);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function resolveLimits(options: ProjectInstructionLoadOptions): {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
} {
  const maxFileBytes = boundedLimit(
    options.maxFileBytes,
    MAX_PROJECT_INSTRUCTION_FILE_BYTES,
    "maxFileBytes",
  );
  const maxTotalBytes = boundedLimit(
    options.maxTotalBytes,
    MAX_PROJECT_INSTRUCTION_TOTAL_BYTES,
    "maxTotalBytes",
  );
  const maxFiles = boundedLimit(
    options.maxFiles,
    MAX_PROJECT_INSTRUCTION_FILES,
    "maxFiles",
  );
  return { maxFileBytes, maxTotalBytes, maxFiles };
}

function boundedLimit(
  value: number | undefined,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? maximum;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new ProjectInstructionError(
      `${name} must be an integer between 1 and ${maximum}`,
    );
  }
  return resolved;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
