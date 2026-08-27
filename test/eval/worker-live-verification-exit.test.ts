import { describe, expect, it } from "vitest";

import { workerLiveVerificationExitCode } from "./worker-live-verification-exit.js";

describe("Worker live verifier CLI exit contract", () => {
  it("returns success only for complete evidence that advances the Worker gate", () => {
    expect(workerLiveVerificationExitCode({
      complete: true,
      decision: { status: "advance" },
    })).toBe(0);
  });

  it("returns hold for complete evidence without an advance decision", () => {
    expect(workerLiveVerificationExitCode({
      complete: true,
      decision: { status: "hold" },
    })).toBe(2);
    expect(workerLiveVerificationExitCode({ complete: true })).toBe(2);
  });

  it("returns incomplete even if a malformed result claims advance", () => {
    expect(workerLiveVerificationExitCode({ complete: false })).toBe(3);
    expect(workerLiveVerificationExitCode({
      complete: false,
      decision: { status: "advance" },
    })).toBe(3);
  });
});
