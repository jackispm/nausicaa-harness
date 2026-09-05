import { isIP } from "node:net";

import type { AgentTool } from "../domain/ports.js";
import {
  createWebSearchTool,
  HttpWebFetchProvider,
  type WebFetchFunction,
  type WebSearchProvider,
  type WebSearchResult,
  type WebSearchSource,
  WebToolError,
} from "./web.js";

const DEFAULT_DDG_ENDPOINT = "https://html.duckduckgo.com/html/";
const DEFAULT_MAX_BODY_CHARS = 512_000;

export interface DuckDuckGoSearchOptions {
  readonly fetch?: WebFetchFunction;
  readonly endpoint?: string;
  readonly maxBodyChars?: number;
}

/**
 * Public HTML search adapter. It intentionally has no credentials or hidden
 * model calls, and implements the generic provider seam used by Mowe.
 * Deployments may replace it with an API-backed provider without changing the
 * model-facing `web_search` schema.
 */
export class DuckDuckGoSearchProvider implements WebSearchProvider {
  readonly id = "duckduckgo";
  private readonly endpoint: URL;
  private readonly fetcher: HttpWebFetchProvider;
  private readonly maxBodyChars: number;

  constructor(options: DuckDuckGoSearchOptions = {}) {
    this.endpoint = parseEndpoint(options.endpoint ?? DEFAULT_DDG_ENDPOINT);
    this.maxBodyChars = positiveInteger(options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS, "maxBodyChars");
    this.fetcher = new HttpWebFetchProvider({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      limits: {
        maxBodyChars: this.maxBodyChars,
        maxResponseBytes: Math.max(this.maxBodyChars * 2, 1_024 * 1_024),
        maxRedirects: 2,
        timeoutMs: 30_000,
        userAgent: "nausicaa-web-search/0.1",
      },
    });
  }

  available(): boolean {
    return this.fetcher.available();
  }

  async search(
    request: { readonly query: string; readonly maxResults: number },
    signal?: AbortSignal,
  ): Promise<WebSearchResult> {
    if (request.query.trim().length === 0) {
      throw new WebToolError("WEB_SEARCH_INVALID_QUERY", "query must be a non-empty string");
    }
    const maxResults = positiveInteger(request.maxResults, "maxResults");
    const url = new URL(this.endpoint);
    url.searchParams.set("q", request.query);
    const fetched = await this.fetcher.fetch({ url: url.toString() }, signal);
    if (fetched.statusCode < 200 || fetched.statusCode >= 300) {
      throw new WebToolError("WEB_PROVIDER_ERROR", `Web search provider returned HTTP ${fetched.statusCode}`);
    }
    return parseDuckDuckGoResults(fetched.body.content, maxResults, fetched.truncated);
  }
}

/** Convenience factory for the default public search backend. */
export function createDuckDuckGoSearchTool(options: DuckDuckGoSearchOptions = {}): AgentTool {
  const provider = new DuckDuckGoSearchProvider(options);
  return createWebSearchTool(provider);
}

/** Parse DuckDuckGo's result HTML into normalized, citeable sources. */
export function parseDuckDuckGoResults(
  html: string,
  maxResults: number,
  sourceTruncated = false,
): WebSearchResult {
  const limit = positiveInteger(maxResults, "maxResults");
  const sources: WebSearchSource[] = [];
  const seen = new Set<string>();
  const anchorPattern = /<a\b([^>]*\bclass\s*=\s*["'][^"']*\bresult__a\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/giu;
  let match: RegExpExecArray | null;
  while (sources.length < limit && (match = anchorPattern.exec(html)) !== null) {
    const attributes = match[1] ?? "";
    const href = attributeValue(attributes, "href");
    if (href === undefined) continue;
    const url = normalizeSearchUrl(href);
    if (url === undefined || seen.has(url)) continue;
    const title = cleanHtmlText(match[2] ?? "");
    const following = html.slice(anchorPattern.lastIndex, Math.min(html.length, anchorPattern.lastIndex + 8_192));
    const snippetMatch = /<a\b[^>]*\bclass\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/iu.exec(following);
    const snippet = cleanHtmlText(snippetMatch?.[1] ?? "");
    seen.add(url);
    sources.push({
      url,
      ...(title.length === 0 ? {} : { title }),
      ...(snippet.length === 0 ? {} : { snippet }),
    });
  }
  const hasMore = sources.length >= limit && anchorPattern.exec(html) !== null;
  anchorPattern.lastIndex = 0;
  return {
    sources,
    truncated: sourceTruncated || hasMore,
  };
}

function parseEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error: unknown) {
    throw new WebToolError("WEB_INVALID_URL", "Search endpoint URL is invalid", { cause: error });
  }
  if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0) {
    throw new WebToolError("WEB_URL_BLOCKED", "Search endpoint must be a credential-free HTTPS URL");
  }
  if (isBlockedEndpointHostname(url.hostname)) {
    throw new WebToolError("WEB_URL_BLOCKED", "Search endpoint must target a public host");
  }
  return url;
}

