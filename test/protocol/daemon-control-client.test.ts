import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DaemonControlClient,
  DaemonControlClientError,
  DaemonControlServer,
  DaemonHost,
  type DaemonWakeRequest,
} from "../../src/runtime/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function wake(runId: string, dedupeKey = `${runId}:wake`): DaemonWakeRequest {
  return { runId, source: "system", dedupeKey };
}

describe("DaemonControlClient", () => {
  it("connects lazily, supports concurrent requests, and delivers live events", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-daemon-client-"));
    roots.push(root);
    const host = new DaemonHost({
      ownerId: "client-host",
      createWakeId: () => "wake-1",
      createActivationId: () => "activation-1",
      admitWake: async (request) => ({ status: "admitted", inputId: request.wakeId ?? "input" }),
      activate: async () => undefined,
    });
    const server = new DaemonControlServer({ host, socketPath: join(root, "control.sock") });
    await server.listen();
    const client = new DaemonControlClient({
      socketPath: server.socketPath,
      createRequestId: (() => {
        let sequence = 0;
        return () => `request-${++sequence}`;
      })(),
    });
    const events: string[] = [];
    const connections: string[] = [];
    const unsubscribe = client.onEvent((event) => events.push(event.type));
    const unsubscribeConnection = client.onConnection((event) => connections.push(event.type));

    const beforeStart = await client.request<{ status: string }>("status");
    const start = await client.request<{ status: string }>("start");
    const [statusAfterStart, statusAfterStartAgain] = await Promise.all([
      client.request<{ status: string }>("status"),
      client.request<{ status: string }>("status"),
    ]);
    expect(beforeStart.status).toBe("stopped");
    expect(start.status).toBe("running");
    expect(statusAfterStart.status).toBe("running");
    expect(statusAfterStartAgain.status).toBe("running");

    await client.request("events.subscribe");
    const wakeResult = await client.request<{ status: string }>("wake", wake("run-1"));
    expect(wakeResult.status).toBe("queued");
    await host.waitForIdle();
    expect(events).toContain("wake");
    expect(events).toContain("activation.started");
    expect(events).toContain("activation.finished");
    expect(connections).toEqual(["connected"]);

    unsubscribe();
    client.close();
    expect(connections).toEqual(["connected", "closed"]);
    unsubscribeConnection();
    await server.close();
    await host.stop();
  });

  it("returns server command failures as typed client errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-daemon-client-"));
    roots.push(root);
    const host = new DaemonHost({
      admitWake: async (request) => ({ status: "admitted", inputId: request.wakeId ?? "input" }),
      activate: async () => undefined,
    });
    const server = new DaemonControlServer({ host, socketPath: join(root, "control.sock") });
    await server.listen();
    const client = new DaemonControlClient({ socketPath: server.socketPath });

    await expect(client.request("status")).resolves.toMatchObject({ status: "stopped" });
    await expect(client.request("wake", wake("run-1"))).rejects.toMatchObject({
      code: "host_rejected",
    });

    client.close();
    await server.close();
  });

  it("rejects invalid options and pending requests on close", async () => {
    expect(() => new DaemonControlClient({ socketPath: "relative.sock" })).toThrow(
      DaemonControlClientError,
    );
    const client = new DaemonControlClient({
      socketPath: "/tmp/nausicaa-missing-control.sock",
      requestTimeoutMs: 2_000,
    });
    const request = client.request("status");
    client.close();
    await expect(request).rejects.toMatchObject({ code: expect.stringMatching(/connect|closed|disconnected/u) });
  });

  it("drops a partial response frame before reconnecting", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-daemon-client-reconnect-"));
    roots.push(root);
    const socketPath = join(root, "control.sock");
    let connections = 0;
    const server = createServer((socket) => {
      const connection = ++connections;
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string | Buffer) => {
        buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline)) as { id: string };
        if (connection === 1) {
          // Leave the JSON object incomplete so the client must discard it
          // when this transport closes.
          const partial = JSON.stringify({
            version: 1,
            kind: "response",
            id: request.id,
            ok: true,
            result: { status: "stale" },
          }).slice(0, -1);
          socket.write(partial);
          socket.destroy();
          return;
        }
        socket.end(`${JSON.stringify({
          version: 1,
          kind: "response",
          id: request.id,
          ok: true,
          result: { status: "reconnected" },
        })}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    let sequence = 0;
    const client = new DaemonControlClient({
      socketPath,
      createRequestId: () => `request-${++sequence}`,
      requestTimeoutMs: 2_000,
    });
    await expect(client.request("status")).rejects.toMatchObject({ code: "disconnected" });
    await expect(client.request<{ status: string }>("status")).resolves.toEqual({
      status: "reconnected",
    });
    expect(connections).toBe(2);

    client.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  });

  it("ignores stale socket events after reconnecting", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-daemon-client-stale-"));
    roots.push(root);
    const socketPath = join(root, "control.sock");
    let connections = 0;
    const secondRequestSeen = deferred<void>();
    const releaseSecondResponse = deferred<void>();
    const server = createServer((socket) => {
      const connection = ++connections;
      socket.setEncoding("utf8");
      socket.once("data", (chunk: string | Buffer) => {
        const request = JSON.parse(
          (typeof chunk === "string" ? chunk : chunk.toString("utf8")).trim(),
        ) as { id: string };
        if (connection === 1) {
          socket.destroy();
          return;
        }
        secondRequestSeen.resolve();
        void releaseSecondResponse.promise.then(() => {
          socket.end(`${JSON.stringify({
            version: 1,
            kind: "response",
            id: request.id,
            ok: true,
            result: { status: "current" },
          })}\n`);
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    let sequence = 0;
    const client = new DaemonControlClient({
      socketPath,
      createRequestId: () => `stale-request-${++sequence}`,
      requestTimeoutMs: 2_000,
    });
    await client.connect();
    const oldSocket = (client as unknown as { socket: import("node:net").Socket }).socket;
    await expect(client.request("status")).rejects.toMatchObject({ code: "disconnected" });

    const current = client.request<{ status: string }>("status");
    await secondRequestSeen.promise;
    oldSocket.emit("error", new Error("late transport failure"));
    oldSocket.emit("close", true);
    releaseSecondResponse.resolve();
    await expect(current).resolves.toEqual({ status: "current" });
    expect(connections).toBe(2);

    client.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  });

  it("rejects request ID reuse within one connection", async () => {
    const root = await mkdtemp(join(tmpdir(), "ndc-dup-"));
    roots.push(root);
    const socketPath = join(root, "control.sock");
    const release = deferred<void>();
    const requestSeen = deferred<void>();
    let requests = 0;
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string | Buffer) => {
        const request = JSON.parse(
          (typeof chunk === "string" ? chunk : chunk.toString("utf8")).trim(),
        ) as { id: string };
        requests += 1;
        requestSeen.resolve();
        void release.promise.then(() => socket.write(`${JSON.stringify({
          version: 1,
          kind: "response",
          id: request.id,
          ok: true,
          result: { status: "ok" },
        })}\n`));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    const client = new DaemonControlClient({
      socketPath,
      createRequestId: () => "same-id",
      requestTimeoutMs: 2_000,
    });
    const first = client.request<{ status: string }>("status");
    await requestSeen.promise;
    await expect(client.request("status")).rejects.toMatchObject({
      code: "duplicate_request_id",
    });
    expect(requests).toBe(1);
    release.resolve();
    await expect(first).resolves.toEqual({ status: "ok" });
    await expect(client.request("status")).rejects.toMatchObject({
      code: "duplicate_request_id",
    });
    expect(requests).toBe(1);

    client.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  });

  it("clears an invalid protocol stream before an immediate reconnect", async () => {
    const root = await mkdtemp(join(tmpdir(), "ndc-proto-"));
    roots.push(root);
    const socketPath = join(root, "control.sock");
    let connections = 0;
    const server = createServer((socket) => {
      const connection = ++connections;
      socket.setEncoding("utf8");
      socket.once("data", (chunk: string | Buffer) => {
        const request = JSON.parse(
          (typeof chunk === "string" ? chunk : chunk.toString("utf8")).trim(),
        ) as { id: string };
        if (connection === 1) {
          // The first frame is invalid and deliberately leaves the transport
          // open, forcing the client to make the socket unusable synchronously.
          socket.write("not-json\n");
          return;
        }
        socket.end(`${JSON.stringify({
          version: 1,
          kind: "response",
          id: request.id,
          ok: true,
          result: { status: "fresh" },
        })}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    let sequence = 0;
    const client = new DaemonControlClient({
      socketPath,
      createRequestId: () => `protocol-${++sequence}`,
      requestTimeoutMs: 2_000,
    });
    await expect(client.request("status")).rejects.toMatchObject({ code: "invalid_json" });
    await expect(client.request<{ status: string }>("status")).resolves.toEqual({
      status: "fresh",
    });
    expect(connections).toBe(2);

    client.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  });
});

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
