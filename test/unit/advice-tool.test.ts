import { describe, expect, it } from "vitest";

import { A2AInbox } from "../../src/a2a/index.js";
import type { A2AMessage } from "../../src/domain/types.js";
import { createAdviceResponseTool } from "../../src/runtime/advice-tool.js";

const message = (): A2AMessage => ({
  messageId: "message-1",
  runId: "run-1",
  conversationId: "run-1",
  threadId: "main:teto",
  from: "teto",
  to: "main",
  createdAt: "2026-08-25T12:00:00.000Z",
  expiresAt: "2026-08-25T13:00:00.000Z",
  correlationId: "correlation-1",
  idempotencyKey: "advice-send-1",
  visibility: "run",
  priority: 5,
  delivery: "next-step",
  payload: {
    type: "advice.propose",
    advice: {
      adviceId: "advice-1",
      kind: "orientation",
      claim: "Return to the requested scope.",
      evidenceRefs: [],
      confidence: 0.8,
      risk: "medium",
      suggestedAction: "Drop the unrelated work.",
      urgency: "next-step",
      expiresAt: "2026-08-25T13:00:00.000Z",
      dedupeKey: "scope",
      sourceLane: "teto",
    },
  },
});

describe("respond_to_advice", () => {
  it("persists an explicit Main disposition", async () => {
    const inbox = new A2AInbox({
      clock: { now: () => new Date("2026-08-25T12:01:00.000Z") },
    });
    await inbox.send(message());
    await inbox.claim("main", "main", { claimId: "claim-1" });
    const tool = createAdviceResponseTool(inbox);

    const result = await tool.execute(
      {
        adviceId: "advice-1",
        disposition: "accept",
        reason: "It restores the user scope.",
      },
      { runId: "run-1", workspace: "/tmp", operationId: "operation-1" },
    );

    expect(result.isError).toBe(false);
    expect(inbox.snapshot().records[0]).toMatchObject({
      status: "handled",
      acknowledgement: { disposition: "accept" },
    });
  });

  it("cannot acknowledge Advice from another Run", async () => {
    const inbox = new A2AInbox({
      clock: { now: () => new Date("2026-08-25T12:01:00.000Z") },
    });
    await inbox.send(message());
    await inbox.claim("main", "main", { claimId: "claim-1" });

    const result = await createAdviceResponseTool(inbox).execute(
      { adviceId: "advice-1", disposition: "accept", reason: "wrong run" },
      { runId: "run-2", workspace: "/tmp", operationId: "operation-1" },
    );

    expect(result.isError).toBe(true);
    expect(inbox.snapshot().records[0]?.status).toBe("claimed");
  });
});
