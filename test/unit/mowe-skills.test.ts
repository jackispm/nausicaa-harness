import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SkillConflictError,
  SkillFrontmatterError,
  SkillPathError,
  discoverSkillCatalog,
  discoverSkills,
  loadSkill,
  loadSkillFromWorkspace,
  loadSkillResource,
  parseSkillDocument,
} from "../../src/mowe/edges/skills.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Mowe Skills edge", () => {
  it("parses required frontmatter, nested metadata, and a progressive body", () => {
    const document = [
      "---",
      "name: release-notes",
      "description: Explain how to prepare release notes",
      "license: MIT",
      "metadata:",
      "  author: Nausicaa",
      "  tags: [release, docs]",
      "usage: |",
      "  Run this after the tests pass.",
      "---",
      "# Release notes",
      "",
      "Use the changelog.",
      "",
    ].join("\n");

    const parsed = parseSkillDocument(document);
    expect(parsed.frontmatter).toMatchObject({
      name: "release-notes",
      description: "Explain how to prepare release notes",
      license: "MIT",
      metadata: { author: "Nausicaa", tags: ["release", "docs"] },
      usage: "Run this after the tests pass.\n",
    });
    expect(parsed.body).toBe("# Release notes\n\nUse the changelog.\n");
    expect(Object.isFrozen(parsed.frontmatter)).toBe(true);
    expect(Object.isFrozen(parsed.frontmatter.metadata)).toBe(true);
  });

  it("accepts an optional UTF-8 BOM while keeping frontmatter strict", () => {
    const parsed = parseSkillDocument("\uFEFF---\r\nname: bom-skill\r\ndescription: bom\r\n---\r\nbody");
    expect(parsed.frontmatter.name).toBe("bom-skill");
    expect(parsed.body).toBe("body");
  });

  it("discovers immutable summaries and loads instructions only when selected", async () => {
    const workspace = await temporaryRoot();
    const skillDirectory = path.join(workspace, "skills", "release-notes");
    await mkdir(skillDirectory, { recursive: true });
    await writeSkill(skillDirectory, "Explain release notes", "# Instructions\n\nKeep it concise.\n");

    const summaries = await discoverSkills(workspace, { roots: ["skills"] });
    expect(summaries).toHaveLength(1);
    const summary = summaries[0]!;
    expect(summary.name).toBe("release-notes");
    expect(summary.relativePath).toBe("skills/release-notes/SKILL.md");
    expect(summary).not.toHaveProperty("body");
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.frontmatter)).toBe(true);

    const loaded = await loadSkill(summary);
    expect(loaded.instructions).toBe("# Instructions\n\nKeep it concise.\n");
    expect(loaded.body).toBe(loaded.instructions);
    expect(loaded.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(Object.isFrozen(loaded)).toBe(true);

    await writeFile(path.join(skillDirectory, "examples.md"), "example\n");
    const resource = await loadSkillResource(summary, "examples.md");
    expect(resource.relativePath).toBe("examples.md");
    expect(resource.content).toBe("example\n");
    expect(resource.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("supports selection by name and reports duplicate names deterministically", async () => {
    const workspace = await temporaryRoot();
    const first = path.join(workspace, "first", "same-skill");
    const second = path.join(workspace, "second", "same-skill");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    await writeSkill(first, "first", "first body\n");
    await writeSkill(second, "second", "second body\n");

    await expect(discoverSkills(workspace, { roots: ["first", "second"] })).rejects.toBeInstanceOf(SkillConflictError);
    const report = await discoverSkillCatalog(workspace, { roots: ["first", "second"], conflictMode: "report" });
    expect(report.skills.map((skill) => skill.relativePath)).toEqual([
      "first/same-skill/SKILL.md",
      "second/same-skill/SKILL.md",
    ]);
    expect(report.conflicts).toEqual([{
      name: "same-skill",
      paths: ["first/same-skill/SKILL.md", "second/same-skill/SKILL.md"],
    }]);

    const loaded = await loadSkillFromWorkspace(workspace, "same-skill", {
      roots: ["first", "second"],
      conflictMode: "first",
    });
    expect(loaded.body).toBe("first body\n");
  });

  it("uses bounded standard roots with deterministic precedence and normalizes disabled invocation", async () => {
    const workspace = await temporaryRoot();
    const project = path.join(workspace, ".agents", "skills", "shared");
    const fallback = path.join(workspace, ".pi", "skills", "shared");
    await mkdir(project, { recursive: true });
    await mkdir(fallback, { recursive: true });
    await writeSkill(project, "project", "project body\n");
    await writeFile(path.join(project, "SKILL.md"), [
      "---", "name: shared", "description: project", "disable-model-invocation: \"true\"", "---", "project body\n",
    ].join("\n"));
    await writeSkill(fallback, "fallback", "fallback body\n");

    const report = await discoverSkillCatalog(workspace, { conflictMode: "report" });
    expect(report.skills.map((skill) => skill.relativePath)).toEqual([
      ".agents/skills/shared/SKILL.md",
      ".pi/skills/shared/SKILL.md",
    ]);
    expect(report.skills[0]?.disableModelInvocation).toBe(true);
    const selected = await loadSkillFromWorkspace(workspace, "shared");
    expect(selected.body).toBe("project body\n");
  });

  it("enforces byte/depth limits and rejects symlink or workspace escapes", async () => {
    const workspace = await temporaryRoot();
    const skillDirectory = path.join(workspace, "skills", "safe-skill");
    await mkdir(skillDirectory, { recursive: true });
    await writeSkill(skillDirectory, "safe", "body\n");
    const oversizedReport = await discoverSkillCatalog(workspace, {
      roots: ["skills"],
      maxFileBytes: 4,
      conflictMode: "report",
    });
    expect(oversizedReport.diagnostics.some((diagnostic) => diagnostic.kind === "invalid")).toBe(true);

    const outside = await temporaryRoot();
    await writeSkill(outside, "safe-skill", "outside\n");
    await symlink(outside, path.join(workspace, "linked-skill"), "dir");
    const unsafeReport = await discoverSkillCatalog(workspace, { roots: ["."], conflictMode: "report" });
    expect(unsafeReport.diagnostics.some((diagnostic) => diagnostic.kind === "unsafe")).toBe(true);
    await expect(discoverSkills(workspace, { roots: ["../outside"] })).rejects.toBeInstanceOf(SkillPathError);

    const selected = (await discoverSkills(workspace, { roots: ["skills"] }))[0]!;
    await symlink(path.join(outside, "SKILL.md"), path.join(selected.directory, "linked.md"));
    await expect(loadSkillResource(selected, "linked.md")).rejects.toBeInstanceOf(SkillPathError);
    await expect(loadSkillResource(selected, "../outside.txt")).rejects.toBeInstanceOf(SkillPathError);
  });

  it("fails closed for malformed frontmatter and directory/name conflicts", async () => {
    const workspace = await temporaryRoot();
    const malformed = path.join(workspace, "skills", "broken");
    await mkdir(malformed, { recursive: true });
    await writeFile(path.join(malformed, "SKILL.md"), "---\nname: broken\n---\nbody\n");
    const malformedReport = await discoverSkillCatalog(workspace, { roots: ["skills"], conflictMode: "report" });
    expect(malformedReport.diagnostics.some((diagnostic) => diagnostic.kind === "invalid")).toBe(true);
    await rm(malformed, { recursive: true, force: true });

    const mismatch = path.join(workspace, "skills", "directory-name");
    await mkdir(mismatch, { recursive: true });
    await writeFile(path.join(mismatch, "SKILL.md"), [
      "---",
      "name: different-name",
      "description: mismatch",
      "---",
      "body\n",
    ].join("\n"));
    const mismatchReport = await discoverSkillCatalog(workspace, { roots: ["skills"], conflictMode: "report" });
    expect(mismatchReport.diagnostics.some((diagnostic) => diagnostic.message.includes("does not match directory"))).toBe(true);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "nausicaa-skills-"));
  roots.push(root);
  return root;
}

async function writeSkill(directory: string, name: string, body: string): Promise<void> {
  await writeFile(path.join(directory, "SKILL.md"), [
    "---",
    `name: ${path.basename(directory)}`,
    `description: ${name}`,
    "---",
    body,
  ].join("\n"));
}
