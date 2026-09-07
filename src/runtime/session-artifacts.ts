import type {
  AnyEvent,
  EventEnvelope,
  EventPayloadMap,
  InputDelivery,
} from "../domain/events.js";
import type {
  A2AMessage,
  ArtifactRef,
  ConversationMessage,
  CrossRunEndpoint,
  CrossRunEnvelope,
  CrossRunRelationship,
} from "../domain/types.js";
import { normalizeEnvelope } from "../a2a/cross-run-contract.js";
import {
  type UserImage,
  userImageSummary,
  validateUserImages,
} from "../domain/images.js";
import {
  ArtifactNotFoundError,
  type ContentAddressedStore,
} from "../store/index.js";
import { SessionProtocolError } from "./session-protocol-error.js";

export const MESSAGE_MEDIA_TYPE = "application/vnd.nausicaa.conversation-message+json";
export const TOOL_ARGUMENTS_MEDIA_TYPE = "application/vnd.nausicaa.tool-arguments+json";

export interface SessionLaneMessage {
  role: "agent";
  content: string;
  turnId: string;
  messageId: string;
  from: string;
  to: string;
  payloadType: "message.inform" | "question.ask" | "question.answer";
  sourceEndpoint?: CrossRunEndpoint;
  targetEndpoint?: CrossRunEndpoint;
  relationship?: CrossRunRelationship;
  direction?: "incoming" | "outgoing";
}

export type SessionTranscriptEntry =
  | SessionLaneMessage
  | {
      role: "user";
      content: string;
      imageTypes?: string[];
      turnId: string;
    }
  | {
      role: "assistant";
      content: string;
      hasToolCalls: boolean;
      turnId: string;
    }
  | {
      role: "tool";
      content: string;
      imageTypes?: string[];
      turnId: string;
      toolName: string;
      toolCallId: string;
      status: "succeeded" | "failed" | "unknown";
      isError: boolean;
      operationId: string;
      arguments?: Record<string, unknown>;
    };

/** Only explicit public lane communication belongs beside Main's transcript. */
export function projectSessionLaneMessage(event: AnyEvent, runId: string): SessionLaneMessage | undefined {
  if (event.runId !== runId || !isTranscriptVisible(event.visibility)) return undefined;
  if (event.type === "a2a.outbox.pending") {
    return projectSessionCrossRunMessage(event, runId);
  }
  if (event.type !== "message.sent") return undefined;
  const message = event.payload.message;
  if (message.routeId !== undefined || message.sourceEndpoint !== undefined || message.targetEndpoint !== undefined) {
    return projectSessionCrossRunMessage(event, runId);
  }
  if (message.runId !== runId || event.laneId !== message.from
    || !isTranscriptVisible(message.visibility)
    || message.from === message.to) return undefined;
  const payload = message.payload;
  if (payload.type !== "message.inform" && payload.type !== "question.ask" && payload.type !== "question.answer") return undefined;
  const content = payload.type === "message.inform" ? payload.text
    : payload.type === "question.ask" ? payload.question
      : payload.answer;
  return {
    role: "agent", content, turnId: event.turnId ?? legacyTurnIdForTranscript(runId),
    messageId: message.messageId, from: message.from, to: message.to, payloadType: payload.type,
  };
}

function projectSessionCrossRunMessage(
  event: Extract<AnyEvent, { type: "message.sent" | "a2a.outbox.pending" }>,
  runId: string,
): SessionLaneMessage | undefined {
  let envelope: CrossRunEnvelope;
  try {
    envelope = event.type === "a2a.outbox.pending"
      ? normalizeEnvelope(event.payload.envelope)
      : sessionMessageEnvelope(event.payload.message);
  } catch {
    return undefined;
  }
  if (!isTranscriptVisible(envelope.visibility) || event.laneId !== envelope.source.laneId) return undefined;
  const outgoing = event.type === "a2a.outbox.pending";
  if (outgoing ? envelope.source.runId !== runId : envelope.target.runId !== runId) return undefined;
  if (event.type === "message.sent" && (event.payload.message.runId !== runId
    || event.payload.message.from !== envelope.source.laneId
    || event.payload.message.to !== envelope.target.laneId)) return undefined;
  const payload = envelope.payload;
  if (payload.type !== "message.inform" && payload.type !== "question.ask" && payload.type !== "question.answer") return undefined;
  return {
    role: "agent", messageId: envelope.messageId,
    turnId: event.turnId ?? legacyTurnIdForTranscript(runId),
    from: envelope.source.laneId, to: envelope.target.laneId,
    payloadType: payload.type,
    content: payload.type === "message.inform" ? payload.text : payload.type === "question.ask" ? payload.question : payload.answer,
    sourceEndpoint: { ...envelope.source }, targetEndpoint: { ...envelope.target },
    relationship: envelope.relationship, direction: outgoing ? "outgoing" : "incoming",
  };
}

