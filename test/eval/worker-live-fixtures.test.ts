import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  WORKER_LIVE_FIXTURE_CATALOG,
  WORKER_LIVE_FIXTURE_HASH,
  WORKER_LIVE_SCORER_HASH,
  createWorkerLiveFixture,
  type WorkerLiveToolTraceEntry,
} from "./worker-live-fixtures.js";
import { hashJson } from "./fingerprint.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Worker real-model fixture catalog", () => {
  it("freezes natural decomposable tasks and one indivisible sentinel", () => {
    expect(WORKER_LIVE_FIXTURE_CATALOG.map((fixture) => fixture.task.kind)).toEqual([
      "decomposable",
      "decomposable",
      "decomposable",
      "sentinel",
    ]);
    expect(WORKER_LIVE_FIXTURE_CATALOG.every((fixture) => fixture.task.oracle === "hidden"))
      .toBe(true);
    for (const fixture of WORKER_LIVE_FIXTURE_CATALOG) {
      const visibleInstruction = [
        fixture.message,
        fixture.goal.statement,
        ...fixture.goal.successCriteria,
        ...fixture.goal.hardConstraints,
      ].join(" ").toLowerCase();
      expect(visibleInstruction).not.toContain("delegate_task");
      expect(visibleInstruction).not.toMatch(/\bdelegate|\bworker\b/);
    }
    expect(Object.isFrozen(WORKER_LIVE_FIXTURE_CATALOG)).toBe(true);
    expect(Object.isFrozen(WORKER_LIVE_FIXTURE_CATALOG[0]?.hiddenOracle)).toBe(true);
    expect(WORKER_LIVE_FIXTURE_HASH).toBe(hashJson(WORKER_LIVE_FIXTURE_CATALOG));
    expect(WORKER_LIVE_FIXTURE_HASH)
      .toBe("sha256:9c76cb2f3d3355de4be966a15edad0869861756150b62a0b6d2e08a5b212e7b3");
    expect(WORKER_LIVE_SCORER_HASH).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(WORKER_LIVE_SCORER_HASH)
      .toBe("sha256:6a1ab4b74c462135bd487f64f37cdcb8a3225ca34c6a3a6f0ff042e301912f29");
  });

  it("scores answer concepts and cross-lane read evidence deterministically", async () => {
    const root = await temporaryRoot();
    const spec = WORKER_LIVE_FIXTURE_CATALOG[0]!;
    const fixture = await createWorkerLiveFixture(spec.task, root);
    const trace: WorkerLiveToolTraceEntry[] = [
      read("main", "services/api/runtime.md"),
      read("worker", "services/dashboard/runtime.md"),
      read("worker", "ops/release-policy.md"),
    ];
    const answer = "Node.js 22.19, evergreen browsers, npm, and npm run build:web are required. The report is local-only.";

    await expect(fixture.score(answer, trace)).resolves.toBe(1);
    await expect(fixture.score(answer, [])).resolves.toBeCloseTo(0.8, 12);
    await expect(fixture.score("Use kubectl for a production deploy.", trace)).resolves.toBe(0);
    await expect(fixture.score(
      `${answer} The release policy says do not include production deployment commands.`,
      trace,
    )).resolves.toBe(1);
    await expect(fixture.score(answer, trace)).resolves.toBe(1);

    const incident = await createWorkerLiveFixture(
      WORKER_LIVE_FIXTURE_CATALOG.find((candidate) => candidate.task.taskId === "incident-triage")!.task,
      root,
    );
    await expect(incident.score(
      "The payment service first failed at 09:14:03 because PAYMENT_REGION was missing; the gateway had an upstream timed out error. Restore the validated regional value and restart only the payment service; do not retry captured charges manually.",
      [
        read("main", "logs/gateway.log"),
        read("main", "logs/payment.log"),
        read("main", "config/payment.example"),
        read("main", "runbooks/checkout.md"),
      ],
    )).resolves.toBe(1);
  });

  it("invalidates evidence after any visible fixture mutation", async () => {
    const root = await temporaryRoot();
    const spec = WORKER_LIVE_FIXTURE_CATALOG.at(-1)!;
    const fixture = await createWorkerLiveFixture(spec.task, root);
    const answer = "Local run artifacts are retained for 30 days (policy/retention.md).";
    const trace = [read("main", "policy/retention.md")];

    await expect(fixture.score(answer, trace)).resolves.toBe(1);
    await writeFile(join(fixture.workspace, "policy/retention.md"), "Changed\n", "utf8");
    await expect(fixture.score(answer, trace)).resolves.toBe(0);
  });

  it("rejects task plans that do not exactly match the frozen catalog", async () => {
    const root = await temporaryRoot();
    const changed = structuredClone(WORKER_LIVE_FIXTURE_CATALOG[0]!.task);
    changed.expectedWorkerUse = false;
    await expect(createWorkerLiveFixture(changed, root)).rejects.toThrow(/No frozen/);
  });
});

function read(laneId: string, path: string): WorkerLiveToolTraceEntry {
  return { laneId, name: "read_file", arguments: { path }, isError: false };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nausicaa-worker-live-fixture-"));
  roots.push(root);
  return root;
}
