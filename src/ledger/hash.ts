import { createHash } from "node:crypto";

function normalizeJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeJson(item) ?? null);
  }

  if (typeof value === "object") {
    if (value instanceof Date) {
      return value.toISOString();
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Ledger values must be plain JSON objects");
    }

    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = normalizeJson((value as Record<string, unknown>)[key]);
      if (item !== undefined) {
        normalized[key] = item;
      }
    }
    return normalized;
  }

  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }

  throw new TypeError(`Ledger values cannot contain ${typeof value}`);
}

export function stableJson(value: unknown): string {
  const normalized = normalizeJson(value);
  if (normalized === undefined) {
    throw new TypeError("Ledger value must be JSON serializable");
  }
  return JSON.stringify(normalized);
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(stableJson(value)) as T;
}

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
