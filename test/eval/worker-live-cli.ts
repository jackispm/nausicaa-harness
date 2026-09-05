import {
  persistedErrorText,
  stringifyRedactedJson,
} from "../../src/runtime/redaction.js";
import {
  WORKER_LIVE_EVALUATION_ID,
  runWorkerLiveEvaluation,
  verifyWorkerLiveArtifacts,
} from "./worker-live-runner.js";
import { workerLiveVerificationExitCode } from "./worker-live-verification-exit.js";

const configuredId = process.env.NAUSICAA_WORKER_EVAL_ID?.trim();
const requestedId = configuredId === "" ? undefined : configuredId;
const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const evaluationId = requestedId
  ?? `${WORKER_LIVE_EVALUATION_ID}-${timestamp}`;

try {
  process.stderr.write(
    "Worker live cost enforcement is a post-response soft stop; in-flight requests may exceed it. Configure a provider-side OpenRouter limit key before running.\n",
  );
  const evaluation = await runWorkerLiveEvaluation({
    live: true,
    evaluationId,
  });
  try {
    if (evaluation.artifactDirectory === undefined) {
      throw new Error("Worker live evaluation did not persist artifacts");
    }
    const verified = await verifyWorkerLiveArtifacts(
      evaluation.artifactDirectory,
    );
    process.stdout.write(`${stringifyRedactedJson({
      evaluationId,
      scope: "worker-live",
      artifactDirectory: verified.artifactDirectory,
      evidenceDigest: verified.evidenceDigest,
      records: verified.recordCount,
      samples: verified.sampleCount,
      failures: verified.failureCount,
      complete: verified.complete,
      workerGate: verified.complete
        ? verified.decision?.status ?? "hold"
        : "incomplete",
      reasons: verified.complete
        ? verified.decision?.reasons ?? []
        : verified.incompleteReason === undefined
          ? []
          : [verified.incompleteReason],
    })}\n`);
    process.exitCode = workerLiveVerificationExitCode(verified);
  } finally {
    await evaluation.cleanup();
  }
} catch (error: unknown) {
  process.stderr.write(
    `Worker live evaluation failed: ${persistedErrorText(error)}\n`,
  );
  process.exitCode = 1;
}
