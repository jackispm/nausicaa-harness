import type { AnyEvent, InputDelivery, UserMessageKind } from "../domain/events.js";
import type {
  A2AMessage,
  AdviceDisposition,
  ArtifactRef,
  Goal,
  InputId,
  LaneId,
  LaneKind,
  LaneStatus,
  NavigationDelta,
  RunId,
  RunPolicy,
  TokenUsage,
  TurnId,
} from "../domain/types.js";
import { cloneJson } from "./hash.js";
import { projectTodos, type TodoProjection } from "./todo-projection.js";
import { projectionCheckpoint, type ProjectionCheckpoint } from "./projection-query.js";

// Cross-Run projections live with the router because they consume its saga
// facts, but are re-exported here alongside the ordinary Ledger projection
// surface for persistence/recovery callers.
export {
  projectCrossRunFacts,
  projectA2AReceipts,
  projectCrossRunInbox,
} from "../a2a/cross-run-router.js";
export type {
  CrossRunProjection,
  CrossRunReceiptView,
} from "../a2a/cross-run-router.js";

export type RunStatus = "not-started" | "running" | "completed" | "failed";

export interface RunView {
  runId: RunId;
  status: RunStatus;
  lastOffset: number;
  workspace?: string;
  policy?: RunPolicy;
  answerRef?: ArtifactRef;
  error?: string;
  checkpoint?: { watermark: number; checksum: string };
}

export interface LaneView {
  laneId: LaneId;
  kind?: LaneKind;
  /** Latest durable selector for this lane, when explicitly recorded. */
  model?: string;
  status: LaneStatus;
  reason?: string;
  lastSeq: number;
  lastStep?: number;
  navigation?: NavigationDelta;
}

export interface InboxMessageView {
  message: A2AMessage;
  status: "pending" | "claimed" | "handled";
  sentAtOffset: number;
  claimedBy?: LaneId;
  handledAtOffset?: number;
  adviceDisposition?: AdviceDisposition;
  adviceReason?: string;
}

export type InputStatus = "pending" | "delivered" | "withdrawn";

export interface InputView {
  inputId: InputId;
  messageRef: ArtifactRef;
  delivery: InputDelivery;
  sequence: number;
  revision: number;
  status: InputStatus;
  admittedAtOffset: number;
  replacedAtOffset?: number;
  withdrawnAtOffset?: number;
  targetTurnId?: TurnId;
  turnId?: TurnId;
  deliveredAtOffset?: number;
  boundary?: string;
}

export type TurnStatus =
  | "active"
  | "completed"
  | "failed"
  | "cancelled"
  | "waiting"
  | "interrupted";

export interface TurnView {
  turnId: TurnId;
  status: TurnStatus;
  startedAtOffset: number;
  lastOffset: number;
  lastCommittedStep: number;
  legacy: boolean;
  inputId?: InputId;
  ordinal?: number;
  answerRef?: ArtifactRef;
  error?: string;
  reason?: string;
  retryable?: boolean;
  resumeRequires?: string;
  stepAllowance?: number;
}

