import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

export class WorkspacePathError extends Error {
  override readonly name = "WorkspacePathError";
}

export async function resolveExistingWorkspacePath(
  workspace: string,
  requestedPath: string,
): Promise<{ workspace: string; absolute: string; relative: string }> {
  const root = await realpath(workspace);
  const lexical = lexicalPath(root, requestedPath);
  let absolute: string;
  try {
    absolute = await realpath(lexical);
  } catch (error: unknown) {
    throw new WorkspacePathError(`Path does not exist: ${displayPath(requestedPath)}`, { cause: error });
  }
  assertWithin(root, absolute);
  return { workspace: root, absolute, relative: relativePath(root, absolute) };
}

export async function resolveWorkspaceWritePath(
  workspace: string,
  requestedPath: string,
): Promise<{ workspace: string; absolute: string; relative: string }> {
  const root = await realpath(workspace);
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
    try {
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) {
        const target = await realpath(candidate);
        assertWithin(root, target);
        const targetStat = await lstat(target);
        if (!targetStat.isDirectory()) {
          throw new WorkspacePathError(`Parent is not a directory: ${part}`);
        }
        parent = target;
      } else if (stat.isDirectory()) {
        parent = candidate;
      } else {
        throw new WorkspacePathError(`Parent is not a directory: ${part}`);
      }
    } catch (error: unknown) {
      if (!isNotFound(error)) {
        throw error;
      }
      await mkdir(candidate);
      parent = await realpath(candidate);
      assertWithin(root, parent);
    }
  }

  const absolute = path.join(parent, fileName);
  assertWithin(root, absolute);
  try {
    const targetStat = await lstat(absolute);
    if (targetStat.isSymbolicLink()) {
      const target = await realpath(absolute);
      assertWithin(root, target);
      throw new WorkspacePathError("Refusing to replace a symbolic link");
    }
    if (targetStat.isDirectory()) {
      throw new WorkspacePathError("Refusing to replace a directory");
    }
  } catch (error: unknown) {
    if (!isNotFound(error)) {
      throw error;
    }
  }

  return { workspace: root, absolute, relative: relativePath(root, absolute) };
}

export function relativePath(workspace: string, absolute: string): string {
  const relative = path.relative(workspace, absolute);
  return relative.length === 0 ? "." : relative.split(path.sep).join("/");
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

function isNotFound(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function displayPath(value: string): string {
  return value.length > 200 ? `${value.slice(0, 197)}...` : value;
}
