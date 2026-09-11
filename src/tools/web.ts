import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { checkServerIdentity } from "node:tls";

import type { AgentTool, ToolResult } from "../domain/ports.js";

/** A normalized source returned by a web search backend. */
export interface WebSearchSource {
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
  readonly publishedAt?: string;
}

/** A provider-neutral search result. */
export interface WebSearchResult {
  readonly content?: string;
  readonly sources: readonly WebSearchSource[];
  readonly truncated: boolean;
}

/** Search provider seam. Providers own credentials and endpoint selection. */
export interface WebSearchProvider {
  readonly id: string;
  available(): boolean;
  search(
    request: { readonly query: string; readonly maxResults: number },
    signal?: AbortSignal,
  ): Promise<WebSearchResult>;
}

/** A normalized body returned by an HTTP fetch backend. */
export interface WebFetchBody {
  readonly kind: "html" | "text";
  readonly content: string;
}

/** A provider-neutral fetch result. */
export interface WebFetchResult {
  readonly url: string;
  readonly statusCode: number;
  readonly contentType: string;
  readonly body: WebFetchBody;
  readonly truncated: boolean;
}

/** Fetch provider seam. A deployment can replace the local HTTP backend. */
export interface WebFetchProvider {
  readonly id: string;
  available(): boolean;
  fetch(
    request: { readonly url: string },
    signal?: AbortSignal,
  ): Promise<WebFetchResult>;
}

/** The fetch function is injectable so adapters can be tested without network calls. */
export type WebFetchFunction = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface WebResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** Resolver seam for deterministic SSRF and rebinding tests. */
export type WebAddressResolver = (
  hostname: string,
  signal?: AbortSignal,
) => Promise<readonly WebResolvedAddress[]>;

/** Low-level seam receives the validated address that the connection must use. */
export type WebPinnedFetchFunction = (
  url: URL,
  address: WebResolvedAddress,
  init?: RequestInit,
) => Promise<Response>;

export type WebToolErrorCode =
  | "WEB_INVALID_URL"
  | "WEB_URL_BLOCKED"
  | "WEB_REDIRECT_BLOCKED"
  | "WEB_REDIRECT_LIMIT"
  | "WEB_TIMEOUT"
  | "WEB_ABORTED"
  | "WEB_RESPONSE_TOO_LARGE"
  | "WEB_UNSUPPORTED_CONTENT_TYPE"
  | "WEB_PROVIDER_UNAVAILABLE"
  | "WEB_PROVIDER_ERROR"
  | "WEB_SEARCH_INVALID_QUERY";

/** Machine-readable error used by web tools and provider adapters. */
export class WebToolError extends Error {
  override readonly name = "WebToolError";
  readonly code: WebToolErrorCode;

