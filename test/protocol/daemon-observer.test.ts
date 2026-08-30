import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AnyEvent } from "../../src/domain/events.js";
import { computeEventContentHash, MemoryLedger } from "../../src/ledger/index.js";
import {
  DaemonRunObserver,
  FileDaemonRunEventSource,
  projectDaemonRunReplay,
  type DaemonRunEventSnapshot,
  type DaemonRunEventSource,
  type DaemonRunObservation,
} from "../../src/runtime/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DaemonRunObserver", () => {
  it("pages a fixed Ledger watermark with canonical monotonic cursors", async () => {
    const events = await fixtureEvents(4);
    const source = mutableSource(events);
    const observer = new DaemonRunObserver({ source, pollIntervalMs: 5 });

    const first = await observer.replay({ runId: "run-1", cursor: "offset:0", limit: 2 });
    expect(first).toMatchObject({
      status: "ok",
      cursor: "offset:0",
      nextCursor: "offset:2",
      watermark: 4,
      hasMore: true,
    });
    if (first.status !== "ok") throw new Error("expected replay page");
    expect(first.events.map((event) => event.globalOffset)).toEqual([1, 2]);

    source.events.push((await fixtureEvents(5))[4]!);

    const second = await observer.replay({
      runId: "run-1",
      cursor: first.nextCursor,
      limit: 2,
      upperWatermark: first.watermark,
    });
    expect(second).toMatchObject({
      status: "ok",
      cursor: "offset:2",
      nextCursor: "offset:4",
      watermark: 4,
      hasMore: false,
    });
    if (second.status !== "ok") throw new Error("expected replay page");
    expect(second.events.map((event) => event.globalOffset)).toEqual([3, 4]);

    const liveSuffix = await observer.replay({
      runId: "run-1",
      cursor: second.nextCursor,
      limit: 2,
    });
    expect(liveSuffix).toMatchObject({
      status: "ok",
      watermark: 5,
      events: [{ globalOffset: 5 }],
    });
  });

  it("requires explicit resync for ahead, truncated, and gapped cursors", async () => {
    const events = await fixtureEvents(3);
    const ahead = projectDaemonRunReplay(snapshot(events), {
      runId: "run-1",
      cursor: "offset:4",
    });
    expect(ahead).toMatchObject({ status: "resync_required", reason: "cursor-ahead" });

    const retained = events.map((event) => withOffset(event, event.globalOffset + 4));
    const truncated = projectDaemonRunReplay(snapshot(retained), {
      runId: "run-1",
      cursor: "offset:2",
    });
    expect(truncated).toMatchObject({
      status: "resync_required",
      reason: "history-truncated",
      firstOffset: 5,
      watermark: 7,
    });
    const retainedBoundary = projectDaemonRunReplay(snapshot(retained), {
      runId: "run-1",
      cursor: "offset:4",
    });
    expect(retainedBoundary).toMatchObject({
      status: "ok",
      nextCursor: "offset:7",
      hasMore: false,
    });

    const gap = [events[0]!, withOffset(events[1]!, 3), withOffset(events[2]!, 4)];
    expect(projectDaemonRunReplay(snapshot(gap), {
      runId: "run-1",
      cursor: "offset:1",
    })).toMatchObject({ status: "resync_required", reason: "offset-gap" });

    const fullyTruncated: DaemonRunEventSnapshot = {
      runId: "run-1",
      firstOffset: 8,
      watermark: 7,
      events: [],
    };
    expect(projectDaemonRunReplay(fullyTruncated, {
      runId: "run-1",
      cursor: "offset:6",
    })).toMatchObject({ status: "resync_required", reason: "history-truncated" });
    expect(projectDaemonRunReplay(fullyTruncated, {
      runId: "run-1",
      cursor: "offset:7",
    })).toMatchObject({ status: "ok", nextCursor: "offset:7", events: [] });
  });

  it("hands off from replay to live polling without duplicates", async () => {
    const initial = await fixtureEvents(2);
    const source = mutableSource(initial);
    const observer = new DaemonRunObserver({ source, pollIntervalMs: 5 });
    const received: DaemonRunObservation[] = [];
    const live = deferred<DaemonRunObservation>();

    const subscription = await observer.subscribe(
      { runId: "run-1", cursor: "offset:0", limit: 8 },
      (observation) => {
        received.push(observation);
        if (observation.type === "event") live.resolve(observation);
      },
    );
    expect(subscription.subscribed).toBe(true);
    expect(subscription.replay).toMatchObject({
      status: "ok",
      nextCursor: "offset:2",
      hasMore: false,
    });

    const third = (await fixtureEvents(3))[2]!;
    source.events.push(third);
    await expect(live.promise).resolves.toMatchObject({
      type: "event",
      cursor: "offset:3",
      event: { globalOffset: 3 },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(received.filter((entry) => entry.type === "event")).toHaveLength(1);
    subscription.unsubscribe();
  });

  it("tails only newly completed JSONL records and carries a partial suffix", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-daemon-observer-"));
    roots.push(root);
    const runRoot = join(root, "runs", "run-1");
    await mkdir(runRoot, { recursive: true });
    const events = await fixtureEvents(3);
    const second = JSON.stringify(events[1]);
    const split = Math.floor(second.length / 2);
    const ledgerPath = join(runRoot, "ledger.jsonl");
    await writeFile(
      ledgerPath,
      `${JSON.stringify(events[0])}\n${second.slice(0, split)}`,
      "utf8",
    );

    const source = new FileDaemonRunEventSource({ dataDir: root });
    await expect(source.read("run-1")).resolves.toMatchObject({
      runId: "run-1",
      firstOffset: 1,
      watermark: 1,
      events: [{ globalOffset: 1 }],
    });
    await appendFile(ledgerPath, `${second.slice(split)}\n`, "utf8");
    await expect(source.read("run-1")).resolves.toMatchObject({
      watermark: 2,
      events: [{ globalOffset: 1 }, { globalOffset: 2 }],
    });
    await appendFile(ledgerPath, `${JSON.stringify(events[2])}\n`, "utf8");
    await expect(source.read("run-1")).resolves.toMatchObject({
      watermark: 3,
      events: [{ globalOffset: 1 }, { globalOffset: 2 }, { globalOffset: 3 }],
    });
  });

  it("preserves a copied rotation and requires resync after destructive replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-daemon-observer-rotate-"));
    roots.push(root);
    const runRoot = join(root, "runs", "run-1");
    await mkdir(runRoot, { recursive: true });
    const ledgerPath = join(runRoot, "ledger.jsonl");
    const events = await fixtureEvents(3);
    await writeFile(ledgerPath, jsonl(events.slice(0, 2)), "utf8");
    const source = new FileDaemonRunEventSource({ dataDir: root });
    const first = await source.read("run-1");

    const copied = join(runRoot, "ledger.copied");
    await writeFile(copied, jsonl(events), "utf8");
    await rename(copied, ledgerPath);
    const continued = await source.read("run-1");
    expect(continued).toMatchObject({
      generation: first.generation,
      watermark: 3,
      events: [{ globalOffset: 1 }, { globalOffset: 2 }, { globalOffset: 3 }],
    });

    const observer = new DaemonRunObserver({ source, pollIntervalMs: 5 });
    const resync = deferred<DaemonRunObservation>();
    const subscription = await observer.subscribe(
      { runId: "run-1", cursor: "offset:3" },
      (observation) => {
        if (observation.type === "resync_required") resync.resolve(observation);
      },
    );
    const replaced = events.map((event, index) => index === 0
      ? withStatus(event, "waiting")
      : event);
    const destructive = join(runRoot, "ledger.destructive");
    await writeFile(destructive, jsonl(replaced), "utf8");
    await rename(destructive, ledgerPath);

    await expect(resync.promise).resolves.toMatchObject({
      type: "resync_required",
      result: { reason: "history-truncated", watermark: 3 },
    });
    subscription.unsubscribe();

    await expect(observer.replay({
      runId: "run-1",
      cursor: "offset:3",
    })).resolves.toMatchObject({
      status: "resync_required",
      reason: "history-truncated",
      cursor: "offset:3",
      watermark: 3,
      generation: 1,
    });

    const replacementFirst = await observer.replay({
      runId: "run-1",
      cursor: "offset:0",
      limit: 2,
    });
    expect(replacementFirst).toMatchObject({
      status: "ok",
      nextCursor: "offset:2",
      watermark: 3,
      generation: 1,
      hasMore: true,
    });
    if (replacementFirst.status !== "ok") throw new Error("expected replacement replay");
    if (replacementFirst.generation === undefined) throw new Error("expected source generation");
    await expect(observer.replay({
      runId: "run-1",
      cursor: replacementFirst.nextCursor,
      upperWatermark: replacementFirst.watermark,
      generation: replacementFirst.generation,
    })).resolves.toMatchObject({
      status: "ok",
      nextCursor: "offset:3",
      watermark: 3,
      generation: 1,
      hasMore: false,
      events: [{ globalOffset: 3 }],
    });
  });
});

