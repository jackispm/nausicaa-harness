import {
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import {
  ActivityLine,
  AdviceBlock,
  AssistantMessageBlock,
  BrandSplashHeader,
  NoticeBlock,
  QueuePreview,
  SessionTray,
  ToolStatusBlock,
  ThinkingRow,
  UserMessageBlock,
  selectLatestToolExpandHint,
  setNausicaaColorScheme,
  terminalSafeText,
} from "../../src/cli/tui-components.js";
import type { SessionSnapshot } from "../../src/runtime/index.js";

const snapshot: SessionSnapshot = {
  workspace: "/work/a-very-long-project-name",
  runId: "run-1234567890abcdef",
  turnId: "turn-1234567890abcdef",
  status: "running",
  model: "openrouter:openai/gpt-5-mini",
  tetoEnabled: true,
  workerEnabled: false,
  allowWrite: false,
  allowShell: false,
  pendingInputs: 2,
  lastCommittedStep: 3,
  usage: { input: 120, output: 30, cacheRead: 80, cacheWrite: 0 },
};

describe("TUI components", () => {
  it("keeps every rendered line inside the terminal width", () => {
    const tool = new ToolStatusBlock("read_file", "running", "src/a.ts");
    tool.setStatus("succeeded");
    const components = [
      new SessionTray(() => snapshot),
      new ActivityLine(() => snapshot),
      new UserMessageBlock("Inspect **this repository** and explain it."),
      new AssistantMessageBlock("## Result\n\n- one\n- two\n\n```ts\nconst x = 1;\n```"),
      tool,
      new AdviceBlock("The current approach may miss the stated intent.", "Re-read the goal.", 0.82),
      new NoticeBlock("Waiting for operator input.", "warning"),
    ];

    for (const width of [1, 2, 4, 20, 80]) {
      for (const component of components) {
        for (const line of component.render(width)) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it("renders semantic labels instead of raw bracketed logs", () => {
    const user = stripTerminalSequences(new UserMessageBlock("hello").render(80).join("\n"));
    const assistant = stripTerminalSequences(
      new AssistantMessageBlock("**done**").render(80).join("\n"),
    );
    const advice = stripTerminalSequences(
      new AdviceBlock("Check intent.", undefined, 0.9).render(80).join("\n"),
    );

    expect(user).not.toContain("you");
    expect(user).toContain("hello");
    expect(assistant).toContain("done");
    expect(advice).toContain("Teto");
    expect(advice).toContain("90%");

    const activity = stripTerminalSequences(new ActivityLine(() => snapshot).render(80).join("\n"));
    expect(activity).toContain("Thinking");
    expect(activity).toContain("step 3");
  });

  it("shows the opt-in Worker lane in the topology tray", () => {
    const workerSnapshot = { ...snapshot, workerEnabled: true };
    const tray = stripTerminalSequences(new SessionTray(() => workerSnapshot).render(100).join("\n"));
    expect(tray).toContain("main + Teto + Worker/running");
  });

  it("keeps the Prime-style brand header useful at wide and narrow widths", () => {
    const header = new BrandSplashHeader({
      version: "0.1.0",
      getModel: () => "openrouter:openai/gpt-5-mini",
      getWorkspace: () => "/work/project",
    });
    const wide = stripTerminalSequences(header.render(80).join("\n"));
    const narrow = stripTerminalSequences(header.render(24).join("\n"));
    expect(wide).toContain("version");
    expect(wide).toContain("openrouter");
    expect(narrow).toContain("Nausicaa");
    for (const [width, lines] of [[80, header.render(80)] as const, [24, header.render(24)] as const]) {
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    header.setCompact(true);
    const compact = stripTerminalSequences(header.render(80).join("\n"));
    expect(header.render(80)).toHaveLength(2);
    expect(compact).toContain("Nausicaa");
    expect(compact).toContain("openrouter");
  });

  it("expands thinking by default and expands tool details without losing content", () => {
    const thinking = new ThinkingRow();
    thinking.setText("**Inspect the goal**\nCheck the smallest useful change.");
    thinking.setStreaming(false);
    const expanded = stripTerminalSequences(thinking.render(80).join("\n"));
    expect(expanded).toContain("Thinking...");
    expect(expanded).toContain("Ctrl+T to collapse");
    expect(expanded).toContain("Check the smallest useful change");
    thinking.setExpanded(false);
    const collapsed = stripTerminalSequences(thinking.render(80).join("\n"));
    expect(collapsed).toContain("Thinking...");
    expect(collapsed).toContain("Ctrl+T to expand");

    const tool = new ToolStatusBlock("read_file", "succeeded");
    tool.setArguments('{"path":"README.md"}');
    tool.setResult("TOOL_RESULT_SENTINEL");
    const compact = stripTerminalSequences(tool.render(80).join("\n"));
    expect(compact).toContain("README.md");
    expect(compact).not.toContain("TOOL_RESULT_SENTINEL");
    expect(tool.render(80)).toHaveLength(1);
    tool.setExpanded(true);
    const detailed = stripTerminalSequences(tool.render(80).join("\n"));
    expect(detailed).toContain("README.md");
    expect(detailed).toContain("TOOL_RESULT_SENTINEL");
  });

  it("bounds and caches large tool result rendering", () => {
    const tool = new ToolStatusBlock("read_file", "succeeded");
    tool.setResult(`${"large result line\n".repeat(20_000)}END_SENTINEL`);

    const first = tool.render(80);
    const second = tool.render(80);
    expect(second).toBe(first);
    const collapsed = stripTerminalSequences(first.join("\n"));
    expect(first).toHaveLength(1);
    expect(collapsed).not.toContain("more output");
    expect(collapsed).not.toContain("END_SENTINEL");

    tool.setExpanded(true);
    const expanded = tool.render(80);
    expect(expanded).not.toBe(first);
    expect(expanded.length).toBeLessThanOrEqual(205);
    expect(stripTerminalSequences(expanded.join("\n"))).toContain("more lines");
  });

  it("advertises Ctrl+O only on the latest expandable tool", () => {
    const first = new ToolStatusBlock("read_file", "succeeded");
    first.setResult("first result\nwith detail");
    const second = new ToolStatusBlock("read_file", "succeeded");
    second.setResult("second result\nwith detail");

    selectLatestToolExpandHint([first], first);
    selectLatestToolExpandHint([first, second], second);

    expect(stripTerminalSequences(first.render(100).join("\n")))
      .not.toContain("Ctrl+O to expand");
    expect(stripTerminalSequences(second.render(100).join("\n")))
      .toContain("Ctrl+O to expand");
  });

  it("summarizes searches and shows a Prime-style bash tail when collapsed", () => {
    const grep = new ToolStatusBlock("grep", "running");
    grep.setArguments('{"pattern":"needle","path":"src","glob":"**/*.ts"}');
    grep.setStatus("succeeded");
    grep.setResult('{"path":"src","matches":["a.ts:1: needle"],"matchCount":1}');

    const rendered = stripTerminalSequences(grep.render(100).join("\n"));
    expect(grep.render(100)).toHaveLength(1);
    expect(rendered).toContain("src · 1 matches");
    expect(rendered).not.toContain("a.ts:1");

    const bash = new ToolStatusBlock("bash", "running");
    bash.setArguments('{"command":"npm test"}');
    bash.setStatus("succeeded");
    bash.setResult('{"stdout":"all tests passed","stderr":"","exitCode":0,"truncated":false}');
    const bashRendered = stripTerminalSequences(bash.render(100).join("\n"));
    expect(bash.render(100)).toHaveLength(3);
    expect(bashRendered).toContain("npm test");
    expect(bashRendered).toContain("all tests passed");
  });

  it("maps semantic edit rows to Prime-style added and removed colors", () => {
    setNausicaaColorScheme("light");
    const edit = new ToolStatusBlock("edit", "succeeded");
    edit.setArguments('{"path":"src/main.ts","edits":[]}');
    edit.setResult(JSON.stringify({
      path: "src/main.ts",
      replacements: 1,
      diff: " 1 context\n-2 const before = true;\n+2 const after = true;",
    }));

    const compact = stripTerminalSequences(edit.render(100).join("\n"));
    expect(compact).toContain("+1 -1");
    expect(compact).not.toContain("const before");

    edit.setExpanded(true);
    const rendered = edit.render(100).join("\n");
    expect(stripTerminalSequences(rendered)).toContain("-2 const before = true;");
    expect(stripTerminalSequences(rendered)).toContain("+2 const after = true;");
    expect(rendered).toContain("\x1b[38;2;170;85;85m-2 const before = true;");
    expect(rendered).toContain("\x1b[38;2;88;132;88m+2 const after = true;");
  });

  it("renders queue previews and reacts to theme changes", () => {
    const queue = new QueuePreview();
    queue.setItems([
      { delivery: "steering", text: "Use the package manifest first" },
      { delivery: "follow-up", text: "Then summarize the findings" },
    ]);
    const rendered = stripTerminalSequences(queue.render(80).join("\n"));
    expect(rendered).toContain("steer");
    expect(rendered).toContain("follow-up");
    expect(rendered).toContain("package manifest");
    expect(rendered).not.toContain("browse");

    setNausicaaColorScheme("dark");
    const dark = new NoticeBlock("dark palette").render(80).join("\n");
    setNausicaaColorScheme("light");
    const light = new NoticeBlock("light palette").render(80).join("\n");
    expect(dark).not.toBe(light);
  });

  it("removes terminal control sequences from untrusted surface text", () => {
    const unsafe = "visible\x1b[2J\x1b]0;spoofed title\x07 text\u0000";
    const safe = terminalSafeText(unsafe);
    expect(safe).toBe("visible text");
    expect(safe).not.toContain("\x1b");

    const tool = new ToolStatusBlock(
      "write\x1b]8;;https://example.invalid\x07_file\x1b]8;;\x07\u0000",
      "unknown",
      "unresolved operation-1",
    );
    const rendered = tool.render(100).join("\n");
    expect(stripTerminalSequences(rendered)).toContain("write_file");
    expect(rendered).not.toContain("example.invalid");
    expect(rendered).not.toContain("\x07");
  });
});
