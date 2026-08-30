import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AppendEvent } from "../../src/domain/events.js";
import type { Clock } from "../../src/domain/index.js";
import { JsonlLedger } from "../../src/ledger/index.js";
import {
  DaemonHost,
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
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

const roots: string[] = [];
const ledgers: JsonlLedger[] = [];

afterEach(async () => {
  await Promise.all(ledgers.splice(0).map((ledger) => ledger.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function identity(lease: ExecutionLease): ExecutionLeaseIdentity {
  return {
    runId: lease.runId,
    ownerId: lease.ownerId,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
  };
}

function event(id: string): AppendEvent<"step.started"> {
  return {
    runId: "run-fenced",
    laneId: "main",
    type: "step.started",
    payload: { step: 1 },
    correlationId: `commit:${id}`,
    idempotencyKey: `commit:${id}`,
    occurredAt: "2026-08-30T00:00:00.000Z",
  };
}

describe("file-backed daemon Ledger fencing", () => {
  it("blocks a successor claim until a commit-first Ledger append leaves the lease fence", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-daemon-ledger-fence-"));
    roots.push(root);
    const clock = new MutableClock(Date.parse("2026-08-30T00:00:00.000Z"));
    const leasePath = join(root, "execution-leases.json");
    const incumbentStore = await FileExecutionLeaseStore.open(leasePath, {
      clock,
      createLeaseId: () => "lease-incumbent",
    });
    const successorStore = await FileExecutionLeaseStore.open(leasePath, {
      clock,
      createLeaseId: () => "lease-successor",
    });
    const ledger = await JsonlLedger.open(join(root, "ledger.jsonl"), {
      createEventId: () => "event-incumbent",
    });
    ledgers.push(ledger);

    const acquired = await incumbentStore.claim({
      runId: "run-fenced",
      ownerId: "incumbent",
      acquisitionId: "claim-incumbent",
      ttlMs: 100,
    });
    if (acquired.status !== "acquired") throw new Error("expected incumbent lease");

    const appendFinished = deferred();
    const leaveCommit = deferred();
    const committing = incumbentStore.runIfCurrent(identity(acquired.lease), async () => {
      const appended = await ledger.append(event("incumbent"));
      appendFinished.resolve();
      await leaveCommit.promise;
      return appended.eventId;
    });
    await appendFinished.promise;

    clock.advance(100);
    let successorSettled = false;
    const claiming = successorStore.claim({
      runId: "run-fenced",
      ownerId: "successor",
      acquisitionId: "claim-successor",
      ttlMs: 100,
    }).then((result) => {
      successorSettled = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(successorSettled).toBe(false);
    leaveCommit.resolve();
    await expect(committing).resolves.toEqual({
      status: "committed",
      value: "event-incumbent",
    });
    const successor = await claiming;
    expect(successor.status).toBe("acquired");
    if (successor.status !== "acquired") throw new Error("expected successor lease");
    expect(successor.lease.fencingToken).toBe(2);
    await expect(ledger.read({ runId: "run-fenced" })).resolves.toHaveLength(1);
  });

  it("rejects a stale Ledger append when the successor claim wins first", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-daemon-ledger-fence-"));
    roots.push(root);
    const clock = new MutableClock(Date.parse("2026-08-30T00:00:00.000Z"));
    const leasePath = join(root, "execution-leases.json");
    const incumbentStore = await FileExecutionLeaseStore.open(leasePath, {
      clock,
      createLeaseId: () => "lease-incumbent",
    });
    const successorStore = await FileExecutionLeaseStore.open(leasePath, {
      clock,
      createLeaseId: () => "lease-successor",
    });
    const ledger = await JsonlLedger.open(join(root, "ledger.jsonl"));
    ledgers.push(ledger);

    const acquired = await incumbentStore.claim({
      runId: "run-fenced",
      ownerId: "incumbent",
      acquisitionId: "claim-incumbent",
      ttlMs: 100,
    });
    if (acquired.status !== "acquired") throw new Error("expected incumbent lease");
    clock.advance(100);
    const successor = await successorStore.claim({
      runId: "run-fenced",
      ownerId: "successor",
      acquisitionId: "claim-successor",
      ttlMs: 100,
    });
    expect(successor.status).toBe("acquired");

    let staleAppendRan = false;
    await expect(incumbentStore.runIfCurrent(identity(acquired.lease), async () => {
      staleAppendRan = true;
      return ledger.append(event("stale"));
    })).resolves.toEqual({ status: "lost" });
    expect(staleAppendRan).toBe(false);
    await expect(ledger.read({ runId: "run-fenced" })).resolves.toEqual([]);
  });

  it("keeps Host successor claims behind its atomic commitLease boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-daemon-host-fence-"));
    roots.push(root);
    const clock = new MutableClock(Date.parse("2026-08-30T00:00:00.000Z"));
    const leasePath = join(root, "execution-leases.json");
    const firstStore = await FileExecutionLeaseStore.open(leasePath, {
      clock,
      createLeaseId: () => "lease-first",
    });
    const secondStore = await FileExecutionLeaseStore.open(leasePath, {
      clock,
      createLeaseId: () => "lease-second",
    });
    const ledger = await JsonlLedger.open(join(root, "ledger.jsonl"), {
      createEventId: () => "event-host-commit",
    });
    ledgers.push(ledger);

    const appendFinished = deferred();
    const releaseCommit = deferred();
    let secondActivations = 0;
    const secondEvents: Array<{ type: string }> = [];
    const first = new DaemonHost({
      ownerId: "host-first",
      leaseStore: firstStore,
      clock,
      leaseTtlMs: 5_000,
      admitWake: async (request) => ({
        status: "admitted",
        inputId: request.inputId ?? request.wakeId ?? "input-first",
      }),
      activate: async ({ commitLease }) => {
        if (typeof commitLease !== "function") throw new Error("missing commitLease");
        await commitLease(async () => {
          await ledger.append(event("host-first"));
          appendFinished.resolve();
          await releaseCommit.promise;
        });
      },
    });
    const second = new DaemonHost({
      ownerId: "host-second",
      leaseStore: secondStore,
      clock,
      leaseTtlMs: 5_000,
      admitWake: async (request) => ({
        status: "admitted",
        inputId: request.inputId ?? request.wakeId ?? "input-second",
      }),
      activate: async () => {
        secondActivations += 1;
      },
    });
    second.subscribe((hostEvent) => {
      secondEvents.push(hostEvent);
    });
    await first.start();
    await second.start();
    await first.wake({ runId: "run-fenced", source: "system", dedupeKey: "first" });
    await appendFinished.promise;
    // Let the successor become eligible while the incumbent is still inside
    // the atomic commit. Its claim must wait for that commit lock, then win
    // the expired lease with the next fencing token.
    clock.advance(5_000);
    await second.wake({ runId: "run-fenced", source: "system", dedupeKey: "second" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(secondActivations).toBe(0);
    releaseCommit.resolve();
    await first.waitForIdle();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await second.waitForIdle();
    expect(secondEvents.some((hostEvent) => hostEvent.type === "activation.started")).toBe(true);
    expect(secondActivations).toBe(1);
    await expect(ledger.read({ runId: "run-fenced" })).resolves.toHaveLength(1);
    await first.stop();
    await second.stop();
  });
});
