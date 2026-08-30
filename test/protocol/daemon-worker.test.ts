import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DaemonWorkerClient,
  DaemonWorkerProtocolError,
  DaemonWorkerServer,
  MemoryExecutionLeaseStore,
  FileExecutionLeaseStore,
  decodeDaemonWorkerFrame,
  encodeDaemonWorkerFrame,
  spawnDaemonWorker,
  FileDaemonWorkerDescriptorPublisher,
  readDaemonWorkerDescriptor,
} from "../../src/runtime/index.js";
import type { DaemonWorkerFrame, DaemonWorkerTransport } from "../../src/runtime/index.js";

class PairTransport implements DaemonWorkerTransport {
  peer?: PairTransport;
  private readonly frames = new Set<(frame: unknown) => void>();
  private readonly closes = new Set<(error?: Error) => void>();
  private closed = false;

  send(frame: unknown): void {
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

class FakeTransport implements DaemonWorkerTransport {
  readonly sent: DaemonWorkerFrame[] = [];
  private readonly frames = new Set<(frame: unknown) => void>();
  private readonly closes = new Set<(error?: Error) => void>();
  private closed = false;

  constructor(
    private readonly sendHandler: (frame: DaemonWorkerFrame, transport: FakeTransport) => void | Promise<void>,
  ) {}

  send(frame: DaemonWorkerFrame): void | Promise<void> {
    if (this.closed) throw new Error("closed");
    this.sent.push(frame);
    return this.sendHandler(frame, this);
  }

  onFrame(listener: (frame: unknown) => void): () => void {
    this.frames.add(listener);
    return () => this.frames.delete(listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closes.add(listener);
    return () => this.closes.delete(listener);
  }

  emit(frame: DaemonWorkerFrame): void {
    for (const listener of this.frames) listener(frame);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closes) listener();
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

describe("daemon worker protocol", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("round-trips bounded JSONL frames and rejects oversized payloads", () => {
    const frame: DaemonWorkerFrame = {
      kind: "drain",
      version: 1,
      commandId: "command-1",
      runId: "run-1",
    };
    expect(decodeDaemonWorkerFrame(encodeDaemonWorkerFrame(frame))).toEqual(frame);
    expect(() => encodeDaemonWorkerFrame({
      ...frame,
      commandId: "x".repeat(100),
    }, 32)).toThrow(DaemonWorkerProtocolError);
  });

  it("performs initialize, activation, duplicate replay, and fencing in-process", async () => {
    const [clientTransport, serverTransport] = pair();
    const leases = new MemoryExecutionLeaseStore({ createLeaseId: () => "lease-1" });
    const claimed = await leases.claim({ runId: "run-1", ownerId: "host", acquisitionId: "claim-1", ttlMs: 10_000 });
    if (claimed.status !== "acquired") throw new Error("expected lease");
    const commits: string[] = [];
    const server = new DaemonWorkerServer({
      runId: "run-1",
      workerId: "worker-1",
      transport: serverTransport,
      leaseStoreFactory: { open: async () => leases },
      runner: {
        activate: async ({ commitLease }) => {
          await commitLease(async () => {
            commits.push("one");
          });
          return { status: "completed" };
        },
      },
      createInstanceToken: () => "instance-1",
    });
    server.start();
    const client = new DaemonWorkerClient({
      runId: "run-1",
      workerId: "worker-1",
      lease: { runId: "run-1", leasePath: "/unused", fencingToken: claimed.lease.fencingToken },
      transport: clientTransport,
      createCommandId: (() => {
        let index = 0;
        return () => `command-${++index}`;
      })(),
    });

    await expect(client.initialize()).resolves.toMatchObject({ lifecycle: "ready", initialized: true });
    const first = client.activate({ activationId: "activation-1", wakes: [] });
    const duplicate = client.activate({ activationId: "activation-1", wakes: [] });
    await expect(first).resolves.toMatchObject({ status: "completed" });
    await expect(duplicate).resolves.toMatchObject({ status: "completed" });
    expect(commits).toEqual(["one"]);
    await client.shutdown();
  });

  it("does not invoke a runner after its initialized lease is fenced", async () => {
    const [clientTransport, serverTransport] = pair();
    let leaseSequence = 0;
    const leases = new MemoryExecutionLeaseStore({
      createLeaseId: () => `lease-${++leaseSequence}`,
    });
    const claimed = await leases.claim({
      runId: "run-1",
      ownerId: "host",
      acquisitionId: "claim-1",
      ttlMs: 10_000,
    });
    if (claimed.status !== "acquired") throw new Error("expected lease");
    let invoked = false;
    const server = new DaemonWorkerServer({
      runId: "run-1",
      workerId: "worker-1",
      transport: serverTransport,
      leaseStoreFactory: { open: async () => leases },
      runner: {
        activate: async () => {
          invoked = true;
          return { status: "completed" };
        },
      },
    });
    server.start();
    const client = new DaemonWorkerClient({
      runId: "run-1",
      workerId: "worker-1",
      lease: {
        runId: "run-1",
        leasePath: "/unused",
        fencingToken: claimed.lease.fencingToken,
      },
      transport: clientTransport,
    });

    await client.initialize();
    await leases.release({
      runId: claimed.lease.runId,
      ownerId: claimed.lease.ownerId,
      leaseId: claimed.lease.leaseId,
      fencingToken: claimed.lease.fencingToken,
      commandId: "release-1",
    });
    const successor = await leases.claim({
      runId: "run-1",
      ownerId: "successor",
      acquisitionId: "claim-2",
      ttlMs: 10_000,
    });
    if (successor.status !== "acquired") throw new Error("expected successor lease");

    await expect(client.activate({ activationId: "fenced-activation", wakes: [] }))
      .resolves.toMatchObject({
        status: "cancelled",
        error: { message: expect.stringContaining("no longer current") },
      });
    expect(invoked).toBe(false);

    await client.shutdown();
  });

  it("returns uncertain when transport closes during an activation", async () => {
    const [clientTransport, serverTransport] = pair();
    const leases = new MemoryExecutionLeaseStore({ createLeaseId: () => "lease-1" });
    const claimed = await leases.claim({ runId: "run-1", ownerId: "host", acquisitionId: "claim-1", ttlMs: 10_000 });
    if (claimed.status !== "acquired") throw new Error("expected lease");
    let release!: () => void;
    const server = new DaemonWorkerServer({
      runId: "run-1",
      workerId: "worker-1",
      transport: serverTransport,
      leaseStoreFactory: { open: async () => leases },
      runner: { activate: async () => new Promise(() => undefined) },
    });
    server.start();
    const client = new DaemonWorkerClient({
      runId: "run-1",
      workerId: "worker-1",
      lease: { runId: "run-1", leasePath: "/unused", fencingToken: claimed.lease.fencingToken },
      transport: clientTransport,
      activationTimeoutMs: 5_000,
    });
    await client.initialize();
    const activation = client.activate({ activationId: "activation-1", wakes: [] });
    await settled();
    clientTransport.close();
    await expect(activation).resolves.toMatchObject({ status: "uncertain" });
    await server.close();
    void release;
  });

  it("settles an activation deadline even when transport send never resolves", async () => {
    const transport = new FakeTransport((frame, current) => {
      if (frame.kind === "initialize") {
        queueMicrotask(() => current.emit({
          kind: "ready",
          version: 1,
          commandId: frame.commandId,
          runId: "run-1",
          workerId: "worker-1",
          instanceToken: "instance-1",
        }));
      } else if (frame.kind === "activate") {
        return new Promise<void>(() => undefined);
      }
    });
    const client = new DaemonWorkerClient({
      runId: "run-1",
      workerId: "worker-1",
      lease: { runId: "run-1", leasePath: "/unused", fencingToken: 1 },
      transport,
      activationTimeoutMs: 20,
    });

    const activation = client.activate({ activationId: "activation-1", wakes: [] });
    const deadline = Symbol("test deadline");
    const result = await Promise.race([
      activation,
      new Promise<typeof deadline>((resolve) => setTimeout(() => resolve(deadline), 250)),
    ]);
    expect(result).not.toBe(deadline);
    if (result === deadline) throw new Error("activation did not settle before the test deadline");
    expect(result).toMatchObject({
      status: "uncertain",
      error: { code: "activation_timeout" },
    });
    await client.close();
  });

  it("rejects a generated command ID collision without replacing the pending command", async () => {
    const transport = new FakeTransport((frame, current) => {
      if (frame.kind === "initialize") {
        queueMicrotask(() => current.emit({
          kind: "ready",
          version: 1,
          commandId: frame.commandId,
          runId: "run-1",
          workerId: "worker-1",
          instanceToken: "instance-1",
        }));
      }
    });
    const client = new DaemonWorkerClient({
      runId: "run-1",
      workerId: "worker-1",
      lease: { runId: "run-1", leasePath: "/unused", fencingToken: 1 },
      transport,
      createCommandId: () => "duplicate-command",
    });

    await client.initialize();
    const firstDrain = client.drain();
    await settled();
    await expect(client.drain()).rejects.toMatchObject({ code: "command_conflict" });
    const drainFrame = transport.sent.find((frame) => frame.kind === "drain");
    expect(drainFrame).toBeDefined();
    if (drainFrame === undefined || drainFrame.kind !== "drain") {
      throw new Error("expected a pending drain frame");
    }
    transport.emit({
      kind: "command.result",
      version: 1,
      commandId: drainFrame.commandId,
      runId: "run-1",
      command: "drain",
      status: "ok",
      lifecycle: "draining",
    });
    await expect(firstDrain).resolves.toMatchObject({ lifecycle: "draining" });
    await client.close();
  });

  it("cooperatively cancels a running activation within the worker grace period", async () => {
    const [clientTransport, serverTransport] = pair();
    const leases = new MemoryExecutionLeaseStore({ createLeaseId: () => "lease-1" });
    const claimed = await leases.claim({ runId: "run-1", ownerId: "host", acquisitionId: "claim-1", ttlMs: 10_000 });
    if (claimed.status !== "acquired") throw new Error("expected lease");
    const server = new DaemonWorkerServer({
      runId: "run-1",
      workerId: "worker-1",
      transport: serverTransport,
      leaseStoreFactory: { open: async () => leases },
      cancelGraceMs: 100,
      runner: {
        activate: async ({ signal }) => {
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { status: "cancelled", error: "cancelled" };
        },
      },
    });
    server.start();
    const client = new DaemonWorkerClient({
      runId: "run-1",
      workerId: "worker-1",
      lease: { runId: "run-1", leasePath: "/unused", fencingToken: claimed.lease.fencingToken },
      transport: clientTransport,
    });
    await client.initialize();
    const activation = client.activate({ activationId: "activation-1", wakes: [] });
    await settled();
    await client.cancel("activation-1");
    await expect(activation).resolves.toMatchObject({ status: "cancelled" });
    await client.shutdown();
  });

  it("settles an activation when the worker rejects its command", async () => {
    const [clientTransport, serverTransport] = pair();
    const leases = new MemoryExecutionLeaseStore({ createLeaseId: () => "lease-1" });
    const claimed = await leases.claim({ runId: "run-1", ownerId: "host", acquisitionId: "claim-1", ttlMs: 10_000 });
    if (claimed.status !== "acquired") throw new Error("expected lease");
    const server = new DaemonWorkerServer({
      runId: "run-1",
      workerId: "worker-1",
      transport: serverTransport,
      leaseStoreFactory: { open: async () => leases },
      runner: { activate: async () => ({ status: "completed" }) },
    });
    server.start();
    const client = new DaemonWorkerClient({
      runId: "run-1",
      workerId: "worker-1",
      lease: { runId: "run-1", leasePath: "/unused", fencingToken: claimed.lease.fencingToken },
      transport: clientTransport,
    });
    await client.initialize();
    await client.drain();
    await expect(client.activate({ activationId: "activation-1", wakes: [] })).resolves.toMatchObject({
      status: "failed",
      error: { code: "draining" },
    });
    await client.shutdown();
  });

  it("uses a real spawned Node worker over stdio", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-worker-process-"));
    roots.push(root);
    const leasePath = join(root, "leases.json");
    const leases = await FileExecutionLeaseStore.open(leasePath, { createLeaseId: () => "lease-parent" });
    const claimed = await leases.claim({ runId: "run-1", ownerId: "host", acquisitionId: "claim-1", ttlMs: 10_000 });
    if (claimed.status !== "acquired") throw new Error("expected lease");
    const script = [
      "import { runDaemonWorkerStdioServer } from './src/runtime/daemon-worker-server.ts';",
      "runDaemonWorkerStdioServer({ runId: 'run-1', workerId: 'worker-1', runner: { activate: async ({ assertLease }) => { await assertLease(); return { status: 'completed' }; } } });",
    ].join(" ");
    const worker = spawnDaemonWorker({
      runId: "run-1",
      workerId: "worker-1",
      lease: { runId: "run-1", leasePath, fencingToken: claimed.lease.fencingToken },
      args: ["--import", "tsx", "--input-type=module", "-e", script],
      cwd: process.cwd(),
      env: process.env,
    });
    await expect(worker.initialize()).resolves.toMatchObject({ lifecycle: "ready" });
    await expect(worker.client.activate({ activationId: "activation-1", wakes: [] })).resolves.toMatchObject({ status: "completed" });
    await worker.client.shutdown();
    await leases.release({
      runId: claimed.lease.runId,
      ownerId: claimed.lease.ownerId,
      leaseId: claimed.lease.leaseId,
      fencingToken: claimed.lease.fencingToken,
      commandId: "release-1",
    });
    const descriptor = await readFile(leasePath, "utf8");
    expect(descriptor).toContain('"version":1');
  });

  it("publishes and clears descriptors atomically by instance token", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-worker-descriptor-"));
    roots.push(root);
    const publisher = new FileDaemonWorkerDescriptorPublisher(join(root, "worker.json"));
    const descriptor = {
      version: 1 as const,
      runId: "run-1",
      workerId: "worker-1",
      leasePath: join(root, "leases.json"),
      fencingToken: 1,
      instanceToken: "instance-1",
      publishedAt: "2026-08-31T00:00:00.000Z",
    };
    await publisher.publish(descriptor);
    await expect(readDaemonWorkerDescriptor(publisher.path)).resolves.toEqual(descriptor);
    await publisher.clear("wrong-instance");
    await expect(readDaemonWorkerDescriptor(publisher.path)).resolves.toEqual(descriptor);
    await publisher.clear("instance-1");
    await expect(readDaemonWorkerDescriptor(publisher.path)).resolves.toBeUndefined();
  });
});
