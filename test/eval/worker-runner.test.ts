import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  WORKER_EVAL_MANIFEST,
  WORKER_TREATMENT_ARM,
} from "./worker-contract.js";
import {
  runWorkerEvaluation,
  verifyWorkerArtifacts,
  type WorkerEvaluationResult,
} from "./worker-runner.js";

describe("Phase 3 deterministic Worker evaluation", () => {
  let temporaryDirectory: string;
  let evaluation: WorkerEvaluationResult;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "nausicaa-worker-runner-test-"));
    evaluation = await runWorkerEvaluation({
      artifactDirectory: join(temporaryDirectory, "artifacts"),
      evaluationId: "worker-runner-test",
      executionCommit: "a".repeat(40),
      repositoryDirty: false,
    });
  }, 120_000);

  afterAll(async () => {
    await evaluation?.cleanup();
    if (temporaryDirectory !== undefined) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("passes the deterministic mechanism gate", () => {
    expect(evaluation.rows).toHaveLength(WORKER_EVAL_MANIFEST.sampleCount);
    expect(evaluation.decision).toMatchObject({
      status: "pass",
      eligible: true,
      reasons: [],
    });
    expect(Object.values(evaluation.decision.checks).every(Boolean)).toBe(true);
  });

  it("joins all three tasks while isolating partial and failed results", () => {
    const parallel = evaluation.records.filter((record) => (
      record.armId === WORKER_TREATMENT_ARM && record.taskKind === "parallel"
    ));

    expect(parallel).toHaveLength(WORKER_EVAL_MANIFEST.repetitions);
    for (const record of parallel) {
      expect(record.outcome.completed).toBe(true);
      expect(record.outcome.graph).toMatchObject({
        taskCount: 3,
        joined: 3,
        stale: 0,
        partial: 1,
        failed: 1,
        anomalyCount: 0,
      });
      expect(record.outcome.graph.maximumFanIn).toBeGreaterThanOrEqual(2);
    }
  });

  it("proves Main and Worker overlap while the Worker lane stays serial", () => {
    const parallel = evaluation.records.filter((record) => (
      record.armId === WORKER_TREATMENT_ARM && record.taskKind === "parallel"
    ));

    for (const record of parallel) {
      expect(record.outcome.concurrency).toMatchObject({
        overlapped: true,
        peakAllLanesConcurrency: 2,
        peakWorkerConcurrency: 1,
      });
      expect(record.outcome.concurrency.overlapMs).toBeGreaterThan(0);
      const workerIntervals = record.outcome.concurrency.intervals
        .filter((interval) => interval.laneId === "worker")
        .sort((left, right) => Number(BigInt(left.startedNs) - BigInt(right.startedNs)));
      expect(workerIntervals).toHaveLength(3);
      for (let index = 1; index < workerIntervals.length; index += 1) {
        expect(BigInt(workerIntervals[index - 1]!.endedNs)).toBeLessThanOrEqual(
          BigInt(workerIntervals[index]!.startedNs),
        );
      }
    }
  });

  it("does not delegate the non-parallel sentinel", () => {
    const sentinel = evaluation.records.filter((record) => (
      record.armId === WORKER_TREATMENT_ARM && record.taskKind === "sentinel"
    ));

    expect(sentinel).toHaveLength(WORKER_EVAL_MANIFEST.repetitions);
    for (const record of sentinel) {
      expect(record.outcome).toMatchObject({
        completed: true,
        workerUsed: false,
        workerRequestCount: 0,
        graph: { taskCount: 0, joined: 0, anomalyCount: 0 },
      });
    }
  });

  it("records bounded backpressure as two queued and one rejected", () => {
    expect(evaluation.report.mechanism.backpressure).toEqual({
      capacity: 2,
      attempted: 3,
      queued: 2,
      rejected: 1,
      maximumQueueDepth: 2,
    });
  });

  it("verifies persisted evidence and rejects digest tampering", async () => {
    const artifactDirectory = evaluation.artifactDirectory!;
    await expect(verifyWorkerArtifacts(artifactDirectory)).resolves.toMatchObject({
      evidenceDigest: evaluation.evidenceDigest,
      recordCount: WORKER_EVAL_MANIFEST.sampleCount * WORKER_EVAL_MANIFEST.arms.length,
      sampleCount: WORKER_EVAL_MANIFEST.sampleCount,
      decision: { status: "pass", eligible: true },
    });

    const checkpointPath = join(artifactDirectory, "raw", "records.json");
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as {
      records: Array<{ finalText: string }>;
    };
    checkpoint.records[0]!.finalText += " tampered";
    await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");

    await expect(verifyWorkerArtifacts(artifactDirectory)).rejects.toThrow(/digest/);
  });
});
