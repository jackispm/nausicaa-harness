import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Clock } from "../../src/domain/index.js";
import {
  ExecutionLeaseStoreLockedError,
  FileExecutionLeaseStore,
  type ExecutionLease,
  type ExecutionLeaseIdentity,
} from "../../src/runtime/index.js";

class MutableClock implements Clock {
  constructor(private instantMs: number) {}

  now(): Date {
    return new Date(this.instantMs);
  }

  advance(milliseconds: number): void {
    this.instantMs += milliseconds;
  }

  set(milliseconds: number): void {
    this.instantMs = milliseconds;
  }
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function identity(lease: ExecutionLease): ExecutionLeaseIdentity {
  return {
    runId: lease.runId,
    ownerId: lease.ownerId,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
  };
}

async function openStore(
  root: string,
  clock: MutableClock,
  ids: string[],
): Promise<FileExecutionLeaseStore> {
  let index = 0;
  return FileExecutionLeaseStore.open(join(root, "leases.json"), {
    clock,
    createLeaseId: () => ids[index++] ?? `lease-${index}`,
  });
}

describe("FileExecutionLeaseStore", () => {
  it("persists active leases and idempotency receipts across reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-file-lease-"));
    roots.push(root);
    const clock = new MutableClock(Date.parse("2026-08-29T12:00:00.000Z"));
    const first = await openStore(root, clock, ["lease-1", "lease-2"]);
    const claimInput = {
      runId: "run-1",
      ownerId: "worker-1",
      acquisitionId: "acquire-1",
      ttlMs: 1_000,
    } as const;

    const acquired = await first.claim(claimInput);
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") throw new Error("expected acquisition");
    const lease = acquired.lease;
    const renewal = {
      ...identity(lease),
      commandId: "renew-1",
      ttlMs: 2_000,
    } as const;
    const renewed = await first.renew(renewal);
    expect(renewed.status).toBe("renewed");

    const reopened = await openStore(root, clock, ["unused-id"]);
    await expect(reopened.inspect("run-1")).resolves.toMatchObject({
      ownerId: "worker-1",
      fencingToken: 1,
      expiresAt: "2026-08-29T12:00:02.000Z",
    });
    await expect(reopened.claim(claimInput)).resolves.toEqual(acquired);
    await expect(reopened.renew(renewal)).resolves.toEqual(renewed);
    await expect(reopened.verify(identity(lease))).resolves.toBe(true);

    clock.advance(2_000);
    await expect(reopened.inspect("run-1")).resolves.toBeUndefined();
    const successor = await reopened.claim({
      ...claimInput,
      ownerId: "worker-2",
      acquisitionId: "acquire-2",
    });
    expect(successor.status).toBe("acquired");
    if (successor.status !== "acquired") throw new Error("expected successor acquisition");
    expect(successor.lease.fencingToken).toBe(2);
  });

  it("keeps fencing high watermarks and release receipts after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-file-lease-"));
    roots.push(root);
    const clock = new MutableClock(10_000);
    const first = await openStore(root, clock, ["lease-1", "lease-2"]);
    const acquired = await first.claim({
      runId: "run-1",
      ownerId: "worker-1",
      acquisitionId: "acquire-1",
      ttlMs: 100,
    });
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") throw new Error("expected acquisition");
    const release = {
      ...identity(acquired.lease),
      commandId: "release-1",
    } as const;
    await expect(first.release(release)).resolves.toEqual({ status: "released" });

    const reopened = await openStore(root, clock, ["lease-2"]);
    await expect(reopened.release(release)).resolves.toEqual({ status: "released" });
    const successor = await reopened.claim({
      runId: "run-1",
      ownerId: "worker-2",
      acquisitionId: "acquire-2",
      ttlMs: 100,
    });
    expect(successor.status).toBe("acquired");
    if (successor.status !== "acquired") throw new Error("expected successor acquisition");
    expect(successor.lease.leaseId).toBe("lease-2");
    expect(successor.lease.fencingToken).toBe(2);
  });

  it("persists the per-Run clock high watermark and rejects rollback after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-file-lease-"));
    roots.push(root);
    const clock = new MutableClock(10_000);
    const first = await openStore(root, clock, ["lease-1", "lease-2"]);
    const lease = await first.claim({
      runId: "run-1",
      ownerId: "worker-1",
      acquisitionId: "acquire-1",
      ttlMs: 1_000,
    });
    expect(lease.status).toBe("acquired");
    if (lease.status !== "acquired") throw new Error("expected acquisition");
    clock.advance(100);
    await expect(first.verify(identity(lease.lease))).resolves.toBe(true);

    const reopened = await openStore(root, clock, ["lease-2"]);
    clock.set(10_050);
    await expect(reopened.renew({
      ...identity(lease.lease),
      commandId: "renew-regressed",
      ttlMs: 1_000,
    })).resolves.toMatchObject({
      status: "clock-regressed",
      lease: lease.lease,
    });
    clock.set(11_100);
    const successor = await reopened.claim({
      runId: "run-1",
      ownerId: "worker-2",
      acquisitionId: "acquire-2",
      ttlMs: 100,
    });
    expect(successor.status).toBe("acquired");
    if (successor.status !== "acquired") throw new Error("expected successor acquisition");
    expect(successor.lease.fencingToken).toBe(2);
  });

  it("rejects a live lock and removes a lock held by a dead process", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-file-lease-"));
    roots.push(root);
    const clock = new MutableClock(10_000);
    const store = await openStore(root, clock, ["lease-live", "lease-stale"]);
    const lockPath = `${store.path}.lock`;
    const lockOwner = (pid: number, token: string): string => JSON.stringify({
      version: 1,
      pid,
      hostname: hostname(),
      token,
    });

    await writeFile(lockPath, `${lockOwner(process.pid, "live")}\n`, { mode: 0o600 });
    await expect(store.claim({
      runId: "run-live-lock",
      ownerId: "worker-1",
      acquisitionId: "acquire-live-lock",
      ttlMs: 100,
    })).rejects.toBeInstanceOf(ExecutionLeaseStoreLockedError);
    await unlink(lockPath);

    await writeFile(lockPath, `${lockOwner(9_999_999, "stale")}\n`, { mode: 0o600 });
    const acquired = await store.claim({
      runId: "run-stale-lock",
      ownerId: "worker-1",
      acquisitionId: "acquire-stale-lock",
      ttlMs: 100,
    });
    expect(acquired.status).toBe("acquired");
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("linearizes claims from two independently opened stores", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-file-lease-"));
    roots.push(root);
    const clock = new MutableClock(10_000);
    const left = await openStore(root, clock, ["left-lease"]);
    const right = await openStore(root, clock, ["right-lease"]);
    const [first, second] = await Promise.all([
      left.claim({
        runId: "run-1",
        ownerId: "left",
        acquisitionId: "left-acquire",
        ttlMs: 100,
      }),
      right.claim({
        runId: "run-1",
        ownerId: "right",
        acquisitionId: "right-acquire",
        ttlMs: 100,
      }),
    ]);
    expect([first.status, second.status].sort()).toEqual(["acquired", "held"]);
    const winner = first.status === "acquired" ? first : second;
    if (winner.status !== "acquired") throw new Error("expected one winning claim");
    expect((await left.inspect("run-1"))?.ownerId).toBe(winner.lease.ownerId);
    expect((await right.inspect("run-1"))?.fencingToken).toBe(1);
  });

  it("runs a durable commit only for the current file-backed fence", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-file-lease-"));
    roots.push(root);
    const clock = new MutableClock(10_000);
    const store = await openStore(root, clock, ["lease-1", "lease-2"]);
    const acquired = await store.claim({
      runId: "run-1",
      ownerId: "worker-1",
      acquisitionId: "acquire-1",
      ttlMs: 100,
    });
    if (acquired.status !== "acquired") throw new Error("expected acquisition");
    await expect(store.runIfCurrent(identity(acquired.lease), async () => "written"))
      .resolves.toEqual({ status: "committed", value: "written" });

    clock.advance(100);
    const successor = await store.claim({
      runId: "run-1",
      ownerId: "worker-2",
      acquisitionId: "acquire-2",
      ttlMs: 100,
    });
    expect(successor.status).toBe("acquired");
    let staleOperationRan = false;
    await expect(store.runIfCurrent(identity(acquired.lease), async () => {
      staleOperationRan = true;
    })).resolves.toEqual({ status: "lost" });
    expect(staleOperationRan).toBe(false);
  });
});
