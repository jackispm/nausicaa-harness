import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  daemonCommandRecoveryFingerprint,
  FileDaemonCommandRecoveryJournal,
  MemoryDaemonCommandRecoveryJournal,
  projectDaemonCommandRecovery,
  type DaemonCommandRecoveryRecordInput,
} from "../../src/runtime/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function record(status: DaemonCommandRecoveryRecordInput["status"]): DaemonCommandRecoveryRecordInput {
  return {
    clientId: "client-1",
    commandId: "command-1",
    method: "start",
    fingerprint: daemonCommandRecoveryFingerprint("start", undefined),
    status,
    ...(status === "received"
      ? {}
      : { response: { ok: true, result: { status: "running" } } }),
    occurredAt: "2026-09-04T00:00:00.000Z",
  };
}

describe("daemon command recovery journal", () => {
  it("projects received, result and acknowledged states and rejects conflicts", async () => {
    const journal = new MemoryDaemonCommandRecoveryJournal();
    await journal.append(record("received"));
    await journal.append(record("result"));
    await journal.append(record("acknowledged"));

    const projected = projectDaemonCommandRecovery(await journal.read());
    expect(projected.get("client-1\u0000command-1")).toMatchObject({
      status: "acknowledged",
      response: { ok: true },
    });
    await expect(journal.append({
      ...record("result"),
      fingerprint: "sha256:other",
    })).rejects.toThrow(/transition/u);
  });

  it("reopens a fsynced journal and truncates a torn tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-command-journal-"));
    roots.push(root);
    const path = join(root, "command-recovery.jsonl");
    const first = await FileDaemonCommandRecoveryJournal.open(path);
    await first.append(record("received"));
    await first.close();

    await appendFile(path, '{"version":1,"sequence":2', "utf8");
    const reopened = await FileDaemonCommandRecoveryJournal.open(path);
    await expect(reopened.read()).resolves.toHaveLength(1);
    await reopened.append(record("result"));
    await reopened.close();

    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ sequence: 2, status: "result" });
  });
});
