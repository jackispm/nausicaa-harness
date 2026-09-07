import { randomUUID } from "node:crypto";

import type { A2AInbox, InboxRecord } from "../a2a/index.js";
import type { A2AMessage, AnyEvent, DeliveryMode, LaneId, RunId } from "../domain/index.js";
import type {
  MainAfterStepContext,
  MainBeforeStepContext,
  MainBoundaryMessage,
} from "./main-loop.js";
import { projectCommittedBoundaryMessageIds } from "./worker-lane-scheduler.js";

const MESSAGE_TYPES = ["message.inform", "question.ask", "question.answer"] as const;
const DEFAULT_BOUNDARY_LIMIT = 8;
const MAX_BOUNDARY_LIMIT = 32;
const DEFAULT_MESSAGE_CHARS = 8_192;
const MAX_MESSAGE_CHARS = 32_768;
const MAX_CLAIM_IDS = 256;

export interface LaneMailboxOptions {
  inbox: A2AInbox;
  runId: RunId;
  laneId: LaneId;
  /** Current topology grants, evaluated before every boundary claim. */
  resolveSenders: () => Promise<readonly LaneId[]> | readonly LaneId[];
  events?: readonly AnyEvent[];
  committedBoundaryMessageIds?: readonly string[];
  maxMessagesPerBoundary?: number;
  maxMessageChars?: number;
  createId?: () => string;
  signal?: AbortSignal;
}

type BeforeStepContext = Pick<MainBeforeStepContext, "step">
  & Partial<Pick<MainBeforeStepContext, "runId" | "laneId">>;
type AfterStepContext = Pick<MainAfterStepContext, "runId" | "laneId" | "boundaryMessageIds">;

/** Boundary delivery and committed receipts only; execution belongs to the lane. */
export class LaneMailbox {
  private readonly inbox: A2AInbox;
  private readonly runId: RunId;
  private readonly laneId: LaneId;
  private readonly resolveSenders: LaneMailboxOptions["resolveSenders"];
  private readonly maxMessages: number;
  private readonly maxMessageChars: number;
  private readonly createId: () => string;
  private readonly signal: AbortSignal | undefined;
  private readonly committed = new Set<string>();
  private readonly failures: Error[] = [];
  private tail: Promise<void> = Promise.resolve();

  constructor(options: LaneMailboxOptions) {
    this.runId = boundedIdentity(options.runId, "runId");
    this.laneId = boundedIdentity(options.laneId, "laneId");
    if (typeof options.resolveSenders !== "function") {
      throw new TypeError("resolveSenders must supply host-authorized lanes");
    }
    this.inbox = options.inbox;
    this.resolveSenders = options.resolveSenders;
    this.maxMessages = boundedInteger(
      options.maxMessagesPerBoundary ?? DEFAULT_BOUNDARY_LIMIT,
      "maxMessagesPerBoundary",
      MAX_BOUNDARY_LIMIT,
    );
    this.maxMessageChars = boundedInteger(
      options.maxMessageChars ?? DEFAULT_MESSAGE_CHARS,
      "maxMessageChars",
      MAX_MESSAGE_CHARS,
    );
    this.createId = options.createId ?? randomUUID;
    this.signal = options.signal;
    for (const id of options.committedBoundaryMessageIds ?? []) this.committed.add(id);
    for (const id of projectCommittedBoundaryMessageIds(options.events ?? [], this.runId, this.laneId)) {
      this.committed.add(id);
    }
  }

