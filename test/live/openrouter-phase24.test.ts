import { describe, expect, it } from "vitest";

import {
  PREREGISTERED_ARMS,
  PREREGISTERED_MANIFEST,
  evaluateReleaseDecision,
} from "../eval/preregistered-contract.js";
import { PHASE24_EVALUATION_ENV, runPhase24Evaluation } from "../eval/runner.js";

const enabled = process.env[PHASE24_EVALUATION_ENV] === "1";

describe.skipIf(!enabled)("preregistered OpenRouter Phase 2.4 evaluation", () => {
  it("runs the frozen four-arm experiment and checkpoints its evidence", async () => {
    const evaluation = await runPhase24Evaluation({ live: true });
    try {
      expect(evaluation.records).toHaveLength(
        PREREGISTERED_MANIFEST.sampleCount * PREREGISTERED_ARMS.length,
      );
      expect(evaluation.rows).toHaveLength(PREREGISTERED_MANIFEST.sampleCount);
      expect(evaluation.failures).toHaveLength(0);
      expect(evaluation.report?.provenance).toMatchObject({
        repositoryDirty: false,
        evidenceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
      if (evaluation.report === undefined) throw new Error("Live evaluation did not produce a report");
      expect(evaluateReleaseDecision(evaluation.report)).toMatchObject({
        status: "release",
        eligible: true,
      });
    } finally {
      await evaluation.cleanup();
    }
  }, 3_000_000);
});
