import { mkdtemp, readlink, stat, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  DaemonControlServer,
  DaemonHost,
  type DaemonControlEventFrame,
  type DaemonControlResponse,
  type DaemonHostEvent,
  type DaemonWakeRequest,
} from "../../src/runtime/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function wake(runId: string, dedupeKey = `${runId}:wake`): DaemonWakeRequest {
  return { runId, source: "system", dedupeKey };
}

describe("DaemonControlServer", () => {
  it("serves versioned JSONL lifecycle commands and removes its socket on close", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-daemon-control-"));
    roots.push(root);
    const socketPath = join(root, "control.sock");
    const host = new DaemonHost({
      ownerId: "control-host",
      admitWake: async (request) => ({ status: "admitted", inputId: request.wakeId ?? "input" }),
      activate: async () => undefined,
    });
    const control = new DaemonControlServer({ host, socketPath });
    await control.listen();

    expect(control.listening).toBe(true);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);

    const client = await connect(socketPath);
    await expect(sendAndWait(client, { id: "status-1", method: "status" })).resolves.toMatchObject({
      version: 1,
      kind: "response",
      id: "status-1",
      ok: true,
      result: { status: "stopped" },
    });
    await expect(sendAndWait(client, { id: "start-1", method: "start" })).resolves.toMatchObject({
      id: "start-1",
      ok: true,
      result: { status: "running" },
    });
    await client.end();
    await control.close();
    expect(control.listening).toBe(false);
    await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("routes attach, wake and filtered live events without creating a second loop", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-daemon-control-"));
    roots.push(root);
    const socketPath = join(root, "control.sock");
    const activations: string[] = [];
    const host = new DaemonHost({
      ownerId: "control-routing-host",
      createWakeId: () => "wake-1",
      createActivationId: () => "activation-1",
      admitWake: async (request) => ({ status: "admitted", inputId: request.wakeId ?? "input" }),
      activate: async ({ runId }) => {
        activations.push(runId);
      },
    });
    const control = new DaemonControlServer({
      host,
      socketPath,
      createClientId: () => "client-1",
    });
    await control.listen();
    const client = await connect(socketPath);

    await sendAndWait(client, { id: "start", method: "start" });
    await expect(sendAndWait(client, {
      id: "subscribe",
      method: "events.subscribe",
      params: { runId: "run-1" },
    })).resolves.toMatchObject({ id: "subscribe", ok: true, result: { subscribed: true, runId: "run-1" } });
    await expect(sendAndWait(client, {
      id: "attach",
      method: "attach",
      params: { runId: "run-1" },
    })).resolves.toMatchObject({
      id: "attach",
      ok: true,
      result: { clientId: "client-1", snapshot: { attachedClients: 1 } },
    });

    const wakeResponse = sendAndWait(client, {
      id: "wake",
      method: "wake",
      params: wake("run-1"),
    });
    const response = await wakeResponse;
    expect(response).toMatchObject({ id: "wake", ok: true, result: { status: "queued" } });
    const event = await waitForEvent(client, (frame) => (
      frame.kind === "event"
      && frame.event.type === "activation.started"
      && frame.event.runId === "run-1"
    ));
    expect(event.kind).toBe("event");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(activations).toEqual(["run-1"]);

    await expect(sendAndWait(client, {
      id: "detach",
      method: "detach",
      params: {},
    })).resolves.toMatchObject({ id: "detach", ok: true, result: { clientId: "client-1" } });
    await client.end();
    await control.close();
    await host.stop();
  });

  it("uses an injected runtime lifecycle and notifies shutdown after stop response", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-daemon-control-"));
    roots.push(root);
    const host = new DaemonHost({
      ownerId: "control-runtime-host",
      admitWake: async (request) => ({
        status: "admitted",
        inputId: request.wakeId ?? "input",
      }),
      activate: async () => undefined,
    });
    const calls: string[] = [];
    let stopResponseQueued = false;
    const control = new DaemonControlServer({
      host,
      socketPath: join(root, "control.sock"),
      lifecycle: {
        start: async () => {
          calls.push("runtime.start");
          return { ...host.snapshot(), status: "running" };
        },
        stop: async () => {
          calls.push("runtime.stop");
          return { ...host.snapshot(), status: "stopped" };
        },
      },
      onStopResponse: () => {
        stopResponseQueued = true;
      },
    });
    await control.listen();
    const client = await connect(control.socketPath);

    await expect(sendAndWait(client, { id: "runtime-start", method: "start" }))
      .resolves.toMatchObject({
        id: "runtime-start",
        ok: true,
        result: { status: "running" },
      });
    const stop = await sendAndWait(client, { id: "runtime-stop", method: "stop" });
    expect(stop).toMatchObject({
      id: "runtime-stop",
      ok: true,
      result: { status: "stopped" },
    });
    expect(calls).toEqual(["runtime.start", "runtime.stop"]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopResponseQueued).toBe(true);

    await client.end();
    await control.close();
  });

  it("rejects malformed requests and never replaces a live or non-socket path", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-daemon-control-"));
    roots.push(root);
    const socketPath = join(root, "control.sock");
    await writeFile(socketPath, "reserved", "utf8");
    const host = new DaemonHost({
      admitWake: async (request) => ({ status: "admitted", inputId: request.wakeId ?? "input" }),
      activate: async () => undefined,
    });
    await expect(new DaemonControlServer({ host, socketPath }).listen()).rejects.toThrow(/not a Unix socket/u);
    expect(await readlink(socketPath).catch(() => undefined)).toBeUndefined();

    const stalePath = join(root, "stale.sock");
    const staleControl = new DaemonControlServer({ host, socketPath: stalePath });
    await staleControl.listen();
    await staleControl.close();
    const replacement = join(root, "replacement");
    await writeFile(replacement, "replacement", "utf8");
    await symlink(replacement, stalePath);
    await expect(new DaemonControlServer({ host, socketPath: stalePath }).listen()).rejects.toThrow(/Unix socket/u);
    expect(await readlink(stalePath)).toBe(replacement);

    const validControl = new DaemonControlServer({ host, socketPath: join(root, "valid.sock") });
    await validControl.listen();
    const client = await connect(validControl.socketPath);
    await expect(sendAndWait(client, "not an object")).resolves.toMatchObject({
      id: null,
      ok: false,
      error: { code: "invalid_request" },
    });
    await expect(sendAndWait(client, { id: "unknown", method: "unknown" })).resolves.toMatchObject({
      id: "unknown",
      ok: false,
      error: { code: "invalid_request" },
    });
    await client.end();
    await validControl.close();
  });

  it("fences explicit attachment IDs to their owning connection", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-daemon-control-"));
    roots.push(root);
    const host = new DaemonHost({
      ownerId: "control-ownership-host",
      admitWake: async (request) => ({
        status: "admitted",
        inputId: request.wakeId ?? "input",
      }),
      activate: async () => undefined,
    });
    const control = new DaemonControlServer({ host, socketPath: join(root, "control.sock") });
    await control.listen();
    await host.start();
    const first = await connect(control.socketPath);
    const second = await connect(control.socketPath);

    await expect(sendAndWait(first, {
      id: "first-attach",
      method: "attach",
      params: { clientId: "shared-client", runId: "run-1" },
    })).resolves.toMatchObject({ id: "first-attach", ok: true });
    await expect(sendAndWait(second, {
      id: "second-attach",
      method: "attach",
      params: { clientId: "shared-client", runId: "run-2" },
    })).resolves.toMatchObject({
      id: "second-attach",
      ok: false,
      error: { code: "invalid_params" },
    });
    await expect(sendAndWait(second, {
      id: "second-detach",
      method: "detach",
      params: { clientId: "shared-client" },
    })).resolves.toMatchObject({
      id: "second-detach",
      ok: false,
      error: { code: "invalid_params" },
    });
    expect(host.snapshot().attachedClients).toBe(1);

    await control.close();
    expect(host.snapshot().attachedClients).toBe(0);

    // Closing the control plane releases ownership synchronously, so the same
    // server instance can be started again without a stale client ID fence.
    await control.listen();
    const replacement = await connect(control.socketPath);
    await expect(sendAndWait(replacement, {
      id: "replacement-attach",
      method: "attach",
      params: { clientId: "shared-client", runId: "run-3" },
    })).resolves.toMatchObject({ id: "replacement-attach", ok: true });

    first.destroy();
    second.destroy();
    await replacement.end();
    await control.close();
    expect(host.snapshot().attachedClients).toBe(0);
    await host.stop();
  });

  it("waits for drain and disconnects a client whose pending write queue exceeds its bound", () => {
    const host = new DaemonHost({
      admitWake: async (request) => ({ status: "admitted", inputId: request.wakeId ?? "input" }),
      activate: async () => undefined,
    });
    const frame: DaemonControlResponse = {
      version: 1,
      kind: "response",
      id: "bounded-write",
      ok: true,
      result: { status: "ok" },
    };
    const frameBytes = Buffer.byteLength(`${JSON.stringify(frame)}\n`, "utf8");
    const control = new DaemonControlServer({
      host,
      socketPath: "/tmp/unused-nausicaa-control.sock",
      maxFrameBytes: 4_096,
      maxPendingWriteBytes: frameBytes * 2,
    });
    const writes: string[] = [];
    const socketState: {
      destroyed: boolean;
      writable: boolean;
      writableLength: number;
      acceptWrites: boolean;
      write(value: string): boolean;
      destroy(): void;
    } = {
      destroyed: false,
      writable: true,
      writableLength: 0,
      acceptWrites: false,
      write(value: string): boolean {
        writes.push(value);
        socketState.writableLength += Buffer.byteLength(value, "utf8");
        return socketState.acceptWrites;
      },
      destroy(): void {
        socketState.destroyed = true;
        socketState.writable = false;
      },
    };
    const socket = socketState as unknown as Socket;
    const connection = {
      id: "test-client",
      socket,
      buffer: "",
      tail: Promise.resolve(),
      writeQueue: [],
      queuedWriteBytes: 0,
      writeBlocked: false,
      attachedClientIds: new Set<string>(),
    };
    const transport = control as unknown as {
      sendFrame(connection: unknown, frame: DaemonControlResponse): void;
      flushWrites(connection: unknown): void;
    };

    transport.sendFrame(connection, frame);
    transport.sendFrame(connection, frame);
    expect(writes).toHaveLength(1);
    expect(connection.writeQueue).toHaveLength(1);

    socketState.acceptWrites = true;
    socketState.writableLength = 0;
    transport.flushWrites(connection);
    expect(writes).toHaveLength(2);
    expect(connection.writeQueue).toHaveLength(0);

    socketState.acceptWrites = false;
    socketState.writableLength = 0;
    transport.sendFrame(connection, frame);
    transport.sendFrame(connection, frame);
    transport.sendFrame(connection, frame);
    expect(socketState.destroyed).toBe(true);
  });
});

