import { describe, expect, it } from "vitest";

import type { ArtifactRef, RunPolicy } from "../../src/domain/types.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";
import {
  commitRunCheckpoint,
  recoverRun,
  resolvePendingToolOperation,
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

  it("refuses to resume a tool operation whose side-effect outcome is unknown", async () => {
    const ledger = new MemoryLedger();
    await append(ledger, "run.created", {
      goal: { version: 1, statement: "Inspect", successCriteria: [], hardConstraints: [] },
      workspace: "/workspace",
      policy,
    }, "created");
    await append(ledger, "step.started", { step: 1 }, "step-1");
    await append(ledger, "tool.requested", {
      operationId: "operation-unknown",
      toolCallId: "call-1",
      name: "external_write",
      argumentsRef: ref("arguments"),
    }, "tool-requested");
    await append(ledger, "step.failed", {
      step: 1,
      error: "Process exited before the result was recorded",
    }, "step-failed");
    const eventCount = (await ledger.read()).length;

    await expect(recoverRun(ledger, "run-1")).rejects.toThrow(
      /unknown outcomes: operation-unknown/,
    );
    expect((await ledger.read())).toHaveLength(eventCount);
  });

  it("settles one unknown operation as an operator-confirmed failure", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    await append(ledger, "run.created", {
      goal: { version: 1, statement: "Inspect", successCriteria: [], hardConstraints: [] },
      workspace: "/workspace",
      policy,
    }, "created");
    await append(ledger, "step.started", { step: 1 }, "step-1");
    await append(ledger, "tool.requested", {
      operationId: "operation-unknown",
      toolCallId: "call-1",
      name: "external_write",
      argumentsRef: ref("arguments"),
    }, "tool-requested");

    const beforeResolution = (await ledger.read()).length;
    await expect(resolvePendingToolOperation(
      ledger,
      store,
      "run-1",
      "operation-other",
    )).rejects.toThrow(/not pending/);
    expect(await ledger.read()).toHaveLength(beforeResolution);

    await resolvePendingToolOperation(
      ledger,
      store,
      "run-1",
      "operation-unknown",
      { clock: { now: () => new Date("2026-01-01T00:00:01.000Z") } },
    );

    const events = await ledger.read();
    const failed = events.find((event) => event.type === "tool.failed");
    expect(failed?.type).toBe("tool.failed");
    if (failed?.type !== "tool.failed") throw new Error("Missing synthetic tool.failed");
    expect(failed.payload).toMatchObject({
      operationId: "operation-unknown",
      toolCallId: "call-1",
      name: "external_write",
      error: "Operator resolved unknown tool outcome as failed",
    });
    const result = JSON.parse(new TextDecoder().decode(await store.get(failed.payload.resultRef)));
    expect(result).toMatchObject({
      role: "tool",
      toolCallId: "call-1",
      toolName: "external_write",
      isError: true,
    });
    const afterResolution = events.length;
    await expect(resolvePendingToolOperation(
      ledger,
      store,
      "run-1",
      "operation-unknown",
    )).resolves.toBeUndefined();
    expect(await ledger.read()).toHaveLength(afterResolution);
    await expect(recoverRun(ledger, "run-1")).resolves.toMatchObject({
      startStep: 2,
    });
  });

  it("accounts for completed model usage missing its budget charge", async () => {
    const ledger = new MemoryLedger();
    const charged = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 };
    const uncharged = {
      input: 20,
      output: 7,
      cacheRead: 3,
      cacheWrite: 2,
      costUsd: 0.01,
    };
    await append(ledger, "run.created", {
      goal: { version: 1, statement: "Inspect", successCriteria: [], hardConstraints: [] },
      workspace: "/workspace",
      policy,
    }, "created");
    await append(ledger, "step.started", { step: 1 }, "step-1-started");
    await append(ledger, "model.completed", {
      model: "scripted",
      responseRef: ref("answer-1"),
      stopReason: "toolUse",
      usage: charged,
    }, "model-1");
    await append(ledger, "budget.charged", {
      laneId: "main",
      usage: charged,
    }, "budget-1");
    await append(ledger, "step.completed", {
      step: 1,
      hasToolCalls: true,
    }, "step-1-completed");
    await append(ledger, "step.started", { step: 2 }, "step-2-started");
    await append(ledger, "model.completed", {
      model: "scripted",
      responseRef: ref("answer-2"),
      stopReason: "stop",
      usage: uncharged,
    }, "model-2");
    await append(ledger, "step.completed", {
      step: 2,
      hasToolCalls: false,
    }, "step-2-completed");

    const recovered = await recoverRun(ledger, "run-1");

    expect(recovered.priorUsage).toEqual({
      input: 30,
      output: 12,
      cacheRead: 5,
      cacheWrite: 3,
      costUsd: 0.01,
    });
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
