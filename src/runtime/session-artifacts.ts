import type { AnyEvent, InputDelivery } from "../domain/events.js";
import type {
  ArtifactRef,
  ConversationMessage,
} from "../domain/types.js";
import {
  type UserImage,
  userImageSummary,
  validateUserImages,
} from "../domain/images.js";
import type { ContentAddressedStore } from "../store/index.js";
import { SessionProtocolError } from "./session-protocol-error.js";

export const MESSAGE_MEDIA_TYPE = "application/vnd.nausicaa.conversation-message+json";
export const TOOL_ARGUMENTS_MEDIA_TYPE = "application/vnd.nausicaa.tool-arguments+json";

export type SessionTranscriptEntry =
  | {
      role: "user";
      content: string;
      imageTypes?: string[];
      turnId: string;
    }
  | {
      role: "assistant";
      content: string;
      turnId: string;
    }
  | {
      role: "tool";
      content: string;
      turnId: string;
      toolName: string;
      toolCallId: string;
      status: "succeeded" | "failed" | "unknown";
      isError: boolean;
      operationId: string;
      arguments?: Record<string, unknown>;
    };

export interface SessionPendingInput {
  inputId: string;
  delivery: InputDelivery;
  text: string;
  imageTypes?: string[];
  sequence: number;
}

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
  for (const event of events) {
    if (event.type === "tool.requested") {
      requestedTools.set(event.payload.operationId, event);
    }
  }

  const transcript: SessionTranscriptEntry[] = [];
  const toolEntryIndexes = new Map<string, number>();
  for (const event of events) {
    if (
      event.type !== "user.message"
      && event.type !== "assistant.message"
      && event.type !== "tool.succeeded"
      && event.type !== "tool.failed"
      && event.type !== "tool.unknown"
    ) continue;
    const turnId = event.turnId ?? legacyTurnIdForTranscript(runId);
    if (event.type === "user.message" || event.type === "assistant.message") {
      const message = await readConversationArtifact(store, event.payload.messageRef);
      if (event.type === "user.message") {
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
        transcript.push({ role: "assistant", content: message.content, turnId });
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

export async function projectPendingInputs(
  store: ContentAddressedStore,
  events: readonly AnyEvent[],
): Promise<SessionPendingInput[]> {
  return Promise.all(projectPendingAdmissions(events).map(async (event) => {
    const message = await readUserMessage(store, event.payload.messageRef);
    const imageTypes = userImageSummary(message.images);
    return {
      inputId: event.payload.inputId,
      delivery: event.payload.delivery,
      text: message.content,
      ...(imageTypes.length === 0 ? {} : { imageTypes }),
      sequence: event.payload.sequence,
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
  const value: unknown = JSON.parse(new TextDecoder().decode(await store.get(ref)));
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
  } else if ((value as { images?: unknown }).images !== undefined) {
    throw new SessionProtocolError("Only user messages may contain images");
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
): Array<Extract<AnyEvent, { type: "input.admitted" }>> {
  const delivered = new Set(events
    .filter((event) => event.type === "input.delivered")
    .map((event) => event.payload.inputId));
  return events
    .filter((event): event is Extract<AnyEvent, { type: "input.admitted" }> => (
      event.type === "input.admitted" && !delivered.has(event.payload.inputId)
    ))
    .sort((left, right) => left.payload.sequence - right.payload.sequence);
}

function legacyTurnIdForTranscript(runId: string): string {
  return `legacy:${runId}:0`;
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
