import type {
  AnyEvent,
  AppendEvent,
} from "../domain/events.js";
import type {
  ArtifactRef,
  LaneId,
  OperationId,
  RunId,
  Visibility,
} from "../domain/types.js";
import { sha256, stableJson } from "../ledger/hash.js";
import type { Ledger } from "../ledger/index.js";
import type { TeamRunReport } from "../domain/team.js";

const channelWrites = new WeakMap<Ledger, Promise<void>>();

/** Channel sequence allocation and report repair share the Ledger's writer scope. */
export function serializeTeamChannelWrite<T>(ledger: Ledger, operation: () => Promise<T>): Promise<T> {
  const result = (channelWrites.get(ledger) ?? Promise.resolve()).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  channelWrites.set(ledger, tail);
  void tail.then(() => { if (channelWrites.get(ledger) === tail) channelWrites.delete(ledger); });
  return result;
}

/** Idempotent report publication also repairs a crash between its two facts. */
export function publishTeamRunReport(input: {
  ledger: Ledger;
  readEvents: () => Promise<readonly AnyEvent[]>;
  report: TeamRunReport & { reportId: string; runId: RunId };
  occurredAt: string;
  causationId?: string;
  assertOwned?: () => void | Promise<void>;
}): Promise<void> {
  return serializeTeamChannelWrite(input.ledger, async () => {
    const { report } = input;
    await input.assertOwned?.();
    const candidate = appendTeamChannelMessage(await input.readEvents(), {
      runId: report.runId, laneId: report.laneId, teamId: report.teamId,
      channelId: "general", threadId: `task:${report.taskId}`,
      operationId: `${report.reportId}:channel`, fromLane: report.laneId,
      body: `[${report.kind}] ${report.summary}`.slice(0, 8_192), artifactRefs: report.artifactRefs,
      ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
      correlationId: `${report.runId}:team:${report.teamId}:task:${report.taskId}`,
      visibility: "run", occurredAt: input.occurredAt,
    });
    await input.assertOwned?.();
    if (!candidate.duplicate) await input.ledger.append(candidate.event);
    await input.assertOwned?.();
    await input.ledger.append({
      runId: report.runId, laneId: report.laneId, type: "team.run.reported", payload: report,
      correlationId: `${report.runId}:team:${report.teamId}:task:${report.taskId}`,
      idempotencyKey: `${report.runId}:team:${report.teamId}:task:${report.taskId}:report`,
      visibility: "run", occurredAt: input.occurredAt,
    } as never);
  });
}

export type TeamChannelEvent = Extract<AnyEvent, { type: "team.message.sent" }>;
export type TeamChannelAppendEvent = AppendEvent<"team.message.sent">;

export interface TeamChannelAppendInput {
  readonly runId: RunId;
  /** Authenticated event author. Defaults to `fromLane`. */
  readonly laneId?: LaneId;
  readonly teamId: string;
  readonly channelId: string;
  /** Stable caller key. Retrying this operation is idempotent. */
  readonly operationId: OperationId;
  readonly fromLane: LaneId;
  readonly body: string;
  readonly threadId?: string;
  readonly mentions?: readonly LaneId[];
  readonly artifactRefs?: readonly ArtifactRef[];
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly turnId?: string;
  readonly visibility?: Visibility;
  readonly occurredAt?: string;
}

export interface TeamChannelAppendResult {
  /** A fresh candidate for Ledger.append, or the already committed event. */
  readonly event: TeamChannelAppendEvent | TeamChannelEvent;
  /** True when the operation already existed with identical content. */
  readonly duplicate: boolean;
}

export interface TeamChannelHistoryOptions {
  readonly runId: RunId;
  readonly teamId: string;
  readonly channelId: string;
  readonly threadId?: string;
  /** Opaque cursor returned by a previous page. */
  readonly cursor?: string;
  readonly limit?: number;
}

export interface TeamChannelHistoryPage {
  readonly messages: readonly TeamChannelEvent[];
  readonly hasMore: boolean;
  /** Omitted on the final page. */
  readonly nextCursor?: string;
}

export const DEFAULT_TEAM_CHANNEL_PAGE_LIMIT = 20;
export const MAX_TEAM_CHANNEL_PAGE_LIMIT = 100;

export class TeamChannelError extends Error {
  override readonly name: string = "TeamChannelError";
}

export class TeamChannelOperationConflictError extends TeamChannelError {
  override readonly name: string = "TeamChannelOperationConflictError";
}

export class TeamChannelCursorError extends TeamChannelError {
  readonly code: "invalid" | "expired";

  constructor(message: string, code: "invalid" | "expired") {
    super(message);
    this.code = code;
  }
}

export class TeamChannelCursorInvalidError extends TeamChannelCursorError {
  override readonly name: string = "TeamChannelCursorInvalidError";

  constructor(message: string) {
    super(message, "invalid");
  }
}

