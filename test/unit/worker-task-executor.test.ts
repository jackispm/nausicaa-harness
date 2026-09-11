import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { A2AInbox } from "../../src/a2a/index.js";
import type {
  A2AMessage,
  AgentTool,
  ArtifactRef,
  Clock,
  Goal,
  ModelPort,
  ModelRequest,
  ModelResponse,
  TaskBudget,
} from "../../src/domain/index.js";
import { estimateUserImageTokens } from "../../src/domain/images.js";
import { DEFAULT_MAIN_REQUEST_TIMEOUT_MS } from "../../src/domain/types.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { sha256, stableJson } from "../../src/ledger/hash.js";
import { ScriptedModel } from "../../src/model/index.js";
import {
  RunTokenBudget,
  WorkerTaskExecutor,
  WorkerTaskTimeoutError,
} from "../../src/runtime/index.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";
import { createWorkspaceTools } from "../../src/tools/index.js";

const goal: Goal = {
  version: 1,
  statement: "Identify the installation command",
  successCriteria: ["Return the command with evidence"],
  hardConstraints: ["Do not modify files"],
};

function taskMessage(
  inputRefs: ArtifactRef[],
  budget: TaskBudget = {
    maxModelTokens: 500,
    maxWallClockMs: 5_000,
  },
): A2AMessage {
  return {
    messageId: "task-message-1",
    runId: "run-1",
    conversationId: "conversation-1",
    threadId: "thread-1",
    from: "main",
    to: "worker-1",
    createdAt: "2026-08-27T12:00:00.000Z",
    correlationId: "task-correlation-1",
    idempotencyKey: "task-send-1",
    visibility: "run",
    priority: 5,
    delivery: "next-step",
    payload: {
      type: "task.request",
      taskId: "task-1",
      goal,
      inputRefs,
      budget,
    },
  };
}

async function setup(
  model: ModelPort,
  input = "npm install",
  budget?: TaskBudget,
  runTokenBudget?: RunTokenBudget,
  options: {
    workspace?: string;
    tools?: readonly AgentTool[];
    signal?: AbortSignal;
    maxOutputTokens?: number;
  } = {},
) {
  const clock: Clock = {
    now: () => new Date("2026-08-27T12:00:00.000Z"),
  };
  const ledger = new MemoryLedger({ clock });
  const store = new MemoryContentAddressedStore();
  const inputRef = await store.put(input, "text/plain");
  const inbox = new A2AInbox({ sink: ledger, clock });
  await inbox.send(taskMessage([inputRef], budget));
  let idSequence = 0;
  const recoveryReads = { count: 0 };
  const executor = new WorkerTaskExecutor({
    inbox,
    eventSink: ledger,
    store,
    model,
    modelName: "scripted/worker",
    runId: "run-1",
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
    ...(runTokenBudget === undefined ? {} : { runTokenBudget }),
    workerLaneId: "worker-1",
    clock,
    createId: () => `fixed-id-${++idSequence}`,
    readWatermark: () => ledger.watermark(),
    readEvents: async () => {
      recoveryReads.count += 1;
      return ledger.read({ runId: "run-1" });
    },
  });
  return { ledger, store, inbox, executor, inputRef, recoveryReads };
}

