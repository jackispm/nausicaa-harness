import { describe, expect, it } from "vitest";

import type { Clock } from "../../src/domain/index.js";
import {
  ExecutionLeaseProtocolError,
  type ExecutionLease,
  type ExecutionLeaseIdentity,
  MAX_EXECUTION_LEASE_TTL_MS,
  MemoryExecutionLeaseStore,
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

function leaseIds(...ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? `lease-${index}`;
}

function identity(lease: ExecutionLease): ExecutionLeaseIdentity {
  return {
    runId: lease.runId,
    ownerId: lease.ownerId,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
  };
}

async function acquire(
  store: MemoryExecutionLeaseStore,
  overrides: Partial<{
    runId: string;
    ownerId: string;
    acquisitionId: string;
    ttlMs: number;
  }> = {},
): Promise<ExecutionLease> {
  const result = await store.claim({
    runId: "run-1",
    ownerId: "worker-1",
    acquisitionId: "acquire-1",
    ttlMs: 100,
    ...overrides,
  });
  if (result.status !== "acquired") {
    throw new Error(`expected acquisition, received ${result.status}`);
  }
  return result.lease;
}

describe("ExecutionLeaseStore protocol", () => {
  it("claims a Run lease with immutable identity and timestamp snapshots", async () => {
    const clock = new MutableClock(Date.parse("2026-08-28T12:00:00.000Z"));
    const store = new MemoryExecutionLeaseStore({
      clock,
      createLeaseId: leaseIds("lease-1"),
    });

    const result = await store.claim({
      runId: "run-1",
      ownerId: "worker-1",
      acquisitionId: "acquire-1",
      ttlMs: 1_000,
    });

    expect(result).toEqual({
      status: "acquired",
      lease: {
        runId: "run-1",
        ownerId: "worker-1",
        acquisitionId: "acquire-1",
        leaseId: "lease-1",
        fencingToken: 1,
        acquiredAt: "2026-08-28T12:00:00.000Z",
        renewedAt: "2026-08-28T12:00:00.000Z",
        expiresAt: "2026-08-28T12:00:01.000Z",
      },
    });
    if (result.status !== "acquired") throw new Error("expected acquisition");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.lease)).toBe(true);
    expect(() => {
      (result.lease as { ownerId: string }).ownerId = "intruder";
    }).toThrow(TypeError);

    const inspected = await store.inspect("run-1");
    expect(inspected).toEqual({
      runId: "run-1",
      ownerId: "worker-1",
      fencingToken: 1,
      acquiredAt: "2026-08-28T12:00:00.000Z",
      renewedAt: "2026-08-28T12:00:00.000Z",
      expiresAt: "2026-08-28T12:00:01.000Z",
    });
    expect(inspected).not.toBe(result.lease);
    expect(Object.isFrozen(inspected)).toBe(true);
    expect(inspected).not.toHaveProperty("leaseId");
    expect(inspected).not.toHaveProperty("acquisitionId");
    await expect(store.verify(identity(result.lease))).resolves.toBe(true);
  });

  it("makes one acquisition retry idempotent without allocating another fence", async () => {
    const store = new MemoryExecutionLeaseStore({
      clock: new MutableClock(1_000),
      createLeaseId: leaseIds("lease-1", "lease-2"),
    });
    const input = {
      runId: "run-1",
      ownerId: "worker-1",
      acquisitionId: "same-attempt",
      ttlMs: 100,
    } as const;

    const first = await store.claim(input);
    const retry = await store.claim(input);
    expect(retry).toEqual(first);
    if (first.status !== "acquired" || retry.status !== "acquired") {
      throw new Error("expected idempotent acquisition");
    }
    expect(retry.lease.fencingToken).toBe(1);
    await expect(store.claim({ ...input, ownerId: "worker-2" })).rejects.toThrow(
      ExecutionLeaseProtocolError,
    );
    await expect(store.claim({ ...input, ttlMs: 101 })).rejects.toThrow(
      /reused with different input/,
    );
  });

  it("admits exactly one of concurrent acquisition attempts", async () => {
    const store = new MemoryExecutionLeaseStore({
      clock: new MutableClock(1_000),
      createLeaseId: leaseIds("winner"),
    });

    const [left, right] = await Promise.all([
      store.claim({ runId: "run-1", ownerId: "left", acquisitionId: "left-1", ttlMs: 100 }),
      store.claim({ runId: "run-1", ownerId: "right", acquisitionId: "right-1", ttlMs: 100 }),
    ]);

    expect([left.status, right.status].sort()).toEqual(["acquired", "held"]);
    let winner: ExecutionLease;
    if (left.status === "acquired" && right.status === "held") {
      winner = left.lease;
      expect(right.holder).toMatchObject({ ownerId: left.lease.ownerId });
      expect(right.holder).not.toHaveProperty("leaseId");
    } else if (right.status === "acquired" && left.status === "held") {
      winner = right.lease;
      expect(left.holder).toMatchObject({ ownerId: right.lease.ownerId });
      expect(left.holder).not.toHaveProperty("leaseId");
    } else {
      throw new Error("concurrent claims did not produce one acquired and one held result");
    }
    expect((await store.inspect("run-1"))?.ownerId).toBe(winner.ownerId);
  });

  it("keeps a blocked acquisition retry non-mutating after the holder expires", async () => {
    const clock = new MutableClock(1_000);
    const store = new MemoryExecutionLeaseStore({
      clock,
      createLeaseId: leaseIds("lease-1", "lease-2"),
    });
    await acquire(store);
    const blockedInput = {
      runId: "run-1",
      ownerId: "worker-2",
      acquisitionId: "blocked-1",
      ttlMs: 100,
    } as const;
    const blocked = await store.claim(blockedInput);
    expect(blocked.status).toBe("held");
    if (blocked.status !== "held") throw new Error("expected held lease");
    expect(Object.isFrozen(blocked.holder)).toBe(true);
    expect(blocked.holder).not.toHaveProperty("leaseId");

    clock.advance(100);
    await expect(store.claim(blockedInput)).resolves.toEqual(blocked);
    expect(await store.inspect("run-1")).toBeUndefined();

    const fresh = await store.claim({ ...blockedInput, acquisitionId: "blocked-2" });
    expect(fresh.status).toBe("acquired");
    if (fresh.status !== "acquired") throw new Error("expected fresh acquisition");
    expect(fresh.lease.fencingToken).toBe(2);
  });

  it("allows expiry takeover and fences every operation from the old owner", async () => {
    const clock = new MutableClock(1_000);
    const store = new MemoryExecutionLeaseStore({
      clock,
      createLeaseId: leaseIds("lease-old", "lease-new"),
    });
    const oldLease = await acquire(store);

    clock.advance(100);
    const takeover = await store.claim({
      runId: "run-1",
      ownerId: "worker-2",
      acquisitionId: "acquire-2",
      ttlMs: 100,
    });
    expect(takeover.status).toBe("acquired");
    if (takeover.status !== "acquired") throw new Error("expected takeover");
    expect(takeover.lease).toMatchObject({
      ownerId: "worker-2",
      leaseId: "lease-new",
      fencingToken: 2,
    });

    await expect(store.verify(identity(oldLease))).resolves.toBe(false);
    await expect(store.renew({
      ...identity(oldLease),
      commandId: "renew-old-after-takeover",
      ttlMs: 100,
    })).resolves.toEqual({
      status: "lost",
    });
    await expect(store.release({
      ...identity(oldLease),
      commandId: "release-old-after-takeover",
    })).resolves.toEqual({ status: "lost" });
    expect(await store.inspect("run-1")).toMatchObject({
      ownerId: takeover.lease.ownerId,
      fencingToken: takeover.lease.fencingToken,
    });
    expect(await store.inspect("run-1")).not.toHaveProperty("leaseId");
  });

  it("linearizes a fenced commit before expiry takeover", async () => {
    const clock = new MutableClock(1_000);
    const store = new MemoryExecutionLeaseStore({
      clock,
      createLeaseId: leaseIds("lease-old", "lease-new"),
    });
    const current = await acquire(store);
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    let commitStarted!: () => void;
    const started = new Promise<void>((resolve) => { commitStarted = resolve; });
    const committed = store.runIfCurrent(identity(current), async () => {
      commitStarted();
      await commitGate;
      return "durable";
    });
    await started;
    clock.advance(100);
    let takeoverSettled = false;
    const takeover = store.claim({
      runId: "run-1",
      ownerId: "worker-2",
      acquisitionId: "acquire-2",
      ttlMs: 100,
    }).then((result) => {
      takeoverSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(takeoverSettled).toBe(false);

    releaseCommit();
    await expect(committed).resolves.toEqual({ status: "committed", value: "durable" });
    await expect(takeover).resolves.toMatchObject({
      status: "acquired",
      lease: { fencingToken: 2 },
    });
    let staleOperationRan = false;
    await expect(store.runIfCurrent(identity(current), async () => {
      staleOperationRan = true;
    })).resolves.toEqual({ status: "lost" });
    expect(staleOperationRan).toBe(false);
  });

  it("never reacquires on a stale acquisition retry", async () => {
    const clock = new MutableClock(1_000);
    const store = new MemoryExecutionLeaseStore({
      clock,
      createLeaseId: leaseIds("lease-old", "lease-new"),
    });
    const oldLease = await acquire(store);
    clock.advance(100);

    const retry = await store.claim({
      runId: "run-1",
      ownerId: "worker-1",
      acquisitionId: "acquire-1",
      ttlMs: 100,
    });
    expect(retry).toEqual({ status: "stale" });
    expect(await store.inspect("run-1")).toBeUndefined();

    const fresh = await store.claim({
      runId: "run-1",
      ownerId: "worker-1",
      acquisitionId: "acquire-fresh",
      ttlMs: 100,
    });
    expect(fresh.status).toBe("acquired");
    if (fresh.status !== "acquired") throw new Error("expected fresh acquisition");
    expect(fresh.lease.fencingToken).toBe(2);
  });

  it("renews only the exact live identity", async () => {
    const clock = new MutableClock(1_000);
    const store = new MemoryExecutionLeaseStore({
      clock,
      createLeaseId: leaseIds("lease-1"),
    });
    const lease = await acquire(store);
    clock.advance(40);

    const renewed = await store.renew({
      ...identity(lease),
      commandId: "renew-1",
      ttlMs: 200,
    });
    expect(renewed.status).toBe("renewed");
    expect(renewed.status === "renewed" && renewed.lease).toMatchObject({
      acquiredAt: new Date(1_000).toISOString(),
      renewedAt: new Date(1_040).toISOString(),
      expiresAt: new Date(1_240).toISOString(),
    });
    clock.advance(50);
    await expect(store.renew({
      ...identity(lease),
      commandId: "renew-1",
      ttlMs: 200,
    })).resolves.toEqual(renewed);
    await expect(store.renew({
      ...identity(lease),
      commandId: "renew-1",
      ttlMs: 201,
    })).rejects.toThrow(/commandId .* reused with different input/);
    await expect(store.renew({
      ...identity(lease),
      ownerId: "worker-other",
      commandId: "renew-wrong-owner",
      ttlMs: 200,
    })).resolves.toEqual({ status: "lost" });
    await expect(store.verify({
      ...identity(lease),
      fencingToken: 2,
    })).resolves.toBe(false);
  });

  it("downgrades a successful renewal retry after expiry or takeover", async () => {
    const clock = new MutableClock(1_000);
    const store = new MemoryExecutionLeaseStore({
      clock,
      createLeaseId: leaseIds("lease-1", "lease-2"),
    });
    const lease = await acquire(store);
    const renewal = {
      ...identity(lease),
      commandId: "renew-1",
      ttlMs: 100,
    } as const;
    await expect(store.renew(renewal)).resolves.toMatchObject({ status: "renewed" });

    clock.advance(100);
    const successor = await store.claim({
      runId: "run-1",
      ownerId: "worker-2",
      acquisitionId: "acquire-2",
      ttlMs: 100,
    });
    expect(successor.status).toBe("acquired");
    await expect(store.renew(renewal)).resolves.toEqual({ status: "lost" });
    expect(await store.inspect("run-1")).toMatchObject({
      ownerId: "worker-2",
      fencingToken: 2,
    });
  });

  it("never shortens an existing lease with a smaller renewal TTL", async () => {
    const clock = new MutableClock(1_000);
    const store = new MemoryExecutionLeaseStore({
      clock,
      createLeaseId: leaseIds("lease-1"),
    });
    const lease = await acquire(store);
    const long = await store.renew({
      ...identity(lease),
      commandId: "renew-long",
      ttlMs: 500,
    });
    expect(long.status).toBe("renewed");
    if (long.status !== "renewed") throw new Error("expected renewal");

    clock.advance(10);
    const short = await store.renew({
      ...identity(lease),
      commandId: "renew-short",
      ttlMs: 1,
    });
    expect(short.status).toBe("renewed");
    if (short.status !== "renewed") throw new Error("expected renewal");
    expect(short.lease.expiresAt).toBe(long.lease.expiresAt);
    await expect(store.renew({
      ...identity(lease),
      commandId: "renew-long",
      ttlMs: 500,
    })).resolves.toEqual(long);
  });

  it("rejects stale identity combinations without changing the current lease", async () => {
    const store = new MemoryExecutionLeaseStore({
      clock: new MutableClock(1_000),
      createLeaseId: leaseIds("lease-1"),
    });
    const lease = await acquire(store);
    const variants: ExecutionLeaseIdentity[] = [
      { ...identity(lease), ownerId: "worker-other" },
      { ...identity(lease), leaseId: "lease-other" },
      { ...identity(lease), fencingToken: 2 },
    ];

    for (const [index, stale] of variants.entries()) {
      await expect(store.verify(stale)).resolves.toBe(false);
      await expect(store.renew({
        ...stale,
        commandId: `renew-stale-${index}`,
        ttlMs: 100,
      })).resolves.toEqual({ status: "lost" });
      await expect(store.release({
        ...stale,
        commandId: `release-stale-${index}`,
      })).resolves.toEqual({ status: "lost" });
    }
    expect(await store.inspect("run-1")).toMatchObject({
      ownerId: lease.ownerId,
      fencingToken: lease.fencingToken,
    });
  });

  it("makes release retries harmless after a successor acquires the Run", async () => {
    const store = new MemoryExecutionLeaseStore({
      clock: new MutableClock(1_000),
      createLeaseId: leaseIds("lease-1", "lease-2", "lease-3"),
    });
    const first = await acquire(store);
    await expect(store.release({
      ...identity(first),
      commandId: "release-1",
    })).resolves.toEqual({ status: "released" });

    const successor = await acquire(store, {
      ownerId: "worker-2",
      acquisitionId: "acquire-2",
    });
    expect(successor.fencingToken).toBe(2);
    await expect(store.release({
      ...identity(first),
      commandId: "release-1",
    })).resolves.toEqual({ status: "released" });
    await expect(store.release({
      ...identity(first),
      commandId: "release-old-new-command",
    })).resolves.toEqual({ status: "lost" });
    expect(await store.inspect("run-1")).toMatchObject({
      ownerId: successor.ownerId,
      fencingToken: successor.fencingToken,
    });

    await store.release({
      ...identity(successor),
      commandId: "release-2",
    });
    const third = await acquire(store, {
      ownerId: "worker-3",
      acquisitionId: "acquire-3",
    });
    expect(third.fencingToken).toBe(3);
  });

  it("linearizes concurrent expiry takeover to one successor fence", async () => {
    const clock = new MutableClock(1_000);
    const store = new MemoryExecutionLeaseStore({
      clock,
      createLeaseId: leaseIds("lease-1", "lease-2"),
    });
    await acquire(store);
    clock.advance(100);

    const [left, right] = await Promise.all([
      store.claim({ runId: "run-1", ownerId: "left", acquisitionId: "left", ttlMs: 100 }),
      store.claim({ runId: "run-1", ownerId: "right", acquisitionId: "right", ttlMs: 100 }),
    ]);

    expect([left.status, right.status].sort()).toEqual(["acquired", "held"]);
    const current = await store.inspect("run-1");
    expect(current?.fencingToken).toBe(2);
    expect(current?.ownerId).toBe(
      left.status === "acquired" ? left.lease.ownerId : right.status === "acquired"
        ? right.lease.ownerId
        : "unreachable",
    );
  });

  it("keeps command receipts type-safe and input-stable", async () => {
    const store = new MemoryExecutionLeaseStore({
      clock: new MutableClock(1_000),
      createLeaseId: leaseIds("lease-1"),
    });
    const lease = await acquire(store);
    await store.renew({
      ...identity(lease),
      commandId: "mutation-1",
      ttlMs: 100,
    });
    await expect(store.renew({
      ...identity(lease),
      commandId: "mutation-1",
      ttlMs: 101,
    })).rejects.toThrow(/reused with different input/);
    await expect(store.release({
      ...identity(lease),
      commandId: "mutation-1",
    })).rejects.toThrow(/reused with different input/);
    expect(await store.verify(identity(lease))).toBe(true);
  });

  it("rejects renewal during clock rollback and cannot revive an expired lease", async () => {
    const clock = new MutableClock(1_000);
    const store = new MemoryExecutionLeaseStore({
      clock,
      createLeaseId: leaseIds("lease-1", "lease-2"),
    });
    const lease = await acquire(store);

    clock.set(1_050);
    await expect(store.verify(identity(lease))).resolves.toBe(true);
    clock.set(1_040);
    const regressed = await store.renew({
      ...identity(lease),
      commandId: "renew-during-rollback",
      ttlMs: 100,
    });
    expect(regressed).toEqual({ status: "clock-regressed", lease });
    expect((await store.inspect("run-1"))?.expiresAt).toBe(new Date(1_100).toISOString());

    clock.set(1_100);
    await expect(store.verify(identity(lease))).resolves.toBe(false);
    clock.set(1_000);
    await expect(store.renew({
      ...identity(lease),
      commandId: "renew-after-expiry",
      ttlMs: 10_000,
    })).resolves.toEqual({
      status: "lost",
    });
    await expect(store.verify(identity(lease))).resolves.toBe(false);

    await expect(store.claim({
      runId: "run-1",
      ownerId: "worker-2",
      acquisitionId: "acquire-2",
      ttlMs: 100,
    })).resolves.toEqual({ status: "clock-regressed" });
    clock.set(1_100);
    const next = await store.claim({
      runId: "run-1",
      ownerId: "worker-2",
      acquisitionId: "acquire-3",
      ttlMs: 100,
    });
    expect(next.status).toBe("acquired");
    if (next.status !== "acquired") throw new Error("expected successor acquisition");
    expect(next.lease).toMatchObject({
      fencingToken: 2,
      acquiredAt: new Date(1_100).toISOString(),
      expiresAt: new Date(1_200).toISOString(),
    });
  });

  it("fails a fresh claim closed while the wall clock is regressed", async () => {
    const clock = new MutableClock(1_000);
    const store = new MemoryExecutionLeaseStore({
      clock,
      createLeaseId: leaseIds("lease-1", "lease-2"),
    });
    const first = await acquire(store);
    await store.release({
      ...identity(first),
      commandId: "release-1",
    });
    clock.set(900);
    const regressedInput = {
      runId: "run-1",
      ownerId: "worker-2",
      acquisitionId: "acquire-regressed",
      ttlMs: 100,
    } as const;

    await expect(store.claim(regressedInput)).resolves.toEqual({
      status: "clock-regressed",
    });
    expect(await store.inspect("run-1")).toBeUndefined();

    clock.set(1_000);
    await expect(store.claim(regressedInput)).resolves.toEqual({
      status: "clock-regressed",
    });
    const acquired = await store.claim({
      ...regressedInput,
      acquisitionId: "acquire-after-clock-recovery",
    });
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") throw new Error("expected acquisition");
    expect(acquired.lease).toMatchObject({
      fencingToken: 2,
      acquiredAt: new Date(1_000).toISOString(),
      expiresAt: new Date(1_100).toISOString(),
    });
  });

  it("validates all untrusted identifiers, numbers, clocks, and generated ids", async () => {
    const store = new MemoryExecutionLeaseStore({
      clock: new MutableClock(1_000),
      createLeaseId: leaseIds("lease-secret", "lease-secret"),
    });
    const valid = {
      runId: "run-1",
      ownerId: "worker-1",
      acquisitionId: "acquire-1",
      ttlMs: 100,
    } as const;

    await expect(store.claim({ ...valid, runId: " " })).rejects.toThrow(/runId/);
    await expect(store.claim({ ...valid, ownerId: "owner\0bad" })).rejects.toThrow(/ownerId/);
    await expect(store.claim({ ...valid, ttlMs: 0 })).rejects.toThrow(/positive safe integer/);
    await expect(store.claim({ ...valid, ttlMs: 1.5 })).rejects.toThrow(/positive safe integer/);
    await expect(store.claim({
      ...valid,
      ttlMs: MAX_EXECUTION_LEASE_TTL_MS + 1,
    })).rejects.toThrow(/must not exceed/);
    await store.claim(valid);
    await expect(store.verify({
      runId: "run-1",
      ownerId: "worker-1",
      leaseId: "lease-secret",
      fencingToken: 0,
    })).rejects.toThrow(/fencingToken/);
    const duplicateError = await store.claim({
      ...valid,
      runId: "run-2",
      acquisitionId: "acquire-2",
    }).catch((error: unknown) => error);
    expect(duplicateError).toBeInstanceOf(ExecutionLeaseProtocolError);
    expect((duplicateError as Error).message).toMatch(/duplicate value/);
    expect((duplicateError as Error).message).not.toContain("lease-secret");

    const invalidClock = new MemoryExecutionLeaseStore({
      clock: { now: () => new Date(Number.NaN) },
    });
    await expect(invalidClock.inspect("run-1")).rejects.toThrow(/invalid Date/);
  });

  it("applies the same TTL safety cap to renewal without mutating the lease", async () => {
    const store = new MemoryExecutionLeaseStore({
      clock: new MutableClock(1_000),
      createLeaseId: leaseIds("lease-1"),
    });
    const lease = await acquire(store);

    await expect(store.renew({
      ...identity(lease),
      commandId: "renew-too-long",
      ttlMs: MAX_EXECUTION_LEASE_TTL_MS + 1,
    })).rejects.toThrow(/must not exceed/);
    expect(await store.inspect("run-1")).toMatchObject({
      fencingToken: 1,
      expiresAt: lease.expiresAt,
    });
  });

  it("fails expiration overflow without consuming a fence or acquisition receipt", async () => {
    const maxDateMs = 8_640_000_000_000_000;
    const clock = new MutableClock(maxDateMs - 10);
    const store = new MemoryExecutionLeaseStore({
      clock,
      createLeaseId: leaseIds("failed-id", "lease-1"),
    });
    const input = {
      runId: "run-1",
      ownerId: "worker-1",
      acquisitionId: "acquire-1",
      ttlMs: 11,
    } as const;

    await expect(store.claim(input)).rejects.toThrow(/Date range/);
    const acquired = await store.claim({ ...input, ttlMs: 10 });
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") throw new Error("expected acquisition");
    expect(acquired.lease).toMatchObject({
      leaseId: "lease-1",
      fencingToken: 1,
      expiresAt: new Date(maxDateMs).toISOString(),
    });
  });
});
