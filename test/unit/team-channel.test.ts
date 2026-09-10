import { describe, expect, it } from "vitest";

import { MemoryLedger } from "../../src/ledger/index.js";
import {
  appendTeamChannelMessage,
  MAX_TEAM_CHANNEL_PAGE_LIMIT,
  readTeamChannelHistory,
  TeamChannelCursorExpiredError,
  TeamChannelCursorInvalidError,
  TeamChannelOperationConflictError,
} from "../../src/runtime/team-channel.js";

const scope = { runId: "run-1", teamId: "team-1", channelId: "general" };

async function append(
  ledger: MemoryLedger,
  operationId: string,
  body = operationId,
): Promise<void> {
  const result = appendTeamChannelMessage(await ledger.read(), {
    ...scope,
    operationId,
    fromLane: "worker-1",
    body,
    occurredAt: "2026-09-10T00:00:00.000Z",
  });
  await ledger.append(result.event);
}

describe("TeamChannel pure append and history projection", () => {
  it("returns Ledger candidates and paginates with an opaque cursor", async () => {
    const ledger = new MemoryLedger();
    await append(ledger, "op-1");
    await append(ledger, "op-2");
    await append(ledger, "op-3");
    const events = await ledger.read();

    const first = readTeamChannelHistory(events, { ...scope, limit: 2 });
    expect(first.messages.map((event) => event.payload.body)).toEqual(["op-1", "op-2"]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toMatch(/^tc1\.[A-Za-z0-9_-]+\.[a-f0-9]{16}$/u);
    expect(first.nextCursor).not.toContain("event-2");
    const cursor = first.nextCursor!;

    const second = readTeamChannelHistory(events, {
      ...scope, cursor, limit: 2,
    });
    expect(second.messages.map((event) => event.payload.body)).toEqual(["op-3"]);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeUndefined();
  });

  it("deduplicates an operation and rejects a conflicting retry", async () => {
    const ledger = new MemoryLedger();
    const first = appendTeamChannelMessage([], {
      ...scope, operationId: "op-1", fromLane: "worker-1", body: "hello",
    });
    const committed = await ledger.append(first.event);
    const retry = appendTeamChannelMessage([committed], {
      ...scope, operationId: "op-1", fromLane: "worker-1", body: "hello",
    });
    expect(retry.duplicate).toBe(true);
    expect(retry.event).toBe(committed);
    expect(() => appendTeamChannelMessage([committed], {
      ...scope, operationId: "op-1", fromLane: "worker-1", body: "changed",
    })).toThrow(TeamChannelOperationConflictError);
  });

  it("expires a cursor when its anchor has left retained history", async () => {
    const ledger = new MemoryLedger();
    await append(ledger, "op-1");
    await append(ledger, "op-2");
    await append(ledger, "op-3");
    const events = await ledger.read();
    const page = readTeamChannelHistory(events, { ...scope, limit: 1 });
    const retained = events.filter((event) => (
      event.type !== "team.message.sent" || event.payload.sequence >= 2
    ));
    const cursor = page.nextCursor!;
    expect(() => readTeamChannelHistory(retained, {
      ...scope, cursor,
    })).toThrow(TeamChannelCursorExpiredError);
  });

  it("rejects tampered, cross-channel, and unbounded cursors", async () => {
    const ledger = new MemoryLedger();
    await append(ledger, "op-1");
    await append(ledger, "op-2");
    const events = await ledger.read();
    const page = readTeamChannelHistory(events, { ...scope, limit: 1 });
    const original = page.nextCursor!;
    const tampered = original.slice(0, -1) + (original.endsWith("0") ? "1" : "0");
    expect(() => readTeamChannelHistory(events, { ...scope, cursor: tampered })).toThrow(TeamChannelCursorInvalidError);
    expect(() => readTeamChannelHistory(events, { ...scope, channelId: "other", cursor: original })).toThrow(TeamChannelCursorInvalidError);
    expect(() => readTeamChannelHistory(events, { ...scope, limit: MAX_TEAM_CHANNEL_PAGE_LIMIT + 1 })).toThrow(RangeError);
  });
});
