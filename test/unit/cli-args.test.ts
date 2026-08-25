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
          "--allow-write",
          "--resume",
          "run-7",
          "--max-steps",
          "8",
          "task",
        ],
        "/work",
      ),
    ).toMatchObject({
      mode: "json",
      modeExplicit: true,
      model: "openrouter:openai/gpt-5-mini",
      tetoEnabled: false,
      allowWrite: true,
      resume: "run-7",
      maxSteps: 8,
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

  it("rejects malformed or unknown options", () => {
    expect(() => parseCliArgs(["--mode", "rpc"], "/work")).toThrow(
      CliUsageError,
    );
    expect(() => parseCliArgs(["--wat"], "/work")).toThrow(CliUsageError);
    expect(() => parseCliArgs(["--max-steps", "0"], "/work")).toThrow(
      CliUsageError,
    );
    expect(() => parseCliArgs(["--resolve-operation", "op-1"], "/work")).toThrow(
      /requires --resume/,
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
  });
});
