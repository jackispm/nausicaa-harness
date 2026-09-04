import { describe, expect, it } from "vitest";

import type { ModelPort, ModelResponse } from "../../src/domain/ports.js";
import { ProviderModelError } from "../../src/model/index.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import {
  ContentStoreFukaiSource,
  FukaiContextProvider,
} from "../../src/fukai/index.js";
import { MainLoop } from "../../src/runtime/main-loop.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

describe("MainLoop model retry boundary", () => {
  it("retries transient provider failures without duplicating durable settlement", async () => {
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    let calls = 0;
    const model: ModelPort = {
      async complete() {
        calls += 1;
        if (calls === 1) {
          throw new ProviderModelError({
            category: "server",
            status: 503,
            retryable: true,
          });
        }
        return response;
      },
    };
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [],
    });

    const pending = loop.run({
      runId: "main-default-retry",
      goal: {
        version: 1,
        statement: "Answer",
        successCriteria: [],
        hardConstraints: [],
      },
      model: "demo",
      workspace: process.cwd(),
      policy: {
        maxMainSteps: 1,
        maxModelTokens: 10_000,
        tetoEnabled: false,
        tetoMaxOutputTokens: 64,
        tetoTokenRatio: 0.1,
      },
      initialMessage: "Go",
    });
    await expect(pending).resolves.toMatchObject({
      completed: true,
      finalText: "recovered",
    });

    expect(calls).toBe(2);
    const events = await ledger.read({ runId: "main-default-retry" });
    expect(events.filter((event) => event.type === "model.requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "model.completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "budget.charged")).toHaveLength(1);
    expect(events.some((event) => event.type === "model.failed")).toBe(false);
    const requested = events.find((event) => event.type === "model.requested");
    const retries = events.filter((event) => event.type === "model.retrying");
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({
      type: "model.retrying",
      causationId: requested?.eventId,
      correlationId: requested?.correlationId,
      payload: {
        requestId: requested?.eventId,
        model: "demo",
        attempt: 1,
        maxAttempts: 4,
        category: "server",
      },
    });
    expect(retries[0]?.payload).toMatchObject({ delayMs: expect.any(Number) });
    expect((retries[0]?.payload as { delayMs: number }).delayMs).toBeGreaterThanOrEqual(1_500);
    expect((retries[0]?.payload as { delayMs: number }).delayMs).toBeLessThanOrEqual(2_000);
  });
});

const response: ModelResponse = {
  content: "recovered",
  toolCalls: [],
  stopReason: "stop",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
  },
};
