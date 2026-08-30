import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnyEvent, ModelResponse } from "../../src/domain/index.js";
import { computeEventContentHash, JsonlLedger, projectRun } from "../../src/ledger/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import {
  DaemonControlServer,
  DaemonControlClient,
  DaemonHost,
  DaemonRemoteAttachment,
  DaemonRemoteSession,
  DaemonRunObserver,
  type DaemonRunObservation,
  FileDaemonRunEventSource,
  SessionController,
} from "../../src/runtime/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => (
    rm(root, { recursive: true, force: true })
  )));
});

describe("daemon remote attachment", () => {
  it("hydrates a read-only Session projection and follows live Ledger events", async () => {
    const fixture = await remoteFixture("remote-session");
    const attachment = await DaemonRemoteAttachment.open({
      socketPath: fixture.control.socketPath,
      runId: fixture.runId,
      reconnectDelayMs: 5,
    });
    const remote = await DaemonRemoteSession.open({
      attachment,
      workspace: fixture.workspace,
      dataDir: fixture.dataDir,
      model: "scripted",
    });

    expect(fixture.host.snapshot().attachedClients).toBe(1);
    expect(remote.snapshot()).toMatchObject({
      workspace: await realpath(fixture.workspace),
      runId: fixture.runId,
      status: "idle",
      model: "scripted",
      goal: { statement: "Assist the user with tasks in the current workspace" },
    });
    expect(await remote.transcript()).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "observe this Run" }),
      expect.objectContaining({ role: "assistant", content: "observed" }),
    ]));

    const updated = stateWhere(remote, (state) => state.snapshot.goal?.version === 2);
    const ledger = await JsonlLedger.open(join(
      fixture.dataDir,
      "runs",
      fixture.runId,
      "ledger.jsonl",
    ));
    await ledger.append({
      runId: fixture.runId,
      laneId: "main",
      type: "goal.revised",
      payload: {
        goal: {
          version: 2,
          statement: "Observe the daemon-owned Run",
          successCriteria: [],
          hardConstraints: [],
        },
      },
      correlationId: `run:${fixture.runId}`,
      idempotencyKey: "remote:test:goal:2",
      visibility: "run",
    });
    await ledger.close();

    await expect(updated).resolves.toMatchObject({
      snapshot: { goal: { statement: "Observe the daemon-owned Run" } },
      attachmentStatus: "attached",
    });
    await remote.close();
    expect(fixture.host.snapshot().attachedClients).toBe(0);
    await fixture.close();
  });

  it("paginates the fixed replay watermark without losing events", async () => {
    const fixture = await remoteFixture("remote-pages");
    const ledgerPath = join(fixture.dataDir, "runs", fixture.runId, "ledger.jsonl");
    const ledger = await JsonlLedger.open(ledgerPath);
    for (let version = 2; version <= 140; version += 1) {
      await ledger.append({
        runId: fixture.runId,
        laneId: "main",
        type: "goal.revised",
        payload: {
          goal: {
            version,
            statement: `Goal ${version}`,
            successCriteria: [],
            hardConstraints: [],
          },
        },
        correlationId: `run:${fixture.runId}`,
        idempotencyKey: `remote:test:goal:${version}`,
        visibility: "run",
      });
    }
    const expected = await ledger.read({ runId: fixture.runId });
    await ledger.close();

    const attachment = await DaemonRemoteAttachment.open({
      socketPath: fixture.control.socketPath,
      runId: fixture.runId,
    });

    expect(attachment.snapshot()).toMatchObject({
      status: "attached",
      cursor: `offset:${expected.at(-1)?.globalOffset}`,
    });
    expect(attachment.snapshot().events).toHaveLength(expected.length);
    expect(projectRun(attachment.snapshot().events, fixture.runId).goal?.version).toBe(140);
    await attachment.close();
    await fixture.close();
  });

  it("reattaches and resumes from its contiguous cursor after the socket restarts", async () => {
    const fixture = await remoteFixture("remote-reconnect");
    const attachment = await DaemonRemoteAttachment.open({
      socketPath: fixture.control.socketPath,
      runId: fixture.runId,
      reconnectDelayMs: 5,
    });
    const reconnecting = attachmentWhere(
      attachment,
      (snapshot) => snapshot.status === "reconnecting",
    );
    await fixture.control.close();
    await expect(reconnecting).resolves.toMatchObject({ status: "reconnecting" });

    const attachedAgain = attachmentWhere(
      attachment,
      (snapshot) => snapshot.status === "attached",
    );
    await fixture.control.listen();
    await expect(attachedAgain).resolves.toMatchObject({
      status: "attached",
    });
    expect(fixture.host.snapshot().attachedClients).toBe(1);

    await attachment.close();
    await fixture.close();
  });

  it("rejects a Run whose durable workspace differs from the attaching surface", async () => {
    const fixture = await remoteFixture("remote-workspace");
    const otherWorkspace = await mkdtemp(join(tmpdir(), "nausicaa-remote-other-"));
    roots.push(otherWorkspace);
    const attachment = await DaemonRemoteAttachment.open({
      socketPath: fixture.control.socketPath,
      runId: fixture.runId,
    });

    await expect(DaemonRemoteSession.open({
      attachment,
      workspace: otherWorkspace,
      dataDir: fixture.dataDir,
      model: "scripted",
    })).rejects.toMatchObject({ code: "workspace_mismatch" });

    await attachment.close();
    await fixture.close();
  });

  it("rejects a replay page that claims more history without advancing its cursor", async () => {
    const client = new DaemonControlClient({ socketPath: "/tmp/nausicaa-test-control.sock" });
    vi.spyOn(client, "connect").mockResolvedValue(undefined);
    vi.spyOn(client, "request").mockImplementation(async (method) => {
      if (method === "attach") {
        return {
          clientId: "remote-test-client",
          snapshot: {
            status: "running",
            ownerId: "remote-test-host",
            queuedRuns: 0,
            runningRuns: 0,
            attachedClients: 1,
            runs: [],
          },
        } as never;
      }
      return {
        subscribed: false,
        runId: "malformed-run",
        replay: {
          status: "ok",
          runId: "malformed-run",
          cursor: "offset:0",
          nextCursor: "offset:0",
          watermark: 1,
          generation: 0,
          hasMore: true,
          events: [],
        },
      } as never;
    });

    await expect(DaemonRemoteAttachment.open({
      socketPath: client.socketPath,
      runId: "malformed-run",
      client,
    })).rejects.toMatchObject({ code: "invalid_frame" });
  });

  it("does not silently accept different content at an already-seen offset", async () => {
    const runId = "same-offset-run";
    const first = testEvent(runId, 1, "first");
    const different = testEvent(runId, 1, "forged");
    let replayCount = 0;
    let runListener: ((observation: DaemonRunObservation) => void) | undefined;
    const client = mockedAttachmentClient((method) => {
      if (method === "attach") return attachResult();
      replayCount += 1;
      return replayPage(runId, [first], 1, 0);
    });
    vi.spyOn(client, "onRunEvent").mockImplementation((listener) => {
      runListener = listener;
      return () => { runListener = undefined; };
    });

    const attachment = await DaemonRemoteAttachment.open({
      socketPath: client.socketPath,
      runId,
      reconnectDelayMs: 1,
      client,
    });
    expect(runListener).toBeDefined();
    runListener?.({
      type: "event",
      runId,
      cursor: "offset:1",
      event: different,
    });
    await eventually(() => {
      expect(replayCount).toBeGreaterThanOrEqual(2);
      expect(attachment.snapshot()).toMatchObject({
        status: "attached",
        cursor: "offset:1",
      });
      expect(attachment.snapshot().events).toEqual([first]);
    });
    await attachment.close();
  });

  it("resyncs instead of dropping a live event for another Run", async () => {
    const runId = "cross-run-attachment";
    const first = testEvent(runId, 1, "first");
    let replayCount = 0;
    let runListener: ((observation: DaemonRunObservation) => void) | undefined;
    const client = mockedAttachmentClient((method) => {
      if (method === "attach") return attachResult();
      replayCount += 1;
      return replayPage(runId, [first], 1, 0);
    });
    vi.spyOn(client, "onRunEvent").mockImplementation((listener) => {
      runListener = listener;
      return () => { runListener = undefined; };
    });

    const attachment = await DaemonRemoteAttachment.open({
      socketPath: client.socketPath,
      runId,
      reconnectDelayMs: 1,
      client,
    });
    runListener?.({
      type: "event",
      runId: "another-run",
      cursor: "offset:1",
      event: testEvent("another-run", 1, "wrong Run"),
    });
    await eventually(() => {
      expect(replayCount).toBeGreaterThanOrEqual(2);
      expect(attachment.snapshot().events).toEqual([first]);
    });
    await attachment.close();
  });

  it("rejects generation presence changes between replay pages", async () => {
    const runId = "generation-presence-run";
    const first = testEvent(runId, 1, "first");
    let page = 0;
    const client = mockedAttachmentClient((method) => {
      if (method === "attach") return attachResult();
      page += 1;
      if (page === 1) {
        return replayPage(runId, [first], 2, 0, true, undefined);
      }
      return replayPage(runId, [testEvent(runId, 2, "second")], 2, 1, false, 0);
    });

    await expect(DaemonRemoteAttachment.open({
      socketPath: client.socketPath,
      runId,
      client,
    })).rejects.toMatchObject({ code: "invalid_frame" });
  });

  it("stops retrying when history cannot be reconstructed from offset zero", async () => {
    const runId = "truncated-history-run";
    const first = testEvent(runId, 1, "first");
    let replayCount = 0;
    let runListener: ((observation: DaemonRunObservation) => void) | undefined;
    const client = mockedAttachmentClient((method, params) => {
      if (method === "attach") return attachResult();
      replayCount += 1;
      const cursor = typeof params === "object" && params !== null
        && "cursor" in params && typeof params.cursor === "string"
        ? params.cursor
        : "offset:0";
      if (replayCount > 1 && cursor === "offset:0") {
        return {
          subscribed: false,
          runId,
          replay: {
            status: "resync_required",
            runId,
            cursor: "offset:0",
            firstOffset: 2,
            watermark: 2,
            reason: "history-truncated",
          },
        };
      }
      return replayPage(runId, [first], 1, 0);
    });
    vi.spyOn(client, "onRunEvent").mockImplementation((listener) => {
      runListener = listener;
      return () => { runListener = undefined; };
    });

    const attachment = await DaemonRemoteAttachment.open({
      socketPath: client.socketPath,
      runId,
      client,
      reconnectDelayMs: 1,
    });
    expect(replayCount).toBe(1);
    runListener?.({
      type: "resync_required",
      result: {
        status: "resync_required",
        runId,
        cursor: "offset:1",
        firstOffset: 2,
        watermark: 2,
        reason: "history-truncated",
      },
    });
    await eventually(() => expect(attachment.snapshot().status).toBe("resyncing"));
    const observed = replayCount;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(replayCount).toBe(observed);
    await attachment.close();
  });

  it("fails closed on a malformed live resync observation", async () => {
    const runId = "malformed-live-resync";
    let runListener: ((observation: DaemonRunObservation) => void) | undefined;
    const client = mockedAttachmentClient((method) => {
      if (method === "attach") return attachResult();
      return replayPage(runId, [], 0, 0);
    });
    vi.spyOn(client, "onRunEvent").mockImplementation((listener) => {
      runListener = listener;
      return () => { runListener = undefined; };
    });
    const attachment = await DaemonRemoteAttachment.open({
      socketPath: client.socketPath,
      runId,
      client,
    });

    runListener?.({
      type: "resync_required",
      result: null as never,
    });
    await eventually(() => {
      expect(attachment.snapshot()).toMatchObject({ status: "resyncing" });
      expect(attachment.snapshot().error).toMatch(/resync result is invalid/u);
    });
    await attachment.close();
  });

  it("does not clear replay state for a cross-Run resync observation", async () => {
    const runId = "cross-run-resync";
    const first = testEvent(runId, 1, "first");
    let runListener: ((observation: DaemonRunObservation) => void) | undefined;
    const client = mockedAttachmentClient((method) => {
      if (method === "attach") return attachResult();
      return replayPage(runId, [first], 1, 0);
    });
    vi.spyOn(client, "onRunEvent").mockImplementation((listener) => {
      runListener = listener;
      return () => { runListener = undefined; };
    });
    const attachment = await DaemonRemoteAttachment.open({
      socketPath: client.socketPath,
      runId,
      client,
    });
    runListener?.({
      type: "resync_required",
      result: {
        status: "resync_required",
        runId: "other-run",
        cursor: "offset:1",
        firstOffset: 1,
        watermark: 1,
        reason: "offset-gap",
      } as never,
    });
    await eventually(() => {
      expect(attachment.snapshot().status).toBe("resyncing");
      expect(attachment.snapshot().events).toEqual([first]);
    });
    await attachment.close();
  });
});

