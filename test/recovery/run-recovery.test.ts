import { describe, expect, it } from "vitest";

import type { ArtifactRef, RunPolicy } from "../../src/domain/types.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import {
  commitRunCheckpoint,
  recoverRun,
  RunRecoveryError,
} from "../../src/runtime/recovery.js";

const policy: RunPolicy = {
  maxMainSteps: 20,
  maxModelTokens: 20_000,
  tetoEnabled: true,
  tetoMaxOutputTokens: 200,
  tetoTokenRatio: 0.1,
};

const ref = (id: string): ArtifactRef => ({
  id,
  contentHash: `sha256:${id.padEnd(64, "0")}`,
  mediaType: "application/json",
  byteLength: id.length,
});

const append = async (
  ledger: MemoryLedger,
  type: Parameters<MemoryLedger["append"]>[0]["type"],
  payload: Record<string, unknown>,
  key: string,
): Promise<void> => {
  await ledger.append({
    runId: "run-1",
    laneId: "main",
    type,
    payload,
    correlationId: "correlation-1",
    idempotencyKey: key,
  } as Parameters<MemoryLedger["append"]>[0]);
};

describe("Run recovery", () => {
  it("seals an interrupted Step and preserves its committed response", async () => {
    const ledger = new MemoryLedger();
    await append(ledger, "run.created", {
      goal: { version: 1, statement: "Inspect", successCriteria: [], hardConstraints: [] },
      workspace: "/workspace",
      policy,
    }, "created");
    await append(ledger, "user.message", { messageRef: ref("user") }, "user");
    await append(ledger, "step.started", { step: 1 }, "step-1");
    await append(ledger, "model.completed", {
      model: "scripted",
      responseRef: ref("answer"),
      stopReason: "toolUse",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    }, "model-1");

    const recovered = await recoverRun(ledger, "run-1");

    expect(recovered.startStep).toBe(2);
    expect(recovered.conversationRefs.map((item) => item.ref.id)).toEqual([
      "user",
      "answer",
    ]);
    expect(recovered.events.at(-1)).toMatchObject({
      type: "step.failed",
      payload: { step: 1 },
    });
    await expect(recoverRun(ledger, "run-1")).resolves.toMatchObject({ startStep: 2 });
  });

  it("verifies the latest committed projection checkpoint", async () => {
    const ledger = new MemoryLedger();
    await append(ledger, "run.created", {
      goal: { version: 1, statement: "Inspect", successCriteria: [], hardConstraints: [] },
      workspace: "/workspace",
      policy,
    }, "created");
    await commitRunCheckpoint(ledger, "run-1");
    await expect(recoverRun(ledger, "run-1")).resolves.toMatchObject({
      upperWatermark: 2,
      startStep: 1,
    });

    const events = await ledger.read();
    events[1]!.payload = { watermark: 1, checksum: "sha256:bad" };
    const corrupt = new MemoryLedger();
    await append(corrupt, "run.created", {
      goal: { version: 1, statement: "Inspect", successCriteria: [], hardConstraints: [] },
      workspace: "/workspace",
      policy,
    }, "created");
    await corrupt.append({
      runId: "run-1",
      laneId: "main",
      type: "checkpoint.committed",
      payload: { watermark: 1, checksum: "sha256:bad" },
      correlationId: "checkpoint",
      idempotencyKey: "bad-checkpoint",
    });
    await expect(recoverRun(corrupt, "run-1")).rejects.toBeInstanceOf(
      RunRecoveryError,
    );
  });
});
