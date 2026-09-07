import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_BUNDLED_SKILL_SOURCE_ID,
  DEFAULT_LOCAL_SKILL_ROOTS,
  DEFAULT_LOCAL_SKILL_SOURCE_ID,
  planCliSkillDiscovery,
} from "../../src/config/skill-discovery.js";
import { createConfiguredEdgeComposition } from "../../src/config/edge-factory.js";
import type { ResolvedSettings } from "../../src/config/settings.js";
import { createSkillsEdgeAdapter } from "../../src/mowe/edges/skills.js";
import { createBundledSkillsEdgeAdapter } from "../../src/mowe/edges/bundled-skills.js";
import { ScriptedModel } from "../../src/model/index.js";
import {
  createRegistryEdgeTurnSnapshotProvider,
  executeRun,
} from "../../src/runtime/index.js";

function settings(
  edges: Partial<ResolvedSettings["edges"]> = {},
): ResolvedSettings {
  return {
    model: "scripted",
    tetoModel: "scripted",
    tetoEnabled: false,
    maxSteps: 1,
    maxOutputTokens: 64,
    dataDir: "/workspace/.nausicaa",
    allowShell: false,
    allowWrite: false,
    allowNetwork: false,
    edges: {
      enabled: true,
      refreshOnStart: true,
      refreshTimeoutMs: 60_000,
      sources: [],
      grants: [],
      ...edges,
    },
    fukaiCompaction: {
      enabled: false,
      provider: "none",
      maxInputTokens: 32_000,
      maxOutputTokens: 4_096,
      maxWallClockMs: 60_000,
      thresholdRatio: 0.8,
      retainRatio: 0.16,
      minimumGainTokens: 512,
    },
  };
}