/** Keep provider configuration from becoming an SSRF bypass. */
function isBlockedEndpointHostname(value: string): boolean {
  const hostname = value.replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase();
  if (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname === "metadata"
    || hostname === "metadata.google.internal"
    || hostname === "host.docker.internal"
  ) return true;
  const kind = isIP(hostname);
  if (kind === 4) return isPrivateEndpointIpv4(hostname);
  if (kind === 6) return isPrivateEndpointIpv6(hostname);
  return false;
}

function isPrivateEndpointIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return true;
  }
  const [first, second] = octets as [number, number, number, number];
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && (second === 0 || second === 168))
    || (first === 198 && second >= 18 && second <= 19)
    || (first === 203 && second === 0)
    || first >= 224;
}

function isPrivateEndpointIpv6(hostname: string): boolean {
  const groups = expandIpv6(hostname);
  if (groups === undefined) return true;
  if (groups.every((group) => group === 0) || (groups.length === 8 && groups[7] === 1 && groups.slice(0, 7).every((group) => group === 0))) {
    return true;
  }
  const first = groups[0] ?? 0;
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) {
    return true;
  }
  // IPv4-mapped/compatible IPv6 addresses must inherit the IPv4 boundary.
  const mapped = groups.length === 8
    && groups.slice(0, 5).every((group) => group === 0)
    && (groups[5] === 0xffff || groups[5] === 0)
    ? `${(groups[6] ?? 0) >> 8}.${(groups[6] ?? 0) & 0xff}.${(groups[7] ?? 0) >> 8}.${(groups[7] ?? 0) & 0xff}`
    : undefined;
  return mapped !== undefined && isPrivateEndpointIpv4(mapped);
}

function expandIpv6(value: string): number[] | undefined {
  const halves = value.split("::");
  if (halves.length > 2) return undefined;
  const parseHalf = (half: string): number[] | undefined => {
    if (half.length === 0) return [];
    const parts = half.split(":");
    const result: number[] = [];
    for (const part of parts) {
      if (part.includes(".")) {
        const octets = part.split(".").map(Number);
        if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined;
        const first = octets[0] ?? -1;
        const second = octets[1] ?? -1;
        const third = octets[2] ?? -1;
        const fourth = octets[3] ?? -1;
        result.push((first << 8) | second, (third << 8) | fourth);
        continue;
      }
      if (!/^[\da-f]{1,4}$/iu.test(part)) return undefined;
      result.push(Number.parseInt(part, 16));
    }
    return result;
  };
  const left = parseHalf(halves[0] ?? "");
  const right = parseHalf(halves[1] ?? "");
  if (left === undefined || right === undefined) return undefined;
  if (halves.length === 1) return left.length === 8 ? left : undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function normalizeSearchUrl(value: string): string | undefined {
  const decoded = decodeHtmlEntities(value.trim());
  let url: URL;
  try {
    url = new URL(decoded, DEFAULT_DDG_ENDPOINT);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.hostname === "duckduckgo.com" || url.hostname.endsWith(".duckduckgo.com")) {
    const redirected = url.searchParams.get("uddg");
    if (redirected !== null) {
      try {
        url = new URL(redirected);
      } catch {
        return undefined;
      }
    }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username.length > 0 || url.password.length > 0) return undefined;
  return url.toString();
}

function attributeValue(attributes: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "iu");
  return pattern.exec(attributes)?.[2];
}

function cleanHtmlText(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/gu, " ")).replace(/\s+/gu, " ").trim();
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/giu, (entity, body: string) => {
    const lower = body.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    if (lower === "nbsp") return " ";
    const radix = lower.startsWith("#x") ? 16 : 10;
    const digits = lower.startsWith("#x") ? lower.slice(2) : lower.slice(1);
    const code = Number.parseInt(digits, radix);
    return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : entity;
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}
