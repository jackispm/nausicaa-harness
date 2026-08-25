import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";

export class UnsafeFilesystemPathError extends Error {
  override readonly name = "UnsafeFilesystemPathError";
}

const noFollow = constants.O_NOFOLLOW ?? 0;
const directoryOnly = constants.O_DIRECTORY ?? 0;
let trustedSymlinksPromise: Promise<Set<string>> | undefined;

function pathComponents(path: string): string[] {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const remainder = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean);
  const components: string[] = [];
  let current = root;
  for (const part of remainder) {
    current = join(current, part);
    components.push(current);
  }
  return components;
}

async function trustedSymlinkComponents(): Promise<Set<string>> {
  if (trustedSymlinksPromise !== undefined) {
    return trustedSymlinksPromise;
  }

  trustedSymlinksPromise = (async () => {
    const trusted = new Set<string>();
    for (const base of [process.cwd(), tmpdir()]) {
      for (const component of pathComponents(base)) {
        try {
          if ((await lstat(component)).isSymbolicLink()) {
            trusted.add(component);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
          throw error;
        }
      }
    }
    return trusted;
  })();
  return trustedSymlinksPromise;
}

export async function assertNoSymlinkComponents(path: string): Promise<void> {
  const trusted = await trustedSymlinkComponents();
  for (const component of pathComponents(path)) {
    try {
      const info = await lstat(component);
      if (info.isSymbolicLink() && !trusted.has(component)) {
        throw new UnsafeFilesystemPathError(
          `Refusing symbolic-link path component: ${component}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export async function canonicalFilePath(path: string): Promise<{
  path: string;
  parent: string;
}> {
  const resolved = resolve(path);
  await assertNoSymlinkComponents(resolved);

  const parent = dirname(resolved);
  let parentExisted = true;
  try {
    await lstat(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    parentExisted = false;
  }
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new UnsafeFilesystemPathError(
      `Unable to prepare parent directory ${parent}: ${String(error)}`,
    );
  }

  await assertNoSymlinkComponents(resolved);
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new UnsafeFilesystemPathError(`Ledger parent is not a real directory: ${parent}`);
  }

  const canonicalParent = await realpath(parent);
  const canonicalPath = join(canonicalParent, basename(resolved));
  try {
    const targetInfo = await lstat(canonicalPath);
    if (targetInfo.isSymbolicLink()) {
      throw new UnsafeFilesystemPathError(
        `Refusing symbolic-link file: ${canonicalPath}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (!parentExisted) {
    await syncDirectory(dirname(canonicalParent));
  }
  return { path: canonicalPath, parent: canonicalParent };
}

export async function ensureRealDirectory(path: string): Promise<{
  path: string;
  created: boolean;
}> {
  const resolved = resolve(path);
  await assertNoSymlinkComponents(resolved);
  let existed = true;
  try {
    await lstat(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    existed = false;
  }
  let created = false;
  try {
    await mkdir(resolved, { recursive: true, mode: 0o700 });
    created = !existed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  await assertNoSymlinkComponents(resolved);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new UnsafeFilesystemPathError(`Path is not a real directory: ${resolved}`);
  }
  const canonical = await realpath(resolved);
  if (created) {
    await syncDirectory(dirname(canonical));
  }
  return { path: canonical, created };
}

export async function assertRealDirectory(path: string): Promise<string> {
  const resolved = resolve(path);
  await assertNoSymlinkComponents(resolved);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new UnsafeFilesystemPathError(`Path is not a real directory: ${resolved}`);
  }
  return realpath(resolved);
}

export function assertWithinRoot(root: string, target: string): void {
  const pathFromRoot = relative(root, target);
  if (
    pathFromRoot === ""
    || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  ) {
    return;
  }
  throw new UnsafeFilesystemPathError(`Path escapes storage root: ${target}`);
}

export async function openNoFollow(
  path: string,
  flags: number,
  mode?: number,
): Promise<FileHandle> {
  return open(path, flags | noFollow, mode);
}

export async function assertRegularFile(
  handle: FileHandle,
  path: string,
  requireSingleLink = false,
): Promise<void> {
  const info = await handle.stat();
  if (!info.isFile() || (requireSingleLink && info.nlink !== 1)) {
    throw new UnsafeFilesystemPathError(`Path is not a private regular file: ${path}`);
  }
}

export async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | directoryOnly);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
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
