import { createHash } from "node:crypto";

export const FINGERPRINT_ALGORITHM = "sha256" as const;

export function hashJson(value: unknown): string {
  return `sha256:${createHash(FINGERPRINT_ALGORITHM).update(canonicalJson(value)).digest("hex")}`;
}

export function hashText(value: string): string {
  return hashJson(value);
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot canonicalize a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("Cannot canonicalize this value");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
