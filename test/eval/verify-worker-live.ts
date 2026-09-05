import {
  persistedErrorText,
  stringifyRedactedJson,
} from "../../src/runtime/redaction.js";
import { verifyWorkerLiveArtifacts } from "./worker-live-runner.js";
import { workerLiveVerificationExitCode } from "./worker-live-verification-exit.js";

const artifactDirectory = process.argv[2];
if (artifactDirectory === undefined || artifactDirectory.trim().length === 0) {
  process.stderr.write(
    "Usage: node --import tsx test/eval/verify-worker-live.ts <artifact-directory>\n",
  );
  process.exitCode = 1;
} else {
  try {
    const verified = await verifyWorkerLiveArtifacts(artifactDirectory);
    process.stdout.write(`${stringifyRedactedJson({
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
  } catch (error: unknown) {
    process.stderr.write(
      `Worker live artifact verification failed: ${persistedErrorText(error)}\n`,
    );
    process.exitCode = 1;
  }
}
