import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ModelResponse } from "../../src/domain/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import { executeRun } from "../../src/runtime/index.js";
import type { WebFetchProvider, WebSearchProvider } from "../../src/tools/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runtime network tool composition", () => {
  it("registers injected web providers only when network is explicitly enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-network-runtime-"));
    roots.push(root);
    const fetchProvider: WebFetchProvider = {
      id: "test-fetch",
      available: () => true,
      fetch: async ({ url }) => ({
        url,
        statusCode: 200,
        contentType: "text/plain",
        body: { kind: "text", content: "provider body" },
        truncated: false,
      }),
    };
    const searchProvider: WebSearchProvider = {
      id: "test-search",
      available: () => true,
      search: async ({ query }) => ({
        sources: [{ url: `https://example.test/${query}`, title: query }],
        truncated: false,
      }),
    };
    const model = new ScriptedModel([
      toolResponse("web_fetch", "web-call", { url: "https://example.test/page" }),
      response("done"),
    ]);

    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted-main",
      message: "Fetch the page",
      policy: { tetoEnabled: false, maxMainStepsPerActivation: 2 },
      allowNetwork: true,
    }, {
      mainModel: model,
      webFetchProvider: fetchProvider,
      webSearchProvider: searchProvider,
    });

    expect(result.completed).toBe(true);
    expect(model.requests[0]?.tools.map((tool) => tool.name)).toContain("web_fetch");
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      toolName: "web_fetch",
      isError: false,
    });
  });
});

function toolResponse(name: string, id: string, arguments_: Record<string, unknown>): ModelResponse {
  return {
    content: "",
    toolCalls: [{ id, name, arguments: structuredClone(arguments_) }],
    stopReason: "toolUse",
    usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
  };
}

function response(content: string): ModelResponse {
  return {
    content,
    toolCalls: [],
    stopReason: "stop",
    usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
  };
}
