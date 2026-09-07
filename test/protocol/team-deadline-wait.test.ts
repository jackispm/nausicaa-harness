import { afterEach, describe, expect, it, vi } from "vitest";

import { A2AInbox } from "../../src/a2a/index.js";
import type { AgentTool, ModelPort, ModelRequest, ModelResponse, ToolExecutionContext } from "../../src/domain/ports.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";
import { RunTokenBudget } from "../../src/runtime/run-token-budget.js";
import { TeamRuntime } from "../../src/runtime/team-runtime.js";

const runId = "team-deadline-wait";
const context: ToolExecutionContext = { runId, laneId: "main", workspace: process.cwd(), operationId: "create-held-team" };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, label: string, milliseconds = 1_500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not finish within ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function fixture(maxWallClockMs: number) {
  const entered = deferred<void>();
  const release = deferred<void>();
  const clock = { now: () => new Date() };
  const ledger = new MemoryLedger({ clock });
  const inbox = new A2AInbox({ sink: ledger, clock });
  const store = new MemoryContentAddressedStore();
  let toolSignal: AbortSignal | undefined;
  let toolReturned = false;
  const execute = vi.fn(async (_arguments: Record<string, unknown>, toolContext: ToolExecutionContext) => {
    toolSignal = toolContext.signal;
    entered.resolve();
    // Deliberately ignore cancellation until the test releases the adapter.
    await release.promise;
    toolReturned = true;
    return { content: "Late tool evidence", isError: false };
  });
  const tool: AgentTool = {
    definition: {
      name: "read_file", description: "Read evidence from the held test adapter",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    },
    execute,
  };
  const complete = vi.fn(async (_request: ModelRequest): Promise<ModelResponse> => ({
    content: complete.mock.calls.length === 1 ? "Read evidence" : "Late result must not overwrite cancellation",
    stopReason: complete.mock.calls.length === 1 ? "toolUse" : "stop",
    toolCalls: complete.mock.calls.length === 1 ? [{ id: "read-held", name: "read_file", arguments: { path: "held-evidence" } }] : [],
    usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 },
  }));
  const model: ModelPort = { complete };
  const runtime = new TeamRuntime({
    eventSink: ledger, inbox, store, model, modelName: "deadline-model", runId,
    workspace: process.cwd(), branchTools: [tool], clock, runTokenBudget: new RunTokenBudget(10_000),
    policy: { maxMainStepsPerActivation: 3, maxModelTokens: 10_000, mainRequestTimeoutMs: 10_000, tetoEnabled: false, tetoMaxOutputTokens: 64, tetoActivation: "manual", workerEnabled: false },
    readEvents: () => ledger.read({ runId }), readWatermark: () => ledger.watermark(),
    readAwareness: () => ({ version: 1, generatedAt: clock.now().toISOString(), availability: "fresh", nodes: [], edges: [], roots: [], truncated: false }),
  });
  cleanup.push(async () => {
    release.resolve();
    try {
      await within(runtime.drain(), "released tool drain");
    } finally {
      await within(runtime.stop(), "Team shutdown");
    }
  });
  await runtime.create({
    teamId: "held", members: [{ memberId: "reader", statement: "Read the held evidence", maxModelTokens: 1_000, maxWallClockMs, maxAttempts: 2 }],
  }, context);
  await within(entered.promise, "tool entry");
  return {
    runtime, ledger, release, complete, execute,
    signal: () => toolSignal, returned: () => toolReturned,
    board: async () => (await runtime.status(context)).teams[0]!,
  };
}

describe("Team wait with an uncooperative tool", () => {
  it("joins at a short deadline without awaiting a tool that ignores AbortSignal", async () => {
    const s = await fixture(100);
    expect(s.returned()).toBe(false);
    await expect(within(s.runtime.waitForJoin(), "deadline collection")).resolves.toBeUndefined();

    expect(s.returned()).toBe(false);
    expect(s.signal()?.aborted).toBe(true);
    expect(await s.board()).toMatchObject({
      joinSatisfied: true, joinState: "joined", members: [{ terminal: true, outcome: "abandoned" }],
    });
    const settled = (await s.ledger.read({ runId })).filter((event) => event.type === "team.member.settled");
    expect(settled).toHaveLength(1);
    s.release.resolve();
    await within(s.runtime.drain(), "late tool completion");
    expect(s.returned()).toBe(true);
    expect(s.complete).toHaveBeenCalledTimes(1);
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect((await s.board()).members[0]?.outcome).toBe("abandoned");
    expect((await s.ledger.read({ runId })).filter((event) => event.type === "team.member.settled")).toEqual(settled);
  });

  it("returns after external abort and keeps cancellation authoritative when the tool returns later", async () => {
    const s = await fixture(10_000);
    const abort = new AbortController();
    const waiting = s.runtime.waitForJoin(abort.signal);
    abort.abort(new Error("External Run cancellation"));
    await expect(within(waiting, "cancelled collection")).resolves.toBeUndefined();

    expect(s.returned()).toBe(false);
    expect(s.signal()?.aborted).toBe(true);
    expect(await s.board()).toMatchObject({
      cancellationRequested: true, joinState: "cancelled", members: [{ terminal: true, outcome: "cancelled" }],
    });
    const settled = (await s.ledger.read({ runId })).filter((event) => event.type === "team.member.settled");
    s.release.resolve();
    await within(s.runtime.drain(), "cancelled tool completion");
    expect(s.returned()).toBe(true);
    expect(s.complete).toHaveBeenCalledTimes(1);
    expect((await s.board()).members[0]?.outcome).toBe("cancelled");
    const events = await s.ledger.read({ runId });
    expect(events.filter((event) => event.type === "team.member.settled")).toEqual(settled);
    expect(events.filter((event) => event.type === "team.cancelled")).toHaveLength(1);
    expect(events.some((event) => event.type === "team.joined")).toBe(false);
  });
});
