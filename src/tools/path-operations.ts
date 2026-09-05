import { cp, link, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, rmdir, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";

import type { AgentTool, ToolResult, ToolExecutionContext } from "../domain/ports.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import {
  assertSameFile,
  isWorkspacePathAllowed,
  relativePath,
  resolveExistingWorkspacePath,
  resolveWorkspaceWritePath,
  revalidateExistingWorkspacePath,
  revalidateWorkspaceParent,
  type ResolvedWorkspacePath,
  type WorkspacePathPolicy,
} from "./workspace-path.js";

/**
 * Workspace path mutations that are intentionally separate from text writes.
 *
 * `write_file` and `edit` cover the common coding path, but a model also needs
 * to be able to create a directory, move an artifact, copy a fixture, or
 * remove a stale file without falling back to a privileged shell.  All four
 * operations retain the same lexical/protected/no-follow policy as the text
 * tools.  They are opt-in through `allowWrite` because they mutate the
 * workspace and cannot be safely advertised on a read-only lane.
 */

const MAX_PATH_LENGTH = 16 * 1024;
const MAX_COPY_BYTES = 16 * 1024 * 1024;

/**
 * The directory resolver keeps the missing suffix explicit.  Calling
 * `mkdir(..., { recursive: true })` for the whole path lets a path component
 * be swapped for a symlink between checks; creating one component at a time
 * gives us a revalidation point around every mutation.
 */
interface DirectoryWriteTarget extends ResolvedWorkspacePath {
  readonly existingParent: string;
  readonly missingParts: readonly string[];
}

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

export function createDirectoryCreateTool(policy: WorkspacePathPolicy = {}): AgentTool {
  const pathPolicy = snapshotPolicy(policy);
  return {
    definition: {
      name: "directory_create",
      description: "Create one workspace directory. Parent directories must already exist unless parents is true.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative directory path" },
          parents: { type: "boolean", description: "Create missing parent directories (default: false)" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    async execute(arguments_, context): Promise<ToolResult> {
      try {
        throwIfAborted(context.signal);
        const requestedPath = requiredPath(arguments_.path);
        const parents = optionalBoolean(arguments_.parents, "parents") ?? false;
        const result = await createDirectory(context, requestedPath, parents, pathPolicy);
        return success(result);
      } catch (error: unknown) {
        return failure(error instanceof Error ? error.message : "Directory creation failed");
      }
    },
  };
}

export function createPathDeleteTool(policy: WorkspacePathPolicy = {}): AgentTool {
  const pathPolicy = snapshotPolicy(policy);
  return {
    definition: {
      name: "path_delete",
      description: "Delete one workspace file or directory. Directories must be empty unless recursive is true.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file or directory path" },
          recursive: { type: "boolean", description: "Delete a directory tree (default: false)" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    async execute(arguments_, context): Promise<ToolResult> {
      try {
        throwIfAborted(context.signal);
        const requestedPath = requiredPath(arguments_.path);
        const recursive = optionalBoolean(arguments_.recursive, "recursive") ?? false;
        const result = await deletePath(context, requestedPath, recursive, pathPolicy);
        return success(result);
      } catch (error: unknown) {
        return failure(error instanceof Error ? error.message : "Path deletion failed");
      }
    },
  };
}

export function createPathMoveTool(policy: WorkspacePathPolicy = {}): AgentTool {
  const pathPolicy = snapshotPolicy(policy);
  return {
    definition: {
      name: "path_move",
      description: "Move one workspace file or directory to another workspace path atomically.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Existing workspace-relative source path" },
          to: { type: "string", description: "Workspace-relative destination path" },
          overwrite: { type: "boolean", description: "Replace an existing regular file (default: false)" },
        },
        required: ["from", "to"],
        additionalProperties: false,
      },
    },
    async execute(arguments_, context): Promise<ToolResult> {
      try {
        throwIfAborted(context.signal);
        const from = requiredPath(arguments_.from, "from");
        const to = requiredPath(arguments_.to, "to");
        const overwrite = optionalBoolean(arguments_.overwrite, "overwrite") ?? false;
        const result = await movePath(context, from, to, overwrite, pathPolicy);
        return success(result);
      } catch (error: unknown) {
        return failure(error instanceof Error ? error.message : "Path move failed");
      }
    },
  };
}

