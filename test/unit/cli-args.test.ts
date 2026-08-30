import { describe, expect, it } from "vitest";

import { CliUsageError, parseCliArgs, usage } from "../../src/cli/args.js";

describe("parseCliArgs", () => {
  it("keeps a task as one message", () => {
    expect(parseCliArgs(["inspect", "this", "repo"], "/work")).toMatchObject({
      message: "inspect this repo",
      mode: "interactive",
      modeExplicit: false,
      continue: false,
      workspace: "/work",
    });
  });

  it("allows an interactive session to start without a message", () => {
    expect(parseCliArgs([], "/work")).toMatchObject({
      mode: "interactive",
      modeExplicit: false,
      continue: false,
      workspace: "/work",
    });
    expect(parseCliArgs([], "/work")).not.toHaveProperty("message");
  });

  it("parses the long-lived daemon control mode", () => {
    expect(parseCliArgs([
      "--daemon",
      "--daemon-socket",
      ".state/control.sock",
      "--allow-shell",
      "--allow-network",
    ], "/work")).toMatchObject({
      daemon: true,
      daemonSocket: ".state/control.sock",
      allowShell: true,
      allowNetwork: true,
    });
    expect(() => parseCliArgs(["--daemon-socket", "/tmp/control.sock"], "/work"))
      .toThrow(/requires --daemon/u);
    expect(() => parseCliArgs(["--daemon", "task"], "/work"))
      .toThrow(/cannot be combined/u);
  });

  it("parses a read-only daemon attachment without enabling daemon mode", () => {
    expect(parseCliArgs([
      "--attach",
      "run-7",
      "--daemon-socket",
      "/tmp/nausicaa-control.sock",
    ], "/work")).toMatchObject({
      daemon: false,
      attach: "run-7",
      daemonSocket: "/tmp/nausicaa-control.sock",
      mode: "interactive",
      modeExplicit: false,
    });
    expect(() => parseCliArgs(["--attach", "run-7", "task"], "/work"))
      .toThrow(/cannot be combined/u);
    expect(() => parseCliArgs(["--attach", "run-7", "--resume", "run-8"], "/work"))
      .toThrow(/cannot be combined/u);
    expect(() => parseCliArgs(["--attach", "run-7", "--daemon"], "/work"))
      .toThrow(/cannot be combined/u);
    expect(() => parseCliArgs(["--attach", "run-7", "--allow-write"], "/work"))
      .toThrow(/only accepts/u);
    expect(() => parseCliArgs(["--attach", "run-7", "--worker"], "/work"))
      .toThrow(/only accepts/u);
    expect(usage).toContain("--attach <run-id>");
  });

  it("separates Prime-style @image operands from the task", () => {
    expect(parseCliArgs([
      "@screens/first.png",
      "inspect",
      "@screens/second.webp",
    ], "/work")).toMatchObject({
      fileArgs: ["screens/first.png", "screens/second.webp"],
      message: "inspect",
    });
    expect(parseCliArgs(["--", "@literal"], "/work")).toMatchObject({
      fileArgs: [],
      message: "@literal",
    });
    expect(() => parseCliArgs(["@"], "/work")).toThrow(/image path/i);
  });

  it("tracks explicitly selected output modes", () => {
    expect(parseCliArgs(["-p", "task"], "/work")).toMatchObject({
      mode: "print",
      modeExplicit: true,
    });
    expect(parseCliArgs(["--json", "task"], "/work")).toMatchObject({
      mode: "json",
      modeExplicit: true,
    });
    expect(
      parseCliArgs(["--mode", "interactive", "task"], "/work"),
    ).toMatchObject({
      mode: "interactive",
      modeExplicit: true,
    });
  });

  it("parses model, output, and lane controls", () => {
    expect(
      parseCliArgs(
        [
          "--mode",
          "json",
          "--model",
          "openrouter:openai/gpt-5-mini",
          "--main-only",
          "--worker",
          "--fukai-compaction",
          "--fukai-provider",
          "pi-ai",
          "--fukai-max-input-tokens",
          "12000",
          "--fukai-max-output-tokens",
          "2048",
          "--fukai-max-wall-clock-ms",
          "30000",
          "--allow-write",
          "--allow-shell",
          "--allow-network",
          "--resume",
          "run-7",
          "--max-steps",
          "8",
          "--max-output-tokens",
          "8192",
          "task",
        ],
        "/work",
      ),
    ).toMatchObject({
      mode: "json",
      modeExplicit: true,
      model: "openrouter:openai/gpt-5-mini",
      tetoEnabled: false,
      workerEnabled: true,
      fukaiCompaction: {
        enabled: true,
        provider: "pi-ai",
        maxInputTokens: 12_000,
        maxOutputTokens: 2_048,
        maxWallClockMs: 30_000,
      },
      allowWrite: true,
      allowShell: true,
      allowNetwork: true,
      resume: "run-7",
      maxSteps: 8,
      maxOutputTokens: 8192,
      message: "task",
    });
  });

  it("leaves write access unset unless explicitly requested", () => {
    expect(parseCliArgs(["task"], "/work").allowWrite).toBeUndefined();
    expect(parseCliArgs(["--allow-write", "task"], "/work")).toMatchObject({
      allowWrite: true,
      message: "task",
    });
  });

  it("leaves shell access unset unless explicitly requested", () => {
    expect(parseCliArgs(["--allow-write", "task"], "/work").allowShell)
      .toBeUndefined();
    const options = parseCliArgs(["--allow-shell", "task"], "/work");
    expect(options).toMatchObject({
      allowShell: true,
      message: "task",
    });
    expect(options.allowWrite).toBeUndefined();
  });

  it("keeps network access unset unless explicitly requested", () => {
    expect(parseCliArgs(["task"], "/work").allowNetwork).toBeUndefined();
    expect(parseCliArgs(["--allow-network", "task"], "/work")).toMatchObject({
      allowNetwork: true,
      message: "task",
    });
  });

  it("parses edge enablement and refresh controls", () => {
    expect(parseCliArgs(["--edges", "--refresh-edges", "task"], "/work"))
      .toMatchObject({
        edgesEnabled: true,
        refreshEdges: true,
        edges: { enabled: true, refreshOnStart: true },
        message: "task",
      });
    expect(parseCliArgs(["--no-edges", "task"], "/work")).toMatchObject({
      edgesEnabled: false,
      edges: { enabled: false },
    });
  });

  it("parses explicit Fukai disablement without enabling a provider", () => {
    expect(parseCliArgs(["--no-fukai-compaction", "task"], "/work"))
      .toMatchObject({
        fukaiCompaction: { enabled: false },
        message: "task",
      });
    expect(parseCliArgs(["--fukai-provider", "none", "task"], "/work"))
      .toMatchObject({
        fukaiCompaction: { provider: "none" },
        message: "task",
      });
  });

  it("rejects malformed or unknown options", () => {
    expect(() => parseCliArgs(["--mode", "rpc"], "/work")).toThrow(
      CliUsageError,
    );
    expect(() => parseCliArgs(["--wat"], "/work")).toThrow(CliUsageError);
    expect(() => parseCliArgs(["--max-steps", "0"], "/work")).toThrow(
      CliUsageError,
    );
    expect(() => parseCliArgs(["--max-output-tokens", "0"], "/work")).toThrow(
      CliUsageError,
    );
    expect(() => parseCliArgs(["--max-output-tokens", "1000001"], "/work")).toThrow(
      CliUsageError,
    );
    expect(() => parseCliArgs(["--max-output-tokens", "1.5"], "/work")).toThrow(
      CliUsageError,
    );
    expect(() => parseCliArgs(["--resolve-operation", "op-1"], "/work")).toThrow(
      /requires --resume/,
    );
    expect(() => parseCliArgs(["--fukai-provider", "other"], "/work")).toThrow(
      /fukai-provider.*none or pi-ai/i,
    );
    expect(() => parseCliArgs(["--fukai-max-output-tokens", "0"], "/work")).toThrow(
      /fukai-max-output-tokens.*positive integer/i,
    );
  });

  it("parses an explicit unknown-operation resolution for resume", () => {
    expect(parseCliArgs(
      ["--resume", "run-7", "--resolve-operation", "op-1"],
      "/work",
    )).toMatchObject({
      resume: "run-7",
      resolveOperation: "op-1",
    });
  });

  it("selects the latest workspace Run with --continue", () => {
    expect(parseCliArgs(["--continue"], "/work")).toMatchObject({
      continue: true,
      mode: "interactive",
      modeExplicit: false,
    });
  });

  it("rejects --continue together with --resume", () => {
    expect(() =>
      parseCliArgs(["--continue", "--resume", "run-7"], "/work"),
    ).toThrow(/mutually exclusive/);
    expect(() =>
      parseCliArgs(["--resume", "run-7", "--continue"], "/work"),
    ).toThrow(/mutually exclusive/);
  });

  it("documents interactive and latest-Run options", () => {
    expect(usage).toContain("--mode <interactive|print|json>");
    expect(usage).toContain("--continue");
    expect(usage).toContain("--max-output-tokens");
    expect(usage).toContain("--fukai-compaction");
    expect(usage).toContain("--fukai-provider <none|pi-ai>");
    expect(usage).toMatch(/--allow-shell.*high privilege.*read\/write outside the workspace/i);
    expect(usage).toContain("--allow-network");
    expect(usage).toContain("--edges");
    expect(usage).toContain("--refresh-edges");
    expect(usage).toContain("--daemon");
    expect(usage).toContain("--daemon-socket");
  });
});
