import { persistedErrorText } from "../../src/runtime/redaction.js";
import { verifyEvaluationArtifacts } from "./runner.js";
import { phase24VerificationExitCode } from "./verification-exit.js";

const artifactDirectory = process.argv[2];
if (artifactDirectory === undefined || artifactDirectory.trim().length === 0) {
  process.stderr.write("Usage: npm run eval:verify -- <artifact-directory>\n");
  process.exitCode = 1;
} else {
  try {
    const verified = await verifyEvaluationArtifacts(artifactDirectory);
    process.stdout.write(`${JSON.stringify({
      artifactDirectory: verified.artifactDirectory,
      evidenceDigest: verified.evidenceDigest,
      records: verified.recordCount,
      samples: verified.sampleCount,
      failures: verified.failureCount,
      complete: verified.complete,
      decision: verified.releaseDecision?.status ?? "incomplete",
      reasons: verified.releaseDecision?.reasons
        ?? (verified.incompleteReason === undefined ? [] : [verified.incompleteReason]),
    }, null, 2)}\n`);
    process.exitCode = phase24VerificationExitCode(verified);
  } catch (error: unknown) {
    process.stderr.write(`Evaluation artifact verification failed: ${persistedErrorText(error)}\n`);
    process.exitCode = 1;
  }
}
