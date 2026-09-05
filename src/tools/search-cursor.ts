import { createHash, timingSafeEqual } from "node:crypto";

const CURSOR_VERSION = 1;
const MAX_CURSOR_CHARACTERS = 4_096;
const SIGNATURE_DOMAIN = "nausicaa-search-cursor-v1\0";

export type SearchCursorTool = "find" | "grep";

interface SearchCursorPayload {
  version: number;
  tool: SearchCursorTool;
  query: string;
  anchor: unknown;
}

export function searchQueryFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

export function encodeSearchCursor(
  tool: SearchCursorTool,
  query: string,
  anchor: unknown,
): string {
  const encoded = Buffer.from(JSON.stringify({
    version: CURSOR_VERSION,
    tool,
    query,
    anchor,
  } satisfies SearchCursorPayload), "utf8").toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

export function decodeSearchCursor<T>(
  cursor: string,
  tool: SearchCursorTool,
  query: string,
  isAnchor: (value: unknown) => value is T,
): T {
  if (cursor.length > MAX_CURSOR_CHARACTERS) throw invalidCursor();
  const parts = cursor.split(".");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw invalidCursor();
  }
  const [encoded, suppliedSignature] = parts as [string, string];
  const expectedSignature = sign(encoded);
  const supplied = Buffer.from(suppliedSignature, "base64url");
  const expected = Buffer.from(expectedSignature, "base64url");
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
    throw invalidCursor();
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  if (!isRecord(payload) || payload.version !== CURSOR_VERSION) throw invalidCursor();
  if (payload.tool !== tool) {
    throw new Error(`cursor belongs to ${String(payload.tool)}, not ${tool}; restart without cursor`);
  }
  if (payload.query !== query) {
    throw new Error(`cursor does not match this ${tool} query; reuse the original search arguments or restart without cursor`);
  }
  if (!isAnchor(payload.anchor)) throw invalidCursor();
  return payload.anchor;
}

function sign(encoded: string): string {
  // This is an integrity checksum, not an authorization token. Search anchors
  // cannot broaden the underlying workspace/query boundary, and a deterministic
  // digest lets a durable Run continue pagination after a process restart.
  return createHash("sha256")
    .update(SIGNATURE_DOMAIN)
    .update(encoded)
    .digest("base64url");
}

function invalidCursor(): Error {
  return new Error("cursor is invalid or expired; restart the search without cursor");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