  constructor(code: WebToolErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

export interface WebFetchLimits {
  readonly maxUrlLength: number;
  readonly maxResponseBytes: number;
  readonly maxBodyChars: number;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  readonly userAgent: string;
}

export const DEFAULT_WEB_FETCH_LIMITS: WebFetchLimits = Object.freeze({
  maxUrlLength: 4_096,
  maxResponseBytes: 2 * 1024 * 1024,
  maxBodyChars: 200_000,
  timeoutMs: 30_000,
  maxRedirects: 3,
  userAgent: "nausicaa-web/0.1",
});

export interface WebToolOptions {
  /** Explicit replacement transport; it owns its own DNS/egress boundary. */
  readonly fetch?: WebFetchFunction;
  /** Used only by the DNS-safe default transport. */
  readonly resolveAddresses?: WebAddressResolver;
  /** Test/deployment seam for the pinned Node HTTP(S) request. */
  readonly pinnedFetch?: WebPinnedFetchFunction;
  readonly limits?: Partial<WebFetchLimits>;
}

/**
 * Bounded anonymous HTTP(S) retrieval. Redirects stay same-origin and no
 * ambient cookies, credentials, or authorization headers are sent.
 *
 * The default transport resolves and validates every address, then connects
 * to a selected validated IP while retaining the original Host/SNI identity.
 * This closes the DNS-rebinding gap between admission and connection. An
 * explicitly injected fetch implementation owns its own DNS/egress boundary.
 */
export class HttpWebFetchProvider implements WebFetchProvider {
  readonly id = "http";
  private readonly fetchImpl: WebFetchFunction;
  private readonly limits: WebFetchLimits;

  constructor(options: WebToolOptions = {}) {
    this.fetchImpl = options.fetch ?? createDnsSafeFetch(
      options.resolveAddresses ?? resolveHostAddresses,
      options.pinnedFetch ?? pinnedNodeFetch,
    );
    this.limits = resolveLimits(options.limits);
  }

  available(): boolean {
    return typeof this.fetchImpl === "function";
  }

  async fetch(
    request: { readonly url: string },
    signal?: AbortSignal,
  ): Promise<WebFetchResult> {
    if (signal?.aborted) throw new WebToolError("WEB_ABORTED", "Web fetch was aborted");
    let current = validateWebUrl(request.url, this.limits.maxUrlLength);
    let redirects = 0;
    const deadline = Date.now() + this.limits.timeoutMs;
    for (;;) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new WebToolError("WEB_TIMEOUT", `Web fetch timed out after ${this.limits.timeoutMs}ms`);
      }
      const attempt = timeoutSignal(signal, remainingMs);
      try {
        const response = await this.fetchImpl(current, {
          method: "GET",
          redirect: "manual",
          headers: {
            accept: "text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8",
            "user-agent": this.limits.userAgent,
          },
          signal: attempt.signal,
        });
        if (isRedirectStatus(response.status)) {
          await cancelBody(response);
          if (redirects >= this.limits.maxRedirects) {
            throw new WebToolError(
              "WEB_REDIRECT_LIMIT",
              `Web fetch exceeded the ${this.limits.maxRedirects}-redirect limit`,
            );
          }
          const location = response.headers.get("location");
          if (location === null) {
            throw new WebToolError("WEB_REDIRECT_BLOCKED", "Redirect response has no Location header");
          }
          const target = validateWebUrl(
            new URL(location, current).toString(),
            this.limits.maxUrlLength,
          );
          if (!sameOrigin(target, current)) {
            throw new WebToolError(
              "WEB_REDIRECT_BLOCKED",
              "Cross-origin redirects must be fetched explicitly",
            );
          }
          current = target;
          redirects += 1;
          continue;
        }
        return await readWebResponse(response, current, this.limits, attempt.signal);
      } catch (error: unknown) {
        if (attempt.didTimeout()) {
          throw new WebToolError("WEB_TIMEOUT", `Web fetch timed out after ${this.limits.timeoutMs}ms`, { cause: error });
        }
        if (signal?.aborted || attempt.signal.aborted) {
          throw new WebToolError("WEB_ABORTED", "Web fetch was aborted", { cause: error });
        }
        throw error instanceof WebToolError
          ? error
          : new WebToolError("WEB_PROVIDER_ERROR", "Web fetch request failed", { cause: error });
      } finally {
        attempt.dispose();
      }
    }
  }
}

/** Model-facing bounded fetch tool over an injected provider. */
export function createWebFetchTool(
  provider: WebFetchProvider = new HttpWebFetchProvider(),
  maxOutputChars = 120_000,
): AgentTool {
  const outputLimit = positiveInteger(maxOutputChars, "maxOutputChars");
  return {
    definition: {
      name: "web_fetch",
      description: "Fetch a public HTTP(S) URL and return bounded decoded text or HTML. Redirects stay on the same origin.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Public HTTP(S) URL to fetch" },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    async execute(arguments_, context): Promise<ToolResult> {
      try {
        if (!provider.available()) {
          throw new WebToolError("WEB_PROVIDER_UNAVAILABLE", "Web fetch provider is unavailable");
        }
        const url = requiredString(arguments_.url, "url");
        const result = await provider.fetch({ url }, context.signal);
        return success(boundFetchResult(result, outputLimit));
      } catch (error: unknown) {
        return failure(error);
      }
    },
  };
}

/** Parse model-facing search arguments before any provider call. */
export function parseWebSearchQueries(value: unknown, maxQueries: number): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new WebToolError("WEB_SEARCH_INVALID_QUERY", "queries must contain at least one query");
  }
  if (value.length > maxQueries) {
    throw new WebToolError(
      "WEB_SEARCH_INVALID_QUERY",
      `queries must contain at most ${maxQueries} items`,
    );
  }
  const queries = value.map((item) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new WebToolError("WEB_SEARCH_INVALID_QUERY", "each query must be a non-empty string");
    }
    return item;
  });
  return [...new Set(queries)];
}

