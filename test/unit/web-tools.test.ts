import { describe, expect, it, vi } from "vitest";

import {
  createWebFetchTool,
  createWebSearchTool,
  createWorkspaceTools,
  DuckDuckGoSearchProvider,
  HttpWebFetchProvider,
  parseDuckDuckGoResults,
  type WebFetchFunction,
} from "../../src/tools/index.js";

function context(signal?: AbortSignal) {
  return { runId: "run-1", workspace: "/tmp", operationId: "operation-1", ...(signal === undefined ? {} : { signal }) };
}

function response(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
    ...init,
  });
}

describe("web tools", () => {
  it("keeps network opt-in while exposing both Mowe web capabilities", () => {
    expect(createWorkspaceTools().map((tool) => tool.definition.name)).not.toContain("web_fetch");
    expect(createWorkspaceTools({ allowNetwork: true }).map((tool) => tool.definition.name)).toEqual([
      "read_file",
      "read_many",
      "list_files",
      "grep",
      "find",
      "file_info",
      "git_status",
      "git_log",
      "git_show",
      "git_diff",
      "web_fetch",
      "web_search",
    ]);
    expect(createWorkspaceTools({ allowNetwork: true }).map((tool) => tool.definition.name))
      .toEqual(createWorkspaceTools({ allowWeb: true }).map((tool) => tool.definition.name));
  });

  it("fetches bounded text and preserves HTTP status metadata", async () => {
    const fetch: WebFetchFunction = vi.fn(async () => response("0123456789", {
      status: 404,
      headers: { "content-type": "text/plain" },
    }));
    const provider = new HttpWebFetchProvider({
      fetch,
      limits: { maxBodyChars: 5, maxResponseBytes: 1_024 },
    });
    const result = await createWebFetchTool(provider, 4_000).execute(
      { url: "https://example.test/missing" },
      context(),
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      url: "https://example.test/missing",
      statusCode: 404,
      contentType: "text/plain",
      body: { kind: "text", content: "01234" },
      truncated: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ redirect: "manual", method: "GET" }),
    );
  });

  it("converts HTML to a bounded HTML body without executing it", async () => {
    const fetch: WebFetchFunction = vi.fn(async () => response(
      "<html><script>alert(1)</script><body><h1>Hello</h1></body></html>",
      { headers: { "content-type": "text/html; charset=utf-8" } },
    ));
    const result = await createWebFetchTool(new HttpWebFetchProvider({ fetch }), 50).execute(
      { url: "https://example.test/page" },
      context(),
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content).body).toMatchObject({ kind: "html" });
    expect(JSON.parse(result.content).body.content).toContain("<script>");
  });

  it("blocks credential-bearing, private, and non-HTTP URLs before fetch", async () => {
    const fetch: WebFetchFunction = vi.fn(async () => response("should not run"));
    const provider = createWebFetchTool(new HttpWebFetchProvider({ fetch }));
    for (const url of [
      "file:///etc/passwd",
      "http://127.0.0.1/admin",
      "http://192.168.1.1/",
      "http://192.88.99.1/",
      "http://198.51.100.1/",
      "http://metadata.google.internal/",
      "http://service.internal./",
      // URL canonicalizes mapped IPv4 literals to hexadecimal groups; the
      // fetch guard must still classify them as private addresses.
      "https://[0:0:0:0:0:ffff:7f00:1]/",
      "https://[::127.0.0.1]/",
      "https://[fec0::1]/",
      "https://[64:ff9b::a9fe:a9fe]/",
      "https://[64:ff9b:1::1]/",
      "https://[100::1]/",
      "https://[2001:2::1]/",
      "https://[2001:db8::1]/",
      "https://[2002:a9fe:a9fe::]/",
      "https://user:password@example.test/",
    ]) {
      const result = await provider.execute({ url }, context());
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).error.code).toMatch(/WEB_(INVALID_URL|URL_BLOCKED)/u);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("validates every DNS answer and pins the request to a public address", async () => {
    const resolveAddresses = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 as const },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 as const },
    ]);
    const pinnedFetch = vi.fn(async () => response("pinned"));
    const provider = new HttpWebFetchProvider({ resolveAddresses, pinnedFetch });

    await expect(provider.fetch({ url: "https://example.test/page" })).resolves.toMatchObject({
      body: { content: "pinned" },
    });
    expect(resolveAddresses).toHaveBeenCalledWith("example.test", expect.any(AbortSignal));
    expect(pinnedFetch).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "example.test", pathname: "/page" }),
      { address: "93.184.216.34", family: 4 },
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
  });

  it("rejects a mixed public/private DNS answer before opening a connection", async () => {
    const pinnedFetch = vi.fn(async () => response("must not run"));
    const provider = new HttpWebFetchProvider({
      resolveAddresses: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
      pinnedFetch,
    });

    await expect(provider.fetch({ url: "https://example.test/" }))
      .rejects.toMatchObject({ code: "WEB_URL_BLOCKED" });
    expect(pinnedFetch).not.toHaveBeenCalled();
  });

  it("falls back to another already-validated address after a connection failure", async () => {
    const pinnedFetch = vi.fn()
      .mockRejectedValueOnce(new Error("IPv6 route unavailable"))
      .mockResolvedValueOnce(response("fallback"));
    const provider = new HttpWebFetchProvider({
      resolveAddresses: async () => [
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
        { address: "93.184.216.34", family: 4 },
      ],
      pinnedFetch,
    });

    await expect(provider.fetch({ url: "https://example.test/" })).resolves.toMatchObject({
      body: { content: "fallback" },
    });
    expect(pinnedFetch).toHaveBeenCalledTimes(2);
  });

  it("resolves and validates the host again for every redirect hop", async () => {
    const resolveAddresses = vi.fn()
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "10.0.0.4", family: 4 }]);
    const pinnedFetch = vi.fn(async () => response("", {
      status: 302,
      headers: { location: "/next", "content-type": "text/plain" },
    }));
    const provider = new HttpWebFetchProvider({ resolveAddresses, pinnedFetch });

    await expect(provider.fetch({ url: "https://example.test/start" }))
      .rejects.toMatchObject({ code: "WEB_URL_BLOCKED" });
    expect(resolveAddresses).toHaveBeenCalledTimes(2);
    expect(pinnedFetch).toHaveBeenCalledTimes(1);
  });

  it("applies the request timeout while DNS resolution is still pending", async () => {
    const provider = new HttpWebFetchProvider({
      resolveAddresses: async () => await new Promise(() => undefined),
      pinnedFetch: async () => response("must not run"),
      limits: { timeoutMs: 5 },
    });

    await expect(provider.fetch({ url: "https://example.test/" }))
      .rejects.toMatchObject({ code: "WEB_TIMEOUT" });
  });

  it("applies caller cancellation while DNS resolution is still pending", async () => {
    const controller = new AbortController();
    const provider = new HttpWebFetchProvider({
      resolveAddresses: async () => await new Promise(() => undefined),
      pinnedFetch: async () => response("must not run"),
    });

    const pending = provider.fetch({ url: "https://example.test/" }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "WEB_ABORTED" });
  });

  it("follows same-origin redirects and rejects cross-origin hops", async () => {
    const sameOriginFetch: WebFetchFunction = vi.fn()
      .mockResolvedValueOnce(response("", {
        status: 302,
        headers: { location: "/next", "content-type": "text/plain" },
      }))
      .mockResolvedValueOnce(response("done"));
    const provider = new HttpWebFetchProvider({ fetch: sameOriginFetch });
    await expect(provider.fetch({ url: "https://example.test/start" })).resolves.toMatchObject({
      url: "https://example.test/next",
      body: { content: "done" },
    });
    expect(sameOriginFetch).toHaveBeenCalledTimes(2);

    const crossOriginFetch: WebFetchFunction = vi.fn(async () => response("", {
      status: 302,
      headers: { location: "https://other.test/secret" },
    }));
    await expect(new HttpWebFetchProvider({ fetch: crossOriginFetch }).fetch({
      url: "https://example.test/start",
    })).rejects.toMatchObject({ code: "WEB_REDIRECT_BLOCKED" });
  });

  it("returns structured cancellation and unsupported-content errors", async () => {
    const unsupported = new HttpWebFetchProvider({
      fetch: async () => response("binary", { headers: { "content-type": "application/octet-stream" } }),
    });
    await expect(unsupported.fetch({ url: "https://example.test/file" }))
      .rejects.toMatchObject({ code: "WEB_UNSUPPORTED_CONTENT_TYPE" });

    const controller = new AbortController();
    controller.abort();
    const result = await createWebFetchTool(unsupported).execute(
      { url: "https://example.test/file" },
      context(controller.signal),
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error.code).toBe("WEB_ABORTED");
  });

  it("parses DuckDuckGo result links, snippets, entities, and redirect URLs", () => {
    const html = [
      '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1&amp;rut=abc">A &amp; One</a>',
      '<a class="result__snippet">A <b>useful</b> snippet</a></div>',
      '<div class="result"><a class="result__a" href="https://example.com/b">B</a></div>',
    ].join("");
    expect(parseDuckDuckGoResults(html, 8)).toEqual({
      sources: [
        {
          url: "https://example.com/a?x=1",
          title: "A & One",
          snippet: "A useful snippet",
        },
        { url: "https://example.com/b", title: "B" },
      ],
      truncated: false,
    });
  });

  it("rejects custom search endpoints on local and private hosts", () => {
    for (const endpoint of [
      "https://localhost/search",
      "https://search.internal/",
      "https://127.0.0.1/",
      "https://10.0.0.1/",
      "https://169.254.169.254/latest/meta-data/",
      "https://[::1]/",
      "https://[fc00::1]/",
      "https://[::ffff:127.0.0.1]/",
    ]) {
      expect(() => new DuckDuckGoSearchProvider({ endpoint }))
        .toThrow(expect.objectContaining({ code: "WEB_URL_BLOCKED" }));
    }
    expect(() => new DuckDuckGoSearchProvider({ endpoint: "https://search.example.test/" }))
      .not.toThrow();
  });

  it("supports bounded concurrent multi-query search with deterministic deduplication", async () => {
    const provider = new DuckDuckGoSearchProvider({
      fetch: vi.fn(async (input) => {
        const query = new URL(input).searchParams.get("q");
        return response(
          `<a class="result__a" href="https://example.test/shared">${query}</a>`
          + `<a class="result__a" href="https://example.test/${query}">${query}</a>`,
          { headers: { "content-type": "text/html" } },
        );
      }),
    });
    const tool = createWebSearchTool(provider, { maxResults: 3, maxQueries: 2 });
    const result = await tool.execute({ queries: ["one", "two"] }, context());
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({
      sources: [
        { url: "https://example.test/shared", title: "one" },
        { url: "https://example.test/one", title: "one" },
        { url: "https://example.test/two", title: "two" },
      ],
      truncated: false,
    });
  });

  it("rejects empty and over-sized search query lists", async () => {
    const tool = createWebSearchTool({
      id: "test",
      available: () => true,
      search: async () => ({ sources: [], truncated: false }),
    }, { maxQueries: 2 });
    for (const queries of [[], ["one", "two", "three"], ["  "]]) {
      const result = await tool.execute({ queries }, context());
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).error.code).toBe("WEB_SEARCH_INVALID_QUERY");
    }
  });
});