function mockedAttachmentClient(
  handler: (method: string, params?: unknown) => unknown,
): DaemonControlClient {
  const client = new DaemonControlClient({ socketPath: "/tmp/nausicaa-remote-attachment-test.sock" });
  vi.spyOn(client, "connect").mockResolvedValue(undefined);
  vi.spyOn(client, "request").mockImplementation(async (method, params) => (
    handler(method, params)
  ) as never);
  return client;
}

function attachResult(): unknown {
  return {
    clientId: "remote-test-client",
    snapshot: {
      status: "running",
      ownerId: "remote-test-host",
      queuedRuns: 0,
      runningRuns: 0,
      attachedClients: 1,
      runs: [],
    },
  };
}

function replayPage(
  runId: string,
  events: readonly AnyEvent[],
  watermark: number,
  cursorOffset: number,
  hasMore = false,
  generation?: number,
): unknown {
  const nextOffset = events.at(-1)?.globalOffset ?? cursorOffset;
  return {
    subscribed: !hasMore,
    runId,
    replay: {
      status: "ok",
      runId,
      cursor: `offset:${cursorOffset}`,
      nextCursor: `offset:${nextOffset}`,
      watermark,
      hasMore,
      events,
      ...(generation === undefined ? {} : { generation }),
    },
  };
}

