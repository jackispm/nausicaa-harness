import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ArtifactRef, RunPolicy } from "../../src/domain/index.js";
import {
  DaemonRunDiscoveryError,
  discoverDaemonRuns,
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
});
