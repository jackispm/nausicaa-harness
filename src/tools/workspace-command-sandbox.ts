import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdtemp,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import type { BashCommandExecutionInput, BashCommandExecutor } from "./bash.js";
import {
  executeShellCommand,
  type ShellCommandInvocation,
  type ShellExecutionResult,
} from "./shell-process.js";

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const MAX_PROTECTION_SCAN_ENTRIES = 100_000;
const MAX_PROTECTED_TARGETS = 2_048;
const MACOS_SEATBELT_EXECUTABLE = "/usr/bin/sandbox-exec";
const MACOS_HOST_AUTOMATION_EXECUTABLES = [
  "/usr/bin/automator",
  "/usr/bin/open",
  "/usr/bin/osascript",
  "/usr/bin/shortcuts",
] as const;
const LINUX_BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/bin/bwrap"] as const;
const FIXED_BASH_CANDIDATES = ["/bin/bash", "/usr/bin/bash"] as const;
const WORKSPACE_SECRET_DIRECTORIES = new Set([
  ".aws",
  ".azure",
  ".gnupg",
  ".kube",
  ".nausicaa",
  ".ssh",
]);
const PROTECTION_SCAN_PRUNED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".pnpm-store",
  "build",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);

export type WorkspaceSandboxBackend = "macos-seatbelt" | "linux-bwrap";

export type WorkspaceSandboxAvailability =
  | { available: true; backend: WorkspaceSandboxBackend }
  | { available: false; reason: string };

export class WorkspaceCommandSandboxUnavailableError extends Error {
  override readonly name = "WorkspaceCommandSandboxUnavailableError";
  readonly code = "WORKSPACE_SANDBOX_UNAVAILABLE";
}

export interface WorkspaceCommandSandboxOptions {
  /** Additional host-owned paths hidden from sandboxed commands. */
  protectedPaths?: readonly string[];
  /** Functional probe bound; zero never means unbounded. */
  probeTimeoutMs?: number;
  /** Test/embedding override for platform selection. */
  platform?: NodeJS.Platform;
  /** Explicit trusted launcher override, primarily for packaged deployments and tests. */
  seatbeltExecutable?: string;
  /** Explicit trusted launcher override, primarily for packaged deployments and tests. */
  bubblewrapExecutable?: string;
  /** Test seam for a functional launcher probe. */
  probe?: (invocation: ShellCommandInvocation, timeoutMs: number) => boolean;
  /** Test seam that preserves the production shell lifecycle contract. */
  execute?: typeof executeShellCommand;
}

interface SelectedRunner {
  backend: WorkspaceSandboxBackend;
  executable: string;
}

interface ProtectedTarget {
  path: string;
  kind: "file" | "directory" | "missing";
  access: "unreadable" | "read-only";
}

/**
 * OS-enforced foreground command backend for the `workspace` permission profile.
 *
 * Its provider/profile shape is minimally adapted from DeepSeek Harness's
 * MIT-licensed `sandbox-local` package (commit aa6c361a97). Fixed launcher
 * paths, functional probing and fail-closed execution follow Codex's mature
 * sandbox boundary. Mowe remains the catalog/admission owner.
 */
export class WorkspaceCommandSandbox {
  readonly #options: WorkspaceCommandSandboxOptions;
  #runner: SelectedRunner | "unavailable" | undefined;
  #unavailableReason: string | undefined;