export function createPathCopyTool(policy: WorkspacePathPolicy = {}): AgentTool {
  const pathPolicy = snapshotPolicy(policy);
  return {
    definition: {
      name: "path_copy",
      description: "Copy one workspace file or directory to another workspace path.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Existing workspace-relative source path" },
          to: { type: "string", description: "Workspace-relative destination path" },
          overwrite: { type: "boolean", description: "Replace an existing regular file (default: false)" },
        },
        required: ["from", "to"],
        additionalProperties: false,
      },
    },
    async execute(arguments_, context): Promise<ToolResult> {
      try {
        throwIfAborted(context.signal);
        const from = requiredPath(arguments_.from, "from");
        const to = requiredPath(arguments_.to, "to");
        const overwrite = optionalBoolean(arguments_.overwrite, "overwrite") ?? false;
        const result = await copyPath(context, from, to, overwrite, pathPolicy);
        return success(result);
      } catch (error: unknown) {
        return failure(error instanceof Error ? error.message : "Path copy failed");
      }
    },
  };
}

export const directoryCreateTool = createDirectoryCreateTool();
export const pathDeleteTool = createPathDeleteTool();
export const pathMoveTool = createPathMoveTool();
export const pathCopyTool = createPathCopyTool();

async function createDirectory(
  context: ToolExecutionContext,
  requestedPath: string,
  parents: boolean,
  policy: WorkspacePathPolicy,
): Promise<{ path: string; created: boolean; parents: boolean }> {
  // Resolve the parent first, keeping directory creation consistent with
  // write_file: no implicit workspace escape and no symlink components.
  try {
    const existing = await resolveExistingWorkspacePath(context.workspace, requestedPath, policy);
    const info = await revalidateExistingWorkspacePath(existing);
    if (!info.isDirectory()) throw new Error("Destination exists and is not a directory");
    return { path: existing.relative, created: false, parents };
  } catch (error: unknown) {
    if (!isNotFound(error)) throw error;
  }
  const target = await resolveDirectoryWritePath(context.workspace, requestedPath, policy, parents);
  return await withMutationLocks(directoryCreationLockPaths(target), async () => {
    throwIfAborted(context.signal);
    const created = await createDirectoryComponents(context, target, policy);
    return { path: target.relative, created, parents };
  });
}

async function deletePath(
  context: ToolExecutionContext,
  requestedPath: string,
  recursive: boolean,
  policy: WorkspacePathPolicy,
): Promise<{ path: string; type: "file" | "directory" | "other"; deleted: boolean; recursive: boolean }> {
  const target = await resolveExistingWorkspacePath(context.workspace, requestedPath, policy);
  if (target.relative === ".") throw new Error("The workspace root cannot be deleted");
  const before = await revalidateExistingWorkspacePath(target);
  const type = before.isFile() ? "file" : before.isDirectory() ? "directory" : "other";
  if (type === "other") throw new Error("Only regular files and directories can be deleted");
  if (before.isFile() && before.nlink !== 1) {
    throw new Error("Only private regular files can be deleted");
  }
  if (type === "directory" && !recursive) {
    // rm({ recursive: false }) gives a platform-specific error for a non-empty
    // directory.  Make the contract explicit before touching the filesystem.
    const children = await readdir(target.absolute);
    if (children.length > 0) throw new Error("Directory is not empty; set recursive to true");
  }
  if (type === "directory" && recursive) {
    await assertDeletableTree(target.absolute, target.workspace, target.policy);
  }
  return await withFileMutationQueue(target.absolute, async () => {
    throwIfAborted(context.signal);
    const current = await revalidateExistingWorkspacePath(target);
    assertSameFile(before, current);
    if (current.isFile() && current.nlink !== 1) {
      throw new Error("Only private regular files can be deleted");
    }
    if (current.isDirectory() && recursive) {
      await quarantineAndDeleteTree(target, current);
    } else {
      await rm(target.absolute, { recursive, force: false, maxRetries: 0 });
    }
    return { path: target.relative, type, deleted: true, recursive };
  });
}

