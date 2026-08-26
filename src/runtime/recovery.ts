import type { AnyEvent, EventEnvelope } from "../domain/events.js";
import type { Clock } from "../domain/ports.js";
import { systemClock } from "../domain/ports.js";
import type {
  ArtifactRef,
  ConversationMessage,
  Goal,
  RunId,
  RunPolicy,
  TokenUsage,
} from "../domain/types.js";
import type { FukaiConversationRef } from "../fukai/types.js";
import { sha256, stableJson } from "../ledger/hash.js";
import type { Ledger } from "../ledger/index.js";
import { projectRun } from "../ledger/index.js";
import type { ContentAddressedStore } from "../store/store.js";

const CONVERSATION_MESSAGE_MEDIA_TYPE = "application/vnd.nausicaa.conversation-message+json";
const OPERATOR_RESOLUTION_ERROR = "Operator resolved unknown tool outcome as failed";

export interface RunRecoveryState {
  runId: RunId;
  goal: Goal;
  policy: RunPolicy;
  workspace: string;
  startStep: number;
  upperWatermark: number;
  conversationRefs: FukaiConversationRef[];
  priorUsage: TokenUsage;
  completedAnswerRef?: ArtifactRef;
  events: AnyEvent[];
}

export interface MainExecutionRecoveryProjection {
  conversationRefs: FukaiConversationRef[];
  usage: TokenUsage;
}

export class RunRecoveryError extends Error {}

export class UnknownToolOperationError extends RunRecoveryError {
  readonly runId: RunId;
  readonly operationIds: readonly string[];

  constructor(runId: RunId, operationIds: readonly string[]) {
    super(
      `Run ${runId} has tool operations with unknown outcomes: ${operationIds.join(", ")}`,
    );
    this.name = "UnknownToolOperationError";
    this.runId = runId;
    this.operationIds = [...operationIds];
  }
}

export const recoverRun = async (
  ledger: Ledger,
  runId: RunId,
): Promise<RunRecoveryState> => {
  let events = await ledger.read({ runId });
  if (events.length === 0) {
    throw new RunRecoveryError(`Run ${runId} does not exist`);
  }
  await verifyLatestCheckpoint(events, runId);

  const unresolvedOperations = findUnresolvedToolOperations(events);
  if (unresolvedOperations.length > 0) {
    throw new UnknownToolOperationError(runId, unresolvedOperations);
  }

  const interruptedStep = findInterruptedStep(events);
  if (interruptedStep !== undefined) {
    const started = events.find((event) =>
      event.type === "step.started"
      && event.laneId === "main"
      && event.payload.step === interruptedStep,
    );
    await ledger.append({
      runId,
      laneId: "main",
      type: "step.failed",
      payload: {
        step: interruptedStep,
        error: "Interrupted before the Step reached a committed boundary",
      },
      ...(started === undefined ? {} : { causationId: started.eventId }),
      correlationId: started?.correlationId ?? `recovery:${runId}`,
      idempotencyKey: `main:step:${interruptedStep}:recovery:interrupted`,
      visibility: "run",
    });
    events = await ledger.read({ runId });
  }

  const projection = projectRun(events, runId);
  if (
    projection.goal === undefined
    || projection.run.policy === undefined
    || projection.run.workspace === undefined
  ) {
    throw new RunRecoveryError(`Run ${runId} is missing its creation facts`);
  }

  const completedAnswerRef = projection.run.status === "completed"
    ? projection.run.answerRef
    : undefined;
  const main = projectMainExecutionRecovery(events);
  return {
    runId,
    goal: projection.goal,
    policy: projection.run.policy,
    workspace: projection.run.workspace,
    startStep: highestStep(events) + 1,
    upperWatermark: projection.run.lastOffset,
    conversationRefs: main.conversationRefs,
    priorUsage: main.usage,
    ...(completedAnswerRef === undefined ? {} : { completedAnswerRef }),
    events,
  };
};

/**
 * Resolve exactly one pending tool operation after an operator has confirmed
 * that its side effect must be treated as failed. The operation is looked up
 * before writing anything, and the deterministic idempotency key makes a
 * retried command harmless after the terminal event is committed.
 */
