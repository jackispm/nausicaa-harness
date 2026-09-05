import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ArtifactRef, RunPolicy } from "../../src/domain/index.js";
import { JsonlLedger } from "../../src/ledger/index.js";
import { openDaemonRuntime } from "../../src/runtime/index.js";

const roots: string[] = [];

const policy: RunPolicy = {
  maxMainStepsPerActivation: 4,
  maxModelTokens: 20_000,
  tetoEnabled: false,
  tetoMaxOutputTokens: 64,
  tetoTokenRatio: 0.1,
};

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function messageRef(id: string): ArtifactRef {
  const contentHash = `sha256:${id.padEnd(64, "0")}`;
  return { id, contentHash, mediaType: "text/plain", byteLength: id.length };
}

async function createPendingRun(
  dataDir: string,
  runId: string,
  workspace: string,
): Promise<void> {
  const runDir = join(dataDir, "runs", runId);
  await mkdir(runDir, { recursive: true });
  const ledger = await JsonlLedger.open(join(runDir, "ledger.jsonl"));
  await ledger.append({
    runId,
    laneId: "main",
    type: "run.created",
    payload: {
      goal: { version: 1, statement: `Inspect ${runId}`, successCriteria: [], hardConstraints: [] },
      workspace,
      policy,
    },
    correlationId: `run:${runId}`,
    idempotencyKey: "run:created",
    visibility: "run",
  });
  await ledger.append({
    runId,
    laneId: "main",
    type: "input.admitted",
    payload: {
      inputId: `${runId}:input`,
      messageRef: messageRef(`${runId}:message`),
      delivery: "new-turn",
      sequence: 1,
    },
    correlationId: `run:${runId}`,
    idempotencyKey: "input:admitted",
    visibility: "user",
  });
  await ledger.close();
}

function sessionOptions(workspace: string, dataDir: string) {
  return { workspace, dataDir, model: "scripted", policy };
}

