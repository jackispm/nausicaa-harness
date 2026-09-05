import type { A2AInbox } from "../a2a/index.js";
import type { AdviceDisposition } from "../domain/types.js";
import type { AgentTool } from "../domain/ports.js";

export const createAdviceResponseTool = (inbox: A2AInbox): AgentTool => ({
  definition: {
    name: "respond_to_advice",
    description:
      "Acknowledge Teto advice after deciding to accept, defer, or reject it.",
    parameters: {
      type: "object",
      properties: {
        adviceId: { type: "string", description: "Advice identifier" },
        disposition: {
          type: "string",
          enum: ["accept", "defer", "reject"],
        },
        reason: { type: "string", description: "Short decision rationale" },
      },
      required: ["adviceId", "disposition", "reason"],
      additionalProperties: false,
    },
  },

  async execute(arguments_, context) {
    try {
      const adviceId = requiredString(arguments_.adviceId, "adviceId");
      const disposition = adviceDisposition(arguments_.disposition);
      const reason = requiredString(arguments_.reason, "reason");
      const record = inbox.snapshot().records.find((candidate) =>
        candidate.message.payload.type === "advice.propose"
        && candidate.message.payload.advice.adviceId === adviceId,
      );
      if (record === undefined || record.message.runId !== context.runId) {
        throw new Error(`Advice ${adviceId} is not available in this Run`);
      }

      const result = await inbox.acknowledgeAdvice(
        adviceId,
        disposition,
        "main",
        reason.slice(0, 1_024),
      );
      return {
        content: JSON.stringify({ adviceId, disposition, status: result.status }),
        isError: false,
      };
    } catch (error: unknown) {
      return {
        content: JSON.stringify({
          error: error instanceof Error ? error.message : "Advice response failed",
        }),
        isError: true,
      };
    }
  },
});

const requiredString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
};

const adviceDisposition = (value: unknown): AdviceDisposition => {
  if (value === "accept" || value === "defer" || value === "reject") {
    return value;
  }
  throw new TypeError("disposition must be accept, defer, or reject");
};