export const resolvePendingToolOperation = async (
  ledger: Ledger,
  store: ContentAddressedStore,
  runId: RunId,
  operationId: string,
  options: { clock?: Clock } = {},
): Promise<EventEnvelope<"tool.failed"> | undefined> => {
  if (operationId.length === 0 || operationId.includes("\0")) {
    throw new RunRecoveryError("Operation id must be a non-empty string without NUL");
  }
  const events = await ledger.read({ runId });
  if (events.length === 0) {
    throw new RunRecoveryError(`Run ${runId} does not exist`);
  }
  await verifyLatestCheckpoint(events, runId);
  if (hasOperatorResolution(events, operationId)) {
    return undefined;
  }
  const pending = findPendingToolOperation(events, operationId);
  if (pending === undefined) {
    const known = findUnresolvedToolOperations(events);
    if (known.length === 0) {
      throw new RunRecoveryError(`Tool operation ${operationId} is not pending`);
    }
    throw new RunRecoveryError(
      `Tool operation ${operationId} is not pending; unresolved operations: ${known.join(", ")}`,
    );
  }

  const clock = options.clock ?? systemClock;
  const message: ConversationMessage = {
    role: "tool",
    content: OPERATOR_RESOLUTION_ERROR,
    toolCallId: pending.toolCallId,
    toolName: pending.name,
    isError: true,
    createdAt: clock.now().toISOString(),
  };
  const resultRef = await store.put(
    stableJson(message),
    CONVERSATION_MESSAGE_MEDIA_TYPE,
  );
  return ledger.append({
    runId,
    ...(pending.turnId === undefined ? {} : { turnId: pending.turnId }),
    laneId: pending.laneId,
    type: "tool.failed",
    payload: {
      operationId: pending.operationId,
      toolCallId: pending.toolCallId,
      name: pending.name,
      error: OPERATOR_RESOLUTION_ERROR,
      resultRef,
      resolution: "operator",
    },
    causationId: pending.eventId,
    correlationId: pending.correlationId,
    idempotencyKey: `${pending.laneId}:operation:${pending.operationId}:operator-resolved`,
    visibility: "run",
    occurredAt: clock.now().toISOString(),
  });
};

export const commitRunCheckpoint = async (
  ledger: Ledger,
  runId: RunId,
): Promise<void> => {
  const events = await ledger.read({ runId });
  if (events.length === 0) {
    throw new RunRecoveryError(`Cannot checkpoint missing Run ${runId}`);
  }
  const watermark = events.at(-1)!.globalOffset;
  const checksum = projectionChecksum(events, runId);
  await ledger.append({
    runId,
    laneId: "main",
    type: "checkpoint.committed",
    payload: { watermark, checksum },
    correlationId: `checkpoint:${runId}`,
    idempotencyKey: `checkpoint:${watermark}`,
    visibility: "run",
  });
};

export const projectionChecksum = (
  events: readonly AnyEvent[],
  runId: RunId,
): string => sha256(stableJson(projectRun(events, runId)));

const verifyLatestCheckpoint = async (
  events: readonly AnyEvent[],
  runId: RunId,
): Promise<void> => {
  const checkpoint = [...events]
    .reverse()
    .find((event) => event.type === "checkpoint.committed");
  if (checkpoint === undefined) {
    return;
  }
  const prefix = events.filter(
    (event) => event.globalOffset <= checkpoint.payload.watermark,
  );
  const actual = projectionChecksum(prefix, runId);
  if (actual !== checkpoint.payload.checksum) {
    throw new RunRecoveryError(
      `Checkpoint checksum mismatch at offset ${checkpoint.payload.watermark}`,
    );
  }
};

const findInterruptedStep = (events: readonly AnyEvent[]): number | undefined => {
  const started = new Set<number>();
  const terminal = new Set<number>();
  for (const event of events) {
    if (event.laneId !== "main") continue;
    if (event.type === "step.started") started.add(event.payload.step);
    if (event.type === "step.completed" || event.type === "step.failed") {
      terminal.add(event.payload.step);
    }
  }
  return [...started].filter((step) => !terminal.has(step)).sort((a, b) => b - a)[0];
};

const highestStep = (events: readonly AnyEvent[]): number => {
  let highest = 0;
  for (const event of events) {
    if (
      event.laneId === "main"
      && (
        event.type === "step.started"
        || event.type === "step.completed"
        || event.type === "step.failed"
      )
    ) {
      highest = Math.max(highest, event.payload.step);
    }
  }
  return highest;
};

const findUnresolvedToolOperations = (
  events: readonly AnyEvent[],
): string[] => {
  return [...findPendingToolOperations(events).keys()].sort();
};

interface PendingToolOperation {
  operationId: string;
  toolCallId: string;
  name: string;
  laneId: string;
  turnId?: string;
  eventId: string;
  correlationId: string;
}

const findPendingToolOperations = (
  events: readonly AnyEvent[],
): Map<string, PendingToolOperation> => {
  const pending = new Map<string, PendingToolOperation>();
  for (const event of events) {
    if (event.type === "tool.requested") {
      pending.set(event.payload.operationId, {
        operationId: event.payload.operationId,
        toolCallId: event.payload.toolCallId,
        name: event.payload.name,
        laneId: event.laneId,
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        eventId: event.eventId,
        correlationId: event.correlationId,
      });
    } else if (event.type === "tool.succeeded" || event.type === "tool.failed") {
      pending.delete(event.payload.operationId);
    }
  }
  return pending;
};

