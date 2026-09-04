import { afterEach, describe, expect, it } from "vitest";

import {
  DaemonWorkerClient,
  DaemonWorkerServer,
  MemoryDaemonWorkerRecoveryJournal,
  MemoryExecutionLeaseStore,
} from "../../src/runtime/index.js";
import type {
  DaemonWorkerFrame,
  DaemonWorkerRecoveryJournal,
  DaemonWorkerRecoveryRecord,
  DaemonWorkerRecoveryRecordInput,
  DaemonWorkerTransport,
} from "../../src/runtime/index.js";

class PairTransport implements DaemonWorkerTransport {
  peer?: PairTransport;
  private readonly frames = new Set<(frame: unknown) => void>();
  private readonly closes = new Set<(error?: Error) => void>();
  private closed = false;

  send(frame: DaemonWorkerFrame): void {
    if (this.closed) throw new Error("closed");
    queueMicrotask(() => {
      for (const listener of this.peer?.frames ?? []) listener(frame);
    });
  }

  onFrame(listener: (frame: unknown) => void): () => void {
    this.frames.add(listener);
    return () => this.frames.delete(listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closes.add(listener);
    return () => this.closes.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closes) listener();
    for (const listener of this.peer?.closes ?? []) listener();
  }
}

function pair(): [PairTransport, PairTransport] {
  const left = new PairTransport();
  const right = new PairTransport();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

async function settled(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

class SerialBlockingRecoveryJournal implements DaemonWorkerRecoveryJournal {
  private readonly delegate = new MemoryDaemonWorkerRecoveryJournal();
  private tail: Promise<void> = Promise.resolve();
  private releaseCompleted!: () => void;
  readonly completedAppendStarted: Promise<void>;
  private readonly completedStarted: Promise<void>;

  constructor() {
    this.completedStarted = new Promise<void>((resolve) => {
      this.releaseCompleted = resolve;
    });
    this.completedAppendStarted = new Promise<void>((resolve) => {
      this.completedAppendStartedResolve = resolve;
    });
  }

  private completedAppendStartedResolve!: () => void;

  read(): Promise<readonly DaemonWorkerRecoveryRecord[]> {
    return this.tail.then(() => this.delegate.read());
  }

  append(input: DaemonWorkerRecoveryRecordInput): Promise<DaemonWorkerRecoveryRecord> {
    const operation = this.tail.then(async () => {
      if (input.status === "completed") {
        this.completedAppendStartedResolve();
        await this.completedStarted;
      }
      return this.delegate.append(input);
    });
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  releaseTerminal(): void {
    this.releaseCompleted();
  }
}

describe("daemon worker recovery", () => {
  const servers: DaemonWorkerServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("resolves an activation as uncertain after restart instead of replaying it", async () => {
    const leases = new MemoryExecutionLeaseStore({ createLeaseId: () => "lease-1" });
    const claimed = await leases.claim({
      runId: "run-1",
      ownerId: "host",
      acquisitionId: "claim-1",
      ttlMs: 10_000,
    });
    if (claimed.status !== "acquired") throw new Error("expected lease");
    const journal = new MemoryDaemonWorkerRecoveryJournal();
    const [firstClientTransport, firstServerTransport] = pair();
    let firstInvocations = 0;
    const first = new DaemonWorkerServer({
      runId: "run-1",
      workerId: "worker-1",
      transport: firstServerTransport,
      leaseStoreFactory: { open: async () => leases },
      recoveryJournal: journal,
      cancelGraceMs: 10,
      runner: {
        activate: async () => {
          firstInvocations += 1;
          return new Promise(() => undefined);
        },
      },
    });
    servers.push(first);
    first.start();
    const firstClient = new DaemonWorkerClient({
      runId: "run-1",
      workerId: "worker-1",
      lease: { runId: "run-1", leasePath: "/unused", fencingToken: claimed.lease.fencingToken },
      transport: firstClientTransport,
      cancelGraceMs: 10,
    });
    await firstClient.initialize();
    const pending = firstClient.activate({ activationId: "activation-1", wakes: [] });
    await settled();
    await first.close("simulated worker crash");
    await expect(pending).resolves.toMatchObject({ status: "uncertain" });
    expect(firstInvocations).toBe(1);

    const [secondClientTransport, secondServerTransport] = pair();
    let secondInvocations = 0;
    const second = new DaemonWorkerServer({
      runId: "run-1",
      workerId: "worker-1",
      transport: secondServerTransport,
      leaseStoreFactory: { open: async () => leases },
      recoveryJournal: journal,
      runner: {
        activate: async () => {
          secondInvocations += 1;
          return { status: "completed" };
        },
      },
    });
    servers.push(second);
    second.start();
    const secondClient = new DaemonWorkerClient({
      runId: "run-1",
      workerId: "worker-1",
      lease: { runId: "run-1", leasePath: "/unused", fencingToken: claimed.lease.fencingToken },
      transport: secondClientTransport,
    });
    await secondClient.initialize();
    await expect(secondClient.activate({ activationId: "activation-1", wakes: [] })).resolves.toMatchObject({
      status: "uncertain",
    });
    expect(secondInvocations).toBe(0);
    await second.close();
  });

  it("replays a durable terminal result after restart without invoking the runner", async () => {
    const leases = new MemoryExecutionLeaseStore({ createLeaseId: () => "lease-1" });
    const claimed = await leases.claim({
      runId: "run-1",
      ownerId: "host",
      acquisitionId: "claim-1",
      ttlMs: 10_000,
    });
    if (claimed.status !== "acquired") throw new Error("expected lease");
    const journal = new MemoryDaemonWorkerRecoveryJournal();
    const [firstClientTransport, firstServerTransport] = pair();
    let invocations = 0;
    const first = new DaemonWorkerServer({
      runId: "run-1",
      workerId: "worker-1",
      transport: firstServerTransport,
      leaseStoreFactory: { open: async () => leases },
      recoveryJournal: journal,
      runner: {
        activate: async () => {
          invocations += 1;
          return { status: "completed" };
        },
      },
    });
    servers.push(first);
    first.start();
    const firstClient = new DaemonWorkerClient({
      runId: "run-1",
      workerId: "worker-1",
      lease: { runId: "run-1", leasePath: "/unused", fencingToken: claimed.lease.fencingToken },
      transport: firstClientTransport,
    });
    await firstClient.initialize();
    await expect(firstClient.activate({ activationId: "activation-1", wakes: [] })).resolves.toMatchObject({
      status: "completed",
    });
    await first.close();

    const [secondClientTransport, secondServerTransport] = pair();
    const second = new DaemonWorkerServer({
      runId: "run-1",
      workerId: "worker-1",
      transport: secondServerTransport,
      leaseStoreFactory: { open: async () => leases },
      recoveryJournal: journal,
      runner: {
        activate: async () => {
          invocations += 1;
          return { status: "failed", error: "must not run" };
        },
      },
    });
    servers.push(second);
    second.start();
    const secondClient = new DaemonWorkerClient({
      runId: "run-1",
      workerId: "worker-1",
      lease: { runId: "run-1", leasePath: "/unused", fencingToken: claimed.lease.fencingToken },
      transport: secondClientTransport,
    });
    await secondClient.initialize();
    await expect(secondClient.activate({ activationId: "activation-1", wakes: [] })).resolves.toMatchObject({
      status: "completed",
    });
    expect(invocations).toBe(1);
    await second.close();
  });

  it("does not admit an activation after close wins an in-flight accepted write", async () => {
    const leases = new MemoryExecutionLeaseStore({ createLeaseId: () => "lease-1" });
    const claimed = await leases.claim({
      runId: "run-1",
      ownerId: "host",
      acquisitionId: "claim-1",
      ttlMs: 10_000,
    });
    if (claimed.status !== "acquired") throw new Error("expected lease");
    const delegate = new MemoryDaemonWorkerRecoveryJournal();
    let releaseAccepted!: () => void;
    let acceptedStartedResolve!: () => void;
    const acceptedStarted = new Promise<void>((resolve) => { acceptedStartedResolve = resolve; });
    let acceptedReleased = false;
    const journal: DaemonWorkerRecoveryJournal = {
      read: () => delegate.read(),
      append: (input) => {
        if (input.status === "accepted" && !acceptedReleased) {
          acceptedStartedResolve();
          return new Promise<DaemonWorkerRecoveryRecord>((resolve, reject) => {
            releaseAccepted = () => {
              acceptedReleased = true;
              void delegate.append(input).then(resolve, reject);
            };
          });
        }
        return delegate.append(input);
      },
    };
    const [clientTransport, serverTransport] = pair();
    let invocations = 0;
    const server = new DaemonWorkerServer({
      runId: "run-1",
      workerId: "worker-1",
      transport: serverTransport,
      leaseStoreFactory: { open: async () => leases },
      recoveryJournal: journal,
      cancelGraceMs: 10,
      runner: {
        activate: async () => {
          invocations += 1;
          return { status: "completed" };
        },
      },
    });
    server.start();
    const client = new DaemonWorkerClient({
      runId: "run-1",
      workerId: "worker-1",
      lease: { runId: "run-1", leasePath: "/unused", fencingToken: claimed.lease.fencingToken },
      transport: clientTransport,
      cancelGraceMs: 10,
    });
    await client.initialize();
    const activation = client.activate({ activationId: "activation-race", wakes: [] });
    await acceptedStarted;
    await server.close("admission race");
    releaseAccepted();
    await expect(activation).resolves.toMatchObject({ status: "uncertain" });
    expect(invocations).toBe(0);
    expect((await delegate.read()).map((record) => record.status)).toEqual(["accepted"]);
    await client.close();
  });

  it("does not overwrite an in-flight terminal journal write with interrupted", async () => {
    const leases = new MemoryExecutionLeaseStore({ createLeaseId: () => "lease-1" });
    const claimed = await leases.claim({
      runId: "run-1",
      ownerId: "host",
      acquisitionId: "claim-1",
      ttlMs: 10_000,
    });
    if (claimed.status !== "acquired") throw new Error("expected lease");
    const journal = new SerialBlockingRecoveryJournal();
    const [clientTransport, serverTransport] = pair();
    const server = new DaemonWorkerServer({
      runId: "run-1",
      workerId: "worker-1",
      transport: serverTransport,
      leaseStoreFactory: { open: async () => leases },
      recoveryJournal: journal,
      cancelGraceMs: 10,
      runner: { activate: async () => ({ status: "completed" }) },
    });
    server.start();
    const client = new DaemonWorkerClient({
      runId: "run-1",
      workerId: "worker-1",
      lease: { runId: "run-1", leasePath: "/unused", fencingToken: claimed.lease.fencingToken },
      transport: clientTransport,
      cancelGraceMs: 10,
    });
    await client.initialize();
    const activation = client.activate({ activationId: "terminal-race", wakes: [] });
    await journal.completedAppendStarted;
    const closing = server.close("terminal race");
    journal.releaseTerminal();
    await closing;
    await expect(activation).resolves.toMatchObject({ status: "completed" });
    expect((await journal.read()).map((record) => record.status)).toEqual([
      "accepted",
      "started",
      "completed",
    ]);
    await client.close();
  });
});
