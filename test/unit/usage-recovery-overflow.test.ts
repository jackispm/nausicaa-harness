import { describe, expect, it } from "vitest";

import type { TokenUsage } from "../../src/domain/types.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { projectMainExecutionRecovery } from "../../src/runtime/recovery.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

describe("Main usage recovery overflow", () => {
  it.each(["charges", "uncharged completions", "mixed"] as const)(
    "accepts the safe integer boundary and rejects overflow across %s",
    async (source) => {
      const fixture = await setup();
      await fixture.append(source === "uncharged completions" ? "completed" : "charged", usage(Number.MAX_SAFE_INTEGER));
      expect(projectMainExecutionRecovery(await fixture.ledger.read()).usage.input).toBe(Number.MAX_SAFE_INTEGER);

      await fixture.append(source === "charges" ? "charged" : "completed", usage(1));
      const events = await fixture.ledger.read();
      expect(() => projectMainExecutionRecovery(events)).toThrow(/recovered input tokens exceed the safe integer range/u);
      expect(await fixture.ledger.read()).toEqual(events);
    },
  );

  it("does not double-count a completion already paired with a charge at the safe integer boundary", async () => {
    const fixture = await setup();
    await fixture.append("charged", usage(Number.MAX_SAFE_INTEGER), "same-request");
    await fixture.append("completed", usage(Number.MAX_SAFE_INTEGER), "same-request");

    expect(projectMainExecutionRecovery(await fixture.ledger.read()).usage.input).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects a non-finite recovered cost from individually finite charges", async () => {
    const fixture = await setup();
    await fixture.append("charged", { ...usage(1), costUsd: Number.MAX_VALUE });
    await fixture.append("charged", { ...usage(1), costUsd: Number.MAX_VALUE });

    const events = await fixture.ledger.read();
    expect(() => projectMainExecutionRecovery(events)).toThrow(/recovered cost exceeds the finite number range/u);
  });
});

async function setup() {
  const ledger = new MemoryLedger();
  const store = new MemoryContentAddressedStore();
  const responseRef = await store.put("response", "text/plain");
  let sequence = 0;
  return {
    ledger,
    async append(kind: "charged" | "completed", usage: TokenUsage, prefix = `request-${++sequence}`) {
      const common = { runId: "run-1", laneId: "main", correlationId: "recovery-test" };
      if (kind === "charged") {
        await ledger.append({
          ...common, type: "budget.charged", payload: { laneId: "main", usage }, idempotencyKey: `${prefix}:budget`,
        });
      } else {
        await ledger.append({
          ...common,
          type: "model.completed",
          payload: { model: "untrusted/model", responseRef, stopReason: "stop", usage },
          idempotencyKey: `${prefix}:model:completed`,
        });
      }
    },
  };
}

function usage(input: number): TokenUsage {
  return { input, output: 0, cacheRead: 0, cacheWrite: 0 };
}