/** Model-facing batched search tool. Results are merged deterministically. */
export function createWebSearchTool(
  provider: WebSearchProvider,
  options: { readonly maxResults?: number; readonly maxQueries?: number } = {},
): AgentTool {
  if (!provider || typeof provider.search !== "function") {
    throw new TypeError("A web search provider is required");
  }
  const maxResults = positiveInteger(options.maxResults ?? 8, "maxResults");
  const maxQueries = positiveInteger(options.maxQueries ?? 4, "maxQueries");
  return {
    definition: {
      name: "web_search",
      description: `Search the web for current information. Provide 1-${maxQueries} queries; results include citeable source URLs.`,
      parameters: {
        type: "object",
        properties: {
          queries: {
            type: "array",
            description: `Non-empty search queries (maximum ${maxQueries})`,
            items: { type: "string" },
          },
        },
        required: ["queries"],
        additionalProperties: false,
      },
    },
    async execute(arguments_, context): Promise<ToolResult> {
      try {
        if (!provider.available()) {
          throw new WebToolError("WEB_PROVIDER_UNAVAILABLE", "Web search provider is unavailable");
        }
        const queries = parseWebSearchQueries(arguments_.queries, maxQueries);
        const result = await runSearchBatch(provider, queries, maxResults, context.signal);
        return success(result);
      } catch (error: unknown) {
        return failure(error);
      }
    },
  };
}

async function runSearchBatch(
  provider: WebSearchProvider,
  queries: readonly string[],
  maxResults: number,
  signal?: AbortSignal,
): Promise<WebSearchResult> {
  if (signal?.aborted) throw new WebToolError("WEB_ABORTED", "Web search was aborted");
  const controller = new AbortController();
  const batchSignal = signal === undefined
    ? controller.signal
    : AbortSignal.any([signal, controller.signal]);
  const results: WebSearchResult[] = new Array(queries.length);
  let firstFailure: unknown;
  await Promise.all(queries.map(async (query, index) => {
    try {
      results[index] = await provider.search({ query, maxResults }, batchSignal);
    } catch (error: unknown) {
      firstFailure ??= error;
      controller.abort(error);
    }
  }));
  if (firstFailure !== undefined) throw firstFailure;
  return mergeSearchResults(results, maxResults);
}

function mergeSearchResults(
  results: readonly WebSearchResult[],
  maxResults: number,
): WebSearchResult {
  const sources: WebSearchSource[] = [];
  const seen = new Set<string>();
  const maxRank = Math.max(0, ...results.map((result) => result.sources.length));
  let truncated = results.some((result) => result.truncated);
  for (let rank = 0; rank < maxRank; rank += 1) {
    for (const result of results) {
      const source = result.sources[rank];
      if (source === undefined || seen.has(source.url)) continue;
      if (sources.length >= maxResults) {
        truncated = true;
        return { sources, truncated };
      }
      seen.add(source.url);
      sources.push(source);
    }
  }
  return { sources, truncated };
}

function boundFetchResult(result: WebFetchResult, maxOutputChars: number): WebFetchResult {
  if (result.body.content.length <= maxOutputChars) return result;
  return {
    ...result,
    body: { ...result.body, content: result.body.content.slice(0, maxOutputChars) },
    truncated: true,
  };
}

function resolveLimits(overrides: Partial<WebFetchLimits> | undefined): WebFetchLimits {
  const limits = { ...DEFAULT_WEB_FETCH_LIMITS, ...(overrides ?? {}) };
  positiveInteger(limits.maxUrlLength, "maxUrlLength");
  positiveInteger(limits.maxResponseBytes, "maxResponseBytes");
  positiveInteger(limits.maxBodyChars, "maxBodyChars");
  positiveInteger(limits.timeoutMs, "timeoutMs");
  positiveInteger(limits.maxRedirects + 1, "maxRedirects");
  if (limits.userAgent.trim().length === 0) throw new RangeError("userAgent must not be empty");
  return limits;
}