async function movePath(
  context: ToolExecutionContext,
  from: string,
  to: string,
  overwrite: boolean,
  policy: WorkspacePathPolicy,
): Promise<{ from: string; to: string; type: "file" | "directory" | "other" }> {
  const source = await resolveExistingWorkspacePath(context.workspace, from, policy);
  if (source.relative === ".") throw new Error("The workspace root cannot be moved");
  const sourceStat = await revalidateExistingWorkspacePath(source);
  const type = sourceStat.isFile() ? "file" : sourceStat.isDirectory() ? "directory" : "other";
  if (type === "other") throw new Error("Only regular files and directories can be moved");
  if (sourceStat.isFile() && sourceStat.nlink !== 1) {
    throw new Error("Source is not a private regular file");
  }
  const destination = await resolveWorkspaceWritePath(context.workspace, to, policy);
  if (source.absolute === destination.absolute) throw new Error("Source and destination are identical");
  if (type === "directory" && isWithin(source.absolute, destination.absolute)) {
    throw new Error("A directory cannot be moved inside itself");
  }
  if (type === "directory") {
    await assertMovableTree(source.absolute, source.workspace, source.policy);
  }
  await assertDestinationAvailable(destination, overwrite);
  return await withMutationLocks([source.absolute, destination.absolute], async () => {
    throwIfAborted(context.signal);
    const currentSource = await revalidateExistingWorkspacePath(source);
    assertSameFile(sourceStat, currentSource);
    if (currentSource.isFile() && currentSource.nlink !== 1) {
      throw new Error("Source is not a private regular file");
    }
    if (currentSource.isDirectory()) {
      await assertMovableTree(source.absolute, source.workspace, source.policy);
    }
    await revalidateWorkspaceParent(destination);
    await assertDestinationAvailable(destination, overwrite);
    if (overwrite) {
      await rename(source.absolute, destination.absolute);
    } else {
      await promoteNoOverwrite(source.absolute, destination, type, async () => {
        const latestSource = await revalidateExistingWorkspacePath(source);
        assertSameFile(sourceStat, latestSource);
        if (latestSource.isFile() && latestSource.nlink !== 1) {
          throw new Error("Source is not a private regular file");
        }
        if (latestSource.isDirectory()) {
          await assertMovableTree(source.absolute, source.workspace, source.policy);
        }
      });
    }
    return { from: source.relative, to: destination.relative, type };
  });
}

async function copyPath(
  context: ToolExecutionContext,
  from: string,
  to: string,
  overwrite: boolean,
  policy: WorkspacePathPolicy,
): Promise<{ from: string; to: string; type: "file" | "directory" | "other"; bytes?: number }> {
  const source = await resolveExistingWorkspacePath(context.workspace, from, policy);
  if (source.relative === ".") throw new Error("The workspace root cannot be copied");
  const sourceStat = await revalidateExistingWorkspacePath(source);
  const type = sourceStat.isFile() ? "file" : sourceStat.isDirectory() ? "directory" : "other";
  if (type === "other") throw new Error("Only regular files and directories can be copied");
  if (sourceStat.isFile() && sourceStat.nlink !== 1) throw new Error("Source is not a private regular file");
  if (sourceStat.isFile() && sourceStat.size > MAX_COPY_BYTES) {
    throw new Error(`Source exceeds the ${MAX_COPY_BYTES}-byte copy limit`);
  }
  const destination = await resolveWorkspaceWritePath(context.workspace, to, policy);
  if (source.absolute === destination.absolute) throw new Error("Source and destination are identical");
  if (type === "directory" && isWithin(source.absolute, destination.absolute)) {
    throw new Error("A directory cannot be copied inside itself");
  }
  await assertDestinationAvailable(destination, overwrite);
  return await withMutationLocks([source.absolute, destination.absolute], async () => {
    throwIfAborted(context.signal);
    const currentSource = await revalidateExistingWorkspacePath(source);
    assertSameFile(sourceStat, currentSource);
    await revalidateWorkspaceParent(destination);
    const destinationStat = await assertDestinationAvailable(destination, overwrite);
    const stagingRoot = await mkdtemp(path.join(path.dirname(destination.absolute), ".nausicaa-copy-"));
    const stagedPath = path.join(stagingRoot, "payload");
    let preserveStaging = false;
    try {
      // Copy into an isolated sibling first. Recursive filters can now fail
      // without exposing a partially-populated destination to other tools.
      let copiedBytes = 0;
      await cp(source.absolute, stagedPath, {
        recursive: type === "directory",
        force: false,
        errorOnExist: true,
        dereference: false,
        filter: async (entry) => {
          throwIfAborted(context.signal);
          const info = await lstat(entry);
          if (!isWorkspacePathAllowed(source.workspace, entry, policy)) {
            throw new Error("Copy source contains a protected workspace path");
          }
          if (info.isSymbolicLink()) throw new Error("Refusing symbolic links during copy");
          if (info.isFile()) {
            if (info.nlink !== 1) throw new Error("Refusing non-private regular file during copy");
            copiedBytes += info.size;
            if (copiedBytes > MAX_COPY_BYTES) {
              throw new Error(`Source tree exceeds the ${MAX_COPY_BYTES}-byte copy limit`);
            }
          }
          return true;
        },
      });
      throwIfAborted(context.signal);
      const afterCopySource = await revalidateExistingWorkspacePath(source);
      assertSameFile(sourceStat, afterCopySource);
      await revalidateWorkspaceParent(destination);
      const currentDestination = await assertDestinationAvailable(destination, overwrite);
      assertSameOptionalFile(destinationStat, currentDestination);
      let stagedBytes: number;
      try {
        stagedBytes = await promoteStagedCopy(
          stagedPath,
          stagingRoot,
          destination,
          currentDestination,
          overwrite,
          type,
          source.absolute,
          source.workspace,
          source.policy,
        );
      } catch (error: unknown) {
        preserveStaging = error instanceof CopyRollbackError;
        throw error;
      }
      return {
        from: source.relative,
        to: destination.relative,
        type,
        ...(type === "file" ? { bytes: stagedBytes } : {}),
      };
    } finally {
      if (!preserveStaging) {
        await rm(stagingRoot, { recursive: true, force: true, maxRetries: 0 });
      }
    }
  });
}

