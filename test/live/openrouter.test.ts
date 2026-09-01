import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  AnyEvent,
  ModelPort,
  ModelRequest,
  ModelResponse,
} from "../../src/domain/index.js";
import { createOpenRouterModelPort } from "../../src/model/index.js";
import { projectRunMetrics } from "../../src/observability/index.js";
import { executeRun } from "../../src/runtime/index.js";

const apiKey = process.env.OPENROUTER_API_KEY;
const configuredModel = process.env.NAUSICAA_LIVE_MODEL
  ?? process.env.NAUSICAA_EVAL_MODEL;
const budgetUsd = Number(process.env.NAUSICAA_EVAL_BUDGET_USD);
const configuredVisionModel = process.env.NAUSICAA_VISION_MODEL;
const visionBudgetUsd = Number(process.env.NAUSICAA_VISION_BUDGET_USD);
// Keep the older comparison/vision probes opt-in. The beta command exercises
// one bounded Main tool loop; it must not silently spend the historical seven
// request Main-only/Main+Teto comparison budget.
const legacyLiveEnabled = process.env.NAUSICAA_LIVE_SCENARIO === "legacy";
const liveEnabled = legacyLiveEnabled
  && process.env.NAUSICAA_LIVE_TESTS === "1"
  && apiKey !== undefined
  && apiKey.trim().length > 0
  && configuredModel !== undefined
  && configuredModel.trim().length > 0
  && Number.isFinite(budgetUsd)
  && budgetUsd > 0;
const visionLiveEnabled = legacyLiveEnabled
  && process.env.NAUSICAA_LIVE_TESTS === "1"
  && apiKey !== undefined
  && apiKey.trim().length > 0
  && configuredVisionModel !== undefined
  && configuredVisionModel.trim().length > 0
  && Number.isFinite(visionBudgetUsd)
  && visionBudgetUsd > 0;

const modelSelector = configuredModel ?? "disabled";
const model = modelSelector.startsWith("openrouter:")
  ? modelSelector
  : `openrouter:${modelSelector}`;
const visionModelSelector = configuredVisionModel ?? "disabled";
const visionModel = visionModelSelector.startsWith("openrouter:")
  ? visionModelSelector
  : `openrouter:${visionModelSelector}`;
const MAX_REQUESTS = 7;
const MAIN_OUTPUT_TOKENS = 128;
const TETO_OUTPUT_TOKENS = 16;
const RUN_TIMEOUT_MS = 45_000;
const TETO_SETTLE_TIMEOUT_MS = 25_000;
const RED_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGP4z8DwnxLMMGrAqAGjBgwXAwAwxP4QHCfkAAAAAABJRU5ErkJggg==";