function sessionMessageEnvelope(message: A2AMessage): CrossRunEnvelope {
  return normalizeEnvelope({
    protocolVersion: 1, messageId: message.messageId, routeId: message.routeId,
    source: message.sourceEndpoint, target: message.targetEndpoint,
    relationship: message.routeRelationship, artifacts: message.routeArtifacts,
    conversationId: message.conversationId, threadId: message.threadId,
    correlationId: message.correlationId, idempotencyKey: message.idempotencyKey,
    createdAt: message.createdAt, expiresAt: message.expiresAt, causationId: message.causationId,
    visibility: message.visibility, priority: message.priority, payload: message.payload,
  });
}

/**
 * Durable compaction lifecycle facts that are safe to project into a
 * read-only Session presentation. The event identity is part of the public
 * projection so reconnect/replay cannot manufacture a second notice.
 */
export type SessionCompactionNotice = {
  eventId: string;
  globalOffset: number;
  turnId?: string;
  compactionId: string;
  status: "requested" | "committed" | "failed" | "fallback";
};

export interface SessionPendingInput {
  inputId: string;
  delivery: InputDelivery;
  text: string;
  images?: UserImage[];
  imageTypes?: string[];
  sequence: number;
  revision: number;
}

export type ProjectedPendingAdmission = Omit<
  EventEnvelope<"input.admitted"> | EventEnvelope<"input.replaced">,
  "payload"
> & {
  payload: EventPayloadMap["input.admitted"] & { revision: number };
};

/**
 * Hydrate the presentation transcript from durable event facts. This keeps
 * artifact validation and tool-result upserts out of session orchestration.
 */
