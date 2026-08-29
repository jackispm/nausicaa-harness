import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import {
  TOOL_PRESENTATION_RENDERERS,
  renderRichDiffRows,
  renderToolPresentation,
} from "../../src/cli/tool-renderers.js";

describe("tool presentation registry", () => {
  it("covers every first-party Mowe tool and falls back for unknown tools", () => {
    expect(Object.keys(TOOL_PRESENTATION_RENDERERS).sort()).toEqual([
      "bash",
      "delegate_task",
      "directory_create",
      "edit",
      "file_info",
      "find",
      "grep",
      "list_files",
      "path_copy",
      "path_delete",
      "path_move",
      "process_kill",
      "process_list",
      "process_output",
      "process_start",
      "process_status",
      "read_file",
      "read_image",
      "respond_to_advice",
      "web_fetch",
      "web_search",
      "write_file",
    ]);

    const fallback = renderToolPresentation({
      name: "inspect_manifest",
      arguments: { path: "package.json", depth: 2 },
      result: "custom result",
      status: "succeeded",
      width: 80,
    });
    expect(fallback.summary).toBe("package.json");
    expect(text(fallback.expanded)).toContain("arguments");
    expect(text(fallback.expanded)).toContain('"depth": 2');
    expect(text(fallback.expanded)).toContain("custom result");
  });

  it("renders a Prime-style bash tail without exposing result JSON", () => {
    const rendered = renderToolPresentation({
      name: "bash",
      arguments: { command: "npm test", timeout: 30 },
      result: {
        stdout: "one\ntwo\nthree\nfour\nfive\nsix\nseven",
        stderr: "warning from stderr",
        exitCode: 0,
        truncated: true,
        truncation: {
          stdout: { totalLines: 20, outputLines: 7 },
          stderr: { totalLines: 1, outputLines: 1 },
        },
      },
      status: "succeeded",
      width: 80,
    });

    expect(rendered.summary).toBe("$ npm test (30s timeout)");
    expect(rendered.collapsed).toHaveLength(7);
    expect(rendered.collapsed[0]).toMatchObject({ tone: "muted" });
    expect(text(rendered.collapsed)).not.toContain("one");
    expect(text(rendered.collapsed)).toContain("seven");
    expect(text(rendered.collapsed)).toContain("warning from stderr");
    expect(text(rendered.collapsed)).toContain("showing 8 of 21 lines");
    expect(text(rendered.expanded)).toContain("one");
    expect(text(rendered.expanded)).not.toContain('"stdout"');
  });

  it("does not count a shell's final newline as a visual preview row", () => {
    const rendered = renderToolPresentation({
      name: "bash",
      arguments: { command: "seq 1 8" },
      result: {
        stdout: "1\n2\n3\n4\n5\n6\n7\n8\n",
        stderr: "",
        exitCode: 0,
        truncated: false,
      },
      status: "succeeded",
      width: 80,
    });

    expect(text(rendered.collapsed)).toBe("... 3 earlier lines\n4\n5\n6\n7\n8");
  });

  it("keeps terminal bash diagnostics when expanded output exceeds the UI budget", () => {
    const stdout = Array.from({ length: 300 }, (_, index) => `line-${index + 1}`).join("\n");
    const rendered = renderToolPresentation({
      name: "bash",
      arguments: { command: "long-command" },
      result: {
        stdout,
        stderr: "fatal detail",
        error: "Command exited with code 2",
        exitCode: 2,
        truncated: true,
        truncation: {
          stdout: { totalLines: 500, outputLines: 300 },
          stderr: { totalLines: 1, outputLines: 1 },
        },
      },
      status: "failed",
      width: 80,
    });

    expect(rendered.expanded).toHaveLength(200);
    expect(text(rendered.expanded)).not.toContain("line-1\n");
    expect(text(rendered.expanded)).toContain("line-300");
    expect(text(rendered.expanded)).toContain("fatal detail");
    expect(text(rendered.expanded)).toContain("Command exited with code 2");
    expect(text(rendered.expanded)).toContain("showing 301 of 501 lines");
  });

  it("reports byte-truncated bash output in bytes instead of misleading line counts", () => {
    const rendered = renderToolPresentation({
      name: "bash",
      arguments: { command: "emit-one-long-line" },
      result: {
        stdout: "tail",
        stderr: "",
        exitCode: 0,
        truncated: true,
        truncation: {
          stdout: {
            truncated: true,
            truncatedBy: "bytes",
            totalBytes: 10_240,
            outputBytes: 1_024,
            totalLines: 1,
            outputLines: 1,
          },
          stderr: {
            truncated: false,
            truncatedBy: null,
            totalBytes: 0,
            outputBytes: 0,
            totalLines: 0,
            outputLines: 0,
          },
        },
      },
      status: "succeeded",
      width: 80,
    });

    expect(text(rendered.expanded)).toContain("showing 1.0 KB of 10.0 KB");
    expect(text(rendered.expanded)).not.toContain("1 of 1 lines");
  });

  it("clips huge fallback sources before wrapping them into display rows", () => {
    const rendered = renderToolPresentation({
      name: "custom_tool",
      result: "x".repeat(1_000_000),
      status: "succeeded",
      width: 40,
    });

    expect(rendered.expanded).toHaveLength(200);
    expect(rendered.expanded.at(-1)?.text).toContain("source clipped");
    expect(rendered.expanded.every((line) => visibleWidth(line.text) <= 40)).toBe(true);
  });

  it("renders file reads, listings, and writes from their structured contracts", () => {
    const read = renderToolPresentation({
      name: "read_file",
      arguments: '{"path":"src/main.ts","offset":2}',
      result: JSON.stringify({
        path: "src/main.ts",
        content: "const one = 1;\nconst two = 2;",
        offset: 2,
        lineCount: 2,
        truncated: true,
      }),
      status: "succeeded",
      width: 80,
    });
    expect(read.summary).toBe("src/main.ts · lines 2-3 · more");
    expect(text(read.expanded)).toContain("const two = 2;");
    expect(text(read.expanded)).not.toContain('"content"');

    const list = renderToolPresentation({
      name: "list_files",
      arguments: { path: "src" },
      result: {
        path: "src",
        entries: [
          { path: "src/cli", type: "directory" },
          { path: "src/index.ts", type: "file" },
          { path: "src/current", type: "symlink" },
        ],
        truncated: false,
      },
      status: "succeeded",
      width: 80,
    });
    expect(list.summary).toBe("src · 3 entries");
    expect(text(list.expanded)).toContain("dir   src/cli");
    expect(text(list.expanded)).toContain("link  src/current");

    const write = renderToolPresentation({
      name: "write_file",
      arguments: { path: "src/new.ts", content: "export {};" },
      result: { path: "src/new.ts", byteLength: 10, atomic: true },
      status: "succeeded",
      width: 80,
    });
    expect(write.summary).toBe("src/new.ts · 10 B written");
    expect(text(write.expanded)).not.toContain("export {}");
  });

  it("renders file metadata, images, and path mutations without result JSON", () => {
    const info = renderToolPresentation({
      name: "file_info",
      arguments: { path: "bin/run" },
      result: {
        path: "bin/run",
        type: "file",
        byteLength: 2_048,
        mode: 0o755,
        executable: true,
        modifiedAt: "2026-08-30T00:00:00.000Z",
        createdAt: "2026-08-29T00:00:00.000Z",
        hash: "sha256:abc",
      },
      status: "succeeded",
      width: 100,
    });
    expect(info.summary).toBe("bin/run · file · 2.0 KB");
    expect(text(info.expanded)).toContain("Mode 0755 · executable");
    expect(text(info.expanded)).toContain("sha256:abc");
    expect(text(info.expanded)).not.toContain('"modifiedAt"');

    const image = renderToolPresentation({
      name: "read_image",
      arguments: { path: "screen.png" },
      result: { path: "screen.png", mimeType: "image/png", byteLength: 4_096 },
      status: "succeeded",
      width: 80,
    });
    expect(image.summary).toBe("screen.png · image/png · 4.0 KB");
    expect(text(image.expanded)).toBe("Image attached to model context");

    const created = renderToolPresentation({
      name: "directory_create",
      arguments: { path: "fixtures/new", parents: true },
      result: { path: "fixtures/new", created: true, parents: true },
      status: "succeeded",
      width: 80,
    });
    expect(created.summary).toBe("fixtures/new · created");
    expect(text(created.expanded)).toBe("Parent creation enabled");

    const copied = renderToolPresentation({
      name: "path_copy",
      arguments: { from: "a.txt", to: "b.txt" },
      result: { from: "a.txt", to: "b.txt", type: "file", bytes: 12 },
      status: "succeeded",
      width: 80,
    });
    expect(copied.summary).toBe("a.txt -> b.txt · copied · file · 12 B");

    const moved = renderToolPresentation({
      name: "path_move",
      arguments: { from: "old", to: "new" },
      result: { from: "old", to: "new", type: "directory" },
      status: "succeeded",
      width: 80,
    });
    expect(moved.summary).toBe("old -> new · moved · directory");

    const deleted = renderToolPresentation({
      name: "path_delete",
      arguments: { path: "old", recursive: true },
      result: { path: "old", type: "directory", deleted: true, recursive: true },
      status: "succeeded",
      width: 80,
    });
    expect(deleted.summary).toBe("old · directory deleted recursively");
  });

  it("renders web fetches and searches as bounded content and citeable sources", () => {
    const fetched = renderToolPresentation({
      name: "web_fetch",
      arguments: { url: "https://example.test/docs" },
      result: {
        url: "https://example.test/docs",
        statusCode: 200,
        contentType: "text/plain",
        body: { kind: "text", content: "first\nsecond\nthird\nfourth" },
        truncated: true,
      },
      status: "succeeded",
      width: 100,
    });
    expect(fetched.summary).toContain("HTTP 200 · text");
    expect(fetched.summary).toContain("more");
    expect(text(fetched.collapsed)).toContain("... 2 more lines");
    expect(text(fetched.expanded)).toContain("fourth");
    expect(text(fetched.expanded)).not.toContain('"body"');

    const searched = renderToolPresentation({
      name: "web_search",
      arguments: { queries: ["Nausicaa runtime", "Nausicaa Mowe"] },
      result: {
        sources: [
          { url: "https://example.test/a", title: "Architecture", snippet: "Runtime notes" },
          { url: "https://example.test/b", title: "Tools" },
        ],
        truncated: false,
      },
      status: "succeeded",
      width: 100,
    });
    expect(searched.summary).toBe("2 searches · 2 sources");
    expect(text(searched.collapsed)).toContain("Architecture · https://example.test/a");
    expect(text(searched.expanded)).toContain("Runtime notes");
    expect(text(searched.expanded)).not.toContain('"sources"');

    const failed = renderToolPresentation({
      name: "web_fetch",
      arguments: { url: "http://127.0.0.1" },
      result: { error: { code: "WEB_URL_BLOCKED", message: "URL is private" } },
      status: "failed",
      width: 80,
    });
    expect(failed.summary).toBe("WEB_URL_BLOCKED: URL is private");
    expect(text(failed.collapsed)).toBe("WEB_URL_BLOCKED: URL is private");
  });

  it("renders background process lifecycle and output without snapshot JSON", () => {
    const snapshot = {
      id: "job-123",
      pid: 42,
      state: "running",
      exitCode: null,
      signal: null,
      startedAt: "2026-08-30T00:00:00.000Z",
      endedAt: null,
      stdout: { content: "", totalLines: 3, totalBytes: 30, outputLines: 3, outputBytes: 30, truncated: false },
      stderr: { content: "", totalLines: 0, totalBytes: 0, outputLines: 0, outputBytes: 0, truncated: false },
    };
    const started = renderToolPresentation({
      name: "process_start",
      arguments: { command: "npm run dev" },
      result: snapshot,
      status: "succeeded",
      width: 100,
    });
    expect(started.summary).toBe("$ npm run dev · running");
    expect(text(started.collapsed)).toBe("job-123 · pid 42");
    expect(text(started.expanded)).toContain("stdout · 3 lines · 30 B");
    expect(text(started.expanded)).not.toContain('"startedAt"');

    for (const name of ["process_status", "process_kill"] as const) {
      const rendered = renderToolPresentation({
        name,
        arguments: { jobId: "job-123" },
        result: { ...snapshot, state: name === "process_kill" ? "killed" : "running" },
        status: "succeeded",
        width: 100,
      });
      expect(rendered.summary).toContain(`job-123 · ${name === "process_kill" ? "killed" : "running"}`);
    }

    const output = renderToolPresentation({
      name: "process_output",
      arguments: { jobId: "job-123", stream: "both" },
      result: {
        jobId: "job-123",
        state: "running",
        stream: "both",
        stdout: { content: "ready\nserving", truncated: false },
        stderr: { content: "warning", truncated: true, outputBytes: 7, totalBytes: 70 },
      },
      status: "succeeded",
      width: 80,
    });
    expect(output.summary).toBe("job-123 · running · both");
    expect(text(output.expanded)).toContain("ready\nserving");
    expect(text(output.expanded)).toContain("stderr truncated · showing 7 B of 70 B");
    expect(text(output.expanded)).not.toContain('"stdout"');

    const list = renderToolPresentation({
      name: "process_list",
      result: JSON.stringify([
        { snapshot, status: "attached", persisted: true },
        { snapshot: { ...snapshot, id: "job-456", pid: null, state: "succeeded" }, status: "terminal", persisted: true },
      ]),
      status: "succeeded",
      width: 100,
    });
    expect(list.summary).toBe("2 process jobs");
    expect(text(list.expanded)).toContain("job-123 · running · pid 42 · attached");
    expect(text(list.expanded)).toContain("job-456 · succeeded · terminal");
    expect(text(list.expanded)).not.toContain('"snapshot"');
  });

  it("renders Worker delegation and Teto acknowledgement as collaboration events", () => {
    const delegated = renderToolPresentation({
      name: "delegate_task",
      arguments: {
        statement: "Inspect the storage boundary",
        successCriteria: ["Identify the owner"],
        hardConstraints: ["Read only"],
        input: "bounded source",
        maxModelTokens: 2_000,
        maxWallClockMs: 30_000,
      },
      result: { status: "queued", taskId: "task-storage", messageId: "message-1" },
      status: "succeeded",
      width: 100,
    });
    expect(delegated.summary).toBe("Inspect the storage boundary · queued");
    expect(text(delegated.collapsed)).toBe("task-storage");
    expect(text(delegated.expanded)).toContain("success  Identify the owner");
    expect(text(delegated.expanded)).toContain("limit    Read only");
    expect(text(delegated.expanded)).toContain("2000 tokens · 30.0s");
    expect(text(delegated.expanded)).not.toContain("bounded source");

    const advice = renderToolPresentation({
      name: "respond_to_advice",
      arguments: { adviceId: "advice-1", disposition: "accept", reason: "It closes the gap" },
      result: { adviceId: "advice-1", disposition: "accept", status: "acknowledged" },
      status: "succeeded",
      width: 80,
    });
    expect(advice.summary).toBe("accept advice-1 · acknowledged");
    expect(text(advice.expanded)).toBe("It closes the gap");
  });

  it("distinguishes a partial read line from an empty file", () => {
    const partial = renderToolPresentation({
      name: "read_file",
      arguments: { path: "long.txt", maxBytes: 4 },
      result: {
        path: "long.txt",
        content: "abcd",
        offset: 1,
        lineCount: 0,
        lineTruncated: true,
        truncated: true,
        nextOffset: 1,
        nextLineByteOffset: 4,
      },
      status: "succeeded",
      width: 80,
    });
    expect(partial.summary).toBe("long.txt · line 1 · partial · more");
    expect(text(partial.expanded)).toContain("abcd");
    expect(text(partial.expanded)).toContain("Line continues at byte 4");
    expect(text(partial.expanded)).not.toContain("empty file");

    const noCharacter = renderToolPresentation({
      name: "read_file",
      arguments: { path: "unicode.txt", maxBytes: 1 },
      result: {
        path: "unicode.txt",
        content: "",
        offset: 1,
        lineCount: 0,
        lineTruncated: true,
        truncated: true,
        nextOffset: 1,
        nextLineByteOffset: 0,
        minimumMaxBytes: 3,
      },
      status: "succeeded",
      width: 80,
    });
    expect(text(noCharacter.expanded)).toContain("retry with maxBytes >= 3");
    expect(text(noCharacter.expanded)).not.toContain("empty file");
  });

  it("renders grep and find results as compact locations and paths", () => {
    const grep = renderToolPresentation({
      name: "grep",
      arguments: { pattern: "needle", path: "src" },
      result: {
        path: "src",
        matchCount: 1,
        filesMatched: 1,
        truncated: false,
        matches: [{
          path: "src/a.ts",
          line: 8,
          column: 4,
          text: "const needle = true;",
          before: [{ line: 7, text: "// context" }],
          after: [{ line: 9, text: "export { needle };" }],
        }],
      },
      status: "succeeded",
      width: 80,
    });
    expect(grep.summary).toBe("src · 1 matches in 1 files");
    expect(text(grep.expanded)).toContain("src/a.ts:8:4  const needle = true;");
    expect(grep.expanded.map((line) => line.tone)).toEqual(["context", "output", "context"]);

    const find = renderToolPresentation({
      name: "find",
      arguments: { pattern: "**/*.ts", path: "." },
      result: {
        path: ".",
        pattern: "**/*.ts",
        files: ["src/a.ts", "src/b.ts"],
        count: 2,
        truncated: true,
      },
      status: "succeeded",
      width: 80,
    });
    expect(find.summary).toBe(". · 2 paths · more");
    expect(text(find.expanded)).toContain("src/b.ts");
    expect(find.expanded.at(-1)).toMatchObject({ tone: "warning" });
  });

  it("renders edits as semantic rich-diff rows and a compact change summary", () => {
    const diff = [
      " 1 unchanged",
      "-2 const oldName = true;",
      "+2 const newName = true;",
      " 3 export { newName };",
    ].join("\n");
    const rendered = renderToolPresentation({
      name: "edit",
      arguments: { path: "src/a.ts", edits: [] },
      result: { path: "src/a.ts", replacements: 1, diff },
      status: "succeeded",
      width: 40,
    });

    expect(rendered.summary).toBe("src/a.ts · 1 replacement · +1 -1");
    expect(rendered.collapsed).toEqual([{
      text: "2 changed lines · +1 -1",
      tone: "muted",
    }]);
    expect(rendered.expanded.map((line) => line.tone)).toEqual([
      "context",
      "removed",
      "added",
      "context",
    ]);
    expect(text(rendered.expanded)).toContain("+2 const newName = true;");

    const wrapped = renderRichDiffRows("+12 a very long replacement line", 12);
    expect(wrapped.length).toBeGreaterThan(1);
    expect(wrapped.every((line) => visibleWidth(line.text) <= 12)).toBe(true);
    expect(wrapped.every((line) => line.tone === "added")).toBe(true);
  });

  it("shows failures, strips terminal controls, and bounds every line", () => {
    const rendered = renderToolPresentation({
      name: "read_file",
      arguments: { path: "secret.txt" },
      result: { error: "Permission denied\x1b]0;spoofed\x07\nretry safely" },
      status: "failed",
      width: 12,
    });

    expect(rendered.summary).not.toContain("\x1b");
    expect(text(rendered.expanded)).toContain("Permission");
    expect(text(rendered.expanded)).not.toContain("spoofed");
    for (const row of [...rendered.collapsed, ...rendered.expanded]) {
      expect(visibleWidth(row.text)).toBeLessThanOrEqual(12);
      expect(row.tone).toBe("error");
    }
  });
});

function text(lines: readonly { text: string }[]): string {
  return lines.map((line) => line.text).join("\n");
}