describe.skipIf(!liveEnabled)("OpenRouter live harness acceptance", () => {
  it("runs a grounded tool loop and bounds the Main-only versus Teto comparison", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-live-"));
    const workspace = join(root, "workspace");
    const controllers: AbortController[] = [];
    await mkdir(workspace);
    await writeFile(
      join(workspace, "README.md"),
      "Install with npm install. Requires Node >=22.19. Run checks with npm test.\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({ engines: { node: ">=22.19" }, scripts: { test: "vitest run" } }),
      "utf8",
    );

    const budget = new LiveBudget(budgetUsd, MAX_REQUESTS);
    const liveModel = new CappedLiveModel(createOpenRouterModelPort(), budget);
    const task = [
      "Inspect this workspace using tools; do not infer file contents.",
      "In your first response, issue exactly one read_file call for OPTIONAL.md and no prose.",
      "OPTIONAL.md is deliberately absent; after that expected failure, issue exactly these three tool calls in parallel and no prose:",
      "list_files for '.', read_file for README.md, and read_file for package.json.",
      "Then answer one short line containing the install command, Node requirement, and test command.",
    ].join(" ");
    const goal = {
      version: 1,
      statement: "Report the fixture installation commands from workspace evidence.",
      successCriteria: ["Use list and read tool evidence"],
      hardConstraints: ["Do not write files"],
    };
    const mainOnlyEvents: AnyEvent[] = [];
    const withTetoEvents: AnyEvent[] = [];

    try {
      const mainOnlyController = new AbortController();
      controllers.push(mainOnlyController);
      const mainOnly = await executeRun({
        workspace,
        dataDir: join(root, "main-only-state"),
        model,
        message: task,
        goal,
        policy: {
          maxMainSteps: 3,
          maxModelTokens: 3_000,
          tetoEnabled: false,
        },
        signal: boundedSignal(mainOnlyController, RUN_TIMEOUT_MS),
      }, {
        mainModel: liveModel,
        createRunId: () => "live-main-only",
        onEvent: (event) => mainOnlyEvents.push(event),
      });

      const tetoController = new AbortController();
      controllers.push(tetoController);
      const withTeto = await executeRun({
        workspace,
        dataDir: join(root, "with-teto-state"),
        model,
        tetoModel: model,
        message: task,
        goal,
        policy: {
          maxMainSteps: 3,
          maxModelTokens: 3_000,
          tetoEnabled: true,
          tetoMaxOutputTokens: TETO_OUTPUT_TOKENS,
          // A short live fixture cannot accrue the production ratio before a pass.
          tetoTokenRatio: 0.49,
        },
        signal: boundedSignal(tetoController, RUN_TIMEOUT_MS),
      }, {
        mainModel: liveModel,
        tetoModel: liveModel,
        createRunId: () => "live-with-teto",
        onEvent: (event) => withTetoEvents.push(event),
      });

      await waitFor(
        () => hasTerminalTetoPass(withTetoEvents),
        TETO_SETTLE_TIMEOUT_MS,
        "Teto did not finish its bounded live pass",
      );
      await waitFor(
        () => pathIsMissing(join(withTeto.stateDir, "ledger.jsonl.lock")),
        2_000,
        "Teto Ledger writer did not close",
      );

      expect(mainOnly.completed).toBe(true);
      expect(withTeto.completed).toBe(true);
      expectGroundedAnswer(mainOnly.finalText);
      expectGroundedAnswer(withTeto.finalText);
      expectToolLoop(mainOnlyEvents, mainOnly.runId);
      expectToolLoop(withTetoEvents, withTeto.runId);

      const mainOnlyMetrics = projectRunMetrics(mainOnlyEvents, mainOnly.runId);
      const withTetoMetrics = projectRunMetrics(withTetoEvents, withTeto.runId);
      expect(mainOnlyMetrics.lanes.teto).toBeUndefined();
      expect(withTetoMetrics.lanes.teto?.tetoPasses).toBe(1);
      expect(liveModel.requests.filter((request) => request.laneId === "teto"))
        .toHaveLength(1);
      expect(liveModel.requests).toHaveLength(MAX_REQUESTS);
      expect(liveModel.requests.every((request) => request.maxOutputTokens <= (
        request.laneId === "teto" ? TETO_OUTPUT_TOKENS : MAIN_OUTPUT_TOKENS
      ))).toBe(true);

      const measuredCost = usageCost(mainOnlyMetrics.total.usage)
        + usageCost(withTetoMetrics.total.usage);
      expect(measuredCost).toBeCloseTo(budget.spentUsd, 8);
      expect(measuredCost).toBeLessThanOrEqual(budgetUsd);
    } finally {
      for (const controller of controllers) {
        controller.abort(new Error("Live test cleanup"));
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 100_000);
});

describe.skipIf(!visionLiveEnabled)("OpenRouter live vision acceptance", () => {
  it("sends one bounded pi-ai image request to an explicitly selected vision model", async () => {
    const budget = new LiveBudget(visionBudgetUsd, 1);
    const liveModel = new CappedLiveModel(createOpenRouterModelPort(), budget);

    const response = await liveModel.complete({
      runId: "live-vision",
      laneId: "main",
      sessionId: "live-vision:main",
      model: visionModel,
      systemPrompt: "Answer the image question directly and briefly.",
      messages: [{
        role: "user",
        content: "What is the dominant color of this image? Reply with the color name.",
        images: [{ type: "image", mimeType: "image/png", data: RED_PIXEL_PNG }],
        createdAt: new Date(0).toISOString(),
      }],
      tools: [],
      maxOutputTokens: 32,
      signal: AbortSignal.timeout(20_000),
    });

    expect(response.content).toMatch(/red/i);
    expect(liveModel.requests).toHaveLength(1);
    expect(budget.requests).toBe(1);
    expect(budget.spentUsd).toBeLessThanOrEqual(visionBudgetUsd);
  }, 30_000);
});

class LiveBudget {
  spentUsd = 0;
  requests = 0;

  constructor(
    readonly limitUsd: number,
    readonly maxRequests: number,
  ) {}

  beforeRequest(): void {
    if (this.requests >= this.maxRequests) {
      throw new Error(`Live request limit of ${this.maxRequests} was reached`);
    }
    if (this.spentUsd >= this.limitUsd) {
      throw new Error(`Live cost limit of $${this.limitUsd} was reached`);
    }
    this.requests += 1;
  }

  charge(response: ModelResponse): void {
    const cost = response.usage.costUsd;
    if (cost === undefined || !Number.isFinite(cost) || cost < 0) {
      throw new Error("OpenRouter did not return a finite non-negative cost");
    }
    this.spentUsd += cost;
    if (this.spentUsd > this.limitUsd) {
      throw new Error(`Live cost $${this.spentUsd} exceeded $${this.limitUsd}`);
    }
  }
}

class CappedLiveModel implements ModelPort {
  readonly requests: Array<Pick<ModelRequest, "runId" | "laneId" | "maxOutputTokens">> = [];
  private readonly mainCallsByRun = new Map<string, number>();
  private readonly tetoFinished = deferred<void>();

  constructor(
    private readonly delegate: ModelPort,
    private readonly budget: LiveBudget,
  ) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.laneId === "main") {
      const mainCalls = (this.mainCallsByRun.get(request.runId) ?? 0) + 1;
      this.mainCallsByRun.set(request.runId, mainCalls);
      if (request.runId === "live-with-teto" && mainCalls === 3) {
        await withTimeout(
          this.tetoFinished.promise,
          20_000,
          "Teto did not finish before the final Main comparison request",
        );
      }
    }
    this.budget.beforeRequest();
    const maxOutputTokens = Math.min(
      request.maxOutputTokens,
      request.laneId === "teto" ? TETO_OUTPUT_TOKENS : MAIN_OUTPUT_TOKENS,
    );
    this.requests.push({
      runId: request.runId,
      laneId: request.laneId,
      maxOutputTokens,
    });
    try {
      const response = await this.delegate.complete({
        ...request,
        maxOutputTokens,
        signal: request.signal === undefined
          ? AbortSignal.timeout(20_000)
          : AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]),
      });
      this.budget.charge(response);
      return response;
    } finally {
      if (request.laneId === "teto") {
        this.tetoFinished.resolve();
      }
    }
  }
}

