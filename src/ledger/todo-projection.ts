import type { AnyEvent } from "../domain/events.js";
import type { LaneId, TodoItem, TurnId, RunId } from "../domain/types.js";
import { cloneJson } from "./hash.js";

export interface TodoProjection {
  runId: RunId;
  revision: number;
  items: TodoItem[];
  updatedAtOffset: number;
  updatedByLane?: LaneId;
  turnId?: TurnId;
  source?: "model" | "operator";
}

/**
 * Rebuild the latest structured Todo snapshot from durable events. Revisions
 * make stale writes harmless when a caller replays an out-of-order prefix;
 * global offsets remain the tie-breaker for an idempotent same-revision write.
 */
export function projectTodos(
  events: readonly AnyEvent[],
  runId: RunId,
): TodoProjection {
  let projection: TodoProjection = {
    runId,
    revision: 0,
    items: [],
    updatedAtOffset: 0,
  };
  const ordered = events
    .filter((event) => event.runId === runId)
    .slice()
    .sort((left, right) => left.globalOffset - right.globalOffset);
  for (const event of ordered) {
    if (event.type !== "todo.updated") continue;
    if (event.payload.revision < projection.revision) continue;
    projection = {
      runId,
      revision: event.payload.revision,
      items: cloneJson(event.payload.items),
      updatedAtOffset: event.globalOffset,
      updatedByLane: event.laneId,
      ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
      ...(event.payload.source === undefined ? {} : { source: event.payload.source }),
    };
  }
  return projection;
}
