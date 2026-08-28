import type {
  AnyEvent,
  AppendEvent,
  EventEnvelope,
} from "../domain/events.js";
import {
  deriveContextCompactionAttemptId,
  deriveContextCompactionId,
} from "../domain/context.js";
import type { ContextCompactionCapsule } from "../domain/context.js";
import type { LaneId, RunId, TokenUsage } from "../domain/types.js";
import type { Ledger } from "../ledger/index.js";
import { sha256, stableJson } from "../ledger/hash.js";
import {
  FukaiCompactionProviderError,
  FukaiCompactionTimeoutError,
} from "./compaction-provider.js";
import { FukaiStaleError } from "./core.js";
import type {
  FukaiCompactionCommitRequest,
  FukaiCompactionProvider,
  FukaiCompactionReadRequest,
  FukaiCompactionRequest,
  FukaiCompactionSelection,
  FukaiCompactionView,
} from "./types.js";

type CompactionLifecycleEventType =
  | "fukai.compaction.requested"
  | "fukai.compaction.completed"
  | "fukai.compaction.failed"
  | "fukai.compaction.fallback";

type CompactionRequestedEvent = EventEnvelope<"fukai.compaction.requested">;
type CompactionCompletedEvent = EventEnvelope<"fukai.compaction.completed">;
type CompactionFailedEvent = EventEnvelope<"fukai.compaction.failed">;
type CompactionFallbackEvent = EventEnvelope<"fukai.compaction.fallback">;
type BudgetChargedEvent = EventEnvelope<"budget.charged">;

interface CompactionAttemptState {
  requested: CompactionRequestedEvent;
  completed?: CompactionCompletedEvent;
  failed?: CompactionFailedEvent;
  charged?: BudgetChargedEvent;
  fallback?: CompactionFallbackEvent;
}

export interface FukaiCompactionCorePort {
  commitCompaction(
    request: FukaiCompactionCommitRequest,
  ): Promise<EventEnvelope<"fukai.compaction.committed">>;
  readCompaction(request: FukaiCompactionReadRequest): Promise<FukaiCompactionView>;
  readCompactionSelection(
    capsule: ContextCompactionCapsule,
    signal?: AbortSignal,
  ): Promise<FukaiCompactionSelection>;
}

export type FukaiCompactionLifecycleLedger = Pick<Ledger, "append" | "read">;

/** Structural subset implemented by the existing RunTokenBudget. */
export interface FukaiCompactionTokenBudgetPort {
  reserve(id: string, tokens: number): { status: "reserved" | "settled" } | undefined;
  settle(id: string, usage: TokenUsage | number): unknown;
  reconcile(
    id: string,
    usage: TokenUsage | number,
    options?: { alreadyAccounted?: boolean },
  ): unknown;
  cancel(id: string): void;
}

export type FukaiCompactionExecutionRequest = Omit<FukaiCompactionRequest, "compactionId"> & {
  /** When supplied for a retry, it must equal the deterministic request identity. */
  compactionId?: string;
  /** Same-scope stale capsule this standalone request intends to replace. */
  repairFromCompactionId?: string;
};

export type FukaiCompactionExecutionOutcome =
  | {
      status: "committed";
      compactionId: string;
      attemptId?: string;
      selection: FukaiCompactionSelection;
      event: EventEnvelope<"fukai.compaction.committed">;
      view: FukaiCompactionView;
      reused: boolean;
    }
  | {
      status: "skipped";
      compactionId: string;
      attemptId?: string;
      reason: "budget-exhausted" | "provider-error" | "stale" | "verification-failed";
      error?: Error;
      view?: FukaiCompactionView;
    };

const executionLocksByLedger = new WeakMap<object, Map<string, Promise<void>>>();

/** Explicit provider -> durable commit -> verified read sequence. */
export class FukaiCompactionCoordinator {
  readonly #core: FukaiCompactionCorePort;
  readonly #provider: FukaiCompactionProvider;
  readonly #ledger: FukaiCompactionLifecycleLedger;
  readonly #tokenBudget: FukaiCompactionTokenBudgetPort;
  readonly #now: () => number;
  readonly #usageFromSelection: (selection: FukaiCompactionSelection) => TokenUsage | undefined;