function expectGroundedAnswer(answer: string): void {
  expect(answer).toMatch(/npm install/i);
  expect(answer).toMatch(/22\.19/);
  expect(answer).toMatch(/npm test/i);
}

function expectToolLoop(events: readonly AnyEvent[], runId: string): void {
  const runEvents = events.filter((event) => event.runId === runId);
  const succeeded = runEvents
    .filter((event) => event.type === "tool.succeeded")
    .map((event) => event.payload.name);
  const failed = runEvents
    .filter((event) => event.type === "tool.failed")
    .map((event) => event.payload.name);
  expect(succeeded).toContain("list_files");
  expect(succeeded).toContain("read_file");
  expect(failed).toContain("read_file");
}

function hasTerminalTetoPass(events: readonly AnyEvent[]): boolean {
  return events.some((event) =>
    event.laneId === "teto"
    && event.type === "lane.status"
    && (event.payload.status === "dormant" || event.payload.status === "failed"),
  );
}

function usageCost(usage: { costUsd?: number }): number {
  expect(usage.costUsd).toSatisfy((value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0,
  );
  return usage.costUsd ?? 0;
}

function boundedSignal(controller: AbortController, milliseconds: number): AbortSignal {
  return AbortSignal.any([controller.signal, AbortSignal.timeout(milliseconds)]);
}

async function pathIsMissing(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