type Frame = DaemonControlResponse | DaemonControlEventFrame;

async function connect(path: string): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection(path);
    const reader = new FrameReader(socket);
    socket.once("connect", () => {
      readers.set(socket, reader);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

const readers = new WeakMap<Socket, FrameReader>();

async function sendAndWait(socket: Socket, request: unknown): Promise<DaemonControlResponse> {
  const expectedId = request !== null && typeof request === "object" && !Array.isArray(request)
    ? ((request as Record<string, unknown>).id ?? null)
    : null;
  const framePromise = waitForFrame(socket, (frame) => (
    frame.kind === "response" && frame.id === expectedId
  ));
  socket.write(`${JSON.stringify(request)}\n`);
  const frame = await framePromise;
  if (frame.kind !== "response") throw new Error("expected response frame");
  return frame;
}

async function waitForEvent(
  socket: Socket,
  predicate: (frame: DaemonControlEventFrame) => boolean,
): Promise<DaemonControlEventFrame> {
  const frame = await waitForFrame(socket, (frame) => (
    frame.kind === "event" && predicate(frame)
  ));
  if (frame.kind !== "event") throw new Error("expected event frame");
  return frame as DaemonControlEventFrame;
}

async function waitForFrame(
  socket: Socket,
  predicate: (frame: Frame) => boolean,
): Promise<Frame> {
  const reader = readers.get(socket);
  if (reader === undefined) throw new Error("socket reader was not initialized");
  return reader.wait(predicate);
}

class FrameReader {
  private buffer = "";
  private readonly frames: Frame[] = [];
  private readonly waiters: Array<{
    predicate: (frame: Frame) => boolean;
    resolve: (frame: Frame) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string | Buffer) => this.read(chunk));
    socket.on("error", (error: Error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("daemon control socket closed")));
  }

  wait(predicate: (frame: Frame) => boolean): Promise<Frame> {
    const index = this.frames.findIndex(predicate);
    if (index >= 0) {
      const [frame] = this.frames.splice(index, 1);
      if (frame !== undefined) return Promise.resolve(frame);
    }
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("timed out waiting for daemon control frame"));
      }, 2_000);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  private read(chunk: string | Buffer): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) continue;
      this.frames.push(JSON.parse(line) as Frame);
    }
    this.flush();
  }

  private flush(): void {
    for (let index = 0; index < this.waiters.length;) {
      const waiter = this.waiters[index];
      if (waiter === undefined) break;
      const frameIndex = this.frames.findIndex(waiter.predicate);
      if (frameIndex < 0) {
        index += 1;
        continue;
      }
      const [frame] = this.frames.splice(frameIndex, 1);
      this.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      if (frame !== undefined) waiter.resolve(frame);
    }
  }

  private fail(error: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}
