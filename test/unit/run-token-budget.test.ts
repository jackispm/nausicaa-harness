import { describe, expect, it } from "vitest";

import { RunTokenBudget } from "../../src/runtime/index.js";

describe("RunTokenBudget", () => {
  it("atomically reserves one shared balance and makes retries idempotent", () => {
    const budget = new RunTokenBudget(100, 20);

    expect(budget.availableTokens()).toBe(80);
    expect(budget.reserve("main:1", 50)).toEqual({
      id: "main:1",
      tokens: 50,
      status: "reserved",
    });
    expect(budget.reserve("worker:1", 31)).toBeUndefined();
    expect(budget.reserve("worker:1", 30)).toMatchObject({ status: "reserved" });
    expect(budget.availableTokens()).toBe(0);
    expect(budget.reserve("main:1", 50)).toMatchObject({ status: "reserved" });
    expect(() => budget.reserve("main:1", 49)).toThrow(/different size/);

    expect(budget.snapshot()).toMatchObject({
      maxTokens: 100,
      usedTokens: 20,
      reservedTokens: 80,
      availableTokens: 0,
      reservations: [
        { id: "main:1", tokens: 50 },
        { id: "worker:1", tokens: 30 },
      ],
    });
  });

  it("settles four-part usage exactly once and releases unused capacity", () => {
    const budget = new RunTokenBudget(100, 20);
    budget.reserve("worker:1", 40);
    const usage = { input: 10, output: 5, cacheRead: 5, cacheWrite: 5 };

    expect(budget.settle("worker:1", usage)).toEqual({
      id: "worker:1",
      reservedTokens: 40,
      actualTokens: 25,
      overrunTokens: 0,
    });
    expect(budget.availableTokens()).toBe(55);
    expect(budget.settle("worker:1", 25)).toMatchObject({ actualTokens: 25 });
    expect(budget.snapshot().usedTokens).toBe(45);
    expect(budget.reserve("worker:1", 40)).toMatchObject({ status: "settled" });
    expect(() => budget.settle("worker:1", 24)).toThrow(/different usage/);
    expect(() => budget.reserve("worker:1", 39)).toThrow(/different size/);
  });

  it("charges an actual overrun and exhausts future capacity", () => {
    const budget = new RunTokenBudget(100, 80);
    budget.reserve("main:1", 20);

    expect(budget.settle("main:1", 35)).toMatchObject({
      actualTokens: 35,
      overrunTokens: 15,
    });
    expect(budget.snapshot()).toMatchObject({
      usedTokens: 115,
      reservedTokens: 0,
      availableTokens: 0,
    });
    expect(budget.reserve("worker:1", 1)).toBeUndefined();
  });

  it("cancels active reservations without rolling back settled usage", () => {
    const budget = new RunTokenBudget(100);
    budget.reserve("cancelled", 60);
    budget.cancel("cancelled");
    budget.cancel("cancelled");
    expect(budget.availableTokens()).toBe(100);

    budget.reserve("settled", 40);
    budget.settle("settled", 30);
    budget.cancel("settled");
    expect(budget.snapshot().usedTokens).toBe(30);
  });

  it("rejects invalid values and unknown settlements without mutation", () => {
    expect(() => new RunTokenBudget(0)).toThrow(/maxTokens/);
    expect(() => new RunTokenBudget(10, -1)).toThrow(/usedTokens/);
    const budget = new RunTokenBudget(10);
    expect(() => budget.reserve("", 1)).toThrow(/reservation id/);
    expect(() => budget.reserve("valid", 0)).toThrow(/positive/);
    expect(() => budget.settle("missing", 1)).toThrow(/Unknown/);
    expect(budget.snapshot()).toMatchObject({ usedTokens: 0, reservedTokens: 0 });
  });
});
