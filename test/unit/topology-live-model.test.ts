import { describe, expect, it, vi } from "vitest";

import type { ModelPort, ModelRequest, ModelResponse, TokenUsage } from "../../src/domain/index.js";
import { TopologyLiveModel } from "../eval/topology-live-model.js";

const defaults = {
  budgetUsd: 0.1,
  maxRequests: 8,
  maxOutputTokens: 128,
  timeoutMs: 10_000,
  inputPrice: 1,
  outputPrice: 1,
};

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    runId: "offline-topology",
    laneId: "main",
    sessionId: "offline-topology:main",
    model: "offline/model",
    systemPrompt: "Answer briefly.",
    messages: [],
    tools: [],
    maxOutputTokens: 64,
    ...overrides,
  };
}

function response(usage: TokenUsage = {
  input: 10, output: 2, cacheRead: 0, cacheWrite: 0, costUsd: 0.001,
}): ModelResponse {
  return { content: "Done.", toolCalls: [], stopReason: "stop", usage };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("topology live model offline safeguards", () => {
  it("validates timeout precision before accepting any provider work", () => {
    const complete = vi.fn<ModelPort["complete"]>().mockResolvedValue(response());

    expect(() => new TopologyLiveModel({ complete }, { ...defaults, timeoutMs: 0.5 }))
      .toThrow(/bounded smoke allowance/u);
    expect(complete).not.toHaveBeenCalled();
  });

  it("copies and freezes limits so callers cannot expand them after admission setup", async () => {
    const complete = vi.fn<ModelPort["complete"]>().mockResolvedValue(response());
    const limits = { ...defaults, maxRequests: 1, maxOutputTokens: 32 };
    const model = new TopologyLiveModel({ complete }, limits);
    limits.maxRequests = 20;
    limits.maxOutputTokens = 4096;

    await model.complete(request());
    await expect(model.complete(request())).rejects.toThrow(/request cap/u);
    expect(complete.mock.calls[0]?.[0].maxOutputTokens).toBe(32);
    expect(Object.isFrozen(model.limits)).toBe(true);
  });

  it("does not call the provider or consume admission for an already aborted request", async () => {
    const complete = vi.fn<ModelPort["complete"]>().mockResolvedValue(response());
    const model = new TopologyLiveModel({ complete }, { ...defaults, maxRequests: 1 });
    const controller = new AbortController();
    const reason = new Error("Cancelled before live admission");
    controller.abort(reason);

    await expect(model.complete(request({ signal: controller.signal }))).rejects.toBe(reason);
    expect(complete).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(0);
    expect(model.uncertain).toBe(false);
    await expect(model.complete(request())).resolves.toMatchObject({ content: "Done." });
  });

  it("counts in-flight calls against the request cap", async () => {
    const pending = deferred<ModelResponse>();
    const complete = vi.fn<ModelPort["complete"]>().mockReturnValue(pending.promise);
    const model = new TopologyLiveModel({ complete }, { ...defaults, maxRequests: 1 });
    const admitted = model.complete(request());

    await expect(model.complete(request({ laneId: "team:review:member" })))
      .rejects.toThrow(/request cap/u);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(model.calls).toHaveLength(1);
    pending.resolve(response());
    await admitted;
    await expect(model.complete(request())).rejects.toThrow(/request cap/u);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("reserves concurrent cost before dispatch and releases it after settlement", async () => {
    const pending = deferred<ModelResponse>();
    const complete = vi.fn<ModelPort["complete"]>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(response());
    const model = new TopologyLiveModel({ complete }, { ...defaults, budgetUsd: 0.007 });
    const admitted = model.complete(request());

    await expect(model.complete(request({ laneId: "team:review:member" })))
      .rejects.toThrow(/concurrent cost reservation/u);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(model.calls).toHaveLength(1);
    expect(model.uncertain).toBe(false);

    pending.resolve(response());
    await admitted;
    await expect(model.complete(request({ laneId: "team:review:member" }))).resolves.toBeDefined();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(model.knownCostUsd).toBeCloseTo(0.002);
  });

  it("forwards the smaller output cap without changing the caller's request", async () => {
    const complete = vi.fn<ModelPort["complete"]>().mockResolvedValue(response());
    const model = new TopologyLiveModel({ complete }, { ...defaults, maxOutputTokens: 32 });
    const original = request({ maxOutputTokens: 256 });

    await model.complete(original);
    await model.complete(request({ maxOutputTokens: 16 }));

    expect(complete.mock.calls[0]?.[0].maxOutputTokens).toBe(32);
    expect(complete.mock.calls[1]?.[0].maxOutputTokens).toBe(16);
    expect(complete.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    expect(original.maxOutputTokens).toBe(256);
    expect(original.signal).toBeUndefined();
  });

  it("aggregates valid usage and records the actual lane and response", async () => {
    const first = response({ input: 11, output: 3, cacheRead: 5, cacheWrite: 7, costUsd: 0.001 });
    const second = response({ input: 13, output: 4, cacheRead: 6, cacheWrite: 8, costUsd: 0.002 });
    const complete = vi.fn<ModelPort["complete"]>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const model = new TopologyLiveModel({ complete }, defaults);
    const firstRequest = request({
      laneId: "team:review:evidence",
      messages: [{ role: "user", content: "Synthetic evidence only", createdAt: new Date(0).toISOString() }],
      tools: [{ name: "read_file", description: "Read fixture", parameters: { type: "object" } }],
    });

    expect(await model.complete(firstRequest)).toBe(first);
    expect(await model.complete(request())).toBe(second);

    expect(model.usage).toEqual({ input: 24, output: 7, cacheRead: 11, cacheWrite: 15 });
    expect(model.knownCostUsd).toBeCloseTo(0.003);
    expect(model.uncertain).toBe(false);
    expect(model.calls[0]).toMatchObject({
      runId: "offline-topology",
      laneId: "team:review:evidence",
      tools: ["read_file"],
      context: "Synthetic evidence only",
      response: first,
      startedAt: expect.any(Number),
      endedAt: expect.any(Number),
    });
    expect(model.calls[0]!.endedAt!).toBeGreaterThanOrEqual(model.calls[0]!.startedAt);
  });

  it("disables subsequent calls when provider cost is missing", async () => {
    const complete = vi.fn<ModelPort["complete"]>().mockResolvedValue(response({
      input: 10, output: 2, cacheRead: 0, cacheWrite: 0,
    }));
    const model = new TopologyLiveModel({ complete }, defaults);

    await expect(model.complete(request())).rejects.toThrow(/Missing provider cost/u);
    expect(model.uncertain).toBe(true);
    expect(model.knownCostUsd).toBe(0);
    expect(model.calls[0]).toMatchObject({ endedAt: expect.any(Number), error: expect.stringContaining("Missing provider cost") });
    await expect(model.complete(request())).rejects.toThrow(/uncertain provider cost/u);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("stops further provider calls after an ambiguous provider failure", async () => {
    const reason = new Error("Provider connection lost after dispatch");
    const complete = vi.fn<ModelPort["complete"]>().mockRejectedValue(reason);
    const model = new TopologyLiveModel({ complete }, defaults);

    await expect(model.complete(request())).rejects.toBe(reason);
    expect(model.uncertain).toBe(true);
    expect(model.calls[0]).toMatchObject({ error: reason.message, endedAt: expect.any(Number) });
    await expect(model.complete(request())).rejects.toThrow(/uncertain provider cost/u);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("ends the caller's wait even when a provider ignores the deadline signal", async () => {
    vi.useFakeTimers();
    try {
      const complete = vi.fn<ModelPort["complete"]>().mockReturnValue(new Promise(() => {}));
      const model = new TopologyLiveModel({ complete }, { ...defaults, timeoutMs: 5 });
      const settled = expect(model.complete(request())).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(5);
      await settled;
      expect(model.uncertain).toBe(true);
      expect(model.calls[0]?.endedAt).toBeDefined();
      expect(vi.getTimerCount()).toBe(0);
      await expect(model.complete(request())).rejects.toThrow(/uncertain provider cost/u);
      expect(complete).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears its deadline when the provider settles before timeout", async () => {
    vi.useFakeTimers();
    try {
      const complete = vi.fn<ModelPort["complete"]>().mockResolvedValue(response());
      const model = new TopologyLiveModel({ complete }, defaults);
      await model.complete(request());
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(defaults.timeoutMs);
      expect(model.uncertain).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { input: -1, output: 2, cacheRead: 0, cacheWrite: 0, costUsd: 0.001 },
    { input: 1, output: Number.NaN, cacheRead: 0, cacheWrite: 0, costUsd: 0.001 },
    { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0, costUsd: 0.001 },
    { input: 1, output: 2, cacheRead: 0, cacheWrite: -1, costUsd: 0.001 },
  ])("fails closed for invalid provider usage %j", async (usage) => {
    const complete = vi.fn<ModelPort["complete"]>().mockResolvedValue(response(usage));
    const model = new TopologyLiveModel({ complete }, defaults);

    await expect(model.complete(request())).rejects.toThrow(/Invalid provider usage/u);
    expect(model.uncertain).toBe(true);
    expect(model.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    await expect(model.complete(request())).rejects.toThrow(/uncertain provider cost/u);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it.each([
    { input: 1, output: 65, cacheRead: 0, cacheWrite: 0, costUsd: 0.001 },
    { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, costUsd: 0.101 },
  ])("stops when actual usage exceeds the output or dollar limit %j", async (usage) => {
    const complete = vi.fn<ModelPort["complete"]>().mockResolvedValue(response(usage));
    const model = new TopologyLiveModel({ complete }, defaults);

    await expect(model.complete(request())).rejects.toThrow(/exceeded the requested live budget/u);
    expect(model.uncertain).toBe(true);
    await expect(model.complete(request())).rejects.toThrow(/uncertain provider cost/u);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("rejects image input before provider admission", async () => {
    const complete = vi.fn<ModelPort["complete"]>().mockResolvedValue(response());
    const model = new TopologyLiveModel({ complete }, defaults);

    await expect(model.complete(request({ messages: [{
      role: "user", content: "Inspect this image", createdAt: new Date(0).toISOString(),
      images: [{ type: "image", mimeType: "image/png", data: "c3ludGhldGlj" }],
    }] }))).rejects.toThrow(/synthetic text only/u);
    expect(complete).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(0);
    expect(model.uncertain).toBe(false);
  });

  it("bounds serialized input bytes, not just character count", async () => {
    const complete = vi.fn<ModelPort["complete"]>().mockResolvedValue(response());
    const model = new TopologyLiveModel({ complete }, defaults);

    await expect(model.complete(request({ systemPrompt: "\u754c".repeat(54_000) })))
      .rejects.toThrow(/input byte cap/u);
    expect(complete).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(0);
    expect(model.uncertain).toBe(false);
  });
});
