import { randomUUID } from "node:crypto";

import type { A2AInbox } from "../a2a/index.js";
import type { AgentTool, ToolExecutionContext, ToolResult } from "../domain/ports.js";
import type { A2AMessage, DeliveryMode, LaneId, Visibility } from "../domain/types.js";
import { annotateTool } from "../mowe/catalog.js";
import type { MoweAgentTool } from "../mowe/types.js";
import { publicLaneName, resolveLaneTarget } from "./lane-names.js";

const TOOL_NAME = "agent_message";
const MAX_TEXT_LENGTH = 8_192;
const MAX_ID_LENGTH = 512;
const MAX_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_PENDING_MESSAGES = 64;
const MAX_PENDING_MESSAGES = 256;
const DEFAULT_DELIVERY: DeliveryMode = "next-step";
const DEFAULT_VISIBILITY: Visibility = "run";
const ARGUMENT_KEYS = new Set(["text", "target", "kind", "replyTo"]);
const MESSAGE_TYPES = new Set(["message.inform", "question.ask", "question.answer"]);
// Local message tools share one admission boundary even across lane factories.
const admissionTails = new WeakMap<A2AInbox, Promise<void>>();

export type InRunMessageKind = "inform" | "request" | "progress";

/**
 * In-Run A2A capability with host-bound identity and dynamic topology grants.
 * Without a resolver the recipient remains host-fixed for compatibility.
 */
export interface InRunAgentMessageToolOptions {
  inbox: A2AInbox;
  runId: string;
  from?: LaneId;
  to?: LaneId;
  /** Resolve the host-authorized in-Run targets for every send attempt. */
  resolveTargets?: () => Promise<readonly LaneId[]> | readonly LaneId[];
  conversationId?: string;
  threadId?: string;
  correlationId?: string;
  delivery?: DeliveryMode;
  visibility?: Visibility;
  priority?: number;
  /** Optional host-owned expiry. Model arguments cannot extend this bound. */
  ttlMs?: number;
  /** Maximum unhandled ordinary messages emitted by this lane in the Run. */
  maxPendingMessages?: number;
  /** A wake hint after durable send; failure cannot undo an accepted message. */
  onMessage?: (message: A2AMessage) => void | Promise<void>;
  createId?: () => string;
  now?: () => Date;
}

