import type { AnyEvent, AppendEvent, InputDelivery } from "../domain/events.js";
import { systemClock, type ArtifactRef, type Clock, type Visibility } from "../domain/index.js";
import {
  IdempotencyConflictError,
  type Ledger,
} from "../ledger/index.js";
import { sha256, stableJson } from "../ledger/hash.js";
import {
  type DaemonWakeAdmitter,
  type DaemonWakeRequest,
  type DaemonWakeAdmission,
} from "./daemon-host.js";

/** The lane used by wake inputs unless a composition root chooses another one. */
export const DEFAULT_DAEMON_WAKE_LANE_ID = "main";

/** Stable media type for synthetic payloads created by a caller's resolver. */
export const DAEMON_WAKE_PAYLOAD_MEDIA_TYPE =
  "application/vnd.nausicaa.daemon-wake+json" as const;

export type DaemonWakeDeliveryResolver =
  | InputDelivery
  | ((request: DaemonWakeRequest) => InputDelivery);

export interface LedgerWakeAdmissionAdapterOptions {
  /** The sole durable fact sink. No in-memory wake registry is introduced. */
  readonly ledger: Ledger;
  /**
   * Resolve a durable message artifact when the wake carries no payloadRef.
   * The resolver owns persistence; returning a reference that is not present
   * in the Store will make a later Session projection fail closed.
   */
  readonly resolvePayloadRef?: (
    request: DaemonWakeRequest,
  ) => ArtifactRef | Promise<ArtifactRef>;
  readonly laneId?: string;
  /** Defaults to an independent new Turn. */
  readonly delivery?: DaemonWakeDeliveryResolver;
  /** Defaults to run visibility because daemon wakes are not necessarily user text. */
  readonly visibility?: Visibility;
  readonly clock?: Clock;
  /** Retries stale input sequence observations caused by another writer. */
  readonly maxSequenceRetries?: number;
}

export class LedgerWakeAdmissionError extends Error {
  override readonly name = "LedgerWakeAdmissionError";
}

// Serialize adapters sharing one Ledger object. This is only a race-control
// queue; the Ledger remains the sole durable source of truth.
const ledgerRunTails = new WeakMap<object, Map<string, Promise<void>>>();

/**
 * Converts daemon wakes into the existing `input.admitted` Ledger contract.
 *
 * Dedupe is represented by the Ledger idempotency key, not by another daemon
 * database. A duplicate pending input asks the Host to activate so a restart
 * cannot strand an admitted fact; an already delivered input is a no-op.
 */
export class LedgerWakeAdmissionAdapter {
  private readonly ledger: Ledger;
  private readonly resolvePayloadRef: LedgerWakeAdmissionAdapterOptions["resolvePayloadRef"];
  private readonly laneId: string;
  private readonly delivery: DaemonWakeDeliveryResolver;
  private readonly visibility: Visibility;
  private readonly clock: Clock;
  private readonly maxSequenceRetries: number;

