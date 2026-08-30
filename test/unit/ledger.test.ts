import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { AppendEvent, EventType } from "../../src/domain/events.js";
import type { Clock } from "../../src/domain/ports.js";
import {
  IdempotencyConflictError,
  JsonlLedger,
  type Ledger,
  MemoryLedger,
} from "../../src/ledger/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, {
      recursive: true,
      force: true,
    })),
  );
});

function input<K extends EventType>(
  type: K,
  payload: AppendEvent<K>["payload"],
  options: Partial<Pick<
    AppendEvent<K>,
    "runId" | "turnId" | "laneId" | "idempotencyKey"
  >> = {},
): AppendEvent<K> {
  return {
    runId: options.runId ?? "run-1",
    ...(options.turnId === undefined ? {} : { turnId: options.turnId }),
    laneId: options.laneId ?? "main",
    type,
    payload,
    correlationId: "correlation-1",
    idempotencyKey: options.idempotencyKey ?? `${type}-1`,
  };
}

function deterministicOptions() {
  let id = 0;
  let tick = 0;
  const clock: Clock = {
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  };
  return {
    clock,
    createEventId: () => `event-${++id}`,
  };
}

async function ledgerImplementations(): Promise<Array<{
  name: string;
  ledger: Ledger;
}>> {
  const directory = await mkdtemp(join(tmpdir(), "nausicaa-ledger-unit-"));
  temporaryDirectories.push(directory);
  return [
    { name: "memory", ledger: new MemoryLedger(deterministicOptions()) },
    {
      name: "jsonl",
      ledger: await JsonlLedger.open(
        join(directory, "events.jsonl"),
        deterministicOptions(),
      ),
    },
  ];
}