export async function projectSessionTranscript(
  store: ContentAddressedStore,
  events: readonly AnyEvent[],
  runId: string,
): Promise<SessionTranscriptEntry[]> {
  const requestedTools = new Map<string, Extract<AnyEvent, {
    type: "tool.requested";
  }>>();
  const agentMessages = new Map<AnyEvent, SessionLaneMessage>();
  const wrappedInputs = new Set<string>();
  for (const event of events) {
    if (event.runId === runId && event.type === "message.sent") {
      const source = event.payload.message;
      if ((source.routeId !== undefined || source.sourceEndpoint !== undefined || source.targetEndpoint !== undefined)
        && (source.payload.type === "message.inform" || source.payload.type === "question.ask" || source.payload.type === "question.answer")) {
        // A host wrapper must not revive an envelope rejected by the public projection.
        wrappedInputs.add(sessionInputScope(runId, `a2a:${source.messageId}`));
      }
    }
    const message = projectSessionLaneMessage(event, runId);
    if (message !== undefined) {
      agentMessages.set(event, message);
    }
    if (event.runId === runId && event.laneId === "main" && event.type === "tool.requested"
      && isMainTranscriptVisible(event.visibility)) {
      requestedTools.set(event.payload.operationId, event);
    }
  }

  const transcript: SessionTranscriptEntry[] = [];
  const toolEntryIndexes = new Map<string, number>();
  const seenLaneMessages = new Set<string>();
  const privateInputs = privateSessionInputScopes(events);
  for (const event of events) {
    const laneMessage = agentMessages.get(event);
    if (laneMessage !== undefined) {
      if (!seenLaneMessages.has(laneMessage.messageId)) {
        seenLaneMessages.add(laneMessage.messageId);
        transcript.push(laneMessage);
      }
      continue;
    }
    // This projection feeds the Main-facing transcript surfaces. Sibling
    // lanes keep their own transcripts for their own context and must not be
    // replayed as if they were another Main answer.
    if (event.runId !== runId || event.laneId !== "main" || !isMainTranscriptVisible(event.visibility)) continue;
    if (
      event.type !== "user.message"
      && event.type !== "assistant.message"
      && event.type !== "tool.succeeded"
      && event.type !== "tool.failed"
      && event.type !== "tool.unknown"
    ) continue;
    if (event.type === "user.message" && event.payload.inputId !== undefined
      && (privateInputs.has(sessionInputScope(event.runId, event.payload.inputId))
        || wrappedInputs.has(sessionInputScope(event.runId, event.payload.inputId)))) continue;
    const turnId = event.turnId ?? legacyTurnIdForTranscript(runId);
    if (event.type === "user.message" || event.type === "assistant.message") {
      const message = await readConversationArtifact(store, event.payload.messageRef);
      if (event.type === "user.message") {
        if (event.payload.kind === "continuation") continue;
        if (message.role !== "user") {
          throw new SessionProtocolError("User transcript artifact is not a user message");
        }
        const imageTypes = userImageSummary(message.images);
        transcript.push({
          role: "user",
          content: message.content,
          ...(imageTypes.length === 0 ? {} : { imageTypes }),
          turnId,
        });
      } else {
        if (message.role !== "assistant") {
          throw new SessionProtocolError("Assistant transcript artifact is not an assistant message");
        }
        transcript.push({
          role: "assistant",
          content: message.content,
          hasToolCalls: message.toolCalls.length > 0,
          turnId,
        });
      }
      continue;
    }

    const requested = requestedTools.get(event.payload.operationId);
    const arguments_ = await readTranscriptToolArguments(store, requested);
    if (event.type === "tool.unknown") {
      upsertTranscriptToolEntry(transcript, toolEntryIndexes, {
        role: "tool",
        content: event.payload.reason,
        turnId,
        toolName: event.payload.name,
        toolCallId: event.payload.toolCallId,
        status: "unknown",
        isError: false,
        operationId: event.payload.operationId,
        ...(arguments_ === undefined ? {} : { arguments: arguments_ }),
      });
      continue;
    }

    const message = await readConversationArtifact(store, event.payload.resultRef);
    if (message.role !== "tool") {
      throw new SessionProtocolError("Tool transcript artifact is not a tool message");
    }
    upsertTranscriptToolEntry(transcript, toolEntryIndexes, {
      role: "tool",
      content: message.content,
      ...(userImageSummary(message.images).length === 0
        ? {}
        : { imageTypes: userImageSummary(message.images) }),
      turnId,
      toolName: event.payload.name,
      toolCallId: event.payload.toolCallId,
      status: event.type === "tool.failed" ? "failed" : "succeeded",
      isError: event.type === "tool.failed" || message.isError,
      operationId: event.payload.operationId,
      ...(arguments_ === undefined ? {} : { arguments: arguments_ }),
    });
  }
  return transcript;
}

function isTranscriptVisible(visibility: string): boolean {
  return visibility === "run" || visibility === "user";
}

function isMainTranscriptVisible(visibility: string | undefined): boolean {
  // Legacy Main artifacts were lane-scoped; that does not grant sibling access.
  return visibility === undefined || visibility === "lane" || isTranscriptVisible(visibility);
}

/** Main's legacy lane transcript is public, so private derived inputs use sensitive. */
export function sessionInputVisibility(
  events: readonly AnyEvent[],
  runId: string,
  inputId: string,
): "user" | "sensitive" {
  return privateSessionInputScopes(events).has(sessionInputScope(runId, inputId)) ? "sensitive" : "user";
}

function privateSessionInputScopes(events: readonly AnyEvent[]): Set<string> {
  const scopes = new Set<string>();
  for (const event of events) {
    if ((event.type === "input.admitted" || event.type === "input.replaced")
      && event.laneId === "main" && event.visibility === "sensitive") {
      scopes.add(sessionInputScope(event.runId, event.payload.inputId));
      continue;
    }
    if (event.type !== "message.sent") continue;
    const message = event.payload.message;
    if (message.runId !== event.runId || event.laneId !== message.from
      || message.sourceEndpoint?.laneId !== message.from
      || message.targetEndpoint?.runId !== event.runId
      || message.targetEndpoint.laneId !== "main" || message.to !== "main") continue;
    if (!isTranscriptVisible(event.visibility) || !isTranscriptVisible(message.visibility)) {
      scopes.add(sessionInputScope(event.runId, `a2a:${message.messageId}`));
    }
  }
  return scopes;
}