/**
 * Create a missing directory suffix one component at a time.
 *
 * Node's `mkdir` does not expose an `mkdirat(2)`-style directory handle, so a
 * hostile process can still race a path component between the checks and the
 * syscall.  Revalidating the parent and the newly-created component on both
 * sides of every syscall is the strongest boundary available to this API and
 * ensures we detect (and report) a swap before returning success.
 */
async function createDirectoryComponents(
  context: ToolExecutionContext,
  target: DirectoryWriteTarget,
  policy: WorkspacePathPolicy,
): Promise<boolean> {
  let parent = target.existingParent;
  let parentState = await inspectCreationDirectory(target.workspace, parent, policy);
  let created = false;

  for (const part of target.missingParts) {
    throwIfAborted(context.signal);
    parentState = await revalidateCreationDirectory(
      target.workspace,
      parent,
      parentState.identity,
      policy,
    );
    const candidate = path.join(parent, part);
    if (!isWorkspacePathAllowed(target.workspace, candidate, policy)) {
      throw new Error("Access to a protected workspace path is denied");
    }

    let candidateInfo: Awaited<ReturnType<typeof lstat>>;
    let createdThisComponent = false;
    try {
      candidateInfo = await lstat(candidate);
    } catch (error: unknown) {
      if (!isNotFound(error)) throw error;
      try {
        // Deliberately avoid recursive mkdir: only the validated parent is
        // allowed to be traversed by this syscall.
        await mkdir(candidate, { recursive: false, mode: 0o755 });
        createdThisComponent = true;
      } catch (mkdirError: unknown) {
        // Another creator may have won the race.  Re-lstat and apply the same
        // no-follow/type checks instead of treating EEXIST as success.
        if (!isAlreadyExists(mkdirError)) throw mkdirError;
      }
      candidateInfo = await lstat(candidate);
    }

    assertDirectoryComponent(candidate, candidateInfo);
    const canonicalCandidate = await realpath(candidate);
    assertCanonicalDirectoryComponent(target.workspace, candidate, canonicalCandidate, policy);

    // Verify that neither the parent nor the child was replaced while the
    // component was being inspected/created.
    await revalidateCreationDirectory(target.workspace, parent, parentState.identity, policy);
    const afterCandidate = await lstat(candidate);
    assertDirectoryComponent(candidate, afterCandidate);
    assertSameDirectoryIdentity(candidateInfo, afterCandidate, "Directory component changed while creating path");
    const canonicalAfter = await realpath(candidate);
    assertCanonicalDirectoryComponent(target.workspace, candidate, canonicalAfter, policy);

    created ||= createdThisComponent;
    parent = canonicalAfter;
    parentState = {
      info: afterCandidate,
      identity: directoryIdentity(afterCandidate),
    };
  }

  // A final full-path check catches a component that was swapped after the
  // last per-component check and keeps the returned path canonical.
  const completed = await resolveExistingWorkspacePath(target.workspace, target.relative, policy);
  const completedInfo = await revalidateExistingWorkspacePath(completed);
  if (!completedInfo.isDirectory() || completedInfo.isSymbolicLink()) {
    throw new Error("Destination exists and is not a directory");
  }
  return created;
}