function createDnsSafeFetch(
  resolver: WebAddressResolver,
  pinnedFetch: WebPinnedFetchFunction,
): WebFetchFunction {
  return async (input, init = {}) => {
    const url = input instanceof URL ? new URL(input) : new URL(input);
    const hostname = normalizeHostname(url.hostname);
    const signal = init.signal ?? undefined;
    throwIfAborted(signal);
    const addresses = await waitForAbortable(resolver(hostname, signal), signal);
    throwIfAborted(signal);
    if (addresses.length === 0) {
      throw new WebToolError(
        "WEB_PROVIDER_ERROR",
        `Web target did not resolve to an address: ${hostname}`,
      );
    }
    for (const resolved of addresses) {
      const actualFamily = isIP(resolved.address);
      if (actualFamily === 0 || actualFamily !== resolved.family) {
        throw new WebToolError(
          "WEB_URL_BLOCKED",
          `Web target resolved to an invalid address: ${hostname}`,
        );
      }
      if (actualFamily === 4
        ? isPrivateIpv4(resolved.address)
        : isPrivateIpv6(resolved.address)) {
        // Reject the whole DNS answer instead of silently choosing a public
        // sibling. A mixed answer is a common rebinding/SSRF bypass shape.
        throw new WebToolError(
          "WEB_URL_BLOCKED",
          `Web target resolved to a non-public address: ${hostname}`,
        );
      }
    }
    let lastFailure: unknown;
    for (const address of addresses) {
      throwIfAborted(signal);
      try {
        return await waitForAbortable(pinnedFetch(url, address, init), signal);
      } catch (error: unknown) {
        throwIfAborted(signal);
        lastFailure = error;
      }
    }
    throw lastFailure ?? new WebToolError(
      "WEB_PROVIDER_ERROR",
      `No validated address could be reached: ${hostname}`,
    );
  };
}

async function resolveHostAddresses(
  hostname: string,
  signal?: AbortSignal,
): Promise<readonly WebResolvedAddress[]> {
  throwIfAborted(signal);
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    return [{ address: hostname, family: literalFamily }];
  }
  let records: Array<{ address: string; family: number }>;
  try {
    records = await dnsLookup(hostname, { all: true, order: "verbatim" });
  } catch (error: unknown) {
    throwIfAborted(signal);
    throw new WebToolError(
      "WEB_PROVIDER_ERROR",
      `Web target could not be resolved: ${hostname}`,
      { cause: error },
    );
  }
  throwIfAborted(signal);
  return records.map((record) => {
    if (record.family !== 4 && record.family !== 6) {
      throw new WebToolError(
        "WEB_PROVIDER_ERROR",
        `Web target resolved to an unsupported address family: ${hostname}`,
      );
    }
    return { address: record.address, family: record.family };
  });
}

function pinnedNodeFetch(
  url: URL,
  address: WebResolvedAddress,
  init: RequestInit = {},
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  if (init.body !== undefined && init.body !== null) {
    return Promise.reject(new TypeError("The bounded web transport does not accept request bodies"));
  }
  const headers = new Headers(init.headers);
  headers.set("host", url.host);
  const requestHeaders: Record<string, string> = {};
  headers.forEach((value, name) => {
    requestHeaders[name] = value;
  });
  const hostname = normalizeHostname(url.hostname);
  const baseOptions = {
    protocol: url.protocol,
    hostname: address.address,
    family: address.family,
    ...(url.port.length === 0 ? {} : { port: url.port }),
    path: `${url.pathname}${url.search}`,
    method,
    headers: requestHeaders,
    ...(init.signal === undefined || init.signal === null ? {} : { signal: init.signal }),
  };

  return new Promise<Response>((resolve, reject) => {
    const onResponse = (message: IncomingMessage): void => {
      try {
        resolve(responseFromIncomingMessage(message, method));
      } catch (error: unknown) {
        message.destroy();
        reject(error);
      }
    };
    const request = url.protocol === "https:"
      ? httpsRequest({
        ...baseOptions,
        // Connect to the validated address, but authenticate the original
        // URL identity. DNS names retain SNI; IP literals intentionally do not.
        servername: isIP(hostname) === 0 ? hostname : "",
        checkServerIdentity: (_servername, certificate) => (
          checkServerIdentity(hostname, certificate)
        ),
      }, onResponse)
      : httpRequest(baseOptions, onResponse);
    request.once("error", reject);
    request.end();
  });
}

