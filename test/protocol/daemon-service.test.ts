import { readFile, lstat, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DAEMON_SERVICE_DESCRIPTOR_VERSION,
  DaemonServiceManager,
  type DaemonServiceChildExit,
  type DaemonServiceDependencies,
  type DaemonServiceDescriptor,
  type DaemonServiceManagerOptions,
  type DaemonServiceProcessObservation,
  type DaemonServiceSignalRequest,
  type DaemonServiceSocketIdentity,
  type DaemonServiceSpawnRequest,
} from "../../src/runtime/daemon-service.js";
import {
  DAEMON_SERVICE_PROBE_VERSION,
  type DaemonServiceProbeRequest,
  type DaemonServiceProbeTransportResult,
} from "../../src/runtime/daemon-service-probe.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

class FakeServiceHost {
  readonly processes = new Map<number, string>([[process.pid, "manager-process-start"]]);
  readonly children = new Map<number, Deferred<DaemonServiceChildExit>>();
  readonly spawnRequests: DaemonServiceSpawnRequest[] = [];
  readonly signalRequests: DaemonServiceSignalRequest[] = [];
  readonly shutdownRequests: DaemonServiceProbeRequest[] = [];
  nextPid = 4_000;
  probe: (request: DaemonServiceProbeRequest) => Promise<DaemonServiceProbeTransportResult> =
    async (request) => readyProbe(request);
  inspect: (pid: number) => Promise<DaemonServiceProcessObservation> = async (pid) => {
    const processStartId = this.processes.get(pid);
    return processStartId === undefined
      ? { status: "missing" }
      : { status: "running", processStartId };
  };
  shutdown: (request: DaemonServiceProbeRequest) => Promise<void> = async () => undefined;
  signal: (request: DaemonServiceSignalRequest) => Promise<void> = async (request) => {
    if (request.signal === "SIGKILL") this.exit(request.identity.pid, { code: null, signal: "SIGKILL" });
  };

  readonly dependencies: DaemonServiceDependencies = {
    spawn: async (request) => {
      this.spawnRequests.push(request);
      const pid = this.nextPid++;
      this.processes.set(pid, `process-start-${pid}`);
      const child = deferred<DaemonServiceChildExit>();
      this.children.set(pid, child);
      return { pid, exited: child.promise };
    },
    inspectProcess: async (pid) => this.inspect(pid),
    probe: async (request) => this.probe(request),
    requestShutdown: async ({ probe }) => {
      this.shutdownRequests.push(probe);
      await this.shutdown(probe);
    },
    signal: async (request) => {
      this.signalRequests.push(request);
      await this.signal(request);
    },
  };

  exit(pid: number, receipt: DaemonServiceChildExit): void {
    this.processes.delete(pid);
    this.children.get(pid)?.resolve(receipt);
  }

  failObserver(pid: number, error: unknown): void {
    this.children.get(pid)?.reject(error);
  }
}

async function serviceOptions(
  host: FakeServiceHost,
  overrides: Partial<DaemonServiceManagerOptions> = {},
): Promise<DaemonServiceManagerOptions> {
  const stateDirectory = await mkdtemp(join(tmpdir(), "nausicaa-daemon-service-"));
  roots.push(stateDirectory);
  return {
    stateDirectory,
    socketPath: join(stateDirectory, "daemon.sock"),
    executable: "/explicit/nausicaa-daemon",
    argv: ["--service", "literal $(no-shell)"],
    controlProtocolVersion: 1,
    dependencies: host.dependencies,
    readyTimeoutMs: 80,
    probeTimeoutMs: 20,
    pollIntervalMs: 2,
    gracefulTimeoutMs: 12,
    termTimeoutMs: 12,
    killTimeoutMs: 12,
    lockTimeoutMs: 200,
    ...overrides,
  };
}

async function openService(
  host: FakeServiceHost,
  overrides: Partial<DaemonServiceManagerOptions> = {},
): Promise<DaemonServiceManager> {
  return DaemonServiceManager.open(await serviceOptions(host, overrides));
}

