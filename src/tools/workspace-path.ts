import { constants, realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, realpath } from "node:fs/promises";
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
  policy: WorkspacePathPolicy;
}

export interface WorkspacePathPolicy {
  protectedPaths?: readonly string[];
}

const noFollow = constants.O_NOFOLLOW ?? 0;
const protectedDirectories = new Set([
  ".aws",
  ".azure",
  ".git",
  ".gnupg",
  ".kube",
  ".nausicaa",
  ".ssh",
]);
const protectedFileNames = new Set([
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "_netrc",
  "application_default_credentials.json",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "secrets.json",
  "service-account.json",
  "service_account.json",
]);
const protectedExtensions = new Set([
  ".jks",
  ".key",
  ".keystore",
  ".p12",
  ".pem",
  ".pfx",
]);

export async function resolveExistingWorkspacePath(
  workspace: string,
  requestedPath: string,
  policy: WorkspacePathPolicy = {},
): Promise<ResolvedWorkspacePath> {
  const root = await canonicalWorkspace(workspace);
  const lexical = lexicalPath(root, requestedPath);
  const normalizedPolicy = normalizePolicy(root, policy);
  assertPathAllowed(root, lexical, normalizedPolicy);
  const target = await inspectExistingPath(root, lexical);
  return {
    workspace: root,
    absolute: target.absolute,
    relative: relativePath(root, target.absolute),
    parentIdentity: target.parentIdentity,
    policy: normalizedPolicy,
  };
}

export async function resolveWorkspaceWritePath(
  workspace: string,
  requestedPath: string,
  policy: WorkspacePathPolicy = {},
): Promise<ResolvedWorkspacePath> {
  const root = await canonicalWorkspace(workspace);
  const lexical = lexicalPath(root, requestedPath);
  const normalizedPolicy = normalizePolicy(root, policy);
  assertPathAllowed(root, lexical, normalizedPolicy);
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
      throw new WorkspacePathError(`Parent directory does not exist: ${part}`);
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
    policy: normalizedPolicy,
  };
}

export async function revalidateExistingWorkspacePath(
  resolved: ResolvedWorkspacePath,
): Promise<Stats> {
  const root = await canonicalWorkspace(resolved.workspace);
  if (root !== resolved.workspace) {
    throw new WorkspacePathError("Workspace identity changed");
  }
  assertPathAllowed(root, resolved.absolute, resolved.policy);
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
  assertPathAllowed(root, resolved.absolute, resolved.policy);
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

export function isWorkspacePathAllowed(
  workspace: string,
  candidate: string,
  policy: WorkspacePathPolicy = {},
): boolean {
  try {
    const normalizedPolicy = normalizePolicy(workspace, policy);
    assertPathAllowed(workspace, candidate, normalizedPolicy);
    return true;
  } catch (error: unknown) {
    if (error instanceof WorkspacePathError) {
      return false;
    }
    throw error;
  }
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

function assertPathAllowed(
  workspace: string,
  candidate: string,
  policy: WorkspacePathPolicy,
): void {
  assertWithin(workspace, candidate);
  const parts = path.relative(workspace, candidate).split(path.sep).filter(Boolean);
  for (const part of parts) {
    if (isSensitiveName(part)) {
      throw new WorkspacePathError("Access to a protected workspace path is denied");
    }
  }

  for (const protectedPath of policy.protectedPaths ?? []) {
    if (isWithin(protectedPath, candidate)) {
      throw new WorkspacePathError("Access to runtime state is denied");
    }
  }
}

function isSensitiveName(value: string): boolean {
  const name = value.toLowerCase();
  if (name === ".env.example") {
    return false;
  }
  return name === ".env"
    || name.startsWith(".env.")
    || protectedDirectories.has(name)
    || protectedFileNames.has(name)
    || protectedExtensions.has(path.extname(name));
}

function normalizePolicy(
  workspace: string,
  policy: WorkspacePathPolicy,
): WorkspacePathPolicy {
  const protectedPaths = (policy.protectedPaths ?? []).map((value) => {
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
      throw new WorkspacePathError("protectedPaths must contain non-empty paths without NUL");
    }
    return canonicalPolicyPath(workspace, value);
  });
  return { protectedPaths };
}

function canonicalPolicyPath(workspace: string, value: string): string {
  let current = path.resolve(workspace, value);
  const suffix: string[] = [];
  while (true) {
    try {
      const canonical = realpathSync(current);
      return path.join(canonical, ...suffix);
    } catch (error: unknown) {
      if (!isNodeError(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return path.resolve(workspace, value);
      }
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative.length === 0
    || (!path.isAbsolute(relative)
      && relative !== ".."
      && !relative.startsWith(`..${path.sep}`));
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
