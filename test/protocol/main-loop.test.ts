import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type {
  AgentTool,
  ModelPort,
  ModelResponse,
} from "../../src/domain/ports.js";
import type { Goal } from "../../src/domain/types.js";
import { FUKAI_COMPACTION_MEDIA_TYPE } from "../../src/domain/context.js";
import {
  ContentStoreFukaiSource,
  FukaiContextProvider,
} from "../../src/fukai/index.js";
import type {
  FukaiCompactionSelection,
  MainContextProvider,
} from "../../src/fukai/types.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import {
  MoweCatalog,
  MoweExecutor,
  type MoweAgentTool,
} from "../../src/mowe/index.js";
import {
  MainLoop,
  MainRunTokenBudgetExhaustedError,
  UNKNOWN_MODEL_REQUEST_INPUT_FALLBACK_TOKENS,
  type MainStreamEvent,
} from "../../src/runtime/main-loop.js";
import { projectMainExecutionRecovery } from "../../src/runtime/recovery.js";
import { RunTokenBudget } from "../../src/runtime/run-token-budget.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";
import { createGrepTool } from "../../src/tools/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("MainLoop", () => {
  it("keeps model request capacity independent from the cumulative Run budget", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const observedInputBudgets: number[] = [];
    const scripted = new ScriptedModel([{
      content: "done",
      toolCalls: [],
      stopReason: "stop",
      usage: tokenUsage(10, 5),
    }]);
    const model = modelWithContextWindows(scripted, { demo: 20_000 });
    const provider = recordingContextProvider(store, observedInputBudgets);
    const loop = new MainLoop({
      model,
      runTokenBudget: new RunTokenBudget(500),
      contextProvider: provider,
      conversationStore: store,
      eventSink: new MemoryLedger(),
      tools: [],
    });

    await loop.run({
      runId: "main-request-window-independent",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: { ...policy(1), maxModelTokens: 500 },
      initialMessage: "Go",
      maxOutputTokens: 2_000,
    });

    expect(observedInputBudgets).toEqual([18_000]);
    expect(scripted.requests[0]?.maxOutputTokens).toBeLessThan(500);
  });

  it("recomputes request input capacity when the selected model changes", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const observedInputBudgets: number[] = [];
    const scripted = new ScriptedModel([{
      content: "inspect",
      toolCalls: [{ id: "switch-noop", name: "noop", arguments: {} }],
      stopReason: "toolUse",
      usage: tokenUsage(10, 5),
    }, {
      content: "done",
      toolCalls: [],
      stopReason: "stop",
      usage: tokenUsage(10, 5),
    }]);
    let selector = "small";
    const loop = new MainLoop({
      model: modelWithContextWindows(scripted, { small: 12_000, large: 40_000 }),
      resolveModel: () => selector,
      contextProvider: recordingContextProvider(store, observedInputBudgets),
      conversationStore: store,
      eventSink: new MemoryLedger(),
      tools: [noopToolForMainTest],
      afterStep: () => { selector = "large"; },
    });

    await loop.run({
      runId: "main-request-window-switch",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "small",
      workspace,
      policy: policy(2),
      initialMessage: "Go",
      maxOutputTokens: 2_000,
    });

    expect(observedInputBudgets).toEqual([10_000, 38_000]);
    expect(scripted.requests.map((request) => request.model)).toEqual(["small", "large"]);
  });

  it("freezes model capabilities once for context and pressure at each boundary", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const scripted = new ScriptedModel([{
      content: "done",
      toolCalls: [],
      stopReason: "stop",
      usage: tokenUsage(10, 5),
    }]);
    let capabilityCalls = 0;
    const pressureCapacities: Array<{
      contextWindowTokens: number | undefined;
      inputCapacityTokens: number;
    }> = [];
    const model: ModelPort = {
      capabilities() {
        capabilityCalls += 1;
        return {
          imageInput: false,
          contextWindowTokens: capabilityCalls === 1 ? 12_000 : 40_000,
        };
      },
      complete: scripted.complete.bind(scripted),
    };
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: new MemoryLedger(),
      tools: [],
      compactForPressure: async (context) => {
        pressureCapacities.push({
          contextWindowTokens: context.contextWindowTokens,
          inputCapacityTokens: context.inputCapacityTokens,
        });
        return undefined;
      },
    });

    await loop.run({
      runId: "main-request-capability-freeze",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "Go",
      maxOutputTokens: 2_000,
    });

    expect(capabilityCalls).toBe(1);
    expect(pressureCapacities).toEqual([{
      contextWindowTokens: 12_000,
      inputCapacityTokens: 10_000,
    }]);
  });

  it("uses the conservative request fallback for invalid context metadata", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const observedInputBudgets: number[] = [];
    const scripted = new ScriptedModel([{
      content: "done",
      toolCalls: [],
      stopReason: "stop",
      usage: tokenUsage(10, 5),
    }]);
    const model: ModelPort = {
      capabilities: () => ({ imageInput: false, contextWindowTokens: 0 }),
      complete: scripted.complete.bind(scripted),
    };
    const loop = new MainLoop({
      model,
      contextProvider: recordingContextProvider(store, observedInputBudgets),
      conversationStore: store,
      eventSink: new MemoryLedger(),
      tools: [],
    });

    await loop.run({
      runId: "main-request-invalid-window-fallback",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "Go",
      maxOutputTokens: 2_000,
    });

    expect(observedInputBudgets).toEqual([UNKNOWN_MODEL_REQUEST_INPUT_FALLBACK_TOKENS]);
  });

  it("rejects a model window that cannot retain one input token after output reservation", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const scripted = new ScriptedModel([{
      content: "must not run",
      toolCalls: [],
      stopReason: "stop",
      usage: tokenUsage(1, 1),
    }]);
    const loop = new MainLoop({
      model: modelWithContextWindows(scripted, { demo: 2_000 }),
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: new MemoryLedger(),
      tools: [],
    });

    await expect(loop.run({
      runId: "main-request-output-reservation-boundary",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "Go",
      maxOutputTokens: 2_000,
    })).rejects.toThrow("Model context window must exceed the 2000 token output reservation");
    expect(scripted.callCount).toBe(0);
  });

  it("uses an explicit input budget only to tighten model request capacity", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const observedInputBudgets: number[] = [];
    const scripted = new ScriptedModel(Array.from({ length: 2 }, () => ({
      content: "done",
      toolCalls: [],
      stopReason: "stop",
      usage: tokenUsage(10, 5),
    })));
    const loop = new MainLoop({
      model: modelWithContextWindows(scripted, { demo: 20_000 }),
      contextProvider: recordingContextProvider(store, observedInputBudgets),
      conversationStore: store,
      eventSink: new MemoryLedger(),
      tools: [],
    });

    await loop.run({
      runId: "main-request-explicit-input-tight",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "Go",
      maxOutputTokens: 2_000,
      contextBudget: { maxInputTokens: 6_000 },
    });
    await loop.run({
      runId: "main-request-explicit-input-cap",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "Go",
      maxOutputTokens: 2_000,
      contextBudget: { maxInputTokens: 50_000 },
    });

    expect(observedInputBudgets).toEqual([6_000, 18_000]);
  });

  it("rejects an invalid explicit input budget instead of silently clamping it", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const scripted = new ScriptedModel([{
      content: "must not run",
      toolCalls: [],
      stopReason: "stop",
      usage: tokenUsage(1, 1),
    }]);
    const loop = new MainLoop({
      model: modelWithContextWindows(scripted, { demo: 20_000 }),
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: new MemoryLedger(),
      tools: [],
    });

    await expect(loop.run({
      runId: "main-request-invalid-explicit-input",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "Go",
      maxOutputTokens: 2_000,
      contextBudget: { maxInputTokens: Number.POSITIVE_INFINITY },
    })).rejects.toThrow("contextBudget.maxInputTokens must be a non-negative integer");
    expect(scripted.callCount).toBe(0);
  });

  it("reloads trusted project instructions at every request and records CAS identity", async () => {
    const workspace = await temporaryDirectory();
    const instructionPath = path.join(workspace, "AGENTS.md");
    await writeFile(instructionPath, "Use the first project rule.\n");
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const model = new ScriptedModel([
      {
        content: "refresh instructions",
        toolCalls: [{ id: "refresh", name: "refresh_instructions", arguments: {} }],
        stopReason: "toolUse",
        usage: tokenUsage(10, 5),
      },
      {
        content: "done",
        toolCalls: [],
        stopReason: "stop",
        usage: tokenUsage(10, 5),
      },
    ]);
    const refreshInstructions: AgentTool = {
      definition: {
        name: "refresh_instructions",
        description: "Replace the project instruction fixture",
        parameters: { type: "object", additionalProperties: false },
      },
      async execute() {
        await writeFile(instructionPath, "Use the second project rule.\n");
        return { content: "updated", isError: false };
      },
    };
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [refreshInstructions],
    });

    await loop.run({
      runId: "main-project-instructions",
      goal: { version: 1, statement: "Follow project rules", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(2),
      initialMessage: "Go",
    });

    expect(model.requests).toHaveLength(2);
    expect(model.requests[0]?.systemPrompt).toContain("Trusted project instructions");
    expect(model.requests[0]?.systemPrompt).toContain("Use the first project rule.");
    expect(model.requests[1]?.systemPrompt).toContain("Use the second project rule.");
    expect(model.requests[1]?.systemPrompt).not.toContain("Use the first project rule.");

    const requested = (await ledger.read({ runId: "main-project-instructions" }))
      .filter((event) => event.type === "model.requested");
    const first = requested[0]?.payload.contextManifest?.projectInstructions;
    const second = requested[1]?.payload.contextManifest?.projectInstructions;
    expect(first?.state).toBe("present");
    expect(first?.sourceHash).toBe(second?.sourceHash);
    expect(first?.contentHash).not.toBe(second?.contentHash);
    expect(first?.bundleRef?.contentHash).not.toBe(second?.bundleRef?.contentHash);
    expect(requested[0]?.payload.prefixHash).not.toBe(requested[1]?.payload.prefixHash);
    expect(JSON.stringify(first)).not.toContain("Use the first project rule.");
    if (first?.bundleRef === undefined) throw new Error("Missing project instruction bundle");
    const bundle = Buffer.from(await store.get(first.bundleRef)).toString("utf8");
    expect(bundle).toContain("Use the first project rule.");
    expect(requested[0]?.payload.dependencyRefs).toContain(
      `${first.bundleRef.id}@${first.bundleRef.contentHash}`,
    );
  });

  it("keeps tool steps quiet until evidence is ready in the latest user language", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const model = new ScriptedModel([{
      content: "完成",
      toolCalls: [],
      stopReason: "stop",
      usage: tokenUsage(10, 5),
    }]);
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: new MemoryLedger(),
      tools: [],
    });

    await loop.run({
      runId: "main-language-continuity",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "查看最新提交",
    });

    const prompt = model.requests[0]?.systemPrompt ?? "";
    expect(prompt).toContain("Match all user-visible progress and final answers");
    expect(prompt).toContain("language of the latest user message");
    expect(prompt).toContain("tool output and context language do not change it");
    expect(prompt).toContain("Tool steps emit only tools");
    expect(prompt).toContain("answer after evidence is complete");
    expect(prompt).toContain("except for an immediate risk or blocker");
  });

  it("keeps evidence guidance aligned with the visible grep schema", async () => {
    const workspace = await temporaryDirectory();
    const goal = { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] };
    const run = async (tools: readonly AgentTool[], runId: string): Promise<string> => {
      const model = new ScriptedModel([{
        content: "done",
        toolCalls: [],
        stopReason: "stop",
        usage: tokenUsage(1, 1),
      }]);
      const store = new MemoryContentAddressedStore();
      const loop = new MainLoop({
        model,
        contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
        conversationStore: store,
        eventSink: new MemoryLedger(),
        tools,
      });
      await loop.run({
        runId,
        goal,
        model: "demo",
        workspace,
        policy: policy(1),
        initialMessage: "Inspect the repository",
      });
      return model.requests[0]?.systemPrompt ?? "";
    };

    await expect(run([createGrepTool()], "grep-files-prompt"))
      .resolves.toContain("outputMode=files");
    await expect(run([createGrepTool({}, { pagination: "legacy" })], "grep-legacy-prompt"))
      .resolves.not.toContain("outputMode=files");
  });

  it("rejects malformed tool arguments before recording a tool operation", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const model = new ScriptedModel([{
      content: "invalid call",
      toolCalls: [{
        id: "bad-arguments",
        name: "noop",
        arguments: null as unknown as Record<string, unknown>,
      }],
      stopReason: "toolUse",
      usage: tokenUsage(10, 5),
    }]);
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [],
    });

    await expect(loop.run({
      runId: "malformed-tool-arguments",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "Go",
    })).rejects.toThrow(/arguments must be an object/u);

    const events = await ledger.read({ runId: "malformed-tool-arguments" });
    expect(events.some((event) => event.type === "tool.requested")).toBe(false);
  });

  it("accepts Mowe as the only tool authority", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const mowe = new MoweExecutor({ catalog: new MoweCatalog([]) });
    const model = new ScriptedModel([{
      content: "done",
      toolCalls: [],
      stopReason: "stop",
      usage: tokenUsage(10, 5),
    }]);
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      mowe,
    });

    await expect(loop.run({
      runId: "main-mowe-only",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "Go",
    })).resolves.toMatchObject({ finalText: "done", completed: true });
    expect(model.requests[0]?.tools).toEqual([]);
  });

  it("routes required tool approval through the host seam", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    let executions = 0;
    const approvals: string[] = [];
    const guardedTool: MoweAgentTool = {
      definition: {
        name: "guarded_tool",
        description: "Requires host approval",
        parameters: { type: "object", additionalProperties: false },
      },
      metadata: { requiresApproval: true, effect: "write", scope: "workspace" },
      async execute() {
        executions += 1;
        return { content: "approved", isError: false };
      },
    };
    const model = new ScriptedModel([
      {
        content: "use guarded tool",
        toolCalls: [{ id: "guarded-call", name: "guarded_tool", arguments: {} }],
        stopReason: "toolUse",
        usage: tokenUsage(5, 2),
      },
      {
        content: "done",
        toolCalls: [],
        stopReason: "stop",
        usage: tokenUsage(5, 2),
      },
    ]);
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [guardedTool],
      approve: ({ operationId }) => {
        approvals.push(operationId);
        return true;
      },
    });

    await expect(loop.run({
      runId: "main-tool-approval",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(2),
      initialMessage: "Go",
    })).resolves.toMatchObject({ completed: true, finalText: "done" });

    expect(executions).toBe(1);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatch(/^op:/u);
    expect((await ledger.read({ runId: "main-tool-approval" })).some((event) => (
      event.type === "tool.succeeded" && event.payload.toolCallId === "guarded-call"
    ))).toBe(true);
  });

  it("uses an injected Mowe catalog as the model-visible tool source", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const staleTool: AgentTool = {
      definition: {
        name: "stale_tool",
        description: "Should not be advertised when Mowe is injected",
        parameters: { type: "object", additionalProperties: false },
      },
      async execute() {
        return { content: "stale", isError: false };
      },
    };
    const liveTool: AgentTool = {
      definition: {
        name: "live_tool",
        description: "The Mowe-owned tool",
        parameters: { type: "object", additionalProperties: false },
      },
      async execute() {
        return { content: "live", isError: false };
      },
    };
    const mowe = new MoweExecutor({ catalog: new MoweCatalog([liveTool]) });
    const model = new ScriptedModel([{
      content: "done",
      toolCalls: [],
      stopReason: "stop",
      usage: tokenUsage(10, 5),
    }]);
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [staleTool],
      mowe,
    });

    await loop.run({
      runId: "main-mowe-schema-source",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "Go",
    });

    expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual(["live_tool"]);
  });

  it("wires an explicit Fukai capsule selector without changing the default loop", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const model = new ScriptedModel([{
      content: "inspect",
      toolCalls: [{ id: "compaction-noop", name: "noop", arguments: {} }],
      stopReason: "toolUse",
      usage: tokenUsage(10, 5),
    }, {
      content: "done",
      toolCalls: [],
      stopReason: "stop",
      usage: tokenUsage(10, 5),
    }]);
    const summary = {
      schemaVersion: 1 as const,
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      decisions: ["Keep the answer concise"],
      verifiedResults: ["The request is bounded"],
      openQuestions: [],
      sourceRefs: [{ kind: "event" as const, eventId: "source-event", contentHash: "sha256:source" }],
    };
    const summaryRef = await store.put(JSON.stringify(summary), FUKAI_COMPACTION_MEDIA_TYPE);
    let selectorCalls = 0;
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [{
        definition: {
          name: "noop",
          description: "Return a deterministic result",
          parameters: { type: "object", additionalProperties: false },
        },
        async execute() {
          return { content: "ok", isError: false };
        },
      }],
      selectCompaction: async (context) => {
        selectorCalls += 1;
        expect(context.upperWatermark).toBeGreaterThan(0);
        if (selectorCalls === 2) {
          throw new Error("transient compaction read failure");
        }
        return {
          capsule: {
            schemaVersion: 1,
            compactionId: `fukai-compaction:sha256:${"a".repeat(64)}`,
            status: "ready",
            summaryRef,
            sourceRefs: summary.sourceRefs,
            summaryHash: summaryRef.contentHash,
            cursor: "offset:0",
            upperWatermark: context.upperWatermark,
            goalVersion: 1,
            policyVersion: "1",
            estimatedTokens: 24,
          },
          summary,
        };
      },
    });

    await loop.run({
      runId: "main-compaction-selector",
      goal: summary.goal,
      model: "demo",
      workspace,
      policy: policy(2),
      policyVersion: "1",
      initialMessage: "Go",
    });

    expect(selectorCalls).toBe(2);
    expect(model.requests[0]?.messages.some((message) => (
      message.content.includes("Historical compaction capsule")
    ))).toBe(true);
    expect(model.requests[1]?.messages.some((message) => (
      message.content.includes("Historical compaction capsule")
    ))).toBe(false);
    const requested = (await ledger.read({ runId: "main-compaction-selector" }))
      .filter((event) => event.type === "model.requested");
    expect(requested.map((event) => event.payload.contextManifest?.slots.compaction.status))
      .toEqual(["ready", "none"]);
    expect(new Set(requested.map((event) => event.payload.prefixHash)).size).toBe(1);
  });

  it("falls back to bounded raw context when a selected capsule exceeds the context budget", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const model = new ScriptedModel([{
      content: "done",
      toolCalls: [],
      stopReason: "stop",
      usage: tokenUsage(10, 5),
    }]);
    const goal = { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] };
    const summary = {
      schemaVersion: 1 as const,
      goal,
      decisions: ["x".repeat(4_000)],
      verifiedResults: [],
      openQuestions: [],
      sourceRefs: [{ kind: "event" as const, eventId: "source-event", contentHash: "sha256:source" }],
    };
    const summaryRef = await store.put(JSON.stringify(summary), FUKAI_COMPACTION_MEDIA_TYPE);
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [],
      selectCompaction: async (context) => ({
        capsule: {
          schemaVersion: 1,
          compactionId: `fukai-compaction:sha256:${"b".repeat(64)}`,
          status: "ready",
          summaryRef,
          sourceRefs: summary.sourceRefs,
          summaryHash: summaryRef.contentHash,
          cursor: "offset:0",
          upperWatermark: context.upperWatermark,
          goalVersion: goal.version,
          policyVersion: "1",
          estimatedTokens: 1_100,
        },
        summary,
      }),
    });

    await expect(loop.run({
      runId: "main-compaction-context-fallback",
      goal,
      model: "demo",
      workspace,
      policy: policy(1),
      policyVersion: "1",
      systemPrompt: "Main",
      contextBudget: { maxInputTokens: 256 },
      initialMessage: "Go",
    })).resolves.toMatchObject({ completed: true });

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.messages.some((message) => (
      message.content.includes("Historical compaction capsule")
    ))).toBe(false);
    const requested = (await ledger.read({ runId: "main-compaction-context-fallback" }))
      .filter((event) => event.type === "model.requested");
    expect(requested[0]?.payload.contextManifest?.slots.compaction.status).toBe("none");
  });

  it("checks compaction pressure at every Main request boundary without adding provider calls", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const model = new ScriptedModel([{
      content: "inspect both",
      toolCalls: [
        { id: "pressure-tool-a", name: "noop", arguments: {} },
        { id: "pressure-tool-b", name: "noop", arguments: {} },
      ],
      stopReason: "toolUse",
      usage: tokenUsage(10, 5),
    }, {
      content: "done",
      toolCalls: [],
      stopReason: "stop",
      usage: tokenUsage(10, 5),
    }]);
    const pressureChecks: Array<{
      model: string;
      upperWatermark: number;
      conversationCount: number;
      estimatedInputTokens: number;
    }> = [];
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [{
        definition: {
          name: "noop",
          description: "Return a deterministic result",
          parameters: { type: "object", additionalProperties: false },
        },
        async execute() {
          return { content: "ok", isError: false };
        },
      }],
      compactForPressure: async (context) => {
        pressureChecks.push({
          model: context.model,
          upperWatermark: context.upperWatermark,
          conversationCount: context.conversationRefs.length,
          estimatedInputTokens: context.estimatedInputTokens,
        });
        return undefined;
      },
      beforeStep: async ({ step }) => [{
        kind: "runtime-notice",
        source: "test",
        content: `boundary ${step}`,
        messageId: `pressure-boundary-${step}`,
      }],
    });

    await expect(loop.run({
      runId: "main-pressure-boundaries",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(2),
      initialMessage: "Go",
    })).resolves.toMatchObject({ completed: true, steps: 2 });

    expect(model.requests).toHaveLength(2);
    expect(pressureChecks).toHaveLength(2);
    expect(pressureChecks[0]).toMatchObject({ model: "demo", conversationCount: 0 });
    expect(pressureChecks[1]).toMatchObject({ model: "demo", conversationCount: 2 });
    expect(pressureChecks[1]!.upperWatermark).toBeGreaterThan(
      pressureChecks[0]!.upperWatermark,
    );
    expect(pressureChecks.every((check) => check.estimatedInputTokens > 0)).toBe(true);
    expect((await ledger.read({ runId: "main-pressure-boundaries" }))
      .filter((event) => event.type === "model.requested")).toHaveLength(2);
  });

  it("protects the admitted Main request budget from optional compaction failure", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const runTokenBudget = new RunTokenBudget(1_000);
    const model = new ScriptedModel([{
      content: "done",
      toolCalls: [],
      stopReason: "stop",
      usage: tokenUsage(10, 5),
    }]);
    let compactionUsage = 0;
    let mainReservedDuringCompaction = 0;
    const loop = new MainLoop({
      model,
      runTokenBudget,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [],
      compactForPressure: async () => {
        const beforeCompaction = runTokenBudget.snapshot();
        mainReservedDuringCompaction = beforeCompaction.reservedTokens;
        compactionUsage = beforeCompaction.availableTokens;
        expect(beforeCompaction.reservations).toEqual([
          expect.objectContaining({
            id: "main-pressure-budget-guard:lane:main:legacy:step:1:provider:attempt:1",
          }),
        ]);
        expect(mainReservedDuringCompaction).toBeGreaterThan(0);
        expect(compactionUsage).toBeGreaterThan(0);
        expect(runTokenBudget.reserve("test:optional-compaction", compactionUsage))
          .toBeDefined();
        runTokenBudget.settle("test:optional-compaction", compactionUsage);
        throw new Error("optional compaction failed after provider usage");
      },
    });

    await expect(loop.run({
      runId: "main-pressure-budget-guard",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "Go",
      maxOutputTokens: 20,
    })).resolves.toMatchObject({ completed: true, finalText: "done" });

    expect(model.callCount).toBe(1);
    expect(mainReservedDuringCompaction).toBeGreaterThan(0);
    expect(compactionUsage).toBeGreaterThan(0);
    expect(runTokenBudget.snapshot()).toMatchObject({
      usedTokens: compactionUsage + 15,
      reservedTokens: 0,
    });
  });

  it("constrains Main output when pressure compaction grows within its reservation", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const runTokenBudget = new RunTokenBudget(400);
    const model = new ScriptedModel([{
      content: "done",
      toolCalls: [],
      stopReason: "stop",
      usage: tokenUsage(10, 5),
    }]);
    const goal: Goal = {
      version: 1,
      statement: "Answer",
      successCriteria: [],
      hardConstraints: [],
    };
    const loop = new MainLoop({
      model,
      runTokenBudget,
      contextProvider: pressureSizedContextProvider(store, 100, 160),
      conversationStore: store,
      eventSink: ledger,
      tools: [],
      compactForPressure: (context) => pressureCompactionSelection(
        store,
        goal,
        context.policyVersion,
        context.upperWatermark,
        "c",
      ),
    });

    await expect(loop.run({
      runId: "main-pressure-larger-view",
      goal,
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "Go",
      maxOutputTokens: 100,
    })).resolves.toMatchObject({ completed: true, finalText: "done" });

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.maxOutputTokens).toBe(40);
    expect(model.requests[0]?.messages.some((message) => (
      message.content.includes("Historical compaction capsule")
    ))).toBe(true);
    expect(runTokenBudget.snapshot()).toMatchObject({
      usedTokens: 15,
      reservedTokens: 0,
      settlements: [expect.objectContaining({ reservedTokens: 200 })],
    });
    const requested = (await ledger.read({ runId: "main-pressure-larger-view" }))
      .find((event) => event.type === "model.requested");
    expect(requested?.payload).toMatchObject({
      estimatedInputTokens: 160,
      contextManifest: { slots: { compaction: { status: "ready" } } },
    });
  });

  it("retains the admitted view when pressure compaction outgrows Main's reservation", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const runTokenBudget = new RunTokenBudget(400);
    const model = new ScriptedModel([{
      content: "done",
      toolCalls: [],
      stopReason: "stop",
      usage: tokenUsage(10, 5),
    }]);
    const goal: Goal = {
      version: 1,
      statement: "Answer",
      successCriteria: [],
      hardConstraints: [],
    };
    const loop = new MainLoop({
      model,
      runTokenBudget,
      contextProvider: pressureSizedContextProvider(store, 100, 220),
      conversationStore: store,
      eventSink: ledger,
      tools: [],
      compactForPressure: (context) => pressureCompactionSelection(
        store,
        goal,
        context.policyVersion,
        context.upperWatermark,
        "d",
      ),
    });

    await expect(loop.run({
      runId: "main-pressure-view-rejected",
      goal,
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "Go",
      maxOutputTokens: 100,
    })).resolves.toMatchObject({ completed: true, finalText: "done" });

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.maxOutputTokens).toBe(100);
    expect(model.requests[0]?.messages.some((message) => (
      message.content.includes("Historical compaction capsule")
    ))).toBe(false);
    const requested = (await ledger.read({ runId: "main-pressure-view-rejected" }))
      .find((event) => event.type === "model.requested");
    expect(requested?.payload).toMatchObject({
      estimatedInputTokens: 100,
      contextManifest: { slots: { compaction: { status: "none" } } },
    });
  });

  it("releases Main's reservation when pressure compaction is aborted", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const runTokenBudget = new RunTokenBudget(4_000);
    const controller = new AbortController();
    const model = new ScriptedModel([{
      content: "must not run",
      toolCalls: [],
      stopReason: "stop",
      usage: tokenUsage(1, 1),
    }]);
    let reservedBeforeAbort = 0;
    const loop = new MainLoop({
      model,
      runTokenBudget,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [],
      compactForPressure: async () => {
        reservedBeforeAbort = runTokenBudget.snapshot().reservedTokens;
        const cancellation = new Error("pressure compaction cancelled");
        controller.abort(cancellation);
        throw cancellation;
      },
    });

    await expect(loop.run({
      runId: "main-pressure-aborted",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "Go",
      maxOutputTokens: 20,
      signal: controller.signal,
    })).rejects.toThrow("pressure compaction cancelled");

    expect(reservedBeforeAbort).toBeGreaterThan(0);
    expect(model.callCount).toBe(0);
    expect(runTokenBudget.snapshot()).toMatchObject({
      usedTokens: 0,
      reservedTokens: 0,
      availableTokens: 4_000,
      settlements: [],
    });
    expect((await ledger.read({ runId: "main-pressure-aborted" })).some((event) => (
      event.type === "model.requested"
    ))).toBe(false);
  });

  it("freezes one model selector for pressure and provider IO at each boundary", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const model = new ScriptedModel([{
      content: "inspect",
      toolCalls: [{ id: "selector-noop", name: "noop", arguments: {} }],
      stopReason: "toolUse",
      usage: tokenUsage(10, 5),
    }, {
      content: "done",
      toolCalls: [],
      stopReason: "stop",
      usage: tokenUsage(10, 5),
    }]);
    let selectedModel = "model-b";
    let resolverCalls = 0;
    const pressureModels: string[] = [];
    const loop = new MainLoop({
      model,
      resolveModel: () => {
        resolverCalls += 1;
        return selectedModel;
      },
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [noopToolForMainTest],
      compactForPressure: async (context) => {
        pressureModels.push(context.model);
        selectedModel = "model-c";
        return undefined;
      },
    });

    await loop.run({
      runId: "main-pressure-model-freeze",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "model-a",
      workspace,
      policy: policy(2),
      initialMessage: "Go",
    });

    expect(resolverCalls).toBe(2);
    expect(pressureModels).toEqual(["model-b", "model-c"]);
    expect(model.requests.map((request) => request.model)).toEqual(["model-b", "model-c"]);
    expect((await ledger.read({ runId: "main-pressure-model-freeze" }))
      .filter((event) => event.type === "model.requested")
      .map((event) => event.payload.model)).toEqual(["model-b", "model-c"]);
  });

  it("admits Main with a shared Run budget, narrows output, and settles actual usage", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const observedInputBudgets: number[] = [];
    const runTokenBudget = new RunTokenBudget(4_000);
    const model = new ScriptedModel([{
      content: "done",
      toolCalls: [],
      stopReason: "stop",
      usage: tokenUsage(10, 5),
    }]);
    const loop = new MainLoop({
      model,
      runTokenBudget,
      contextProvider: recordingContextProvider(store, observedInputBudgets),
      conversationStore: store,
      eventSink: ledger,
      tools: [],
    });

    await expect(loop.run({
      runId: "main-budget-run",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "Go",
    })).resolves.toMatchObject({ completed: true, usage: tokenUsage(10, 5) });

    expect(observedInputBudgets).toEqual([UNKNOWN_MODEL_REQUEST_INPUT_FALLBACK_TOKENS]);
    expect(model.requests[0]?.maxOutputTokens).toBeGreaterThan(0);
    expect(model.requests[0]?.maxOutputTokens).toBeLessThan(4_000);
    expect(runTokenBudget.snapshot()).toMatchObject({
      usedTokens: 15,
      reservedTokens: 0,
      availableTokens: 3_985,
      settlements: [{
        id: "main-budget-run:lane:main:legacy:step:1:provider:attempt:1",
        reservedTokens: 4_000,
        actualTokens: 15,
      }],
    });
    const eventTypes = (await ledger.read({ runId: "main-budget-run" }))
      .map((event) => event.type);
    expect(eventTypes.indexOf("budget.charged"))
      .toBeLessThan(eventTypes.indexOf("model.completed"));
  });

  it("does not call Main when the shared Run budget cannot fit its input", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const runTokenBudget = new RunTokenBudget(1);
    const model = new ScriptedModel([{
      content: "must not run",
      toolCalls: [],
      stopReason: "stop",
      usage: tokenUsage(1, 1),
    }]);
    const loop = new MainLoop({
      model,
      runTokenBudget,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [],
    });

    const error = await loop.run({
      runId: "main-budget-denied",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "Go",
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(MainRunTokenBudgetExhaustedError);
    expect(error).toMatchObject({ code: "run-budget-exhausted" });
    expect(model.requests).toHaveLength(0);
    expect(runTokenBudget.snapshot()).toMatchObject({
      usedTokens: 0,
      reservedTokens: 0,
      availableTokens: 1,
    });
    expect((await ledger.read({ runId: "main-budget-denied" })).some((event) => (
      event.type === "model.requested"
    ))).toBe(false);
  });

  it("releases Main's shared reservation when the provider fails", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const runTokenBudget = new RunTokenBudget(4_000);
    const loop = new MainLoop({
      model: new ScriptedModel([new Error("provider unavailable")]),
      runTokenBudget,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [],
    });

    await expect(loop.run({
      runId: "main-budget-failure",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "Go",
    })).rejects.toThrow("provider unavailable");
    expect(runTokenBudget.snapshot()).toMatchObject({
      usedTokens: 0,
      reservedTokens: 0,
      availableTokens: 4_000,
      settlements: [],
    });
  });

  it("charges provider-reported usage when a Main request fails", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const runTokenBudget = new RunTokenBudget(4_000);
    const failure = Object.assign(new Error("provider returned an error response"), {
      providerUsage: tokenUsage(9, 3),
    });
    const loop = new MainLoop({
      model: new ScriptedModel([failure]),
      runTokenBudget,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [],
    });

    await expect(loop.run({
      runId: "main-budget-metered-failure",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "Go",
    })).rejects.toThrow("provider returned an error response");

    expect(runTokenBudget.snapshot()).toMatchObject({
      usedTokens: 12,
      reservedTokens: 0,
      availableTokens: 3_988,
    });
    const events = await ledger.read({ runId: "main-budget-metered-failure" });
    expect(events.filter((event) => event.type === "budget.charged"))
      .toEqual([expect.objectContaining({ payload: { laneId: "main", usage: tokenUsage(9, 3) } })]);
    expect(events.some((event) => event.type === "model.failed")).toBe(true);
  });

  it("reconciles partial deltas with the committed assistant message", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const response: ModelResponse = {
      content: "partial response completed from durable state",
      toolCalls: [],
      stopReason: "stop",
      usage: tokenUsage(4, 6),
    };
    const model: ModelPort = {
      async complete() { return response; },
      async *stream() {
        yield { type: "start" as const };
        yield { type: "text-delta" as const, delta: "partial response" };
        yield { type: "done" as const, response };
      },
    };
    const streamed: MainStreamEvent[] = [];
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [],
      onStreamEvent: (event) => streamed.push(event),
    });

    await loop.run({
      runId: "stream-reconcile-run",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "Go",
    });

    expect(streamed.find((event) => event.type === "stream.delta")).toMatchObject({
      delta: "partial response",
    });
    const ended = streamed.find((event) => event.type === "stream.end");
    expect(ended?.type).toBe("stream.end");
    if (ended?.type !== "stream.end") throw new Error("Missing stream.end");
    const committed = JSON.parse(new TextDecoder().decode(await store.get(ended.messageRef)));
    expect(committed.content).toBe(response.content);
  });

  it("accepts an image-only initial message and preserves it for the model", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const model = new ScriptedModel([{
      content: "image inspected",
      toolCalls: [],
      stopReason: "stop",
      usage: tokenUsage(4, 3),
    }]);
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [],
    });
    const image = { type: "image" as const, data: "AQID", mimeType: "image/png" };

    const result = await loop.run({
      runId: "image-only-run",
      goal: {
        version: 1,
        statement: "Analyze the attached image",
        successCriteria: [],
        hardConstraints: [],
      },
      model: "vision-demo",
      workspace,
      policy: policy(1),
      initialImages: [image],
    });

    expect(result.finalText).toBe("image inspected");
    expect(model.requests[0]?.messages.find((message) =>
      message.role === "user" && message.images !== undefined
    )).toMatchObject({ content: "", images: [image] });
    const userEvent = (await ledger.read({ runId: "image-only-run" }))
      .find((event) => event.type === "user.message");
    if (userEvent?.type !== "user.message") throw new Error("Missing user message");
    const persisted = JSON.parse(new TextDecoder().decode(await store.get(userEvent.payload.messageRef)));
    expect(persisted).toMatchObject({ role: "user", content: "", images: [image] });
  });

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
      activeObjective: "Handle the current Turn",
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
    expect(model.requests[0]?.messages.at(-1)?.content).toContain("Handle the current Turn");
    expect(model.requests[0]?.messages.some((message) =>
      message.content.includes("Runtime advice")
      && message.content.includes("Check the simpler route"),
    )).toBe(true);
    expect(model.requests[1]?.messages.filter((message) => message.role === "tool")).toHaveLength(2);

    const events = await ledger.read({ runId: "run-main" });
    expect(events.filter((event) => event.type === "tool.requested")).toHaveLength(2);
    expect(events.filter((event) => event.type === "tool.succeeded")).toHaveLength(2);
    expect(events.filter((event) => event.type === "navigation.updated")).toHaveLength(2);
    expect(result.navigationDeltas.map((delta) => delta.activeObjective)).toEqual([
      "Handle the current Turn",
      "Handle the current Turn",
    ]);
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
    expect(result.stopReason).toBe("length");
    expect(result.navigationDeltas[0]?.status).toBe("uncertain");
    expect(afterSteps).toEqual([{
      usage: tokenUsage(3, 4),
      boundaryMessageIds: ["advice-length"],
    }]);
    const events = await ledger.read({ runId: "length-run" });
    expect(events.some((event) => event.type === "run.completed")).toBe(false);
    const completed = events.find((event) => event.type === "step.completed");
    expect(completed?.payload.boundaryMessageIds).toEqual(["advice-length"]);
    const requested = events.find((event) => event.type === "model.requested");
    expect(requested?.payload.contextWatermark).toBeGreaterThan(0);
    expect(requested?.payload.contextWatermark).toBeLessThan(requested?.globalOffset ?? 0);
  });

  it("never executes tool calls from a length-truncated model response", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    let executions = 0;
    const model = new ScriptedModel([
      {
        content: "partial tool call",
        toolCalls: [{ id: "truncated-call", name: "mutate", arguments: { path: "a" } }],
        stopReason: "length",
        usage: tokenUsage(3, 4),
      },
      {
        content: "recovered",
        toolCalls: [],
        stopReason: "stop",
        usage: tokenUsage(4, 2),
      },
    ]);
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [{
        definition: {
          name: "mutate",
          description: "must not run with truncated arguments",
          parameters: { type: "object", additionalProperties: true },
        },
        async execute() {
          executions += 1;
          return { content: "mutated", isError: false };
        },
      }],
    });

    const result = await loop.run({
      runId: "truncated-tool-run",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(2),
      initialMessage: "Go",
    });

    expect(executions).toBe(0);
    expect(result).toMatchObject({ completed: true, finalText: "recovered" });
    const events = await ledger.read({ runId: "truncated-tool-run" });
    expect(events.filter((event) => event.type === "tool.failed")).toHaveLength(1);
    const retryContext = model.requests[1]?.messages.find((message) => message.role === "tool");
    expect(retryContext?.content).toContain("may be truncated");
  });

  it("does not promote one expected tool miss to a repeated-failure wake", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const model = new ScriptedModel([
      {
        content: "",
        toolCalls: [{ id: "missing-1", name: "read_file", arguments: { path: "OPTIONAL.md" } }],
        stopReason: "toolUse",
        usage: tokenUsage(3, 1),
      },
      {
        content: "done",
        toolCalls: [],
        stopReason: "stop",
        usage: tokenUsage(3, 1),
      },
    ]);
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [{
        definition: {
          name: "read_file",
          description: "read a bounded file",
          parameters: { type: "object", additionalProperties: false },
        },
        async execute() {
          return { content: "File not found", isError: true };
        },
      }],
    });

    const result = await loop.run({
      runId: "expected-miss-run",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(2),
      initialMessage: "Go",
    });

    expect(result.completed).toBe(true);
    expect(result.navigationDeltas[0]).toMatchObject({
      triggerKind: "normal",
      actionOrDecision: expect.stringContaining("OPTIONAL.md"),
      outcome: expect.stringContaining("File not found"),
    });
  });

  it("marks a successful workspace mutation as a decision boundary", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const loop = new MainLoop({
      model: new ScriptedModel([
        {
          content: "",
          toolCalls: [{
            id: "edit-1",
            name: "edit",
            arguments: { path: "src/value.ts", oldText: "1", newText: "2" },
          }],
          stopReason: "toolUse",
          usage: tokenUsage(3, 1),
        },
        {
          content: "done",
          toolCalls: [],
          stopReason: "stop",
          usage: tokenUsage(3, 1),
        },
      ]),
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [{
        definition: {
          name: "edit",
          description: "edit one file",
          parameters: { type: "object", additionalProperties: true },
        },
        async execute() {
          return { content: "Updated src/value.ts", isError: false };
        },
      }],
    });

    const result = await loop.run({
      runId: "mutation-decision-run",
      goal: { version: 1, statement: "Change the value", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(2),
      initialMessage: "Go",
    });

    expect(result.navigationDeltas[0]).toMatchObject({
      triggerKind: "decision",
      actionOrDecision: expect.stringContaining("src/value.ts"),
    });
  });

  it("records monotonic context and provider latency without wall-clock inference", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const timings = [10, 14, 20, 45];
    const loop = new MainLoop({
      model: new ScriptedModel([{
        content: "done",
        toolCalls: [],
        stopReason: "stop",
        usage: { input: 10, output: 2, cacheRead: 8, cacheWrite: 1 },
      }]),
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [],
      monotonicNow: () => timings.shift() ?? 45,
    });

    await loop.run({
      runId: "telemetry-run",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "Go",
    });

    const events = await ledger.read({ runId: "telemetry-run" });
    const requested = events.find((event) => event.type === "model.requested");
    const completed = events.find((event) => event.type === "model.completed");
    expect(requested?.payload).toMatchObject({
      contextBuildMs: 4,
      sessionId: "telemetry-run:main",
      truncations: [],
    });
    expect(requested?.payload.prefixHash).toMatch(/^[a-f0-9]{64}$/);
    expect(completed?.payload).toMatchObject({
      modelLatencyMs: 25,
      cacheOutcome: "hit-write",
    });
  });

  it("keeps prefix and session affinity stable across images, steering, recovery, and turns", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const image = { type: "image" as const, data: "AQID", mimeType: "image/png" };
    const model = new ScriptedModel([
      {
        content: "inspect once",
        toolCalls: [{ id: "inspect", name: "noop", arguments: {} }],
        stopReason: "toolUse",
        usage: tokenUsage(5, 2),
      },
      {
        content: "first turn complete",
        toolCalls: [],
        stopReason: "stop",
        usage: tokenUsage(6, 2),
      },
      {
        content: "second turn complete",
        toolCalls: [],
        stopReason: "stop",
        usage: tokenUsage(7, 2),
      },
    ]);
    let boundaryOrdinal = 0;
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [{
        definition: {
          name: "noop",
          description: "Return a deterministic observation",
          parameters: { type: "object", additionalProperties: false },
        },
        async execute() {
          return { content: "observed", isError: false };
        },
      }],
      beforeStep: async () => {
        boundaryOrdinal += 1;
        return [{
          kind: "steering",
          source: "user",
          content: `steering-${boundaryOrdinal}`,
          messageId: `steering-${boundaryOrdinal}`,
        }];
      },
    });
    const goal = {
      version: 1,
      statement: "Keep cache evidence explainable",
      successCriteria: [],
      hardConstraints: [],
    };
    const contextBudget = {
      maxInputTokens: 4_000,
      maxConversationMessages: 3,
    };
    const activationPolicy = {
      maxMainStepsPerActivation: 1,
      maxModelTokens: 10_000,
      tetoEnabled: false,
      tetoMaxOutputTokens: 200,
      tetoTokenRatio: 0.1,
    };

    const interrupted = await loop.run({
      runId: "cache-evidence-run",
      turnId: "turn-1",
      activeObjective: "Inspect the image",
      goal,
      model: "vision-demo",
      workspace,
      policy: activationPolicy,
      initialImages: [image],
      contextBudget,
    });
    expect(interrupted.completed).toBe(false);

    const resumed = await loop.run({
      runId: "cache-evidence-run",
      turnId: "turn-1",
      activeObjective: "Finish the inspection",
      goal,
      model: "vision-demo",
      workspace,
      policy: activationPolicy,
      startStep: 2,
      upperWatermark: await ledger.watermark(),
      conversationRefs: interrupted.conversationRefs,
      contextBudget,
    });
    expect(resumed.completed).toBe(true);

    await loop.run({
      runId: "cache-evidence-run",
      turnId: "turn-2",
      activeObjective: "Answer the follow-up",
      goal,
      model: "vision-demo",
      workspace,
      policy: activationPolicy,
      initialMessage: "What changed?",
      upperWatermark: await ledger.watermark(),
      conversationRefs: resumed.conversationRefs,
      contextBudget,
    });

    expect(model.requests.map((request) => request.sessionId)).toEqual([
      "cache-evidence-run:main",
      "cache-evidence-run:main",
      "cache-evidence-run:main",
    ]);
    expect(model.requests[0]?.messages.some((message) =>
      message.role === "user" && message.images?.length === 1
    )).toBe(true);
    expect(model.requests[1]?.messages.some((message) =>
      message.content.includes("steering-2")
    )).toBe(true);

    const requested = (await ledger.read({ runId: "cache-evidence-run" }))
      .filter((event) => event.type === "model.requested");
    expect(requested).toHaveLength(3);
    expect(new Set(requested.map((event) => event.payload.sessionId))).toEqual(
      new Set(["cache-evidence-run:main"]),
    );
    expect(new Set(requested.map((event) => event.payload.prefixHash)).size).toBe(1);
    expect(new Set(requested.map((event) => event.payload.requestHash)).size).toBe(3);
    expect(requested[0]?.payload.truncations).toEqual([]);
    expect(requested.slice(1).every((event) =>
      event.payload.truncations?.some((item) => item.kind === "conversation-message-limit")
    )).toBe(true);
  });

  it("redacts persisted model and Step failure text", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const bearer = "bearer-secret-value-123456";
    const openRouterKey = "sk" + "-or-v1-" + "a".repeat(32);
    const loop = new MainLoop({
      model: new ScriptedModel([
        new Error(`Provider rejected Bearer ${bearer} using ${openRouterKey}`),
      ]),
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [],
    });

    await expect(loop.run({
      runId: "redacted-model-run",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "Go",
    })).rejects.toThrow("Provider rejected");

    const serialized = JSON.stringify(await ledger.read({ runId: "redacted-model-run" }));
    expect(serialized).not.toContain(bearer);
    expect(serialized).not.toContain(openRouterKey);
    expect(serialized).toContain("[REDACTED]");
    const failureTypes = (await ledger.read({ runId: "redacted-model-run" }))
      .filter((event) => event.type.endsWith(".failed"))
      .map((event) => event.type);
    expect(failureTypes).toEqual(["model.failed", "step.failed"]);
  });

  it("redacts a failed tool result before storing or returning it to the model", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const bearer = "tool-bearer-secret-123456";
    const openRouterKey = "sk" + "-or-v1-" + "z".repeat(32);
    const model = new ScriptedModel([
      {
        content: "run the tool",
        toolCalls: [{ id: "secret-call", name: "secret_tool", arguments: {} }],
        stopReason: "toolUse",
        usage: tokenUsage(5, 2),
      },
      {
        content: "done",
        toolCalls: [],
        stopReason: "stop",
        usage: tokenUsage(5, 2),
      },
    ]);
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [{
        definition: {
          name: "secret_tool",
          description: "fails with provider details",
          parameters: { type: "object", additionalProperties: false },
        },
        async execute() {
          throw new Error(`Authorization: Bearer ${bearer}; key=${openRouterKey}`);
        },
      }],
    });

    await loop.run({
      runId: "redacted-tool-run",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(2),
      initialMessage: "Go",
    });

    const events = await ledger.read({ runId: "redacted-tool-run" });
    const failed = events.find((event) => event.type === "tool.failed");
    expect(failed?.type).toBe("tool.failed");
    if (failed?.type !== "tool.failed") throw new Error("Missing tool.failed event");
    const artifact = new TextDecoder().decode(await store.get(failed.payload.resultRef));
    const persisted = JSON.stringify(events) + artifact;
    expect(persisted).not.toContain(bearer);
    expect(persisted).not.toContain(openRouterKey);
    expect(persisted).toContain("[REDACTED]");
    expect(JSON.stringify(model.requests[1]?.messages)).not.toContain(bearer);
    expect(JSON.stringify(model.requests[1]?.messages)).not.toContain(openRouterKey);
  });

  it("shares one bounded transcript artifact while Mowe retains the full source once", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const fullContent = `${"前缀内容 ".repeat(40_000)}END`;
    const scripted = new ScriptedModel([
      {
        content: "inspect the result",
        toolCalls: [{ id: "large-call", name: "large_tool", arguments: {} }],
        stopReason: "toolUse",
        usage: tokenUsage(5, 2),
      },
      {
        content: "done",
        toolCalls: [],
        stopReason: "stop",
        usage: tokenUsage(5, 2),
      },
    ]);
    const loop = new MainLoop({
      model: modelWithContextWindows(scripted, { demo: 128_000 }),
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [{
        definition: {
          name: "large_tool",
          description: "returns a large result",
          parameters: { type: "object", additionalProperties: false },
        },
        async execute() {
          return { content: fullContent, isError: false };
        },
      }],
    });

    const outcome = await loop.run({
      runId: "large-tool-result-run",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(2),
      contextBudget: { maxInputTokens: 100_000 },
      initialMessage: "Go",
    });

    const events = await ledger.read({ runId: "large-tool-result-run" });
    const succeeded = events.find((event) => event.type === "tool.succeeded");
    expect(succeeded?.type).toBe("tool.succeeded");
    if (succeeded?.type !== "tool.succeeded") throw new Error("Missing tool.succeeded event");
    const durable = JSON.parse(new TextDecoder().decode(await store.get(succeeded.payload.resultRef))) as {
      role: string;
      content: string;
    };
    expect(durable.role).toBe("tool");
    expect(durable.content).not.toBe(fullContent);
    expect(durable.content).toContain("Full tool result stored as artifact");

    const visibleTool = scripted.requests[1]?.messages.find((message) => message.role === "tool");
    expect(visibleTool?.content).toContain("[TRUNCATED BY MAIN LOOP]");
    expect(Buffer.byteLength(visibleTool?.content ?? "", "utf8")).toBeLessThanOrEqual(256 * 1024);
    expect(visibleTool?.content).toBe(durable.content);
    expect(succeeded.payload.contextRef?.id).toBe(succeeded.payload.resultRef.id);

    const contextMessage = await Promise.all(outcome.conversationRefs.map(async ({ ref }) => {
      const parsed = JSON.parse(new TextDecoder().decode(await store.get(ref))) as {
        role?: string;
        content?: string;
      };
      return parsed.role === "tool" && parsed.content === visibleTool?.content ? parsed : undefined;
    })).then((messages) => messages.find((message) => message !== undefined));
    expect(contextMessage?.content).toBe(visibleTool?.content);
  });

  it("does not amplify a Mowe result beyond its aggregate output budget", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const fullContent = "0123456789abcdef";
    const tool: AgentTool = {
      definition: {
        name: "aggregate_tool",
        description: "returns a result larger than the test aggregate budget",
        parameters: { type: "object", additionalProperties: false },
      },
      async execute() {
        return { content: fullContent, isError: false };
      },
    };
    const mowe = new class extends MoweExecutor {
      override execute(request: Parameters<MoweExecutor["execute"]>[0]) {
        return super.execute({
          ...request,
          limits: { ...request.limits, maxOutputBytes: 8 },
        });
      }
    }({ catalog: [tool] });
    const model = new ScriptedModel([
      {
        content: "inspect",
        toolCalls: [{ id: "aggregate-call", name: "aggregate_tool", arguments: {} }],
        stopReason: "toolUse",
        usage: tokenUsage(5, 2),
      },
      {
        content: "done",
        toolCalls: [],
        stopReason: "stop",
        usage: tokenUsage(5, 2),
      },
    ]);
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [tool],
      mowe,
    });

    await loop.run({
      runId: "aggregate-result-run",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(2),
      initialMessage: "Go",
    });

    const events = await ledger.read({ runId: "aggregate-result-run" });
    const succeeded = events.find((event) => event.type === "tool.succeeded");
    if (succeeded?.type !== "tool.succeeded") throw new Error("Missing tool.succeeded event");
    const durable = JSON.parse(new TextDecoder().decode(
      await store.get(succeeded.payload.resultRef),
    )) as { role: string; content: string };
    expect(durable.role).toBe("tool");
    expect(durable.content).not.toBe(fullContent);
    expect(Buffer.byteLength(durable.content, "utf8")).toBeLessThanOrEqual(8);

    const visibleTool = model.requests[1]?.messages.find((message) => message.role === "tool");
    expect(visibleTool?.content).toBe(durable.content);
  });

  it("keeps bounded tool images in the next request and recovery context", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    // Valid canonical base64 representing a 300 KiB image payload. The tool
    // boundary intentionally does not inspect image magic bytes.
    const image = {
      type: "image" as const,
      mimeType: "image/png",
      data: "A".repeat(400_000),
    };
    const model = new ScriptedModel([
      {
        content: "inspect image",
        toolCalls: [{ id: "image-call", name: "image_tool", arguments: {} }],
        stopReason: "toolUse",
        usage: tokenUsage(5, 2),
      },
      {
        content: "done",
        toolCalls: [],
        stopReason: "stop",
        usage: tokenUsage(5, 2),
      },
    ]);
    const imageTool: MoweAgentTool = {
      definition: {
        name: "image_tool",
        description: "returns a large image",
        parameters: { type: "object", additionalProperties: false },
      },
      metadata: { outputKinds: ["image", "json"] },
      async execute() {
        return { content: "large image", isError: false, images: [image] };
      },
    };
    const loop = new MainLoop({
      model,
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [imageTool],
    });

    const outcome = await loop.run({
      runId: "large-tool-image-run",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(2),
      contextBudget: { maxInputTokens: 100_000 },
      initialMessage: "Go",
    });

    const visibleTool = model.requests[1]?.messages.find((message) => message.role === "tool");
    if (visibleTool?.role !== "tool") throw new Error("Missing visible tool result");
    expect(visibleTool.images).toEqual([image]);
    expect(visibleTool?.content).toContain("large image");
    expect(Buffer.byteLength(visibleTool?.content ?? "", "utf8")).toBeLessThanOrEqual(256 * 1024);

    const events = await ledger.read({ runId: "large-tool-image-run" });
    const succeeded = events.find((event) => event.type === "tool.succeeded");
    if (succeeded?.type !== "tool.succeeded") throw new Error("Missing tool.succeeded event");
    expect(succeeded.payload.contextRef).toBeDefined();
    const contextArtifact = JSON.parse(new TextDecoder().decode(
      await store.get(succeeded.payload.contextRef!),
    )) as { role: string; images?: unknown[]; content: string };
    expect(contextArtifact.images).toEqual([image]);
    expect(contextArtifact.content).toContain("large image");

    const recovered = projectMainExecutionRecovery(events);
    const recoveredTool = recovered.conversationRefs.find((ref) => ref.ref.id === succeeded.payload.contextRef!.id);
    expect(recoveredTool).toBeDefined();
    expect(succeeded.payload.contextRef?.id).toBe(succeeded.payload.resultRef.id);
    expect(outcome.conversationRefs.some((ref) => ref.ref.id === succeeded.payload.resultRef.id)).toBe(true);
  });

  it("waits for every parallel tool execution before rejecting cancellation", async () => {
    const workspace = await temporaryDirectory();
    const store = new MemoryContentAddressedStore();
    const ledger = new MemoryLedger();
    const controller = new AbortController();
    let started = 0;
    let releaseStarted: (() => void) | undefined;
    let releaseDelayed: (() => void) | undefined;
    let delayedFinished = false;
    let runSettled = false;
    const bothStarted = new Promise<void>((resolve) => { releaseStarted = resolve; });
    const delayedGate = new Promise<void>((resolve) => { releaseDelayed = resolve; });
    const markStarted = (): void => {
      started += 1;
      if (started === 2) releaseStarted?.();
    };
    const tool = (name: string, execute: AgentTool["execute"]): AgentTool => ({
      definition: {
        name,
        description: name,
        parameters: { type: "object", additionalProperties: false },
      },
      execute,
    });
    const loop = new MainLoop({
      model: new ScriptedModel([{
        content: "run both",
        toolCalls: [
          { id: "cancel-call", name: "cancel", arguments: {} },
          { id: "delayed-call", name: "delayed", arguments: {} },
        ],
        stopReason: "toolUse",
        usage: tokenUsage(5, 2),
      }]),
      contextProvider: new FukaiContextProvider(new ContentStoreFukaiSource(store)),
      conversationStore: store,
      eventSink: ledger,
      tools: [
        tool("cancel", async () => {
          markStarted();
          await bothStarted;
          controller.abort(new Error("cancelled"));
          return { content: "cancelled", isError: false };
        }),
        tool("delayed", async () => {
          markStarted();
          await delayedGate;
          delayedFinished = true;
          return { content: "late result", isError: false };
        }),
      ],
    });

    const outcome = loop.run({
      runId: "cancelled-tools-run",
      goal: { version: 1, statement: "Answer", successCriteria: [], hardConstraints: [] },
      model: "demo",
      workspace,
      policy: policy(1),
      initialMessage: "Go",
      signal: controller.signal,
    }).then(
      () => undefined,
      (error: unknown) => error,
    ).finally(() => {
      runSettled = true;
    });

    await bothStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runSettled).toBe(false);
    expect(delayedFinished).toBe(false);

    releaseDelayed?.();
    expect(await outcome).toBeInstanceOf(Error);
    expect(delayedFinished).toBe(true);
    const events = await ledger.read({ runId: "cancelled-tools-run" });
    const requested = events.filter((event) => event.type === "tool.requested");
    const terminal = events.filter((event) => (
      event.type === "tool.succeeded" || event.type === "tool.failed"
    ));
    expect(requested).toHaveLength(2);
    expect(terminal).toHaveLength(2);
    expect(new Set(terminal.map((event) => event.payload.operationId))).toEqual(
      new Set(requested.map((event) => event.payload.operationId)),
    );
    const watermark = await ledger.watermark();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await ledger.watermark()).toBe(watermark);
  });
});

