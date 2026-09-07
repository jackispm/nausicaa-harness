import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { EventPayloadMap, EventType } from "../../src/domain/events.js";
import { JsonlLedger, projectRun } from "../../src/ledger/index.js";
import { resolveRunPolicy } from "../../src/runtime/run-policy.js";
import { listWorkspaceRuns } from "../../src/runtime/session-controller.js";

const roots: string[] = [];
const ledgers: JsonlLedger[] = [];

afterEach(async () => {
  await Promise.all(ledgers.splice(0).map((ledger) => ledger.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace Main status", () => {
  it.each([
    { type: "turn.completed", payload: { turnId: "main-turn" }, expected: "ready" },
    { type: "turn.failed", payload: { turnId: "main-turn", error: "provider failed" }, expected: "failed" },
    { type: "turn.cancelled", payload: { turnId: "main-turn", reason: "cancelled", lastCommittedStep: 1 }, expected: "cancelled" },
    { type: "turn.waiting", payload: { turnId: "main-turn", reason: "approval", lastCommittedStep: 1, resumeRequires: "approval" }, expected: "waiting" },
    { type: "turn.interrupted", payload: { turnId: "main-turn", reason: "provider", retryable: true, lastCommittedStep: 1 }, expected: "interrupted" },
  ] as const)("keeps $expected after late auxiliary activity", async ({ type, payload, expected }) => {
    const fixture = await createFixture();
    await fixture.append("turn.started", { turnId: "main-turn", inputId: "input", ordinal: 1, boundary: boundary() }, "main", "main-turn");
    await fixture.append(type, payload, "main", "main-turn");
    for (const laneId of ["teto", "worker", "team:review:member"]) {
      await fixture.append("step.started", { step: 1 }, laneId);
      await fixture.append("step.completed", { step: 1, hasToolCalls: false }, laneId);
      await fixture.append("lane.status", { status: "dormant" }, laneId);
    }
    await fixture.append("turn.started", { turnId: "aux-turn", inputId: "aux-input", ordinal: 1, boundary: boundary() }, "team:review:member", "aux-turn");
    const events = await fixture.ledger.read({ runId: fixture.runId });
    expect(projectRun(events, fixture.runId).turns[`legacy:${fixture.runId}:0`]?.status).toBe("active");
    expect(await fixture.status()).toBe(expected);
    expect(await fixture.ledger.read({ runId: fixture.runId })).toEqual(events);
  });

  it("keeps a resumed Main turn active while Teto is dormant", async () => {
    const fixture = await createFixture();
    await fixture.append("turn.started", { turnId: "main-turn", inputId: "input", ordinal: 1, boundary: boundary() }, "main", "main-turn");
    await fixture.append("turn.waiting", { turnId: "main-turn", reason: "approval", lastCommittedStep: 1, resumeRequires: "approval" }, "main", "main-turn");
    await fixture.append("turn.resumed", { turnId: "main-turn", fromStep: 2, stepAllowance: 2 }, "main", "main-turn");
    await fixture.append("step.started", { step: 1 }, "teto");
    await fixture.append("lane.status", { status: "dormant" }, "teto");
    expect(await fixture.status()).toBe("active");
  });

  it("does not invent a Main turn from auxiliary-only legacy events", async () => {
    const fixture = await createFixture();
    await fixture.append("step.started", { step: 1 }, "teto");
    expect(await fixture.status()).toBe("ready");
  });

  it("preserves legacy Main activity and terminal Run status", async () => {
    const fixture = await createFixture();
    await fixture.append("step.started", { step: 1 });
    expect(await fixture.status()).toBe("active");
    await fixture.append("run.completed", {});
    await fixture.append("step.started", { step: 1 }, "teto");
    expect(await fixture.status()).toBe("completed");
  });
});

async function createFixture() {
  const workspace = await mkdtemp(join(tmpdir(), "nausicaa-main-status-"));
  roots.push(workspace);
  const dataDir = join(workspace, "state");
  const runId = "status-run";
  const ledger = await JsonlLedger.open(join(dataDir, "runs", runId, "ledger.jsonl"));
  ledgers.push(ledger);
  let sequence = 0;
  const append = <K extends EventType>(type: K, payload: EventPayloadMap[K], laneId = "main", turnId?: string) => ledger.append({
    runId, laneId, type, payload,
    ...(turnId === undefined ? {} : { turnId }),
    correlationId: "status-test", idempotencyKey: `status:${++sequence}`, visibility: "run",
  });
  await append("run.created", { workspace, policy: resolveRunPolicy() });
  await append("lane.registered", { kind: "main" });
  return {
    append, ledger, runId,
    status: async () => (await listWorkspaceRuns(dataDir, workspace)).find((run) => run.runId === runId)?.status,
  };
}

function boundary() {
  return {
    collaborationMode: "default" as const,
    capabilities: { allowWrite: true, allowShell: true, allowNetwork: true },
  };
}
