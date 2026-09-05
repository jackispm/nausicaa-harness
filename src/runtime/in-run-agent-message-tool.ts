import { randomUUID } from "node:crypto";

import type { A2AInbox } from "../a2a/index.js";
import type { AgentTool } from "../domain/ports.js";
import type { DeliveryMode, LaneId, Visibility } from "../domain/types.js";

const TOOL_NAME = "agent_message";
const MAX_TEXT_LENGTH = 8_192;
const DEFAULT_DELIVERY: DeliveryMode = "next-step";
const DEFAULT_VISIBILITY: Visibility = "run";

/**
 * Host-fixed A2A capability for lanes that communicate inside one Run.
 *
 * The model can choose when to speak, but it cannot choose the recipient,
 * sender, payload type, or visibility. This keeps Teto on the ordinary Inbox
 * transport while preserving the host's lane boundary.
 */
export interface InRunAgentMessageToolOptions {
  inbox: A2AInbox;
  runId: string;
  from?: LaneId;
  to?: LaneId;
  conversationId?: string;
  threadId?: string;
  correlationId?: string;
  delivery?: DeliveryMode;
  visibility?: Visibility;
  priority?: number;
  createId?: () => string;
  now?: () => Date;
}

export function createInRunAgentMessageTool(
  options: InRunAgentMessageToolOptions,
): AgentTool {
  const from = options.from ?? "teto";
  const to = options.to ?? "main";
  const conversationId = options.conversationId ?? options.runId;
  const threadId = options.threadId ?? `${options.runId}:${to}`;
  const correlationId = options.correlationId ?? options.runId;
  const delivery = options.delivery ?? DEFAULT_DELIVERY;
  const visibility = options.visibility ?? DEFAULT_VISIBILITY;
  const priority = options.priority ?? 5;
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? (() => new Date());

  validateOptions(options.runId, from, to, conversationId, threadId, correlationId, priority);
  validateDelivery(delivery);
  validateVisibility(visibility);

  return {
    definition: {
      name: TOOL_NAME,
      description:
        "Send a concise observation to the Main lane through the ordinary in-Run A2A Inbox. Use this when your independent reasoning should be visible to Main; sending is optional.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The observation or suggestion to send to Main",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },

    async execute(arguments_, context) {
      if (context.runId !== options.runId) {
        return failure("agent_message capability is bound to another Run");
      }
      try {
        const text = boundedText(arguments_.text);
        const createdAt = now().toISOString();
        const messageId = createId();
        const result = await options.inbox.send({
          messageId,
          runId: options.runId,
          conversationId,
          threadId,
          from,
          to,
          createdAt,
          correlationId,
          idempotencyKey: `${options.runId}:a2a:${from}:${context.operationId}`,
          visibility,
          priority,
          delivery,
          payload: { type: "message.inform", text },
        });
        return {
          content: JSON.stringify({
            status: result.status,
            messageId: result.messageId,
            from,
            to,
          }),
          isError: false,
        };
      } catch (error: unknown) {
        return failure(error instanceof Error ? error.message : "A2A send failed");
      }
    },
  };
}

function boundedText(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("text must be a non-empty string");
  }
  if (value.length > MAX_TEXT_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new TypeError("text must be bounded and free of control characters");
  }
  return value;
}

function validateOptions(
  runId: string,
  from: string,
  to: string,
  conversationId: string,
  threadId: string,
  correlationId: string,
  priority: number,
): void {
  for (const [name, value] of [
    ["runId", runId],
    ["from", from],
    ["to", to],
    ["conversationId", conversationId],
    ["threadId", threadId],
    ["correlationId", correlationId],
  ] as const) {
    if (value.trim().length === 0 || value.includes("\0")) {
      throw new TypeError(`${name} must be non-empty and free of NUL`);
    }
  }
  if (!Number.isSafeInteger(priority) || priority < 0 || priority > 100) {
    throw new RangeError("priority must be an integer between 0 and 100");
  }
}

function validateDelivery(value: DeliveryMode): void {
  if (!(value === "next-step"
    || value === "next-turn"
    || value === "deferred"
    || value === "urgent")) {
    throw new TypeError("delivery must be a valid A2A delivery mode");
  }
}

function validateVisibility(value: Visibility): void {
  if (!(value === "lane" || value === "run" || value === "user" || value === "sensitive")) {
    throw new TypeError("visibility must be a valid A2A visibility");
  }
}

function failure(message: string): { content: string; isError: true } {
  return {
    content: JSON.stringify({ status: "error", error: message }),
    isError: true,
  };
}