describe("WorkerTaskExecutor", () => {
  it("finishes an unbounded task after more than two model turns, four tools and 2000 tokens", async () => {
    const readTool: AgentTool = {
      definition: { name: "read_file", description: "Read evidence", parameters: { type: "object" } },
      async execute() { return { content: "Evidence", isError: false }; },
    };
    const model = new ScriptedModel([
      ...Array.from({ length: 5 }, (_, index) => ({
        content: "",
        toolCalls: [{ id: `read-${index}`, name: "read_file", arguments: {} }],
        stopReason: "tool_calls" as const,
        usage: { input: 600, output: 200, cacheRead: 0, cacheWrite: 0 },
      })),
      {
        content: "Complete report with all five evidence sources",
        toolCalls: [],
        stopReason: "stop" as const,
        usage: { input: 600, output: 200, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
    const { executor, ledger, inbox } = await setup(model, "input", {}, undefined, { tools: [readTool] });

    await expect(executor.runOnce()).resolves.toMatchObject({
      status: "completed",
      usage: { input: 3_600, output: 1_200 },
    });
    expect(model.requests).toHaveLength(6);
    expect(model.requests.every((request) => request.maxOutputTokens === 8_192)).toBe(true);
    const events = await ledger.read({ runId: "run-1" });
    expect(events.filter((event) => event.type === "tool.succeeded")).toHaveLength(5);
    expect(events.filter((event) => event.type === "budget.charged")).toHaveLength(6);
    const result = inbox.snapshot().records.find((record) => record.message.payload.type === "task.result");
    expect(result?.message.payload).toMatchObject({ status: "completed", openQuestions: [] });
  });

  it("still times out one stalled model request without imposing a task deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let notifyStarted!: () => void;
      const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
      let signal: AbortSignal | undefined;
      const model: ModelPort = {
        async complete(request) {
          signal = request.signal;
          notifyStarted();
          return new Promise<ModelResponse>(() => {});
        },
      };
      const { executor, inbox } = await setup(model, "input", {});
      const running = executor.runOnce();
      await started;
      await vi.advanceTimersByTimeAsync(DEFAULT_MAIN_REQUEST_TIMEOUT_MS);

      await expect(running).resolves.toMatchObject({ status: "failed", reason: "Worker model request timed out" });
      expect(signal?.aborted).toBe(true);
      expect(inbox.snapshot().records.find((record) => record.message.payload.type === "task.failed")?.message.payload)
        .toMatchObject({ retryable: true });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors a host per-request output limit while accounting larger cumulative usage", async () => {
    const model = new ScriptedModel([{
      content: "Complete report",
      toolCalls: [],
      stopReason: "stop",
      usage: { input: 3_000, output: 700, cacheRead: 0, cacheWrite: 0 },
    }]);
    const { executor } = await setup(model, "input", {}, undefined, { maxOutputTokens: 1_024 });
    await expect(executor.runOnce()).resolves.toMatchObject({ status: "completed", usage: { input: 3_000, output: 700 } });
    expect(model.requests[0]?.maxOutputTokens).toBe(1_024);
  });

  it("renews the request timeout while a healthy task runs beyond five minutes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let calls = 0;
      const model: ModelPort = {
        async complete() {
          calls += 1;
          await new Promise<void>((resolve) => setTimeout(resolve, 3 * 60 * 1_000));
          return {
            content: calls === 1 ? "" : "Finished the long task",
            toolCalls: calls === 1 ? [{ id: "read", name: "read_file", arguments: {} }] : [],
            stopReason: "stop",
            usage: { input: 1_200, output: 200, cacheRead: 0, cacheWrite: 0 },
          };
        },
      };
      const tools: AgentTool[] = [{
        definition: { name: "read_file", description: "Read evidence", parameters: { type: "object" } },
        async execute() { return { content: "Evidence", isError: false }; },
      }];
      const { executor } = await setup(model, "input", {}, undefined, { tools });
      const running = executor.runOnce();
      await vi.advanceTimersByTimeAsync(6 * 60 * 1_000);

      await expect(running).resolves.toMatchObject({ status: "completed", usage: { input: 2_400, output: 400 } });
      expect(calls).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("admits Worker with a shared Run budget, narrows output, and settles actual usage", async () => {
    const runTokenBudget = new RunTokenBudget(400);
    const model = new ScriptedModel([{
      content: "Bounded result",
      toolCalls: [],
      stopReason: "stop",
      usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
    }]);
    const { executor, ledger } = await setup(model, "input", {
      maxModelTokens: 1_000,
      maxWallClockMs: 5_000,
    }, runTokenBudget);

    await expect(executor.runOnce()).resolves.toMatchObject({ status: "completed" });
    expect(model.requests[0]?.maxOutputTokens).toBeGreaterThan(0);
    expect(model.requests[0]?.maxOutputTokens).toBeLessThan(400);
    expect(runTokenBudget.snapshot()).toMatchObject({
      usedTokens: 25,
      reservedTokens: 0,
      availableTokens: 375,
      settlements: [{
        id: "run-1:worker-1:task:task-1:attempt:1:provider",
        reservedTokens: 400,
        actualTokens: 25,
      }],
    });
    const eventTypes = (await ledger.read({ runId: "run-1" })).map((event) => event.type);
    expect(eventTypes.indexOf("budget.charged"))
      .toBeLessThan(eventTypes.indexOf("model.completed"));
  });

  it("fails only its task when the shared Run budget cannot fit Worker input", async () => {
    const runTokenBudget = new RunTokenBudget(1);
    const model = new ScriptedModel([{
      content: "must not run",
      toolCalls: [],
      stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    }]);
    const { executor, ledger } = await setup(model, "input", undefined, runTokenBudget);

    await expect(executor.runOnce()).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("run-budget-exhausted"),
    });
    expect(model.requests).toHaveLength(0);
    expect(runTokenBudget.snapshot()).toMatchObject({
      usedTokens: 0,
      reservedTokens: 0,
      availableTokens: 1,
    });
    expect((await ledger.read({ runId: "run-1" })).some((event) => (
      event.type === "model.requested"
    ))).toBe(false);
  });

  it("releases Worker's shared reservation when the provider fails", async () => {
    const runTokenBudget = new RunTokenBudget(400);
    const { executor } = await setup(
      new ScriptedModel([new Error("provider unavailable")]),
      "input",
      undefined,
      runTokenBudget,
    );

    await expect(executor.runOnce()).resolves.toMatchObject({
      status: "failed",
      reason: "provider unavailable",
    });
    expect(runTokenBudget.snapshot()).toMatchObject({
      usedTokens: 0,
      reservedTokens: 0,
      availableTokens: 400,
      settlements: [],
    });
  });

  it("executes one bounded handoff and returns artifact evidence", async () => {
    const model = new ScriptedModel([(_request: ModelRequest): ModelResponse => ({
      content: "Run `npm install`.",
      toolCalls: [],
      stopReason: "stop",
      usage: { input: 40, output: 8, cacheRead: 0, cacheWrite: 0 },
    })]);
    const { executor, inbox, ledger, inputRef, recoveryReads } = await setup(model);

    await expect(executor.runOnce()).resolves.toMatchObject({
      status: "completed",
      taskId: "task-1",
      requestMessageId: "task-message-1",
    });

    const records = inbox.snapshot().records;
    expect(records.find((record) => record.message.messageId === "task-message-1"))
      .toMatchObject({ status: "handled" });
    const replies = records
      .filter((record) => record.message.parentId === "task-message-1")
      .map((record) => record.message.payload.type);
    expect(replies).toEqual(["task.accept", "task.result"]);

    const events = await ledger.read({ runId: "run-1" });
    expect(events.map((event) => event.type)).toEqual([
      "message.sent",
      "message.claimed",
      "message.sent",
      "model.requested",
      "budget.charged",
      "model.completed",
      "assistant.message",
      "message.sent",
      "message.handled",
    ]);
    const request = model.requests[0]!;
    expect(request.messages[0]?.content).toContain(inputRef.contentHash);
    expect(request.messages[0]?.content).toContain("npm install");
    expect(request.messages[0]?.content).toContain("Workspace root:");
    expect(request.maxOutputTokens).toBe(500);
    expect(recoveryReads.count).toBe(0);
    await expect(executor.runOnce()).resolves.toEqual({ status: "idle" });
  });

  it("lets Worker gather workspace evidence through a bounded read-only tool loop", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nausicaa-worker-tools-"));
    try {
      await writeFile(join(workspace, "notes.md"), "Install with npm install.\n", "utf8");
      const tools = createWorkspaceTools({ allowWrite: false, allowShell: false });
      const model = new ScriptedModel([
        (request): ModelResponse => {
          expect(request.tools.map((tool) => tool.name)).toEqual([
            "read_file",
            "read_many",
            "list_files",
            "grep",
            "find",
            "file_info",
            "git_status",
            "git_log",
            "git_show",
            "git_diff",
          ]);
          return {
            content: "I will inspect the installation note.",
            toolCalls: [{
              id: "read-notes",
              name: "read_file",
              arguments: { path: "notes.md" },
            }],
            stopReason: "toolUse",
            usage: { input: 40, output: 8, cacheRead: 0, cacheWrite: 0 },
          };
        },
        (request): ModelResponse => {
          const toolMessage = request.messages.find((message) => message.role === "tool");
          expect(toolMessage?.content).toContain("npm install");
          expect(toolMessage?.toolName).toBe("read_file");
          return {
            content: "Use npm install.",
            toolCalls: [],
            stopReason: "stop",
            usage: { input: 70, output: 6, cacheRead: 0, cacheWrite: 0 },
          };
        },
      ]);
      const { executor, ledger } = await setup(
        model,
        "Find the installation command",
        undefined,
        undefined,
        { workspace, tools },
      );

      await expect(executor.runOnce()).resolves.toMatchObject({
        status: "completed",
        usage: { input: 110, output: 14 },
      });
      expect(model.requests).toHaveLength(2);
      expect(model.requests[1]?.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "tool",
      ]);
      const events = await ledger.read({ runId: "run-1" });
      expect(events.filter((event) => event.type === "tool.requested")).toHaveLength(1);
      expect(events.filter((event) => event.type === "tool.succeeded")).toHaveLength(1);
      expect(events.filter((event) => event.type === "tool.failed")).toHaveLength(0);
      expect(events.filter((event) => event.type === "model.requested")).toHaveLength(2);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("records a terminal tool fact before propagating lane cancellation", async () => {
    const controller = new AbortController();
    const cancellingTool: AgentTool = {
      definition: {
        name: "read_file",
        description: "Cancel after returning one settled read",
        parameters: { type: "object", additionalProperties: false },
      },
      async execute() {
        controller.abort(new Error("worker lane cancelled"));
        return { content: "settled before cancellation", isError: false };
      },
    };
    const model = new ScriptedModel([{
      content: "Read once",
      toolCalls: [{ id: "cancelled-read", name: "read_file", arguments: {} }],
      stopReason: "toolUse",
      usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
    }]);
    const { executor, ledger } = await setup(
      model,
      "Inspect evidence",
      { maxModelTokens: 1_000, maxWallClockMs: 5_000 },
      undefined,
      { tools: [cancellingTool], signal: controller.signal },
    );

    await expect(executor.runOnce()).resolves.toEqual({ status: "idle", reason: "stopped" });
    const events = await ledger.read({ runId: "run-1" });
    const requested = events.find((event) => event.type === "tool.requested");
    const terminalOperationIds = events.flatMap((event) => (
      event.type === "tool.succeeded" || event.type === "tool.failed"
        ? [event.payload.operationId]
        : []
    ));
    expect(requested?.type).toBe("tool.requested");
    expect(terminalOperationIds).toEqual([requested?.payload.operationId]);
  });

  it("charges tool-produced images against the next Worker context budget", async () => {
    const imageTool: AgentTool = {
      definition: {
        name: "read_image",
        description: "return a tiny image",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
      async execute() {
        return {
          content: "image evidence",
          isError: false,
          images: [{ type: "image", mimeType: "image/png", data: "AA==" }],
        };
      },
    };
    const model = new ScriptedModel([{
      content: "Inspecting the image.",
      toolCalls: [{ id: "image-call", name: "read_image", arguments: { path: "screen.png" } }],
      stopReason: "toolUse",
      usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
    }]);
    const runTokenBudget = new RunTokenBudget(500);
    const { executor, ledger } = await setup(
      model,
      "Inspect screen.png",
      { maxModelTokens: 2_000, maxWallClockMs: 5_000 },
      runTokenBudget,
      { tools: [imageTool] },
    );

    await expect(executor.runOnce()).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("run-budget-exhausted"),
    });
    expect(model.callCount).toBe(1);
    const events = await ledger.read({ runId: "run-1" });
    expect(events.filter((event) => event.type === "model.requested")).toHaveLength(1);
    expect(events.some((event) => event.type === "tool.succeeded")).toBe(true);
  });

  it("keeps a compliant tool image available to the next Worker request", async () => {
    const image = { type: "image" as const, mimeType: "image/png", data: "AA==" };
    const imageTool: AgentTool = {
      definition: {
        name: "read_image",
        description: "return one compliant image",
        parameters: { type: "object", additionalProperties: false },
      },
      async execute() {
        return { content: "image evidence", isError: false, images: [image] };
      },
    };
    const model = new ScriptedModel([
      {
        content: "Inspecting the image.",
        toolCalls: [{ id: "image-call", name: "read_image", arguments: {} }],
        stopReason: "toolUse",
        usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
      },
      (request): ModelResponse => {
        const result = request.messages.find((message) => message.role === "tool");
        expect(result?.images).toEqual([image]);
        expect(result?.content).not.toContain("IMAGE BLOCK");
        return {
          content: "The image is visible.",
          toolCalls: [],
          stopReason: "stop",
          usage: { input: 30, output: 5, cacheRead: 0, cacheWrite: 0 },
        };
      },
    ]);
    const { executor } = await setup(
      model,
      "Inspect the image",
      { maxModelTokens: 5_000, maxWallClockMs: 5_000 },
      new RunTokenBudget(5_000),
      { tools: [imageTool] },
    );

    await expect(executor.runOnce()).resolves.toMatchObject({ status: "completed" });
    expect(model.requests).toHaveLength(2);
  });

  it("omits tool images beyond the Worker task byte budget but retains durable evidence", async () => {
    const imageBytes = 2_560 * 1024;
    const image = {
      type: "image" as const,
      mimeType: "image/png",
      data: Buffer.alloc(imageBytes).toString("base64"),
    };
    const overflowImage = {
      type: "image" as const,
      mimeType: "image/png",
      data: "AA==",
    };
    const imageTool: AgentTool = {
      definition: {
        name: "read_image",
        description: "return compliant image batches",
        parameters: {
          type: "object",
          properties: { batch: { type: "boolean" } },
          required: ["batch"],
          additionalProperties: false,
        },
      },
      async execute(arguments_) {
        return arguments_.batch === true
          ? { content: "full image batch", isError: false, images: [image, image, image, image] }
          : { content: "overflow image", isError: false, images: [overflowImage] };
      },
    };
    const calls = [
      { id: "image-batch", name: "read_image", arguments: { batch: true } },
      { id: "image-overflow", name: "read_image", arguments: { batch: false } },
    ];
    const model = new ScriptedModel([
      {
        content: "Inspecting four images.",
        toolCalls: calls,
        stopReason: "toolUse",
        usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
      },
      (request): ModelResponse => {
        const results = request.messages.filter((message) => message.role === "tool");
        expect(results).toHaveLength(2);
        expect(results.map((message) => message.images?.length ?? 0)).toEqual([4, 0]);
        expect(results[1]?.content).toContain("1 IMAGE BLOCK OMITTED BY WORKER");
        return {
          content: "Compared the retained images.",
          toolCalls: [],
          stopReason: "stop",
          usage: { input: 30, output: 5, cacheRead: 0, cacheWrite: 0 },
        };
      },
    ]);
    const { executor, ledger, store } = await setup(
      model,
      "Inspect the images",
      { maxModelTokens: 30_000, maxWallClockMs: 10_000 },
      new RunTokenBudget(30_000),
      { tools: [imageTool] },
    );

    await expect(executor.runOnce()).resolves.toMatchObject({ status: "completed" });
    const succeeded = (await ledger.read({ runId: "run-1" }))
      .filter((event) => event.type === "tool.succeeded");
    expect(succeeded).toHaveLength(2);
    const durable = JSON.parse(new TextDecoder().decode(
      await store.get(succeeded[1]!.payload.resultRef),
    )) as { images?: unknown[] };
    expect(durable.images).toHaveLength(1);
  });

  it("estimates larger image blocks above the canonical per-image token floor", () => {
    const image = {
      type: "image" as const,
      mimeType: "image/png",
      data: Buffer.alloc(2 * 1024 * 1024).toString("base64"),
    };

    expect(estimateUserImageTokens([
      { type: "image", mimeType: "image/png", data: "AA==" },
    ])).toBe(1_024);
    expect(estimateUserImageTokens([image])).toBe(2_048);
  });

  it("rejects write and shell tools at the Worker boundary", async () => {
    const ledger = new MemoryLedger();
    const store = new MemoryContentAddressedStore();
    const inbox = new A2AInbox({ sink: ledger });
    const unsafeTools = createWorkspaceTools({ allowWrite: true, allowShell: true });

    expect(() => new WorkerTaskExecutor({
      inbox,
      eventSink: ledger,
      store,
      model: new ScriptedModel([]),
      modelName: "scripted/worker",
      runId: "run-1",
      tools: unsafeTools,
    })).toThrow(/not an allowed read-only tool/);
  });

  it("fails closed on recovery after a durable tool-call response", async () => {
    const model = new ScriptedModel([]);
    const { executor, inbox, ledger, store, inputRef } = await setup(model);
    await inbox.claim("worker-1", "worker-1", { claimId: "crashed-worker" });

    const responseRef = await store.put(
      stableJson({
        role: "assistant",
        content: "Inspecting the workspace.",
        toolCalls: [{
          id: "read-after-restart",
          name: "read_file",
          arguments: { path: "README.md" },
        }],
        createdAt: "2026-08-27T12:00:00.000Z",
      }),
      "application/vnd.nausicaa.conversation-message+json",
    );
    const prefix = "run-1:worker-1:task:task-1:attempt:1";
    await ledger.append({
      runId: "run-1",
      laneId: "worker-1",
      type: "model.requested",
      payload: {
        model: "scripted/worker",
        requestHash: "request-hash",
        contextWatermark: 2,
        sessionId: "run-1:worker-1:task:task-1",
        prefixHash: "prefix-hash",
        dependencyRefs: [inputRef.contentHash],
        contextBuildMs: 0,
      },
      correlationId: "task-correlation-1",
      idempotencyKey: `${prefix}:model:requested`,
      visibility: "run",
    });
    await ledger.append({
      runId: "run-1",
      laneId: "worker-1",
      type: "model.completed",
      payload: {
        model: "scripted/worker",
        responseRef,
        stopReason: "toolUse",
        usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
      },
      correlationId: "task-correlation-1",
      idempotencyKey: `${prefix}:model:completed`,
      visibility: "run",
    });

    const recoveryClock: Clock = {
      now: () => new Date("2026-08-27T12:01:00.000Z"),
    };
    const recoveredInbox = A2AInbox.rehydrate(await ledger.read({ runId: "run-1" }), {
      sink: ledger,
      clock: recoveryClock,
    });
    const recoveryModel = new ScriptedModel([]);
    const recoveryExecutor = new WorkerTaskExecutor({
      inbox: recoveredInbox,
      eventSink: ledger,
      store,
      model: recoveryModel,
      modelName: "scripted/worker",
      runId: "run-1",
      workerLaneId: "worker-1",
      clock: recoveryClock,
      readWatermark: () => ledger.watermark(),
      readEvents: () => ledger.read({ runId: "run-1" }),
    });

    await expect(recoveryExecutor.runOnce()).resolves.toMatchObject({
      status: "failed",
      taskId: "task-1",
      reason: expect.stringContaining("tool-loop recovery is unavailable"),
    });
    expect(recoveryModel.requests).toHaveLength(0);
    expect(recoveredInbox.snapshot().records.map((record) => record.message.payload.type))
      .toEqual(["task.request", "task.accept", "task.failed"]);
    expect(recoveredInbox.snapshot().records[0]?.status).toBe("handled");

    // Keep the original executor reference live long enough for its test-owned
    // resources to be unambiguous; it must never claim the recovered task.
    await expect(executor.runOnce()).resolves.toEqual({ status: "idle" });
  });

  it("records but does not execute tool calls truncated by the model output limit", async () => {
    let executions = 0;
    const readTool: AgentTool = {
      definition: {
        name: "read_file",
        description: "read",
        parameters: { type: "object" },
      },
      async execute() {
        executions += 1;
        return { content: "must not execute", isError: false };
      },
    };
    const model = new ScriptedModel([{
      content: "The tool call was cut off.",
      toolCalls: [{ id: "truncated-read", name: "read_file", arguments: { path: "x" } }],
      stopReason: "length",
      usage: { input: 30, output: 512, cacheRead: 0, cacheWrite: 0 },
    }]);
    const { executor, inbox, ledger } = await setup(
      model,
      "Inspect the file",
      { maxModelTokens: 1_000, maxWallClockMs: 5_000 },
      undefined,
      { tools: [readTool] },
    );

    await expect(executor.runOnce()).resolves.toMatchObject({
      status: "partial",
      taskId: "task-1",
    });
    expect(executions).toBe(0);
    const events = await ledger.read({ runId: "run-1" });
    expect(events.filter((event) => event.type === "tool.requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool.failed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool.succeeded")).toHaveLength(0);
    expect(inbox.snapshot().records.some((record) => (
      record.message.payload.type === "task.result"
      && record.message.payload.status === "partial"
    ))).toBe(true);
  });

  it("rejects malformed tool calls before billing or persistence", async () => {
    const runTokenBudget = new RunTokenBudget(600);
    const model = new ScriptedModel([{
      content: "invalid duplicate calls",
      toolCalls: [
        { id: "duplicate", name: "read_file", arguments: { path: "a" } },
        { id: "duplicate", name: "read_file", arguments: { path: "b" } },
      ],
      stopReason: "toolUse",
      usage: { input: 30, output: 5, cacheRead: 0, cacheWrite: 0 },
    }]);
    const { executor, ledger } = await setup(
      model,
      "Inspect evidence",
      { maxModelTokens: 1_000, maxWallClockMs: 5_000 },
      runTokenBudget,
      { tools: [createWorkspaceTools()[0]!] },
    );

    await expect(executor.runOnce()).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("Duplicate tool call id"),
    });
    expect(runTokenBudget.snapshot()).toMatchObject({
      usedTokens: 0,
      reservedTokens: 0,
      availableTokens: 600,
    });
    const events = await ledger.read({ runId: "run-1" });
    expect(events.filter((event) => event.type === "budget.charged")).toHaveLength(0);
    expect(events.filter((event) => event.type === "model.failed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "model.completed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "tool.requested")).toHaveLength(0);
  });

  it("returns task.failed when reported usage exceeds the task token budget", async () => {
    const model = new ScriptedModel([{
      content: "Too much output",
      toolCalls: [],
      stopReason: "stop",
      usage: { input: 8, output: 4, cacheRead: 0, cacheWrite: 0 },
    }]);
    const { executor, inbox } = await setup(model, "input", {
      maxModelTokens: 10,
      maxWallClockMs: 5_000,
    });

    await expect(executor.runOnce()).resolves.toMatchObject({
      status: "failed",
      taskId: "task-1",
      reason: expect.stringContaining("token budget exceeded"),
    });
    expect(inbox.snapshot().records.map((record) => record.message.payload.type))
      .toEqual(["task.request", "task.accept", "task.failed"]);
    const failure = inbox.snapshot().records.find((record) => (
      record.message.payload.type === "task.failed"
    ));
    expect(failure?.message.payload).toMatchObject({
      taskId: "task-1",
      retryable: false,
    });
  });

  it("caps one Worker response independently from the cumulative task token budget", async () => {
    const model = new ScriptedModel([{
      content: "Bounded result",
      toolCalls: [],
      stopReason: "stop",
      usage: { input: 600, output: 300, cacheRead: 0, cacheWrite: 0 },
    }]);
    const { executor, ledger } = await setup(model, "input", {
      maxModelTokens: 1_000,
      maxWallClockMs: 5_000,
    });

    await expect(executor.runOnce()).resolves.toMatchObject({
      status: "completed",
      usage: { input: 600, output: 300 },
    });
    const request = model.requests[0]!;
    expect(request.maxOutputTokens).toBe(512);
    const requested = (await ledger.read({ runId: "run-1" })).find((event) => (
      event.type === "model.requested"
    ));
    expect(requested?.payload.requestHash).toBe(sha256(stableJson({
      model: request.model,
      sessionId: request.sessionId,
      systemPrompt: request.systemPrompt,
      messages: request.messages,
      tools: request.tools,
      maxOutputTokens: 512,
    })));
  });

  it("fails a task when the wall-clock budget expires", async () => {
    class SlowModel implements ModelPort {
      async complete(request: ModelRequest): Promise<ModelResponse> {
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (request.signal?.aborted) {
          throw request.signal.reason instanceof Error
            ? request.signal.reason
            : new WorkerTaskTimeoutError("aborted");
        }
        return {
          content: "late",
          toolCalls: [],
          stopReason: "stop",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        };
      }
    }
    const { executor, inbox } = await setup(new SlowModel(), "input", {
      maxModelTokens: 100,
      maxWallClockMs: 5,
    });

    await expect(executor.runOnce()).resolves.toMatchObject({
      status: "failed",
      taskId: "task-1",
      reason: expect.stringContaining("wall-clock budget"),
    });
    const failure = inbox.snapshot().records.find((record) => (
      record.message.payload.type === "task.failed"
    ));
    expect(failure?.message.payload).toMatchObject({
      taskId: "task-1",
      retryable: true,
    });
  });

  it.each([{}, { maxModelTokens: 100, maxWallClockMs: 5_000 }])("cancels an in-flight model on stop and ignores its late response: %j", async (budget) => {
    let resolveModel: ((response: ModelResponse) => void) | undefined;
    const model: ModelPort = {
      complete: async () => new Promise<ModelResponse>((resolve) => {
        resolveModel = resolve;
      }),
    };
    const runTokenBudget = new RunTokenBudget(400);
    const { executor, inbox, ledger } = await setup(model, "input", budget, runTokenBudget);

    const running = executor.runOnce();
    for (let attempt = 0; attempt < 20 && resolveModel === undefined; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(resolveModel).toBeTypeOf("function");

    await expect(executor.stop()).resolves.toBeUndefined();
    await expect(running).resolves.toEqual({ status: "idle", reason: "stopped" });
    const beforeLateResponse = await ledger.read({ runId: "run-1" });
    expect(beforeLateResponse.map((event) => event.type)).toEqual([
      "message.sent",
      "message.claimed",
      "message.sent",
      "model.requested",
    ]);
    expect(inbox.snapshot().records.some((record) => (
      record.message.payload.type === "task.result"
        || record.message.payload.type === "task.failed"
    ))).toBe(false);

    resolveModel?.({
      content: "late response",
      toolCalls: [],
      stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await ledger.read({ runId: "run-1" })).toEqual(beforeLateResponse);
    expect(inbox.snapshot().records[0]?.status).toBe("claimed");
    expect(runTokenBudget.snapshot()).toMatchObject({
      usedTokens: 0,
      reservedTokens: 0,
      availableTokens: 400,
    });
    await expect(executor.runOnce()).resolves.toEqual({ status: "idle", reason: "stopped" });
  });

  it("serializes concurrent runOnce calls on the Worker lane", async () => {
    let active = 0;
    let maximum = 0;
    const model: ModelPort = {
      complete: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active -= 1;
        return {
          content: "done",
          toolCalls: [],
          stopReason: "stop",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        };
      },
    };
    const { executor, inbox } = await setup(model);
    const second = taskMessage([]);
    second.messageId = "task-message-2";
    second.idempotencyKey = "task-send-2";
    if (second.payload.type !== "task.request") throw new Error("expected task request");
    second.payload.taskId = "task-2";
    await inbox.send(second);
    const results = await Promise.all([executor.runOnce(), executor.runOnce()]);
    expect(results.map((result) => result.status)).toEqual(["completed", "completed"]);
    expect(maximum).toBe(1);
    const requests = inbox.snapshot().records.filter((record) => (
      record.message.payload.type === "task.request"
    ));
    expect(requests.map((record) => record.status)).toEqual(["handled", "handled"]);
  });
});
