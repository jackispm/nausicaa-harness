import type { AnyEvent } from "../domain/events.js";
import type {
  A2AMessage,
  AdviceDisposition,
  ArtifactRef,
  Goal,
  LaneId,
  LaneKind,
  LaneStatus,
  NavigationDelta,
  RunId,
  RunPolicy,
  TokenUsage,
} from "../domain/types.js";
import { cloneJson } from "./hash.js";

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

export type ConversationEntry =
  | {
      role: "user" | "assistant";
      artifact: ArtifactRef;
      laneId: LaneId;
      globalOffset: number;
    }
  | {
      role: "tool";
      artifact: ArtifactRef;
      laneId: LaneId;
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
  budget: BudgetView;
  conversation: ConversationEntry[];
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
    budget: {
      charged: emptyUsage(),
      byLane: Object.create(null) as Record<LaneId, TokenUsage>,
    },
    conversation: [],
  };
  const inboxById = new Map<string, InboxMessageView>();

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
        break;
      case "run.completed":
        projection.run.status = "completed";
        delete projection.run.error;
        if (event.payload.answerRef !== undefined) {
          projection.run.answerRef = cloneJson(event.payload.answerRef);
        }
        break;
      case "run.failed":
        projection.run.status = "failed";
        projection.run.error = event.payload.error;
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
        break;
      case "navigation.updated":
        lane.navigation = cloneJson(event.payload.delta);
        break;
      case "user.message":
      case "assistant.message":
        projection.conversation.push({
          role: event.type === "user.message" ? "user" : "assistant",
          artifact: cloneJson(event.payload.messageRef),
          laneId: event.laneId,
          globalOffset: event.globalOffset,
        });
        break;
      case "tool.succeeded":
      case "tool.failed":
        projection.conversation.push({
          role: "tool",
          artifact: cloneJson(event.payload.resultRef),
          laneId: event.laneId,
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

  return projection;
}