export class TeamChannelCursorExpiredError extends TeamChannelCursorError {
  override readonly name: string = "TeamChannelCursorExpiredError";

  constructor(message: string) {
    super(message, "expired");
  }
}

/**
 * Build one immutable channel fact for the authoritative Ledger. This
 * function never mutates or stores `events`; the caller must append a fresh
 * result to the Ledger and read it back for the next projection.
 */
export function appendTeamChannelMessage(
  events: readonly AnyEvent[],
  input: TeamChannelAppendInput,
): TeamChannelAppendResult {
  validateAppendInput(input);
  const scoped = channelEvents(events, input.runId, input.teamId, input.channelId);
  const existing = scoped.find((event) => event.payload.operationId === input.operationId);
  if (existing !== undefined) {
    if (!sameOperation(existing, input)) {
      throw new TeamChannelOperationConflictError(
        `Operation ${input.operationId} was already used with different channel content`,
      );
    }
    return { event: existing, duplicate: true };
  }

  const sequence = scoped.reduce((highest, event) => Math.max(highest, event.payload.sequence), 0) + 1;
  const payload: TeamChannelAppendEvent["payload"] = {
    teamId: input.teamId,
    channelId: input.channelId,
    sequence,
    fromLane: input.fromLane,
    body: input.body,
    mentions: [...(input.mentions ?? [])],
    artifactRefs: [...(input.artifactRefs ?? [])],
    operationId: input.operationId,
    // The Ledger event contract requires every message to belong to a
    // thread; callers may omit it to post in the channel's general thread.
    threadId: input.threadId ?? `${input.teamId}:${input.channelId}:general`,
  };
  return {
    event: {
      runId: input.runId,
      laneId: input.laneId ?? input.fromLane,
      type: "team.message.sent",
      payload,
      correlationId: input.correlationId ?? `${input.runId}:team:${input.teamId}`,
      idempotencyKey: `${input.runId}:team:${input.teamId}:${input.channelId}:${input.operationId}`,
      ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    },
    duplicate: false,
  };
}

/** Read a bounded page after an opaque, retention-aware cursor. */
export function readTeamChannelHistory(
  events: readonly AnyEvent[],
  options: TeamChannelHistoryOptions,
): TeamChannelHistoryPage {
  validateChannelIdentity(options.runId, "runId");
  validateChannelIdentity(options.teamId, "teamId");
  validateChannelIdentity(options.channelId, "channelId");
  const limit = boundedLimit(options.limit);
  const messages = channelEvents(events, options.runId, options.teamId, options.channelId)
    .sort((left, right) => left.payload.sequence - right.payload.sequence);
  const start = cursorStart(messages, options.cursor, {
    runId: options.runId,
    teamId: options.teamId,
    channelId: options.channelId,
  });
  const visible = options.threadId === undefined
    ? messages.slice(start)
    : messages.slice(start).filter((event) => event.payload.threadId === options.threadId);
  const page = visible.slice(0, limit);
  const hasMore = visible.length > page.length;
  return {
    messages: page,
    hasMore,
    ...(hasMore && page.length > 0
      ? { nextCursor: encodeCursor(cursorForEvent(page[page.length - 1] as TeamChannelEvent)) }
      : {}),
  };
}

function channelEvents(
  events: readonly AnyEvent[],
  runId: RunId,
  teamId: string,
  channelId: string,
): TeamChannelEvent[] {
  return events.filter((event): event is TeamChannelEvent => (
    event.runId === runId
      && event.type === "team.message.sent"
      && event.payload.teamId === teamId
      && event.payload.channelId === channelId
  ));
}

function cursorStart(
  messages: readonly TeamChannelEvent[],
  cursor: string | undefined,
  scope: { readonly runId: string; readonly teamId: string; readonly channelId: string },
): number {
  if (cursor === undefined) return 0;
  const value = decodeCursor(cursor);
  if (value.runId !== scope.runId || value.teamId !== scope.teamId || value.channelId !== scope.channelId) {
    throw new TeamChannelCursorInvalidError("Cursor belongs to another Team channel");
  }
  const index = messages.findIndex((event) => (
    event.eventId === value.eventId
      && event.payload.sequence === value.sequence
      && eventFingerprint(event) === value.fingerprint
  ));
  if (index < 0) {
    throw new TeamChannelCursorExpiredError(
      "Cursor anchor is no longer retained in the Team channel history",
    );
  }
  return index + 1;
}

interface CursorValue {
  readonly version: 1;
  readonly runId: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly fingerprint: string;
}

const CURSOR_PREFIX = "tc1.";

function cursorForEvent(event: TeamChannelEvent): CursorValue {
  return {
    version: 1,
    runId: event.runId,
    teamId: event.payload.teamId,
    channelId: event.payload.channelId,
    eventId: event.eventId,
    sequence: event.payload.sequence,
    fingerprint: eventFingerprint(event),
  };
}

/** Return the same opaque cursor used by history pages for one channel event. */
export function teamChannelCursor(event: TeamChannelEvent): string {
  return encodeCursor(cursorForEvent(event));
}

