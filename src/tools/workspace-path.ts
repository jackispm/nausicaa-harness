import { constants } from "node:fs";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";

export class WorkspacePathError extends Error {
  override readonly name = "WorkspacePathError";
}

interface FileIdentity {
  dev: number;
  ino: number;
}

export interface ResolvedWorkspacePath {
  workspace: string;
  absolute: string;
  relative: string;
  parentIdentity: FileIdentity;
}

const noFollow = constants.O_NOFOLLOW ?? 0;

export async function resolveExistingWorkspacePath(
  workspace: string,
  requestedPath: string,
): Promise<ResolvedWorkspacePath> {
  const root = await canonicalWorkspace(workspace);
  const lexical = lexicalPath(root, requestedPath);
  const target = await inspectExistingPath(root, lexical);
  return {
    workspace: root,
    absolute: target.absolute,
    relative: relativePath(root, target.absolute),
    parentIdentity: target.parentIdentity,
  };
}

export async function resolveWorkspaceWritePath(
  workspace: string,
  requestedPath: string,
): Promise<ResolvedWorkspacePath> {
  const root = await canonicalWorkspace(workspace);
  const lexical = lexicalPath(root, requestedPath);
  if (lexical === root) {
    throw new WorkspacePathError("A file path is required");
  }

  const relative = path.relative(root, lexical);
  const parts = relative.split(path.sep);
  const fileName = parts.pop();
  if (fileName === undefined || fileName.length === 0) {
    throw new WorkspacePathError("A file path is required");
  }

  let parent = root;
  for (const part of parts) {
    const candidate = path.join(parent, part);
    let info: Stats;
    try {
      info = await lstat(candidate);
    } catch (error: unknown) {
      if (!isNotFound(error)) throw error;
      await revalidateDirectory(root, parent);
      await mkdir(candidate, { mode: 0o700 });
      await syncDirectory(parent);
      info = await lstat(candidate);
    }

    if (info.isSymbolicLink()) {
      throw new WorkspacePathError(`Refusing symbolic-link path component: ${part}`);
    }
    if (!info.isDirectory()) {
      throw new WorkspacePathError(`Parent is not a directory: ${part}`);
    }
    const canonical = await realpath(candidate);
    assertWithin(root, canonical);
    parent = canonical;
  }

  await revalidateDirectory(root, parent);
  const absolute = path.join(parent, fileName);
  await inspectWriteTarget(absolute);
  return {
    workspace: root,
    absolute,
    relative: relativePath(root, absolute),
    parentIdentity: identity(await lstat(parent)),
  };
}

export async function revalidateExistingWorkspacePath(
  resolved: ResolvedWorkspacePath,
): Promise<Stats> {
  const root = await canonicalWorkspace(resolved.workspace);
  if (root !== resolved.workspace) {
    throw new WorkspacePathError("Workspace identity changed");
  }
  const current = await inspectExistingPath(root, resolved.absolute);
  assertSameIdentity(resolved.parentIdentity, current.parentIdentity, "Parent directory changed");
  return current.info;
}

export async function revalidateWorkspaceWritePath(
  resolved: ResolvedWorkspacePath,
): Promise<void> {
  await revalidateWorkspaceParent(resolved);
  await inspectWriteTarget(resolved.absolute);
}

export async function revalidateWorkspaceParent(
  resolved: ResolvedWorkspacePath,
): Promise<void> {
  const root = await canonicalWorkspace(resolved.workspace);
  if (root !== resolved.workspace) {
    throw new WorkspacePathError("Workspace identity changed");
  }
  const parent = path.dirname(resolved.absolute);
  const info = await revalidateDirectory(root, parent);
  assertSameIdentity(resolved.parentIdentity, identity(info), "Parent directory changed");
}

export async function openNoFollow(
  filePath: string,
  flags: number,
  mode?: number,
): Promise<FileHandle> {
  try {
    return await open(filePath, flags | noFollow, mode);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ELOOP") {
      throw new WorkspacePathError("Refusing to open a symbolic link", { cause: error });
    }
    throw error;
  }
}

export function assertSameFile(
  expected: Pick<Stats, "dev" | "ino">,
  actual: Pick<Stats, "dev" | "ino">,
): void {
  assertSameIdentity(identity(expected), identity(actual), "File identity changed");
}

