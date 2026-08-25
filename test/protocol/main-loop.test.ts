import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentTool } from "../../src/domain/ports.js";
import {
  ContentStoreFukaiSource,
  FukaiContextProvider,
} from "../../src/fukai/index.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import { MainLoop } from "../../src/runtime/main-loop.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("MainLoop", () => {
  it("executes same-response tools concurrently and records natural boundaries", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    let started = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tool = (name: string): AgentTool => ({
      definition: {
        name,
        description: name,
        parameters: { type: "object", additionalProperties: false },
      },
      async execute() {
        started += 1;
        if (started === 2) {
          release?.();
        }
        await gate;
        return { content: `${name}-done`, isError: false };
      },
    });
    const model = new ScriptedModel([
      {
        content: "running checks",
        toolCalls: [
          { id: "call-a", name: "alpha", arguments: {} },
          { id: "call-b", name: "beta", arguments: {} },
        ],
        stopReason: "toolUse",
        usage: tokenUsage(20, 5),
      },
      {
        content: "all done",
        toolCalls: [],
        stopReason: "stop",
        usage: tokenUsage(25, 5),
      },
    ]);
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [tool("alpha"), tool("beta")],
      beforeStep: async ({ step }) => step === 1
        ? [{
            kind: "advice",
            source: "teto",
            content: "Check the simpler route",
            messageId: "advice-1",
          }]
        : [],
    });

    const result = await loop.run({
      runId: "run-main",
      goal: {
        version: 1,
        statement: "Complete the task",
        successCriteria: ["finished"],
        hardConstraints: [],
      },
      model: "openrouter:demo",
      workspace,
      policy: policy(4),
      initialMessage: "Please do it",
      contextBudget: { maxInputTokens: 4_000 },
    });

    expect(started).toBe(2);
    expect(result).toMatchObject({ finalText: "all done", steps: 2, completed: true });
    expect(result.usage).toEqual(tokenUsage(45, 10));
    expect(model.requests[0]?.messages.some((message) =>
      message.content.includes("Runtime advice")
      && message.content.includes("Check the simpler route"),
    )).toBe(true);
    expect(model.requests[1]?.messages.filter((message) => message.role === "tool")).toHaveLength(2);

    const events = await ledger.read({ runId: "run-main" });
    expect(events.filter((event) => event.type === "tool.requested")).toHaveLength(2);
    expect(events.filter((event) => event.type === "tool.succeeded")).toHaveLength(2);
    expect(events.filter((event) => event.type === "navigation.updated")).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("run.completed");
    expect(new Set(events.map((event) => event.correlationId)).size).toBe(1);
    expect(events.every((event) => event.idempotencyKey.length > 0)).toBe(true);
    const requestedTools = events.filter((event) => event.type === "tool.requested");
    const expectedOperationId = (toolCallId: string, toolName: string) => {
      const input = JSON.stringify({
        laneId: "main",
        runId: "run-main",
        step: 1,
        toolCallId,
        toolName,
      });
      return `op:${createHash("sha256").update(input).digest("hex")}`;
    };
    expect(requestedTools.map((event) => event.payload.operationId)).toEqual([
      expectedOperationId("call-a", "alpha"),
      expectedOperationId("call-b", "beta"),
    ]);
  });

  it("returns an incomplete checkpoint when the step limit is reached", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const previousMessage = await store.put(JSON.stringify({
      role: "user",
      content: "Original request",
      createdAt: "2026-01-01T00:00:00.000Z",
    }), "application/vnd.nausicaa.conversation-message+json");
    const model = new ScriptedModel([{
      content: "one more step",
      toolCalls: [{ id: "again", name: "noop", arguments: {} }],
      stopReason: "toolUse",
      usage: tokenUsage(5, 2),
    }]);
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [{
        definition: {
          name: "noop",
          description: "noop",
          parameters: { type: "object", additionalProperties: false },
        },
        async execute() {
          return { content: "ok", isError: false };
        },
      }],
    });

    const result = await loop.run({
      runId: "resume-run",
      goal: { version: 1, statement: "Continue", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(7),
      startStep: 7,
      conversationRefs: [{ ref: previousMessage, sequence: 1 }],
      contextBudget: { maxInputTokens: 2_000 },
    });

    expect(result.completed).toBe(false);
    expect(result.steps).toBe(1);
    const events = await ledger.read({ runId: "resume-run" });
    expect(events.find((event) => event.type === "step.started")?.payload).toEqual({ step: 7 });
    expect(events.some((event) => event.type === "user.message")).toBe(false);
    expect(model.requests[0]?.messages[0]?.content).toBe("Original request");
    expect(events.some((event) => event.type === "run.completed")).toBe(false);
  });

  it("does not mark a length-limited response complete", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const afterSteps: Array<{ usage: unknown; boundaryMessageIds: readonly string[] }> = [];
    const model = new ScriptedModel([{
      content: "partial",
      toolCalls: [],
      stopReason: "length",
      usage: tokenUsage(3, 4),
    }]);
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [],
      beforeStep: async () => [{
        kind: "advice",
        source: "teto",
        content: "stay focused",
        messageId: "advice-length",
      }],
      afterStep: ({ usage, boundaryMessageIds }) => {
        afterSteps.push({ usage, boundaryMessageIds });
      },
    });

    const result = await loop.run({
      runId: "length-run",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "Go",
      contextBudget: { maxInputTokens: 2_000 },
    });

    expect(result.completed).toBe(false);
    expect(result.navigationDeltas[0]?.status).toBe("uncertain");
    expect(afterSteps).toEqual([{
      usage: tokenUsage(3, 4),
      boundaryMessageIds: ["advice-length"],
    }]);
    const events = await ledger.read({ runId: "length-run" });
    expect(events.some((event) => event.type === "run.completed")).toBe(false);
    const requested = events.find((event) => event.type === "model.requested");
    expect(requested?.payload.contextWatermark).toBeGreaterThan(0);
    expect(requested?.payload.contextWatermark).toBeLessThan(requested?.globalOffset ?? 0);
  });
});

function policy(maxMainSteps: number) {
  return {
    maxMainSteps,
    maxModelTokens: 10_000,
    tetoEnabled: false,
    tetoMaxOutputTokens: 200,
    tetoTokenRatio: 0.1,
  };
}

function tokenUsage(input: number, output: number) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "nausicaa-main-"));
  temporaryDirectories.push(directory);
  return directory;
}
