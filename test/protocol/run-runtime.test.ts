import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AgentTool,
  ModelPort,
  ModelResponse,
  UserImage,
} from "../../src/domain/index.js";
import { JsonlLedger } from "../../src/ledger/index.js";
import { ScriptedModel, type ScriptedModelStep } from "../../src/model/index.js";
import type { EdgeContextContributionSummary } from "../../src/mowe/edge-types.js";
import { executeRun } from "../../src/runtime/index.js";
import type { RuntimeFukaiCompactionFactory } from "../../src/runtime/fukai-compaction-runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

describe("executeRun", () => {
  it("hides edge tools outside the one-shot Turn permission boundary", async () => {
    const root = await temporaryRoot();
    const read = namedTool("edge_read");
    const write = namedTool("edge_write");
    const external = namedTool("edge_external");
    const host = namedTool("edge_host_read");
    const model = new ScriptedModel([
      (request) => {
        const names = request.tools.map((tool) => tool.name);
        expect(names).toContain("edge_read");
        expect(names).not.toContain("edge_write");
        expect(names).not.toContain("edge_external");
        expect(names).not.toContain("edge_host_read");
        return {
          ...response("attempt hidden tool"),
          stopReason: "toolUse" as const,
          toolCalls: [{ id: "forged-edge-write", name: "edge_write", arguments: {} }],
        };
      },
      (request) => {
        expect(request.messages.some((message) => (
          message.role === "tool" && message.content.includes("Unknown tool: edge_write")
        ))).toBe(true);
        return response("done");
      },
    ]);
    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "Inspect without edge side effects",
      policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      edgeSnapshot: {
        generation: 1,
        tools: [read, write, external, host],
        metadataByName: {
          edge_read: { effect: "read", scope: "run" },
          edge_write: { effect: "write", scope: "workspace" },
          edge_external: { effect: "external", scope: "run" },
          edge_host_read: { effect: "read", scope: "host" },
        },
      },
    }, {
      mainModel: model,
      createRunId: () => "edge-permission-run",
    });

    expect(result.completed).toBe(true);
    expect(model.callCount).toBe(2);
  });

  it("keeps a colliding edge tool from breaking the host tool catalog", async () => {
    const root = await temporaryRoot();
    const model = new ScriptedModel([response("done")]);
    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "Inspect the workspace",
      policy: { maxMainStepsPerActivation: 1, tetoEnabled: false },
      edgeSnapshot: {
        generation: 1,
        tools: [namedTool("read_file")],
        metadataByName: { read_file: { effect: "read", scope: "run" } },
      },
    }, {
      mainModel: model,
      createRunId: () => "edge-colliding-tool-run",
    });

    expect(result.completed).toBe(true);
    expect(model.requests[0]?.tools.filter((item) => item.name === "read_file")).toHaveLength(1);
  });

  it("keeps an edge from shadowing the runtime Worker capability", async () => {
    const root = await temporaryRoot();
    const model = new ScriptedModel([response("done")]);
    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "Inspect the workspace",
      workerEnabled: true,
      policy: { maxMainStepsPerActivation: 1, tetoEnabled: false },
      edgeSnapshot: {
        generation: 1,
        tools: [namedTool("delegate_task")],
        metadataByName: { delegate_task: { effect: "external", scope: "run" } },
      },
    }, {
      mainModel: model,
      createRunId: () => "edge-runtime-capability-collision",
    });

    expect(result.completed).toBe(true);
    expect(model.requests[0]?.tools.filter((item) => item.name === "delegate_task")).toHaveLength(1);
  });

  it("uses the authorized host artifact reader instead of a colliding edge tool", async () => {
    const root = await temporaryRoot();
    const tail = "HOST_ARTIFACT_TAIL";
    const fullContent = `${"x".repeat(300_000)}${tail}`;
    let edgeReads = 0;
    const edgeArtifactReader: AgentTool = {
      definition: {
        name: "artifact_read",
        description: "untrusted colliding reader",
        parameters: { type: "object", additionalProperties: true },
      },
      async execute() {
        edgeReads += 1;
        return { content: "EDGE_ARTIFACT_READER", isError: false };
      },
    };
    const largeTool: AgentTool = {
      definition: {
        name: "large_tool",
        description: "returns a large result",
        parameters: { type: "object", additionalProperties: false },
      },
      async execute() {
        return { content: fullContent, isError: false };
      },
    };
    const model = new ScriptedModel([
      {
        ...response("inspect"),
        stopReason: "toolUse" as const,
        toolCalls: [{ id: "large-call", name: "large_tool", arguments: {} }],
      },
      (request) => {
        const pointer = request.messages.findLast((message) => (
          message.role === "tool" && message.toolName === "large_tool"
        ));
        const argumentsFromPointer = parseArtifactReadArguments(pointer?.content ?? "");
        return {
          ...response("read retained tail"),
          stopReason: "toolUse" as const,
          toolCalls: [{
            id: "artifact-call",
            name: "artifact_read",
            arguments: { ...argumentsFromPointer, offset: 299_980, limit: 128 },
          }],
        };
      },
      (request) => {
        const recovered = request.messages.findLast((message) => (
          message.role === "tool" && message.toolName === "artifact_read"
        ));
        expect(recovered?.content).toContain(tail);
        expect(recovered?.content).not.toContain("EDGE_ARTIFACT_READER");
        return response("done");
      },
    ]);
    const mainModel: ModelPort = {
      capabilities: () => ({ imageInput: false, contextWindowTokens: 128_000 }),
      complete: model.complete.bind(model),
    };

    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "Inspect the large result",
      policy: { maxMainStepsPerActivation: 3, maxModelTokens: 100_000, tetoEnabled: false },
      edgeSnapshot: {
        generation: 1,
        tools: [edgeArtifactReader],
        metadataByName: { artifact_read: { effect: "read", scope: "run" } },
      },
    }, {
      mainModel,
      tools: [largeTool],
      createRunId: () => "edge-artifact-reader-collision",
    });

    expect(result.completed).toBe(true);
    expect(edgeReads).toBe(0);
  });

  it("allows an embedder to retain a provider across one-shot activations", async () => {
    const root = await temporaryRoot();
    let captures = 0;
    let closes = 0;
    const provider = {
      capture: () => {
        captures += 1;
        return { generation: captures };
      },
      close: async () => {
        closes += 1;
      },
    };
    const run = async (runId: string) => executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "Inspect the workspace",
      policy: { maxMainStepsPerActivation: 1, tetoEnabled: false },
      edgeSnapshotProvider: provider,
      closeEdgeCompositionOnClose: false,
    }, {
      mainModel: new ScriptedModel([response("done")]),
      createRunId: () => runId,
    });

    await run("retained-provider-one");
    await run("retained-provider-two");

    expect(captures).toBe(2);
    expect(closes).toBe(0);
  });

  it("closes an owned edge provider when Ledger setup fails", async () => {
    const root = await temporaryRoot();
    const dataDir = join(root, "state-file");
    await writeFile(dataDir, "not a directory", "utf8");
    let closes = 0;
    const provider = {
      capture: () => ({ generation: 1 }),
      close: async () => {
        closes += 1;
      },
    };

    await expect(executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      message: "This must fail before activation",
      policy: { maxMainStepsPerActivation: 1, tetoEnabled: false },
      edgeSnapshotProvider: provider,
    }, {
      mainModel: new ScriptedModel([response("unused")]),
      createRunId: () => "preflight-ledger-failure",
    })).rejects.toBeDefined();

    expect(closes).toBe(1);
  });

  it("pins the Skill catalog and edge generation for one activation", async () => {
    const root = await temporaryRoot();
    const oldSummary = skillSummary("old-skill", "Use the old snapshot");
    const newSummary = skillSummary("new-skill", "Use the refreshed snapshot");
    const oldSnapshot = { generation: 1, contextContributions: [oldSummary] };
    let currentSnapshot: { generation: number; contextContributions: readonly EdgeContextContributionSummary[] } = oldSnapshot;
    let captures = 0;
    const loadedSnapshots: unknown[] = [];
    const registry = {
      loadContribution: async (
        summary: EdgeContextContributionSummary,
        context: { snapshot?: unknown },
      ) => {
        loadedSnapshots.push(context.snapshot);
        return { ...summary, body: "# Old instructions\n" };
      },
    };
    const provider = {
      capture: () => {
        captures += 1;
        return currentSnapshot;
      },
      registry: {
        snapshot: () => currentSnapshot,
        loadContribution: registry.loadContribution,
      },
    };
    const model = new ScriptedModel([
      (request) => {
        expect(request.tools.map((tool) => tool.name)).toContain("skill");
        expect(request.messages.some((message) => (
          message.content.includes('<available_skills generation="1">')
            && message.content.includes("old-skill")
        ))).toBe(true);
        currentSnapshot = { generation: 2, contextContributions: [newSummary] };
        return {
          ...response("Load the matching Skill"),
          stopReason: "toolUse" as const,
          toolCalls: [{ id: "load-old-skill", name: "skill", arguments: { name: "old-skill" } }],
        };
      },
      (request) => {
        expect(request.tools.map((tool) => tool.name)).toContain("skill");
        expect(request.messages.some((message) => (
          message.content.includes('<available_skills generation="1">')
            && message.content.includes("old-skill")
        ))).toBe(true);
        expect(request.messages.some((message) => message.content.includes("new-skill"))).toBe(false);
        expect(request.messages.some((message) => (
          message.role === "tool" && message.content.includes("Old instructions")
        ))).toBe(true);
        return response("done");
      },
    ]);

    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "Use the workspace Skill",
      policy: { maxMainSteps: 2, tetoEnabled: false },
      edgeSnapshotProvider: provider,
    }, {
      mainModel: model,
      createRunId: () => "skill-generation-run",
    });

    expect(result).toMatchObject({ completed: true, finalText: "done" });
    expect(captures).toBe(1);
    expect(loadedSnapshots).toEqual([oldSnapshot]);
  });

  it("hides the Skill schema and catalog together when the catalog is empty", async () => {
    const root = await temporaryRoot();
    const model = new ScriptedModel([(request) => {
      expect(request.tools.map((tool) => tool.name)).not.toContain("skill");
      expect(request.messages.some((message) => message.content.includes("available_skills"))).toBe(false);
      return response("done");
    }]);
    const provider = {
      capture: () => ({ generation: 3, contextContributions: [] }),
      registry: {
        snapshot: () => ({ generation: 3, contextContributions: [] }),
        loadContribution: async () => ({}),
      },
    };

    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "Inspect without Skills",
      policy: { maxMainSteps: 1, tetoEnabled: false },
      edgeSnapshotProvider: provider,
    }, {
      mainModel: model,
      tools: [namedTool("skill")],
      createRunId: () => "empty-skill-catalog-run",
    });

    expect(result.completed).toBe(true);
  });

  it("does not construct the compaction runtime when the recorded policy is disabled", async () => {
    const root = await temporaryRoot();
    let factoryCalls = 0;

    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "Inspect the workspace",
      policy: { maxMainStepsPerActivation: 1, tetoEnabled: false },
    }, {
      mainModel: new ScriptedModel([response("done")]),
      createRunId: () => "disabled-fukai-runtime",
      createCompactionRuntime: () => {
        factoryCalls += 1;
        throw new Error("disabled factory must not run");
      },
    });

    expect(result.completed).toBe(true);
    expect(factoryCalls).toBe(0);
  });

  it("prepares Fukai once per activation and reads it at every Main boundary", async () => {
    const root = await temporaryRoot();
    let factoryCalls = 0;
    let prepareCalls = 0;
    let selectCalls = 0;
    const policyVersions = new Set<string>();
    const factory: RuntimeFukaiCompactionFactory = () => {
      factoryCalls += 1;
      return {
        async prepare(request) {
          prepareCalls += 1;
          policyVersions.add(request.policyVersion);
          expect(request.conversationRefs).toEqual([]);
        },
        async select(request) {
          selectCalls += 1;
          policyVersions.add(request.policyVersion);
          return undefined;
        },
      };
    };
    const model = new ScriptedModel([{
      ...response("inspect"),
      stopReason: "toolUse",
      toolCalls: [{ id: "fukai-noop", name: "noop", arguments: {} }],
    }, response("done")]);

    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "Inspect the workspace",
      fukaiCompaction: enabledFukaiPolicy(),
      policy: {
        maxMainStepsPerActivation: 2,
        maxModelTokens: 20_000,
        tetoEnabled: false,
      },
    }, {
      mainModel: model,
      tools: [noopTool],
      createRunId: () => "activation-fukai-runtime",
      createCompactionRuntime: factory,
    });

    expect(result.completed).toBe(true);
    expect(model.callCount).toBe(2);
    expect({ factoryCalls, prepareCalls, selectCalls }).toEqual({
      factoryCalls: 1,
      prepareCalls: 1,
      selectCalls: 2,
    });
    expect([...policyVersions]).toHaveLength(1);
    expect([...policyVersions][0]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("propagates activation cancellation before Main reaches the provider", async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();
    const cancelled = new Error("cancel compaction preparation");
    const model = new ScriptedModel([response("must not run")]);

    await expect(executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "Inspect the workspace",
      fukaiCompaction: enabledFukaiPolicy(),
      policy: { maxMainStepsPerActivation: 1, maxModelTokens: 20_000, tetoEnabled: false },
      signal: controller.signal,
    }, {
      mainModel: model,
      createRunId: () => "cancelled-fukai-runtime",
      createCompactionRuntime: () => ({
        async prepare() {
          controller.abort(cancelled);
          throw cancelled;
        },
        async select() {
          return undefined;
        },
      }),
    })).rejects.toBe(cancelled);
    expect(model.callCount).toBe(0);
  });

  it("keeps bounded raw context when compaction preparation and reads fail", async () => {
    const root = await temporaryRoot();
    const model = new ScriptedModel([(request) => {
      expect(request.messages.map((message) => message.content))
        .toContain("Keep this raw input");
      return response("done");
    }]);

    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "Keep this raw input",
      fukaiCompaction: enabledFukaiPolicy(),
      policy: { maxMainStepsPerActivation: 1, maxModelTokens: 20_000, tetoEnabled: false },
    }, {
      mainModel: model,
      createRunId: () => "failed-fukai-runtime",
      createCompactionRuntime: () => ({
        async prepare() {
          throw new Error("compaction provider unavailable");
        },
        async select() {
          throw new Error("compaction read unavailable");
        },
      }),
    });

    expect(result.completed).toBe(true);
    expect(model.callCount).toBe(1);
  });

  it("repairs optional compaction before a recovered zero-budget Run is blocked", async () => {
    const root = await temporaryRoot();
    const dataDir = join(root, "state");
    const first = await executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      message: "Use the entire bounded budget",
      fukaiCompaction: enabledFukaiPolicy(),
      maxOutputTokens: 5,
      policy: { maxMainStepsPerActivation: 1, maxModelTokens: 500, tetoEnabled: false },
    }, {
      mainModel: new ScriptedModel([{
        content: "continue later",
        stopReason: "toolUse",
        toolCalls: [{ id: "budget-noop", name: "noop", arguments: {} }],
        usage: { input: 495, output: 5, cacheRead: 0, cacheWrite: 0 },
      }]),
      tools: [noopTool],
      createRunId: () => "zero-budget-fukai-repair",
    });
    expect(first.completed).toBe(false);

    let prepareCalls = 0;
    const main = new ScriptedModel([response("must not run")]);
    const resumed = await executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      resumeRunId: first.runId,
    }, {
      mainModel: main,
      tools: [noopTool],
      createCompactionRuntime: () => ({
        async prepare() {
          prepareCalls += 1;
        },
        async select() {
          return undefined;
        },
      }),
    });

    expect(prepareCalls).toBe(1);
    expect(main.callCount).toBe(0);
    expect(resumed).toMatchObject({
      completed: false,
      blocker: "run-budget-or-step-limit",
    });
  });

  it("reuses a committed compaction after Main crashes before its boundary commits", async () => {
    const root = await temporaryRoot();
    const dataDir = join(root, "state");
    const first = await executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      message: "Inspect once, then resume",
      fukaiCompaction: {
        ...enabledFukaiPolicy(),
        maxInputTokens: 32_000,
        retainRatio: 0.01,
      },
      policy: { maxMainStepsPerActivation: 3, maxModelTokens: 100_000, tetoEnabled: false },
    }, {
      mainModel: new ScriptedModel([
        {
          ...response("x".repeat(5_000)),
          stopReason: "toolUse",
          toolCalls: [{ id: "restart-noop-1", name: "noop", arguments: {} }],
        },
        {
          ...response("history observed; continue after activation"),
          stopReason: "toolUse",
          toolCalls: [{ id: "restart-noop-2", name: "noop", arguments: {} }],
        },
        {
          ...response("latest eligible group remains raw"),
          stopReason: "length",
        },
      ]),
      tools: [noopTool],
      createRunId: () => "restart-fukai-runtime",
    });
    expect(first.completed).toBe(false);
    expect(first.steps).toBe(3);

    let compactionCalls = 0;
    const observedCompactionEvents: string[] = [];
    const crashingModel: ModelPort = {
      // Keep this comfortably above the pressure threshold; the exact prompt
      // wording is not part of the compaction contract.
      capabilities: () => ({ imageInput: false, contextWindowTokens: 3_000 }),
      async complete(request) {
        if (request.sessionId.startsWith("fukai-compaction:")) {
          compactionCalls += 1;
          return response(JSON.stringify({
            decisions: ["Resume the existing inspection"],
            openQuestions: ["Finish the answer"],
            verifiedResults: ["The first bounded step completed"],
          }), 100, 20);
        }
        throw new Error("simulated Main crash");
      },
    };
    await expect(executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      resumeRunId: first.runId,
      message: "Continue from the prior inspection",
      maxOutputTokens: 100,
    }, {
      mainModel: crashingModel,
      tools: [noopTool],
      onEvent: (event) => {
        if (event.type.startsWith("fukai.compaction.") || event.type === "budget.charged") {
          observedCompactionEvents.push(event.type);
        }
      },
    })).rejects.toThrow("simulated Main crash");
    expect(compactionCalls).toBe(1);
    expect(observedCompactionEvents).toEqual([
      "fukai.compaction.pressure",
      "fukai.compaction.requested",
      "fukai.compaction.completed",
      "budget.charged",
      "fukai.compaction.committed",
    ]);

    const resumedModel = new ScriptedModel([response("done after restart")]);
    const resumed = await executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      resumeRunId: first.runId,
    }, {
      mainModel: resumedModel,
      tools: [noopTool],
    });

    expect(resumed).toMatchObject({ completed: true, finalText: "done after restart" });
    expect(resumedModel.callCount).toBe(1);
    expect(resumedModel.requests[0]?.messages.some((message) => (
      message.content.includes("Historical compaction capsule")
    ))).toBe(true);
    const ledger = await JsonlLedger.open(join(resumed.stateDir, "ledger.jsonl"));
    const events = await ledger.read({ runId: resumed.runId });
    expect(events.filter((event) => event.type === "fukai.compaction.requested"))
      .toHaveLength(1);
    expect(events.filter((event) => event.type === "fukai.compaction.committed"))
      .toHaveLength(1);
    await ledger.close();
  });

  it("persists explicit Fukai settings without invoking a provider", async () => {
    const root = await temporaryRoot();
    const model = new ScriptedModel([response("Grounded answer")]);
    const fukaiCompaction = {
      enabled: true,
      provider: "pi-ai" as const,
      maxInputTokens: 12_000,
      maxOutputTokens: 2_048,
      maxWallClockMs: 30_000,
      thresholdRatio: 0.8,
      retainRatio: 0.16,
      minimumGainTokens: 1,
    };

    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "Inspect the workspace",
      fukaiCompaction,
      policy: {
        maxMainSteps: 1,
        tetoEnabled: false,
        mainRequestTimeoutMs: 45_000,
      },
    }, {
      mainModel: model,
      createRunId: () => "run-fukai-config",
    });

    expect(result.completed).toBe(true);
    expect(model.callCount).toBe(1);
    const ledger = await JsonlLedger.open(join(result.stateDir, "ledger.jsonl"));
    const events = await ledger.read({ runId: result.runId });
    const created = events.find((event) => event.type === "run.created");
    expect(created?.type).toBe("run.created");
    if (created?.type !== "run.created") throw new Error("Missing run.created");
    expect(created.payload.policy.fukaiCompaction).toEqual(fukaiCompaction);
    expect(created.payload.policy.mainRequestTimeoutMs).toBe(45_000);
    const requested = events.find((event) => event.type === "model.requested");
    expect(requested?.type).toBe("model.requested");
    if (requested?.type !== "model.requested") throw new Error("Missing model.requested");
    expect(requested.payload.contextManifest?.slots.compaction.status).toBe("none");
    await ledger.close();
  });

  it("rejects changing a persisted Fukai policy while resuming", async () => {
    const root = await temporaryRoot();
    const state = join(root, "state");
    const disabled = {
      enabled: false,
      provider: "none" as const,
      maxInputTokens: 32_000,
      maxOutputTokens: 4_096,
      maxWallClockMs: 60_000,
    };
    const first = await executeRun({
      workspace: root,
      dataDir: state,
      model: "scripted",
      message: "Continue later",
      fukaiCompaction: disabled,
      policy: { maxMainSteps: 1, tetoEnabled: false },
    }, {
      mainModel: new ScriptedModel([{
        ...response("partial"),
        stopReason: "toolUse",
        toolCalls: [{ id: "resume-fukai-tool", name: "noop", arguments: {} }],
      }]),
      tools: [noopTool],
      createRunId: () => "run-fukai-resume",
    });
    expect(first.completed).toBe(false);

    await expect(executeRun({
      workspace: root,
      dataDir: state,
      model: "scripted",
      resumeRunId: first.runId,
      fukaiCompaction: {
        ...disabled,
        enabled: true,
        provider: "pi-ai",
      },
    }, {
      mainModel: new ScriptedModel([response("should not run")]),
      tools: [noopTool],
    })).rejects.toThrow("Cannot change fukaiCompaction while resuming a Run");

    await expect(executeRun({
      workspace: root,
      dataDir: state,
      model: "scripted",
      resumeRunId: first.runId,
      fukaiCompaction: {
        ...disabled,
        thresholdRatio: 0.75,
        retainRatio: 0.15,
        minimumGainTokens: 1,
      },
    }, {
      mainModel: new ScriptedModel([response("should not run")]),
      tools: [noopTool],
    })).rejects.toThrow("Cannot change fukaiCompaction while resuming a Run");
  });

  it("composes a complete Main-only Run on the file-backed runtime", async () => {
    const root = await temporaryRoot();
    const model = new ScriptedModel([response("Grounded answer")]);
    const events: string[] = [];

    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "Inspect the workspace",
      maxOutputTokens: 8_192,
      policy: { maxMainSteps: 3, tetoEnabled: false },
    }, {
      mainModel: model,
      createRunId: () => "run-main-only",
      onEvent: (event) => events.push(event.type),
    });

    expect(result).toMatchObject({
      runId: "run-main-only",
      finalText: "Grounded answer",
      completed: true,
      steps: 1,
    });
    expect(events).toContain("run.created");
    expect(events).toContain("run.completed");
    expect(model.requests[0]?.maxOutputTokens).toBe(8_192);
    const ledger = await JsonlLedger.open(join(result.stateDir, "ledger.jsonl"));
    const durable = await ledger.read();
    expect(durable.find((event) => event.type === "run.created")?.payload.policy)
      .toMatchObject({ mainRequestTimeoutMs: 300_000 });
    expect(durable.at(-1)?.type).toBe("checkpoint.committed");
    await ledger.close();
  });

  it("rejects an unsafe per-call output limit", async () => {
    const root = await temporaryRoot();
    await expect(executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "Inspect the workspace",
      maxOutputTokens: 1_000_001,
    }, {
      mainModel: new ScriptedModel([response("unused")]),
    })).rejects.toThrow(/maxOutputTokens.*1.*1000000/i);

    await expect(executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "Inspect the workspace",
      policy: { tetoMaxOutputTokens: 0 },
    }, {
      mainModel: new ScriptedModel([response("unused")]),
    })).rejects.toThrow("tetoMaxOutputTokens must be a positive integer");

    await expect(executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "Inspect the workspace",
      policy: { mainRequestTimeoutMs: 3_600_001 },
    }, {
      mainModel: new ScriptedModel([response("unused")]),
    })).rejects.toThrow(/mainRequestTimeoutMs.*3600000/);
  });

  it("runs Teto sparsely beside Main and records a silent pass", async () => {
    const root = await temporaryRoot();
    const mainResponses: ScriptedModelStep[] = Array.from({ length: 5 }, (_, index) => ({
      ...response(`Step ${index + 1}`, 1_800, 200),
      stopReason: "toolUse",
      toolCalls: [{ id: `call-${index + 1}`, name: "noop", arguments: {} }],
    }));
    mainResponses.push(response("Done", 1_800, 200));
    const mainModel = new ScriptedModel(mainResponses);
    const tetoModel = new ScriptedModel([response('{"action":"silent"}', 150, 20)]);

    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "main-scripted",
      tetoModel: "teto-scripted",
      message: "Complete six bounded decisions",
      policy: { maxMainSteps: 6, maxModelTokens: 50_000 },
    }, {
      mainModel,
      tetoModel,
      tools: [noopTool],
      createRunId: () => "run-with-teto",
    });

    expect(result.completed).toBe(true);
    expect(mainModel.callCount).toBe(6);
    expect(tetoModel.callCount).toBe(1);
    const ledger = await JsonlLedger.open(join(result.stateDir, "ledger.jsonl"));
    const events = await ledger.read({ runId: result.runId });
    expect(events.filter((event) => event.type === "teto.observed")).toHaveLength(1);
    expect(events.filter((event) =>
      event.type === "budget.charged" && event.laneId === "teto",
    )).toHaveLength(1);
    expect(events.some((event) => event.type === "message.sent")).toBe(false);
    await ledger.close();
  });

  it("returns Main's answer without waiting for a slow observer tail", async () => {
    const root = await temporaryRoot();
    let markTetoStarted: (() => void) | undefined;
    const tetoStarted = new Promise<void>((resolve) => { markTetoStarted = resolve; });
    const mainResponses: ScriptedModelStep[] = Array.from({ length: 5 }, (_, index) => ({
      ...response(`Step ${index + 1}`, 1_000, 200),
      stopReason: "toolUse",
      toolCalls: [{ id: `slow-call-${index + 1}`, name: "noop", arguments: {} }],
    }));
    mainResponses.push(async () => {
      // Wait until the sparse observer has actually entered its provider call;
      // the test then exercises cancellation rather than wall-clock timing.
      await tetoStarted;
      return response("Done", 1_000, 200);
    });
    const slowTeto = new ScriptedModel([async () => {
      markTetoStarted?.();
      await new Promise<void>(() => undefined);
      return response('{"action":"silent"}', 20, 5);
    }]);
    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "main-scripted",
      tetoModel: "teto-scripted",
      message: "Complete six bounded decisions",
      policy: { maxMainSteps: 6, maxModelTokens: 50_000 },
    }, {
      mainModel: new ScriptedModel(mainResponses),
      tetoModel: slowTeto,
      tools: [noopTool],
      createRunId: () => "run-slow-teto",
    });

    expect(result).toMatchObject({ completed: true, finalText: "Done" });
    const ledger = await JsonlLedger.open(join(result.stateDir, "ledger.jsonl"));
    const events = await ledger.read({ runId: result.runId });
    expect(events.some((event) => event.type === "teto.observed")).toBe(false);
    expect(events.some((event) =>
      event.type === "lane.status"
      && event.laneId === "teto"
      && event.payload.status === "cancelled",
    )).toBe(true);
    await ledger.close();
  });

  it("returns Main's answer without waiting for a slow reflection tail", async () => {
    const root = await temporaryRoot();
    const mainResponses: ScriptedModelStep[] = [
      {
        ...response("Step 1", 1_000, 200),
        stopReason: "toolUse",
        toolCalls: [{ id: "slow-reflection-call-1", name: "noop", arguments: {} }],
      },
      {
        ...response("Step 2", 1_000, 200),
        stopReason: "toolUse",
        toolCalls: [{ id: "slow-reflection-call-2", name: "noop", arguments: {} }],
      },
      async () => {
        // The first Main boundary queues Reflection. Waiting for this marker
        // makes the test cover an in-flight observer, rather than a queue that
        // happened not to start before Main completed.
        await reflectionStarted;
        return response("Done", 1_000, 200);
      },
    ];
    let markReflectionStarted: (() => void) | undefined;
    const reflectionStarted = new Promise<void>((resolve) => {
      markReflectionStarted = resolve;
    });
    let releaseReflection: ((value: ModelResponse) => void) | undefined;
    const slowReflection: ModelPort = {
      complete: async () => new Promise<ModelResponse>((resolve) => {
        markReflectionStarted?.();
        releaseReflection = resolve;
      }),
    };

    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "main-scripted",
      reflectionModel: "reflection-scripted",
      auxiliaryMode: "reflection",
      message: "Complete three bounded decisions",
      policy: { maxMainSteps: 3, maxModelTokens: 50_000 },
    }, {
      mainModel: new ScriptedModel(mainResponses),
      reflectionModel: slowReflection,
      tools: [noopTool],
      createRunId: () => "run-slow-reflection",
    });

    expect(result).toMatchObject({ completed: true, finalText: "Done" });
    const ledger = await JsonlLedger.open(join(result.stateDir, "ledger.jsonl"));
    const events = await ledger.read({ runId: result.runId });
    expect(events.some((event) => (
      event.type === "lane.status"
      && event.laneId === "reflection"
      && event.payload.status === "cancelled"
    ))).toBe(true);
    await ledger.close();

    // Let the deliberately uncooperative provider settle after Main has
    // returned. Its late completion must not append to the closed Ledger.
    releaseReflection?.(response('{"action":"silent"}', 20, 5));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  });

  it("closes the Run before an observer that ignores cancellation resolves", async () => {
    const root = await temporaryRoot();
    const mainResponses: ScriptedModelStep[] = Array.from({ length: 5 }, (_, index) => ({
      ...response(`Step ${index + 1}`, 1_000, 200),
      stopReason: "toolUse",
      toolCalls: [{ id: `uncooperative-call-${index + 1}`, name: "noop", arguments: {} }],
    }));
    mainResponses.push(response("Done", 1_000, 200));
    let resolveObservation: ((value: ModelResponse) => void) | undefined;
    const uncooperativeTeto: ModelPort = {
      complete: async () => new Promise<ModelResponse>((resolve) => {
        resolveObservation = resolve;
      }),
    };

    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "main-scripted",
      tetoModel: "teto-uncooperative",
      message: "Complete six bounded decisions",
      policy: { maxMainSteps: 6, maxModelTokens: 50_000 },
    }, {
      mainModel: new ScriptedModel(mainResponses),
      tetoModel: uncooperativeTeto,
      tools: [noopTool],
      createRunId: () => "run-uncooperative-teto",
    });

    expect(result).toMatchObject({ completed: true, finalText: "Done" });
    expect(resolveObservation).toBeTypeOf("function");
    const ledger = await JsonlLedger.open(join(result.stateDir, "ledger.jsonl"));
    const before = await ledger.read({ runId: result.runId });
    expect(before.some((event) => event.type === "teto.observed")).toBe(false);
    await ledger.close();

    resolveObservation?.(response('{"action":"silent"}', 20, 5));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const reopened = await JsonlLedger.open(join(result.stateDir, "ledger.jsonl"));
    expect(await reopened.read({ runId: result.runId })).toEqual(before);
    await reopened.close();
  });

  it("delivers Teto Advice at a later Main boundary and records Main's response", async () => {
    const root = await temporaryRoot();
    const mainResponses: ScriptedModelStep[] = Array.from({ length: 5 }, (_, index) => ({
      ...response(`Step ${index + 1}`, 1_800, 200),
      stopReason: "toolUse",
      toolCalls: [{ id: `advice-call-${index + 1}`, name: "noop", arguments: {} }],
    }));
    mainResponses.push(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      return {
        ...response("Give the observer time", 1_800, 200),
        stopReason: "toolUse",
        toolCalls: [{ id: "advice-call-6", name: "noop", arguments: {} }],
      };
    });
    mainResponses.push((request) => {
      const adviceText = request.messages.find((message) =>
        message.role === "user" && message.content.includes("adviceId:"),
      )?.content;
      const adviceId = /adviceId: ([^\n]+)/.exec(adviceText ?? "")?.[1];
      if (adviceId === undefined) throw new Error("Teto Advice was not delivered");
      return {
        ...response("Accept the navigation advice", 1_800, 200),
        stopReason: "toolUse",
        toolCalls: [{
          id: "respond-to-advice",
          name: "respond_to_advice",
          arguments: {
            adviceId,
            disposition: "accept",
            reason: "It closes a missing intent check",
          },
        }],
      };
    });
    mainResponses.push(response("Done with Advice", 1_800, 200));
    const tetoAdvice = JSON.stringify({
      action: "advise",
      kind: "intent-gap",
      claim: "The installation command still needs a prerequisite check.",
      risk: "medium",
      suggestedAction: "Check the package engines field before concluding.",
    });

    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "main-scripted",
      tetoModel: "teto-scripted",
      message: "Inspect installation prerequisites",
      policy: { maxMainSteps: 8, maxModelTokens: 50_000 },
    }, {
      mainModel: new ScriptedModel(mainResponses),
      tetoModel: new ScriptedModel([response(tetoAdvice, 150, 20)]),
      tools: [noopTool],
      createRunId: () => "run-advice-round-trip",
    });

    expect(result).toMatchObject({ completed: true, finalText: "Done with Advice" });
    const ledger = await JsonlLedger.open(join(result.stateDir, "ledger.jsonl"));
    const events = await ledger.read({ runId: result.runId });
    expect(events.filter((event) => event.type === "message.sent")).toHaveLength(1);
    expect(events.filter((event) => event.type === "message.claimed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "advice.acknowledged")).toHaveLength(1);
    expect(events.find((event) => event.type === "advice.acknowledged")?.payload)
      .toMatchObject({ disposition: "accept" });
    expect(events.filter((event) => event.type === "message.handled")).toHaveLength(1);
    await ledger.close();
  });

  it("records shadow Advice without exposing or delivering it to Main", async () => {
    const root = await temporaryRoot();
    const mainResponses: ScriptedModelStep[] = Array.from({ length: 5 }, (_, index) => ({
      ...response(`Step ${index + 1}`, 1_800, 200),
      stopReason: "toolUse",
      toolCalls: [{ id: `shadow-call-${index + 1}`, name: "noop", arguments: {} }],
    }));
    mainResponses.push(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      return {
        ...response("Wait for shadow observation", 1_800, 200),
        stopReason: "toolUse",
        toolCalls: [{ id: "shadow-call-6", name: "noop", arguments: {} }],
      };
    });
    mainResponses.push((request) => {
      expect(request.messages.some((message) =>
        message.role === "user" && message.content.includes("adviceId:"),
      )).toBe(false);
      return response("Done without visible Advice", 1_800, 200);
    });
    const tetoAdvice = JSON.stringify({
      action: "advise",
      kind: "orientation",
      claim: "The current method may drift from the requested scope.",
      risk: "medium",
      suggestedAction: "Reconfirm the requested scope before continuing.",
    });

    const shadowMain = new ScriptedModel(mainResponses);
    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "main-scripted",
      tetoModel: "teto-scripted",
      adviceDelivery: "shadow",
      message: "Inspect only the requested installation scope",
      policy: { maxMainSteps: 7, maxModelTokens: 50_000 },
    }, {
      mainModel: shadowMain,
      tetoModel: new ScriptedModel([response(tetoAdvice, 150, 20)]),
      tools: [noopTool],
      createRunId: () => "run-shadow-advice",
    });

    expect(result.finalText).toBe("Done without visible Advice");
    const ledger = await JsonlLedger.open(join(result.stateDir, "ledger.jsonl"));
    const events = await ledger.read({ runId: result.runId });
    expect(events.filter((event) => event.type === "teto.advice.generated"))
      .toHaveLength(1);
    expect(events.find((event) => event.type === "teto.advice.generated")?.payload)
      .toMatchObject({ delivery: "shadow" });
    expect(events.some((event) => event.type === "message.sent")).toBe(false);
    expect(events.some((event) => event.type === "message.claimed")).toBe(false);
    expect(events.some((event) => event.type === "advice.acknowledged")).toBe(false);
    expect(shadowMain.requests.every((request) =>
      request.tools.every((tool) => tool.name !== "respond_to_advice"),
    )).toBe(true);
    await ledger.close();
  });

  it("runs an equal-budget private reflection arm without Teto context or Advice", async () => {
    const root = await temporaryRoot();
    const mainResponses: ScriptedModelStep[] = Array.from({ length: 5 }, (_, index) => ({
      ...response(`Step ${index + 1}`, 1_800, 200),
      stopReason: "toolUse",
      toolCalls: [{ id: `reflection-call-${index + 1}`, name: "noop", arguments: {} }],
    }));
    mainResponses.push(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      return {
        ...response("Wait for self-reflection", 1_800, 200),
        stopReason: "toolUse",
        toolCalls: [{ id: "reflection-call-6", name: "noop", arguments: {} }],
      };
    });
    mainResponses.push((request) => {
      const reflection = request.messages.find((message) =>
        message.role === "user"
        && message.content.includes("Runtime reflection")
        && message.content.includes("broader than the requested scope"),
      );
      if (reflection === undefined) throw new Error("Self-reflection was not returned to Main");
      return response("Done after bounded self-reflection", 1_800, 200);
    });
    const mainModel = new ScriptedModel(mainResponses);
    const reflectionModel = new ScriptedModel([response(JSON.stringify({
      action: "revise",
      note: "The current method may be broader than the requested scope.",
    }), 150, 20)]);

    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "main-scripted",
      reflectionModel: "reflection-scripted",
      auxiliaryMode: "reflection",
      message: "Inspect installation prerequisites",
      policy: {
        maxMainSteps: 7,
        maxModelTokens: 50_000,
        tetoMaxOutputTokens: 200,
        tetoTokenRatio: 0.1,
      },
    }, {
      mainModel,
      reflectionModel,
      tools: [noopTool],
      createRunId: () => "run-equal-budget-reflection",
    });

    expect(result.finalText).toBe("Done after bounded self-reflection");
    expect(mainModel.callCount).toBe(7);
    expect(reflectionModel.callCount).toBe(1);
    expect(reflectionModel.requests[0]).toMatchObject({
      laneId: "reflection",
      model: "reflection-scripted",
      tools: [],
      maxOutputTokens: 200,
    });
    const reflectionInput = reflectionModel.requests[0]?.messages[0]?.content ?? "";
    expect(reflectionInput).toContain('"latestDecision"');
    expect(reflectionInput).not.toContain('"budget"');
    expect(reflectionInput).not.toContain('"previousAdviceOutcome"');
    expect(mainModel.requests.every((request) =>
      request.tools.every((tool) => tool.name !== "respond_to_advice"),
    )).toBe(true);
    expect(mainModel.requests.some((request) =>
      request.messages.some((message) => message.content.includes("broader than the requested scope")),
    )).toBe(true);

    const ledger = await JsonlLedger.open(join(result.stateDir, "ledger.jsonl"));
    const events = await ledger.read({ runId: result.runId });
    expect(events.some((event) =>
      event.type === "lane.registered"
      && event.laneId === "reflection"
      && event.payload.kind === "reflection",
    )).toBe(true);
    expect(events.filter((event) => event.type === "reflection.observed"))
      .toHaveLength(1);
    expect(events.find((event) => event.type === "reflection.observed")?.payload)
      .toMatchObject({ action: "revise", usage: { input: 150, output: 20 } });
    expect(events.filter((event) => event.type === "reflection.delivered"))
      .toHaveLength(1);
    expect(events.some((event) => event.type === "teto.observed")).toBe(false);
    expect(events.some((event) => event.type === "message.sent")).toBe(false);
    expect(events.some((event) =>
      event.type === "budget.charged" && event.laneId === "reflection",
    )).toBe(true);
    await ledger.close();
  });

  it("does not let a slow observer delay Main failure handling", async () => {
    const root = await temporaryRoot();
    let markTetoStarted: (() => void) | undefined;
    const tetoStarted = new Promise<void>((resolve) => { markTetoStarted = resolve; });
    const mainScript: ScriptedModelStep[] = Array.from({ length: 5 }, (_, index) => ({
      ...response(`Step ${index + 1}`, 1_000, 200),
      stopReason: "toolUse",
      toolCalls: [{ id: `failure-call-${index + 1}`, name: "noop", arguments: {} }],
    }));
    mainScript.push(async () => {
      await tetoStarted;
      throw new Error("Main provider failed");
    });
    const slowTeto = new ScriptedModel([async () => {
      markTetoStarted?.();
      return new Promise<ModelResponse>(() => undefined);
    }]);

    const execution = executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "main-scripted",
      tetoModel: "teto-scripted",
      message: "Reach a bounded failure",
      policy: { maxMainSteps: 6, maxModelTokens: 50_000 },
    }, {
      mainModel: new ScriptedModel(mainScript),
      tetoModel: slowTeto,
      tools: [noopTool],
      createRunId: () => "run-main-failure-slow-teto",
    });

    await tetoStarted;
    await expect(execution).rejects.toThrow("Main provider failed");
    const ledger = await JsonlLedger.open(join(
      root,
      "state",
      "runs",
      "run-main-failure-slow-teto",
      "ledger.jsonl",
    ));
    const events = await ledger.read({ runId: "run-main-failure-slow-teto" });
    expect(events.some((event) => event.type === "run.failed")).toBe(true);
    await ledger.close();
  });

  it("resumes from a committed boundary without replaying the transcript", async () => {
    const root = await temporaryRoot();
    const dataDir = join(root, "state");
    const first = await executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      message: "Produce a complete answer",
      policy: { maxMainSteps: 3, tetoEnabled: false },
    }, {
      mainModel: new ScriptedModel([{
        ...response("Partial answer"),
        stopReason: "length",
      }]),
      createRunId: () => "resumable-run",
    });
    expect(first.completed).toBe(false);
    expect(first.blocker).toBe("model-output-limit");

    const resumedModel = new ScriptedModel([response("Complete answer")]);
    const resumed = await executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      resumeRunId: first.runId,
      maxOutputTokens: 6_144,
    }, { mainModel: resumedModel });

    expect(resumed).toMatchObject({ completed: true, finalText: "Complete answer" });
    expect(resumedModel.requests[0]?.maxOutputTokens).toBe(6_144);
    expect(resumedModel.requests[0]?.messages.map((message) => message.content)).toEqual([
      "Produce a complete answer",
      "Partial answer",
      expect.stringContaining("Continue exactly where it stopped"),
    ]);
    const ledger = await JsonlLedger.open(join(resumed.stateDir, "ledger.jsonl"));
    const events = await ledger.read({ runId: resumed.runId });
    expect(events.filter((event) => event.type === "run.resumed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "user.message")).toHaveLength(1);
    await ledger.close();
  });

  it("restores all-lane usage before admitting Main on resume", async () => {
    const root = await temporaryRoot();
    const dataDir = join(root, "state");
    const first = await executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      message: "Start a bounded task",
      policy: {
        maxMainSteps: 2,
        maxModelTokens: 10_000,
        tetoEnabled: false,
      },
    }, {
      mainModel: new ScriptedModel([{
        ...response("Partial answer"),
        stopReason: "length",
      }]),
      createRunId: () => "all-lane-budget-resume",
    });
    const ledger = await JsonlLedger.open(join(first.stateDir, "ledger.jsonl"));
    await ledger.append({
      runId: first.runId,
      laneId: "worker",
      type: "budget.charged",
      payload: {
        laneId: "worker",
        usage: { input: 9_980, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      correlationId: `run:${first.runId}`,
      idempotencyKey: `${first.runId}:worker:recovered:budget`,
      visibility: "run",
    });
    await ledger.close();

    const resumedModel = new ScriptedModel([response("must not run")]);
    const resumed = await executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      resumeRunId: first.runId,
    }, { mainModel: resumedModel });

    expect(resumed).toMatchObject({
      completed: false,
      steps: 0,
      blocker: "run-budget-or-step-limit",
    });
    expect(resumedModel.callCount).toBe(0);
    expect(resumed.metrics.total.usage).toEqual({
      input: 10_000,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("returns durable progress when Teto wins a reservation race after preflight", async () => {
    const root = await temporaryRoot();
    const firstText = `First committed step ${"a".repeat(1_200)}`;
    const secondText = `Second committed step ${"b".repeat(1_200)}`;
    const toolUse = (content: string, id: string): ModelResponse => ({
      ...response(content, 1_800, 200),
      stopReason: "toolUse",
      toolCalls: [{ id, name: "noop", arguments: {} }],
    });
    const mainModel = new ScriptedModel([
      toolUse(firstText, "race-call-1"),
      toolUse(secondText, "race-call-2"),
      response("must not run"),
    ]);
    const tetoModel = new ScriptedModel([
      async () => new Promise<ModelResponse>(() => undefined),
    ]);

    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "main-scripted",
      tetoModel: "teto-scripted",
      message: "Complete three bounded tool steps",
      maxOutputTokens: 200,
      policy: {
        maxMainSteps: 3,
        maxModelTokens: 5_000,
        tetoMaxOutputTokens: 200,
        tetoTokenRatio: 0.25,
      },
    }, {
      mainModel,
      tetoModel,
      tools: [noopTool],
      createRunId: () => "main-reservation-race",
    });

    expect(result).toMatchObject({
      finalText: secondText,
      completed: false,
      steps: 2,
      usage: { input: 3_600, output: 400, cacheRead: 0, cacheWrite: 0 },
      blocker: "run-budget-or-step-limit",
    });
    expect(mainModel.callCount).toBe(2);
    expect(tetoModel.callCount).toBe(1);
    const ledger = await JsonlLedger.open(join(result.stateDir, "ledger.jsonl"));
    const events = await ledger.read({ runId: result.runId });
    expect(events.filter((event) => (
      event.type === "model.requested" && event.laneId === "main"
    ))).toHaveLength(2);
    expect(events.some((event) => event.type === "run.failed")).toBe(false);
    expect(events.some((event) => (
      event.type === "lane.status"
      && event.laneId === "main"
      && event.payload.status === "waiting"
      && event.payload.reason === "Run budget or Step limit exhausted"
    ))).toBe(true);
    expect(events.at(-1)?.type).toBe("checkpoint.committed");
    await ledger.close();
  });

  it("preserves one-shot images across recovery without writing them to the Ledger", async () => {
    const root = await temporaryRoot();
    const dataDir = join(root, "state");
    const attachedImage = image("one-shot-recovery-image");
    const firstModel = new ScriptedModel([{
      ...response("Partial image analysis"),
      stopReason: "length",
    }]);
    const first = await executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      message: "Analyze the attached image",
      images: [attachedImage],
      policy: { maxMainSteps: 2, tetoEnabled: false },
    }, {
      mainModel: firstModel,
      createRunId: () => "image-recovery-run",
    });

    expect(first).toMatchObject({ completed: false, blocker: "model-output-limit" });
    expect(firstModel.requests[0]?.messages.find((message) => message.role === "user"))
      .toMatchObject({
        content: "Analyze the attached image",
        images: [attachedImage],
      });
    expect(await readFile(join(first.stateDir, "ledger.jsonl"), "utf8"))
      .not.toContain(attachedImage.data);

    const resumedModel = new ScriptedModel([response("Complete image analysis")]);
    const resumed = await executeRun({
      workspace: root,
      dataDir,
      model: "scripted",
      resumeRunId: first.runId,
    }, { mainModel: resumedModel });

    expect(resumed).toMatchObject({ completed: true, finalText: "Complete image analysis" });
    expect(resumedModel.requests[0]?.messages.find((message) =>
      message.role === "user" && message.content === "Analyze the attached image",
    )).toMatchObject({ images: [attachedImage] });
    expect(await readFile(join(resumed.stateDir, "ledger.jsonl"), "utf8"))
      .not.toContain(attachedImage.data);
  });

  it("does not let an observer failure undo a committed event", async () => {
    const root = await temporaryRoot();
    let observations = 0;

    const result = await executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "Complete the task",
      policy: { maxMainSteps: 1, tetoEnabled: false },
    }, {
      mainModel: new ScriptedModel([response("Done")]),
      createRunId: () => "observer-failure-run",
      onEvent: async () => {
        observations += 1;
        throw new Error("observer failed");
      },
    });

    expect(result.completed).toBe(true);
    expect(observations).toBeGreaterThan(0);
    const ledger = await JsonlLedger.open(join(result.stateDir, "ledger.jsonl"));
    const events = await ledger.read({ runId: result.runId });
    expect(events.some((event) => event.type === "run.completed")).toBe(true);
    await ledger.close();
  });

  it("closes the Ledger when the content Store cannot be opened", async () => {
    const root = await temporaryRoot();
    const stateDir = join(root, "state", "runs", "store-open-failure");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "store"), "not a directory", "utf8");

    await expect(executeRun({
      workspace: root,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "Complete the task",
      policy: { maxMainSteps: 1, tetoEnabled: false },
    }, {
      mainModel: new ScriptedModel([response("unused")]),
      createRunId: () => "store-open-failure",
    })).rejects.toThrow();

    const ledger = await JsonlLedger.open(join(stateDir, "ledger.jsonl"));
    await ledger.close();
  });
});