  constructor(options: WorkspaceCommandSandboxOptions = {}) {
    const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    if (!Number.isFinite(probeTimeoutMs) || probeTimeoutMs <= 0) {
      throw new TypeError("probeTimeoutMs must be a finite number greater than zero");
    }
    this.#options = {
      ...options,
      probeTimeoutMs,
      protectedPaths: [...(options.protectedPaths ?? [])],
    };
  }

  /** Cached functional availability; probing never runs the requested command. */
  availability(): WorkspaceSandboxAvailability {
    const runner = this.#selectRunner();
    return runner === "unavailable"
      ? {
          available: false,
          reason: this.#unavailableReason ?? "No supported workspace sandbox is available",
        }
      : { available: true, backend: runner.backend };
  }

  /** Stable executor seam consumed by `createBashTool`. */
  readonly execute: BashCommandExecutor = async (
    input: BashCommandExecutionInput,
  ): Promise<ShellExecutionResult> => {
    const runner = this.#selectRunner();
    if (runner === "unavailable") {
      throw new WorkspaceCommandSandboxUnavailableError(
        this.#unavailableReason ?? "No supported workspace sandbox is available",
      );
    }

    const workspace = await canonicalWorkspace(input.cwd);
    const bash = fixedBashExecutable();
    if (bash === undefined) {
      throw new WorkspaceCommandSandboxUnavailableError(
        "Workspace Bash requires /bin/bash or /usr/bin/bash",
      );
    }
    const protectedTargets = await resolveProtectedTargets(
      workspace,
      this.#options.protectedPaths ?? [],
    );

    let scratch: string | undefined;
    try {
      if (runner.backend === "macos-seatbelt") {
        scratch = await mkdtemp(path.join(tmpdir(), "nausicaa-sandbox-"));
      }
      const invocation = runner.backend === "macos-seatbelt"
        ? seatbeltInvocation(runner.executable, bash, workspace, scratch!, protectedTargets)
        : bubblewrapInvocation(runner.executable, bash, workspace, protectedTargets);
      const execute = this.#options.execute ?? executeShellCommand;
      const execution = await execute({
        ...input,
        cwd: workspace,
        invocation,
        env: sandboxEnvironment(runner.backend, scratch),
      });
      if (runnerRefusedProfile(runner.backend, execution)) {
        throw new WorkspaceCommandSandboxUnavailableError(
          `${runner.backend} refused its confinement profile`,
        );
      }
      return execution;
    } finally {
      if (scratch !== undefined) {
        await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  };

  #selectRunner(): SelectedRunner | "unavailable" {
    if (this.#runner !== undefined) return this.#runner;
    const platform = this.#options.platform ?? process.platform;
    switch (platform) {
      case "darwin": {
        const executable = this.#options.seatbeltExecutable ?? MACOS_SEATBELT_EXECUTABLE;
        if (!existsSync(executable)) {
          return this.#markUnavailable(`macOS Seatbelt launcher is missing: ${executable}`);
        }
        const probeInvocation = seatbeltProbeInvocation(executable);
        if (!this.#probe(probeInvocation)) {
          return this.#markUnavailable("macOS Seatbelt is present but cannot apply a sandbox profile");
        }
        this.#runner = { backend: "macos-seatbelt", executable };
        return this.#runner;
      }
      case "linux": {
        const executable = this.#options.bubblewrapExecutable
          ?? LINUX_BWRAP_CANDIDATES.find((candidate) => existsSync(candidate));
        if (executable === undefined || !existsSync(executable)) {
          return this.#markUnavailable(
            "Linux workspace Bash requires bubblewrap at /usr/bin/bwrap or /bin/bwrap",
          );
        }
        const probeInvocation = bubblewrapProbeInvocation(executable);
        if (!this.#probe(probeInvocation)) {
          return this.#markUnavailable(
            "bubblewrap is present but cannot create filesystem, PID, and network namespaces",
          );
        }
        this.#runner = { backend: "linux-bwrap", executable };
        return this.#runner;
      }
      default:
        return this.#markUnavailable(
          `Workspace Bash has no OS sandbox backend for ${platform}`,
        );
    }
  }

  #probe(invocation: ShellCommandInvocation): boolean {
    const timeoutMs = this.#options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    if (this.#options.probe !== undefined) {
      return this.#options.probe(invocation, timeoutMs);
    }
    try {
      const result = spawnSync(invocation.executable, invocation.arguments, {
        timeout: timeoutMs,
        stdio: "ignore",
        windowsHide: true,
      });
      return result.status === 0;
    } catch {
      return false;
    }
  }

  #markUnavailable(reason: string): "unavailable" {
    this.#runner = "unavailable";
    this.#unavailableReason = reason;
    return this.#runner;
  }
}

export function createWorkspaceSandboxBashExecutor(
  options: WorkspaceCommandSandboxOptions = {},
): { sandbox: WorkspaceCommandSandbox; executor: BashCommandExecutor } {
  const sandbox = new WorkspaceCommandSandbox(options);
  return { sandbox, executor: sandbox.execute };
}

/** Exported for narrow contract tests and platform packaging audits. */
export function buildSeatbeltWorkspaceProfile(input: {
  workspace: string;
  scratch: string;
  protectedTargets?: readonly ProtectedTarget[];
}): string {
  const forms = [
    "(version 1)",
    "(allow default)",
    "(deny signal)",
    "(allow signal (target same-sandbox))",
    "(deny process-info*)",
    "(allow process-info* (target same-sandbox))",
    "(deny mach-lookup)",
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
    '(allow mach-lookup (global-name "com.apple.PowerManagement.control"))',
    "(deny appleevent-send)",
    "(deny distributed-notification-post)",
    "(deny system-privilege)",
    ...MACOS_HOST_AUTOMATION_EXECUTABLES.map(
      (executable) => `(deny process-exec (literal ${sbplString(executable)}))`,
    ),
    "(deny file-write*)",
    "(deny network*)",
    `(allow file-write* (literal ${sbplString("/dev/null")}))`,
    `(allow file-write* (subpath ${sbplString(input.workspace)}) (subpath ${sbplString(input.scratch)}))`,
  ];
  for (const target of input.protectedTargets ?? []) {
    const operations = target.access === "unreadable"
      ? "file-read* file-write*"
      : "file-write*";
    forms.push(
      `(deny ${operations} (literal ${sbplString(target.path)}) (subpath ${sbplString(target.path)}))`,
    );
  }
  return forms.join("\n");
}

