import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DaemonActivationRequest,
  DaemonSessionFactory,
  DaemonSession,
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
  resumeCurrent: ReturnType<typeof vi.fn>;
  waitForIdle: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    resumeCurrent: vi.fn(async () => undefined),
    waitForIdle: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe("daemon runtime composition", () => {
  it("activates the existing SessionController contract for one durable wake", async () => {
    const session = sessionDouble();
    const createSession = vi.fn<DaemonSessionFactory>(async () => session);
    const activate = createDaemonSessionActivator({
      session: {
        workspace: "/workspace",
        dataDir: "/state",
        model: "scripted",
      },
      createSession,
    });

    await activate(activation());

    expect(createSession).toHaveBeenCalledOnce();
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      workspace: "/workspace",
      dataDir: "/state",
      model: "scripted",
      runId: "run-1",
    }), {});
    expect(session.resumeCurrent).toHaveBeenCalledOnce();
    expect(session.waitForIdle).toHaveBeenCalledOnce();
    expect(session.close).toHaveBeenCalledOnce();
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
