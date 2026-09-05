import { describe, expect, it } from "vitest";

import type {
  ExecutionLeaseRelease,
  ExecutionLeaseRenewal,
  ExecutionLeaseStore,
  ExecutionLeaseIdentity,
  ExecutionLeaseClaim,
} from "../../src/runtime/execution-lease.js";
import {
  MemoryExecutionLeaseStore,
  type ExecutionLeaseRenewResult,
} from "../../src/runtime/execution-lease.js";
import {
  LeasedBackgroundJobRunner,
  MIN_LEASED_BACKGROUND_JOB_TTL_MS,
} from "../../src/runtime/leased-background-job.js";

describe("LeasedBackgroundJobRunner", () => {
  it("holds a job for a second owner and fences completion", async () => {
    const store = new MemoryExecutionLeaseStore();
    const firstRunner = runner(store, "owner-1");
    const gate = deferred<void>();
    const first = firstRunner.run("job-1", async () => {
      await gate.promise;
      return "done";
    });
    await eventually(async () => {
      const second = await runner(store, "owner-2").run("job-1", async () => "wrong");
      expect(second.status).toBe("held");
    });
    gate.resolve();
    await expect(first).resolves.toMatchObject({ status: "completed", value: "done" });
  });

  it("aborts the handler and reports lost when renewal loses the lease", async () => {
    const base = new MemoryExecutionLeaseStore();
    const store = new RenewalLostStore(base);
    const result = await runner(store, "owner-1").run("job-loss", async ({ signal }) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return "should-not-commit";
    });
    expect(result.status).toBe("lost");
  });

  it("reports lost when an abort-aware handler rejects after renewal loss", async () => {
    const base = new MemoryExecutionLeaseStore();
    const store = new RenewalLostStore(base);
    const result = await runner(store, "owner-1").run("job-loss-rejection", async ({ signal }) => {
      await aborted(signal);
      throw signal.reason;
    });
    expect(result).toMatchObject({ status: "lost", reason: "Background job lease lost" });
  });

  it("does not claim work after caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled by caller"));
    const result = await runner(new MemoryExecutionLeaseStore(), "owner-1").run(
      "job-cancelled",
      async () => "unexpected",
      { signal: controller.signal },
    );
    expect(result).toMatchObject({ status: "cancelled", reason: "cancelled by caller" });
  });

  it("reports cancellation when an active handler rejects on caller abort", async () => {
    const controller = new AbortController();
    const active = runner(new MemoryExecutionLeaseStore(), "owner-1").run(
      "job-active-cancellation",
      async ({ signal }) => {
        await aborted(signal);
        throw signal.reason;
      },
      { signal: controller.signal },
    );
    controller.abort(new Error("cancelled while active"));
    await expect(active).resolves.toMatchObject({
      status: "cancelled",
      reason: "cancelled while active",
    });
  });

  it("rejects TTLs shorter than the supported renewal cadence", () => {
    expect(() => new LeasedBackgroundJobRunner({
      leaseStore: new MemoryExecutionLeaseStore(),
      namespace: "test",
      ownerId: "owner-1",
      ttlMs: MIN_LEASED_BACKGROUND_JOB_TTL_MS - 1,
    })).toThrow(/ttlMs must be an integer/u);
  });
});

function runner(store: ExecutionLeaseStore, ownerId: string): LeasedBackgroundJobRunner {
  return new LeasedBackgroundJobRunner({
    leaseStore: store,
    namespace: "test",
    ownerId,
    ttlMs: 100,
    createAcquisitionId: () => `${ownerId}:acquisition`,
  });
}

class RenewalLostStore implements ExecutionLeaseStore {
  constructor(private readonly base: ExecutionLeaseStore) {}
  claim(input: ExecutionLeaseClaim) { return this.base.claim(input); }
  renew(_input: ExecutionLeaseRenewal): Promise<ExecutionLeaseRenewResult> {
    return Promise.resolve({ status: "lost" });
  }
  verify(input: ExecutionLeaseIdentity) { return this.base.verify(input); }
  runIfCurrent<T>(input: ExecutionLeaseIdentity, operation: () => Promise<T>) {
    return this.base.runIfCurrent(input, operation);
  }
  release(input: ExecutionLeaseRelease) { return this.base.release(input); }
  inspect(runId: string) { return this.base.inspect(runId); }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function eventually(assertion: () => Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error: unknown) {
      lastError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
  }
  throw lastError;
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
