import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DaemonActivationRequest,
  DaemonSessionFactory,
  DaemonSession,
  DaemonSupervisorWorkerClient,
  DaemonWorkerClientSnapshot,
} from "../../src/runtime/index.js";
import {
  createDaemonSessionActivator,
  DaemonRuntimeActivationError,
  MemoryExecutionLeaseStore,
  openDaemonRuntime,
} from "../../src/runtime/index.js";
import type { ArtifactRef } from "../../src/domain/index.js";
import type { ExecutionLease } from "../../src/runtime/execution-lease.js";
import { JsonlLedger, MemoryLedger, type Ledger } from "../../src/ledger/index.js";
import { sha256 } from "../../src/ledger/hash.js";

const runtimes: Array<{ stop(): Promise<unknown> }> = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function lease(): ExecutionLease {
  return {
    runId: "run-1",
    ownerId: "daemon-test",
    acquisitionId: "claim-1",
    leaseId: "lease-1",
    fencingToken: 1,
    acquiredAt: "2026-08-29T00:00:00.000Z",
    renewedAt: "2026-08-29T00:00:00.000Z",
    expiresAt: "2026-08-29T00:05:00.000Z",
  };
}

function activation(
  overrides: Partial<DaemonActivationRequest> = {},
): DaemonActivationRequest {
  return {
    runId: "run-1",
    activationId: "activation-1",
    wakes: [{ runId: "run-1", source: "system", dedupeKey: "wake-1" }],
    lease: lease(),
    signal: new AbortController().signal,
    commitLease: async <T>(operation: () => Promise<T>): Promise<T> => operation(),
    ...overrides,
  };
}

function payloadRef(content = "wake"): ArtifactRef {
  const contentHash = sha256(content);
  return {
    id: contentHash,
    contentHash,
    mediaType: "text/plain",
    byteLength: Buffer.byteLength(content),
  };
}

