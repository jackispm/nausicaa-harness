import { describe, expect, it } from "vitest";

import {
  DaemonSupervisor,
  createDaemonSupervisorWorkerFactory,
  type DaemonSupervisorDescriptor,
  type DaemonSupervisorWorker,
  type DaemonSupervisorWorkerClient,
} from "../../src/runtime/daemon-supervisor.js";
import { MemoryExecutionLeaseStore } from "../../src/runtime/execution-lease.js";
import type {
  DaemonWorkerActivationReceipt,
  DaemonWorkerActivationRequest,
  DaemonWorkerClientSnapshot,
} from "../../src/runtime/daemon-worker-client.js";
import type { DaemonWakeRequest } from "../../src/runtime/daemon-host.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((mark) => {
    resolve = mark;
  });
  return { promise, resolve };
}

function wake(runId: string, dedupeKey = `${runId}:wake`): DaemonWakeRequest {
  return { runId, source: "system", dedupeKey };
}

class FakeWorkerClient implements DaemonSupervisorWorkerClient {
  lifecycle: DaemonWorkerClientSnapshot["lifecycle"] = "starting";
  initialized = false;
  instanceToken = "instance-token";
  initializeCalls = 0;
  activateCalls = 0;
  drainCalls = 0;
  cancelCalls = 0;
  shutdownCalls = 0;
  closeCalls = 0;
  shutdownError?: Error;
  readonly activation = deferred<DaemonWorkerActivationReceipt>();
  initializeGate?: Promise<DaemonWorkerClientSnapshot>;

  get snapshot(): DaemonWorkerClientSnapshot {
    return {
      lifecycle: this.lifecycle,
      connected: this.lifecycle !== "stopped" && this.lifecycle !== "failed",
      initialized: this.initialized,
      runId: "run-1",
      workerId: "worker-1",
      ...(this.initialized ? { instanceToken: this.instanceToken } : {}),
      pendingActivations: this.activateCalls > this.cancelCalls ? 1 : 0,
    };
  }

  async initialize(): Promise<DaemonWorkerClientSnapshot> {
    this.initializeCalls += 1;
    if (this.initializeGate !== undefined) return this.initializeGate;
    this.initialized = true;
    this.lifecycle = "ready";
    return this.snapshot;
  }

  async activate(_request: DaemonWorkerActivationRequest): Promise<DaemonWorkerActivationReceipt> {
    this.activateCalls += 1;
    this.lifecycle = "ready";
    return this.activation.promise;
  }

  async cancel(activationId: string): Promise<DaemonWorkerClientSnapshot> {
    this.cancelCalls += 1;
    this.activation.resolve({
      activationId,
      runId: "run-1",
      status: "cancelled",
    });
    return this.snapshot;
  }

  async drain(): Promise<DaemonWorkerClientSnapshot> {
    this.drainCalls += 1;
    this.lifecycle = "draining";
    return this.snapshot;
  }

  async shutdown(): Promise<DaemonWorkerClientSnapshot> {
    this.shutdownCalls += 1;
    if (this.shutdownError !== undefined) throw this.shutdownError;
    this.lifecycle = "stopped";
    return this.snapshot;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.lifecycle = "stopped";
  }
}

function makeSupervisor(options: {
  maxWorkers?: number;
  maxPendingRuns?: number;
  readyTimeoutMs?: number;
  client?: FakeWorkerClient;
  descriptor?: DaemonSupervisorDescriptor;
} = {}): Promise<DaemonSupervisor> {
  const client = options.client ?? new FakeWorkerClient();
  return DaemonSupervisor.open({
    ...(options.maxWorkers === undefined ? {} : { maxWorkers: options.maxWorkers }),
    ...(options.maxPendingRuns === undefined ? {} : { maxPendingRuns: options.maxPendingRuns }),
    ...(options.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: options.readyTimeoutMs }),
    admitWake: async (request) => ({
      status: "admitted" as const,
      inputId: request.inputId ?? `${request.runId}:input:${request.dedupeKey}`,
    }),
    leasePathForRun: (runId) => `/tmp/nausicaa/${runId}/lease.json`,
    createWorkerId: () => "worker-1",
    createWorker: (request) => ({
      client,
      ...(options.descriptor === undefined ? {} : { descriptor: options.descriptor }),
      request,
    } as DaemonSupervisorWorker & { request: typeof request }),
    host: {
      ownerId: "supervisor-test",
      leaseTtlMs: 10_000,
      createActivationId: () => "activation-1",
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    },
  });
}

