import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileDaemonWorkerRecoveryJournal,
  MemoryDaemonWorkerRecoveryJournal,
  type DaemonWorkerRecoveryRecordInput,
} from "../../src/runtime/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function record(status: DaemonWorkerRecoveryRecordInput["status"]): DaemonWorkerRecoveryRecordInput {
  return {
    runId: "run-1",
    workerId: "worker-1",
    activationId: "activation-1",
    commandId: "command-1",
    fingerprint: "sha256:fingerprint",
    status,
    occurredAt: "2026-09-03T00:00:00.000Z",
  };
}

describe("daemon worker recovery journal", () => {
  it("serializes concurrent memory appends with monotonic records", async () => {
    const journal = new MemoryDaemonWorkerRecoveryJournal();
    const records = await Promise.all([
      journal.append(record("accepted")),
      journal.append(record("started")),
      journal.append(record("uncertain")),
    ]);

    expect(records.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect((await journal.read()).map((item) => item.status)).toEqual([
      "accepted",
      "started",
      "uncertain",
    ]);
  });

  it("reopens a fsynced journal and truncates a trailing partial record", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-worker-journal-"));
    roots.push(root);
    const path = join(root, "worker-recovery.jsonl");
    const first = await FileDaemonWorkerRecoveryJournal.open(path);
    await first.append(record("accepted"));
    await first.append(record("started"));
    await first.close();

    await appendFile(path, '{"version":1,"sequence":3', "utf8");
    const reopened = await FileDaemonWorkerRecoveryJournal.open(path);
    await expect(reopened.read()).resolves.toHaveLength(2);
    await reopened.append(record("uncertain"));
    await reopened.close();

    const contents = await readFile(path, "utf8");
    expect(contents.trimEnd().split("\n")).toHaveLength(3);
    expect(JSON.parse(contents.trimEnd().split("\n").at(-1)!)).toMatchObject({
      sequence: 3,
      status: "uncertain",
    });
  });

  it("rejects an invalid transition before it can poison memory or file journals", async () => {
    const memory = new MemoryDaemonWorkerRecoveryJournal();
    await memory.append(record("accepted"));
    await memory.append(record("completed"));
    await expect(memory.append(record("uncertain"))).rejects.toThrow(/invalid status transition/u);
    await expect(memory.read()).resolves.toHaveLength(2);

    const root = await mkdtemp(join(tmpdir(), "nausicaa-worker-journal-live-transition-"));
    roots.push(root);
    const path = join(root, "worker-recovery.jsonl");
    const file = await FileDaemonWorkerRecoveryJournal.open(path);
    await file.append(record("accepted"));
    await file.append(record("completed"));
    await expect(file.append(record("uncertain"))).rejects.toThrow(/invalid status transition/u);
    await file.close();

    const reopened = await FileDaemonWorkerRecoveryJournal.open(path);
    await expect(reopened.read()).resolves.toHaveLength(2);
    await reopened.close();
  });

  it("rejects semantic corruption when opening a complete journal history", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-worker-journal-corrupt-history-"));
    roots.push(root);
    const path = join(root, "worker-recovery.jsonl");
    const accepted = {
      version: 1,
      sequence: 1,
      occurredAt: "2026-09-03T00:00:00.000Z",
      ...record("accepted"),
    };
    const started = {
      version: 1,
      sequence: 2,
      occurredAt: "2026-09-03T00:00:01.000Z",
      ...record("started"),
      fingerprint: "sha256:changed-fingerprint",
    };
    await appendFile(path, `${JSON.stringify(accepted)}\n${JSON.stringify(started)}\n`, "utf8");

    await expect(FileDaemonWorkerRecoveryJournal.open(path)).rejects.toThrow(
      /changed fingerprint/u,
    );
  });

  it("rejects a terminal status downgrade when opening a complete journal history", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-worker-journal-downgrade-"));
    roots.push(root);
    const path = join(root, "worker-recovery.jsonl");
    const accepted = {
      version: 1,
      sequence: 1,
      occurredAt: "2026-09-03T00:00:00.000Z",
      ...record("accepted"),
    };
    const completed = {
      version: 1,
      sequence: 2,
      occurredAt: "2026-09-03T00:00:01.000Z",
      ...record("completed"),
    };
    const failed = {
      version: 1,
      sequence: 3,
      occurredAt: "2026-09-03T00:00:02.000Z",
      ...record("failed"),
    };
    await appendFile(
      path,
      `${JSON.stringify(accepted)}\n${JSON.stringify(completed)}\n${JSON.stringify(failed)}\n`,
      "utf8",
    );

    await expect(FileDaemonWorkerRecoveryJournal.open(path)).rejects.toThrow(
      /invalid status transition/u,
    );
  });

  it("does not allow two file journal writers at once", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-worker-journal-lock-"));
    roots.push(root);
    const path = join(root, "worker-recovery.jsonl");
    const first = await FileDaemonWorkerRecoveryJournal.open(path);
    await expect(FileDaemonWorkerRecoveryJournal.open(path)).rejects.toThrow(/live writer/u);
    await first.close();
    const second = await FileDaemonWorkerRecoveryJournal.open(path);
    await second.close();
  });
});