function testEvent(runId: string, globalOffset: number, statement: string): AnyEvent {
  const content = {
    eventId: `event-${runId}-${globalOffset}-${statement}`,
    runId,
    laneId: "main",
    globalOffset,
    laneSeq: globalOffset,
    type: "goal.revised" as const,
    schemaVersion: 1 as const,
    occurredAt: "2026-08-31T00:00:00.000Z",
    correlationId: `run:${runId}`,
    idempotencyKey: `test:${runId}:${globalOffset}:${statement}`,
    visibility: "run" as const,
    payload: {
      goal: {
        version: globalOffset,
        statement,
        successCriteria: [],
        hardConstraints: [],
      },
    },
  };
  return {
    ...content,
    contentHash: computeEventContentHash(content),
  };
}

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 500;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error: unknown) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error("condition did not become true");
}

async function remoteFixture(name: string): Promise<{
  workspace: string;
  dataDir: string;
  runId: string;
  host: DaemonHost;
  control: DaemonControlServer;
  close(): Promise<void>;
}> {
  const workspace = await mkdtemp(join(tmpdir(), `nausicaa-${name}-`));
  roots.push(workspace);
  const dataDir = join(workspace, "state");
  const runId = `${name}-run`;
  const session = await SessionController.open({
    workspace,
    dataDir,
    model: "scripted",
    policy: { maxMainStepsPerActivation: 1, tetoEnabled: false },
  }, {
    mainModel: new ScriptedModel([response("observed")]),
    createRunId: () => runId,
  });
  await session.submit({
    inputId: `${name}-input`,
    text: "observe this Run",
    delivery: "new-turn",
  });
  await session.waitForIdle();
  await session.close();

  const host = new DaemonHost({
    ownerId: `${name}-host`,
    admitWake: async (request) => ({
      status: "admitted",
      inputId: request.inputId ?? `${name}-wake`,
    }),
    activate: async () => undefined,
  });
  await host.start();
  const observer = new DaemonRunObserver({
    source: new FileDaemonRunEventSource({ dataDir }),
    pollIntervalMs: 5,
  });
  const control = new DaemonControlServer({
    host,
    observer,
    socketPath: join(workspace, "control.sock"),
  });
  await control.listen();
  return {
    workspace,
    dataDir,
    runId,
    host,
    control,
    close: async () => {
      await control.close().catch(() => undefined);
      await host.stop().catch(() => undefined);
    },
  };
}

function response(content: string): ModelResponse {
  return {
    content,
    toolCalls: [],
    stopReason: "stop",
    usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
  };
}

function attachmentWhere(
  attachment: DaemonRemoteAttachment,
  predicate: (snapshot: ReturnType<DaemonRemoteAttachment["snapshot"]>) => boolean,
): Promise<ReturnType<DaemonRemoteAttachment["snapshot"]>> {
  const current = attachment.snapshot();
  if (predicate(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for remote attachment state"));
    }, 2_000);
    const unsubscribe = attachment.subscribe((snapshot) => {
      if (!predicate(snapshot)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(snapshot);
    });
  });
}

function stateWhere(
  session: DaemonRemoteSession,
  predicate: (state: ReturnType<DaemonRemoteSession["state"]>) => boolean,
): Promise<ReturnType<DaemonRemoteSession["state"]>> {
  const current = session.state();
  if (predicate(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for remote Session state"));
    }, 2_000);
    const unsubscribe = session.subscribe((state) => {
      if (!predicate(state)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(state);
    });
  });
}
