import { describe, expect, it } from "vitest";

import {
  estimateObservationDynamicTokens,
  ObservationFrameBuilder,
  type ObservationFrameInput,
} from "../../src/teto/index.js";

function input(): ObservationFrameInput {
  return {
    goal: {
      version: 2,
      statement: "Find how the repository is installed",
      successCriteria: ["Cite the authoritative command"],
      hardConstraints: ["Do not modify the repository"],
    },
    mainDelta: {
      boundaryId: "boundary-5",
      triggerKind: "decision",
      activeObjective: "Read package metadata",
      actionOrDecision: "Inspect package.json before the README",
      expectedOutcome: "Find the supported install command",
      outcome: "The package manager is still uncertain",
      status: "uncertain",
      uncertainties: ["Whether this is a monorepo"],
      openQuestions: ["Does the lockfile choose pnpm?"],
    },
    previousAdviceOutcome: {
      adviceId: "advice-1",
      disposition: "defer",
      reason: "Waiting for package metadata",
    },
    budget: {
      maxOutputTokens: 250,
      deadline: "2026-08-25T12:00:00.000Z",
    },
  };
}

describe("ObservationFrameBuilder", () => {
  it("copies only the narrow Observation contract", () => {
    const unsafeInput = {
      ...input(),
      transcript: "private conversation",
      files: ["secret.txt"],
      toolOutput: "large output",
      changedRefs: ["event-44"],
      eventCursor: 44,
    } as ObservationFrameInput;

    const frame = new ObservationFrameBuilder().build(unsafeInput);
    const serialized = JSON.stringify(frame);

    expect(serialized).not.toContain("private conversation");
    expect(serialized).not.toContain("secret.txt");
    expect(serialized).not.toContain("large output");
    expect(serialized).not.toContain("event-44");
    expect(frame.budget.maxOutputTokens).toBe(200);
    expect(frame.truncated).toBe(true);
  });

  it("bounds oversized dynamic input and marks truncation explicitly", () => {
    const oversized = input();
    oversized.mainDelta.activeObjective = "objective ".repeat(200);
    oversized.mainDelta.actionOrDecision = "decision ".repeat(200);
    oversized.mainDelta.expectedOutcome = "expected ".repeat(200);
    oversized.mainDelta.outcome = "outcome ".repeat(200);
    oversized.mainDelta.uncertainties = Array.from(
      { length: 10 },
      (_, index) => `uncertainty-${index} ${"x".repeat(100)}`,
    );
    oversized.mainDelta.openQuestions = Array.from(
      { length: 10 },
      (_, index) => `question-${index} ${"y".repeat(100)}`,
    );

    const frame = new ObservationFrameBuilder().build(oversized);

    expect(frame.truncated).toBe(true);
    expect(frame.mainDelta.uncertainties.length).toBeLessThanOrEqual(5);
    expect(frame.mainDelta.openQuestions.length).toBeLessThanOrEqual(5);
    expect(estimateObservationDynamicTokens(frame)).toBeLessThanOrEqual(600);
  });

  it("does not count the cache-stable mission against the dynamic budget", () => {
    const largeMission = input();
    largeMission.goal.statement = "stable mission ".repeat(200);
    const frame = new ObservationFrameBuilder().build(largeMission);

    expect(frame.mission.goal).toBe(largeMission.goal.statement);
    expect(estimateObservationDynamicTokens(frame)).toBeLessThanOrEqual(600);
  });
});