  constructor(options: LedgerWakeAdmissionAdapterOptions) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new LedgerWakeAdmissionError("options must be an object");
    }
    if (options.ledger === null || typeof options.ledger !== "object") {
      throw new LedgerWakeAdmissionError("ledger must implement the Ledger contract");
    }
    this.ledger = options.ledger;
    this.resolvePayloadRef = options.resolvePayloadRef;
    this.laneId = identifier(
      options.laneId ?? DEFAULT_DAEMON_WAKE_LANE_ID,
      "laneId",
    );
    this.delivery = options.delivery ?? "new-turn";
    this.visibility = options.visibility ?? "run";
    this.clock = options.clock ?? systemClock;
    this.maxSequenceRetries = positiveInteger(
      options.maxSequenceRetries ?? 3,
      "maxSequenceRetries",
      8,
    );
    if (typeof this.delivery !== "function" && !isDelivery(this.delivery)) {
      throw new LedgerWakeAdmissionError("delivery must be a valid InputDelivery or resolver");
    }
    if (options.resolvePayloadRef !== undefined && typeof options.resolvePayloadRef !== "function") {
      throw new LedgerWakeAdmissionError("resolvePayloadRef must be a function");
    }
  }

  /** Function-shaped adapter for `DaemonHostOptions.admitWake`. */
  readonly admitWake: DaemonWakeAdmitter = (request) => this.admit(request);

  async admit(request: DaemonWakeRequest): Promise<DaemonWakeAdmission> {
    const normalized = normalizeWake(request, this.clock);
    const tails = ledgerRunTails.get(this.ledger) ?? new Map<string, Promise<void>>();
    ledgerRunTails.set(this.ledger, tails);
    const previous = tails.get(normalized.runId) ?? Promise.resolve();
    const operation = previous.then(() => this.admitSerialized(normalized));
    const tail = operation.then(() => undefined, () => undefined);
    tails.set(normalized.runId, tail);
    try {
      return await operation;
    } finally {
      if (tails.get(normalized.runId) === tail) {
        tails.delete(normalized.runId);
      }
    }
  }

  private async admitSerialized(request: DaemonWakeRequest): Promise<DaemonWakeAdmission> {
    const idempotencyKey = deriveDaemonWakeIdempotencyKey(request);
    const delivery = resolveDelivery(this.delivery, request);
    let payloadRef = request.payloadRef === undefined
      ? undefined
      : structuredClone(request.payloadRef);

    for (let attempt = 0; attempt < this.maxSequenceRetries; attempt += 1) {
      const events = await this.ledger.read({ runId: request.runId });
      const existing = findAdmission(events, idempotencyKey);
      if (existing !== undefined) {
        assertCompatible(existing, request, payloadRef, delivery);
        return duplicateAdmission(events, existing);
      }

      payloadRef ??= await this.resolveMessageRef(request, idempotencyKey);

      const sequence = nextInputSequence(events);
      const input = {
        runId: request.runId,
        laneId: this.laneId,
        type: "input.admitted" as const,
        payload: {
          inputId: request.inputId ?? deriveDaemonWakeInputId(request),
          messageRef: payloadRef,
          delivery,
          sequence,
        },
        correlationId: deriveDaemonWakeCorrelationId(request),
        idempotencyKey,
        visibility: this.visibility,
        ...(request.occurredAt === undefined ? {} : { occurredAt: request.occurredAt }),
      } satisfies AppendEvent<"input.admitted">;
      try {
        const admitted = await this.ledger.append(input);
        return {
          status: "admitted",
          inputId: admitted.payload.inputId,
        };
      } catch (error: unknown) {
        if (!isInputSequenceConflict(error) || attempt + 1 >= this.maxSequenceRetries) {
          throw error;
        }
      }
    }

    throw new LedgerWakeAdmissionError("wake admission exceeded sequence retry bound");
  }

  private async resolveMessageRef(
    request: DaemonWakeRequest,
    idempotencyKey: string,
  ): Promise<ArtifactRef> {
    if (request.payloadRef !== undefined) return structuredClone(request.payloadRef);
    if (this.resolvePayloadRef === undefined) {
      throw new LedgerWakeAdmissionError(
        `Wake ${idempotencyKey} has no payloadRef; configure resolvePayloadRef`,
      );
    }
    const resolved = await this.resolvePayloadRef(request);
    if (!isArtifactRef(resolved)) {
      throw new LedgerWakeAdmissionError("resolvePayloadRef must return an ArtifactRef");
    }
    return structuredClone(resolved);
  }
}

/** Create a function suitable for `DaemonHostOptions.admitWake`. */
export function createLedgerWakeAdmitter(
  options: LedgerWakeAdmissionAdapterOptions,
): DaemonWakeAdmitter {
  const adapter = new LedgerWakeAdmissionAdapter(options);
  return adapter.admitWake;
}

/** Stable idempotency identity shared by all adapters for one Run wake. */
export function deriveDaemonWakeIdempotencyKey(request: Pick<DaemonWakeRequest, "runId" | "dedupeKey">): string {
  return `daemon:wake:${sha256(`${request.runId}\u0000${request.dedupeKey}`)}`;
}

/** Stable input identity used when the caller did not provide an inputId. */
export function deriveDaemonWakeInputId(request: Pick<DaemonWakeRequest, "runId" | "dedupeKey">): string {
  return `wake:${sha256(`${request.runId}\u0000${request.dedupeKey}`)}`;
}

function deriveDaemonWakeCorrelationId(request: DaemonWakeRequest): string {
  return `daemon:${request.source}:${sha256(`${request.runId}\u0000${request.dedupeKey}`)}`;
}