export interface UnknownOperationView {
  operationId: string;
  toolCallId: string;
  name: string;
  reason: string;
  turnId: TurnId;
  unknownAtOffset: number;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "cancelled";

export interface ApprovalView {
  operationId: string;
  toolCallId: string;
  name: string;
  argumentsHash: string;
  status: ApprovalStatus;
  requestedAtOffset: number;
  decidedAtOffset?: number;
  reason?: string;
  laneId: LaneId;
  turnId?: TurnId;
}

export type ConversationEntry =
  | {
      role: "user" | "assistant";
      artifact: ArtifactRef;
      laneId: LaneId;
      turnId: TurnId;
      globalOffset: number;
      inputId?: InputId;
      kind?: UserMessageKind;
    }
  | {
      role: "tool";
      artifact: ArtifactRef;
      laneId: LaneId;
      turnId: TurnId;
      globalOffset: number;
      toolCallId: string;
      toolName: string;
      isError: boolean;
    };

export interface BudgetView {
  charged: TokenUsage;
  byLane: Record<LaneId, TokenUsage>;
  maxModelTokens?: number;
}

export interface RunProjection {
  run: RunView;
  goal: Goal | undefined;
  lanes: Record<LaneId, LaneView>;
  inbox: InboxMessageView[];
  inputs: InputView[];
  turns: Record<TurnId, TurnView>;
  activeTurnId?: TurnId;
  unknownOperations: UnknownOperationView[];
  /** Durable approval lifecycle, when tools required host approval. */
  approvals?: ApprovalView[];
  /** Latest structured Todo snapshot, when one has been committed. */
  todos?: TodoProjection;
  /** Stable revision/checksum for this projection's event prefix. */
  revision?: ProjectionCheckpoint;
  budget: BudgetView;
  conversation: ConversationEntry[];
}

export function legacyTurnIdForRun(runId: RunId): TurnId {
  return `legacy:${runId}:0`;
}

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  const hasCost = left.costUsd !== undefined || right.costUsd !== undefined;
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    ...(hasCost ? { costUsd: (left.costUsd ?? 0) + (right.costUsd ?? 0) } : {}),
  };
}

