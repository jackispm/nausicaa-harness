import type { AnyEvent } from "../domain/events.js";

function operationScope(runId: string, operationId: string): string {
  return `${runId}\u0000${operationId}`;
}

export type PendingToolOperationPhase = "requested" | "admitted" | "started";

export interface PendingToolOperation {
  request: Extract<AnyEvent, { type: "tool.requested" }>;
  phase: PendingToolOperationPhase;
  /** An explicit unknown fact still requires operator reconciliation. */
  unknown: boolean;
}

/**
 * Reconcile tool lifecycle facts without treating the lifecycle itself as a
 * second state machine. Modern records can distinguish an admitted call from
 * an effect that crossed the adapter boundary. Legacy records only have the
 * request fact, so they remain conservatively pending when that operation has
 * no lifecycle facts in the replay.
 */
export function pendingToolOperations(
  events: readonly AnyEvent[],
  runId?: string,
): PendingToolOperation[] {
  const states = new Map<string, PendingToolOperation>();
  // Lifecycle support is determined per operation. A Run may contain both
  // legacy request-only records and modern admitted/started records while an
  // older host is being upgraded; a modern sibling must not hide a legacy
  // operation that still needs reconciliation.
  const lifecycleOperations = new Set<string>();
  for (const event of events) {
    if (runId !== undefined && event.runId !== runId) continue;
    if (event.type === "tool.admitted" || event.type === "tool.started") {
      lifecycleOperations.add(operationScope(event.runId, event.payload.operationId));
    }
    if (event.type === "tool.requested") {
      states.set(operationScope(event.runId, event.payload.operationId), {
        request: event,
        phase: "requested",
        unknown: false,
      });
      continue;
    }
    if (
      event.type !== "tool.admitted"
      && event.type !== "tool.started"
      && event.type !== "tool.succeeded"
      && event.type !== "tool.failed"
      && event.type !== "tool.unknown"
    ) continue;
    const scope = operationScope(event.runId, event.payload.operationId);
    const state = states.get(scope);
    if (state === undefined) continue;
    if (event.type === "tool.admitted") {
      state.phase = "admitted";
    } else if (event.type === "tool.started") {
      state.phase = "started";
    } else if (event.type === "tool.unknown") {
      state.unknown = true;
    } else {
      states.delete(scope);
    }
  }

  return [...states.values()].filter((state) => (
    state.unknown
    || state.phase === "started"
    || (!lifecycleOperations.has(operationScope(state.request.runId, state.request.payload.operationId))
      && state.phase === "requested")
  ));
}

/**
 * Select operations that crossed the durable effect boundary but have no
 * durable outcome. Requested or admitted-only operations never invoked the
 * adapter and therefore must not be promoted to an unknown side effect.
 */
export function pendingStartedToolRequests(
  events: readonly AnyEvent[],
  runId: string,
  turnId: string,
): Array<Extract<AnyEvent, { type: "tool.requested" }>> {
  return pendingToolOperations(events, runId)
    .filter((state) => state.phase === "started" && !state.unknown)
    .map((state) => state.request)
    .filter((event) => event.turnId === turnId);
}
