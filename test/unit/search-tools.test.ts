import { access, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFindTool, createGrepTool } from "../../src/tools/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("workspace search tools", () => {
  it("treats ripgrep exit 1 as a successful empty search", async () => {
    const workspace = await temporaryDirectory("nausicaa-search-empty-");

    const found = await createFindTool().execute({ pattern: "**/*.ts" }, context(workspace));
    const searched = await createGrepTool().execute({ pattern: "missing" }, context(workspace));

    expect(found.isError).toBe(false);
    expect(JSON.parse(found.content)).toMatchObject({ files: [], count: 0, truncated: false });
    expect(searched.isError).toBe(false);
    expect(JSON.parse(searched.content)).toMatchObject({ matches: [], matchCount: 0, truncated: false });
  });

  it("finds globbed files in stable order and reports limits as JSON", async () => {
    const workspace = await temporaryDirectory("nausicaa-find-");
    await mkdir(path.join(workspace, "src", "nested"), { recursive: true });
    await writeFile(path.join(workspace, "src", "z.ts"), "z");
    await writeFile(path.join(workspace, "src", "a.ts"), "a");
    await writeFile(path.join(workspace, "src", "nested", "b.ts"), "b");
    await writeFile(path.join(workspace, "src", "ignored.js"), "js");

    const tool = createFindTool();
    const result = await tool.execute({
      pattern: "**/*.ts",
      path: "src",
      limit: 2,
    }, context(workspace));

    expect(result.isError).toBe(false);
    const first = JSON.parse(result.content) as {
      path: string;
      pattern: string;
      files: string[];
      count: number;
      truncated: boolean;
      nextCursor?: string;
    };
    expect(first).toMatchObject({
      path: "src",
      pattern: "**/*.ts",
      files: ["src/a.ts", "src/nested/b.ts"],
      count: 2,
      truncated: true,
    });
    expect(first.nextCursor).toEqual(expect.any(String));

    const repeated = await tool.execute({
      pattern: "**/*.ts",
      path: "src",
      limit: 2,
    }, context(workspace));
    expect((JSON.parse(repeated.content) as { nextCursor: string }).nextCursor).toBe(first.nextCursor);

    const continued = await tool.execute({
      pattern: "**/*.ts",
      path: "src",
      limit: 3,
      cursor: first.nextCursor,
    }, context(workspace));

    expect(continued.isError).toBe(false);
    expect(JSON.parse(continued.content)).toEqual({
      path: "src",
      pattern: "**/*.ts",
      files: ["src/z.ts"],
      count: 1,
      truncated: false,
    });
  });

  it("normalizes ripgrep paths before path globs and scopes nested ignores", async () => {
    const workspace = await temporaryDirectory("nausicaa-find-ignore-scope-");
    await mkdir(path.join(workspace, "a"), { recursive: true });
    await mkdir(path.join(workspace, "b"), { recursive: true });
    await writeFile(path.join(workspace, "a", ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(workspace, "a", "ignored.txt"), "hidden by a/.gitignore\n");
    await writeFile(path.join(workspace, "a", "kept.txt"), "kept\n");
    await writeFile(path.join(workspace, "b", "ignored.txt"), "visible sibling\n");
    await writeFile(path.join(workspace, "b", "kept.txt"), "kept\n");
    await writeFile(path.join(workspace, "root.txt"), "root\n");

    const tool = createFindTool();
    const recursive = await tool.execute({ pattern: "**/*.txt" }, context(workspace));
    expect(recursive.isError).toBe(false);
    expect(JSON.parse(recursive.content)).toMatchObject({
      files: ["a/kept.txt", "b/ignored.txt", "b/kept.txt", "root.txt"],
      count: 4,
      truncated: false,
    });

    const pathGlob = await tool.execute({ pattern: "a/**/*.txt" }, context(workspace));
    expect(pathGlob.isError).toBe(false);
    expect(JSON.parse(pathGlob.content)).toMatchObject({
      files: ["a/kept.txt"],
      count: 1,
      truncated: false,
    });
  });

  it("applies deeper ignore files only within their own subtree", async () => {
    const workspace = await temporaryDirectory("nausicaa-find-deep-ignore-");
    await mkdir(path.join(workspace, "a", "deep"), { recursive: true });
    await mkdir(path.join(workspace, "b"), { recursive: true });
    await writeFile(path.join(workspace, "a", ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(workspace, "a", "deep", ".gitignore"), "secret.txt\n");
    await writeFile(path.join(workspace, "a", "ignored.txt"), "ignored\n");
    await writeFile(path.join(workspace, "a", "kept.txt"), "kept\n");
    await writeFile(path.join(workspace, "a", "deep", "ignored.txt"), "ignored\n");
    await writeFile(path.join(workspace, "a", "deep", "secret.txt"), "secret\n");
    await writeFile(path.join(workspace, "a", "deep", "kept.txt"), "kept\n");
    await writeFile(path.join(workspace, "b", "ignored.txt"), "visible sibling\n");
    await writeFile(path.join(workspace, "b", "kept.txt"), "kept\n");
    await writeFile(path.join(workspace, "root.txt"), "root\n");

    const result = await createFindTool().execute({ pattern: "**/*.txt" }, context(workspace));
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      files: ["a/deep/kept.txt", "a/kept.txt", "b/ignored.txt", "b/kept.txt", "root.txt"],
      count: 5,
      truncated: false,
    });
  });

  it("supports literal, case-insensitive, globbed grep with context", async () => {
    const workspace = await temporaryDirectory("nausicaa-grep-");
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "src", "match.ts"), [
      "before",
      "Needle.ONE",
      "after",
    ].join("\n"));
    await writeFile(path.join(workspace, "src", "regex-only.ts"), "needleXone");
    await writeFile(path.join(workspace, "src", "excluded.md"), "needle.one");

    const result = await createGrepTool().execute({
      pattern: "needle.one",
      path: ".",
      glob: "**/*.ts",
      ignoreCase: true,
      literal: true,
      context: 1,
    }, context(workspace));

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({
      path: ".",
      pattern: "needle.one",
      matches: [
        {
          path: "src/match.ts",
          line: 2,
          column: 1,
          text: "Needle.ONE",
          before: [{ line: 1, text: "before" }],
          after: [{ line: 3, text: "after" }],
        },
      ],
      matchCount: 1,
      filesMatched: 1,
      truncated: false,
    });
  });

  it("returns globally stable grep results and enforces the match limit", async () => {
    const workspace = await temporaryDirectory("nausicaa-grep-limit-");
    await writeFile(path.join(workspace, "z.txt"), "hit z");
    await writeFile(path.join(workspace, "a.txt"), "hit a\nhit again");

    const tool = createGrepTool();
    const result = await tool.execute({
      pattern: "hit",
      limit: 2,
    }, context(workspace));
    const output = JSON.parse(result.content) as {
      matches: Array<{ path: string; line: number; column: number; text: string }>;
      matchCount: number;
      filesMatched: number;
      truncated: boolean;
      nextCursor?: string;
    };

    expect(result.isError).toBe(false);
    expect(output.matches).toEqual([
      { path: "a.txt", line: 1, column: 1, text: "hit a" },
      { path: "a.txt", line: 2, column: 1, text: "hit again" },
    ]);
    expect(output.matchCount).toBe(2);
    expect(output.filesMatched).toBe(1);
    expect(output.truncated).toBe(true);
    expect(output.nextCursor).toEqual(expect.any(String));

    const continued = await tool.execute({
      pattern: "hit",
      limit: 2,
      cursor: output.nextCursor,
    }, context(workspace));

    expect(continued.isError).toBe(false);
    expect(JSON.parse(continued.content)).toEqual({
      path: ".",
      pattern: "hit",
      matches: [{ path: "z.txt", line: 1, column: 1, text: "hit z" }],
      matchCount: 1,
      filesMatched: 1,
      truncated: false,
    });
  });

  it("returns stable deduplicated matching-file pages without line-result noise", async () => {
    const workspace = await temporaryDirectory("nausicaa-grep-files-");
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "src", "z.ts"), "hit z\nhit z again");
    await writeFile(path.join(workspace, "src", "a.ts"), "HIT a\nhit a again");
    await writeFile(path.join(workspace, "src", "m.ts"), "miss");
    await writeFile(path.join(workspace, "ignored.md"), "hit docs");

    const tool = createGrepTool();
    const firstResult = await tool.execute({
      pattern: "hit",
      glob: "**/*.ts",
      ignoreCase: true,
      outputMode: "files",
      limit: 1,
    }, context(workspace));
    const first = JSON.parse(firstResult.content) as {
      files: string[];
      count: number;
      truncated: boolean;
      nextCursor?: string;
    };

    expect(firstResult.isError).toBe(false);
    expect(first).toMatchObject({
      files: ["src/a.ts"],
      count: 1,
      truncated: true,
    });
    expect(first.nextCursor).toEqual(expect.any(String));

    const continued = await tool.execute({
      pattern: "hit",
      glob: "**/*.ts",
      ignoreCase: true,
      outputMode: "files",
      limit: 2,
      cursor: first.nextCursor,
    }, context(workspace));

    expect(continued.isError).toBe(false);
    expect(JSON.parse(continued.content)).toEqual({
      path: ".",
      pattern: "hit",
      files: ["src/z.ts"],
      count: 1,
      truncated: false,
    });
  });

  it("keeps files-mode cursors separate from the default line-match query", async () => {
    const workspace = await temporaryDirectory("nausicaa-grep-files-cursor-");
    await writeFile(path.join(workspace, "a.ts"), "hit");
    await writeFile(path.join(workspace, "b.ts"), "hit");
    const tool = createGrepTool();
    const first = await tool.execute({
      pattern: "hit",
      outputMode: "files",
      limit: 1,
    }, context(workspace));
    const cursor = (JSON.parse(first.content) as { nextCursor: string }).nextCursor;

    const mismatched = await tool.execute({
      pattern: "hit",
      limit: 1,
      cursor,
    }, context(workspace));

    expect(mismatched.isError).toBe(true);
    expect(JSON.parse(mismatched.content).error).toMatch(/does not match this grep query/);
  });

  it("rejects a files-mode cursor when its anchor was deleted or stopped matching", async () => {
    for (const mutation of ["delete", "replace"] as const) {
      const workspace = await temporaryDirectory(`nausicaa-grep-files-stale-${mutation}-`);
      const anchorPath = path.join(workspace, "a.ts");
      await writeFile(anchorPath, "hit");
      await writeFile(path.join(workspace, "b.ts"), "hit");
      const tool = createGrepTool();
      const first = await tool.execute({
        pattern: "hit",
        outputMode: "files",
        limit: 1,
      }, context(workspace));
      const cursor = (JSON.parse(first.content) as { nextCursor: string }).nextCursor;

      if (mutation === "delete") await rm(anchorPath);
      else await writeFile(anchorPath, "miss");
      const continued = await tool.execute({
        pattern: "hit",
        outputMode: "files",
        limit: 1,
        cursor,
      }, context(workspace));

      expect(continued.isError).toBe(true);
      expect(JSON.parse(continued.content).error)
        .toMatch(/grep cursor no longer matches the workspace/);
    }
  });

  it("rejects malformed, tampered, cross-tool, and query-mismatched cursors", async () => {
    const workspace = await temporaryDirectory("nausicaa-search-cursor-");
    await writeFile(path.join(workspace, "a.ts"), "hit");
    await writeFile(path.join(workspace, "b.ts"), "hit");
    const find = createFindTool();
    const grep = createGrepTool();
    const first = await find.execute({ pattern: "*.ts", limit: 1 }, context(workspace));
    const cursor = (JSON.parse(first.content) as { nextCursor: string }).nextCursor;
    const [payload, signature] = cursor.split(".") as [string, string];
    const tamperedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;

    for (const invalidCursor of ["not-a-cursor", `${payload}.${tamperedSignature}`]) {
      const invalid = await find.execute({
        pattern: "*.ts",
        limit: 1,
        cursor: invalidCursor,
      }, context(workspace));
      expect(invalid.isError).toBe(true);
      expect(JSON.parse(invalid.content).error).toMatch(/invalid or expired/);
    }

    const mismatched = await find.execute({
      pattern: "*.js",
      limit: 1,
      cursor,
    }, context(workspace));
    expect(mismatched.isError).toBe(true);
    expect(JSON.parse(mismatched.content).error).toMatch(/does not match this find query/);

    const wrongTool = await grep.execute({
      pattern: "hit",
      limit: 1,
      cursor,
    }, context(workspace));
    expect(wrongTool.isError).toBe(true);
    expect(JSON.parse(wrongTool.content).error).toMatch(/belongs to find, not grep/);
  });

  it("diagnoses a grep cursor whose anchor changed between pages", async () => {
    const workspace = await temporaryDirectory("nausicaa-grep-cursor-change-");
    const file = path.join(workspace, "input.txt");
    await writeFile(file, "hit one\nhit two\n");
    const tool = createGrepTool();
    const first = await tool.execute({ pattern: "hit", limit: 1 }, context(workspace));
    const cursor = (JSON.parse(first.content) as { nextCursor: string }).nextCursor;

    await writeFile(file, "miss one\nhit two\n");
    const continued = await tool.execute({ pattern: "hit", limit: 1, cursor }, context(workspace));

    expect(continued.isError).toBe(true);
    expect(JSON.parse(continued.content).error).toMatch(/no longer matches the workspace/);
  });

  it("does not expose protected paths, symbolic links, or hard links", async () => {
    const workspace = await temporaryDirectory("nausicaa-search-secure-");
    const outside = await temporaryDirectory("nausicaa-search-outside-");
    await writeFile(path.join(workspace, ".env"), "TOKEN=secret");
    await writeFile(path.join(workspace, "private.txt"), "custom secret");
    await writeFile(path.join(workspace, "visible.txt"), "public");
    await writeFile(path.join(outside, "secret.txt"), "outside secret");
    await symlink(outside, path.join(workspace, "escape"), "dir");
    await link(path.join(outside, "secret.txt"), path.join(workspace, "hardlink-secret.txt"));
    const policy = { protectedPaths: ["private.txt"] };
    const tools = [createFindTool(policy), createGrepTool(policy)];

    for (const tool of tools) {
      for (const protectedPath of [".env", "private.txt", "hardlink-secret.txt"]) {
        const protectedResult = await tool.execute({
          ...(tool.definition.name === "find" ? { pattern: "*" } : { pattern: "secret" }),
          path: protectedPath,
        }, context(workspace));
        expect(protectedResult.isError).toBe(true);
      }
      const linkedResult = await tool.execute({
        ...(tool.definition.name === "find" ? { pattern: "*" } : { pattern: "secret" }),
        path: "escape",
      }, context(workspace));

      expect(linkedResult.isError).toBe(true);
    }

    const found = await createFindTool(policy).execute({ pattern: "*", path: "." }, context(workspace));
    expect(JSON.parse(found.content).files).toEqual(["visible.txt"]);
    const searched = await createGrepTool(policy).execute({ pattern: "secret", path: "." }, context(workspace));
    expect(JSON.parse(searched.content)).toMatchObject({ matches: [], matchCount: 0 });
  });

  it("passes hostile search text as data without invoking a shell", async () => {
    const workspace = await temporaryDirectory("nausicaa-search-injection-");
    const marker = path.join(workspace, "shell-was-run");
    const payload = `$(touch ${marker})`;
    await writeFile(path.join(workspace, "input.txt"), payload);

    const grep = await createGrepTool().execute({
      pattern: payload,
      literal: true,
    }, context(workspace));
    const find = await createFindTool().execute({
      pattern: `*; touch ${marker}`,
    }, context(workspace));

    expect(grep.isError).toBe(false);
    expect(JSON.parse(grep.content).matchCount).toBe(1);
    expect(find.isError).toBe(false);
    expect(JSON.parse(find.content).files).toEqual([]);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function context(workspace: string) {
  return { runId: "run-1", workspace, operationId: "operation-1" };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
