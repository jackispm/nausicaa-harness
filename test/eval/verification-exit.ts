import type { VerifiedEvaluationArtifacts } from "./runner.js";

/** A valid report is still a failed gate until its preregistered decision releases. */
export function phase24VerificationExitCode(
  verified: Pick<VerifiedEvaluationArtifacts, "complete" | "releaseDecision">,
): 0 | 2 {
  return verified.complete && verified.releaseDecision?.eligible === true ? 0 : 2;
}
