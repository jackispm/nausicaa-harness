import type { BetaToolTraceEntry } from "./types.js";

/**
 * Derive read evidence from the structured result returned by a tool. Request
 * arguments alone are not evidence: a batch may partially fail and a search
 * may return no matches.
 */
export function observedReadPathsFromToolResult(
  toolName: string,
  content: string,
  isError: boolean,
  allowedPaths: ReadonlySet<string>,
): readonly string[] {
  if (isError) return [];
  let payload: unknown;
  try {
    payload = JSON.parse(content) as unknown;
  } catch {
    return [];
  }

  const candidates: unknown[] = [];
  if (toolName === "read_file" && isRecord(payload)) {
    candidates.push(payload.path);
  } else if (toolName === "read_many" && isRecord(payload) && Array.isArray(payload.results)) {
    for (const result of payload.results) {
      if (isRecord(result) && result.ok === true) candidates.push(result.path);
    }
  } else if (toolName === "grep" && isRecord(payload)) {
    if (Array.isArray(payload.matches)) {
      for (const match of payload.matches) {
        if (isRecord(match)) candidates.push(match.path);
      }
    }
    if (Array.isArray(payload.files)) candidates.push(...payload.files);
  }

  const paths: string[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeObservedPath(candidate, allowedPaths);
    if (normalized !== undefined && !paths.includes(normalized)) paths.push(normalized);
  }
  return paths;
}

export function collectObservedReadPaths(
  trace: readonly BetaToolTraceEntry[],
): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const entry of trace) {
    if (entry.isError || entry.observedPaths === undefined) continue;
    for (const path of entry.observedPaths) paths.add(path);
  }
  return paths;
}

function normalizeObservedPath(
  value: unknown,
  allowedPaths: ReadonlySet<string>,
): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.includes("\0")) return undefined;
  const replaced = value.replaceAll("\\", "/");
  if (replaced.startsWith("/") || /^[A-Za-z]:\//u.test(replaced)) return undefined;
  const parts = replaced.split("/");
  if (parts.some((part) => part === "..")) return undefined;
  const normalized = parts.filter((part) => part.length > 0 && part !== ".").join("/");
  return allowedPaths.has(normalized) ? normalized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
