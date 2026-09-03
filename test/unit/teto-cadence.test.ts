import { describe, expect, it } from "vitest";

import { TetoCadence, TokenRatioGate } from "../../src/teto/index.js";

describe("TetoCadence", () => {
  it("observes short work early, then keeps four sparse passes per 20 calls", () => {
    const cadence = new TetoCadence();
    const passes: number[] = [];

    for (let call = 1; call <= 20; call += 1) {
      const decision = cadence.recordMainCall("normal");
      if (decision.shouldWake) {
        passes.push(decision.mainCallIndex);
        cadence.commitPass(decision.mainCallIndex);
      }
    }

    expect(passes).toEqual([2, 7, 12, 17]);
  });

  it("never lets hard triggers bypass spacing or the rolling limit", () => {
    const cadence = new TetoCadence();
    const passes: number[] = [];
    const blocked: string[] = [];

    for (let call = 1; call <= 20; call += 1) {
      const decision = cadence.recordMainCall("contradiction");
      if (decision.shouldWake) {
        passes.push(call);
        cadence.commitPass(call);
      } else if (decision.blockedBy !== undefined) {
        blocked.push(decision.blockedBy);
      }
    }

    expect(passes).toEqual([1, 5, 9, 13]);
    expect(blocked).toContain("min-gap");
    expect(blocked).toContain("rolling-limit");

    const next = cadence.recordMainCall("goal-change");
    expect(next).toMatchObject({ mainCallIndex: 21, shouldWake: true });
  });

  it("uses max-gap as a backstop and preserves uncommitted credit", () => {
    const cadence = new TetoCadence({
      creditThreshold: 100,
      firstPassThreshold: 100,
      maxGap: 7,
    });
    for (let call = 1; call < 7; call += 1) {
      expect(cadence.recordMainCall().shouldWake).toBe(false);
    }
    const wake = cadence.recordMainCall();
    expect(wake).toMatchObject({ shouldWake: true, reason: "max-gap" });
    cadence.skipPass();
    expect(cadence.snapshot().credit).toBe(7);
  });

  it("restores cadence state without changing the next decision", () => {
    const original = new TetoCadence();
    for (let call = 0; call < 2; call += 1) {
      const decision = original.recordMainCall();
      if (decision.shouldWake) original.commitPass();
    }

    const restored = new TetoCadence({}, original.snapshot());
    for (let call = 0; call < 5; call += 1) {
      const decision = restored.recordMainCall();
      if (call === 4) {
        expect(decision).toMatchObject({ mainCallIndex: 7, shouldWake: true });
      }
    }
  });
});

describe("TokenRatioGate", () => {
  it("rejects token aggregation overflow instead of corrupting allowance", () => {
    const gate = new TokenRatioGate(0.1, {
      mainTokens: Number.MAX_SAFE_INTEGER,
      tetoTokens: 0,
      reservations: [],
    });

    expect(() => gate.chargeMain(1)).toThrow(/safe integer range/u);
  });

  it("reserves before a Teto call and caps Teto at 10% of all model tokens", () => {
    const gate = new TokenRatioGate();
    gate.chargeMain(900);

    expect(gate.availableTetoTokens()).toBe(100);
    expect(gate.reserve("pass-1", 101)).toBeUndefined();
    expect(gate.reserve("pass-1", 80)).toEqual({ id: "pass-1", tokens: 80 });
    expect(gate.availableTetoTokens()).toBe(20);
    expect(gate.reserve("pass-1", 80)).toEqual({ id: "pass-1", tokens: 80 });

    gate.settle("pass-1", 75);
    expect(gate.snapshot()).toMatchObject({ mainTokens: 900, tetoTokens: 75 });
    expect(gate.availableTetoTokens()).toBe(25);
  });

  it("restores outstanding reservations and rejects over-settlement", () => {
    const gate = new TokenRatioGate(0.1, {
      mainTokens: 900,
      tetoTokens: 20,
      reservations: [{ id: "in-flight", tokens: 30 }],
    });

    expect(gate.availableTetoTokens()).toBe(50);
    expect(() => gate.settle("in-flight", 31)).toThrow(/only allowed 30/);
    gate.cancel("in-flight");
    expect(gate.availableTetoTokens()).toBe(80);
  });

  it("counts cache read and write usage reported by pi-ai", () => {
    const gate = new TokenRatioGate();
    gate.chargeMain({
      input: 100,
      output: 100,
      cacheRead: 650,
      cacheWrite: 50,
    });

    expect(gate.snapshot().mainTokens).toBe(900);
    expect(gate.availableTetoTokens()).toBe(100);
  });
});
