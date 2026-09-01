import { describe, expect, it } from "vitest";

import type { EdgeContextContributionSummary } from "../../src/mowe/edge-types.js";
import { sha256 } from "../../src/ledger/hash.js";
import { MoweEdgeRegistry } from "../../src/mowe/edge-registry.js";
import {
  captureRuntimeSkillCatalog,
  createRuntimeSkillTool,
  renderRuntimeSkillCatalog,
} from "../../src/runtime/skill-tool.js";

function summary(
  name: string,
  description: string,
  options: Partial<Pick<EdgeContextContributionSummary, "sourceType" | "disabled" | "sourceId" | "contributionId">> = {},
): EdgeContextContributionSummary {
  return {
    kind: "context",
    sourceId: options.sourceId ?? "skills",
    contributionId: options.contributionId ?? `skill:${name}`,
    sourceType: options.sourceType ?? "skill",
    name,
    description,
    disabled: options.disabled ?? false,
  };
}

describe("runtime Skill catalog and tool", () => {
  it("captures only invocable Skills, sorts them, normalizes descriptions, and escapes rendering", () => {
    const snapshot = {
      generation: 7,
      contextContributions: [
        summary("zeta", "  zeta\n description "),
        summary("disabled", "manual", { disabled: true }),
        summary("plugin", "plugin", { sourceType: "plugin" }),
        summary("same", "first", { sourceId: "a", contributionId: "one" }),
        summary("same", "second", { sourceId: "b", contributionId: "two" }),
        summary("alpha", "<safe> & \"quoted\"\0line"),
      ],
    };
    const registry = { loadContribution: async () => ({}) };
    const catalog = captureRuntimeSkillCatalog({ snapshot, registry });

    expect(catalog.complete).toBe(true);
    expect(catalog.entries.map((entry) => entry.name)).toEqual(["alpha", "zeta"]);
    expect(catalog.modelEntries).toEqual([
      { name: "alpha", description: '<safe> & "quoted" line' },
      { name: "zeta", description: "zeta description" },
    ]);
    expect(catalog.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "duplicate-name", name: "same" }),
    ]));
    expect(renderRuntimeSkillCatalog(catalog)).toContain("&lt;safe&gt; &amp; &quot;quoted&quot;");
    expect(renderRuntimeSkillCatalog(catalog)).not.toContain("<safe>");
  });

  it("pins exact summary and snapshot, and returns stable instruction/resource envelopes", async () => {
    const snapshot = { generation: 3, contextContributions: [summary("docs", "docs")] };
    let call: { summary: unknown; context: Record<string, unknown> } | undefined;
    const registry = {
      loadContribution: async (candidate: EdgeContextContributionSummary, context: Record<string, unknown>) => {
        call = { summary: candidate, context };
        return {
          ...candidate,
          body: "# Docs\n",
        };
      },
    };
    const catalog = captureRuntimeSkillCatalog({ snapshot, registry });
    const tool = createRuntimeSkillTool(catalog, registry, { snapshot, workspace: "/workspace" });

    const instructions = await tool.execute({ name: "docs" }, {
      runId: "run",
      workspace: "/workspace",
      operationId: "op",
    });
    expect(instructions.isError).toBe(false);
    expect(JSON.parse(instructions.content)).toEqual({
      kind: "skill_instructions",
      name: "docs",
      generation: 3,
      contentHash: sha256("# Docs\n"),
      instructions: "# Docs\n",
    });
    expect(call?.summary).toBe(catalog.entries[0]?.summary);
    expect(call?.context.snapshot).toBe(snapshot);
    expect(call?.context.workspace).toBe("/workspace");

    if (call === undefined) throw new Error("expected registry call");
    const resourceRegistry = {
      loadContribution: async (candidate: EdgeContextContributionSummary, context: Record<string, unknown>) => {
        call = { summary: candidate, context };
        return withLoadedResources({
          ...candidate,
          body: "# Docs\n",
        }, [{ relativePath: "references/example.md", content: "example\n" }]);
      },
    };
    const resourceTool = createRuntimeSkillTool(catalog, resourceRegistry, { snapshot });
    const resource = await resourceTool.execute({ name: "docs", resourcePath: "./references//example.md" }, {
      runId: "run",
      workspace: "/workspace",
      operationId: "resource",
    });
    expect(resource.isError).toBe(false);
    expect(JSON.parse(resource.content)).toMatchObject({
      kind: "skill_resource",
      name: "docs",
      generation: 3,
      resourcePath: "references/example.md",
      content: "example\n",
    });
    expect(call?.context.resourcePaths).toEqual(["references/example.md"]);
  });

  it("fails closed without a loader and bounds exact-name failures", async () => {
    const snapshot = { generation: 1, contextContributions: [summary("docs", "docs")] };
    const noLoader = captureRuntimeSkillCatalog({ snapshot, registry: {} as never });
    expect(noLoader.complete).toBe(false);
    expect(noLoader.entries).toEqual([]);
    expect(noLoader.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "loader-unavailable" }),
    ]));

    const registry = { loadContribution: async () => { throw new Error("unexpected"); } };
    const catalog = captureRuntimeSkillCatalog({ snapshot, registry });
    const tool = createRuntimeSkillTool(catalog, registry);
    const unknown = await tool.execute({ name: "other" }, {
      runId: "run",
      workspace: "/workspace",
      operationId: "unknown",
    });
    expect(unknown).toEqual({
      content: JSON.stringify({ error: "Skill other is unknown or unavailable" }),
      isError: true,
    });
  });

  it("forwards an explicit file bound and never lets body output exceed it", async () => {
    const snapshot = { generation: 1, contextContributions: [summary("docs", "docs")] };
    let received: Record<string, unknown> | undefined;
    const registry = {
      loadContribution: async (
        candidate: EdgeContextContributionSummary,
        context: Record<string, unknown>,
      ) => {
        received = context;
        return { ...candidate, body: "12345" };
      },
    };
    const catalog = captureRuntimeSkillCatalog({ snapshot, registry });
    const tool = createRuntimeSkillTool(catalog, registry, {
      snapshot,
      maxFileBytes: 4,
      maxBodyBytes: 1_024,
    });
    const result = await tool.execute({ name: "docs" }, {
      runId: "run",
      workspace: "/workspace",
      operationId: "file-bound",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("byte budget");
    expect(received?.maxFileBytes).toBe(4);
    expect(received?.maxBodyBytes).toBe(4);
  });

  it("fails closed when the rendered catalog exceeds its byte budget", () => {
    const snapshot = { generation: 1, contextContributions: [summary("docs", "description")] };
    const registry = { loadContribution: async () => ({}) };
    const catalog = captureRuntimeSkillCatalog({ snapshot, registry, maxTotalBytes: 1 });
    expect(catalog.complete).toBe(false);
    expect(catalog.entries).toEqual([]);
    expect(catalog.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "catalog-limit" }),
    ]));
  });

  it("keeps Skills adapter resources available through the registry boundary", async () => {
    const candidate = summary("docs", "docs");
    const registry = new MoweEdgeRegistry({
      adapters: [{
        sourceId: "skills",
        sourceType: "skill",
        discoverContributions: async () => [candidate],
        loadContribution: async (loadedSummary) => {
          const loaded = { ...loadedSummary, body: "# Docs\n" };
          Object.defineProperty(loaded, "resources", {
            configurable: false,
            enumerable: false,
            value: [{ relativePath: "references/example.md", content: "example\n" }],
          });
          return loaded;
        },
      }],
    });
    try {
      const snapshot = await registry.refresh();
      const catalog = captureRuntimeSkillCatalog({ snapshot, registry });
      const tool = createRuntimeSkillTool(catalog, registry, { snapshot });
      const result = await tool.execute({ name: "docs", resourcePath: "references/example.md" }, {
        runId: "run",
        workspace: "/workspace",
        operationId: "registry-resource",
      });
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.content)).toMatchObject({
        kind: "skill_resource",
        resourcePath: "references/example.md",
        content: "example\n",
      });
    } finally {
      await registry.close();
    }
  });

  it("redacts absolute paths from loader failures", async () => {
    const snapshot = { generation: 1, contextContributions: [summary("docs", "docs")] };
    const registry = {
      loadContribution: async () => {
        throw new Error("Cannot inspect Skill resource /Users/private/workspace/secret.txt");
      },
    };
    const catalog = captureRuntimeSkillCatalog({ snapshot, registry });
    const tool = createRuntimeSkillTool(catalog, registry, { snapshot });
    const result = await tool.execute({ name: "docs" }, {
      runId: "run",
      workspace: "/Users/private/workspace",
      operationId: "redaction",
    });
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("/Users/private/workspace");
    expect(result.content).toContain("[PATH]");
  });

  it("bounds the complete resource set returned by a loader", async () => {
    const snapshot = { generation: 1, contextContributions: [summary("docs", "docs")] };
    const registry = {
      loadContribution: async (candidate: EdgeContextContributionSummary) => {
        const loaded = { ...candidate, body: "# Docs\n" };
        Object.defineProperty(loaded, "resources", {
          configurable: false,
          enumerable: false,
          value: [
            { relativePath: "references/example.md", content: "one" },
            { relativePath: "references/other.md", content: "two" },
          ],
        });
        return loaded;
      },
    };
    const catalog = captureRuntimeSkillCatalog({ snapshot, registry });
    const tool = createRuntimeSkillTool(catalog, registry, { snapshot });
    const result = await tool.execute({ name: "docs", resourcePath: "references/example.md" }, {
      runId: "run",
      workspace: "/workspace",
      operationId: "resource-limit",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("returned too many resources");
  });
});

function withLoadedResources(
  value: object,
  resources: readonly { relativePath: string; content: string }[],
): object {
  Object.defineProperty(value, "resources", {
    configurable: false,
    enumerable: false,
    value: resources,
  });
  return value;
}