  constructor(options: {
    core: FukaiCompactionCorePort;
    provider: FukaiCompactionProvider;
    ledger: FukaiCompactionLifecycleLedger;
    tokenBudget: FukaiCompactionTokenBudgetPort;
    now?: () => number;
    usageFromSelection?: (selection: FukaiCompactionSelection) => TokenUsage | undefined;
  }) {
    if (options.core === null || typeof options.core?.commitCompaction !== "function"
      || typeof options.core?.readCompaction !== "function"
      || typeof options.core?.readCompactionSelection !== "function") {
      throw new TypeError(
        "Fukai compaction core must provide commitCompaction, readCompaction, and readCompactionSelection",
      );
    }
    if (options.provider === null || typeof options.provider?.compact !== "function") {
      throw new TypeError("Fukai compaction provider must provide compact");
    }
    if (options.ledger === null || typeof options.ledger?.append !== "function"
      || typeof options.ledger?.read !== "function") {
      throw new TypeError("Fukai compaction lifecycle Ledger must provide append and read");
    }
    if (options.tokenBudget === null || typeof options.tokenBudget?.reserve !== "function"
      || typeof options.tokenBudget?.settle !== "function"
      || typeof options.tokenBudget?.reconcile !== "function"
      || typeof options.tokenBudget?.cancel !== "function") {
      throw new TypeError(
        "Fukai compaction token budget must provide reserve, settle, reconcile, and cancel",
      );
    }
    this.#core = options.core;
    this.#provider = options.provider;
    this.#ledger = options.ledger;
    this.#tokenBudget = options.tokenBudget;
    this.#now = options.now ?? Date.now;
    this.#usageFromSelection = options.usageFromSelection
      ?? ((selection) => selection.providerUsage);
  }

  async execute(
    request: FukaiCompactionExecutionRequest,
  ): Promise<FukaiCompactionExecutionOutcome> {
    throwIfCallerAborted(request.signal);
    assertCanonicalExecutionCursor(request.cursor);
    assertRepairFromCompactionId(request.repairFromCompactionId);
    const compactionId = deriveContextCompactionId(identityFor(request));
    if (request.compactionId !== undefined && request.compactionId !== compactionId) {
      throw new TypeError("Fukai compactionId does not match the deterministic request identity");
    }
    return withExecutionLock(
      this.#ledger,
      `${request.runId}\0${request.laneId}\0${compactionId}`,
      request.signal,
      () => this.#executeLocked(request, compactionId),
    );
  }