export function createInRunAgentMessageTool(
  options: InRunAgentMessageToolOptions,
): MoweAgentTool {
  const inbox = options.inbox;
  const runId = options.runId;
  const from = options.from ?? "teto";
  const fixedTo = options.to ?? "main";
  const resolveTargets = options.resolveTargets;
  const conversationId = options.conversationId ?? runId;
  const threadId = options.threadId;
  const correlationId = options.correlationId ?? runId;
  const delivery = options.delivery ?? DEFAULT_DELIVERY;
  const visibility = options.visibility ?? DEFAULT_VISIBILITY;
  const priority = options.priority ?? 5;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxPendingMessages = options.maxPendingMessages ?? DEFAULT_MAX_PENDING_MESSAGES;
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const onMessage = options.onMessage;

  validateOptions(
    runId,
    from,
    fixedTo,
    conversationId,
    threadId ?? `${runId}:${fixedTo}`,
    correlationId,
    priority,
    ttlMs,
  );
  validateDelivery(delivery);
  validateVisibility(visibility);
  if (!Number.isSafeInteger(maxPendingMessages) || maxPendingMessages < 1 || maxPendingMessages > MAX_PENDING_MESSAGES) {
    throw new RangeError(`maxPendingMessages must be an integer between 1 and ${MAX_PENDING_MESSAGES}`);
  }

  const tool: AgentTool = {
    definition: {
      name: TOOL_NAME,
      description:
        "Send a bounded note, request, or progress update to a host-authorized lane in this Run. Select a target from your lane manifest; sender identity and permissions are bound by the host. queued confirms durable delivery admission, not that the recipient has read or completed anything.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            minLength: 1,
            maxLength: MAX_TEXT_LENGTH,
            description: "The note, question, or progress update",
          },
          target: {
            type: "string",
            minLength: 1,
            maxLength: MAX_ID_LENGTH,
            description: "Host-authorized in-Run recipient, such as nausicaa or teto. Omit only when the host supplied a fixed recipient.",
          },
          kind: {
            type: "string",
            enum: ["inform", "request", "progress"],
            description: "inform sends a note, request asks a question, progress sends a bounded progress note",
          },
          replyTo: {
            type: "string",
            minLength: 1,
            maxLength: MAX_ID_LENGTH,
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },

    execute(arguments_, context) {
      return send(arguments_, context);
    },
  };
  return annotateTool(tool, {
    effect: "external",
    deterministic: false,
    supportsBatch: false,
    concurrencySafe: false,
    scope: "lane",
    inputKinds: ["json"],
    outputKinds: ["json"],
  });

  async function send(
    arguments_: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    if (context.laneId !== undefined && context.laneId !== from) {
      return failure("agent_message capability is bound to another lane");
    }
    if (context.runId !== runId) {
      return failure("agent_message capability is bound to another Run");
    }
    try {
      assertKnownArguments(arguments_);
      if (context.signal?.aborted) return failure("agent_message was cancelled before send");
      boundedId(context.operationId, "operationId");
      const text = boundedText(arguments_.text);
      const kind = normalizeKind(arguments_.kind);
      const requestedTarget = boundedId(arguments_.target === undefined ? fixedTo : arguments_.target, "target");
      const { message, result } = await runInboxAdmission(inbox, async () => {
        const targets = resolveTargets === undefined ? [fixedTo] : await resolveTargets();
        if (!Array.isArray(targets) || targets.some((value) => typeof value !== "string")) {
          throw new TypeError("resolveTargets must return lane IDs");
        }
        const target = resolveLaneTarget(requestedTarget, targets);
        if (!targets.includes(target)) {
          throw new Error(`target ${publicLaneName(target)} is not authorized for this lane`);
        }
        const replyTo = arguments_.replyTo === undefined
          ? undefined
          : boundedId(arguments_.replyTo, "replyTo");
        const records = inbox.snapshot().records;
        if (replyTo !== undefined && !records.some(({ message }) => (
          message.messageId === replyTo
          && message.runId === runId
          && message.to === from
          && message.from === target
          && message.routeId === undefined
          && message.sourceEndpoint === undefined
          && message.targetEndpoint === undefined
        ))) {
          throw new TypeError("replyTo must reference a message from this recipient to this lane in this Run");
        }
        const idempotencyKey = `${runId}:a2a:${from}:${context.operationId}`;
        const existing = records.find(({ message }) => (
          message.runId === runId
          && message.idempotencyKey === idempotencyKey
          && message.routeId === undefined
        ))?.message;
        const admissionTime = now();
        if (existing === undefined) {
          const pending = records.filter(({ message, status }) => status !== "handled"
            && message.runId === runId
            && message.routeId === undefined
            && message.sourceEndpoint === undefined
            && message.targetEndpoint === undefined
            && MESSAGE_TYPES.has(message.payload.type)
            && (message.expiresAt === undefined || Date.parse(message.expiresAt) > admissionTime.getTime()));
          const outgoing = pending.filter(({ message }) => message.from === from).length;
          if (outgoing >= maxPendingMessages) {
            throw new InRunMessageBackpressureError(`Lane ${publicLaneName(from)} has reached its pending message limit (${outgoing}/${maxPendingMessages})`);
          }
          const incoming = pending.filter(({ message }) => message.to === target).length;
          if (incoming >= MAX_PENDING_MESSAGES) {
            throw new InRunMessageBackpressureError(`Lane ${publicLaneName(target)} has reached its Inbox message limit (${incoming}/${MAX_PENDING_MESSAGES})`);
          }
        }
        const createdAtDate = existing === undefined ? admissionTime : new Date(existing.createdAt);
        const createdAt = createdAtDate.toISOString();
        const payload = kind === "request"
          ? { type: "question.ask" as const, question: text }
          : { type: "message.inform" as const, text };
        const message: A2AMessage = {
          messageId: existing?.messageId ?? createId(),
          runId,
          conversationId,
          threadId: threadId ?? `${runId}:${target}`,
          from,
          to: target,
          createdAt,
          ...(existing === undefined
            ? { expiresAt: new Date(createdAtDate.getTime() + ttlMs).toISOString() }
            : existing.expiresAt === undefined ? {} : { expiresAt: existing.expiresAt }),
          ...(replyTo === undefined ? {} : { replyTo }),
          correlationId,
          idempotencyKey,
          visibility,
          priority,
          delivery,
          payload,
        };
        if (context.signal?.aborted) throw new Error("agent_message was cancelled before send");
        return { message, result: await inbox.send(message) };
      });
      let wakePending = false;
      if (onMessage !== undefined && result.status !== "expired") {
        try {
          await onMessage(structuredClone(message));
        } catch {
          wakePending = true;
        }
      }
      return {
        content: JSON.stringify({
          status: result.status,
          messageId: result.messageId,
          from: publicLaneName(message.from),
          to: publicLaneName(message.to),
          kind,
          ...(wakePending ? { wakePending: true } : {}),
        }),
        isError: false,
      };
    } catch (error: unknown) {
      return failure(
        error instanceof Error ? error.message : "A2A send failed",
        error instanceof InRunMessageBackpressureError ? "backpressure" : undefined,
      );
    }
  }
}

