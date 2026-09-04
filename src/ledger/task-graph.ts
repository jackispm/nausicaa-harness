import type { AnyEvent } from "../domain/events.js";
import type {
  A2AMessage,
  LaneId,
  RunId,
  TaskAccept,
  TaskFailed,
  TaskRequest,
  TaskResult,
  TurnId,
} from "../domain/types.js";

type TaskRequestMessage = Omit<A2AMessage, "payload"> & { payload: TaskRequest };
type TaskAcceptMessage = Omit<A2AMessage, "payload"> & { payload: TaskAccept };
type TaskTerminalPayload = TaskResult | TaskFailed;
type TaskTerminalMessage = Omit<A2AMessage, "payload"> & {
  payload: TaskTerminalPayload;
};

export interface TaskAcceptView {
  messageId: string;
  sentAtOffset: number;
}

export interface TaskTerminalView {
  messageId: string;
  type: TaskTerminalPayload["type"];
  payload: TaskTerminalPayload;
  sentAtOffset: number;
}

export interface TaskJoinView {
  eventId: string;
  laneId: LaneId;
  step: number;
  globalOffset: number;
  turnId?: TurnId;
}

export type TaskStaleReason =
  | "goal-revised-before-join"
  | "terminal-handled-without-join"
  | "conflicting-terminal";

export type TaskGraphState =
  | { kind: "delegated" }
  | { kind: "terminal"; terminal: TaskTerminalView }
  | { kind: "joined"; terminal: TaskTerminalView; join: TaskJoinView }
  | { kind: "stale"; reason: TaskStaleReason; terminal?: TaskTerminalView };

export interface TaskGraphTaskView {
  requestMessageId: string;
  taskId: string;
  from: LaneId;
  to: LaneId;
  conversationId: string;
  threadId: string;
  correlationId: string;
  delegatedAtOffset: number;
  /** Parent Run Goal version at delegation; the task's own Goal has a separate version. */
  runGoalVersion?: number;
  request: TaskRequest;
  accept?: TaskAcceptView;
  state: TaskGraphState;
}

export type TaskGraphAnomalyKind =
  | "duplicate-request"
  | "orphan-accept"
  | "invalid-accept-link"
  | "orphan-terminal"
  | "invalid-terminal-link"
  | "conflicting-terminal"
  | "join-from-wrong-lane"
  | "join-after-stale";

export interface TaskGraphAnomaly {
  kind: TaskGraphAnomalyKind;
  globalOffset: number;
  messageId?: string;
  requestMessageId?: string;
}

export interface TaskGraphProjection {
  runId: RunId;
  lastOffset: number;
  tasks: TaskGraphTaskView[];
  anomalies: TaskGraphAnomaly[];
}

/**
 * Project durable delegation and join facts without introducing a graph DSL.
 * A task is joined only when its terminal message is named by a committed Step.
 */