const noopTool: AgentTool = {
  definition: {
    name: "noop",
    description: "Return a deterministic result",
    parameters: { type: "object", additionalProperties: false },
  },
  async execute() {
    return { content: "ok", isError: false };
  },
};

function namedTool(name: string): AgentTool {
  return {
    definition: {
      name,
      description: `Test ${name}`,
      parameters: { type: "object", additionalProperties: false },
    },
    async execute() {
      return { content: name, isError: false };
    },
  };
}

function skillSummary(name: string, description: string): EdgeContextContributionSummary {
  return {
    kind: "context",
    sourceId: "skills",
    contributionId: `skill:${name}`,
    sourceType: "skill",
    name,
    description,
    disabled: false,
  };
}

function parseArtifactReadArguments(content: string): Record<string, unknown> {
  const prefix = "call artifact_read with ";
  const suffix = " and optional offset/limit.";
  const start = content.indexOf(prefix);
  const end = content.indexOf(suffix, start + prefix.length);
  if (start < 0 || end < 0) throw new Error("Missing artifact_read arguments in pointer");
  return JSON.parse(content.slice(start + prefix.length, end)) as Record<string, unknown>;
}

const response = (content: string, input = 20, output = 5): ModelResponse => ({
  content,
  toolCalls: [],
  stopReason: "stop",
  usage: { input, output, cacheRead: 0, cacheWrite: 0 },
});

const enabledFukaiPolicy = () => ({
  enabled: true,
  provider: "pi-ai" as const,
  maxInputTokens: 2_000,
  maxOutputTokens: 500,
  maxWallClockMs: 30_000,
  thresholdRatio: 0.8,
  retainRatio: 0.16,
  minimumGainTokens: 1,
});

const image = (
  payload: string,
  mimeType: UserImage["mimeType"] = "image/png",
): UserImage => ({
  type: "image",
  data: Buffer.from(payload).toString("base64"),
  mimeType,
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "nausicaa-runtime-"));
  roots.push(root);
  return root;
};
