import { describe, expect, it } from "vitest";

import {
  SHELL_MAX_OUTPUT_BYTES,
  SHELL_MAX_OUTPUT_LINES,
  ShellOutputCapture,
} from "../../src/tools/shell-output.js";

describe("ShellOutputCapture", () => {
  it("emits sanitized chunks to the optional host sink", () => {
    const chunks: string[] = [];
    const capture = new ShellOutputCapture({ onChunk: (chunk) => chunks.push(chunk) });

    capture.append("safe\u0000\r\n");

    expect(chunks).toEqual(["safe\n"]);
    expect(capture.snapshot()).toMatchObject({
      content: "safe\n",
      totalBytes: Buffer.byteLength("safe\n", "utf8"),
      outputBytes: Buffer.byteLength("safe\n", "utf8"),
    });
  });

  it("keeps the returned tail bounded while the host sink sees all chunks", () => {
    const chunks: string[] = [];
    const capture = new ShellOutputCapture({ onChunk: (chunk) => chunks.push(chunk) });
    const fullOutput = Array.from(
      { length: SHELL_MAX_OUTPUT_LINES + 500 },
      (_, index) => `line-${index}\n`,
    ).join("");

    capture.append(fullOutput);
    const snapshot = capture.snapshot();

    expect(chunks.join("")).toBe(fullOutput);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.totalLines).toBe(SHELL_MAX_OUTPUT_LINES + 500);
    expect(snapshot.outputLines).toBe(SHELL_MAX_OUTPUT_LINES);
    expect(snapshot.outputBytes).toBeLessThanOrEqual(SHELL_MAX_OUTPUT_BYTES);
    expect(snapshot.content).not.toContain("line-0\n");
    expect(snapshot.content).toContain(`line-${SHELL_MAX_OUTPUT_LINES + 499}`);
  });

  it("records sink errors once and continues bounded capture", () => {
    let calls = 0;
    const capture = new ShellOutputCapture({
      onChunk: () => {
        calls += 1;
        throw new Error("sink closed");
      },
    });

    capture.append("first");
    capture.append("second");

    expect(calls).toBe(1);
    expect(capture.snapshot()).toMatchObject({
      content: "firstsecond",
      outputSinkError: "Shell output sink failed",
    });
  });

  it("does not reflect host sink diagnostics into the captured result", () => {
    const capture = new ShellOutputCapture({
      onChunk: () => {
        throw new Error(`OPENROUTER_API_KEY=${"x".repeat(10_000)}`);
      },
    });

    capture.append("visible");

    expect(capture.snapshot().outputSinkError).toBe("Shell output sink failed");
  });
});
