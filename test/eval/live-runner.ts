import { persistedErrorText } from "../../src/runtime/redaction.js";
import {
  PHASE24_EVALUATION_ID,
  runPhase24Evaluation,
  verifyEvaluationArtifacts,
} from "./runner.js";
import { phase24VerificationExitCode } from "./verification-exit.js";

const configuredId = process.env.NAUSICAA_EVAL_ID?.trim();
const requestedId = configuredId === "" ? undefined : configuredId;
const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const evaluationId = requestedId ?? `${PHASE24_EVALUATION_ID}-${timestamp}`;

try {
  const evaluation = await runPhase24Evaluation({
    live: true,
    evaluationId,
  });
  try {
    if (evaluation.artifactDirectory === undefined) {
      throw new Error("Live evaluation did not persist an artifact directory");
    }
    const verified = await verifyEvaluationArtifacts(evaluation.artifactDirectory);
    process.stdout.write(`${JSON.stringify({
      evaluationId,
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
  } finally {
    await evaluation.cleanup();
  }
} catch (error: unknown) {
  process.stderr.write(`Phase 2.4 live evaluation failed: ${persistedErrorText(error)}\n`);
  process.exitCode = 1;
}