function directoryCreationLockPaths(target: DirectoryWriteTarget): string[] {
  const paths: string[] = [];
  let current = target.workspace;
  for (const part of path.relative(target.workspace, target.absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    paths.push(current);
  }
  return paths;
}

async function inspectCreationDirectory(
  workspace: string,
  directory: string,
  policy: WorkspacePathPolicy,
): Promise<{ readonly info: Awaited<ReturnType<typeof lstat>>; readonly identity: DirectoryIdentity }> {
  if (!isWithin(workspace, directory) || !isWorkspacePathAllowed(workspace, directory, policy)) {
    throw new Error("Access to a protected workspace path is denied");
  }
  const info = await lstat(directory);
  if (info.isSymbolicLink()) {
    throw new Error(`Refusing symbolic-link path component: ${path.basename(directory)}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`Path component is not a directory: ${path.basename(directory)}`);
  }
  const canonical = await realpath(directory);
  assertCanonicalDirectoryComponent(workspace, directory, canonical, policy);
  return { info, identity: directoryIdentity(info) };
}

async function revalidateCreationDirectory(
  workspace: string,
  directory: string,
  expected: DirectoryIdentity,
  policy: WorkspacePathPolicy,
): Promise<{ readonly info: Awaited<ReturnType<typeof lstat>>; readonly identity: DirectoryIdentity }> {
  const current = await inspectCreationDirectory(workspace, directory, policy);
  assertSameDirectoryIdentity(current.info, expected, "Parent directory changed while creating path");
  return current;
}

function assertDirectoryComponent(
  candidate: string,
  info: Awaited<ReturnType<typeof lstat>>,
): void {
  if (info.isSymbolicLink()) {
    throw new Error(`Refusing symbolic-link path component: ${path.basename(candidate)}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`Path component is not a directory: ${path.basename(candidate)}`);
  }
}

function assertCanonicalDirectoryComponent(
  workspace: string,
  candidate: string,
  canonical: string,
  policy: WorkspacePathPolicy,
): void {
  if (canonical !== candidate || !isWithin(workspace, canonical)) {
    throw new Error(`Refusing canonical path escape: ${path.basename(candidate)}`);
  }
  if (!isWorkspacePathAllowed(workspace, canonical, policy)) {
    throw new Error("Access to a protected workspace path is denied");
  }
}

function directoryIdentity(value: { dev: number | bigint; ino: number | bigint }): DirectoryIdentity {
  return { dev: numericIdentityPart(value.dev), ino: numericIdentityPart(value.ino) };
}

function assertSameDirectoryIdentity(
  actual: { dev: number | bigint; ino: number | bigint },
  expected: DirectoryIdentity,
  message: string,
): void {
  if (numericIdentityPart(actual.dev) !== expected.dev || numericIdentityPart(actual.ino) !== expected.ino) {
    throw new Error(message);
  }
}

function numericIdentityPart(value: number | bigint): number {
  if (typeof value === "number") return value;
  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) throw new Error("Filesystem identity is out of range");
  return converted;
}

async function assertDeletableTree(
  absolute: string,
  workspace: string,
  policy: WorkspacePathPolicy,
  sourceMapping = absolute,
): Promise<void> {
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) throw new Error("Refusing symbolic links during recursive delete");
  if (info.isFile()) {
    if (info.nlink !== 1 || !isWorkspacePathAllowed(workspace, sourceMapping, policy)) {
      throw new Error("Recursive delete contains a protected or non-private file");
    }
    return;
  }
  if (!info.isDirectory() || !isWorkspacePathAllowed(workspace, sourceMapping, policy)) {
    throw new Error("Recursive delete contains an unsupported path");
  }
  for (const child of await readdir(absolute)) {
    await assertDeletableTree(
      path.join(absolute, child),
      workspace,
      policy,
      path.join(sourceMapping, child),
    );
  }
}

async function quarantineAndDeleteTree(
  target: ResolvedWorkspacePath,
  expected: Stats,
): Promise<void> {
  const quarantine = await mkdtemp(path.join(path.dirname(target.absolute), ".nausicaa-delete-"));
  const reservation = await lstat(quarantine);
  let moved = false;
  let ownsQuarantinedTree = false;
  try {
    await assertOwnedPlaceholder(quarantine, reservation, "directory");
    await rename(target.absolute, quarantine);
    moved = true;
    assertSameFile(expected, await lstat(quarantine));
    ownsQuarantinedTree = true;
    await assertMissing(target.absolute, "Delete target was recreated while quarantining");
    await assertDeletableTree(quarantine, target.workspace, target.policy, target.absolute);
    await rm(quarantine, { recursive: true, force: false, maxRetries: 0 });
  } catch (error: unknown) {
    if (!moved) {
      await removeOwnedPlaceholder(quarantine, reservation);
      throw error;
    }
    if (!ownsQuarantinedTree) {
      throw new DeleteRollbackError(
        `Recursive delete failed after the quarantine identity changed; refusing rollback at ${quarantine}`,
        { cause: error },
      );
    }
    try {
      assertSameFile(expected, await lstat(quarantine));
      await promoteNoOverwrite(quarantine, target, "directory");
    } catch (rollbackError: unknown) {
      throw new DeleteRollbackError(
        `Recursive delete failed and could not restore the target; quarantine retained at ${quarantine}`,
        { cause: rollbackError },
      );
    }
    throw error;
  }
}