async function fixtureEvents(count: number): Promise<AnyEvent[]> {
  const ledger = new MemoryLedger({
    createEventId: (() => {
      let sequence = 0;
      return () => `event-${++sequence}`;
    })(),
  });
  for (let index = 1; index <= count; index += 1) {
    await ledger.append({
      runId: "run-1",
      laneId: "main",
      type: "lane.status",
      payload: { status: index === count ? "waiting" : "running" },
      correlationId: "test",
      idempotencyKey: `status-${index}`,
      occurredAt: `2026-01-01T00:00:0${index}.000Z`,
    });
  }
  return ledger.read({ runId: "run-1" });
}

function mutableSource(initial: readonly AnyEvent[]): DaemonRunEventSource & { events: AnyEvent[] } {
  const source = {
    events: [...initial],
    async read(runId: string): Promise<DaemonRunEventSnapshot> {
      return snapshot(source.events, runId);
    },
  };
  return source;
}

function snapshot(events: readonly AnyEvent[], runId = "run-1"): DaemonRunEventSnapshot {
  return {
    runId,
    firstOffset: events.at(0)?.globalOffset ?? 0,
    watermark: events.at(-1)?.globalOffset ?? 0,
    events,
  };
}

function withOffset(event: AnyEvent, globalOffset: number): AnyEvent {
  const content = { ...event, globalOffset };
  return {
    ...content,
    contentHash: computeEventContentHash(content),
  } as AnyEvent;
}

function withStatus(event: AnyEvent, status: "running" | "waiting"): AnyEvent {
  const content = { ...event, payload: { status } };
  return {
    ...content,
    contentHash: computeEventContentHash(content),
  } as AnyEvent;
}

function jsonl(events: readonly AnyEvent[]): string {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((mark) => { resolve = mark; });
  return { promise, resolve };
}