export function projectRun(events: readonly AnyEvent[], runId: RunId): RunProjection {
  const projection: RunProjection = {
    run: { runId, status: "not-started", lastOffset: 0 },
    goal: undefined,
    lanes: Object.create(null) as Record<LaneId, LaneView>,
    inbox: [],
    inputs: [],
    turns: Object.create(null) as Record<TurnId, TurnView>,
    unknownOperations: [],
    approvals: [],
    budget: {
      charged: emptyUsage(),
      byLane: Object.create(null) as Record<LaneId, TokenUsage>,
    },
    conversation: [],
  };
  const inboxById = new Map<string, InboxMessageView>();
  const inputById = new Map<InputId, InputView>();
  const unknownByOperation = new Map<string, UnknownOperationView>();
  const approvalByOperation = new Map<string, ApprovalView>();
  const legacyTurnId = legacyTurnIdForRun(runId);

  const ensureTurn = (
    turnId: TurnId,
    offset: number,
    legacy = false,
  ): TurnView => {
    const existing = projection.turns[turnId];
    if (existing !== undefined) {
      existing.lastOffset = offset;
      return existing;
    }
    const created: TurnView = {
      turnId,
      status: "active",
      startedAtOffset: offset,
      lastOffset: offset,
      lastCommittedStep: 0,
      legacy,
    };
    projection.turns[turnId] = created;
    return created;
  };

  const ordered = events
    .filter((event) => event.runId === runId)
    .slice()
    .sort((left, right) => left.globalOffset - right.globalOffset);

  for (const event of ordered) {
    projection.run.lastOffset = event.globalOffset;
    let lane = projection.lanes[event.laneId];
    if (lane === undefined) {
      lane = {
        laneId: event.laneId,
        status: "dormant",
        lastSeq: event.laneSeq,
      };
      projection.lanes[event.laneId] = lane;
    } else {
      lane.lastSeq = event.laneSeq;
    }

    const attributedTurnId = event.turnId ?? (
      event.type === "step.started"
      || event.type === "step.completed"
      || event.type === "step.failed"
      || event.type === "user.message"
      || event.type === "assistant.message"
      || event.type === "model.requested"
      || event.type === "model.completed"
      || event.type === "model.failed"
      || event.type === "tool.requested"
      || event.type === "approval.requested"
      || event.type === "approval.decided"
      || event.type === "tool.succeeded"
      || event.type === "tool.failed"
        ? legacyTurnId
        : undefined
    );
    const attributedTurn = attributedTurnId === undefined
      ? undefined
      : ensureTurn(attributedTurnId, event.globalOffset, event.turnId === undefined);
    if (
      attributedTurnId === legacyTurnId
      && event.turnId === undefined
      && attributedTurn?.status === "active"
    ) {
      projection.activeTurnId = legacyTurnId;
    }

    switch (event.type) {
      case "run.created":
        projection.run = {
          runId,
          status: "running",
          lastOffset: event.globalOffset,
          workspace: event.payload.workspace,
          policy: cloneJson(event.payload.policy),
        };
        projection.goal = cloneJson(event.payload.goal);
        projection.budget.maxModelTokens = event.payload.policy.maxModelTokens;
        break;
      case "run.resumed":
        projection.run.status = "running";
        delete projection.run.error;
        delete projection.run.answerRef;
        break;
      case "run.completed":
        projection.run.status = "completed";
        delete projection.run.error;
        if (event.payload.answerRef !== undefined) {
          projection.run.answerRef = cloneJson(event.payload.answerRef);
        }
        if (projection.turns[legacyTurnId]?.status === "active") {
          const legacyTurn = projection.turns[legacyTurnId];
          legacyTurn.status = "completed";
          legacyTurn.lastOffset = event.globalOffset;
          if (event.payload.answerRef !== undefined) {
            legacyTurn.answerRef = cloneJson(event.payload.answerRef);
          }
          if (projection.activeTurnId === legacyTurnId) delete projection.activeTurnId;
        }
        break;
      case "run.failed":
        projection.run.status = "failed";
        projection.run.error = event.payload.error;
        if (projection.turns[legacyTurnId]?.status === "active") {
          const legacyTurn = projection.turns[legacyTurnId];
          legacyTurn.status = "failed";
          legacyTurn.error = event.payload.error;
          legacyTurn.lastOffset = event.globalOffset;
          if (projection.activeTurnId === legacyTurnId) delete projection.activeTurnId;
        }
        break;
      case "goal.revised":
        projection.goal = cloneJson(event.payload.goal);
        break;
      case "lane.registered":
        lane.kind = event.payload.kind;
        if (lane.status === "dormant") {
          lane.status = "ready";
        }
        break;
      case "lane.status":
        lane.status = event.payload.status;
        if (event.payload.reason === undefined) {
          delete lane.reason;
        } else {
          lane.reason = event.payload.reason;
        }
        break;
      case "step.started":
      case "step.completed":
      case "step.failed":
        lane.lastStep = event.payload.step;
        if (attributedTurn !== undefined && event.type === "step.completed") {
          attributedTurn.lastCommittedStep = Math.max(
            attributedTurn.lastCommittedStep,
            event.payload.step,
          );
        }
        break;
      case "input.admitted": {
        const input: InputView = {
          inputId: event.payload.inputId,
          messageRef: cloneJson(event.payload.messageRef),
          delivery: event.payload.delivery,
          sequence: event.payload.sequence,
          revision: 1,
          status: "pending",
          admittedAtOffset: event.globalOffset,
          ...(event.payload.targetTurnId === undefined
            ? {}
            : { targetTurnId: event.payload.targetTurnId }),
        };
        projection.inputs.push(input);
        inputById.set(input.inputId, input);
        break;
      }
      case "input.replaced": {
        const input = inputById.get(event.payload.inputId);
        if (input !== undefined) {
          input.messageRef = cloneJson(event.payload.messageRef);
          input.delivery = event.payload.delivery;
          input.sequence = event.payload.sequence;
          input.revision = event.payload.revision;
          input.replacedAtOffset = event.globalOffset;
          if (event.payload.targetTurnId === undefined) {
            delete input.targetTurnId;
          } else {
            input.targetTurnId = event.payload.targetTurnId;
          }
        }
        break;
      }
      case "input.withdrawn": {
        const input = inputById.get(event.payload.inputId);
        if (input !== undefined) {
          input.status = "withdrawn";
          input.withdrawnAtOffset = event.globalOffset;
        }
        break;
      }
      case "input.delivered": {
        const input = inputById.get(event.payload.inputId);
        if (input !== undefined) {
          input.status = "delivered";
          input.turnId = event.payload.turnId;
          input.deliveredAtOffset = event.globalOffset;
          input.boundary = event.payload.boundary;
        }
        break;
      }
      case "turn.started": {
        const turn = ensureTurn(event.payload.turnId, event.globalOffset);
        turn.status = "active";
        turn.inputId = event.payload.inputId;
        turn.ordinal = event.payload.ordinal;
        turn.legacy = false;
        projection.activeTurnId = turn.turnId;
        break;
      }
      case "turn.resumed": {
        const turn = ensureTurn(event.payload.turnId, event.globalOffset);
        turn.status = "active";
        turn.lastCommittedStep = Math.max(turn.lastCommittedStep, event.payload.fromStep);
        turn.stepAllowance = event.payload.stepAllowance;
        delete turn.error;
        delete turn.reason;
        delete turn.retryable;
        delete turn.resumeRequires;
        projection.activeTurnId = turn.turnId;
        break;
      }
      case "turn.completed": {
        const turn = ensureTurn(event.payload.turnId, event.globalOffset);
        turn.status = "completed";
        delete turn.error;
        delete turn.reason;
        delete turn.retryable;
        delete turn.resumeRequires;
        if (event.payload.answerRef !== undefined) {
          turn.answerRef = cloneJson(event.payload.answerRef);
        }
        if (projection.activeTurnId === turn.turnId) delete projection.activeTurnId;
        break;
      }
      case "turn.failed": {
        const turn = ensureTurn(event.payload.turnId, event.globalOffset);
        turn.status = "failed";
        turn.error = event.payload.error;
        delete turn.reason;
        delete turn.retryable;
        delete turn.resumeRequires;
        if (projection.activeTurnId === turn.turnId) delete projection.activeTurnId;
        break;
      }
      case "turn.cancelled": {
        const turn = ensureTurn(event.payload.turnId, event.globalOffset);
        turn.status = "cancelled";
        turn.reason = event.payload.reason;
        turn.lastCommittedStep = event.payload.lastCommittedStep;
        delete turn.error;
        delete turn.retryable;
        delete turn.resumeRequires;
        if (projection.activeTurnId === turn.turnId) delete projection.activeTurnId;
        break;
      }
      case "turn.waiting": {
        const turn = ensureTurn(event.payload.turnId, event.globalOffset);
        turn.status = "waiting";
        turn.reason = event.payload.reason;
        turn.lastCommittedStep = event.payload.lastCommittedStep;
        turn.resumeRequires = event.payload.resumeRequires;
        delete turn.error;
        delete turn.retryable;
        if (projection.activeTurnId === turn.turnId) delete projection.activeTurnId;
        break;
      }
      case "turn.interrupted": {
        const turn = ensureTurn(event.payload.turnId, event.globalOffset);
        turn.status = "interrupted";
        turn.reason = event.payload.reason;
        turn.retryable = event.payload.retryable;
        turn.lastCommittedStep = event.payload.lastCommittedStep;
        delete turn.error;
        delete turn.resumeRequires;
        if (projection.activeTurnId === turn.turnId) delete projection.activeTurnId;
        break;
      }
      case "navigation.updated":
        lane.navigation = cloneJson(event.payload.delta);
        break;
      case "model.selected":
        lane.model = event.payload.model;
        break;
      case "user.message":
      case "assistant.message":
        projection.conversation.push({
          role: event.type === "user.message" ? "user" : "assistant",
          artifact: cloneJson(event.payload.messageRef),
          laneId: event.laneId,
          turnId: attributedTurnId!,
          globalOffset: event.globalOffset,
          ...(event.type === "user.message" && event.payload.inputId !== undefined
            ? { inputId: event.payload.inputId, kind: event.payload.kind }
            : {}),
        });
        break;
      case "tool.unknown":
        unknownByOperation.set(event.payload.operationId, {
          operationId: event.payload.operationId,
          toolCallId: event.payload.toolCallId,
          name: event.payload.name,
          reason: event.payload.reason,
          turnId: event.turnId!,
          unknownAtOffset: event.globalOffset,
        });
        break;
      case "approval.requested": {
        const approval: ApprovalView = {
          operationId: event.payload.operationId,
          toolCallId: event.payload.toolCallId,
          name: event.payload.name,
          argumentsHash: event.payload.argumentsHash,
          status: "pending",
          requestedAtOffset: event.globalOffset,
          laneId: event.laneId,
          ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        };
        approvalByOperation.set(approval.operationId, approval);
        break;
      }
      case "approval.decided": {
        const approval = approvalByOperation.get(event.payload.operationId);
        if (approval !== undefined) {
          approval.status = event.payload.decision;
          approval.decidedAtOffset = event.globalOffset;
          if (event.payload.reason === undefined) delete approval.reason;
          else approval.reason = event.payload.reason;
        }
        break;
      }
      case "tool.succeeded":
      case "tool.failed":
        unknownByOperation.delete(event.payload.operationId);
        projection.conversation.push({
          role: "tool",
          artifact: cloneJson(event.payload.resultRef),
          laneId: event.laneId,
          turnId: attributedTurnId!,
          globalOffset: event.globalOffset,
          toolCallId: event.payload.toolCallId,
          toolName: event.payload.name,
          isError: event.type === "tool.failed",
        });
        break;
      case "message.sent": {
        const item: InboxMessageView = {
          message: cloneJson(event.payload.message),
          status: "pending",
          sentAtOffset: event.globalOffset,
        };
        projection.inbox.push(item);
        inboxById.set(item.message.messageId, item);
        break;
      }
      case "message.claimed": {
        const item = inboxById.get(event.payload.messageId);
        if (item !== undefined && item.status !== "handled") {
          item.status = "claimed";
          item.claimedBy = event.payload.claimedBy;
        }
        break;
      }
      case "message.handled": {
        const item = inboxById.get(event.payload.messageId);
        if (item !== undefined) {
          item.status = "handled";
          item.handledAtOffset = event.globalOffset;
        }
        break;
      }
      case "advice.acknowledged": {
        const item = projection.inbox.find((candidate) => (
          candidate.message.payload.type === "advice.propose"
          && candidate.message.payload.advice.adviceId === event.payload.adviceId
        ));
        if (item !== undefined) {
          item.adviceDisposition = event.payload.disposition;
          if (event.payload.reason !== undefined) {
            item.adviceReason = event.payload.reason;
          }
        }
        break;
      }
      case "budget.charged": {
        projection.budget.charged = addUsage(
          projection.budget.charged,
          event.payload.usage,
        );
        const current = projection.budget.byLane[event.payload.laneId] ?? emptyUsage();
        projection.budget.byLane[event.payload.laneId] = addUsage(
          current,
          event.payload.usage,
        );
        break;
      }
      case "checkpoint.committed":
        projection.run.checkpoint = cloneJson(event.payload);
        break;
      default:
        break;
    }
  }

  projection.inputs.sort((left, right) => (
    left.sequence - right.sequence || left.admittedAtOffset - right.admittedAtOffset
  ));
  projection.unknownOperations = [...unknownByOperation.values()]
    .sort((left, right) => left.unknownAtOffset - right.unknownAtOffset);
  projection.approvals = [...approvalByOperation.values()]
    .sort((left, right) => left.requestedAtOffset - right.requestedAtOffset);
  projection.todos = projectTodos(ordered, runId);
  projection.revision = projectionCheckpoint(ordered, runId);

  return projection;
}