const findPendingToolOperation = (
  events: readonly AnyEvent[],
  operationId: string,
): PendingToolOperation | undefined => findPendingToolOperations(events).get(operationId);

const hasOperatorResolution = (
  events: readonly AnyEvent[],
  operationId: string,
): boolean => events.some((event) =>
  event.type === "tool.failed"
  && event.payload.operationId === operationId
  && (
    event.payload.resolution === "operator"
    || (
      event.payload.error === OPERATOR_RESOLUTION_ERROR
      && event.idempotencyKey.endsWith(":operator-resolved")
    )
  ),
);

const recoverConversationRefs = (events: readonly AnyEvent[]): FukaiConversationRef[] => {
  const refs: FukaiConversationRef[] = [];
  const pendingModelMessages: Array<{
    ref: ArtifactRef;
    offset: number;
    eventId: string;
    consumed: boolean;
  }> = [];
  const add = (ref: ArtifactRef, offset: number, groupId: string): void => {
    refs.push({ ref, sequence: offset, groupId });
  };

  for (const event of events) {
    switch (event.type) {
      case "user.message":
        add(event.payload.messageRef, event.globalOffset, `event:${event.eventId}`);
        break;
      case "assistant.message": {
        const pending = pendingModelMessages.findLast((candidate) =>
          !candidate.consumed && candidate.ref.id === event.payload.messageRef.id,
        );
        if (pending !== undefined) pending.consumed = true;
        add(event.payload.messageRef, event.globalOffset, `event:${event.eventId}`);
        break;
      }
      case "model.completed":
        if (event.laneId === "main") {
          pendingModelMessages.push({
            ref: event.payload.responseRef,
            offset: event.globalOffset,
            eventId: event.eventId,
            consumed: false,
          });
        }
        break;
      case "tool.succeeded":
      case "tool.failed":
        add(event.payload.resultRef, event.globalOffset, `operation:${event.payload.operationId}`);
        break;
      default:
        break;
    }
  }
  for (const pending of pendingModelMessages) {
    if (!pending.consumed) {
      add(pending.ref, pending.offset, `event:${pending.eventId}`);
    }
  }
  return refs.sort((left, right) => left.sequence - right.sequence);
};

/**
 * Rebuild Main's committed context and token usage from durable facts. A
 * completed response is already billable and usable even when the process
 * stopped before its assistant.message or budget.charged events were appended.
 */
export const projectMainExecutionRecovery = (
  events: readonly AnyEvent[],
): MainExecutionRecoveryProjection => {
  const chargedUsage = events.reduce<TokenUsage>((usage, event) => (
    event.type === "budget.charged" && event.payload.laneId === "main"
      ? addUsage(usage, event.payload.usage)
      : usage
  ), emptyUsage());
  return {
    conversationRefs: recoverConversationRefs(events),
    usage: recoverMainUsage(events, chargedUsage),
  };
};

const emptyUsage = (): TokenUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

const recoverMainUsage = (
  events: readonly AnyEvent[],
  chargedUsage: TokenUsage,
): TokenUsage => {
  const pending: TokenUsage[] = [];
  for (const event of events) {
    if (event.type === "model.completed" && event.laneId === "main") {
      pending.push(event.payload.usage);
    } else if (
      event.type === "budget.charged"
      && event.payload.laneId === "main"
    ) {
      const completedIndex = pending.findIndex((usage) =>
        sameUsage(usage, event.payload.usage)
      );
      if (completedIndex >= 0) {
        pending.splice(completedIndex, 1);
      }
    }
  }
  return pending.reduce(addUsage, chargedUsage);
};

const addUsage = (left: TokenUsage, right: TokenUsage): TokenUsage => ({
  input: left.input + right.input,
  output: left.output + right.output,
  cacheRead: left.cacheRead + right.cacheRead,
  cacheWrite: left.cacheWrite + right.cacheWrite,
  ...(
    left.costUsd === undefined && right.costUsd === undefined
      ? {}
      : { costUsd: (left.costUsd ?? 0) + (right.costUsd ?? 0) }
  ),
});

const sameUsage = (left: TokenUsage, right: TokenUsage): boolean =>
  left.input === right.input
  && left.output === right.output
  && left.cacheRead === right.cacheRead
  && left.cacheWrite === right.cacheWrite
  && (left.costUsd ?? 0) === (right.costUsd ?? 0);
