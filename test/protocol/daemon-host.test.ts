import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Clock } from "../../src/domain/index.js";
import {
  DaemonHost,
  type DaemonHostEvent,
  type DaemonWakeRequest,
  type ExecutionLeaseStore,
  MemoryExecutionLeaseStore,
} from "../../src/runtime/index.js";

const temporaryRoots: string[] = [];

class MutableClock implements Clock {
  constructor(private instantMs: number) {}

  now(): Date {
    return new Date(this.instantMs);
  }

  advance(milliseconds: number): void {
    this.instantMs += milliseconds;
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function wake(runId: string, dedupeKey = `${runId}:wake`): DaemonWakeRequest {
  return {
    runId,
    source: "system",
    dedupeKey,
  };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((mark) => {
    resolve = mark;
  });
  return { promise, resolve };
}

async function waitForEvent(
  events: readonly DaemonHostEvent[],
  predicate: (event: DaemonHostEvent) => boolean,
): Promise<void> {
  if (events.some(predicate)) return;
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (events.some(predicate)) {
        clearInterval(timer);
        resolve();
      }
    }, 1);
    timer.unref?.();
  });
}

describe("DaemonHost", () => {
  it("can open with a restart-safe local lease path", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-daemon-"));
    temporaryRoots.push(root);
    const host = await DaemonHost.open({
      ownerId: "durable-host",
      leasePath: join(root, "leases.json"),
      admitWake: async (request) => ({ status: "admitted", inputId: request.wakeId ?? "input" }),
      activate: async () => undefined,
    });
    await host.start();
    await host.wake(wake("run-durable"));
    await host.waitForIdle();
    await host.stop();
    expect(host.status).toBe("stopped");
  });

  it("requires the async opener for a durable lease path", () => {
    expect(() => new DaemonHost({
      leasePath: "/tmp/nausicaa-leases.json",
      admitWake: async (request) => ({ status: "admitted", inputId: request.wakeId ?? "input" }),
      activate: async () => undefined,
    })).toThrow(/DaemonHost\.open/u);
  });

  it("has an idempotent lifecycle and admits durable wakes before activation", async () => {
    const events: DaemonHostEvent[] = [];
    const activations: string[] = [];
    const host = new DaemonHost({
      ownerId: "host-1",
      createWakeId: () => "wake-1",
      createActivationId: () => "activation-1",
      admitWake: async (request) => ({
        status: "admitted",
        inputId: request.inputId ?? request.wakeId ?? "input-1",
      }),
      activate: async ({ runId }) => {
        activations.push(runId);
      },
    });
    host.subscribe((event) => events.push(event));

    await expect(host.wake(wake("run-1"))).rejects.toThrow(/stopped/u);
    await expect(host.start()).resolves.toMatchObject({ status: "running" });
    await expect(host.start()).resolves.toMatchObject({ status: "running" });
    await host.wake(wake("run-1"));
    await host.waitForIdle();

    expect(activations).toEqual(["run-1"]);
    expect(host.snapshot()).toMatchObject({
      status: "running",
      queuedRuns: 0,
      runningRuns: 0,
    });
    expect(events.filter((event) => event.type === "activation.started")).toHaveLength(1);

    await expect(host.stop()).resolves.toMatchObject({ status: "stopped" });
    await expect(host.stop()).resolves.toMatchObject({ status: "stopped" });
  });

  it("does not execute a duplicate durable wake unless the adapter asks for activation", async () => {
    const seen = new Set<string>();
    let calls = 0;
    const host = new DaemonHost({
      ownerId: "host-duplicate",
      admitWake: async (request) => {
        if (seen.has(request.dedupeKey)) {
          return { status: "duplicate", inputId: request.inputId ?? "input-1" };
        }
        seen.add(request.dedupeKey);
        return { status: "admitted", inputId: request.inputId ?? "input-1" };
      },
      activate: async () => {
        calls += 1;
      },
    });
    await host.start();

    await expect(host.wake(wake("run-1", "same"))).resolves.toMatchObject({
      status: "queued",
      admission: { status: "admitted" },
    });
    await expect(host.wake(wake("run-1", "same"))).resolves.toMatchObject({
      status: "duplicate",
      admission: { status: "duplicate" },
    });
    await host.waitForIdle();
    expect(calls).toBe(1);

    await host.stop();
  });

  it("serializes a Run while allowing bounded concurrency across Runs", async () => {
    const events: DaemonHostEvent[] = [];
    const runOneRelease = deferred();
    const runOneSecondRelease = deferred();
    const runTwoRelease = deferred();
    const activeByRun = new Map<string, number>();
    const activationRuns: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const host = new DaemonHost({
      ownerId: "host-concurrency",
      maxConcurrentActivations: 2,
      leaseTtlMs: 1_000,
      admitWake: async (request) => ({
        status: "admitted",
        inputId: request.inputId ?? request.wakeId ?? `${request.runId}:input`,
      }),
      activate: async ({ runId }) => {
        activationRuns.push(runId);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        activeByRun.set(runId, (activeByRun.get(runId) ?? 0) + 1);
        try {
          if (runId === "run-1" && (activeByRun.get(runId) ?? 0) === 1) {
            await runOneRelease.promise;
          } else if (runId === "run-1") {
            await runOneSecondRelease.promise;
          } else if (runId === "run-2") {
            await runTwoRelease.promise;
          }
        } finally {
          active -= 1;
        }
      },
    });
    host.subscribe((event) => events.push(event));
    await host.start();

    await host.wake(wake("run-1", "first"));
    await waitForEvent(events, (event) => (
      event.type === "activation.started" && event.runId === "run-1"
    ));
    await host.wake(wake("run-1", "second"));
    await host.wake(wake("run-2", "first"));
    await waitForEvent(events, (event) => (
      event.type === "activation.started" && event.runId === "run-2"
    ));

    expect(maximumActive).toBe(2);
    expect(host.snapshot()).toMatchObject({ runningRuns: 2 });
    runOneRelease.resolve();
    runTwoRelease.resolve();
    const firstRunActivation = events.find((item): item is Extract<
      DaemonHostEvent,
      { type: "activation.started" }
    > => item.type === "activation.started" && item.runId === "run-1");
    await waitForEvent(events, (event) => (
      event.type === "activation.started"
      && event.runId === "run-1"
      && event.activationId !== firstRunActivation?.activationId
    ));
    runOneSecondRelease.resolve();
    await host.waitForIdle();

    expect(activationRuns).toEqual(["run-1", "run-2", "run-1"]);
    expect(maximumActive).toBeLessThanOrEqual(2);
    await host.stop();
  });

  it("keeps execution ownership when a client detaches", async () => {
    const release = deferred();
    let aborted = false;
    const host = new DaemonHost({
      ownerId: "host-attach",
      admitWake: async (request) => ({
        status: "admitted",
        inputId: request.inputId ?? request.wakeId ?? "input-1",
      }),
      activate: async ({ signal }) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          }, { once: true });
          void release.promise.then(() => resolve());
        });
      },
    });
    await host.start();
    host.attach("client-1", "run-1");
    expect(host.snapshot().attachedClients).toBe(1);
    await host.wake(wake("run-1"));
    host.detach("client-1");
    expect(host.snapshot().attachedClients).toBe(0);
    release.resolve();
    await host.waitForIdle();
    expect(aborted).toBe(false);
    await host.stop();
  });

  it("cancels active executions on stop and reports a cancelled activation", async () => {
    const events: DaemonHostEvent[] = [];
    const started = deferred();
    const host = new DaemonHost({
      ownerId: "host-stop",
      admitWake: async (request) => ({
        status: "admitted",
        inputId: request.inputId ?? request.wakeId ?? "input-1",
      }),
      activate: async ({ signal }) => {
        started.resolve();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw signal.reason;
      },
    });
    host.subscribe((event) => events.push(event));
    await host.start();
    await host.wake(wake("run-1"));
    await started.promise;
    await host.stop();

    expect(events.some((event) => (
      event.type === "activation.finished"
      && event.outcome === "cancelled"
    ))).toBe(true);
    expect(host.snapshot()).toMatchObject({ status: "stopped", runningRuns: 0 });
  });

  it("waits for in-flight wake admission and leaves its durable input for recovery", async () => {
    const admissionStarted = deferred();
    const admission = deferred<{ status: "admitted"; inputId: string }>();
    let activations = 0;
    const host = new DaemonHost({
      ownerId: "host-admission-stop",
      admitWake: async () => {
        admissionStarted.resolve();
        return admission.promise;
      },
      activate: async () => {
        activations += 1;
      },
    });
    await host.start();

    const waking = host.wake(wake("run-admission-stop"));
    await admissionStarted.promise;
    let stopSettled = false;
    const stopping = host.stop().then((snapshot) => {
      stopSettled = true;
      return snapshot;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopSettled).toBe(false);

    admission.resolve({ status: "admitted", inputId: "durable-input" });
    await expect(waking).rejects.toThrow(/durable input requires recovery/u);
    await expect(stopping).resolves.toMatchObject({
      status: "stopped",
      queuedRuns: 0,
      runningRuns: 0,
      runs: [],
    });
    expect(activations).toBe(0);

    await host.start();
    await host.waitForIdle();
    expect(activations).toBe(1);
    expect(host.snapshot().runs).toEqual([]);
    await host.stop();
  });

  it("parks a cancelled activation for a same-process stop and start", async () => {
    const firstStarted = deferred();
    let attempts = 0;
    const host = new DaemonHost({
      ownerId: "host-activation-restart",
      admitWake: async (request) => ({
        status: "admitted",
        inputId: request.inputId ?? request.wakeId ?? "input-1",
      }),
      activate: async ({ signal }) => {
        attempts += 1;
        if (attempts > 1) return;
        firstStarted.resolve();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        // Return normally after cooperative cancellation; stop/start still
        // owes the durable wake another activation attempt.
      },
    });
    await host.start();
    await host.wake(wake("run-activation-restart"));
    await firstStarted.promise;

    await expect(host.stop()).resolves.toMatchObject({
      status: "stopped",
      runs: [],
    });
    expect(attempts).toBe(1);

    await host.start();
    await host.waitForIdle();
    expect(attempts).toBe(2);
    expect(host.snapshot().runs).toEqual([]);
    await host.stop();
  });

  it("allows a fenced terminal commit while cooperative stop is cancelling", async () => {
    const started = deferred();
    let terminalCommits = 0;
    const host = new DaemonHost({
      ownerId: "host-cooperative-terminal",
      admitWake: async (request) => ({
        status: "admitted",
        inputId: request.wakeId ?? "input-1",
      }),
      activate: async ({ signal, commitLease }) => {
        started.resolve();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        await commitLease?.(async () => {
          terminalCommits += 1;
        });
      },
    });
    await host.start();
    await host.wake(wake("run-cooperative-terminal"));
    await started.promise;

    await host.stop();

    expect(terminalCommits).toBe(1);
  });

  it("revokes local commit authority when a guarded commit throws", async () => {
    vi.useFakeTimers();
    try {
      let firstCommitAttempts = 0;
      let staleCommitAttempts = 0;
      const host = new DaemonHost({
        ownerId: "host-thrown-commit",
        admitWake: async (request) => ({
          status: "admitted",
          inputId: request.wakeId ?? "input-1",
        }),
        activate: async ({ signal, commitLease }) => {
          expect(commitLease).toBeTypeOf("function");
          await expect(commitLease?.(async () => {
            firstCommitAttempts += 1;
            throw new Error("ledger append failed");
          })).rejects.toThrow("ledger append failed");
          expect(signal.aborted).toBe(true);
          await expect(commitLease?.(async () => {
            staleCommitAttempts += 1;
          })).rejects.toThrow(/commit authority lost/u);
        },
      });
      await host.start();
      await host.wake(wake("run-thrown-commit"));
      await host.waitForIdle();

      expect(firstCommitAttempts).toBe(1);
      expect(staleCommitAttempts).toBe(0);
      expect(host.snapshot().runs).toContainEqual(expect.objectContaining({
        runId: "run-thrown-commit",
        state: "held",
        pendingWakeCount: 1,
      }));
      await host.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains a wake when another Host holds the Run lease", async () => {
    const store = new MemoryExecutionLeaseStore();
    const release = deferred();
    const firstEvents: DaemonHostEvent[] = [];
    const first = new DaemonHost({
      ownerId: "host-first",
      leaseStore: store,
      admitWake: async (request) => ({ status: "admitted", inputId: request.wakeId ?? "input" }),
      activate: async () => {
        await release.promise;
      },
    });
    first.subscribe((event) => firstEvents.push(event));
    const secondEvents: DaemonHostEvent[] = [];
    let secondActivations = 0;
    const second = new DaemonHost({
      ownerId: "host-second",
      leaseStore: store,
      admitWake: async (request) => ({ status: "admitted", inputId: request.wakeId ?? "input" }),
      activate: async () => {
        secondActivations += 1;
      },
    });
    second.subscribe((event) => secondEvents.push(event));
    await first.start();
    await second.start();
    await first.wake(wake("run-1", "first"));
    await waitForEvent(firstEvents, (event) => (
      event.type === "activation.started" && event.runId === "run-1"
    ));
    await second.wake(wake("run-1", "second"));
    await second.waitForIdle();

    expect(second.snapshot().runs).toContainEqual(expect.objectContaining({
      runId: "run-1",
      state: "held",
      pendingWakeCount: 1,
    }));
    release.resolve();
    await first.waitForIdle();
    await first.stop();
    await second.wake(wake("run-1", "retry"));
    await second.waitForIdle();
    expect(secondActivations).toBe(1);
    await second.stop();
  });

  it("retries a held Run once the competing lease expires", async () => {
    vi.useFakeTimers();
    try {
      const clock = new MutableClock(Date.parse("2026-08-30T00:00:00.000Z"));
      const store = new MemoryExecutionLeaseStore({ clock });
      const held = await store.claim({
        runId: "run-expiring-lease",
        ownerId: "old-host",
        acquisitionId: "old-host-claim",
        ttlMs: 100,
      });
      expect(held.status).toBe("acquired");
      const activationWakes: string[][] = [];
      const host = new DaemonHost({
        ownerId: "replacement-host",
        clock,
        leaseStore: store,
        leaseTtlMs: 100,
        admitWake: async (request) => ({
          status: "admitted",
          inputId: request.wakeId ?? "durable-input",
        }),
        activate: async ({ wakes }) => {
          activationWakes.push(wakes.map((item) => item.dedupeKey));
        },
      });
      await host.start();
      await host.wake(wake("run-expiring-lease", "recovered-wake"));
      await host.waitForIdle();
      expect(host.snapshot().runs).toContainEqual(expect.objectContaining({
        runId: "run-expiring-lease",
        state: "held",
        pendingWakeCount: 1,
      }));

      clock.advance(101);
      await vi.advanceTimersByTimeAsync(101);
      await host.waitForIdle();

      expect(activationWakes).toEqual([["recovered-wake"]]);
      expect(host.snapshot().runs).toEqual([]);
      await host.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reschedules one held-lease retry when the competing owner renews", async () => {
    vi.useFakeTimers();
    try {
      const clock = new MutableClock(Date.parse("2026-08-30T00:30:00.000Z"));
      const store = new MemoryExecutionLeaseStore({ clock });
      const claim = await store.claim({
        runId: "run-renewed-lease",
        ownerId: "old-host",
        acquisitionId: "old-host-claim",
        ttlMs: 100,
      });
      if (claim.status !== "acquired") throw new Error("expected old Host lease");
      let activations = 0;
      const host = new DaemonHost({
        ownerId: "replacement-host",
        clock,
        leaseStore: store,
        leaseTtlMs: 100,
        admitWake: async (request) => ({
          status: "admitted",
          inputId: request.wakeId ?? "durable-input",
        }),
        activate: async () => {
          activations += 1;
        },
      });
      await host.start();
      await host.wake(wake("run-renewed-lease"));
      await host.waitForIdle();
      expect(vi.getTimerCount()).toBe(1);

      clock.advance(50);
      await store.renew({
        runId: claim.lease.runId,
        ownerId: claim.lease.ownerId,
        leaseId: claim.lease.leaseId,
        fencingToken: claim.lease.fencingToken,
        commandId: "old-host-renewal",
        ttlMs: 200,
      });
      clock.advance(51);
      await vi.advanceTimersByTimeAsync(101);
      await host.waitForIdle();

      expect(activations).toBe(0);
      expect(vi.getTimerCount()).toBe(1);
      expect(host.snapshot().runs).toContainEqual(expect.objectContaining({
        runId: "run-renewed-lease",
        state: "held",
        pendingWakeCount: 1,
      }));

      clock.advance(150);
      await vi.advanceTimersByTimeAsync(150);
      await host.waitForIdle();
      expect(activations).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      await host.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels held-lease retries when the Host stops", async () => {
    vi.useFakeTimers();
    try {
      const clock = new MutableClock(Date.parse("2026-08-30T01:00:00.000Z"));
      const store = new MemoryExecutionLeaseStore({ clock });
      await store.claim({
        runId: "run-stopped-retry",
        ownerId: "old-host",
        acquisitionId: "old-host-claim",
        ttlMs: 100,
      });
      let activations = 0;
      const host = new DaemonHost({
        ownerId: "replacement-host",
        clock,
        leaseStore: store,
        leaseTtlMs: 100,
        admitWake: async (request) => ({
          status: "admitted",
          inputId: request.wakeId ?? "durable-input",
        }),
        activate: async () => {
          activations += 1;
        },
      });
      await host.start();
      await host.wake(wake("run-stopped-retry"));
      await host.waitForIdle();
      await host.stop();

      clock.advance(101);
      await vi.advanceTimersByTimeAsync(101);

      expect(activations).toBe(0);
      expect(host.snapshot()).toMatchObject({
        status: "stopped",
        queuedRuns: 0,
        runningRuns: 0,
        runs: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains failed activation wakes for an explicit retry", async () => {
    const events: DaemonHostEvent[] = [];
    let attempts = 0;
    const host = new DaemonHost({
      ownerId: "host-retry",
      admitWake: async (request) => ({
        status: "admitted",
        inputId: request.inputId ?? request.wakeId ?? `${request.runId}:input`,
      }),
      activate: async ({ wakes }) => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient activation failure");
        expect(wakes.map((wake) => wake.dedupeKey)).toEqual(["first", "retry"]);
      },
    });
    host.subscribe((event) => events.push(event));
    await host.start();
    await host.wake(wake("run-retry", "first"));
    await waitForEvent(events, (event) => (
      event.type === "activation.finished" && event.outcome === "failed"
    ));
    expect(host.snapshot().runs).toContainEqual(expect.objectContaining({
      runId: "run-retry",
      state: "held",
      pendingWakeCount: 1,
    }));

    await host.wake(wake("run-retry", "retry"));
    await host.waitForIdle();
    expect(attempts).toBe(2);
    expect(host.snapshot().runs).toEqual([]);
    await host.stop();
  });

  it("exposes a lease assertion that fences a stale activator", async () => {
    let nowMs = Date.parse("2026-08-29T00:00:00.000Z");
    const clock = { now: () => new Date(nowMs) };
    const store = new MemoryExecutionLeaseStore({ clock });
    const events: DaemonHostEvent[] = [];
    const host = new DaemonHost({
      ownerId: "host-fenced",
      leaseStore: store,
      clock,
      leaseTtlMs: 100,
      admitWake: async (request) => ({
        status: "admitted",
        inputId: request.inputId ?? request.wakeId ?? "input-1",
      }),
      activate: async ({ assertLease }) => {
        expect(assertLease).toBeTypeOf("function");
        nowMs += 101;
        await store.claim({
          runId: "run-1",
          ownerId: "successor",
          acquisitionId: "successor-claim",
          ttlMs: 100,
        });
        await assertLease?.();
      },
    });
    host.subscribe((event) => events.push(event));
    await host.start();
    await host.wake(wake("run-1"));
    await host.waitForIdle();

    expect(events.some((event) => (
      event.type === "activation.finished"
      && (event.outcome === "failed" || event.outcome === "cancelled")
    ))).toBe(true);
    // The finished event is emitted before the activation's finally block
    // removes it from the running map; observe the settled snapshot.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(host.snapshot().runs).toContainEqual(expect.objectContaining({
      runId: "run-1",
      state: "held",
      pendingWakeCount: 1,
    }));
    await host.stop();
  });

  it("ignores a delayed renewal after the activation has released its lease", async () => {
    const base = new MemoryExecutionLeaseStore();
    const renewalStarted = deferred();
    const releaseRenewal = deferred();
    const events: DaemonHostEvent[] = [];
    const leaseStore: ExecutionLeaseStore = {
      claim: (input) => base.claim(input),
      renew: async (input) => {
        renewalStarted.resolve();
        await releaseRenewal.promise;
        return base.renew(input);
      },
      verify: (input) => base.verify(input),
      runIfCurrent: (input, operation) => base.runIfCurrent(input, operation),
      release: (input) => base.release(input),
      inspect: (runId) => base.inspect(runId),
    };
    const host = new DaemonHost({
      ownerId: "host-delayed-renewal",
      leaseStore,
      leaseTtlMs: 100,
      admitWake: async (request) => ({
        status: "admitted",
        inputId: request.inputId ?? request.wakeId ?? "input-1",
      }),
      activate: async () => {
        await renewalStarted.promise;
      },
    });
    host.subscribe((event) => events.push(event));
    await host.start();
    await host.wake(wake("run-delayed-renewal"));
    await host.waitForIdle();

    releaseRenewal.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(events.filter((event) => event.type === "activation.lease-lost")).toEqual([]);
    await host.stop();
  });

  it("reports a lost activation lease only once", async () => {
    const base = new MemoryExecutionLeaseStore();
    const events: DaemonHostEvent[] = [];
    const leaseStore: ExecutionLeaseStore = {
      claim: (input) => base.claim(input),
      renew: async () => ({ status: "lost" }),
      verify: (input) => base.verify(input),
      runIfCurrent: (input, operation) => base.runIfCurrent(input, operation),
      release: async () => ({ status: "lost" }),
      inspect: (runId) => base.inspect(runId),
    };
    const host = new DaemonHost({
      ownerId: "host-single-lease-loss",
      leaseStore,
      leaseTtlMs: 20,
      admitWake: async (request) => ({
        status: "admitted",
        inputId: request.inputId ?? request.wakeId ?? "input-1",
      }),
      activate: async ({ signal }) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw signal.reason;
      },
    });
    host.subscribe((event) => events.push(event));
    await host.start();
    await host.wake(wake("run-single-lease-loss"));
    await host.waitForIdle();

    expect(events.filter((event) => event.type === "activation.lease-lost")).toHaveLength(1);
    await host.stop();
  });

  it("retries preserved wakes after a transient renewal failure", async () => {
    vi.useFakeTimers();
    try {
      const clock = new MutableClock(Date.parse("2026-08-30T02:00:00.000Z"));
      const base = new MemoryExecutionLeaseStore({ clock });
      let renewalAttempts = 0;
      const leaseStore: ExecutionLeaseStore = {
        claim: (input) => base.claim(input),
        renew: async (input) => {
          renewalAttempts += 1;
          if (renewalAttempts === 1) throw new Error("transient lease I/O failure");
          return base.renew(input);
        },
        verify: (input) => base.verify(input),
        runIfCurrent: (input, operation) => base.runIfCurrent(input, operation),
        release: (input) => base.release(input),
        inspect: (runId) => base.inspect(runId),
      };
      const firstStarted = deferred();
      let activations = 0;
      let staleTerminalCommits = 0;
      const host = new DaemonHost({
        ownerId: "host-renewal-retry",
        leaseStore,
        clock,
        leaseTtlMs: 20,
        admitWake: async (request) => ({
          status: "admitted",
          inputId: request.wakeId ?? "input-1",
        }),
        activate: async ({ signal, commitLease }) => {
          activations += 1;
          if (activations !== 1) return;
          firstStarted.resolve();
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          expect(commitLease).toBeTypeOf("function");
          await expect(commitLease?.(async () => {
            staleTerminalCommits += 1;
          })).rejects.toThrow(/commit authority lost/u);
        },
      });
      await host.start();
      await host.wake(wake("run-renewal-retry"));
      await firstStarted.promise;

      await vi.advanceTimersByTimeAsync(10);
      await host.waitForIdle();
      expect(staleTerminalCommits).toBe(0);
      expect(host.snapshot().runs).toContainEqual(expect.objectContaining({
        runId: "run-renewal-retry",
        state: "held",
        pendingWakeCount: 1,
      }));

      clock.advance(26);
      await vi.advanceTimersByTimeAsync(26);
      await host.waitForIdle();
      expect(activations).toBe(2);
      expect(host.snapshot().runs).toEqual([]);
      await host.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
