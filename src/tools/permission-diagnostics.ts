/** Structured, non-secret guidance for failures caused by a host/filesystem boundary. */
export interface PermissionDiagnostic {
  code: "permission-denied";
  scope: "git-metadata" | "filesystem";
  hint: string;
}

export function diagnosePermissionFailure(input: {
  command?: string;
  error?: unknown;
  stderr?: string;
}): PermissionDiagnostic | undefined {
  const errorText = input.error instanceof Error
    ? `${errorCode(input.error)} ${input.error.message}`
    : typeof input.error === "string" ? input.error : "";
  const text = `${input.command ?? ""}\n${errorText}\n${input.stderr ?? ""}`;
  if (!isPermissionFailure(text, input.error)) return undefined;

  const gitMetadata = /(?:\.git(?:[\\/.'"]|$)|\bgit(?:\s|$))/iu.test(text);
  return {
    code: "permission-denied",
    scope: gitMetadata ? "git-metadata" : "filesystem",
    hint: gitMetadata
      ? "Git metadata is protected by the current execution boundary. Use git_status/git_log/git_show/git_diff for read-only inspection, or select /permissions full-access (or --allow-shell) for git add/commit. If full-access still fails, the host or OS sandbox must grant write access to .git."
      : "The current execution boundary denied this filesystem operation. Check the workspace permission or select /permissions full-access for host-level access.",
  };
}

function isPermissionFailure(text: string, error: unknown): boolean {
  if (error !== null && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "WORKSPACE_SANDBOX_UNAVAILABLE") {
    return true;
  }
  return /\b(?:EACCES|EPERM)\b|operation not permitted|permission denied|permission profile|workspace\s+bash[^\n]*(?:denied|disabled|unavailable)|sandbox[^\n]*(?:denied|refused|unavailable|cannot apply)/iu.test(text);
}

function errorCode(error: Error): string {
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}
