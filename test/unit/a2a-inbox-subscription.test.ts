import { describe, expect, it, vi } from "vitest";

import { A2AInbox } from "../../src/a2a/inbox.js";
import type { AppendEvent, EventType } from "../../src/domain/events.js";
import type { A2AMessage } from "../../src/domain/types.js";
import { MemoryLedger } from "../../src/ledger/index.js";

function message(id: string, to = "main"): A2AMessage {
  return { messageId: id, runId: "inbox-subscription", conversationId: "conversation", threadId: "thread",
    from: "worker", to, createdAt: new Date().toISOString(), correlationId: id, idempotencyKey: id,
    visibility: "run", priority: 5, delivery: "next-step", payload: { type: "message.inform", text: id } };
}

describe("Inbox durable readiness subscriptions", () => {
  it("notifies only the receiver after projection, preserving send, claim, reclaim and handle ordering", async () => {
    const ledger = new MemoryLedger();
    const inbox = new A2AInbox({ sink: ledger });
    const seen: string[] = [];
    const other = vi.fn();
    const unsubscribe = inbox.subscribe("main", () => {
      seen.push(inbox.snapshot().records.find((record) => record.message.messageId === "one")!.status);
    });
    inbox.subscribe("other", other);
    const first = message("one");
    await inbox.send(first);
    await inbox.send(first);
    await inbox.claim("main", "main", { claimId: "first" });
    await inbox.reclaim("one", "main");
    await inbox.claim("main", "main", { claimId: "second" });
    await inbox.handle("one", "main");
    expect(seen).toEqual(["pending", "claimed", "pending", "claimed", "handled"]);
    expect(other).not.toHaveBeenCalled();
    unsubscribe();
    await inbox.send(message("two"));
    expect(seen).toHaveLength(5);
  });

  it("isolates synchronous and async observer failures from committed sends and later observers", async () => {
    const inbox = new A2AInbox();
    inbox.subscribe("main", () => { throw new Error("observer failed"); });
    inbox.subscribe("main", async () => { throw new Error("async observer failed"); });
    const healthy = vi.fn();
    inbox.subscribe("main", healthy);
    await expect(inbox.send(message("one"))).resolves.toMatchObject({ status: "queued" });
    await expect(inbox.send(message("two"))).resolves.toMatchObject({ status: "queued" });
    expect(healthy).toHaveBeenCalledTimes(2);
    expect(inbox.snapshot().records).toHaveLength(2);
  });

  it("does not notify for a failed append, and an old unsubscribe cannot remove a new subscription", async () => {
    class FailingLedger extends MemoryLedger {
      fail = true;
      override async append<K extends EventType>(event: AppendEvent<K>) {
        if (this.fail) throw new Error("disk unavailable");
        return super.append(event);
      }
    }
    const ledger = new FailingLedger();
    const inbox = new A2AInbox({ sink: ledger });
    const old = vi.fn();
    const unsubscribe = inbox.subscribe("main", old);
    await expect(inbox.send(message("one"))).rejects.toThrow("disk unavailable");
    expect(old).not.toHaveBeenCalled();
    expect(inbox.snapshot().records).toEqual([]);
    unsubscribe();
    const current = vi.fn();
    inbox.subscribe("main", current);
    unsubscribe();
    ledger.fail = false;
    await inbox.send(message("one"));
    expect(old).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnce();
  });

  it("signals rehydrated readiness after replacing the projection", async () => {
    const ledger = new MemoryLedger();
    const source = new A2AInbox({ sink: ledger });
    const receiver = new A2AInbox();
    let ready = false;
    const unsubscribe = receiver.subscribe("main", () => {
      ready = receiver.nextClaimableDelayMs("main") === 0;
    });
    await source.send(message("restored"));
    receiver.rehydrate(await ledger.read());
    expect(ready).toBe(true);
    unsubscribe();
  });
});