describe("CLI Skill discovery policy", () => {
  it("keeps local Skill discovery available when external sources are explicitly disabled", () => {
    const plan = planCliSkillDiscovery(settings({
      enabled: false,
      sources: [{ sourceId: "docs", type: "mcp", command: "docs-server" }],
    }));

    expect(plan.localSkillSourceId).toBe(DEFAULT_LOCAL_SKILL_SOURCE_ID);
    expect(plan.localSkillRoots).toEqual(DEFAULT_LOCAL_SKILL_ROOTS);
    expect(plan.edges.enabled).toBe(true);
    expect(plan.edges.sources).toEqual([
      expect.objectContaining({
        sourceId: DEFAULT_LOCAL_SKILL_SOURCE_ID,
        type: "skill",
        location: ".",
        enabled: true,
      }),
      expect.objectContaining({ sourceId: "docs", type: "mcp", enabled: false }),
      expect.objectContaining({ sourceId: DEFAULT_BUNDLED_SKILL_SOURCE_ID, type: "skill", enabled: true }),
    ]);
  });

  it("keeps configured external sources and refresh enabled with the new defaults", () => {
    const plan = planCliSkillDiscovery(settings({
      sources: [{ sourceId: "docs", type: "mcp", command: "docs-server" }],
    }));

    expect(plan.edges.enabled).toBe(true);
    expect(plan.edges.refreshOnStart).toBe(true);
    expect(plan.edges.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: DEFAULT_LOCAL_SKILL_SOURCE_ID, enabled: true }),
      expect.objectContaining({ sourceId: "docs", type: "mcp", command: "docs-server" }),
    ]));
  });

  it("treats --no-edges as an explicit opt-out for the implicit source", () => {
    const plan = planCliSkillDiscovery(settings({
      enabled: true,
      sources: [{ sourceId: "docs", type: "mcp", command: "docs-server" }],
    }), { cliEdgesEnabled: false });

    expect(plan.localSkillSourceId).toBeUndefined();
    expect(plan.bundledSkillSourceId).toBeUndefined();
    expect(plan.edges.enabled).toBe(false);
    expect(plan.edges.sources).toEqual([
      expect.objectContaining({ sourceId: "docs", enabled: false }),
    ]);
  });

  it("keeps bundled fallbacks when an explicit Skill source replaces project discovery", () => {
    const plan = planCliSkillDiscovery(settings({
      enabled: true,
      sources: [{ sourceId: "team-skills", type: "skill", location: "team-skills" }],
    }));

    expect(plan.localSkillSourceId).toBeUndefined();
    expect(plan.bundledSkillSourceId).toBe(DEFAULT_BUNDLED_SKILL_SOURCE_ID);
    expect(plan.edges.sources).toEqual([
      expect.objectContaining({ sourceId: "team-skills", type: "skill" }),
      expect.objectContaining({ sourceId: DEFAULT_BUNDLED_SKILL_SOURCE_ID, type: "skill" }),
    ]);
  });

  it("does not collide with a configured source using the reserved local source id", () => {
    const plan = planCliSkillDiscovery(settings({
      sources: [{ sourceId: DEFAULT_LOCAL_SKILL_SOURCE_ID, type: "mcp", command: "server" }],
    }));

    expect(plan.localSkillSourceId).toBeUndefined();
    expect(plan.edges.sources).toEqual([
      expect.objectContaining({ sourceId: DEFAULT_LOCAL_SKILL_SOURCE_ID, type: "mcp" }),
      expect.objectContaining({ sourceId: DEFAULT_BUNDLED_SKILL_SOURCE_ID, type: "skill" }),
    ]);
  });

  it("does not replace a configured source using the bundled source id", () => {
    const plan = planCliSkillDiscovery(settings({
      sources: [{ sourceId: DEFAULT_BUNDLED_SKILL_SOURCE_ID, type: "skill", location: "custom-skills" }],
    }));

    expect(plan.bundledSkillSourceId).toBeUndefined();
    expect(plan.edges.sources).toEqual([
      expect.objectContaining({ sourceId: DEFAULT_BUNDLED_SKILL_SOURCE_ID, location: "custom-skills" }),
    ]);
  });

  it("discovers a project Skill through the default composition", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nausicaa-default-skills-"));
    const skillDirectory = join(workspace, ".agents", "skills", "review-code");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), [
      "---",
      "name: review-code",
      "description: Review project changes",
      "---",
      "Use the review checklist.",
    ].join("\n"));

    const plan = planCliSkillDiscovery(settings());
    const composition = await createConfiguredEdgeComposition({
      workspace,
      settings: plan.edges,
      constructors: {
        skill: (source) => source.sourceId === plan.bundledSkillSourceId
          ? createBundledSkillsEdgeAdapter({ sourceId: source.sourceId })
          : createSkillsEdgeAdapter({
          sourceId: source.sourceId,
          roots: source.sourceId === DEFAULT_LOCAL_SKILL_SOURCE_ID
            ? plan.localSkillRoots
            : [source.location ?? "skills"],
        }),
      },
      startupRefresh: true,
    });
    try {
      expect(composition.snapshot().contextContributions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          sourceType: "skill",
          name: "review-code",
          description: "Review project changes",
        }),
      ]));
      expect(composition.snapshot().contextContributions.map((item) => item.name).sort()).toEqual([
        "code-review", "codebase-map", "review-code", "task-plan",
      ]);
      expect(composition.snapshot().tools).toEqual([]);
    } finally {
      await composition.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("exposes the default catalog and paired skill tool on the first Run request", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nausicaa-default-skills-run-"));
    const skillDirectory = join(workspace, ".agents", "skills", "review-code");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), [
      "---",
      "name: review-code",
      "description: Review project changes",
      "---",
      "PRIVATE_SKILL_BODY_MUST_NOT_BE_IN_FIRST_REQUEST",
    ].join("\n"));

    const plan = planCliSkillDiscovery(settings());
    const composition = await createConfiguredEdgeComposition({
      workspace,
      settings: plan.edges,
      constructors: {
        skill: (source) => source.sourceId === plan.bundledSkillSourceId
          ? createBundledSkillsEdgeAdapter({ sourceId: source.sourceId })
          : createSkillsEdgeAdapter({
          sourceId: source.sourceId,
          roots: source.sourceId === DEFAULT_LOCAL_SKILL_SOURCE_ID
            ? plan.localSkillRoots
            : [source.location ?? "skills"],
          conflictMode: "first",
        }),
      },
      startupRefresh: true,
    });
    const provider = createRegistryEdgeTurnSnapshotProvider(composition.registry);
    const model = new ScriptedModel([(request) => {
      expect(request.tools.some((tool) => tool.name === "skill")).toBe(true);
      expect(request.messages.some((message) => (
        message.content.includes('<available_skills generation="1">')
          && message.content.includes("review-code")
      ))).toBe(true);
      expect(request.messages.some((message) => (
        message.content.includes("PRIVATE_SKILL_BODY_MUST_NOT_BE_IN_FIRST_REQUEST")
      ))).toBe(false);
      return {
        content: "done",
        toolCalls: [],
        stopReason: "stop",
        usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0 },
      };
    }]);

    try {
      const result = await executeRun({
        workspace,
        dataDir: join(workspace, "state"),
        model: "scripted",
        message: "Inspect the workspace",
        policy: { maxMainSteps: 1, tetoEnabled: false },
        edgeSnapshotProvider: provider,
        closeEdgeCompositionOnClose: false,
      }, {
        mainModel: model,
        createRunId: () => "default-skill-first-request",
      });
      expect(result).toMatchObject({ completed: true, finalText: "done" });
    } finally {
      await composition.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