function normalizeWake(request: DaemonWakeRequest, clock: Clock): DaemonWakeRequest {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new LedgerWakeAdmissionError("wake must be an object");
  }
  if (
    request.source !== "timer"
    && request.source !== "webhook"
    && request.source !== "file"
    && request.source !== "a2a"
    && request.source !== "user"
    && request.source !== "system"
  ) {
    throw new LedgerWakeAdmissionError("wake.source is unsupported");
  }
  const runId = identifier(request.runId, "wake.runId");
  const dedupeKey = identifier(request.dedupeKey, "wake.dedupeKey");
  if (request.payloadRef !== undefined && !isArtifactRef(request.payloadRef)) {
    throw new LedgerWakeAdmissionError("wake.payloadRef must be an ArtifactRef");
  }
  const occurredAt = request.occurredAt ?? clock.now().toISOString();
  if (!Number.isFinite(Date.parse(occurredAt))) {
    throw new LedgerWakeAdmissionError("wake.occurredAt must be a valid date-time");
  }
  return Object.freeze({
    runId,
    source: request.source,
    dedupeKey,
    ...(request.wakeId === undefined ? {} : { wakeId: identifier(request.wakeId, "wake.wakeId") }),
    ...(request.inputId === undefined ? {} : { inputId: identifier(request.inputId, "wake.inputId") }),
    ...(request.payloadRef === undefined ? {} : { payloadRef: structuredClone(request.payloadRef) }),
    occurredAt,
  });
}

function findAdmission(
  events: readonly AnyEvent[],
  idempotencyKey: string,
): Extract<AnyEvent, { type: "input.admitted" }> | undefined {
  const existing = events.find((event) => event.idempotencyKey === idempotencyKey);
  if (existing === undefined) return undefined;
  if (existing.type !== "input.admitted") {
    throw new IdempotencyConflictError(
      `Daemon wake idempotency key ${idempotencyKey} is already used by ${existing.type}`,
    );
  }
  return existing;
}

function assertCompatible(
  existing: Extract<AnyEvent, { type: "input.admitted" }>,
  request: DaemonWakeRequest,
  payloadRef: ArtifactRef | undefined,
  delivery: InputDelivery,
): void {
  if (
    existing.payload.delivery !== delivery
    || (payloadRef !== undefined
      && stableJson(existing.payload.messageRef) !== stableJson(payloadRef))
    || (request.inputId !== undefined && existing.payload.inputId !== request.inputId)
    || existing.correlationId !== deriveDaemonWakeCorrelationId(request)
  ) {
    throw new IdempotencyConflictError(
      `Daemon wake dedupe key was reused with different payload or delivery`,
    );
  }
}

function duplicateAdmission(
  events: readonly AnyEvent[],
  existing: Extract<AnyEvent, { type: "input.admitted" }>,
): DaemonWakeAdmission {
  const delivered = events.some((event) => (
    event.type === "input.delivered"
    && event.payload.inputId === existing.payload.inputId
  ));
  return {
    status: "duplicate",
    inputId: existing.payload.inputId,
    ...(delivered ? {} : { shouldActivate: true }),
  };
}

function nextInputSequence(events: readonly AnyEvent[]): number {
  let highest = 0;
  for (const event of events) {
    if (event.type === "input.admitted") highest = Math.max(highest, event.payload.sequence);
  }
  if (highest >= Number.MAX_SAFE_INTEGER) {
    throw new LedgerWakeAdmissionError("input sequence is exhausted");
  }
  return highest + 1;
}

function resolveDelivery(
  delivery: DaemonWakeDeliveryResolver,
  request: DaemonWakeRequest,
): InputDelivery {
  const value = typeof delivery === "function" ? delivery(request) : delivery;
  if (!isDelivery(value)) throw new LedgerWakeAdmissionError("delivery resolver returned an invalid value");
  return value;
}

function isDelivery(value: unknown): value is InputDelivery {
  return value === "new-turn" || value === "steering" || value === "follow-up";
}

function isArtifactRef(value: unknown): value is ArtifactRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ArtifactRef>;
  return (
    typeof candidate.id === "string"
    && candidate.id.length > 0
    && typeof candidate.contentHash === "string"
    && /^sha256:[0-9a-f]{64}$/u.test(candidate.contentHash)
    && candidate.id === candidate.contentHash
    && typeof candidate.mediaType === "string"
    && candidate.mediaType.length > 0
    && Number.isSafeInteger(candidate.byteLength)
    && (candidate.byteLength as number) >= 0
  );
}

function isInputSequenceConflict(error: unknown): boolean {
  return error instanceof Error && /input sequence|not monotonic/iu.test(error.message);
}

function identifier(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.includes("\0")
  ) {
    throw new LedgerWakeAdmissionError(`${field} must be a non-empty, trimmed string without NUL`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new LedgerWakeAdmissionError(`${field} must be a positive integer <= ${maximum}`);
  }
  return value as number;
}