/** Exported for narrow contract tests and platform packaging audits. */
export function buildBubblewrapWorkspaceArguments(input: {
  workspace: string;
  protectedTargets?: readonly ProtectedTarget[];
}): string[] {
  const args = [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--unshare-pid",
    "--proc", "/proc",
    "--unshare-net",
    "--die-with-parent",
    // A network namespace does not isolate pathname AF_UNIX sockets. Hide the
    // conventional host service tree before exposing the read-only root.
    "--tmpfs", "/run",
    "--tmpfs", "/tmp",
    "--bind", input.workspace, input.workspace,
    "--chdir", input.workspace,
  ];
  for (const target of input.protectedTargets ?? []) {
    if (target.kind === "missing") continue;
    if (target.access === "read-only") {
      args.push("--ro-bind", target.path, target.path);
      continue;
    }
    if (target.kind === "file") {
      args.push("--ro-bind", "/dev/null", target.path);
    } else {
      args.push("--tmpfs", target.path, "--remount-ro", target.path);
    }
  }
  return args;
}

function seatbeltProbeInvocation(executable: string): ShellCommandInvocation {
  // Parse and apply the production base profile so availability cannot pass on
  // a reduced policy that the first real command then rejects.
  const profile = buildSeatbeltWorkspaceProfile({
    workspace: "/private/tmp",
    scratch: "/private/tmp",
  });
  return {
    executable,
    arguments: ["-p", profile, "--", "/usr/bin/true"],
  };
}

function bubblewrapProbeInvocation(executable: string): ShellCommandInvocation {
  return {
    executable,
    arguments: [
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--unshare-pid",
      "--proc", "/proc",
      "--unshare-net",
      "--die-with-parent",
      "--", "/bin/true",
    ],
  };
}

function seatbeltInvocation(
  executable: string,
  bash: string,
  workspace: string,
  scratch: string,
  protectedTargets: readonly ProtectedTarget[],
): ShellCommandInvocation {
  return {
    executable,
    arguments: [
      "-p",
      buildSeatbeltWorkspaceProfile({ workspace, scratch, protectedTargets }),
      "--",
      bash,
      "-c",
    ],
  };
}

function bubblewrapInvocation(
  executable: string,
  bash: string,
  workspace: string,
  protectedTargets: readonly ProtectedTarget[],
): ShellCommandInvocation {
  return {
    executable,
    arguments: [
      ...buildBubblewrapWorkspaceArguments({ workspace, protectedTargets }),
      "--",
      bash,
      "-c",
    ],
  };
}

function sandboxEnvironment(
  backend: WorkspaceSandboxBackend,
  scratch: string | undefined,
): NodeJS.ProcessEnv {
  const temporaryDirectory = backend === "linux-bwrap" ? "/tmp" : scratch;
  if (temporaryDirectory === undefined) {
    throw new WorkspaceCommandSandboxUnavailableError("Sandbox scratch directory is unavailable");
  }
  return {
    TMPDIR: temporaryDirectory,
    TMP: temporaryDirectory,
    TEMP: temporaryDirectory,
    XDG_CACHE_HOME: path.join(temporaryDirectory, "cache"),
    NPM_CONFIG_CACHE: path.join(temporaryDirectory, "npm-cache"),
    GIT_OPTIONAL_LOCKS: "0",
  };
}

async function canonicalWorkspace(workspace: string): Promise<string> {
  const lexical = path.resolve(workspace);
  const supplied = await lstat(lexical);
  if (supplied.isSymbolicLink() || !supplied.isDirectory()) {
    throw new WorkspaceCommandSandboxUnavailableError(
      "Workspace sandbox requires a real directory root",
    );
  }
  return await realpath(lexical);
}

