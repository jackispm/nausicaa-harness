import type { AnyEvent } from "../domain/events.js";
import type { ArtifactRef, Goal, RunId, RunPolicy, TokenUsage } from "../domain/types.js";
import type { FukaiConversationRef } from "../fukai/types.js";
import { sha256, stableJson } from "../ledger/hash.js";
import type { Ledger } from "../ledger/index.js";
import { projectRun } from "../ledger/index.js";

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

export class RunRecoveryError extends Error {}

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
    throw new RunRecoveryError(
      `Run ${runId} has tool operations with unknown outcomes: ${unresolvedOperations.join(", ")}`,
    );
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
  return {
    runId,
    goal: projection.goal,
    policy: projection.run.policy,
    workspace: projection.run.workspace,
    startStep: highestStep(events) + 1,
    upperWatermark: projection.run.lastOffset,
    conversationRefs: conversationRefs(events),
    priorUsage: recoverMainUsage(
      events,
      projection.budget.byLane.main ?? emptyUsage(),
    ),
    ...(completedAnswerRef === undefined ? {} : { completedAnswerRef }),
    events,
  };
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
  const pending = new Set<string>();
  for (const event of events) {
    if (event.type === "tool.requested") {
      pending.add(event.payload.operationId);
    } else if (event.type === "tool.succeeded" || event.type === "tool.failed") {
      pending.delete(event.payload.operationId);
    }
  }
  return [...pending].sort();
};

const conversationRefs = (events: readonly AnyEvent[]): FukaiConversationRef[] => {
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
