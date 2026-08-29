import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ArtifactRef } from "../../src/domain/index.js";
import { sha256 } from "../../src/ledger/hash.js";
import {
  JsonlLedger,
  MemoryLedger,
  type Ledger,
} from "../../src/ledger/index.js";
import {
  createLedgerWakeAdmitter,
  deriveDaemonWakeIdempotencyKey,
  LedgerWakeAdmissionAdapter,
} from "../../src/runtime/daemon-wake-adapter.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function payloadRef(name = "payload"): ArtifactRef {
  const contentHash = sha256(name);
  return {
    id: contentHash,
    contentHash,
    mediaType: "text/plain",
    byteLength: name.length,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-wake",
    source: "webhook" as const,
    dedupeKey: "event-1",
    ...overrides,
  };
}

describe("LedgerWakeAdmissionAdapter", () => {
  it("maps payloadRef and occurredAt into one durable input fact", async () => {
    const ledger = new MemoryLedger({ createEventId: () => "event-1" });
    const admit = createLedgerWakeAdmitter({ ledger, delivery: "follow-up" });
    const occurredAt = "2026-08-29T12:34:56.000Z";

    await expect(admit(request({
      inputId: "input-explicit",
      payloadRef: payloadRef(),
      occurredAt,
    }))).resolves.toEqual({ status: "admitted", inputId: "input-explicit" });

    const [event] = await ledger.read({ runId: "run-wake" });
    expect(event).toMatchObject({
      type: "input.admitted",
      occurredAt,
      idempotencyKey: deriveDaemonWakeIdempotencyKey(request()),
      payload: {
        inputId: "input-explicit",
        messageRef: payloadRef(),
        delivery: "follow-up",
        sequence: 1,
      },
    });
  });

  it("serializes same-Run admissions and keeps independent dedupe keys distinct", async () => {
    const ledger = new MemoryLedger();
    const admit = new LedgerWakeAdmissionAdapter({
      ledger,
      resolvePayloadRef: async (wake) => payloadRef(wake.dedupeKey),
    }).admitWake;

    const results = await Promise.all([
      admit(request({ dedupeKey: "first" })),
      admit(request({ dedupeKey: "second" })),
    ]);
    expect(results).toEqual([
      { status: "admitted", inputId: expect.stringContaining("wake:sha256:") },
      { status: "admitted", inputId: expect.stringContaining("wake:sha256:") },
    ]);
    const events = await ledger.read({ runId: "run-wake" });
    expect(events.filter((event) => event.type === "input.admitted").map((event) => (
      event.type === "input.admitted" ? event.payload.sequence : 0
    ))).toEqual([1, 2]);
  });

  it("shares a race gate across adapters using the same Ledger", async () => {
    const ledger = new MemoryLedger();
    const first = new LedgerWakeAdmissionAdapter({
      ledger,
      resolvePayloadRef: () => payloadRef("same-dedupe"),
    });
    const second = new LedgerWakeAdmissionAdapter({
      ledger,
      resolvePayloadRef: () => payloadRef("same-dedupe"),
    });

    const [left, right] = await Promise.all([
      first.admit(request({ dedupeKey: "same-dedupe" })),
      second.admit(request({ dedupeKey: "same-dedupe" })),
    ]);
    expect([left.status, right.status].sort()).toEqual(["admitted", "duplicate"]);
    expect(await ledger.watermark()).toBe(1);
  });

  it("returns shouldActivate for pending replay, then omits it after delivery", async () => {
    const ledger = new MemoryLedger();
    const resolver = vi.fn(async () => payloadRef("replay"));
    const adapter = new LedgerWakeAdmissionAdapter({ ledger, resolvePayloadRef: resolver });
    const wake = request({ dedupeKey: "replay-key" });

    await expect(adapter.admit(wake)).resolves.toMatchObject({ status: "admitted" });
    await expect(adapter.admit({ ...wake, wakeId: "retry-after-restart" })).resolves.toMatchObject({
      status: "duplicate",
      shouldActivate: true,
    });
    expect(resolver).toHaveBeenCalledTimes(1);

    const admitted = (await ledger.read({ runId: wake.runId })).find((event) => event.type === "input.admitted");
    if (admitted === undefined || admitted.type !== "input.admitted") throw new Error("missing admission");
    await ledger.append({
      runId: wake.runId,
      turnId: "turn-1",
      laneId: "main",
      type: "input.delivered",
      payload: { inputId: admitted.payload.inputId, turnId: "turn-1", boundary: "daemon-test" },
      correlationId: "turn:turn-1",
      idempotencyKey: "input-delivered-1",
    });

    await expect(adapter.admit(wake)).resolves.toEqual({
      status: "duplicate",
      inputId: admitted.payload.inputId,
    });
  });

  it("preserves pending duplicate semantics after JsonlLedger reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-daemon-wake-"));
    roots.push(root);
    const path = join(root, "events.jsonl");
    const firstLedger = await JsonlLedger.open(path);
    const first = new LedgerWakeAdmissionAdapter({
      ledger: firstLedger,
      resolvePayloadRef: () => payloadRef("durable"),
    });
    await expect(first.admit(request({ dedupeKey: "durable-key" }))).resolves.toMatchObject({
      status: "admitted",
    });
    await firstLedger.close();

    const reopened = await JsonlLedger.open(path);
    const second = new LedgerWakeAdmissionAdapter({
      ledger: reopened,
      resolvePayloadRef: () => {
        throw new Error("resolver must not run for a replayed duplicate");
      },
    });
    await expect(second.admit(request({ dedupeKey: "durable-key" }))).resolves.toMatchObject({
      status: "duplicate",
      shouldActivate: true,
    });
    await reopened.close();
  });

  it("requires a resolver when a wake has no durable payload reference", async () => {
    const ledger: Ledger = new MemoryLedger();
    const adapter = new LedgerWakeAdmissionAdapter({ ledger });
    await expect(adapter.admit(request())).rejects.toThrow(/resolvePayloadRef/u);
  });

  it("rejects malformed payload references before touching the Ledger", async () => {
    const ledger = new MemoryLedger();
    const adapter = new LedgerWakeAdmissionAdapter({ ledger });
    await expect(adapter.admit(request({
      payloadRef: {
        id: "not-a-hash",
        contentHash: "not-a-hash",
        mediaType: "text/plain",
        byteLength: 1,
      },
    }))).rejects.toThrow(/ArtifactRef/u);
    await expect(ledger.watermark()).resolves.toBe(0);
  });
});
