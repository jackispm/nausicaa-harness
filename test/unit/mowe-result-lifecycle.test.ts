import { describe, expect, it, vi } from "vitest";

import type { AgentTool } from "../../src/domain/ports.js";
import { MoweCatalog, MoweExecutor } from "../../src/mowe/index.js";
import type { MoweCallResult, MoweToolMetadata } from "../../src/mowe/types.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function register(
  catalog: MoweCatalog,
  name: string,
  execute: AgentTool["execute"],
  metadata: MoweToolMetadata = {},
): void {
  catalog.register({
    definition: {
      name,
      description: name,
      parameters: { type: "object" },
    },
    execute,
  }, { effect: "read", concurrencySafe: true, ...metadata });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

describe("Mowe result lifecycle", () => {
  it("reports retained results immediately in completion order and returns source order", async () => {
    const releaseSlow = deferred();
    const fastRecorded = deferred();
    const catalog = new MoweCatalog();
    register(catalog, "slow", async () => {
      await releaseSlow.promise;
      return { content: "slow-value", isError: false };
    });
    register(catalog, "fast", async () => ({ content: "0123456789", isError: false }));
    const recorded: Array<{ index: number; result: MoweCallResult }> = [];
    const execution = new MoweExecutor({ catalog }).execute({
      runId: "completion-order",
      laneId: "main",
      workspace: "/tmp",
      limits: { maxOutputBytes: 10 },
      calls: [
        { id: "slow", name: "slow", arguments: {} },
        { id: "fast", name: "fast", arguments: {} },
      ],
      onResult: (result, index) => {
        recorded.push({ index, result });
        if (result.callId === "fast") fastRecorded.resolve();
      },
    });
    try {
      await fastRecorded.promise;
      expect(recorded.map(({ index }) => index)).toEqual([1]);
      expect(recorded[0]?.result.result.content).toBe("0123456789");
    } finally {
      releaseSlow.resolve();
    }
    const response = await execution;
    expect(recorded.map(({ index }) => index)).toEqual([1, 0]);
    expect(response.results.map((result) => result.callId)).toEqual(["slow", "fast"]);
    expect(response.results[0]?.result.content).toBe("");
    expect(recorded[0]?.result).toBe(response.results[1]);
    expect(recorded[1]?.result).toBe(response.results[0]);
  });

  it("records rejected admissions and ordinary failures once without cancelling other calls", async () => {
    const catalog = new MoweCatalog();
    const needsApproval = vi.fn(async () => ({ content: "unexpected", isError: false }));
    register(catalog, "approval", needsApproval, { requiresApproval: true });
    register(catalog, "broken", async () => { throw new Error("tool failed"); });
    register(catalog, "good", async () => ({ content: "done", isError: false }));
    const recorded: Array<{ index: number; result: MoweCallResult }> = [];
    const response = await new MoweExecutor({ catalog }).execute({
      runId: "isolated-tool-failures",
      laneId: "main",
      workspace: "/tmp",
      calls: [
        { id: "unknown", name: "unknown", arguments: {} },
        { id: "denied", name: "approval", arguments: {} },
        { id: "broken", name: "broken", arguments: {} },
        { id: "truncated", name: "good", arguments: {}, forcedError: "truncated arguments" },
        { id: "good", name: "good", arguments: {} },
      ],
      onResult: (result, index) => { recorded.push({ index, result }); },
    });
    expect(response.status).toBe("partial");
    expect(response.cancelled).toBe(false);
    expect(response.results.map((result) => result.status))
      .toEqual(["failed", "failed", "failed", "failed", "succeeded"]);
    expect(recorded.sort((a, b) => a.index - b.index))
      .toEqual(response.results.map((result, index) => ({ result, index })));
    expect(needsApproval).not.toHaveBeenCalled();
  });

  it.each(["throw", "reject"])(
    "aborts peers and drains adapter cleanup and result callbacks after a callback %s",
    async (failureMode) => {
      const peerStarted = deferred();
      const peerAborted = deferred();
      const releaseCleanup = deferred();
      const peerFinalizing = deferred();
      const releaseFinalization = deferred();
      const pendingRecorded = deferred();
      const originalFailure = new Error("terminal journal unavailable");
      const started: number[] = [];
      const recorded: Array<{ index: number; status: string }> = [];
      let cleanupFinished = false;
      let callbackFinished = false;
      let settled = false;
      const catalog = new MoweCatalog();
      register(catalog, "work", async (args, context) => {
        const index = Number(args.index);
        started.push(index);
        if (index === 0) {
          await peerStarted.promise;
          return { content: "written", isError: false };
        }
        peerStarted.resolve();
        await waitForAbort(context.signal!);
        peerAborted.resolve();
        await releaseCleanup.promise;
        cleanupFinished = true;
        throw context.signal!.reason;
      });
      const execution = new MoweExecutor({ catalog, maxConcurrency: 2 }).execute({
        runId: "terminal-failure",
        laneId: "worker",
        workspace: "/tmp",
        calls: [0, 1, 2].map((index) => ({ id: String(index), name: "work", arguments: { index } })),
        onResult: (result, index) => {
          recorded.push({ index, status: result.status });
          if (index === 0) {
            if (failureMode === "reject") return Promise.reject(originalFailure);
            throw originalFailure;
          }
          if (index === 1) {
            peerFinalizing.resolve();
            return releaseFinalization.promise.then(() => {
              callbackFinished = true;
              throw new Error("secondary journal failure");
            });
          }
          pendingRecorded.resolve();
        },
      });
      const outcome = execution.then(
        () => { settled = true; return undefined; },
        (error: unknown) => { settled = true; return error; },
      );
      try {
        await peerAborted.promise;
        await pendingRecorded.promise;
        expect(settled).toBe(false);
        expect(cleanupFinished).toBe(false);
        expect(started).toEqual([0, 1]);
        expect(recorded).toEqual([
          { index: 0, status: "succeeded" },
          { index: 2, status: "cancelled" },
        ]);
        releaseCleanup.resolve();
        await peerFinalizing.promise;
        expect(cleanupFinished).toBe(true);
        expect(callbackFinished).toBe(false);
        expect(settled).toBe(false);
      } finally {
        releaseCleanup.resolve();
        releaseFinalization.resolve();
      }
      expect(await outcome).toBe(originalFailure);
      expect(callbackFinished).toBe(true);
      expect(recorded).toEqual([
        { index: 0, status: "succeeded" },
        { index: 2, status: "cancelled" },
        { index: 1, status: "cancelled" },
      ]);
      const settledRecords = structuredClone(recorded);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(recorded).toEqual(settledRecords);
    },
  );

  it("drains cancelled queued calls and their callbacks when cancelled before execution", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancel before admission"));
    const execute = vi.fn(async () => ({ content: "unexpected", isError: false }));
    const catalog = new MoweCatalog();
    register(catalog, "work", execute);
    const recorded: string[] = [];
    const response = await new MoweExecutor({ catalog, maxConcurrency: 1 }).execute({
      runId: "pre-cancelled",
      laneId: "main",
      workspace: "/tmp",
      signal: controller.signal,
      calls: [0, 1, 2].map((index) => ({ id: String(index), name: "work", arguments: {} })),
      onResult: async (result) => {
        await Promise.resolve();
        recorded.push(result.callId);
      },
    });
    expect(response.status).toBe("cancelled");
    expect(recorded).toEqual(["0", "1", "2"]);
    expect(response.results.map((result) => result.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not invoke an adapter when its own deadline expires during start recording", async () => {
    vi.useFakeTimers();
    const started = deferred();
    const releaseStart = deferred();
    const execute = vi.fn(async () => ({ content: "unexpected side effect", isError: false }));
    const catalog = new MoweCatalog();
    register(catalog, "timed", execute, { timeoutMs: 10 });
    const recorded: MoweCallResult[] = [];
    try {
      const execution = new MoweExecutor({ catalog }).execute({
        runId: "expired-before-adapter",
        laneId: "main",
        workspace: "/tmp",
        calls: [{ id: "timed", name: "timed", arguments: {} }],
        toolLifecycle: {
          admitted: () => undefined,
          started: async () => {
            started.resolve();
            await releaseStart.promise;
          },
        },
        onResult: (result) => { recorded.push(result); },
      });
      await started.promise;
      await vi.advanceTimersByTimeAsync(10);
      releaseStart.resolve();
      const response = await execution;
      expect(execute).not.toHaveBeenCalled();
      expect(response.results).toMatchObject([{
        status: "failed",
        error: "Tool timed out after 10ms",
      }]);
      expect(recorded).toEqual(response.results);
    } finally {
      releaseStart.resolve();
      vi.useRealTimers();
    }
  });
});
