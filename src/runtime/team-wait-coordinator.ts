import type { LaneId } from "../domain/types.js";

/** Ephemeral wait edges and current deliveries; durable receipts stay in the Ledger. */
export class TeamWaitCoordinator {
  private readonly listeners = new Set<() => void>();
  private readonly boundaries = new Map<LaneId, ReadonlySet<string>>();
  private readonly waits = new Map<symbol, { from: LaneId; to: LaneId }>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  notify(): void {
    for (const listener of [...this.listeners]) {
      // Readiness notifications cannot fail a committed Team transition.
      try { void Promise.resolve(listener()).catch(() => undefined); } catch { /* notification only */ }
    }
  }

  delivered(laneId: LaneId, messageIds: readonly string[]): void {
    this.boundaries.set(laneId, new Set(messageIds));
  }

  currentMessages(laneId: LaneId): ReadonlySet<string> {
    return this.boundaries.get(laneId) ?? new Set();
  }

  beginWait(from: LaneId, to: LaneId): () => void {
    const visited = new Set<LaneId>();
    const pending = [to];
    while (pending.length > 0) {
      const lane = pending.pop()!;
      if (lane === from) throw new Error("Cannot create a circular Team wait. Handle the collaboration or send a report before waiting again.");
      if (visited.has(lane)) continue;
      visited.add(lane);
      for (const edge of this.waits.values()) if (edge.from === lane) pending.push(edge.to);
    }
    const id = Symbol();
    this.waits.set(id, { from, to });
    return () => { this.waits.delete(id); };
  }
}