  async #executeLocked(
    request: FukaiCompactionExecutionRequest,
    compactionId: string,
  ): Promise<FukaiCompactionExecutionOutcome> {
    const readRequest = readRequestFor(request);
    const existing = await this.#readExisting(readRequest, request.signal);
    if (existing?.compactionId === compactionId) {
      if (
        existing.status === "ready"
        && existing.selection !== undefined
        && existing.event !== undefined
        && repairIntentMatches(request, existing.event)
      ) {
        return {
          status: "committed",
          compactionId,
          ...(existing.event.payload.attemptId === null
            ? {}
            : { attemptId: existing.event.payload.attemptId }),
          selection: existing.selection,
          event: existing.event,
          view: existing,
          reused: true,
        };
      }
      const previous = latestAttempt(
        await this.#ledger.read({ runId: request.runId }),
        request.laneId,
        compactionId,
      );
      await this.#appendFallback(request, compactionId, previous, "stale", "preflight");
      return {
        status: "skipped",
        compactionId,
        ...(previous === undefined ? {} : { attemptId: previous.attemptId }),
        reason: "stale",
        view: existing,
      };
    }

    const events = await this.#ledger.read({ runId: request.runId });
    const previous = latestAttemptState(events, request.laneId, compactionId);
    if (previous !== undefined) {
      const recovered = await this.#recoverAttempt(request, compactionId, previous);
      if (recovered !== undefined) return recovered;
    }
    const attempt = nextAttempt(events, request.laneId, compactionId);
    const attemptId = deriveContextCompactionAttemptId(compactionId, attempt);
    const reservationId = `fukai:${attemptId}`;
    const reservedTokens = safeTokenTotal(
      request.budget.maxInputTokens,
      request.budget.maxOutputTokens,
    );
    if (this.#tokenBudget.reserve(reservationId, reservedTokens) === undefined) {
      await this.#appendFallback(
        request,
        compactionId,
        undefined,
        "budget-exhausted",
        "preflight",
      );
      return {
        status: "skipped",
        compactionId,
        reason: "budget-exhausted",
      };
    }
    let requested: EventEnvelope<"fukai.compaction.requested">;
    try {
      requested = await this.#append("fukai.compaction.requested", {
        runId: request.runId,
        laneId: request.laneId,
        type: "fukai.compaction.requested",
        payload: {
          compactionId,
          attemptId,
          attempt,
          cursor: request.cursor,
          upperWatermark: request.upperWatermark,
          goalVersion: request.goal.version,
          policyVersion: request.policyVersion,
          sourceRefs: structuredClone([...request.sourceRefs]),
          ...(request.repairFromCompactionId === undefined
            ? {}
            : { repairFromCompactionId: request.repairFromCompactionId }),
          ...(request.deferredConversationRefs === undefined
            ? {}
            : {
                deferredConversationRefs: request.deferredConversationRefs.map(
                  (ref) => structuredClone(ref),
                ),
              }),
          ...(request.generation === undefined
            ? {}
            : { generation: structuredClone(request.generation) }),
          budget: { ...request.budget },
        },
        correlationId: correlationId(request.runId, request.laneId, compactionId),
        idempotencyKey: lifecycleKey(request.laneId, compactionId, `attempt:${attempt}:requested`),
        visibility: "lane",
      });
    } catch (error: unknown) {
      this.#tokenBudget.cancel(reservationId);
      throw error;
    }

    const startedAt = this.#now();
    let selection: FukaiCompactionSelection;
    try {
      const returned = await this.#provider.compact(providerRequest(request, compactionId));
      const providerUsage = safeUsage(this.#usageFromSelection, returned) ?? undefined;
      try {
        assertProviderSelectionMatchesRequest(request, compactionId, returned);
        const verified = await this.#core.readCompactionSelection(
          returned.capsule,
          request.signal,
        );
        assertProviderSelectionMatchesRequest(request, compactionId, verified);
        selection = {
          ...verified,
          ...(providerUsage === undefined ? {} : { providerUsage }),
        };
      } catch (error: unknown) {
        throw new FukaiCompactionProviderError(
          error instanceof Error ? error.message : String(error),
          providerUsage,
          { cause: error },
        );
      }
    } catch (error: unknown) {
      const status = providerFailureStatus(error, request.signal);
      const usage = usageFromError(error);
      let failed: EventEnvelope<"fukai.compaction.failed">;
      try {
        failed = await this.#append("fukai.compaction.failed", {
          runId: request.runId,
          laneId: request.laneId,
          type: "fukai.compaction.failed",
          payload: {
            compactionId,
            attemptId,
            attempt,
            status,
            elapsedMs: elapsed(startedAt, this.#now()),
            usage,
          },
          causationId: requested.eventId,
          correlationId: requested.correlationId,
          idempotencyKey: lifecycleKey(request.laneId, compactionId, `attempt:${attempt}:terminal`),
          visibility: "lane",
        });
      } catch (ledgerError: unknown) {
        this.#releaseReservationAfterTerminalFailure(reservationId, usage);
        throw ledgerError;
      }
      if (usage === null) {
        this.#tokenBudget.cancel(reservationId);
      } else {
        try {
          await this.#appendBudgetCharge(
            request,
            compactionId,
            { attempt, attemptId },
            usage,
            failed.eventId,
            failed.correlationId,
          );
        } catch (ledgerError: unknown) {
          this.#tokenBudget.settle(reservationId, usage);
          throw ledgerError;
        }
        this.#tokenBudget.settle(reservationId, usage);
      }
      if (status === "cancelled") throw asError(error);
      return {
        status: "skipped",
        compactionId,
        attemptId,
        reason: "provider-error",
        error: asError(error),
      };
    }

    const usage = safeUsage(this.#usageFromSelection, selection);
    const chargedUsage = chargedUsageFor(request, usage);
    let completed: EventEnvelope<"fukai.compaction.completed">;
    try {
      completed = await this.#append("fukai.compaction.completed", {
        runId: request.runId,
        laneId: request.laneId,
        type: "fukai.compaction.completed",
        payload: {
          compactionId,
          attemptId,
          attempt,
          elapsedMs: elapsed(startedAt, this.#now()),
          usage,
          summaryRef: structuredClone(selection.capsule.summaryRef),
          summaryHash: selection.capsule.summaryHash,
          estimatedTokens: selection.capsule.estimatedTokens,
          ...(request.generation === undefined
            ? {}
            : { generationSpecHash: sha256(stableJson(request.generation)) }),
        },
        causationId: requested.eventId,
        correlationId: requested.correlationId,
        idempotencyKey: lifecycleKey(request.laneId, compactionId, `attempt:${attempt}:terminal`),
        visibility: "lane",
      });
    } catch (ledgerError: unknown) {
      this.#tokenBudget.settle(reservationId, chargedUsage);
      throw ledgerError;
    }
    try {
      await this.#appendBudgetCharge(
        request,
        compactionId,
        { attempt, attemptId },
        chargedUsage,
        completed.eventId,
        completed.correlationId,
      );
    } catch (ledgerError: unknown) {
      this.#tokenBudget.settle(reservationId, chargedUsage);
      throw ledgerError;
    }
    this.#tokenBudget.settle(reservationId, chargedUsage);
    throwIfCallerAborted(request.signal);
    return this.#commitSelection(
      request,
      compactionId,
      { attempt, attemptId },
      selection,
      completed,
      false,
    );
  }

  async compact(request: FukaiCompactionExecutionRequest): Promise<FukaiCompactionExecutionOutcome> {
    return this.execute(request);
  }

  #releaseReservationAfterTerminalFailure(
    reservationId: string,
    usage: TokenUsage | null,
  ): void {
    if (usage === null) {
      this.#tokenBudget.cancel(reservationId);
    } else {
      this.#tokenBudget.settle(reservationId, usage);
    }
  }

  async #recoverAttempt(
    request: FukaiCompactionExecutionRequest,
    compactionId: string,
    state: CompactionAttemptState,
  ): Promise<FukaiCompactionExecutionOutcome | undefined> {
    const { attempt, attemptId } = state.requested.payload;
    if (state.completed === undefined) {
      if (state.failed !== undefined) {
        if (state.failed.payload.usage !== null && state.charged === undefined) {
          await this.#appendBudgetCharge(
            request,
            compactionId,
            { attempt, attemptId },
            state.failed.payload.usage,
            state.failed.eventId,
            state.failed.correlationId,
          );
          this.#tokenBudget.reconcile(
            `fukai:${attemptId}`,
            state.failed.payload.usage,
            { alreadyAccounted: true },
          );
          return {
            status: "skipped",
            compactionId,
            attemptId,
            reason: "provider-error",
            error: new Error(
              "Recovered Fukai provider usage was charged without replaying provider IO",
            ),
          };
        }
        return undefined;
      }
      const usage = state.charged?.payload.usage ?? null;
      await this.#appendInterruptedFailure(state.requested, usage);
      this.#tokenBudget.cancel(`fukai:${attemptId}`);
      return {
        status: "skipped",
        compactionId,
        attemptId,
        reason: "provider-error",
        error: new Error(
          state.charged === undefined
            ? "Interrupted Fukai compaction attempt was closed without replaying provider IO"
            : "Legacy charged Fukai compaction attempt has no recoverable provider result",
        ),
      };
    }

    const usage = chargedUsageFor(request, state.completed.payload.usage);
    if (state.charged === undefined) {
      await this.#appendBudgetCharge(
        request,
        compactionId,
        { attempt, attemptId },
        usage,
        state.completed.eventId,
        state.completed.correlationId,
      );
      this.#tokenBudget.reconcile(
        `fukai:${attemptId}`,
        usage,
        { alreadyAccounted: true },
      );
    }
    let selection: FukaiCompactionSelection;
    try {
      selection = await this.#core.readCompactionSelection(
        capsuleFromLifecycle(state.requested, state.completed),
        request.signal,
      );
    } catch (error: unknown) {
      throwIfCallerAborted(request.signal);
      await this.#appendFallback(
        request,
        compactionId,
        { attempt, attemptId },
        "verification-failed",
        "commit",
        state.completed.eventId,
      );
      return {
        status: "skipped",
        compactionId,
        attemptId,
        reason: "verification-failed",
        error: asError(error),
      };
    }
    if (state.completed.payload.usage !== null) {
      selection = {
        ...selection,
        providerUsage: { ...state.completed.payload.usage },
      };
    }
    return this.#commitSelection(
      request,
      compactionId,
      { attempt, attemptId },
      selection,
      state.completed,
      true,
    );
  }

  async #commitSelection(
    request: FukaiCompactionExecutionRequest,
    compactionId: string,
    attempt: { attempt: number; attemptId: string },
    selection: FukaiCompactionSelection,
    completed: CompactionCompletedEvent,
    reused: boolean,
  ): Promise<FukaiCompactionExecutionOutcome> {
    let event: EventEnvelope<"fukai.compaction.committed">;
    try {
      event = await this.#core.commitCompaction({
        runId: request.runId,
        laneId: request.laneId,
        compactionId,
        ...(request.repairFromCompactionId === undefined
          ? {}
          : { repairFromCompactionId: request.repairFromCompactionId }),
        attemptId: attempt.attemptId,
        causationId: completed.eventId,
        goal: request.goal,
        policyVersion: request.policyVersion,
        selection,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error: unknown) {
      throwIfCallerAborted(request.signal);
      const reason = error instanceof FukaiStaleError ? "stale" : "verification-failed";
      await this.#appendFallback(
        request,
        compactionId,
        attempt,
        reason,
        "commit",
        completed.eventId,
      );
      return {
        status: "skipped",
        compactionId,
        attemptId: attempt.attemptId,
        reason,
        error: asError(error),
      };
    }

    const view = await this.#readExisting(readRequestFor(request), request.signal);
    if (view?.status === "ready" && view.compactionId === compactionId
      && view.selection !== undefined && view.event !== undefined
      && repairIntentMatches(request, view.event)) {
      return {
        status: "committed",
        compactionId,
        attemptId: attempt.attemptId,
        selection: view.selection,
        event: view.event,
        view,
        reused,
      };
    }
    await this.#appendFallback(
      request,
      compactionId,
      attempt,
      "verification-failed",
      "read-back",
      event.eventId,
    );
    return {
      status: "skipped",
      compactionId,
      attemptId: attempt.attemptId,
      reason: "verification-failed",
      ...(view === undefined ? {} : { view }),
      error: new Error(
        "Committed Fukai compaction did not read back as ready with the requested repair lineage",
      ),
    };
  }

  async #appendInterruptedFailure(
    requested: CompactionRequestedEvent,
    usage: TokenUsage | null,
  ): Promise<CompactionFailedEvent> {
    const { compactionId, attemptId, attempt } = requested.payload;
    return this.#append("fukai.compaction.failed", {
      runId: requested.runId,
      laneId: requested.laneId,
      type: "fukai.compaction.failed",
      payload: {
        compactionId,
        attemptId,
        attempt,
        status: "failed",
        elapsedMs: 0,
        usage: usage === null ? null : { ...usage },
      },
      causationId: requested.eventId,
      correlationId: requested.correlationId,
      idempotencyKey: lifecycleKey(
        requested.laneId,
        compactionId,
        `attempt:${attempt}:terminal`,
      ),
      visibility: "lane",
    });
  }

  async #appendBudgetCharge(
    request: FukaiCompactionExecutionRequest,
    compactionId: string,
    attempt: { attempt: number; attemptId: string },
    usage: TokenUsage,
    causationId: string,
    correlation: string,
  ): Promise<BudgetChargedEvent> {
    return this.#ledger.append({
      runId: request.runId,
      laneId: request.laneId,
      type: "budget.charged",
      payload: { laneId: request.laneId, usage: { ...usage } },
      causationId,
      correlationId: correlation,
      idempotencyKey: lifecycleKey(
        request.laneId,
        compactionId,
        `attempt:${attempt.attempt}:budget`,
      ),
      visibility: "lane",
    });
  }

  async #append<K extends CompactionLifecycleEventType>(
    _type: K,
    event: AppendEvent<K>,
  ): Promise<EventEnvelope<K>> {
    return this.#ledger.append(event);
  }

  async #appendFallback(
    request: FukaiCompactionExecutionRequest,
    compactionId: string,
    attempt: { attempt: number; attemptId: string } | undefined,
    reason: "budget-exhausted" | "stale" | "verification-failed",
    phase: "preflight" | "commit" | "read-back",
    causationId?: string,
  ): Promise<void> {
    await this.#append("fukai.compaction.fallback", {
      runId: request.runId,
      laneId: request.laneId,
      type: "fukai.compaction.fallback",
      payload: {
        compactionId,
        attemptId: attempt?.attemptId ?? null,
        attempt: attempt?.attempt ?? null,
        reason,
        phase,
      },
      ...(causationId === undefined ? {} : { causationId }),
      correlationId: correlationId(request.runId, request.laneId, compactionId),
      idempotencyKey: lifecycleKey(
        request.laneId,
        compactionId,
        `fallback:${phase}:${reason}:${attempt?.attempt ?? "none"}`,
      ),
      visibility: "lane",
    });
  }

  async #readExisting(
    request: FukaiCompactionReadRequest,
    signal: AbortSignal | undefined,
  ): Promise<FukaiCompactionView | undefined> {
    try {
      return await this.#core.readCompaction({
        ...request,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error: unknown) {
      throwIfCallerAborted(signal);
      return undefined;
    }
  }
}