export function projectTaskGraph(
  events: readonly AnyEvent[],
  runId: RunId,
): TaskGraphProjection {
  const tasksByRequest = new Map<string, TaskGraphTaskView>();
  const taskByTerminal = new Map<string, TaskGraphTaskView>();
  const handledMessages = new Set<string>();
  const appliedEvents = new Set<string>();
  const anomalies: TaskGraphAnomaly[] = [];
  let runGoalVersion: number | undefined;
  let lastOffset = 0;

  const ordered = events
    .filter((event) => event.runId === runId)
    .slice()
    .sort(compareEvents);

  for (const event of ordered) {
    if (appliedEvents.has(event.eventId)) continue;
    appliedEvents.add(event.eventId);
    lastOffset = Math.max(lastOffset, event.globalOffset);

    if (event.type === "run.created") {
      runGoalVersion = event.payload.goal?.version;
      continue;
    }
    if (event.type === "goal.revised") {
      runGoalVersion = event.payload.goal.version;
      for (const task of tasksByRequest.values()) {
        if (
          task.state.kind !== "joined"
          && task.runGoalVersion !== undefined
          && event.payload.goal.version > task.runGoalVersion
        ) {
          markStale(task, "goal-revised-before-join");
        }
      }
      continue;
    }
    if (event.type === "message.sent") {
      const message = event.payload.message;
      switch (message.payload.type) {
        case "task.request":
          applyRequest(message as TaskRequestMessage, event.globalOffset);
          break;
        case "task.accept":
          applyAccept(message as TaskAcceptMessage, event.globalOffset);
          break;
        case "task.result":
        case "task.failed":
          applyTerminal(message as TaskTerminalMessage, event.globalOffset);
          break;
        default:
          break;
      }
      continue;
    }
    if (event.type === "step.completed") {
      for (const messageId of event.payload.boundaryMessageIds ?? []) {
        const task = taskByTerminal.get(messageId);
        if (task === undefined) continue;
        if (event.laneId !== task.from) {
          anomalies.push({
            kind: "join-from-wrong-lane",
            globalOffset: event.globalOffset,
            messageId,
            requestMessageId: task.requestMessageId,
          });
          continue;
        }
        const terminal = terminalFromState(task.state);
        if (terminal === undefined) continue;
        if (task.state.kind === "stale") {
          anomalies.push({
            kind: "join-after-stale",
            globalOffset: event.globalOffset,
            messageId,
            requestMessageId: task.requestMessageId,
          });
          continue;
        }
        if (task.state.kind !== "joined") {
          task.state = {
            kind: "joined",
            terminal,
            join: {
              eventId: event.eventId,
              laneId: event.laneId,
              step: event.payload.step,
              globalOffset: event.globalOffset,
              ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
            },
          };
        }
      }
      continue;
    }
    if (event.type === "message.handled") {
      handledMessages.add(event.payload.messageId);
      const task = taskByTerminal.get(event.payload.messageId);
      if (task !== undefined && task.state.kind !== "joined") {
        markStale(task, "terminal-handled-without-join");
      }
    }
  }

  const tasks = [...tasksByRequest.values()]
    .sort((left, right) => (
      left.delegatedAtOffset - right.delegatedAtOffset
      || left.requestMessageId.localeCompare(right.requestMessageId)
    ))
    .map(cloneTask);
  anomalies.sort((left, right) => (
    left.globalOffset - right.globalOffset
    || left.kind.localeCompare(right.kind)
    || (left.messageId ?? "").localeCompare(right.messageId ?? "")
  ));
  return { runId, lastOffset, tasks, anomalies: structuredClone(anomalies) };

  function applyRequest(message: TaskRequestMessage, globalOffset: number): void {
    if (message.runId !== runId || tasksByRequest.has(message.messageId)) {
      anomalies.push({
        kind: "duplicate-request",
        globalOffset,
        messageId: message.messageId,
        requestMessageId: message.messageId,
      });
      return;
    }
    tasksByRequest.set(message.messageId, {
      requestMessageId: message.messageId,
      taskId: message.payload.taskId,
      from: message.from,
      to: message.to,
      conversationId: message.conversationId,
      threadId: message.threadId,
      correlationId: message.correlationId,
      delegatedAtOffset: globalOffset,
      ...(runGoalVersion === undefined ? {} : { runGoalVersion }),
      request: structuredClone(message.payload),
      state: { kind: "delegated" },
    });
  }

  function applyAccept(message: TaskAcceptMessage, globalOffset: number): void {
    const task = requestForReply(message);
    if (task === undefined) {
      anomalies.push({
        kind: message.parentId === undefined || !tasksByRequest.has(message.parentId)
          ? "orphan-accept"
          : "invalid-accept-link",
        globalOffset,
        messageId: message.messageId,
        ...(message.parentId === undefined ? {} : { requestMessageId: message.parentId }),
      });
      return;
    }
    task.accept ??= { messageId: message.messageId, sentAtOffset: globalOffset };
  }

  function applyTerminal(message: TaskTerminalMessage, globalOffset: number): void {
    const task = requestForReply(message);
    if (task === undefined) {
      anomalies.push({
        kind: message.parentId === undefined || !tasksByRequest.has(message.parentId)
          ? "orphan-terminal"
          : "invalid-terminal-link",
        globalOffset,
        messageId: message.messageId,
        ...(message.parentId === undefined ? {} : { requestMessageId: message.parentId }),
      });
      return;
    }
    const terminal: TaskTerminalView = {
      messageId: message.messageId,
      type: message.payload.type,
      payload: structuredClone(message.payload),
      sentAtOffset: globalOffset,
    };
    const existing = terminalFromState(task.state);
    taskByTerminal.set(message.messageId, task);
    if (existing !== undefined && existing.messageId !== message.messageId) {
      anomalies.push({
        kind: "conflicting-terminal",
        globalOffset,
        messageId: message.messageId,
        requestMessageId: task.requestMessageId,
      });
      if (task.state.kind !== "joined") markStale(task, "conflicting-terminal");
      return;
    }
    if (task.state.kind === "delegated") {
      task.state = { kind: "terminal", terminal };
    } else if (task.state.kind === "stale" && task.state.terminal === undefined) {
      task.state = { ...task.state, terminal };
    }
    if (handledMessages.has(message.messageId) && task.state.kind !== "joined") {
      markStale(task, "terminal-handled-without-join");
    }
  }

  function requestForReply(
    message: TaskAcceptMessage | TaskTerminalMessage,
  ): TaskGraphTaskView | undefined {
    if (message.runId !== runId || message.parentId === undefined) return undefined;
    const task = tasksByRequest.get(message.parentId);
    if (task === undefined) return undefined;
    return message.payload.taskId === task.taskId
      && (message.replyTo === undefined || message.replyTo === task.requestMessageId)
      && message.from === task.to
      && message.to === task.from
      && message.conversationId === task.conversationId
      && message.threadId === task.threadId
      && message.correlationId === task.correlationId
      ? task
      : undefined;
  }
}

function markStale(task: TaskGraphTaskView, reason: TaskStaleReason): void {
  if (task.state.kind === "joined") return;
  const terminal = terminalFromState(task.state);
  const currentReason = task.state.kind === "stale" ? task.state.reason : undefined;
  const selected = currentReason === undefined
    || stalePriority(reason) > stalePriority(currentReason)
    ? reason
    : currentReason;
  task.state = {
    kind: "stale",
    reason: selected,
    ...(terminal === undefined ? {} : { terminal }),
  };
}

function stalePriority(reason: TaskStaleReason): number {
  switch (reason) {
    case "goal-revised-before-join": return 1;
    case "terminal-handled-without-join": return 2;
    case "conflicting-terminal": return 3;
  }
}

function terminalFromState(state: TaskGraphState): TaskTerminalView | undefined {
  return state.kind === "terminal" || state.kind === "joined"
    ? state.terminal
    : state.kind === "stale"
      ? state.terminal
      : undefined;
}

function cloneTask(task: TaskGraphTaskView): TaskGraphTaskView {
  return structuredClone(task);
}

function compareEvents(left: AnyEvent, right: AnyEvent): number {
  return left.globalOffset - right.globalOffset
    || left.laneId.localeCompare(right.laneId)
    || left.laneSeq - right.laneSeq
    || left.eventId.localeCompare(right.eventId);
}
