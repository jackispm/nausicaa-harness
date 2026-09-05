import { persistedErrorText } from "../../src/runtime/redaction.js";
import { verifyCacheProbeArtifact } from "./cache-artifact.js";

const artifactPath = process.argv[2];
if (artifactPath === undefined || artifactPath.trim().length === 0) {
  process.stderr.write("Usage: npm run eval:cache:verify -- <artifact-file>\n");
  process.exitCode = 1;
} else {
  try {
    const verified = await verifyCacheProbeArtifact(artifactPath);
    process.stdout.write(`${JSON.stringify({
      artifactPath,
      taskId: verified.provenance.taskId,
      executionCommit: verified.provenance.executionCommit,
      evidenceDigest: verified.evidenceDigest,
      requests: verified.cacheEvidence.total.requestCount,
      completed: verified.cacheEvidence.total.completed,
      cacheReadTokens: verified.totals.cacheReadTokens,
      spentUsd: verified.totals.spentUsd,
      decision: verified.releaseDecision.status,
      reasons: verified.releaseDecision.reasons,
    }, null, 2)}\n`);
    if (verified.releaseDecision.eligible !== true) process.exitCode = 2;
  } catch (error: unknown) {
    process.stderr.write(`Cache artifact verification failed: ${persistedErrorText(error)}\n`);
    process.exitCode = 1;
  }
}
