import { describe, expect, it } from "vitest";

import { CliUsageError, parseCliArgs } from "../../src/cli/args.js";

describe("parseCliArgs", () => {
  it("keeps a task as one message", () => {
    expect(parseCliArgs(["inspect", "this", "repo"], "/work")).toMatchObject({
      message: "inspect this repo",
      mode: "print",
      workspace: "/work",
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
      model: "openrouter:openai/gpt-5-mini",
      tetoEnabled: false,
      resume: "run-7",
      maxSteps: 8,
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
  });
});