async function startAndWake(supervisor: DaemonSupervisor, request = wake("run-1")):
  Promise<void> {
  await supervisor.start();
  await supervisor.wake(request);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("DaemonSupervisor", () => {
  it("starts the service/Host before accepting wakes and performs a ready-gated activation", async () => {
    const client = new FakeWorkerClient();
    const supervisor = await makeSupervisor({ client });
    const events: string[] = [];
    supervisor.subscribe((event) => {
      if (event.type === "worker") events.push(event.state);
    });

    await startAndWake(supervisor);
    expect(client.initializeCalls).toBe(1);
    expect(client.activateCalls).toBe(1);
    client.activation.resolve({ activationId: "activation-1", runId: "run-1", status: "completed" });
    await supervisor.daemonHost.waitForIdle();
    expect(events).toEqual(["starting", "ready", "running", "completed", "closed"]);
    await supervisor.close();
  });

  it("coalesces duplicate wakes and keeps one activation per Run", async () => {
    const client = new FakeWorkerClient();
    const supervisor = await makeSupervisor({ client });
    await supervisor.start();
    await supervisor.wake(wake("run-1", "same"));
    await supervisor.wake(wake("run-1", "same"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(client.activateCalls).toBe(1);
    client.activation.resolve({ activationId: "activation-1", runId: "run-1", status: "completed" });
    await supervisor.daemonHost.waitForIdle();
    await supervisor.close();
  });

  it("reports bounded capacity before admitting a second Run", async () => {
    const client = new FakeWorkerClient();
    const supervisor = await makeSupervisor({ client, maxPendingRuns: 1, maxWorkers: 1 });
    await startAndWake(supervisor);
    const result = await supervisor.wake(wake("run-2"));
    expect(result.status).toBe("capacity");
    if (result.status === "capacity") expect(result.failure.code).toBe("capacity");
    client.activation.resolve({ activationId: "activation-1", runId: "run-1", status: "completed" });
    await supervisor.daemonHost.waitForIdle();
    await supervisor.close();
  });

  it("counts lease-held Runs toward pending capacity", async () => {
    const leases = new MemoryExecutionLeaseStore({ createLeaseId: () => "held-lease" });
    const claim = await leases.claim({
      runId: "run-held",
      ownerId: "other-host",
      acquisitionId: "other-claim",
      ttlMs: 10_000,
    });
    expect(claim.status).toBe("acquired");
    const client = new FakeWorkerClient();
    const supervisor = await DaemonSupervisor.open({
      maxWorkers: 1,
      maxPendingRuns: 1,
      host: {
        ownerId: "held-capacity",
        leaseStore: leases,
        leaseTtlMs: 10_000,
      },
      admitWake: async (request) => ({
        status: "admitted" as const,
        inputId: `${request.runId}:input`,
      }),
      leasePathForRun: () => "/tmp/nausicaa/held-capacity/lease.json",
      createWorker: () => ({ client }),
    });
    await supervisor.start();
    await supervisor.wake(wake("run-held"));
    await supervisor.daemonHost.waitForIdle();
    expect(supervisor.daemonHost.snapshot().runs).toEqual([
      expect.objectContaining({ runId: "run-held", state: "held" }),
    ]);

    await expect(supervisor.wake(wake("run-2"))).resolves.toMatchObject({
      status: "capacity",
      failure: { code: "capacity" },
    });
    await supervisor.close();
    if (claim.status === "acquired") {
      await leases.release({
        runId: claim.lease.runId,
        ownerId: claim.lease.ownerId,
        leaseId: claim.lease.leaseId,
        fencingToken: claim.lease.fencingToken,
        commandId: "other-release",
      });
    }
  });

  it("keeps process descriptor publication in the supervisor factory", async () => {
    const published: string[] = [];
    const factory = createDaemonSupervisorWorkerFactory({
      args: [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        "import { runDaemonWorkerStdioServer } from './src/runtime/daemon-worker-server.ts'; runDaemonWorkerStdioServer({ runId: 'run-1', workerId: 'worker-1', runner: { activate: async () => ({ status: 'completed' }) } });",
      ],
      cwd: process.cwd(),
      env: process.env,
      descriptorPublisherForRun: () => ({
        publish: async (descriptor) => { published.push(descriptor.instanceToken); },
        clear: async (instanceToken) => {
          const index = published.indexOf(instanceToken);
          if (index >= 0) published.splice(index, 1);
        },
      }),
    });
    const worker = await factory({
      runId: "run-1",
      workerId: "worker-1",
      activationId: "activation-1",
      generation: 1,
      lease: {
        runId: "run-1",
        leasePath: "/tmp/nausicaa-supervisor-test/lease.json",
        fencingToken: 1,
      },
    });
    await expect(worker.client.initialize()).resolves.toMatchObject({ lifecycle: "ready" });
    expect(published).toHaveLength(1);
    await worker.close?.();
    expect(published).toHaveLength(0);
  });

  it("closes a worker even when its shutdown command fails", async () => {
    const client = new FakeWorkerClient();
    client.shutdownError = new Error("worker already crashed");
    const supervisor = await makeSupervisor({ client });
    await startAndWake(supervisor);
    client.activation.resolve({ activationId: "activation-1", runId: "run-1", status: "completed" });
    await supervisor.daemonHost.waitForIdle();
    expect(client.shutdownCalls).toBe(1);
    expect(client.closeCalls).toBe(1);
    await supervisor.close();
  });

  it("reserves capacity across concurrent wake admissions", async () => {
    const admission = deferred<void>();
    const client = new FakeWorkerClient();
    const supervisor = await DaemonSupervisor.open({
      maxWorkers: 1,
      maxPendingRuns: 1,
      host: { ownerId: "concurrent-capacity", leaseTtlMs: 10_000 },
      admitWake: async (request) => {
        await admission.promise;
        return { status: "admitted" as const, inputId: `${request.runId}:input` };
      },
      leasePathForRun: (runId) => `/tmp/nausicaa/${runId}/lease.json`,
      createWorker: () => ({ client }),
    });
    await supervisor.start();
    const first = supervisor.wake(wake("run-1"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(supervisor.wake(wake("run-2"))).resolves.toMatchObject({ status: "capacity" });
    admission.resolve();
    await first;
    client.activation.resolve({ activationId: "activation-1", runId: "run-1", status: "completed" });
    await supervisor.daemonHost.waitForIdle();
    await supervisor.close();
  });

  it("classifies an uncertain worker receipt and never replays it", async () => {
    const client = new FakeWorkerClient();
    const supervisor = await makeSupervisor({ client });
    const events: string[] = [];
    supervisor.subscribe((event) => {
      if (event.type === "worker") events.push(event.state);
    });
    await startAndWake(supervisor);
    client.activation.resolve({
      activationId: "activation-1",
      runId: "run-1",
      status: "uncertain",
      error: { code: "internal", message: "outcome unknown" },
    });
    await supervisor.daemonHost.waitForIdle();
    expect(events).toContain("uncertain");
    expect(client.activateCalls).toBe(1);
    await supervisor.close();
  });

  it("classifies a ready timeout and closes the unusable worker", async () => {
    const client = new FakeWorkerClient();
    client.initializeGate = new Promise<DaemonWorkerClientSnapshot>(() => undefined);
    const supervisor = await makeSupervisor({ client, readyTimeoutMs: 5 });
    const events: string[] = [];
    supervisor.subscribe((event) => {
      if (event.type === "worker") events.push(event.state);
    });
    await startAndWake(supervisor);
    await supervisor.daemonHost.waitForIdle();
    expect(events).toContain("ready-timeout");
    expect(client.activateCalls).toBe(0);
    expect(client.closeCalls).toBe(1);
    await supervisor.close();
  });

  it("matches descriptors only when worker identity and generation agree", async () => {
    const client = new FakeWorkerClient();
    const descriptor: DaemonSupervisorDescriptor = {
      runId: "run-1",
      workerId: "worker-1",
      generation: 1,
      instanceToken: "instance-token",
    };
    const supervisor = await makeSupervisor({ client, descriptor });
    await startAndWake(supervisor);
    await expect(supervisor.reconcile([descriptor])).resolves.toMatchObject({ matched: ["run-1"] });
    await expect(supervisor.reconcile([{
      ...descriptor,
      generation: 99,
    }])).resolves.toMatchObject({ replaced: ["run-1"] });
    await expect(supervisor.reconcile([])).resolves.toMatchObject({ stale: ["run-1"] });
    client.activation.resolve({ activationId: "activation-1", runId: "run-1", status: "completed" });
    await supervisor.daemonHost.waitForIdle();
    await supervisor.close();
  });

  it("detaches without cancelling, while explicit stop drains and cancels", async () => {
    const client = new FakeWorkerClient();
    const supervisor = await makeSupervisor({ client });
    await startAndWake(supervisor);
    supervisor.attach("client-1", "run-1");
    supervisor.detach("client-1");
    expect(client.cancelCalls).toBe(0);
    await supervisor.stop();
    expect(client.drainCalls).toBe(1);
    expect(client.cancelCalls).toBe(1);
    expect(supervisor.lifecycle).toBe("stopped");
    await supervisor.close();
  });
});
