import { describe, expect, it } from "vitest";

import type {
  AnyEvent,
  EventPayloadMap,
  EventType,
  TokenUsage,
} from "../../src/domain/index.js";
import {
  recoverRunTokenUsage,
  recoverRunTokenUsageByLane,
} from "../../src/runtime/index.js";

const chargedMain = usage(10, 4, 2, 1, 0.01);
const chargedTeto = usage(3, 1, 1, 0);
const unchargedWorker = usage(7, 2, 0, 1, 0.02);
const unchargedReflection = usage(5, 3, 2, 0);

describe("recoverRunTokenUsage", () => {
  it("fails closed when recovered usage aggregation overflows", () => {
    const tokenOverflow = [
      completed("main", "overflow:one", usage(Number.MAX_SAFE_INTEGER, 0, 0, 0), 1),
      completed("main", "overflow:two", usage(1, 0, 0, 0), 2),
    ];
    expect(() => recoverRunTokenUsage(tokenOverflow, "run-1")).toThrow(
      /recovered input tokens exceed the safe integer range/u,
    );

    const costOverflow = [
      completed("main", "cost:one", usage(1, 0, 0, 0, Number.MAX_VALUE), 3),
      completed("main", "cost:two", usage(1, 0, 0, 0, Number.MAX_VALUE), 4),
    ];
    expect(() => recoverRunTokenUsage(costOverflow, "run-1")).toThrow(
      /recovered cost exceeds the finite number range/u,
    );
  });

  it("sums authoritative charges across lanes and closes terminal crash windows", () => {
    const events = [
      completed("main", "run:main:step:1", usage(999, 999, 0, 0), 1),
      charged("main", "run:main:step:1", chargedMain, 2),
      observed("teto.observed", "teto", "teto:3", chargedTeto, 3),
      charged("teto", "teto:3", chargedTeto, 4),
      completed("worker", "run:worker:task:a:attempt:1", unchargedWorker, 5),
      observed(
        "reflection.observed",
        "reflection",
        "reflection:3",
        unchargedReflection,
        6,
      ),
    ];

    expect(recoverRunTokenUsage(events, "run-1")).toEqual({
      input: 25,
      output: 10,
      cacheRead: 5,
      cacheWrite: 2,
      costUsd: 0.03,
    });
    expect(recoverRunTokenUsageByLane(events, "run-1")).toEqual([
      { laneId: "main", usage: chargedMain },
      { laneId: "reflection", usage: unchargedReflection },
      { laneId: "teto", usage: chargedTeto },
      { laneId: "worker", usage: unchargedWorker },
    ]);
  });

  it("pairs every current terminal and budget idempotency convention", () => {
    const events = [
      completed("main", "session:turn:1:step:1", chargedMain, 1),
      charged("main", "session:turn:1:step:1", chargedMain, 2),
      completed("worker", "run-1:worker:task:a:attempt:1", unchargedWorker, 3),
      charged("worker", "run-1:worker:task:a:attempt:1", unchargedWorker, 4),
      observed("teto.observed", "teto", "teto:7", chargedTeto, 5),
      charged("teto", "teto:7", chargedTeto, 6),
      observed(
        "reflection.observed",
        "reflection",
        "reflection:7",
        unchargedReflection,
        7,
      ),
      charged("reflection", "reflection:7", unchargedReflection, 8),
    ];

    expect(recoverRunTokenUsage(events, "run-1")).toEqual({
      input: 25,
      output: 10,
      cacheRead: 5,
      cacheWrite: 2,
      costUsd: 0.03,
    });
  });

  it("pairs Fukai terminal usage with its charge and closes an uncharged failure window", () => {
    const compaction = `fukai:compaction:main:fukai-compaction:sha256:${"a".repeat(64)}`;
    const events = [
      compactionTerminal("fukai.compaction.completed", `${compaction}:attempt:1`, chargedMain, 1),
      charged("main", `${compaction}:attempt:1`, chargedMain, 2),
      compactionTerminal("fukai.compaction.failed", `${compaction}:attempt:2`, unchargedWorker, 3),
    ];

    expect(recoverRunTokenUsage(events, "run-1")).toEqual({
      input: 17,
      output: 6,
      cacheRead: 2,
      cacheWrite: 2,
      costUsd: 0.03,
    });
  });

  it("recovers the reserved maximum when successful Fukai usage was not persisted", () => {
    const compaction = `fukai:compaction:main:fukai-compaction:sha256:${"a".repeat(64)}`;
    const budget = { maxInputTokens: 100, maxOutputTokens: 20, maxWallClockMs: 1_000 };
    const events = [
      compactionRequested(`${compaction}:attempt:3`, 3, budget, 1),
      compactionTerminal(
        "fukai.compaction.completed",
        `${compaction}:attempt:3`,
        null,
        2,
        3,
      ),
      compactionRequested(`${compaction}:attempt:4`, 4, budget, 3),
      compactionTerminal("fukai.compaction.failed", `${compaction}:attempt:4`, null, 4, 4),
    ];

    expect(recoverRunTokenUsage(events.toReversed(), "run-1")).toEqual({
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("is deterministic under replay, reordering, and duplicate terminal forms", () => {
    const first = completed("hybrid", "hybrid:9", chargedMain, 1);
    const replay = {
      ...first,
      eventId: "event-replay",
      globalOffset: 20,
      payload: { ...first.payload, usage: usage(900, 900, 0, 0) },
    } satisfies AnyEvent;
    const duplicateForm = observed(
      "teto.observed",
      "hybrid",
      "hybrid:9",
      usage(800, 800, 0, 0),
      2,
    );
    const events = [replay, duplicateForm, first];

    expect(recoverRunTokenUsage(events, "run-1")).toEqual(chargedMain);
    expect(recoverRunTokenUsage(events.toReversed(), "run-1")).toEqual(chargedMain);
  });

  it("ignores other Runs and counts legacy unpaired charges once", () => {
    const legacyCharge = event("budget.charged", "main", {
      laneId: "main",
      usage: chargedMain,
    }, "legacy-budget", 1);
    const replay = { ...legacyCharge, eventId: "legacy-replay", globalOffset: 2 };
    const otherRun = {
      ...completed("main", "other:step:1", unchargedWorker, 3),
      runId: "run-2",
    } satisfies AnyEvent;

    expect(recoverRunTokenUsage([replay, otherRun, legacyCharge], "run-1"))
      .toEqual(chargedMain);
  });
});

function completed(
  laneId: string,
  prefix: string,
  terminalUsage: TokenUsage,
  offset: number,
): Extract<AnyEvent, { type: "model.completed" }> {
  return event("model.completed", laneId, {
    model: "test-model",
    responseRef: ref(`response-${offset}`),
    stopReason: "stop",
    usage: terminalUsage,
  }, `${prefix}:model:completed`, offset);
}

function observed(
  type: "teto.observed" | "reflection.observed",
  laneId: string,
  prefix: string,
  terminalUsage: TokenUsage,
  offset: number,
): Extract<AnyEvent, { type: typeof type }> {
  if (type === "teto.observed") {
    return event(type, laneId, {
      mainCallIndex: offset,
      trigger: "cadence",
      frameHash: `frame-${offset}`,
      usage: terminalUsage,
    }, `${prefix}:observed`, offset) as Extract<AnyEvent, { type: typeof type }>;
  }
  return event(type, laneId, {
    mainCallIndex: offset,
    trigger: "cadence",
    action: "silent",
    reflectionRef: ref(`reflection-${offset}`),
    usage: terminalUsage,
  }, `${prefix}:observed`, offset) as Extract<AnyEvent, { type: typeof type }>;
}

function charged(
  laneId: string,
  prefix: string,
  chargedUsage: TokenUsage,
  offset: number,
): Extract<AnyEvent, { type: "budget.charged" }> {
  return event("budget.charged", laneId, {
    laneId,
    usage: chargedUsage,
  }, `${prefix}:budget`, offset);
}

function compactionTerminal(
  type: "fukai.compaction.completed" | "fukai.compaction.failed",
  prefix: string,
  terminalUsage: TokenUsage | null,
  offset: number,
  attempt = offset === 1 ? 1 : 2,
): Extract<AnyEvent, { type: typeof type }> {
  const compactionId = `fukai-compaction:sha256:${"a".repeat(64)}`;
  const attemptId = `${compactionId}:attempt:${attempt}`;
  if (type === "fukai.compaction.completed") {
    const summary = ref(`compaction-summary-${offset}`);
    return event(type, "main", {
      compactionId,
      attemptId,
      attempt,
      elapsedMs: 10,
      usage: terminalUsage,
      summaryRef: summary,
      summaryHash: summary.contentHash,
      estimatedTokens: terminalUsage?.output ?? 0,
    }, `${prefix}:terminal`, offset) as Extract<AnyEvent, { type: typeof type }>;
  }
  return event(type, "main", {
    compactionId,
    attemptId,
    attempt,
    status: "failed",
    elapsedMs: 10,
    usage: terminalUsage,
  }, `${prefix}:terminal`, offset) as Extract<AnyEvent, { type: typeof type }>;
}

function compactionRequested(
  prefix: string,
  attempt: number,
  budget: {
    maxInputTokens: number;
    maxOutputTokens: number;
    maxWallClockMs: number;
  },
  offset: number,
): Extract<AnyEvent, { type: "fukai.compaction.requested" }> {
  const compactionId = `fukai-compaction:sha256:${"a".repeat(64)}`;
  return event("fukai.compaction.requested", "main", {
    compactionId,
    attemptId: `${compactionId}:attempt:${attempt}`,
    attempt,
    cursor: `offset:${offset}`,
    upperWatermark: offset,
    goalVersion: 1,
    policyVersion: "policy-v1",
    sourceRefs: [],
    budget,
  }, `${prefix}:requested`, offset);
}

function event<K extends EventType>(
  type: K,
  laneId: string,
  payload: EventPayloadMap[K],
  idempotencyKey: string,
  globalOffset: number,
): Extract<AnyEvent, { type: K }> {
  return {
    eventId: `event-${globalOffset}`,
    runId: "run-1",
    laneId,
    globalOffset,
    laneSeq: globalOffset,
    type,
    schemaVersion: 1,
    occurredAt: `2026-01-01T00:00:${String(globalOffset).padStart(2, "0")}.000Z`,
    correlationId: "run-1",
    idempotencyKey,
    visibility: "run",
    contentHash: `hash-${globalOffset}`,
    payload,
  } as Extract<AnyEvent, { type: K }>;
}

function usage(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  costUsd?: number,
): TokenUsage {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

function ref(id: string) {
  return {
    id,
    contentHash: `hash-${id}`,
    mediaType: "application/json",
    byteLength: 1,
  };
}