export async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await openNoFollow(directory, constants.O_RDONLY);
    if (!(await handle.stat()).isDirectory()) {
      throw new WorkspacePathError("Path is not a directory");
    }
    await handle.sync();
  } catch (error: unknown) {
    const code = isNodeError(error) ? error.code : undefined;
    if (
      code !== "EINVAL"
      && code !== "ENOTSUP"
      && code !== "EISDIR"
      && code !== "EBADF"
      && code !== "EPERM"
      && code !== "EACCES"
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

export function relativePath(workspace: string, absolute: string): string {
  const relative = path.relative(workspace, absolute);
  return relative.length === 0 ? "." : relative.split(path.sep).join("/");
}

async function canonicalWorkspace(workspace: string): Promise<string> {
  if (typeof workspace !== "string" || workspace.length === 0 || workspace.includes("\0")) {
    throw new WorkspacePathError("workspace must be a non-empty path without NUL");
  }
  const lexical = path.resolve(workspace);
  const supplied = await lstat(lexical);
  if (supplied.isSymbolicLink()) {
    throw new WorkspacePathError("Refusing a symbolic-link workspace root");
  }
  if (!supplied.isDirectory()) {
    throw new WorkspacePathError("Workspace is not a directory");
  }
  const root = await realpath(lexical);
  const canonical = await lstat(root);
  if (!canonical.isDirectory() || canonical.isSymbolicLink()) {
    throw new WorkspacePathError("Workspace is not a real directory");
  }
  return root;
}

async function inspectExistingPath(
  root: string,
  requested: string,
): Promise<{ absolute: string; info: Stats; parentIdentity: FileIdentity }> {
  assertWithin(root, requested);
  const parts = path.relative(root, requested).split(path.sep).filter(Boolean);
  let current = root;
  let parentInfo = await lstat(root);
  let info = parentInfo;

  for (const [index, part] of parts.entries()) {
    const candidate = path.join(current, part);
    info = await lstat(candidate);
    if (info.isSymbolicLink()) {
      throw new WorkspacePathError(`Refusing symbolic-link path component: ${part}`);
    }
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw new WorkspacePathError(`Parent is not a directory: ${part}`);
    }
    parentInfo = index === parts.length - 1 ? await lstat(current) : info;
    current = candidate;
  }

  const absolute = await realpath(current);
  assertWithin(root, absolute);
  return { absolute, info, parentIdentity: identity(parentInfo) };
}

async function revalidateDirectory(root: string, directory: string): Promise<Stats> {
  const inspected = await inspectExistingPath(root, directory);
  if (!inspected.info.isDirectory()) {
    throw new WorkspacePathError("Parent is not a directory");
  }
  if (inspected.absolute !== directory) {
    throw new WorkspacePathError("Directory canonical path changed");
  }
  return inspected.info;
}

async function inspectWriteTarget(absolute: string): Promise<void> {
  try {
    const target = await lstat(absolute);
    if (target.isSymbolicLink()) {
      throw new WorkspacePathError("Refusing to replace a symbolic link");
    }
    if (target.isDirectory()) {
      throw new WorkspacePathError("Refusing to replace a directory");
    }
    if (!target.isFile() || target.nlink !== 1) {
      throw new WorkspacePathError("Refusing to replace a non-private regular file");
    }
  } catch (error: unknown) {
    if (!isNotFound(error)) throw error;
  }
}

function lexicalPath(workspace: string, requestedPath: string): string {
  if (typeof requestedPath !== "string" || requestedPath.length === 0) {
    throw new WorkspacePathError("path must be a non-empty string");
  }
  if (path.isAbsolute(requestedPath)) {
    throw new WorkspacePathError("Absolute paths are outside the workspace contract");
  }
  if (requestedPath.includes("\0")) {
    throw new WorkspacePathError("Path contains a NUL byte");
  }
  const resolved = path.resolve(workspace, requestedPath);
  assertWithin(workspace, resolved);
  return resolved;
}

function assertWithin(workspace: string, candidate: string): void {
  const relative = path.relative(workspace, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new WorkspacePathError("Path escapes the workspace");
  }
}

function identity(value: Pick<Stats, "dev" | "ino">): FileIdentity {
  return { dev: value.dev, ino: value.ino };
}

function assertSameIdentity(
  expected: FileIdentity,
  actual: FileIdentity,
  message: string,
): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) {
    throw new WorkspacePathError(message);
  }
}

function isNotFound(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