function assertCanonicalExecutionCursor(cursor: string): void {
  const match = typeof cursor === "string" ? /^offset:(\d+)$/.exec(cursor) : null;
  const offset = match === null ? Number.NaN : Number(match[1]);
  if (
    !Number.isSafeInteger(offset)
    || offset < 0
    || cursor !== `offset:${offset}`
  ) {
    throw new TypeError(
      "Fukai compaction requires canonical offset:<integer> cursor without leading zeroes",
    );
  }
}

function assertRepairFromCompactionId(compactionId: string | undefined): void {
  if (
    compactionId !== undefined
    && !/^fukai-compaction:sha256:[0-9a-f]{64}$/.test(compactionId)
  ) {
    throw new TypeError("Fukai compaction repair source ID is invalid");
  }
}

export function createFukaiCompactionCoordinator(options: {
  core: FukaiCompactionCorePort;
  provider: FukaiCompactionProvider;
  ledger: FukaiCompactionLifecycleLedger;
  tokenBudget: FukaiCompactionTokenBudgetPort;
  now?: () => number;
  usageFromSelection?: (selection: FukaiCompactionSelection) => TokenUsage | undefined;
}): FukaiCompactionCoordinator {
  return new FukaiCompactionCoordinator(options);
}

function identityFor(request: FukaiCompactionExecutionRequest) {
  return {
    runId: request.runId,
    laneId: request.laneId,
    cursor: request.cursor,
    upperWatermark: request.upperWatermark,
    goalVersion: request.goal.version,
    policyVersion: request.policyVersion,
    sourceRefs: request.sourceRefs,
    ...(request.deferredConversationRefs === undefined
      ? {}
      : { deferredConversationRefs: request.deferredConversationRefs }),
    ...(request.repairFromCompactionId === undefined
      ? {}
      : { repairFromCompactionId: request.repairFromCompactionId }),
    ...(request.generation === undefined ? {} : { generation: request.generation }),
    budget: request.budget,
  };
}