function readyProbe(request: DaemonServiceProbeRequest): DaemonServiceProbeTransportResult {
  return {
    status: "response",
    response: {
      version: DAEMON_SERVICE_PROBE_VERSION,
      controlProtocolVersion: request.controlProtocolVersion,
      instanceToken: request.instanceToken,
      state: "ready",
    },
  };
}

async function readDescriptor(manager: DaemonServiceManager): Promise<DaemonServiceDescriptor> {
  return JSON.parse(await readFile(manager.descriptorPath, "utf8")) as DaemonServiceDescriptor;
}

async function eventually(
  assertion: () => Promise<void>,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error: unknown) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  throw lastError;
}

describe("detached daemon service lifecycle", () => {
  it("publishes one complete 0600 descriptor in a 0700 directory before probing", async () => {
    const host = new FakeServiceHost();
    const options = await serviceOptions(host);
    let observed: DaemonServiceDescriptor | undefined;
    host.probe = async (request) => {
      observed = JSON.parse(await readFile(
        join(options.stateDirectory, "daemon-service.json"),
        "utf8",
      )) as DaemonServiceDescriptor;
      return readyProbe(request);
    };
    const manager = await DaemonServiceManager.open(options);

    await expect(manager.start()).resolves.toMatchObject({ state: "ready", pid: 4_000 });

    expect(observed).toMatchObject({
      version: DAEMON_SERVICE_DESCRIPTOR_VERSION,
      probeVersion: DAEMON_SERVICE_PROBE_VERSION,
      state: "starting",
      pid: 4_000,
      processStartId: "process-start-4000",
      controlProtocolVersion: 1,
      socketPath: manager.socketPath,
    });
    expect(observed?.instanceToken).toEqual(expect.any(String));
    expect((await stat(manager.stateDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(manager.descriptorPath)).mode & 0o777).toBe(0o600);
    expect(host.spawnRequests[0]).toMatchObject({
      executable: "/explicit/nausicaa-daemon",
      argv: ["--service", "literal $(no-shell)"],
      detached: true,
    });
  });

  it("serializes concurrent starts across managers and has one spawn winner", async () => {
    const host = new FakeServiceHost();
    const options = await serviceOptions(host);
    let tokenOrdinal = 0;
    const shared = {
      ...options,
      createInstanceToken: () => `instance-token-${++tokenOrdinal}`,
    };
    const first = await DaemonServiceManager.open(shared);
    const second = await DaemonServiceManager.open(shared);

    const [left, right] = await Promise.all([first.start(), second.start()]);

    expect(left.state).toBe("ready");
    expect(right.state).toBe("ready");
    expect(host.spawnRequests).toHaveLength(1);
    expect((left as { pid: number }).pid).toBe((right as { pid: number }).pid);
  });

  it("returns an already-ready service idempotently after an identity-bound probe", async () => {
    const host = new FakeServiceHost();
    const options = await serviceOptions(host);
    const first = await DaemonServiceManager.open(options);
    expect((await first.start()).state).toBe("ready");
    const descriptor = await readDescriptor(first);
    const second = await DaemonServiceManager.open(options);

    const status = await second.start();

    expect(status).toMatchObject({ state: "ready", pid: descriptor.pid });
    expect(host.spawnRequests).toHaveLength(1);
  });

  it("projects starting, ready, draining, failed, stale, and stopped states", async () => {
    const host = new FakeServiceHost();
    const probeGate = deferred<DaemonServiceProbeTransportResult>();
    host.probe = async () => probeGate.promise;
    const manager = await openService(host, { probeTimeoutMs: 60, readyTimeoutMs: 100 });
    const start = manager.start();
    await eventually(async () => {
      expect((await manager.status()).state).toBe("starting");
    });
    const starting = await readDescriptor(manager);
    probeGate.resolve(readyProbe({
      version: DAEMON_SERVICE_PROBE_VERSION,
      controlProtocolVersion: 1,
      instanceToken: starting.instanceToken,
      socketPath: manager.socketPath,
      timeoutMs: 1,
    }));
    expect((await start).state).toBe("ready");
    expect((await manager.status()).state).toBe("ready");

    const shutdownGate = deferred<void>();
    host.shutdown = async () => shutdownGate.promise;
    const stop = manager.stop();
    await eventually(async () => {
      expect((await manager.status()).state).toBe("draining");
    });
    host.exit(starting.pid, { code: 0, signal: null });
    shutdownGate.resolve();
    expect((await stop).state).toBe("stopped");
    expect((await manager.status()).state).toBe("stopped");

    host.probe = async () => ({ status: "unavailable" });
    const failed = await manager.start();
    expect(failed).toMatchObject({ state: "failed", error: { code: "ready_timeout" } });
    expect((await manager.status()).state).toBe("failed");
    const failedDescriptor = await readDescriptor(manager);
    await writeFile(manager.descriptorPath, `${JSON.stringify({
      ...failedDescriptor,
      state: "ready",
      failure: undefined,
    }, (_key, value) => value === undefined ? undefined : value)}\n`, { mode: 0o600 });
    expect((await manager.status()).state).toBe("stale");
    await manager.close();
  });

  it("detects PID reuse and never signals the replacement", async () => {
    const host = new FakeServiceHost();
    const manager = await openService(host);
    const ready = await manager.start();
    expect(ready.state).toBe("ready");
    const descriptor = await readDescriptor(manager);
    host.processes.set(descriptor.pid, "reused-process-start");

    await expect(manager.status()).resolves.toMatchObject({
      state: "stale",
      reason: "process_identity_changed",
    });
    await expect(manager.stop()).resolves.toEqual({ state: "stopped" });
    expect(host.signalRequests).toEqual([]);
    await expect(readFile(manager.descriptorPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a replacement descriptor that wins stale cleanup", async () => {
    const host = new FakeServiceHost();
    const manager = await openService(host);
    await manager.start();
    const stale = await readDescriptor(manager);
    host.processes.delete(stale.pid);
    let replaced = false;
    host.inspect = async (pid) => {
      if (pid === stale.pid && !replaced) {
        replaced = true;
        await writeFile(manager.descriptorPath, `${JSON.stringify({
          ...stale,
          pid: 8_888,
          processStartId: "replacement-process-start",
          instanceToken: "replacement-instance-token",
        })}\n`, { mode: 0o600 });
      }
      const processStartId = host.processes.get(pid);
      return processStartId === undefined
        ? { status: "missing" }
        : { status: "running", processStartId };
    };

    await expect(manager.start()).resolves.toMatchObject({
      state: "failed",
      error: { code: "descriptor_replaced" },
    });
    expect((await readDescriptor(manager)).instanceToken).toBe("replacement-instance-token");
    expect(host.spawnRequests).toHaveLength(1);
  });

  it("removes only an identity-bound stale socket after an explicit unavailable probe", async () => {
    const host = new FakeServiceHost();
    const socketIdentity: DaemonServiceSocketIdentity = { device: "1", inode: "42", mode: 0o140600 };
    let socketPresent = true;
    const manager = await openService(host, {
      dependencies: {
        ...host.dependencies,
        inspectSocket: async () => socketPresent
          ? { status: "socket", identity: socketIdentity }
          : { status: "absent" },
        removeSocket: async (_path, expected) => {
          if (!socketPresent) return "absent";
          if (expected !== socketIdentity) return "replaced";
          socketPresent = false;
          return "removed";
        },
      },
    });
    socketPresent = false;
    await manager.start();
    const old = await readDescriptor(manager);
    socketPresent = true;
    host.processes.delete(old.pid);
    host.probe = async (request) => request.instanceToken === old.instanceToken
      ? { status: "unavailable" }
      : readyProbe(request);

    await expect(manager.start()).resolves.toMatchObject({ state: "ready", pid: 4_001 });
    expect(host.spawnRequests).toHaveLength(2);
    expect(socketPresent).toBe(false);
  });

  it("refuses to remove a socket which proves a live replacement identity", async () => {
    const host = new FakeServiceHost();
    const socketIdentity: DaemonServiceSocketIdentity = { device: "1", inode: "43", mode: 0o140600 };
    let socketPresent = false;
    const manager = await openService(host, {
      dependencies: {
        ...host.dependencies,
        inspectSocket: async () => socketPresent
          ? { status: "socket", identity: socketIdentity }
          : { status: "absent" },
        removeSocket: async () => {
          socketPresent = false;
          return "removed";
        },
      },
    });
    await manager.start();
    const old = await readDescriptor(manager);
    socketPresent = true;
    host.processes.delete(old.pid);
    host.probe = async (request) => ({
      status: "response",
      response: {
        version: DAEMON_SERVICE_PROBE_VERSION,
        controlProtocolVersion: request.controlProtocolVersion,
        instanceToken: "different-live-instance",
        state: "ready",
      },
    });

    await expect(manager.start()).resolves.toMatchObject({
      state: "failed",
      error: { code: "live_replacement" },
    });
    expect(socketPresent).toBe(true);
    expect(host.spawnRequests).toHaveLength(1);
  });

  it("fails closed on malformed descriptors and ordinary socket paths", async () => {
    const malformedHost = new FakeServiceHost();
    const malformed = await openService(malformedHost);
    await writeFile(malformed.descriptorPath, "not-json\n", { mode: 0o600 });

    await expect(malformed.status()).resolves.toMatchObject({
      state: "failed",
      error: { code: "malformed_descriptor" },
    });
    await expect(malformed.start()).resolves.toMatchObject({ state: "failed" });
    expect(malformedHost.spawnRequests).toEqual([]);

    const pathHost = new FakeServiceHost();
    const ordinary = await openService(pathHost);
    await writeFile(ordinary.socketPath, "do not delete\n", { mode: 0o600 });
    await expect(ordinary.start()).resolves.toMatchObject({
      state: "failed",
      error: { code: "unsafe_socket_path" },
    });
    expect(await readFile(ordinary.socketPath, "utf8")).toBe("do not delete\n");
    expect(pathHost.spawnRequests).toEqual([]);
  });

  it("bounds a ready timeout, records failure, and terminates the failed child", async () => {
    const host = new FakeServiceHost();
    host.probe = async () => ({ status: "unavailable" });
    const manager = await openService(host, { readyTimeoutMs: 15, pollIntervalMs: 2 });

    const status = await manager.start();

    expect(status).toMatchObject({ state: "failed", error: { code: "ready_timeout" } });
    expect(host.signalRequests.map((request) => request.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect((await readDescriptor(manager)).state).toBe("failed");
  });

  it("rejects a ready response for another control protocol", async () => {
    const host = new FakeServiceHost();
    host.probe = async (request) => ({
      status: "response",
      response: {
        version: DAEMON_SERVICE_PROBE_VERSION,
        controlProtocolVersion: request.controlProtocolVersion + 1,
        instanceToken: request.instanceToken,
        state: "ready",
      },
    });
    const manager = await openService(host);

    await expect(manager.start()).resolves.toMatchObject({
      state: "failed",
      error: { code: "probe_mismatch" },
    });
    expect(host.spawnRequests).toHaveLength(1);
  });

  it("requests graceful shutdown then uses bounded TERM and KILL with full identity", async () => {
    const host = new FakeServiceHost();
    const manager = await openService(host);
    await manager.start();
    const descriptor = await readDescriptor(manager);

    const stopped = await manager.stop();

    expect(stopped).toEqual({ state: "stopped" });
    expect(host.shutdownRequests).toHaveLength(1);
    expect(host.signalRequests).toEqual([
      {
        identity: {
          pid: descriptor.pid,
          processStartId: descriptor.processStartId,
          instanceToken: descriptor.instanceToken,
        },
        signal: "SIGTERM",
      },
      {
        identity: {
          pid: descriptor.pid,
          processStartId: descriptor.processStartId,
          instanceToken: descriptor.instanceToken,
        },
        signal: "SIGKILL",
      },
    ]);
  });

  it("stops an already stopped service and deduplicates concurrent stop and restart", async () => {
    const host = new FakeServiceHost();
    const manager = await openService(host);
    await expect(manager.stop()).resolves.toEqual({ state: "stopped" });
    await expect(manager.stop()).resolves.toEqual({ state: "stopped" });
    expect(host.signalRequests).toEqual([]);

    await manager.start();
    await Promise.all([manager.stop(), manager.stop()]);
    expect(host.signalRequests.filter((request) => request.signal === "SIGKILL")).toHaveLength(1);

    await manager.start();
    const [first, second] = await Promise.all([manager.restart(), manager.restart()]);
    expect(first.state).toBe("ready");
    expect(second.state).toBe("ready");
    expect(host.spawnRequests).toHaveLength(3);
  });

  it("redacts the instance token from bounded status errors", async () => {
    const host = new FakeServiceHost();
    const token = "top-secret-instance-token";
    host.probe = async () => ({ status: "error", error: new Error(`permission denied for ${token}`) });
    const manager = await openService(host, { createInstanceToken: () => token });

    const status = await manager.start();
    const serialized = JSON.stringify(status);

    expect(status).toMatchObject({ state: "failed", error: { code: "probe_failed" } });
    expect(serialized).not.toContain(token);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized.length).toBeLessThan(1_024);

    const descriptor = await readDescriptor(manager);
    await writeFile(manager.descriptorPath, `${JSON.stringify({
      ...descriptor,
      failure: { code: "probe_failed", message: `forged ${token} failure` },
    })}\n`, { mode: 0o600 });
    expect(JSON.stringify(await manager.status())).not.toContain(token);
  });

  it("isolates normal child exits and child observer errors as durable failed state", async () => {
    const normalHost = new FakeServiceHost();
    const normal = await openService(normalHost);
    await normal.start();
    const normalDescriptor = await readDescriptor(normal);
    normalHost.exit(normalDescriptor.pid, { code: 7, signal: null });
    await eventually(async () => {
      expect(await normal.status()).toMatchObject({
        state: "failed",
        error: { code: "child_exit" },
      });
    });

    const errorHost = new FakeServiceHost();
    const observed = await openService(errorHost);
    await observed.start();
    const observedDescriptor = await readDescriptor(observed);
    errorHost.failObserver(observedDescriptor.pid, new Error("observer transport failed"));
    await eventually(async () => {
      expect(await observed.status()).toMatchObject({
        state: "failed",
        error: { code: "child_observer_failed" },
      });
    });
  });

  it("clamps regressed wall-clock timestamps and closes idempotently", async () => {
    const host = new FakeServiceHost();
    const times = [
      new Date("2026-08-31T10:00:01.000Z"),
      new Date("2026-08-31T10:00:00.000Z"),
      new Date("2026-08-31T09:59:59.000Z"),
    ];
    const manager = await openService(host, {
      clock: { now: () => times.shift() ?? new Date("2026-08-31T09:59:58.000Z") },
    });
    await manager.start();
    const descriptor = await readDescriptor(manager);
    expect(descriptor.updatedAt).toBe(descriptor.startedAt);

    const first = manager.close();
    const second = manager.close();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    await expect(manager.start()).resolves.toMatchObject({
      state: "failed",
      error: { code: "manager_closed" },
    });
  });

  it("bounds close when a child observer never settles", async () => {
    const host = new FakeServiceHost();
    host.signal = async (request) => {
      if (request.signal === "SIGKILL") host.processes.delete(request.identity.pid);
    };
    const manager = await openService(host, { killTimeoutMs: 5, pollIntervalMs: 1 });
    await manager.start();

    await expect(Promise.race([
      manager.close().then(() => "closed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("unbounded"), 200)),
    ])).resolves.toBe("closed");
  });

  it("fails closed on process inspection permission errors without signaling by PID", async () => {
    const host = new FakeServiceHost();
    host.inspect = async (pid) => pid === process.pid
      ? { status: "running", processStartId: "manager-process-start" }
      : { status: "inaccessible", error: new Error("EPERM") };
    const manager = await openService(host);

    await expect(manager.start()).resolves.toMatchObject({
      state: "failed",
      error: { code: "identity_unverifiable" },
    });
    expect(host.signalRequests).toEqual([]);
  });
});
