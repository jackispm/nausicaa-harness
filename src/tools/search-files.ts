import path from "node:path";

import type { Stats } from "node:fs";

import {
  assertSameFile,
  isWorkspacePathAllowed,
  type ResolvedWorkspacePath,
  resolveExistingWorkspacePath,
  revalidateExistingWorkspacePath,
  type WorkspacePathPolicy,
} from "./workspace-path.js";
import { executeRipgrep } from "./ripgrep.js";

const MAX_DISCOVERY_BYTES = 4 * 1024 * 1024;

export interface SearchFile {
  argument: string;
  path: string;
  resolved: ResolvedWorkspacePath;
  identity: Pick<Stats, "dev" | "ino">;
}

export interface SearchFileDiscovery {
  files: SearchFile[];
  truncated: boolean;
  root: ResolvedWorkspacePath;
  cwd: string;
}

export async function discoverSearchFiles(
  workspace: string,
  requestedPath: string,
  glob: string | undefined,
  policy: WorkspacePathPolicy,
  signal: AbortSignal | undefined,
): Promise<SearchFileDiscovery> {
  const root = await resolveExistingWorkspacePath(workspace, requestedPath, policy);
  const rootStats = await revalidateExistingWorkspacePath(root);
  if (rootStats.isFile()) {
    assertPrivateRegularFile(rootStats);
    return {
      files: [{
        argument: path.basename(root.absolute),
        path: root.relative,
        resolved: root,
        identity: rootStats,
      }],
      truncated: false,
      root,
      cwd: path.dirname(root.absolute),
    };
  }
  if (!rootStats.isDirectory()) {
    throw new Error("Search path is not a file or directory");
  }

  const arguments_ = [
    "--files",
    "--hidden",
    "--null",
    "--no-config",
    "--sort=path",
    "--path-separator=/",
  ];
  if (glob !== undefined) {
    arguments_.push("--glob", glob);
  }
  arguments_.push("--", ".");

  const result = await executeRipgrep(arguments_, root.absolute, signal, MAX_DISCOVERY_BYTES);
  if (result.exitCode !== 0 && !result.outputTruncated) {
    throw new Error(ripgrepError(result.stderr, result.exitCode));
  }
  await revalidateExistingWorkspacePath(root);

  const entries = splitNullTerminated(result.stdout, result.outputTruncated);
  const files: SearchFile[] = [];
  for (const entry of entries) {
    throwIfAborted(signal);
    const nativeEntry = entry.split("/").join(path.sep);
    const absolute = path.resolve(root.absolute, nativeEntry);
    if (!isWithin(root.absolute, absolute)) continue;
    if (!isWorkspacePathAllowed(root.workspace, absolute, root.policy)) continue;
    const workspaceRelative = path.relative(root.workspace, absolute);
    try {
      const resolved = await resolveExistingWorkspacePath(root.workspace, workspaceRelative, root.policy);
      const stats = await revalidateExistingWorkspacePath(resolved);
      if (!stats.isFile() || stats.nlink !== 1) continue;
      files.push({
        argument: path.relative(root.absolute, resolved.absolute),
        path: resolved.relative,
        resolved,
        identity: stats,
      });
    } catch {
      // Entries that changed, are protected, or contain symlinks are not searchable.
    }
  }
  files.sort((left, right) => compareText(left.path, right.path));
  return { files, truncated: result.outputTruncated, root, cwd: root.absolute };
}

export async function revalidateSearchFile(file: SearchFile): Promise<void> {
  const stats = await revalidateExistingWorkspacePath(file.resolved);
  assertPrivateRegularFile(stats);
  assertSameFile(file.identity, stats);
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function snapshotPolicy(policy: WorkspacePathPolicy): WorkspacePathPolicy {
  return { protectedPaths: [...(policy.protectedPaths ?? [])] };
}

export function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, name);
}

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  if (Buffer.byteLength(value, "utf8") > 16 * 1024) {
    throw new TypeError(`${name} exceeds the 16KB input limit`);
  }
  return value;
}

export function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new TypeError(`${name} must be a boolean`);
  }
  return value;
}

export function boundedInteger(
  value: unknown,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

export function ripgrepError(stderr: string, exitCode: number | null): string {
  const message = stderr.trim();
  return message.length > 0
    ? `ripgrep failed: ${message}`
    : `ripgrep exited with code ${exitCode ?? "unknown"}`;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted", "AbortError");
  }
}

function assertPrivateRegularFile(stats: Stats): void {
  if (!stats.isFile() || stats.nlink !== 1) {
    throw new Error("Search path is not a private regular file");
  }
}

function splitNullTerminated(output: Buffer, truncated: boolean): string[] {
  const parts = output.toString("utf8").split("\0");
  if (parts.at(-1) === "") parts.pop();
  else if (truncated) parts.pop();
  return parts.filter((entry) => entry.length > 0);
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative.length === 0
    || (!path.isAbsolute(relative)
      && relative !== ".."
      && !relative.startsWith(`..${path.sep}`));
}