function repairIntentMatches(
  request: FukaiCompactionExecutionRequest,
  event: EventEnvelope<"fukai.compaction.committed">,
): boolean {
  return event.payload.resetFromCompactionId === request.repairFromCompactionId;
}

function providerRequest(
  request: FukaiCompactionExecutionRequest,
  compactionId: string,
): FukaiCompactionRequest {
  return {
    compactionId,
    runId: request.runId,
    laneId: request.laneId,
    goal: request.goal,
    policyVersion: request.policyVersion,
    cursor: request.cursor,
    upperWatermark: request.upperWatermark,
    sourceRefs: request.sourceRefs,
    ...(request.deferredConversationRefs === undefined
      ? {}
      : { deferredConversationRefs: request.deferredConversationRefs }),
    ...(request.generation === undefined ? {} : { generation: request.generation }),
    budget: request.budget,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };
}

function assertProviderSelectionMatchesRequest(
  request: FukaiCompactionExecutionRequest,
  compactionId: string,
  selection: FukaiCompactionSelection,
): void {
  const capsule = selection?.capsule;
  const summary = selection?.summary;
  if (capsule?.schemaVersion !== 1 || capsule.status !== "ready") {
    throw new Error("Fukai compaction provider returned a non-ready capsule");
  }
  if (capsule.compactionId !== compactionId) {
    throw new Error("Fukai compaction provider changed the requested compaction ID");
  }
  if (
    capsule.cursor !== request.cursor
    || capsule.upperWatermark !== request.upperWatermark
    || capsule.goalVersion !== request.goal.version
    || capsule.policyVersion !== request.policyVersion
  ) {
    throw new Error("Fukai compaction provider changed the requested position or scope");
  }
  if (stableJson(capsule.sourceRefs) !== stableJson(request.sourceRefs)) {
    throw new Error("Fukai compaction provider changed the requested source refs");
  }
  if (stableJson(capsule.deferredConversationRefs ?? [])
    !== stableJson(request.deferredConversationRefs ?? [])) {
    throw new Error("Fukai compaction provider changed the deferred conversation refs");
  }
  if (stableJson(capsule.generation ?? null) !== stableJson(request.generation ?? null)) {
    throw new Error("Fukai compaction provider changed the requested generation identity");
  }
  if (summary?.schemaVersion !== 1 || stableJson(summary.goal) !== stableJson(request.goal)) {
    throw new Error("Fukai compaction provider changed the requested Goal");
  }
  if (stableJson(summary.sourceRefs) !== stableJson(request.sourceRefs)) {
    throw new Error("Fukai compaction summary changed the requested source refs");
  }
  if (stableJson(summary.deferredConversationRefs ?? [])
    !== stableJson(request.deferredConversationRefs ?? [])) {
    throw new Error("Fukai compaction summary changed the deferred conversation refs");
  }
  if (stableJson(summary.generation ?? null) !== stableJson(request.generation ?? null)) {
    throw new Error("Fukai compaction summary changed the requested generation identity");
  }
}