describe("Ledger conformance", () => {
  it("assigns global offsets and run-local lane sequences", async () => {
    for (const { ledger } of await ledgerImplementations()) {
      try {
        const first = await ledger.append(input("lane.registered", { kind: "main" }));
        const second = await ledger.append(input(
          "lane.registered",
          { kind: "intent-navigator" },
          { laneId: "teto", idempotencyKey: "register-teto" },
        ));
        const third = await ledger.append(input(
          "lane.status",
          { status: "running" },
          { idempotencyKey: "main-running" },
        ));

        expect([first.globalOffset, second.globalOffset, third.globalOffset]).toEqual([1, 2, 3]);
        expect([first.laneSeq, second.laneSeq, third.laneSeq]).toEqual([1, 1, 2]);
        expect(await ledger.watermark()).toBe(3);
      } finally {
        await ledger.close();
      }
    }
  });

  it("returns the original event for an idempotent retry", async () => {
    for (const { ledger } of await ledgerImplementations()) {
      try {
        const command = input("lane.registered", { kind: "main" });
        const first = await ledger.append(command);
        const retried = await ledger.append(command);

        expect(retried).toEqual(first);
        expect(await ledger.watermark()).toBe(1);
        expect(await ledger.read()).toEqual([first]);
      } finally {
        await ledger.close();
      }
    }
  });

  it("rejects an idempotency key reused for a different fact", async () => {
    for (const { ledger } of await ledgerImplementations()) {
      try {
        await ledger.append(input("lane.status", { status: "ready" }));
        await expect(ledger.append(input("lane.status", { status: "failed" })))
          .rejects.toBeInstanceOf(IdempotencyConflictError);
        expect(await ledger.watermark()).toBe(1);
      } finally {
        await ledger.close();
      }
    }
  });

  it("preserves Turn identity and includes it in idempotency fingerprints", async () => {
    for (const { ledger } of await ledgerImplementations()) {
      try {
        const first = input(
          "lane.status",
          { status: "ready" },
          { turnId: "turn-1", idempotencyKey: "start-turn" },
        );
        const appended = await ledger.append(first);
        expect(appended.turnId).toBe("turn-1");
        await expect(ledger.append(first)).resolves.toEqual(appended);

        await expect(ledger.append(input(
          "lane.status",
          { status: "ready" },
          { turnId: "turn-2", idempotencyKey: "start-turn" },
        ))).rejects.toBeInstanceOf(IdempotencyConflictError);
      } finally {
        await ledger.close();
      }
    }
  });

  it("deduplicates admission retries by inputId and rejects conflicting reuse", async () => {
    for (const { ledger } of await ledgerImplementations()) {
      try {
        const messageRef = {
          id: "message-1",
          contentHash: `sha256:${"a".repeat(64)}`,
          mediaType: "text/plain",
          byteLength: 5,
        };
        const admitted = await ledger.append(input("input.admitted", {
          inputId: "input-1",
          messageRef,
          delivery: "new-turn",
          sequence: 1,
        }, { idempotencyKey: "admit-input-1" }));
        const retried = await ledger.append(input("input.admitted", {
          inputId: "input-1",
          messageRef: { ...messageRef, id: "equivalent-content" },
          delivery: "new-turn",
          sequence: 2,
        }, { idempotencyKey: "retry-after-lost-ack" }));

        expect(retried).toEqual(admitted);
        expect(await ledger.watermark()).toBe(1);
        await expect(ledger.append(input("input.admitted", {
          inputId: "input-1",
          messageRef,
          delivery: "follow-up",
          sequence: 2,
        }, { idempotencyKey: "conflicting-input-1" })))
          .rejects.toBeInstanceOf(IdempotencyConflictError);

        await expect(ledger.append(input("input.admitted", {
          inputId: "input-2",
          messageRef,
          delivery: "follow-up",
          sequence: 1,
        }, { idempotencyKey: "non-monotonic-input-2" }))).rejects.toThrow(/not monotonic/);
      } finally {
        await ledger.close();
      }
    }
  });

  it("enforces append-only input replacement and withdrawal CAS", async () => {
    for (const { ledger } of await ledgerImplementations()) {
      try {
        const firstRef = {
          id: "message-first",
          contentHash: `sha256:${"a".repeat(64)}`,
          mediaType: "text/plain",
          byteLength: 5,
        };
        const secondRef = {
          ...firstRef,
          id: "message-second",
          contentHash: `sha256:${"b".repeat(64)}`,
        };
        await ledger.append(input("input.admitted", {
          inputId: "mutable-input",
          messageRef: firstRef,
          delivery: "follow-up",
          sequence: 1,
        }, { idempotencyKey: "mutable-admitted" }));
        await ledger.append(input("input.replaced", {
          inputId: "mutable-input",
          expectedRevision: 1,
          expectedMessageRef: firstRef,
          revision: 2,
          messageRef: secondRef,
          delivery: "follow-up",
          sequence: 1,
        }, { idempotencyKey: "mutable-replaced-2" }));

        await expect(ledger.append(input("input.replaced", {
          inputId: "mutable-input",
          expectedRevision: 1,
          expectedMessageRef: firstRef,
          revision: 2,
          messageRef: secondRef,
          delivery: "follow-up",
          sequence: 1,
        }, { idempotencyKey: "stale-replacement" }))).rejects.toThrow(/current revision is 2/);
        await expect(ledger.append(input("input.replaced", {
          inputId: "mutable-input",
          expectedRevision: 2,
          expectedMessageRef: firstRef,
          revision: 3,
          messageRef: firstRef,
          delivery: "follow-up",
          sequence: 1,
        }, { idempotencyKey: "stale-message-ref" }))).rejects.toThrow(/message ref/);
        await expect(ledger.append(input("input.replaced", {
          inputId: "mutable-input",
          expectedRevision: 2,
          expectedMessageRef: secondRef,
          revision: 4,
          messageRef: firstRef,
          delivery: "follow-up",
          sequence: 1,
        }, { idempotencyKey: "skipped-revision" }))).rejects.toThrow(/increment by one/);
        await expect(ledger.append(input("input.replaced", {
          inputId: "mutable-input",
          expectedRevision: 2,
          expectedMessageRef: secondRef,
          revision: 3,
          messageRef: firstRef,
          delivery: "follow-up",
          sequence: 2,
        }, { idempotencyKey: "changed-sequence" }))).rejects.toThrow(/cannot change queue sequence/);

        await ledger.append(input("input.withdrawn", {
          inputId: "mutable-input",
          expectedRevision: 2,
          expectedMessageRef: secondRef,
        }, { idempotencyKey: "mutable-withdrawn" }));
        await expect(ledger.append(input("input.withdrawn", {
          inputId: "mutable-input",
          expectedRevision: 2,
          expectedMessageRef: secondRef,
        }, { idempotencyKey: "withdrawn-again" }))).rejects.toThrow(/withdraw withdrawn input/);

        await ledger.append(input("input.admitted", {
          inputId: "delivered-input",
          messageRef: firstRef,
          delivery: "follow-up",
          sequence: 2,
        }, { idempotencyKey: "delivered-admitted" }));
        await ledger.append(input("input.delivered", {
          inputId: "delivered-input",
          turnId: "turn-delivered",
          boundary: "test",
          expectedRevision: 1,
          expectedMessageRef: firstRef,
        }, { turnId: "turn-delivered", idempotencyKey: "delivered-terminal" }));
        await expect(ledger.append(input("input.replaced", {
          inputId: "delivered-input",
          expectedRevision: 1,
          expectedMessageRef: firstRef,
          revision: 2,
          messageRef: secondRef,
          delivery: "follow-up",
          sequence: 2,
        }, { idempotencyKey: "replace-delivered" }))).rejects.toThrow(/replace delivered input/);
      } finally {
        await ledger.close();
      }
    }
  });

  it("filters reads without exposing mutable internal events", async () => {
    for (const { ledger } of await ledgerImplementations()) {
      try {
        await ledger.append(input("lane.registered", { kind: "main" }));
        await ledger.append(input(
          "lane.registered",
          { kind: "main" },
          { runId: "run-2", idempotencyKey: "run-2-lane" },
        ));
        const third = await ledger.append(input(
          "lane.status",
          { status: "running" },
          { idempotencyKey: "main-running" },
        ));

        const filtered = await ledger.read({ runId: "run-1", afterOffset: 1 });
        expect(filtered).toEqual([third]);
        filtered[0]!.payload = { status: "failed" };
        expect((await ledger.read({ afterOffset: 2 }))[0]).toEqual(third);
      } finally {
        await ledger.close();
      }
    }
  });

  it("serializes concurrent appends in call order", async () => {
    for (const { ledger } of await ledgerImplementations()) {
      try {
        const events = await Promise.all(
          Array.from({ length: 20 }, (_, index) => ledger.append(input(
            "step.started",
            { step: index + 1 },
            { idempotencyKey: `step-${index + 1}` },
          ))),
        );
        expect(events.map((event) => event.globalOffset)).toEqual(
          Array.from({ length: 20 }, (_, index) => index + 1),
        );
        expect(events.map((event) => event.laneSeq)).toEqual(
          Array.from({ length: 20 }, (_, index) => index + 1),
        );
      } finally {
        await ledger.close();
      }
    }
  });

  it("drains an accepted JSONL append before close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nausicaa-ledger-close-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "events.jsonl");
    const ledger = await JsonlLedger.open(path, deterministicOptions());

    const append = ledger.append(input("lane.registered", { kind: "main" }));
    const close = ledger.close();
    await expect(append).resolves.toMatchObject({ globalOffset: 1, laneSeq: 1 });
    await expect(close).resolves.toBeUndefined();

    const reopened = await JsonlLedger.open(path);
    expect(await reopened.watermark()).toBe(1);
    await reopened.close();
  });

  it("rejects NUL-delimited identifier ambiguity", async () => {
    for (const { ledger } of await ledgerImplementations()) {
      try {
        await expect(ledger.append(input(
          "lane.registered",
          { kind: "main" },
          { runId: "run\0other" },
        ))).rejects.toThrow(/runId/);
      } finally {
        await ledger.close();
      }
    }
  });

  it("rejects invalid optional Turn and causation identifiers", async () => {
    for (const { ledger } of await ledgerImplementations()) {
      try {
        await expect(ledger.append({
          ...input("lane.status", { status: "ready" }),
          turnId: "",
        })).rejects.toThrow(/turnId/);
        await expect(ledger.append({
          ...input("lane.status", { status: "ready" }),
          causationId: "cause\0other",
        })).rejects.toThrow(/causationId/);
      } finally {
        await ledger.close();
      }
    }
  });
});