function sessionInputScope(runId: string, inputId: string): string {
  return JSON.stringify([runId, inputId]);
}

/**
 * Project user-visible compaction lifecycle from replayed Ledger facts.
 *
 * Provider completion is intentionally omitted: it is an internal attempt
 * boundary, while requested/committed/failed/fallback are the same lifecycle
 * facts rendered by the live interactive surface. Duplicate event IDs are
 * ignored defensively because a reconnect source must be idempotent.
 */
export function projectSessionCompactionNotices(
  events: readonly AnyEvent[],
  runId: string,
): SessionCompactionNotice[] {
  const notices: SessionCompactionNotice[] = [];
  const seenEventIds = new Set<string>();
  const ordered = [...events].sort((left, right) => (
    left.globalOffset - right.globalOffset
    || left.eventId.localeCompare(right.eventId)
  ));
  for (const event of ordered) {
    if (
      event.runId !== runId
      || event.laneId !== "main"
      || (
        event.type !== "fukai.compaction.requested"
        && event.type !== "fukai.compaction.committed"
        && event.type !== "fukai.compaction.failed"
        && event.type !== "fukai.compaction.fallback"
      )
      || seenEventIds.has(event.eventId)
    ) {
      continue;
    }
    seenEventIds.add(event.eventId);
    notices.push({
      eventId: event.eventId,
      globalOffset: event.globalOffset,
      ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
      compactionId: event.payload.compactionId,
      status: compactionStatus(event.type),
    });
  }
  return notices;
}

export async function projectPendingInputs(
  store: ContentAddressedStore,
  events: readonly AnyEvent[],
): Promise<SessionPendingInput[]> {
  const privateInputs = privateSessionInputScopes(events);
  const visible = projectPendingAdmissions(events).filter((event) => (
    !privateInputs.has(sessionInputScope(event.runId, event.payload.inputId))
  ));
  return Promise.all(visible.map(async (event) => {
    const message = await readUserMessage(store, event.payload.messageRef);
    const imageTypes = userImageSummary(message.images);
    return {
      inputId: event.payload.inputId,
      delivery: event.payload.delivery,
      text: message.content,
      ...(message.images === undefined
        ? {}
        : { images: structuredClone(message.images) }),
      ...(imageTypes.length === 0 ? {} : { imageTypes }),
      sequence: event.payload.sequence,
      revision: event.payload.revision,
    };
  }));
}

export async function readUserMessage(
  store: ContentAddressedStore,
  ref: ArtifactRef,
): Promise<Extract<ConversationMessage, { role: "user" }>> {
  const value = await readConversationArtifact(store, ref);
  if (value.role !== "user") {
    throw new SessionProtocolError("Input artifact is not a user message");
  }
  return value;
}

export async function readUserText(
  store: ContentAddressedStore,
  ref: ArtifactRef,
): Promise<string> {
  return (await readUserMessage(store, ref)).content;
}

export async function readConversationArtifact(
  store: ContentAddressedStore,
  ref: ArtifactRef,
): Promise<ConversationMessage> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(await store.get(ref)));
  } catch (error: unknown) {
    if (error instanceof SessionProtocolError || error instanceof ArtifactNotFoundError) {
      throw error;
    }
    throw new SessionProtocolError("Conversation artifact is not valid JSON", { cause: error });
  }
  if (
    value === null
    || typeof value !== "object"
    || !["user", "assistant", "tool"].includes((value as Partial<ConversationMessage>).role ?? "")
    || typeof (value as Partial<ConversationMessage>).content !== "string"
  ) {
    throw new SessionProtocolError("Conversation artifact is invalid");
  }
  if ((value as { role?: unknown }).role === "user") {
    try {
      validateUserImages((value as { images?: unknown }).images);
    } catch (error: unknown) {
      throw new SessionProtocolError("Conversation image artifact is invalid", { cause: error });
    }
  } else if ((value as { role?: unknown }).role === "tool"
    && (value as { images?: unknown }).images !== undefined) {
    try {
      validateUserImages((value as { images?: unknown }).images);
    } catch (error: unknown) {
      throw new SessionProtocolError("Conversation tool image artifact is invalid", { cause: error });
    }
  } else if ((value as { images?: unknown }).images !== undefined) {
    throw new SessionProtocolError("Only user and tool messages may contain images");
  }
  return value as ConversationMessage;
}

