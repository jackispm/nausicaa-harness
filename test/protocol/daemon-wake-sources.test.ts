import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFileWakeSource,
  createTimerWakeSource,
  createWebhookWakeSource,
  type DaemonFileWatcher,
  type DaemonWakeRequest,
} from "../../src/runtime/index.js";
import type { Clock } from "../../src/domain/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function mutableClock(initial: string): { clock: Clock; set(value: string): void } {
  let current = new Date(initial);
  return {
    clock: { now: () => new Date(current) },
    set(value: string): void {
      current = new Date(value);
    },
  };
}

function payloadRef(byteLength: number): {
  id: string;
  contentHash: string;
  mediaType: string;
  byteLength: number;
} {
  const contentHash = `sha256:${"a".repeat(64)}`;
  return { id: contentHash, contentHash, mediaType: "text/plain", byteLength };
}

describe("daemon wake sources", () => {
  it("uses stable timer slots and rejects a clock rollback", async () => {
    const clock = mutableClock("2026-08-29T00:00:01.000Z");
    const wakes: DaemonWakeRequest[] = [];
    const source = createTimerWakeSource({
      runId: "run-1",
      scheduleId: "every-minute",
      intervalMs: 60_000,
      clock: clock.clock,
      onWake: (wake) => {
        wakes.push(wake);
      },
    });

    await source.start();
    const first = await source.tick();
    clock.set("2026-08-29T00:00:30.000Z");
    const sameSlot = await source.tick();
    expect(sameSlot.dedupeKey).toBe(first.dedupeKey);
    clock.set("2026-08-29T00:01:01.000Z");
    const next = await source.tick();
    expect(next.dedupeKey).not.toBe(first.dedupeKey);
    clock.set("2026-08-29T00:00:59.000Z");
    await expect(source.tick()).rejects.toThrow(/moved backwards/u);
    expect(wakes).toHaveLength(3);
    await source.close();
    expect(source.running).toBe(false);
  });

  it("waits for an in-flight timer wake before completing stop", async () => {
    let release!: () => void;
    const onWake = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const source = createTimerWakeSource({
      runId: "run-stop",
      scheduleId: "stop-test",
      intervalMs: 60_000,
      onWake,
    });

    await source.start();
    const tick = source.tick();
    await vi.waitFor(() => expect(onWake).toHaveBeenCalledOnce());
    const stopping = source.stop();
    expect(source.running).toBe(false);
    release();
    await expect(tick).resolves.toMatchObject({ source: "timer" });
    await stopping;
    await expect(source.tick()).rejects.toThrow(/stopped/u);
  });

  it("rolls back a failed immediate timer wake", async () => {
    let attempts = 0;
    const source = createTimerWakeSource({
      runId: "run-immediate-failure",
      scheduleId: "bootstrap",
      intervalMs: 60_000,
      startImmediately: true,
      onWake: () => {
        attempts += 1;
        throw new Error("wake unavailable");
      },
    });

    await expect(source.start()).rejects.toThrow("wake unavailable");
    expect(source.running).toBe(false);
    await expect(source.tick()).rejects.toThrow(/stopped/u);
    expect(attempts).toBe(1);
    await source.close();
  });

  it("serializes webhook delivery and keeps event identity independent of payload", async () => {
    const order: string[] = [];
    const source = createWebhookWakeSource({
      runId: "run-webhook",
      webhookId: "github",
      onWake: async (wake) => {
        order.push(wake.dedupeKey);
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
    });
    await source.start();
    const first = source.receive({ eventId: "evt-1" });
    const second = source.receive({ eventId: "evt-2", inputId: "input-2" });
    const [one, two] = await Promise.all([first, second]);
    expect(order).toEqual([one.dedupeKey, two.dedupeKey]);
    expect(one.source).toBe("webhook");
    expect(two.inputId).toBe("input-2");
    await source.stop();
    await expect(source.receive({ eventId: "evt-3" })).rejects.toThrow(/stopped/u);
  });

  it("validates webhook payload references and optional size limits", async () => {
    const onWake = vi.fn();
    const source = createWebhookWakeSource({
      runId: "run-webhook-validation",
      webhookId: "github",
      maxPayloadBytes: 4,
      onWake,
    });
    await source.start();
    await expect(source.receive(null as never)).rejects.toThrow(/event must be an object/u);
    await expect(source.receive({ eventId: "" })).rejects.toThrow(/eventId/u);
    await expect(source.receive({ eventId: "large", payloadRef: {
      ...payloadRef(5),
      byteLength: 5,
    } })).rejects.toThrow(/maxPayloadBytes/u);
    await expect(source.receive({ eventId: "bad", payloadRef: {
      id: "bad",
      contentHash: "bad",
      mediaType: "text/plain",
      byteLength: 1,
    } } as never)).rejects.toThrow(/ArtifactRef/u);
    expect(onWake).not.toHaveBeenCalled();
    await source.close();
    expect(() => createWebhookWakeSource({
      runId: "run-webhook-validation",
      webhookId: "github",
      maxPayloadBytes: -1,
      onWake,
    })).toThrow(/maxPayloadBytes/u);
  });

  it("turns watched file revisions into deduplicable wakes and bounds paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-file-wake-"));
    roots.push(root);
    let emit: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
    const watcher: DaemonFileWatcher = {
      on: vi.fn(() => watcher),
      close: vi.fn(),
    };
    const wakes: DaemonWakeRequest[] = [];
    const source = createFileWakeSource({
      runId: "run-file",
      watchId: "workspace-watch",
      path: root,
      watchFactory: (_path, _options, listener) => {
        emit = listener;
        return watcher;
      },
      resolveRevision: async (_path, notification) => notification.revision ?? "auto",
      onWake: (wake) => {
        wakes.push(wake);
      },
    });

    await source.start();
    expect(source.running).toBe(true);
    const first = await source.notify({ eventType: "change", relativePath: "src/app.ts", revision: "r1" });
    const same = await source.notify({ eventType: "change", relativePath: "src/app.ts", revision: "r1" });
    expect(same.dedupeKey).toBe(first.dedupeKey);
    await expect(source.notify({ eventType: "change", relativePath: "../outside", revision: "r2" }))
      .rejects.toThrow(/watched directory/u);

    emit?.("change", "src/other.ts");
    await vi.waitFor(() => expect(wakes).toHaveLength(3));
    expect(watcher.close).not.toHaveBeenCalled();
    await source.close();
    expect(watcher.close).toHaveBeenCalledOnce();
  });

  it("reports unsupported watcher events and rejects absolute paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-file-events-"));
    roots.push(root);
    let emit!: (eventType: string, filename: string | Buffer | null) => void;
    const errors: Error[] = [];
    const watcher: DaemonFileWatcher = {
      on: vi.fn(() => watcher),
      close: vi.fn(),
    };
    const source = createFileWakeSource({
      runId: "run-file-events",
      watchId: "watch-events",
      path: root,
      watchFactory: (_path, _options, listener) => {
        emit = listener;
        return watcher;
      },
      onError: (error) => errors.push(error),
      onWake: () => undefined,
    });
    await source.start();
    emit("unknown", "file.txt");
    expect(errors).toHaveLength(1);
    await expect(source.notify({ eventType: "change", relativePath: "/outside", revision: "r1" }))
      .rejects.toThrow(/relativePath/u);
    await source.close();
  });
});
