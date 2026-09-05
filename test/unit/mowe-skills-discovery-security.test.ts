import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SkillFrontmatterError,
  SkillLoaderError,
  discoverSkillCatalog,
  loadSkill,
  parseSkillDocument,
} from "../../src/mowe/edges/skills.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Mowe Skills discovery security", () => {
  it("keeps standard-root precedence deterministic and accepts spaced delimiters", async () => {
    const workspace = await temporaryRoot();
    await writeSkill(path.join(workspace, ".agents", "skills", "shared"), "agents", "agents body\n", "---   ");
    await writeSkill(path.join(workspace, ".pi", "skills", "shared"), "pi", "pi body\n");
    await writeSkill(path.join(workspace, "skills", "shared"), "fallback", "fallback body\n");

    const report = await discoverSkillCatalog(workspace);
    expect(report.skills).toHaveLength(1);
    expect(report.skills[0]).toMatchObject({
      name: "shared",
      description: "agents",
      relativePath: ".agents/skills/shared/SKILL.md",
    });
    expect(report.conflicts[0]?.paths).toEqual([
      ".agents/skills/shared/SKILL.md",
      ".pi/skills/shared/SKILL.md",
      "skills/shared/SKILL.md",
    ]);
    expect(parseSkillDocument("---\nname: spaced\ndescription: spaced\n...   \nbody").body).toBe("body");
  });

  it("defers body UTF-8 validation until an explicitly selected Skill is loaded", async () => {
    const workspace = await temporaryRoot();
    const directory = path.join(workspace, "skills", "binary-body");
    await mkdir(directory, { recursive: true });
    const header = Buffer.from("---\nname: binary-body\ndescription: header is valid\n---\n", "utf8");
    await writeFile(path.join(directory, "SKILL.md"), Buffer.concat([header, Buffer.from([0xff, 0xfe, 0xfd])]));

    const report = await discoverSkillCatalog(workspace, { roots: ["skills"], conflictMode: "report" });
    expect(report.skills).toHaveLength(1);
    expect(report.diagnostics).toEqual([]);
    await expect(loadSkill(report.skills[0]!)).rejects.toBeInstanceOf(SkillFrontmatterError);
  });

  it("isolates malformed and unsafe entries without reading selected-skill resources", async () => {
    const workspace = await temporaryRoot();
    const valid = path.join(workspace, "skills", "valid-skill");
    await writeSkill(valid, "valid", "valid body\n");
    const outside = await temporaryRoot();
    await writeFile(path.join(outside, "secret.txt"), "secret\n");
    await symlink(path.join(outside, "secret.txt"), path.join(valid, "unselected.txt"));

    const malformed = path.join(workspace, "skills", "malformed");
    await mkdir(malformed, { recursive: true });
    await writeFile(path.join(malformed, "SKILL.md"), "---\nname: malformed\n---\nbody\n");
    await symlink(outside, path.join(workspace, "skills", "linked"), "dir");

    const report = await discoverSkillCatalog(workspace, { roots: ["skills"], conflictMode: "report" });
    expect(report.skills.map((skill) => skill.name)).toEqual(["valid-skill"]);
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "invalid" }),
      expect.objectContaining({ kind: "unsafe" }),
    ]));
  });

  it("enforces file, total, depth, and count bounds before publishing summaries", async () => {
    const workspace = await temporaryRoot();
    await writeSkill(path.join(workspace, "skills", "first"), "first", "12345678\n");
    await writeSkill(path.join(workspace, "skills", "second"), "second", "12345678\n");

    await expect(discoverSkillCatalog(workspace, {
      roots: ["skills"],
      maxSkills: 1,
      conflictMode: "report",
    })).rejects.toThrow(/skill limit/u);
    await expect(discoverSkillCatalog(workspace, {
      roots: ["skills"],
      maxTotalBytes: 16,
      conflictMode: "report",
    })).rejects.toThrow(/total limit/u);

    const bounded = await discoverSkillCatalog(workspace, {
      roots: ["skills"],
      maxFileBytes: 32,
      maxDepth: 1,
      conflictMode: "report",
    });
    expect(bounded.skills).toEqual([]);
    expect(bounded.diagnostics.some((item) => item.kind === "unsafe")).toBe(true);
  });

  it("detects same-size body mutation between discovery and load", async () => {
    const workspace = await temporaryRoot();
    const directory = path.join(workspace, "skills", "changing");
    await writeSkill(directory, "changing", "first-body\n");
    const summary = (await discoverSkillCatalog(workspace, {
      roots: ["skills"],
      conflictMode: "report",
    })).skills[0]!;
    await writeSkill(directory, "changing", "other-body\n");

    await expect(loadSkill(summary)).rejects.toThrow(/changed while loading/u);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "nausicaa-skills-security-"));
  temporaryRoots.push(root);
  return root;
}

async function writeSkill(
  directory: string,
  description: string,
  body: string,
  closing = "---",
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), [
    "---",
    `name: ${path.basename(directory)}`,
    `description: ${description}`,
    closing,
    body,
  ].join("\n"));
}
