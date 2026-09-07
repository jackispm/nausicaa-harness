import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createEdgeSelectionController } from "../../src/cli/edge-selection.js";
import {
  displaySkillInvocation,
  expandSkillInvocation,
  type SkillInvocationSource,
} from "../../src/cli/skill-invocation.js";
import { MoweEdgeRegistry } from "../../src/mowe/edge-registry.js";
import { validateEdgeContextContributionSummary } from "../../src/mowe/edge-adapter.js";
import type { EdgeContextContributionSummary, EdgeContributionAdapter } from "../../src/mowe/edge-types.js";
import { createSkillsEdgeAdapter } from "../../src/mowe/edges/skills.js";
import { captureRuntimeSkillCatalog, createRuntimeSkillTool } from "../../src/runtime/skill-tool.js";

const temporaryRoots: string[] = [];
const registries: MoweEdgeRegistry[] = [];

afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function summary(name = "review", overrides: Partial<EdgeContextContributionSummary> = {}): EdgeContextContributionSummary {
  return {
    kind: "context",
    sourceType: "skill",
    sourceId: "project-skills",
    contributionId: `skill:${name}`,
    name,
    description: "Review this repository",
    disabled: false,
    ...overrides,
  };
}

function sourceFor(rows: readonly EdgeContextContributionSummary[], body = "Review carefully.\n") {
  const snapshot = { generation: 1, contextContributions: rows };
  const loadContribution = vi.fn<SkillInvocationSource["loadContribution"]>(async (selected) => ({ ...selected, body }));
  return { snapshot: () => snapshot, loadContribution };
}

async function fixture(manualOnly = false, body = "Read references/checklist.md.\n") {
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), "nausicaa-skill-invocation-")));
  temporaryRoots.push(workspace);
  const directory = path.join(workspace, "skills", "review");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "SKILL.md");
  await writeFile(file, `---\nname: review\ndescription: Review this repository\n${manualOnly ? "disable-model-invocation: true\n" : ""}---\n${body}`);
  const adapter = createSkillsEdgeAdapter({ sourceId: "project-skills", roots: ["skills"] });
  const registry = new MoweEdgeRegistry({ workspace, adapters: [adapter] });
  registries.push(registry);
  const snapshot = await registry.refresh();
  const controller = createEdgeSelectionController({ registry });
  return { workspace, directory, file, adapter, registry, snapshot, controller };
}