async function assertMovableTree(
  absolute: string,
  workspace: string,
  policy: WorkspacePathPolicy,
): Promise<void> {
  if (!isWorkspacePathAllowed(workspace, absolute, policy)) {
    throw new Error("Move source contains a protected workspace path");
  }
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) return;
  for (const child of await readdir(absolute)) {
    await assertMovableTree(path.join(absolute, child), workspace, policy);
  }
}

async function assertStagedCopyTree(
  stagedRoot: string,
  sourceRoot: string,
  workspace: string,
  policy: WorkspacePathPolicy,
  expectedType: "file" | "directory",
): Promise<number> {
  let bytes = 0;
  const visit = async (candidate: string): Promise<void> => {
    const relative = path.relative(stagedRoot, candidate);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new Error("Staged copy escaped its transaction directory");
    }
    const sourceMapping = relative.length === 0
      ? sourceRoot
      : path.join(sourceRoot, relative);
    if (!isWorkspacePathAllowed(workspace, sourceMapping, policy)) {
      throw new Error("Copy staging contains a protected source mapping");
    }

    const info = await lstat(candidate);
    if (info.isSymbolicLink()) throw new Error("Refusing symbolic links in copy staging");
    if (info.isFile()) {
      if (info.nlink !== 1) throw new Error("Refusing non-private regular files in copy staging");
      bytes += info.size;
      if (bytes > MAX_COPY_BYTES) {
        throw new Error(`Staged copy exceeds the ${MAX_COPY_BYTES}-byte copy limit`);
      }
      return;
    }
    if (!info.isDirectory()) throw new Error("Copy staging contains an unsupported path type");
    for (const child of await readdir(candidate)) {
      await visit(path.join(candidate, child));
    }
  };

  const rootInfo = await lstat(stagedRoot);
  if ((expectedType === "file" && !rootInfo.isFile())
    || (expectedType === "directory" && !rootInfo.isDirectory())) {
    throw new Error("Copy staging root type changed");
  }
  await visit(stagedRoot);
  return bytes;
}

async function promoteNoOverwrite(
  source: string,
  destination: ResolvedWorkspacePath,
  type: "file" | "directory",
  beforeCommit?: () => Promise<void>,
): Promise<void> {
  if (type === "file") {
    await promoteFileNoOverwrite(source, destination, beforeCommit);
    return;
  }
  const reservation = await reserveDestination(destination, type);
  let committed = false;
  try {
    await beforeCommit?.();
    await assertOwnedPlaceholder(destination.absolute, reservation, type);
    await rename(source, destination.absolute);
    committed = true;
  } finally {
    if (!committed) await removeOwnedPlaceholder(destination.absolute, reservation);
  }
}

async function promoteFileNoOverwrite(
  source: string,
  destination: ResolvedWorkspacePath,
  beforeLink?: () => Promise<void>,
): Promise<void> {
  await revalidateWorkspaceParent(destination);
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.nlink !== 1) {
    throw new Error("Source is not a private regular file");
  }
  await beforeLink?.();
  const currentSource = await lstat(source);
  assertSameFile(sourceInfo, currentSource);
  if (!currentSource.isFile() || currentSource.nlink !== 1) {
    throw new Error("Source is not a private regular file");
  }
  try {
    await link(source, destination.absolute);
  } catch (error: unknown) {
    if (isAlreadyExists(error)) {
      throw new Error("Destination already exists; overwrite is false");
    }
    throw error;
  }

  try {
    const published = await lstat(destination.absolute);
    const linkedSource = await lstat(source);
    assertSameFile(sourceInfo, published);
    assertSameFile(sourceInfo, linkedSource);
    if (published.nlink !== 2 || linkedSource.nlink !== 2) {
      throw new Error("Published file gained an unexpected hard link");
    }
    await unlink(source);
  } catch (error: unknown) {
    await removeOwnedFileLink(destination.absolute, sourceInfo);
    throw error;
  }
}

async function removeOwnedFileLink(absolute: string, sourceInfo: Stats): Promise<void> {
  let current: Stats;
  try {
    current = await lstat(absolute);
  } catch (error: unknown) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (current.dev !== sourceInfo.dev || current.ino !== sourceInfo.ino) return;
  await unlink(absolute);
}

