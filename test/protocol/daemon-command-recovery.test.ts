import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  daemonCommandRecoveryFingerprint,
  createFileDaemonCommandRecoveryJournal,
  DaemonControlServer,
  DaemonHost,
  MemoryDaemonCommandRecoveryJournal,
  type DaemonControlResponse,
} from "../../src/runtime/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("daemon command recovery", () => {
  it("keeps an injected file journal reusable across control close and listen", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-command-recovery-relisten-"));
    roots.push(root);
    const journal = createFileDaemonCommandRecoveryJournal(
      join(root, "command-recovery.jsonl"),
    );
    const host = new DaemonHost({
      admitWake: async (request) => ({ status: "admitted", inputId: request.wakeId ?? "input" }),
      activate: async () => undefined,
    });
    const control = new DaemonControlServer({
      host,
      socketPath: join(root, "control.sock"),
      commandJournal: journal,
    });

    await control.listen();
    await control.close();
    await expect(control.listen()).resolves.toBeUndefined();
    await control.close();
    await journal.close();
  });

  it("replays a completed command without dispatching it twice", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-command-recovery-control-"));
    roots.push(root);
    const journal = new MemoryDaemonCommandRecoveryJournal();
    let starts = 0;
    const host = new DaemonHost({
      admitWake: async (request) => ({ status: "admitted", inputId: request.wakeId ?? "input" }),
      activate: async () => undefined,
    });
    const control = new DaemonControlServer({
      host,
      socketPath: join(root, "control.sock"),
      commandJournal: journal,
      lifecycle: {
        start: async () => {
          starts += 1;
          return { ...host.snapshot(), status: "running" };
        },
        stop: () => host.stop(),
      },
    });
    await control.listen();
    const client = await connect(control.socketPath);
    const request = { id: "start-1", clientId: "stable-client", method: "start" };
    await expect(sendAndWait(client, request)).resolves.toMatchObject({ ok: true, id: "start-1" });
    await expect(sendAndWait(client, request)).resolves.toMatchObject({ ok: true, id: "start-1" });
    await expect(sendAndWait(client, {
      ...request,
      params: {},
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "command_conflict" },
    });
    expect(starts).toBe(1);
    expect((await journal.read()).at(-1)?.status).toBe("acknowledged");
    client.destroy();
    await control.close();
  });

  it("returns uncertain for a received-only command and does not dispatch it", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-command-recovery-uncertain-"));
    roots.push(root);
    const journal = new MemoryDaemonCommandRecoveryJournal();
    await journal.append({
      clientId: "stable-client",
      commandId: "start-uncertain",
      method: "start",
      fingerprint: daemonCommandRecoveryFingerprint("start", undefined),
      status: "received",
    });
    let starts = 0;
    const host = new DaemonHost({
      admitWake: async (request) => ({ status: "admitted", inputId: request.wakeId ?? "input" }),
      activate: async () => undefined,
    });
    const control = new DaemonControlServer({
      host,
      socketPath: join(root, "control.sock"),
      commandJournal: journal,
      lifecycle: {
        start: async () => {
          starts += 1;
          return host.snapshot();
        },
        stop: () => host.stop(),
      },
    });
    await control.listen();
    const client = await connect(control.socketPath);
    await expect(sendAndWait(client, {
      id: "start-uncertain",
      clientId: "stable-client",
      method: "start",
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "command_uncertain" },
    });
    expect(starts).toBe(0);
    client.destroy();
    await control.close();
  });

  it("keeps the same command id independent across clients", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-command-recovery-clients-"));
    roots.push(root);
    const journal = new MemoryDaemonCommandRecoveryJournal();
    let starts = 0;
    const host = new DaemonHost({
      admitWake: async (request) => ({ status: "admitted", inputId: request.wakeId ?? "input" }),
      activate: async () => undefined,
    });
    const control = new DaemonControlServer({
      host,
      socketPath: join(root, "control.sock"),
      commandJournal: journal,
      lifecycle: {
        start: async () => {
          starts += 1;
          return host.snapshot();
        },
        stop: () => host.stop(),
      },
    });
    await control.listen();
    const first = await connect(control.socketPath);
    const second = await connect(control.socketPath);
    const [firstResponse, secondResponse] = await Promise.all([
      sendAndWait(first, { id: "same-id", clientId: "client-a", method: "start" }),
      sendAndWait(second, { id: "same-id", clientId: "client-b", method: "start" }),
    ]);
    expect(firstResponse.ok).toBe(true);
    expect(secondResponse.ok).toBe(true);
    expect(starts).toBe(2);
    first.destroy();
    second.destroy();
    await control.close();
  });
});

async function connect(socketPath: string): Promise<Socket> {
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.setEncoding("utf8");
  return socket;
}

function sendAndWait(socket: Socket, request: unknown): Promise<DaemonControlResponse> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: string | Buffer): void => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const frame = JSON.parse(buffer.slice(0, newline)) as DaemonControlResponse;
      socket.off("data", onData);
      resolve(frame);
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.write(`${JSON.stringify(request)}\n`);
  });
}
