import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AnyEvent } from "../../src/domain/events.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import {
  DaemonControlClient,
  DaemonControlServer,
  DaemonHost,
  DaemonRunObserver,
  type DaemonRunEventSnapshot,
  type DaemonRunEventSource,
  type DaemonRunObservation,
  type DaemonRunReplayResult,
} from "../../src/runtime/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("daemon observer control protocol", () => {
  it("replays from a durable cursor, streams the suffix once, and resumes after reconnect", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-daemon-observer-control-"));
    roots.push(root);
    const allEvents = await fixtureEvents(4);
    const source = mutableSource(allEvents.slice(0, 2));
    const observer = new DaemonRunObserver({ source, pollIntervalMs: 5 });
    const host = new DaemonHost({
      admitWake: async (request) => ({ status: "admitted", inputId: request.wakeId ?? "input" }),
      activate: async () => undefined,
    });
    const server = new DaemonControlServer({
      host,
      observer,
      socketPath: join(root, "control.sock"),
    });
    await server.listen();

    const first = new DaemonControlClient({ socketPath: server.socketPath });
    const firstLive = deferred<DaemonRunObservation>();
    const firstSeen: DaemonRunObservation[] = [];
    first.onRunEvent((observation) => {
      firstSeen.push(observation);
      if (observation.type === "event") firstLive.resolve(observation);
    });
    const initial = await first.request<{
      subscribed: boolean;
      replay: DaemonRunReplayResult;
    }>("events.subscribe", { runId: "run-1", cursor: "offset:0", limit: 8 });
    expect(initial).toMatchObject({
      subscribed: true,
      replay: {
        status: "ok",
        nextCursor: "offset:2",
        events: [{ globalOffset: 1 }, { globalOffset: 2 }],
      },
    });

    source.events.push(allEvents[2]!);
    await expect(firstLive.promise).resolves.toMatchObject({
      type: "event",
      cursor: "offset:3",
      event: { globalOffset: 3 },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(firstSeen.filter((entry) => entry.type === "event")).toHaveLength(1);
    first.close();

    source.events.push(allEvents[3]!);
    const second = new DaemonControlClient({ socketPath: server.socketPath });
    const resumed = await second.request<{
      subscribed: boolean;
      replay: DaemonRunReplayResult;
    }>("events.subscribe", {
      runId: "run-1",
      cursor: "offset:3",
      limit: 8,
      upperWatermark: 4,
    });
    expect(resumed).toMatchObject({
      subscribed: true,
      replay: {
        status: "ok",
        cursor: "offset:3",
        nextCursor: "offset:4",
        events: [{ globalOffset: 4 }],
      },
    });

    second.close();
    await server.close();
  });

  it("returns resync_required instead of silently clamping an invalid cursor", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-daemon-observer-resync-"));
    roots.push(root);
    const source = mutableSource(await fixtureEvents(2));
    const server = new DaemonControlServer({
      host: new DaemonHost({
        admitWake: async (request) => ({ status: "admitted", inputId: request.wakeId ?? "input" }),
        activate: async () => undefined,
      }),
      observer: new DaemonRunObserver({ source, pollIntervalMs: 5 }),
      socketPath: join(root, "control.sock"),
    });
    await server.listen();
    const client = new DaemonControlClient({ socketPath: server.socketPath });

    await expect(client.request("events.subscribe", {
      runId: "run-1",
      cursor: "offset:99",
    })).resolves.toMatchObject({
      subscribed: false,
      replay: {
        status: "resync_required",
        reason: "cursor-ahead",
        cursor: "offset:99",
        watermark: 2,
      },
    });

    client.close();
    await server.close();
  });

  it("fences an in-flight old subscription before building its replacement replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-daemon-observer-fence-"));
    roots.push(root);
    const events = await fixtureEvents(3);
    const oldReadStarted = deferred<void>();
    const newReadStarted = deferred<void>();
    const oldRead = deferred<DaemonRunEventSnapshot>();
    const newRead = deferred<DaemonRunEventSnapshot>();
    let reads = 0;
    const source: DaemonRunEventSource = {
      async read(runId: string): Promise<DaemonRunEventSnapshot> {
        reads += 1;
        if (reads === 1) return eventSnapshot(events.slice(0, 2), runId);
        if (reads === 2) {
          oldReadStarted.resolve(undefined);
          return oldRead.promise;
        }
        if (reads === 3) {
          newReadStarted.resolve(undefined);
          return newRead.promise;
        }
        return eventSnapshot(events, runId);
      },
    };
    const server = new DaemonControlServer({
      host: new DaemonHost({
        admitWake: async (request) => ({ status: "admitted", inputId: request.wakeId ?? "input" }),
        activate: async () => undefined,
      }),
      observer: new DaemonRunObserver({ source, pollIntervalMs: 5 }),
      socketPath: join(root, "control.sock"),
    });
    await server.listen();
    const client = new DaemonControlClient({ socketPath: server.socketPath });
    const live: DaemonRunObservation[] = [];
    client.onRunEvent((observation) => live.push(observation));

    await client.request("events.subscribe", {
      runId: "run-1",
      cursor: "offset:0",
      limit: 8,
    });
    await oldReadStarted.promise;
    const replacement = client.request<{
      subscribed: boolean;
      replay: DaemonRunReplayResult;
    }>("events.subscribe", {
      runId: "run-1",
      cursor: "offset:2",
      limit: 8,
    });
    await newReadStarted.promise;
    oldRead.resolve(eventSnapshot(events, "run-1"));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(live).toEqual([]);
    newRead.resolve(eventSnapshot(events, "run-1"));

    await expect(replacement).resolves.toMatchObject({
      subscribed: true,
      replay: {
        status: "ok",
        cursor: "offset:2",
        nextCursor: "offset:3",
        events: [{ globalOffset: 3 }],
      },
    });
    expect(live).toEqual([]);

    client.close();
    await server.close();
  });
});

async function fixtureEvents(count: number): Promise<AnyEvent[]> {
  const ledger = new MemoryLedger({
    createEventId: (() => {
      let sequence = 0;
      return () => `control-event-${++sequence}`;
    })(),
  });
  for (let index = 1; index <= count; index += 1) {
    await ledger.append({
      runId: "run-1",
      laneId: "main",
      type: "lane.status",
      payload: { status: index === count ? "waiting" : "running" },
      correlationId: "control-test",
      idempotencyKey: `control-status-${index}`,
      occurredAt: `2026-01-01T00:00:0${index}.000Z`,
    });
  }
  return ledger.read({ runId: "run-1" });
}

function mutableSource(initial: readonly AnyEvent[]): DaemonRunEventSource & { events: AnyEvent[] } {
  const source = {
    events: [...initial],
    async read(runId: string): Promise<DaemonRunEventSnapshot> {
      return {
        runId,
        firstOffset: source.events.at(0)?.globalOffset ?? 0,
        watermark: source.events.at(-1)?.globalOffset ?? 0,
        events: source.events,
      };
    },
  };
  return source;
}

function eventSnapshot(
  events: readonly AnyEvent[],
  runId: string,
): DaemonRunEventSnapshot {
  return {
    runId,
    firstOffset: events.at(0)?.globalOffset ?? 0,
    watermark: events.at(-1)?.globalOffset ?? 0,
    events,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((mark) => { resolve = mark; });
  return { promise, resolve };
}
