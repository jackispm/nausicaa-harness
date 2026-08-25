import { describe, expect, it } from "vitest";

import { A2AInbox } from "../../src/a2a/index.js";
import type {
  A2AMessage,
  ModelPort,
  ModelRequest,
  ModelResponse,
} from "../../src/domain/index.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import {
  IntentNavigator,
  ObservationFrameBuilder,
  TetoCadence,
} from "../../src/teto/index.js";

class OneShotModel implements ModelPort {
  calls = 0;

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    return {
      content: JSON.stringify({
        kind: "intent-gap",
        claim: "The requested install verification is still missing.",
        evidenceRefs: ["boundary:5"],
        confidence: 0.9,
        risk: "medium",
        suggestedAction: "Verify the documented command in a clean directory.",
        urgency: "next-turn",
        expiresAt: "2026-08-25T12:10:00.000Z",
        dedupeKey: "verify-install",
      }),
      toolCalls: [],
      stopReason: "stop",
      usage: { input: 150, output: 80, cacheRead: 80, cacheWrite: 0 },
    };
  }
}

describe("Teto protocol", () => {
  it("observes sparsely, sends Advice, and lets Main ack at a boundary", async () => {
    const clock = { now: () => new Date("2026-08-25T12:00:00.000Z") };
    const ledger = new MemoryLedger({ clock });
    const inbox = new A2AInbox({ sink: ledger, clock });
    const cadence = new TetoCadence();
    const model = new OneShotModel();
    const navigator = new IntentNavigator({
      modelPort: model,
      model: "scripted",
      clock,
      createAdviceId: () => "advice-1",
    });

    let shouldWake = false;
    for (let call = 1; call <= 5; call += 1) {
      shouldWake = cadence.recordMainCall().shouldWake;
    }
    expect(shouldWake).toBe(true);
    cadence.commitPass();

    const frame = new ObservationFrameBuilder().build({
      goal: {
        version: 1,
        statement: "Find and verify repository installation",
        successCriteria: ["Provide a tested command"],
        hardConstraints: ["Do not publish secrets"],
      },
      mainDelta: {
        boundaryId: "5",
        triggerKind: "normal",
        activeObjective: "Read installation docs",
        actionOrDecision: "Quote the README command",
        expectedOutcome: "Return a verified command",
        outcome: "The command was found but not verified",
        status: "uncertain",
        uncertainties: ["Whether the command works in a clean directory"],
        openQuestions: ["Has installation actually run?"],
      },
      budget: {
        maxOutputTokens: 200,
        deadline: "2026-08-25T12:05:00.000Z",
      },
    });
    const observed = await navigator.observe({
      runId: "run-1",
      sessionId: "teto-1",
      frame,
    });
    expect(observed.advice).toBeDefined();

    const message: A2AMessage = {
      messageId: "message-1",
      runId: "run-1",
      conversationId: "conversation-1",
      threadId: "thread-1",
      from: "teto",
      to: "main",
      createdAt: clock.now().toISOString(),
      expiresAt: observed.advice!.expiresAt,
      correlationId: "run-1",
      idempotencyKey: "teto-pass-1",
      visibility: "run",
      priority: 5,
      delivery: observed.advice!.urgency,
      payload: { type: "advice.propose", advice: observed.advice! },
    };
    await inbox.send(message);
    expect(await inbox.claim("main", "main", { claimId: "boundary-6" })).toHaveLength(1);
    await inbox.acknowledgeAdvice(
      "advice-1",
      "accept",
      "main",
      "Verification is part of success criteria",
    );

    expect(model.calls).toBe(1);
    expect((await ledger.read()).map((event) => event.type)).toEqual([
      "message.sent",
      "message.claimed",
      "advice.acknowledged",
      "message.handled",
    ]);
  });
});