function responseFromIncomingMessage(message: IncomingMessage, method: string): Response {
  const status = message.statusCode;
  if (status === undefined) {
    throw new WebToolError("WEB_PROVIDER_ERROR", "Web server returned no HTTP status");
  }
  const headers = new Headers();
  for (let index = 0; index < message.rawHeaders.length; index += 2) {
    const name = message.rawHeaders[index];
    const value = message.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  const hasBody = method !== "HEAD" && status !== 204 && status !== 205 && status !== 304;
  if (!hasBody) message.destroy();
  const body = hasBody
    ? Readable.toWeb(message) as ReadableStream<Uint8Array>
    : null;
  return new Response(body, {
    status,
    ...(message.statusMessage === undefined ? {} : { statusText: message.statusMessage }),
    headers,
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function waitForAbortable<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function normalizeHostname(value: string): string {
  return value.replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase();
}

function validateWebUrl(value: string, maxLength: number): URL {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new WebToolError("WEB_INVALID_URL", "URL must be a non-empty string within the URL length limit");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error: unknown) {
    throw new WebToolError("WEB_INVALID_URL", "URL is invalid", { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebToolError("WEB_INVALID_URL", "Only HTTP(S) URLs are supported");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WebToolError("WEB_URL_BLOCKED", "Credential-bearing URLs are not allowed");
  }
  const hostname = normalizeHostname(url.hostname);
  if (isBlockedHostname(hostname)) {
    throw new WebToolError("WEB_URL_BLOCKED", "Local and private network targets are not allowed");
  }
  return url;
}

function isBlockedHostname(hostname: string): boolean {
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
  if (kind === 4) return isPrivateIpv4(hostname);
  if (kind === 6) return isPrivateIpv6(hostname);
  return false;
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;
  const [first, second] = octets as [number, number, number, number];
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && (second === 0 || second === 168))
    || (first === 192 && second === 88 && octets[2] === 99)
    || (first === 198 && second >= 18 && second <= 19)
    || (first === 198 && second === 51)
    || (first === 203 && second === 0)
    || first >= 224;
}

function isPrivateIpv6(hostname: string): boolean {
  // URL.hostname is bracketed for IPv6 in Node.  Expand rather than relying
  // on textual prefixes: URL canonicalization turns an IPv4-mapped address
  // such as `::ffff:127.0.0.1` into `::ffff:7f00:1`, which otherwise bypasses
  // a dotted-quad-only check.
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  const groups = expandIpv6(normalized);
  if (groups === undefined) return true;
  if (groups.every((group) => group === 0)
    || (groups.length === 8 && groups[7] === 1 && groups.slice(0, 7).every((group) => group === 0))) {
    return true;
  }
  const first = groups[0] ?? 0;
  if ((first & 0xfe00) === 0xfc00 // unique-local fc00::/7
    || (first & 0xffc0) === 0xfe80 // link-local fe80::/10
    || (first & 0xffc0) === 0xfec0 // deprecated site-local fec0::/10
    || (first === 0x0064 && groups[1] === 0xff9b && groups[2] === 1) // local NAT64 64:ff9b:1::/48
    || (first === 0x0100 && groups.slice(1, 4).every((group) => group === 0)) // discard-only 100::/64
    || (first === 0x2001 && groups[1] === 0) // Teredo/special assignment 2001::/32
    || (first === 0x2001 && groups[1] === 2 && groups[2] === 0) // benchmark 2001:2::/48
    || (first === 0x2001 && groups[1] === 0x0db8) // documentation 2001:db8::/32
    || first === 0x2002 // deprecated 6to4 2002::/16
    || (first & 0xff00) === 0xff00) { // multicast ff00::/8
    return true;
  }
  // The well-known NAT64 prefix embeds an IPv4 destination in its last
  // 32 bits. Preserve public NAT64 reachability while inheriting IPv4 blocks.
  if (first === 0x0064
    && groups[1] === 0xff9b
    && groups.slice(2, 6).every((group) => group === 0)
    && isPrivateIpv4(ipv4FromIpv6Groups(groups[6] ?? 0, groups[7] ?? 0))) {
    return true;
  }
  // IPv4-mapped and IPv4-compatible IPv6 addresses inherit the IPv4 policy.
  if (groups.length === 8
    && groups.slice(0, 5).every((group) => group === 0)
    && (groups[5] === 0xffff || groups[5] === 0)) {
    const mapped = `${(groups[6] ?? 0) >> 8}.${(groups[6] ?? 0) & 0xff}.${(groups[7] ?? 0) >> 8}.${(groups[7] ?? 0) & 0xff}`;
    return isPrivateIpv4(mapped);
  }
  return false;
}

function ipv4FromIpv6Groups(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/** Expand an IPv6 literal into eight 16-bit groups, including IPv4 tails. */
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
        result.push(((octets[0] ?? -1) << 8) | (octets[1] ?? -1));
        result.push(((octets[2] ?? -1) << 8) | (octets[3] ?? -1));
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

async function readWebResponse(
  response: Response,
  url: URL,
  limits: WebFetchLimits,
  signal?: AbortSignal,
): Promise<WebFetchResult> {
  const header = response.headers.get("content-type") ?? "text/plain";
  let kind: WebFetchBody["kind"];
  try {
    kind = contentKind(header);
  } catch (error: unknown) {
    await cancelBody(response);
    throw error;
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && Number.isFinite(Number(declared)) && Number(declared) > limits.maxResponseBytes) {
    await cancelBody(response);
    throw new WebToolError("WEB_RESPONSE_TOO_LARGE", "Response exceeds the configured byte limit");
  }
  const bytes = await readCappedBody(response, limits.maxResponseBytes, signal);
  const charset = /charset\s*=\s*([^;\s]+)/iu.exec(header)?.[1] ?? "utf-8";
  let decoder: InstanceType<typeof TextDecoder>;
  try {
    decoder = new TextDecoder(charset);
  } catch (error: unknown) {
    throw new WebToolError("WEB_UNSUPPORTED_CONTENT_TYPE", `Unsupported response charset: ${charset}`, { cause: error });
  }
  const decoded = decoder.decode(bytes.bytes);
  const truncated = bytes.truncated || decoded.length > limits.maxBodyChars;
  return {
    url: url.toString(),
    statusCode: response.status,
    contentType: header,
    body: { kind, content: decoded.slice(0, limits.maxBodyChars) },
    truncated,
  };
}

function contentKind(contentType: string): WebFetchBody["kind"] {
  const normalized = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (normalized === "text/html" || normalized === "application/xhtml+xml") return "html";
  if (normalized.startsWith("text/") || normalized.includes("json") || normalized.includes("xml")
    || normalized.includes("javascript") || normalized === "application/graphql") return "text";
  throw new WebToolError("WEB_UNSUPPORTED_CONTENT_TYPE", `Unsupported response content type: ${normalized || "unknown"}`);
}

async function readCappedBody(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean }> {
  if (response.body === null) return { bytes: new Uint8Array(0), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      const next = await reader.read();
      if (next.done) break;
      const remaining = maxBytes - total;
      if (next.value.byteLength > remaining) {
        chunks.push(next.value.subarray(0, Math.max(remaining, 0)));
        total += Math.max(remaining, 0);
        truncated = true;
        break;
      }
      chunks.push(next.value);
      total += next.value.byteLength;
      if (total === maxBytes) {
        const afterCap = await reader.read();
        if (!afterCap.done) truncated = true;
        break;
      }
    }
  } catch (error: unknown) {
    throw new WebToolError("WEB_PROVIDER_ERROR", "Response body could not be read", { cause: error });
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

function timeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new WebToolError("WEB_TIMEOUT", "Web request timed out"));
  }, timeoutMs);
  timeout.unref?.();
  const onAbort = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function sameOrigin(left: URL, right: URL): boolean {
  return left.protocol === right.protocol && left.hostname === right.hostname && left.port === right.port;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function success(value: unknown): ToolResult {
  return { content: JSON.stringify(value), isError: false };
}

function failure(error: unknown): ToolResult {
  if (error instanceof WebToolError) {
    return { content: JSON.stringify({ error: { code: error.code, message: error.message } }), isError: true };
  }
  return { content: JSON.stringify({ error: { code: "WEB_PROVIDER_ERROR", message: error instanceof Error ? error.message : "Web tool failed" } }), isError: true };
}