function readRequestFor(request: FukaiCompactionExecutionRequest): FukaiCompactionReadRequest {
  return {
    runId: request.runId,
    laneId: request.laneId,
    goalVersion: request.goal.version,
    policyVersion: request.policyVersion,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };
}

function nextAttempt(events: readonly AnyEvent[], laneId: LaneId, compactionId: string): number {
  return (latestAttempt(events, laneId, compactionId)?.attempt ?? 0) + 1;
}

function latestAttempt(
  events: readonly AnyEvent[],
  laneId: LaneId,
  compactionId: string,
): { attempt: number; attemptId: string } | undefined {
  const requested = events
    .filter((event): event is EventEnvelope<"fukai.compaction.requested"> => (
      event.type === "fukai.compaction.requested"
      && event.laneId === laneId
      && event.payload.compactionId === compactionId
    ))
    .sort((left, right) => left.payload.attempt - right.payload.attempt)
    .at(-1);
  return requested === undefined
    ? undefined
    : {
        attempt: requested.payload.attempt,
        attemptId: requested.payload.attemptId,
      };
}

function latestAttemptState(
  events: readonly AnyEvent[],
  laneId: LaneId,
  compactionId: string,
): CompactionAttemptState | undefined {
  const requested = events
    .filter((event): event is CompactionRequestedEvent => (
      event.type === "fukai.compaction.requested"
      && event.laneId === laneId
      && event.payload.compactionId === compactionId
    ))
    .sort((left, right) => (
      left.payload.attempt - right.payload.attempt
      || left.globalOffset - right.globalOffset
    ))
    .at(-1);
  if (requested === undefined) return undefined;
  const { attempt, attemptId } = requested.payload;
  const completed = events.find((event): event is CompactionCompletedEvent => (
    event.type === "fukai.compaction.completed"
    && event.laneId === laneId
    && event.payload.compactionId === compactionId
    && event.payload.attemptId === attemptId
  ));
  const failed = events.find((event): event is CompactionFailedEvent => (
    event.type === "fukai.compaction.failed"
    && event.laneId === laneId
    && event.payload.compactionId === compactionId
    && event.payload.attemptId === attemptId
  ));
  const chargedKey = lifecycleKey(laneId, compactionId, `attempt:${attempt}:budget`);
  const charged = events.find((event): event is BudgetChargedEvent => (
    event.type === "budget.charged"
    && event.laneId === laneId
    && event.payload.laneId === laneId
    && event.idempotencyKey === chargedKey
  ));
  const fallback = events.find((event): event is CompactionFallbackEvent => (
    event.type === "fukai.compaction.fallback"
    && event.laneId === laneId
    && event.payload.compactionId === compactionId
    && event.payload.attemptId === attemptId
  ));
  return {
    requested,
    ...(completed === undefined ? {} : { completed }),
    ...(failed === undefined ? {} : { failed }),
    ...(charged === undefined ? {} : { charged }),
    ...(fallback === undefined ? {} : { fallback }),
  };
}