function sessionDouble(): DaemonSession & {
  reconcileExternalMessages: ReturnType<typeof vi.fn>;
  resumeCurrent: ReturnType<typeof vi.fn>;
  waitForIdle: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    reconcileExternalMessages: vi.fn(async () => undefined),
    resumeCurrent: vi.fn(async () => undefined),
    waitForIdle: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe("daemon runtime composition", () => {
  it("uses an explicitly injected supervisor without changing the default Host path", async () => {
    const ledger = new MemoryLedger();
    const admissionLedger: Ledger = {
      append: (event) => ledger.append(event),
      read: (options) => ledger.read(options),
      watermark: () => ledger.watermark(),
      flush: () => ledger.flush(),
      close: async () => undefined,
    };
    let initialized = 0;
    let activations = 0;
    let closed = 0;
    const runtime = await openDaemonRuntime({
      session: { workspace: "/workspace", dataDir: "/state", model: "scripted" },
      openLedger: async () => admissionLedger,
      supervisor: {
        createWorker: ({ runId, workerId }) => {
          let lifecycle: DaemonWorkerClientSnapshot["lifecycle"] = "starting";
          let isInitialized = false;
          const client: DaemonSupervisorWorkerClient = {
            get snapshot() {
              return {
                lifecycle,
                connected: lifecycle !== "stopped" && lifecycle !== "failed",
                initialized: isInitialized,
                runId,
                workerId,
                ...(isInitialized ? { instanceToken: `${workerId}:instance` } : {}),
                pendingActivations: 0,
              };
            },
            async initialize() {
              initialized += 1;
              isInitialized = true;
              lifecycle = "ready";
              return this.snapshot;
            },
            async activate(request) {
              activations += 1;
              return {
                activationId: request.activationId,
                runId,
                status: "completed",
              };
            },
            async drain() {
              lifecycle = "draining";
              return this.snapshot;
            },
            async close() {
              closed += 1;
              lifecycle = "stopped";
            },
          };
          return { client };
        },
      },
    });
    runtimes.push(runtime);

    expect(runtime.supervisor).toBeDefined();
    await runtime.start();
    await expect(runtime.host.wake({
      runId: "run-1",
      source: "system",
      dedupeKey: "supervisor-wake",
      payloadRef: payloadRef(),
    })).resolves.toMatchObject({ status: "queued" });
    await runtime.host.waitForIdle();

    expect(initialized).toBe(1);
    expect(activations).toBe(1);
    await expect(ledger.watermark()).resolves.toBe(1);
    await runtime.stop();
    expect(closed).toBe(1);
  });

  it("rejects an external worker process when the Host has no durable lease path", async () => {
    await expect(openDaemonRuntime({
      session: { workspace: "/workspace", dataDir: "/state", model: "scripted" },
      supervisor: {
        process: { args: ["worker-entry.mjs"] },
      },
    })).rejects.toThrow(/durable host\.leasePath/u);
  });

  it("activates the existing SessionController contract for one durable wake", async () => {
    const session = sessionDouble();
    const createSession = vi.fn<DaemonSessionFactory>(async () => session);
    const activate = createDaemonSessionActivator({
      session: {
        workspace: "/workspace",
        dataDir: "/state",
        model: "scripted",
        sessionId: "daemon-session",
      },
      createSession,
    });

    await activate(activation());

    expect(createSession).toHaveBeenCalledOnce();
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: "/workspace",
        dataDir: "/state",
        model: "scripted",
        runId: "run-1",
        sessionId: expect.stringMatching(/^daemon-session:activation-activation-1-/u),
      }),
      expect.objectContaining({ commitExecutionLease: expect.any(Function) }),
    );
    expect(session.resumeCurrent).toHaveBeenCalledOnce();
    expect(session.reconcileExternalMessages).toHaveBeenCalledOnce();
    expect(session.resumeCurrent.mock.invocationCallOrder[0])
      .toBeLessThan(session.reconcileExternalMessages.mock.invocationCallOrder[0]!);
    expect(session.waitForIdle).toHaveBeenCalledOnce();
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("gives concurrent activations distinct presence identities", async () => {
    const sessions = [sessionDouble(), sessionDouble()];
    const createSession = vi.fn<DaemonSessionFactory>(async () => sessions.shift()!);
    const activate = createDaemonSessionActivator({
      session: {
        workspace: "/workspace",
        dataDir: "/state",
        model: "scripted",
        sessionId: "daemon-session",
      },
      createSession,
    });

    await Promise.all([
      activate(activation({ activationId: "activation-a" })),
      activate(activation({ activationId: "activation-b" })),
    ]);

    const identities = createSession.mock.calls.map(([options]) => options.sessionId);
    expect(identities).toHaveLength(2);
    expect(new Set(identities).size).toBe(2);
    expect(identities.every((value) => value?.startsWith("daemon-session:activation-"))).toBe(true);
  });

  it("bounds a host-supplied activation id in the presence identity", async () => {
    const session = sessionDouble();
    const createSession = vi.fn<DaemonSessionFactory>(async () => session);
    const activate = createDaemonSessionActivator({
      session: {
        workspace: "/workspace",
        dataDir: "/state",
        model: "scripted",
        sessionId: "daemon-session",
      },
      createSession,
    });

    await activate(activation({ activationId: "x".repeat(512) }));

    const identity = createSession.mock.calls[0]?.[0].sessionId;
    expect(identity?.length).toBeLessThanOrEqual(128);
    expect(identity).toMatch(/^daemon-session:activation-x{72}-[a-f0-9]{8}$/u);
  });

  it("cancels and closes a SessionController when the Host aborts an activation", async () => {
    const controller = new AbortController();
    let releaseResume!: () => void;
    const session = sessionDouble();
    session.resumeCurrent.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseResume = resolve;
    }));
    const activate = createDaemonSessionActivator({
      session: { workspace: "/workspace", dataDir: "/state", model: "scripted" },
      createSession: async () => session,
    });

    const running = activate(activation({ signal: controller.signal }));
    await vi.waitFor(() => expect(session.resumeCurrent).toHaveBeenCalledOnce());
    controller.abort(new Error("daemon stop"));
    expect(session.cancel).toHaveBeenCalledWith("Daemon activation cancelled");
    releaseResume();

    await expect(running).rejects.toBeInstanceOf(DaemonRuntimeActivationError);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("passes Host assertion and atomic commit guards into SessionController dependencies", async () => {
    const session = sessionDouble();
    const createSession = vi.fn<DaemonSessionFactory>(async (_options, deps) => {
      expect(deps.assertExecutionLease).toBeTypeOf("function");
      await deps.assertExecutionLease?.();
      expect(deps.commitExecutionLease).toBeTypeOf("function");
      await deps.commitExecutionLease?.(async () => undefined);
      return session;
    });
    const assertLease = vi.fn(async () => undefined);
    let commitCalls = 0;
    const commitLease = async <T>(operation: () => Promise<T>): Promise<T> => {
      commitCalls += 1;
      return operation();
    };
    const activate = createDaemonSessionActivator({
      session: { workspace: "/workspace", dataDir: "/state", model: "scripted" },
      createSession,
    });

    await activate(activation({ assertLease, commitLease }));

    expect(assertLease).toHaveBeenCalledOnce();
    expect(commitCalls).toBe(1);
    expect(createSession).toHaveBeenCalledOnce();
  });

  it("fails closed before opening a daemon session without atomic commit authority", async () => {
    const createSession = vi.fn<DaemonSessionFactory>(async () => sessionDouble());
    const activate = createDaemonSessionActivator({
      session: { workspace: "/workspace", dataDir: "/state", model: "scripted" },
      createSession,
    });
    const { commitLease: _missingCommitLease, ...request } = activation();

    await expect(activate(request)).rejects.toThrow(/commitLease/u);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("composes per-Run Ledger wake admission with the Session activation seam", async () => {
    const ledger = new MemoryLedger();
    const admissionLedger: Ledger = {
      append: (event) => ledger.append(event),
      read: (options) => ledger.read(options),
      watermark: () => ledger.watermark(),
      flush: () => ledger.flush(),
      close: async () => undefined,
    };
    const session = sessionDouble();
    const createSession = vi.fn<DaemonSessionFactory>(async () => session);
    const runtime = await openDaemonRuntime({
      session: { workspace: "/workspace", dataDir: "/state", model: "scripted" },
      host: {
        ownerId: "daemon-composition",
        leaseStore: new MemoryExecutionLeaseStore(),
      },
      openLedger: async () => admissionLedger,
      createSession,
    });
    runtimes.push(runtime);

    await runtime.start();
    await expect(runtime.host.wake({
      runId: "run-1",
      source: "webhook",
      dedupeKey: "event-1",
      payloadRef: payloadRef(),
    })).resolves.toMatchObject({
      status: "queued",
      admission: { status: "admitted" },
    });
    await runtime.host.waitForIdle();

    expect(createSession).toHaveBeenCalledOnce();
    expect(session.resumeCurrent).toHaveBeenCalledOnce();
    expect((await ledger.read({ runId: "run-1" })).map((event) => event.type))
      .toEqual(["input.admitted"]);
  });

  it("reopens a durable wake and reactivates a still-pending input after Host restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-daemon-runtime-"));
    roots.push(root);
    const ledgerPath = join(root, "run-1.jsonl");
    const sessions: Array<DaemonSession> = [];
    const createSession = vi.fn<DaemonSessionFactory>(async () => {
      const session = sessionDouble();
      sessions.push(session);
      return session;
    });
    const options = {
      session: { workspace: "/workspace", dataDir: "/state", model: "scripted" },
      host: { ownerId: "daemon-restart" },
      openLedger: async () => JsonlLedger.open(ledgerPath),
      createSession,
    };

    const first = await openDaemonRuntime(options);
    runtimes.push(first);
    await first.start();
    await first.host.wake({
      runId: "run-1",
      source: "timer",
      dedupeKey: "tick-1",
      payloadRef: payloadRef("restart"),
    });
    await first.host.waitForIdle();
    await first.stop();

    const second = await openDaemonRuntime(options);
    runtimes.push(second);
    await second.start();
    await expect(second.host.wake({
      runId: "run-1",
      source: "timer",
      dedupeKey: "tick-1",
      payloadRef: payloadRef("restart"),
    })).resolves.toMatchObject({
      status: "queued",
      admission: { status: "duplicate", shouldActivate: true },
    });
    await second.host.waitForIdle();

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(sessions[0]?.resumeCurrent).toHaveBeenCalledOnce();
    expect(sessions[1]?.resumeCurrent).toHaveBeenCalledOnce();
  });

  it("rejects activation requests without a wake instead of silently running a session", async () => {
    const activate = createDaemonSessionActivator({
      session: { workspace: "/workspace", dataDir: "/state", model: "scripted" },
      createSession: async () => sessionDouble(),
    });
    await expect(activate(activation({ wakes: [] }))).rejects.toThrow(
      /at least one wake/u,
    );
  });

  it("rejects unsafe Run IDs before resolving a Ledger path", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-daemon-runtime-path-"));
    roots.push(root);
    const runtime = await openDaemonRuntime({
      session: { workspace: root, dataDir: root, model: "scripted" },
      host: { ownerId: "daemon-path-boundary" },
    });
    runtimes.push(runtime);
    await runtime.start();

    await expect(runtime.host.wake({
      runId: "../escape",
      source: "system",
      dedupeKey: "path-traversal",
    })).rejects.toThrow(/safe identifier/u);
  });
});
