import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BUNDLED_SKILL_DIRECTORY,
  createBundledSkillsEdgeAdapter,
} from "../../src/mowe/edges/bundled-skills.js";
import { createSkillsEdgeAdapter, discoverSkillCatalog } from "../../src/mowe/edges/skills.js";

const roots: string[] = [];
const adapters: ReturnType<typeof createBundledSkillsEdgeAdapter>[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.release?.({ reason: "shutdown" })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nausicaa-bundled-skills-"));
  roots.push(root);
  return root;
}

function adapter(overrides?: () => ReadonlySet<string>) {
  const value = createBundledSkillsEdgeAdapter({
    sourceId: "bundled",
    ...(overrides === undefined ? {} : { getOverrideNames: overrides }),
  });
  adapters.push(value);
  return value;
}

describe("bundled Skills", () => {
  it("discovers three package-owned presets without adding their bodies to metadata", async () => {
    const context = { workspace: await workspace() };
    const value = adapter();
    const summaries = await value.discoverContributions(context);

    expect(summaries.map((summary) => summary.name).sort()).toEqual([
      "code-review", "codebase-map", "task-plan",
    ]);
    for (const summary of summaries) {
      expect(summary).toMatchObject({ sourceType: "skill", disabled: false, userInvocable: true });
      expect(summary).not.toHaveProperty("body");
      expect(summary.provenance?.license).toBe("MIT");
    }
    expect(BUNDLED_SKILL_DIRECTORY).toMatch(/[/\\]assets[/\\]skills[/\\]?$/u);
    await expect(discoverSkillCatalog(context.workspace, { roots: [BUNDLED_SKILL_DIRECTORY] }))
      .rejects.toThrow(/escapes|outside|within/iu);
  });

  it("loads the selected instructions with attribution and retains existing size and resource limits", async () => {
    const context = { workspace: await workspace() };
    const value = adapter();
    const summary = (await value.discoverContributions(context)).find((item) => item.name === "codebase-map")!;
    const loaded = await value.loadContribution(summary, context);

    expect(loaded.body).toContain("# Codebase Map");
    expect(loaded.body).toContain("1defa151e0c1dac87d38a2d0ac09d67f817b30f9");
    expect(loaded.skillLocation?.filePath).toBe(join(BUNDLED_SKILL_DIRECTORY, "codebase-map", "SKILL.md"));
    await expect(value.loadContribution(summary, { ...context, maxBodyBytes: 1 }))
      .rejects.toThrow(/byte|limit|exceed/iu);
    await expect(value.loadContribution(summary, { ...context, resourcePaths: ["../LICENSE"] }))
      .rejects.toThrow(/escapes|outside|within/iu);
    const license = await readFile(join(BUNDLED_SKILL_DIRECTORY, "LICENSE"), "utf8");
    expect(license).toContain("Copyright (c) 2025 Mario Zechner");
    expect(license).toContain("Copyright (c) 2026 Prime Intellect");
    expect(license).toContain("Copyright (c) 2026 DeepSeek");
  });

  it("lets a discovered project Skill replace a bundled preset with the same name", async () => {
    const root = await workspace();
    const skill = join(root, ".agents", "skills", "code-review");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), [
      "---", "name: code-review", "description: Project-specific review", "---", "PROJECT_REVIEW_BODY",
    ].join("\n"));
    const project = createSkillsEdgeAdapter({ sourceId: "project" });
    adapters.push(project);
    const local = await project.discoverContributions({ workspace: root });
    const value = adapter(() => new Set(local.map((item) => item.name)));

    expect((await value.discoverContributions({ workspace: root })).map((item) => item.name).sort()).toEqual([
      "codebase-map", "task-plan",
    ]);
    expect((await project.loadContribution(local[0]!, { workspace: root })).body).toBe("PROJECT_REVIEW_BODY");
    const all = adapter();
    const hidden = (await all.discoverContributions({ workspace: root })).find((item) => item.name === "code-review")!;
    await expect(value.loadContribution(hidden, { workspace: root })).rejects.toThrow(/not discovered/u);
  });

  it("keeps captured presets loadable during one refresh while applying new override names", async () => {
    const context = { workspace: await workspace() };
    let names = new Set<string>();
    const value = adapter(() => names);
    const original = (await value.discoverContributions(context)).find((item) => item.name === "code-review")!;
    names = new Set(["code-review"]);
    await value.refresh?.(context);
    expect((await value.discoverContributions(context)).some((item) => item.name === "code-review")).toBe(false);
    expect((await value.loadContribution(original, context)).body).toContain("# Code Review");
    await value.refresh?.(context);
    await value.discoverContributions(context);
    await expect(value.loadContribution(original, context)).rejects.toThrow(/not discovered/u);
  });

  it("rejects cross-workspace, forged, and aborted loads", async () => {
    const context = { workspace: await workspace() };
    const value = adapter();
    const summary = (await value.discoverContributions(context))[0]!;
    await expect(value.loadContribution(summary, { workspace: await workspace() })).rejects.toThrow(/not discovered/u);
    await expect(value.loadContribution({ ...summary, name: "forged" }, context)).rejects.toThrow(/forged|stale/u);
    const controller = new AbortController();
    controller.abort(new Error("cancel bundled discovery"));
    await expect(value.discoverContributions({ ...context, signal: controller.signal })).rejects.toThrow("cancel bundled discovery");
    await expect(value.loadContribution(summary, { ...context, signal: controller.signal })).rejects.toThrow("cancel bundled discovery");
  });
});