export async function readToolArgumentsFromStore(
  store: ContentAddressedStore,
  ref: ArtifactRef,
): Promise<Record<string, unknown>> {
  if (ref.mediaType !== TOOL_ARGUMENTS_MEDIA_TYPE) {
    throw new SessionProtocolError("Tool arguments artifact has an unexpected media type");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(await store.get(ref)));
  } catch {
    throw new SessionProtocolError("Tool arguments artifact is not valid JSON");
  }
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new SessionProtocolError("Tool arguments artifact must be a plain object");
  }
  return value as Record<string, unknown>;
}

async function readTranscriptToolArguments(
  store: ContentAddressedStore,
  requested: Extract<AnyEvent, { type: "tool.requested" }> | undefined,
): Promise<Record<string, unknown> | undefined> {
  if (requested === undefined) return undefined;
  // Legacy/corrupt logs may omit the request artifact. The terminal event is
  // still useful, so transcript argument hydration remains best-effort.
  try {
    return await readToolArgumentsFromStore(store, requested.payload.argumentsRef);
  } catch {
    return undefined;
  }
}

export function projectPendingAdmissions(
  events: readonly AnyEvent[],
): ProjectedPendingAdmission[] {
  const pending = new Map<string, ProjectedPendingAdmission>();
  const ordered = [...events].sort((left, right) => left.globalOffset - right.globalOffset);
  for (const event of ordered) {
    if (event.type === "input.admitted") {
      pending.set(event.payload.inputId, {
        ...structuredClone(event),
        payload: {
          ...structuredClone(event.payload),
          revision: 1,
        },
      });
      continue;
    }
    if (event.type === "input.replaced") {
      if (!pending.has(event.payload.inputId)) continue;
      pending.set(event.payload.inputId, {
        eventId: event.eventId,
        runId: event.runId,
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        laneId: event.laneId,
        globalOffset: event.globalOffset,
        laneSeq: event.laneSeq,
        type: "input.replaced",
        schemaVersion: event.schemaVersion,
        occurredAt: event.occurredAt,
        ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
        correlationId: event.correlationId,
        idempotencyKey: event.idempotencyKey,
        visibility: event.visibility,
        contentHash: event.contentHash,
        payload: {
          inputId: event.payload.inputId,
          messageRef: structuredClone(event.payload.messageRef),
          delivery: event.payload.delivery,
          ...(event.payload.targetTurnId === undefined
            ? {}
            : { targetTurnId: event.payload.targetTurnId }),
          sequence: event.payload.sequence,
          revision: event.payload.revision,
        },
      });
      continue;
    }
    if (event.type === "input.delivered" || event.type === "input.withdrawn") {
      pending.delete(event.payload.inputId);
    }
  }
  return [...pending.values()].sort((left, right) => (
    left.payload.sequence - right.payload.sequence
    || left.payload.inputId.localeCompare(right.payload.inputId)
  ));
}

function legacyTurnIdForTranscript(runId: string): string {
  return `legacy:${runId}:0`;
}

function compactionStatus(
  type:
    | "fukai.compaction.requested"
    | "fukai.compaction.committed"
    | "fukai.compaction.failed"
    | "fukai.compaction.fallback",
): SessionCompactionNotice["status"] {
  switch (type) {
    case "fukai.compaction.requested": return "requested";
    case "fukai.compaction.committed": return "committed";
    case "fukai.compaction.failed": return "failed";
    case "fukai.compaction.fallback": return "fallback";
  }
}

function upsertTranscriptToolEntry(
  transcript: SessionTranscriptEntry[],
  indexes: Map<string, number>,
  entry: Extract<SessionTranscriptEntry, { role: "tool" }>,
): void {
  const index = indexes.get(entry.operationId);
  if (index === undefined) {
    indexes.set(entry.operationId, transcript.length);
    transcript.push(entry);
    return;
  }
  transcript[index] = entry;
}