async function reserveDestination(
  destination: ResolvedWorkspacePath,
  type: "directory",
): Promise<Stats> {
  await revalidateWorkspaceParent(destination);
  let reservation: Stats;
  try {
    await mkdir(destination.absolute, { recursive: false, mode: 0o700 });
    reservation = await lstat(destination.absolute);
  } catch (error: unknown) {
    if (isAlreadyExists(error)) {
      throw new Error("Destination already exists; overwrite is false");
    }
    throw error;
  }

  try {
    await revalidateWorkspaceParent(destination);
    await assertOwnedPlaceholder(destination.absolute, reservation, type);
    return reservation;
  } catch (error: unknown) {
    await removeOwnedPlaceholder(destination.absolute, reservation);
    throw error;
  }
}

async function assertOwnedPlaceholder(
  absolute: string,
  expected: Stats,
  type: "directory",
): Promise<void> {
  const current = await lstat(absolute);
  assertSameFile(expected, current);
  if (type === "directory" && !current.isDirectory()) {
    throw new Error("Destination reservation changed before commit");
  }
}

async function removeOwnedPlaceholder(absolute: string, expected: Stats): Promise<void> {
  let current: Stats;
  try {
    current = await lstat(absolute);
  } catch (error: unknown) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (current.dev !== expected.dev || current.ino !== expected.ino) return;
  if (current.isDirectory()) {
    try {
      await rmdir(absolute);
    } catch (error: unknown) {
      if (!isDirectoryNotEmpty(error)) throw error;
    }
  } else {
    await rm(absolute, { recursive: false, force: false, maxRetries: 0 });
  }
}

class CopyRollbackError extends Error {
  override readonly name = "CopyRollbackError";
}

class DeleteRollbackError extends Error {
  override readonly name = "DeleteRollbackError";
}

async function promoteStagedCopy(
  stagedPath: string,
  stagingRoot: string,
  destination: ResolvedWorkspacePath,
  existing: Stats | undefined,
  overwrite: boolean,
  type: "file" | "directory",
  sourceRoot: string,
  workspace: string,
  policy: WorkspacePathPolicy,
): Promise<number> {
  if (existing === undefined) {
    if (overwrite) {
      const bytes = await assertStagedCopyTree(stagedPath, sourceRoot, workspace, policy, type);
      await rename(stagedPath, destination.absolute);
      return bytes;
    } else {
      if (type === "file") {
        let bytes = 0;
        await promoteFileNoOverwrite(stagedPath, destination, async () => {
          bytes = await assertStagedCopyTree(stagedPath, sourceRoot, workspace, policy, type);
        });
        return bytes;
      }
      const reservation = await reserveDestination(destination, type);
      let committed = false;
      try {
        const bytes = await assertStagedCopyTree(stagedPath, sourceRoot, workspace, policy, type);
        await assertOwnedPlaceholder(destination.absolute, reservation, type);
        await rename(stagedPath, destination.absolute);
        committed = true;
        return bytes;
      } finally {
        if (!committed) await removeOwnedPlaceholder(destination.absolute, reservation);
      }
    }
  }

  const backupPath = path.join(stagingRoot, "previous");
  await rename(destination.absolute, backupPath);
  try {
    assertSameFile(existing, await lstat(backupPath));
    await revalidateWorkspaceParent(destination);
    await assertMissing(destination.absolute, "Copy destination changed while committing");
    const bytes = await assertStagedCopyTree(stagedPath, sourceRoot, workspace, policy, type);
    await rename(stagedPath, destination.absolute);
    return bytes;
  } catch (error: unknown) {
    try {
      await assertMissing(destination.absolute, "Copy destination changed during rollback");
      await rename(backupPath, destination.absolute);
    } catch (rollbackError: unknown) {
      throw new CopyRollbackError(
        `Copy failed and the previous destination could not be restored; backup retained at ${backupPath}`,
        { cause: rollbackError },
      );
    }
    throw error;
  }
}

function assertSameOptionalFile(
  expected: Stats | undefined,
  actual: Stats | undefined,
): void {
  if (expected === undefined && actual === undefined) return;
  if (expected === undefined || actual === undefined) {
    throw new Error("Copy destination changed while staging");
  }
  assertSameFile(expected, actual);
}

async function assertMissing(absolute: string, message: string): Promise<void> {
  try {
    await lstat(absolute);
  } catch (error: unknown) {
    if (isNotFound(error)) return;
    throw error;
  }
  throw new Error(message);
}