describe("explicit CLI Skill invocation", () => {
  it("leaves ordinary input unchanged without loading or requiring a registry", async () => {
    expect(await expandSkillInvocation("Please review /skill:review", undefined)).toBe("Please review /skill:review");
    expect(await expandSkillInvocation("/skills", undefined)).toBe("/skills");
    await expect(expandSkillInvocation("/skill:", undefined)).rejects.toThrow("Usage:");
    await expect(expandSkillInvocation("/skill:review", undefined)).rejects.toThrow("unavailable");
  });

  it("loads only the requested discovered body from the captured snapshot", async () => {
    const source = sourceFor([summary(), summary("other")]);
    const captured = source.snapshot();
    const expanded = await expandSkillInvocation("/skill:review\nCheck the diff.\nKeep it short.", source);
    expect(expanded).toContain("Review carefully.");
    expect(expanded).toContain("</skill>\n\nCheck the diff.\nKeep it short.");
    expect(displaySkillInvocation(expanded)).toBe("/skill:review Check the diff.\nKeep it short.");
    expect(source.loadContribution).toHaveBeenCalledTimes(1);
    expect(source.loadContribution).toHaveBeenCalledWith(summary(), {
      snapshot: captured,
      invocation: "user",
      maxBodyBytes: 64 * 1024,
    });
  });

  it("rejects unknown names, arbitrary paths and ambiguous aliases without loading", async () => {
    const source = sourceFor([summary(), summary("review", { sourceId: "global-skills" })]);
    await expect(expandSkillInvocation("/skill:missing", source)).rejects.toThrow("Unknown Skill");
    await expect(expandSkillInvocation("/skill:../../secret", source)).rejects.toThrow("Unknown Skill");
    await expect(expandSkillInvocation("/skill:/tmp/SKILL.md", source)).rejects.toThrow("Unknown Skill");
    await expect(expandSkillInvocation("/skill:review", source)).rejects.toThrow("ambiguous");
    expect(source.loadContribution).not.toHaveBeenCalled();
    expect(await expandSkillInvocation("/skill:global-skills:skill:review", source)).toContain("Review carefully.");
    expect(source.loadContribution.mock.calls[0]?.[0].sourceId).toBe("global-skills");
  });

  it("keeps disabled generic entries closed unless they explicitly allow manual invocation", async () => {
    for (const candidate of [summary("review", { disabled: true }), summary("review", { userInvocable: false })]) {
      const source = sourceFor([candidate]);
      await expect(expandSkillInvocation("/skill:review", source)).rejects.toThrow("cannot be invoked");
      expect(source.loadContribution).not.toHaveBeenCalled();
    }
    const manual = sourceFor([summary("review", { disabled: true, userInvocable: true })]);
    expect(await expandSkillInvocation("/skill:review", manual)).toContain("Review carefully.");
  });

  it("rejects loader identity changes, absent bodies and oversized instructions", async () => {
    const source = sourceFor([summary()]);
    source.loadContribution.mockResolvedValueOnce({ ...summary("other"), body: "secret body" });
    await expect(expandSkillInvocation("/skill:review", source)).rejects.toThrow("does not match");
    source.loadContribution.mockResolvedValueOnce(summary());
    await expect(expandSkillInvocation("/skill:review", source)).rejects.toThrow("no instructions");
    source.loadContribution.mockResolvedValueOnce({ ...summary(), body: "x".repeat(64 * 1024 + 1) });
    await expect(expandSkillInvocation("/skill:review", source)).rejects.toThrow("byte limit");
    source.loadContribution.mockResolvedValueOnce({ ...summary(), userInvocable: true, body: "secret body" });
    await expect(expandSkillInvocation("/skill:review", source)).rejects.toThrow("does not match");
    source.loadContribution.mockResolvedValueOnce({
      ...summary(), body: "secret body", provenance: { upstreamName: "forged", upstreamVersion: "1", license: "MIT" },
    });
    await expect(expandSkillInvocation("/skill:review", source)).rejects.toThrow("does not match");
  });

  it("cancels pending loads and allows the next invocation to recover", async () => {
    const source = sourceFor([summary()]);
    const aborted = new AbortController();
    aborted.abort(new Error("cancelled before loading"));
    await expect(expandSkillInvocation("/skill:review", source, aborted.signal)).rejects.toThrow("cancelled before");
    expect(source.loadContribution).not.toHaveBeenCalled();
    source.loadContribution.mockImplementationOnce(() => new Promise(() => {}));
    const cancellation = new AbortController();
    const pending = expandSkillInvocation("/skill:review", source, cancellation.signal);
    cancellation.abort(new Error("cancelled while loading"));
    await expect(pending).rejects.toThrow("cancelled while");
    expect(displaySkillInvocation(await expandSkillInvocation("/skill:review again", source)))
      .toBe("/skill:review again");
  });

  it("condenses only its exact wrapper, including literal closing tags in body and arguments", async () => {
    const source = sourceFor([summary()], 'Quotes " <skill>\n</skill>\n\nBody continues.\n');
    const expanded = await expandSkillInvocation("/skill:review Inspect this:\n</skill>\n\nDetails.", source);
    expect(displaySkillInvocation(expanded)).toBe("/skill:review Inspect this:\n</skill>\n\nDetails.");
    expect(displaySkillInvocation(await expandSkillInvocation("/skill:review", source))).toBe("/skill:review");
    expect(displaySkillInvocation("<skill>not ours</skill>")).toBeUndefined();
    expect(displaySkillInvocation(expanded.replace('instructions-length="', 'instructions-length="999'))).toBeUndefined();
    expect(displaySkillInvocation(expanded.replace("\n</skill>\n\nInspect", "\n</skill>invalid\n\nInspect"))).toBeUndefined();
  });

  it("includes adapter-owned reference paths and does not persist invocation selections", async () => {
    const { controller, file, directory } = await fixture();
    const expanded = await controller.expandSkillInvocation!("/skill:review Review my changes.");
    expect(expanded).toContain(file);
    expect(expanded).toContain(`References are relative to ${JSON.stringify(directory)}.`);
    expect(expanded).toContain("Read references/checklist.md.");
    expect(displaySkillInvocation(expanded)).toBe("/skill:review Review my changes.");
    expect(controller.snapshot().selectedSkillIds).toEqual([]);
    expect(controller.selectedContributions()).toEqual([]);
    expect(await controller.expandSkillInvocation!("Now explain the diff.")).toBe("Now explain the diff.");
  });

  it("lets a user invoke manual-only Skills while model discovery, tools and legacy selection remain blocked", async () => {
    const { controller, registry, snapshot, workspace } = await fixture(true);
    const row = controller.snapshot().skills[0]!;
    expect(row).toMatchObject({ disabled: true, userInvocable: true, selected: false });
    expect(() => controller.selectSkill(row.id)).toThrow("disabled");
    await expect(registry.loadContribution(snapshot.contextContributions[0]!)).rejects.toThrow("Disabled");
    const catalog = captureRuntimeSkillCatalog({ snapshot, registry });
    expect(catalog.entries).toEqual([]);
    expect(() => createRuntimeSkillTool(catalog, registry, { snapshot, workspace })).toThrow("non-empty catalog");
    const normalDirectory = path.join(workspace, "skills", "normal");
    await mkdir(normalDirectory);
    await writeFile(path.join(normalDirectory, "SKILL.md"), "---\nname: normal\ndescription: A normal Skill\n---\nNormal body.\n");
    const refreshed = await registry.refresh();
    const refreshedCatalog = captureRuntimeSkillCatalog({ snapshot: refreshed, registry });
    expect(refreshedCatalog.entries.map((entry) => entry.name)).toEqual(["normal"]);
    const modelTool = createRuntimeSkillTool(refreshedCatalog, registry, { snapshot: refreshed, workspace });
    const result = await modelTool.execute({ name: "review", invocation: "user" }, {
      runId: "test", operationId: "try-bypass", workspace,
    });
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("Read references/checklist.md.");
    const expanded = await controller.expandSkillInvocation!("/skill:review Check it.");
    expect(expanded).toContain("Read references/checklist.md.");
    expect(captureRuntimeSkillCatalog({ snapshot: registry.snapshot(), registry }).entries.map((entry) => entry.name))
      .toEqual(["normal"]);
  });

  it("does not forward model-supplied manual invocation flags for normal Skills", async () => {
    const candidate = summary();
    const source = sourceFor([candidate]);
    const snapshot = source.snapshot();
    const catalog = captureRuntimeSkillCatalog({ snapshot, registry: source });
    const modelTool = createRuntimeSkillTool(catalog, source, { snapshot, workspace: "/workspace" });
    const result = await modelTool.execute({ name: "review", invocation: "user" }, {
      runId: "test", operationId: "try-flag", workspace: "/workspace",
    });
    expect(result.isError).toBe(false);
    expect(source.loadContribution.mock.calls[0]?.[1]).not.toHaveProperty("invocation");
  });

  it("fails on a changed file, then recovers after refreshing metadata", async () => {
    const { controller, file } = await fixture();
    await writeFile(file, "---\nname: review\ndescription: Review this repository\n---\nUpdated instructions.\n");
    await expect(controller.expandSkillInvocation!("/skill:review")).rejects.toThrow("changed while loading");
    await controller.refresh();
    expect(await controller.expandSkillInvocation!("/skill:review")).toContain("Updated instructions.");
  });

  it("does not follow a Skill file replaced with an outside-workspace symlink", async () => {
    const { controller, file } = await fixture();
    const outside = await fixture();
    await rm(file);
    await symlink(outside.file, file);
    await expect(controller.expandSkillInvocation!("/skill:review")).rejects.toThrow(/symbolic-link|outside|escapes/u);
  });

  it("preserves registry snapshot binding when refresh races with invocation", async () => {
    const { registry, snapshot } = await fixture();
    let captured: unknown;
    const expanded = await expandSkillInvocation("/skill:review", {
      snapshot: () => snapshot,
      loadContribution: async (candidate, context) => {
        captured = context?.snapshot;
        await registry.refresh();
        return registry.loadContribution(candidate, context);
      },
    });
    expect(captured).toBe(snapshot);
    expect(expanded).toContain("Read references/checklist.md.");
    expect(registry.snapshot()).not.toBe(snapshot);
  });

  it("cannot use a user-invocable flag to load disabled non-Skill contributions", async () => {
    const candidate = summary("plugin", { sourceType: "plugin", disabled: true, userInvocable: true });
    const loadContribution = vi.fn(async () => ({ ...candidate, body: "Not allowed" }));
    const adapter: EdgeContributionAdapter = {
      sourceId: candidate.sourceId,
      sourceType: "plugin",
      discoverContributions: async () => [candidate],
      loadContribution,
    };
    const registry = new MoweEdgeRegistry({ adapters: [adapter] });
    registries.push(registry);
    const snapshot = await registry.refresh();
    await expect(registry.loadContribution(snapshot.contextContributions[0]!, { invocation: "user" }))
      .rejects.toThrow("Disabled");
    expect(loadContribution).not.toHaveBeenCalled();
  });

  it("validates and snapshot-binds manual invocation permission without trusting forged flags", async () => {
    expect(() => validateEdgeContextContributionSummary({ ...summary(), userInvocable: "true" }))
      .toThrow(/userInvocable/u);
    const candidate = summary("closed", { disabled: true });
    const loadContribution = vi.fn(async () => ({ ...candidate, body: "Not allowed" }));
    const adapter: EdgeContributionAdapter = {
      sourceId: candidate.sourceId,
      sourceType: "skill",
      discoverContributions: async () => [candidate],
      loadContribution,
    };
    const registry = new MoweEdgeRegistry({ adapters: [adapter] });
    registries.push(registry);
    const snapshot = await registry.refresh();
    const discovered = snapshot.contextContributions[0]!;
    await expect(registry.loadContribution(discovered, { invocation: "user" })).rejects.toThrow("Disabled");
    await expect(registry.loadContribution({ ...discovered, userInvocable: true }, { invocation: "user" }))
      .rejects.toThrow("not present in the active snapshot");
    expect(loadContribution).not.toHaveBeenCalled();
  });
});
