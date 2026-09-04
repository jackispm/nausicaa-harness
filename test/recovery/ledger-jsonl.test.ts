import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { AnyEvent, AppendEvent } from "../../src/domain/events.js";
import type { A2AMessage, TaskBudget } from "../../src/domain/types.js";
import {
  computeEventContentHash,
  JsonlLedger,
  LedgerCorruptionError,
  LedgerWriterLockedError,
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

function command(step: number): AppendEvent<"step.started"> {
  return {
    runId: "run-1",
    laneId: "main",
    type: "step.started",
    payload: { step },
    correlationId: "correlation-1",
    idempotencyKey: `step-${step}`,
    occurredAt: `2026-01-01T00:00:${String(step).padStart(2, "0")}.000Z`,
  };
}

async function fixture(): Promise<{
  directory: string;
  path: string;
  events: AnyEvent[];
}> {
  const directory = await mkdtemp(join(tmpdir(), "nausicaa-ledger-recovery-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "events.jsonl");
  const memory = new MemoryLedger({
    createEventId: (() => {
      let id = 0;
      return () => `event-${++id}`;
    })(),
  });
  await memory.append(command(1));
  await memory.append(command(2));
  const events = await memory.read();
  await memory.close();
  return { directory, path, events };
}

function line(event: AnyEvent): string {
  return `${JSON.stringify(event)}\n`;
}

describe("JsonlLedger recovery", () => {
  it("discards a final torn fragment and continues from the last committed line", async () => {
    const { path, events } = await fixture();
    await writeFile(path, `${line(events[0]!)}${JSON.stringify(events[1]!).slice(0, 31)}`);

    const ledger = await JsonlLedger.open(path, { createEventId: () => "event-recovered" });
    expect(await ledger.read()).toEqual([events[0]]);
    const recovered = await ledger.append(command(2));
    expect(recovered.globalOffset).toBe(2);
    expect(recovered.laneSeq).toBe(2);
    await ledger.close();

    const contents = await readFile(path, "utf8");
    expect(contents.trimEnd().split("\n")).toHaveLength(2);
    const reopened = await JsonlLedger.open(path);
    expect(await reopened.watermark()).toBe(2);
    await reopened.close();
  });

  it("rejects malformed JSON before a later committed record", async () => {
    const { path, events } = await fixture();
    await writeFile(path, `${line(events[0]!)}{"broken":\n${line(events[1]!)}`);

    await expect(JsonlLedger.open(path)).rejects.toBeInstanceOf(LedgerCorruptionError);
  });

  it("rejects a global offset gap even when hashes are internally valid", async () => {
    const { path, events } = await fixture();
    const { contentHash: _hash, ...secondContent } = events[1]!;
    const gapContent = { ...secondContent, globalOffset: 3 };
    const gap = {
      ...gapContent,
      contentHash: computeEventContentHash(gapContent),
    } as AnyEvent;
    await writeFile(path, `${line(events[0]!)}${line(gap)}`);

    await expect(JsonlLedger.open(path)).rejects.toThrow(/Expected globalOffset 2/);
  });

  it("rejects content changed without updating its hash", async () => {
    const { path, events } = await fixture();
    const tampered = {
      ...events[1]!,
      payload: { step: 999 },
    } as AnyEvent;
    await writeFile(path, `${line(events[0]!)}${line(tampered)}`);

    await expect(JsonlLedger.open(path)).rejects.toThrow(/Content hash mismatch/);
  });

  it("treats a complete-looking record without newline as uncommitted", async () => {
    const { path, events } = await fixture();
    await writeFile(path, line(events[0]!));
    await appendFile(path, JSON.stringify(events[1]!));

    const ledger = await JsonlLedger.open(path);
    expect(await ledger.read()).toEqual([events[0]]);
    await ledger.close();
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
  });

  it("preserves idempotency and lane sequence after reopening", async () => {
    const { path } = await fixture();
    const firstLedger = await JsonlLedger.open(path, {
      createEventId: () => "event-original",
    });
    const original = await firstLedger.append(command(1));
    await firstLedger.close();

    const reopened = await JsonlLedger.open(path, {
      createEventId: () => "event-next",
    });
    expect(await reopened.append(command(1))).toEqual(original);
    const next = await reopened.append(command(2));
    expect(next).toMatchObject({
      eventId: "event-next",
      globalOffset: 2,
      laneSeq: 2,
    });
    await reopened.close();
  });

  it("reopens mixed legacy and current Worker events without changing hashes", async () => {
    const { path } = await fixture();
    let eventId = 0;
    const ledger = await JsonlLedger.open(path, {
      createEventId: () => `worker-event-${++eventId}`,
    });
    const legacy = workerRequest("legacy-task", {
      maxModelTokens: 100,
      maxWallClockMs: 1_000,
    });
    const current = workerRequest("current-task", {
      maxModelTokens: 100,
      maxWallClockMs: 1_000,
      deadline: "2026-08-27T12:00:01.000Z",
      maxAttempts: 2,
    });
    await ledger.append({
      runId: "run-1",
      laneId: "main",
      type: "message.sent",
      payload: { message: legacy },
      correlationId: legacy.correlationId,
      idempotencyKey: "legacy-task-sent",
      occurredAt: legacy.createdAt,
    });
    await ledger.append({
      runId: "run-1",
      laneId: "worker",
      type: "model.failed",
      payload: { model: "model-1", error: "legacy failure" },
      correlationId: legacy.correlationId,
      idempotencyKey: "legacy-model-failed",
      occurredAt: legacy.createdAt,
    });
    await ledger.append({
      runId: "run-1",
      laneId: "main",
      type: "message.sent",
      payload: { message: current },
      correlationId: current.correlationId,
      idempotencyKey: "current-task-sent",
      occurredAt: current.createdAt,
    });
    await ledger.append({
      runId: "run-1",
      laneId: "worker",
      type: "model.failed",
      payload: { model: "model-1", error: "current failure", retryable: true },
      correlationId: current.correlationId,
      idempotencyKey: "current-model-failed",
      occurredAt: current.createdAt,
    });
    const before = await ledger.read({ runId: "run-1" });
    await ledger.close();

    const reopened = await JsonlLedger.open(path);
    const after = await reopened.read({ runId: "run-1" });
    expect(after).toEqual(before);
    expect(after.map((event) => event.contentHash)).toEqual(
      before.map((event) => event.contentHash),
    );
    expect(after.every((event) => event.schemaVersion === 1)).toBe(true);
    await reopened.close();
  });

  it("does not persist a duplicate generated event id", async () => {
    const { path } = await fixture();
    const ledger = await JsonlLedger.open(path, { createEventId: () => "same" });
    await ledger.append(command(1));
    await expect(ledger.append(command(2))).rejects.toThrow(/Duplicate eventId/);
    await ledger.close();

    const reopened = await JsonlLedger.open(path);
    await expect(reopened.read()).resolves.toHaveLength(1);
    await reopened.close();
  });

  it("freezes an append command at its call boundary", async () => {
    const { path } = await fixture();
    const ledger = await JsonlLedger.open(path);
    const mutable = command(1);
    const pending = ledger.append(mutable);
    mutable.payload.step = 999;
    await pending;

    expect((await ledger.read())[0]?.payload).toEqual({ step: 1 });
    await ledger.close();
  });

  it("allows only one writer and releases ownership on close", async () => {
    const { path } = await fixture();
    const first = await JsonlLedger.open(path);
    await expect(JsonlLedger.open(path)).rejects.toBeInstanceOf(
      LedgerWriterLockedError,
    );

    await first.close();
    const second = await JsonlLedger.open(path);
    await expect(second.append(command(1))).resolves.toMatchObject({ globalOffset: 1 });
    await second.close();
  });

  it("recovers a lock owned by a dead local pid", async () => {
    const { path } = await fixture();
    await writeFile(`${path}.lock`, `${JSON.stringify({
      version: 1,
      pid: 999_999,
      hostname: hostname(),
      token: "stale-owner",
    })}\n`, { mode: 0o600 });

    const ledger = await JsonlLedger.open(path);
    await expect(ledger.append(command(1))).resolves.toMatchObject({ globalOffset: 1 });
    await ledger.close();
  });

  it("rejects an oversized writer lock before reading its payload", async () => {
    const { path } = await fixture();
    await writeFile(`${path}.lock`, `${"x".repeat(4 * 1024 + 1)}\n`, { mode: 0o600 });

    await expect(JsonlLedger.open(path)).rejects.toBeInstanceOf(
      LedgerWriterLockedError,
    );
  });

  it("never follows a symbolic-link ledger file", async () => {
    const { directory, path } = await fixture();
    const outside = join(directory, "outside.jsonl");
    await writeFile(outside, "do-not-truncate");
    await symlink(outside, path);

    await expect(JsonlLedger.open(path)).rejects.toThrow(/symbolic-link/i);
    await expect(readFile(outside, "utf8")).resolves.toBe("do-not-truncate");
  });

  it("rejects a symbolic-link parent without writing through it", async () => {
    const { directory } = await fixture();
    const outside = join(directory, "outside");
    const linkedParent = join(directory, "linked-parent");
    await mkdir(outside);
    await symlink(outside, linkedParent, "dir");

    await expect(JsonlLedger.open(join(linkedParent, "events.jsonl")))
      .rejects.toThrow(/symbolic-link/i);
    await expect(readFile(join(outside, "events.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

function workerRequest(taskId: string, budget: TaskBudget): A2AMessage {
  return {
    messageId: `${taskId}-message`,
    runId: "run-1",
    conversationId: "conversation-1",
    threadId: "thread-1",
    from: "main",
    to: "worker",
    createdAt: "2026-08-27T12:00:00.000Z",
    correlationId: `${taskId}-correlation`,
    idempotencyKey: `${taskId}-message`,
    visibility: "run",
    priority: 1,
    delivery: "next-step",
    payload: {
      type: "task.request",
      taskId,
      goal: {
        version: 1,
        statement: "Inspect the project",
        successCriteria: [],
        hardConstraints: [],
      },
      inputRefs: [],
      budget,
    },
  };
}