async function assertDestinationAvailable(
  destination: ResolvedWorkspacePath,
  overwrite: boolean,
): Promise<Stats | undefined> {
  try {
    const info = await lstat(destination.absolute);
    if (info.isSymbolicLink()) throw new Error("Refusing to replace a symbolic link");
    if (info.isDirectory()) throw new Error("Destination is a directory");
    if (!info.isFile() || info.nlink !== 1) throw new Error("Destination is not a private regular file");
    if (!overwrite) throw new Error("Destination already exists; set overwrite to true");
    return info;
  } catch (error: unknown) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function resolveDirectoryWritePath(
  workspace: string,
  requestedPath: string,
  policy: WorkspacePathPolicy,
  parents: boolean,
): Promise<DirectoryWriteTarget> {
  if (!parents) {
    const resolved = await resolveWorkspaceWritePath(workspace, requestedPath, policy);
    return {
      ...resolved,
      existingParent: path.dirname(resolved.absolute),
      missingParts: [path.basename(resolved.absolute)],
    };
  }
  // For recursive creation, resolve the lexical path and find the deepest
  // existing parent.  Every existing component still goes through the same
  // no-follow/protected checks; mkdir itself only creates the missing suffix.
  let existing: ResolvedWorkspacePath | undefined;
  try {
    existing = await resolveExistingWorkspacePath(workspace, requestedPath, policy);
  } catch (error: unknown) {
    if (!isNotFound(error)) throw error;
  }
  if (existing !== undefined) {
    const info = await revalidateExistingWorkspacePath(existing);
    if (!info.isDirectory()) throw new Error("Destination exists and is not a directory");
    return {
      ...existing,
      existingParent: path.dirname(existing.absolute),
      missingParts: [],
    };
  }

  const root = await resolveExistingWorkspacePath(workspace, ".", policy);
  const absolute = path.resolve(root.workspace, requestedPath);
  if (path.isAbsolute(requestedPath) || !isWithin(root.workspace, absolute)) {
    throw new Error("Path escapes the workspace");
  }
  if (!isWorkspacePathAllowed(root.workspace, absolute, policy)) {
    throw new Error("Access to a protected workspace path is denied");
  }
  const relative = relativePath(root.workspace, absolute);
  if (relative === ".") throw new Error("A directory path below the workspace root is required");
  let current = absolute;
  const missingParts: string[] = [];
  while (current !== root.workspace) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new Error(`Refusing symbolic-link path component: ${path.basename(current)}`);
      }
      if (!info.isDirectory()) {
        throw new Error(`Path component is not a directory: ${path.basename(current)}`);
      }
      break;
    } catch (error: unknown) {
      if (!isNotFound(error)) throw error;
      missingParts.unshift(path.basename(current));
      current = path.dirname(current);
    }
  }
  const parentRelative = relativePath(root.workspace, current);
  const resolvedParent = parentRelative === "."
    ? root
    : await resolveExistingWorkspacePath(root.workspace, parentRelative, policy);
  const targetAbsolute = path.join(resolvedParent.absolute, ...missingParts);
  const targetRelative = relativePath(root.workspace, targetAbsolute);
  return {
    workspace: root.workspace,
    absolute: targetAbsolute,
    relative: targetRelative,
    parentIdentity: resolvedParent.parentIdentity,
    policy: resolvedParent.policy,
    existingParent: resolvedParent.absolute,
    missingParts,
  };
}

async function withMutationLocks<T>(paths: readonly string[], operation: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(paths)].sort();
  const acquire = async (index: number): Promise<T> => {
    const key = ordered[index];
    if (key === undefined) return operation();
    return await withFileMutationQueue(key, () => acquire(index + 1));
  };
  return await acquire(0);
}

function snapshotPolicy(policy: WorkspacePathPolicy): WorkspacePathPolicy {
  return { protectedPaths: [...(policy.protectedPaths ?? [])] };
}

function requiredPath(value: unknown, name = "path"): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  if (value.length > MAX_PATH_LENGTH || value.includes("\0")) {
    throw new TypeError(`${name} exceeds the path limit or contains NUL`);
  }
  return value;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
  return value;
}

function success(value: unknown): ToolResult {
  return { content: JSON.stringify(value), isError: false };
}

function failure(message: string): ToolResult {
  return { content: JSON.stringify({ error: message }), isError: true };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted", "AbortError");
  }
}

function isNotFound(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "EEXIST";
}

function isDirectoryNotEmpty(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && ((error as { code?: unknown }).code === "ENOTEMPTY"
      || (error as { code?: unknown }).code === "EEXIST");
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative.length === 0
    || (!path.isAbsolute(relative)
      && relative !== ".."
      && !relative.startsWith(`..${path.sep}`));
}