async function resolveProtectedTargets(
  workspace: string,
  additional: readonly string[],
): Promise<ProtectedTarget[]> {
  const targets = new Map<string, ProtectedTarget["access"]>();
  const home = homedir();
  const unreadable = [
    path.join(workspace, ".nausicaa"),
    path.join(workspace, ".aws"),
    path.join(workspace, ".azure"),
    path.join(workspace, ".gnupg"),
    path.join(workspace, ".kube"),
    path.join(workspace, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".azure"),
    path.join(home, ".cargo", "credentials"),
    path.join(home, ".cargo", "credentials.toml"),
    path.join(home, ".config", "gcloud"),
    path.join(home, ".config", "gh"),
    path.join(home, ".config", "git", "credentials"),
    path.join(home, ".config", "op"),
    path.join(home, ".config", "containers"),
    path.join(home, ".config", "pypoetry", "auth.toml"),
    path.join(home, ".config", "rclone", "rclone.conf"),
    path.join(home, ".config", "sops", "age", "keys.txt"),
    path.join(home, ".docker"),
    path.join(home, ".git-credentials"),
    path.join(home, ".gnupg"),
    path.join(home, ".gradle", "gradle.properties"),
    path.join(home, ".kube"),
    path.join(home, ".local", "share", "keyrings"),
    path.join(home, ".m2", "settings.xml"),
    path.join(home, ".netrc"),
    path.join(home, ".npmrc"),
    path.join(home, ".password-store"),
    path.join(home, ".pypirc"),
    path.join(home, ".ssh"),
    path.join(home, ".terraform.d", "credentials.tfrc.json"),
    path.join(home, "Library", "Keychains"),
    ...additional.map((candidate) => path.resolve(candidate)),
  ];
  for (const candidate of unreadable) setProtectedTarget(targets, candidate, "unreadable");
  await discoverWorkspaceProtections(workspace, targets);

  return await Promise.all([...targets].map(async ([candidate, access]) => ({
    path: await canonicalTarget(candidate),
    kind: await targetKind(candidate),
    access,
  })));
}

async function discoverWorkspaceProtections(
  workspace: string,
  targets: Map<string, ProtectedTarget["access"]>,
): Promise<void> {
  const pending = [workspace];
  let scannedEntries = 0;
  try {
    while (pending.length > 0) {
      const directory = pending.pop();
      if (directory === undefined) break;
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        scannedEntries += 1;
        if (scannedEntries > MAX_PROTECTION_SCAN_ENTRIES) {
          throw new WorkspaceCommandSandboxUnavailableError(
            `Workspace protection scan exceeds ${MAX_PROTECTION_SCAN_ENTRIES} entries`,
          );
        }
        const candidate = path.join(directory, entry.name);
        if (entry.name === ".git") {
          setProtectedTarget(targets, candidate, "read-only");
          setProtectedTarget(targets, path.join(candidate, "config"), "unreadable");
          setProtectedTarget(targets, path.join(candidate, "config.worktree"), "unreadable");
          setProtectedTarget(targets, path.join(candidate, "hooks"), "unreadable");
          continue;
        }
        if (isEnvironmentFileName(entry.name)) {
          setProtectedTarget(targets, candidate, "unreadable");
          continue;
        }
        if (entry.isDirectory() && WORKSPACE_SECRET_DIRECTORIES.has(entry.name)) {
          setProtectedTarget(targets, candidate, "unreadable");
          continue;
        }
        if (
          entry.isDirectory()
          && !entry.isSymbolicLink()
          && !PROTECTION_SCAN_PRUNED_DIRECTORIES.has(entry.name)
        ) {
          pending.push(candidate);
        }
      }
    }
  } catch (error: unknown) {
    if (error instanceof WorkspaceCommandSandboxUnavailableError) throw error;
    throw new WorkspaceCommandSandboxUnavailableError(
      `Cannot inspect workspace protections: ${safeMessage(error)}`,
    );
  }
}

function setProtectedTarget(
  targets: Map<string, ProtectedTarget["access"]>,
  candidate: string,
  access: ProtectedTarget["access"],
): void {
  targets.set(candidate, access);
  if (targets.size > MAX_PROTECTED_TARGETS) {
    throw new WorkspaceCommandSandboxUnavailableError(
      `Workspace protection set exceeds ${MAX_PROTECTED_TARGETS} paths`,
    );
  }
}

function isEnvironmentFileName(name: string): boolean {
  return name === ".env" || name.startsWith(".env.");
}

async function canonicalTarget(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

async function targetKind(candidate: string): Promise<ProtectedTarget["kind"]> {
  try {
    const info = await lstat(candidate);
    return info.isDirectory() ? "directory" : "file";
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

function fixedBashExecutable(): string | undefined {
  return FIXED_BASH_CANDIDATES.find((candidate) => existsSync(candidate));
}

function runnerRefusedProfile(
  backend: WorkspaceSandboxBackend,
  execution: ShellExecutionResult,
): boolean {
  if (execution.spawnError !== undefined) return true;
  if (execution.exitCode === 0) return false;
  const stderr = execution.stderr.content.toLowerCase();
  return backend === "macos-seatbelt"
    ? stderr.includes("sandbox-exec: sandbox_apply:")
    : stderr.split(/\r?\n/u).some((line) => line.startsWith("bwrap:"));
}

function sbplString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