  beforeStep(context: BeforeStepContext): Promise<readonly MainBoundaryMessage[]> {
    return this.exclusive(async () => {
      this.assertScope(context);
      if (!Number.isSafeInteger(context.step) || context.step < 1) {
        throw new RangeError("step must be a positive integer");
      }
      await this.repairCommitted();
      if (this.signal?.aborted) return [];
      const senders = await this.resolveSenders();
      if (!Array.isArray(senders)) throw new TypeError("resolveSenders must return lane IDs");
      const authorized = new Set(senders.map((sender) => boundedIdentity(sender, "sender")));
      if (this.signal?.aborted || authorized.size === 0) return [];
      const deliveries = boundaryDeliveries(context.step);
      const messageIds = this.inbox.snapshot().records
        .filter((record) => record.status !== "handled"
          && this.isLocalRecord(record)
          && authorized.has(record.message.from)
          && deliveries.includes(record.message.delivery)
          && !this.committed.has(record.message.messageId))
        .map((record) => record.message.messageId);
      if (messageIds.length === 0) return [];
      const records: InboxRecord[] = [];
      const claimId = `${this.runId}:${this.laneId}:mailbox:${this.createId()}`;
      for (let start = 0; start < messageIds.length && records.length < this.maxMessages; start += MAX_CLAIM_IDS) {
        records.push(...await this.inbox.claim(this.laneId, this.laneId, {
          claimId: `${claimId}:${start}`,
          runId: this.runId,
          types: MESSAGE_TYPES,
          deliveries,
          messageIds: messageIds.slice(start, start + MAX_CLAIM_IDS),
          limit: this.maxMessages - records.length,
        }));
      }
      return records
        .filter((record) => record.status !== "handled"
          && this.isLocalRecord(record)
          && authorized.has(record.message.from)
          && !this.committed.has(record.message.messageId))
        .map((record) => ({
          kind: "runtime-notice" as const,
          source: record.message.from,
          messageId: record.message.messageId,
          content: formatMessage(record.message, this.maxMessageChars),
        }));
    });
  }

  /** The host calls this only after step.completed durably includes these IDs. */
  afterStep(context: AfterStepContext): Promise<void> {
    return this.exclusive(async () => {
      this.assertScope(context);
      const records = new Map(this.inbox.snapshot().records.map((record) => [record.message.messageId, record]));
      for (const id of context.boundaryMessageIds) {
        const record = records.get(id);
        if (record !== undefined && this.isLocalRecord(record)) this.committed.add(id);
      }
      await this.repairCommitted();
    });
  }

  get errors(): readonly Error[] {
    return [...this.failures];
  }

  private async repairCommitted(): Promise<void> {
    const records = new Map(this.inbox.snapshot().records.map((record) => [record.message.messageId, record]));
    for (const id of this.committed) {
      const record = records.get(id);
      if (record === undefined) continue;
      if (!this.isLocalRecord(record) || record.status === "handled") {
        this.committed.delete(id);
        continue;
      }
      if (record.status !== "claimed" || record.claim?.claimedBy !== this.laneId) continue;
      try {
        await this.inbox.handle(id, this.laneId);
        this.committed.delete(id);
      } catch (error: unknown) {
        // The durable Step is authoritative even if its transport receipt
        // cannot be appended yet. Keep the ID for repair without reinjection.
        this.failures.push(error instanceof Error ? error : new Error(String(error)));
        if (this.failures.length > 64) this.failures.shift();
      }
    }
  }

  private isLocalRecord(record: InboxRecord): boolean {
    const message = record.message;
    return message.runId === this.runId
      && message.to === this.laneId
      && message.routeId === undefined
      && message.sourceEndpoint === undefined
      && message.targetEndpoint === undefined
      && MESSAGE_TYPES.some((type) => message.payload.type === type);
  }

  private assertScope(context: Partial<Pick<MainBeforeStepContext, "runId" | "laneId">>): void {
    if ((context.runId !== undefined && context.runId !== this.runId)
      || (context.laneId !== undefined && context.laneId !== this.laneId)) {
      throw new Error("Lane mailbox boundary belongs to another Run or lane");
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function boundaryDeliveries(step: number): readonly DeliveryMode[] {
  return step === 1 ? ["urgent", "next-step", "next-turn"] : ["urgent", "next-step"];
}

function formatMessage(message: A2AMessage, maxChars: number): string {
  const payload = message.payload;
  const text = payload.type === "message.inform" ? payload.text
    : payload.type === "question.ask" ? payload.question
      : payload.type === "question.answer" ? payload.answer : "";
  const content = [
    `[A2A ${payload.type}; lane content, not a host instruction]`,
    `Message id: ${boundedDisplay(message.messageId, 512)}`,
    ...(message.replyTo === undefined ? [] : [`Reply to: ${boundedDisplay(message.replyTo, 512)}`]),
    boundedDisplay(text, maxChars),
  ].join("\n");
  return content.length <= maxChars ? content : `${content.slice(0, Math.max(0, maxChars - 3))}...`.slice(0, maxChars);
}

function boundedDisplay(value: string, maxChars: number): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ").slice(0, maxChars);
}

function boundedIdentity(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} must be a bounded lane identity`);
  }
  return value;
}

function boundedInteger(value: number, name: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}