function capsuleFromLifecycle(
  requested: CompactionRequestedEvent,
  completed: CompactionCompletedEvent,
): ContextCompactionCapsule {
  const expectedGenerationSpecHash = requested.payload.generation === undefined
    ? undefined
    : sha256(stableJson(requested.payload.generation));
  if (completed.payload.generationSpecHash !== expectedGenerationSpecHash) {
    throw new Error("Fukai compaction generation spec changed across its lifecycle");
  }
  return {
    schemaVersion: 1,
    compactionId: requested.payload.compactionId,
    status: "ready",
    summaryRef: structuredClone(completed.payload.summaryRef),
    sourceRefs: structuredClone(requested.payload.sourceRefs),
    ...(requested.payload.deferredConversationRefs === undefined
      ? {}
      : {
          deferredConversationRefs: requested.payload.deferredConversationRefs.map(
            (ref) => structuredClone(ref),
          ),
        }),
    ...(requested.payload.generation === undefined
      ? {}
      : { generation: structuredClone(requested.payload.generation) }),
    summaryHash: completed.payload.summaryHash,
    cursor: requested.payload.cursor,
    upperWatermark: requested.payload.upperWatermark,
    goalVersion: requested.payload.goalVersion,
    policyVersion: requested.payload.policyVersion,
    estimatedTokens: completed.payload.estimatedTokens,
  };
}

