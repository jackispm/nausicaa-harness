import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEditFileTool } from "../../src/tools/edit-file.js";
import { createReadFileTool } from "../../src/tools/read-file.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("coding file tools", () => {
  it("reads a bounded line window with an explicit continuation", async () => {
    const workspace = await temporaryDirectory();
    await writeFile(path.join(workspace, "source.ts"), "one\n\u4e8c\nthree\nfour", "utf8");
    const result = await createReadFileTool().execute({
      path: "source.ts",
      offset: 2,
      limit: 2,
    }, toolContext(workspace));

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      path: "source.ts",
      content: "\u4e8c\nthree",
      offset: 2,
      lineCount: 2,
      totalLines: 4,
      truncated: true,
      nextOffset: 4,
    });
  });

  it("never cuts through a UTF-8 character at the byte boundary", async () => {
    const workspace = await temporaryDirectory();
    await writeFile(path.join(workspace, "unicode.txt"), "\u4f60\u597dworld\nnext", "utf8");
    const result = await createReadFileTool().execute({
      path: "unicode.txt",
      maxBytes: 4,
    }, toolContext(workspace));

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      content: "\u4f60",
      lineCount: 0,
      lineTruncated: true,
      truncated: true,
      nextOffset: 1,
      nextLineByteOffset: 3,
    });
  });

  it("keeps continuation on a UTF-8 line when no codepoint fits", async () => {
    const workspace = await temporaryDirectory();
    await writeFile(path.join(workspace, "unicode.txt"), "\u4f60\nnext", "utf8");
    const tool = createReadFileTool();

    const tooSmall = await tool.execute({
      path: "unicode.txt",
      maxBytes: 1,
    }, toolContext(workspace));
    expect(tooSmall.isError).toBe(false);
    expect(JSON.parse(tooSmall.content)).toMatchObject({
      content: "",
      offset: 1,
      lineCount: 0,
      lineTruncated: true,
      truncated: true,
      nextOffset: 1,
      nextLineByteOffset: 0,
      minimumMaxBytes: 3,
    });

    const retried = await tool.execute({
      path: "unicode.txt",
      offset: 1,
      maxBytes: 3,
    }, toolContext(workspace));
    expect(retried.isError).toBe(false);
    expect(JSON.parse(retried.content)).toMatchObject({
      content: "\u4f60",
      lineCount: 1,
      truncated: true,
      nextOffset: 2,
    });
  });

  it("does not skip the unread suffix of a byte-truncated line", async () => {
    const workspace = await temporaryDirectory();
    await writeFile(path.join(workspace, "long.txt"), "abcdefgh\nnext", "utf8");
    const tool = createReadFileTool();

    const preview = await tool.execute({
      path: "long.txt",
      maxBytes: 4,
    }, toolContext(workspace));
    expect(preview.isError).toBe(false);
    expect(JSON.parse(preview.content)).toMatchObject({
      content: "abcd",
      offset: 1,
      lineCount: 0,
      lineTruncated: true,
      truncated: true,
      nextOffset: 1,
      nextLineByteOffset: 4,
    });

    const retried = await tool.execute({
      path: "long.txt",
      offset: 1,
      maxBytes: 8,
    }, toolContext(workspace));
    expect(retried.isError).toBe(false);
    expect(JSON.parse(retried.content)).toMatchObject({
      content: "abcdefgh",
      lineCount: 1,
      truncated: true,
      nextOffset: 2,
    });
  });

  it("continues a UTF-8 line larger than the hard per-read byte budget", async () => {
    const workspace = await temporaryDirectory();
    const longLine = "\u4f60".repeat(100_000);
    await writeFile(path.join(workspace, "huge-line.txt"), `${longLine}\nnext`, "utf8");
    const tool = createReadFileTool();

    const first = await tool.execute({
      path: "huge-line.txt",
      maxBytes: 256 * 1024,
    }, toolContext(workspace));
    expect(first.isError).toBe(false);
    const firstPage = JSON.parse(first.content);
    expect(firstPage).toMatchObject({
      offset: 1,
      lineCount: 0,
      lineTruncated: true,
      truncated: true,
      nextOffset: 1,
    });
    expect(firstPage.content).not.toContain("\uFFFD");
    expect(firstPage.nextLineByteOffset).toBe(Buffer.byteLength(firstPage.content, "utf8"));
    expect(firstPage.nextLineByteOffset).toBeGreaterThan(0);

    const second = await tool.execute({
      path: "huge-line.txt",
      offset: firstPage.nextOffset,
      lineByteOffset: firstPage.nextLineByteOffset,
      maxBytes: 256 * 1024,
    }, toolContext(workspace));
    expect(second.isError).toBe(false);
    const secondPage = JSON.parse(second.content);
    expect(secondPage).toMatchObject({
      offset: 1,
      lineByteOffset: firstPage.nextLineByteOffset,
      lineCount: 2,
      truncated: false,
    });
    expect(`${firstPage.content}${secondPage.content}`).toBe(`${longLine}\nnext`);
  });

  it("applies disjoint edits together and preserves CRLF plus UTF-8 BOM", async () => {
    const workspace = await temporaryDirectory();
    const file = path.join(workspace, "source.txt");
    await writeFile(file, "\uFEFFalpha\r\nbeta\r\ngamma\r\n", "utf8");
    const result = await createEditFileTool().execute({
      path: "source.txt",
      edits: [
        { oldText: "alpha", newText: "ALPHA" },
        { oldText: "gamma", newText: "GAMMA" },
      ],
    }, toolContext(workspace));

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      path: "source.txt",
      replacements: 2,
      atomic: true,
      firstChangedLine: 1,
    });
    await expect(readFile(file, "utf8")).resolves.toBe(
      "\uFEFFALPHA\r\nbeta\r\nGAMMA\r\n",
    );
  });

  it("preserves untouched bytes during fuzzy matching and keeps file permissions", async () => {
    const workspace = await temporaryDirectory();
    const file = path.join(workspace, "script.sh");
    await writeFile(file, "keep trailing   \nconst label = \u201cwind\u201d;\n", "utf8");
    await chmod(file, 0o755);

    const result = await createEditFileTool().execute({
      path: "script.sh",
      edits: [{ oldText: 'const label = "wind";', newText: 'const label = "sky";' }],
    }, toolContext(workspace));

    expect(result.isError).toBe(false);
    await expect(readFile(file, "utf8")).resolves.toBe(
      "keep trailing   \nconst label = \"sky\";\n",
    );
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o755);
    }
  });

  it("rejects ambiguous edits without changing the file", async () => {
    const workspace = await temporaryDirectory();
    const file = path.join(workspace, "duplicate.txt");
    await writeFile(file, "same\nsame\n", "utf8");
    const result = await createEditFileTool().execute({
      path: "duplicate.txt",
      edits: [{ oldText: "same", newText: "changed" }],
    }, toolContext(workspace));

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toMatch(/2 matches|unique/i);
    await expect(readFile(file, "utf8")).resolves.toBe("same\nsame\n");
  });

  it("serializes edits to the same file while unrelated replacements remain valid", async () => {
    const workspace = await temporaryDirectory();
    const file = path.join(workspace, "parallel.txt");
    await writeFile(file, "left\nright\n", "utf8");
    const edit = createEditFileTool();
    const context = toolContext(workspace);
    const [left, right] = await Promise.all([
      edit.execute({ path: "parallel.txt", edits: [{ oldText: "left", newText: "LEFT" }] }, context),
      edit.execute({ path: "parallel.txt", edits: [{ oldText: "right", newText: "RIGHT" }] }, context),
    ]);

    expect(left.isError).toBe(false);
    expect(right.isError).toBe(false);
    await expect(readFile(file, "utf8")).resolves.toBe("LEFT\nRIGHT\n");
  });
});

function toolContext(workspace: string) {
  return { runId: "run-1", workspace, operationId: "operation-1" };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "nausicaa-coding-tools-"));
  temporaryDirectories.push(directory);
  return directory;
}