class InRunMessageBackpressureError extends Error {}

function runInboxAdmission<T>(inbox: A2AInbox, operation: () => Promise<T>): Promise<T> {
  const tail = admissionTails.get(inbox) ?? Promise.resolve();
  const result = tail.then(operation);
  admissionTails.set(inbox, result.then(() => undefined, () => undefined));
  return result;
}

/** One model-visible name for in-Run lane IDs and existing cross-Run selectors. */
export function composeAgentMessageTools(
  inRun: AgentTool,
  crossRun?: AgentTool,
): AgentTool {
  if (crossRun === undefined) return inRun;
  if (inRun.definition.name !== TOOL_NAME || crossRun.definition.name !== TOOL_NAME) {
    throw new TypeError("Both message tools must be named agent_message");
  }
  return {
    ...crossRun,
    definition: {
      name: TOOL_NAME,
      description: `${inRun.definition.description} For another Run, use the cross-Run target object. ${crossRun.definition.description}`,
      parameters: {
        type: "object",
        properties: {
          ...crossRun.definition.parameters.properties,
          ...inRun.definition.parameters.properties,
          // Mowe's supported schema subset has no unions. Each original tool
          // still validates its complete branch before it can send anything.
          target: {
            description: "An in-Run lane ID string, or a cross-Run selector object {relationship:'parent'|'sibling'|'child'|'direct', name?:string, id?:string}.",
          },
        },
        additionalProperties: false,
      },
    },
    execute(arguments_, context) {
      if (arguments_ === null || typeof arguments_ !== "object" || Array.isArray(arguments_)) {
        return Promise.resolve(failure("agent_message arguments must be an object"));
      }
      const target = arguments_.target;
      if (target === undefined || typeof target === "string") return inRun.execute(arguments_, context);
      if (target !== null && typeof target === "object" && !Array.isArray(target)) {
        return crossRun.execute(arguments_, context);
      }
      return Promise.resolve(failure("target must be an in-Run lane ID or a cross-Run selector"));
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

function boundedId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_ID_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${field} must be a bounded non-empty string`);
  }
  return value;
}

function normalizeKind(value: unknown): InRunMessageKind {
  if (value === undefined) return "inform";
  if (value === "inform" || value === "request" || value === "progress") return value;
  throw new TypeError("kind must be inform, request, or progress");
}

function assertKnownArguments(arguments_: Record<string, unknown>): void {
  if (arguments_ === null || typeof arguments_ !== "object" || Array.isArray(arguments_)) {
    throw new TypeError("agent_message arguments must be an object");
  }
  for (const key of Object.keys(arguments_)) {
    if (!ARGUMENT_KEYS.has(key)) throw new TypeError(`unknown agent_message argument: ${key}`);
  }
}

function validateOptions(
  runId: string,
  from: string,
  to: string,
  conversationId: string,
  threadId: string,
  correlationId: string,
  priority: number,
  ttlMs?: number,
): void {
  for (const [name, value] of [
    ["runId", runId],
    ["from", from],
    ["to", to],
    ["conversationId", conversationId],
    ["threadId", threadId],
    ["correlationId", correlationId],
  ] as const) {
    boundedId(value, name);
  }
  if (!Number.isSafeInteger(priority) || priority < 0 || priority > 100) {
    throw new RangeError("priority must be an integer between 0 and 100");
  }
  if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS)) {
    throw new RangeError(`ttlMs must be an integer between 1 and ${MAX_TTL_MS}`);
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

function failure(message: string, code?: "backpressure"): { content: string; isError: true } {
  return {
    content: JSON.stringify({ status: "error", error: message, ...(code === undefined ? {} : { code }) }),
    isError: true,
  };
}
