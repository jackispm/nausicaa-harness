import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelResponse } from "../../src/domain/index.js";
import { JsonlLedger, projectRun } from "../../src/ledger/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import {
  DaemonControlServer,
  DaemonControlClient,
  DaemonHost,
  DaemonRemoteAttachment,
  DaemonRemoteSession,
  DaemonRunObserver,
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
});

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