describe("daemon live reconciliation", () => {
  it("discovers a Run created after startup and does not duplicate an active activation", async () => {
    vi.useFakeTimers();
    const workspace = await mkdtemp(join(tmpdir(), "nausicaa-reconcile-workspace-"));
    const dataDir = await mkdtemp(join(tmpdir(), "nausicaa-reconcile-state-"));
    roots.push(workspace, dataDir);
    const started = deferred();
    const release = deferred();
    let activations = 0;
    const runtime = await openDaemonRuntime({
      host: { ownerId: "reconcile-discovery" },
      session: sessionOptions(workspace, dataDir),
      reconciliation: { intervalMs: 10 },
      createSession: async () => ({
        resumeCurrent: async () => {
          activations += 1;
          started.resolve();
          await release.promise;
        },
        waitForIdle: async () => undefined,
        cancel: async () => undefined,
        close: async () => undefined,
      }),
    });

    await runtime.start();
    await createPendingRun(dataDir, "late-run", workspace);
    await vi.advanceTimersByTimeAsync(10);
    await started.promise;
    await vi.advanceTimersByTimeAsync(100);
    expect(activations).toBe(1);

    release.resolve();
    await runtime.host.waitForIdle();
    await runtime.stop();
  });

  it("treats an interactive Ledger writer as busy and never preempts it", async () => {
    vi.useFakeTimers();
    const workspace = await mkdtemp(join(tmpdir(), "nausicaa-reconcile-owner-workspace-"));
    const dataDir = await mkdtemp(join(tmpdir(), "nausicaa-reconcile-owner-state-"));
    roots.push(workspace, dataDir);
    await createPendingRun(dataDir, "interactive-run", workspace);
    const ledgerPath = join(dataDir, "runs", "interactive-run", "ledger.jsonl");
    const interactiveLedger = await JsonlLedger.open(ledgerPath);
    const firstResult = deferred<string>();
    const activationStarted = deferred();
    const release = deferred();
    let activations = 0;
    const runtime = await openDaemonRuntime({
      host: { ownerId: "reconcile-owner" },
      session: sessionOptions(workspace, dataDir),
      reconciliation: {
        intervalMs: 10,
        onResult: (result) => {
          const kind = result.failures.find((failure) => failure.runId === "interactive-run")?.kind;
          if (kind !== undefined) firstResult.resolve(kind);
        },
      },
      createSession: async () => ({
        resumeCurrent: async () => {
          activations += 1;
          activationStarted.resolve();
          await release.promise;
        },
        waitForIdle: async () => undefined,
        cancel: async () => undefined,
        close: async () => undefined,
      }),
    });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(10);
    await expect(firstResult.promise).resolves.toBe("busy");
    expect(activations).toBe(0);

    await interactiveLedger.close();
    await vi.advanceTimersByTimeAsync(10);
    await activationStarted.promise;
    expect(activations).toBe(1);
    release.resolve();
    await runtime.host.waitForIdle();
    await runtime.stop();
  });

  it("keeps scans single-flight when a manual recovery overlaps a timer tick", async () => {
    vi.useFakeTimers();
    const workspace = await mkdtemp(join(tmpdir(), "nausicaa-reconcile-overlap-workspace-"));
    const dataDir = await mkdtemp(join(tmpdir(), "nausicaa-reconcile-overlap-state-"));
    roots.push(workspace, dataDir);
    await createPendingRun(dataDir, "overlap-run", workspace);
    const scanStarted = deferred();
    const releaseScan = deferred();
    let activeScans = 0;
    let maxActiveScans = 0;
    let openCalls = 0;
    const runtime = await openDaemonRuntime({
      host: { ownerId: "reconcile-overlap" },
      session: sessionOptions(workspace, dataDir),
      reconciliation: { intervalMs: 10 },
      openLedger: async (runId) => {
        openCalls += 1;
        activeScans += 1;
        maxActiveScans = Math.max(maxActiveScans, activeScans);
        if (openCalls === 1) {
          scanStarted.resolve();
          await releaseScan.promise;
        }
        try {
          return await JsonlLedger.open(join(dataDir, "runs", runId, "ledger.jsonl"));
        } finally {
          activeScans -= 1;
        }
      },
      createSession: async () => ({
        resumeCurrent: async () => undefined,
        waitForIdle: async () => undefined,
        cancel: async () => undefined,
        close: async () => undefined,
      }),
    });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(10);
    await scanStarted.promise;
    const manual = runtime.recoverPendingRuns();
    await vi.advanceTimersByTimeAsync(100);
    expect(maxActiveScans).toBe(1);
    releaseScan.resolve();
    await manual;
    await runtime.stop();
  });

  it("continues reconciling after one failed scan", async () => {
    vi.useFakeTimers();
    const workspace = await mkdtemp(join(tmpdir(), "nausicaa-reconcile-failure-workspace-"));
    const dataDir = await mkdtemp(join(tmpdir(), "nausicaa-reconcile-failure-state-"));
    roots.push(workspace, dataDir);
    await createPendingRun(dataDir, "retry-run", workspace);
    const results: number[] = [];
    const firstResult = deferred<number>();
    const started = deferred();
    const release = deferred();
    let firstOpen = true;
    const runtime = await openDaemonRuntime({
      host: { ownerId: "reconcile-failure" },
      session: sessionOptions(workspace, dataDir),
      reconciliation: {
        intervalMs: 10,
        onResult: (result) => {
          results.push(result.failures.length);
          if (results.length === 1) firstResult.resolve(result.failures.length);
        },
      },
      openLedger: async (runId) => {
        if (firstOpen) {
          firstOpen = false;
          throw new Error("transient discovery failure");
        }
        return JsonlLedger.open(join(dataDir, "runs", runId, "ledger.jsonl"));
      },
      createSession: async () => ({
        resumeCurrent: async () => {
          started.resolve();
          await release.promise;
        },
        waitForIdle: async () => undefined,
        cancel: async () => undefined,
        close: async () => undefined,
      }),
    });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(10);
    await firstResult.promise;
    expect(results).toEqual([1]);
    await vi.advanceTimersByTimeAsync(10);
    await started.promise;
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[1]).toBe(0);
    release.resolve();
    await runtime.host.waitForIdle();
    await runtime.stop();
  });

  it("waits for an active scan on stop and cancels future ticks", async () => {
    vi.useFakeTimers();
    const workspace = await mkdtemp(join(tmpdir(), "nausicaa-reconcile-stop-workspace-"));
    const dataDir = await mkdtemp(join(tmpdir(), "nausicaa-reconcile-stop-state-"));
    roots.push(workspace, dataDir);
    await createPendingRun(dataDir, "stopping-run", workspace);
    const scanStarted = deferred();
    const releaseScan = deferred();
    let openCalls = 0;
    const runtime = await openDaemonRuntime({
      host: { ownerId: "reconcile-stop" },
      session: sessionOptions(workspace, dataDir),
      reconciliation: { intervalMs: 10 },
      openLedger: async (runId) => {
        openCalls += 1;
        if (openCalls === 1) {
          scanStarted.resolve();
          await releaseScan.promise;
        }
        return JsonlLedger.open(join(dataDir, "runs", runId, "ledger.jsonl"));
      },
      createSession: async () => ({
        resumeCurrent: async () => undefined,
        waitForIdle: async () => undefined,
        cancel: async () => undefined,
        close: async () => undefined,
      }),
    });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(10);
    await scanStarted.promise;
    let stopped = false;
    const stopping = runtime.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseScan.resolve();
    await stopping;
    const callsAfterStop = openCalls;
    await vi.advanceTimersByTimeAsync(100);
    expect(openCalls).toBe(callsAfterStop);
  });
});