const noopToolForMainTest: AgentTool = {
  definition: {
    name: "noop",
    description: "Return a deterministic result",
    parameters: { type: "object", additionalProperties: false },
  },
  async execute() {
    return { content: "ok", isError: false };
  },
};

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

function pressureSizedContextProvider(
  store: MemoryContentAddressedStore,
  rawTokens: number,
  compactedTokens: number,
): MainContextProvider {
  const provider = new FukaiContextProvider(new ContentStoreFukaiSource(store));
  return {
    async build(request) {
      const view = await provider.build(request);
      return {
        ...view,
        usage: {
          ...view.usage,
          estimatedInputTokens: request.compaction === undefined
            ? rawTokens
            : compactedTokens,
        },
      };
    },
  };
}

function recordingContextProvider(
  store: MemoryContentAddressedStore,
  observedInputBudgets: number[],
): MainContextProvider {
  const provider = new FukaiContextProvider(new ContentStoreFukaiSource(store));
  return {
    async build(request) {
      observedInputBudgets.push(request.budget.maxInputTokens);
      return provider.build(request);
    },
  };
}

function modelWithContextWindows(
  scripted: ScriptedModel,
  contextWindowTokens: Readonly<Record<string, number>>,
): ModelPort {
  return {
    capabilities(model) {
      const contextWindow = contextWindowTokens[model];
      return {
        imageInput: false,
        ...(contextWindow === undefined ? {} : { contextWindowTokens: contextWindow }),
      };
    },
    complete: scripted.complete.bind(scripted),
  };
}

async function pressureCompactionSelection(
  store: MemoryContentAddressedStore,
  goal: Goal,
  policyVersion: string,
  upperWatermark: number,
  digestCharacter: string,
): Promise<FukaiCompactionSelection> {
  const sourceRefs = [{
    kind: "event" as const,
    eventId: `pressure-source-${digestCharacter}`,
    contentHash: `sha256:${digestCharacter.repeat(64)}`,
  }];
  const summary = {
    schemaVersion: 1 as const,
    goal,
    decisions: ["Use the pressure capsule"],
    verifiedResults: [],
    openQuestions: [],
    sourceRefs,
  };
  const summaryRef = await store.put(JSON.stringify(summary), FUKAI_COMPACTION_MEDIA_TYPE);
  return {
    capsule: {
      schemaVersion: 1,
      compactionId: `fukai-compaction:sha256:${digestCharacter.repeat(64)}`,
      status: "ready",
      summaryRef,
      sourceRefs,
      summaryHash: summaryRef.contentHash,
      cursor: "offset:0",
      upperWatermark,
      goalVersion: goal.version,
      policyVersion,
      estimatedTokens: 24,
    },
    summary,
  };
}