function encodeCursor(value: CursorValue): string {
  const raw = Buffer.from(stableJson(value), "utf8").toString("base64url");
  const digest = sha256(raw).slice("sha256:".length, "sha256:".length + 16);
  return `${CURSOR_PREFIX}${raw}.${digest}`;
}

function decodeCursor(cursor: string): CursorValue {
  if (typeof cursor !== "string" || cursor.length < 8 || cursor.length > 2_048) {
    throw new TeamChannelCursorInvalidError("Cursor is not a bounded string");
  }
  if (!cursor.startsWith(CURSOR_PREFIX)) {
    throw new TeamChannelCursorInvalidError("Cursor format is unsupported");
  }
  const encoded = cursor.slice(CURSOR_PREFIX.length);
  const separator = encoded.lastIndexOf(".");
  if (separator <= 0 || separator === encoded.length - 1) {
    throw new TeamChannelCursorInvalidError("Cursor checksum is missing");
  }
  const raw = encoded.slice(0, separator);
  const providedDigest = encoded.slice(separator + 1);
  const expectedDigest = sha256(raw).slice("sha256:".length, "sha256:".length + 16);
  if (providedDigest !== expectedDigest) {
    throw new TeamChannelCursorInvalidError("Cursor checksum is invalid");
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!isCursorValue(parsed)) throw new Error("shape");
    return parsed;
  } catch {
    throw new TeamChannelCursorInvalidError("Cursor payload is invalid");
  }
}

function isCursorValue(value: unknown): value is CursorValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.version === 1
    && typeof item.runId === "string"
    && typeof item.teamId === "string"
    && typeof item.channelId === "string"
    && typeof item.eventId === "string"
    && Number.isSafeInteger(item.sequence)
    && (item.sequence as number) >= 1
    && typeof item.fingerprint === "string"
    && item.fingerprint.length > 0;
}

function sameOperation(event: TeamChannelEvent, input: TeamChannelAppendInput): boolean {
  const payload = event.payload;
  const expectedLane = input.laneId ?? input.fromLane;
  const expectedThread = input.threadId ?? `${input.teamId}:${input.channelId}:general`;
  return payload.teamId === input.teamId
    && payload.channelId === input.channelId
    && event.laneId === expectedLane
    && payload.fromLane === input.fromLane
    && payload.body === input.body
    && (payload.threadId ?? expectedThread) === expectedThread
    && stableJson(payload.mentions) === stableJson(input.mentions ?? [])
    && stableJson(payload.artifactRefs) === stableJson(input.artifactRefs ?? []);
}

function eventFingerprint(event: TeamChannelEvent): string {
  return sha256(stableJson({
    runId: event.runId,
    teamId: event.payload.teamId,
    channelId: event.payload.channelId,
    operationId: event.payload.operationId,
    fromLane: event.payload.fromLane,
    body: event.payload.body,
    threadId: event.payload.threadId,
    mentions: event.payload.mentions,
    artifactRefs: event.payload.artifactRefs,
  }));
}

function validateAppendInput(input: TeamChannelAppendInput): void {
  validateChannelIdentity(input.runId, "runId");
  validateChannelIdentity(input.teamId, "teamId");
  validateChannelIdentity(input.channelId, "channelId");
  boundedId(input.operationId, "operationId");
  boundedId(input.fromLane, "fromLane");
  boundedText(input.body, "body", 8_192);
  if (input.laneId !== undefined) boundedId(input.laneId, "laneId");
  if (input.threadId !== undefined) boundedId(input.threadId, "threadId");
  if (input.mentions !== undefined) {
    if (input.mentions.length > 16) throw new RangeError("mentions must contain at most 16 lanes");
    const uniqueMentions = new Set<string>();
    for (const mention of input.mentions) {
      boundedId(mention, "mention");
      if (!uniqueMentions.add(mention)) throw new TypeError("mentions must be unique");
    }
  }
  if (input.artifactRefs !== undefined && input.artifactRefs.length > 32) {
    throw new RangeError("artifactRefs must contain at most 32 refs");
  }
  if (input.occurredAt !== undefined && !Number.isFinite(Date.parse(input.occurredAt))) {
    throw new TypeError("occurredAt must be an ISO timestamp");
  }
}

function validateChannelIdentity(value: string, field: string): void {
  boundedId(value, field);
}

function boundedId(value: string, field: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${field} must be a bounded non-empty identifier`);
  }
  return value;
}

function boundedText(value: string, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || /[\u0000]/u.test(value)) {
    throw new TypeError(`${field} must be bounded non-empty text`);
  }
  return value;
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_TEAM_CHANNEL_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TEAM_CHANNEL_PAGE_LIMIT) {
    throw new RangeError(`limit must be an integer between 1 and ${MAX_TEAM_CHANNEL_PAGE_LIMIT}`);
  }
  return limit;
}
