import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ArtifactRef, RunPolicy } from "../../src/domain/index.js";
import {
  DaemonRunDiscoveryError,
  discoverDaemonRuns,
  openDaemonRuntime,
  recoverPendingDaemonRuns,
} from "../../src/runtime/index.js";
import { JsonlLedger } from "../../src/ledger/index.js";

const roots: string[] = [];

const policy: RunPolicy = {
  maxMainStepsPerActivation: 20,
  maxModelTokens: 20_000,
  tetoEnabled: true,
  tetoMaxOutputTokens: 200,
  tetoTokenRatio: 0.1,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function messageRef(id: string): ArtifactRef {
  const contentHash = `sha256:${id.padEnd(64, "0")}`;
  return {
    id,
    contentHash,
    mediaType: "text/plain",
    byteLength: id.length,
  };
}

async function createRun(
  dataDir: string,
  runId: string,
  pendingInput = false,
): Promise<string> {
  const runDir = join(dataDir, "runs", runId);
  await mkdir(runDir, { recursive: true });
  const ledgerPath = join(runDir, "ledger.jsonl");
  const ledger = await JsonlLedger.open(ledgerPath);
  await ledger.append({
    runId,
    laneId: "main",
    type: "run.created",
    payload: {
      goal: { version: 1, statement: `Inspect ${runId}`, successCriteria: [], hardConstraints: [] },
      workspace: "/workspace",
      policy,
    },
    correlationId: `run:${runId}`,
    idempotencyKey: "run-created",
    visibility: "run",
  });
  if (pendingInput) {
    await ledger.append({
      runId,
      laneId: "main",
      type: "input.admitted",
      payload: {
        inputId: `${runId}-input`,
        messageRef: messageRef(`${runId}-message`),
        delivery: "new-turn",
        sequence: 1,
      },
      correlationId: `run:${runId}`,
      idempotencyKey: `${runId}:input:admitted`,
      visibility: "run",
    });
  }
  await ledger.close();
  return ledgerPath;
}

async function createActiveTurn(dataDir: string, runId: string): Promise<string> {
  const ledgerPath = await createRun(dataDir, runId);
  const ledger = await JsonlLedger.open(ledgerPath);
  const inputId = `${runId}-active-input`;
  const turnId = `${runId}-active-turn`;
  await ledger.append({
    runId,
    laneId: "main",
    type: "input.admitted",
    payload: {
      inputId,
      messageRef: messageRef(`${runId}-active-message`),
      delivery: "new-turn",
      sequence: 1,
    },
    correlationId: `input:${inputId}`,
    idempotencyKey: `${runId}:input:${inputId}:admitted`,
    visibility: "user",
  });
  await ledger.append({
    runId,
    turnId,
    laneId: "main",
    type: "input.delivered",
    payload: {
      inputId,
      turnId,
      boundary: "test-active-turn",
      expectedRevision: 1,
      expectedMessageRef: messageRef(`${runId}-active-message`),
    },
    correlationId: `turn:${turnId}`,
    idempotencyKey: `${runId}:input:${inputId}:delivered`,
    visibility: "run",
  });
  await ledger.append({
    runId,
    turnId,
    laneId: "main",
    type: "turn.started",
    payload: {
      turnId,
      inputId,
      ordinal: 1,
      boundary: {
        collaborationMode: "default",
        capabilities: { allowWrite: false, allowShell: false, allowNetwork: false },
      },
    },
    correlationId: `turn:${turnId}`,
    idempotencyKey: `${runId}:turn:${turnId}:started`,
    visibility: "run",
  });
  await ledger.close();
  return ledgerPath;
}

describe("daemon Run discovery and recovery", () => {
  it("discovers only regular, valid ledgers and isolates damaged siblings", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nausicaa-daemon-discovery-"));
    roots.push(dataDir);
    await createRun(dataDir, "run-b", true);
    await createRun(dataDir, "run-a", false);

    const brokenDir = join(dataDir, "runs", "broken");
    await mkdir(brokenDir, { recursive: true });
    await writeFile(join(brokenDir, "ledger.jsonl"), "not-json\n");
    await writeFile(join(dataDir, "runs", "README.txt"), "ignored\n");

    const external = await mkdtemp(join(tmpdir(), "nausicaa-daemon-external-"));
    roots.push(external);
    await symlink(external, join(dataDir, "runs", "linked"), "dir");

    const result = await discoverDaemonRuns({ dataDir });
    expect(result.runs.map((run) => run.runId)).toEqual(["run-a", "run-b"]);
    expect(result.runs.find((run) => run.runId === "run-a")).toMatchObject({
      pendingInputIds: [],
      lastOffset: 1,
    });
    expect(result.runs.find((run) => run.runId === "run-b")).toMatchObject({
      pendingInputIds: ["run-b-input"],
      lastOffset: 2,
    });
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: "broken", kind: "open-failed" }),
      expect.objectContaining({ runId: "linked", kind: "symlink" }),
    ]));

    const repeated = await discoverDaemonRuns({ dataDir });
    expect(repeated).toEqual(result);
  });

  it("bounds discovery and rejects a symlinked runs root", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nausicaa-daemon-discovery-bound-"));
    roots.push(dataDir);
    await createRun(dataDir, "run-1", true);
    await createRun(dataDir, "run-2", true);

    const limited = await discoverDaemonRuns({ dataDir, maxRuns: 1 });
    expect(limited.runs).toHaveLength(1);

    const malformed = join(dataDir, "runs", "00-malformed");
    await mkdir(malformed, { recursive: true });
    await writeFile(join(malformed, "ledger.jsonl"), "not-json\n");
    const inspectedLimit = await discoverDaemonRuns({ dataDir, maxRuns: 1 });
    expect(inspectedLimit.runs).toEqual([]);
    expect(inspectedLimit.failures).toEqual([
      expect.objectContaining({ runId: "00-malformed", kind: "open-failed" }),
    ]);

    const linkedRoot = await mkdtemp(join(tmpdir(), "nausicaa-daemon-discovery-root-"));
    roots.push(linkedRoot);
    const symlinkedDataDir = join(linkedRoot, "state");
    await mkdir(symlinkedDataDir, { recursive: true });
    await symlink(join(dataDir, "runs"), join(symlinkedDataDir, "runs"), "dir");
    await expect(discoverDaemonRuns({ dataDir: symlinkedDataDir })).rejects
      .toBeInstanceOf(DaemonRunDiscoveryError);
  });

  it("recovers pending Runs through the existing recovery projection idempotently", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nausicaa-daemon-recovery-"));
    roots.push(dataDir);
    const ledgerPath = await createRun(dataDir, "run-pending", true);
    await createRun(dataDir, "run-idle", false);

    const first = await recoverPendingDaemonRuns({ dataDir });
    expect(first.failures).toEqual([]);
    expect(first.runs).toHaveLength(1);
    expect(first.runs[0]).toMatchObject({
      runId: "run-pending",
      pendingInputIds: ["run-pending-input"],
      recovery: { runId: "run-pending" },
    });

    const before = await readFile(ledgerPath, "utf8");
    const second = await recoverPendingDaemonRuns({ dataDir });
    const after = await readFile(ledgerPath, "utf8");
    expect(second.runs).toHaveLength(1);
    expect(after).toBe(before);
  });

  it("discovers and requeues a delivered Turn interrupted by process exit", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nausicaa-daemon-active-turn-"));
    roots.push(dataDir);
    const ledgerPath = await createActiveTurn(dataDir, "run-active-turn");
    const activeLedger = await JsonlLedger.open(ledgerPath);
    await activeLedger.append({
      runId: "run-active-turn",
      turnId: "run-active-turn-active-turn",
      laneId: "main",
      type: "step.started",
      payload: { step: 1 },
      correlationId: "turn:run-active-turn-active-turn",
      idempotencyKey: "run-active-turn:step:1:started",
      visibility: "run",
    });
    const beforeRecovery = await activeLedger.read({ runId: "run-active-turn" });
    await activeLedger.close();

    const discovered = await discoverDaemonRuns({ dataDir });
    expect(discovered.failures).toEqual([]);
    expect(discovered.runs).toEqual([
      expect.objectContaining({
        runId: "run-active-turn",
        pendingInputIds: [],
        recoverableTurn: {
          turnId: "run-active-turn-active-turn",
          inputId: "run-active-turn-active-input",
          startedAtOffset: 4,
        },
      }),
    ]);

    const activations: Array<{ runId: string; wakeCount: number }> = [];
    const runtime = await openDaemonRuntime({
      host: { ownerId: "active-turn-recovery-host" },
      session: {
        workspace: "/workspace",
        dataDir,
        model: "scripted",
        policy,
      },
      createSession: async () => ({
        resumeCurrent: async () => undefined,
        waitForIdle: async () => undefined,
        cancel: async () => undefined,
        close: async () => undefined,
      }),
    });
    const unsubscribe = runtime.host.subscribe((event) => {
      if (event.type === "activation.started") {
        activations.push({
          runId: event.runId,
          wakeCount: event.wakeCount,
        });
      }
    });

    await runtime.start();
    const recovered = await runtime.recoverPendingRuns();
    await runtime.host.waitForIdle();

    expect(recovered.queuedRunIds).toEqual(["run-active-turn"]);
    expect(recovered.runs[0]?.recoverableTurn).toMatchObject({
      turnId: "run-active-turn-active-turn",
      inputId: "run-active-turn-active-input",
    });
    expect(activations).toEqual([{
      runId: "run-active-turn",
      wakeCount: 1,
    }]);
    const afterLedger = await JsonlLedger.open(ledgerPath);
    expect(await afterLedger.read({ runId: "run-active-turn" })).toEqual(beforeRecovery);
    await afterLedger.close();
    unsubscribe();
    await runtime.stop();
  });

  it("does not auto-requeue an active Turn with an unknown tool outcome", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nausicaa-daemon-unknown-tool-"));
    roots.push(dataDir);
    const runId = "run-unknown-tool";
    const ledgerPath = await createActiveTurn(dataDir, runId);
    const ledger = await JsonlLedger.open(ledgerPath);
    await ledger.append({
      runId,
      turnId: `${runId}-active-turn`,
      laneId: "main",
      type: "tool.requested",
      payload: {
        operationId: "unknown-operation",
        toolCallId: "unknown-call",
        name: "write_file",
        argumentsRef: messageRef("unknown-arguments"),
      },
      correlationId: `turn:${runId}-active-turn`,
      idempotencyKey: `${runId}:tool:unknown-operation:requested`,
      visibility: "run",
    });
    await ledger.close();

    const recovered = await recoverPendingDaemonRuns({ dataDir });
    expect(recovered.runs).toEqual([]);
    expect(recovered.failures).toEqual([
      expect.objectContaining({
        runId,
        kind: "recovery-required",
        error: expect.stringContaining("unknown-operation"),
      }),
    ]);
  });

  it("queues already-admitted inputs when a composed daemon restarts", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nausicaa-daemon-runtime-recovery-"));
    roots.push(dataDir);
    await createRun(dataDir, "run-restart", true);
    const activations: string[] = [];
    let releaseActivation!: () => void;
    const activationGate = new Promise<void>((resolve) => { releaseActivation = resolve; });
    const runtime = await openDaemonRuntime({
      host: { ownerId: "restart-host" },
      session: {
        workspace: "/workspace",
        dataDir,
        model: "scripted",
        policy,
      },
      createSession: async () => ({
        resumeCurrent: async () => activationGate,
        waitForIdle: async () => undefined,
        cancel: async () => undefined,
        close: async () => undefined,
      }),
    });

    await runtime.start();
    const unsubscribe = runtime.host.subscribe((event) => {
      if (event.type === "activation.started") activations.push(event.runId);
    });
    const recovered = await runtime.recoverPendingRuns();
    expect(recovered.queuedRunIds).toEqual(["run-restart"]);
    expect(runtime.host.snapshot().runs).toMatchObject([{
      runId: "run-restart",
      state: "running",
    }]);

    releaseActivation();
    await runtime.host.waitForIdle();
    unsubscribe();
    expect(activations).toEqual(["run-restart"]);
    await runtime.stop();
  });

  it("does not enqueue the same pending input during an active recovery", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nausicaa-daemon-recovery-active-"));
    roots.push(dataDir);
    await createRun(dataDir, "run-active-recovery", true);
    let releaseActivation!: () => void;
    const activationGate = new Promise<void>((resolve) => { releaseActivation = resolve; });
    let resolveActivationStarted!: () => void;
    const activationStarted = new Promise<void>((resolve) => {
      resolveActivationStarted = resolve;
    });
    const activations: Array<{ runId: string; wakeCount: number }> = [];
    const runtime = await openDaemonRuntime({
      host: { ownerId: "active-recovery-host" },
      session: {
        workspace: "/workspace",
        dataDir,
        model: "scripted",
        policy,
      },
      createSession: async () => ({
        resumeCurrent: async () => activationGate,
        waitForIdle: async () => undefined,
        cancel: async () => undefined,
        close: async () => undefined,
      }),
    });

    const unsubscribe = runtime.host.subscribe((event) => {
      if (event.type === "activation.started") {
        activations.push({ runId: event.runId, wakeCount: event.wakeCount });
        resolveActivationStarted();
      }
    });
    await runtime.start();
    await runtime.recoverPendingRuns();
    await activationStarted;
    await runtime.recoverPendingRuns();
    releaseActivation();
    await runtime.host.waitForIdle();

    expect(activations).toEqual([{ runId: "run-active-recovery", wakeCount: 1 }]);
    unsubscribe();
    await runtime.stop();
  });
});
