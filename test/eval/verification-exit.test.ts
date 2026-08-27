import { describe, expect, it } from "vitest";

import { phase24VerificationExitCode } from "./verification-exit.js";

describe("Phase 2.4 verifier CLI exit contract", () => {
  it("returns success only for a complete eligible release", () => {
    expect(phase24VerificationExitCode({
      complete: true,
      releaseDecision: {
        status: "release",
        eligible: true,
        primaryTreatmentArmId: "teto-live",
        primaryControlArmId: "teto-shadow",
        checks: {} as never,
        primaryCheck: {} as never,
        reasons: [],
      },
    })).toBe(0);
  });

  it("returns gate failure for a complete hold or incomplete evidence", () => {
    expect(phase24VerificationExitCode({
      complete: true,
      releaseDecision: {
        status: "hold",
        eligible: false,
        primaryTreatmentArmId: "teto-live",
        primaryControlArmId: "teto-shadow",
        checks: {} as never,
        primaryCheck: {} as never,
        reasons: ["uplift interval crossed zero"],
      },
    })).toBe(2);
    expect(phase24VerificationExitCode({ complete: false })).toBe(2);
  });
});