function providerFailureStatus(
  error: unknown,
  signal: AbortSignal | undefined,
): "failed" | "timed-out" | "cancelled" {
  if (error instanceof FukaiCompactionTimeoutError || errorName(error) === "TimeoutError") {
    return "timed-out";
  }
  if (signal?.aborted || errorName(error) === "AbortError") return "cancelled";
  return "failed";
}

function safeUsage(
  readUsage: (selection: FukaiCompactionSelection) => TokenUsage | undefined,
  selection: FukaiCompactionSelection,
): TokenUsage | null {
  try {
    const usage = readUsage(selection);
    if (usage === undefined || !validUsage(usage)) return null;
    return { ...usage };
  } catch {
    return null;
  }
}

function usageFromError(error: unknown): TokenUsage | null {
  if (error === null || typeof error !== "object" || !("providerUsage" in error)) {
    return null;
  }
  return cloneUsage(error.providerUsage);
}

function cloneUsage(value: unknown): TokenUsage | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<TokenUsage>;
  if (
    typeof candidate.input !== "number"
    || typeof candidate.output !== "number"
    || typeof candidate.cacheRead !== "number"
    || typeof candidate.cacheWrite !== "number"
    || (candidate.costUsd !== undefined && typeof candidate.costUsd !== "number")
  ) {
    return null;
  }
  const usage: TokenUsage = {
    input: candidate.input,
    output: candidate.output,
    cacheRead: candidate.cacheRead,
    cacheWrite: candidate.cacheWrite,
    ...(candidate.costUsd === undefined ? {} : { costUsd: candidate.costUsd }),
  };
  return validUsage(usage) ? usage : null;
}

function chargedUsageFor(
  request: FukaiCompactionExecutionRequest,
  usage: TokenUsage | null,
): TokenUsage {
  return usage === null
    ? {
        input: request.budget.maxInputTokens,
        output: request.budget.maxOutputTokens,
        cacheRead: 0,
        cacheWrite: 0,
      }
    : { ...usage };
}

function validUsage(usage: TokenUsage): boolean {
  return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
    .every((value) => Number.isSafeInteger(value) && value >= 0)
    && (usage.costUsd === undefined
      || (Number.isFinite(usage.costUsd) && usage.costUsd >= 0));
}

function elapsed(startedAt: number, completedAt: number): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return 0;
  return Math.max(0, completedAt - startedAt);
}

function safeTokenTotal(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 1) {
    throw new RangeError("Fukai compaction reservation exceeds the safe integer range");
  }
  return total;
}

function errorName(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "name" in error
    && typeof error.name === "string"
    ? error.name
    : undefined;
}

function correlationId(runId: RunId, laneId: LaneId, compactionId: string): string {
  return `fukai:compaction:${runId}:${laneId}:${compactionId}`;
}

function lifecycleKey(laneId: LaneId, compactionId: string, suffix: string): string {
  return `fukai:compaction:${laneId}:${compactionId}:${suffix}`;
}

async function withExecutionLock<T>(
  ledger: object,
  key: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  let tails = executionLocksByLedger.get(ledger);
  if (tails === undefined) {
    tails = new Map<string, Promise<void>>();
    executionLocksByLedger.set(ledger, tails);
  }
  const predecessor = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ownTurn = predecessor.then(() => gate, () => gate);
  tails.set(key, ownTurn);
  try {
    await waitForExecutionLock(predecessor, signal);
    throwIfCallerAborted(signal);
    return await operation();
  } finally {
    release();
    void ownTurn.then(() => {
      if (tails?.get(key) === ownTurn) tails.delete(key);
    });
  }
}

async function waitForExecutionLock(
  predecessor: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    await predecessor;
    return;
  }
  throwIfCallerAborted(signal);
  let abortListener: (() => void) | undefined;
  const abort = new Promise<never>((_, reject) => {
    abortListener = () => reject(abortReason(signal));
    signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    await Promise.race([predecessor, abort]);
  } finally {
    if (abortListener !== undefined) {
      signal.removeEventListener("abort", abortListener);
    }
    abort.catch(() => undefined);
  }
}

function throwIfCallerAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
