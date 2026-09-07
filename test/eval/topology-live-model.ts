import type { ModelPort, ModelRequest, ModelResponse, TokenUsage } from "../../src/domain/index.js";
import { persistedErrorText } from "../../src/runtime/redaction.js";

export interface LiveCall {
  runId: string;
  laneId: string;
  startedAt: number;
  endedAt?: number;
  tools: string[];
  context: string;
  response?: ModelResponse;
  error?: string;
}

/** Live-only metering: concurrent reservations, with no changes to model decisions. */
export class TopologyLiveModel implements ModelPort {
  readonly calls: LiveCall[] = [];
  readonly usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  knownCostUsd = 0;
  uncertain = false;
  private reservedUsd = 0;

  constructor(
    private readonly delegate: ModelPort,
    readonly limits: {
      budgetUsd: number;
      maxRequests: number;
      maxOutputTokens: number;
      timeoutMs: number;
      inputPrice: number;
      outputPrice: number;
    },
  ) {
    for (const value of Object.values(limits)) {
      if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid live limit or price");
    }
    if (limits.budgetUsd > 0.85 || limits.maxRequests > 100
      || !Number.isInteger(limits.maxRequests) || !Number.isInteger(limits.maxOutputTokens)
      || limits.maxOutputTokens > 4096 || limits.timeoutMs > 120_000
      || !Number.isSafeInteger(limits.timeoutMs)) {
      throw new Error("Topology live limits exceed the bounded smoke allowance");
    }
    this.limits = Object.freeze({ ...limits });
  }

  capabilities(model: string) { return this.delegate.capabilities?.(model) ?? { imageInput: false }; }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    request.signal?.throwIfAborted();
    if (this.uncertain || this.calls.length >= this.limits.maxRequests) {
      throw new Error("Live request cap or uncertain provider cost prevents another request");
    }
    const maxOutputTokens = Math.min(request.maxOutputTokens, this.limits.maxOutputTokens);
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) throw new Error("Invalid output limit");
    if (request.messages.some((message) => "images" in message && message.images?.length)) {
      throw new Error("This topology smoke accepts synthetic text only");
    }
    const input = JSON.stringify({ system: request.systemPrompt, messages: request.messages, tools: request.tools });
    const inputBytes = Buffer.byteLength(input);
    if (inputBytes > 160_000) throw new Error("Live input byte cap reached");
    // Byte-count plus overhead is deliberately conservative, not a tokenizer or a billing guarantee.
    const reservation = ((inputBytes + 4096) * this.limits.inputPrice
      + maxOutputTokens * this.limits.outputPrice) / 1_000_000 * 1.25;
    if (this.knownCostUsd + this.reservedUsd + reservation > this.limits.budgetUsd) {
      throw new Error("Live concurrent cost reservation would exceed the configured budget");
    }
    this.reservedUsd += reservation;
    const call: LiveCall = {
      runId: request.runId, laneId: request.laneId ?? "main", startedAt: Date.now(),
      tools: request.tools.map((tool) => tool.name),
      context: request.messages.map((message) => message.content).join("\n"),
    };
    this.calls.push(call);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new DOMException("Live model request timed out", "TimeoutError")), this.limits.timeoutMs);
    const signal = AbortSignal.any([
      ...(request.signal === undefined ? [] : [request.signal]),
      deadline.signal,
    ]);
    let rejectOnAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectOnAbort = () => reject(signal.reason);
        if (signal.aborted) rejectOnAbort();
        else signal.addEventListener("abort", rejectOnAbort, { once: true });
      });
      signal.throwIfAborted();
      const response = await Promise.race([
        this.delegate.complete({ ...request, maxOutputTokens, signal }), aborted,
      ]);
      call.response = response;
      this.charge(response.usage, maxOutputTokens);
      return response;
    } catch (error) {
      this.uncertain = true;
      call.error = persistedErrorText(error);
      throw error;
    } finally {
      clearTimeout(timer);
      if (rejectOnAbort !== undefined) signal.removeEventListener("abort", rejectOnAbort);
      this.reservedUsd -= reservation;
      call.endedAt = Date.now();
    }
  }

  private charge(usage: TokenUsage, maxOutputTokens: number): void {
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      if (!Number.isSafeInteger(usage[key]) || usage[key] < 0) throw new Error("Invalid provider usage");
    }
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) this.usage[key] += usage[key];
    if (usage.costUsd === undefined || !Number.isFinite(usage.costUsd) || usage.costUsd < 0) {
      throw new Error("Missing provider cost; subsequent live requests are disabled");
    }
    this.knownCostUsd += usage.costUsd;
    if (usage.output > maxOutputTokens || this.knownCostUsd > this.limits.budgetUsd) {
      throw new Error("Provider exceeded the requested live budget");
    }
  }
}
