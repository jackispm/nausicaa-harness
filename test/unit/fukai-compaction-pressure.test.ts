import { describe, expect, it } from "vitest";

import {
  decideFukaiCompactionPressure,
  type FukaiCompactionPressureInput,
} from "../../src/fukai/compaction-pressure.js";

describe("decideFukaiCompactionPressure", () => {
  it("does not become eligible before the floored pressure threshold", () => {
    const input = request({ currentTokens: 799 });

    expect(decideFukaiCompactionPressure(input)).toEqual({
      status: "skip",
      reason: "below-threshold",
      thresholdTokens: 800,
      minimumRetainedRawTokens: 200,
      retainedRawTokens: 900,
      selectedRawTokens: 0,
      predictedGainTokens: -100,
      selectedGroupIds: [],
      selectedRefs: [],
    });
    expect(decideFukaiCompactionPressure({
      ...input,
      contextWindowTokens: 999,
      thresholdRatio: 0.8,
      currentTokens: 799,
    })).toMatchObject({
      status: "compact",
      thresholdTokens: 799,
    });
  });

  it("selects whole oldest groups and retains the newest raw-token floor", () => {
    const input = request();

    const decision = decideFukaiCompactionPressure(input);

    expect(decision).toEqual({
      status: "compact",
      reason: "pressure-threshold-reached",
      thresholdTokens: 800,
      minimumRetainedRawTokens: 200,
      retainedRawTokens: 300,
      selectedRawTokens: 600,
      predictedGainTokens: 500,
      selectedGroupIds: ["turn-1", "turn-2"],
      selectedRefs: input.conversationRefs.slice(0, 3),
    });
    expect(input.conversationRefs).toHaveLength(4);
  });

  it("uses group boundaries even when a boundary retains more than required", () => {
    const decision = decideFukaiCompactionPressure(request({
      retainRatio: 0.25,
      conversationRefs: [
        ref("old-user", "old", 300),
        ref("old-assistant", "old", 200),
        ref("middle", "middle", 260),
        ref("latest", "latest", 240),
      ],
    }));

    expect(decision).toMatchObject({
      status: "compact",
      minimumRetainedRawTokens: 250,
      retainedRawTokens: 500,
      selectedRawTokens: 500,
      selectedGroupIds: ["old"],
    });
  });

  it("never skips a blocking middle group to select a newer group", () => {
    const input = request({
      retainRatio: 0.3,
      conversationRefs: [
        ref("old", "old", 400),
        ref("blocking", "blocking", 350),
        ref("newer", "newer", 100),
        ref("latest", "latest", 150),
      ],
    });

    expect(decideFukaiCompactionPressure(input)).toMatchObject({
      selectedRawTokens: 400,
      retainedRawTokens: 600,
      selectedGroupIds: ["old"],
      selectedRefs: input.conversationRefs.slice(0, 1),
    });
  });

  it("treats the threshold and minimum gain boundaries as inclusive", () => {
    const decision = decideFukaiCompactionPressure(request({
      currentTokens: 800,
      minimumGainTokens: 500,
    }));

    expect(decision).toMatchObject({
      status: "compact",
      thresholdTokens: 800,
      predictedGainTokens: 500,
    });
  });

  it("reports a candidate but skips when its worst-case gain is too small", () => {
    const input = request({ minimumGainTokens: 501 });

    expect(decideFukaiCompactionPressure(input)).toEqual({
      status: "skip",
      reason: "insufficient-predicted-gain",
      thresholdTokens: 800,
      minimumRetainedRawTokens: 200,
      retainedRawTokens: 300,
      selectedRawTokens: 600,
      predictedGainTokens: 500,
      selectedGroupIds: ["turn-1", "turn-2"],
      selectedRefs: input.conversationRefs.slice(0, 3),
    });
  });

  it("skips when no complete old group can be removed", () => {
    expect(decideFukaiCompactionPressure(request({
      conversationRefs: [
        ref("only-user", "only", 300),
        ref("only-assistant", "only", 600),
      ],
    }))).toEqual({
      status: "skip",
      reason: "no-compactable-prefix",
      thresholdTokens: 800,
      minimumRetainedRawTokens: 200,
      retainedRawTokens: 900,
      selectedRawTokens: 0,
      predictedGainTokens: -100,
      selectedGroupIds: [],
      selectedRefs: [],
    });
  });

  it("always retains the latest complete group when the floored target is zero", () => {
    expect(decideFukaiCompactionPressure(request({
      contextWindowTokens: 1,
      thresholdRatio: 0.5,
      retainRatio: 0.1,
      currentTokens: 1,
      minimumGainTokens: 0,
      maxSummaryTokens: 0,
      conversationRefs: [
        ref("old", "old", 10),
        ref("latest", "latest", 1),
      ],
    }))).toMatchObject({
      status: "compact",
      minimumRetainedRawTokens: 0,
      selectedRawTokens: 10,
      retainedRawTokens: 1,
      selectedGroupIds: ["old"],
    });
  });

  it.each([
    ["contextWindowTokens", 0],
    ["contextWindowTokens", 1.5],
    ["contextWindowTokens", Number.MAX_SAFE_INTEGER + 1],
    ["minimumGainTokens", -1],
    ["minimumGainTokens", 1.5],
    ["maxSummaryTokens", -1],
    ["currentTokens", Number.NaN],
  ] as const)("rejects invalid integer field %s=%s", (field, value) => {
    expect(() => decideFukaiCompactionPressure(request({ [field]: value })))
      .toThrow(RangeError);
  });

  it.each([
    ["thresholdRatio", 0],
    ["thresholdRatio", 1],
    ["thresholdRatio", Number.NaN],
    ["retainRatio", -0.1],
    ["retainRatio", 1],
    ["retainRatio", Number.POSITIVE_INFINITY],
  ] as const)("rejects invalid ratio %s=%s", (field, value) => {
    expect(() => decideFukaiCompactionPressure(request({ [field]: value })))
      .toThrow(RangeError);
  });

  it("requires retention pressure to stay below the trigger pressure", () => {
    expect(() => decideFukaiCompactionPressure(request({
      thresholdRatio: 0.5,
      retainRatio: 0.5,
    }))).toThrow(/retainRatio.*less than thresholdRatio/);
  });

  it("validates estimates and requires each atomic group to be contiguous", () => {
    expect(() => decideFukaiCompactionPressure(request({
      conversationRefs: [ref("bad", "bad", -1)],
    }))).toThrow(/estimatedTokens/);
    expect(() => decideFukaiCompactionPressure(request({
      conversationRefs: [
        ref("a-1", "a", 100),
        ref("b", "b", 100),
        ref("a-2", "a", 100),
      ],
    }))).toThrow(/must be contiguous/);
  });

  it("rejects unsafe aggregate token estimates", () => {
    expect(() => decideFukaiCompactionPressure(request({
      conversationRefs: [
        ref("one", "one", Number.MAX_SAFE_INTEGER),
        ref("two", "two", 1),
      ],
    }))).toThrow(/safe integer range/);
  });
});

function request(
  overrides: Partial<FukaiCompactionPressureInput<string>> = {},
): FukaiCompactionPressureInput<string> {
  return {
    contextWindowTokens: 1_000,
    thresholdRatio: 0.8,
    retainRatio: 0.2,
    minimumGainTokens: 400,
    maxSummaryTokens: 100,
    currentTokens: 800,
    conversationRefs: [
      ref("turn-1-user", "turn-1", 200),
      ref("turn-1-assistant", "turn-1", 200),
      ref("turn-2", "turn-2", 200),
      ref("turn-3", "turn-3", 300),
    ],
    ...overrides,
  };
}

function ref(
  value: string,
  groupId: string,
  estimatedTokens: number,
): { ref: string; groupId: string; estimatedTokens: number } {
  return { ref: value, groupId, estimatedTokens };
}
